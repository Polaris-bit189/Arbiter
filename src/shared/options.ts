import type {
  Category,
  DenoiseStrength,
  FilterAction,
  OutputOptions,
  ResizeAction,
  TaskOptions
} from './types'
import { formatBytes } from './format'
import { canTrim, describeTrim } from './trim'

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
  return canTrim(category) || canOutputSize(category) || canFilter(category)
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
  return parts.length > 0 ? parts.join(' · ') : null
}

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
