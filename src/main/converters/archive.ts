import { spawn } from 'child_process'
import { mkdir, mkdtemp, readdir, rm, stat } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { extOf } from '@shared/formats'
import type { TaskProgress } from '@shared/types'
import { sevenZipEngine } from '../engines/sevenzip'
import { partPathOf } from '../core/outputName'
import { killTree } from '../core/kill'
import type { CancelToken } from '../core/cancel'
import {
  ConversionCanceled,
  ConversionFailed,
  finalizeOutput,
  removeQuietly,
  tailLines,
  type ConvertContext
} from './common'

/**
 * 压缩包互转 = 全拆开 + 重新打包。
 *
 * 归档格式之间没有「流式转换」这回事：zip 和 7z 的字典、条目索引、压缩算法
 * 完全不同，只能把内容解出来再按目标格式压回去。所以中间必然要落一次临时目录。
 */

/** 能打包成的格式。toExt 来自 UI，必须过白名单才敢拼进 `-t` 参数 */
const PACK_FORMATS = new Set(['zip', '7z', 'tar'])

/**
 * 源格式本身就意味着「先解压缩层、再解容器」两层。
 * 只有这些才需要拆第二趟——tar.gz 里的 tar 必须再拆一层才是真内容，
 * 而「一个 zip 里装着一个 zip」是内容，不该擅自拆开。
 */
const LAYERED_SRC = new Set(['tgz', 'tbz', 'tbz2', 'txz', 'gz', 'bz2', 'xz'])

/** 压缩层拆开后，里面若是 tar 就再拆一趟。三层足够覆盖各种套娃，也挡住压缩炸弹 */
const MAX_UNWRAP_DEPTH = 3

const PROGRESS_THROTTLE_MS = 100
const STDERR_CAP = 256 * 1024

/** 拆包占 0~45%，打包占 45~100%——打包通常更慢，给它多一点 */
const UNWRAP_SHARE = 0.45

interface RunOptions {
  cancel: CancelToken
  onProgress: (progress: TaskProgress) => void
  /** 这一段进度映射到总进度的起点与跨度 */
  percentBase: number
  percentSpan: number
  /** 打包时以临时目录为工作目录，用 `*` 把内容全带上 */
  cwd?: string
}

/**
 * 删掉整个临时目录，**失败不抛出**。
 *
 * ## 为什么必须有这个包装
 *
 * 这个 `rm` 挂在 `finally` 里。它一旦抛，**异常会顶替掉真正的原因**——用户本来该看到
 * 7-Zip 的原话（「No space left on device」/「Cannot open the file as archive」），
 * 结果看到一句 `EPERM: operation not permitted, rmdir '…\arbit_temp_x'`。
 * 临时目录被别的进程占着（杀软在扫、上一轮的句柄还没释放、用户自己在里面开着文件）
 * 都是真会发生的，而那时候「为什么转换失败」已经查不回来了。
 *
 * 同理，清理失败**本身也不该让一次成功的转换变成失败**：它是我们自己的垃圾。
 *
 * ## 为什么是这个形状
 *
 * `common.ts` 的 `removeQuietly` 是 `rm(target, { force: true })`、**不带 recursive**，
 * 语义是「删一个文件」——把它改成能删目录会悄悄改掉 `finalizeOutput` 的行为，
 * 所以这里另起一个，而不是去加宽那一个（`libreoffice.ts` 的 `removeDirQuietly`
 * 出于同一个理由也是独立的一份，区别只在于它带重试）。
 * `document.ts` / `image.ts` 同样是内联的 `.catch(() => undefined)`。
 *
 * **`pandoc.ts` import 的是本文件这一份**（它同样要清一个整目录）：两处各写一遍的话，
 * 漏掉一处就是一次「EPERM 顶掉真正原因」，而那种漏法在界面上看不出来。
 */
export async function removeTempDirQuietly(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true }).catch(() => undefined)
}

/**
 * 跑一次 7z 并解析它的进度。
 *
 * 进度输出用 `\r` 分隔而不是 `\n`，按行切会全部落空——原始输出长这样：
 *   "  0M Scan D:\\out\\\r          \r  0%\r    \r 36% 48 + blob.bin\r"
 * 所以先按 `\r` 和 `\n` 一起切，再匹配 `^\s*(\d{1,3})%`。
 * 开头那条 `0M Scan <路径>` 不含 `%`，天然不会误匹配。
 */
