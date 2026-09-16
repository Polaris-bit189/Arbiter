import { spawn } from 'child_process'
import { copyFile, mkdtemp, readdir, rm, stat } from 'fs/promises'
import { tmpdir } from 'os'
import { basename, dirname, join, resolve } from 'path'
import { extOf } from '@shared/formats'
import { libreOfficePath } from '../engines/heavy'
import { killTree } from '../core/kill'
import type { CancelToken } from '../core/cancel'
import { partPathOf } from '../core/outputName'
import {
  ConversionCanceled,
  ConversionFailed,
  delay,
  EngineWatchdog,
  finalizeOutput,
  removeQuietly,
  tailLines,
  type ConvertContext
} from './common'

/**
 * LibreOffice 适配器：二进制办公格式的互转
 * （`doc/xls/ppt/pptx/odt/ods/odp` → `pdf/docx/xlsx/pptx/txt`）。
 *
 * 用 `msiexec /a` 解出来的原始目录树（见约束 16），`program/soffice.exe` 是个瘦壳
 * 启动器，真身是同目录的 `soffice.bin`——所以「旁边有 bin」既是就绪判据，
 * 也由 `engines/heavy.ts` 的 `libreOfficePath()` 负责解析（随包内置 → 按需下载 → 系统安装）。
 *
 * 下面每一条都是**在本机真跑 CLI 实测出来的**（LO 26.8.0.3），不是照抄文档：
 *
 * - **退出码基本可信，但仍不足以当就绪判据**。实测：输入不存在 → 1；跨应用目标
 *   （`doc → pptx`）→ 1；输出目录不可写 → 1；转换中途 `taskkill /T /F` → 1。
 *   唯一抓到「退出码 0 却没产物」的路径是**给了显式滤镜名**（`--convert-to
 *   'pptx:Impress MS PowerPoint 2007 XML'` 转一个 Writer 文档）：它打印
 *   `convert … using filter : Impress MS PowerPoint 2007 XML`、退出码 0，
 *   而输出目录里只留下一个 `.~lock.<名字>#` 与一个 0 字节的 `lu*.tmp`。
 *   我们**不传显式滤镜名**，但这证明这个二进制确实存在「声称成功却没写成」的模式，
 *   再加上它同时也是「profile 被占用」这类外部干扰的唯一表现，就绪判据必须是
 *   「产物存在且 size > 0」而不是退出码——见 `ensureProduced`。
 * - **产物名 = 输入名剥掉最后一个扩展名再加新扩展名**，与目标格式那个滤镜无关。
 *   所以 `报告.part.docx` 转 pdf 写出的是 `报告.part.pdf`：**双点 stem 是安全的**，
 *   这正好让 `partPathOf(output)` 那套「临时名保留扩展名」（约束 8）能直接落地。
 *   输入的扩展名决定 LO 用哪个组件装它（按内容嗅探），副本因此必须沿用**源**扩展名。
 * - **跨应用转换一律失败，失败方式很干脆**：`doc → xlsx` / `xls → docx` /
 *   `ppt → xlsx` / `xls → txt` 全都是 `Error: no export filter for <路径> found, aborting.`
 *   退出码 1、目录里一个残留都没有。分界线实测**正好按 Writer / Calc / Impress 三家分**
 *   （与源是 ODF 还是 OOXML 无关）：
 *     Writer（doc/odt）→ pdf、docx、txt
 *     Calc（xls/ods）  → pdf、xlsx
 *     Impress（ppt/pptx/odp）→ pdf、pptx
 *   注意 `xls → txt` 也在失败之列——txt 是 Writer 专属出口。
 *   上游 `shared/formats.ts` 对每个 office 源都宣称 `['pdf','docx','xlsx','pptx','txt']`，
 *   所以这条路上会**真的**收到跨应用请求；这里不做拦截，交给 LO 拒掉并把它的原话回传，
 *   总比我们自己维护一张会漂的表强。
 * - **`-env:UserInstallation` 的值必须做 URL 编码**，只把反斜杠换成正斜杠是不够的。
 *   实测：路径里带**空格**或**中文**时，未编码的 URL 让 soffice 直接
 *   **退出码 127、不建 profile、不产文件**；同一路径写成 `%20` / `%E4%B8%AD…` 就一切正常，
 *   profile 也会落在**解码后**的那个真实路径上。这条不是洁癖：Windows 用户名带空格
 *   （`C:\Users\John Smith\…`）时临时目录天然带空格，踩中就是整条线不可用。
 *   见 `profileUrl`。
 * - **每次任务一个全新 profile，代价约 5.6 s**。实测 `--convert-to`：全新 profile
 *   9.6~13.7 s（本机第一次调用 20.0 s，那是 OS 文件缓存没命中），复用同一 profile
 *   3.8~4.6 s。差价就是自建 profile 的开销（约 979 KB）。之所以认这笔账，是因为
 *   `ENGINE_LIMITS.libreoffice = 1` 只约束我们自己进程内的任务，**挡不住用户自己开着的
 *   LibreOffice 窗口**；隔离掉之后，那边无论什么状态都影响不到我们。
 *   （实测参考：一个**活着**的 headless 常驻实例共享同一 profile 时转换照样成功、
 *   反而更快 1.9 s；预置一个孤儿 `.lock` 也照样成功。所以这条隔离更多是「不越界改
 *   用户目录」与「不依赖未定义行为」，而不是在救一个已知的必崩场景。）
 * - **看门狗 5 分钟**（`common.ts` 的 `ENGINE_TIMEOUT_MS`）：LO 冷启动就有 9.6 s 起步，
 *   任何「几秒」量级的超时都会把正常任务误杀成假故障，所以这个值刻意宽——本机实测
 *   小 docx → pdf 是 8.3 s（热）/ 16.0 s（会话首次），一份 2.16 MB 文档撑出的
 *   26.7 MB PDF 要 35~36 s。它的作用不是「救慢任务」，而是**卡死时把引擎槽位放出来**：
 *   LO 的容量是 1，一个卡死的 soffice 会让之后所有 LO 转换一起堵到会话结束，
 *   而在此之前用户看到的只是「转换中…」永远转下去。到点走 `killTree` 杀整棵树。
 * - **必须杀进程树**：`soffice.exe` 之下是 `soffice.bin`，只杀父进程会留孤儿占着
 *   profile 锁。被 `taskkill /T /F` 杀掉时 Node 的 `close` 报 **code 1**，
 *   所以「先判 `cancel.canceled` 再判退出码」是承重的。
 * - **进度只能是不确定态**：LO 不吐百分比（stdout 只有 `convert … using filter …`
 *   这一行，`--convert-to` 没有任何 `--progress` 类开关）。硬造一个假进度条不如老实
 *   显示不确定态，与 pandoc / calibre 同一个取舍。
 */

