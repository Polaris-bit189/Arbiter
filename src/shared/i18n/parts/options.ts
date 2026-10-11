/**
 * 参数面板的其余几块（裁剪 / 输出约束 / 编码质量档 / 外壳组件）的文案。
 *
 * ⚠️ 中文值必须与迁移前源码里的字面量**逐字节相同**——闸门 d 会拿冻结快照逐值比对。
 * 迁移的时候是「把字面量搬进来、原样不动」，不是「顺手把哪句读着别扭的话改通顺」。
 *
 * ## 键是按 **JSX 文本片段**切的，不是按「一句话」
 *
 * 这几块里有几段带内联强调（`<span className="text-gold-pale">` 夹在句子中间），
 * 而 `test-i18n.ts` 的扫描口径是「被 `{` `}` `<` `>` 切开的极大文本段」——
 * 一段话在源码里**本来就是 2~4 条独立片段**，闸门 d 逐条比对，所以这里也逐条切键。
 * ⇒ `presetHintC` 这种只有「反而比」三个字的键是**正常的**，不是漏合并；
 * 拼起来仍是同一句话，靠的是每段各自的措辞（英文那侧尤其要看**前后接得上**）。
 *
 * ## 片段两侧的空格是承重的
 *
 * `medium 更小` 里那个空格来自 JSX 文本节点（拉丁字母与汉字之间），而字典值两侧
 * 不能带空格——闸门 d 对 JSX 文本先 `trim()` 再比。所以空格写在源码那一侧、
 * 用 `{' '}` 显式表达，**中文与英文共用同一处**：改任意一侧的措辞时，
 * 都得让句子在「前一段 + 空格 + 后一段」这个形状下读得通。
 *
 * ## `options.common.*` 是跨面板共用的句子
 *
 * 目前只有「只能填数字」——它在质量档与输出约束两块里**逐字相同**。
 * 共用一条而不是各写一条，是为了改措辞时不会漏掉另一处。
 */

