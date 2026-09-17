/**
 * `inspect_file` 的「代价三件套」：`cost` / `lossy` / `estimate`（RESEARCH §5 的 E-3）。
 *
 * 侦察的用途是**让 agent 在动手之前算一笔账**：要不要下 357 MiB 的引擎、这一步会不会掉画质、
 * 大概等多久。三个字段各自回答其中一句，而且**全部按方向判**（`(源, 目标)` 二元组），
 * 不按「源文件长什么样」泛泛地说——`mkv → mp4` 能无损、`mp4 → avi` 不能，同一个源。
 *
 * ## 四条贯穿本文件的设计约束
 *
 * 1. **`cost` 是运行时读清单，不是手抄。** 数字的唯一真相源是
 *    `resources/engines.manifest.json` 的 `sizeBytes`。任何一份「在代码里写死 375 MB」
 *    的表都会漂（本项目里已经有一张：写 375 MB 而清单是 374906880 字节 = 357.5 MiB，
 *    连单位口径都对不上），而漂了**不报错**——agent 拿一个错数字去跟用户交代。
 * 2. **判据一律复用现成的，不另写白名单。**
 *    - 要下载哪个引擎 → `@shared/formats` 的 `requiresDownload()`（与 UI、与
 *      `TaskManager` 是同一份表）。
 *    - 有没有无损通路 → `src/main/engines/ffmpeg.ts` 的 `remuxEligible()` /
 *      `canRemux()`（约束 18 那张实测出来的白名单）。
 *    在这两个模块之外再写一份，两边必然分家，而分家的表现是「inspect 说能无损、
 *    跑起来却在重编码」——不报错，只是白等几分钟。
 * 3. **绝不编。** 拿不到就给 `null`（`download_bytes` / `unpacked_bytes` / `lossy` /
 *    整个 `estimate` 都可以是 null）。`estimate` 尤其：它是**区间 + 置信度**，
 *    不是一个数——把区间当承诺报给用户，比不给数字更坏。
 * 4. **不能 import electron**（本模块在 `src/mcp/` 下）。所以清单**不能**用
 *    `core/engineInstall.ts` 的 `loadEngineManifest()`：那个函数内部会
 *    `import('./downlink')`，而 `downlink.ts` 静态 `import { net } from 'electron'`。
 *    这里只复用它的**路径**（`manifestPath()`——那个文件与它的静态依赖图都不碰
 *    electron），自己读、自己挑我们要的那两个数字。
 *
 * ## 与 `inspect.ts` 的分工
 *
 * 本模块只做「算」，不做「探」：探针（时长 / 分辨率 / 编解码器 / 条目数）由
 * `inspect.ts` 起子进程拿到后传进来。所以这里的函数都是可单测的纯逻辑，
 * 唯一有 IO 的是 `manifestEngineSizes()`，而且只读一个文件。
 *
 * ⚠️ **三件套都按「默认目标」算**（`defaultTargetFor()`），与顶层 `engine` /
 * `requiresDownload` 同一个口径。`inspect_file` 不收 `target_format`，所以别让
 * 这三个字段暗示「换成别的目标也是这样」——`targets` 里列的那些各自可能不同。
 */
import { readFile } from 'node:fs/promises'
import { categoryOf, requiresDownload } from '@shared/formats'
import type { Category, EngineKey } from '@shared/types'
import { manifestPath } from '../main/core/engineInstall'
import type { MediaInfo } from '../main/core/probe'
import { canRemux, remuxEligible } from '../main/engines/ffmpeg'

/* ------------------------------------------------------------------ 类型 */

/**
 * 估算需要的探针事实。**结构类型**，不是 `import type { InspectProbe } from './inspect'`：
 * `inspect.ts` 要 import 本模块，互相 import（哪怕是类型）会成环，而环在
 * `tsc --noEmit` 里看不出来，只在打包顺序上咬人。
 *
 * 字段与 `InspectProbe` 对齐（少一个字段这里就编不过），所以不存在「悄悄少读一项」。
 */
