import { spawn, type ChildProcess } from 'child_process'
import { existsSync, statSync } from 'fs'
import { resolve } from 'path'
import sharp from 'sharp'
import {
  categoryOf,
  defaultTargetFor,
  engineFor,
  extOf,
  requiresDownload,
  targetsFor
} from '@shared/formats'
import type { Category, EngineKey } from '@shared/types'
import { killTree } from '../main/core/kill'
import { parseProbeOutput } from '../main/core/probe'
import { buildProbeArgs } from '../main/engines/ffmpeg'
import { ffmpegPath } from '../main/engines/registry'
import { sevenZipEngine } from '../main/engines/sevenzip'
import { describeError } from './errors'
import { costFor, estimateFor, lossyFor, type CostEstimate, type EngineCost } from './inspectCost'
// 只借形状。`verify.ts` 是纯的（零运行时 import），所以这个 `import type` 编译后不留
// 任何痕迹——`selfCheck.ts` 才是那个把两边接起来的地方。
import type { VerifySide } from './verify'

/**
 * M4 的 `inspect_file`：**转换前侦察**。
 *
 * 给一个路径，回答「这是什么、能不能转、编码器是什么、多长、多大」——agent 拿到这几个
 * 数字才谈得上决策（remux 还是重编码、要不要先下 340 MB 的引擎、这个文件值不值得转）。
 *
 * 四条贯穿全文件的设计约束：
 *
 * 1. **绝不抛异常。** 这个结果是给 agent 看的，抛出去就只剩一句话。文件不存在、扩展名
 *    不认识、引擎起不来、ffmpeg 读不出流信息——全部是**结构化结果**加一句可读的 `note`。
 *    在 MCP 那条线上，工具抛异常等于把「为什么」全丢了，而 agent 无法追问。
 * 2. **绝不编。** 拿不到就 `null`（约束见 `InspectProbe` 的注释）。猜一个时长、猜一个
 *    分辨率对 agent 比没有更糟——它会据此选一条错误的路，而且不报错。
 * 3. **判定格式只走 `@shared/formats`。** `extOf` / `categoryOf` / `targetsFor` /
 *    `engineFor` 与 UI、与 `TaskManager` 是同一份表。在这里再写一份扩展名表，
 *    两边迟早分家，而分家的表现是「inspect 说能转、点下去却报不支持」。
 * 4. **路径闸门不在这里。** `mcp/paths.ts` 的闸门失败形态是抛 `PathNotAllowed`，而这里
 *    的每一条出口都是结构化结果——两者混在一起，「文件不存在」和「路径越界」在 agent
 *    眼里会长得一样。闸门属于调用方（server 那层）的职责，本模块只管侦察。
 *
 * 5. **代价三件套（`cost` / `lossy` / `estimate`）算在 `inspectCost.ts` 里**，
 *    本模块只负责把探针喂给它。那不是为了拆文件好看：那个模块要读引擎清单、要 import
 *    `engines/ffmpeg.ts` 的白名单，都是纯逻辑，单独成文件才能被逐条钉住。
 *
 * ⚠️ **本模块必须能在不 import electron 的进程里加载**（MCP Server 跑在普通 Node 里）。
 * 所以它只碰 `engines/{registry,sevenzip,ffmpeg}.ts` / `core/{probe,kill,engineInstall}.ts`
 * 这些已经 electron-free 的模块，自己也不写 `import('electron')`。这条有
 * `test-mcp-inspect.ts` 里那个 `Module._load` 钩子盯着——光看代码是看不出来的，
 * `engines/registry.ts` 就曾经直接读 `app.isPackaged`（见 `core/appPaths.ts` 的文件头）。
 *
 * 同一个钩子也是**清单那一侧不能复用 `loadEngineManifest()`** 的原因：
 * 它内部会 `import('./downlink')`，而那个模块静态依赖 electron。`inspectCost.ts`
 * 只复用它的路径（`manifestPath()`），自己读那一个文件。
 */

/**
 * 单次子进程侦察的超时。
 *
 * 侦察必须比转换快得多才值得做，所以给一个**硬上限**：MCP 的一次工具调用挂死，
 * 对 agent 来说是整个会话卡住，而不是「这条失败了」。10 秒足够 ffmpeg 读完一个
 * 文件的头（实测 4 KB 的 mp4 约 30 ms）、也足够 7z 列一个包；不够的是网络盘上一
 * 个巨大的包，那种情况给 `note` 说清楚比给它 60 秒更有用。
 */