export const optionsZh = {
  // —— 外壳：`OptionsSection` 的按钮与 `OptionsEditor` 的收起 ——
  'options.apply': '应用',
  'options.clear': '清除',
  'options.collapse': '收起',

  // —— 跨面板共用的校验原因 ——
  'options.common.reasonNotNumber': '只能填数字',

  // —— 裁剪（`TrimSection`）——
  'options.trim.title': '裁剪区间（秒）',
  'options.trim.failed': '没能设上——这条任务不接受裁剪参数',
  'options.trim.startAria': '起点（秒）',
  'options.trim.endAria': '终点（秒）',
  'options.trim.startShort': '起',
  'options.trim.endShort': '止',
  'options.trim.modeLossless': '无损（不重编码）',
  'options.trim.modeExact': '精确（重新编码）',
  'options.trim.reasonBothRequired': '起点与终点都要填',
  'options.trim.reasonNotNumber': '只能填数字（单位是秒）',
  'options.trim.reasonNegative': '时间不能是负数',
  'options.trim.reasonOrder': '终点必须大于起点',
  'options.trim.reasonTooLong': '终点不能超过 {max} 秒（24 小时）',
  'options.trim.losslessLead':
    '无损裁剪一个字节都不重编，所以它只能在关键帧上落刀：起点会对齐到最近的关键帧，',
  'options.trim.losslessEarly': '可能比你要的早一点',
  'options.trim.losslessRest':
    '（最多早一个关键帧间隔），终点不受影响。另外它要求源里的编解码器能原样装进目标 容器（比如 h264 就进不了 webm），装不下时任务会失败并让你改用精确模式—— 不会背着你偷偷重编一遍。',
  'options.trim.exactHint':
    '精确裁剪会重新编码（H.264 + AAC），帧级准确，画质会有一次损失，耗时也长得多。',

  // —— 输出约束（`OutputSection`）——
  'options.output.title': '输出约束（体积 / 码率，二选一）',
  'options.output.failed': '没能设上——这条任务不接受输出约束，或它正在跑',
  'options.output.modeSize': '目标体积',
  'options.output.modeBitrate': '目标码率',
  'options.output.sizeAria': '目标体积',
  'options.output.bitrateAria': '目标码率',
  'options.output.reasonSizeEmpty': '体积不能为空',
  'options.output.reasonSizePositive': '体积要大于 0',
  'options.output.reasonSizeMin': '不能小于 {n} KB',
  'options.output.reasonSizeMax': '不能大于 {n} GB',
  'options.output.reasonRateEmpty': '码率不能为空',
  'options.output.reasonRateInteger': '码率是整数（单位 kbps）',
  'options.output.reasonRateMin': '不能小于 {n} kbps',
  'options.output.reasonRateMax': '不能大于 {n} kbps',
  'options.output.sizeHintLead': '视频的体积目标要先把整片分析一遍再编（',
  'options.output.sizeHintDouble': '耗时接近翻倍',
  'options.output.sizeHintRest':
    '），换来的是产物体积确实受控。图片改的是质量（二分搜索），音频直接按码率压。 它要求引擎重新编码，所以与「无损裁剪」不能同时用——两者一起提交会被拒。',
  'options.output.rateHintLead': '直接指定码率（kb',
  'options.output.rateHintRest':
    '），单遍编码，比体积目标快得多。它同样要求重新编码，与无损裁剪互斥。',

  // —— 编码质量档（`QualitySection`）——
  'options.quality.title': '编码质量档（恒定质量 · 速度档 · 调优）',
  'options.quality.failed': '没能设上——这条任务不接受编码质量档，或它正在跑',
  'options.quality.reasonEmpty': 'CRF 不能为空（不想要这一项就点「清除」）',
  'options.quality.reasonInteger': 'CRF 是整数',
  'options.quality.reasonRange': '只能在 {min} ~ {max} 之间',
  'options.quality.exitLead': '.{ext} 这个出口没有编码质量档',
  'options.quality.exitWebm': '（webm 走 VP9：它的 CRF 是另一条尺子，也没有 -preset / -tune）',
  'options.quality.exitGif': '（gif 走调色板滤镜，根本没有质量旋钮）',
  'options.quality.labelCrf': '质量',
  'options.quality.crfAria': '恒定质量 CRF',
  'options.quality.crfHintLead': 'CRF（',
  'options.quality.crfHintMid': '，越小越好；默认 ',
  'options.quality.crfHintTail': '）',
  'options.quality.labelPreset': '速度档',
  'options.quality.presetAria': '编码速度档',
  'options.quality.labelTune': '调优',
  'options.quality.tuneAria': '编码调优',
  'options.quality.tuneNone': '不调优（默认）',
  'options.quality.presetHintA': '速度档只影响时间与「同一 CRF 下的画质/体积权衡」',
  'options.quality.presetHintB': '，不是「越慢体积越小」——实测同一份素材上',
  'options.quality.presetHintC': '反而比',
  'options.quality.presetHintD':
    '更小，而画质更差（SSIM 0.9802 对 0.9860）。同一个 CRF 数字换个预设就**不是同一个画质**，两者不能互相换算。 实测',
  'options.quality.presetHintE': '慢 5.6~6.6 倍， 而画质从',
  'options.quality.presetHintF': '往后基本不再涨。 慢档也更吃内存（',
  'options.quality.presetHintG': '是',
  'options.quality.presetHintH': '的 2.3 倍），所以并发会相应下调。',
  'options.quality.encodeHint':
    '质量档要求重新编码，所以与「无损裁剪」不能同时用；它也与显卡编码互斥 （CRF 与 CQ 同号不同质），设了它这次就走 CPU。与「输出约束」互斥，见上面的禁用原因。'
} as const

