import { existsSync, readFileSync, statSync } from 'fs'
import { homedir } from 'os'
import { join, resolve } from 'path'
import { fileURLToPath } from 'url'
import { extOf, resolveDefaultTarget, targetsFor } from '@shared/formats'
import { isAsarPath, setAppPaths, type AppPaths } from '../main/core/appPaths'
import { parseCliRequest } from '../main/core/cli'
import { getSettings } from '../main/core/settings'
import { isRecipeEmpty, parseRecipe, type Recipe } from '@shared/recipe'
import { failureOf, McpToolError, type ErrorCode } from '../mcp/errors'
import { JobRegistry } from '../mcp/jobs'
import { EXIT, log, protectStdout, writeStdout } from './stdio'

/**
 * `arbiter` 的独立进程入口。
 *
 *     arbiter convert <文件...> [--to <扩展名>] [--out <路径>] [--recipe <路径>] [--json]
 *
 * ## 它为什么不是「再起一个应用实例」
 *
 * Electron 应用有**单实例锁**（`src/main/index.ts` 的 `requestSingleInstanceLock()`），
 * 第二个实例起来就立刻 `app.quit()`。所以 CLI 只能是一条**没有窗口**的路：
 * 拿应用的 Electron 二进制、以 `ELECTRON_RUN_AS_NODE=1` 跑 `out/main/cli.js`。
 * 这个形状不是新发明的，它与 MCP 那条线共用（`plugins/arbiter/mcp/launch.mjs`
 * 拉起 `out/main/mcp.js` 是同一个做法，见 docs/NOTES.md 约束 19）。
 *
 * ⚠️ **因此这个进程里没有 Electron 运行时**：`converters/index.ts` 的按需 `import()`
 * 正是为这件事存在的（约束 19），**别把任何一个引擎改回静态 import**——
 * 那会让 CLI 一启动就去加载 `chromiumPdf`，而这个进程里 `BrowserWindow` 根本不存在。
 * 反过来说：**任何要 Chromium 的转换（`→ pdf`）在 CLI 里都做不到**，
 * 它会走到 Chromium 那一步才失败。这条限制与 MCP 那条线完全一样，不是这里引入的。
 *
 * ## 装配
 *
 * 与 `src/mcp/main.ts` 同源：先 `setAppPaths()`（`core/appPaths.ts` 的
 * `appPaths()` **没装就抛**，刻意不做「兜底去问 electron 要」），路径从 `ARBITER_*`
 * 环境变量读。**但告警范围收窄了**，理由见 `resolvePaths()` 里那段：只有结构性判据
 * 证明装配与实际不符时才出声，正常形态一声不吭。
 * （`src/mcp/main.ts` 那一份**还是宽的那版**，正常形态下也会响。要收窄就照这里的两条
 * 判据抄过去，别把这里改回宽的。）
 *
 * ## stdout
 *
 * 见 `./stdio.ts`：那是**数据通道**，只有一个出口。诊断一律 stderr。
 */

interface CliResult {
  source: string
  output: string
  from: string
  to: string
  engine: string
  /** 产物字节数。读不到体积时给 `null`（文件已经转出来了，编一个数字比不说更坏） */
  bytes: number | null
  /** 从提交到落定的墙钟，含排队与输出名解析 */
  duration_ms: number
}

interface CliFailure {
  /** `ErrorCode` 里的一项，外加一个只在 CLI 上出现的 `usage` */
  code: string
  message: string
  retryable: boolean
  next_steps: string[]
  /** 是哪一条源失败/被拒的 */
  source?: string
  /** 引擎的 stderr 尾部（有才给）。**它是这个项目最值钱的一件东西**，别省 */
  log_tail?: string[]
  /** 结构化补充：合法目标清单之类 */
  hint?: Record<string, unknown>
}

interface CliPayload {
  ok: boolean
  command: 'convert'
  results: CliResult[]
  error?: CliFailure
}

const USAGE = `arbiter —— 调律者转换器（Arbiter）的命令行

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
`

/**
 * 错误码 → 退出码。
 *
 * 码表的**唯一**来源是 MCP 的 `src/mcp/errors.ts`（`POLICIES`），这里只做翻译。
 * 抄一份码表过来必然漂移，而漂移的表现是「同一个原因，MCP 说该重试、CLI 说该改参数」。
 */