/** 上限：LO 在 stdout 上只有 `convert …` 与 `Error:` 几行，64 KB 是防呆闸而非额度 */
const STDOUT_CAP = 64 * 1024
const STDERR_CAP = 64 * 1024

/**
 * 取 LibreOffice 可执行文件，取不到就抛一个能照做的错。
 *
 * 措辞与 `pandocRun.requirePandocExe` / `calibre.ts` 的 `requireCalibreExe` 同路数。
 * 解析交给 `engines/heavy.ts`：那里有「`soffice.exe` 旁边必须有 `soffice.bin`」的就绪判据
 * （与 `sevenzip.ts` 里「`7z.exe` 旁边必须有 `7z.dll`」同构同理）。
 */
export function requireLibreOfficeExe(): string {
  const exe = libreOfficePath()
  if (!exe) {
    throw new ConversionFailed([
      '找不到 LibreOffice 可执行文件',
      '预期路径：resources/engines/libreoffice/program/soffice.exe（同目录还必须要有 soffice.bin）',
      '用 msiexec /a 解包官方 MSI 即可补齐（见 docs/NOTES.md 约束 16），或在关于页按需下载'
    ])
  }
  return exe
}

/**
 * 把 Windows 路径变成 `file:///` URL，**逐段做 percent 编码**。
 *
 * 只替换反斜杠是不够的（实测空格与中文都会让 soffice 退出码 127 且什么都不做）。
 * 用逐段 `encodeURIComponent` 而不是整体 `encodeURI`：后者会漏掉 `#`（会被当成 fragment）
 * 和裸 `%`（会被当成转义序列的开头），而这两者在真实临时路径里都可能出现。
 * 首段（盘符 `C:`）保持原样，`encodeURIComponent` 会把冒号变成 `%3A` 从而弄坏盘符。
 */
