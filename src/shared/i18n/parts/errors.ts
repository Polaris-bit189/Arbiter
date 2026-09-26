/**
 * **自家 error 的码表** —— `ConversionFailed` 可以在 `throw` 时带一个 `ref`，
 * 渲染层据此在切语言时把那行失败原因重新翻一遍（P7）。
 *
 * ## 与 `stage.ts` 那一片的分工
 *
 * 那边是**进度**（跑着的任务），这边是**失败原因**（跑完的、乃至几天前的历史条目）。
 * 两者都是 B 类（跨时间传递 + 会被重新渲染），所以都要码；差别只在于**码从哪来**：
 * `progress.stage` 是**从码生成文本**，而失败原因**反过来**——`logTail` 里那行中文早在
 * `throw` 时就写定了，`ref` 只是它对应的码。
 *
 * ## ⚠️ 一条硬约束：这里的 zh 值必须与那行 `logTail` **逐字节相同**
 *
 * 因为卡片上显示的**就是** `logTail` 里那一行（`task.ts` 的 `summarize()` 取倒数第一条
 * 有信息量的行）。两者一旦不一致，用户会看到「卡片上一句话、展开日志里另一句话」——
 * 而两句都言之成理，极难归因。
 *
 * 判据在 `test-i18n.ts` 的 `[P7]` 一节：它拿这一片里的每个键，与 `src/main` 里
 * **那个键被引用处**的 `logTail` 文本比对。所以**加一条就必须在那边补一次取证**。
 *
 * ## 覆盖范围：**进度式**，不是一次做完
 *
 * `src/main/**` 里一共有 78 个 `new ConversionFailed` 站点。这一片先收**高频的那批**
 * （引擎未就绪 / 体积目标做不到 / 认不出的格式 / 源损坏）。没加 `ref` 的那些站点行为
 * **一个字都不变**——它们走 `summarize(logTail)` 那条老路，只是切语言时不会变。
 * 补一个站点的成本是「加一条 + 改一行 throw + 在 `[P7]` 补一次取证」。
 */
export const errorsZh = {
  /* —— 引擎未就绪（`core/task.ts` 的 `unavailableEngineReason`，最常走的一条）—— */
  'err.engine.notReady': '需要 {engine} 引擎，当前未就绪，按设置已跳过',

  /* —— 图片 —— */
  'err.image.filterNotApplicable':
    '这一步只对视频 / 音频有意义。这是一条内部错误：契约层的判据本该拦住它',
  'err.image.tooSmall': '请把目标体积调大，或先用处理链缩小尺寸。',
  'err.image.unreadable': '无法识别的图片格式：{input}'
} as const

/**
 * ⚠️ 英文那侧是**给人读的失败原因**，不是说明书——要短、要说清「下一步做什么」。
 * 占位符的名字与个数必须与中文那边完全一致（闸门 c 逐键比对）。
 */
export const errorsEn: Record<keyof typeof errorsZh, string> = {
  'err.engine.notReady': 'The {engine} engine is needed but not ready — skipped per your settings',

  'err.image.filterNotApplicable':
    'This step only applies to video / audio. This is an internal error: the contract layer should have blocked it',
  'err.image.tooSmall': 'Raise the target size, or shrink the image with the filter chain first.',
  'err.image.unreadable': 'Unrecognized image format: {input}'
}
