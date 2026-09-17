import type { Category } from '@shared/types'

/**
 * E-6 产物自检的**判据**：拿两份侦察结果，逐项对照，把事实列出来。
 *
 * 存在的理由（PLAN §9.1 的 E-6 / RESEARCH §5）：agent 在此之前唯一的成功判据是
 * **退出码 0**，而「引擎说它成功了」与「产物真的对」是两件事——本项目自己就记着
 * 好几条「报成功、产物其实不对」的路（扫描件 PDF 抽出空文件、pandoc 静默丢掉插图、
 * 7z 解 MSI 摊平目录树）。自检把 agent 从「它说成了」抬到「时长/音轨/分辨率对得上源」。
 *
 * 三条**定死的取舍**，每一条都对应一个具体的坏结果：
 *
 * 1. **判据要宽。** 判据写严了会把正常产物判成「不对」，而那比不做更坏——
 *    一个说谎的检查比没有检查糟得多，agent 会照着它去「修」一个没坏的东西。
 *    所以：`ts → mp4` 会重新分装（容器报的时长会变）、gif 是图片（没有时长也没有音轨）、
 *    换容器必然换编解码器（mp4 → webm 一定从 h264 变 vp9/vp8）——这三件事**都不算差异**，
 *    只在 `facts` 里如实报数、在 `notes` 里说明为什么不参与判定。
 * 2. **只报事实，不做评分。** 「产物没有音轨」是量出来的事实，能负责；
 *    「PSNR 32dB，画质下降」是判断，超出这个工具敢负责的范围（本项目不含画质评估，
 *    也没有做过任何失真度量）。整个返回里没有分数、没有等级、没有「质量」二字。
 *    所以 `Comparison` 里全是**可复核的数字与真假**，`facts` 里全是「量到了什么」。
 * 3. **本模块是纯的。** 零运行时 import（`Category` 是类型，编译后不留痕迹）——
 *    于是它能在**封锁 electron 的进程**里被逐条断言（`test-mcp-view.ts` 的 [H] 节），
 *    而「判据宽不宽」这件事恰恰只能靠一堆人造探针去问：真跑一遍转换根本造不出
 *    「时长差 0.03s」「gif 没有音轨」这些边界。起子进程那一半在 `selfCheck.ts` 里。
 *
 * ⚠️ **别在 `facts` 里下结论。** 判据是「这句话是一个测量结果，还是一个判断」：
 * 「时长：产物 12.03s / 源 12.00s（差 +0.03s）」是测量；
 * 「时长对得上，产物没问题」是判断——后者在时序上根本站不住（秒级误差是容器的常态）。
 */

/** 自检的结论。**三档都是「查得到的东西里」的结论，不是对整个文件的鉴定。** */
export type VerificationStatus =
  /** 查得到的项目都对得上。⚠️ **没查到的项目不算**——看了 `checked` 才知道查了什么 */
  | 'consistent'
  /** 至少有一条硬差异（分辨率不同 / 音轨丢了 / 视频流没了） */
  | 'differs'
  /** 一项都没查到（文档、压缩包，或探针没拿到）。`notes` 里说清为什么 */
  | 'unknown'

/**
 * 参与判定的项目名。**闭集**：`checked` 里只会出现这五个，agent 可以放心穷举。
 *
 * `duration` 在这一列里，但它**不参与「一致/不一致」的判定**（理由见 `compareConversion`）：
 * 「两边都量到了时长」本身就是一条信息（下次自检时可以比），所以它照旧进 `checked`。
 */
export const CHECK_KEYS = [
  'resolution',
  'video_codec',
  'audio',
  'video_stream',
  'duration'
] as const

export type CheckKey = (typeof CHECK_KEYS)[number]

/**
 * 侦察结果里**自检要读的那几项**。
 *
 * 刻意写成结构类型，而不是 `import type { InspectProbe } from './inspect'`：
 * `inspect.ts` 要 import 本模块，互相 import（哪怕是类型）会成环，而 `inspectCost.ts`
 * 已经为同一件事立了先例。`InspectProbe` 结构上兼容，直接传即可。
 *
 * ⚠️ 字段名沿用 `InspectProbe` 的驼峰（`hasAudio` / `durationSec`），
 * 因为这里存的就是**侦察结果原样透传**的引用：真跑起来它会带着 `format` / `entries`
 * 那些本模块不读的字段一起出现在返回里，那是有意的（agent 多看到几个侦察字段没有代价，
 * 而在这里把它投影一遍就是又一处会与 `inspect.ts` 分家的副本）。
 */
