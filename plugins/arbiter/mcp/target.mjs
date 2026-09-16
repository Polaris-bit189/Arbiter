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
 * 候选根目录。**顺序 = 优先级**。
 *
 * NSIS 默认装成 per-user（`%LOCALAPPDATA%\Programs\...`），但用户装的时候可以改成
 * 全机（`%ProgramFiles%\...`）——两种都要认。
 */
export function candidateRoots() {
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
 */
export function resolveTarget(entry) {
  const found = candidateRoots()
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