const PROBE_TIMEOUT_MS = 10_000

/**
 * stdout / stderr 的缓冲上限。
 *
 * 与 `converters/ffmpegRun.ts` 的 `PROBE_STDERR_CAP` 同一个理由：正常只有一两 KB，
 * 但损坏文件在 `-i` 阶段就能刷出巨量报错。超限时丢**尾部**——流信息在开头，
 * 那正是我们要读的部分。
 */
const STREAM_CAP = 64 * 1024

/**
 * 分辨率：`Stream #0:0 … Video: h264 (…), yuv420p(progressive), 160x120 [SAR 1:1 DAR 4:3] …`
 * 里那个 `WxH`。
 *
 * **这条正则是本文件新写的**，`core/probe.ts` 里没有、也不该有：那份 `MediaInfo` 只回答
 * remux 需要的问题（时长 / 编解码器 / 有没有音视频轨），分辨率不在其中，而
 * `src/main/**` 这一轮一个字节都不许改。**但除此之外一律走 `parseProbeOutput`**——
 * `Duration:` 与编解码器那两个正则早就有测试盯着，在这再抄一份就是约束 5 警告的分家。
 *
 * `\d{2,5}` 里的「至少两位」是承重的：Video 行里比分辨率更早出现的是
 * `(avc1 / 0x31637661)` 这种 FourCC，它前面只有一位数字，天然不命中。
 * 放宽成 `\d+` 的话，一个 mp4 会被解析出尺寸 `0x31637661` —— 不报错，只是给 agent
 * 一个巨大的鬼数字。
 */
const RESOLUTION_RE = /Stream #\d+:\d+.*?: Video:.*?(\d{2,5})x(\d{2,5})/

/**
 * ffmpeg 打开输入时打印的 `Input #0, mov,mp4,m4a,3gp,3g2,mj2, from '…'`。
 *
 * 抓的是 `Input #0,` 与 `, from` **之间**的整段，而不是到第一个逗号为止：ffmpeg 给的是
 * 一串**别名**（一个 mp4 自述成 `mov,mp4,m4a,3gp,3g2,mj2`），只取第一个 token 会得到
 * `mov` —— 不报错，只是对着一个 mp4 说它是 mov，比没有更坏。
 * （这条是实测踩出来的：第一版写成 `([^,]+),`，测试里「容器名里有 mp4」那条当场翻红。）
 */
const FORMAT_RE = /Input #0,\s*(.+?),\s*from\s/

/** 7-Zip `-slt` 每条目一个 `Path = …` 块，见 `countEntries` */
const ENTRY_RE = /^Path = /gm

/**
 * 侦察到的原始信息。**每个字段都可能为 null，null 的含义是「没拿到」，不是「没有」。**
 *
 * 这个区别对 agent 是承重的：`durationSec: null` 在图片上是正常的、在损坏的 mp4 上是
 * 故障信号，而两者都会带上 `note` 去解释。编解码器名取的是 ffmpeg 打印的**第一个
 * token**（`h264` / `aac`），不是括号里的 FourCC——口径与 `core/probe.ts` 一致，
 * 也正好是 `engines/ffmpeg.ts` 那张 remux 白名单需要的粒度。
 */
export interface InspectProbe {
  /**
   * 容器 / 文件格式名。来自 ffmpeg 的 `Input #0, …` 或 sharp 的 `meta.format`。
   *
   * ⚠️ ffmpeg 那一侧给的是一串**别名**（`mov,mp4,m4a,3gp,3g2,mj2`），不是单一容器名：
   * 它是解复用器的自述，别拿它做等值比较，用 `includes('mp4')` 那种判法。
   */
  format: string | null
  /** null = 拿不到：图片、流式媒体、损坏文件，或 `Duration: N/A` */
  durationSec: number | null
  width: number | null
  height: number | null
  hasVideo: boolean
  hasAudio: boolean
  videoCodec: string | null
  audioCodec: string | null
  /** 归档：条目数（含目录条目）。非归档为 null */
  entries: number | null
  /** 归档：当前这个 7-Zip 能不能解 RAR（精简版一发都解不了，见约束 11）。非归档为 null */
  rarSupported: boolean | null
}

