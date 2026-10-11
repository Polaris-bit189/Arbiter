/**
 * 处理链面板（FiltersSection）的文案。
 *
 * ⚠️ 中文值必须与迁移前源码里的字面量**逐字节相同**——闸门 d 会拿冻结快照逐值比对。
 * 迁移的时候是「把字面量搬进来、原样不动」，不是「顺手把哪句读着别扭的话改通顺」。
 *
 * ## 两条搬进字典时才显形的口径
 *
 * 1. **JSX 文本节点的换行会被 React 折成一个空格**，所以那几段长说明搬进来时写的是
 *    「渲染之后用户看到的那一串」（`…； 加了它…` 中间那个空格是承重的，去掉之后
 *    渲染出来就和迁移前不是一个字了）。
 * 2. **反引号是原文的一部分**（`` `idet` `` / `` `-c copy` ``）。它们看起来像 Markdown，
 *    其实是「这里是个 ffmpeg 的开关名」的标记，界面上本来就照原样渲染——所以照抄，
 *    不改成别的记号，也不删。
 *
 * ## 键名
 *
 * 动作短名 / 缩放档位 / 降噪档位三张表是**窄联合键**（`KeysOf<'filters.kind.'>` 那三个），
 * 不是整张 `MsgKey`：后者会让 `t(KIND_LABEL[kind])` 被推成「必须传参数」而编译不过——
 * 那是个假错误，真正会被传进去的那几个键一个参数都不需要（见 `types.ts` 的 `KeysOf`）。
 */

