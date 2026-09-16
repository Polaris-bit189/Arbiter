import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { DownloadTransport, EngineManifest, EngineManifestEntry } from './downlink'
import { ConversionCanceled } from '../converters/common'
import type { CancelToken } from './cancel'
import { appPaths } from './appPaths'
import { killTree } from './kill'
import { getSettings } from './settings'
// 静态引这两个是安全的：它们只依赖 fs / path / 设置，都不碰 electron。
// （本模块要能在 MCP 那条**没有 Electron** 的链路里被 `core/task.ts` 加载，见约束 19。）
import { resetHeavyCache } from '../engines/heavy'
import { resetPandocCache } from '../engines/pandoc'
import { sevenZipPath } from '../engines/sevenzip'

/**
 * 「按需下载一个重型引擎」的完整动作：**下载 → 校验 → 解包 → 落到 engineDir**。
 *
 * ## 为什么单独成文件
 *
 * `core/downlink.ts` 只负责把字节拿到本地（多镜像、续传、sha256），
 * **它刻意不管拿到之后怎么办**。而「怎么办」有两个很不一样的实现
 * （MSI 走 `msiexec /a`、wheel 走 7z 抽单文件），且两者都**必须**按
 * 约束 16 / 14 那两条实测结论来写，否则产物是一棵跑不起来的树。
 *
 * ⚠️ **这个模块在 M7 收尾之前根本不存在**：`downlink.ts` 的消费侧写完了、
 * 149 条断言也全绿，但 `src/` 里**没有任何一个调用者**——`loadManifest` /
 * `engineDownloadPlan` / `downloadEngine` 只被 `scripts/test-downlink.ts` import。
 * 干净机器上的表现是：`md → docx` 直接失败，一个字节都没下，然后让用户去跑
 * 仓库里的 `node scripts/fetch-pandoc.mjs`（装了安装包的人根本没有那个脚本）。
 *
 * ## 两条进口约束
 *
 * - **不 import electron。** 本模块被 `core/task.ts` 引用（转换时自动下载），
 *   而 `task.ts` 在 MCP 那条**没有 Electron** 的链路里也要能加载（约束 19）。
 *   所以 `downlink.ts`（它 `import { net } from 'electron'`）只能**动态** import，
 *   类型用 `import type` 引（编译期擦除，不进依赖图）。传输层由调用方注入：
 *   Electron 侧给 `createNetTransport()`，测试给本地 http 实现。
 * - **不自己解析引擎路径。** 装完之后「去哪儿找」由 `engines/heavy.ts` /
 *   `engines/pandoc.ts` 的候选数组回答，这里只保证**落点正确**，
 *   然后调它们的 reset 让缓存重新探测（那两个缓存是三态的，见各自的注释）。
 */

/** 进度。`phase` 只有两段——解包那一段没有细粒度进度可报（msiexec 的 `-qn` 不吐百分比） */
export type InstallPhase = 'download' | 'extract'

export interface InstallProgress {
  engine: string
  phase: InstallPhase
  /** 已拿到的字节数。解包阶段保持不变（等于整包大小） */
  receivedBytes: number
  /** 整包大小。清单里写着，所以下载一开始就是已知的 */
  totalBytes: number
  /** 0~1；解包阶段恒为 null（上面那句注释），UI 要显示 indeterminate */
  percent: number | null
}

/**
 * 跑一个解包子进程。**默认真起进程**，测试注入一个假的。
 *
 * 这个缝是必要的而不是为了好看：真的解一次 LibreOffice 要 **29 秒 + 1.49 GiB**，
 * 那段编排逻辑（先解到 `.installing` 再整体改名、失败要清干净、取消要杀进程树）
 * 才是这个模块里唯一容易写错的部分，而它跟「解的是哪个 MSI」毫无关系。
 */
export type InstallRunner = (
  exe: string,
  args: string[],
  cancel: CancelToken | undefined
) => Promise<void>

export interface InstallOptions {
  /** 不传就用 `setInstallTransport()` 注入的那个。**测试走这条路传假的** */
  transport?: DownloadTransport
  onProgress?: (progress: InstallProgress) => void
  cancel?: CancelToken
  /** 测试注入用。生产环境别传——默认那个才是真的在解包 */
  run?: InstallRunner
}