export interface InspectResult {
  /** 绝对路径。渲染进程与 agent 给的都可能是相对路径，侦察一律按绝对路径回话 */
  path: string
  exists: boolean
  /** 字节数。文件不存在或路径是目录时为 null */
  size: number | null
  /** 小写、不含点。没有扩展名时是空串 */
  ext: string
  category: Category | null
  /** 能转成什么。扩展名不认识时是空数组 */
  targets: string[]
  /**
   * 首选引擎（按 `defaultTargetFor` 挑出来的那个默认目标算）。
   * null = 没有默认出口，或者这个组合走不到任何引擎。
   */
  engine: EngineKey | null
  /** 需要用户先下载哪个引擎。null = 不需要下载 */
  requiresDownload: EngineKey | null
  probe: InspectProbe | null
  /**
   * 走一次转换要准备什么（E-3）：要下哪个引擎、多大。
   *
   * ⚠️ 与 `engine` / `requiresDownload` **同一个口径**：按**默认目标**
   * （`defaultTargetFor()`）算，不是「随便哪个合法目标」。`inspect_file` 不收
   * `target_format`，所以 agent 要拿它去推别的目标时必须先看一眼 `targets`。
   *
   * 没有要走的转换时（文件不存在、扩展名不认得、没有出口）它是「空代价」：
   * `engine: null` / `download_bytes: 0`——不是「代价未知」。
   */
  cost: EngineCost
  /**
   * 这一次转换会不会丢信息。**`true` = 一定有损，`false` = 存在无损通路。**
   *
   * `null` 表示判不了（扩展名不认得、没有默认出口）。判据与三档的保守方向见
   * `inspectCost.ts` 的 `lossyFor()`。
   */
  lossy: boolean | null
  /**
   * 耗时估算。**区间 + 置信度**，不是一个数；判不了时是 null。
   *
   * 拿到之后**先说置信度**：`low` 只够回答「秒级还是分钟级」，
   * `high` 才是可以照着安排等待的。见 `inspectCost.ts` 的 `CostEstimate`。
   */
  estimate: CostEstimate | null
  /** 一句人话，解释「为什么这里没有数据」。正常时 null */
  note: string | null
}

/* ------------------------------------------------------------- 子进程 */

interface RunResult {
  code: number | null
  stdout: string
  stderr: string
  /** 超时被杀。调用方不能拿一份空 stderr 当「文件没问题」 */
  timedOut: boolean
  /** 进程根本没起来（exe 路径为空 / ENOENT）。此时 stderr 是空的，原因在这里 */
  spawnError: string | null
}

/**
 * 跑一个侦察子进程，带超时与进程树杀灭。
 *
 * 与全仓一致的三条（约束 2 / 3）：
 *  - `spawn(exe, args[])` 数组参数，没有 shell、没有拼字符串。用户文件名可能含空格、
 *    引号、`&`、`$()`、中文、emoji，走数组时 shell 根本不参与解析。
 *  - 超时要**杀进程树**：`taskkill /pid <pid> /T /F`（复用 `core/kill.ts`，这里不另写一份）。
 *    7z 会拉起子进程、`soffice` 那种瘦壳更是只杀父进程就留孤儿占锁。
 *  - **绝不抛。** `spawn('')` 是**同步抛** `ERR_INVALID_ARG_VALUE`，而它抛在 Promise 的
 *    executor 里就变成整个 Promise 拒绝 → 工具调用崩掉。这里必须把它收成 `spawnError`。
 */
