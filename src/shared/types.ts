/**
 * 媒体大类。决定 UI 分组、默认目标格式、以及走哪个转换引擎。
 *
 * 写成常量数组再派生类型，是为了让「有哪些类别」在**运行时**也拿得到：
 * IPC 的 zod 枚举、关于页的分组、设置页的六行下拉都要用它。
 * 各处各写一份字符串数组迟早漂移，而漂移的表现是某个类别静默消失。
 */
export const CATEGORIES = ['video', 'audio', 'image', 'document', 'ebook', 'archive'] as const

export type Category = (typeof CATEGORIES)[number]

/** 转换引擎标识。每个引擎有独立的并发上限与进度上报能力。 */
export const ENGINE_KEYS = [
  'ffmpeg',
  'sharp',
  'pdf',
  'pandoc',
  'libreoffice',
  'calibre',
  'archive',
  /**
   * 加密音乐容器（`.ncm` / `.qmc*` / `.mflac` / `.mgg` / `.kwm` / `.xm`）。
   *
   * **它不是一个「解码器」，而是一个「开壳器」**：把外壳剥掉、拿回里面那个真正的
   * mp3 / flac，然后按需要交给 ffmpeg。所以它与 ffmpeg 是两个引擎，而不是
   * ffmpeg 的一种输入格式——ffmpeg 根本不认识这些容器。
   */
  'encmusic'
] as const

export type EngineKey = (typeof ENGINE_KEYS)[number]

export type TaskStatus = 'queued' | 'waiting_engine' | 'running' | 'done' | 'error' | 'canceled'

/* ------------------------------------------------------------------ 任务参数 */

/**
 * 裁剪模式。写成常量数组再派生类型，理由与 `CATEGORIES` 一样：
 * IPC 的 zod 枚举、界面的模式选择器、以及参数构造三处都要用它。
 *
 * - `'lossless'` `-c copy`，一个字节都不重编；**起点会对齐到最近的关键帧**
 * - `'exact'`    重编码，帧级准确，代价是画质与几倍的时间
 */
export const TRIM_MODES = ['lossless', 'exact'] as const

export type TrimMode = (typeof TRIM_MODES)[number]

/**
 * 视频/音频裁剪。
 *
 * **区间语义写死在这里：`[start, end)`，左闭右开，`end > start`。**
 * 输出内容 = 请求区间，两种模式的差别只在「起点能不能精确落在 `start` 上」：
 *
 * - 无损模式必然包含 `[start, end)`，**可能多出** `[关键帧, start)` 这一段（不多不少，就是
 *   到前一个关键帧的距离）以及末尾最多几帧（B 帧重排延迟，实测 ≤ 0.14 s）；
 * - 精确模式给的正好是 `[start, end)`。
 *
 * 换句话说**两种模式都不会吃掉用户要的内容**——这一条是实测出来的，不是设计意图：
 * 朴素写法（不带 `-avoid_negative_ts make_zero`）会让无损模式丢掉
 * `[start, 关键帧+时长)` 这一段，见 `engines/ffmpeg.ts` 的 `buildTrimCopyArgs`。
 */
export interface TrimOptions {
  /** 起点，秒，非负 */
  start: number
  /** 终点，秒，必须大于 `start` */
  end: number
  mode: TrimMode
}

/**
 * 图片缩放方式。写成常量数组再派生类型，理由与 `CATEGORIES` 一样：
 * zod 枚举、界面选择器、以及 sharp 的 `fit` 三处都要用它。
 *
 * - `'inside'` 装进 `width`×`height` 这个框，**保持比例**，不裁切（最常用）
 * - `'cover'`  填满这个框，保持比例，**多出来的裁掉**
 * - `'fill'`   拉伸到正好这个尺寸，**会变形**
 */
export const IMAGE_FITS = ['inside', 'cover', 'fill'] as const

export type ImageFit = (typeof IMAGE_FITS)[number]

