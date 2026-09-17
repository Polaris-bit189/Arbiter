import { existsSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join, resolve } from 'path'
import { fileURLToPath } from 'url'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { isAsarPath, setAppPaths, type AppPaths } from '../main/core/appPaths'
import { JobRegistry } from './jobs'
import { createPathGate } from './paths'
import { createServer } from './server'
import { inspectShallow, protectStdout } from './stdout'

/**
 * MCP Server 的入口。**它是这个仓库里唯一一个「没有 Electron」的进程**——
 * M3 把引擎的加载路径从 electron 上剥下来（`converters/index.ts` 的按需 `import()`
 * + `core/appPaths.ts` 的注入式路径），就是为了让这个文件能跑起来。
 * 反过来说：**这个进程是 M3 那件事的唯一消费者，也是它的验收现场。**
 *
 * ## 三件必须做对的事
 *
 * 1. **保住 stdout**（见 `stdout.ts`）。stdio 传输下 stdout 就是协议帧，
 *    写进去一行日志就等于往 JSON-RPC 流里插乱码，客户端表现是「连着连着就断了」，
 *    而服务端一句错都不报。
 *
 * 2. **把路径注入进来。** `appPaths()` 未初始化时**直接抛**（那是刻意的，见
 *    `core/appPaths.ts` 的文件头），所以这里必须给全五个值。默认值是推测出来的——
 *    dev 下猜得准，用户装的包则未必。**但告警只在装配与实际不符时才响**（见
 *    `resolvePaths()` 里那两条判据）：原先「凡是猜出来的都吱一声」对着正常形态也响，
 *    而报出来的值全都是对的，那种告警只会训练人忽略它。
 *
 * 3. **退出时杀掉子进程树。** Windows 上杀父进程不会带走子进程，而 ffmpeg 一旦变成
 *    孤儿就会一直跑到天荒地老（约束 3）。所以三条退出路径（SIGINT / SIGTERM /
 *    stdin 关闭——客户端退出时最常见的就是最后这一种）走同一个收尾。
 *
 * 开发期跑法：
 *
 * ```bash
 * TSX_TSCONFIG_PATH=tsconfig.node.json node --import tsx src/mcp/main.ts
 * ```
 *
 * Claude Code 侧的配置见 M5 的 plugin（`.mcp.json`）。
 */

/** 从环境变量里读一个路径，没给就返回 null（调用方决定默认值）。 */
function envPath(name: string): string | null {
  const value = process.env[name]
  return value !== undefined && value.trim() !== '' ? resolve(value.trim()) : null
}

/**
 * 算出一份能用的 `AppPaths`，**只在结构性判据证明装配与实际不符时**往 stderr 报一句。
 *
 * `ARBITER_*` 这一组环境变量是启动器（`plugins/arbiter/mcp/target.mjs` 的 `entryEnv()`）
 * 拉起 MCP 时给的；开发期不设也能跑，因为 dev 下这五个值恰好都能从仓库位置推出来。
 *
 * 那个启动器对 GUI 与 CLI 一视同仁地传同一组变量，而**打包形态是五件全传、仓库形态
 * 只传 `ARBITER_APP_PATH`**——两种形态在这两条判据下都一声不吭（实测）。
 */