function exitCodeFor(code: string): number {
  switch (code) {
    case 'engine_missing':
      return EXIT.ENGINE_MISSING
    case 'usage':
    case 'unknown_format':
    case 'target_not_supported':
    case 'path_not_allowed':
    case 'source_missing':
    case 'output_conflict':
      return EXIT.USAGE
    case 'internal':
      return EXIT.INTERNAL
    // source_corrupt / canceled / no_text_content / not_readable / unknown_job
    default:
      return EXIT.CONVERT_FAILED
  }
}

/** 读配方这一步的结果。**返回而不是抛**：它要实现的是「用法错」那一档退出码，
 * 而异常那条路上最终落到的是内部错误（4）。 */
type RecipeLoad = { ok: true; recipe: Recipe } | { ok: false; message: string }

/**
 * 读并解析一份配方文件（R15）。
 *
 * 三件事，每一件都对应一种「静默出错」：
 *
 *  - **读不了 / 不是 JSON** → 用法错。配方是用户点名给的，读不了就是他该知道的事。
 *  - **有字段认不出** → 打到 **stderr**（`log()` 走的就是 stderr；`--json` 时 stdout
 *    必须只有那一个 JSON），然后**继续用认得的那部分**。逐字段宽容是刻意的：
 *    一个键名写错不该让另外那个能用的字段一起作废。
 *  - **一个字段都没认出来** → 用法错**拒掉，一个源文件都不转**。一份什么都没设的配方
 *    一定是个错误（顶层键名写错了，或者拿到一份别的工具的配置），而按默认档
 *    默默跑完还报成功，正是这个功能最想堵的那件事。
 */
function loadRecipe(path: string | null): RecipeLoad {
  if (path === null) return { ok: true, recipe: {} }

  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return { ok: false, message: `读不了配方文件：${path}` }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error)
    return { ok: false, message: `配方不是合法的 JSON：${path}（${why}）` }
  }

  const { recipe, problems } = parseRecipe(parsed)
  for (const problem of problems) log(`⚠️ 配方 ${path}：${problem}`)
  if (isRecipeEmpty(recipe)) {
    return {
      ok: false,
      message: `这份配方一个字段都没认出来：${path}（只认 target 与 mode，见 --help）`
    }
  }
  return { ok: true, recipe }
}

/** 一个用法错的失败对象。`usage` 这个码只在 CLI 上出现，不进 MCP 的闭集码表。 */
function usageFailure(message: string): CliFailure {
  return {
    code: 'usage',
    message,
    retryable: false,
    next_steps: ['跑 `arbiter --help` 看用法', '目标格式写成不带点的扩展名，如 mp4 / md / png']
  }
}

/** 任意异常 → 失败对象。`McpToolError` 的分类信息原样带出来。 */
function failureFrom(error: unknown, source: string): CliFailure {
  const fields = failureOf(error)
  // `log_tail` 是 `convertOne` 塞进 hint 里的（那是 `McpToolError` 唯一能挂结构化数据的地方），
  // 但它在 CLI 的 JSON 里该是**顶层**字段：与 MCP 的 `log_tail` 同名同位，
  // 调用方不必为了读一段 stderr 而先知道 hint 的内部结构。
  const hint = fields.hint === undefined ? undefined : { ...fields.hint }
  let logTail: string[] | undefined
  if (hint !== undefined && Array.isArray(hint.log_tail)) {
    logTail = hint.log_tail.filter((line): line is string => typeof line === 'string')
    delete hint.log_tail
  }

  return {
    code: fields.code,
    message: error instanceof Error ? error.message : String(error),
    retryable: fields.retryable,
    next_steps: fields.next_steps,
    source,
    ...(logTail === undefined ? {} : { log_tail: logTail }),
    ...(hint === undefined || Object.keys(hint).length === 0 ? {} : { hint })
  }
}

