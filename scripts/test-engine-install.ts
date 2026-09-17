import './install-test-paths'
import { createServer, request as httpRequest, type Server } from 'node:http'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appPaths, setAppPaths } from '../src/main/core/appPaths'
import { CancelToken } from '../src/main/core/cancel'
import { updateSettings } from '../src/main/core/settings'
import { ConversionCanceled } from '../src/main/converters/common'
import {
  installEngine,
  installInFlight,
  resetEngineInstallForTest,
  setManifestPathForTest,
  type InstallProgress,
  type InstallResult
} from '../src/main/core/engineInstall'
import { pandocEngine, resetPandocCache } from '../src/main/engines/pandoc'

/**
 * M7「按需下载引擎」的编排自测。
 *
 *   npx tsx --tsconfig tsconfig.test.json scripts/test-engine-install.ts
 *
 * ## 这份测的是**编排**，不是下载
 *
 * 下载本身（多镜像 / 续传 / sha256 / 416）已经被 `test-downlink.ts` 的 149 条钉住了，
 * 这里不重复。这里要盯的是「下完之后怎么把它变成一棵能跑的树」——那段逻辑才是
 * 真正踩过雷的地方，而且它的失败方式全都很难看：
 *
 *   - 直接往最终目录里解 → 中断后留一棵**半截但看起来完整**的树
 *     （`soffice.exe` 在、`soffice.bin` 不在），之后每次转换都报一个看不懂的错；
 *   - 同一个引擎并发装两次 → 两个 `msiexec` 往同一个 `TARGETDIR` 里写字；
 *   - 装完不重置解析器缓存 → 「下载成功了，但永远显示未就绪」，只能重启应用；
 *   - 清单里的条目名拼错 → `7z e` **一个文件都不抽、退出码仍是 0**。
 *
 * ## 为什么要 `setManifestPathForTest`
 *
 * 真清单指的三个包是 375 / 223 / 40 MB，跑不进聚合。而上面这些判据与「解的是哪个包」
 * 毫无关系，所以测试自带一份**合成清单**指向本地 http 服务器，再用注入的 runner
 * 假装解包（真跑一次 LibreOffice 要 29 秒 + 1.49 GiB）。
 *
 * 两条**不注入**的东西是刻意的：清单的**读取与校验**走真的解析器（`loadManifest`），
 * 下载走真的 `downloadEngine`——只把「网络在哪」和「谁来解包」换掉。
 */

const PAYLOAD = Buffer.from('Arbiter 引擎安装自测用的假安装包'.repeat(64), 'utf8')
const PAYLOAD_SHA = createHash('sha256').update(PAYLOAD).digest('hex')

let passed = 0
let failed = 0

function check(label: string, ok: boolean, detail?: string): void {
  if (ok) {
    passed += 1
    console.log(`  ✓ ${label}`)
  } else {
    failed += 1
    console.log(`  ✗ ${label}${detail ? `  ← ${detail}` : ''}`)
  }
}

async function thrownBy(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn()
    return null
  } catch (error) {
    return error
  }
}

/** 一份指向本地服务器的合成清单。`entryPatch` 用来单独盖掉某个字段 */
function manifestFor(port: number, entryPatch: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: 1,
    engines: [
      {
        key: 'demo',
        label: 'Demo',
        version: '1',
        kind: 'msi',
        sizeBytes: PAYLOAD.length,
        sha256: PAYLOAD_SHA,
        mirrors: [{ url: `http://127.0.0.1:${port}/demo.msi`, region: 'cn', verified: true }],
        // 默认落成一个中性的形状（与任何真实引擎都不重叠）。
        // **[1] 那一节会单独盖成 pandoc 形状**——只有 pandoc 的分辨路径能观察到
        // 「缓存有没有被重置」；其余各节没必要跟着那条判据走。
        extract: { method: 'msiexec-a', targetDir: 'demo' },
        entry: 'program/demo.exe',
        ...entryPatch
      }
    ]
  })
}

/** 本地镜像。请求计数是「下载只发生了一次」那条断言的唯一观测点 */
interface FakeMirror {
  server: Server
  port: number
  hits: number
  close: () => Promise<void>
}

function startMirror(body: Buffer, status = 200): Promise<FakeMirror> {
  const state: FakeMirror = { server: createServer(), port: 0, hits: 0, close: async () => {} }
  state.server.on('request', (_req, res) => {
    state.hits += 1
    if (status !== 200) {
      res.writeHead(status)
      res.end()
      return
    }
    res.writeHead(200, { 'content-length': String(body.length) })
    res.end(body)
  })
  return new Promise((done) => {
    state.server.listen(0, '127.0.0.1', () => {
      const address = state.server.address()
      state.port = typeof address === 'object' && address !== null ? address.port : 0
      state.close = () => new Promise((closed) => state.server.close(() => closed(undefined)))
      done(state)
    })
  })
}

