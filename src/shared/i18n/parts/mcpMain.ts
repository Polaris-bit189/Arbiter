/**
 * MCP 入口与路径闸门 —— `src/mcp/main.ts` / `paths.ts` / `readDocument.ts` /
 * `selfCheck.ts` / `stdout.ts`。
 *
 * ## P6 · 线 δ 独占这一片
 *
 * ⚠️ 这一片里的字**大多走 stderr**（`[arbiter-mcp] …` 那类启动与告警），
 * 它们在 MCP 的协议里不是「对用户说的话」——但用户会在 Claude Code 的日志面板
 * 里看到它们，而且 `readDocument.ts` 的工具回话是**真的给 agent 读的**。
 * 逐条判断：**给 agent 看的翻，纯协议诊断的按 C 类保留**（见 `docs/NOTES.md` 约束 43）。
 *
 * ## 逐条判完之后的形态：这一片**只翻了「结果」那半边**
 *
 * 留下的中文（**C 类，逐条列在源码注释里，别顺手搬进这张表**）分三种：
 *
 *   - `main.ts` 的**生命周期日志**（`收到 SIGINT` / `stdin 关闭（客户端断开）` /
 *     `[arbiter-mcp] …，正在收尾…`）与**就绪横幅**（`已就绪：cwd=… 读根=…`）：
 *     `[engine] …` / `[task] …` / `[pdf] …` 那几个主进程日志是同一条规矩——**原始记录**。
 *     就绪横幅另有一条硬理由：`test-mcp-server.ts` 与 `test-plugin-launch.mjs`
 *     都拿 `已就绪` 这个子串判「服务起没起来」，翻它等于把两个套件绑在语言设置上。
 *   - `stdout.ts` 的 `拦下一段非 JSON-RPC 的 stdout 写入`：协议守卫的开发者诊断，
 *     而它旁边跟着的就是那段**脏内容原文**（原始记录）。
 *   - `inspectCost.ts` 的 `引擎清单里没有 engines 数组`：它抛出的异常被
 *     `catch { size = undefined }` **吞掉**，永远到不了 agent、也进不了日志。
 *
 * ⚠️ 而翻的那几条里有一条**结构上的前提**：`main.ts` 的路径装配告警原先在
 * `resolvePaths()` 里就打印，而那时 `applyLocale()` **还没跑**（它要 `setAppPaths()`
 * 之后才读得到设置，`core/settings.ts` 走 `userData`）——那样翻出来的是一句
 * 「永远是中文的英文文案」。所以那一块的打印被挪到了 `applyLocale()` 之后
 * （见 `reportPathProblems`）。
 */
export const mcpMainZh = {
  /* ---------- main.ts：路径装配自检（给用户 / agent 看「引擎为什么没找到」） ---------- */

  'mcp.main.problemResourcesPath':
    'resourcesPath={path} 不存在：打包形态下随包引擎就在它下面，缺了它会被判成「没装」',
  'mcp.main.problemAsarAppPath':
    'appPath={path} 指向 asar 内部，但 ARBITER_IS_PACKAGED 不是 1：引擎解析会走 dev 分支，随包引擎找不到',
  'mcp.main.assemblyWarningHead':
    '[arbiter-mcp] 路径装配与实际不符（这会让已经装好的引擎被判成「没装」）：\n',
  'mcp.main.assemblyWarningUsed':
    '  本次实际用的值（ARBITER_APP_PATH / ARBITER_RESOURCES_PATH / ARBITER_IS_PACKAGED / ARBITER_USER_DATA / ARBITER_DOWNLOADS 可以覆盖）：\n',
  'mcp.main.startupFailed': '[arbiter-mcp] 启动失败：{error}\n',

  /* ---------- paths.ts：闸门拒绝的理由（agent 读到它才知道该往哪放） ---------- */

  'mcp.paths.noRoots':
    '一个可用的根目录都没有，MCP 不会放行任何路径。请用 ARBITER_MCP_ROOTS 指定。',
  'mcp.paths.allowedRoots': '允许的目录：{roots}',
  /**
   * 根目录之间的分隔符。
   *
   * 它单独成键，是因为中文用顿号、英文该用 `', '`——直接 `join('、')` 的话，
   * 英文用户会看到 `C:\a、C:\b`，而那个顿号也正是闸门 a 数得到的那一条。
   */
  'mcp.paths.rootsSeparator': '、',
  'mcp.paths.notFound': '路径不存在（或所在目录不存在）：{path}',
  'mcp.paths.notAllowed': '路径不在允许的目录里：{path}。{roots}',
  'mcp.paths.unreadable': '路径读不到：{path}',
  'mcp.paths.isDirectory': '这是一个目录，不是文件：{path}',
  'mcp.paths.parentMissing': '输出路径的上级目录不存在：{path}',
  'mcp.paths.parentMissingHint': '先建好目录，或把产物写到已有的目录里',
  'mcp.paths.writeNotAllowed': '输出路径不在允许的目录里：{path}。{roots}',

  /* ---------- readDocument.ts：工具回话（agent 真的会读它） ---------- */

  /**
   * 扫描件那条**补充说明**。
   *
   * 正文那几行来自 `converters/pdfText.ts` 的 `textlessReason`——那份是 C 类
   * （转换层抛出的原始记录，约束 43），**不在这张表里**；这里只翻我们自己补的那句。
   */
  'mcp.read.textlessHint':
    '本项目不含 OCR。要看内容就用 convert_file 转成 png / jpg 交给能看图的客户端；要文字得先让用户做一次 OCR。',
  'mcp.read.canceled': '读取被取消，没有拿到正文。',
  'mcp.read.failed': '读不出正文：{log}',
  'mcp.read.empty':
    '抽出来是空的。两种可能：「这份文档确实没有文字」，或者「文字都在图里」（本项目不含 OCR，后者抽不出来）。',
  'mcp.read.offsetBeyond':
    'offset={offset} 已经超出正文长度（{total} 字符），这一段是空的：读完了就不要再往下读',
  'mcp.read.maxCharsClamped':
    'max_chars 被夹到 {max}（你要的是 {wanted}）：单次返回再多会把上下文塞爆，要更多就用 offset 分几次读',

  /* ---------- selfCheck.ts：自检自己的兜底（进 verification.notes） ---------- */

  'mcp.selfCheck.failed': '自检自身出错，这一次没查成：{reason}'
} as const