export interface InstallResult {
  engine: string
  /** 可执行文件的绝对路径（`engineDir/<targetDir>/<entry>`） */
  exe: string
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * 解包步骤的超时。**这条不是「防御性编程」，是被真事逼出来的。**
 *
 * 2026-09-13 实测：这台机器上 `msiserver`（Windows Installer 服务）处于 STOPPED，
 * 于是 `msiexec.exe` 起来之后**一直等那个服务**——
 *   - `sc query msiserver` → `STATE: 1 STOPPED`，`START_TYPE: 3 DEMAND_START`；
 *   - 同时 `Session ManagerPendingFileRenameOperations` 里挂着一条待重启的更新。
 * 现象是：手工跑**同一条命令**（完全绕开本项目的代码）也挂足 150 秒不返回；
 * 日志文件（`/L*v`）**压根没被创建**，说明 msiexec 连命令行都没解析到。
 *
 * 没有超时的话，用户看到的是「正在安装 LibreOffice 引擎…」**永远转下去**：
 * 不报错、不失败、不产出，只能手动取消。而这条路上一次要下 375 MB，
 * 用户很容易把它理解成「还在下」而一直等。
 *
 * 5 分钟是个够宽的界：实测一次正常的 LibreOffice 解包是 **29 秒**（约束 16），
 * Calibre 5 秒，7z 抽单文件不到 1 秒。
 */
const EXTRACT_TIMEOUT_MS = 5 * 60_000

/** 默认执行器：`spawn` 数组参数（约束 2）、取消时杀**进程树**（约束 3） */
const spawnRunner: InstallRunner = (exe, args, cancel) =>
  new Promise<void>((resolve, reject) => {
    const child = spawn(exe, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })

    // 超时到了先杀进程树再拒绝。**杀树是必须的**：msiexec 会拉起 `msiexec` 的
    // 服务端进程，只杀父进程会把它留在那儿占着安装互斥量，之后的每一次安装
    // 都会跟着挂住（与约束 3 里 soffice/soffice.bin 那个坑同构）。
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      void killTree(child.pid)
    }, EXTRACT_TIMEOUT_MS)

    let stderr = ''
    child.stderr?.on('data', (chunk: Buffer) => {
      // 只留尾巴：msiexec 出事时会倒出几百行 MSI 日志
      stderr = (stderr + chunk.toString()).slice(-4000)
    })

    cancel?.onCancel(() => {
      void killTree(child.pid)
    })

    child.on('error', (err) => {
      clearTimeout(timer)
      reject(new Error(`无法启动 ${basename(exe)}：${err.message}`))
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      // 超时的判据单独一条，而且**排在取消之前**：超时时我们主动杀了树，
      // 而杀树会让 `close` 报一个非零码，不先判超时的话用户会看到一句
      // 「退出码 1」——那跟他真正遇到的事毫无关系。
      //
      // ⚠️ **文案的第一句是「进程无响应」，不是「服务没运行」。**
      // 这里原来把「Windows Installer 服务没有运行」放在第一位——而真机上实测到的那次挂起，
      // **服务是好的**（StartType=Manual，手工跑同一条命令 25 秒成功），真因是我们自己传出去的
      // 参数畸形（见 `extractCommand` 里那段 D1 的说明）。
      // 把最可能的原因放在第一句，等于**主动把排查的人引向错的方向**——
      // 而这类「看起来很确定」的误诊，比一句泛泛的失败更费时间。
      //
      // 退出状态与完整命令行由调用方附上（它才知道日志落在哪）。
      if (timedOut) {
        return reject(
          new Error(
            `${basename(exe)} 超过 ${Math.round(EXTRACT_TIMEOUT_MS / 60_000)} 分钟没有结束，已终止。` +
              '它多半是**零 I/O 地挂住**了——也就是进程还在、但什么都没在做。' +
              '其次才轮到环境问题：Windows Installer 服务没起来（`sc query msiserver` 看状态）、' +
              '或系统有待重启的挂起操作。' +
              '别先猜：这条错误后面会附上诊断日志的路径，那一份比任何推测都有用。' +
              '处理完可以直接重试，已下好的安装包会保留、不会重下。'
          )
        )
      }
      // 取消判在退出码之前：被 `taskkill /T /F` 杀掉的进程报的是**非零退出码**，
      // 先看码就会把「用户取消了」报成「解包失败」（约束 3 那份实测）。
      if (cancel?.canceled) return reject(new ConversionCanceled())
      if (code === 0) return resolve()
      reject(
        new Error(
          `${basename(exe)} 退出码 ${code}${stderr.trim() === '' ? '' : `：${stderr.trim()}`}`
        )
      )
    })
  })