function resolvePaths(): AppPaths {
  /** 这个文件在 `<仓库根>/src/mcp/main.ts`，往上两层是仓库根 */
  const here = fileURLToPath(new URL('.', import.meta.url))
  const guessedAppPath = resolve(here, '..', '..')

  const appPath = envPath('ARBITER_APP_PATH') ?? guessedAppPath
  const isPackaged = process.env.ARBITER_IS_PACKAGED === '1'
  const resourcesPath =
    envPath('ARBITER_RESOURCES_PATH') ?? (isPackaged ? join(appPath, 'resources') : '')

  // Electron 在 Windows 上的 userData 就是 `%APPDATA%\<productName>`。
  // 猜错的表现是「引擎明明装好了，MCP 却说没有」，所以下面会把实际用的值打出来。
  const guessedUserData =
    process.platform === 'win32'
      ? join(homedir(), 'AppData', 'Roaming', 'Arbiter')
      : join(homedir(), '.config', 'Arbiter')
  const userData = envPath('ARBITER_USER_DATA') ?? guessedUserData
  const downloads = envPath('ARBITER_DOWNLOADS') ?? join(homedir(), 'Downloads')

  const paths: AppPaths = { isPackaged, resourcesPath, appPath, userData, downloads }

  const problems: string[] = []

  // 判据一：打包形态下 `resourcesPath` 必须真的存在。
  // 漏给 `ARBITER_RESOURCES_PATH` 时它被派生成 `join(appPath, 'resources')`，而打包形态的
  // `appPath` 已经指进 `resources\app.asar` 里——于是那条路径**落在 asar 内部、必然不存在**，
  // 随包引擎被判成「没装」。落地症状是只剩 `7zip-bin` 的精简版 `7za.exe` 兜底，
  // **RAR 悄悄不支持了**，一句错都不报。
  if (isPackaged && !existsSync(resourcesPath)) {
    problems.push(
      `resourcesPath=${resourcesPath} 不存在：打包形态下随包引擎就在它下面，缺了它会被判成「没装」`
    )
  }

  // 判据二：`appPath` 指着 asar，但 `ARBITER_IS_PACKAGED` 不是 `1`。
  // 于是 `bundledEnginePath()` 走 dev 分支，那条路径同样落在 asar 内部。
  // 判据本体在 `core/appPaths.ts` 的 `isAsarPath()`——与 `src/cli/main.ts` 共用一个实现，
  // 两边不会漂（曾经各写一份，那正是「同一事实两个副本」的形态）。
  if (!isPackaged && isAsarPath(appPath)) {
    problems.push(
      `appPath=${appPath} 指向 asar 内部，但 ARBITER_IS_PACKAGED 不是 1：` +
        '引擎解析会走 dev 分支，随包引擎找不到'
    )
  }

  // ⚠️ **告警范围是收窄过的，别改回「凡是没给环境变量就报」。** 那种写法对着**正常形态**
  // 也会响（仓库形态、以及装机启动器只传一部分变量的形态），而报出来的值**全都是对的**——
  // 一份只在自己没出错时才叫的告警，等于训练人忽略它。收窄的完整理由、以及为什么
  // `userData` / `downloads` **一条判据都不留**，写在 `src/cli/main.ts` 的 `resolvePaths()` 上。
  if (problems.length > 0) {
    // 五条值只在**出事时**才打，而那一刻正是人要看它们的时刻。环境变量名写全——
    // 不写「见 --help」，那会把指到一个查不到这一段的地方。
    const used = [
      `    appPath=${appPath}`,
      `    resourcesPath=${resourcesPath}`,
      `    userData=${userData}`,
      `    downloads=${downloads}`,
      `    isPackaged=${isPackaged}`
    ]
    // 只走 stderr：stdout 是 JSON-RPC 协议通道（见 `./stdout.ts` 与 docs/NOTES.md 约束 20）。
    process.stderr.write(
      '[arbiter-mcp] 路径装配与实际不符（这会让已经装好的引擎被判成「没装」）：\n' +
        problems.map((p) => `  - ${p}\n`).join('') +
        '  本次实际用的值（ARBITER_APP_PATH / ARBITER_RESOURCES_PATH / ' +
        'ARBITER_IS_PACKAGED / ARBITER_USER_DATA / ARBITER_DOWNLOADS 可以覆盖）：\n' +
        used.map((line) => `${line}\n`).join('')
    )
  }
  return paths
}

/** 版本号：读得到 package.json 就用它，读不到不编。 */
function resolveVersion(appPath: string): string {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(appPath, 'package.json'), 'utf8'))
    if (typeof parsed === 'object' && parsed !== null && 'version' in parsed) {
      const version = (parsed as { version?: unknown }).version
      if (typeof version === 'string' && version.length > 0) return version
    }
  } catch {
    // 读不到就回落，不报错。**别把这里的失败当成「打包后一定读不到」**：
    // 拉起这个进程的是 `launch.mjs`，它用 `ELECTRON_RUN_AS_NODE=1` 的 **Electron** 起我们，
    // 而 Electron 的 Node 模式带 asar 补丁，读 asar 里的 package.json 是成功的（实测见
    // docs/NOTES.md 约束 21 末尾「适用范围的更正」）。真走到这里通常是 dev 下目录不对。
  }
  return '0.0.0'
}

async function main(): Promise<void> {
  protectStdout()

  const paths = resolvePaths()
  setAppPaths(paths)

  const cwd = process.cwd()
  const gate = createPathGate({ cwd, userData: paths.userData })
  const registry = new JobRegistry()

  const server = createServer({ gate, registry, cwd, version: resolveVersion(paths.appPath) })
  const transport = new StdioServerTransport()

  /**
   * 收尾。**三条退出路径共用这一个**：用户 Ctrl-C、客户端发 SIGTERM、
   * 客户端直接关掉 stdin（Claude Code 退出时最常见的就是这一种）。
   *
   * 顺序不能反：先 `shutdown()` 把取消信号发给每个在跑的 job（引擎侧会
   * `taskkill /T /F` 杀进程树），再留一点时间让它们真的死掉，最后才退出。
   * 直接 `process.exit()` 会把 ffmpeg 变成孤儿——它不属于任何进程组，
   * 之后就再没人管得了它了（约束 3）。
   */
  let closing = false
  const shutdown = (reason: string): void => {
    if (closing) return
    closing = true
    process.stderr.write(`[arbiter-mcp] ${reason}，正在收尾…\n`)
    registry.shutdown()
    // 500ms 足够 taskkill 返回；再长也只是拖着不退。
    setTimeout(() => process.exit(0), 500)
  }

  process.on('SIGINT', () => shutdown('收到 SIGINT'))
  process.on('SIGTERM', () => shutdown('收到 SIGTERM'))
  process.stdin.on('end', () => shutdown('stdin 关闭（客户端断开）'))
  process.stdin.on('close', () => shutdown('stdin 关闭（客户端断开）'))

  await server.connect(transport)
  process.stderr.write(
    `[arbiter-mcp] 已就绪：cwd=${cwd} userData=${paths.userData} ` +
      `读根=${gate.roots.join(',')} 写根=${gate.writeRoots.join(',')}\n`
  )
}

main().catch((error: unknown) => {
  // 启动期失败只能走 stderr：此刻 stdout 可能已经被客户端当成协议在读了。
  process.stderr.write(`[arbiter-mcp] 启动失败：${inspectShallow(error)}\n`)
  if (error instanceof Error && error.stack) process.stderr.write(`${error.stack}\n`)
  process.exit(1)
})