function run(exe: string, args: string[], timeoutMs: number): Promise<RunResult> {
  return new Promise<RunResult>((done) => {
    let child: ChildProcess
    try {
      child = spawn(exe, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      done({
        code: null,
        stdout: '',
        stderr: '',
        timedOut: false,
        spawnError: describeError(error)
      })
      return
    }

    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false

    const finish = (code: number | null, spawnError: string | null = null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      done({ code, stdout, stderr, timedOut, spawnError })
    }

    // 到点先杀父进程、再交给 killTree 杀树。**不能只等 'close'**：万一 taskkill 也失灵，
    // 这一次工具调用就永远挂着了，所以 killTree 一回来（它自己保证一定 resolve，
    // 见 core/kill.ts 里那个 5 秒兜底）就无条件收尾，用的是已经收到的那些输出。
    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
      void killTree(child.pid).then(() => finish(null))
    }, timeoutMs)

    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length >= STREAM_CAP) return
      stdout += chunk.toString('utf8')
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length >= STREAM_CAP) return
      stderr += chunk.toString('utf8')
    })

    child.on('error', (error) => finish(null, describeError(error)))
    child.on('close', (code) => finish(code))
  })
}

/** 输出里最后一条非空行。给 `note` 用——报错的原因通常在尾部，而不是开头那堆噪声里 */
function lastLine(text: string): string {
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0)
  const last = lines[lines.length - 1] ?? ''
  return last.trim().slice(0, 200)
}

/* ------------------------------------------------------------- 侦察实现 */

interface Scout {
  probe: InspectProbe | null
  note: string | null
}

/** 一个字都没拿到的空探针——用于判断「探了等于没探」，见 `hasNothing` */
function emptyProbe(): InspectProbe {
  return {
    format: null,
    durationSec: null,
    width: null,
    height: null,
    hasVideo: false,
    hasAudio: false,
    videoCodec: null,
    audioCodec: null,
    entries: null,
    rarSupported: null
  }
}

function hasNothing(probe: InspectProbe): boolean {
  return (
    probe.format === null &&
    probe.durationSec === null &&
    probe.width === null &&
    probe.height === null &&
    !probe.hasVideo &&
    !probe.hasAudio &&
    probe.videoCodec === null &&
    probe.audioCodec === null &&
    probe.entries === null
  )
}

/**
 * 音视频：问 ffmpeg。
 *
 * **不装 ffprobe，也不用专门探测进程**（约束 5）：`ffmpeg -i <file>` 打开输入时就会把
 * `Input #0 … Duration: …` 和每个 `Stream #` 打到 stderr 上，这就是我们要的全部。
 * 解析走 `parseProbeOutput`，本文件只补一个分辨率正则（理由见 `RESOLUTION_RE`）。
 *
 * **不看退出码**：`ffmpeg -i` 不带输出文件时必定非 0 退出（实测 1），而那正是本函数的用法。
 * 判据是「解析结果是不是空的」；读不出来时把 stderr 最后一行带上，那句
 * `moov atom not found` 比任何自造的文案都有用。
 *
 * `note` 里**刻意不报退出码**：ffmpeg 的失败码是 `AVERROR_*` 那套负值，经 Node 报出来
 * 是 `3199971767` 这种无符号数（实测），对 agent 是纯噪声。
 */
async function scoutMedia(path: string): Promise<Scout> {
  let exe = ''
  try {
    exe = ffmpegPath()
  } catch (error) {
    return { probe: null, note: `找不到 ffmpeg，读不出流信息：${describeError(error)}` }
  }

  let result: RunResult
  try {
    result = await run(exe, buildProbeArgs(path), PROBE_TIMEOUT_MS)
  } catch (error) {
    return { probe: null, note: `ffmpeg 侦察失败：${describeError(error)}` }
  }

  if (result.spawnError) {
    return { probe: null, note: `无法启动 ffmpeg：${result.spawnError}` }
  }
  if (result.timedOut) {
    return {
      probe: null,
      note: `ffmpeg 超过 ${PROBE_TIMEOUT_MS / 1000} 秒没有返回，已杀掉进程树；文件所在磁盘可能很慢`
    }
  }

  const info = parseProbeOutput(result.stderr)
  const resolution = RESOLUTION_RE.exec(result.stderr)

  const probe: InspectProbe = {
    format: FORMAT_RE.exec(result.stderr)?.[1].trim() ?? null,
    durationSec: info.durationSec,
    width: resolution ? Number(resolution[1]) : null,
    height: resolution ? Number(resolution[2]) : null,
    hasVideo: info.hasVideo,
    hasAudio: info.hasAudio,
    videoCodec: info.videoCodec,
    audioCodec: info.audioCodec,
    entries: null,
    rarSupported: null
  }

  if (hasNothing(probe)) {
    return {
      probe: null,
      note: `ffmpeg 读不出流信息，文件可能损坏或不是它扩展名宣称的格式：${
        lastLine(result.stderr) || '（stderr 为空）'
      }`
    }
  }

  return { probe, note: null }
}

