/**
 * 命令行入口 —— `src/cli/main.ts` / `stdio.ts`。
 *
 * ## P6 · 线 ε 独占这一片
 *
 * ⚠️ **`stdout` 上的东西不在这片里**：`--json` 那份输出是承重契约（一个 JSON 对象、
 * 一个字节不多），翻译它等于改协议。这片收的是 **stderr 上的人话**（用法、错误、
 * 下一步怎么办）——脚本作者与排障的人看的就是它们。
 *
 * ## 两条边界，逐条说明为什么这么切
 *
 * - **`--help` 的用法正文收**，尽管它由 `writeStdout()` 打到 stdout。那一路是用户
 *   **显式点名要的**（`arbiter --help`），本来就不是机器读的数据——stdout 作为
 *   「数据通道」那条纪律说的是 `convert` 的产物路径与 `--json` 那份 JSON
 *   （见 `src/cli/stdio.ts` 的文件头）。参数错时那同一段正文还会顺带打到 stderr。
 * - **`CliFailure` 里的 `code`**（`usage` / `source_missing` / `engine_missing` …）
 *   **不翻译**：它是 agent 写分支用的闭集，翻了就是改协议（与 `mcpErrors` 那片同一条）。
 *   同一个 JSON 里的 `message` / `next_steps` 是**人话**，照翻。
 *
 * ## `cli.paths.*` 为什么是 Head / Tail 两半
 *
 * 那四条在源码里本来就是 `+` 拼接的两段（纯粹为了不让行太长），而扫描器按**源码里的
 * 片段**计数，所以这里保持「一段一个键」：合成一句会让字典的粒度与扫描器对不上
 * （P4 为 `integration.rename.notifyBody` 补 `GRANULARITY_DIFFERS` 才放行的就是这一族）。
 * 拼回去的成品句子与迁移前**逐字节相同**。
 */
export const cliZh = {
  /* ------------------------------------------------------------ 帮助正文 */
  'cli.usage': `arbiter —— 调律者转换器（Arbiter）的命令行

用法：
  arbiter convert <文件...> [--to <扩展名>] [--out <路径>] [--recipe <路径>] [--json]
  arbiter --version
  arbiter --help

选项：
  --to <扩展名>   目标格式，不带点（mp4 / md / png …）。省略时用应用里该类别的默认目标
  --out <路径>    产物的完整路径（含文件名）。只允许配一个源文件
  --recipe <路径> 配方文件（JSON）：{"target": "mp4", "mode": "remux"}
                  --to 比配方里的 target 优先；mode 目前只能从配方给
  --json          结果以**恰好一个** JSON 对象打到 stdout
  -h, --help      显示这段帮助
  -v, --version   显示版本号

退出码：
  0    成功
  1    转换失败（引擎跑了但没成功）
  2    参数错（用法 / 源文件不存在 / 这个格式组合不支持）
  3    引擎缺失（需要按需下载的引擎，本机还没装）
  4    内部错误
  130  被 Ctrl-C 打断

stdout 只有数据：--json 时是一个 JSON 对象，否则是产物路径（一行一个）。
诊断、进度、警告一律走 stderr。
`,

  /* ------------------------------------------------ 用法错的两条「下一步」 */
  'cli.usage.nextHelp': '跑 `arbiter --help` 看用法',
  'cli.usage.nextTarget': '目标格式写成不带点的扩展名，如 mp4 / md / png',

  /* ------------------------------------------------------- 配方文件（R15） */
  'cli.recipe.readFailed': '读不了配方文件：{path}',
  'cli.recipe.badJson': '配方不是合法的 JSON：{path}（{why}）',
  'cli.recipe.problem': '⚠️ 配方 {path}：{problem}',
  'cli.recipe.empty': '这份配方一个字段都没认出来：{path}（只认 target 与 mode，见 --help）',

  /* -------------------------------------- 源文件闸门（submit 之前那三道） */
  'cli.source.notFound': '找不到源文件：{source}',
  'cli.source.notFoundHint': '路径要写全（相对路径按当前工作目录解析），且文件必须已经存在',
  'cli.source.isDirectory': '这是一个目录，不是文件：{source}',
  'cli.source.isDirectoryHint': 'CLI 只转文件；目录递归还没做',
  'cli.source.unknownFormat': '认不出源格式，或者 .{from} 没有任何可用的目标格式',
  'cli.source.unknownFormatHint': '用 --to 显式指定目标格式',

  /* ------------------------------------------------------------ 任务落定 */
  'cli.job.lost': '内部状态异常：提交之后立刻找不到这个任务',
  'cli.convert.failed': '转换失败',

  /* --------------------------------------- 运行时诊断（**全走 stderr**） */
  'cli.signal.canceling': '收到 {signal}，正在取消…',
  'cli.result.failed': '{source} 失败：{message}',
  'cli.unexpected': '[arbiter] 未预期的错误：{message}',
  // stdout 闸门拦下的一段写入（`stdio.ts`）。**它必须说清「不是静默丢弃」**：
  // 被拦的往往是某个第三方依赖的 `console.log`，而那一行改道去了 stderr。
  'cli.stdout.blocked': '[arbiter] 拦下一段本会污染 stdout 的写入（stdout 是数据通道）：{text}',

  /* -------------------------------- 路径装配告警（判据见 `resolvePaths()`） */
  'cli.paths.resourcesMissingHead':
    'resourcesPath={resourcesPath} 不存在：打包形态下随包引擎就在它下面，',
  'cli.paths.resourcesMissingTail': '缺了它会被判成「没装」',
  'cli.paths.appPathAsarHead': 'appPath={appPath} 指向 asar 内部，但 ARBITER_IS_PACKAGED 不是 1：',
  'cli.paths.appPathAsarTail': '引擎解析会走 dev 分支，随包引擎找不到',
  'cli.paths.mismatchHead':
    '[arbiter] 路径装配与实际不符（这会让已经装好的引擎被判成「没装」）：\n',
  'cli.paths.mismatchValuesHead': '  本次实际用的值（ARBITER_APP_PATH / ARBITER_RESOURCES_PATH / ',
  'cli.paths.mismatchValuesTail':
    'ARBITER_IS_PACKAGED / ARBITER_USER_DATA / ARBITER_DOWNLOADS 可以覆盖）：\n'
} as const