export interface ProbedFacts {
  durationSec: number | null
  width: number | null
  height: number | null
  hasVideo: boolean
  hasAudio: boolean
  videoCodec: string | null
  audioCodec: string | null
  entries: number | null
}

/**
 * 这次转换的「准备代价」。
 *
 * `engine` 是**这条路要准备的那个引擎**（`requiresDownload()` 的裁决），不是
 * 「谁来执行」——`rst → md` 的执行引擎是文档引擎（`engineFor` 报 `'pdf'`），
 * 要下载的却是 pandoc，按执行引擎填会让 agent 去找一个不存在的 pdf 引擎。
 */
export interface EngineCost {
  /** 要准备的重型引擎。null = 这条路不需要任何额外引擎（ffmpeg / sharp / 7-Zip / 内置文档引擎） */
  engine: EngineKey | null
  /**
   * 该引擎安装包的字节数（清单的 `sizeBytes`）。
   *
   * 三种取值，含义不同，别混：
   *   - `0` —— 不需要额外引擎，没什么要下的；
   *   - 正整数 —— 清单里写着它多大；
   *   - `null` —— 需要引擎，但**清单读不到**（打包残缺、路径没注入、JSON 坏了）。
   *     这时 `engine` 仍然有效：它来自能力矩阵，与清单无关。
   */
  download_bytes: number | null
  /**
   * 解包之后落地的字节数。
   *
   * **只有清单声明了才有**：`zip-entry` 那条（pandoc 的 wheel）写着
   * `expectedEntrySizeBytes`，抽出来的就是那一个文件；两条 `msiexec-a` 的解包体积
   * 清单里没有这一项，所以是 `null`。这里**刻意不去填 docs/NOTES.md 约束 16 里那两个
   * 手测值**（LibreOffice 1.49 GiB / Calibre 658,600,649 字节）——那是实测值不是清单值，
   * 抄进代码就是第二张会漂的表，而它一旦漂了没有任何东西会红。
   */
  unpacked_bytes: number | null
  /**
   * 这条路**依赖一个按需下载的重型引擎**。
   *
   * ⚠️ 它是**结构性**判据（`engine !== null` 的布尔投影），**不查本机装没装**：
   * 用户可能早就装过 LibreOffice（`engines/heavy.ts` 会复用系统安装），那时联网下载
   * 根本不需要。「现在要不要联网」这个问题由 `convert_file` 在**排队之前**裁决
   * （`jobs.ts` 的 `assertEngineReady`，引擎缺失时它明确拒掉），那一步必须做——排到
   * 队里再失败时 agent 已经又发了两轮调用。
   *
   * 之所以留这个布尔而不是让 agent 自己判 `engine !== null`：两个字段同源同判据，
   * 不会有第二种解释。
   */
  network_required: boolean
}

/** 区间估得准不准。**闭集**，agent 可以拿它做 switch。 */
export const ESTIMATE_CONFIDENCE = ['high', 'medium', 'low'] as const

export type EstimateConfidence = (typeof ESTIMATE_CONFIDENCE)[number]

/**
 * 耗时估算。**永远是区间 + 置信度，永远不是一个数。**
 *
 * 为什么不是单值：本项目的绝对值耗时**随负载漂 20%+**（同一份代码相隔三小时差 27%，
 * 见约束 25 的测量口径），而且这里连帧率都拿不到（探针里没有）。给一个数就是给一个
 * 假的精确度，agent 会把它当承诺转述给用户。
 *
 * `confidence` 是承重的那一半：
 *   - `high` —— 判据里的关键输入都拿到了，而且**路径本身已被实测**（能 remux 那一条
 *     走的就是 `-c copy`，与素材内容无关），区间只是磁盘与负载的裕量；
 *   - `medium` —— 关键输入拿到了，但路径本身带假设（重编码按 30fps 估、图片按像素
 *     线性缩放——而 AVIF / HEIC 比这个慢得多）；
 *   - `low` —— 关键输入缺一半以上（文档类压根不探时长、损坏文件探不出来），
 *     区间是**按类别**给的宽频带，只够判断「秒级还是分钟级」。
 */