export interface SideProbe {
  durationSec: number | null
  width: number | null
  height: number | null
  hasVideo: boolean
  hasAudio: boolean
  videoCodec: string | null
  audioCodec: string | null
}

/** 一侧（源或产物）量到的东西。 */
export interface VerifySide {
  path: string
  ext: string
  category: Category | null
  /** 字节数。读不到时为 null（不是 0） */
  size_bytes: number | null
  /** null = 没探到（文档 / 压缩包 / 探针失败），见 `inspect.ts` 的 `InspectProbe` */
  probe: SideProbe | null
  /** 「为什么这里没有数据」的一句话。正常时 null */
  note: string | null
}

/** 逐项的比对结果。**每一项都可能为 null，含义是「这一项没查」，不是「不一致」。** */
export interface VerificationComparison {
  /**
   * 源与产物的 WxH 是不是同一个。
   *
   * null = 这一项**没判**：有一边拿不到尺寸，或者这个方向的尺寸本来就不该一致
   * （视频 → 图片，见 `resolutionComparable()`）。两种都在 `facts` / `notes` 里说清。
   */
  resolution_matches: boolean | null
  /** 视频编解码器是不是同一个。null = 有一边没有视频流或拿不到。
   *  ⚠️ `false` **不算差异**：换容器本来就要重编码 */
  video_codec_matches: boolean | null
  /** 源有没有音轨 */
  source_has_audio: boolean | null
  /** 产物有没有音轨 */
  output_has_audio: boolean | null
  /** 源有音轨而产物没有。**这是真事实，也是这个工具最值钱的一条** */
  audio_lost: boolean | null
  /** 源有视频流而产物没有（只在产物也是视频时才判） */
  video_lost: boolean | null
  /** 时长只在两边都量得到时才有意义（图片没有、gif 会变） */
  duration_comparable: boolean
  source_duration_sec: number | null
  output_duration_sec: number | null
  /** 产物减源。可比的场合才不是 null */
  duration_delta_sec: number | null
}

export interface Verification {
  status: VerificationStatus
  /** **只报事实**：每条都是一个测量结果，不是判断 */
  facts: string[]
  /** 需要解释的事（为什么不把某一条算成差异、哪一项没查成） */
  notes: string[]
  /** 这次**实际查了**哪几项（`CHECK_KEYS` 的子集）。`status: consistent` 要配着它读 */
  checked: CheckKey[]
  source: VerifySide
  output: VerifySide
  comparison: VerificationComparison
}

/**
 * 时长差到多少才**多说一句**。
 *
 * 它**只控制要不要加一条 note，不影响 `status`**（时长不参与判定，理由见下）。
 * 1 秒是「一秒以上的差不太像分装带来的」那个量级，不是判据——所以措辞是
 * 「值得自己核对」，不是「有问题」。
 */
const DURATION_NOTEWORTHY_SEC = 1

/** 只有这三类文件，「有没有音视频流」才是一项有意义的观测。 */
function hasStreams(category: Category | null): boolean {
  return category === 'video' || category === 'audio'
}

/**
 * 这个方向上，「尺寸一致」这件事**本来就不该成立**。
 *
 * 唯一的例外是**视频 → 图片**：能力矩阵里视频只有一个图片出口（`gif`），而 gif 走
 * 调色板链，链上写死了 `scale=480:-1:flags=lanczos`（`engines/ffmpeg.ts` 的 `GIF_FILTER`）。
 * 也就是说产物尺寸是**我们定的**、与源无关——拿它当「不一致」，每一个 `video → gif`
 * 都会报一条假差异，而那正是「判据写严了比不做更坏」的样子。
 *
 * 其它方向（视频 → 视频、图片 → 图片、音频 → 音频）尺寸都该原样保留，照判。
 */
function resolutionComparable(source: VerifySide, output: VerifySide): boolean {
  return !(source.category === 'video' && output.category === 'image')
}

function sec(value: number): string {
  return `${value.toFixed(2)}s`
}