/**
 * 转换一个文件。抛出去的一律是 `McpToolError`（或它没预料到的原生异常，
 * 那种由 `failureOf` 归成 `internal`）。
 *
 * 复用 `JobRegistry` 而不是自己撸一遍：它已经把四件容易做错的事做完了——
 * 「矩阵里没有这个组合就在排队前拒」、「引擎没装就在排队前拒」、
 * 输出名占位（约束 9）、以及把 `ConversionFailed` 的 `logTail` 原样留住。
 * 自己抄一份必然漏掉其中一条，而漏掉的那条**不报错**。
 */
async function convertOne(
  registry: JobRegistry,
  source: string,
  requestedTo: string | null,
  out: string | null,
  recipe: Recipe
): Promise<CliResult> {
  // 存在性检查放在 submit 之前。`JobRegistry` 不做这件事——MCP 那条路的存在性由
  // 路径闸门（`src/mcp/paths.ts`）负责，而这里没有闸门。少了这一句，一个拼错的
  // 路径会一路走到引擎那里报一句「转换失败」，真正的原因（这个文件根本不在）
  // 一个字都看不见。
  let stat
  try {
    stat = statSync(source)
  } catch {
    throw new McpToolError(
      `找不到源文件：${source}`,
      { source, hint: '路径要写全（相对路径按当前工作目录解析），且文件必须已经存在' },
      { code: 'source_missing' }
    )
  }
  if (!stat.isFile()) {
    throw new McpToolError(
      `这是一个目录，不是文件：${source}`,
      { source, hint: 'CLI 只转文件；目录递归还没做' },
      { code: 'source_missing' }
    )
  }

  const fromExt = extOf(source)
  // `--to` 省略时走「应用里该类别的默认目标」。**不在这里另写一份偏好表**：
  // 那是 `shared/formats.ts` 的 `resolveDefaultTarget()`，界面与这里必须是同一个答案。
  // 次序是承重的：命令行给的 > 配方给的 > 应用里该类别的默认目标。
  // 反过来的话，一份随手存下来的配方会**压过**用户这次手敲的 `--to`，
  // 而那种「我明明说了 mp4，它转成了 mkv」极难归因。
  const toExt =
    requestedTo ?? recipe.target ?? resolveDefaultTarget(fromExt, getSettings().defaultTargets)
  if (toExt === null) {
    throw new McpToolError(
      `认不出源格式，或者 .${fromExt} 没有任何可用的目标格式`,
      { source, from: fromExt, targets: targetsFor(fromExt), hint: '用 --to 显式指定目标格式' },
      { code: 'unknown_format' }
    )
  }

  const job = registry.submit({
    source,
    toExt,
    // ⚠️ `mode` 目前**只有配方这一个来源**——CLI 没有对应的命令行开关。
    // 这不是遗漏：它本来就是「这套参数我要反复用」的那一类，放配方里正合适，
    // 而多一个 `--mode` 会让 hook 那种一行命令多一个可写错的地方。
    ...(recipe.mode === undefined ? {} : { mode: recipe.mode }),
    ...(out === null ? {} : { outputPath: out })
  })

  // 20ms 轮询：MCP 那边默认 100ms 是给「转视频要几分钟」用的；CLI 一次就一个文件，
  // 那 100ms 会原样加在每一次进程启动上（hook 那条路尤其在意）。
  const done = await registry.waitFor(job.id, { pollMs: 20 })
  if (done === null) {
    throw new McpToolError(
      '内部状态异常：提交之后立刻找不到这个任务',
      { source },
      { code: 'internal' }
    )
  }
  if (done.status !== 'done') {
    throw new McpToolError(
      done.error ?? '转换失败',
      {
        source,
        to: done.toExt,
        ...(done.logTail === undefined ? {} : { log_tail: done.logTail })
      },
      { code: (done.errorCode ?? 'internal') as ErrorCode }
    )
  }

  return {
    source: done.source,
    output: done.output,
    from: done.fromExt,
    to: done.toExt,
    engine: done.engine,
    bytes: done.sizeBytes ?? null,
    duration_ms: (done.finishedAt ?? Date.now()) - done.createdAt
  }
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2)
  const command = parseCliRequest(argv, process.cwd())

  if (command.kind === 'help') {
    await writeStdout(USAGE)
    return EXIT.OK
  }

  if (command.kind === 'version') {
    await writeStdout(`${resolveVersion()}\n`)
    return EXIT.OK
  }

  if (command.kind === 'error') {
    log(`arbiter: ${command.message}`)
    log('')
    log(USAGE)
    // `--json` 时**仍然**要往 stdout 写一个合法 JSON：契约是「stdout 是恰好一个
    // JSON 对象，或者空」，而参数错正是最容易只吼 stderr、让调用方解析到
    // `Unexpected end of JSON input` 的一类。
    await writeStdout(
      command.json
        ? stringify({
            ok: false,
            command: 'convert',
            results: [],
            error: usageFailure(command.message)
          })
        : ''
    )
    return EXIT.USAGE
  }

  const { request, json, out, recipePath } = command.options
  const registry = new JobRegistry(1)

  // Ctrl-C / SIGTERM 不能直接退：在跑的 ffmpeg 会成为孤儿（约束 3）。
  // `shutdown()` 会让每个活动任务触发 `CancelToken`，引擎侧再去 `taskkill /T /F`。
  let closing = false
  const onSignal = (signal: string): void => {
    if (closing) return
    closing = true
    log(`收到 ${signal}，正在取消…`)
    registry.shutdown()
    // 给 taskkill 一点时间真的跑完，与 `src/mcp/main.ts` 的收尾同一个形状。
    setTimeout(() => process.exit(EXIT.INTERRUPTED), 500)
  }
  process.on('SIGINT', () => onSignal('SIGINT'))
  process.on('SIGTERM', () => onSignal('SIGTERM'))

  const results: CliResult[] = []
  let failure: CliFailure | null = null

  const loaded = loadRecipe(recipePath)
  const recipe: Recipe = loaded.ok ? loaded.recipe : {}
  if (!loaded.ok) failure = usageFailure(loaded.message)

  // 配方不认时**一个源文件都不转**：拿一份半懂的配置去动用户的文件，
  // 比什么都不做坏得多。空集合在这里是刻意的，不是省事。
  for (const source of loaded.ok ? request.paths : []) {
    try {
      const result = await convertOne(registry, source, request.to, out, recipe)
      results.push(result)
      log(`${source} → ${result.output}`)
    } catch (error) {
      const failed = failureFrom(error, source)
      // **第一条失败决定退出码**（多文件时后面的失败只进 JSON）。理由：退出码只能表达
      // 一件事，而调用方最该先处理的就是第一条——后面的多半是它的连带结果。
      if (failure === null) failure = failed
      log(`${source} 失败：${failed.message}`)
      for (const line of failed.log_tail ?? []) log(`  | ${line}`)
    }
  }

  const payload: CliPayload = {
    ok: failure === null,
    command: 'convert',
    results,
    ...(failure === null ? {} : { error: failure })
  }

  // 非 `--json` 时 stdout 只有产物路径（一行一个），**失败时为空**。
  const text = json
    ? stringify(payload)
    : results.length === 0
      ? ''
      : `${results.map((r) => r.output).join('\n')}\n`

  await writeStdout(text)
  return failure === null ? EXIT.OK : exitCodeFor(failure.code)
}

