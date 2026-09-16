import { spawn } from 'child_process'
import { mkdir, stat } from 'fs/promises'
import { join, resolve } from 'path'
import { appPaths } from '../core/appPaths'
import type { CancelToken } from '../core/cancel'
import { killTree } from '../core/kill'
import { partPathOf } from '../core/outputName'
import { calibrePath } from '../engines/heavy'
import {
  ConversionCanceled,
  ConversionFailed,
  EngineWatchdog,
  finalizeOutput,
  removeQuietly,
  tailLines,
  type ConvertContext
} from './common'

/**
 * Calibre 适配器：电子书格式互转（`epub/mobi/azw3/azw/fb2/lit/pdb` → `epub/mobi/azw3/pdf/docx/txt`）。
 *
 * 用随包解包出来的 `ebook-convert.exe`（`msiexec /a` 解 MSI，见约束 16），
 * 不用 `pip install calibre` 之类——它是自包含目录树，改个名、整体搬走都照跑。
 *
 * 下面这些结论全部是**在本机实测出来的**（不是照抄文档），命令行形状只有
 * `ebook-convert <绝对输入路径> <绝对输出路径>` 两个位置参数：
 *
 * - **输出格式从输出文件名的最后一个扩展名推断**。给 `报告.part.epub` 就写出
 *   `报告.part.epub`；给 `out.epub.part` 直接 `ValueError: No plugin to handle output format: part`
 *   ——所以 `partPathOf(output)` 能原样当输出参数喂进去（约束 8 在这条线上同样承重）。
 *   给一个没有扩展名的路径更危险：它**不报错**，转成 OEB 输出并**建一个同名目录**，
 *   退出码 0。我们的目标格式都来自能力矩阵、必然带扩展名，这条只是记录在案。
 * - **退出码可信**：不存在的输入、损坏的 epub、未知输出格式、输出目录不存在，
 *   四种失败全都是退出码 1（Python 的 traceback 走 stderr）。从未观察到「退 0 但不产文件」，
 *   但仍加了一道产物检查——理由见 `ensureProduced`。
 * - **它会拉起子进程**：`ebook-convert.exe` 之下有 `calibre-parallel.exe`，
 *   渲染 PDF 时还会再起**二十多个 `QtWebEngineProcess.exe`**（实测 300 章的书同时 24 个）。
 *   实测 `taskkill /pid <父> /T /F` 能把整棵树 26 个进程一次清干净，只杀父进程会留孤儿。
 *   所以取消必须走 `killTree`（约束 3 在 calibre 上同样是硬需求，且比 LibreOffice 更甚）。
 *   另外被 `taskkill /T /F` 杀掉时 Node 的 `close` 报的是 **code 1**（不是 0），
 *   所以「先判 `cancel.canceled` 再判退出码」是承重的。
 * - **墙钟**：热启动实测 710~850 ms；本次会话第一次调用 4880 ms（那是 OS 文件缓存没命中，
 *   不是引擎冷启动——把 `CALIBRE_CONFIG_DIRECTORY` 指向全新空目录仍是 683~752 ms，
 *   建出来的 `caches/` 是空的，没有「构建 plugin cache」这回事）。PDF 出口重得多：
 *   210 KB 的 epub → pdf 要 25.7 s（产物 11.8 MB、峰值 RSS 299 MB），其余出口 0.4~1.3 s。
 *   2026-09-14 复量：小 epub → docx 0.52 s、小 epub → pdf 3.6 s，而**一份 533 KB 的 epub
 *   转 pdf 跑了 147.8 s** 才以 `0xC00000FD`（栈溢出）退出——看门狗的值必须比这更宽，
 *   见 `ENGINE_TIMEOUT_MS` 那张表。
 * - **stdout 里有百分比**：`1% 转换为HTML中...` / `34% 正在对电子书进行转换...` /
 *   `67% 正在运行 EPUB Output 插件`（PDF 出口更多：… 90% / 91% / 100%）。
 *   一行一个、CRLF 结尾、都在 **stdout**（stderr 只放 traceback）。但**刻意不解析它**：
 *   epub/docx 出口压根不到 100%（停 67%，与 7z 一个毛病），PDF 出口虽然到 100%，
 *   但从 `70% 将所有HTML渲染为PDF` 到结束要熬二十几秒——进度条会冻在 70% 二三十秒，
 *   比不确定进度**更像卡死**（后者至少还在动）。所以整段只显示阶段文案，
 *   对应 UI 里既有的 `.indeterminate-bar`。stdout 仍照全量留着（见 `STDOUT_CAP`），
 *   将来真要升级成 determinate 再加解析器，务必**行首锚定**——日志里会出现
 *   `Looking for large trees in Da%20Yang%20Ben.html` 这种 URL 编码的文件名。
 * - **不做编码归一**。`pandocRun.normalizeEncoding` 那一套在这里是有害的：源格式全是
 *   自带编码元数据的二进制容器（epub 是 zip、mobi/azw3 是 MOBI 容器、fb2 是 XML 声明），
 *   按 `decodeTextFile` 解一遍只会得到乱码。实测对照：**带 `charset=gbk` 声明的 GBK HTML
 *   中文完好；声明写着 utf-8 而字节其实是 GBK 的，中文被静默替换成 U+FFFD、退出码 0**——
 *   但 HTML 属于 document 类，根本不走 calibre（走 `document.ts` / pandoc），
 *   所以这条不影响本适配器，只作为「为什么这里不需要临时目录」的依据。
 * - **配置目录必须隔离**：不做隔离时 `ebook-convert` 会往用户真实的 `%APPDATA%\calibre`
 *   里写（实测 `gui.json` 的 mtime 被翻新）。两个后果都不该由我们引入：一是格式转换器
 *   去改另一个应用的配置，越过了本应用该有的边界，用户也不会想到是我们动的；
 *   二是用户可能同时开着 calibre 主程序，两边抢同一份配置与插件目录——**这类冲突是静默的**，
 *   不报错、只是行为变得不确定，正是本项目最忌讳的失败。做法见 `calibreConfigDir`。
 * - **看门狗 5 分钟**（`common.ts` 的 `ENGINE_TIMEOUT_MS`）：卡死时它把引擎槽位放出来
 *   ——calibre 的容量是 1，一个卡死的 `ebook-convert`（它会拉起 `calibre-parallel.exe`
 *   与二十多个 `QtWebEngineProcess.exe`）会让之后所有电子书转换一起堵到会话结束。
 *   值刻意宽：PDF 出口动辄几十秒是正常耗时，实测最重的一次跑了 147.8 s。
 */

