import { mkdtemp, rm, stat } from 'fs/promises'
import { tmpdir } from 'os'
import { basename, dirname, join } from 'path'
import sharp, { type Sharp } from 'sharp'
import type { FilterAction, TaskProgress } from '@shared/types'
import { formatBytes } from '@shared/format'
import type { CancelToken } from '../core/cancel'
import { partPathOf } from '../core/outputName'
import { decodeHeif, type HeifPixels } from './heic'
import {
  ConversionCanceled,
  ConversionFailed,
  finalizeOutput,
  removeQuietly,
  tailLines,
  type ConvertContext
} from './common'

/** 这些目标格式能装下多帧，源图是动图时应该保留动画而不是只取第一帧 */
const ANIMATED_TARGETS = new Set(['gif', 'webp', 'avif', 'png'])

/**
 * **sharp 的输入侧读不了**的源格式。这份名单是实测出来的，不是照抄文档。
 *
 * 实测（sharp 0.35.4 / 预编译 libvips）：
 *   - `sharp.format` 里**根本没有** `bmp` / `ico` 这两项（`undefined`，不是 `input:false`）。
 *     连 `magick` 那一项也是 `input:false`——预编译版剔掉了 ImageMagick。
 *   - 拿真文件去喂（用 ffmpeg 现造的 32x24 BMP 与 ICO，不是手搓字节）：
 *     `Input file contains unsupported image format`，两个格式都是。
 *
 * **这一条是能力矩阵的一处硬伤**：`bmp` / `ico` 是登记在册的源格式，而它们的
 * png/jpg/webp/avif/tiff/gif 六个出口在 `engineFor` 里都路由给 `sharp` —— 那六个格子
 * 曾经**没有一格跑得通**（`bmp → ico` / `ico → bmp` 走 ffmpeg，是好的；`→ pdf` 那格
 * 卡在 `document.ts` 用 sharp 量尺寸）。修法不是改路由（ffmpeg 也写不出 gif：
 * 实测 `bmp → gif` 直接失败），而是**给 sharp 补一步解码**：先用 ffmpeg 解成 PNG，
 * 再交给原来那条 sharp 管线。于是输出格式的能力表一个字都不用动。
 *
 * 输出侧那份表（哪些格式 sharp 写不出来）在 `@shared/formats` 的 `SHARP_IMAGE_TARGETS`
 * 里，两份合起来才是 sharp 的完整能力边界。
 */
export const SHARP_UNREADABLE_SRC = new Set(['bmp', 'ico'])

/** 单张图片的解码上限，防止一张 10 亿像素的图把内存吃干 */
const MAX_PIXELS = 512 * 1024 * 1024

/**
 * 把 `SHARP_UNREADABLE_SRC` 里的格式先解成一张 PNG，返回它的路径；源格式 sharp 读得了
 * 就返回 null（调用方拿 null 就该原样用自己的输入）。
 *
 * 走 ffmpeg 而不是自己解：BMP 的 4/8/16/24/32 位、RLE 压缩、ICO 的多尺寸条目与
 * PNG 内嵌条目，自己写一份解析器就是把一个已经解决的解码问题重做一遍，还会漏。
 * 产物落在调用方给的临时目录里，由调用方负责收走。
 *
 * **动态 import**：`document.ts` 也要用它（`bmp → pdf` 那条路要先量尺寸），而那条线
 * 在 MCP 进程里跑——不让每个文档转换都拖着 ffmpeg 的依赖图（同 `chromiumPdf` 的理由）。
 */
export async function normalizeToPng(
  input: string,
  fromExt: string,
  tempDir: string,
  cancel: CancelToken
): Promise<string | null> {
  if (!SHARP_UNREADABLE_SRC.has(fromExt)) return null

  const { runFfmpeg } = await import('./ffmpegRun')
  const target = join(tempDir, 'source.png')
  await runFfmpeg({
    input,
    output: target,
    fromExt,
    toExt: 'png',
    cancel,
    onProgress: () => undefined
  })
  return target
}