function profileUrl(profileDir: string): string {
  const normalized = resolve(profileDir).replace(/\\/g, '/')
  const encoded = normalized
    .split('/')
    .map((segment, index) => (index === 0 ? segment : encodeURIComponent(segment)))
    .join('/')
  return `file:///${encoded}`
}

/**
 * 递归删目录，失败重试。
 *
 * `common.ts` 的 `removeQuietly` 是 `rm(target, { force: true })`、**不带 recursive**，
 * 删不掉目录，所以这里自己写一遍。重试的理由与那里相同：Windows 上进程刚退出时
 * 文件句柄未必立刻释放，紧接着 rm 会拿到 EBUSY/EPERM，不重试就会把临时 profile
 * 永久留在 temp 目录里。
 */
async function removeDirQuietly(target: string): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await rm(target, { recursive: true, force: true })
      return
    } catch {
      await delay(120)
    }
  }
}

/**
 * 副本路径：`<输出 stem>.part.<源扩展名>`。
 *
 * 这是整套落盘策略的关键一步。LO 的产物名由它自己决定（剥掉输入名的最后一个扩展名
 * 再加新的），所以要让产物正好落在 `partPathOf(output)` 上，就得反过来构造输入名：
 *
 *   output   = D:\out\报告.pdf
 *   tempOut  = partPathOf(output)              = D:\out\报告.part.pdf   ← 期望的临时产物
 *   copyPath = <tempOut 去掉 .pdf> + .docx     = D:\out\报告.part.docx  ← 喂给 LO 的输入
 *   LO 剥掉 .docx 换 .pdf                      = D:\out\报告.part.pdf   ✓
 *
 * 三个好处：产物与最终文件**同目录**（`finalizeOutput` 的同卷 rename 才是原子的）、
 * 名字完全受我们控制、全程零次搬运产物（只搬输入）。
 *
 * **`fromExt === toExt` 时这条不成立**：那时 copyPath 与 tempOut 会是同一个路径，
 * LO 会试图「就地覆盖自己」，实测报 `Overwriting: …` + `impl_store failed`、退出码 1。
 * 能力矩阵不会造出这种任务（`targetsFor` 一律滤掉同格式），`runLibreOffice` 里也有一道兜底。
 */
function copyPathFor(tempOut: string, fromExt: string): string {
  const dot = tempOut.lastIndexOf('.')
  const slash = Math.max(tempOut.lastIndexOf('/'), tempOut.lastIndexOf('\\'))
  return dot > slash ? `${tempOut.slice(0, dot)}.${fromExt}` : `${tempOut}.${fromExt}`
}

interface LibreOfficeRunResult {
  stdout: string
  stderr: string
}

/**
 * 挑出最值得展示的失败信息。
 *
 * LO 的失败信息走 **stdout**：`Error: no export filter for <路径> found, aborting.`、
 * `Error: source file could not be loaded`，此时 stderr 往往是空的——只看 stderr
 * 用户就只能拿到一句「退出码 1」。所以两条流都看，并优先挑 LO 自己打了 `Error:` 的行
 * （stdout 里还混着 `convert … using filter …` 这种正常输出，直接全量回传会把噪声当结论）。
 */
function errorTail(stdout: string, stderr: string, code: number | null): string[] {
  const merged = [...tailLines(stderr), ...tailLines(stdout)]
  const errors = merged.filter((line) => /^error|no export filter|aborting/i.test(line))
  if (errors.length > 0) return errors
  if (merged.length > 0) return merged
  return [`LibreOffice 退出码 ${code}，且没有输出错误信息`]
}

/**
 * 跑一次 `soffice --convert-to`，返回它的 stdout / stderr。
 *
 * 与 `pandocRun.runPandocCli` / `calibre.ts` 的 `runCalibreCli` 同款（数组参数起进程、
 * 限量收集、取消杀树、错误映射），差别只有 `onConverting` 这个回调：
 * LO 从进程起到真正开始转换之间有数秒的引导（加载 1.49 GiB 的目录树 + 建 profile），
 * 值得单独占一个阶段文案。`soffice` 会在这条边界上打出
 * `convert <输入> as a <组件> document -> <输出> using filter : …`，所以「收到第一段输出」
 * 就是**真实信号**，而不是我们自己估的；万一它在出错前一言不发，阶段就停在前一条上，
 * 那也仍然是对的。
 */