/** stderr 上限：Python traceback 撑死几 KB，64 KB 足够看清最后一个异常 */
const STDERR_CAP = 64 * 1024
/**
 * stdout 上限。
 *
 * 实测 300 章、389 KB 的书，calibre 的日志也只有 1 KB / 27 行，正常情况远够不着这个闸。
 * 给到 1 MB 是为了两件事：一是防病态输入把它撑爆内存，二是将来加百分比解析器时，
 * 被裁掉的只有开头（百分比单调递增，从尾部留够就没问题）。
 */
const STDOUT_CAP = 1024 * 1024

/**
 * 目标格式 → 该出口专属的额外参数。
 *
 * **刻意留空**：表里只放实测验证过的参数，这与 `pandocRun.ts` 的 `READER` 表同思路
 * （那张表里也只有 `txt → markdown` 这种踩过坑、非加不可的映射）。
 * 实测六个出口（epub / mobi / azw3 / pdf / docx / txt）**都不需要任何额外开关**：
 * →pdf 不需要外部 PDF 引擎（calibre 自带 Qt WebEngine 那套），→docx 也不缺什么。
 * 将来如果真要用 `--filter` / `--pdf-engine` / `--extra-css` 一类开关，
 * 加在这张表里、按 `toExt` 取，别散落到调用点上去。
 */
const TARGET_ARGS: Record<string, string[]> = {}

/**
 * Calibre 可执行文件的解析**统一交给 `engines/heavy.ts` 的 `calibrePath()`**。
 *
 * 这里原先自己留了一份「只认随包内置路径」的副本，于是两侧对不上：关于页的引擎状态、
 * 版本探测、以及设置里那句「引擎未备时跳过」问的都是 `calibrePath()`，而它认三档
 * （随包 → 按需下载落盘的 `engineDir` → 系统安装）。结果是**界面说已就绪、而每一次
 * 转换都报找不到引擎**，报出来的那句「预期路径」还正好是它自己拒绝承认的那条路。
 * LibreOffice 那侧一直没有这个问题（`libreoffice.ts` 走的是 `libreOfficePath()`），
 * 照它的样子统一即可。
 *
 * 缓存也一并交出去：`calibrePath()` 是三态缓存 + `resetHeavyCache()`，而 `heavy.ts` 的
 * 注释里写明「按需下载落盘、引擎目录变更」这些入口都要在重新探测前清一次缓存，
 * 所以下载完成后不会卡在「探测过、没有」那个状态上。
 */

/**
 * 取可执行文件，取不到就抛一个能照做的错。
 *
 * 措辞与 `pandocRun.requirePandocExe` 保持一致的路数：这类提示是要用户去动手的，
 * 说清楚「缺什么」和「怎么补」。
 */