export interface CostEstimate {
  /** `[下限, 上限]`，秒。恒有 `lo <= hi` */
  seconds: [number, number]
  confidence: EstimateConfidence
}

/* ------------------------------------------------------------ 引擎清单 */

/** 清单里我们要的那两个数字 */
export interface EngineManifestSize {
  downloadBytes: number
  unpackedBytes: number | null
}

/**
 * 清单只读一次，**而且只在成功时缓存**。
 *
 * 与 `core/engineInstall.ts` 的 `loadEngineManifest()` 同一个取舍：把失败也缓存起来，
 * 一次读盘抖动就变成「这个进程永远报不出下载体积」，而那个后果是静默的——agent 拿到的
 * 是 `download_bytes: null`，它只会以为这个引擎没写大小。
 */
let sizesCache: Promise<Map<string, EngineManifestSize>> | null = null

function manifestEngineSizes(): Promise<Map<string, EngineManifestSize>> {
  if (sizesCache === null) {
    sizesCache = readManifestSizes().catch((error: unknown) => {
      sizesCache = null
      throw error
    })
  }
  return sizesCache
}

/**
 * 读清单、只挑 `key` / `sizeBytes` / `extract.expectedEntrySizeBytes` 三项。
 *
 * ⚠️ **刻意不走 `core/downlink.ts` 的 `parseManifest()`**（那份校验严得多，也本该是
 * 唯一入口）：那个模块静态 `import { net } from 'electron'`，在 MCP 这个没有 Electron
 * 的进程里加载它，就是往封锁台账上记一笔（`test-mcp-inspect.ts` 有一条断言专门钉
 * 「整轮侦察里没有任何模块**试图**加载 electron」）。而 `parseManifest` 是纯函数、
 * 只是恰好住在那个文件里——够不着它，不是偷懒。
 *
 * 代价要说清楚：这里**不做** schemaVersion 校验、不做 sha256 形状校验。这是可接受的，
 * 因为本模块只读两个显示用的数字，**下载那一侧的判据一概不经过这里**（真正下载走的是
 * `engineInstall.ts` → `downlink.parseManifest`，那里一个字符不合格就抛）。这里读坏了
 * 的最坏后果是「体积显示不出来」（`null`），不是「下了一个坏包」。
 */
async function readManifestSizes(): Promise<Map<string, EngineManifestSize>> {
  const text = await readFile(manifestPath(), 'utf8')
  const parsed: unknown = JSON.parse(text)
  const engines = (parsed as { engines?: unknown } | null)?.engines
  if (!Array.isArray(engines)) throw new Error('引擎清单里没有 engines 数组')

  const out = new Map<string, EngineManifestSize>()
  for (const raw of engines) {
    if (typeof raw !== 'object' || raw === null) continue
    const entry = raw as Record<string, unknown>
    const key = entry.key
    const size = entry.sizeBytes
    if (typeof key !== 'string' || key === '') continue
    if (typeof size !== 'number' || !Number.isFinite(size) || size <= 0) continue

    const extract = entry.extract as Record<string, unknown> | undefined
    const unpacked = extract?.expectedEntrySizeBytes
    out.set(key, {
      downloadBytes: size,
      unpackedBytes:
        typeof unpacked === 'number' && Number.isFinite(unpacked) && unpacked > 0 ? unpacked : null
    })
  }
  return out
}

/**
 * 这一次转换要准备哪个引擎、多大（**运行时读清单**）。
 *
 * `toExt` 为 null（没有默认出口）时按「没有额外引擎」报：没有要走的转换，也就没有代价。
 * 清单读不到时**不抛**——`inspect_file` 的全部出口都是结构化结果（拿不到就 null），
 * 在这里抛出去会让 agent 只剩一句话，而它真正需要的信息（引擎是谁）我们是有的。
 */
