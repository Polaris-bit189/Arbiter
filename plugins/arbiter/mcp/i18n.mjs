/**
 * 插件自己的极简字典 —— 只有**查表 + 插值**两件事。
 *
 * ## 为什么不复用 `src/shared/i18n`
 *
 * 这个插件是**独立分发**的：用户在 Claude Code 里 `/plugin marketplace add` 之后，
 * 它落在 `~/.claude/plugins/cache/` 下，那里的目录结构与开发仓无关、**没有 `src/`**。
 * 所以它不能 `import '@shared/i18n'`——那份代码根本不在它的分发内容里。
 *
 * ⇒ 这是一份**刻意的副本**，覆盖范围只有插件自己说的那几十句话
 *   （`launch.mjs` / `read-convert.mjs` / `target.mjs`）。
 *   `asar.mjs` 的 `asarHasEntry`、`target.mjs` 的 `decodeRegOutput` 出于同一个理由
 *   也各带了一份——**插件侧这几行只能自带**。
 *
 * ## ⚠️ 唯一必须与应用侧**逐字一致**的东西：语言的裁决顺序
 *
 * `src/main/core/locale.ts` 的 `effectiveLocale()` 是应用侧的权威，它的顺序是：
 *
 * ```
 * ARBITER_LOCALE 环境变量  >  settings.json 里显式的 zh/en  >  'zh'
 * ```
 *
 * 两边对同一个环境变量给出**不同的解释**会是一件很难查的事：MCP server 说英文、
 * 而拉起它的启动器说中文，用户只会看到「一半英文一半中文」。
 * 所以下面 `pickLocale()` 是那条判据的副本，**改那边就要同提交改这里**
 * （`scripts/test-plugin-launch.mjs` 有一条断言喂同一组输入给两边比对）。
 *
 * ⚠️ 与那边**刻意**的两处不同，都是因为插件没有 Electron：
 *   - 拿不到 `app.getLocale()`，所以 `'system'` 一律落到 `'zh'`
 *     （与应用侧「GUI 之外 `'system'` 解析成 `'zh'`」是同一条规矩）；
 *   - 读 `settings.json` 时**只认 `'zh'` / `'en'` 两个字面量**，其余（含 `'system'`）
 *     一律当作「没设」——那份文件可能有各种历史形态，读坏了不该让插件起不来。
 */

import { readFileSync } from 'fs'
import { join } from 'path'

/**
 * 中文表。**插件里唯一允许出现这些中文字面量的地方。**
 *
 * ⚠️ `export` 是为了让 `scripts/test-i18n.ts` 能给这份**副本字典**施加与
 * `src/shared/i18n` 同样的两条闸门（en 里不许有 CJK、占位符集合两边一致）。
 * 这份字典没有构建步骤、也没有类型检查，没人管就一定会漂。
 */