function requireCalibreExe(): string {
  const exe = calibrePath()
  if (!exe) {
    throw new ConversionFailed([
      '找不到 Calibre 可执行文件',
      '找过这三处：随包内置 resources/engines/calibre/PFiles64/Calibre2/、',
      '设置里 engineDir 下的同名路径、以及系统安装的 %ProgramFiles%\\Calibre2',
      '用 msiexec /a 解包官方 MSI 即可补齐（见 docs/NOTES.md 约束 16）'
    ])
  }
  return exe
}

/**
 * 隔离出来的 calibre 配置目录：`<userData>/calibre-config`。
 *
 * 与 LibreOffice 的 `-env:UserInstallation` 是同一类需求，也都是同一个理由：
 * 引擎默认会去改用户自己的配置目录（calibre 是 `%APPDATA%\calibre`，实测会被写），
 * 而那个目录可能正被用户开着的 calibre 主程序占着。与其让两边悄悄抢，不如各用各的。
 *
 * 用**固定子目录**而不是每次新建临时目录：我们自己的足迹集中在一个可解释的位置，
 * 用户想清就清；而「每次都用新目录」会把「首次初始化」变成常态路径——实测它确实便宜
 * （全新空目录 715 / 683 / 752 ms，与稳态 ~720 ms 没差别，而且建出来的 `caches/`、
 * `plugins/` 都是空的），但那份便宜是「恰好不缓存任何东西」换来的，没理由去依赖它。
 *
 * 放在 `userData` 下而不是系统临时目录：临时目录会被清理工具扫走，
 * 而这份目录的作用正是「别让引擎自己乱找地方」，落脚点得是我们自己说了算的。
 */
function calibreConfigDir(): string {
  return join(appPaths().userData, 'calibre-config')
}

/**
 * 建出隔离配置目录，返回它的路径。
 *
 * **必须先建出来**：交给 calibre 一个不存在的路径，行为没验证过——万一它回落到默认的
 * `%APPDATA%\calibre`，隔离就白做了，而且失败是静默的（转换照样成功，只是配置又被写了）。
 * 建不出来时直接报错停下，不带着「可能没隔离上」的状态往下走。
 */
async function ensureCalibreConfigDir(): Promise<string> {
  const dir = calibreConfigDir()
  try {
    await mkdir(dir, { recursive: true })
  } catch {
    throw new ConversionFailed([
      '无法创建 Calibre 的隔离配置目录',
      `路径：${dir}`,
      '这一项不能省：不隔离的话，转换过程会去改写用户自己的 calibre 配置'
    ])
  }
  return dir
}

interface CalibreRunResult {
  stdout: string
  stderr: string
}

/**
 * 跑一次 `ebook-convert`，返回它的 stdout / stderr。
 *
 * 与 `pandocRun.runPandocCli` 同款（起进程、限量收集、取消杀树、错误映射），
 * 差别只有三处，都是 calibre 实测出来的脾气：
 *
 * - **失败信息不能只看 stderr**。Python traceback 在 stderr，但最直白的那句
 *   `Cannot read from <路径>`（输入不存在时）走的是 **stdout**，此时 stderr 是 0 字节。
 *   所以 stderr 为空时回退到 stdout 的尾部，不然用户只会看到一句「退出码 1」。
 * - **`env` 里带隔离配置目录**：`spawn` 一旦给了 `env` 就不再继承父进程环境，
 *   所以得先整份展开 `process.env` 再覆写这一项。
 * - **`onSpawned` 回调**：calibre 的启动阶段（解 exe + 引导 Python）实测有几百毫秒，
 *   值得单独占一个阶段文案；进程真起来之后再推「转换中…」，进度才不会两条挤在一起。
 */