/**
 * 缩放到指定尺寸。**处理链里的一个动作**。
 *
 * ⚠️ **`withoutEnlargement` 是承重的，默认必须是 `true`。** sharp 自己的默认是
 * `false`，也就是「长边 1920」会把一张 800px 的图**放大**成 1920——用户要的是「太大就缩小」，
 * 拿到的却是「小图被拉大」，画质还平白劣化一次。这个默认值反过来写是本项目最忌讳的
 * 「不报错的错误答案」，所以它是**必填字段**而不是可选（省略即用错默认值的路要堵死）。
 *
 * 宽高**至少给一个**：两个都不给的动作不改变任何像素，是一个空转——那种情况
 * 调用方该把它从链里去掉，而不是留一个什么都不做的步骤。
 */
export interface ResizeAction {
  kind: 'resize'
  /** 目标宽度，像素。与 `height` 至少给一个 */
  width?: number
  /** 目标高度，像素 */
  height?: number
  fit: ImageFit
  /** 小图不放大。**默认 `true`**，见上方注释 */
  withoutEnlargement: boolean
}

/* ------------------------------------------------------------------ 处理链的其余动作 */

/**
 * 去隔行方式。写成常量数组再派生类型，理由与 `CATEGORIES` 一样。
 *
 * ⚠️ **这份清单是实测的产物，不是照文档抄的**（见 `docs/RESEARCH.md` §3）：
 * - `nnedi` **列在 ffmpeg 的滤镜表里但用不了**——它要外部权重文件，实测 `rc=127`
 *   加 `No weights file provided, aborting!`。「有滤镜」不等于「能用」。
 * - `idet` 与 `detelecine` **实测缺**，所以做不了「自动判断要不要去隔行」，
 *   只能让用户自己看着办。
 */
export const DEINTERLACE_METHODS = ['yadif', 'bwdif'] as const

export type DeinterlaceMethod = (typeof DEINTERLACE_METHODS)[number]

/**
 * 去隔行。**必须排在降噪与锐化之前**——反了会把隔行留下的一半行当成细节锐化出来。
 *
 * 顺序由数组位置表达（见 `FilterAction`），**这里不做强制**：用户可能有自己的理由。
 * 但界面上「添加」时会插在默认位置，见 `FiltersSection`。
 */
export interface DeinterlaceAction {
  kind: 'deinterlace'
  method: DeinterlaceMethod
}

/**
 * 降噪强度。三档而不是一个连续值：`hqdn3d` 的三个参数（空间/时间各两个）
 * 对普通用户没有可解释性，而档位能被写进文案里。
 *
 * ⚠️ **不在清单里的 `nlmeans` 是有意排除的**：实测它在 1080p 上远慢于实时，
 * 而本项目处理的是用户拖进来的任意长度视频——「点一下、跑一晚上」不是一个可交付的档位。
 * ⚠️ 降噪对**本来干净的素材是纯损失**，所以它默认不加，必须是用户显式选的
 * （与 NVENC「默认关」同一条纪律）。
 */
export const DENOISE_STRENGTHS = ['light', 'medium', 'strong'] as const

export type DenoiseStrength = (typeof DENOISE_STRENGTHS)[number]

export interface DenoiseAction {
  kind: 'denoise'
  strength: DenoiseStrength
}

/**
 * 锐化的可调范围。`unsharp` 的 amount，1.0 是「看得出来的锐化」的起点。
 *
 * 住在这里而不是 `shared/options.ts`（那里住着体积/尺寸的限额）：它只对这一个动作有意义，
 * 而 schema 与界面都从这份唯一的清单取数——两边各写一个数就是「界面放行了主进程会拒的值」。
 */
export const MIN_SHARPEN = 0.1
export const MAX_SHARPEN = 3

export interface SharpenAction {
  kind: 'sharpen'
  /** 锐化强度，`MIN_SHARPEN`~`MAX_SHARPEN` */
  amount: number
}