/* ------------------------------------------------- 处理链与「压到多少字节」 */

/**
 * 有质量旋钮的目标格式。
 *
 * **PNG / TIFF / GIF 不在里面**：PNG 与 TIFF-LZW 是无损编码、GIF 是调色板编码，
 * 三者都没有「质量」这个维度。给它们做体积二分只能靠反复降分辨率或减色，
 * 那是**另一件事**（用户要的是「压到 200 KB」，不是「偷偷把图改小」）。
 * 所以这几条路必须**明确拒掉**——见 `targetSizeRefusal`。
 */
const QUALITY_TARGETS = new Set(['jpg', 'jpeg', 'webp', 'avif'])

/** 质量搜索的下限。再往下压产物就是一片马赛克了——宁可说「做不到」也不交出一个没法看的文件。 */
const MIN_SEARCH_QUALITY = 20

/**
 * 质量搜索的上限。
 *
 * 先拿它试一遍是刻意的：**能装下就直接是最优解，而且只编一遍**。用户的「压到 200 KB」
 * 绝大多数都能在最高质量下满足，所以常见情形一次编码就结束，二分只在装不下时才启动。
 */
const MAX_SEARCH_QUALITY = 100

/** AVIF 搜索阶段的 effort。见 `encodeToTargetBytes`：每一轮都要重编，按正常档位走是十几秒一轮。 */
const AVIF_SEARCH_EFFORT = 1

/**
 * AVIF 搜索阶段给正式那一遍留的余量。
 *
 * effort 从 1 提到 4 之后，**同样的质量通常编得更大**，所以搜索不能照着 `targetBytes`
 * 顶格收敛，否则正式那一遍必然超标。0.85 是保守的，它换来的是「正式那一遍基本不用回退」。
 */
const AVIF_HEADROOM = 0.85

/** 正式那一遍若仍然超标，向下回退的次数与步长。**必须是有界的**，不能无限重编。 */
const FINAL_DESCENT_STEPS = 3
const FINAL_DESCENT_STEP = 8

/** 编码器调参。只有体积搜索会用到——它要按质量反复编同一张图。 */
interface EncodeTuning {
  /** 覆盖该格式的默认质量。不传 = 用默认档 */
  quality?: number
  /** 只对 avif 有意义：搜索阶段 1，正式那一遍 4（也就是默认值） */
  effort?: number
}

function encoderFor(toExt: string, tuning: EncodeTuning = {}): (pipeline: Sharp) => Sharp {
  const { quality, effort } = tuning
  switch (toExt) {
    case 'jpg':
    case 'jpeg':
      return (p) => p.jpeg({ quality: quality ?? 90, progressive: true })
    case 'png':
      // ⚠️ **`effort` 是承重的，不是锦上添花**（2026-09-16 实测，1440×960 实拍 HEIC 源）：
      //
      // | 设置                             | 体积      | 耗时   |
      // | -------------------------------- | --------- | ------ |
      // | 只给 `compressionLevel: 9`       | 1929.4 KB | 84 ms  |
      // | 加上 `effort: 7`（= 现在这一档） |  466.3 KB | 677 ms |
      // | `effort: 10`                     |  464.3 KB | 1070 ms |
      //
      // 也就是**这一个旋钮扛着 4.1×**。它的语义是 libvips 侧的滤波器 / zlib 策略搜索
      // 档位（`compressionLevel` 只管 zlib 那一层），少了它产物体积会当场翻两番——
      // 而 PNG 是**无损**格式，用户看到的就是「同样一张图，怎么大了四倍」，
      // 没有任何地方会报错。
      //
      // 7 → 10 只再省 0.4%、耗时却翻倍，所以停在 7。这条有断言钉着
      //（`scripts/test-image-options.ts` 的 `[6]`，反证是 `falsify-image-options.mjs`）。
      return (p) => p.png({ compressionLevel: 9, effort: 7 })
    case 'webp':
      return (p) => p.webp({ quality: quality ?? 90, effort: 4 })
    case 'avif':
      // AVIF 编码极慢，effort 拉满会让一张图转几十秒，4 是速度/体积的平衡点
      return (p) => p.avif({ quality: quality ?? 60, effort: effort ?? 4 })
    case 'tiff':
      return (p) => p.tiff({ compression: 'lzw' })
    case 'gif':
      return (p) => p.gif()
    default:
      return (p) => p
  }
}