export const optionsEn: Record<keyof typeof optionsZh, string> = {
  'options.apply': 'Apply',
  'options.clear': 'Clear',
  'options.collapse': 'Collapse',

  'options.common.reasonNotNumber': 'Numbers only',

  'options.trim.title': 'Trim range (seconds)',
  'options.trim.failed': 'Could not apply — this task does not take trim options',
  'options.trim.startAria': 'Start (seconds)',
  'options.trim.endAria': 'End (seconds)',
  'options.trim.startShort': 'Start',
  'options.trim.endShort': 'End',
  'options.trim.modeLossless': 'Lossless (no re-encode)',
  'options.trim.modeExact': 'Exact (re-encode)',
  'options.trim.reasonBothRequired': 'Both start and end are required',
  'options.trim.reasonNotNumber': 'Numbers only (in seconds)',
  'options.trim.reasonNegative': 'Time cannot be negative',
  'options.trim.reasonOrder': 'End must be greater than start',
  'options.trim.reasonTooLong': 'End cannot exceed {max} seconds (24 hours)',
  // 「起点会对齐到最近的关键帧，」+ 高亮 + `(at most …)`：三段拼起来是一句，
  // 所以第一段以逗号收尾、第二段是小写起头。
  'options.trim.losslessLead':
    'Lossless trimming re-encodes nothing, so it can only cut on keyframes: the start snaps to the nearest keyframe,',
  'options.trim.losslessEarly': 'which may be a little earlier than you asked for',
  'options.trim.losslessRest':
    '(at most one keyframe interval earlier); the end is unaffected. It also requires that the source codecs fit into the target container as they are (h264 cannot go into webm, for example); when they do not fit, the task fails and asks you to switch to exact mode — it will not quietly re-encode behind your back.',
  'options.trim.exactHint':
    'Exact trimming re-encodes (H.264 + AAC): frame-accurate, at the cost of one generation of quality loss and a much longer run.',

  'options.output.title': 'Output limit (size or bitrate — pick one)',
  'options.output.failed':
    'Could not apply — this task does not take output limits, or it is running',
  'options.output.modeSize': 'Target size',
  'options.output.modeBitrate': 'Target bitrate',
  'options.output.sizeAria': 'Target size',
  'options.output.bitrateAria': 'Target bitrate',
  'options.output.reasonSizeEmpty': 'Size cannot be empty',
  'options.output.reasonSizePositive': 'Size must be greater than 0',
  'options.output.reasonSizeMin': 'Cannot be smaller than {n} KB',
  'options.output.reasonSizeMax': 'Cannot be larger than {n} GB',
  'options.output.reasonRateEmpty': 'Bitrate cannot be empty',
  'options.output.reasonRateInteger': 'Bitrate must be a whole number (in kbps)',
  'options.output.reasonRateMin': 'Cannot be lower than {n} kbps',
  'options.output.reasonRateMax': 'Cannot be higher than {n} kbps',
  'options.output.sizeHintLead': 'A video size target analyses the whole file before encoding (',
  'options.output.sizeHintDouble': 'roughly twice the time',
  'options.output.sizeHintRest':
    '), and in exchange the output size really is under control. Images have their quality adjusted (binary search); audio is compressed straight to the bitrate. It requires re-encoding, so it cannot be combined with lossless trimming — submitting both is rejected.',
  'options.output.rateHintLead': 'Set the bitrate directly (kb',
  'options.output.rateHintRest':
    '), single-pass, and far faster than a size target. It also requires re-encoding, so it is mutually exclusive with lossless trimming.',

  'options.quality.title': 'Encoding quality (constant quality · preset · tune)',
  'options.quality.failed':
    'Could not apply — this task does not take encoding quality, or it is running',
  'options.quality.reasonEmpty': 'CRF cannot be empty (click Clear if you do not want it)',
  'options.quality.reasonInteger': 'CRF must be a whole number',
  'options.quality.reasonRange': 'Must be between {min} and {max}',
  'options.quality.exitLead': 'The .{ext} output has no encoding quality',
  'options.quality.exitWebm':
    '(webm goes through VP9: its CRF is a different scale, and there is no -preset / -tune)',
  'options.quality.exitGif': '(gif goes through the palette filter, which has no quality knob)',
  'options.quality.labelCrf': 'Quality',
  'options.quality.crfAria': 'Constant quality CRF',
  'options.quality.crfHintLead': 'CRF (',
  'options.quality.crfHintMid': ', lower is better; default ',
  'options.quality.crfHintTail': ')',
  'options.quality.labelPreset': 'Preset',
  'options.quality.presetAria': 'Encoding preset',
  'options.quality.labelTune': 'Tune',
  'options.quality.tuneAria': 'Encoding tune',
  'options.quality.tuneNone': 'No tune (default)',
  // 下面八段拼成一句话，顺序由 JSX 定死（`veryfast` 与 `medium` 是两处高亮），
  // 所以每一段都按「上一段 + 空格 + 下一段」读一遍再落笔。
  'options.quality.presetHintA':
    'The preset only affects time and the quality/size trade-off at a given CRF',
  'options.quality.presetHintB':
    ', not the idea that slower means smaller: on the same footage we measured',
  'options.quality.presetHintC': 'come out smaller than',
  'options.quality.presetHintD':
    'while scoring worse on quality (SSIM 0.9802 vs 0.9860). The same CRF number is not the same quality under a different preset, so the two cannot be converted into each other. We measured',
  'options.quality.presetHintE': 'as 5.6–6.6× slower, while quality from',
  'options.quality.presetHintF': 'onwards barely improves. Slower presets also use more memory (',
  'options.quality.presetHintG': 'needs 2.3× the memory of',
  'options.quality.presetHintH': '), so concurrency is scaled down accordingly.',
  'options.quality.encodeHint':
    'A quality setting requires re-encoding, so it cannot be combined with lossless trimming; it is also mutually exclusive with GPU encoding (CRF and CQ share a sign but not a meaning), so setting it means CPU this time. It is mutually exclusive with output limits as well — see the reason above.'
}