/* ------------------------------------------------------------------ 传输层 */

/**
 * 传输层由**入口注入**，与 `core/appPaths.ts` 的 `setAppPaths()` 同一个理由：
 * 本模块要在**没有 Electron** 的进程里被加载（`core/task.ts` 引它，而 task.ts
 * 在 MCP 那条链路上也要能加载，见约束 19），而真实的传输层
 * `createNetTransport()` 依赖 `electron.net`。
 *
 * **没装就抛，刻意不做「兜底去问 electron 要」**：那种兜底在纯 Node 下不会报错
 * （`require('electron')` 返回的是 electron.exe 的路径**字符串**），
 * 于是 `net` 是 undefined、下载永远失败，而报错信息跟真实原因毫无关系。
 * 这也是 `appPaths.ts` 当初选择直接抛而不是兜底的同一条理由。
 */
let injectedTransport: DownloadTransport | null = null

export function setInstallTransport(transport: DownloadTransport): void {
  injectedTransport = transport
}

function requireTransport(): DownloadTransport {
  if (injectedTransport === null) {
    throw new Error(
      '下载传输层未注入：Electron 入口要调 setInstallTransport(createNetTransport())，' +
        'MCP 入口要自己给一个基于 node:https 的实现'
    )
  }
  return injectedTransport
}

/* ------------------------------------------------------------------ 清单 */

/**
 * 清单在哪儿。**打包前后只有根不同**，与 `appPaths.ts` 其余路径同一个形状：
 * dev 是仓库根，打包后是 `app.asar` —— 里面的 `resources/engines.manifest.json`
 * 被 electron-builder 的 `asarUnpack` 解到了 `app.asar.unpacked/`，
 * 但两条路径都读得到（`fs` 的 asar 补丁），所以不必像 `unpackedPath()` 那样换前缀。
 */
export function manifestPath(): string {
  return manifestOverride ?? join(appPaths().appPath, 'resources', 'engines.manifest.json')
}

/**
 * 换掉清单来源。**只有测试用**，与 `core/integration.ts` 的 `setContextMenuRootForTest`
 * 同一个手法。
 *
 * 为什么必须要这个缝：真清单指向的是 375 MB / 223 MB / 40 MB 三个真实镜像，
 * 而这里要断言的编排逻辑（先解到 `.installing` 再整体改名、失败清干净、单飞、
 * sha 对不上要抛、缓存要重置）**与解的是哪个包毫无关系**。没有这个缝，
 * 这些断言就只能对着真实下载写——那既跑不进聚合，也没人会在改代码后重跑。
 */
let manifestOverride: string | null = null

export function setManifestPathForTest(path: string | null): void {
  manifestOverride = path
  manifestCache = null
}

/**
 * 清单只读一次，而且**只在成功时缓存**。
 *
 * 缓存失败的结果会让一次读盘抖动变成「这个进程永远装不了引擎」；
 * 这个模块本来就不在热路径上（一次下载几百兆），多读一次盘的代价可以忽略。
 */
let manifestCache: Promise<EngineManifest> | null = null

export function loadEngineManifest(): Promise<EngineManifest> {
  if (manifestCache === null) {
    manifestCache = import('./downlink')
      .then((mod) => mod.loadManifest(manifestPath()))
      .catch((err: unknown) => {
        manifestCache = null
        throw new Error(`读不到引擎清单「${manifestPath()}」：${messageOf(err)}`)
      })
  }
  return manifestCache
}