function runSevenZip(exe: string, args: string[], opts: RunOptions): Promise<void> {
  const { cancel, onProgress, percentBase, percentSpan, cwd } = opts

  let stderrText = ''
  let lastEmit = 0
  // 进度记录可能被切在两个 chunk 中间，留着尾巴等下一块
  let pending = ''

  /**
   * 7z 的进度流（stdout）。**这一条刻意不改 setEncoding**，取舍记在这里：
   *
   * - 唯一消费它的是下面那句 `^\s*(\d{1,3})%`，行内的文件名（`36% 48 + blob.bin`，
   *   可能是中文）**从来不被读**，只被跳过。所以即使某个多字节序列跨块被拆成替换符，
   *   它在用户那里也不产生任何可见差别。
   * - 行分隔是两个**单字节**字符（`\r` / `\n`），不可能被一个多字节序列「吃掉一半」，
   *   所以「按 `[\r\n]` 切行」这件事不受逐块解码影响；`pending` 那条尾巴同理。
   * - 而 `%` 一定出现在行首附近、文件名之前，所以**即使在文件名里拆出替换符，
   *   也污染不到匹配**。
   *
   * 换成 setEncoding 同样正确，只是「改一条能工作、且没有可观测收益的路径」不划算；
   * stderr 那边就不同了——那是用户会读到的原文，所以改了。
   */
  const consume = (chunk: string): void => {
    pending += chunk
    const parts = pending.split(/[\r\n]/)
    pending = parts.pop() ?? ''

    for (const line of parts) {
      const match = /^\s*(\d{1,3})%/.exec(line)
      if (!match) continue

      const now = Date.now()
      if (now - lastEmit < PROGRESS_THROTTLE_MS) continue
      lastEmit = now

      const ratio = Math.min(1, Number(match[1]) / 100)
      onProgress({ kind: 'determinate', percent: percentBase + ratio * percentSpan })
    }
  }

  return new Promise<void>((done, fail) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(exe, args, { windowsHide: true, cwd })
    } catch {
      fail(new ConversionFailed([`无法启动 7-Zip：${exe}`]))
      return
    }

    cancel.onCancel(() => {
      void killTree(child.pid)
    })

    // stdout 上只有进度记录，**刻意保留逐块 `.toString('utf8')`**（取舍写在 `consume` 上面）。
    child.stdout?.on('data', (chunk: Buffer) => consume(chunk.toString('utf8')))

    // ⚠️ stderr 必须先 setEncoding：这里放的是 7z 的报错原文，而它**含用户的中文路径**
    // （`Cannot open the file as archive`、`ERROR: The system cannot find the file
    // specified. D:\我的 压缩包\x.7z` 之类），这些是要展示给用户的那几句。
    // 逐块 `.toString('utf8')` 会把跨管道边界（64 KiB）的多字节序列拆成两个替换符——
    // 而报错行恰恰可能很长。写法与 `engines/status.ts` / `converters/pandocRun.ts` 一致。
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      if (stderrText.length >= STDERR_CAP) return
      stderrText += chunk
      if (stderrText.length > STDERR_CAP) stderrText = stderrText.slice(-STDERR_CAP / 2)
    })

    child.on('error', (error) => {
      fail(new ConversionFailed([`无法启动 7-Zip：${error.message}`]))
    })

    child.on('close', (code) => {
      if (cancel.canceled) {
        fail(new ConversionCanceled())
        return
      }
      if (code !== 0) {
        const tail = tailLines(stderrText)
        fail(
          new ConversionFailed(
            tail.length > 0 ? tail : [`7-Zip 退出码 ${code}，且没有输出错误信息`]
          )
        )
        return
      }
      // 7z 不会吐出 100%，收尾这一步得自己补上，否则进度条永远差一截
      onProgress({ kind: 'determinate', percent: percentBase + percentSpan })
      done()
    })
  })
}

/**
 * 把输入一层层拆到底，返回装着真实内容的目录。
 *
 * `.tgz` 这类套娃必须拆两趟：第一趟只解掉 gzip 层拿到 `x.tar`，
 * 第二趟才把 tar 解成文件。7z 没有一步到位的选项。
 */
