/**
 * M3 的承重断言：**在不 import electron 的环境里跑完真实转换**（MCP 场景）。
 *
 *   npm run test:electron-free
 *
 * 为什么值得单开一个套件：M4 的 MCP Server 要在普通 Node 进程里复用 `convert()`，
 * 那个进程里没有 Electron 运行时。这条路径一旦被改回去（某个引擎的路径解析又开始
 * 直接读 `app.isPackaged`，或者 `converters/index.ts` 又变回静态 import），
 * **typecheck 与 test:tasks 一条都不会红**——它们在 Electron 桩或真 Electron 里跑，
 * 多一个 electron 依赖毫无症状。真正炸的时刻是用户装上 MCP 之后第一次转换。
 *
 * 判据不是「扫一遍 import 语句」，而是**真的把 electron 拦掉再跑**：往 `Module._load`
 * 上挂一个钩子，凡是请求 `electron` 一律抛错。于是「转换依赖图里任何一处碰 electron」
 * 都会当场翻红，包括将来某人在函数体里写 `await import('electron')` 那种。
 *
 * ⚠️ **钩子本身也要反证**（下面是第一条断言）：钩子没生效的话，后面几条全成了恒真的
 * 装饰——「转换成功」和「根本没拦住」在观测上完全一样。这个仓库已经因此栽过四次。
 * 自证必须借 `scripts/electron-import-probe.ts` 那个**尚未被加载过**的模块，原因写在
 * 那个文件里（直接在自检里 `await import('electron')` 是测不出来的：electron 早被
 * `install-test-paths` 加载过，那次 import 命中缓存、根本不走解析——实测踩过）。
 *
 * 两条通道各跑一次，覆盖 MCP v1 里最容易踩雷的两条：
 *
 *   A. mp4 → mkv（ffmpeg，纯子进程）
 *   B. pdf → txt（pdfjs）——**这条才是重点**：`converters/document.ts` 既管 pdfjs
 *      的四个文本/图片出口，又管 HTML→PDF 那条要真 Chromium 的路。后者现在是**按需**
 *      加载的，这里就用「document 进来了、chromiumPdf 没进来」把它钉住。
 *
 * 每条断言都带防空转的伴生条件（缓存为空 / 上个模块没加载时，对应的否定断言会恒真）：
 * 那种「在空集合上恒真」的断言在本仓库已经抓到过一条，见 docs/NOTES.md 的测试一节。
 * 缓存版的否定断言还有个**结构性盲区**——「加载失败的模块不会进缓存」，所以它抓不住
 * 「静态 import 了一个一加载就抛错的模块」。补它的正是下面那本拦截台账。
 */
import './install-test-paths' // 它自己要用 electron（映射到 stub），必须发生在封锁之前
import Module from 'module'
import { spawn } from 'child_process'
import { existsSync } from 'fs'
import { mkdir, readFile, rm, stat, writeFile } from 'fs/promises'
import { join, resolve } from 'path'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import type { ConvertContext } from '../src/main/converters/common'
import type { TaskProgress } from '../src/shared/types'

const TMP = resolve('.tmp-test-electron-free')
/** PDF 里写这串文本，转出来的 txt 里找得到才说明 pdfjs 真的解出了内容 */
const PDF_MARK = 'ArbiterElectronFree'

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

/* ------------------------------------------------------------ electron 封锁 */

interface Loader {
  _load(request: string, parent: unknown, isMain: boolean): unknown
  _cache: Record<string, unknown>
}

const loader = Module as unknown as Loader
const originalLoad = loader._load

/**
 * 台账：每一次被拦下的 electron 请求记一条，附带调用方模块的文件名。
 *
 * 为什么单开一本账：光看模块缓存抓不住「`document.ts` 又静态 import 了 chromiumPdf」
 * 这种情况——chromiumPdf 一加载就抛错，于是**它永远进不了缓存**，
 * 「chromiumPdf 没被加载」那条断言反而在空集合上恒真地绿着。台账问的是另一个方向：
 * 「有没有人**试图**加载 electron」，这个方向抓得住。
 */
const blocked: string[] = []

// 三个形参写明、用 call 转发（不用 `...rest` 再 apply）：`Module._load` 的签名是三元的，
// 展开成 `[request, ...unknown[]]` 会被 tsc 判成元组长度不确定（TS2345），
// 而 `typecheck:scripts` 红着 `npm run build` 就整个不往下走——打包链直接断在这里。
loader._load = function (request: string, parent: unknown, isMain: boolean): unknown {
  if (request === 'electron') {
    const caller = (parent as { filename?: string } | undefined)?.filename ?? '(未知调用方)'
    blocked.push(caller)
    // 文案要说清是**故意**拦的：否则真跑到这里的人会以为环境坏了
    throw new Error('electron 在本套件里被刻意封锁（模拟 MCP 那个没有 Electron 的进程）')
  }
  return originalLoad.call(loader, request, parent, isMain)
}

