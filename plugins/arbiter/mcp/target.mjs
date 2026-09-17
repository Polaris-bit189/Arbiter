/**
 * 「在本机找到一份可用的 Arbiter」以及「给它装配 `ARBITER_*`」。
 *
 * ## 为什么单独一个文件
 *
 * 与 `asar.mjs` 同一个理由：**`launch.mjs` 有顶层副作用**（解析目标、拉起子进程），
 * import 它就会真的起一个 MCP server。而这件事现在有**两个**消费者：
 *
 *   - `launch.mjs` —— MCP server（`out/main/mcp.js`）
 *   - `hooks/read-convert.mjs` —— PreToolUse hook 要拉起的 CLI（`out/main/cli.js`）
 *
 * 抄一份过来必然分家，而分家的表现是「MCP 找得到应用、hook 找不到」——
 * **只在用户机器上现形**（开发机上有仓库根那条候选，见下）。
 *
 * ## 候选顺序
 *
 * 不是「第一个存在的目录」，而是**第一个真正能用的**（见 `resolveTarget`）：
 * 「存在但没构建」的仓库会让位给「装好的应用」，否则开发者机器上会出现
 * 「明明装了应用，却因为顺手 clone 的仓库没 build 而报错」。
 */
import { spawnSync } from 'child_process'
import { existsSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'

// 纯逻辑单独一个文件，理由同上；这个模块只读 asar 的头部，不碰载荷。
import { asarHasEntry } from './asar.mjs'

/** 这个文件在 `<仓库根>/plugins/arbiter/mcp/target.mjs`，往上三层就是仓库根。 */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

/** 构建产物里两个入口的相对路径。`out/main/` 是 electron-vite 的 main 输出目录。 */
export const MCP_ENTRY = 'out/main/mcp.js'
export const CLI_ENTRY = 'out/main/cli.js'

function firstExisting(paths) {
  return paths.find((p) => p && existsSync(p)) ?? null
}

/** Electron 在 Windows 上的 userData 就是 `%APPDATA%\<productName>`，与应用侧一致。 */
export function defaultUserData() {
  if (process.platform === 'win32') {
    return join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'Arbiter')
  }
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'Arbiter')
  }
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'Arbiter')
}

/**
 * 卸载表里那两个键。装到哪台用户/全机的，就记在哪个下面。
 *
 * `WOW6432Node` 那份刻意不查：我们的应用是 x64，装不出 32 位的那条记录。
 */
const UNINSTALL_KEYS = [
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall'
]

/**
 * `reg.exe` 的输出是系统 OEM 码页，不是 UTF-8。
 *
 * 判据与 `src/main/core/integration.ts` 的 `decodeRegOutput` 是同一套（本项目约束 23）：
 * 先按 UTF-8 严格解，抛错才说明它不是 UTF-8，退到 GB18030；GB18030 对 ASCII 完全兼容，
 * 所以英文机器上那两条路都对。最后一层兜底是防 `TextDecoder` 认不出 `gb18030`
 * （Node 不带 full-icu 时它**抛 RangeError**）——宁可变乱码也不能让探测崩掉。
 *
 * **没有与 `core/integration.ts` 共用**：那份是 TypeScript、在 `src/` 里，而插件是
 * 被 `.mcp.json` 的 `command: "node"` 直接起的**裸 `.mjs`**，没有构建步骤能把它编进来。
 * 与 `asar.mjs` 同一个理由——插件侧这几行只能自带一份。
 */
export function decodeRegOutput(buffer) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer)
  } catch {
    try {
      return new TextDecoder('gb18030').decode(buffer)
    } catch {
      return buffer.toString('utf8')
    }
  }
}

/** 一行的形状：`    DisplayName    REG_SZ    Arbiter`（列之间是空白，不是固定对齐）。 */
const REG_VALUE_LINE = /^\s+(\S+)\s+(REG_[A-Z_]+)\s+(.*)$/

