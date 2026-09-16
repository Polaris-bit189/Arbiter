import type { DenoiseStrength, FilterAction, LoudnormAction, ResizeAction } from '@shared/types'
import type { MediaInfo } from '../core/probe'

const AUDIO_TARGETS = new Set(['mp3', 'wav', 'flac', 'aac', 'm4a', 'ogg', 'opus'])
const IMAGE_TARGETS = new Set(['png', 'jpg', 'jpeg', 'webp', 'avif', 'tiff', 'bmp', 'ico'])

/**
 * 没有任何码率旋钮的音频出口：**无损**，码率是结果而不是参数
 * （wav 由采样率与位深决定，flac 由压缩等级与内容决定）。
 *
 * 体积/码率目标对它们无意义。调用方（`converters/ffmpegRun.ts`）会**报错**而不是静默忽略——
 * 静默忽略的表现是「用户填了 10 MB，拿到 40 MB，任务报成功」。
 */
const LOSSLESS_AUDIO_TARGETS = new Set(['wav', 'flac'])

/** 调色板法生成 GIF，比直接缩放质量高一个档次 */
const GIF_FILTER = 'fps=12,scale=480:-1:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse'

/**
 * 单张图片转视频容器时补的那段静止画面（秒）。
 *
 * **导出是为了别再写一份**：`ffmpegRun` 要把「目标体积 ÷ 时长」落成码率，而图片源在
 * stderr 上根本没有 `Duration:`（它是一张图）。这条分支补的画面长度就是那个时长。
 * 两处各写一个 `5` 的话，改一处就会让体积目标按**错误的时长**反推码率——
 * 产物稳定地不达标（或大得离谱），而任务照样报成功，正是本项目最忌讳的那类错。
 */
export const STILL_DURATION_SEC = 5

/**
 * 这个出口能不能兑现「体积 / 码率目标」。
 *
 * 三处做不到，每一处都是**物理上**做不到，不是没实现：
 *
 * - `gif`：走调色板滤镜（`-vf palettegen/paletteuse`），没有码率旋钮；
 * - 图片出口（`IMAGE_TARGETS`）：JPEG/PNG/BMP 编码器没有「目标码率」这一说，
 *   压缩率由质量参数决定（图片的「压到多少字节」走二分搜索质量，那是另一条路）；
 * - `wav` / `flac`：无损，见 `LOSSLESS_AUDIO_TARGETS`。
 *
 * 判据放在这里而不是各调用处，是为了让「哪些出口兑现不了」只有一个真相源。
 */
export function supportsOutputTarget(toExt: string): boolean {
  const to = toExt.toLowerCase()
  if (to === 'gif') return false
  if (IMAGE_TARGETS.has(to)) return false
  if (LOSSLESS_AUDIO_TARGETS.has(to)) return false
  return true
}

/** 目标是不是纯音频容器（决定码率给 `-b:a` 还是 `-b:v`）。与 `isImageTarget` 对称。 */
export function isAudioTarget(toExt: string): boolean {
  return AUDIO_TARGETS.has(toExt.toLowerCase())
}

/**
 * 各容器**默认**音频编码的码率（kbps）。
 *
 * ⚠️ 它同时参与「目标体积 → 视频码率」那一步的反推：按 192 算而实际编了 128，
 * 10 秒的片子就白白空出 80 KB 的预算（产物偏小、目标没吃满），反过来则是**超标**。
 * 与 `defaultAudioArgs` 里那些 `-b:a` 是同一批数，改一处必须改另一处。
 *
 * 注意这是**标称值**：实测 aac 编一条 440Hz 正弦只有 121 kbps（内容极好压），
 * 于是实际产物稳定地**小于**目标——这个方向是安全的（判据是「不超过」）。
 */
export function defaultAudioKbps(toExt: string): number {
  switch (toExt.toLowerCase()) {
    case 'webm':
      return 128
    case 'avi':
      // libmp3lame -q:a 4 的平均码率（VBR），本项目的实测约 160
      return 160
    default:
      return 192
  }
}

/** 不指定音频码率时各容器的默认音频参数。与 `videoArgs` 里原本写在各分支的那几句同源。 */
function defaultAudioArgs(target: string): string[] {
  if (target === 'avi') return ['-c:a', 'libmp3lame', '-q:a', '4']
  if (target === 'webm') return ['-c:a', 'libopus', '-b:a', '128k']
  return ['-c:a', 'aac', '-b:a', '192k']
}

/** 各容器默认音频编码器，供码率模式下拼 `-c:a` 用 */
function audioCodecOf(target: string): string {
  switch (target) {
    case 'webm':
      return 'libopus'
    case 'avi':
      return 'libmp3lame'
    default:
      return 'aac'
  }
}

/**
 * 输出约束（体积 / 码率）在**参数层**的形状。由 `converters/ffmpegRun.ts` 算好之后交进来——
 * 那里才知道源多长、有没有音轨，这里只负责把它拼成命令行。
 *
 * ⚠️ **给了 `videoKbps` 就不再是质量模式**：`-crf` / `-cq` 会被整体替换成 `-b:v`。
 * 两者同时出现时 x264 会回到质量模式、把 `-b:v` 只当上限，产物体积与目标彻底脱钩，
 * 而任务照样报成功。
 */
export interface EncodeTarget {
  /** 视频码率，kbps。来源有二：用户直接给的 `bitrateKbps`，或由 `targetBytes` 反推 */
  videoKbps?: number
  /** 音频码率，kbps。省略时沿用容器默认（见 `defaultAudioKbps` 的警告） */
  audioKbps?: number
  /** 两遍 ABR 的遍次：`1` 只分析（见 `buildPassOneArgs`）、`2` 正式编码。省略 = 单遍 */
  pass?: 1 | 2
  /** `-passlogfile` 前缀。**必须唯一且落在临时目录**，见 `passArgs` */
  passLogFile?: string
}

/**
 * 两遍 ABR 的 `-pass` / `-passlogfile`。
 *
 * ⚠️ **`-passlogfile` 必须是唯一的、且落在临时目录**：不指定时 ffmpeg 会把
 * `ffmpeg2pass-0.log` 写在**当前工作目录**（开发时就是仓库根），两条并发任务会互相覆盖
 * 统计文件——症状是**产物码率完全不对而任务报成功**（与「并发任务的输出名要额外占位」
 * 是同一类问题）。收尾必须删掉，见 `ffmpegRun` 的 `cleanupPassLog`。
 */
