import { existsSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join, resolve } from 'path'
import { fileURLToPath } from 'url'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { t } from '@shared/i18n'
import { isAsarPath, setAppPaths, type AppPaths } from '../main/core/appPaths'
import { applyLocale } from '../main/core/locale'
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
 * 算出一份能用的 `AppPaths`，**只在结构性判据证明装配与实际不符时**记一笔。
 *
 * `ARBITER_*` 这一组环境变量是启动器（`plugins/arbiter/mcp/target.mjs` 的 `entryEnv()`）
 * 拉起 MCP 时给的；开发期不设也能跑，因为 dev 下这五个值恰好都能从仓库位置推出来。
 *
 * 那个启动器对 GUI 与 CLI 一视同仁地传同一组变量，而**打包形态是五件全传、仓库形态
 * 只传 `ARBITER_APP_PATH`**——两种形态在这两条判据下都一声不吭（实测）。
 *
 * ⚠️ **它只「记」不「说」**：告警的打印被挪到了 `main()` 里 `applyLocale()` **之后**。
 * 原因是个结构性的时序——`t()` 取的是 `@shared/i18n` 的全局语言，而那份全局由
 * `applyLocale()` 装上，`applyLocale()` 又要 `setAppPaths()` 之后才读得到设置
 * （`core/settings.ts` 走 `userData`）。在这个函数里打印，拿到的必然是**启动时那门
 * 语言**（默认 zh），于是文案翻了却永远是中文——比不翻更坏。
 */
function resolvePaths(): { paths: AppPaths; problems: string[] } {
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
    problems.push(t('mcp.main.problemResourcesPath', { path: resourcesPath }))
  }

  // 判据二：`appPath` 指着 asar，但 `ARBITER_IS_PACKAGED` 不是 `1`。
  // 于是 `bundledEnginePath()` 走 dev 分支，那条路径同样落在 asar 内部。
  // 判据本体在 `core/appPaths.ts` 的 `isAsarPath()`——与 `src/cli/main.ts` 共用一个实现，
  // 两边不会漂（曾经各写一份，那正是「同一事实两个副本」的形态）。
  if (!isPackaged && isAsarPath(appPath)) {
    problems.push(t('mcp.main.problemAsarAppPath', { path: appPath }))
  }

  // ⚠️ **告警范围是收窄过的，别改回「凡是没给环境变量就报」。** 那种写法对着**正常形态**
  // 也会响（仓库形态、以及装机启动器只传一部分变量的形态），而报出来的值**全都是对的**——
  // 一份只在自己没出错时才叫的告警，等于训练人忽略它。收窄的完整理由、以及为什么
  // `userData` / `downloads` **一条判据都不留**，写在 `src/cli/main.ts` 的 `resolvePaths()` 上。
  return { paths, problems }
}

/**
 * 把装配自检的结论打出来。**必须在 `applyLocale()` 之后调**（理由见 `resolvePaths`）。
 *
 * 五条值只在**出事时**才打，而那一刻正是人要看它们的时刻。环境变量名写全——
 * 不写「见 --help」，那会把指到一个查不到这一段的地方。
 */
function reportPathProblems(paths: AppPaths, problems: string[]): void {
  if (problems.length === 0) return
  const used = [
    `    appPath=${paths.appPath}`,
    `    resourcesPath=${paths.resourcesPath}`,
    `    userData=${paths.userData}`,
    `    downloads=${paths.downloads}`,
    `    isPackaged=${paths.isPackaged}`
  ]
  // 只走 stderr：stdout 是 JSON-RPC 协议通道（见 `./stdout.ts` 与 docs/NOTES.md 约束 20）。
  process.stderr.write(
    t('mcp.main.assemblyWarningHead') +
      problems.map((p) => `  - ${p}\n`).join('') +
      t('mcp.main.assemblyWarningUsed') +
      used.map((line) => `${line}\n`).join('')
  )
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

  const { paths, problems } = resolvePaths()
  setAppPaths(paths)

  // 语言：MCP 这一侧**没有「系统语言」这个概念**（这里没有 Electron，消费者是 agent）。
  // 所以 effectiveLocale() 不注入系统语言源，'system' 会解析成 'zh'——
  // 未设置时恒为中文，现有全部 MCP 断言与反证锚点因此原样成立。
  // agent 要用英文，就在 .mcp.json 里设 ARBITER_LOCALE=en。
  applyLocale()

  // 装配自检的告警**只能等到这里**才打得出当前语言（见 `resolvePaths` 的说明）。
  reportPathProblems(paths, problems)

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
   *
   * ⚠️ **下面这三个 reason 与那行「正在收尾…」故意**不进字典**（C 类，约束 43）**：
   * 它们是生命周期日志，与 `[engine] …` / `[task] …` / `[pdf] …` 那几条同族——
   * **原始记录，永不翻译**。用户不会因为它是英文而多懂一分，而翻它只会让同一条
   * 日志随语言设置改变形状。逐条清单见 `@shared/i18n/parts/mcpMain.ts` 的文件头。
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
  // 就绪横幅同样是 C 类（不进字典）。除了「原始记录」那条理由，它还有一条硬约束：
  // `test-mcp-server.ts` 与 `test-plugin-launch.mjs` 都拿 `已就绪` 这个**子串**判
  // 「服务起没起来」，翻它等于把两个套件绑在语言设置上（`ARBITER_LOCALE=en` 时那两个
  // 等待会一直等下去，表现是「套件挂在半路、一条失败信息都没有」）。
  process.stderr.write(
    `[arbiter-mcp] 已就绪：cwd=${cwd} userData=${paths.userData} ` +
      `读根=${gate.roots.join(',')} 写根=${gate.writeRoots.join(',')}\n`
  )
}

main().catch((error: unknown) => {
  // 启动期失败只能走 stderr：此刻 stdout 可能已经被客户端当成协议在读了。
  process.stderr.write(t('mcp.main.startupFailed', { error: inspectShallow(error) }))
  if (error instanceof Error && error.stack) process.stderr.write(`${error.stack}\n`)
  process.exit(1)
})