function runLibreOfficeCli(
  args: string[],
  cancel: CancelToken,
  exe: string,
  onConverting: () => void
): Promise<LibreOfficeRunResult> {
  return new Promise<LibreOfficeRunResult>((done, fail) => {
    let stdout = ''
    let stderr = ''
    let announced = false

    let child: ReturnType<typeof spawn>
    try {
      child = spawn(exe, args, { windowsHide: true })
    } catch {
      fail(new ConversionFailed([`无法启动 LibreOffice：${exe}`]))
      return
    }

    const watchdog = new EngineWatchdog({ label: 'LibreOffice' })
    watchdog.arm(child.pid)

    // 先挂取消再通知阶段：中间任何时刻收到取消都能立刻杀掉整棵树
    cancel.onCancel(() => {
      void killTree(child.pid)
    })

    const noteConverting = (): void => {
      if (announced) return
      announced = true
      onConverting()
    }

    // ⚠️ **必须先 setEncoding，别在 data 回调里 `chunk.toString('utf8')`**：
    // 逐块解码是「对每个 chunk 独立解码」，跨管道边界（64 KiB）的多字节序列会被拆成
    // 两个替换符。这两条流里的**路径与报错都可能含中文**（`Error: no export filter for
    // D:\我的 文档\报告.docx found`、`Overwriting: …`），而它们正是原样回传给用户的那几句。
    // setEncoding 走 Node 的 StringDecoder（跨块残字节缓存到下一块），与
    // `engines/status.ts` / `converters/pandocRun.ts` 同一个写法；chunk 随之变成 string。
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')

    child.stdout?.on('data', (chunk: string) => {
      noteConverting()
      if (stdout.length >= STDOUT_CAP) return
      stdout += chunk
      if (stdout.length > STDOUT_CAP) stdout = stdout.slice(-STDOUT_CAP / 2)
    })

    child.stderr?.on('data', (chunk: string) => {
      noteConverting()
      if (stderr.length >= STDERR_CAP) return
      stderr += chunk
      if (stderr.length > STDERR_CAP) stderr = stderr.slice(-STDERR_CAP / 2)
    })

    child.on('error', (error) => {
      watchdog.stop()
      fail(new ConversionFailed([`无法启动 LibreOffice：${error.message}`]))
    })

    child.on('close', (code) => {
      watchdog.stop()
      // 超时判在取消与退出码之前：超时是我们主动杀的树，据此报出来的
      // 「退出码 1」（taskkill 的签名）与用户遭遇到的事毫无关系
      if (watchdog.expired) {
        fail(new ConversionFailed(watchdog.reason()))
        return
      }
      // 取消必须判在退出码之前：被 taskkill /T /F 杀掉的进程实测报 code 1，
      // 先判退出码会把「用户主动取消」显示成「转换失败」
      if (cancel.canceled) {
        fail(new ConversionCanceled())
        return
      }
      if (code !== 0) {
        fail(new ConversionFailed(errorTail(stdout, stderr, code)))
        return
      }
      done({ stdout, stderr })
    })
  })
}

/**
 * 产物自检：必须存在，且 size > 0。
 *
 * **这是本适配器最承重的一条，不能换成「退出码是 0 就算成功」**。退出码在实测里基本
 * 可信（见文件头），但它测不到的正是最该防的那类失败：LO 声称成功、磁盘上却什么都没有。
 * 判错的表现是用户拿到一个「成功」的任务，点开产物却发现文件不存在——本项目最忌讳的
 * 静默失败。
 *
 * 顺带把「产物没落在预期位置」与「落到了别处」分开说：两者的排查方向完全不同。
 * 后者**不接管**——我们无法把它与同目录下另一个并发任务的产物区分开
 * （`ENGINE_LIMITS` 只管同引擎，另一个引擎完全可能同时在往同一个目录写）。
 */