/**
 * 响度归一化（EBU R128 的两遍 `loudnorm`）。
 *
 * -14 LUFS 是流媒体平台（Spotify / YouTube / 播客）的事实标准，所以它是默认值。
 * ⚠️ 两遍是承重的：单遍的 `loudnorm` 是**动态**归一化，它会改动态范围
 * （音质会变），而这里要的是「整段平移一个增益」。见 `engines/ffmpeg.ts`。
 */
export const DEFAULT_TARGET_LUFS = -14

/** 目标响度的可调范围。比 -70 更低没有意义（那是静音），比 -5 更高会削波。 */
export const MIN_TARGET_LUFS = -70
export const MAX_TARGET_LUFS = -5

export interface LoudnormAction {
  kind: 'loudnorm'
  /** 目标响度，LUFS。默认 `DEFAULT_TARGET_LUFS` */
  targetLufs: number
}

/** 旋转角度。只有三个直角——任意角旋转（`rotate=a*`）要补边框，是另一件事。 */
export const ROTATE_DEGREES = [90, 180, 270] as const

export type RotateDegree = (typeof ROTATE_DEGREES)[number]

/**
 * 物理转正。
 *
 * ⚠️ **这与「旋转元数据」是两件事，别混**：手机视频的 rotation 记在**容器 side data** 里，
 * `-c copy` 会把它原样搬过去——于是有的播放器转、有的不转（同一个文件两种观感）。
 * 这个动作是**真的重排像素**，代价是必须重编码。用户要的是后者时才会加它。
 */
export interface RotateAction {
  kind: 'rotate'
  degrees: RotateDegree
}

/**
 * 处理链里的**一个动作**。
 *
 * ## 为什么是有序数组，而不是一堆平行开关
 *
 * 因为**顺序是承重的，而且它不是一个「约定」能解决的事**。最典型的一组是滤镜：
 * 去隔行 → 降噪 → 锐化，**反过来会把噪点一起锐化出来**。写成 `deinterlace?` /
 * `denoise?` / `sharpen?` 三个平行字段，顺序就只能靠引擎里写死的次序排——
 * 用户看不到那个次序、也改不了它；将来再加一个动作，「它该排在哪」就成了一个
 * 没有答案的问题。写成一个数组，数组顺序就是执行顺序，界面上的排序与引擎里的
 * 执行是同一件事。
 *
 * 判别键用 `kind` 而不是「一堆可选字段的松散对象」：后者无法回答「这一步到底是不是
 * resize」，校验只能退化成「看它有没有 `width`」——那正是本项目最忌讳的那类判据
 * （拼错一个字段名就静默退化成一个空动作）。
 *
 * ⚠️ **顺序反过来也是读的顺序**：`describeFilters()` 按数组顺序生成摘要，
 * 而那条摘要是用户在卡片上核对「到底按什么参数跑的」的唯一依据。
 *
 * ⚠️ 将来加动作时**只加联合成员**，不要动数组本身的语义（别去重、别排序）。
 */
export type FilterAction =
  ResizeAction | DeinterlaceAction | DenoiseAction | SharpenAction | LoudnormAction | RotateAction

/**
 * 视频编码的速度档。**取值就是 libx264 自己的 `-preset` 名**，不另造一套词汇表——
 * 造一套就得维护一张「我们的名字 → ffmpeg 的名字」的对应表，而那张表漂了的表现是
 * 「界面上选的是 slow，命令行上是 veryfast」，没有任何地方会报错。
 *
 * 顺序是**从快到慢**，界面直接照这个顺序排；`placebo` 放在最后不是因为它最好，
 * 而是因为它在实测里是纯代价（见 `docs` 里那张实测表：比 `veryslow` 还慢 2.3 倍，
 * 体积与 SSIM 都一样）。留着是为了「能选」，界面上会写明它的代价。
 */
export const ENCODE_PRESETS = [
  'ultrafast',
  'superfast',
  'veryfast',
  'faster',
  'fast',
  'medium',
  'slow',
  'slower',
  'veryslow',
  'placebo'
] as const

export type EncodePreset = (typeof ENCODE_PRESETS)[number]