export const mcpMainEn: Record<keyof typeof mcpMainZh, string> = {
  'mcp.main.problemResourcesPath':
    'resourcesPath={path} does not exist: in a packaged build the bundled engines live under it, and without it they are treated as "not installed"',
  'mcp.main.problemAsarAppPath':
    'appPath={path} points inside the asar, but ARBITER_IS_PACKAGED is not 1: engine resolution takes the dev branch, so the bundled engines cannot be found',
  'mcp.main.assemblyWarningHead':
    '[arbiter-mcp] The injected paths do not match the real layout (anything already installed will look like it is "not installed"):\n',
  'mcp.main.assemblyWarningUsed':
    '  The values actually used this time (ARBITER_APP_PATH / ARBITER_RESOURCES_PATH / ARBITER_IS_PACKAGED / ARBITER_USER_DATA / ARBITER_DOWNLOADS can override them):\n',
  'mcp.main.startupFailed': '[arbiter-mcp] Failed to start: {error}\n',

  'mcp.paths.noRoots':
    'No usable root directory — MCP will not allow any path. Set one with ARBITER_MCP_ROOTS.',
  'mcp.paths.allowedRoots': 'Allowed directories: {roots}',
  'mcp.paths.rootsSeparator': ', ',
  'mcp.paths.notFound': 'That path does not exist (nor does its directory): {path}',
  'mcp.paths.notAllowed': 'That path is not inside an allowed directory: {path}. {roots}',
  'mcp.paths.unreadable': 'Cannot read that path: {path}',
  'mcp.paths.isDirectory': 'That is a directory, not a file: {path}',
  'mcp.paths.parentMissing': 'The directory that would hold the output does not exist: {path}',
  'mcp.paths.parentMissingHint':
    'Create the directory first, or write the output into one that already exists',
  'mcp.paths.writeNotAllowed':
    'That output path is not inside an allowed directory: {path}. {roots}',

  'mcp.read.textlessHint':
    'This project has no OCR. To see what is inside, convert the file to png / jpg with convert_file and hand it to a client that can display images; getting text out of it needs an OCR pass first.',
  'mcp.read.canceled': 'The read was cancelled, so no text was produced.',
  'mcp.read.failed': 'Could not extract any text: {log}',
  'mcp.read.empty':
    'Nothing was extracted. Two possibilities: the document really has no text, or all of its text lives inside images (this project has no OCR, so the latter extracts nothing).',
  'mcp.read.offsetBeyond':
    'offset={offset} is already past the end of the text ({total} characters), so this slice is empty — there is nothing more to read',
  'mcp.read.maxCharsClamped':
    'max_chars was clamped to {max} (you asked for {wanted}): returning more than that in one call would flood the context — use offset to read it in several passes',

  'mcp.selfCheck.failed': 'The self-check itself failed, so nothing was verified: {reason}'
}