export const zh = {
  // —— launch.mjs：找不到应用 / 找到但不完整 ——
  noTargetTitle: '没有在本机找到可用的 Arbiter。',
  noTargetBody: '这个插件本身不含转换引擎——它要借用一份 Arbiter：装好的应用，或一个构建过的仓库。',
  noTargetInstall: '请先装应用：',
  noTargetWindows: '  Windows: 从 Releases 下载 Arbiter-Setup-*.exe 安装',
  noTargetMac: '  macOS:   把 Arbiter.app 拖进 /Applications',
  noTargetHomeHint:
    '已经装了却仍然报这一条，用 ARBITER_HOME 显式指路（写进 .mcp.json 的 env 里）：',
  // ⚠️ 这条里那个尖括号占位符**也是文案的一部分**（它告诉用户把 `<你>` 换成自己的用户名）——
  // 扫描器把它连中文一起数进来是有道理的，别为了「让它看起来像代码」而拆出去。
  noTargetHomeExample: '  ARBITER_HOME=C:\\Users\\<你>\\AppData\\Local\\Programs\\Arbiter',
  noElectron: '找到了 {root}，但里面没有 Electron 可执行文件。',
  noElectronDev: '（开发形态下通常是 `npm i` 还没跑，或者 electron 没装上。）',
  noEntry: '找到了 {root}，但没有 MCP 入口。',
  noEntryExpected: '  期望的位置：{path}',
  noEntryRepo: '这是仓库形态，先在仓库根跑一次 `npm run build` 生成 out/main/mcp.js。',
  noEntryRepoFast:
    '（注意 `npm run build` 会先做 typecheck；只想快的话用 `npx electron-vite build`。）',
  noEntryOld: '这个安装包可能早于 MCP 功能（< 0.2.0），装新版本即可。',
  spawnFailed: '拉起 MCP server 失败：{message}',
  spawnFailedCmd: '  命令：{cmd}',
  // —— launch.mjs：`ARBITER_MCP_DEBUG=1` 才打的那几行 ——
  debugKind: '形态      = {value}',
  debugRoot: '根目录    = {value}',
  debugElectron: 'electron  = {value}',
  debugEntry: 'mcp.js    = {value}',
  debugUserData: 'userData  = {value}',
  debugUserDataGuess: '(交给 main.ts 猜)',
  debugExitSignal: '子进程被信号 {signal} 终止',
  // —— target.mjs ——
  regQueryFailed: '[arbiter-plugin] reg query 失败（{key}）：{message}',
  // —— read-convert.mjs：放行理由（每一次 Read 都可能打，都是「为什么没改写」）——
  passSuffix: '{reason} —— 放行（不改写这次 Read）',
  passEmptyStdin: 'stdin 是空的',
  passBadJson: 'stdin 不是合法 JSON',
  passWrongEvent: '事件不是 PreToolUse：{event}',
  passWrongTool: '工具不是 Read：{tool}',
  passBadPath: 'tool_input.file_path 不是非空字符串',
  passExtNotInTable: '.{ext} 不在快转表里',
  passNoApp: '本机没有找到可用的 Arbiter',
  passNoCli: '找到了 {root}，但里面没有 CLI 入口（out/main/cli.js）',
  passNoTmp: '临时目录建不出来',
  passCliFailed: 'CLI 没能完成这次转换',
  passNoOutput: 'CLI 退出了，但产物不在或为空',
  passInternal: '内部错误：{message} —— 放行',
  // —— read-convert.mjs：改写之后给客户端看的那句话（**这一条模型会读到**）——
  rewritten:
    'Arbiter（调律者转换器）已把这份 .{ext} 转成 .{to} 的临时副本：{out}' +
    '（源文件未改动）。读完不必删它——它在系统临时目录里，会自己过期。',

  // —— update.mjs：查版本与下载（`/arbiter:update` 那条线）——
  updateNoApp: '这台机器上没找到已安装的 Arbiter——应用那一半查不了。',
  updateUnreachable: '连不上 GitHub（{reason}）——这次没能查到最新版本。',
  updateHttpError: 'GitHub 回了 {status}——这次没能查到最新版本。',
  // ⚠️ 这一条是整条链路里**最容易静默出错**的地方：把「没查成」讲成「已是最新」，
  // 用户会以为自己不用更新。所以两者必须分开说。
  updateUnknownWarning: '注意：「没查成」不等于「已经是最新」——上面那句只说这次没问到。',
  updateCertHint:
    '证书没通过校验。本机若把 GitHub 域名指到了本地转发服务（或所在网络做了 TLS 拦截），' +
    'Node 24 可以试：把同一条命令前面加 `node --use-system-ca`。',
  updateRateLimitHint: 'GitHub 对未登录请求限流每小时 60 次，过一会儿再试。',
  updateNetworkHint: '检查网络 / 代理 / hosts 之后重试。',
  updateDownloaded: '安装包已经下到 {path}，sha256 校验通过。',
  updateDownloadHint: '双击那个文件就能装；装之前先退出正在运行的 Arbiter。',
  updateHashMismatch:
    '下载完成但 sha256 对不上（期望 {expected}，实际 {actual}）——文件已删除，请重试。',
  // 下面这两条是「拒绝下载」的理由，不是「下载失败」。宁可不下，也不下一个验证不了的东西。
  updateNoAsset: '这个 release 里没有安装包（`*-setup.exe`）——去 Releases 页面看一眼。',
  updateNoChecksum: '这个 release 没提供 sha256 校验和，所以没有下载——请在 Releases 页面手动下载。',
  // ⚠️ 下载失败**不能**复用「没能查到最新版本」那句——那是查询的文案。
  // 实测踩到过：一次下载超时，报告里却写着「这次没能查到最新版本」，方向整个是反的。
  updateDownloadFailed: '安装包没能下完：{reason}',
  updateDownloadTimeoutHint: '网络慢或被拦截时，去 Releases 页面手动下载更省事。',
  updatePluginHint: '插件更新跑这两条命令（跑完要重启 Claude Code 才生效）：',

  // —— session-start.mjs：会话开始那一眼 ——
  updateSessionNotice:
    'Arbiter 有新版本 {latest}（本机装的是 {installed}）。要更新就跑 /arbiter:update。'
}