/**
 * 调优档（`-tune`）。
 *
 * **只收 x264 那八个里语义明确、且用户真的会想要的六个**：
 *
 * - `film` / `animation` / `grain` —— 按内容类型调心理视觉模型，这是这一项存在的全部理由
 * - `stillimage` —— 静图式素材
 * - `fastdecode` / `zerolatency` —— 不是画质档，是**为下游约束**让路的档
 *   （前者去掉解码器不爱做的编码工具，后者关掉前瞻与 B 帧）
 *
 * ⚠️ **刻意不收 `psnr` / `ssim`**：那两个是「按某个指标最优化」的调试档，
 * 会让产物在**人眼**看来更差而指标更好看，把它摆进界面等于诱导用户选错。
 *
 * ⚠️ **`-tune` 是 x264 独有的**，libvpx / NVENC 都没有同名的东西，所以它只对
 * `QUALITY_TARGETS` 那几个出口有效（判据见 `@shared/options` 的 `supportsQuality`）。
 */
export const ENCODE_TUNES = [
  'film',
  'animation',
  'grain',
  'stillimage',
  'fastdecode',
  'zerolatency'
] as const

export type EncodeTune = (typeof ENCODE_TUNES)[number]

/**
 * 编码质量档：恒定质量 + 速度档 + 调优（HandBrake 那个 Video 页的三件套）。
 *
 * **三个字段全部可选，一个都不给 = 加这个字段之前的行为**（`-preset veryfast -crf 23`）。
 * 这一点是刻意的：`TaskOptions` 整体是「替换」语义，而「没设质量档」必须与
 * 「设了一个空的 quality」区分开——所以空对象由 schema 与 `setOptions` 拒掉。
 *
 * ## ⚠️ 同一串参数在别的编码器上不是同一件事
 *
 * `-crf` 的同一个数字在 x264 与 NVENC 上**同号不同质**（实测：`-cq 23` 的产物是
 * `-crf 23` 的 2.8 倍大，见 `engines/ffmpeg.ts` 里那段）。所以这一项与显卡编码
 * **互斥**：设了质量档就一定走 CPU（`ffmpegRun.ts` 里那条决策，而且会说出来）。
 *
 * ## ⚠️ 同一个 CRF 在不同 preset 之间也不是同一个画质（实测）
 *
 * 本机实测（真实照片推镜的 640x640 片段，crf 23 固定，3 次取中位）：
 *
 * | preset    | 时间  | 体积    | SSIM   |
 * | --------- | ----- | ------- | ------ |
 * | ultrafast | 81 ms | 812.6KB | 0.9791 |
 * | veryfast  | 118ms | 213.4KB | 0.9802 |
 * | fast      | 171ms | 290.9KB | 0.9861 |
 * | medium    | 199ms | 259.7KB | 0.9860 |
 * | veryslow  | 667ms | 233.6KB | 0.9856 |
 *
 * **体积不是单调的**（`veryfast` 最小），而 SSIM 是（`veryfast` 最差）。
 * 所以「换个更慢的预设就能更小」是错的，界面文案不能这么写；
 * 也**不能**把「预设」与「CRF」当成两个能互相换算的旋钮。
 */
export interface QualityOptions {
  /** 恒定质量。x264 的 `-crf`，0~51，越小越好。省略 = 23（本项目一贯的默认值） */
  crf?: number
  /** 编码速度档。省略 = `veryfast`（本项目一贯的默认值） */
  preset?: EncodePreset
  /** 调优档。省略 = 不传 `-tune`（x264 自己的默认行为） */
  tune?: EncodeTune
}