/**
 * 模块缓存里的键是 Windows 路径（`D:\…\converters\index.ts`），比较前统一成正斜杠。
 *
 * 查缓存**而不是**「扫一遍 import 语句」：缓存直接回答「到底加载了什么」，
 * 而扫语句只能用正则猜——猜不中 `await import()` 的写法，也猜不中中间层。
 */
function cacheKeys(): string[] {
  return Object.keys(loader._cache).map((key) => key.replace(/\\/g, '/'))
}

const loaded = (name: string): boolean => cacheKeys().some((key) => key.includes(name))

function strays(allowed: string[]): string[] {
  return OTHER_ENGINES.filter((name) => loaded(name) && !allowed.includes(name))
}

/** 出现这些名字的引擎模块被加载了，就说明有引擎被静态拉进了依赖图 */
const OTHER_ENGINES = [
  'chromiumPdf',
  'converters/document',
  'converters/archive',
  'converters/calibre',
  'converters/libreoffice',
  'converters/pandoc',
  'converters/image'
]

/* ------------------------------------------------------------------ 助手 */

/**
 * 空 exe 直接给失败、不 spawn。
 *
 * `spawn('')` 在 Node 上是**同步抛** `ERR_INVALID_ARG_VALUE`，而它抛在 Promise 的
 * executor 里 → 整个 Promise 拒绝 → `main()` 拒绝 → 脚本崩在半路，**后面几十条断言
 * 一条都不跑**。反证时看到的是一堆堆栈而不是「哪条红了」，跟这里已经抓到过的那个
 * 「用 `task!.outputPath!` 把套件崩在中途」是同一个坑。
 */
function runFfmpeg(exe: string, args: string[]): Promise<{ code: number; stderr: string }> {
  if (!exe) {
    return Promise.resolve({
      code: -1,
      stderr: '没有可用的 ffmpeg 路径（上面那条断言应该已经红了）'
    })
  }
  return new Promise((done) => {
    const child = spawn(exe, args, { windowsHide: true })
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.on('error', (error) => done({ code: -1, stderr: String(error) }))
    child.on('close', (code) => done({ code: code ?? -1, stderr }))
  })
}

interface Api {
  convert: (context: ConvertContext) => Promise<void>
  token: new () => ConvertContext['cancel']
  ffmpegPath: () => string
}

/**
 * 封锁装上之后再加载依赖图。**加载失败要能报出来而不是把脚本崩掉**：
 * 崩掉的话后面一条断言都不会跑，反证时看到的是一堆堆栈而不是「哪条红了」。
 */
async function loadApi(): Promise<{ api: Api | null; error: string }> {
  try {
    const converters = await import('../src/main/converters/index')
    const registry = await import('../src/main/engines/registry')
    const cancel = await import('../src/main/core/cancel')
    return {
      api: {
        convert: converters.convert,
        token: cancel.CancelToken,
        ffmpegPath: registry.ffmpegPath
      },
      error: ''
    }
  } catch (error) {
    return {
      api: null,
      error: error instanceof Error ? error.message.split('\n')[0] : String(error)
    }
  }
}

interface StageResult {
  outputSize: number
  failure: string
  progress: TaskProgress[]
}

async function runConvert(
  api: Api,
  input: string,
  output: string,
  fromExt: string,
  toExt: string
): Promise<StageResult> {
  const progress: TaskProgress[] = []
  let failure = ''
  try {
    await api.convert({
      input,
      output,
      fromExt,
      toExt,
      cancel: new api.token(),
      onProgress: (patch) => progress.push(patch)
    })
  } catch (error) {
    failure = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  }
  const outputSize = await stat(output)
    .then((s) => s.size)
    .catch(() => 0)
  return { outputSize, failure, progress }
}

/* ------------------------------------------------------------------ 主流程 */