/**
 * 动作 → 把这一步接到管线上。
 *
 * **写成 `Record<kind, …>` 而不是 `switch`**：加新动作时漏了在这里补一行是**编译错误**
 * （这个映射要求每个判别值都有实现），而 `switch` 漏一个 case 只会在运行期静默少一步
 * ——链上写着「锐化」，产物里却没锐化，而任务报成功。
 *
 * ⚠️ `withoutEnlargement` **直通** sharp，**不给默认值**：schema 已经把它钉成必填，
 * 而 sharp 自己的默认是 `false`（放大）。「长边 1920」把一张 800px 的图拉大成 1920
 * 是本项目最忌讳的那种「不报错的错误答案」——在引擎这一层再兜一次默认值，
 * 等于把 schema 那道闸悄悄废掉。
 */
const FILTER_BUILDERS: {
  [K in FilterAction['kind']]: (
    pipeline: Sharp,
    action: Extract<FilterAction, { kind: K }>
  ) => Sharp
} = {
  resize: (pipeline, action) =>
    pipeline.resize({
      width: action.width,
      height: action.height,
      fit: action.fit,
      withoutEnlargement: action.withoutEnlargement
    }),

  // sharp 的 `rotate(角度)`。**注意与上面那次无参的 `rotate()` 不是一回事**：
  // 无参那次是「按 EXIF 自动摆正」，这个是用户显式要求的物理旋转。
  rotate: (pipeline, action) => pipeline.rotate(action.degrees),

  // 下面四项在**图片**这条路上不适用：隔行、时域噪点、空间锐化、响度都是
  // 视频/音频流的概念。它们**到不了这里**——`canUseAction()` 在
  // `TaskManager.setOptions` 就把它们拒了，界面上的「添加」菜单也按它过滤。
  //
  // ⚠️ 留着这四行、而不是从映射里省掉，是为了**保住上面那条编译期守卫**：
  // 省掉它们，加第七个动作时这里就会静默少一步（链上写着「锐化」、产物里没锐化、
  // 任务报成功）。抛错比静默跳过好——真有人绕过判据塞进来，错误会指名道姓。
  deinterlace: notOnImages,
  denoise: notOnImages,
  sharpen: notOnImages,
  loudnorm: notOnImages
}

/**
 * 上面那四个「图片不适用」的落点。**抛错而不是静默返回原管线**：
 * 静默的话，用户会在链上看到「锐化 1.5」而产物里什么都没发生——正是本项目
 * 最忌讳的那类「不报错的错误答案」。
 */
function notOnImages(_pipeline: Sharp, action: FilterAction): Sharp {
  throw new ConversionFailed([
    `处理步骤「${action.kind}」不适用于图片`,
    '这一步只对视频 / 音频有意义。这是一条内部错误：契约层的判据本该拦住它'
  ])
}

/**
 * 把处理链按**数组顺序**接到管线上。顺序就是执行顺序，所以这里只遍历一遍，
 * **不去重、不排序**（见 `FilterAction` 的注释）。
 *
 * ⚠️ 调用点在 `encoderFor()` **之前**：滤镜改的是像素，编码器读的是改完的像素。
 */
