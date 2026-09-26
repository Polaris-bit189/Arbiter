/**
 * MCP 工具的**说明书** —— `src/mcp/schema.ts` 的 `TOOL_DESCRIPTIONS` 与各字段的 `.describe()`。
 *
 * ## P6 · 线 α 独占这一片
 *
 * ⚠️ **这些字是给模型读的 API 说明书，不是给界面读的文案。** 英文版必须**读起来像
 * 原生英文**，不是机翻——`convert_file` 一段就五十来行，它要说清「不给 output_path
 * 时落点由应用的输出目录设置决定」这类跨字段的坑，机翻等于把说明书作废。
 *
 * ⚠️ 字段级的 `.describe()` 会自动流进两个 JSON Schema 出口（MCP 的 `inputSchema`
 * 与 OpenAI 的 `parameters`），所以它们**必须留在 schema 上**，只是值改成 `t(...)`。
 *
 * ## 为什么一条片段一个键（而不是一个工具一句话）
 *
 * 键与 `src/mcp/schema.ts` 里**扫描片段**一一对应，顺序也一致。原文是一长串
 * `'…' + '…' + …` 拼出来的，扫描器按**每个字面量**记一段（138 段），所以字典也按段记。
 * 合成一句会**丢掉逐字节的对照物**——那段中文到底动没动过，就再也说不清了。
 * 口径就是 `scripts/test-i18n.ts` 的 `scanFile`，键名里的序号与它数出来的次序一一对应。
 *
 * ## ⚠️ 英文片段的**尾随空格是内容**，不是手滑
 *
 * 中文用全角标点，段与段直接相接（`…；` + `也可以…`）不需要空格；英文必须自己补一个，
 * 否则拼出来是 `not .mp4 or MP4.You can also pass`。所以 en 侧凡是「后面还要接一句」的
 * 片段都**以一个空格结尾**，与 zh 侧那个 `'…默认只给最近 '` 是同一条理由。
 * 改任何一条之前先看清楚它两头的空格——那是拼接契约的一部分。
 *
 * ⚠️ 六个片段原文里是 `${常量}`（`AUTO_TARGET` / `DEFAULT_LIST_LIMIT` / `MAX_LIST_LIMIT` /
 * `DEFAULT_READ_CHARS` / `MAX_READ_CHARS`），扫描器把值抹掉之后是空的，这里按原样补回
 * `{auto}` / `{limit}` / `{max}` / `{chars}` 占位符，由 `schema.ts` 传参——**常量仍然是
 * 唯一真相源**，别把 `auto` / `20` / `200` 写死在字典里。
 */