function passArgs(enc?: EncodeTarget): string[] {
  if (enc?.pass === undefined) return []
  const args = ['-pass', String(enc.pass)]
  if (enc.passLogFile !== undefined) args.push('-passlogfile', enc.passLogFile)
  return args
}

function audioArgs(target: string, bitrateKbps?: number): string[] {
  // 有码率目标（用户直接给的，或体积目标反推出来的）：有损编码器一律走 `-b:a`。
  // 体积目标那条路**只有一遍**——音频没有「两遍」这回事，反推出来的就是它自己的码率。
  if (bitrateKbps !== undefined) {
    const rate = `${Math.max(1, Math.round(bitrateKbps))}k`
    switch (target) {
      case 'mp3':
        return ['-vn', '-c:a', 'libmp3lame', '-b:a', rate]
      case 'm4a':
      case 'aac':
        return ['-vn', '-c:a', 'aac', '-b:a', rate]
      case 'ogg':
        return ['-vn', '-c:a', 'libvorbis', '-b:a', rate]
      case 'opus':
        return ['-vn', '-c:a', 'libopus', '-b:a', rate]
      case 'wav':
      case 'flac':
        // 调用方已经用 supportsOutputTarget() 拦下它们。这里再抛一次是因为
        // 「兜底给个 -b:a」会静默产出一个体积与目标毫不相干的文件，而任务报成功。
        throw new Error(`ffmpeg: ${target} 是无损出口，没有码率可设`)
      default:
        return ['-vn']
    }
  }

  switch (target) {
    case 'mp3':
      return ['-vn', '-c:a', 'libmp3lame', '-q:a', '2']
    case 'm4a':
      return ['-vn', '-c:a', 'aac', '-b:a', '192k']
    case 'wav':
      return ['-vn', '-c:a', 'pcm_s16le']
    case 'flac':
      return ['-vn', '-c:a', 'flac', '-compression_level', '5']
    case 'aac':
      return ['-vn', '-c:a', 'aac', '-b:a', '192k']
    case 'ogg':
      return ['-vn', '-c:a', 'libvorbis', '-q:a', '5']
    case 'opus':
      return ['-vn', '-c:a', 'libopus', '-b:a', '128k']
    default:
      return ['-vn']
  }
}

function imageArgs(target: string): string[] {
  // -frames:v 1 处理连拍 HEIC：只取主图，否则会输出一大串编号文件
  const base = ['-frames:v', '1']
  switch (target) {
    case 'jpg':
    case 'jpeg':
      return [...base, '-q:v', '2']
    case 'png':
      return [...base, '-compression_level', '6']
    case 'webp':
      return [...base, '-quality', '90']
    default:
      return base
  }
}

/**
 * GPU（NVENC）编码参数。
 *
 * 参数是**实测**定的，不是照搬 CPU 那套改个编码器名（实测数据见 docs/NOTES.md 约束 22）：
 *
 * - **`-cq` 与 `-crf` 同号不代表同质。** 同素材上 `-cq 23` 产出的文件是 `-crf 23` 的
 *   **2.8 倍大**（1080p60 高熵：62.39 MiB vs 22.33 MiB）。照抄 `23` 会让用户
 *   在同一个「质量 23」的预期下拿到体积暴涨的产物。
 * - 扫下来 **`-cq 30` 才与现有的 `-crf 23` 体积相当**（22.22 vs 22.33 MiB，
 *   而 SSIM 0.8136 vs 0.8090——同体积下还略好一点）。
 * - **`-preset p4`** 是甜点：`p1` 在平滑素材上更快（1.48s vs 2.18s）但产物大 26%，
 *   高熵素材上两者几乎一样；`p7` 比 CPU 还慢（3.96s vs 3.89s）。
 * - **`-tune hq -rc-lookahead -spatial_aq -temporal_aq` 那一套别加**：实测只换来
 *   +0.01 SSIM，却让产物再涨四成、耗时也多一截。
 */
const NVENC_VIDEO = ['-c:v', 'h264_nvenc', '-preset', 'p4', '-cq', '30']

/**
 * 走 NVENC 的目标容器。
 *
 * **webm 不在里面**：它的默认编码是 vp9（`libvpx-vp9`），NVENC 没有 vp9 编码器，
 * 只有 `av1_nvenc`——那会**换掉编解码器**，是另一件事，不能借「加速」的名义偷偷做。
 */
const NVENC_TARGETS = new Set(['mkv', 'mp4', 'mov', 'm4v', 'avi'])

function videoArgs(target: string, hardware = false, enc?: EncodeTarget): string[] {
  const kbps = enc?.videoKbps
  if (kbps !== undefined) {
    // ---- ABR（码率模式）：用户给的码率，或由目标体积反推出来的码率 ----
    //
    // ⚠️ **绝不带上 `-crf` / `-cq`**：x264 见到 `-crf` 就回到质量模式、把 `-b:v` 只当上限，
    // 体积与目标彻底脱钩；GPU 那套 `-cq`（CQ 模式）与 ABR 更是互斥。所以调用方在
    // 有输出目标时**根本不会去探显卡**（少花那 200ms，也堵住「静默产出一个不达标的体积」）。
    const rate = `${Math.max(1, Math.round(kbps))}k`
    const codec =
      target === 'webm' ? ['-c:v', 'libvpx-vp9'] : ['-c:v', 'libx264', '-preset', 'veryfast']
    const audio =
      enc?.audioKbps !== undefined
        ? ['-c:a', audioCodecOf(target), '-b:a', `${Math.max(1, Math.round(enc.audioKbps))}k`]
        : defaultAudioArgs(target)
    return [...codec, '-b:v', rate, ...audio, ...passArgs(enc)]
  }

  // 目标容器的默认视频编码是 h264 且这次允许用 GPU —— 只有音频那一侧还按原样
  if (hardware && NVENC_TARGETS.has(target)) {
    return [...NVENC_VIDEO, ...defaultAudioArgs(target)]
  }

  switch (target) {
    case 'webm':
      return ['-c:v', 'libvpx-vp9', '-crf', '32', '-b:v', '0', ...defaultAudioArgs(target)]
    case 'avi':
      return ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', ...defaultAudioArgs(target)]
    case 'mkv':
    case 'mp4':
    case 'mov':
    case 'm4v':
    default:
      return ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', ...defaultAudioArgs(target)]
  }
}

/**
 * 容器侧参数：与**用哪个编解码器**无关，所以 `-c copy` 下也照样要带上。
 *
 * 拆这一层的唯一理由是 remux：`videoArgs()` 原先把容器参数和编码参数混在一起，
 * 而 remux 要整段替换掉编码参数、却不该丢掉容器参数。
 */