/**
 * 从 `reg query … /s /f Arbiter` 的输出里认出安装根目录。
 *
 * 纯函数，收**已经解码好**的文本，所以判定部分完全脱开子进程与注册表（测试直接喂字符串）。
 *
 * 三件必须记住的事：
 *
 * - **按 `^HKEY_` 分块，不看提示文案。** 「找不到」那句话是 `reg.exe` 写进 **stdout**
 *   的、而且同样是 GBK（实测 2026-09-17：无匹配时退出码是 **1**、stdout 是 GBK 的「找到 0 匹配」；键根本不存在时也是 1、输出 0 字节），拿文案当判据会跟着码页一起坏。
 * - **`DisplayName` 必须**恰好**是 `Arbiter`**：`/f` 是子串匹配，`Arbiter Beta`、
 *   `Arbiter 插件` 这类邻居条目会一起被捞出来，只有这一条能把它们挡掉。
 * - **目录从 `DisplayIcon` 反推，`UninstallString` 兜底。** 两者都指向安装根下的某个
 *   可执行文件（`<根>\Arbiter.exe,0` / `"<根>\Uninstall Arbiter.exe" /currentuser`），
 *   而 `DisplayIcon` 更直接（它就是主程序）。取**其所在目录**而不是那个文件本身。
 */
export function parseInstallRoots(text) {
  const roots = []
  let displayName = null
  let icon = null
  let uninstall = null

  const flush = () => {
    if (displayName === 'Arbiter') {
      const fromIcon = dirOfExecutable(icon)
      const dir = fromIcon ?? dirOfExecutable(uninstall)
      if (dir && !roots.includes(dir)) roots.push(dir)
    }
    displayName = null
    icon = null
    uninstall = null
  }

  for (const line of text.split(/\r?\n/)) {
    if (/^HKEY_/i.test(line)) {
      flush()
      continue
    }
    const match = REG_VALUE_LINE.exec(line)
    if (!match) continue
    const [, name, , value] = match
    if (name === 'DisplayName') displayName = value.trim()
    else if (name === 'DisplayIcon') icon = value.trim()
    else if (name === 'UninstallString') uninstall = value.trim()
  }
  flush()

  return roots
}

/**
 * 从一个「指向可执行文件的值」反推出它所在的目录。
 *
 * 三种形状都实测过（2026-09-17 在真安装上读回来的）：
 *
 * ```
 * DisplayIcon        REG_SZ    D:\tools\Arbiter\Arbiter.exe,0
 * UninstallString    REG_SZ    "D:\tools\Arbiter\Uninstall Arbiter.exe" /currentuser
 * ```
 *
 * 两条判据，每一条都对应上面某一种形状：
 *
 * - **先按引号取，再按 `.exe` 截。** 顺序不能反：卸载命令是「带引号的路径 + 参数」，
 *   而路径里**可能有空格**（`C:\Program Files\...` 就是），先按空格切会在半路断掉，
 *   得到一个看着挺像那么回事、`existsSync` 却永远为假的目录。
 * - **`DisplayIcon` 那个 `,0` 是图标序号，不是路径的一部分**——它跟在 `.exe` 后面，
 *   所以取到第一个 `.exe` 为止就自然把它甩掉了。
 *
 * 截不出 `.exe` 的一律不认：`DisplayIcon` 有时指向的是 `.ico` 或 `.dll`，
 * 那种值反推出来的目录是哪个都不好说。返回 null 会让调用方退到 `UninstallString`。
 */
function dirOfExecutable(value) {
  if (!value) return null

  const quoted = /^"([^"]+)"/.exec(value)
  const raw = quoted ? quoted[1] : value

  // **贪婪**：目录名里可能自己带 `.exe`（`D:\my.exe.tools\Arbiter\Arbiter.exe,0`），
  // 非贪婪会在第一个 `.exe` 处断开、反推出一个根本没有的 `D:\`。
  const exe = /^(.*\.exe)/i.exec(raw)
  const path = exe ? exe[1] : raw.split(' ')[0]
  if (!/\.exe$/i.test(path)) return null

  const dir = dirname(path)
  return dir && dir !== '.' ? dir : null
}