/**
 * 输出约束：产物体积或码率。
 *
 * **它不是处理链里的一步**，所以在 `TaskOptions` 上与 `filters` 平级而不是数组的一个成员。
 * 判据是「它改的是**编码器怎么编**，不改像素」——塞进链里会让「这条链能不能重排」
 * 变成一个没有答案的问题：两条 `resize` 换顺序还是同一个结果，而 `output` 与任何
 * 动作换顺序都不是同一件事。
 *
 * **两者二选一**，都不给 = 不限制（也就是加这个字段之前的行为）。
 * 为什么不是「一个字段加一个单位」：用户要的是两件不同的事——
 * 「压到 10 MB 以下」（体积，发给别人时有硬上限）与「码率 8000k」（质量，懂行的人用）。
 * 体积要用两遍编码反推码率才做得准，码率是直接给的，两者的实现路径根本不同。
 *
 * ⚠️ **码率的单位是 kbps，不是 bps**，字段名里写死单位就是为了这件事：
 * 单位混掉的表现是产物大一千倍或小一千倍，而两者都「转换成功」。
 *
 * ⚠️ **图片的「压到多少字节」也是这一项**（`targetBytes`），只是实现不同：
 * 视频走两遍 ABR 反推码率、图片走二分搜索质量。两者都是「产物体积上限」，
 * 拆成两个字段会让界面与摘要到处判「这次是哪种」。
 */
export interface OutputOptions {
  /** 目标体积，**字节**。与 `bitrateKbps` 二选一 */
  targetBytes?: number
  /** 目标码率，**kbps**。与 `targetBytes` 二选一 */
  bitrateKbps?: number
}

/**
 * 一条任务的参数。**形状要能长大**。
 *
 * 三块的职责分界，也是这个类型唯一的组织原则：
 *
 * - `trim`    —— **选一段**（时间区间）。与处理链正交：它不改变像素，只决定取哪一段。
 * - `output`  —— **编码目标**（体积 / 码率）。同样与处理链正交，理由见 `OutputOptions`。
 * - `quality` —— **编码质量档**（恒定质量 / 速度档 / 调优）。与 `output` **互斥**，
 *   理由见 `QualityOptions` 与 `@shared/options` 的 `QUALITY_OUTPUT_EXCLUSIVE`。
 * - `filters` —— **改变像素的步骤，有序**。理由见 `FilterAction`。
 *
 * 摊在 `Task` 上（`trimStart` / `trimEnd` / `scaleWidth` …）会把「没有参数」与
 * 「参数是默认值」变成同一个东西，而这两件事在界面上、在历史里、在重跑时都必须分得开。
 *
 * ⚠️ **整体是「替换」而不是「合并」语义**（`TaskManager.setOptions`）。界面上的每一块
 * 面板在「应用」时都必须交出**完整的** `TaskOptions`（见 `shared/options.ts` 的
 * `withOption`）——各交各的那一个字段的话，第二块面板一应用就会把第一块的静默抹掉。
 *
 * ⚠️ **字段的声明顺序 = `describeOptions()` 拼摘要的顺序**，改这里就要改那里：
 * 同一条任务的参数行在队列卡与历史页上必须逐字相同。
 */
export interface TaskOptions {
  trim?: TrimOptions
  output?: OutputOptions
  quality?: QualityOptions
  /** 有序，按数组顺序执行 */
  filters?: FilterAction[]
}

/**
 * 进度是联合类型，因为不同引擎能提供的信息粒度差别巨大：
 *  - ffmpeg 能给出精确百分比与速率
 *  - 7z 能给出百分比但没有速率
 *  - pandoc / LibreOffice / Calibre 什么都不给，只能报阶段文案
 *  - LibreOffice 批量转换时用「已完成 n/N」做批次级确定进度
 */
export type TaskProgress =
  | {
      kind: 'determinate'
      percent: number
      etaSec?: number
      speed?: number
      /**
       * 这一步在干什么。
       *
       * 目前只有「按需下载引擎」用得上：它同样是**有百分比**的（下载那一段
       * 服务端给了 Content-Length），但百分比旁边不写一句「正在下载 LibreOffice 引擎」，
       * 用户看到的是一个转了几分钟的进度条而不知道它在干什么。
       */
      stage?: string
    }
  | { kind: 'indeterminate'; stage: string; hint?: string }
  | { kind: 'batch'; done: number; total: number; stage: string }