async function unwrapAll(
  exe: string,
  input: string,
  root: string,
  fromExt: string,
  cancel: CancelToken,
  onProgress: (progress: TaskProgress) => void
): Promise<string> {
  let current = input
  let contentDir = ''
  let mayNest = LAYERED_SRC.has(fromExt)

  const stepSpan = UNWRAP_SHARE / MAX_UNWRAP_DEPTH

  for (let depth = 0; depth < MAX_UNWRAP_DEPTH; depth += 1) {
    const dest = join(root, `step${depth}`)
    await mkdir(dest, { recursive: true })

    await runSevenZip(exe, ['x', current, `-o${dest}`, '-bsp1', '-bso0', '-bse1', '-y'], {
      cancel,
      onProgress,
      percentBase: depth * stepSpan,
      percentSpan: stepSpan
    })

    contentDir = dest

    if (!mayNest) break

    // 拆出来只有一个文件、且它是 tar → 这层只是壳，继续拆
    const entries = await readdir(dest)
    if (entries.length !== 1) break

    const only = join(dest, entries[0])
    if (!(await stat(only)).isFile()) break
    if (extOf(entries[0]) !== 'tar') break

    current = only
    // tar 里面就是内容了，不会再有第三层
    mayNest = false
  }

  return contentDir
}

async function pack(
  exe: string,
  toExt: string,
  contentDir: string,
  tempOut: string,
  cancel: CancelToken,
  onProgress: (progress: TaskProgress) => void
): Promise<void> {
  // `--` 之后一律当文件名。临时目录里可能有个叫 `-y.txt` 的文件（用户压缩包里的），
  // 少了这个分隔符就会被 7z 当成开关——参数注入比 shell 注入隐蔽得多。
  const args = ['a', `-t${toExt}`, '-mx=5', '-bsp1', '-bso0', '-bse1', '--', tempOut, '*']

  await runSevenZip(exe, args, {
    cancel,
    onProgress,
    percentBase: UNWRAP_SHARE,
    percentSpan: 1 - UNWRAP_SHARE,
    cwd: contentDir
  })
}

export async function runArchive(options: ConvertContext): Promise<void> {
  const { input, output, fromExt, toExt, cancel, onProgress } = options

  if (!PACK_FORMATS.has(toExt)) {
    throw new ConversionFailed([
      `压缩包只能转成 ${[...PACK_FORMATS].join(' / ')}，收到的是 ${toExt}`
    ])
  }

  const engine = sevenZipEngine()
  if (!engine) {
    throw new ConversionFailed(['找不到 7-Zip 可执行文件，请重新安装依赖'])
  }

  // 精简版 7za.exe 完全没有 RAR 解码器，与其让它报 "Cannot open the file as archive"
  // 这种看不出原因的错，不如直接说清楚缺什么
  if (fromExt === 'rar' && !engine.supportsRar) {
    throw new ConversionFailed([
      '当前用的是精简版 7-Zip（7za.exe），它不含 RAR 解码器',
      '运行 node scripts/fetch-bundled-engines.mjs 提取完整版 7z.exe + 7z.dll 后即可支持 RAR'
    ])
  }

  const root = await mkdtemp(join(tmpdir(), 'arbiter-'))
  const tempOut = partPathOf(output)

  try {
    await removeQuietly(tempOut)

    // 第一条百分比记录到来之前先给个阶段文案，否则 UI 会空着
    onProgress({ kind: 'indeterminate', stage: '拆开压缩包…' })

    const contentDir = await unwrapAll(engine.path, input, root, fromExt, cancel, onProgress)

    // 空压缩包：7z 面对空目录会自己报错，但那句话对用户毫无意义，不如换个说法
    const entries = await readdir(contentDir)
    if (entries.length === 0) {
      throw new ConversionFailed(['这个压缩包里没有任何文件'])
    }

    await pack(engine.path, toExt, contentDir, tempOut, cancel, onProgress)
  } catch (error) {
    await removeQuietly(tempOut)
    throw error
  } finally {
    // 临时目录可能很大，而且里面有用户的原始文件，无论成败都必须清掉。
    // ⚠️ 走 `removeTempDirQuietly` 而不是裸 `rm`——理由见那个函数自己的注释
    // （清理异常不许顶替真正的失败原因）。
    await removeTempDirQuietly(root)
  }

  await finalizeOutput(tempOut, output)
  onProgress({ kind: 'determinate', percent: 1 })
}