export const filtersZh = {
  /* ---- 六个动作的短名（菜单项与「第 N 步「…」」里都用它）---- */
  'filters.kind.resize': '缩放',
  'filters.kind.deinterlace': '去隔行',
  'filters.kind.denoise': '降噪',
  'filters.kind.sharpen': '锐化',
  'filters.kind.rotate': '旋转',
  'filters.kind.loudnorm': '响度归一化',

  /* ---- 缩放的三种贴合方式 ---- */
  'filters.fit.inside': '装进框内',
  'filters.fit.cover': '裁切填满',
  'filters.fit.fill': '拉伸',
  'filters.fitHint.inside': '保持比例，长边顶到框为止，不裁也不变形（最常用）。',
  'filters.fitHint.cover': '保持比例，填满整个框，多出来的部分裁掉。',
  'filters.fitHint.fill': '拉伸到正好这个尺寸，会变形。',

  /* ---- 降噪的三档强度 ---- */
  'filters.denoise.light': '轻',
  'filters.denoise.medium': '中',
  'filters.denoise.strong': '重',

  /* ---- 输入框的称呼（两处用：报错句的前缀、输入框旁边的单位字）---- */
  'filters.dim.width': '宽',
  'filters.dim.height': '高',

  /* ---- 单步校验的六句 + 三个共用片段 ---- */
  'filters.resizeBothEmpty': '宽高至少填一个（另一个留空则按比例算）',
  'filters.dimInteger': '{label}只能填整数像素',
  'filters.dimMin': '{label}至少是 {min} 像素',
  'filters.dimMax': '{label}不能超过 {max} 像素',
  'filters.sharpenEmpty': '锐化强度不能为空',
  'filters.notANumber': '只能填数字',
  'filters.sharpenRangeIssue': '锐化强度要在 {min}~{max} 之间',
  'filters.loudnormEmpty': '目标响度不能为空',
  'filters.loudnormRangeIssue': '目标响度要在 {min}~{max} LUFS 之间',

  /* ---- 整链校验：报错要指名道姓是第几步的哪个动作 ---- */
  'filters.stepIssue': '第 {index} 步「{kind}」：{issue}',

  /* ---- aria-label：`第 N 步的` + 下面四个字段名 ---- */
  'filters.stepField': '第 {index} 步的{field}',
  'filters.field.width': '宽度（像素）',
  'filters.field.height': '高度（像素）',
  'filters.field.sharpen': '锐化强度',
  'filters.field.loudnorm': '目标响度',

  /* ---- 缩放的输入行 ---- */
  'filters.resizePlaceholder': '留空',
  'filters.resizeNoEnlarge': '不放大',
  'filters.resizeHintOneDim':
    '只填一个维度时，另一侧按原比例算；「裁切填满 / 拉伸」只在宽高都填了时才生效。',
  // ⚠️ 开头那个空格是**内容的**：它接在上一条后面，凑成「…才生效。 「不放大」开着时…」。
  'filters.resizeHintNoEnlarge': ' 「不放大」开着时，比目标尺寸小的那一侧保持原样、不会被拉大。',

  /* ---- 各步自己的说明 ---- */
  'filters.deinterlaceHint':
    '两档都实测可用。ffmpeg 的自动判断（`idet` / `detelecine`）实测缺失，所以「这段到底 是不是隔行的」要你自己看着办，拿不准就用 yadif。',
  'filters.denoiseHint':
    '降噪越重越慢、细节也越少。它对**本来干净**的素材是纯损失，所以这一步默认不在链上； 加了它是有意的取舍，不是「顺手加一个会更好」。',
  'filters.sharpenAmountUnit': '强度',
  'filters.sharpenHint':
    '范围 {min}~{max}，1 是「看得出来」的起点。它会把噪点一起放大， 所以要排在降噪之后（规范次序已经这么排了）。',
  'filters.loudnormHint':
    '范围 {min}~{max}，默认 {def} LUFS （流媒体平台的事实标准）。它作用在**音频流**上，视频文件里的音轨照样能归一化。',
  'filters.rotateHint':
    '这是**真的重排像素**，所以必须重新编码。手机视频里那个记在容器里的旋转标记是另一回事 ——`-c copy` 会把它原样搬走，有的播放器转、有的不转。',

  /* ---- 链上的一行 ---- */
  'filters.moveUp': '上移',
  'filters.moveUpTitle': '上移（排在上面的先执行）',
  'filters.moveDown': '下移',
  'filters.moveDownTitle': '下移',
  'filters.remove': '删除',
  'filters.removeTitle': '从链上删掉这一步',

  /* ---- 面板外壳 ---- */
  'filters.title': '处理链（从上到下依次执行）',
  'filters.applyFailed': '没能设上——这条任务正在转换中，或这一步不适用于它的类别',
  'filters.emptyChain':
    '链上还没有步骤。从下面挑一个动作加进来——加进来的每一步都会按这个顺序执行。',
  'filters.addStep': '添加一步：',
  'filters.atMax': '链上已经有 {count} 步，到上限了（更长的链必然是算错了的配方）。',
  'filters.hiddenUnavailable': '「{kinds}」在{category}这一类上放不下，所以不在上面。',
  'filters.unsaved': '链上的改动还没生效——点「应用」才会提交。'
} as const

