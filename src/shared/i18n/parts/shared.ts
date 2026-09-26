/**
 * `src/shared/` 里那些**产出一句话**的纯函数：参数摘要、裁剪摘要、动作名。
 *
 * ## 这一块的特点是「主进程一个都不消费」
 *
 * 已核实：`core/task.ts` 只 import `canTrim` / `canFilter` / `canUseAction` 这些**判据**，
 * 而 `describe*` 的消费方全在渲染层（队列卡片、历史页、参数面板的摘要行）。
 * 所以它们的语言跟着 `@shared/i18n` 那份全局走就够了，不必额外注入语言——
 * 注入反而会让「同一句话在两个进程里是两串字」变成一个可能。
 *
 * ## ⚠️ 分隔符是承重的，不许顺手规范化
 *
 * `describeTrim` 里是 `' · '`、`describeFilters` 里是 `' → '`。后者尤其：
 * 那一串讲的是**先后顺序**（去隔行 → 降噪 → 锐化），换成 `' · '` 就把语义抹平了。
 *
 * ## ⚠️ 中文值必须与迁移前逐字节相同
 *
 * `test-core.ts` 里有十来条**整句钉死**的断言（`'裁 3.0s–8.0s · 无损（起点对齐关键帧）'`、
 * `'去隔行（yadif） → 降噪（中） → 锐化 1'`……）。它们一条都不改，靠的就是这一条。
 */

export const sharedZh = {
  /* ---- 输出约束（体积 / 码率）---- */
  'shared.output.targetBytes': '目标体积 {size}',
  'shared.output.bitrate': '码率 {rate}kbps',
  'shared.output.unspecified': '输出限制（未指定）',

  /* ---- 缩放 ---- */
  'shared.resize.to': '缩到 {w}×{h}',
  'shared.resize.width': '缩到宽 {w}',
  'shared.resize.height': '缩到高 {h}',
  'shared.resize.cover': '裁切填满',
  'shared.resize.fill': '拉伸',
  'shared.resize.noEnlarge': '不放大',
  'shared.resize.unspecified': '缩放（未指定尺寸）',

  /* ---- 降噪三档（嵌在「降噪（{label}）」里）---- */
  'shared.denoise.light': '轻',
  'shared.denoise.medium': '中',
  'shared.denoise.strong': '重',

  /* ---- 处理链上的一个动作 ---- */
  'shared.action.deinterlace': '去隔行（{method}）',
  'shared.action.denoise': '降噪（{label}）',
  'shared.action.sharpen': '锐化 {amount}',
  'shared.action.loudnorm': '响度 {lufs} LUFS',
  'shared.action.rotate': '旋转 {degrees}°',

  /* ---- 编码质量档 ---- */
  'shared.quality.crf': 'CRF {crf}',
  'shared.quality.preset': '预设 {preset}',
  'shared.quality.tune': '调优 {tune}',
  'shared.quality.unspecified': '编码档（未指定）',

  /* ---- 裁剪 ---- */
  'shared.trim.cut': '裁 {start}–{end} · {mode}',

  /* ---- 裁剪模式名（只在这两句里用，单独一个子前缀是为了 KeysOf 能切准）---- */
  'shared.trimMode.lossless': '无损（起点对齐关键帧）',
  'shared.trimMode.exact': '精确'
} as const

export const sharedEn: Record<keyof typeof sharedZh, string> = {
  'shared.output.targetBytes': 'Target size {size}',
  'shared.output.bitrate': 'Bitrate {rate} kbps',
  'shared.output.unspecified': 'Output limit (not set)',

  'shared.resize.to': 'Resize to {w}×{h}',
  'shared.resize.width': 'Resize to width {w}',
  'shared.resize.height': 'Resize to height {h}',
  'shared.resize.cover': 'Crop to fill',
  'shared.resize.fill': 'Stretch',
  'shared.resize.noEnlarge': 'No upscaling',
  'shared.resize.unspecified': 'Resize (no size given)',

  'shared.denoise.light': 'light',
  'shared.denoise.medium': 'medium',
  'shared.denoise.strong': 'strong',

  'shared.action.deinterlace': 'Deinterlace ({method})',
  'shared.action.denoise': 'Denoise ({label})',
  'shared.action.sharpen': 'Sharpen {amount}',
  // LUFS 是单位，不翻——与 `kbps` / `MB` 同一条规矩。
  'shared.action.loudnorm': 'Loudness {lufs} LUFS',
  'shared.action.rotate': 'Rotate {degrees}°',

  'shared.quality.crf': 'CRF {crf}',
  'shared.quality.preset': 'Preset {preset}',
  'shared.quality.tune': 'Tune {tune}',
  'shared.quality.unspecified': 'Quality (not set)',

  'shared.trim.cut': 'Cut {start}–{end} · {mode}',
  'shared.trimMode.lossless': 'Lossless (start snaps to a keyframe)',
  'shared.trimMode.exact': 'Exact'
}