function applyFilters(pipeline: Sharp, filters: readonly FilterAction[] | undefined): Sharp {
  if (!filters || filters.length === 0) return pipeline

  let out = pipeline
  for (const action of filters) {
    // ⚠️ 这个 `as` 是**必须的**，而且它没有削弱上面那条编译期守卫：
    // `FILTER_BUILDERS` 按 `kind` 索引，所以取到的那一个**必然**接受这个 kind。
    // 是 TypeScript 推不出**关联联合类型**——它把六个函数签名合成一个交叉签名，
    // 参数位置就成了 `never`。加第七个动作时，**定义处那张映射**照样会报编译错误。
    const build = FILTER_BUILDERS[action.kind] as (p: Sharp, a: FilterAction) => Sharp
    out = build(out, action)
  }
  return out
}

/**
 * 「这个目标格式 + 这张图」能不能按体积压。返回 `null` = 可以，否则是给用户看的**原因**。
 *
 * **明确拒绝，绝不静默忽略。** 设了「压到 200 KB」而产物还是 1.2 MB、任务报成功，
 * 是本项目最忌讳的形态：用户拿到的东西和他要求的不一样，而且没有任何地方说得出这件事。
 *
 * 两条判据的顺序是刻意的：动图那条更具体（它说的是**这张图**为什么不行），先判它，
 * 用户才不会拿到一句「GIF 没有质量旋钮」——而他其实转的是 WebP 动图。
 */
export function targetSizeRefusal(toExt: string, pages: number): string | null {
  if (pages > 1 && ANIMATED_TARGETS.has(toExt)) {
    return (
      `这是一张 ${pages} 帧的动图：按体积压缩要对每一帧反复重编，成本随帧数线性增长，` +
      `所以这条路暂时不做。想控制体积请先用处理链缩小尺寸，或改转静态格式（如 JPEG）。`
    )
  }
  if (!QUALITY_TARGETS.has(toExt)) {
    return (
      `${toExt.toUpperCase()} 没有质量旋钮（无损或调色板编码），压不到指定体积。` +
      `想按体积压缩请改转 WebP 或 JPEG。`
    )
  }
  return null
}

/** 一条**可重复构建**的 sharp 管线。`Sharp` 实例是一次性的（同一个实例调两次 `toFile` 会抛），
 *  体积搜索正是靠反复重建来完成多轮试探的。 */
type PipelineFactory = (tuning: EncodeTuning) => Sharp

/**
 * 二分搜索质量，把产物体积压到 `targetBytes` 以内。
 *
 * 目标不是「随便找一个能装下的质量」，而是**能装下的最大质量**：体积上限是用户的硬约束，
 * 但画质不该因此被砍到没必要的地步。所以从 100 开始往下二分，命中即停。
 *
 * 单张图最多编 `2 + log2(80) ≈ 8` 遍，而**常见情形（最高质量就装得下）只编一遍**。
 *
 * AVIF 例外：它每编一遍都要几秒起步（见 `encoderFor` 那条注释），所以搜索阶段降到
 * `AVIF_SEARCH_EFFORT`，命中之后再按正常 effort 正式出一遍；后者通常更大，于是给搜索
 * 留了余量（`AVIF_HEADROOM`）、并在正式那一遍上做有界回退。代价是 AVIF 的体积目标
 * 仍可能失败，但**绝不会交出超标或画质崩掉的产物**。
 *
 * ⚠️ `onProgress` 传进来时已经被 `runSharp` 包上了**前置取消检查**（见那里的 `report`），
 * 所以这里每一轮试探都自带一次「编码前检查」——体积搜索要反复编同一张图，
 * 用户取消之后没有任何理由再编下一轮。
 */