function runCalibreCli(
  args: string[],
  cancel: CancelToken,
  exe: string,
  configDir: string,
  onSpawned: () => void
): Promise<CalibreRunResult> {
  return new Promise<CalibreRunResult>((done, fail) => {
    let stdout = ''
    let stderr = ''

    let child: ReturnType<typeof spawn>
    try {
      child = spawn(exe, args, {
        windowsHide: true,
        env: { ...process.env, CALIBRE_CONFIG_DIRECTORY: configDir }
      })
    } catch {
      fail(new ConversionFailed([`无法启动 Calibre：${exe}`]))
      return
    }

    const watchdog = new EngineWatchdog({ label: 'Calibre' })
    watchdog.arm(child.pid)

    // 先挂取消再通知已启动：中间任何时刻收到取消都能立刻杀掉整棵树
    cancel.onCancel(() => {
      void killTree(child.pid)
    })
    onSpawned()

    // ⚠️ **必须先 setEncoding，别在 data 回调里 `chunk.toString('utf8')`**：
    // 逐块解码会把跨管道边界（64 KiB）的多字节序列拆成两个替换符，而这两条流里
    // 恰好全是**含中文的路径与报错**（`Cannot read from D:\我的 书\三体.epub`、
    // Python traceback 里那个路径、`1% 转换为HTML中...`）。这些都是要展示给用户的原文。
    // setEncoding 走 Node 的 StringDecoder（跨块残字节缓存到下一块），与
    // `engines/status.ts` / `converters/pandocRun.ts` 同一个写法；chunk 随之变成 string。
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')

    child.stdout?.on('data', (chunk: string) => {
      if (stdout.length >= STDOUT_CAP) return
      stdout += chunk
      if (stdout.length > STDOUT_CAP) stdout = stdout.slice(-STDOUT_CAP / 2)
    })

    child.stderr?.on('data', (chunk: string) => {
      if (stderr.length >= STDERR_CAP) return
      stderr += chunk
      if (stderr.length > STDERR_CAP) stderr = stderr.slice(-STDERR_CAP / 2)
    })

    child.on('error', (error) => {
      watchdog.stop()
      fail(new ConversionFailed([`无法启动 Calibre：${error.message}`]))
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
        const tail = tailLines(stderr)
        const fallback = tailLines(stdout)
        fail(
          new ConversionFailed(
            tail.length > 0
              ? tail
              : fallback.length > 0
                ? fallback
                : [`Calibre 退出码 ${code}，且没有输出错误信息`]
          )
        )
        return
      }
      done({ stdout, stderr })
    })
  })
}

/**
 * 产物自检：必须存在，且不能是 0 字节。
 *
 * 实测没抓到过「退 0 但不产文件」的样本，但这道检查留着有独立价值：
 * calibre 只在整个管线的**最后**才落盘（实测中途 `taskkill /T /F` 掉整棵树后，
 * 输出路径上一个字节都没有），所以「退出码 0 而产物缺失」只可能来自更上游的异常，
 * 而那正是本项目最忌讳的静默失败。宁可明确报错，也不要让用户拿到一个空文件
 * 或者一份指向不存在文件的成功记录。
 */
async function ensureProduced(tempOut: string): Promise<void> {
  let size = -1
  try {
    size = (await stat(tempOut)).size
  } catch {
    size = -1
  }

  if (size < 0) {
    throw new ConversionFailed(['Calibre 退出码 0，但没有产出任何文件', `预期产物：${tempOut}`])
  }
  if (size === 0) {
    throw new ConversionFailed(['Calibre 产出了一个 0 字节的空文件', `产物路径：${tempOut}`])
  }
}

/**
 * 跑一次 Calibre，产物直接写进 `output`。
 *
 * 落盘形状与 `pandoc.ts` 完全一致（`partPathOf` → 子进程 → `finalizeOutput`）：
 * calibre 是**直接写你给的那个路径**、不搞 `--outdir` + `readdir` 那一套
 * （那是 LibreOffice 的怪癖），所以这里不需要任何「产物到底落在哪」的兜底猜测——
 * 唯一的前提是输出路径的**扩展名必须保留**，因为格式就是从它推出来的。
 */
export async function runCalibre(context: ConvertContext): Promise<void> {
  const { input, output, toExt, cancel, onProgress } = context

  // 先解析引擎路径、再动磁盘：缺引擎时连配置目录与临时文件都不该留
  // （错误要早、痕迹要少）
  const exe = requireCalibreExe()
  const configDir = await ensureCalibreConfigDir()
  const tempOut = partPathOf(output)

  try {
    await removeQuietly(tempOut)
    onProgress({ kind: 'indeterminate', stage: '启动 Calibre…' })

    // 一律传绝对路径（约束 2）：文件名里的空格、引号、`&`、`$()`、中文、emoji 都天然无害
    // （全程数组参数、不经 shell），以 `-` 开头的文件名被 `resolve` 一改也就不再像选项了。
    await runCalibreCli(
      [resolve(input), resolve(tempOut), ...(TARGET_ARGS[toExt] ?? [])],
      cancel,
      exe,
      configDir,
      () => onProgress({ kind: 'indeterminate', stage: '转换中…' })
    )

    await ensureProduced(tempOut)
  } catch (error) {
    await removeQuietly(tempOut)
    throw error
  }

  await finalizeOutput(tempOut, output)
  onProgress({ kind: 'determinate', percent: 1 })
}
