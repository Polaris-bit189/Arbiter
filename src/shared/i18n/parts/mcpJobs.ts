/**
 * MCP 的任务登记表与工具注册 —— `src/mcp/jobs.ts` / `server.ts` / `plan.ts` /
 * `readPlan.ts` / `formatsView.ts`。
 *
 * ## P6 · 线 γ 独占这一片
 *
 * `jobs.ts` 是这一片的枢纽（任务的排队、预览、落点解析、失败回话都在那儿），
 * 其余几个是它周围的视图与计划。
 *
 * ## 三条口径
 *
 * - **一段一个键。** 源码里 `'…，' + '…。'` 那种两段拼接保持两段，不在字典里合成一句。
 * - **`mcp.formats.md*` 那几条是 `converter://formats` 的 markdown 正文**，不是界面文案：
 *   它们的读法是「agent 读一次就知道全局」，所以英文版要**照样能当说明书读**，
 *   不能把表格说明写成一句泛泛的话。
 * - **类别的六个名字不在这里**：它们早就住在 `@shared/i18n/keys.ts` 的
 *   `CATEGORY_LABEL`（`category.*`），`formatsView.ts` 现在读那一份。
 */
export const mcpJobsZh = {
  /* -------------------------------------------------- jobs.ts：校验与路由 */
  'mcp.jobs.unknownSourceExt': '认不出源文件的扩展名：{source}',
  'mcp.jobs.unknownSourceExtHint': '源文件必须带扩展名，比如 D:\\video\\a.mkv',
  'mcp.jobs.unknownSourceFormat': '不认识的源格式 .{ext}',
  'mcp.jobs.noTargets': '.{ext} 目前没有任何可用的目标格式',
  'mcp.jobs.targetNotSupported': '.{from} 转不了 .{to}',
  'mcp.jobs.targetNotSupportedHint':
    '请从 targets 里选一个。矩阵里没有的组合多半是实测过做不到，不是漏配。',
  'mcp.jobs.engineRouteMismatch':
    '内部不一致：.{from} → .{to} 在 targetsFor 里合法，却路由不到引擎',

  /* -------------------------------------------------- jobs.ts：引擎未就绪 */
  'mcp.jobs.engineMissing': '这条转换需要 {engine} 引擎，本机还没装好，无法执行。',
  'mcp.jobs.engineMissingHintHead': '请在 Arbiter（调律者转换器）的关于页里下载 {engine}，',
  'mcp.jobs.engineMissingHintTail': '或改用不需要该引擎的目标格式。',

  /* -------------------------------------------------- jobs.ts：产物落点 */
  'mcp.jobs.outputPathIsDir': 'output_path 指向的是一个**目录**，不是文件路径：{path}',
  'mcp.jobs.outputPathIsDirHint':
    'output_path 要写成产物的完整路径（含文件名），比如 D:\\out\\clip.jpg；想要落在某个目录里请改用 batch_convert 的 output_dir',
  'mcp.jobs.outputPathExists': 'output_path 上已经有一个文件了，不会往它上面写：{path}',
  'mcp.jobs.outputPathExistsHint':
    '这条转换没有覆盖它，一个字节都没动。换一个路径，或者先自己把那个文件移走 / 删掉，再原样重发这次调用。',

  /* -------------------------------------------------- jobs.ts：失败落定 */
  'mcp.jobs.failedNonZeroExit': '转换失败（引擎返回了非零退出码）',
  'mcp.jobs.internalStateLost': '内部状态异常：这个 job 既不在队列里也不在运行中',

  /* -------------------------------------------------- server.ts：工具标题 */
  'mcp.server.title.convertFile': '转换单个文件',
  'mcp.server.title.listFormats': '列出支持的格式',
  'mcp.server.title.inspectFile': '侦察一个文件',
  'mcp.server.title.batchConvert': '批量转换',
  'mcp.server.title.getJobStatus': '查询任务状态',
  'mcp.server.title.listJobs': '列出任务',
  'mcp.server.title.cancelJob': '取消任务',
  'mcp.server.title.readDocument': '读出文档正文',

  /* -------------------------------------------------- server.ts：工具回话 */
  'mcp.server.progressConverting': '转换中',
  'mcp.server.jobVanished': '这个 job 不见了（内部状态异常）',
  'mcp.server.unknownJob': '没有这个 job：{id}',
  'mcp.server.canceledNoOutput': '这个转换被取消了，没有产物。',
  'mcp.server.failed': '转换失败',
  'mcp.server.batchRejectedNote':
    '被拒的那些没有入队，每条的 code / next_steps 说明了原因与改法，修好后可以单独再调 batch_convert。',
  'mcp.server.batchQueuedNote':
    '全部已入队，用 list_jobs 一次看完整批（status:"failed" 看谁坏了）。',
  'mcp.server.batchAutoNote':
    'target_format 是 "{target}"：每条 job 的 to 是**各自**解析出来的实际目标格式，以它为准。',

  /* -------------------------------------------------- server.ts：resource */
  'mcp.server.resourceTitle': '能力矩阵',
  'mcp.server.resourceDescHead': '全部六个大类的转换能力，一张 markdown 表。读一次就知道全局，',
  'mcp.server.resourceDescTail': '不必用 list_supported_formats 来回试探。',

  /* -------------------------------------------------- plan.ts：预览的那句人话 */
  'mcp.plan.notePreviewOnly':
    '只预览：没有建任务、没有写任何文件、也没有占用产物名（不会把真实任务的落点挤成 `(1)`）。',
  'mcp.plan.noteSnapshot':
    '落点是按**此刻**的磁盘与占用情况算的；从这次预览到真跑之间若出现了同名文件，真跑会顺势避让成 `(1)`。',
  'mcp.plan.pkgSizeUnknown': '安装包体积未知（引擎清单读不到）',
  'mcp.plan.pkgSize': '安装包 {bytes} 字节',
  'mcp.plan.needEngineHead': '这条路要用按需引擎 {engine}（{size}）：',
  'mcp.plan.needEngineTail':
    '它**现在已就绪**（没装的话这一步就会被拒，不会给你预览），所以本次不会触发下载。',
  'mcp.plan.remuxBlockedHead': '⚠️ mode 给的是 remux，但 .{from} → .{to} 走不通重封装',
  'mcp.plan.remuxBlockedMid':
    '（方向或编解码器不在白名单里）：真跑会**直接失败**，不会自动回退成重编码。',
  'mcp.plan.remuxBlockedTail': '要它成功就去掉 mode（用 auto），或者换一个装得下的目标容器。',
  'mcp.plan.reencodeHead':
    'mode 给的是 reencode：这一步**不会走重封装**，estimate 里那条 high 置信度的重封装区间',
  'mcp.plan.reencodeTail': '（秒级）不适用于本次，按重编码那一档看。',
  'mcp.plan.scoutNote': '侦察没拿到全部信息（estimate 因此只是个宽频带）：{note}',

  /* -------------------------------------------------- readPlan.ts：三条拒绝 */
  'mcp.readPlan.noExt': '源文件没有扩展名，判断不了它是什么',
  'mcp.readPlan.noExtHint': '源文件必须带真实扩展名，别拿 .part / .tmp 这类中间文件来读',
  'mcp.readPlan.unknownFormat': '不认识的源格式 .{ext}',
  'mcp.readPlan.heavyHead': '.{ext} 读不了：它要先转成别的格式才能拿到文字，而那条路要 {engine}',
  'mcp.readPlan.heavyMid': '（安装包 {size}）。read_document 这一版不做这类转换——',
  'mcp.readPlan.heavyTail': '「这个文件写了啥」不该牵出一次几百 MB 的下载。',
  'mcp.readPlan.heavyHintHead':
    '最省事的是让用户在原应用里另存为 {save}，这些格式不用下引擎就能读；',
  'mcp.readPlan.heavyHintMid':
    '要用 {engine} 就改用 convert_file（它会在引擎缺失时点名说要下什么、多大），',
  'mcp.readPlan.heavyHintTail': '**并且先让用户确认**再下。',
  'mcp.readPlan.heavyStep1': '让用户把这份文件另存为 {save} 再读——那几种这一版直接支持',
  'mcp.readPlan.heavyStep2':
    '或者改用 convert_file：它会说明要下 {engine}（{size}），由用户决定要不要下',
  'mcp.readPlan.heavyStep3': '这一步**不要**自己重试：引擎不在位，重试一万次还是同一句拒绝',
  'mcp.readPlan.notReadable':
    'read_document 读的是**文档正文**，而 .{ext} 是 {category} 类，没有「正文」可读',
  'mcp.readPlan.notReadableHint':
    '音视频 / 图片 / 压缩包的信息用 inspect_file 查，要换格式用 convert_file',

  /* -------------------------------------------------- readPlan.ts：回落链 */
  'mcp.readPlan.fallbackNative':
    '.{ext} 没有 {requested} 出口，已按 {same} 原样返回（没有做任何转换）',
  'mcp.readPlan.fallbackConverted':
    '.{ext} 没有 {requested} 出口，已改按 {candidate} 返回（可选的是 {targets}）',
  'mcp.readPlan.noTextTarget': '.{ext} 没有可读的文本出口（能力矩阵给的是 {targets}）',
  'mcp.readPlan.emptyList': '空',

  /* -------------------------------------------------- formatsView.ts：视图 */
  'mcp.formats.unknownCategory': '未知类别 {category}；可用的是：{list}',
  'mcp.formats.itemSep': '、',
  'mcp.formats.groupSep': '；',

  /* -------------------------------------------------- formatsView.ts：markdown */
  'mcp.formats.mdTitle': '# Arbiter 能力矩阵：源格式 → 目标格式',
  'mcp.formats.mdDerivedHead':
    '> 本表由 `src/shared/formats.ts` **派生**，不要手改——矩阵改了这张表就跟着变，',
  'mcp.formats.mdDerivedTail': '> 对不上时 `scripts/test-mcp-view.ts` 会翻红。',
  'mcp.formats.mdHowToRead': '读法：',
  'mcp.formats.mdBullet1':
    '- 格式一律是小写、不带点的扩展名，源与目标都是这个口径（不要写成 .mp4 或 MP4）。',
  'mcp.formats.mdBullet2Head':
    '- 「要下载的出口」列写成 `docx` → `pandoc` 这种形式，意思是**只有这几个出口**要先装好该引擎；',
  'mcp.formats.mdBullet2Tail':
    '  没装时这些任务会失败或一直排队等下载。没列出来的出口不需要额外下载。',
  'mcp.formats.mdBullet3':
    '- `—` 表示没有内容（该源没有合法出口，或该出口不需要额外下载），不要拿它去拼 target_format。',
  'mcp.formats.mdBullet4':
    '- 同一类别内不同源格式的出口可以不一样，所以「某类别能转成 X」不等于该类别下每个源都能转成 X。',
  'mcp.formats.mdUnion': '目标格式并集：{list}',
  'mcp.formats.mdTableHeader': '| 源格式 | 可转为 | 要下载的出口 |'
} as const