async function encodeToTargetBytes(
  make: PipelineFactory,
  toExt: string,
  tempPath: string,
  targetBytes: number,
  onProgress: (progress: TaskProgress) => void
): Promise<void> {
  const dir = dirname(tempPath)
  const base = basename(tempPath)
  const isAvif = toExt === 'avif'
  const budget = isAvif ? Math.floor(targetBytes * AVIF_HEADROOM) : targetBytes

  /** 试探产物落在产物目录下——**必须能收干净**，见下面的 finally。 */
  const probes: string[] = []
  let round = 0

  const trial = async (quality: number): Promise<number> => {
    round += 1
    const probe = join(dir, `${base}.probe${round}.${toExt}`)
    probes.push(probe)
    onProgress({ kind: 'indeterminate', stage: `压缩到目标体积…（第 ${round} 次试探）` })
    await make({ quality, effort: isAvif ? AVIF_SEARCH_EFFORT : undefined }).toFile(probe)
    return (await stat(probe)).size
  }

  try {
    let quality: number
    if ((await trial(MAX_SEARCH_QUALITY)) <= budget) {
      quality = MAX_SEARCH_QUALITY
    } else {
      const floorSize = await trial(MIN_SEARCH_QUALITY)
      if (floorSize > budget) {
        // 「体积优先」不等于「不计代价」：连最低质量都装不下时，交出一个画质崩掉、
        // 体积仍然不达标的产物没有任何意义。宁可明说做不到。
        throw new ConversionFailed([
          `压到 ${formatBytes(targetBytes)} 做不到：质量降到最低档，产物仍有 ${formatBytes(floorSize)}。`,
          `请把目标体积调大，或先用处理链缩小尺寸。`
        ])
      }

      // lo 已知装得下、hi 已知装不下，二分收敛到「装得下的最大质量」
      let lo = MIN_SEARCH_QUALITY
      let hi = MAX_SEARCH_QUALITY
      while (hi - lo > 1) {
        const mid = Math.floor((lo + hi) / 2)
        if ((await trial(mid)) <= budget) lo = mid
        else hi = mid
      }
      quality = lo
    }

    // 交差那一遍用**正常**的 effort / 参数：搜索阶段降 effort 只是为了定位质量，
    // 正式产物必须按各格式的默认档出，否则等于为了体积偷偷降了一次画质。
    let chosen = quality
    for (let step = 0; ; step += 1) {
      onProgress({ kind: 'indeterminate', stage: '编码中…' })
      await make({ quality: chosen }).toFile(tempPath)
      const size = (await stat(tempPath)).size
      if (size <= targetBytes) return
      // effort 提上去之后同样的质量通常编得更大，所以这里还有一次**有界**的回退。
      if (!isAvif || step >= FINAL_DESCENT_STEPS || chosen <= MIN_SEARCH_QUALITY) {
        throw new ConversionFailed([
          `压到 ${formatBytes(targetBytes)} 做不到：最终产物是 ${formatBytes(size)}。`,
          `请把目标体积调大，或先用处理链缩小尺寸。`
        ])
      }
      chosen = Math.max(MIN_SEARCH_QUALITY, chosen - FINAL_DESCENT_STEP)
    }
  } finally {
    for (const probe of probes) await removeQuietly(probe)
  }
}

/**
 * 一条管线 + 它该报的那个阶段文案。没有体积目标时直接编，有的话走二分。
 *
 * ⚠️ **`make()` 之前那一下取消检查是承重的**（见 `runSharp` 里的 `report`）：
 * `sharp.toFile()` 一旦开始就没有中断接口（没有 `AbortSignal` 那一类的口子），
 * 所以「取消」这条路上唯一能省下 CPU 的地方就是**动手之前**。
 */
async function encode(
  make: PipelineFactory,
  toExt: string,
  tempPath: string,
  targetBytes: number | undefined,
  stage: string,
  onProgress: (progress: TaskProgress) => void
): Promise<void> {
  if (targetBytes === undefined) {
    // 这一句是**编码前的最后一次**取消检查：它排在 `make({})`（构建管线，含滤镜与编码器）
    // 与 `toFile()`（真正开编）之前，取消请求在这里就兑现，不必等它编完。
    onProgress({ kind: 'indeterminate', stage })
    await make({}).toFile(tempPath)
    return
  }
  await encodeToTargetBytes(make, toExt, tempPath, targetBytes, onProgress)
}

/**
 * 走 sharp 原生管线（libvips 直接读文件），适合绝大多数格式。
 */