export interface Task {
  id: string
  inputPath: string
  inputName: string
  category: Category
  /** 源扩展名，小写不带点，如 'mkv' */
  fromExt: string
  /** 目标扩展名，小写不带点，如 'mp4' */
  toExt: string
  /**
   * 这条任务的参数（裁剪等）。**没有参数就是 `undefined`**，不是空对象——
   * 界面上「这条用了什么参数」那一行渲染与否认的就是它。
   */
  options?: TaskOptions
  engine: EngineKey
  status: TaskStatus
  progress: TaskProgress | null
  outputPath?: string
  sizeBytes?: number
  /** 失败时的简短原因，展示在卡片上 */
  error?: string
  /** stderr 尾部若干行，供用户展开排查 */
  logTail?: string[]
  createdAt: number
  startedAt?: number
  finishedAt?: number
}

/**
 * 历史记录的终态。比 `TaskStatus` 少三个——`queued` / `waiting_engine` / `running`
 * 都是「还在队列里」，而队列随进程结束就没了，历史里只剩尘埃落定的三种。
 */
export type HistoryStatus = 'done' | 'error' | 'canceled'

/**
 * 「转换完成之后做什么」。
 *
 * 写成常量数组再派生类型，理由与 `CATEGORIES` 一样：zod 枚举、设置页的分段选择、
 * 主进程的动作分派三处都要用它，各写一份字符串数组迟早漂移，
 * 而漂移的表现是「界面上选得出来的那一档，主进程不认识」——点了什么都不发生。
 */
export const AFTER_CONVERT_ACTIONS = ['none', 'copy-path', 'copy-file', 'open-folder'] as const

export type AfterConvertAction = (typeof AFTER_CONVERT_ACTIONS)[number]

/**
 * 默认动作：**什么都不做**。
 *
 * 这个默认值是承重的，不是随手取的。自动往剪贴板里写东西有两重风险：
 * 一是它会**覆盖用户此刻手里的剪贴板内容**（而且没有任何提示能让他知道），
 * 二是「复制了但粘出来是别的东西」这种事后归因极其困难（别的程序随时会抢剪贴板）。
 * 所以这条功能必须由用户显式打开，而且要有一个能被反证的断言盯着默认值
 * （见 `scripts/test-integration.ts` 的 [9] 与 `test-core.ts` 的契约断言）。
 */
export const DEFAULT_AFTER_CONVERT: AfterConvertAction = 'none'

/**
 * 一条历史记录。**刻意不复用 `Task`**，理由不是省字段：
 *
 * - `Task.progress` 对历史毫无意义，存下来只会让文件变大
 * - `Task.logTail` 可能有几百行、含文件内容片段，更不该长期留存
 * - 最要紧的是**架构导向**：一旦历史里存的是 `Task`，后人就会顺手写「启动时从历史
 *   重建队列」——那会直接破坏「主进程是活动队列唯一真相源」这条不变量。
 *   类型分开，这条路就从「顺手」变成「要刻意绕一道」。
 *
 * 字段与 `Task` 同形，渲染逻辑照样可以共用，只是类型各论各的。
 */
export interface HistoryEntry {
  id: string
  inputPath: string
  inputName: string
  category: Category
  fromExt: string
  toExt: string
  /**
   * 当初那次用的是什么参数。与 `Task.options` 同义，**存下来是必要的**：
   * 两条 `clip.mp4 → mp4` 在历史里长得一模一样，而一条是整段、另一条只裁了 5 秒。
   * 「再行调律」也照它复现——否则界面上一行写着「裁 3.0s–8.0s」，
   * 点下去出来的却是整段，正是这个项目最忌讳的静默换个结果。
   */
  options?: TaskOptions
  engine: EngineKey
  status: HistoryStatus
  outputPath?: string
  sizeBytes?: number
  /** 只存 summarize 之后的一行，不像 `Task` 那样存 `logTail` */
  error?: string
  createdAt: number
  startedAt?: number
  finishedAt: number
}

