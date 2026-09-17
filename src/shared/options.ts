import type {
  Category,
  DenoiseStrength,
  FilterAction,
  OutputOptions,
  QualityOptions,
  ResizeAction,
  TaskOptions
} from './types'
import { formatBytes } from './format'
import { canTrim, describeTrim } from './trim'
import { categoryOf } from './formats'

/**
 * 任务参数的**判据、限额与文案**，main 与 renderer 共用一份。
 *
 * 与 `shared/trim.ts` 是同一类东西（零依赖、只 `import type` 加同层的两个纯函数），
 * 分成两个文件是因为那个文件讲的是「裁剪」这一件事：它的注释从头到尾都在解释
 * `[start, end)` 与关键帧。裁剪自己的判据与文案**留在 `trim.ts`**，
 * 这里只负责把它们拼进总摘要。
 *
 * ## 为什么限额住在这里而不是 schema 里
 *
 * 界面的输入框与主进程的 zod schema 必须用**同一个数**。两边各写一个上限的表现是
 * 「界面放行了一个主进程会拒掉的值」——用户点了「应用」什么都不发生，而界面上一个字都不提示。
 * 这一条在 `MAX_TRIM_SEC` 那里已经踩过，这里照同一个形状办。
 *
 * ## 摘要那一行是承重的
 *
 * `describeOptions` 的结果同时出现在队列卡片与历史页上，两处**必须是同一句话**。
 * 它回答的是「这条任务到底按什么参数跑的」：两条 `clip.mp4 → mp4` 在列表里长得一模一样，
 * 而一条是整段、另一条只裁了 5 秒。摘要就是那条任务的全部记忆。
 */

/* ------------------------------------------------------------------ 限额 */

/**
 * 目标体积的上下界（字节）。
 *
 * 下界 64 KiB 不是防溢出，是防「一个不可能是转换结果的数」：比这更小的目标必然要把
 * 视频压成一片马赛克，而它照样会「转换成功」。上界 64 GiB 比任何家用素材都大，
 * 留着是为了挡住 `2 ** 53` 那种明显是算错了的值。
 */
export const MIN_TARGET_BYTES = 64 * 1024
export const MAX_TARGET_BYTES = 64 * 1024 ** 3

/** 目标码率的上下界（kbps）。8 kbps 是「再低就没法听了」，200000 kbps 高于未压缩的 4K。 */
export const MIN_BITRATE_KBPS = 8
export const MAX_BITRATE_KBPS = 200_000

/** 目标尺寸的上下界（像素）。上界取 PNG/JPEG 的格式极限，下界 1px 是「至少还是个图」。 */
export const MIN_IMAGE_DIM = 1
export const MAX_IMAGE_DIM = 65_535

/**
 * 处理链的长度上限。
 *
 * 上界的作用不是防溢出，是**挡住一个必然是算错了的链**：真有人交一条 200 步的链，
 * 与其让引擎跑上几小时再失败，不如在 IPC 那一道就说清楚。16 步远大于任何合理配方
 * （去隔行 + 降噪 + 锐化 + 缩放 + 旋转 + 裁剪也才 6 步）。
 */
export const MAX_FILTER_ACTIONS = 16

/**
 * CRF 的上下界。
 *
 * **0~51 是 libx264 自己的定义域**，照抄过来而不是自己另划一条线：界面上放行一个
 * ffmpeg 会顶回来的值，表现是「点了应用什么都没发生」；而卡得比 51 还紧，
 * 表现是「我想无损却选不了 0」。两端都不是我们该替用户决定的。
 *
 * ⚠️ 这几个数字**只对 x264 成立**（libvpx-vp9 的 CRF 是 0~63），而这一项本来就
 * 只对 `supportsQuality()` 放行的出口开放，所以不必按出口分叉。
 */
export const MIN_CRF = 0
export const MAX_CRF = 51

/** 省略 CRF 时用的值。与加这个参数之前写死在 `videoArgs` 里的那个数**是同一个**。 */
export const DEFAULT_CRF = 23