/**
 * 图片：问 sharp。
 *
 * 只读 `metadata()`——它不解码像素，所以既快又不必担心像素炸弹（`converters/image.ts`
 * 那份 `limitInputPixels` 是给真正解码用的，这里不需要，也就不去抄那个私有常量：
 * 抄一份就是又一处会分家的副本）。
 *
 * ⚠️ **HEIC 的元数据读得出来，但那不代表像素解得开**（约束 6）：sharp 的预编译 libvips
 * 因 HEVC 专利剔除了 libde265，`metadata()` 好端端地返回 `format: 'heif'` 和正确尺寸，
 * 一取像素才报 `bad seek`。这里给的是侦察结果，别把它当成「这张图能转」的保证。
 */
async function scoutImage(path: string): Promise<Scout> {
  try {
    const meta = await sharp(path, { failOn: 'none' }).metadata()
    const probe = emptyProbe()
    probe.format = meta.format ?? null
    probe.width = meta.width ?? null
    probe.height = meta.height ?? null

    if (probe.format === null && probe.width === null && probe.height === null) {
      return { probe: null, note: 'sharp 认不出这个文件，也就没有尺寸可报' }
    }
    return { probe, note: null }
  } catch (error) {
    return { probe: null, note: `sharp 读不出这张图的元数据：${describeError(error)}` }
  }
}

/**
 * 数一个 `7z l -ba -slt` 输出里的条目。
 *
 * **用 `-ba -slt` 而不是默认的表格**：默认输出末尾有一行 `2 files` 汇总，看着更省事，
 * 但表格行的列是**按文件名对齐的定宽文本**，一个含空格、`\r` 的文件名就能把后面几列
 * 挤歪；`-slt` 是 `键 = 值` 一行一条，与文件名长什么样无关。
 * `-ba`（bare）去掉归档自己那个头部块，于是「`^Path = ` 的行数」就是条目数，
 * 不用减 1。实测：一个装了两个文件的 zip，`7z l -ba -slt` 输出恰好两行 `Path = `。
 *
 * `--` 之后的参数一律当文件名（约束 11）：用户压缩包里可能有个叫 `-y.txt` 的条目，
 * 少了这个分隔符会被 7z 当成开关。
 */
function countEntries(listing: string): number {
  return (listing.match(ENTRY_RE) ?? []).length
}

/**
 * 归档：列出条目。
 *
 * 顺带把「这个 7-Zip 能不能解 RAR」一起报出去——它取决于磁盘上装的是完整版
 * `7z.exe`（带 `7z.dll`）还是 `7zip-bin` 发来的精简版 `7za.exe`，后者**一个 RAR
 * 编解码器都没有**（约束 11），而它遇到 `.rar` 只报一句含糊的
 * `Cannot open the file as archive`，看不出缺什么。提前说清楚，agent 就能提示用户
 * 跑 `node scripts/fetch-bundled-engines.mjs`，而不是丢一个看不懂的失败。
 */
async function scoutArchive(path: string): Promise<Scout> {
  let engine: ReturnType<typeof sevenZipEngine> = null
  try {
    engine = sevenZipEngine()
  } catch (error) {
    // `bundledEnginePath()` 在 MCP 进程里没被 `setAppPaths()` 初始化过就会抛
    // （见 core/appPaths.ts）。这条也收成结构化结果——工具抛出去 agent 就只剩一句话了。
    return { probe: null, note: `7-Zip 路径解析失败：${describeError(error)}` }
  }
  if (!engine) {
    return { probe: null, note: '找不到 7-Zip 可执行文件，列不出压缩包内容' }
  }

  const result = await run(engine.path, ['l', '-ba', '-slt', '--', path], PROBE_TIMEOUT_MS)

  if (result.spawnError) {
    return { probe: null, note: `无法启动 7-Zip：${result.spawnError}` }
  }
  if (result.timedOut) {
    return { probe: null, note: `7-Zip 超过 ${PROBE_TIMEOUT_MS / 1000} 秒没有返回，已杀掉进程树` }
  }
  if (result.code !== 0) {
    return {
      probe: null,
      note: `7-Zip 列不出条目（退出码 ${result.code ?? '未知'}），文件可能损坏或需要完整版 7z：${
        lastLine(result.stderr) || '（stderr 为空）'
      }`
    }
  }

  const probe = emptyProbe()
  probe.entries = countEntries(result.stdout)
  probe.rarSupported = engine.supportsRar
  return { probe, note: null }
}