function containerArgs(target: string): string[] {
  switch (target) {
    case 'mp4':
    case 'mov':
    case 'm4v':
      // 让 moov 前置，产出可以边下边播。
      // 它只重写索引、不碰码流，所以 `-c copy` 下同样有效，remux 时必须保留。
      //
      // ⚠️ **它不便宜，但也不该被条件化——这里刻意不做优化，理由值得记住。**
      //
      // 实测代价（同一份素材、同一台机器，只差这一个开关，3 次取中位）：
      //   - 66.5 MiB 的 1080p60 remux：102 → 135 ms（+32%，绝对 +33 ms）
      //   - 另一份 221 MiB 的素材：261 → 349 ms（+34%）
      //   - 重编码路径：同样要重写一遍文件，但相对几分钟的编码可以忽略
      // 也就是说「相对涨幅」看着大，**绝对代价只有几十毫秒**——因为 remux 本身已经
      // 比重编码快了两个数量级（33.9×，见约束 18），从这里再抠几十毫秒没有意义。
      // 而代价的另一面是**产物语义**：丢掉 faststart 的 mp4 不能边下边播，而用户
      // 拿到的仍是「转换成功」。为省 80 毫秒换一个他会归因到「这软件压出来的 mp4
      // 有问题」的行为，不划算。要做也得先有「不要 faststart」这个用户选项。
      return ['-movflags', '+faststart']
    default:
      return []
  }
}

// ---------------------------------------------------------------------------
// 处理链 → 滤镜参数
// ---------------------------------------------------------------------------
//
// `TaskOptions.filters` 是**有序**的动作数组，顺序就是语义（`docs/RESEARCH.md` §4.1：
// 去隔行 → 降噪 → 锐化，反了会把噪点一起锐化出来）。所以这一层只做三件事：
// 按序遍历、逐个翻成 ffmpeg 的滤镜片段、用 `,` 连起来。
// **不排序、不去重、不合并同类项**——那是把用户写的顺序悄悄改掉。
//
// 判据（哪一类任务装得下哪一步）不在这里，在 `@shared/options.ts` 的
// `canUseAction`；`TaskManager.setOptions` 用的是同一份函数。这里收到的链一定是合法的，
// 所以**遇到不认识的动作返回 `null` 是死代码**——真出现了也只该少一步，不该整条崩掉。

/**
 * 降噪三档 → `hqdn3d` 的四个参数（空间亮度:空间色度:时间亮度:时间色度）。
 *
 * `medium` 就是 hqdn3d 自己的默认值 `4:3:6:4.5`（实测：显式写出来与不写参数产物一致，
 * 所以「中档 = 不调参」是有依据的，不是拍出来的），`light` / `strong` 是它的 1/2 与 2 倍。
 *
 * ⚠️ **不用 `nlmeans`**（它在本项目的滤镜表里，但 1080p 上远慢于实时，见 `docs/RESEARCH.md`
 * §3/§4.1），也不用 `dynaudnorm` 那一类冒充降噪的东西。
 *
 * 实测（160x120 交错+噪点的 1 秒素材，x264 veryfast crf18 重编码后取码流 md5）：
 * 三档与「不加滤镜」的对照四者**互不相同**——档位真的落在参数上了。
 */
const DENOISE_PRESET: Record<DenoiseStrength, string> = {
  light: '2:1:2:3',
  medium: '4:3:6:4.5',
  strong: '8:6:12:9'
}

/**
 * `loudnorm` 的两个固定参数。契约里只有目标响度（`targetLufs`）一个旋钮，
 * 这两个按 EBU R128 的常用值写死：真峰 -1.5 dBTP（给有损编码留的余量）、
 * 响度范围 11 LU（loudnorm 的默认值）。
 */
const LOUDNORM_TP = -1.5
const LOUDNORM_LRA = 11

/**
 * `loudnorm` 第一遍量出来的输入特征。第二遍靠它做**线性**归一化
 * （整段乘一个增益），而不是单遍那种动态归一化（会改动态范围）。
 */
export interface LoudnormStats {
  inputI: number
  inputTp: number
  inputLra: number
  inputThresh: number
  targetOffset: number
}

/**
 * 视频动作 → 一个滤镜片段；音频动作（`loudnorm`）返回 `null`（它进 `-af`）。
 *
 * 三个方向的映射都是**实测**过的：
 *
 * - **旋转方向**（素材：160x120，左上角一块 80x60 的白块，用 `crop=1:1:x:y` 逐像素读回来）：
 *   `transpose=1` → 白块落到**右上**（顺时针 90°）；`transpose=2` → **左下**（逆时针 90°，
 *   也就是顺时针 270°）；`transpose=1,transpose=1` → **右下**（180°）。
 *   所以 90→`1`、270→`2`、180→连着转两次。这不是照文档抄的：`transpose` 的 1/2 哪个是
 *   顺时针，光看文档很容易写反，而写反的表现是「视频转出来躺倒了」。
 * - **缩放**：`force_original_aspect_ratio=decrease` **会放大**（实测 160x120 装进 640x480
 *   的框得到 640x480），所以「不放大」必须用 `min(iw,框宽)` 这种表达式把框先夹住，
 *   而不是指望 `decrease`。见 `resizeFilter`。
 * - **去隔行**：切片名与滤镜名一一对应（`yadif` / `bwdif`），直接透传。
 */
function videoFilterOf(action: FilterAction): string | null {
  switch (action.kind) {
    case 'resize':
      return resizeFilter(action)
    case 'deinterlace':
      return action.method
    case 'denoise':
      return `hqdn3d=${DENOISE_PRESET[action.strength]}`
    case 'sharpen':
      return `unsharp=5:5:${action.amount}`
    case 'rotate':
      // 90 顺时针 / 180 / 270 顺时针（= 逆时针 90）
      if (action.degrees === 90) return 'transpose=1'
      if (action.degrees === 180) return 'transpose=1,transpose=1'
      return 'transpose=2'
    case 'loudnorm':
      return null
  }
}

