import { spawn } from 'child_process'
import { existsSync } from 'fs'
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { appPaths } from '../core/appPaths'
import { killTree } from '../core/kill'
import type { HtmlPdfOptions } from './chromiumPdf'

/**
 * PDF 渲染的**子进程委托**，给 CLI / MCP 形态用（审计 2026-09-15 §3.1）。
 *
 * ## 它解决的问题
 *
 * `docx / html / md → pdf` 在 CLI 上是**该通**的一条路：它走 `document.ts` 那条纯 JS 管线
 * （mammoth / SheetJS / 自己的 markdown 解析）+ 随 Electron 自带的 Chromium 排版，
 * `requiresDownload()` 刻意让它不必拖 357 MiB 的 LibreOffice。
 *
 * 可 CLI / MCP 跑在 `ELECTRON_RUN_AS_NODE=1` 下——**那个进程里没有 Electron 运行时**。
 * ⚠️ 它**不是**以「`Cannot find module 'electron'`」这种好认的方式失败的：本机实测
 * （见 `chromiumPdf.ts` 的 `loadElectron()`），那个模式下 `require('electron')` 返回的是
 * electron.exe 的路径**字符串**，于是顶层那句 `import { BrowserWindow } from 'electron'`
 * 一路走到 `new BrowserWindow(…)` 才炸成 **`TypeError: BrowserWindow is not a constructor`**。
 *
 * 后果因此不是「这条转换不可用」那么干净：前置检查（能力矩阵 / 引擎就绪）**全部放行**，
 * 真正干活时才炸，而且炸在一层认不出它的 catch 里，最后报给用户的是
 * **「你的源文件坏了」**——一次彻头彻尾的错误归因。
 *
 * ## 形状
 *
 * 本模块**零 electron 依赖**，所以在 `ELECTRON_RUN_AS_NODE` 进程里能加载。它做的事只有一件：
 *
 * ```
 *   CLI / MCP 进程                      子进程（真 Electron）
 *  ┌──────────────────┐               ┌──────────────────────────────┐
 *  │ 写 request.json  │ ──spawn──────▶│ Arbiter.exe --arbiter-pdf-worker=… │
 *  │                  │               │   读 request → printToPDF     │
 *  │ 读 response.json │ ◀─────────────│   写 response → app.exit()    │
 *  └──────────────────┘               └──────────────────────────────┘
 * ```
 *
 * ## 三个必须记住的点
 *
 * - **结果走文件，不走 stdout。** 子进程是个真的 Electron 主进程，它会往两条流上打一大堆
 *   启动噪音；在这里解析 stdout 等于和 Chromium 抢通道。更要紧的是——**父进程的 stdout 是
 *   协议通道**（CLI 的 `--json`、MCP 的 JSON-RPC，约束 20），任何「顺便把子进程的输出转出来」
 *   的写法都是在往那条通道上写字。所以子进程的两条流一律 `pipe` 到我们手里、只当诊断用。
 * - **`ELECTRON_RUN_AS_NODE` 必须从子进程环境里删掉。** 它就在我们的环境里（我们正是从
 *   `arbiter.cmd` 那行 `set` 里继承来的），不删的话子进程起来的是**又一个 Node 进程**，
 *   于是它同样没有 Electron 运行时、同样走委托分支——**一层层递归 fork 下去**。
 *   `ARBITER_PDF_WORKER_DEPTH` 是这条防线的第二道闸，防的是「删失败」这种情况。
 * - **取消杀的是整棵树**（`killTree` → `taskkill /T /F`，约束 3）。Electron 主进程会拉起
 *   GPU / renderer / utility 一串子进程，只杀父进程会留下一堆孤儿占着内存。
 */

/** 命令行开关。带 `=` 传值，所以扫 argv 时**只有一个参数**要认，不必去看下一个 */
export const PDF_WORKER_FLAG = '--arbiter-pdf-worker'

/** 递归深度闸。第一层是 0，子进程是 1；到 1 还不肯停就说明环境里的模式没删掉 */
const DEPTH_ENV = 'ARBITER_PDF_WORKER_DEPTH'

/**
 * 显式指定用什么起子进程，给测试与排障用。
 *
 * 有了它，`test-pdf` 那类「已经是 Electron 了」的场景与「想指到一个特定安装」的场景
 * 都不必去猜路径。`_ENTRY` 只有 dev 形态才需要（打包形态的 exe 自己知道入口在哪）。
 */
const EXE_ENV = 'ARBITER_PDF_WORKER'
const ENTRY_ENV = 'ARBITER_PDF_WORKER_ENTRY'

/**
 * 等子进程的上限。
 *
 * 比 `chromiumPdf.ts` 里的 `RENDER_TIMEOUT_MS`（5 分钟，渲染本身的看门狗）**再宽一倍**：
 * 这里等的除了渲染，还有一次完整的 Electron 冷启动 + GPU 初始化 + 退出。
 * 渲染那次超时会先在子进程里落地并回一句人话，这一层只在子进程**根本没起来**或
 * **起死在那儿**时才开火——那种情况下给一句「超时」比无限等下去有用得多。
 */