/** 测试用：丢掉清单缓存与单飞表 */
export function resetEngineInstallForTest(): void {
  manifestCache = null
  inFlight.clear()
}

/* ------------------------------------------------------------------ 单飞 */

/**
 * 同一个引擎同一时刻只装一次。
 *
 * 没有它的话，一批文档（一个 docx + 一个 xlsx）会同时发现「没有 LibreOffice」，
 * 然后**并发下同一个 375 MB**、并发解同一棵树——两个 msiexec 往同一个
 * `TARGETDIR` 里写字，产物是两半混在一起，而 sha 校验早在下载那一步就过了，
 * 所以没有任何一道闸会拦住它。
 *
 * 后到的调用者拿到的是**同一个 promise**（因此也共享前一个的 `onProgress`）。
 * 这比拒绝或排队都好：它要的那个引擎，前一次装完就在那儿了。
 */
const inFlight = new Map<string, Promise<InstallResult>>()

/** 正在装的引擎（诊断与测试用） */
export function installInFlight(): string[] {
  return [...inFlight.keys()]
}

/* ------------------------------------------------------------------ 主流程 */

export function installEngine(key: string, options: InstallOptions): Promise<InstallResult> {
  const existing = inFlight.get(key)
  if (existing !== undefined) return existing

  const task = runInstall(key, options).finally(() => {
    inFlight.delete(key)
  })
  inFlight.set(key, task)
  return task
}

async function runInstall(key: string, options: InstallOptions): Promise<InstallResult> {
  const mod = await import('./downlink')
  const manifest = await loadEngineManifest()
  const entry = mod.manifestEntry(manifest, key)
  if (entry === null) throw new Error(`引擎清单里没有「${key}」，无法下载`)

  const engineDir = getSettings().engineDir
  const target = join(engineDir, entry.extract.targetDir)
  // 解到 `.installing` 再从整体改名过去。**不能直接往 target 里解**：msiexec 要跑
  // 29 秒，中间被取消或断掉就留下一棵半截的树，而它长得跟完整的树很像
  // （`soffice.exe` 在、`soffice.bin` 可能还不在）——下一次启动解析到这里就会
  // 判「有引擎」，然后每次转换都报一个看不懂的错。整体改名是原子的，磁盘上
  // 要么是旧的（没有），要么是新的（完整）。
  const staging = `${target}.installing`
  const packageDir = join(engineDir, '.packages')

  await mkdir(packageDir, { recursive: true })

  // 顺手扫掉**上一次**留下的残骸（见 `sweepStaleStaging`）。放在下载之前：
  // 一次 LibreOffice 残骸是 1.4 GiB 量级，早点腾出来，下载那段时间就有空间了。
  const swept = await sweepStaleStaging(manifest, mod, engineDir)
  if (swept.length > 0) {
    // 不静默：这是「上一次没装完」这个事实的唯一痕迹，用户磁盘上刚少了一坨东西，
    // 事后要能解释得清。走 stderr（`console.warn`），不进任何数据通道。
    console.warn(`[engine] 清掉了上次没装完的残骸：${swept.join('、')}`)
  }

  const transport = options.transport ?? requireTransport()
  const plan = mod.engineDownloadPlan(manifest, key, packageDir)
  const totalBytes = plan.sizeBytes

  const report = (phase: InstallPhase, receivedBytes: number, percent: number | null): void => {
    options.onProgress?.({ engine: key, phase, receivedBytes, totalBytes, percent })
  }

  // ---- 下载
  await ensurePackage(mod, manifest, key, plan, packageDir, transport, report, options.cancel)

  throwIfCanceled(options.cancel)

  // ---- 解包
  report('extract', totalBytes, null)
  await removeTreeQuietly(staging)
  await mkdir(staging, { recursive: true })

  let msiLog: string | null = null
  try {
    const { exe, args, logPath } = extractCommand(entry, plan.dest, staging)
    msiLog = logPath
    await (options.run ?? spawnRunner)(exe, args, options.cancel)
    await assertExtracted(entry, staging)
  } catch (err) {
    // 半截的树必须清掉。留着的话下一次进来 `existsSync` 判据可能**通过**
    //（比如 LibreOffice 的 `soffice.exe` 已经落地、`soffice.bin` 还没），
    // 于是「装了一半」被当成「装好了」，而报错会出现在一个跟下载毫无关系的地方。
    await removeTreeQuietly(staging)
    // 把诊断日志的路径附上去。**取消不附**：那是用户自己要停的，不是故障。
    if (msiLog !== null && err instanceof Error && !(err instanceof ConversionCanceled)) {
      err.message += `\n（msiexec 的诊断日志：${msiLog}）`
    }
    throw err
  }

  await removeTreeQuietly(target)
  await rename(staging, target)

  // 成功之后才删安装包：失败时留着，重试那一步就能跳过下载（上面 packageIsValid）。
  await rm(plan.dest, { force: true }).catch(() => undefined)

  // ★ 漏掉这一步的表现是「下载成功了，但永远显示未就绪」：那三个解析器的缓存是
  // 三态的，`null`（探过了、没有）会被永久写死。`heavy.ts` 与 `pandoc.ts` 的注释里
  // 都点名了「按需下载落盘」这个入口要调它们——只是当时还没有调用者。
  resetHeavyCache()
  resetPandocCache()

  return { engine: key, exe: join(target, entry.entry ?? '') }
}