/** 英文表。漏键由下面那段运行时检查挡（`.mjs` 没有类型检查，也没有构建步骤）。 */
export const en = {
  noTargetTitle: 'Could not find a usable Arbiter on this machine.',
  noTargetBody:
    'This plugin ships no conversion engines of its own — it borrows one: an installed app, or a built checkout.',
  noTargetInstall: 'Install the app first:',
  noTargetWindows: '  Windows: download Arbiter-Setup-*.exe from Releases and run it',
  noTargetMac: '  macOS:   drag Arbiter.app into /Applications',
  noTargetHomeHint:
    'Already installed and still seeing this? Point at it explicitly with ARBITER_HOME (set it in .mcp.json under env):',
  noTargetHomeExample: '  ARBITER_HOME=C:\\Users\\<you>\\AppData\\Local\\Programs\\Arbiter',
  noElectron: 'Found {root}, but it has no Electron executable.',
  noElectronDev:
    '(In a dev checkout this usually means `npm i` has not run, or electron failed to install.)',
  noEntry: 'Found {root}, but it has no MCP entry point.',
  noEntryExpected: '  Expected at: {path}',
  noEntryRepo:
    'This is a repo checkout — run `npm run build` at the repo root to produce out/main/mcp.js.',
  noEntryRepoFast:
    '(Note `npm run build` runs typecheck first; for speed use `npx electron-vite build`.)',
  noEntryOld:
    'This package predates the MCP feature (< 0.2.0); installing a newer version fixes it.',
  spawnFailed: 'Could not start the MCP server: {message}',
  spawnFailedCmd: '  Command: {cmd}',
  debugKind: 'kind      = {value}',
  debugRoot: 'root      = {value}',
  debugElectron: 'electron  = {value}',
  debugEntry: 'mcp.js    = {value}',
  debugUserData: 'userData  = {value}',
  debugUserDataGuess: '(let main.ts guess)',
  debugExitSignal: 'child terminated by signal {signal}',
  regQueryFailed: '[arbiter-plugin] reg query failed ({key}): {message}',
  passSuffix: '{reason} — passing through (this Read is left as-is)',
  passEmptyStdin: 'stdin was empty',
  passBadJson: 'stdin is not valid JSON',
  passWrongEvent: 'event is not PreToolUse: {event}',
  passWrongTool: 'tool is not Read: {tool}',
  passBadPath: 'tool_input.file_path is not a non-empty string',
  passExtNotInTable: '.{ext} is not in the quick-convert table',
  passNoApp: 'no usable Arbiter found on this machine',
  passNoCli: 'found {root}, but it has no CLI entry point (out/main/cli.js)',
  passNoTmp: 'could not create the temp directory',
  passCliFailed: 'the CLI did not finish this conversion',
  passNoOutput: 'the CLI exited, but the output is missing or empty',
  passInternal: 'internal error: {message} — passing through',
  rewritten:
    'Arbiter converted this .{ext} to a temporary .{to} copy: {out}' +
    ' (the source file is untouched). No need to delete it — it lives in the system temp directory and expires on its own.',

  updateNoApp: 'No installed Arbiter was found on this machine — the app half cannot be checked.',
  updateUnreachable:
    'Could not reach GitHub ({reason}) — the latest version was not retrieved this time.',
  updateHttpError: 'GitHub replied {status} — the latest version was not retrieved this time.',
  updateUnknownWarning:
    'Note: "could not check" is not the same as "already up to date" — the line above only says this attempt failed.',
  updateCertHint:
    'The certificate did not verify. If this machine points GitHub domains at a local forwarder (or the network does TLS inspection), Node 24 can try prefixing the same command with `node --use-system-ca`.',
  updateRateLimitHint: 'GitHub allows 60 unauthenticated requests per hour — try again later.',
  updateNetworkHint: 'Check the network / proxy / hosts file, then retry.',
  updateDownloaded: 'Installer downloaded to {path}; sha256 verified.',
  updateDownloadHint: 'Double-click that file to install. Quit any running Arbiter first.',
  updateHashMismatch:
    'Download finished but the sha256 does not match (expected {expected}, got {actual}) — the file was deleted, please retry.',
  updateNoAsset: 'This release has no installer (`*-setup.exe`) — check the Releases page.',
  updateNoChecksum:
    'This release provides no sha256 checksum, so nothing was downloaded — fetch it manually from the Releases page.',
  updateDownloadFailed: 'The installer did not finish downloading: {reason}',
  updateDownloadTimeoutHint:
    'On a slow or filtered network, downloading manually from the Releases page is easier.',
  updatePluginHint: 'Update the plugin with these two commands (restart Claude Code afterwards):',

  updateSessionNotice:
    'Arbiter {latest} is available (this machine has {installed}). Run /arbiter:update to fetch it.'
}