/**
 * 缩放。语义与 sharp 那一侧（`converters/image.ts`）对齐，四件事逐条实测过：
 *
 * | 输入 | 目标框 | `withoutEnlargement` | 产物 |
 * | --- | --- | --- | --- |
 * | 160x120 | 80x60 | — | 80x60 |
 * | 160x120 | 640x480 | true（默认） | **160x120（没放大）** |
 * | 160x120 | 640x480 | false | 640x480 |
 * | 160x120 | 宽 320 | true | 160x120 |
 *
 * ⚠️ **`min(iw,W)` 这两个表达式是承重的**：`force_original_aspect_ratio=decrease`
 * 只保证「不超出框」，**照样会把小图放大到框的大小**（实测），所以「不放大」只能用
 * 表达式把框夹成「框与源里更小的那个」。少写它，用户拿到的就是本项目最忌讳的那种
 * 「不报错的错误答案」：参数写着不放大、产物却大了一圈。
 *
 * ⚠️ 表达式里的逗号必须写成 `\,`：它就在滤镜图里，不转义的话 ffmpeg 会把
 * `scale=min(iw` 与 `640)` 当成两个滤镜。数组传参救不了这一处——这一层是 ffmpeg
 * 自己的滤镜图语法，与 shell 无关。
 *
 * 只给一个维度时另一维写 `-2`（而不是 `-1`）：h264 / yuv420p 要求宽高都是偶数，
 * `-2` 在保持比例的同时把结果取偶数，省掉一次「转换失败：width not divisible by 2」。
 */
function resizeFilter(action: ResizeAction): string {
  const { width, height, fit, withoutEnlargement: noEnlarge } = action
  const box = (w: number, h: number): string => `min(iw\\,${w}):min(ih\\,${h})`

  if (width !== undefined && height !== undefined) {
    // 拉伸与裁切填满这两个 fit 的**定义**就是要达到这个框，所以「不放大」在这里
    // 表达成「框先按源夹住」：源比框小就原样，源比框大才缩/裁。
    if (fit === 'fill') {
      return noEnlarge ? `scale=${box(width, height)}` : `scale=${width}:${height}`
    }
    if (fit === 'cover') {
      const frame = noEnlarge ? box(width, height) : `${width}:${height}`
      return `scale=${frame}:force_original_aspect_ratio=increase,crop=${frame}`
    }
    return noEnlarge
      ? `scale=${box(width, height)}:force_original_aspect_ratio=decrease`
      : `scale=${width}:${height}:force_original_aspect_ratio=decrease`
  }

  if (height === undefined) {
    return noEnlarge ? `scale=min(iw\\,${width}):-2` : `scale=${width}:-2`
  }
  return noEnlarge ? `scale=-2:min(ih\\,${height})` : `scale=-2:${height}`
}

/**
 * 把处理链编译成一条 `-vf`，没有视频动作时返回 `null`。
 *
 * **顺序就是数组顺序**，`join(',')` 一步不做别的——去隔行 → 降噪 → 锐化那条纪律
 * 靠的就是这里不动它。
 */
export function videoFilterChain(filters: readonly FilterAction[]): string | null {
  const parts: string[] = []
  for (const action of filters) {
    const piece = videoFilterOf(action)
    if (piece !== null) parts.push(piece)
  }
  return parts.length > 0 ? parts.join(',') : null
}

/**
 * 一条 `loudnorm` 滤镜。
 *
 * `measured` 非 null 时是**第二遍**：带上第一遍量出来的四个实测值 + `offset`，
 * 并显式 `linear=true`（整段平移一个增益，动态范围不变）。
 *
 * ⚠️ **那一句 `linear=true` 不是承重的**：实测把它删掉产物**逐字节不变**——
 * loudnorm 的默认值就是 `true`，写出来只是把意图摆在明面上。**真正决定线性还是动态的
 * 是带不带 `measured_*`**（不带就是单遍动态，实测同一素材的两段差从 30.5 LU 掉到 6.9 LU）。
 * 为 null 时是**第一遍**（或降级），走单遍的动态归一化。
 *
 * `print_format`：第一遍要 `json`（从 stderr 里把统计读回来），第二遍只要 `summary`
 * （那一行「Output Integrated / Normalization Type: Linear」是排查时最有用的东西）。
 */
function loudnormFilter(
  action: LoudnormAction,
  measured: LoudnormStats | null,
  format: 'json' | 'summary'
): string {
  const head = `loudnorm=I=${action.targetLufs}:TP=${LOUDNORM_TP}:LRA=${LOUDNORM_LRA}`
  if (measured === null) return `${head}:print_format=${format}`
  return (
    `${head}:measured_I=${measured.inputI}:measured_LRA=${measured.inputLra}` +
    `:measured_TP=${measured.inputTp}:measured_thresh=${measured.inputThresh}` +
    `:offset=${measured.targetOffset}:linear=true:print_format=${format}`
  )
}

/**
 * 把处理链编译成一条 `-af`，没有音频动作时返回 `null`。
 *
 * ⚠️ **只有链上第一条 `loudnorm` 拿得到实测统计。** 两条 `loudnorm` 叠在一起是
 * 一个没有意义的配方（第二条会把第一条的结果再归一化一次），这里不给它报错——
 * 但也不假装第二条是线性的：它按单遍处理。写成「每条都喂同一份 measured」的话，
 * 那个增益会被应用两次，产物的响度偏离目标而任务报成功。
 */
export function audioFilterChain(
  filters: readonly FilterAction[],
  measured: LoudnormStats | null
): string | null {
  const parts: string[] = []
  let first = true
  for (const action of filters) {
    if (action.kind !== 'loudnorm') continue
    parts.push(loudnormFilter(action, first ? measured : null, 'summary'))
    first = false
  }
  return parts.length > 0 ? parts.join(',') : null
}

/**
 * 响度归一化的**第一遍**：只分析、不产出，把统计打到 stderr 上。
 *
 * 与两遍编码的第一遍是同一套做法（`-f null NUL`），但**不需要 VIDEO 那一侧的统计**，
 * 所以带 `-vn`：省掉一次整片解码，短视频上这是可见的差别。
 *
 * ⚠️ **源里没有音轨时这一趟会失败**（实测 rc 非 0：`Output file does not contain any
 * stream`——`-vn` 之后一条输出流都不剩了）。调用方要先用结构判据（源里有没有音频流）
 * 决定跑不跑它，**不能靠匹配那句报错文案**（约束 23 第 4 条）。
 */
export function buildLoudnormProbeArgs(
  input: string,
  action: LoudnormAction,
  trim?: Clip
): string[] {
  return [
    '-hide_banner',
    '-nostdin',
    '-y',
    // 与其它几条路径同一个口径：定位在 `-i` 之前（精确模式的起点是帧级准确的）
    ...(trim ? ['-ss', secondsArg(trim.start)] : []),
    '-i',
    input,
    '-vn',
    '-af',
    loudnormFilter(action, null, 'json'),
    // 与两遍编码第一遍同一个口径：统计只到 stderr，产物丢给 null 封装器
    ...(trim ? ['-t', secondsArg(trim.duration)] : []),
    '-f',
    'null',
    'NUL'
  ]
}