/**
 * 把安装包弄到本地。已下过、且哈希对得上就跳过（解包失败重试时不必重下 375 MB）。
 *
 * **单独抽成一个函数是为了让「失败必须抛」这条策略有一个能被反证的唯一点。**
 * 它最容易被改坏的方向恰恰是「为了容错把错误吞掉」——而那份代码看起来很像在
 * 做好事（「网络抖一下就重试嘛」）。可后果是：解一个**没通过 sha256 的包**，
 * 也就是把整条下载设计里最值钱的那道闸拆了。反证脚本里有一个变异专门打它。
 */
async function ensurePackage(
  mod: typeof import('./downlink'),
  manifest: EngineManifest,
  key: string,
  plan: ReturnType<typeof import('./downlink').engineDownloadPlan>,
  packageDir: string,
  transport: DownloadTransport,
  report: (phase: InstallPhase, receivedBytes: number, percent: number | null) => void,
  cancel?: CancelToken
): Promise<void> {
  if (await packageIsValid(plan.dest, plan.sha256)) return

  report('download', 0, 0)
  await mod.downloadEngine(manifest, key, packageDir, transport, {
    ...(cancel === undefined ? {} : { cancel }),
    onProgress: (p) => report('download', p.received, p.percent)
  })
}

/** 已下过、且 sha256 与清单一致。**只信哈希**：长度相同、内容不同的包是真实存在的 */
async function packageIsValid(path: string, sha256: string): Promise<boolean> {
  if (!existsSync(path)) return false
  const mod = await import('./downlink')
  try {
    return (await mod.sha256File(path)) === sha256
  } catch {
    return false
  }
}

/**
 * 解包命令。
 *
 * 两条路都**绝不能**用 `7z x` 解 MSI（约束 16：`7z x` 会丢掉 Directory 表，
 * 解出 100% 扁平的树，`Everything is Ok`、退出码 0，跑起来才 0xC0000135）。
 */