/** 一次调用 stdout 上恰好一个 JSON 文档（带尾换行）。 */
function stringify(payload: CliPayload): string {
  return `${JSON.stringify(payload, null, 2)}\n`
}

/* ------------------------------------------------------------------ 路径装配 */

/** 从环境变量里读一个路径，没给就返回 null（调用方决定默认值）。 */
function envPath(name: string): string | null {
  const value = process.env[name]
  return value !== undefined && value.trim() !== '' ? resolve(value.trim()) : null
}

/**
 * 算出一份能用的 `AppPaths`，并且**只在结构性判据证明装配与实际不符时**往 stderr 报一句。
 *
 * 与 `src/mcp/main.ts` 的 `resolvePaths()` 是同一件事——那边的注释解释了为什么
 * 「猜错」的代价是「引擎明明装好了却报未就绪」这种几乎无法归因的错。
 * 两条入口共用同一组 `ARBITER_*` 变量名，启动器（`plugins/arbiter/mcp/target.mjs`）
 * 对两者一视同仁地传。
 *
 * ## 告警范围是收窄过的（2026-09-15）
 *
 * 原先的判据是「**凡是没给环境变量的值都报**」，实测下来它对着三种**正常形态**都会响，
 * 而三条猜出来的值**全都是对的**：
 *
 *   - **仓库形态**（`tsx src/cli/main.ts`；`npm run test:cli` 每一次 spawn 都是它）：
 *     `appPath` 猜成仓库根、`userData` / `downloads` 猜成标准位置——分别都对；
 *   - **打包形态走 `arbiter.cmd`**：那个 shim 只给 `APP_PATH` / `RESOURCES_PATH` /
 *     `IS_PACKAGED` 三件，`userData` 与 `downloads` 仍然靠猜，而
 *     `%APPDATA%\Arbiter` 就是 Electron 的 userData（实测：那儿躺着 `settings.json`
 *     与 `engines/`）、`~/Downloads` 就是 `app.getPath('downloads')`。
 *
 * 而**真正会出事的那一处，旧代码一个字都没说**（实测：打包形态漏给
 * `ARBITER_RESOURCES_PATH` 时它只报了 `userData` 与 `downloads` 这两条**对的**值）。
 * 所以判据换成下面两条——都是「这个值本身站不站得住」，不是「有没有给环境变量」：
 *
 *   1. 打包形态下 `resourcesPath` 必须真的存在；
 *   2. `appPath` 指着 asar，`ARBITER_IS_PACKAGED` 却不是 `1`（引擎解析会走 dev 分支）。
 *
 * ## 为什么 `userData` / `downloads` 一条判据都没有
 *
 * 不是忘了：**它们猜错时在这一层拿不到任何结构性证据**。「目录不存在」只说明这台机器
 * 还没装过引擎、还没存过设置——那是完全正常的状态（设置与历史都是懒创建的），
 * 拿它报警只会把正常形态打回噪音。而这两个值真正的核对点也不在这里：装机那份是
 * `plugins/arbiter/mcp/target.mjs` 的 `defaultUserData()`，它**总是显式传**
 * `ARBITER_USER_DATA`（打包形态）——所以「猜」只发生在仓库形态，而那里猜得准。
 */