/**
 * 从第一遍的 stderr 里把那段 JSON 读回来。
 *
 * 形状是 ffmpeg 自己打的（实测 6.1.1 的字段名与顺序）：
 *
 * ```
 * [Parsed_loudnorm_0 @ …]
 * {
 *   "input_i" : "-22.44",   "input_tp" : "-17.83",
 *   "input_lra" : "3.50",   "input_thresh" : "-35.58",
 *   "output_i" : "…",       "normalization_type" : "dynamic",
 *   "target_offset" : "-1.41"
 * }
 * ```
 *
 * 读不出来（没这段、字段缺、值不是数）一律回 `null`——调用方据此**降级成单遍**
 * 并把这件事说出来，而不是拿一堆 `NaN` 去拼命令行（那种命令行 ffmpeg 会直接报错，
 * 而错误信息里完全看不出是我们算错了）。
 *
 * `[^{}]*` 而不是 `[\s\S]*?`：这段 JSON 是**扁平**的（没有嵌套对象），限制住花括号
 * 可以避免在 stderr 里别的花括号（比如中文路径或报错里带的 `{}`）之间乱跨。
 */
export function parseLoudnormStats(stderr: string): LoudnormStats | null {
  const block = /\{[^{}]*"input_i"[^{}]*\}/.exec(stderr)
  if (block === null) return null

  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(block[0]) as Record<string, unknown>
  } catch {
    return null
  }

  const num = (key: string): number | null => {
    const value = Number(raw[key])
    return Number.isFinite(value) ? value : null
  }
  const inputI = num('input_i')
  const inputTp = num('input_tp')
  const inputLra = num('input_lra')
  const inputThresh = num('input_thresh')
  const targetOffset = num('target_offset')
  if (
    inputI === null ||
    inputTp === null ||
    inputLra === null ||
    inputThresh === null ||
    targetOffset === null
  ) {
    return null
  }
  return { inputI, inputTp, inputLra, inputThresh, targetOffset }
}

/**
 * 组装 ffmpeg 参数。
 *
 * 三个关键开关：
 *  - `-nostdin`  防止 ffmpeg 抢 stdin 导致偶发挂死（批量任务时尤其明显）
 *  - `-progress pipe:1`  让进度块写到 stdout，stderr 留给错误信息
 *  - `-nostats`  关掉默认的 stderr 状态行，避免和错误信息混在一起
 *
 * 返回数组而非字符串：用户文件名里的空格/引号/&/$() 全都不必转义，
 * 因为根本不会经过 shell 解析。
 */
export function buildFfmpegArgs(
  input: string,
  output: string,
  fromExt: string,
  toExt: string,
  options: {
    /** `hardware: true` 请求 GPU 编码。**调用方必须先探过**，见 core/nvenc 的说明 */
    hardware?: boolean
    /**
     * 裁剪（精确模式）。给了它就多出 `-ss` / `-t` 两个参数，
     * 其余一切（编码器、质量、容器参数）与不裁剪时**逐字相同**。
     *
     * `trim` 的形状是 `{ start, duration }` 而不是 `TaskOptions` 里那个
     * `{ start, end, mode }`：`end` 只属于用户，`-t` 要的是时长，而
     * 「`duration = end − start`」这一步由 `runFfmpeg` 算**一次**之后同时喂给这里
     * 和进度分母——两处各算一遍迟早会分叉，而分叉的表现是「进度条与产物长度对不上」。
     */
    trim?: Clip
    /**
     * 输出约束（体积 / 码率）翻译过来的编码参数。给了它就**整体替换掉质量模式那一套**
     * （`-crf` / `-cq`），见 `EncodeTarget`。
     */
    target?: EncodeTarget
    /**
     * 处理链（有序）。给了它就多出**一条** `-vf`（视频动作）和/或**一条** `-af`
     * （音频动作），位置与内容见下面的分派。
     *
     * ⚠️ **有处理链时调用方必须让 remux 与无损裁剪失效**（`-c copy` 搬的是原始码流，
     * 装不下改过像素的东西）——那条否定在 `converters/ffmpegRun.ts` 的决策点上，
     * 不在这里。这里只管把链拼成参数。
     */
    filters?: readonly FilterAction[]
    /**
     * 响度归一化的实测统计（第一遍的产物）。给了它，链上的 `loudnorm` 就走
     * **线性**归一化；不给就是单遍的动态归一化。
     */
    loudnorm?: LoudnormStats | null
  } = {}
): string[] {
  const from = fromExt.toLowerCase()
  const to = toExt.toLowerCase()
  const trim = options.trim
  const enc = options.target
  const filters = options.filters ?? []

  // 两条链各算一次。`vf` 在**音频出口**上必须是 null：`-vn` 与 `-vf` 同时出现时
  // ffmpeg 直接报 `Output file does not contain any stream` 并以非 0 退出（实测），
  // 而那一类出口本来也没有像素可改。
  const vf = AUDIO_TARGETS.has(to) ? null : videoFilterChain(filters)
  // 反过来，`-af` 只加在**真的有音轨**的出口上：音频出口当然有，视频容器有；
  // gif（无声）与图片出口没有——那两类上给 `-af` 也是白给，`-vn`/图片出口根本没有音频流。
  const audioOut = AUDIO_TARGETS.has(to) || (!IMAGE_TARGETS.has(to) && to !== 'gif')
  const af = audioOut ? audioFilterChain(filters, options.loudnorm ?? null) : null

  // 图片源转视频容器那条路（下面 `-loop 1 -t 5`）**刻意不沾 GPU**：它只有 5 秒静止画面，
  // 而实测 NVENC 有一笔固定的启动开销，小活上这笔开销能把省下的编码时间整个吃掉
  // ——「图片转 mp4 反而更慢」是用户绝对不会预期的结果。
  const hardware = options.hardware === true && !IMAGE_TARGETS.has(from)

  // 滤镜片段按出口分派。⚠️ `-vf` / `-af` 是**输出侧**选项，同名选项后者胜出——
  // 所以每条链在整个命令行里只能出现一次（gif 那条分支的合并见下面）。
  const vfArgs = vf === null ? [] : ['-vf', vf]
  const afArgs = af === null ? [] : ['-af', af]

  let encode: string[]
  if (to === 'gif') {
    // ⚠️ **gif 这条分支本来是写死的一条 `-vf`**（palettegen/paletteuse 那一串）。
    // 再给一条 `-vf` 的话 ffmpeg **只取最后那个**，于是要么调色板链消失、要么用户的链
    // 消失——两边都不报错，只是产物不对。所以两条链**合并成一条**：用户的链在前
    // （先转正、缩放，再抽帧与量化）。
    const graph = vf === null ? GIF_FILTER : `${vf},${GIF_FILTER}`
    encode = ['-vf', graph, '-loop', '0']
  } else if (AUDIO_TARGETS.has(to)) {
    encode = [...audioArgs(to, enc?.audioKbps), ...afArgs]
  } else if (IMAGE_TARGETS.has(to)) {
    encode = [...imageArgs(to), ...vfArgs]
  } else if (IMAGE_TARGETS.has(from)) {
    // 单张图片转视频容器：补一段静止画面，否则只有一帧。
    // 这段画面的长度同时也是体积目标反推码率时的分母（见 STILL_DURATION_SEC）
    encode = [
      '-loop',
      '1',
      '-t',
      String(STILL_DURATION_SEC),
      ...videoArgs(to, false, enc),
      ...vfArgs,
      ...afArgs
    ]
  } else {
    encode = [...videoArgs(to, hardware, enc), ...vfArgs, ...afArgs]
  }

  return [
    '-hide_banner',
    '-nostdin',
    '-y',
    // 输入侧的定位，**必须在 `-i` 之前**。那个位置 ffmpeg 会先按时间跳过去，
    // 再从这个点往后解码——重编码时它把跳过去的那一段整个丢掉，所以起点是**帧级准确**的
    // （实测：请求 `[3, 5)` 得到的首帧与源 t=3s 那一帧 PSNR 39.2 dB，与 t=2s 那一帧只有 14.0）。
    ...(trim ? ['-ss', secondsArg(trim.start)] : []),
    '-i',
    input,
    '-progress',
    'pipe:1',
    '-nostats',
    ...encode,
    // 容器参数永远排在编码参数之后、输出文件之前。拆出去是为了 remux 能沿用同一份
    ...containerArgs(to),
    // 裁剪时长。**排在 `-t` 可能出现的所有位置之后**（图片源那条分支自带一个 `-t 5`）：
    // 同名输出选项是后者胜出，于是「用户明确要求的裁剪时长」永远比内建的默认值优先。
    ...(trim ? ['-t', secondsArg(trim.duration)] : []),
    output
  ]
}

