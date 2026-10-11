/**
 * MCP 的侦察与产物自检 —— `src/mcp/inspect.ts` / `inspectCost.ts` / `verify.ts`。
 *
 * ## P6 · 线 β 独占这一片
 *
 * 这三块说的是同一件事的两面：**动手之前先量一量**（inspect 给「有哪些合法出口」，
 * inspectCost 给「要准备哪个引擎、多大、多久」），以及**完事之后对一对**
 * （verify 逐项比对源与产物，只报事实、不打分）。
 *
 * ⚠️ 这一片的字**大多是 agent 读的**（`note` 会随工具结果一起回给模型，`facts` / `notes`
 * 是自检的事实清单），所以英文那侧要读得通、要能照做，不是给对照中文的人看的。
 *
 * ⚠️ **`inspect.ts` 里那些片段是拼接出来的**（模板插值 + 相邻字符串相加），迁进来时
 * 按**一句完整的话**记一个键：拼接边界是源码的写法，不是句子的边界——按边界切键会
 * 让英文那侧剩下半句（中文语序靠拼接还读得通，英文读不通）。渲染结果逐字节不变。
 */
export const mcpInspectZh = {
  /* —— inspect.ts · 音视频（ffmpeg）—— */
  'mcp.inspect.mediaNoFfmpeg': '找不到 ffmpeg，读不出流信息：{reason}',
  'mcp.inspect.mediaScoutFailed': 'ffmpeg 侦察失败：{reason}',
  'mcp.inspect.mediaSpawnFailed': '无法启动 ffmpeg：{reason}',
  'mcp.inspect.mediaTimeout':
    'ffmpeg 超过 {seconds} 秒没有返回，已杀掉进程树；文件所在磁盘可能很慢',
  'mcp.inspect.mediaUnreadable':
    'ffmpeg 读不出流信息，文件可能损坏或不是它扩展名宣称的格式：{detail}',
  'mcp.inspect.stderrEmpty': '（stderr 为空）',

  /* —— inspect.ts · 图片（sharp）—— */
  'mcp.inspect.imageUnrecognized': 'sharp 认不出这个文件，也就没有尺寸可报',
  'mcp.inspect.imageMetadataFailed': 'sharp 读不出这张图的元数据：{reason}',

  /* —— inspect.ts · 压缩包（7-Zip）—— */
  'mcp.inspect.archiveResolveFailed': '7-Zip 路径解析失败：{reason}',
  'mcp.inspect.archiveNoEngine': '找不到 7-Zip 可执行文件，列不出压缩包内容',
  'mcp.inspect.archiveSpawnFailed': '无法启动 7-Zip：{reason}',
  'mcp.inspect.archiveTimeout': '7-Zip 超过 {seconds} 秒没有返回，已杀掉进程树',
  'mcp.inspect.archiveListFailed':
    '7-Zip 列不出条目（退出码 {code}），文件可能损坏或需要完整版 7z：{detail}',
  /** `result.code ?? '未知'` —— 退出码拿不到时那个词 */
  'mcp.inspect.codeUnknown': '未知',

  /* —— inspect.ts · inspectFile 的早退 —— */
  'mcp.inspect.emptyPath': '路径为空',
  'mcp.inspect.fileMissing': '文件不存在：{path}',
  'mcp.inspect.statFailed': '读不到文件属性：{reason}',
  'mcp.inspect.dirNotFile': '这是一个目录，不是文件：{path}',
  'mcp.inspect.extNone': '（无扩展名）',
  'mcp.inspect.unknownExt':
    '不认识的扩展名 {ext}：能力矩阵里没有它，能转成什么无从判断。用 list_supported_formats 查一下支持的格式',
  'mcp.inspect.noTargets': '能力矩阵里没有 {path} 的出口格式，它转不了',

  /* —— inspect.ts · 按类别分派 —— */
  'mcp.inspect.noSubprocessScout': '{category}不做子进程侦察：时长 / 分辨率 / 编解码器对它没有意义',
  'mcp.inspect.categoryDocument': '文档',
  'mcp.inspect.categoryEbook': '电子书',

  /* —— inspect.ts · probeFile（自检复用的那一半）—— */
  'mcp.inspect.probeStatFailed': '读不到文件属性（文件可能已经被移走或删掉）：{reason}',
  'mcp.inspect.probeUnknownExt': '不认识的扩展名 {ext}，没有可用的侦察手段',
  'mcp.inspect.probeDirNotFile': '这是一个目录，不是文件',
  /** `probeFile` 把两条 note 拼起来时用的分隔符 */
  'mcp.inspect.noteJoin': '；',

  /* —— verify.ts · 分辨率 —— */
  'mcp.verify.resolutionSame': '分辨率 {w}x{h}，与源一致',
  'mcp.verify.resolutionDiffers': '分辨率与源不同：源 {w}x{h} → 产物 {ow}x{oh}',
  'mcp.verify.dimsLine': '尺寸：源 {w}x{h} / 产物 {ow}x{oh}',
  'mcp.verify.gifSizeNote':
    '产物尺寸与源不同（{w}x{h} → {ow}x{oh}）：视频转 gif 走的是我们的调色板链，那条链自己带 `scale=480:-1`（engines/ffmpeg.ts 的 GIF_FILTER），尺寸是**我们定的**，所以这一项不参与判定，只把两个数报出来。',

  /* —— verify.ts · 视频编解码器 —— */
  'mcp.verify.codecSame': '视频编解码器 {codec}，与源相同',
  'mcp.verify.codecDiffers': '视频编解码器：源 {from} → 产物 {to}',
  'mcp.verify.codecChangedNote':
    '编解码器变了不算差异：目标容器装不下源的编码器时本来就要重编码（mp4 → webm 必然从 h264 变成 vp9/vp8），这条只报事实。',

  /* —— verify.ts · 音轨 —— */
  'mcp.verify.audioLost': '产物没有音轨，而源有',
  'mcp.verify.audioBoth': '音轨：源与产物都有',
  'mcp.verify.audioOutputOnly': '源没有音轨，而产物有',
  'mcp.verify.audioExtraNote':
    '产物多出一条音轨有点反常（本项目不做「加音轨」这件事），值得自己核对。',
  'mcp.verify.audioNeither': '音轨：源与产物都没有',
  'mcp.verify.audioUnknownNote':
    '源有音轨，但产物的元数据没读出来，所以「音轨还在不在」这一项没查成。',

  /* —— verify.ts · 视频流 —— */
  'mcp.verify.videoLost': '产物没有视频流，而源有',

  /* —— verify.ts · 时长 —— */
  'mcp.verify.durationLine': '时长：产物 {output} / 源 {source}（差 {delta}）',
  'mcp.verify.durationNoteworthyNote':
    '产物时长与源相差 {delta}。重新分装（ts → mp4 那类）与 gif 本来就会让容器报的时长变，所以时长**不参与**「一致 / 不一致」的判定；但差到这个量级确实是一处差异，值得自己核对。',

  /* —— verify.ts · 探针失败与「没什么可比的」—— */
  'mcp.verify.outputProbeMissing': '产物的元数据没读出来：{note}',
  'mcp.verify.sourceProbeMissing': '源的元数据没读出来：{note}',
  'mcp.verify.noteUnstated': '（没有说明）',
  'mcp.verify.archiveNote':
    '压缩包不比内容：拆开重打包是正常路径，条目数与源不保证相同，所以这一项刻意不比。产物读得出来、非空，这两条已经由任务本身核过。',
  'mcp.verify.nothingComparableNote':
    '两边都没有可比的项目：图片没有时长与编解码器、gif 也没有音轨，文档与电子书则不做子进程侦察（见 inspect.ts 的分派）。'
} as const