// 漏一条英文键在运行时是「印出一个键名」而不是崩溃，所以在这里显式挡一道
// （`.mjs` 没有 `Record<keyof typeof zh, string>` 那样的类型检查，而插件没有构建步骤）。
for (const key of Object.keys(zh)) {
  if (typeof en[key] !== 'string') throw new Error(`i18n: en 表缺 ${key}`)
}

/**
 * 现在该说哪种语言。**与 `src/main/core/locale.ts` 的 `effectiveLocale()` 同一条判据**
 * （顺序：`ARBITER_LOCALE` > `settings.json` 的 `language` > `'zh'`），理由见文件头。
 *
 * `env` 可注入只为了测试——生产调用一律用 `process.env`。
 */
export function pickLocale(env = process.env) {
  const raw = (env.ARBITER_LOCALE ?? '').trim()
  // 只认 'zh' / 'en' 两个字面量，写别的（比如 'en-US'）按规范化处理——
  // 与 `core/locale.ts` 那句 `envOverride.startsWith('zh') ? 'zh' : 'en'` 逐字一致。
  if (raw !== '') return raw.startsWith('zh') ? 'zh' : 'en'

  const userData = env.ARBITER_USER_DATA
  if (userData) {
    try {
      const parsed = JSON.parse(readFileSync(join(userData, 'settings.json'), 'utf8'))
      const want = parsed?.language
      if (want === 'zh' || want === 'en') return want
    } catch {
      // 文件不在 / 读不动 / 不是 JSON —— 都当作「没设」。**别让它把插件拦下来。**
    }
  }
  return 'zh'
}

/**
 * 取一句。`params` 里的 `{name}` 会被替换掉。
 *
 * 缺参数**不抛**：原样留下 `{name}` 并往 stderr 报一句——与 `src/shared/i18n` 的
 * `interpolate` 同一条规矩（一个文案 bug 不该让 hook 挂掉，而 hook 挂掉的表现是
 * 「用户正常的读文件坏了」）。
 *
 * ⚠️ `locale` 是**每次调用现算**的（不缓存）：`read-convert.mjs` 是个一次性的短进程，
 * 而 `launch.mjs` 在拉起子进程前只读几次——现算既简单又不会拿到过期值。
 */
export function t(key, params = {}, locale = pickLocale()) {
  const table = locale === 'en' ? en : zh
  const template = table[key]
  if (typeof template !== 'string') return String(key)
  return template.replace(/\{(\w+)\}/g, (whole, name) => {
    const value = params[name]
    if (value === undefined) {
      process.stderr.write(`[arbiter-plugin] i18n: ${key} 缺参数 {${name}}\n`)
      return whole
    }
    return String(value)
  })
}