function extractCommand(
  entry: EngineManifestEntry,
  pkgPath: string,
  staging: string
): { exe: string; args: string[]; logPath: string | null } {
  const { extract } = entry

  if (extract.method === 'msiexec-a') {
    // ⚠️ **`TARGETDIR` 的值里绝不能有内层引号。**
    //
    // 这里原来写的是 `TARGETDIR="${staging}"`，注释还说那对引号「是承重的」——
    // **那是错的，而且是致命的**：Node 的 `spawn` 会把参数里出现的 `"` 转义成 `\"`
    //（它按 MSVC 那套规则拼命令行），于是真正送到 msiexec 手上的长这样：
    //
    //     "TARGETDIR=\"C:\...\libreoffice.installing\""
    //
    // 而 Windows 的命令行解析里**反斜杠不是双引号的转义符**。msiexec 拿到这个畸形
    // 参数之后**不报错、不退出，直接挂住**（零 CPU、零 I/O），只能等超时。
    //
    // 实测（2026-09-14，真实的 LibreOffice 26.8.0 MSI，同一台机器，只差这一对引号）：
    //   无内层引号 → 成功，23.2 秒，退出码 0，解出 14 个顶层条目
    //   有内层引号 → 挂死 45 秒以上，目标目录 0 个条目
    //
    // 路径含空格也不怕：Node 会因为**整个参数里有空格**而把它整体引起来，
    // 那才是 msiexec 认的形状（`"TARGETDIR=C:\Users\Zhang San\..."`）。
    //
    // ⚠️ 顺带说明这条为什么能活到今天：那条链路上**没有自动测试碰过真的 msiexec**
    //（`test-engine-install.ts` 的 runner 是注入的假解包器），而打包形态的实测
    // 又卡在本机旧版 `msiserver` 起不来——**两头都够不着**，于是它一直是错的。
    const logPath = `${staging}.log`
    return {
      exe: 'msiexec.exe',
      // `/L*v` 是**诊断的命根子**：msiexec 挂住时它是唯一能看清内部状态的东西
      //（审计者手工跑同一条命令时那份日志有 31 MB，而我们那次挂起零 I/O、零输出，
      // 排查的人手里什么都没有）。路径会随错误一起报出去。
      args: ['/a', pkgPath, '/qn', `TARGETDIR=${staging}`, '/L*v', logPath],
      logPath
    }
  }

  // `7z e`（不是 `x`）：抽出来时**丢掉归档内的目录**，于是 wheel 里那个
  // `pypandoc/files/pandoc.exe` 直接落成 `<staging>/pandoc.exe`，
  // 正好等于清单 `entry` 字段写的那一个路径，两条路线的落点因此统一。
  return {
    exe: sevenZipPath(),
    args: ['e', pkgPath, `-o${staging}`, extract.entryInArchive ?? '', '-y'],
    // 7z 不需要额外的诊断日志：它的报错本来就在 stderr 上
    logPath: null
  }
}

/**
 * 解包之后**复核产物**，而不是「命令退出码是 0 就当好了」。
 *
 * 三条各自的来历：
 *   - 找不到 `entry`：`7z e` 的条目名拼错时**一个文件都不会抽出来、退出码仍是 0**，
 *     唯一的观测点就是这里；
 *   - 体积对不上：wheel 里那个 pandoc.exe 的 sha256 与本项目另外拿到的
 *     GitHub zip 里那个**大小相同、内容不同**，所以清单用
 *     `expectedEntrySizeBytes` 单独钉了一层（见约束 14 那段）；
 *   - LibreOffice 的「同目录还得有谁」不在这里判——那是 `engines/heavy.ts` 的
 *     `isLibreOfficeUsable()`，两处判据不一样，别在这里另写一份。
 */
async function assertExtracted(entry: EngineManifestEntry, staging: string): Promise<void> {
  const relative = entry.entry
  if (relative === undefined || relative === '') {
    throw new Error(`引擎「${entry.key}」的清单里没写 entry，装完之后无法校验`)
  }

  const produced = join(staging, relative)
  if (!existsSync(produced)) {
    throw new Error(
      `解包完成但没找到「${relative}」——解出来的目录树与清单对不上（引擎 ${entry.key}）`
    )
  }

  const expected = entry.extract.expectedEntrySizeBytes
  if (expected !== undefined) {
    const actual = (await stat(produced)).size
    if (actual !== expected) {
      throw new Error(
        `解出来的「${relative}」是 ${actual} 字节，清单说应当是 ${expected} 字节（引擎 ${entry.key}）`
      )
    }
  }
}

/**
 * 递归删一棵树，失败重试。
 *
 * **不能用 `converters/common.ts` 的 `removeQuietly`**：那个是 `rm(target, {force:true})`，
 * 对**目录**会抛 `ERR_FS_EISDIR`，而它把异常吞掉重试三次之后就静默返回——
 * 于是「清掉半截的树」这一步变成空操作，恰好把上面那个坑重新打开一遍。
 */
