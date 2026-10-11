/**
 * 纯函数与常量表：`lib/format.ts` 的剩余时间、`lib/labels.ts` 的类别名。
 *
 * 这一块的特点是**它们的产出会被别处当字符串用**（队列行副标题「MP4 · 视频」、
 * 目标格式下拉的分组标签），所以搬进字典之后，取词的那一处要写 `t(...)` ——
 * 而不是把 `CATEGORY_LABEL` 直接当字符串用。
 */

export const libsZh = {
  'category.video': '视频',
  'category.audio': '音频',
  'category.image': '图片',
  'category.document': '文档',
  'category.ebook': '电子书',
  'category.archive': '压缩包',

  'eta.almost': '即将完成',
  'eta.seconds': '剩余 {n} 秒',
  'eta.minutes': '剩余 {m} 分',
  'eta.minutesSeconds': '剩余 {m} 分 {s} 秒',
  'eta.hours': '剩余 {h} 小时',
  'eta.hoursMinutes': '剩余 {h} 小时 {m} 分'
} as const

export const libsEn: Record<keyof typeof libsZh, string> = {
  'category.video': 'Video',
  'category.audio': 'Audio',
  'category.image': 'Image',
  'category.document': 'Document',
  'category.ebook': 'Ebook',
  'category.archive': 'Archive',

  // 英文的「秒 / 分 / 小时」单复数同形，所以一个 key 够——不必为它引复数引擎。
  // 中文那一侧同理（汉语没有复数变化）。真正需要分单复数的只有 folderScan 那几处
  // 「N 个文件」，那几处用两个 key（`.one` / `.other`）。
  'eta.almost': 'Almost done',
  'eta.seconds': '{n}s left',
  'eta.minutes': '{m}m left',
  'eta.minutesSeconds': '{m}m {s}s left',
  'eta.hours': '{h}h left',
  'eta.hoursMinutes': '{h}h {m}m left'
}