/**
 * 从参数里解析出解包落点。**两种解包方式的形状完全不同**：
 *   - `msiexec /a … TARGETDIR=<dir> /L*v <log>`：`属性=值`，值**不带内层引号**
 *   - `7z e <pkg> -o<dir> <条目> -y`：`-o` 是紧贴着路径写的。
 *
 * 测试的 runner 与真实的那个一样只看参数、不看 exe，所以两条都得认——否则
 * zip-entry 那几条会以「没找到落点」的样子红掉，而那跟真正要测的东西毫无关系。
 *
 * ⚠️ 这里原来写的是 `/TARGETDIR="(.*)"$/.exec(args[args.length - 1])`——**两个错叠在一起**：
 *   既要求值里**有**内层引号（那正是 D1 那个 bug 本身），又锚在**末位**（加了 `/L*v` 之后
 *   TARGETDIR 不再是尾参）。任一条都会让它返回 null，而表现是「没找到落点」——
 *   跟真正要测的东西毫无关系。现在按属性名找、整条参数都在射程内。
 */
function stagingOf(args: string[]): string | null {
  const raw = args.find((a) => a.startsWith('TARGETDIR='))
  if (raw !== undefined) return raw.slice('TARGETDIR='.length)
  const out = args.find((a) => a.startsWith('-o'))
  return out === undefined ? null : out.slice(2)
}

const httpTransport = (): import('../src/main/core/downlink').DownloadTransport => ({
  request(request) {
    const url = new URL(request.url)
    // 只走 http，且**真实网络一律拒绝**：这个测试必须能在断网的机器上跑
    const req = httpRequest(
      { hostname: url.hostname, port: url.port, path: url.pathname, method: 'GET' },
      (res) => {
        request.onResponse({
          status: res.statusCode ?? 0,
          headers: res.headers as Record<string, string | string[] | undefined>,
          onData: (cb) => res.on('data', cb),
          onEnd: (cb) => res.on('end', cb),
          onError: (cb) => res.on('error', cb)
        })
      }
    )
    req.on('error', (error) => request.onError(error))
    req.end()
    return { abort: () => req.destroy() }
  }
})

/* ------------------------------------------------------------------ */

async function freshDir(name: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `arbiter-install-${name}-`))
  return dir
}

/**
 * 一次成功的安装。返回 runner 收到的命令与进度序列。
 *
 * `before` 用来在解包前动一下磁盘（写产物 / 写错体积），所以每条断言都能挑一个
 * 不同的失败点，而不必各写一份 30 行的准备代码。
 */
async function runInstall(options: {
  entryPatch?: Record<string, unknown>
  serverBody?: Buffer
  serverStatus?: number
  before?: (staging: string, engineDir: string) => Promise<void> | void
  cancel?: CancelToken
}): Promise<{
  error: unknown
  calls: Array<{ exe: string; args: string[] }>
  progress: InstallProgress[]
  engineDir: string
}> {
  const mirror = await startMirror(options.serverBody ?? PAYLOAD, options.serverStatus ?? 200)
  const engineDir = await freshDir('engines')
  const manifestPath = join(await freshDir('manifest'), 'manifest.json')
  await writeFile(manifestPath, manifestFor(mirror.port, options.entryPatch), 'utf8')

  resetEngineInstallForTest()
  setManifestPathForTest(manifestPath)
  updateSettings({ engineDir })

  const calls: Array<{ exe: string; args: string[] }> = []
  const progress: InstallProgress[] = []

  const error = await thrownBy(() =>
    installEngine('demo', {
      transport: httpTransport(),
      ...(options.cancel === undefined ? {} : { cancel: options.cancel }),
      onProgress: (p) => progress.push(p),
      run: async (exe, args) => {
        calls.push({ exe, args })
        const target = stagingOf(args)
        if (target === null) throw new Error(`没在参数里找到落点：${args.join(' ')}`)
        await options.before?.(target, engineDir)
        if (options.before === undefined) {
          // 默认行为：老老实实造一棵「解出来」的树
          mkdirSync(join(target, 'program'), { recursive: true })
          writeFileSync(join(target, 'program', 'demo.exe'), 'MZ 假装是可执行文件')
        }
      }
    })
  )

  await mirror.close()
  return { error, calls, progress, engineDir }
}

/* ------------------------------------------------------------------ 断言 */