export const cliEn: Record<keyof typeof cliZh, string> = {
  'cli.usage': `arbiter — the Arbiter converter CLI

Usage:
  arbiter convert <files...> [--to <ext>] [--out <path>] [--recipe <path>] [--json]
  arbiter --version
  arbiter --help

Options:
  --to <ext>       Target format without the dot (mp4 / md / png …). Omit it to use the
                   app's default target for that category
  --out <path>     Full path of the output file, file name included. Only valid with a
                   single source
  --recipe <path>  Recipe file (JSON): {"target": "mp4", "mode": "remux"}
                   --to wins over the recipe's target; mode can only come from the recipe
  --json           Print the result to stdout as **exactly one** JSON object
  -h, --help       Show this help
  -v, --version    Show the version

Exit codes:
  0    Success
  1    Conversion failed (the engine ran but did not succeed)
  2    Bad arguments (usage / source file missing / unsupported format pair)
  3    Engine missing (this needs an on-demand engine that is not installed yet)
  4    Internal error
  130  Interrupted by Ctrl-C

stdout carries data only: one JSON object with --json, otherwise the output paths (one per line).
Diagnostics, progress and warnings always go to stderr.
`,

  'cli.usage.nextHelp': 'Run `arbiter --help` to see the usage',
  'cli.usage.nextTarget':
    'Write the target format as an extension without the dot, e.g. mp4 / md / png',

  'cli.recipe.readFailed': 'Cannot read the recipe file: {path}',
  'cli.recipe.badJson': 'The recipe is not valid JSON: {path} ({why})',
  'cli.recipe.problem': '⚠️ recipe {path}: {problem}',
  'cli.recipe.empty':
    'No usable field in this recipe: {path} (only target and mode are read, see --help)',

  'cli.source.notFound': 'Source file not found: {source}',
  'cli.source.notFoundHint':
    'Give the full path (a relative one is resolved against the current working directory), and the file must already exist',
  'cli.source.isDirectory': 'This is a directory, not a file: {source}',
  'cli.source.isDirectoryHint':
    'The CLI only converts files; recursive directories are not implemented yet',
  'cli.source.unknownFormat': 'Unrecognized source format, or .{from} has no usable target format',
  'cli.source.unknownFormatHint': 'Pass --to to name the target format explicitly',

  'cli.job.lost': 'Internal state error: the job could not be found right after it was submitted',
  'cli.convert.failed': 'Conversion failed',

  'cli.signal.canceling': 'Got {signal}, cancelling…',
  'cli.result.failed': '{source} failed: {message}',
  'cli.unexpected': '[arbiter] unexpected error: {message}',
  'cli.stdout.blocked':
    '[arbiter] blocked a write that would have polluted stdout (stdout is the data channel): {text}',

  'cli.paths.resourcesMissingHead':
    'resourcesPath={resourcesPath} does not exist: the bundled engines live under it in packaged form, ',
  'cli.paths.resourcesMissingTail': 'so they would be reported as "not installed"',
  'cli.paths.appPathAsarHead':
    'appPath={appPath} points inside an asar, but ARBITER_IS_PACKAGED is not 1: ',
  'cli.paths.appPathAsarTail':
    'engine resolution will take the dev branch and the bundled engines will not be found',
  'cli.paths.mismatchHead':
    '[arbiter] path wiring does not match reality (installed engines will be reported as "not installed"):\n',
  'cli.paths.mismatchValuesHead':
    '  values actually used this run (ARBITER_APP_PATH / ARBITER_RESOURCES_PATH / ',
  'cli.paths.mismatchValuesTail':
    'ARBITER_IS_PACKAGED / ARBITER_USER_DATA / ARBITER_DOWNLOADS can override them):\n'
}
