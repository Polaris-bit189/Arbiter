/**
 * MCP 工具的**错误码与下一步指令** —— `src/mcp/errors.ts` 的 `POLICIES`。
 *
 * ## P6 · 线 β 独占这一片
 *
 * ⚠️ `next_steps` 是**写给 agent 的动作**（「换个格式重试」「去让用户先装引擎」），
 * 不是写给人的说明。英文版要短、要能直接驱动决策——机翻出来的长句会让 agent
 * 读不出该干什么。
 *
 * ⚠️ `code` 本身（`source_corrupt` / `engine_missing` …）是**机器可读的闭集**，
 * **不翻译**：它是 agent 写分支用的，翻了就等于改了协议。
 *
 * 键名的后半截按**这句话在说什么**取（`confirmExt` / `readLogTail` …），不按序号——
 * 这张表将来只会加码，而 `s3` 这种名字在中间插一条时全都要重编。
 */
export const mcpErrorsZh = {
  /* —— unknown_format —— */
  'mcp.errors.unknown_format.confirmExt':
    '先确认源文件的扩展名在能力矩阵里：调 list_supported_formats（或读 converter://formats）',
  'mcp.errors.unknown_format.realExt': '路径必须带真实扩展名，别拿 .part / .tmp 这类中间文件去转',

  /* —— target_not_supported —— */
  'mcp.errors.target_not_supported.pickFromHint': '从返回值 hint.targets 里挑一个目标格式改调一次',
  'mcp.errors.target_not_supported.skipKnownImpossible':
    '矩阵里没有的组合多半是实测过做不到，别用同一个目标重复试',

  /* —— engine_missing —— */
  'mcp.errors.engine_missing.askUserToDownload':
    '这条转换需要额外引擎，得请用户先在 Arbiter（调律者转换器）里下载它',
  'mcp.errors.engine_missing.useOtherTarget':
    '在那之前改用不需要该引擎的目标格式（hint 里有具体是哪个引擎）',

  /* —— path_not_allowed —— */
  'mcp.errors.path_not_allowed.useAllowedRoot': '把路径改到 hint.roots 列出的目录里',
  'mcp.errors.path_not_allowed.absoluteOutput':
    '输出路径必须写成绝对路径，且它的**上级目录要已经存在**',

  /* —— source_missing —— */
  'mcp.errors.source_missing.checkSpelling':
    '核对路径拼写；以工具的返回值/hint 里的路径为准，不要自己拼',
  'mcp.errors.source_missing.confirmStillThere': '确认这个文件确实还在（可能刚被移动或改名了）',

  /* —— source_corrupt —— */
  'mcp.errors.source_corrupt.readLogTail':
    '读这次返回里的 log_tail —— 引擎的原始报错在那里，它才说得清是哪一步不对',
  'mcp.errors.source_corrupt.inspectSource': '用 inspect_file 看看这个源还能不能被识别',
  'mcp.errors.source_corrupt.noRetrySameTarget':
    '同一个源 + 同一个目标重试不会有不同结果，要换就换源或换目标格式',

  /* —— output_conflict —— */
  'mcp.errors.output_conflict.fullFilePath':
    'output_path 要写成产物的完整路径（含文件名），而且那上面**当前不能有东西**',
  'mcp.errors.output_conflict.useFreePath': '换一个没被占用的路径；hint 里有冲突的那个路径',

  /* —— canceled —— */
  'mcp.errors.canceled.resubmit': '任务是**被取消**的，不是失败；需要的话重新提交一次同样的转换',

  /* —— unknown_job —— */
  'mcp.errors.unknown_job.listJobs':
    '用 list_jobs 拿一份当前登记的 job_id 清单（hint 里也带了一份）',
  'mcp.errors.unknown_job.sessionScoped':
    'job_id 只在**当前这次 MCP 会话**里有效，换一个会话就是全新的登记表',

  /* —— no_text_content —— */
  'mcp.errors.no_text_content.noTextLayer':
    '这份文档没有文本层（图片型 / 扫描件 PDF），本项目不含 OCR，**重试这个文件不会有不同结果**',
  'mcp.errors.no_text_content.convertToImage':
    '要看内容就用 convert_file 把它转成 png / jpg（一页一张图），交给能看图的客户端',
  'mcp.errors.no_text_content.needsOcr': '要拿到文字得先由用户对这份文件做一次 OCR',

  /* —— not_readable —— */
  'mcp.errors.not_readable.supportedBodies':
    'read_document 只读文档正文：docx / xlsx / pdf / md / txt / html / rst / csv',
  'mcp.errors.not_readable.useInspectOrConvert':
    '音视频 / 图片 / 压缩包的信息用 inspect_file 查；要换格式用 convert_file',
  'mcp.errors.not_readable.heavyEngines':
    '需要重型引擎的类别（doc/xls/ppt/odt/ods 与电子书）改用 convert_file，并把要下载多大的引擎一并告诉用户',

  /* —— internal —— */
  'mcp.errors.internal.retryOnce': '先原样重试一次',
  'mcp.errors.internal.reportToUser': '连续两次同样失败就把这条错误的原文报给用户，不要自己反复重试'
} as const