async function testHappyPath(): Promise<void> {
  console.log('\n[1] 成功路径：下载 → 解到 .installing → 整体改名 → 删安装包')

  const mirror = await startMirror(PAYLOAD)
  const engineDir = await freshDir('engines-happy')
  const manifestPath = join(await freshDir('manifest-happy'), 'manifest.json')
  // 这一节用 pandoc 形状的条目（而不是默认那个 `program/demo.exe`）：
  // `pandocEngine()` 是这里唯一能看见「缓存有没有被重置」的窗口，判据见本节末尾。
  await writeFile(
    manifestPath,
    manifestFor(mirror.port, {
      extract: { method: 'msiexec-a', targetDir: 'pandoc' },
      entry: 'pandoc.exe'
    }),
    'utf8'
  )

  resetEngineInstallForTest()
  setManifestPathForTest(manifestPath)
  updateSettings({ engineDir })

  // 把 pandoc 的**另外两条候选堵死**，只留 engineDir 这一条活路——判据见下面那两条断言。
  // 开发机上 `resources/engines/pandoc/pandoc.exe` 是真实存在的，不堵死的话
  // 「装完之后能不能解析到」这件事根本观察不到。
  //
  // 这一节用 pandoc 形状的条目（而不是默认那个 demo/program/demo.exe），
  // 正是因为 `pandocEngine()` 是这里唯一能看见「缓存有没有被重置」的窗口。
  const savedPaths = appPaths()
  const emptyRoot = await freshDir('empty-root')
  setAppPaths({ ...savedPaths, appPath: emptyRoot })
  const savedEnv = {
    ProgramFiles: process.env.ProgramFiles,
    ProgramFilesX86: process.env['ProgramFiles(x86)'],
    LOCALAPPDATA: process.env.LOCALAPPDATA
  }
  process.env.ProgramFiles = emptyRoot
  process.env['ProgramFiles(x86)'] = emptyRoot
  process.env.LOCALAPPDATA = emptyRoot

  // 先把它探成 null（「探过了、没有」），这是**三态缓存**里最难缠的那一态：
  // 装完之后如果没重置缓存，解析器会一直返回这个 null，只能重启应用。
  resetPandocCache()
  // ⚠️ 这个快照必须在 `installEngine` **之前**取。写成「在断言里现调一次」的话，
  // 那次调用发生在装完之后，拿到的当然是刚装好的那个——断言就变成了空转。
  const pandocBeforeInstall = pandocEngine()

  const calls: Array<{ exe: string; args: string[] }> = []
  const progress: InstallProgress[] = []

  // ⚠️ 用 `thrownBy` 包一层：参数形状不对（比如 TARGETDIR 少了引号）时 runner 会
  // 提前返回，于是产物不存在、`installEngine` 抛。让那个异常直接穿出去的话，
  // 套件会崩在半路，后面的断言一条都跑不到——反证脚本读到的就是「一条都没红」，
  // 看上去像断言抓不住错误，其实是断言根本没被求值。
  // `thrownBy` 成功时返回 null，所以这里不能用它——我们需要的是**成功时的返回值**。
  // 用一个普通的 try/catch，把「成功」与「抛了什么」分别存下来。
  let installedError: unknown = null
  let result: InstallResult = { engine: 'demo', exe: '' }
  try {
    result = await installEngine('demo', {
      transport: httpTransport(),
      onProgress: (p) => progress.push(p),
      run: async (exe, args) => {
        calls.push({ exe, args })
        // ⚠️ 参数形状不对时**直接返回，不要在这里抛**：这个 runner 是注入进来的，
        // 它抛出去的异常会穿过整个 installEngine 把套件崩在半路，于是「哪个变异
        // 应该翻红」这件事就永远观察不到了（反证脚本会把它读成「一条都没红」）。
        // 让后面的断言去红，才是正确的失败方式。
        const target = stagingOf(args)
        if (target === null) return
        // 解包中途**必须**只能在 `.installing` 里看到东西
        check('解包时目标目录还是 `.installing`', target.endsWith('.installing'), target)
        check('解包时最终目录尚未出现', !existsSync(join(engineDir, 'pandoc')), target)
        writeFileSync(join(target, 'pandoc.exe'), 'MZ 假装是可执行文件')
      }
    })
  } catch (error) {
    installedError = error
  }

  await mirror.close()

  check('安装整个过程没有抛异常', installedError === null, String(installedError))

  check(
    '安装成功返回可执行文件路径',
    result.exe === join(engineDir, 'pandoc', 'pandoc.exe'),
    result.exe
  )
  check('产物落在 engineDir/<targetDir> 下', existsSync(join(engineDir, 'pandoc', 'pandoc.exe')))
  check('`.installing` 已随改名消失', !existsSync(join(engineDir, 'pandoc.installing')))
  check(
    '下完的安装包被删掉（不然白占 375 MB）',
    !existsSync(join(engineDir, '.packages', 'demo.msi'))
  )
  check(
    '命令是 msiexec /a…… /qn（约束 16：绝不能是 7z x）',
    calls[0]?.exe === 'msiexec.exe',
    calls[0]?.exe
  )
  check(
    '参数里带 /a 与 /qn',
    calls[0]?.args.includes('/a') === true && calls[0]?.args.includes('/qn') === true
  )
  // ★★ **`TARGETDIR` 的值里绝不能有内层引号**（D1，2026-09-14 真机实测）。
  //
  // 这里原来断言的是**反过来的那一条**（「值带内嵌引号」），注释还写着那对引号是
  // 「承重的」——**测试把 bug 当成了特性**，而反证里那条变异恰好是「把引号去掉」、
  // 期望这条翻红，于是**反证反过来把 bug 锁死了**。这正是 docs/NOTES.md 那句
  // 「反证能证明断言是活的，但证明不了它断言的是对的」的原样重演。
  //
  // 为什么带引号是致命的：Node 的 spawn 会把参数里的 `"` 转义成 `\"`（MSVC 那套），
  // 送到 msiexec 手上就成了 `TARGETDIR=\"C:\…\"`；而 Windows 命令行解析里
  // **反斜杠不是双引号的转义符**，msiexec 拿到这个畸形参数**不报错、不退出，直接挂住**。
  // 实测（真实 LibreOffice MSI，同一台机器，只差这一对引号）：
  //   无内层引号 → 25.5 秒成功，soffice.exe 就位；有内层引号 → 挂死 45 秒以上、0 个条目。
  //
  // 路径含空格照样安全：Node 会因为**整个参数里有空格**而把它整体引起来，
  // 那才是 msiexec 认的形状。
  check(
    '★★ TARGETDIR 的值不带内层引号（带了 msiexec 会静默挂住，实测）',
    calls[0]?.args.some((a) => /^TARGETDIR=[^"]+$/.test(a)) === true,
    calls[0]?.args.join(' ')
  )
  // 顺带钉住诊断日志那一项：msiexec 挂住时它是唯一能看清内部状态的东西
  check(
    '★ 带上 /L*v 诊断日志（挂住时它是唯一的观测点）',
    calls[0]?.args.includes('/L*v') === true,
    calls[0]?.args.join(' ')
  )
  check('下载只发生一次', mirror.hits === 1, String(mirror.hits))
  check(
    '进度先报下载、再报解包',
    progress[0]?.phase === 'download' && progress.some((p) => p.phase === 'extract'),
    progress.map((p) => p.phase).join(',')
  )
  check('下载进度带整包体积（来自清单，不是猜的）', progress[0]?.totalBytes === PAYLOAD.length)
  check('解包那一阶段的百分比是 null（msiexec 不吐进度）', progress.at(-1)?.percent === null)
  check('装完之后不再有在飞的安装', installInFlight().length === 0, installInFlight().join(','))

  // ★ 这一条打的是「装完不重置缓存」那个 bug。
  //
  // 判据必须**确定**，否则它自己就是一条装饰。早先写的是
  // `pandocEngine() === 期望路径 || pandocEngine() !== null`，而后者在开发机上恒为真
  // （仓库里就有 resources/engines/pandoc/pandoc.exe），于是那条断言永远绿、
  // 反证时也照样绿——正是这个仓库一直在抓的那类装饰性断言。
  //
  // 现在把**另外两条候选全部堵死**，只留 engineDir 这一条活路：
  //   bundled()          —— setAppPaths 指到一个没有 resources/engines 的空目录
  //   systemInstalled()  —— ProgramFiles / ProgramFiles(x86) / LOCALAPPDATA 指到空目录
  // 于是「解析得到 / 解析不到」只取决于刚装进去的那一份。
  check(
    '前置：堵死另两条候选后，装之前确实解析不到它（否则下面那条是空转）',
    pandocBeforeInstall === null,
    String(pandocBeforeInstall)
  )
  check(
    '★ 装完之后解析器立刻看得到它（缓存被重置了）',
    pandocEngine() === join(engineDir, 'pandoc', 'pandoc.exe'),
    String(pandocEngine())
  )

  // 还原路径环境：后面几节还要用它去解析真的清单与引擎路径。
  // ⚠️ 这一步必须在上面那两条断言**之后**——放前面的话它们看到的是仓库里那份
  // 自带的 pandoc，两条断言就都失去意义了（这个顺序我踩过一次）。
  setAppPaths(savedPaths)
  process.env.ProgramFiles = savedEnv.ProgramFiles
  process.env['ProgramFiles(x86)'] = savedEnv.ProgramFilesX86
  process.env.LOCALAPPDATA = savedEnv.LOCALAPPDATA
  resetPandocCache()
}

async function testFailureCleansUp(): Promise<void> {
  console.log('\n[2] 解包失败：半截的树要清掉，但安装包留着（重试不必重下）')

  const engineDir = await freshDir('engines-fail')
  const mirror = await startMirror(PAYLOAD)
  const manifestPath = join(await freshDir('manifest-fail'), 'manifest.json')
  await writeFile(manifestPath, manifestFor(mirror.port), 'utf8')

  resetEngineInstallForTest()
  setManifestPathForTest(manifestPath)
  updateSettings({ engineDir })

  const error = await thrownBy(() =>
    installEngine('demo', {
      transport: httpTransport(),
      run: async (_exe, args) => {
        const target = stagingOf(args)!
        // 造一棵**半截但看起来像解完了**的树：这正是最危险的那种中途失败
        mkdirSync(join(target, 'program'), { recursive: true })
        writeFileSync(join(target, 'program', 'demo.exe'), 'MZ')
        throw new Error('msiexec 退出码 1603')
      }
    })
  )
  await mirror.close()

  check(
    '解包失败会抛出，且带上解包器自己的话',
    error instanceof Error && error.message.includes('1603'),
    String(error)
  )
  check('半截的 `.installing` 被清掉', !existsSync(join(engineDir, 'demo.installing')))
  check(
    '最终目录没有被半截的树占住',
    !existsSync(join(engineDir, 'demo')),
    '留着的话下次启动会判「有引擎」，然后每次都报一个看不懂的错'
  )
  check(
    '安装包留着（重试时 sha256 一对上就跳过下载）',
    existsSync(join(engineDir, '.packages', 'demo.msi'))
  )
}

async function testShaMismatch(): Promise<void> {
  console.log('\n[3] sha256 对不上：拒绝安装，而且**不去解包**')

  const engineDir = await freshDir('engines-sha')
  // 服务器给的是别的内容，与清单里的 sha256 对不上
  const mirror = await startMirror(Buffer.from('投毒的内容', 'utf8'))
  const manifestPath = join(await freshDir('manifest-sha'), 'manifest.json')
  await writeFile(manifestPath, manifestFor(mirror.port), 'utf8')

  resetEngineInstallForTest()
  setManifestPathForTest(manifestPath)
  updateSettings({ engineDir })

  const calls: string[] = []
  const error = await thrownBy(() =>
    installEngine('demo', {
      transport: httpTransport(),
      run: async (exe) => {
        calls.push(exe)
      }
    })
  )
  await mirror.close()

  check('sha256 不符时抛错', error !== null, String(error))
  check('不去解包（解一个来路不明的包等于把闸拆了）', calls.length === 0, calls.join(','))
  check('没有留下任何最终目录', !existsSync(join(engineDir, 'demo')))

  // 「不应留下 .part」这类断言必须先确认现场干净，否则会在后续轮次里被毒掉
  check(
    '坏包不会被当成好东西留下',
    !existsSync(join(engineDir, '.packages', 'demo.msi')),
    '留着的话下一次会以为已经下过了'
  )
}

async function testSingleFlight(): Promise<void> {
  console.log('\n[4] 单飞：同一个引擎并发装两次，只下一次、只解一次')

  const engineDir = await freshDir('engines-single')
  const mirror = await startMirror(PAYLOAD)
  const manifestPath = join(await freshDir('manifest-single'), 'manifest.json')
  await writeFile(manifestPath, manifestFor(mirror.port), 'utf8')

  resetEngineInstallForTest()
  setManifestPathForTest(manifestPath)
  updateSettings({ engineDir })

  let runs = 0
  const runner = async (_exe: string, args: string[]): Promise<void> => {
    runs += 1
    const target = stagingOf(args)
    if (target === null) return
    mkdirSync(join(target, 'program'), { recursive: true })
    writeFileSync(join(target, 'program', 'demo.exe'), 'MZ')
    // 拉长一点，保证第二次调用一定落在「第一次还没跑完」这个窗口里
    await new Promise((done) => setTimeout(done, 200))
  }

  // ⚠️ 用 `allSettled` 而不是 `all`：单飞塌掉的时候，两个安装会同时往同一个
  // `TARGETDIR` 里写、同时 `rename`，其中一路**会抛**。用 `all` 的话那个异常会
  // 直接穿出这个函数把套件崩在半路，反证脚本读到的就是「一条都没红」——
  // 看上去像断言抓不住错误，实际上是断言根本没跑到。
  const settled = await Promise.allSettled([
    installEngine('demo', { transport: httpTransport(), run: runner }),
    installEngine('demo', { transport: httpTransport(), run: runner })
  ])
  await mirror.close()

  check(
    '两次并发安装都成功返回（单飞塌了的话会有一路炸掉）',
    settled.every((r) => r.status === 'fulfilled'),
    settled.map((r) => (r.status === 'fulfilled' ? 'ok' : String(r.reason))).join(' | ')
  )

  const a = settled[0].status === 'fulfilled' ? settled[0].value : null
  const b = settled[1].status === 'fulfilled' ? settled[1].value : null
  check('两次调用拿到同一个结果', a !== null && a === b, `${a?.exe} vs ${b?.exe}`)
  check(
    '解包只跑了一次（两个 msiexec 写同一个 TARGETDIR 会调出一棵混起来的树）',
    runs === 1,
    String(runs)
  )
  check('下载也只发生了一次', mirror.hits === 1, String(mirror.hits))
}

async function testZipEntry(): Promise<void> {
  console.log('\n[5] zip-entry：命令形状（`7z e` 而不是 `7z x`）')

  const engineDir = await freshDir('engines-zip')
  const mirror = await startMirror(PAYLOAD)
  const manifestPath = join(await freshDir('manifest-zip'), 'manifest.json')
  await writeFile(
    manifestPath,
    manifestFor(mirror.port, {
      kind: 'wheel',
      extract: {
        method: 'zip-entry',
        targetDir: 'pandoc',
        entryInArchive: 'pypandoc/files/pandoc.exe'
      },
      entry: 'pandoc.exe'
    }),
    'utf8'
  )

  resetEngineInstallForTest()
  setManifestPathForTest(manifestPath)
  updateSettings({ engineDir })

  const calls: Array<{ exe: string; args: string[] }> = []
  await installEngine('demo', {
    transport: httpTransport(),
    run: async (exe, args) => {
      calls.push({ exe, args })
      // `7z e` 会丢掉归档内的目录，所以落点是 `<target>/pandoc.exe`
      writeFileSync(join(args[2]!.replace('-o', ''), 'pandoc.exe'), 'MZ')
    }
  })
  await mirror.close()

  check('用的是 `7z e`（丢目录），不是 `7z x`', calls[0]?.args[0] === 'e', calls[0]?.args[0])
  check(
    '条目名来自清单',
    calls[0]?.args.includes('pypandoc/files/pandoc.exe') === true,
    calls[0]?.args.join(' ')
  )
  check('带 -y（不然 7z 会停下来问）', calls[0]?.args.includes('-y') === true)
  check('产物落在 engineDir/pandoc/pandoc.exe', existsSync(join(engineDir, 'pandoc', 'pandoc.exe')))
}

async function testPostChecks(): Promise<void> {
  console.log('\n[6] 解包后的复核：找不到产物 / 体积不符都要抛')

  // 6a：`7z e` 条目名拼错时退出码仍是 0，唯一观测点就是这里
  const missing = await runInstall({
    entryPatch: {
      extract: { method: 'zip-entry', targetDir: 'demo', entryInArchive: '拼错的/条目.exe' },
      entry: 'never.exe'
    },
    before: () => undefined
  })
  check(
    '没抽到产物要抛（7z 的退出码拦不住这件事）',
    missing.error instanceof Error && missing.error.message.includes('没找到'),
    String(missing.error)
  )

  // 6b：wheel 里那个 pandoc.exe 与 GitHub zip 里那个「大小相同、内容不同」，
  //     所以清单用 expectedEntrySizeBytes 单独钉了一层
  const wrongSize = await runInstall({
    entryPatch: {
      extract: {
        method: 'msiexec-a',
        targetDir: 'demo',
        expectedEntrySizeBytes: 999999
      }
    },
    before: async (staging) => {
      mkdirSync(join(staging, 'program'), { recursive: true })
      writeFileSync(join(staging, 'program', 'demo.exe'), 'MZ')
    }
  })
  check(
    '体积与清单不符要抛',
    wrongSize.error instanceof Error && wrongSize.error.message.includes('999999'),
    String(wrongSize.error)
  )
}

async function testCancelAndUnknown(): Promise<void> {
  console.log('\n[7] 取消与不认识的引擎')

  const token = new CancelToken()
  token.cancel()
  const canceled = await runInstall({ cancel: token })
  check(
    '已取消的令牌会在下载前就抛',
    canceled.error instanceof ConversionCanceled,
    String(canceled.error)
  )

  const engineDir = await freshDir('engines-unknown')
  const mirror = await startMirror(PAYLOAD)
  const manifestPath = join(await freshDir('manifest-unknown'), 'manifest.json')
  await writeFile(manifestPath, manifestFor(mirror.port), 'utf8')
  resetEngineInstallForTest()
  setManifestPathForTest(manifestPath)
  updateSettings({ engineDir })

  const error = await thrownBy(() =>
    installEngine('libreoffice', { transport: httpTransport(), run: async () => undefined })
  )
  await mirror.close()
  check(
    '清单里没有的引擎要明说，而不是报一个看不懂的下载失败',
    error instanceof Error && error.message.includes('清单里没有'),
    String(error)
  )
}

/** `testStaleSweep` 用的一条清单条目 */
function entryFor(key: string, port: number, file: string): Record<string, unknown> {
  return {
    key,
    label: key,
    version: '1',
    kind: 'msi',
    sizeBytes: PAYLOAD.length,
    sha256: PAYLOAD_SHA,
    mirrors: [{ url: `http://127.0.0.1:${port}/${file}`, region: 'cn', verified: true }],
    extract: { method: 'msiexec-a', targetDir: key },
    entry: `program/${key}.exe`
  }
}

/**
 * D6：**装之前扫掉上一次留下的残骸。**
 *
 * 审计在真机上看到过一次 `libreoffice.installing\` 留在盘上（空的——那是 D1 那次
 * 「零 I/O 地挂住」，我们连一个字节都没写进去）。根因是 `catch` 里那次清树
 * **不是百分百成功**：超时那条路先 `taskkill /T /F`，而 msiexec 的服务端进程
 * 放手目录要一小会儿，`removeTreeQuietly` 三次重试一共只等 450 ms。
 * 更彻底的一类是进程被直接杀掉——`catch` 那一行**根本不会执行**。
 *
 * 所以判据有两半，缺一不可：
 *
 *  - **该扫的扫掉**（别人的残骸、连 `.log` 一起）；
 *  - **不该碰的一个都不碰**（完整引擎目录，以及**正在装**的那个引擎的暂存目录）。
 *    后半条是承重的：单飞是按引擎的，LibreOffice 与 Calibre 可以同时在装，
 *    扫掉正在解包的那棵树，产物就是一棵**少了半截却长得很完整**的树。
 */
async function testStaleSweep(): Promise<void> {
  console.log('\n[8] D6：装之前扫掉上一次的残骸（但绝不碰正在装的那个）')

  const engineDir = await freshDir('engines-sweep')
  const mirror = await startMirror(PAYLOAD)
  const manifestPath = join(await freshDir('manifest-sweep'), 'manifest.json')
  // 两个引擎：`beta` 会被卡在解包里「一直在装」，`alpha` 是真正要跑完的那个
  await writeFile(
    manifestPath,
    JSON.stringify({
      schemaVersion: 1,
      engines: [
        entryFor('alpha', mirror.port, 'alpha.msi'),
        entryFor('beta', mirror.port, 'beta.msi')
      ]
    }),
    'utf8'
  )

  resetEngineInstallForTest()
  setManifestPathForTest(manifestPath)
  updateSettings({ engineDir })

  mkdirSync(join(engineDir, 'keepme'), { recursive: true })
  writeFileSync(join(engineDir, 'keepme', 'x.txt'), '完整引擎目录里的东西')

  // ---- 先把 beta 卡在解包中途，让它一直「在装」
  let betaEntered!: () => void
  const betaIsRunningPromise = new Promise<void>((done) => (betaEntered = done))
  let releaseBeta!: () => void
  const betaMayFinish = new Promise<void>((done) => (releaseBeta = done))

  const betaTask = installEngine('beta', {
    transport: httpTransport(),
    run: async (_exe, args) => {
      // ⚠️ **放行必须是第一句，且在 `stagingOf` 之前。** 这里原来把 `betaEntered()`
      //   写在造树之后，于是任何「把落点弄坏」的变异（比如 TARGETDIR 带上引号、
      //   或改成直接往最终目录里解）都会让这句 `mkdirSync` 先抛出来 ——
      //   而抛点在 `betaEntered()` 之前，`await betaIsRunning` 就**永远不返回**。
      //   实测代价：`falsify:engine-install` 卡在第 9 个变异上四分钟不动，
      //   最后只能杀掉它，而**杀掉反证会把那一轮的变异留在盘上**（约束 30 那条警告），
      //   这一轮留在盘上的正好是 D1 那对致命引号。
      //   「测试卡住」比「测试翻红」坏得多：翻红至少有人知道，卡住只会让人等。
      betaEntered()
      const target = stagingOf(args)
      if (target !== null) {
        // 造树失败不要往外抛：注入的 runner 抛出去的异常会穿过整个 installEngine，
        // 让这一节以「没找到落点」这类与正题无关的样子红掉。让断言去红才是对的。
        try {
          mkdirSync(join(target, 'program'), { recursive: true })
          writeFileSync(join(target, 'program', 'beta.exe'), 'MZ')
        } catch {
          // 变异把落点弄成了非法路径（`"` 在 Windows 文件名里非法）
        }
      }
      await betaMayFinish
    }
  }).catch(() => undefined)

  // 等 beta 进解包，**带上界**。同一个理由：一旦 beta 那条链路整条失败
  // （比如下载那一步就炸了、runner 压根没被调用），无界等待就是一次挂死。
  const betaIsRunning = await Promise.race([
    betaIsRunningPromise.then(() => true),
    new Promise<boolean>((done) => setTimeout(() => done(false), 10_000))
  ])
  check(
    '前置：beta 进入了「正在解包」那个状态（它要是没进去，下面几条都失去对象）',
    betaIsRunning,
    '10 秒没等到——多半是 beta 那条链路在更早的地方就断了'
  )
  if (!betaIsRunning) {
    // 把 beta 放走再退出：留着它挂在那儿，套件末尾的统计仍会打出来，
    // 但进程会因为一个永不 settle 的 promise 变成「跑完了却退不出」。
    releaseBeta()
    await mirror.close()
    return
  }
  check('前置：beta 此刻确实在装（单飞表里有它）', installInFlight().includes('beta'))
  check(
    '前置：beta 的暂存目录此刻在盘上（后面那条断言才有对象）',
    existsSync(join(engineDir, 'beta.installing'))
  )

  // 残骸**必须造在 beta 自己那次扫盘之后**（也就是现在）。造在前面的话，
  // beta 的扫盘就把它带走了，而 alpha 那一趟什么也没得扫 —— 三条断言会一起变成空转。
  // 这个顺序我踩过一次：`gamma` 被 beta 扫掉，最后只有「要说出扫了什么」那一条红。
  //
  // `gamma` **不在这份清单里**是刻意的：扫盘按目录名认，不看清单——
  // 一个早就从清单里删掉的引擎留下的残骸同样要能扫掉。
  mkdirSync(join(engineDir, 'gamma.installing', 'program'), { recursive: true })
  writeFileSync(join(engineDir, 'gamma.installing', 'program', 'half.exe'), 'MZ 半截')
  writeFileSync(join(engineDir, 'gamma.installing.log'), '32 MB 的 msi 日志（这里只是个替身）')

  // ---- 现在跑 alpha：它的扫盘必须**放过 beta**、但带走 gamma
  const warnings: string[] = []
  const realWarn = console.warn
  console.warn = (...parts: unknown[]): void => {
    warnings.push(parts.map(String).join(' '))
  }
  let alphaError: unknown = null
  try {
    await installEngine('alpha', {
      transport: httpTransport(),
      run: async (_exe, args) => {
        const target = stagingOf(args)
        if (target === null) return
        mkdirSync(join(target, 'program'), { recursive: true })
        writeFileSync(join(target, 'program', 'alpha.exe'), 'MZ')
      }
    })
  } catch (error) {
    alphaError = error
  } finally {
    console.warn = realWarn
  }

  check('alpha 自己装成功了', alphaError === null, String(alphaError))
  check('alpha 的产物就位', existsSync(join(engineDir, 'alpha', 'program', 'alpha.exe')))
  check(
    '★ 别人的残骸被扫掉了（gamma）',
    !existsSync(join(engineDir, 'gamma.installing')),
    '这一条是 D6 的正题：残骸留在盘上的成因就是「用户再没重试过那个引擎」'
  )
  check(
    '★ 残骸的 `.log` 也一起扫掉（它与暂存目录同级、不在一起）',
    !existsSync(join(engineDir, 'gamma.installing.log'))
  )
  check(
    '★★ 正在装的那个引擎的暂存目录**原封不动**（扫掉它 = 产出一棵少半截的树）',
    existsSync(join(engineDir, 'beta.installing', 'program', 'beta.exe'))
  )
  check('只认 `.installing` 后缀：完整引擎目录不碰', existsSync(join(engineDir, 'keepme', 'x.txt')))
  check(
    '★ 扫掉了什么要说出来（静默地删用户磁盘上 1.4 GiB 是不可接受的）',
    warnings.some((w) => w.includes('gamma.installing')),
    warnings.join(' | ')
  )

  // 收尾：放 beta 走完，确认它没被这一趟扫盘弄坏
  releaseBeta()
  await betaTask
  check(
    '★ beta 跑完之后产物是完整的（它的暂存目录中途没被人动过）',
    existsSync(join(engineDir, 'beta', 'program', 'beta.exe'))
  )

  await mirror.close()
}

async function main(): Promise<void> {
  await testHappyPath()
  await testFailureCleansUp()
  await testShaMismatch()
  await testSingleFlight()
  await testZipEntry()
  await testPostChecks()
  await testCancelAndUnknown()
  await testStaleSweep()

  // 收尾把清单覆盖撤掉，免得影响同一进程里后面的东西
  setManifestPathForTest(null)

  console.log(`\n=== 通过 ${passed} / 失败 ${failed} ===`)
  process.exit(failed === 0 ? 0 : 1)
}

void main()