async function removeTreeQuietly(target: string): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await rm(target, { recursive: true, force: true })
      return
    } catch {
      // Windows 上刚被 msiexec 放手的目录可能还被占着一小会儿
      await new Promise((done) => setTimeout(done, 150))
    }
  }
}

/** 解包的暂存目录后缀。`<engineDir>\<targetDir>.installing`，与 `runInstall` 里那处成对 */
const STAGING_SUFFIX = '.installing'

/**
 * 扫掉上一次留下的 `.installing` 残骸。**返回被清掉的那些名字**（供上面那句 warn）。
 *
 * ## 为什么需要它
 *
 * 失败那一路已经在 `catch` 里清过树了，但它**不是百分百成功的**，而失败是静默的：
 *
 * - 超时那条路先 `taskkill /T /F` 再清树。msiexec 的服务端进程放手目录要一小会儿，
 *   而 `removeTreeQuietly` 三次重试一共只等 450 ms——**实测中过一次**：Agent 被
 *   `taskkill` 掉了，目录却还占着，于是 `libreoffice.installing\` 留在了盘上
 *   （审计 D6 看到的就是它，空的，因为我们连一个字节都还没写进去）。
 * - 更彻底的一类：进程被直接杀掉（任务管理器结束进程、断电、`taskkill /IM Arbiter.exe`），
 *   `catch` 那一行**根本不会执行**，留下的是一棵**有内容的**半截树。
 *
 * ## 为什么要扫「所有」引擎，而不只扫当前这个
 *
 * `runInstall` 的 325 行本来就清了**当前**这个引擎的暂存目录，所以只修自己那条路
 * 等于没修——留下残骸的原因是「用户再也没重试过这个引擎」，而那一刻他重试的是
 * **另一个**。扫全部之后，任何一次安装都会顺手把别人的残骸一起带走。
 *
 * ## 为什么必须跳过「正在装」的引擎
 *
 * ⚠️ 单飞（`inFlight`）是**按引擎的**：LibreOffice 与 Calibre 可以同时在装，
 * 而扫盘那一刻另一个正好在解包——删掉它的暂存目录，产物就是一棵**少了半截、
 * 却长得很完整**的树（与「直接往 target 里解」是同一个坑，只是成因反过来）。
 * 判据用 `inFlight` 而不是「目录的 mtime 够不够旧」：时间戳判据在慢机器上
 * （`msiexec /a` 实测 29 秒、Calibre 5 秒）会误伤正在跑的那一个。
 *
 * `.log` 是 `/L*v` 那份诊断日志，与暂存目录**同级、不在一起**（`${staging}.log`），
 * 所以清了树还要单独清它——否则残骸在盘上留一份 32 MB 的日志（约束 16 实测过那个尺寸）。
 */
async function sweepStaleStaging(
  manifest: EngineManifest,
  mod: typeof import('./downlink'),
  engineDir: string
): Promise<string[]> {
  // 正在装的那些引擎的 targetDir —— 一个都不许碰
  const busy = new Set<string>()
  for (const key of inFlight.keys()) {
    const e = mod.manifestEntry(manifest, key)
    if (e !== null) busy.add(e.extract.targetDir)
  }

  let names: string[]
  try {
    names = await readdir(engineDir)
  } catch {
    // engineDir 还不存在（首次安装）。没有残骸可扫，不是错误。
    return []
  }

  const swept: string[] = []
  for (const name of names) {
    if (!name.endsWith(STAGING_SUFFIX)) continue
    const owner = name.slice(0, -STAGING_SUFFIX.length)
    if (busy.has(owner)) continue

    const full = join(engineDir, name)
    await removeTreeQuietly(full)
    // 只有真删掉了才算「清掉了」——`removeTreeQuietly` 会静默放弃，
    // 而报一个「清掉了」却还在盘上的残骸，比不报更坏（下一次没人再看它）。
    if (existsSync(full)) continue
    await rm(`${full}.log`, { force: true }).catch(() => undefined)
    swept.push(name)
  }
  return swept
}

function throwIfCanceled(cancel?: CancelToken): void {
  if (cancel?.canceled) throw new ConversionCanceled()
}