/**
 * ⚠️ 这一侧是**给 agent 读的指令**，不是翻译腔的说明书：每条都要短到一眼能照做
 * （`retryable` 已经替它答了「要不要重试」，这里只答「那改什么」）。
 * 中文里那些 `**强调**` 与反引号原样保留——它们是同一套 Markdown 约定。
 */
export const mcpErrorsEn: Record<keyof typeof mcpErrorsZh, string> = {
  /* —— unknown_format —— */
  'mcp.errors.unknown_format.confirmExt':
    'Check the source extension against the capability matrix: call list_supported_formats (or read converter://formats)',
  'mcp.errors.unknown_format.realExt':
    'The path needs the real extension — do not convert intermediates like .part / .tmp',

  /* —— target_not_supported —— */
  'mcp.errors.target_not_supported.pickFromHint':
    'Pick a target from hint.targets in the response and call again',
  'mcp.errors.target_not_supported.skipKnownImpossible':
    'Combinations missing from the matrix were measured as impossible — do not retry the same target',

  /* —— engine_missing —— */
  'mcp.errors.engine_missing.askUserToDownload':
    'This conversion needs an extra engine — ask the user to download it in Arbiter first',
  'mcp.errors.engine_missing.useOtherTarget':
    'Until then use a target that does not need that engine (hint names which one)',

  /* —— path_not_allowed —— */
  'mcp.errors.path_not_allowed.useAllowedRoot':
    'Move the path under one of the directories listed in hint.roots',
  'mcp.errors.path_not_allowed.absoluteOutput':
    'The output path must be absolute, and its **parent directory must already exist**',

  /* —— source_missing —— */
  'mcp.errors.source_missing.checkSpelling':
    'Check the spelling, and trust the path the tool returned in hint rather than building one',
  'mcp.errors.source_missing.confirmStillThere':
    'Confirm the file is still there (it may have just been moved or renamed)',

  /* —— source_corrupt —— */
  'mcp.errors.source_corrupt.readLogTail':
    'Read log_tail in this response — the engine raw error is there and says which step went wrong',
  'mcp.errors.source_corrupt.inspectSource':
    'Run inspect_file to see whether the source is still recognized',
  'mcp.errors.source_corrupt.noRetrySameTarget':
    'Retrying the same source and target gives the same result — change the source or the target format',

  /* —— output_conflict —— */
  'mcp.errors.output_conflict.fullFilePath':
    'output_path must be the full path of the output (filename included), and **nothing may exist there right now**',
  'mcp.errors.output_conflict.useFreePath': 'Use a free path — hint reports the one that clashed',

  /* —— canceled —— */
  'mcp.errors.canceled.resubmit':
    'The job was **canceled**, not failed — resubmit the same conversion if you still need it',

  /* —— unknown_job —— */
  'mcp.errors.unknown_job.listJobs':
    'Call list_jobs for the current job_id list (hint carries a copy)',
  'mcp.errors.unknown_job.sessionScoped':
    'A job_id is only valid **within the current MCP session** — a new session starts a fresh registry',

  /* —— no_text_content —— */
  'mcp.errors.no_text_content.noTextLayer':
    'This document has no text layer (image-only / scanned PDF) and this project has no OCR — **retrying the same file gives the same result**',
  'mcp.errors.no_text_content.convertToImage':
    'To see the content, use convert_file to turn it into png / jpg (one image per page) and hand that to a client that renders images',
  'mcp.errors.no_text_content.needsOcr': 'Getting text out needs the user to OCR this file first',

  /* —— not_readable —— */
  'mcp.errors.not_readable.supportedBodies':
    'read_document only reads document bodies: docx / xlsx / pdf / md / txt / html / rst / csv',
  'mcp.errors.not_readable.useInspectOrConvert':
    'Use inspect_file for media / image / archive details, and convert_file to change format',
  'mcp.errors.not_readable.heavyEngines':
    'For categories needing a heavy engine (doc/xls/ppt/odt/ods and ebooks) use convert_file, and tell the user how big the engine download is',

  /* —— internal —— */
  'mcp.errors.internal.retryOnce': 'Retry once with the same arguments',
  'mcp.errors.internal.reportToUser':
    'If it fails the same way twice, report this error verbatim to the user instead of retrying in a loop'
}