/** 省略预设时用的档。同上，是加这个参数之前写死的那个。 */
export const DEFAULT_PRESET = 'veryfast'

/* ------------------------------------------------------------------ 判据 */

/**
 * 这一类能不能设输出约束（体积 / 码率）。
 *
 * **视频、音频、图片都能**——图片的「压到 200 KB」与视频的「压到 10 MB」是同一件事，
 * 契约上是同一个字段（见 `OutputOptions` 的注释），只是实现不同。
 * 文档、电子书、压缩包没有「码率」也没有「质量旋钮」，这一项对它们没有意义。
 *
 * 与 `canTrim` 一样，这是**判据**不是**展示偏好**：`TaskManager.setOptions` 读的是
 * 同一个函数。只在界面上藏起来的话，别的入口（MCP、右键菜单参数）绕得过去，
 * 而绕过去的表现是「参数设上了、引擎按另一条分支跑，参数静默失效」。
 */
export function canOutputSize(category: Category): boolean {
  return category === 'video' || category === 'audio' || category === 'image'
}

/**
 * 这一类能不能设编码质量档。
 *
 * **只有视频**。音频那几档（`-q:a 2`、`-b:a`）名义上也是「质量」，但它们已经是
 * 写死的合理值，而重新暴露一遍等于给同一样东西开第二个入口；图片的质量在
 * `TaskOptions.output` 那条路上（二分搜索），不是恒定质量。
 *
 * 与 `canOutputSize` 一样，这是**判据**不是展示偏好——界面藏起来只挡住拖拽与点击，
 * MCP / 右键菜单参数那些入口绕得过去，而绕过去的表现是「参数设上了、引擎按另一条
 * 分支跑，参数静默失效」。
 */
export function canUseQuality(category: Category): boolean {
  return category === 'video'
}

/**
 * 视频出口里**不认**编码三件套的那些。
 *
 * - `webm` 走 `libvpx-vp9`：它的质量旋钮是 `-crf`（0~63，与 x264 **不是一个定义域**），
 *   速度旋钮是 `-deadline` / `-cpu-used`，而且**没有** `-tune film/animation/grain`
 *   那一套。把 x264 的参数照搬过去，轻则被 ffmpeg 当未知选项拒掉，
 *   重则（`-preset`）被 libvpx 静默忽略、用户以为设了 slow 其实还是默认速度。
 * - `gif` 走调色板滤镜（`palettegen`/`paletteuse`），根本没有码率或质量旋钮。
 *
 * 写成**排除表**而不是包含表：包含表得把 `mp4 / mkv / mov / avi / m4v` 一个个列出来，
 * 而能力矩阵里将来加一个视频目标（比如把 `wmv` 也接成出口）时，那张表不会自动跟上，
 * 后果是「新出口明明走 x264，界面上却选不了质量档」——一种没人会想到去查的缺失。
 */
const NON_X264_VIDEO_TARGETS = new Set(['webm', 'gif'])

/**
 * 这个**出口格式**认不认编码三件套。
 *
 * 判据是「它是不是一个走 libx264 的视频出口」，所以先从能力矩阵问「这是不是视频格式」
 * （`categoryOf`），再排掉 webm / gif 那两个特例——**不另写一张扩展名白名单**，
 * 另一张表必然与 `formats.ts` 漂移，而漂移的表现是「界面上说能设，设上去引擎报错」。
 *
 * `categoryOf` 而不是 `canUseQuality`：后者收的是源的类别，这里问的是**出口**。
 * 两者不是一回事——`mp4 → gif` 的源类别是 video，而 gif 这个出口不认质量档。
 * 目标格式在参数设完之后还能改（`setTarget`），所以这一条**在转换开始前还要再判一次**
 * （见 `converters/ffmpegRun.ts`），否则「先设质量档、再把目标改成 webm」会静默失效。
 */
export function supportsQuality(toExt: string): boolean {
  const to = toExt.toLowerCase()
  if (categoryOf(to) !== 'video') return false
  return !NON_X264_VIDEO_TARGETS.has(to)
}