/**
 * ⚠️ 占位符的名字与个数必须与中文那侧**完全一致**（闸门 c 逐键比对）：
 * `{seconds}` / `{w}` / `{h}` / `{ow}` / `{oh}` / `{code}` / `{detail}` / `{reason}` 都不是
 * 装饰——`t()` 的参数是条件元组，键里有几个占位符就**必须**传几个。
 */
export const mcpInspectEn: Record<keyof typeof mcpInspectZh, string> = {
  /* —— inspect.ts · 音视频（ffmpeg）—— */
  'mcp.inspect.mediaNoFfmpeg': 'ffmpeg not found, cannot read stream info: {reason}',
  'mcp.inspect.mediaScoutFailed': 'ffmpeg probing failed: {reason}',
  'mcp.inspect.mediaSpawnFailed': 'Could not start ffmpeg: {reason}',
  'mcp.inspect.mediaTimeout':
    'ffmpeg did not return within {seconds}s, so the process tree was killed; the disk may be very slow',
  'mcp.inspect.mediaUnreadable':
    'ffmpeg could not read stream info — the file may be corrupt, or not the format its extension claims: {detail}',
  'mcp.inspect.stderrEmpty': '(stderr empty)',

  /* —— inspect.ts · 图片（sharp）—— */
  'mcp.inspect.imageUnrecognized':
    'sharp does not recognize this file, so there are no dimensions to report',
  'mcp.inspect.imageMetadataFailed': 'sharp could not read this image metadata: {reason}',

  /* —— inspect.ts · 压缩包（7-Zip）—— */
  'mcp.inspect.archiveResolveFailed': 'Could not resolve the 7-Zip path: {reason}',
  'mcp.inspect.archiveNoEngine': 'No 7-Zip executable found, cannot list the archive contents',
  'mcp.inspect.archiveSpawnFailed': 'Could not start 7-Zip: {reason}',
  'mcp.inspect.archiveTimeout':
    '7-Zip did not return within {seconds}s, so the process tree was killed',
  'mcp.inspect.archiveListFailed':
    '7-Zip could not list entries (exit code {code}); the file may be corrupt, or needs the full 7z build: {detail}',
  'mcp.inspect.codeUnknown': 'unknown',

  /* —— inspect.ts · inspectFile 的早退 —— */
  'mcp.inspect.emptyPath': 'path is empty',
  'mcp.inspect.fileMissing': 'file does not exist: {path}',
  'mcp.inspect.statFailed': 'could not read file attributes: {reason}',
  'mcp.inspect.dirNotFile': 'this is a directory, not a file: {path}',
  'mcp.inspect.extNone': '(no extension)',
  'mcp.inspect.unknownExt':
    'unknown extension {ext}: it is not in the capability matrix, so there is no way to tell what it converts to. Call list_supported_formats to see the supported formats',
  'mcp.inspect.noTargets':
    'the capability matrix has no output format for {path}; it cannot be converted',

  /* —— inspect.ts · 按类别分派 —— */
  'mcp.inspect.noSubprocessScout':
    '{category}: no subprocess probing — duration / resolution / codecs mean nothing here',
  'mcp.inspect.categoryDocument': 'documents',
  'mcp.inspect.categoryEbook': 'ebooks',

  /* —— inspect.ts · probeFile（自检复用的那一半）—— */
  'mcp.inspect.probeStatFailed':
    'could not read file attributes (the file may have been moved or deleted): {reason}',
  'mcp.inspect.probeUnknownExt': 'unknown extension {ext}; no probing method available',
  'mcp.inspect.probeDirNotFile': 'this is a directory, not a file',
  'mcp.inspect.noteJoin': '; ',

  /* —— verify.ts · 分辨率 —— */
  'mcp.verify.resolutionSame': 'resolution {w}x{h}, same as the source',
  'mcp.verify.resolutionDiffers':
    'resolution differs from the source: source {w}x{h} -> output {ow}x{oh}',
  'mcp.verify.dimsLine': 'dimensions: source {w}x{h} / output {ow}x{oh}',
  'mcp.verify.gifSizeNote':
    'the output size differs from the source ({w}x{h} -> {ow}x{oh}): video-to-gif runs through our palette chain, which hard-codes `scale=480:-1` (GIF_FILTER in engines/ffmpeg.ts) — the size is **ours to set**, so this item does not take part in the verdict; both numbers are reported as-is.',

  /* —— verify.ts · 视频编解码器 —— */
  'mcp.verify.codecSame': 'video codec {codec}, same as the source',
  'mcp.verify.codecDiffers': 'video codec: source {from} -> output {to}',
  'mcp.verify.codecChangedNote':
    'a changed codec is not a difference: when the target container cannot hold the source codec, re-encoding is expected (mp4 -> webm always turns h264 into vp9/vp8); this line only reports the fact.',

  /* —— verify.ts · 音轨 —— */
  'mcp.verify.audioLost': 'the output has no audio track, but the source does',
  'mcp.verify.audioBoth': 'audio track: present in both source and output',
  'mcp.verify.audioOutputOnly': 'the source has no audio track, but the output does',
  'mcp.verify.audioExtraNote':
    'an extra audio track in the output is unusual (this project never adds audio tracks) — worth checking yourself.',
  'mcp.verify.audioNeither': 'audio track: absent from both source and output',
  'mcp.verify.audioUnknownNote':
    'the source has an audio track, but the output metadata could not be read, so "is the audio still there" was not checked.',

  /* —— verify.ts · 视频流 —— */
  'mcp.verify.videoLost': 'the output has no video stream, but the source does',

  /* —— verify.ts · 时长 —— */
  'mcp.verify.durationLine': 'duration: output {output} / source {source} (delta {delta})',
  'mcp.verify.durationNoteworthyNote':
    'the output duration differs from the source by {delta}. Remuxing (ts -> mp4 and the like) and gif both change the duration the container reports, so duration does **not** take part in the consistent / differs verdict — but a gap this large is a real difference, worth checking yourself.',

  /* —— verify.ts · 探针失败与「没什么可比的」—— */
  'mcp.verify.outputProbeMissing': 'output metadata could not be read: {note}',
  'mcp.verify.sourceProbeMissing': 'source metadata could not be read: {note}',
  'mcp.verify.noteUnstated': '(no explanation given)',
  'mcp.verify.archiveNote':
    'archives are not compared by content: unpacking and repacking is the normal path, so entry counts are not guaranteed to match the source — this item is deliberately skipped. That the output is readable and non-empty has already been verified by the task itself.',
  'mcp.verify.nothingComparableNote':
    'neither side has anything comparable: images have no duration or codec, gif has no audio track either, and documents and ebooks get no subprocess probing (see the dispatch in inspect.ts).'
}