const WORKER_TIMEOUT_MS = 10 * 60_000

/** 请求体。`responsePath` 放在请求里而不是让两边各拼一次路径，省掉一次字符串手术 */
export interface PdfWorkerRequest {
  htmlPath: string
  pdfPath: string
  options: HtmlPdfOptions
  responsePath: string
}

/** 回话。失败时 `message` 会一路冒到 CLI / MCP 的结果里 */
export interface PdfWorkerResponse {
  ok: boolean
  message?: string
}

export interface WorkerTarget {
  command: string
  /** 命令与开关之间的固定参数。打包形态为空，dev 形态是入口脚本路径 */
  args: string[]
}

/**
 * 决定用哪个可执行文件、怎么把它当 Electron 起起来。
 *
 * 两种形态的差别只有一处：**`process.execPath` 在我们这个进程里是什么**。
 *
 * - 打包形态：就是 `Arbiter.exe`。`arbiter.cmd` 用它跑 `cli.js` 只是借了
 *   `ELECTRON_RUN_AS_NODE=1` 这个身份；把那个变量摘掉、再不给脚本参数，
 *   同一个 exe 就变回一个正常的 Electron 应用（这正是双击它的行为）。
 * - dev 形态：`process.execPath` 是 `node.exe`，得去 `node_modules/electron/dist/` 里
 *   找真的那个，并且把 `out/main/index.js` 作为入口显式喂给它。
 *
 * 猜不到就**抛**（照 `core/appPaths.ts` 的先例），不做「兜底去 require('electron') 问一声」：
 * 那条兜底在纯 Node 下不报错，返回的是 exe 路径**字符串**，于是错误会以「子进程起不来」
 * 这种面目出现，而不是「这里找不到 Electron」。
 */
export function resolveWorkerTarget(): WorkerTarget {
  const override = process.env[EXE_ENV]
  if (override) {
    const entry = process.env[ENTRY_ENV]
    return { command: override, args: entry ? [entry] : [] }
  }

  const paths = appPaths()

  if (paths.isPackaged) return { command: process.execPath, args: [] }

  // dev：`appPath` 就是仓库根（见 `appPathsFromElectron` 对 `getAppPath()` 的说明）
  const electronExe = join(paths.appPath, 'node_modules', 'electron', 'dist', 'electron.exe')
  const entry = join(paths.appPath, 'out', 'main', 'index.js')

  if (!existsSync(electronExe) || !existsSync(entry)) {
    throw new Error(
      '命令行形态下要生成 PDF，需要一个真正的 Electron 进程，但没找到它：\n' +
        `  Electron：${electronExe}${existsSync(electronExe) ? '' : '（不存在）'}\n` +
        `  入口：${entry}${existsSync(entry) ? '' : '（不存在，先跑一次 npm run build 或 npm run dev）'}\n` +
        `也可以直接用 ${EXE_ENV} / ${ENTRY_ENV} 两个环境变量指过去。`
    )
  }

  return { command: electronExe, args: [entry] }
}

interface SpawnOutcome {
  code: number | null
  stderr: string
}

/**
 * 还活着的子进程。
 *
 * 父进程退出时要把它们带走（见下面的 `killLiveWorkers`）——这是约束 3 的邻居，
 * 只是那条说的是「取消任务」，这条说的是「父进程自己没了」。
 */
const liveWorkers = new Set<ReturnType<typeof spawn>>()

let exitHookInstalled = false

/**
 * 父进程退出时的兜底：把还在跑的子进程杀掉。
 *
 * ⚠️ **这条路覆盖的是一个真实存在的缺口，不是洁癖**：`renderHtmlFileToPdf` 的签名里
 * 根本没有 CancelToken（`printToPDF` 一旦开始就打断不了，理由写在 `chromiumPdf.ts`），
 * 所以 CLI 的 Ctrl-C 与 MCP 客户端的「关掉 stdin」这两条路上，没有任何取消信号会传到
 * 子进程——它会一路渲染到五分钟看门狗到点才罢休。CLI 那条尤其难看：用户按了 Ctrl-C、
 * 终端回了提示符，任务管理器里却还挂着一个 Electron。
 *
 * 只能同步杀（`exit` 钩子里做不了异步的事），所以这里用 `child.kill()` 而不是
 * `killTree()`——**这是刻意的降级**：Electron 主进程一死，它的 GPU / renderer
 * 那串子进程会跟着走（Chromium 会盯着父进程），但严格说我们只保证了「主进程死了」。
 * 真要树杀得把 CancelToken 一路接到这里，那是另一件事。
 */