/**
 * 去注册表问「Arbiter 装在哪」——**这是给**改了安装目录**的用户兜底的**。
 *
 * ## 为什么必须有这一条
 *
 * 上面那三个标准位置是 NSIS 的默认值，而**安装向导允许改**。实测（2026-09-17）：
 * 应用装在 `D:\tools\Arbiter` 时，三个标准位置一个都不存在，`resolveTarget()` 返回
 * **null** —— 插件的 MCP server 直接报「没有在本机找到可用的 Arbiter」并退出，
 * 而应用明明装好了、命令行也能用。
 *
 * 开发机上永远撞不到：`candidateRoots()` 里有仓库根那条候选兜着。**只在用户机器上现形**
 * ——与约束 21 的 asar、约束 30 的残留打包是同一类。小 C 盘上把应用装到 D 盘很常见，
 * 所以这不是一个假想的边角。
 *
 * 代价实测过（2026-09-17，各 5 次取中位）：`HKCU` 那一次 **17.8 ms**、`HKLM` **36.3 ms**，
 * 一次 `registryRoots()` 合计 **约 77 ms**（两个键各起一个 reg.exe 子进程）。而这条链路
 * 每跑一次都要起一个 Electron——这笔钱可以忽略。
 *
 * 不抛异常：注册表读不到（权限、没有 reg.exe、非 Windows）时返回空数组，
 * 让后面的候选照常顶上。**这里失败不该让整个插件起不来。**
 *
 * `keys` 可注入，只为了测试能对着**临时键**跑真 `reg.exe` 往返（见
 * `scripts/test-plugin-target.mjs`）——与 `core/integration.ts` 用临时键测右键菜单
 * 是同一套做法，全程不碰用户真实的卸载表。
 */
export function registryRoots(keys = UNINSTALL_KEYS) {
  if (process.platform !== 'win32') return []

  const roots = []
  for (const key of keys) {
    // 一律 `spawnSync('reg.exe', args[])`，绝不 `shell: true`（本项目约束 2）。
    // 数组参数下 shell 不参与解析，`/s` `/f` 这些开关不会被 Git Bash 那套路径改写动到。
    const result = spawnSync('reg.exe', ['query', key, '/s', '/f', 'Arbiter', '/d'], {
      windowsHide: true,
      // **必须有上限**（审计 2026-09-17 指出这里原本一个都没有）：`reg.exe` 卡住
      // （组策略、安全软件挂钩、hive 异常）时 `spawnSync` 会一直不返回，而这条链路
      // 跑在 MCP server **启动的顶层**——表现是客户端「启动超时」，且没有任何报错。
      // 仓库为同类问题给 msiexec 专门加过 5 分钟超时（docs/NOTES.md 约束 26），
      // 这里按实测「一次查询 ~20~40 ms」的百倍余量取 5 秒。
      timeout: 5000
    })
    if (result.error || !result.stdout) {
      // 不抛：读不到注册表时后面还有候选，插件不该因此起不来。但**也不静默**——
      // stderr 是插件的诊断通道（stdout 是 MCP 的协议通道，见 launch.mjs 的文件头）。
      // 静默的后果是「明明有这条兜底，却不知道为什么没生效」。
      if (result.error) {
        process.stderr.write(`[arbiter-plugin] reg query 失败（${key}）：${result.error.message}\n`)
      }
      continue
    }
    for (const root of parseInstallRoots(decodeRegOutput(result.stdout))) {
      if (!roots.includes(root)) roots.push(root)
    }
  }
  return roots
}