function resolvePaths(): AppPaths {
  /** 这个文件在 `<仓库根>/src/cli/main.ts`，往上两层是仓库根（构建产物是 `out/main/cli.js`，同深度） */
  const here = fileURLToPath(new URL('.', import.meta.url))
  const guessedAppPath = resolve(here, '..', '..')

  const appPath = envPath('ARBITER_APP_PATH') ?? guessedAppPath
  const isPackaged = process.env.ARBITER_IS_PACKAGED === '1'
  const resourcesPath =
    envPath('ARBITER_RESOURCES_PATH') ?? (isPackaged ? join(appPath, 'resources') : '')

  const guessedUserData =
    process.platform === 'win32'
      ? join(homedir(), 'AppData', 'Roaming', 'Arbiter')
      : join(homedir(), '.config', 'Arbiter')
  const userData = envPath('ARBITER_USER_DATA') ?? guessedUserData
  const downloads = envPath('ARBITER_DOWNLOADS') ?? join(homedir(), 'Downloads')

  const paths: AppPaths = { isPackaged, resourcesPath, appPath, userData, downloads }

  const problems: string[] = []

  // 判据一：打包形态下 `resourcesPath` 必须存在。
  // 漏给 `ARBITER_RESOURCES_PATH` 时它被派生成 `join(appPath, 'resources')`，而打包形态的
  // `appPath` 已经指进 `resources\app.asar` 里 —— 于是这条路径**落在 asar 内部、必然不存在**，
  // 随包引擎（`7zip-full` / `pandoc`）全部被判成「没装」。实测的落地形态：
  // 只剩 `7zip-bin` 那个精简版 `7za.exe` 兜底，于是**RAR 悄悄不支持了**，一句错都不报
  // （同一件事在 `build/arbiter.cmd` 的注释里记着原始观测）。
  // ffmpeg 这个症状看不出来——asar 里还躺着一份 ffmpeg-static 能兜住。
  if (isPackaged && !existsSync(resourcesPath)) {
    problems.push(
      `resourcesPath=${resourcesPath} 不存在：打包形态下随包引擎就在它下面，` +
        '缺了它会被判成「没装」'
    )
  }

  // 判据二：`appPath` 指着 asar，但 `ARBITER_IS_PACKAGED` 不是 `1`。
  // 于是 `bundledEnginePath()` 走 dev 分支（`join(appPath, 'resources', 'engines', …)`），
  // 那条路径同样落在 asar 内部；`pdfWorker` 也会去 asar 里找 electron.exe。
  // 这条正是 `arbiter.cmd` 自己的注释里记着的那次事故的另一半（它一开始只设了
  // `ELECTRON_RUN_AS_NODE`）——两个变量少一个，症状一模一样。
  if (!isPackaged && isAsarPath(appPath)) {
    problems.push(
      `appPath=${appPath} 指向 asar 内部，但 ARBITER_IS_PACKAGED 不是 1：` +
        '引擎解析会走 dev 分支，随包引擎找不到'
    )
  }

  if (problems.length > 0) {
    // 五条值本身也打出来：它们**只在出事时**才打，而那一刻正是人要看它们的时刻。
    // 环境变量名写全，**不写「见 --help」**——`USAGE` 里根本没有这一段，那会把人指到
    // 一个查不到的地方去（与约束 21 里那句误导性的「这个安装包可能早于 0.2.0」同一个毛病）。
    const used = [
      `    appPath=${appPath}`,
      `    resourcesPath=${resourcesPath}`,
      `    userData=${userData}`,
      `    downloads=${downloads}`,
      `    isPackaged=${isPackaged}`
    ]
    // 只走 stderr：stdout 是数据通道（见 `./stdio.ts` 与 docs/NOTES.md 约束 20）。
    process.stderr.write(
      '[arbiter] 路径装配与实际不符（这会让已经装好的引擎被判成「没装」）：\n' +
        problems.map((p) => `  - ${p}\n`).join('') +
        '  本次实际用的值（ARBITER_APP_PATH / ARBITER_RESOURCES_PATH / ' +
        'ARBITER_IS_PACKAGED / ARBITER_USER_DATA / ARBITER_DOWNLOADS 可以覆盖）：\n' +
        used.map((line) => `${line}\n`).join('')
    )
  }
  return paths
}