export const mcpJobsEn: Record<keyof typeof mcpJobsZh, string> = {
  /* -------------------------------------------------- jobs.ts：校验与路由 */
  'mcp.jobs.unknownSourceExt': 'Cannot tell the source format from its extension: {source}',
  'mcp.jobs.unknownSourceExtHint': 'The source file needs an extension, e.g. D:\\video\\a.mkv',
  'mcp.jobs.unknownSourceFormat': 'Unknown source format .{ext}',
  'mcp.jobs.noTargets': '.{ext} has no usable target format',
  'mcp.jobs.targetNotSupported': 'Cannot convert .{from} to .{to}',
  'mcp.jobs.targetNotSupportedHint':
    'Pick one from targets. A combination missing from the matrix is usually one we measured as impossible, not an oversight.',
  'mcp.jobs.engineRouteMismatch':
    'Internal inconsistency: .{from} → .{to} is legal in targetsFor, yet routes to no engine',

  /* -------------------------------------------------- jobs.ts：引擎未就绪 */
  'mcp.jobs.engineMissing':
    'This conversion needs the {engine} engine, which is not installed on this machine, so it cannot run.',
  'mcp.jobs.engineMissingHintHead': "Download {engine} from Arbiter's About page, ",
  'mcp.jobs.engineMissingHintTail': 'or pick a target format that does not need that engine.',

  /* -------------------------------------------------- jobs.ts：产物落点 */
  'mcp.jobs.outputPathIsDir': 'output_path points at a **directory**, not a file path: {path}',
  'mcp.jobs.outputPathIsDirHint':
    'output_path must be the full path of the output file (file name included), e.g. D:\\out\\clip.jpg; to drop the output into a directory, use batch_convert with output_dir',
  'mcp.jobs.outputPathExists':
    'There is already a file at output_path, and nothing is written on top of it: {path}',
  'mcp.jobs.outputPathExistsHint':
    'This conversion did not touch it — not a single byte. Use another path, or move / delete that file yourself and then send the very same call again.',

  /* -------------------------------------------------- jobs.ts：失败落定 */
  'mcp.jobs.failedNonZeroExit': 'Conversion failed (the engine returned a non-zero exit code)',
  'mcp.jobs.internalStateLost': 'Internal state error: this job is neither queued nor running',

  /* -------------------------------------------------- server.ts：工具标题 */
  'mcp.server.title.convertFile': 'Convert a single file',
  'mcp.server.title.listFormats': 'List supported formats',
  'mcp.server.title.inspectFile': 'Inspect a file',
  'mcp.server.title.batchConvert': 'Convert a batch',
  'mcp.server.title.getJobStatus': 'Check job status',
  'mcp.server.title.listJobs': 'List jobs',
  'mcp.server.title.cancelJob': 'Cancel a job',
  'mcp.server.title.readDocument': 'Read document text',

  /* -------------------------------------------------- server.ts：工具回话 */
  'mcp.server.progressConverting': 'Converting',
  'mcp.server.jobVanished': 'That job is gone (internal state error)',
  'mcp.server.unknownJob': 'No such job: {id}',
  'mcp.server.canceledNoOutput': 'This conversion was canceled; there is no output.',
  'mcp.server.failed': 'Conversion failed',
  'mcp.server.batchRejectedNote':
    'The rejected ones were not queued; each one carries a code / next_steps explaining why and how to fix it. Once fixed, call batch_convert for them separately.',
  'mcp.server.batchQueuedNote':
    'All queued. Use list_jobs to see the whole batch at once (status:"failed" shows what broke).',
  'mcp.server.batchAutoNote':
    'target_format is "{target}": the to of each job is the target format **it** resolved, so go by that.',

  /* -------------------------------------------------- server.ts：resource */
  'mcp.server.resourceTitle': 'Capability matrix',
  'mcp.server.resourceDescHead':
    'The conversion capability of all six categories, as one markdown table. A single read tells you the whole picture, ',
  'mcp.server.resourceDescTail': 'so you need not probe with list_supported_formats.',

  /* -------------------------------------------------- plan.ts：预览的那句人话 */
  'mcp.plan.notePreviewOnly':
    'Preview only: no job was created, no file was written, and no output name was reserved (a real job will not be pushed to `(1)`).',
  'mcp.plan.noteSnapshot':
    'The output path is computed from the disk and the reservations **as of this moment**; if a file of that name appears between this preview and the real run, the real run will step aside to `(1)`.',
  'mcp.plan.pkgSizeUnknown': 'installer size unknown — the engine manifest could not be read',
  'mcp.plan.pkgSize': 'a {bytes}-byte installer',
  'mcp.plan.needEngineHead': 'This route needs the on-demand engine {engine} ({size}):',
  'mcp.plan.needEngineTail':
    'it is **ready right now** (without it, this step would have been rejected instead of previewed), so nothing will be downloaded this time.',
  'mcp.plan.remuxBlockedHead': '⚠️ mode is remux, but .{from} → .{to} cannot be remuxed',
  'mcp.plan.remuxBlockedMid':
    ' (the direction or its codecs are not on the whitelist): the real run will **fail outright** rather than fall back to re-encoding.',
  'mcp.plan.remuxBlockedTail':
    'For it to succeed, drop mode (use auto) or pick a target container that can hold it.',
  'mcp.plan.reencodeHead':
    'mode is reencode: this step **will not remux**, so the high-confidence remux range in estimate',
  'mcp.plan.reencodeTail': ' (seconds) does not apply here — read it as the re-encode tier.',
  'mcp.plan.scoutNote':
    'The probe did not get the full picture (estimate is therefore a wide band): {note}',

  /* -------------------------------------------------- readPlan.ts：三条拒绝 */
  'mcp.readPlan.noExt': 'The source file has no extension, so there is no telling what it is',
  'mcp.readPlan.noExtHint':
    'The source file needs its real extension — do not read intermediate files such as .part / .tmp',
  'mcp.readPlan.unknownFormat': 'Unknown source format .{ext}',
  'mcp.readPlan.heavyHead':
    'Cannot read .{ext}: it must first be converted to another format to get at its text, and that route needs {engine}',
  'mcp.readPlan.heavyMid':
    ' (a {size} installer). This version of read_document does not do that kind of conversion —',
  'mcp.readPlan.heavyTail':
    ' "what does this file say" should not drag in a download of a few hundred MB.',
  'mcp.readPlan.heavyHintHead':
    'The easiest way is to have the user save it as {save} from the original app — those formats need no engine;',
  'mcp.readPlan.heavyHintMid':
    'to use {engine}, switch to convert_file (when the engine is missing it names what would be downloaded and how big it is),',
  'mcp.readPlan.heavyHintTail': '**and ask the user first** before downloading.',
  'mcp.readPlan.heavyStep1':
    'Have the user save this file as {save} and read that — this version supports those directly',
  'mcp.readPlan.heavyStep2':
    'or switch to convert_file: it will say that {engine} ({size}) is needed, and the user decides whether to download it',
  'mcp.readPlan.heavyStep3':
    'Do **not** retry this one yourself: the engine is not installed, and retrying a thousand times gets the same refusal',
  'mcp.readPlan.notReadable':
    'read_document reads **document text**, and .{ext} is in the {category} category, which has no text to read',
  'mcp.readPlan.notReadableHint':
    'For audio / video / image / archive details use inspect_file; to change format use convert_file',

  /* -------------------------------------------------- readPlan.ts：回落链 */
  'mcp.readPlan.fallbackNative':
    '.{ext} has no {requested} output, so it is returned as-is as {same} (nothing was converted)',
  'mcp.readPlan.fallbackConverted':
    '.{ext} has no {requested} output, so it is returned as {candidate} instead (the options are {targets})',
  'mcp.readPlan.noTextTarget':
    '.{ext} has no readable text output (the capability matrix offers {targets})',
  'mcp.readPlan.emptyList': 'none',

  /* -------------------------------------------------- formatsView.ts：视图 */
  'mcp.formats.unknownCategory': 'Unknown category {category}; the available ones are: {list}',
  'mcp.formats.itemSep': ', ',
  'mcp.formats.groupSep': '; ',

  /* -------------------------------------------------- formatsView.ts：markdown */
  'mcp.formats.mdTitle': '# Arbiter capability matrix: source format → target format',
  'mcp.formats.mdDerivedHead':
    '> This table is **derived** from `src/shared/formats.ts` — do not edit it by hand: change the matrix and this table follows,',
  'mcp.formats.mdDerivedTail':
    '> and `scripts/test-mcp-view.ts` turns red once the two drift apart.',
  'mcp.formats.mdHowToRead': 'How to read it:',
  'mcp.formats.mdBullet1':
    '- Formats are lowercase extensions without the dot, for both source and target (never .mp4 or MP4).',
  'mcp.formats.mdBullet2Head':
    '- The "needs download" column reads like `docx` → `pandoc`, meaning **only those outputs** require that engine to be installed first;',
  'mcp.formats.mdBullet2Tail':
    '  without it those jobs fail or wait in the queue for the download. Outputs not listed need no extra download.',
  'mcp.formats.mdBullet3':
    '- `—` means nothing (the source has no legal output, or that output needs no extra download). Never use it as a target_format.',
  'mcp.formats.mdBullet4':
    '- Sources within one category can have different outputs, so "this category can produce X" does not mean every source in it can.',
  'mcp.formats.mdUnion': 'Union of target formats: {list}',
  'mcp.formats.mdTableHeader': '| Source | Can become | Needs download |'
}