/**
 * 引擎可用状态。四段式解析的产物：
 *  system（用户自己装过，直接复用）> bundled（随包发布）
 *  > installed（按需下载缓存）> missing（需要下载）
 */
export type EngineState = 'system' | 'bundled' | 'installed' | 'missing' | 'installing' | 'error'

export interface EngineStatus {
  key: EngineKey
  label: string
  state: EngineState
  version?: string
  path?: string
  /**
   * 一句给用户看的能力说明，如 7-Zip 的「完整版，支持 RAR」。
   *
   * 存在的理由：`sevenZipEngine()` 本来就返回 `{ path, supportsRar }`，
   * 而 supportsRar 直接决定 `.rar` 能不能转——这是关于页最有价值的一行，
   * 不能只报一句「已就绪」把它盖掉。
   */
  detail?: string
  /** 按需下载体积，用于在 UI 上提示「约 340 MB」 */
  downloadBytes?: number
  error?: string
}

/** 引擎安装/下载进度 */
export interface EngineProgress {
  key: EngineKey
  phase: 'download' | 'verify' | 'extract'
  receivedBytes: number
  totalBytes: number
  percent: number
  speedBps?: number
  etaSec?: number
}

/**
 * 「磁盘上那份设置文件读不出可用数据」这件事的记录。
 *
 * **住在 shared 而不是 `core/jsonStore.ts`**：它要经 IPC 送到渲染层
 * （设置页那条告警），而 preload 不能 import 主进程的模块。
 * 与 `EngineStatus` 那类跨进程 DTO 同一个理由。
 *
 * ⚠️ **留档这一半比报错那一半重要**：读盘失败时原文件会被改名成
 * `<file>.corrupt-<时间戳>`，用户至少不该连原始数据都留不下。
 */
export interface SettingsCorruption {
  /** 出问题的文件（原路径） */
  file: string
  /**
   * 留档后的路径（`<file>.corrupt-<时间戳>`）。
   * 为 `null` 表示改名也失败了——**原文件仍在原地**，此时唯一的保护是没有了，
   * 所以这个字段必须如实区分「留档了」与「没留成」，别一律当成成功。
   */
  quarantinePath: string | null
  /** 为什么读不动（JSON 解析的原文，或「形状不认识」） */
  reason: string
}