/**
 * 这一类能不能带处理链。
 *
 * 视频、音频、图片都能——但**每一项动作还有自己的适用范围**，见 `canUseAction`。
 * 这一层只管「这个类别有没有链接这回事」，别拿它当每一项的判据。
 *
 * ⚠️ `filters` 一旦对视频开放，**有滤镜就必须让 remux 失效**——`-c copy` 搬的是原码流，
 * 而滤镜改了像素就装不进去。那条否定在 `converters/ffmpegRun.ts` 的 remux 决策点上，
 * 与「带裁剪时跳过 remux」是同一个位置。
 */
export function canFilter(category: Category): boolean {
  return category === 'image' || category === 'video' || category === 'audio'
}

/**
 * 某个动作能不能用在这个类别上。
 *
 * 与 `canFilter` 分开是因为两者的粒度不同：`canFilter` 回答「要不要给这一类显示处理链」，
 * 这里回答「这一步放不放得下」。界面按它过滤「添加」菜单，**主进程的 `setOptions`
 * 读的也是同一个函数**——只在界面上藏起来的话，MCP 与右键菜单那些入口绕得过去，
 * 而绕过去的表现是「参数设上了、引擎按另一条分支跑，这一步静默失效」。
 */
export function canUseAction(action: FilterAction, category: Category): boolean {
  switch (action.kind) {
    // 图片走 sharp 的 resize；视频走 ffmpeg 的 `scale`（同一个语义，两条实现）
    case 'resize':
      return category === 'image' || category === 'video'
    // 这三个是**视频独有**的概念：隔行、时域噪点、空间细节，音频与静图都没有对应物
    case 'deinterlace':
    case 'denoise':
    case 'sharpen':
      return category === 'video'
    // 图片的旋转走 sharp 的 `rotate()`；视频的走 ffmpeg 的 `transpose`
    case 'rotate':
      return category === 'image' || category === 'video'
    // 响度是**音频流**的属性。视频文件里的音轨照样能归一化，所以 video 也放行
    case 'loudnorm':
      return category === 'audio' || category === 'video'
  }
}

/**
 * 这一类有没有**任何**参数可设。卡片上那个「参数」按钮的判据。
 *
 * 写成「或」的汇总而不是各面板自己判断，是为了让按钮的出现与消失只有一处真相：
 * 将来再加一块参数面板时，忘了改这里、参数就永远点不出来——
 * 而忘了改各面板的话，按钮会照着老清单出现，点开却是空的。
 */
export function hasAnyOptions(category: Category): boolean {
  // `canUseQuality` 今天被 `canOutputSize` 完全覆盖（两者都只在 video 上为真），
  // 列在这里是**结构上**的要求：将来哪个类别只开放质量档而关了输出约束时，
  // 漏了它就等于那个类别的「参数」按钮永远不出现，而参数面板明明有内容。
  return (
    canTrim(category) || canOutputSize(category) || canFilter(category) || canUseQuality(category)
  )
}

/* ------------------------------------------------------------------ 文案 */

/** 码率的单位是 kbps，显示成 `8000kbps`——与 ffmpeg 命令行里的写法一致，便于用户核对。 */
export function describeOutput(output: OutputOptions): string {
  if (output.targetBytes !== undefined) return `目标体积 ${formatBytes(output.targetBytes)}`
  if (output.bitrateKbps !== undefined) return `码率 ${output.bitrateKbps}kbps`
  // schema 不允许走到这里（体积与码率必须二选一）。但这一行是**给人看的**，
  // 宁可说一句「没指定」也不抛——抛会让整张卡片渲染不出来，比少一句话严重得多。
  return '输出限制（未指定）'
}