/**
 * 传给 ffmpeg 的秒数。
 *
 * 固定三位小数而不是 `String(value)`：`(0.1 + 0.2)` 那种浮点尾巴会原样进命令行，
 * 让参数数组变得不可预期（断言也就钉不住它）。秒级精度下 1 毫秒的粒度够用。
 */
function secondsArg(value: number): string {
  return value.toFixed(3)
}

/**
 * 两遍 ABR 的**第一遍**：只分析、不产出。
 *
 * 为什么体积目标必须走两遍，而不是别的办法（都是实测）：
 *
 * - **`-fs` 不是目标体积。** 实测目标 300 KB 产出 534 KB **且视频被截断在 2.03 秒**——
 *   它是「写到这么多就停」，不是「压到这么多」。
 * - **单遍 ABR 在体积上不可控**：`-b:v` 是软目标，短素材上偏差可以到几十个百分点，
 *   而用户填的是一个硬上限（发给别人用）。
 * - 两遍编码第一遍把每个帧该分多少比特记进统计文件，第二遍按它编，实测能压在目标之内
 *   （见 `scripts/test-tasks.ts` 的 [18]）。
 *
 * ⚠️ **两遍都需要知道时长**，而时长本来是从转换进程自己的 stderr 里捡的（`tryAdoptDuration`），
 * 那对第一遍来说太晚了——所以调用方先探一次（复用 `probeStderr`，它已带缓存与取消槽位）。
 * 约束 5 那句「不单独探测」讲的是「必然重编码且没有体积目标」的场景，与这里不矛盾。
 *
 * ⚠️ Windows 上丢弃输出写 `NUL`：写成 `/dev/null` 会被 ffmpeg 当成一个普通文件名，
 * 于是在当前目录里落下一个叫 `/dev/null` 的文件（还得先建目录才能成功），
 * 而任务报成功。
 */
export function buildPassOneArgs(
  input: string,
  toExt: string,
  options: {
    videoKbps: number
    /** `-passlogfile` 前缀，**与第二遍必须是同一个**，否则第二遍读不到统计 */
    passLogFile: string
    trim?: Clip
    /**
     * 处理链。**第一遍必须带上与第二遍相同的视频滤镜**：统计文件记的是
     * 「这一帧该分多少比特」，而滤镜（缩放/降噪/去隔行）恰恰改变了每一帧的复杂度——
     * 两边不一致时分配出来的比特是错位的，产物码率对不上目标而任务报成功。
     * 音频链不带：第一遍有 `-an`，本来就没有音频要编。
     */
    filters?: readonly FilterAction[]
  }
): string[] {
  const to = toExt.toLowerCase()
  const codec = to === 'webm' ? ['-c:v', 'libvpx-vp9'] : ['-c:v', 'libx264', '-preset', 'veryfast']
  const vf = videoFilterChain(options.filters ?? [])

  return [
    '-hide_banner',
    '-nostdin',
    '-y',
    ...(options.trim ? ['-ss', secondsArg(options.trim.start)] : []),
    '-i',
    input,
    '-progress',
    'pipe:1',
    '-nostats',
    ...codec,
    '-b:v',
    `${Math.max(1, Math.round(options.videoKbps))}k`,
    ...(vf === null ? [] : ['-vf', vf]),
    '-pass',
    '1',
    '-passlogfile',
    options.passLogFile,
    // 第一遍只统计不产出：`-an` 省掉一次音频编码，产物丢给 null 封装器。
    // `-t` 必须排在输出文件**之前**（同名输出选项属于「下一个输出」，排在后面会变成一句警告）
    ...(options.trim ? ['-t', secondsArg(options.trim.duration)] : []),
    '-an',
    '-f',
    'null',
    'NUL'
  ]
}

/** 目标格式是图片时不需要探测时长（拿不到也不影响） */
export function isImageTarget(toExt: string): boolean {
  return IMAGE_TARGETS.has(toExt.toLowerCase())
}