async function main(): Promise<void> {
  await rm(TMP, { recursive: true, force: true }).catch(() => {})
  await mkdir(TMP, { recursive: true })

  // 1. 钩子自证。**必须是第一条**：它不成立的话，下面几条一条都不算数。
  let hookWorks = false
  let hookDetail = '没有抛错——说明它没拦住，整条 MCP 断言都是空转'
  try {
    await import('./electron-import-probe')
  } catch (error) {
    hookWorks = true
    hookDetail = error instanceof Error ? error.message.split('\n')[0] : String(error)
  }
  check('electron 封锁钩子确实生效（自证，防空转断言）', hookWorks, hookDetail)
  // 台账自己也要自证。它记不下来的话，末尾那条「没人碰 electron」就是恒真的装饰
  check(
    '拦截台账记下了自检那一次（防空转：台账是活的）',
    blocked.length >= 1,
    `记到 ${blocked.length} 条`
  )
  blocked.length = 0 // 自检那次是我们故意触发的，不作数

  const { api, error } = await loadApi()
  check(
    '转换依赖图能在封锁 electron 的情况下加载（静态 import 一个引擎就会红）',
    api !== null,
    error
  )
  if (!api) {
    console.log('  ⊘ 依赖图没加载起来，后面的断言无从谈起——不装作通过，也不静默略过')
    report()
    return
  }

  let ffmpeg = ''
  try {
    ffmpeg = api.ffmpegPath()
    check('封锁之后仍能解析出 ffmpeg 可执行文件', existsSync(ffmpeg), ffmpeg)
  } catch (cause) {
    check('封锁之后仍能解析出 ffmpeg 可执行文件', false, String(cause))
  }

  /* ---------------------------------------------------------- A：ffmpeg 通道 */

  const video = join(TMP, 'src.mp4')
  const made = await runFfmpeg(ffmpeg, [
    '-hide_banner',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=duration=1:size=160x120:rate=15',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:duration=1',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-shortest',
    video
  ])
  check('素材生成成功（裸 ffmpeg，不经被测代码）', made.code === 0, made.stderr.slice(-300))

  const a = await runConvert(api, video, join(TMP, 'out.mkv'), 'mp4', 'mkv')
  check(
    'A 无 electron 环境下的 mp4 → mkv 转换成功且产物非空',
    a.failure === '' && a.outputSize > 0,
    a.failure || `${a.outputSize} 字节`
  )
  check(
    'A 转换过程中收到了确定百分比（进度链路也脱得开 electron）',
    a.progress.some((p) => p.kind === 'determinate'),
    `共 ${a.progress.length} 条进度`
  )
  // 防空转：先确认它真的进来了，否则下面「没有别的引擎」在空缓存上恒真
  check('A 被请求的引擎（ffmpegRun）确实加载了', loaded('converters/ffmpegRun'))
  check(
    'A 只有被请求的那个引擎进了依赖图（没有别的引擎被静态拉进来）',
    strays([]).length === 0,
    strays([]).join(', ')
  )

  /* ------------------------------------------------- B：pdfjs 通道（无 Chromium） */

  const pdfPath = join(TMP, 'src.pdf')
  const doc = await PDFDocument.create()
  const page = doc.addPage([300, 200])
  page.drawText(PDF_MARK, {
    x: 20,
    y: 100,
    size: 14,
    font: await doc.embedFont(StandardFonts.Helvetica)
  })
  await writeFile(pdfPath, await doc.save())

  const b = await runConvert(api, pdfPath, join(TMP, 'out.txt'), 'pdf', 'txt')
  const text = await readFile(join(TMP, 'out.txt'), 'utf8').catch(() => '')
  check(
    'B 无 electron 环境下的 pdf → txt 转换成功且抽出了正文',
    b.failure === '' && text.includes(PDF_MARK),
    b.failure || `${b.outputSize} 字节，正文片段：${JSON.stringify(text.slice(0, 40))}`
  )
  // 防空转：document 进来了，下面「chromiumPdf 没进来」才不是空话
  check('B pdf 出口确实走的是 converters/document', loaded('converters/document'))
  check(
    'B 没把 chromiumPdf 拖进来（HTML→PDF 那条路是按需加载的）',
    !loaded('chromiumPdf'),
    'chromiumPdf 被加载了——它一加载就碰 electron，MCP 那条线上的 pdf 文本出口会直接崩'
  )
  // 上面那条只看缓存，而**加载失败的模块不进缓存**——它对「静态 import 了一个一加载就
  // 抛错的模块」是恒真。台账从另一个方向问同一个问题：有没有人**试图**碰 electron。
  check(
    '整轮转换里没有任何模块试图加载 electron（台账为空）',
    blocked.length === 0,
    `${blocked.length} 处试图加载，调用方：${blocked.join(' , ')}`
  )

  await rm(TMP, { recursive: true, force: true }).catch(() => {})
  report()
}

function report(): void {
  console.log(`\n=== 通过 ${passed} / 失败 ${failed} ===`)
  process.exit(failed === 0 ? 0 : 1)
}

// 套件自己崩掉要**显式报出来**：静默崩在中间的话，反证脚本只会看到「后面几条断言没红」，
// 而那与「断言确实抓不住错误」在输出上一模一样。
main().catch((error) => {
  failed += 1
  console.error('\n套件自身抛异常（这是基础设施失败，不是断言红）：', error)
  report()
})