export async function costFor(fromExt: string, toExt: string | null): Promise<EngineCost> {
  const engine = toExt === null ? null : requiresDownload(fromExt, toExt)
  if (engine === null) {
    return { engine: null, download_bytes: 0, unpacked_bytes: null, network_required: false }
  }

  let size: EngineManifestSize | undefined
  try {
    size = (await manifestEngineSizes()).get(engine)
  } catch {
    size = undefined
  }

  return {
    engine,
    download_bytes: size?.downloadBytes ?? null,
    unpacked_bytes: size?.unpackedBytes ?? null,
    network_required: true
  }
}

/* ------------------------------------------------------------------ lossy */

/**
 * 按类别裁决有损与否。三档各自讲得通，见 `lossyFor` 的说明。
 *
 * 单独抽出来不只是为了好读：它让「类别」这个参数**真的被用上**（而不是在函数体里
 * 各判一次），三档因此在一处可读地并列——它们是一张表，不是三个散落的 if。
 */
function lossyByCategory(category: Category, fromExt: string, toExt: string): boolean {
  // 音视频：唯一的无损通路是 remux 白名单，而它**按方向**（约束 18）
  if (category === 'video' || category === 'audio') return !remuxEligible(fromExt, toExt)
  // 归档：全拆开 + 重新打包，条目内容逐字节不变（约束 11）——这是事实，不是估计
  if (category === 'archive') return false
  // 图片 / 文档 / 电子书：没有现成的无损判据，一律按有损报（保守方向，见下）
  return true
}

/**
 * 这一步会不会丢信息。**`true` 的含义是「一定有损」，`false` 是「存在无损通路」。**
 * `null` 表示这个方向判不了（扩展名不认得，或压根没有默认出口）。
 *
 * 三档的理由：
 *
 *   - **音视频** → `!remuxEligible(fromExt, toExt)`。这是本项目唯一一条真正被实测过的
 *     无损通路（约束 18 那张白名单），而且它**按方向**：`mkv → mp4` 有 remux 资格，
 *     `mp4 → avi` 没有（avi 整条不进表），`→ gif` 也没有（必须过调色板滤镜）。
 *     注意方向够格只说明**有可能**无损——真正的取舍还要看编解码器（`vp9 + aac → webm`
 *     装不进去），而 `mode: "auto"` 会先试 remux、失败才重编码，所以这里报 false
 *     与「默认行为是无损的」一致。
 *   - **归档** → `false`。压缩包互转是「全拆开 + 重新打包」，**条目内容逐字节不变**
 *     （约束 11），这是构造性的事实，不是估计。
 *   - **图片 / 文档 / 电子书** → `true`，**是保守判定，不是精确判定**。
 *     这几类里没有现成的「无损通路」判据（`png → tiff` 其实是逐像素保真的），
 *     而两个方向里**报多了只是让 agent 多提醒用户一句，报少了是它替用户保证
 *     「不会掉画质」而其实掉了**。所以一律按有损报，宁可啰嗦。
 */
export function lossyFor(fromExt: string, toExt: string | null): boolean | null {
  if (toExt === null) return null
  const category = categoryOf(fromExt)
  if (category === null) return null
  return lossyByCategory(category, fromExt, toExt)
}

/* --------------------------------------------------------------- estimate */

/**
 * 估速模型里的常数。**每一个都写清来历**，因为它们是把实测换算成公式的那一步。
 *
 * `STARTUP_SEC` 0.05 s：裸启动一次 ffmpeg 实测约 25 ms（约束 5），加上进程创建与
 *   输出名解析，50 ms 是个覆盖得住的下限。**别拿单任务墙钟去做差算它**——
 *   单任务那次还包含一次性的模块加载（libvips / pdfjs），减出来会出现负数。
 * `ENCODE_FAST` / `ENCODE_SLOW` 800 / 80 兆像素每秒：实测 1920x1080 / 30fps / 20 s
 *   用 `libx264 veryfast` 是 1524 ms（约 622 兆像素 → 408 Mpix/s），高熵 1080p60
 *   是 3.89 s（1244 兆像素 → 320 Mpix/s）。快的那一侧取 800（比实测最快再放宽一倍），
 *   慢的那一侧取 80（保守 5 倍余量）——区间要**盖得住**，不是要好看。
 * `IMAGE_FAST` / `IMAGE_SLOW` 200 / 20 兆像素每秒：实测 sharp 处理 4032x3024（12.2 MP）
 *   在并发 4 下 24 张共 743 ms（单张约 124 ms ≈ 98 Mpix/s）。AVIF / HEIC 慢一个数量级，
 *   所以慢的那一侧放到 20。
 * `ASSUMED_FPS` 30：**探针里没有帧率**（`parseProbeOutput` 只给时长与编解码器），
 *   所以重编码的估算必须假定一个。这是 `confidence: 'medium'` 而不是 `high` 的原因。
 */