/**
 * 候选根目录。**顺序 = 优先级**。
 *
 * NSIS 默认装成 per-user（`%LOCALAPPDATA%\Programs\...`），但用户装的时候可以改成
 * 全机（`%ProgramFiles%\...`）——两种都要认；**再往下才是去注册表问**（解决「装到了
 * 那两个标准位置之外」的第三种情况，见 `registryRoots`）。
 *
 * `uninstallKeys` 只给测试用，透传给 `registryRoots`——测试要对着**临时键**跑真往返，
 * 而生产调用一个字都不用改（不传就是真实那两个键）。与 `core/integration.ts` 的
 * `setContextMenuRootForTest` 是同一个套路。
 */
export function candidateRoots(uninstallKeys) {
  if (process.env.ARBITER_HOME) return [process.env.ARBITER_HOME]

  const roots = []

  if (process.platform === 'win32') {
    if (process.env.LOCALAPPDATA) roots.push(join(process.env.LOCALAPPDATA, 'Programs', 'Arbiter'))
    if (process.env.ProgramFiles) roots.push(join(process.env.ProgramFiles, 'Arbiter'))
    if (process.env['ProgramFiles(x86)']) {
      roots.push(join(process.env['ProgramFiles(x86)'], 'Arbiter'))
    }
  } else if (process.platform === 'darwin') {
    roots.push('/Applications/Arbiter.app')
  } else {
    roots.push('/opt/Arbiter', join(homedir(), '.local', 'share', 'Arbiter'))
  }

  // 装到了标准位置之外的那些（安装向导里改了目录）。**排在标准位置之后、开发形态之前**：
  // 它跟上面那三个是同一件事（「本机装好的应用」），只是位置不常规。
  roots.push(...registryRoots(uninstallKeys))

  // 开发形态：插件所在的仓库，以及当前工作目录（Claude Code 起进程时 cwd 就是项目目录）。
  // 放在安装位置**之后**——装了应用的用户不该被一个恰好 clone 过的仓库抢走。
  roots.push(REPO_ROOT, process.cwd())

  return roots
}

/** 认一份仓库根：`package.json` 的 name 得是 arbiter，别把随便一个目录当仓库。 */
function isRepoRoot(root) {
  const pkgPath = join(root, 'package.json')
  if (!existsSync(pkgPath)) return false
  try {
    return JSON.parse(readFileSync(pkgPath, 'utf8')).name === 'arbiter'
  } catch {
    return false
  }
}

function electronInRepo(root) {
  const dist = join(root, 'node_modules', 'electron', 'dist')
  return firstExisting([
    join(dist, 'electron.exe'),
    join(dist, 'Electron.app', 'Contents', 'MacOS', 'Electron'),
    join(dist, 'electron')
  ])
}

/**
 * 从一个根目录里认出「Electron 二进制 + 入口脚本 + resources」三件套。
 *
 * 认两种形态：
 *  - **打包好的应用**：`resources/app.asar/out/main/<entry>`——**必须走 `asarHasEntry`，
 *    不能用 `existsSync`**，理由见 `asar.mjs` 的文件头（那是踩过的坑）；
 *    松散目录的构建（中间试过一版 `asar: false`，已撤回）会落成 `resources/app/...`，
 *    那种普通 `existsSync` 就够。
 *  - **仓库**：`out/main/<entry>`，Electron 取自 `node_modules`。
 *    这条路要求先 `npm run build`；没构建时 `usable` 为 false，会被后面的候选顶掉。
 *
 * `entry` 是 `out/main/` 下的文件名（`MCP_ENTRY` / `CLI_ENTRY`）。**两个入口分开认**：
 * 一份早于 CLI 的安装包可能有 `mcp.js` 而没有 `cli.js`，那时 MCP 照样该能用。
 */