export const mcpToolsZh = {
  /* ---- 字段 · targetFormat ---- */
  'mcp.tools.field.targetFormat.head':
    '不带点的目标扩展名，如 mp4 / mp3 / pdf，不要写成 .mp4 或 MP4；',
  'mcp.tools.field.targetFormat.tail':
    '也可以传保留字 "{auto}"，表示用应用里配置的**默认目标格式**（仍会过一遍能力矩阵校验）',

  /* ---- 字段 · jobId ---- */
  'mcp.tools.field.jobId': 'convert_file / batch_convert 返回的 job_id',

  /* ---- 字段 · verify ---- */
  'mcp.tools.field.verify.01':
    '转换完成后对产物做一次自检（默认 false）。打开时返回值里会多一个 verification：',
  'mcp.tools.field.verify.02':
    '用 inspect_file 那同一套侦察链路把源与产物各读一遍，逐项对照分辨率 / 视频编解码器 / ',
  'mcp.tools.field.verify.03':
    '有没有音轨 / 时长，**只报事实、不打分**（不做 PSNR 那类画质判断）。',
  'mcp.tools.field.verify.04':
    '⚠️ 判据刻意宽：换容器会重新分装（ts → mp4 的时长会对不齐）、gif 与图片根本没有音轨和时长，',
  'mcp.tools.field.verify.05': '这些都写进 notes 而不是判成「不一致」。',
  'mcp.tools.field.verify.06':
    '⚠️ 代价是**每个任务多两个引擎子进程**（源一个、产物一个），批量几十个文件时这笔账不小，',
  'mcp.tools.field.verify.07': '所以默认关，只在「这一次的产物很重要」时打开',

  /* ---- 字段 · dryRun ---- */
  'mcp.tools.field.dryRun.01':
    '只预览、不执行（默认 false）。为 true 时**不建任务、不写任何文件、也不占用产物名**，',
  'mcp.tools.field.dryRun.02':
    '返回一份「会发生什么」：落点 output（此刻磁盘上还没有它）、实际用到的 to、engine、',
  'mcp.tools.field.dryRun.03':
    'cost（要准备的引擎与体积）、lossy（有没有损）、estimate（耗时区间 + confidence）。',
  'mcp.tools.field.dryRun.04':
    '校验走的是与真跑**同一个函数**，所以预览说不行时返回的就是真跑会返回的那个错误',
  'mcp.tools.field.dryRun.05': '（同一个 code / next_steps / 文案），不是另写一句。',
  'mcp.tools.field.dryRun.06':
    '⚠️ 落点是**此刻**算的：从预览到真跑之间若出现了同名文件，真跑会顺势避让成 `(1)`。',

  /* ---- 字段 · priority ---- */
  'mcp.tools.field.priority.01':
    '排队优先级，越大越先跑（默认 0）。**只影响还在排队的那些**——已经在跑的任务',
  'mcp.tools.field.priority.02':
    '永远不会被抢，转换没有「暂停」这回事。批量时用它把几个急着要的文件插到前面。',

  /* ---- 字段 · convertSource ---- */
  'mcp.tools.field.convertSource': '待转换文件的绝对路径',

  /* ---- 字段 · convertOutputPath ---- */
  'mcp.tools.field.convertOutputPath':
    '产物的完整文件路径（含文件名），不是目录；不传时落点由应用的输出目录设置决定',

  /* ---- 字段 · convertMode ---- */
  'mcp.tools.field.convertMode':
    'auto=能重封装就重封装；remux=只准重封装，容器不兼容会直接失败；reencode=强制重编码',

  /* ---- 字段 · formatCategory ---- */
  'mcp.tools.field.formatCategory': '只列这一类；不传则返回全部六类',

  /* ---- 字段 · inspectPath ---- */
  'mcp.tools.field.inspectPath': '要侦察的文件的绝对路径',

  /* ---- 字段 · batchSources ---- */
  'mcp.tools.field.batchSources': '待转换文件的绝对路径列表，至少要有一个',

  /* ---- 字段 · batchTargetFormat ---- */
  'mcp.tools.field.batchTargetFormat.01':
    '这一批共用的目标扩展名，不带点；传保留字 "auto" 时**每个源各按自己的能力矩阵与用户偏好**解析',
  'mcp.tools.field.batchTargetFormat.02':
    '（混合目录的常态：一条 batch 里 png 走图片偏好、mp4 走视频偏好），实际用到的是每条 job 回显的 to',

  /* ---- 字段 · batchOutputDir ---- */
  'mcp.tools.field.batchOutputDir':
    '产物的输出目录（不是文件路径）；不传时落点由应用的输出目录设置决定',

  /* ---- 字段 · jobStatus ---- */
  'mcp.tools.field.jobStatus':
    '只看这一种状态；unfinished = queued 或 running（还没落定的）。不传则全部',

  /* ---- 字段 · listLimit ---- */
  'mcp.tools.field.listLimit.01': '最多返回几条（默认 {limit}，上限 {max}，超过按上限算）。',
  'mcp.tools.field.listLimit.02': '返回里的 truncated 说明有没有被截断',

  /* ---- 字段 · listSince ---- */
  'mcp.tools.field.listSince':
    '只返回 created_at >= 这个**毫秒时间戳**的 job（增量轮询用）；不传则不过滤',

  /* ---- 字段 · readSource ---- */
  'mcp.tools.field.readSource':
    '要读的文档的绝对路径。支持 docx / xlsx / pdf / md / txt / html / rst / csv',

  /* ---- 字段 · readFormat ---- */
  'mcp.tools.field.readFormat.01': '想要的文本形态：md / txt / csv（默认 md）。',
  'mcp.tools.field.readFormat.02':
    '源格式没有这个出口时会**回落到它支持的另一种**并在 warnings 里说明，',
  'mcp.tools.field.readFormat.03':
    '实际给到的是返回值里的 format——以那一个为准，不要假定等于这里传的',

  /* ---- 字段 · readMaxChars ---- */
  'mcp.tools.field.readMaxChars.01':
    '这次最多返回多少字符（默认 {chars}，上限 {max}，超过按上限算）。',
  'mcp.tools.field.readMaxChars.02': '被截断时 truncated 为 true，用 offset 接着读',

  /* ---- 字段 · readOffset ---- */
  'mcp.tools.field.readOffset':
    '从正文的第几个字符开始（默认 0）。续读时传「上次的 offset + 实际拿到的字符数」',

  /* ---- 说明书 · convert_file ---- */
  'mcp.tools.desc.convert_file.01':
    '转换单个文件，**等它跑完再返回**（转视频可能几分钟），过程中持续汇报进度。',
  'mcp.tools.desc.convert_file.02':
    '**它是阻塞的：调用返回时转换已经结束了**，返回值里的 status 就是最终状态——',
  'mcp.tools.desc.convert_file.03':
    '不要在这个调用返回之后再去轮询 get_job_status，那等于在查一个已经跑完的任务。',
  'mcp.tools.desc.convert_file.04':
    '（要查的是**别的**任务时，用 list_jobs 一次问一批。等很多个结果时先用 batch_convert 拿 job_id，',
  'mcp.tools.desc.convert_file.05': '再用 list_jobs 看整批。）',
  'mcp.tools.desc.convert_file.06':
    'source 必须是文件的绝对路径；target_format 是不带点的扩展名（如 mp4），不是 MIME 也不是带点的后缀。',
  'mcp.tools.desc.convert_file.07':
    '给了 output_path 就必须是产物的完整文件路径（含文件名），给成目录会失败。',
  'mcp.tools.desc.convert_file.08':
    '不给 output_path 时落点由**应用的输出目录设置**决定：设了「输出到指定目录」就去那里，',
  'mcp.tools.desc.convert_file.09':
    '否则才落在源文件旁边（同名，只换扩展名）。**不要假定产物在源文件旁边**——',
  'mcp.tools.desc.convert_file.10': '以返回值里的 output 为准，拿不准就用 get_job_status 查。',
  'mcp.tools.desc.convert_file.11':
    '目标格式必须是该源格式的合法目标之一——不确定就先调 inspect_file。',
  'mcp.tools.desc.convert_file.12':
    'target_format 也可以传保留字 "{auto}"：表示用**应用里配置的默认目标格式**',
  'mcp.tools.desc.convert_file.13':
    '（叠了用户偏好的那一档，且仍会过一遍能力矩阵校验），不传就是让工具替用户挑一个。',
  'mcp.tools.desc.convert_file.14':
    'mode 默认 auto：能安全重封装就重封装（实测快一个数量级），否则重编码；显式传 remux 是「只准重封装」——',
  'mcp.tools.desc.convert_file.15':
    '目标容器装不下源的编解码器时**直接失败，不会回退成重编码**，只有在已确认兼容时才用它。',
  'mcp.tools.desc.convert_file.16':
    '`verify: true` 时返回值里会多一个 `verification`：用 `inspect_file` 那**同一套**侦察链路把源与产物',
  'mcp.tools.desc.convert_file.17':
    '各读一遍，逐项对照分辨率 / 视频编解码器 / 有没有音轨 / 时长，**只报事实、不打分**',
  'mcp.tools.desc.convert_file.18':
    '（不做 PSNR 那类画质判断）。⚠️ 判据刻意宽：换容器会重新分装（ts → mp4 的时长会对不齐）、',
  'mcp.tools.desc.convert_file.19':
    'gif 与图片本来就没有音轨和时长，这些都写进 `notes` 而不是判成「不一致」；',
  'mcp.tools.desc.convert_file.20':
    '`checked` 列出这次**实际查了**哪几项，`status: "consistent"` 要配着它读——**没查到的项目不算**。',
  'mcp.tools.desc.convert_file.21':
    '⚠️ 它给每个任务**多起两个引擎子进程**（源一个、产物一个），所以默认关，',
  'mcp.tools.desc.convert_file.22': '只在这一次的产物很重要时打开；批量几十个文件时那笔账不小。',
  'mcp.tools.desc.convert_file.23':
    '`dry_run: true` 时**只预览、不执行**：不建任务、不写任何文件、**也不占用产物名**',
  'mcp.tools.desc.convert_file.24':
    '（不会把真实任务的落点挤成 `(1)`）。返回一份「会发生什么」——`output`（落点，此刻磁盘上还没有它）、',
  'mcp.tools.desc.convert_file.25':
    '实际用到的 `to`（传 auto 时它是算出来的）、`engine`、`cost`（要准备的引擎与体积）、',
  'mcp.tools.desc.convert_file.26':
    '`lossy`（有没有损）、`estimate`（耗时**区间** + `confidence`），外加一句 `note`。',
  'mcp.tools.desc.convert_file.27':
    '**它走的是与真跑同一个校验函数**，所以预览说不行时返回的就是真跑会返回的那**同一个错误**',
  'mcp.tools.desc.convert_file.28': '（同一份 code / next_steps / 文案，不是另写一句中文）。',
  'mcp.tools.desc.convert_file.29':
    '⚠️ 落点是**此刻**算的：从预览到真跑之间若磁盘上出现了同名文件，真跑会顺势避让成 `(1)`。',
  'mcp.tools.desc.convert_file.30':
    '拿不准目标格式合不合法、值不值得等、要不要让用户先确认下载引擎时，**先 dry_run 一次**。',
  'mcp.tools.desc.convert_file.31':
    '⚠️ 调用被客户端取消时（发 notifications/cancelled）本调用**不会再返回任何东西**，',
  'mcp.tools.desc.convert_file.32':
    '这是 MCP 的约定、不是出错；这时要查结果只能靠 get_job_status 或 list_jobs。',
  'mcp.tools.desc.convert_file.33':
    '**失败时返回的不是一句中文，而是一个机器可读的对象**：`code`（闭集，如 ',
  'mcp.tools.desc.convert_file.34':
    'source_corrupt / engine_missing / target_not_supported）、`retryable`（同样参数重试有没有意义）、',
  'mcp.tools.desc.convert_file.35':
    '`next_steps`（下一步做什么），以及 `log_tail`（引擎的 stderr 尾部）。',
  'mcp.tools.desc.convert_file.36':
    '**先看 log_tail，它才是引擎给的原始原因**；`code` 只负责告诉你该不该重试。',

  /* ---- 说明书 · list_supported_formats ---- */
  'mcp.tools.desc.list_supported_formats.01':
    '列出能力矩阵：每个类别下有哪些源格式、各自能转成哪些目标格式。它只回答「支持不支持」，不做任何转换。',
  'mcp.tools.desc.list_supported_formats.02':
    '不传 category 时返回全部六类。**拼 target_format 之前先查这里或 inspect_file**——合法目标随源格式而变',
  'mcp.tools.desc.list_supported_formats.03':
    '（mkv 转不了 mkv；HEIC 与 SVG 源没有 bmp/ico 出口），猜错了 convert_file 会直接报错。',
  'mcp.tools.desc.list_supported_formats.04':
    '想一次看懂全局，优先读 converter://formats 那份 markdown，不必反复调这个工具试探。',

  /* ---- 说明书 · inspect_file ---- */
  'mcp.tools.desc.inspect_file.01':
    '转换前侦察一个文件：类别、源格式、体积、有哪些合法出口、要不要下载引擎；',
  'mcp.tools.desc.inspect_file.02': '音视频还会给出时长、分辨率与编解码器，压缩包给条目数。',
  'mcp.tools.desc.inspect_file.03':
    '**决定目标格式之前先调它**：合法目标是从源格式问答出来的，不是猜出来的。它只读元数据，不改动、不转换文件。',
  'mcp.tools.desc.inspect_file.04': '还会给三样**算账用**的东西，都按**默认目标格式**算：',
  'mcp.tools.desc.inspect_file.05':
    '`cost`（`engine` 要准备哪个引擎、`download_bytes` 安装包多大、`unpacked_bytes` 解包后多大、',
  'mcp.tools.desc.inspect_file.06': '`network_required` 这条路是否依赖一个按需下载的重型引擎）、',
  'mcp.tools.desc.inspect_file.07':
    '`lossy`（这一步会不会丢信息：true=一定有损、false=存在无损通路、null=判不了）、',
  'mcp.tools.desc.inspect_file.08':
    '`estimate`（耗时**区间** `seconds: [下限, 上限]` 秒 + `confidence`）。',
  'mcp.tools.desc.inspect_file.09': '⚠️ `estimate` 是**区间不是承诺**，而且**先看 `confidence`**：',
  'mcp.tools.desc.inspect_file.10':
    '`high` 才能照着安排等待，`medium` / `low` 只够判断「秒级还是分钟级」。',
  'mcp.tools.desc.inspect_file.11':
    '⚠️ 要别的目标格式时这三个数**不适用**——先看 `targets` 列出的合法目标，',
  'mcp.tools.desc.inspect_file.12': '`cost` 只说默认目标那一条路。',
  'mcp.tools.desc.inspect_file.13':
    '⚠️ 体积与引擎来自运行时读安装清单，读不到时是 `null`（**不是 0**）：0 的含义是「这条路不用下东西」。',

  /* ---- 说明书 · batch_convert ---- */
  'mcp.tools.desc.batch_convert.01':
    '一次转换多个文件，共用同一个 target_format，适合「一批同格式的素材」。',
  'mcp.tools.desc.batch_convert.02':
    '**立刻返回一组 job_id，不等转换完成**，用 list_jobs 一次看完整批（**不要**对着返回的 job_id 逐个 get_job_status）。',
  'mcp.tools.desc.batch_convert.03':
    '某个源不合法只影响它自己（会出现在 rejected 里，每条都带 code / retryable / next_steps），',
  'mcp.tools.desc.batch_convert.04': '其余照常入队——所以拿到返回值后要看一眼 rejected。',
  'mcp.tools.desc.batch_convert.05':
    '混合目录里 target_format 传保留字 "{auto}"：每个源**各按自己的能力矩阵与用户偏好**解析目标',
  'mcp.tools.desc.batch_convert.06':
    '（一批里 png 走图片偏好、mp4 走视频偏好），实际用到的是每条 job 回显的 `to`——**以它为准**，不要假定整批同一个目标。',
  'mcp.tools.desc.batch_convert.07':
    '不给 output_dir 时落点由**应用的输出目录设置**决定：设了「输出到指定目录」时整批聚到那一个目录，',
  'mcp.tools.desc.batch_convert.08':
    '否则才各自落在它自己的源文件旁边。**以每个 job 返回的 output 为准**，不要假定它们散在源文件旁边。',
  'mcp.tools.desc.batch_convert.09':
    '`verify: true` 会给**每条 job** 做一次产物自检（判据与 convert_file 那份逐字相同），',
  'mcp.tools.desc.batch_convert.10':
    '于是它在这里的代价是**源文件数的两倍**那么多子进程——批量时先想清楚值不值。',
  'mcp.tools.desc.batch_convert.11':
    '结果随 `list_jobs` 的 `verification_status` 与 `get_job_status` 的 `verification` 一起给出。',

  /* ---- 说明书 · get_job_status ---- */
  'mcp.tools.desc.get_job_status.01':
    '查**一个**任务的进度与结果。job_id 来自 convert_file / batch_convert 的返回。',
  'mcp.tools.desc.get_job_status.02':
    '任务结束时会给出产物路径与体积；失败时给出错误摘要、机器可读的 error_code 与引擎的 stderr 尾部——',
  'mcp.tools.desc.get_job_status.03':
    '**要读 stderr 尾部（`log_tail`），那里才是引擎给的原始原因**（比如 ffmpeg 具体是哪个参数不对），',
  'mcp.tools.desc.get_job_status.04':
    '只看到「转换失败」等于没有信息。`log_tail` **只有这个工具给**（列表里刻意不带，几十条 stderr 会把上下文吃掉）。',
  'mcp.tools.desc.get_job_status.05':
    '还在跑时给出百分比；pandoc / LibreOffice 这类引擎只能给阶段文案，**没有百分比是正常的**，不要据此判定卡死。',
  'mcp.tools.desc.get_job_status.06':
    '提交时开了 `verify` 的任务，结束时还会带一个 `verification`（字段含义见 convert_file 的说明）：',
  'mcp.tools.desc.get_job_status.07':
    '它是任务**落定之前**算好的，所以**哪一次查都一样**，不会出现「第一次查还没有、第二次才有」。',

  /* ---- 说明书 · list_jobs ---- */
  'mcp.tools.desc.list_jobs.01':
    '一次列出**一批**任务的进度与结果（`counts` 是全局计数，`jobs` 是筛出来的那几条，默认只给最近 ',
  'mcp.tools.desc.list_jobs.02': '{limit} 条、上限 {max} 条，被砍时 truncated 为 true）。',
  'mcp.tools.desc.list_jobs.03':
    '**转完一批文件之后用它，而不是把 batch_convert 返回的 job_id 逐个 get_job_status**：',
  'mcp.tools.desc.list_jobs.04': '30 个文件一次调用就能看清谁好谁坏。',
  'mcp.tools.desc.list_jobs.05':
    '常用姿势：status:"failed" 看谁坏了、status:"unfinished" 看还剩几个在跑（= queued + running）、',
  'mcp.tools.desc.list_jobs.06': 'since 传上一次返回里最大的 created_at 做增量。',
  'mcp.tools.desc.list_jobs.07':
    '**列表里刻意不给 log_tail**（几十条 stderr 尾部的 token 代价与它带来的信息完全不成比例）——',
  'mcp.tools.desc.list_jobs.08': '要在哪一条上读引擎原始报错，就用 get_job_status 单独查那一条。',
  'mcp.tools.desc.list_jobs.09':
    '开了 `verify` 的任务在这里只给一个 `verification_status`（consistent / differs / unknown），',
  'mcp.tools.desc.list_jobs.10':
    '完整的事实清单同样要用 get_job_status 单独查那一条（理由与 log_tail 一字不差）。',

  /* ---- 说明书 · cancel_job ---- */
  'mcp.tools.desc.cancel_job.01':
    '取消一个排队中或运行中的任务。它会**连整棵进程树一起杀掉**——LibreOffice 会拉起 soffice.bin，',
  'mcp.tools.desc.cancel_job.02':
    '只杀父进程会留下占着 profile 锁的孤儿进程，之后所有同类转换都会静默失败。',
  'mcp.tools.desc.cancel_job.03':
    '已经结束的任务取消是空操作，返回值会如实说明它当时的状态。取消**不会留下任何残留**——',
  'mcp.tools.desc.cancel_job.04':
    '各引擎的 `.part` 临时文件在取消时都会被删掉（实测：取消后目录里既没有产物也没有 .part）。',

  /* ---- 说明书 · read_document ---- */
  'mcp.tools.desc.read_document.01':
    '**直接读出文档的正文**，一次调用拿到文字，不必先 inspect_file、再 convert_file、',
  'mcp.tools.desc.read_document.02':
    '再去读那个产物（那是三次调用，而且产物还可能落在读不到的目录里）。',
  'mcp.tools.desc.read_document.03':
    '支持 `.docx`（→ md/txt）、`.xlsx`（→ csv）、文本型 `.pdf`（→ txt/md）、',
  'mcp.tools.desc.read_document.04':
    '以及本来就是文字的 `.md` / `.txt` / `.html` / `.rst` / `.csv`。',
  'mcp.tools.desc.read_document.05':
    '**它不写任何文件**：中间产物只落在系统临时目录里，用完就删，所以不会往用户的输出目录里丢东西。',
  'mcp.tools.desc.read_document.06':
    '⚠️ **需要重型引擎的格式这一版明确不支持，别拿它去试**：`doc` / `xls` / `ppt` / `odt` / `ods` ',
  'mcp.tools.desc.read_document.07':
    '要 LibreOffice（安装包 357 MiB），`epub` / `mobi` / `azw3` 要 Calibre（213 MiB）。',
  'mcp.tools.desc.read_document.08':
    '读一份文件的正文不该牵出一次几百 MB 的下载；这类文件要用 convert_file（它会在引擎缺失时',
  'mcp.tools.desc.read_document.09':
    '明确告诉你要下哪个、多大），**并且先让用户确认**。音视频 / 图片 / 压缩包没有「正文」，这个工具会直接拒。',
  'mcp.tools.desc.read_document.10':
    '⚠️ **图片型 / 扫描件 PDF 抽不出文字**（页面里只有图，没有文本层）。这种时候返回的是**错误**而不是空文本，',
  'mcp.tools.desc.read_document.11':
    '本项目不含 OCR——**重试不会有不同结果**，要看内容就改用 convert_file 转成 png/jpg 交给能看图的客户端。',
  'mcp.tools.desc.read_document.12':
    'format 默认 md；源格式没有这个出口时会回落到它支持的另一种，并在返回值的 warnings 里说明，',
  'mcp.tools.desc.read_document.13': '**实际拿到的是返回值里的 format**，以它为准。',
  'mcp.tools.desc.read_document.14':
    '结果是**截断**的：默认最多 20000 字符，`truncated: true` 时用 offset 接着读',
  'mcp.tools.desc.read_document.15':
    '（传上次的 offset + 这次实际拿到的字符数），total_chars 是整个正文的长度、不是这一段的长度。'
} as const