/* --------------------------------------------------------------- 入口 */

/**
 * 侦察一个文件。
 *
 * 返回的每一条都在回答一个具体问题：`ext` / `category` / `probe.format` 是「这是什么」，
 * `targets` / `engine` / `requiresDownload` 是「能不能转、谁来转、要不要先下引擎」，
 * `probe` 是「编码器是什么、多长、多大」，`cost` / `lossy` / `estimate` 是 E-3 的
 * 「要下多大、会不会掉画质、大概多久」（三件套一律按**默认目标**算，见 `InspectResult`）。
 *
 * `note` 只在**有话说**的时候出现（文件不存在、扩展名不认识、引擎起不来、探了等于没探）。
 */
export async function inspectFile(inputPath: string): Promise<InspectResult> {
  const raw = typeof inputPath === 'string' ? inputPath.trim() : ''
  const path = resolve(raw)
  const ext = extOf(path)
  const category = categoryOf(ext)
  const targets = targetsFor(ext)

  // 首选引擎按**默认目标**算：`defaultTargetFor` 是 UI 上卡片默认选中的那一个，
  // 于是 inspect 报的引擎与用户点一次转换真正会走的是同一个
  // （两者都经 `engineFor` / `targetsFor` 裁决，见 shared/formats.ts）。
  const target = category ? defaultTargetFor(ext) : null
  const engine = target ? engineFor(ext, target) : null

  // 下面这几条早退（不存在 / 是目录 / 扩展名不认得 / 没有出口）**都没有一次「要走的
  // 转换」**，所以三件套报「空」而不是「未知」：`download_bytes: 0` 说的是这条路
  // 没什么要下的，不是「拿不到」。真拿不到时那两个数字是 `null`——两种空含义不同，
  // 见 `EngineCost` 的注释。
  const base: InspectResult = {
    path,
    exists: false,
    size: null,
    ext,
    category,
    targets,
    engine,
    requiresDownload: target ? requiresDownload(ext, target) : null,
    probe: null,
    cost: { engine: null, download_bytes: 0, unpacked_bytes: null, network_required: false },
    lossy: null,
    estimate: null,
    note: null
  }

  if (raw === '') {
    return { ...base, note: '路径为空' }
  }

  if (!existsSync(path)) {
    return { ...base, note: `文件不存在：${path}` }
  }

  let isDirectory = false
  let size: number | null = null
  try {
    const stats = statSync(path)
    isDirectory = stats.isDirectory()
    size = isDirectory ? null : stats.size
  } catch (error) {
    return { ...base, exists: true, note: `读不到文件属性：${describeError(error)}` }
  }

  if (isDirectory) {
    // 不当作「0 字节的文件」往下走：那样 agent 会得到一个「空视频」的错误印象。
    // 目录本来就没有单一尺寸、也没有编解码器，明确说出来比返回一堆 null 有用。
    return { ...base, exists: true, note: `这是一个目录，不是文件：${path}` }
  }

  const withSize: InspectResult = { ...base, exists: true, size }

  if (category === null) {
    const shown = ext === '' ? '（无扩展名）' : `.${ext}`
    return {
      ...withSize,
      note: `不认识的扩展名 ${shown}：能力矩阵里没有它，能转成什么无从判断。用 list_supported_formats 查一下支持的格式`
    }
  }

  if (targets.length === 0) {
    return { ...withSize, note: `能力矩阵里没有 ${path} 的出口格式，它转不了` }
  }

  const scout = await scoutFor(category, path)
  return {
    ...withSize,
    probe: scout.probe,
    // 三件套一律按**默认目标**算（`target`），与 `engine` / `requiresDownload` 同源。
    // `costFor` 是全文件唯一一处 IO（读清单），而且**只在真需要下载某个引擎时才读**：
    // 图片、压缩包这些不惊动任何重型引擎的侦察连一次 `readFile` 都不会发生。
    cost: await costFor(ext, target),
    lossy: lossyFor(ext, target),
    estimate: estimateFor({ fromExt: ext, toExt: target, probe: scout.probe, sizeBytes: size }),
    note: scout.note
  }
}