export interface Settings {
  outputDir: string | null
  /** 输出目录留空时写到源文件旁边 */
  outputBesideSource: boolean
  onConflict: 'rename' | 'overwrite' | 'skip'
  maxConcurrent: number
  /**
   * 每个类别偏好的默认目标格式（格式设置页可改）。
   *
   * 这只是**偏好**，不是保证：同一个类别下源格式不同，合法目标也不同
   * （`mkv` 不能转 `mkv`）。真正裁决的是 `resolveDefaultTarget()`，
   * 它会拿 `targetsFor(fromExt)` 再校验一遍 —— 见那里的注释。
   */
  defaultTargets: Partial<Record<Category, string>>
  engineDir: string
  /** 引擎缺失时是否跳过该任务而不是排队等待 */
  skipTasksNeedingDownload: boolean
  /**
   * 用 GPU（NVIDIA NVENC）做视频编码，**速度优先，默认关**。
   *
   * 默认关是实测的结论，不是保守：同素材实测下来 NVENC 只在**难编的内容**上是净赚
   * （1080p60 高熵：3.89s → 2.89s，体积 22.33 → 22.22 MiB，SSIM 0.8090 → 0.8136），
   * 在**好编的内容**上反而更慢（同规格平滑素材：1.77s → 2.16s）。
   * 换句话说它不是「无条件的加速」，而是一个**取舍**——所以只能由用户显式选。
   *
   * 具体参数与数字见 docs/NOTES.md 约束 22。
   */
  hardwareEncode: boolean
  /**
   * 在资源管理器右键菜单里加一项「用调律者转换」，**默认关**。
   *
   * 默认关的理由与 `hardwareEncode` 不同：这里不是效果存疑，而是**它会动注册表**。
   * 一个转换器在用户还没做出任何选择时就去写文件关联，与 M8 说的「否则会变成用户
   * 投诉的来源」是同一件事。用户显式打开之后，键写在 `HKCU` 下，不需要管理员。
   *
   * ⚠️ **Windows 11 上它会落在「显示更多选项」那一层**（老版菜单），
   * 这是系统对新版菜单的限制，不是没注册上——设置页必须把这句话写出来。
   */
  contextMenu: boolean
  /**
   * 「重命名即转换」：在下面这些目录里，把 `a.mkv` 改名成 `a.mp4` 就自动转出真正的 mp4。
   *
   * **默认关，且这是整个功能的开关**。`docs/PLAN.md` §M8 论证过它的收益/风险比是差的
   * （改名后源文件没了、误触发代价大、要配白名单目录反而增加摩擦），所以它必须由用户
   * 显式打开、必须配了目录才生效——**关着的时候一个监听器都不装，零副作用**，
   * 那正是 §M8 给这条的唯一验收判据。
   */
  renameConvert: boolean
  /**
   * 参与重命名监听的目录白名单。**空数组 = 不开工**（与 `renameConvert` 同时成立才走路）。
   *
   * 为什么必须显式配：监听整个磁盘不现实，而「静默对某个目录动手」是这个功能
   * 最坏的表现。目录由用户在设置页一个个挑，挑出来的才在射程内。
   */
  renameConvertDirs: string[]
  /**
   * 转换完成之后的动作，**默认 `'none'`**（见 `DEFAULT_AFTER_CONVERT` 的注释）。
   *
   * 它省掉的是「去文件夹里找」那一步：卡片上只有「打开位置」时，用户想把产物
   * 发出去要走 显示 → 找到 → 右键复制 → 粘贴 四步。
   *
   * ⚠️ **自动触发只在「队列里只有一个任务」时发生**。一次转 50 个时「复制产物」
   * 没有意义（剪贴板只有一个格子，而且用户要的是哪一个根本无从得知），
   * 那种批量场景里我们只把它做成卡片上的按钮，绝不自动动剪贴板。
   */
  afterConvert: AfterConvertAction
  /**
   * 往「发送到」菜单里放一个指向本程序的快捷方式，**默认关**。
   *
   * 与 `contextMenu` 是同一类东西（都是在用户的操作系统里留一个入口），
   * 而且默认关的理由也一样：用户还没做过任何选择就去动他的环境不合适。
   * 但它**完全不写注册表**——只是在 `%APPDATA%\Microsoft\Windows\SendTo\` 下
   * 放一个 `.lnk`，卸载时删掉。另外「发送到」是**一级菜单**，
   * 避开了 Windows 11 新版右键菜单不显示 `*\shell` 动词（要 Shift+F10）那个系统问题。
   *
   * ⚠️ 多选时资源管理器会把**所有**选中文件都追加到命令行末尾（不像 `%1` 只给第一个），
   * 所以 `--convert` 那条路必须收多文件参数，见 `core/cli.ts` 的 `parseConvertRequest`。
   */
  sendTo: boolean
}

/**
 * MCP / CLI 面的重封装模式。
 *
 * ⚠️ **与 `converters/common.ts` 那个同名类型是两回事**：那边是引擎内部的三态
 * （`auto | force | off`，管「这一条转换要不要走 -c copy」），这边是**对调用方**的三态
 * （`auto | remux | reencode`，管「用户可以要求什么」）。两者取值都不一样，
 * 别把它们合并——合并的那一刻就得为「force 与 remux 到底是不是同一件事」编一套解释，
 * 而那不是同一个问题。
 *
 * 2026-09-16 从 `src/mcp/jobs.ts` 挪到这里：R15 的配方文件在 `src/shared/`，
 * 而那个目录**不许引 `src/mcp`**（配方是零依赖的纯逻辑）。`jobs.ts` 现在把它转出去，
 * 所以 `plan.ts` 那边从 `./jobs` 引它的写法一个字没改。
 */
export type RemuxMode = 'auto' | 'remux' | 'reencode'