function killLiveWorkers(): void {
  for (const child of liveWorkers) {
    try {
      child.kill()
    } catch {
      // 已经死了，或者句柄早失效了——退出钩子里不值得为它做任何事
    }
  }
  liveWorkers.clear()
}

/**
 * 起子进程、等它退出。
 *
 * 两条流都**只能**进到这里：stdout 是父进程的协议通道（约束 20），所以既不 `inherit`
 * 也不往自己身上转；stderr 攒起来，只在后面的报错里当佐证。
 */
function spawnWorker(target: WorkerTarget, requestPath: string): Promise<SpawnOutcome> {
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = { ...process.env }
    // ⚠️ 承重的一行，见文件头第二条。少了它子进程会再走一次委托分支，无限递归
    delete env.ELECTRON_RUN_AS_NODE
    env[DEPTH_ENV] = String(Number(process.env[DEPTH_ENV] ?? '0') + 1)

    let child: ReturnType<typeof spawn>
    try {
      child = spawn(target.command, [...target.args, `${PDF_WORKER_FLAG}=${requestPath}`], {
        // stdin 给它关掉：一个不需要交互的子进程留着 stdin 只会让「它到底在等什么」更难判
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        env
      })
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)))
      return
    }

    // 记进「父进程退出时要带走」的那本账。钩子只装一次，装多了会在退出时被杀一遍又一遍
    liveWorkers.add(child)
    if (!exitHookInstalled) {
      exitHookInstalled = true
      process.on('exit', killLiveWorkers)
    }

    let stderr = ''
    // 上限：一个满嘴报错的启动（缺 DLL、GPU 反复重试）不该把内存吃干。
    // 我们只拿它当佐证，留最后几 KB 就够。
    const STDERR_LIMIT = 8192
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < STDERR_LIMIT) stderr += chunk.toString('utf8')
    })

    let settled = false
    // `settle` 引用的 `timer` 在下面才声明：安全，因为 `settle` 只可能从定时器回调或
    // 子进程事件里被调用，那两者都在本同步块跑完之后才发生。
    const settle = (): boolean => {
      if (settled) return false
      settled = true
      liveWorkers.delete(child)
      clearTimeout(timer)
      return true
    }

    const timer = setTimeout(() => {
      if (!settle()) return
      void killTree(child.pid).then(() => {
        resolve({
          code: null,
          stderr: `${stderr}\n（超过 ${Math.round(WORKER_TIMEOUT_MS / 60_000)} 分钟没有结束，已杀掉整个进程树）`
        })
      })
    }, WORKER_TIMEOUT_MS)
    timer.unref?.()

    child.on('error', (error) => {
      if (!settle()) return
      reject(error)
    })

    child.on('close', (code) => {
      if (!settle()) return
      resolve({ code, stderr })
    })
  })
}

/**
 * 把一次渲染交给子进程做完。
 *
 * 签名与 `renderHtmlFileToPdf` 逐字相同，因为这是它的替身：成功时 `pdfPath` 已经写在盘上，
 * 失败时抛出的异常会由 `converters/document.ts` 那一层包成 `ConversionFailed`。
 */
export async function renderHtmlFileToPdfViaWorker(
  htmlPath: string,
  pdfPath: string,
  options: HtmlPdfOptions = {}
): Promise<void> {
  const depth = Number(process.env[DEPTH_ENV] ?? '0')
  if (depth > 0) {
    throw new Error(
      `PDF 子进程又走进了委托分支（深度 ${depth}）：这说明起子进程时没把 ELECTRON_RUN_AS_NODE ` +
        '摘掉，再往下就是无限递归，所以停在这里。'
    )
  }

  const target = resolveWorkerTarget()
  const dir = await mkdtemp(join(tmpdir(), 'arbiter-pdf-'))
  const requestPath = join(dir, 'request.json')
  const responsePath = join(dir, 'response.json')

  try {
    const request: PdfWorkerRequest = { htmlPath, pdfPath, options, responsePath }
    await writeFile(requestPath, JSON.stringify(request), 'utf8')

    const outcome = await spawnWorker(target, requestPath)
    const response = await readResponse(responsePath)

    if (response?.ok) return

    const detail = response?.message ?? '子进程没有留下结果文件'
    throw new Error(
      [
        '生成 PDF 时，负责排版的 Electron 子进程没能完成这次渲染。',
        `子进程说：${detail}`,
        ...(outcome.stderr.trim() ? [`子进程的 stderr：\n${outcome.stderr.trim()}`] : []),
        `子进程退出码：${outcome.code === null ? '（被杀掉，见上）' : outcome.code}`
      ].join('\n')
    )
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
}

/** 读回话。文件不在（子进程崩在半路）返回 `null`，由调用方给一句更笼统的话 */
async function readResponse(path: string): Promise<PdfWorkerResponse | null> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as PdfWorkerResponse
    return typeof parsed?.ok === 'boolean' ? parsed : null
  } catch {
    return null
  }
}