function nativePipeline(
  input: string,
  toExt: string,
  keepAnimation: boolean,
  filters: readonly FilterAction[] | undefined
): PipelineFactory {
  return (tuning) => {
    let pipeline = sharp(input, {
      failOn: 'none',
      limitInputPixels: MAX_PIXELS,
      animated: keepAnimation
    })

    // 手机拍的竖屏照片靠 EXIF 的 orientation 标记方向，像素本身是横着的。
    // 不做自动旋转的话，转出来的照片会躺倒——这是图片转换器最经典的 bug。
    // 动图不能整体旋转，会破坏帧序列，所以跳过。
    //
    // ⚠️ 必须排在处理链**之前**：rotate() 会换掉宽高，之后 resize 的宽高才对应
    // 用户屏幕上看到的那个方向。
    if (!keepAnimation) pipeline = pipeline.rotate()

    pipeline = applyFilters(pipeline, filters)
    pipeline = encoderFor(toExt, tuning)(pipeline)

    // 保留 EXIF / ICC / XMP。丢了 ICC 的话，广色域照片转出来会明显发灰。
    // rotate() 会顺带清掉已经烘焙进像素的 orientation 标记，不会重复旋转。
    return pipeline.withMetadata()
  }
}

/**
 * HEVC 系的 HEIC/HEIF：sharp 拿不到像素，必须先经 libheif 解成 RGBA。
 *
 * 分流判据是元数据里的 `compression`——sharp 读 HEIC 的元数据是好的，
 * 只是取不到像素。只有 `hevc` 才需要 libheif；AV1 系的 HEIF 和被改名的
 * jpg/png 走原生管线更快，没必要绕 WASM 一圈。
 *
 * 像素由调用方先解好传进来：体积搜索要按质量反复重建管线，**解码只做一次**。
 */
function heicPipeline(
  pixels: HeifPixels,
  toExt: string,
  filters: readonly FilterAction[] | undefined
): PipelineFactory {
  return (tuning) => {
    // 注意这里不做 rotate()：libheif 已经按容器的 irot 变换把方向摆正了
    // （Apple 用 irot 记录旋转，方向信息根本不在 EXIF 里），再转一次会转反。
    // 原始像素也没有 EXIF/ICC 可保留，所以不调 withMetadata()。
    const base = sharp(pixels.data, {
      raw: { width: pixels.width, height: pixels.height, channels: 4 }
    })
    return encoderFor(toExt, tuning)(applyFilters(base, filters))
  }
}

/**
 * 用 sharp 转换图片。
 *
 * sharp 走 libvips 的原生流水线，速度比 ffmpeg 转图片快一个数量级，
 * 而且是流式的，不会把整张图解到 JS 堆里。
 *
 * ## 取消：只能拦在「动手之前」
 *
 * `sharp.toFile()` **没有外部中止的接口**（不像子进程能 `killTree`），一次编码开始之后
 * 就只能等它编完。所以这条路能许诺的只有两件事，两件都已经做到：
 *
 * 1. **编码开始之前**（含体积搜索的**每一轮**）看到取消就立刻抛出，一次编码都不做
 *    —— 这就是下面那个 `report` 包装器的作用。此前只有末尾那一处 `cancel.canceled`
 *    检查，于是「取消一张大图」的真实行为是：CPU 照跑满、占着 sharp 的并发槽位、
 *    编完之后把结果丢掉再报「已取消」。正确性无害（产物不会落成正式文件），
 *    但用户点了取消却看着风扇转了三秒，且并发上限被白白占住。
 * 2. **落盘之前**再确认一次（末尾那段），保证取消后不会把 `.part` 搬成正式文件。
 *
 * TODO（刻意记账，不在这条线里做）：真正的中止要换成 sharp 的流式 API——
 * `sharp(...).png()` 拿到 `Pipeline` 之后按块 `.read()` 出来、自己写文件，
 * 每块之间检查一次取消、并销毁 pipeline。成本在于要自己接管落盘（连同体积搜索那条
 * 反复重建管线的路一起改），以及丢掉 `withMetadata()` 在 `toFile()` 里做的收尾。
 * 收益只体现在「取消一张要编几秒的大图」上，暂时不值这个改动量。
 */