export const filtersEn: Record<keyof typeof filtersZh, string> = {
  'filters.kind.resize': 'Resize',
  'filters.kind.deinterlace': 'Deinterlace',
  'filters.kind.denoise': 'Denoise',
  'filters.kind.sharpen': 'Sharpen',
  'filters.kind.rotate': 'Rotate',
  // ⚠️ 不写成 "Normalize loudness"：它是一个**步骤的名字**，与面板上其它五个并列，
  // 名词短语读起来才像同一张菜单里的东西。动作本身在下面的说明里说清了。
  'filters.kind.loudnorm': 'Loudness normalization',

  'filters.fit.inside': 'Fit inside',
  'filters.fit.cover': 'Crop to fill',
  'filters.fit.fill': 'Stretch',
  'filters.fitHint.inside':
    'Keeps the aspect ratio and stops the long edge at the box: no cropping, no distortion (the usual choice).',
  'filters.fitHint.cover':
    'Keeps the aspect ratio, fills the whole box, and crops whatever overflows.',
  'filters.fitHint.fill': 'Stretches to exactly this size, so the image will be distorted.',

  'filters.denoise.light': 'Light',
  'filters.denoise.medium': 'Medium',
  'filters.denoise.strong': 'Heavy',

  'filters.dim.width': 'Width',
  'filters.dim.height': 'Height',

  'filters.resizeBothEmpty':
    'Fill in at least one dimension (leave the other empty and it follows the ratio)',
  'filters.dimInteger': '{label} must be a whole number of pixels',
  'filters.dimMin': '{label} must be at least {min} pixels',
  'filters.dimMax': '{label} must not exceed {max} pixels',
  'filters.sharpenEmpty': 'Sharpen amount cannot be empty',
  'filters.notANumber': 'Numbers only',
  'filters.sharpenRangeIssue': 'Sharpen amount must be between {min} and {max}',
  'filters.loudnormEmpty': 'Target loudness cannot be empty',
  'filters.loudnormRangeIssue': 'Target loudness must be between {min} and {max} LUFS',

  'filters.stepIssue': 'Step {index} “{kind}”: {issue}',

  'filters.stepField': 'Step {index} {field}',
  'filters.field.width': 'width (px)',
  'filters.field.height': 'height (px)',
  'filters.field.sharpen': 'sharpen amount',
  'filters.field.loudnorm': 'target loudness',

  'filters.resizePlaceholder': 'Empty',
  'filters.resizeNoEnlarge': 'Do not enlarge',
  'filters.resizeHintOneDim':
    'With only one dimension filled in, the other side follows the original ratio; “Crop to fill / Stretch” only take effect once both are filled in.',
  // ⚠️ 开头那个空格与中文那一侧同理：它接在上一条后面，两句话之间不能粘在一起。
  'filters.resizeHintNoEnlarge':
    ' With “Do not enlarge” on, a side smaller than the target keeps its own size instead of being blown up.',

  'filters.deinterlaceHint':
    'Both methods work — we measured them. ffmpeg’s auto-detection (`idet` / `detelecine`) is missing in our build, so whether a clip is interlaced is your call; when in doubt, use yadif.',
  'filters.denoiseHint':
    'The heavier the denoise, the slower it runs and the more detail it eats. On already-clean footage it is a pure loss, which is why this step is not in the chain by default; adding it is a deliberate trade-off, not “one more thing cannot hurt”.',
  'filters.sharpenAmountUnit': 'Amount',
  'filters.sharpenHint':
    'Range {min}~{max}; 1 is where the effect starts to show. It magnifies noise along with detail, so it has to come after denoise (the canonical order already places it there).',
  'filters.loudnormHint':
    'Range {min}~{max}, default {def} LUFS (the de-facto standard for streaming platforms). It acts on the audio stream, so an audio track inside a video file gets normalized just the same.',
  'filters.rotateHint':
    'This really does re-arrange pixels, so it has to be re-encoded. The rotation flag a phone writes into the container is a different thing — `-c copy` carries it over as-is, and some players honour it while others do not.',

  'filters.moveUp': 'Up',
  'filters.moveUpTitle': 'Move up (steps above it run first)',
  'filters.moveDown': 'Down',
  'filters.moveDownTitle': 'Move down',
  'filters.remove': 'Remove',
  'filters.removeTitle': 'Remove this step from the chain',

  'filters.title': 'Processing chain (runs top to bottom)',
  'filters.applyFailed':
    'Could not apply — this task is converting right now, or this step does not apply to its category',
  'filters.emptyChain':
    'No steps in the chain yet. Pick an action below to add one — every step you add runs in this order.',
  'filters.addStep': 'Add a step:',
  'filters.atMax':
    'The chain already has {count} steps, which is the cap (a longer chain is a recipe that went wrong).',
  'filters.hiddenUnavailable':
    '“{kinds}” cannot be used on the {category} category, so not listed above.',
  'filters.unsaved': 'Chain changes are not applied yet — click “Apply” to submit them.'
}