async function ensureProduced(tempOut: string, outputDir: string, toExt: string): Promise<void> {
  let size = -1
  try {
    size = (await stat(tempOut)).size
  } catch {
    size = -1
  }

  if (size > 0) return

  if (size === 0) {
    throw new ConversionFailed([
      'LibreOffice 产出了一个 0 字节的空文件',
      `产物路径：${tempOut}`,
      '通常说明转换在中途失败了（输入损坏，或磁盘已满）'
    ])
  }

  let entries: string[] = []
  try {
    entries = await readdir(outputDir)
  } catch {
    entries = []
  }

  const sameExt = entries.filter((name) => extOf(name) === toExt)
  if (sameExt.length > 0) {
    throw new ConversionFailed([
      'LibreOffice 产出了文件，但名字不是我们预期的那个',
      `预期：${basename(tempOut)}`,
      `实际看到：${sameExt.join('、')}`,
      `产物目录：${outputDir}`
    ])
  }

  throw new ConversionFailed([
    'LibreOffice 退出码 0，但没有产出文件',
    `产物目录：${outputDir}`,
    `目录内容：${entries.length > 0 ? entries.join('、') : '（空）'}`,
    '常见原因：LibreOffice 的用户 profile 被占用——本机上是否已经开着一个 LibreOffice？',
    '残留的 soffice.bin 会一直占着锁，可在任务管理器里结束它后重试。',
    '若产物目录不可写（只读、或权限不足），表现与这一模一样。'
  ])
}

/**
 * 跑一次 LibreOffice，产物直接写进 `output`。
 *
 * 落盘形状（`partPathOf` → 子进程 → `finalizeOutput`）与 `pandoc.ts` / `calibre.ts` 一致，
 * 但中间多了一步「把输入复制到输出目录旁边并改成临时名」——理由见 `copyPathFor`，
 * 那是 LO 的 `--outdir` + 自己决定产物名这个脾气逼出来的。
 */
export async function runLibreOffice(context: ConvertContext): Promise<void> {
  const { input, output, fromExt, toExt, cancel, onProgress } = context

  // 先解析引擎路径、再动磁盘：缺引擎时连临时目录与副本都不该留，也不该先推一条进度出去
  // （错误要早、痕迹要少，与 pandoc.ts / calibre.ts 同一个顺序）
  const exe = requireLibreOfficeExe()

  // 兜底：同格式转换会让副本与期望产物同名，LO 会「就地覆盖自己」并失败
  // （实测 `Overwriting:` + `impl_store failed`、退出码 1）。能力矩阵不会造出这种任务，
  // 但这里宁可明确拒绝，也不要让用户看到一条难以归因的 LO 报错。
  if (toExt === fromExt) {
    throw new ConversionFailed([`源格式与目标格式相同（${toExt}），无需转换`])
  }

  const outputDir = dirname(resolve(output))
  const tempOut = partPathOf(resolve(output))
  const copyPath = copyPathFor(tempOut, fromExt)

  // 每次任务一个全新 profile：慢约 5.6 s，换来对「用户自己开着的 LibreOffice」完全免疫
  const root = await mkdtemp(join(tmpdir(), 'msg-lo-'))
  const profileDir = join(root, 'profile')

  try {
    // 残留物先清掉：万一上一轮在同一个名字上留了半截文件，readdir 与 LO 都会被它骗到
    await removeQuietly(tempOut)
    await removeQuietly(copyPath)

    onProgress({ kind: 'indeterminate', stage: '启动 LibreOffice…' })

    // 一律传绝对路径（约束 2）：文件名里的空格、引号、`&`、`$()`、中文、emoji 都天然无害
    // （全程数组参数、不经 shell），以 `-` 开头的文件名被 `resolve` 一改也就不再像选项了。
    await copyFile(resolve(input), copyPath)

    await runLibreOfficeCli(
      [
        '--headless',
        '--norestore',
        // 私有 profile：不加它就会去用（并改写）用户自己那份，两边抢同一把锁
        `-env:UserInstallation=${profileUrl(profileDir)}`,
        '--convert-to',
        toExt,
        '--outdir',
        outputDir,
        copyPath
      ],
      cancel,
      exe,
      () => onProgress({ kind: 'indeterminate', stage: '转换中…' })
    )

    await ensureProduced(tempOut, outputDir, toExt)
  } catch (error) {
    await removeQuietly(tempOut)
    throw error
  } finally {
    // 副本与临时 profile 一律带走：副本留在输出目录里会被用户当成产物，
    // profile 留在 temp 里则是每任务一份的垃圾（约 979 KB）
    await removeQuietly(copyPath)
    await removeDirQuietly(root)
  }

  await finalizeOutput(tempOut, output)
  onProgress({ kind: 'determinate', percent: 1 })
}