/** 版本号：读得到 package.json 就用它，读不到不编（与 MCP 入口同一手法）。 */
function resolveVersion(): string {
  try {
    const raw: unknown = JSON.parse(readFileSync(join(PATHS.appPath, 'package.json'), 'utf8'))
    if (typeof raw === 'object' && raw !== null && 'version' in raw) {
      const version = (raw as { version?: unknown }).version
      if (typeof version === 'string' && version.length > 0) return version
    }
  } catch {
    // 打包后 appPath 指向 app.asar——普通 Node 读不进去，Electron 的 node 模式读得进去。
    // 读不到就算了，不编一个数字出来。
  }
  return '0.0.0'
}

/* ------------------------------------------------------------------ 引导 */

// 闸门先装上，再装配路径——`resolvePaths()` 会往 stderr 报「哪些值是猜的」，
// 那正是这套纪律要保护的东西：它必须走 stderr，不能漏进 stdout。
protectStdout()
const PATHS = resolvePaths()
setAppPaths(PATHS)

main()
  .then((code) => {
    // 显式 exit：转换跑完之后理论上没有活动句柄，但引擎那条链上任何一个没被清掉的
    // 计时器都会让进程挂着不退——对 hook 那条路来说，挂着就是「超时」。
    // stdout 已经在 `writeStdout()` 里等过写入回调，这里退出不会截断数据。
    process.exit(code)
  })
  .catch((error: unknown) => {
    // 走到这里说明是 `main()` 自己出了我们没预料到的事。**仍然只往 stderr 写**：
    // stdout 上此刻可能已经有一个合法的 JSON 了（比如多文件时中途炸），
    // 再补一段文本进去等于亲手把它变成垃圾。
    log(`[arbiter] 未预期的错误：${error instanceof Error ? error.message : String(error)}`)
    if (error instanceof Error && error.stack) log(error.stack)
    process.exit(EXIT.INTERNAL)
  })
