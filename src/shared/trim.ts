import type { Category, TrimOptions } from './types'

/**
 * 裁剪参数的**判据与文案**，main 与 renderer 共用一份。
 *
 * 零依赖（只 `import type`），与 `channels.ts` 同一个理由：preload 跑在 sandbox 里，
 * 任何被 require 进来的 npm 包都会让整个 preload 崩掉，所以这类共用件不许拉依赖。
 *
 * 为什么不把这些塞进 `types.ts`：那个文件的职责是「类型的单一来源」，
 * 而这里是**给人看的判据与文案**（中文用户可见）。两者混在一起之后，
 * 改文案会让人以为动了类型。
 */

/**
 * 裁剪时间的上界（秒）：24 小时。
 *
 * 给上界**不是为了防溢出**（`end - start` 用不着这个），而是为了让界面的输入框
 * 与主进程的 schema 有同一个数：两边各写一个上限，表现是「界面放行了一个主进程
 * 会拒掉的值」，用户点了「应用」什么都不发生，而界面上一个字都不提示。
 */
export const MAX_TRIM_SEC = 86_400

/**
 * 这一类任务能不能裁剪。
 *
 * **只有视频与音频有时间轴。** 图片是一帧、文档/电子书/压缩包根本没有"时长"这个概念——
 * 给它们显示一个裁剪面板，用户填完点「应用」只会得到一个报错或者一个静默无效果。
 *
 * 这是**判据**不是**展示偏好**，所以 main 侧的 `TaskManager.setOptions` 也读它：
 * 只在界面上藏起来的话，任何别的入口（将来的 MCP、右键菜单参数）都能绕过。
 */
export function canTrim(category: Category): boolean {
  return category === 'video' || category === 'audio'
}

/**
 * `3` → `3.0s`、`1.55` → `1.55s`。与裁剪面板上的输入框同一个口径（都是秒）。
 *
 * 不是随手取的一位小数：面板允许用户填 `1.55`，而卡片上写 `1.5s` 的话，
 * 那一行摘要与实际跑的参数就不是同一个数了——用户没法从界面上核对这次裁剪裁在哪。
 * 整数保留一位（`3.0s`）只是可读性；多留的那两位小数是**准确性**。
 */
function seconds(value: number): string {
  const trimmed = Number(value.toFixed(2))
  return `${Number.isInteger(trimmed) ? trimmed.toFixed(1) : trimmed}s`
}

/** 模式的中文名。**无损那句括注是承重的**：见 `describeTrim` 的注释 */
const MODE_LABEL = {
  lossless: '无损（起点对齐关键帧）',
  exact: '精确'
} as const

/**
 * 一行参数摘要，例如 `裁 3.0s–8.0s · 无损（起点对齐关键帧）`。
 *
 * 括号里那句**不是装饰**。无损裁剪的起点一定落在前一个关键帧上（`-ss` 放在 `-i` 之前
 * 的行为就是如此，见 `engines/ffmpeg.ts`），也就是说用户要 `3.0s–8.0s` 拿到的
 * 可能是 `2.0s–8.0s`。这是功能行为的一部分，必须跟着任务一起显示，
 * 不能只在设置它的那一刻提示一次——那张卡片会一直挂在队列里，而摘要就是它的全部记忆。
 */
export function describeTrim(trim: TrimOptions): string {
  return `裁 ${seconds(trim.start)}–${seconds(trim.end)} · ${MODE_LABEL[trim.mode]}`
}

/**
 * 整行摘要 `describeOptions` 已挪到 `shared/options.ts`。
 *
 * 挪走的理由不是「放错地方了」，而是**它长大了**：裁剪只是参数的一种，现在还有输出体积
 * 与图片缩放，而那三块必须拼成**同一句话**（队列卡片与历史页共用）。留在这里的话，
 * 它会反过来 import `options.ts`，与「options.ts 用 describeTrim」构成一个环。
 * 裁剪自己的 `describeTrim` / `canTrim` 留在这里，它们讲的是裁剪这一件事。
 */