export const mcpToolsEn: Record<keyof typeof mcpToolsZh, string> = {
  /* ---- 字段 · targetFormat ---- */
  'mcp.tools.field.targetFormat.head':
    'Target extension without the dot, e.g. mp4 / mp3 / pdf - not .mp4 or MP4. ',
  'mcp.tools.field.targetFormat.tail':
    'You can also pass the reserved word "{auto}", meaning **the default target format configured in the app** (it still goes through the capability-matrix check)',

  /* ---- 字段 · jobId ---- */
  'mcp.tools.field.jobId': 'job_id returned by convert_file / batch_convert',

  /* ---- 字段 · verify ---- */
  'mcp.tools.field.verify.01':
    'Verify the output once the conversion finishes (default false). When on, the return value gains one extra field, verification: ',
  'mcp.tools.field.verify.02':
    'it reads the source and the output through the **same** inspection pipeline that inspect_file uses, comparing them item by item on resolution / video codec / ',
  'mcp.tools.field.verify.03':
    'presence of an audio track / duration, **reporting facts only, never a score** (no PSNR-style quality judgement). ',
  'mcp.tools.field.verify.04':
    '⚠️ The criteria are deliberately loose: switching containers remuxes the streams (a ts → mp4 duration will not line up exactly), and gif or image outputs have no audio track or duration at all, ',
  'mcp.tools.field.verify.05':
    'so all of that goes into notes instead of being reported as "differs". ',
  'mcp.tools.field.verify.06':
    '⚠️ The cost is **two extra engine child processes per job** (one for the source, one for the output), which adds up quickly across dozens of files, ',
  'mcp.tools.field.verify.07':
    'which is why it is off by default; turn it on only when this particular output matters',

  /* ---- 字段 · dryRun ---- */
  'mcp.tools.field.dryRun.01':
    'Preview only, never execute (default false). When true it **creates no job, writes no file, and reserves no output name**, ',
  'mcp.tools.field.dryRun.02':
    'returning a description of what would happen: the landing spot output (which is not on disk yet), the to actually used, engine, ',
  'mcp.tools.field.dryRun.03':
    'cost (the engine to prepare and how large it is), lossy (whether anything is lost), estimate (a time **range** plus confidence). ',
  'mcp.tools.field.dryRun.04':
    'Validation goes through the **same function** as a real run, so when the preview says no you get the very error a real run would return ',
  'mcp.tools.field.dryRun.05':
    '(the same code / next_steps / wording), not a sentence written just for the preview. ',
  'mcp.tools.field.dryRun.06':
    '⚠️ The landing spot is computed **right now**: if a file with that name appears between preview and run, the real run dodges to `(1)`.',

  /* ---- 字段 · priority ---- */
  'mcp.tools.field.priority.01':
    'Queue priority; higher runs first (default 0). **It only affects jobs that are still queued** - a job that is already running ',
  'mcp.tools.field.priority.02':
    'is never preempted; there is no such thing as pausing a conversion. Use it on a batch to move a few urgent files to the front.',

  /* ---- 字段 · convertSource ---- */
  'mcp.tools.field.convertSource': 'Absolute path of the file to convert',

  /* ---- 字段 · convertOutputPath ---- */
  'mcp.tools.field.convertOutputPath':
    "Full file path of the output (including the file name), not a directory; when omitted, the landing spot is decided by the app's output-directory setting",

  /* ---- 字段 · convertMode ---- */
  'mcp.tools.field.convertMode':
    'auto=remux when that is safe, otherwise re-encode; remux=remux only, so an incompatible container fails outright; reencode=force a re-encode',

  /* ---- 字段 · formatCategory ---- */
  'mcp.tools.field.formatCategory': 'List only this category; omit it to get all six',

  /* ---- 字段 · inspectPath ---- */
  'mcp.tools.field.inspectPath': 'Absolute path of the file to inspect',

  /* ---- 字段 · batchSources ---- */
  'mcp.tools.field.batchSources': 'List of absolute paths to convert; at least one is required',

  /* ---- 字段 · batchTargetFormat ---- */
  'mcp.tools.field.batchTargetFormat.01':
    'Target extension shared by the whole batch, without the dot; with the reserved word "auto", **each source resolves its target from its own capability matrix and the user\'s preferences** ',
  'mcp.tools.field.batchTargetFormat.02':
    '(the usual shape of a mixed directory: within one batch png follows the image preference and mp4 the video preference), and what is actually used is the to echoed by each job',

  /* ---- 字段 · batchOutputDir ---- */
  'mcp.tools.field.batchOutputDir':
    "Output directory for the results (not a file path); when omitted, the landing spots are decided by the app's output-directory setting",

  /* ---- 字段 · jobStatus ---- */
  'mcp.tools.field.jobStatus':
    'Only show this status; unfinished = queued or running (not settled yet). Omit it to get everything',

  /* ---- 字段 · listLimit ---- */
  'mcp.tools.field.listLimit.01':
    'How many entries to return at most (default {limit}, cap {max}; anything above the cap is clamped). ',
  'mcp.tools.field.listLimit.02': 'truncated in the result tells you whether it was cut off',

  /* ---- 字段 · listSince ---- */
  'mcp.tools.field.listSince':
    'Only return jobs with created_at >= this **millisecond timestamp** (for incremental polling); omit it to filter nothing',

  /* ---- 字段 · readSource ---- */
  'mcp.tools.field.readSource':
    'Absolute path of the document to read. Supports docx / xlsx / pdf / md / txt / html / rst / csv',

  /* ---- 字段 · readFormat ---- */
  'mcp.tools.field.readFormat.01': 'Text form you want: md / txt / csv (default md). ',
  'mcp.tools.field.readFormat.02':
    'When the source format has no such exit it **falls back to another one it supports** and says so in warnings; ',
  'mcp.tools.field.readFormat.03':
    'what you actually get is the format in the return value - go by that one, do not assume it equals what you passed here',

  /* ---- 字段 · readMaxChars ---- */
  'mcp.tools.field.readMaxChars.01':
    'Maximum number of characters to return this time (default {chars}, cap {max}; anything above the cap is clamped). ',
  'mcp.tools.field.readMaxChars.02': 'when it is cut off, truncated is true; continue with offset',

  /* ---- 字段 · readOffset ---- */
  'mcp.tools.field.readOffset':
    'Character index in the body to start from (default 0). To continue reading, pass "the previous offset + the number of characters you actually got"',

  /* ---- 说明书 · convert_file ---- */
  'mcp.tools.desc.convert_file.01':
    'Convert a single file, **returning only after it finishes** (a video can take minutes), reporting progress along the way. ',
  'mcp.tools.desc.convert_file.02':
    '**The call is blocking: by the time it returns, the conversion is over**, and the status in the return value is final - ',
  'mcp.tools.desc.convert_file.03':
    'do not poll get_job_status after this call returns; that is just querying a job that has already finished. ',
  'mcp.tools.desc.convert_file.04':
    '(When the job you want to check is a **different** one, ask about a whole batch at once with list_jobs. When waiting on many results, start with batch_convert to get job_ids ',
  'mcp.tools.desc.convert_file.05': 'and then watch the whole batch with list_jobs.) ',
  'mcp.tools.desc.convert_file.06':
    'source must be an absolute path; target_format is an extension without the dot (e.g. mp4) - not a MIME type, not a suffix with a dot. ',
  'mcp.tools.desc.convert_file.07':
    'If you pass output_path it must be the full file path of the output (including the file name); passing a directory fails. ',
  'mcp.tools.desc.convert_file.08':
    'When output_path is omitted, the landing spot is decided by **the app\'s output-directory setting**: if "output to a specific directory" is set, the file goes there, ',
  'mcp.tools.desc.convert_file.09':
    'otherwise it lands next to the source file (same name, only the extension changes). **Do not assume the output sits next to the source file** - ',
  'mcp.tools.desc.convert_file.10':
    'go by the output in the return value, and when unsure, look it up with get_job_status. ',
  'mcp.tools.desc.convert_file.11':
    'The target format must be one of the legal targets of that source format - when unsure, call inspect_file first. ',
  'mcp.tools.desc.convert_file.12':
    'target_format also accepts the reserved word "{auto}", meaning **the default target format configured in the app** ',
  'mcp.tools.desc.convert_file.13':
    "(the one that layers the user's preferences on top, and it still goes through the capability-matrix check); omitting it lets the tool pick one for the user. ",
  'mcp.tools.desc.convert_file.14':
    'mode defaults to auto: remux when that is safe (measured an order of magnitude faster), otherwise re-encode; passing remux explicitly means "remux only" - ',
  'mcp.tools.desc.convert_file.15':
    'when the target container cannot hold the source codecs it **fails outright instead of falling back to re-encoding**, so use it only when compatibility is already confirmed. ',
  'mcp.tools.desc.convert_file.16':
    'With `verify: true` the return value gains one extra field, `verification`: it reads the source and the output through **the same** inspection pipeline as `inspect_file` ',
  'mcp.tools.desc.convert_file.17':
    'and compares them item by item on resolution / video codec / presence of an audio track / duration, **reporting facts only, never a score** ',
  'mcp.tools.desc.convert_file.18':
    '(no PSNR-style quality judgement). ⚠️ The criteria are deliberately loose: switching containers remuxes the streams (a ts → mp4 duration will not line up exactly), ',
  'mcp.tools.desc.convert_file.19':
    'gif and image outputs have no audio track or duration to begin with, and all of that goes into `notes` instead of being reported as "differs"; ',
  'mcp.tools.desc.convert_file.20':
    '`checked` lists the items that were **actually examined** this time, and `status: "consistent"` has to be read together with it - **items that were not examined do not count**. ',
  'mcp.tools.desc.convert_file.21':
    '⚠️ It **starts two extra engine child processes per job** (one for the source, one for the output), which is why it is off by default; ',
  'mcp.tools.desc.convert_file.22':
    'turn it on only when this particular output matters; across dozens of files that bill is not small. ',
  'mcp.tools.desc.convert_file.23':
    'With `dry_run: true` it **only previews, never executes**: no job is created, no file is written, and **no output name is reserved** ',
  'mcp.tools.desc.convert_file.24':
    "(so a real job's landing spot is not pushed aside to `(1)`). It returns a description of what would happen - `output` (the landing spot, which is not on disk yet), ",
  'mcp.tools.desc.convert_file.25':
    'the `to` actually used (computed when you passed auto), `engine`, `cost` (the engine to prepare and how large it is), ',
  'mcp.tools.desc.convert_file.26':
    '`lossy` (whether anything is lost), `estimate` (a time **range** plus `confidence`), and one sentence of `note`. ',
  'mcp.tools.desc.convert_file.27':
    '**It runs the same validation function as a real run**, so when the preview says no you get the **very same error** a real run would return ',
  'mcp.tools.desc.convert_file.28':
    '(the same code / next_steps / wording, not a sentence written just for the preview). ',
  'mcp.tools.desc.convert_file.29':
    '⚠️ The landing spot is computed **right now**: if a file with that name shows up on disk between preview and run, the real run dodges to `(1)`. ',
  'mcp.tools.desc.convert_file.30':
    'When you are unsure whether a target format is legal, whether something is worth the wait, or whether the user should confirm an engine download first, **dry_run once first**. ',
  'mcp.tools.desc.convert_file.31':
    '⚠️ When the client cancels the call (by sending notifications/cancelled) this call **will not return anything at all**; ',
  'mcp.tools.desc.convert_file.32':
    'that is the MCP convention, not a failure; at that point the only way to check the result is get_job_status or list_jobs. ',
  'mcp.tools.desc.convert_file.33':
    '**On failure what comes back is not a sentence but a machine-readable object**: `code` (a closed set, e.g. ',
  'mcp.tools.desc.convert_file.34':
    'source_corrupt / engine_missing / target_not_supported), `retryable` (whether retrying with the same arguments could help), ',
  'mcp.tools.desc.convert_file.35':
    "`next_steps` (what to do next), and `log_tail` (the tail of the engine's stderr). ",
  'mcp.tools.desc.convert_file.36':
    '**Read log_tail first, that is the raw reason the engine gave**; `code` only tells you whether to retry.',

  /* ---- 说明书 · list_supported_formats ---- */
  'mcp.tools.desc.list_supported_formats.01':
    'List the capability matrix: which source formats each category has, and which targets each of them can convert to. It only answers "is this supported" and never converts anything. ',
  'mcp.tools.desc.list_supported_formats.02':
    'Omitting category returns all six. **Check here or inspect_file before you settle on a target_format** - the legal targets change with the source format ',
  'mcp.tools.desc.list_supported_formats.03':
    '(mkv cannot become mkv; HEIC and SVG sources have no bmp/ico exit), and guessing wrong makes convert_file fail outright. ',
  'mcp.tools.desc.list_supported_formats.04':
    'To take in the whole picture at once, read the converter://formats markdown first instead of probing repeatedly with this tool.',

  /* ---- 说明书 · inspect_file ---- */
  'mcp.tools.desc.inspect_file.01':
    'Inspect a file before converting it: category, source format, size, which exits are legal, and whether an engine has to be downloaded; ',
  'mcp.tools.desc.inspect_file.02':
    'for audio and video it also gives duration, resolution and codecs, and for archives the number of entries. ',
  'mcp.tools.desc.inspect_file.03':
    '**Call it before you decide on a target format**: the legal targets come from asking about the source format, not from guessing. It only reads metadata; it changes nothing and converts nothing. ',
  'mcp.tools.desc.inspect_file.04':
    'It also gives three things **to do the arithmetic with**, all computed for the **default target format**: ',
  'mcp.tools.desc.inspect_file.05':
    '`cost` (`engine` which engine to prepare, `download_bytes` how big the installer is, `unpacked_bytes` how big it is once unpacked, ',
  'mcp.tools.desc.inspect_file.06':
    '`network_required` whether this path depends on a heavy engine that is downloaded on demand), ',
  'mcp.tools.desc.inspect_file.07':
    '`lossy` (whether this step loses information: true=lossy for sure, false=a lossless path exists, null=cannot tell), ',
  'mcp.tools.desc.inspect_file.08':
    '`estimate` (a time **range** `seconds: [lower, upper]` plus `confidence`). ',
  'mcp.tools.desc.inspect_file.09':
    '⚠️ `estimate` is a **range, not a promise**, and **read `confidence` first**: ',
  'mcp.tools.desc.inspect_file.10':
    'only `high` is good enough to plan a wait around; `medium` / `low` only tell you seconds versus minutes. ',
  'mcp.tools.desc.inspect_file.11':
    '⚠️ For a different target format these three numbers **do not apply** - look at the legal targets listed under `targets` first, ',
  'mcp.tools.desc.inspect_file.12': '`cost` only describes the default-target path. ',
  'mcp.tools.desc.inspect_file.13':
    '⚠️ Sizes and engines come from reading the install manifest at runtime and are `null` when it cannot be read (**not 0**): 0 means "this path downloads nothing".',

  /* ---- 说明书 · batch_convert ---- */
  'mcp.tools.desc.batch_convert.01':
    'Convert many files at once, all sharing one target_format; it suits a batch of material in the same format. ',
  'mcp.tools.desc.batch_convert.02':
    '**It returns a set of job_ids immediately, without waiting for the conversions**, so watch the whole batch at once with list_jobs (**do not** call get_job_status on each returned job_id). ',
  'mcp.tools.desc.batch_convert.03':
    'A source that is not valid only affects itself (it shows up in rejected, each entry carrying code / retryable / next_steps), ',
  'mcp.tools.desc.batch_convert.04':
    'and the rest are queued as usual - so take a look at rejected after you get the return value. ',
  'mcp.tools.desc.batch_convert.05':
    'In a mixed directory, target_format takes the reserved word "{auto}": **each source resolves its target from its own capability matrix and the user\'s preferences** ',
  'mcp.tools.desc.batch_convert.06':
    '(within one batch png follows the image preference and mp4 the video preference), and what is actually used is the `to` echoed by each job - **go by that**, do not assume the whole batch shares one target. ',
  'mcp.tools.desc.batch_convert.07':
    'When output_dir is omitted, the landing spots are decided by **the app\'s output-directory setting**: if "output to a specific directory" is set, the whole batch gathers in that one directory, ',
  'mcp.tools.desc.batch_convert.08':
    'otherwise each one lands next to its own source file. **Go by the output returned for each job**; do not assume they are scattered next to their source files. ',
  'mcp.tools.desc.batch_convert.09':
    "`verify: true` runs an output self-check **for every job** (the criteria are word for word the same as convert_file's), ",
  'mcp.tools.desc.batch_convert.10':
    'so here its cost is **twice the number of source files** in child processes - think it through before turning it on for a batch. ',
  'mcp.tools.desc.batch_convert.11':
    "The results come back with `list_jobs`'s `verification_status` and `get_job_status`'s `verification`.",

  /* ---- 说明书 · get_job_status ---- */
  'mcp.tools.desc.get_job_status.01':
    'Check the progress and result of **one** job. job_id comes from convert_file / batch_convert. ',
  'mcp.tools.desc.get_job_status.02':
    "A finished job gives the output path and size; a failed one gives an error summary, a machine-readable error_code and the tail of the engine's stderr - ",
  'mcp.tools.desc.get_job_status.03':
    "**read the stderr tail (`log_tail`), that is where the engine's raw reason is** (for example which ffmpeg parameter was wrong), ",
  'mcp.tools.desc.get_job_status.04':
    'and "conversion failed" on its own tells you nothing. `log_tail` **comes from this tool only** (the list deliberately leaves it out; dozens of stderr tails would eat your context). ',
  'mcp.tools.desc.get_job_status.05':
    'A running job gives a percentage; engines like pandoc / LibreOffice can only give stage text, and **a missing percentage is normal** - do not read that as a hang. ',
  'mcp.tools.desc.get_job_status.06':
    'A job submitted with `verify` on also carries a `verification` when it finishes (the fields are described under convert_file): ',
  'mcp.tools.desc.get_job_status.07':
    'it is computed **before the job settles**, so **it is the same on every query**; you will never see it missing on the first check and present on the second.',

  /* ---- 说明书 · list_jobs ---- */
  'mcp.tools.desc.list_jobs.01':
    'List the progress and results of **a batch** of jobs (`counts` is the global tally, `jobs` is the filtered rows, and by default only the most recent ',
  'mcp.tools.desc.list_jobs.02':
    '{limit} entries, never more than {max}, and truncated is true when it was cut). ',
  'mcp.tools.desc.list_jobs.03':
    '**Use it after converting a batch, instead of calling get_job_status on each job_id that batch_convert returned**: ',
  'mcp.tools.desc.list_jobs.04': 'one call shows you the good and the bad across 30 files. ',
  'mcp.tools.desc.list_jobs.05':
    'Common patterns: status:"failed" to see what broke, status:"unfinished" to see how many are still running (= queued + running), ',
  'mcp.tools.desc.list_jobs.06':
    'and since set to the largest created_at from the previous result for incremental polling. ',
  'mcp.tools.desc.list_jobs.07':
    '**The list deliberately leaves out log_tail** (the token cost of dozens of stderr tails is wildly out of proportion to what they tell you) - ',
  'mcp.tools.desc.list_jobs.08':
    "to read an engine's raw error on a particular job, look that one up with get_job_status. ",
  'mcp.tools.desc.list_jobs.09':
    'A job with `verify` on only gets a `verification_status` here (consistent / differs / unknown), ',
  'mcp.tools.desc.list_jobs.10':
    'and the full list of facts likewise takes a separate get_job_status call on that job (the reasoning is word for word the same as for log_tail).',

  /* ---- 说明书 · cancel_job ---- */
  'mcp.tools.desc.cancel_job.01':
    'Cancel a queued or running job. It **kills the whole process tree** - LibreOffice spawns soffice.bin, ',
  'mcp.tools.desc.cancel_job.02':
    'and killing only the parent leaves an orphan holding the profile lock, after which every conversion of that kind fails silently. ',
  'mcp.tools.desc.cancel_job.03':
    'Cancelling a job that has already finished is a no-op, and the return value states plainly what its status was at the time. Cancelling **leaves no residue** - ',
  'mcp.tools.desc.cancel_job.04':
    'the `.part` temp files of each engine are deleted on cancel (measured: after a cancel the directory holds neither an output nor a .part).',

  /* ---- 说明书 · read_document ---- */
  'mcp.tools.desc.read_document.01':
    "**Read a document's body text directly**; one call gets you the text, with no need to inspect_file, then convert_file, ",
  'mcp.tools.desc.read_document.02':
    'and then read the output (that is three calls, and the output may even land in a directory you cannot read). ',
  'mcp.tools.desc.read_document.03':
    'Supports `.docx` (→ md/txt), `.xlsx` (→ csv), text-based `.pdf` (→ txt/md), ',
  'mcp.tools.desc.read_document.04':
    'and the formats that are plain text to begin with: `.md` / `.txt` / `.html` / `.rst` / `.csv`. ',
  'mcp.tools.desc.read_document.05':
    "**It writes no files**: intermediate outputs land only in the system temp directory and are deleted after use, so nothing is dropped into the user's output directory. ",
  'mcp.tools.desc.read_document.06':
    '⚠️ **Formats that need a heavy engine are explicitly unsupported in this version; do not try them here**: `doc` / `xls` / `ppt` / `odt` / `ods` ',
  'mcp.tools.desc.read_document.07':
    'need LibreOffice (a 357 MiB installer), and `epub` / `mobi` / `azw3` need Calibre (213 MiB). ',
  'mcp.tools.desc.read_document.08':
    'Reading the body of a file should not drag in a download of several hundred MB; for those files use convert_file (when the engine is missing it ',
  'mcp.tools.desc.read_document.09':
    'tells you plainly which one to download and how big it is), **and get the user\'s confirmation first**. Audio, video, images and archives have no "body", so this tool refuses them outright. ',
  'mcp.tools.desc.read_document.10':
    '⚠️ **Image-only / scanned PDFs yield no text** (the pages hold images, with no text layer). In that case what comes back is an **error** rather than empty text, ',
  'mcp.tools.desc.read_document.11':
    'as this project bundles no OCR - **retrying will not change the result**; to see the content, use convert_file to turn it into png/jpg and hand that to a client that can show images. ',
  'mcp.tools.desc.read_document.12':
    "format defaults to md; when the source format has no such exit it falls back to another one it supports and says so in the return value's warnings, ",
  'mcp.tools.desc.read_document.13':
    'and **what you actually got is the format in the return value** - go by that. ',
  'mcp.tools.desc.read_document.14':
    'The result is **truncated**: at most 20000 characters by default, and when `truncated: true` continue with offset ',
  'mcp.tools.desc.read_document.15':
    '(pass the previous offset plus the number of characters you actually got back); total_chars is the length of the whole body, not of this chunk).'
}