// ---------------------------------------------------------------------------
// remux（智能重封装）
// ---------------------------------------------------------------------------
//
// 容器兼容只是「能把这两条码流装进去」，不保证播放器一定能解——但那是播放器的事，
// 与这里的判据无关。判据要回答的只有一句：**`-c copy` 会不会报错**。

/**
 * remux 白名单：目标容器 → 能直接 `-c copy` 装进去的编解码器。
 *
 * 表里的每一项都是**实测**出来的，不是照规范推的（对照表见 docs/NOTES.md 约束 18）。
 * 两个反直觉的结果值得单独记：
 *
 * - **vp9 + opus 进 mp4 是可行的**——原先以为不行。两者都有 ISOBMFF 绑定。
 * - **同一份 h264 码流，从 mkv 转 avi 要 Annex-B、从 mp4 转 avi 又不用**
 *   （ffmpeg 两条解复用路径给出的包格式不同），而补 Annex-B 要按编解码器
 *   挑 `-bsf:v h264_mp4toannexb` / `hevc_mp4toannexb`，挑错就报
 *   `Codec 'xxx' is not supported`。为了一个冷门目标维护这张对应关系不划算，
 *   所以 **avi 干脆不出现在这张表里**：一律重编码。
 *
 * **未列出的组合一律走重编码**，这是刻意的保守方向——白名单漏判的代价只是
 * 「慢一点」，黑名单误判的代价是「产出坏文件或直接报错」。要放宽某一条，先补实测。
 */
const REMUX_VIDEO: Record<string, readonly string[]> = {
  mp4: ['h264', 'hevc', 'mpeg4', 'vp9'],
  m4v: ['h264', 'hevc', 'mpeg4', 'vp9'],
  // vp9 进 mov 会报 `vp9 only supported in MP4`，所以 mov 这一行比 mp4 少
  mov: ['h264', 'hevc', 'mpeg4'],
  // mkv 是通用容器，这一行放宽到常见编解码器都有规范依据
  mkv: ['h264', 'hevc', 'mpeg4', 'vp9', 'vp8', 'mpeg2video', 'av1'],
  webm: ['vp8', 'vp9', 'av1']
}

const REMUX_AUDIO: Record<string, readonly string[]> = {
  mp4: ['aac', 'mp3', 'opus', 'ac3', 'eac3'],
  m4v: ['aac', 'mp3', 'opus', 'ac3', 'eac3'],
  mov: ['aac', 'mp3', 'opus', 'ac3', 'eac3'],
  mkv: ['aac', 'mp3', 'opus', 'vorbis', 'flac', 'ac3', 'eac3', 'alac'],
  /** webm 只吃 Vorbis/Opus——`Only VP8 or VP9 or AV1 video and Vorbis or Opus audio` */
  webm: ['vorbis', 'opus']
}

/**
 * 这次转换**够不够格**考虑 remux——只看方向，不看编解码器。
 *
 * 拆出来是为了避免白探一次：编解码器只能靠起进程问 ffmpeg 才知道（约 30ms），
 * 而图片、gif 这些方向从一开始就没可能 remux，不该付这个钱。
 *
 * ⚠️ **这里没有「抽音轨」这一路**（视频 → m4a）。不是漏了，是那条路在本项目里**不存在**：
 * `targetsFor()` 给出的 13 个视频源格式，**没有一个**能选到 m4a 为目标
 * （m4a 只出现在 9 个音频源的出口里）。所以「视频转 m4a 时 -vn -c:a copy」这个场景
 * 永远不会被触发，写出来就是死代码。要接它得先改 `shared/formats.ts` 的能力矩阵，
 * 而那是枢纽文件（见 PLAN §4.3）——等真要做的时候一起改，别在这里埋一半。
 */
export function remuxEligible(fromExt: string, toExt: string): boolean {
  const from = fromExt.toLowerCase()
  const to = toExt.toLowerCase()

  // 图片源转视频容器走的是 `-loop 1` 补静止画面那一条，探测它也拿不到 Video 流
  if (IMAGE_TARGETS.has(from) || IMAGE_TARGETS.has(to)) return false
  // gif 必须过调色板滤镜重编码，没有「原样搬过去」这种可能
  if (to === 'gif') return false

  return REMUX_VIDEO[to] !== undefined
}

/**
 * 码流能不能原样搬进目标容器。
 *
 * 调用方必须先用 `remuxEligible()` 过滤过方向——这里假定 `toExt` 是个候选目标。
 */
export function canRemux(toExt: string, info: MediaInfo): boolean {
  const to = toExt.toLowerCase()

  const video = REMUX_VIDEO[to]
  if (!video) return false
  if (info.videoCodec === null || !video.includes(info.videoCodec)) return false

  // 音频那一侧同样是承重的，实测：同一个 vp9 视频流，opus 音轨能 `-c copy` 进 webm，
  // 换成 aac 就报 `Only VP8 or VP9 or AV1 video and Vorbis or Opus audio`。
  // 只判视频的话，vp9+aac → webm 会被判成可 remux，然后整个任务失败。
  //
  // 无音轨的源（静音视频）照样能 remux——音频那一侧没有东西要装。
  // 这条不能写成 `!info.hasAudio || ...`：那样纯视频源会被判成不兼容而白白重编码。
  const audio = REMUX_AUDIO[to] ?? []
  if (info.audioCodec !== null && !audio.includes(info.audioCodec)) return false

  return true
}

/**
 * 组装 remux 参数：`-c copy` 版的重封装。
 *
 * `-map` 显式取第一条视频/音频，口径与重编码路径一致（不指定 `-map` 时 ffmpeg
 * 也是这么默认选的），所以两条路产出的流构成相同，用户看不出区别。
 * 尾巴上的 `?` 让缺失的流不致命——纯视频源也能转。
 *
 * `-map` 与 `-progress` 的位置都在输出侧选项区，`-c copy` 下 `-progress` 照样吐记录，
 * 所以进度条不会因为 remux 变成哑的。
 */
/**
 * 只探测、不产出：不带输出文件，ffmpeg 会在打印完流信息后以**非 0**退出
 * （`At least one output file must be specified`）——那是预期内的，调用方只看 stderr。
 *
 * `-nostdin` 不能省：探测也是子进程，一样有抢 stdin 挂死的风险（见 buildFfmpegArgs）。
 */
export function buildProbeArgs(input: string): string[] {
  return ['-hide_banner', '-nostdin', '-i', input]
}