function signed(value: number): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}s`
}

/**
 * 对照两侧的侦察结果，把事实列出来。
 *
 * **什么算差异**（只有这三条能改变 `status`）：
 *  - 分辨率与源不同 —— 但**视频 → 图片这一条边除外**：矩阵里视频只有一个图片出口（gif），
 *    而 gif 走调色板链、链上写死了 `scale=480:-1`（见 `resolutionComparable()`），
 *    尺寸是**我们定的**，拿它当「不一致」就是把正常产物判成坏产物；
 *  - 源有音轨而产物没有 —— 用户要的内容真的没了；
 *  - 源有视频流而产物没有（产物也是视频时）—— 同上。
 *
 * **什么不算差异**（都进 `facts`，都进 `notes` 说明）：
 *  - 编解码器变了：目标容器装不下源编码器时必然重编码，这是**正常路径**；
 *  - 时长变了：`ts → mp4` 要重新分装、gif 只保留到帧、容器的时长是**报**出来的；
 *  - 图片产物的尺寸：`video → gif` 那条链自己带 `scale=480:-1`（见 `resolutionComparable()`）；
 *  - 图片没有时长也没有音轨：那是格式的性质，不是缺失。
 *
 * 判不上时说「判不上」，**不说「没问题」**：`status: unknown` + `checked: []` 才是
 * 「这次什么也没查」的诚实形态（`consistent` 会被读成「检查过了，好的」）。
 */
export function compareConversion(source: VerifySide, output: VerifySide): Verification {
  const sp = source.probe
  const op = output.probe
  const facts: string[] = []
  const notes: string[] = []
  const checked: CheckKey[] = []

  /* ---------------------------------------------------------- 分辨率 */
  const dimsKnown =
    sp !== null &&
    op !== null &&
    sp.width !== null &&
    sp.height !== null &&
    op.width !== null &&
    op.height !== null
  const resolutionMatches = dimsKnown ? sp.width === op.width && sp.height === op.height : null
  const dimsComparable = dimsKnown && resolutionComparable(source, output)
  if (dimsComparable && sp !== null && op !== null) {
    checked.push('resolution')
    if (resolutionMatches === true) {
      facts.push(`分辨率 ${sp.width}x${sp.height}，与源一致`)
    } else {
      facts.push(`分辨率与源不同：源 ${sp.width}x${sp.height} → 产物 ${op.width}x${op.height}`)
    }
  } else if (dimsKnown && sp !== null && op !== null) {
    // 不判定的那一档：数字照报（agent 有权知道产物多少像素），但不说「不同」。
    facts.push(`尺寸：源 ${sp.width}x${sp.height} / 产物 ${op.width}x${op.height}`)
    if (resolutionMatches === false) {
      notes.push(
        `产物尺寸与源不同（${sp.width}x${sp.height} → ${op.width}x${op.height}）：视频转 gif 走的` +
          '是我们的调色板链，那条链自己带 `scale=480:-1`（engines/ffmpeg.ts 的 GIF_FILTER），' +
          '尺寸是**我们定的**，所以这一项不参与判定，只把两个数报出来。'
      )
    }
  }

  /* ------------------------------------------------------ 视频编解码器 */
  const codecsKnown =
    sp?.videoCodec !== null &&
    sp?.videoCodec !== undefined &&
    op?.videoCodec !== null &&
    op?.videoCodec !== undefined
  const videoCodecMatches = codecsKnown ? sp.videoCodec === op.videoCodec : null
  if (codecsKnown) {
    checked.push('video_codec')
    if (videoCodecMatches === true) {
      facts.push(`视频编解码器 ${sp.videoCodec}，与源相同`)
    } else {
      facts.push(`视频编解码器：源 ${sp.videoCodec} → 产物 ${op.videoCodec}`)
      notes.push(
        '编解码器变了不算差异：目标容器装不下源的编码器时本来就要重编码' +
          '（mp4 → webm 必然从 h264 变成 vp9/vp8），这条只报事实。'
      )
    }
  }

  /* -------------------------------------------------------------- 音轨 */
  // 「量到了吗」比「两边都是 false」重要得多：压缩包与文档的 `hasAudio: false`
  // 来自空探针的默认值，那不是观测——所以那两类不算查过，也就不会出现在 `checked` 里。
  const audioMeasurable =
    sp !== null &&
    op !== null &&
    (sp.hasAudio || op.hasAudio || (hasStreams(source.category) && hasStreams(output.category)))
  const audioLost = audioMeasurable ? sp?.hasAudio === true && op?.hasAudio === false : null
  if (audioMeasurable) {
    checked.push('audio')
    if (sp?.hasAudio === true && op?.hasAudio === false) {
      facts.push('产物没有音轨，而源有')
    } else if (sp?.hasAudio === true && op?.hasAudio === true) {
      facts.push('音轨：源与产物都有')
    } else if (sp?.hasAudio === false && op?.hasAudio === true) {
      facts.push('源没有音轨，而产物有')
      notes.push('产物多出一条音轨有点反常（本项目不做「加音轨」这件事），值得自己核对。')
    } else {
      facts.push('音轨：源与产物都没有')
    }
  } else if (sp?.hasAudio === true) {
    notes.push('源有音轨，但产物的元数据没读出来，所以「音轨还在不在」这一项没查成。')
  }

  /* ------------------------------------------------------------ 视频流 */
  // 只在**产物也是视频**时判：图片与音频出口本来就不带视频流，把它算成「丢了视频流」
  // 是典型的判据过严（video → gif 是正常用法，不是故障）。
  const videoMeasurable = sp?.hasVideo === true && op !== null && output.category === 'video'
  const videoLost = videoMeasurable ? sp?.hasVideo === true && op?.hasVideo === false : null
  if (videoMeasurable) {
    checked.push('video_stream')
    if (op?.hasVideo === false) facts.push('产物没有视频流，而源有')
  }

  /* -------------------------------------------------------------- 时长 */
  const durationComparable =
    sp?.durationSec !== null &&
    sp?.durationSec !== undefined &&
    op?.durationSec !== null &&
    op?.durationSec !== undefined
  const sourceDur = durationComparable ? sp.durationSec : null
  const outputDur = durationComparable ? op.durationSec : null
  const delta =
    durationComparable && sourceDur !== null && outputDur !== null
      ? Math.round((outputDur - sourceDur) * 1000) / 1000
      : null
  if (durationComparable) {
    checked.push('duration')
    facts.push(
      `时长：产物 ${sec(outputDur ?? 0)} / 源 ${sec(sourceDur ?? 0)}（差 ${signed(delta ?? 0)}）`
    )
    if (delta !== null && Math.abs(delta) > DURATION_NOTEWORTHY_SEC) {
      notes.push(
        `产物时长与源相差 ${signed(delta)}。重新分装（ts → mp4 那类）与 gif 本来就会让容器` +
          '报的时长变，所以时长**不参与**「一致 / 不一致」的判定；但差到这个量级确实是一处' +
          '差异，值得自己核对。'
      )
    }
  }

  /* ---------------------------------------------------------- 探针失败 */
  if (op === null) {
    notes.push(`产物的元数据没读出来：${output.note ?? '（没有说明）'}`)
  }
  if (sp === null) {
    notes.push(`源的元数据没读出来：${source.note ?? '（没有说明）'}`)
  }

  /* ------------------------------------------------------ 没什么可比的 */
  if (checked.length === 0) {
    if (source.category === 'archive' || output.category === 'archive') {
      notes.push(
        '压缩包不比内容：拆开重打包是正常路径，条目数与源不保证相同，所以这一项刻意不比。' +
          '产物读得出来、非空，这两条已经由任务本身核过。'
      )
    } else {
      notes.push(
        '两边都没有可比的项目：图片没有时长与编解码器、gif 也没有音轨，' +
          '文档与电子书则不做子进程侦察（见 inspect.ts 的分派）。'
      )
    }
  }

  const differs = resolutionMatches === false || audioLost === true || videoLost === true
  return {
    status: differs ? 'differs' : checked.length > 0 ? 'consistent' : 'unknown',
    facts,
    notes,
    checked,
    source,
    output,
    comparison: {
      resolution_matches: dimsComparable ? resolutionMatches : null,
      video_codec_matches: videoCodecMatches,
      source_has_audio: sp === null ? null : sp.hasAudio,
      output_has_audio: op === null ? null : op.hasAudio,
      audio_lost: audioLost,
      video_lost: videoLost,
      duration_comparable: durationComparable,
      source_duration_sec: sourceDur,
      output_duration_sec: outputDur,
      duration_delta_sec: delta
    }
  }
}