const STARTUP_SEC = 0.05
const ENCODE_FAST = 800e6
const ENCODE_SLOW = 80e6
const IMAGE_FAST = 200e6
const IMAGE_SLOW = 20e6
const ASSUMED_FPS = 30

/** 归档按体积估：实测 `-mx=5` 打包 96 MB **随机数据** 6 秒出头（约 16 MB/s），全零数据只要 0.4 秒 */
const ARCHIVE_FAST = 100e6
const ARCHIVE_SLOW = 3e6

function round1(value: number): number {
  return Math.round(value * 10) / 10
}

/** 组装一个区间。**`lo <= hi` 在这里强制成立**（调用点算反了也不会交出倒过来的区间） */
function band(lo: number, hi: number, confidence: EstimateConfidence): CostEstimate {
  const low = Math.max(STARTUP_SEC, Math.min(lo, hi))
  const high = Math.max(low, Math.max(lo, hi))
  return { seconds: [round1(low), round1(high)], confidence }
}

/**
 * 探针 → remux 判据要的 `MediaInfo`（只有那五个字段，与 `core/probe.ts` 的那一份同形）。
 *
 * **导出**是给 `plan.ts`（E-5 的 `dry_run`）用的：它同样要问一句「这一对装不装得下」，
 * 而 `canRemux` 的入参投影**只该有一份**——各写一份的话，改天 `MediaInfo` 多一个字段，
 * 两条路里就会有一条按 `undefined` 去判，而判错的表现是「预览说能 remux、真跑失败」。
 */
export function mediaInfoOf(probe: ProbedFacts): MediaInfo {
  return {
    durationSec: probe.durationSec,
    hasVideo: probe.hasVideo,
    hasAudio: probe.hasAudio,
    videoCodec: probe.videoCodec,
    audioCodec: probe.audioCodec
  }
}

/**
 * 文档 / 电子书：**按引擎给频带**，不按文件内容。
 *
 * 理由可解释：这几类的耗时几乎全在「引擎冷启动 + 解析」，而解析量随文件大小没有视频
 * 那种数量级关系（一份 300 页 PDF 与一份 3 页的都是同一个 pdfjs 装载）。频带取的是
 * 各引擎的**实测数量级**（约束 12 / 14 / 16）：
 *   - `pandoc` 冷启动 330 ms、热 56~66 ms，所以上限 4 秒；
 *   - `libreoffice` 光是 `soffice` 冷启动就几百毫秒到一秒起，转一份 docx 要几秒，
 *     上限给 30 秒；
 *   - `calibre` 的 `ebook-convert` 同理，上限 20 秒；
 *   - 其余（Chromium 打印 PDF、pdfjs 抽文本、mammoth 解 docx）：实测 A4 三页
 *     150 DPI 是「模块装载 194 ms + 每页 35 ms」，上限 8 秒足够宽。
 *
 * 一律 `low`：**这些转换从来没有被系统地基准过**，区间只够回答「秒级还是分钟级」。
 */
const DOCUMENT_BANDS: Record<string, [number, number]> = {
  pandoc: [0.1, 4],
  libreoffice: [1.5, 30],
  calibre: [1, 20]
}

const DOCUMENT_DEFAULT_BAND: [number, number] = [0.2, 8]