/**
 * 按大类分派侦察。
 *
 * 文档 / 电子书刻意**不起子进程**：时长与分辨率对它们没有意义，而 pdf 的页数、
 * epub 的章节数要真解析一遍（pdfjs 装载 194 ms 起，calibre 更是 0.7 s 起步），
 * 那是转换本身的开销，不是「侦察」该付的。`note` 里说清楚，比让 agent 猜
 * 「为什么 probe 是 null」强。
 */
function scoutFor(category: Category, path: string): Promise<Scout> {
  switch (category) {
    case 'video':
    case 'audio':
      return scoutMedia(path)
    case 'image':
      return scoutImage(path)
    case 'archive':
      return scoutArchive(path)
    case 'document':
    case 'ebook':
      return Promise.resolve({
        probe: null,
        note: `${category === 'document' ? '文档' : '电子书'}不做子进程侦察：时长 / 分辨率 / 编解码器对它没有意义`
      })
  }
}

/* -------------------------------------------------- 侦察链路（给自检复用） */

/**
 * 只侦察、不算账的那一半：一个文件「是什么、有什么」。
 *
 * **它是 E-6 产物自检要复用的那个入口**（`mcp/selfCheck.ts` import 的就是它），
 * 与 `inspectFile()` 走的是**同一套探针**（`scoutFor` 的按类别分派 → ffmpeg / sharp /
 * 7-Zip）。所以「自检报的分辨率」与「`inspect_file` 报的分辨率」不可能是两个答案，
 * 而这是结构上的保证，不是纪律。
 *
 * 与 `inspectFile()` 的分工只有一条：**这条不回答「能转成什么」**。
 * `targets` / `engine` / `requiresDownload` / 代价三件套（`cost` / `lossy` / `estimate`）
 * 一律不算——它们都按**默认目标格式**算，而这里问的是「这个文件里有什么」，
 * 源与产物各问一遍。顺带这也是为什么它比 `inspectFile()` 便宜：
 * 一次侦察只有一次子进程，不读引擎清单（`costFor` 是全模块唯一一处文件 IO）。
 *
 * **绝不抛**，与 `inspectFile()` 同一条规矩：文件不存在、是目录、扩展名不认得、
 * 引擎起不来，全部收成 `note` 里的一句话（自检那边把它列进 `notes`）。
 */
export async function probeFile(inputPath: string): Promise<VerifySide> {
  const raw = typeof inputPath === 'string' ? inputPath.trim() : ''
  const path = resolve(raw)
  const ext = extOf(path)

  if (raw === '') {
    return { path, ext, category: null, size_bytes: null, probe: null, note: '路径为空' }
  }

  let note: string | null = null
  let isDirectory = false
  let size: number | null = null
  try {
    const stats = statSync(path)
    isDirectory = stats.isDirectory()
    size = isDirectory ? null : stats.size
  } catch (error) {
    note = `读不到文件属性（文件可能已经被移走或删掉）：${describeError(error)}`
  }

  const category = categoryOf(ext)

  if (category === null) {
    return {
      path,
      ext,
      category,
      size_bytes: size,
      probe: null,
      note: note ?? `不认识的扩展名 ${ext === '' ? '（无扩展名）' : `.${ext}`}，没有可用的侦察手段`
    }
  }
  if (isDirectory) {
    return {
      path,
      ext,
      category,
      size_bytes: null,
      probe: null,
      note: '这是一个目录，不是文件'
    }
  }

  const scout = await scoutFor(category, path)
  return {
    path,
    ext,
    category,
    size_bytes: size,
    probe: scout.probe,
    // 两个 note 只会有一个非空（读属性失败时探针几乎必然也失败，而探针的说明更具体），
    // 所以相加而不是覆盖：信息一条都不丢，措辞也不必在这里硬拼。
    note: [scout.note, note].filter((line) => line !== null).join('；') || null
  }
}
