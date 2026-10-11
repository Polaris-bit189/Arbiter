/**
 * 转换过程中的**阶段文案**（`progress.stage`）。
 *
 * ## 这一族为什么单独一个区域，而不是并进各引擎那一份
 *
 * 它们是**B 类**文本：**跨时间传递、而且会被重新渲染到界面上**。产出它们的是转换
 * 进程（`converters/**`），而显示它们的是渲染层的任务卡片——中间隔着主进程的
 * 状态机与一条 IPC 通道。别处的文案（对话框、引擎名、扫描报告）都是「当次生成、
 * 当次显示」，语言一变它们自然就变了；这一族不是：**一个跑了两小时的转码，中途把
 * 界面切到英文，卡片上那行字要跟着变**。
 *
 * ## 所以它有两个出口，而两个都由这里出
 *
 * - `stagePair(ref)` 同时给出**码**（`stageRef`）与**中文兜底文本**（`stage`），
 *   两者由同一份字典算出，不可能漂；
 * - 渲染层拿到码之后自己 `t()` 一次，于是语言一变它跟着变；
 * - 而 `stage` 那个字段**恒为中文**——它是 MCP 的线上格式，见 `stage.ts` 的说明。
 *
 * ⚠️ **中文值必须与迁移前逐字节相同**：`test-tasks.ts` 有一批直接断言 stage 文案的
 * 用例，而 MCP 那侧的 `progressKey` 也吃这个字段。
 */

export const stageZh = {
  /* ---- 通用 ---- */
  'stage.preparing': '准备中…',
  'stage.converting': '转换中…',

  /* ---- 各引擎自己的那一步 ---- */
  'stage.archive.extract': '拆开压缩包…',
  'stage.calibre.start': '启动 Calibre…',
  'stage.pandoc.prepare': '准备文档…',
  'stage.libreoffice.start': '启动 LibreOffice…',
  'stage.encmusic.decrypt': '解开加密容器…',
  'stage.document.parse': '解析文档…',
  'stage.document.extractText': '提取文本…',
  'stage.document.layout': '排版中…',
  'stage.document.renderPdf': '生成 PDF…',
  'stage.image.read': '读取图片…',
  'stage.image.decodeHeic': '解 HEIC…',
  'stage.image.encode': '编码中…',
  'stage.image.encodeAnimated': '编码动图…',
  'stage.image.searchQuality': '压缩到目标体积…（第 {round} 次试探）',

  /* ---- 引擎的按需下载 ---- */
  'stage.engine.preparing': '正在准备 {label} 引擎…',
  'stage.engine.installing': '正在安装 {label} 引擎…',
  'stage.engine.downloading': '正在下载 {label} 引擎…',

  /* ---- PDF 逐页导出（`batch` 进度）---- */
  'stage.pdf.exportPage': '导出第',

  /* ---- ffmpeg 的几条分岔 ---- */
  'stage.ffmpeg.noGpu': '未找到可用显卡，本次用 CPU 编码',
  'stage.ffmpeg.abrCpu': '输出目标走 ABR，与显卡编码的 CQ 模式互斥：本次用 CPU 编码',
  'stage.ffmpeg.qualityCpu':
    '质量档与显卡编码的参数不是同一套（CRF 与 CQ 同号不同质、预设也不是一个词表）：本次用 CPU 编码',
  'stage.ffmpeg.noAudioSkipLoudnorm': '源里没有音轨，跳过响度归一化',
  'stage.ffmpeg.loudnormPass': '第一遍分析（响度归一化）',
  'stage.ffmpeg.loudnormEncoding': '编码（响度归一化）',
  'stage.ffmpeg.loudnormSinglePass': '读不出响度统计，本步按单遍处理 · 编码中',
  'stage.ffmpeg.passOne': '第一遍分析（两遍编码）',
  'stage.ffmpeg.passTwo': '第二遍编码（两遍编码）',
  /**
   * 两遍编码时，「用 CPU」与「第一遍分析」必须**并成一条**。
   *
   * 两条 `emit` 之间一个 `await` 都没有，它们会落进同一批 patch、合并时后一条胜出——
   * 单独发出去的那条用户根本看不见。而它防的正是「静默换了一条路」
   * （见 `ffmpegRun.ts` 里 `abrCpuNote` 那段说明）。
   */
  'stage.ffmpeg.abrCpuPassOne':
    '输出目标走 ABR，与显卡编码的 CQ 模式互斥：本次用 CPU 编码 · 第一遍分析（两遍编码）',
  'stage.ffmpeg.gpuFallback': '显卡编码失败，改用 CPU 重试'
} as const

export const stageEn: Record<keyof typeof stageZh, string> = {
  'stage.preparing': 'Preparing…',
  'stage.converting': 'Converting…',

  'stage.archive.extract': 'Unpacking the archive…',
  'stage.calibre.start': 'Starting Calibre…',
  'stage.pandoc.prepare': 'Preparing the document…',
  'stage.libreoffice.start': 'Starting LibreOffice…',
  'stage.encmusic.decrypt': 'Unpacking the encrypted container…',
  'stage.document.parse': 'Parsing the document…',
  'stage.document.extractText': 'Extracting text…',
  'stage.document.layout': 'Laying out…',
  'stage.document.renderPdf': 'Rendering the PDF…',
  'stage.image.read': 'Reading the image…',
  'stage.image.decodeHeic': 'Decoding HEIC…',
  'stage.image.encode': 'Encoding…',
  'stage.image.encodeAnimated': 'Encoding the animation…',
  'stage.image.searchQuality': 'Hitting the target size… (attempt {round})',

  'stage.engine.preparing': 'Preparing the {label} engine…',
  'stage.engine.installing': 'Installing the {label} engine…',
  'stage.engine.downloading': 'Downloading the {label} engine…',

  'stage.pdf.exportPage': 'Page',

  'stage.ffmpeg.noGpu': 'No usable GPU found — encoding on the CPU',
  'stage.ffmpeg.abrCpu':
    'A size target means ABR, which rules out the GPU’s CQ mode — encoding on the CPU',
  'stage.ffmpeg.qualityCpu':
    'Quality settings and the GPU’s parameters are not the same scale (CRF and CQ differ, and the presets are a different vocabulary) — encoding on the CPU',
  'stage.ffmpeg.noAudioSkipLoudnorm':
    'The source has no audio track — skipping loudness normalisation',
  'stage.ffmpeg.loudnormPass': 'First pass: analysing loudness',
  'stage.ffmpeg.loudnormEncoding': 'Encoding (loudness normalisation)',
  'stage.ffmpeg.loudnormSinglePass':
    'Could not read the loudness statistics — treating this as a single pass · encoding',
  'stage.ffmpeg.passOne': 'First pass: analysing (two-pass encoding)',
  'stage.ffmpeg.passTwo': 'Second pass: encoding (two-pass encoding)',
  'stage.ffmpeg.abrCpuPassOne':
    'A size target means ABR, which rules out the GPU’s CQ mode — encoding on the CPU · first pass: analysing (two-pass encoding)',
  'stage.ffmpeg.gpuFallback': 'GPU encoding failed — retrying on the CPU'
}