/**
 * 编码质量档的文案。
 *
 * **三段各说各的，不合并成一句**：`CRF 18 · 预设 slow · 调优 film` 里每一项都能
 * 单独看懂——而这一行同时出现在队列卡与历史页上，读到它的人手上没有别的线索。
 * 写成「编码档 18/slow/film」的话，历史页上那一行是**唯一**的记忆，
 * 三个数字挤在一起谁也认不出来。
 *
 * 顺序固定 crf → preset → tune，与 `TaskOptions` 里的声明顺序一致。
 * 三者可以只给一个，所以每一段都是可选的；一个都没给不可能走到这里
 * （schema 与 `setOptions` 都拒空对象），但这一行是**给人看的**，
 * 宁可说一句「未指定」也不抛——抛会让整张卡片渲染不出来。
 */
export function describeQuality(quality: QualityOptions): string {
  const parts: string[] = []
  if (quality.crf !== undefined) parts.push(`CRF ${quality.crf}`)
  if (quality.preset !== undefined) parts.push(`预设 ${quality.preset}`)
  if (quality.tune !== undefined) parts.push(`调优 ${quality.tune}`)
  return parts.length > 0 ? parts.join(' · ') : '编码档（未指定）'
}

function describeResize(action: ResizeAction): string {
  const parts: string[] = []
  if (action.width !== undefined && action.height !== undefined) {
    parts.push(`缩到 ${action.width}×${action.height}`)
  } else if (action.width !== undefined) {
    parts.push(`缩到宽 ${action.width}`)
  } else if (action.height !== undefined) {
    parts.push(`缩到高 ${action.height}`)
  }

  // 下面两句只在**确实要缩图**的时候才说。分两句是因为它们的适用面不同：
  //
  // - `fit` 的另外两档（裁切填满 / 拉伸）只在把图放进一个**框**里时才有含义。
  //   只给了一个维度的时候 sharp 把它们当 `inside`，写在摘要上只会让人困惑
  //   （用户没填高度，摘要却说「拉伸」）。
  // - 「不放大」与维度个数无关：用户说「缩到宽 1920」，而源图只有 800px 时，
  //   这条设置**确实**在起作用——图会保持 800。不说的话，用户看到摘要写着
  //   「缩到宽 1920」却拿到一张 800px 的图，会以为参数没生效。
  if (parts.length > 0) {
    if (action.width !== undefined && action.height !== undefined) {
      if (action.fit === 'cover') parts.push('裁切填满')
      if (action.fit === 'fill') parts.push('拉伸')
    }
    if (action.withoutEnlargement) parts.push('不放大')
  }

  // 理论上到不了（schema 要求宽高至少给一个），但这一行是给人看的，宁可说出实情。
  return parts.length > 0 ? parts.join(' · ') : '缩放（未指定尺寸）'
}

/** 三档降噪的中文名。**与 `DENOISE_STRENGTHS` 一一对应**，漏一档就是编译错误。 */
const DENOISE_LABEL: Record<DenoiseStrength, string> = {
  light: '轻',
  medium: '中',
  strong: '重'
}

/**
 * 单个动作的文案。加新动作时在这里补一个分支——
 * **`default` 里的 `never` 兜底会让「忘了补」变成编译错误**，而不是让摘要上
 * 少一句话（摘要那一行同时出现在队列卡与历史页上，少一句没有任何地方会报错）。
 */
export function describeAction(action: FilterAction): string {
  switch (action.kind) {
    case 'resize':
      return describeResize(action)
    case 'deinterlace':
      return `去隔行（${action.method}）`
    case 'denoise':
      return `降噪（${DENOISE_LABEL[action.strength]}）`
    case 'sharpen':
      return `锐化 ${action.amount}`
    case 'loudnorm':
      return `响度 ${action.targetLufs} LUFS`
    case 'rotate':
      return `旋转 ${action.degrees}°`
    default: {
      // 加了一个联合成员却忘了在上面补分支时，**这一行会编译不过**
      const exhaustive: never = action
      return exhaustive
    }
  }
}

/**
 * 处理链的文案，**按数组顺序**拼。
 *
 * 顺序是有意义的，所以这里不能排序、不能去重——照着链念一遍就是它要表达的全部。
 * 两个动作之间用 ` → ` 分隔（而不是 ` · `），因为这一串讲的是**先后**。
 */