export function probe(root, entry) {
  if (!root || !existsSync(root)) return null

  const macApp = join(root, 'Contents', 'MacOS', 'Arbiter')
  const appExe = join(root, process.platform === 'win32' ? 'Arbiter.exe' : 'arbiter')

  for (const [exe, resources] of [
    [macApp, join(root, 'Contents', 'Resources')],
    [appExe, join(root, 'resources')]
  ]) {
    if (!existsSync(exe)) continue

    const loose = join(resources, 'app', entry)
    const asar = join(resources, 'app.asar')
    let script = null
    if (existsSync(loose)) script = loose
    else if (existsSync(asar) && asarHasEntry(asar, entry)) {
      script = join(asar, entry)
    }

    return {
      kind: 'packaged',
      root,
      electron: exe,
      resources,
      entry: script,
      appPath: null,
      usable: Boolean(script)
    }
  }

  if (isRepoRoot(root)) {
    const script = join(root, entry)
    const electron = electronInRepo(root)
    return {
      kind: 'repo',
      root,
      electron,
      resources: join(root, 'resources'),
      entry: script,
      appPath: root,
      usable: Boolean(electron) && existsSync(script)
    }
  }

  return null
}

/**
 * 在所有候选里挑**第一个真正能用**的。
 *
 * 全部都不能用时，返回第一个「认出来了但不完整」的——只为了把错误信息说得具体
 * （是缺构建还是缺 electron），而不是笼统地报「没找到」。
 *
 * `uninstallKeys` 同 `candidateRoots`：只给测试注入临时注册表键用，生产调用不传。
 * **测试要断「真的挑中了那份应用」就必须能走这一条**——只断 `indexOf` 的次序说明不了
 * 端到端成立（审计 2026-09-17 指出：我原先以为端到端在开发机上必假红，实测是错的）。
 */
export function resolveTarget(entry, uninstallKeys) {
  const found = candidateRoots(uninstallKeys)
    .map((root) => probe(root, entry))
    .filter(Boolean)

  const usable = found.find((t) => t.usable)
  if (usable) return usable

  return found.find((t) => t.electron) ?? found[0] ?? null
}

/**
 * 那个入口脚本「本该在哪」——只用来把错误信息说得具体。
 *
 * 打包形态**按实际存在的那个布局**报，不写死 asar：报一条不存在的路径会让排查的人
 * 去翻一个根本没有的目录。今天（2026-09-14）的产物是 asar，但松散目录也认得了——
 * 中间试过一版 `asar: false`（已撤回，见 `electron-builder.yml`），保留这个分支
 * 等于两边都不用再改。
 */
export function expectedEntryPath(target, entry) {
  if (target.kind === 'repo') return join(target.root, entry)
  const loose = join(target.resources, 'app', entry)
  return existsSync(loose) ? loose : join(target.resources, 'app.asar', entry)
}

/**
 * 打包形态下把五个路径**全部显式传进去**，不留任何猜测。
 *
 * `src/mcp/main.ts` 与 `src/cli/main.ts` 对未设置的项会按 `import.meta.url` 去猜
 * appPath，而打包后那个 URL 指向 `resources/app.asar/out/main/*.js`，猜出来的是
 * asar 内部的路径——引擎解析会因此判成「没装」，而用户界面里明明装好了。
 * 这类错误没有任何报错，只是所有转换都说缺引擎，所以宁可从外面把话说死。
 *
 * 仓库形态反过来：只传 `ARBITER_APP_PATH`，其余交给入口的默认值——那正是
 * `npm run mcp` 走的那条路，已经实测过，不必另造一份。
 */
export function entryEnv(target) {
  if (target.kind === 'packaged') {
    const asar = join(target.resources, 'app.asar')
    return {
      ARBITER_APP_PATH: existsSync(asar) ? asar : join(target.resources, 'app'),
      ARBITER_RESOURCES_PATH: target.resources,
      ARBITER_IS_PACKAGED: '1',
      ARBITER_USER_DATA: process.env.ARBITER_USER_DATA ?? defaultUserData(),
      ARBITER_DOWNLOADS: process.env.ARBITER_DOWNLOADS ?? join(homedir(), 'Downloads')
    }
  }
  return { ARBITER_APP_PATH: target.appPath }
}