export function buildRemuxArgs(input: string, output: string, toExt: string): string[] {
  return [
    '-hide_banner',
    '-nostdin',
    '-y',
    '-i',
    input,
    '-progress',
    'pipe:1',
    '-nostats',
    '-map',
    '0:v:0?',
    '-map',
    '0:a:0?',
    '-c',
    'copy',
    ...containerArgs(toExt.toLowerCase()),
    output
  ]
}

// ---------------------------------------------------------------------------
// 裁剪（无损）
// ---------------------------------------------------------------------------

/**
 * 一次裁剪的**参数层**形状：起点 + 时长。
 *
 * 与 `@shared/types` 的 `TrimOptions`（`{ start, end, mode }`）刻意不同型：
 * 用户说的是「从哪到哪」，ffmpeg 要的是「从哪起、走多远」，而 `mode` 决定的是
 * **调这个函数还是调 `buildFfmpegArgs`**，属于调用方的分派，不该再传进来。
 */
export interface Clip {
  /** 起点，秒。**只能保证不小于它**——无损模式下会回退到前一个关键帧 */
  start: number
  /** 时长（`end − start`），秒。**调用方算一次**，见 `buildFfmpegArgs` 的说明 */
  duration: number
}

/**
 * 无损裁剪的参数：`-c copy` + 输入侧定位。
 *
 * ## 为什么是这组参数（全部实测，素材 640x360 / 30fps / `-g 60`，关键帧落在 0,2,…,8）
 *
 * 光看「输出多长」会得出错误结论——真正的判据是**产物包里到底是源的哪一段**。
 * 用 `-f framemd5` 逐包比对（拷贝出来的包与源逐位相同，于是能精确定位）实测：
 *
 * | 命令（请求 `[3, 5)`） | 实际覆盖到的源区间 | 容器报的时长 |
 * | --- | --- | --- |
 * | `-ss 3 -i in -t 2 -c copy -avoid_negative_ts make_zero`（本条） | `[2, 5)`：终点准，多了一段头 | 3.14 s |
 * | 同上但**去掉** `-avoid_negative_ts` | 同样是 `[2, 5)`，但**首包 pts = −1.0** | 2.07 s（骗人） |
 * | `-i in -ss 3 -t 2 -c copy` | `[4, 5)`：`[3, 4)` 那一段**被永久丢掉** | 2.05 s |
 *
 * 三件事由此定下来：
 *
 * 1. **`-ss` 放在 `-i` 之前。** 放在后面时 ffmpeg 会一路解码丢弃到**下一个**关键帧才开始
 *    输出，于是 `[3, 4)` 这一秒用户明确要的内容凭空消失，而且**退出码是 0**
 *    （本表第三行就是我实测到的，不是照抄规范）。
 * 2. **`-t` 给的是时长，不是「到某个绝对时刻」。** `-t D` 与输入侧 `-ss S` 合起来
 *    覆盖的是 `[前一个关键帧, S+D)`——**终点是准的**，多出来的只有头。
 *    `-to` 试过：`-ss 3 -i in -c copy -to 5` 实际覆盖到源 8.1s（多出整整 6 秒，因为
 *    `-to` 落在输出时间轴上，而那条时间轴在拷贝时是带偏移的），所以不用它。
 * 3. **`-avoid_negative_ts make_zero` 是承重的，不是顺手加的。**
 *    漏掉它时内容其实一样，但源 `[前一个关键帧, S)` 那一段包的 pts 是**负的**
 *    （实测首包 `pts = -1.0`），而 mp4 表达不了负时间戳，容器于是报
 *    `Duration: 00:00:02.07`——文件短了一整秒，播出来就是「用户要的内容被吃掉了」。
 *    加上它之后首包 pts 归零、容器报 3.14s（3 秒内容 + 末尾那个音频包）。
 *    ⚠️ 这条正是「光看 `-t` 的数字会得出相反结论」的地方：没有它，
 *    `-t 2` 看起来「正好 2 秒」，而那 2 秒是从**关键帧**数的。
 *
 * 于是无损模式对用户的承诺只有一句，而且是**行为**不是提示：
 * **起点会对齐到最近的关键帧（可能比你要的早一点），终点准，一个字节都不重编。**
 * 那句提示跟着参数一起出现在界面上（见 `shared/trim.ts` 的 `describeTrim`）。
 *
 * ## 与 remux 快车道的关系
 *
 * **没有关系——这是两件不同的事，共用一份判据而已。**
 *
 * - remux 判的是「**整段**码流能不能原样装进目标容器」，它是纯粹的性能优化：
 *   行就 `-c copy`，不行就静默重编码，产物语义不变。
 * - 裁剪判的是「**其中一段**码流能不能原样搬走」，它不是优化而是用户的要求：
 *   做不到就得说，不能静默换一条路（静默重编码会改掉用户的画质预期）。
 *
 * 两者唯一的接触面是**容器白名单**（`REMUX_VIDEO` / `REMUX_AUDIO`，即
 * 「目标容器装不装得下这种编解码器」），那是同一份事实，所以复用 `canRemux()`；
 * 但 remux 那个**布尔**（决定走不走快车道）在带裁剪时恒为 false，
 * 裁剪自己决定用不用 `-c copy`。见 `ffmpegRun.ts` 里那段决策块。
 *
 * `-map` 的口径与 `buildRemuxArgs` 完全一致（第一条视频 + 第一条音频，
 * 尾巴上的 `?` 让纯视频 / 纯音频的源也能裁），只是这里多一条：**音轨不参与对齐**
 * ——音频没有关键帧，输入侧定位对它就是「从这个时间点往后」，
 * 所以它跟着视频一起被切在同一个区间里，不会出现音画不同步。
 */
export function buildTrimCopyArgs(
  input: string,
  output: string,
  toExt: string,
  trim: Clip
): string[] {
  return [
    '-hide_banner',
    '-nostdin',
    '-y',
    // ★ 必须在 `-i` 之前，理由见上面第 1 条
    '-ss',
    secondsArg(trim.start),
    '-i',
    input,
    '-progress',
    'pipe:1',
    '-nostats',
    '-map',
    '0:v:0?',
    '-map',
    '0:a:0?',
    '-c',
    'copy',
    // 见上面第 3 条：这一行的有无决定「头那一段还能不能播」
    '-avoid_negative_ts',
    'make_zero',
    '-t',
    secondsArg(trim.duration),
    // 容器参数在 `-c copy` 下同样有效（`-movflags +faststart` 只重写索引、不碰码流），
    // 所以这里与重编码路径共用同一份——少了它，裁出来的 mp4 不能边下边播
    ...containerArgs(toExt.toLowerCase()),
    output
  ]
}