export function describeFilters(filters: readonly FilterAction[]): string {
  return filters.map(describeAction).join(' → ')
}

/**
 * 任务参数的整行摘要，例如：
 *
 *   `裁 3.0s–8.0s · 无损（起点对齐关键帧） · 缩到 1920×1080 · 目标体积 9.5 MB`
 *
 * 没有参数时返回 `null`（而不是空串）：调用方要判的是「这一行要不要渲染」，
 * 空串会渲染出一行 0 高度的空白，而 `null` 让这个判断是个纯类型判断。
 *
 * **顺序固定：裁剪 → 处理链 → 输出约束**，与 `TaskOptions` 里字段的声明顺序一致。
 * 稳定比「按填写顺序」重要：同一组参数在队列卡与历史页上必须逐字相同。
 */
export function describeOptions(options?: TaskOptions): string | null {
  if (!options) return null

  const parts: string[] = []
  if (options.trim) parts.push(describeTrim(options.trim))
  if (options.filters && options.filters.length > 0) parts.push(describeFilters(options.filters))
  if (options.output) parts.push(describeOutput(options.output))
  if (options.quality) parts.push(describeQuality(options.quality))
  return parts.length > 0 ? parts.join(' · ') : null
}

/**
 * 「编码质量档与输出约束互斥」那句**统一文案**。
 *
 * 两处要用它，而且必须是同一句话：界面上那块面板的**禁用理由**，以及引擎真的收到
 * 一份同时带了两者的参数时抛出的错误。分家的话，同一次矛盾在两处会有两种说法，
 * 而用户读到的多半是其中一处——另一处看起来就像在说别的事。
 *
 * 为什么互斥得这么绝对（而不是「让 CRF 当上限、码率当目标」）：`-crf` 与 `-b:v`
 * 同时出现时 x264 会**回到质量模式**、把 `-b:v` 只当上限，产物体积与目标彻底脱钩
 * （`engines/ffmpeg.ts` 的 `EncodeTarget` 注释里记着这条）。那不是折中，是静默失效。
 */
export const QUALITY_OUTPUT_EXCLUSIVE =
  '编码质量档与输出体积/码率目标互斥：前者按质量编、后者按码率编，同时给会让 -crf 与 -b:v 打架'

/* ------------------------------------------------------------------ 组装 */

/**
 * 把 `options` 里的某几项换成新值，**其余原样保留**；新值是 `undefined` 的键会被删掉。
 * 结果里一个字段都不剩时返回 `undefined`（而不是 `{}`）——「没有参数」只有一种表示，
 * 见 `TaskOptions` 的注释。
 *
 * ## 为什么必须有这个函数
 *
 * `TaskManager.setOptions` 是**整体替换**语义（它拿到的 `TaskOptions` 是什么，
 * `task.options` 就是什么）。而界面上是**一块一块**的参数面板——用户设完「目标体积」
 * 再设「裁剪」时，第二块面板若只交自己那一个字段，第一块就被静默抹掉了，
 * 卡片上那行摘要会少一半，而用户以为是界面没刷新。
 *
 * 所以每一块面板在「应用」时都必须走这里，交出**完整的** `TaskOptions`。
 * 把它放在 shared 里而不是各面板自己写：三条 `{ ...task.options, trim: next }` 里
 * 只要有一处漏了展开，症状就只在「同时用了两块参数」时才出现，极难归因。
 *
 * **返回新建的对象，不改动传进来的那一份**——面板拿到的是 store 里的 `task.options`。
 */
export function withOption(
  options: TaskOptions | undefined,
  patch: Partial<TaskOptions>
): TaskOptions | undefined {
  const next: TaskOptions = { ...options }
  for (const key of Object.keys(patch) as (keyof TaskOptions)[]) {
    const value = patch[key]
    if (value === undefined) delete next[key]
    else (next as Record<string, unknown>)[key] = value
  }
  return Object.keys(next).length > 0 ? next : undefined
}