/**
 * 估这一次转换要多久。判不了就返回 `null`（没有默认出口、扩展名不认得）。
 *
 * 音视频那一支**先从 remux 判起**：`remuxEligible()` 说方向够格、`canRemux()` 说
 * 编解码器也装得下时，这条路是真的 `-c copy`，耗时与内容无关、只跟体积走——这正是
 * 本项目最值钱的一条估算（33.9× 的差别，见约束 18），所以它单独一档、置信度也最高。
 */
export function estimateFor(input: {
  fromExt: string
  toExt: string | null
  probe: ProbedFacts | null
  sizeBytes: number | null
}): CostEstimate | null {
  const { fromExt, toExt, probe, sizeBytes } = input
  if (toExt === null) return null

  const category = categoryOf(fromExt)
  if (category === null) return null

  if (category === 'video' || category === 'audio') {
    return mediaEstimate(fromExt, toExt, probe, sizeBytes)
  }

  if (category === 'image') {
    const pixels = probe?.width != null && probe.height != null ? probe.width * probe.height : null
    if (pixels !== null && pixels > 0) {
      return band(STARTUP_SEC + pixels / IMAGE_FAST, STARTUP_SEC + pixels / IMAGE_SLOW, 'medium')
    }
    return band(STARTUP_SEC, 2, 'low')
  }

  if (category === 'archive') {
    // 条目数**不参与**估算：实测决定耗时的是**不可压缩数据的体积**（LZMA 的长游程匹配
    // 让全零数据快得离谱），而不是文件个数。它仍然报在 probe 里，供 agent 自己判断。
    const bytes = sizeBytes ?? 0
    return band(0.2 + bytes / ARCHIVE_FAST, 0.2 + bytes / ARCHIVE_SLOW, 'medium')
  }

  // document / ebook
  const engine = requiresDownload(fromExt, toExt)
  const chosen = (engine !== null ? DOCUMENT_BANDS[engine] : undefined) ?? DOCUMENT_DEFAULT_BAND
  return band(chosen[0], chosen[1], 'low')
}

/** 音视频那一路：能 remux 一档、重编码两档（视频按像素、音频按时长）、兜底一档 */
function mediaEstimate(
  fromExt: string,
  toExt: string,
  probe: ProbedFacts | null,
  sizeBytes: number | null
): CostEstimate {
  const duration = probe?.durationSec ?? null
  const pixels = probe?.width != null && probe.height != null ? probe.width * probe.height : null

  // ① 确认能 `-c copy`：耗时只跟字节数走
  if (probe !== null && remuxEligible(fromExt, toExt) && canRemux(toExt, mediaInfoOf(probe))) {
    const bytes = sizeBytes ?? 0
    return band(STARTUP_SEC + bytes / 500e6, STARTUP_SEC + bytes / 20e6 + 0.3, 'high')
  }

  // ② 视频重编码：像素总量（分辨率 × 时长 × 假定帧率）
  if (probe?.hasVideo === true && pixels !== null && duration !== null) {
    const totalPixels = pixels * duration * ASSUMED_FPS
    const fast = STARTUP_SEC + totalPixels / ENCODE_FAST
    const slow = STARTUP_SEC + totalPixels / ENCODE_SLOW
    return band(fast, slow, 'medium')
  }

  // ③ 纯音频重编码：只有时长可依
  if (probe !== null && !probe.hasVideo && duration !== null) {
    const fast = STARTUP_SEC + duration * 0.005
    const slow = STARTUP_SEC + duration * 0.06
    return band(fast, slow, 'medium')
  }

  // ④ 探针没给出可用输入（损坏文件、流式媒体、`Duration: N/A`）：按体积给一个宽频带。
  //    **不静默返回 null**：agent 至少要知道「这个文件不是几毫秒能转完的」。
  const bytes = sizeBytes ?? 0
  return band(STARTUP_SEC + bytes / 200e6, STARTUP_SEC + bytes / 1.5e6 + 1, 'low')
}