export async function runSharp(options: ConvertContext): Promise<void> {
  const { input, output, fromExt, toExt, cancel, onProgress } = options
  const tempPath = partPathOf(output)
  const filters = options.options?.filters
  const targetBytes = options.options?.output?.targetBytes

  /**
   * 带**前置**取消检查的进度回调。
   *
   * 编码路径上每一个进度点都排在一次 `toFile()` 之前（`encode` 报一次阶段、
   * 体积搜索的每一轮也各报一次），所以把它包在这里，等于给每一次编码都装上了
   * 「开编之前先看一眼取消」。抛在回调里是刻意的：调用链上全是 `await`，
   * 异常会一路冒到 runSharp 的 catch，而那里认得 `ConversionCanceled`。
   */
  const report = (progress: TaskProgress): void => {
    if (cancel.canceled) throw new ConversionCanceled()
    onProgress(progress)
  }

  report({ kind: 'indeterminate', stage: '读取图片…' })

  // 只有 sharp 读不了的源才建临时目录：常见格式不该为它多付一次 mkdtemp
  let tempDir: string | null = null

  try {
    if (SHARP_UNREADABLE_SRC.has(fromExt)) tempDir = await mkdtemp(join(tmpdir(), 'msg-img-'))
    const source = tempDir
      ? ((await normalizeToPng(input, fromExt, tempDir, cancel)) ?? input)
      : input

    // failOn: 'none' 让略微截断的 JPEG 仍能转出来。
    // 完全无法识别的文件 sharp 依然会报错，不会静默产出垃圾。
    const meta = await sharp(source, { failOn: 'none', limitInputPixels: MAX_PIXELS }).metadata()

    if (!meta.format) {
      throw new ConversionFailed([`无法识别的图片格式：${input}`])
    }

    // 「这个目标 + 这张图」根本做不了体积目标时，**在开跑之前就拒**。
    // 让它跑到最后一轮才说「做不到」，用户已经白等了半天，而原因与他的参数无关
    // （PNG 没有质量旋钮、动图要按帧重编）。
    if (targetBytes !== undefined) {
      const refusal = targetSizeRefusal(toExt, meta.pages ?? 1)
      if (refusal !== null) throw new ConversionFailed([refusal])
    }

    if (meta.compression === 'hevc') {
      report({ kind: 'indeterminate', stage: '解 HEIC…' })
      const expected =
        meta.width && meta.height ? { width: meta.width, height: meta.height } : undefined
      const pixels = await decodeHeif(source, expected)
      await encode(
        heicPipeline(pixels, toExt, filters),
        toExt,
        tempPath,
        targetBytes,
        '编码中…',
        report
      )
    } else {
      const keepAnimation = (meta.pages ?? 1) > 1 && ANIMATED_TARGETS.has(toExt)
      await encode(
        nativePipeline(source, toExt, keepAnimation, filters),
        toExt,
        tempPath,
        targetBytes,
        keepAnimation ? '编码动图…' : '编码中…',
        report
      )
    }
  } catch (error) {
    await removeQuietly(tempPath)
    if (error instanceof ConversionFailed || error instanceof ConversionCanceled) throw error
    const message = error instanceof Error ? error.message : String(error)
    throw new ConversionFailed(tailLines(message))
  } finally {
    if (tempDir) await rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
  }

  // sharp 的原生流水线没有中断接口，一次编码无法从中间打断。
  // 图片转换通常在几百毫秒内结束，所以只在落盘前确认一次取消状态，
  // 保证取消后不会把半成品搬成正式文件。
  if (cancel.canceled) {
    await removeQuietly(tempPath)
    throw new ConversionCanceled()
  }

  await finalizeOutput(tempPath, output)
  onProgress({ kind: 'determinate', percent: 1 })
}
