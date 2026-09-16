import type { BrowserWindow, Session } from 'electron'
import { writeFile } from 'fs/promises'

/**
 * 用 Electron 自带的 Chromium 把 HTML 打印成 PDF。
 *
 * 为什么不引别的东西：Chromium 就在进程里，`printToPDF` 是它原生能力，
 * 排版质量（分页、断行、CJK 换行、print 媒体查询）跟 Chrome 里「打印成 PDF」一模一样。
 * 这也正是计划里「用 Chromium 干掉一半 LibreOffice 需求」那条思路的落点。
 *
 * ## 两种执行形态（审计 2026-09-15 §3.1）
 *
 * 这个模块有**两个**调用场景，而它们的进程里装着完全不同的东西：
 *
 * | 形态 | 谁在跑 | 怎么渲染 |
 * | --- | --- | --- |
 * | GUI | 真正的 Electron 主进程 | 本文件：进程内隐藏窗口 + `printToPDF` |
 * | CLI / MCP | `ELECTRON_RUN_AS_NODE=1`（**没有 Electron 运行时**） | 委托 `./pdfWorker`，由它拉起一个真的 `Arbiter.exe --pdf-worker` |
 *
 * 所以 `electron` **不能**在模块顶层 import。原先那行顶层
 * `import { BrowserWindow } from 'electron'` 在 CLI 形态下**不报加载错**（`require('electron')`
 * 返回的是 exe 路径字符串，见 `loadElectron()` 那张表），而是一路走到 `new BrowserWindow(…)`
 * 才炸成 **`TypeError: BrowserWindow is not a constructor`**（本机实测）。
 * 而 `docx / html / md → pdf` 恰恰是 CLI 上**该通**的一条路（`requiresDownload()` 刻意让它
 * 不必拖 357 MiB 的 LibreOffice）：前置检查放行、真正干活时炸，报出来的还是一句
 * 「你的源文件坏了」——审计 §3.1 那个 P0。
 *
 * 现在的形状：`electron` 在**函数里**惰性加载，加载不到就说明是 CLI 形态，转交子进程实现。
 * **只认 `ERR_MODULE_NOT_FOUND` / `MODULE_NOT_FOUND` 这一个原因**——别的异常照原样抛，
 * 免得把「Electron 装坏了」也当成「这里没有 Electron」而绕远路去起子进程。
 *
 * ⚠️ 类型那一侧用 `import type` 无妨：它在**编译期**就被抹掉，不产生任何 `require`。
 */

/** 隐藏窗口的会话名。不带 `persist:` 前缀 = 内存态，进程退出即销毁，不落盘 */
const PARTITION = 'pdf-render'

/**
 * 每个隐藏窗口 50-80 MB，所以并发必须压到 1（见 core/queue.ts 的 ENGINE_LIMITS）。
 * 这里再兜一道：万一将来上限被调大，也不至于把内存打爆。
 */
const MAX_WINDOWS = 2

/**
 * 一次渲染的看门狗时限。
 *
 * `loadFile` 与 `printToPDF` **都没有超时参数**，一个卡住的渲染会永久占着一个槽位；
 * 而 `MAX_WINDOWS` 只有 2，两次卡住就等于**整个 PDF 出口再也不动了**（所有 PDF 转换
 * 都卡在「生成 PDF…」上，不报错、不失败）。`core/engineInstall.ts` 的解包超时
 * 与三个 CLI 引擎的 `ENGINE_TIMEOUT_MS` 都是同一类看门狗。
 *
 * 值取 5 分钟，与 `ENGINE_TIMEOUT_MS` 同一个量级：本机实测同一份文档（2.16 MB 的
 * markdown 撑出来的 26.7 MB PDF）交给 LibreOffice 排版要 35 秒，Chromium 那条路
 * 没有进程冷启动、只会更快。5 分钟宽出一个数量级，不会误杀一次正在正常排版的大文档。
 */
const RENDER_TIMEOUT_MS = 5 * 60_000

/**
 * 排队等槽位的时限。
 *
 * 比单次渲染的看门狗**再宽一分钟**：等到这个点的正常含义是「排在前面的渲染
 * 全都过了自己的看门狗」，也就是真出事了。宽出这一分钟是为了让正在正常跑的那一次
 * 先有机会到期——否则排队的那个先放弃，而它等的那个其实还活着。
 */
const SLOT_WAIT_TIMEOUT_MS = RENDER_TIMEOUT_MS + 60_000

let live = 0

/** 等槽位的队列。`timer` 是它自己的等待上限，见 `acquireSlot` */
interface Waiter {
  grant: () => void
  timer: ReturnType<typeof setTimeout>
}
const waiting: Waiter[] = []

/**
 * 取一个渲染槽位。拿到返回 `true`，等到超时返回 `false`。
 *
 * ⚠️ **超时那一侧必须把自己从队列里摘掉**，这是本函数唯一容易写错的地方：
 * 留在队列里的话，下一次 `releaseSlot` 会把已经没人等的它 shift 出来、
 * 走一遍 `grant()`（那个 promise 已经 settled，什么都不会发生）**并且照样把
 * `live` 加回去**——那个槽位再也不会被释放，几轮之后这个出口静默瘫痪。
 */
async function acquireSlot(): Promise<boolean> {
  if (live < MAX_WINDOWS) {
    live += 1
    return true
  }

  const granted = await new Promise<boolean>((resolve) => {
    const waiter: Waiter = {
      grant: () => resolve(true),
      timer: setTimeout(() => {
        const index = waiting.indexOf(waiter)
        if (index >= 0) waiting.splice(index, 1)
        resolve(false)
      }, SLOT_WAIT_TIMEOUT_MS)
    }
    waiter.timer.unref?.()
    waiting.push(waiter)
  })

  // 交接时才真正占住槽位：`releaseSlot` 已经先减过一次，这一加正好抵消
  if (granted) live += 1
  return granted
}

function releaseSlot(): void {
  live -= 1
  const next = waiting.shift()
  if (next) {
    clearTimeout(next.timer)
    next.grant()
  }
}

let hardened: Session | null = null

/**
 * 掐断渲染期的网络访问。
 *
 * 两条理由，都不是洁癖：
 *  - **确定性**：用户 HTML 里一个挂掉的 CDN 链接就能让加载卡到超时，转换时间变得不可预期。
 *  - **隐私**：文档内容不该因为里面有个 `<img src="http://…">` 就被发到外网去。
 *
 * urls 过滤器写的是 http/https 通配，`file://` 不在其中——
 * 本地图片和样式照常加载。
 */
function hardenSession(session: Session): void {
  if (hardened === session) return
  hardened = session
  session.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (_details, callback) => {
    callback({ cancel: true })
  })
}

/**
 * 拿 Electron 运行时。拿不到（CLI / MCP 形态）返回 `null`。
 *
 * ## 判据有两道，而**第二道才是真正承重的那道**
 *
 * 本机实测（2026-09-15，`ELECTRON_RUN_AS_NODE=1 electron.exe -e "require('electron')"`）：
 *
 * | 进程                     | `require('electron')` 的结果                       |
 * | --- | --- |
 * | 真的 Electron 主进程     | 模块对象，`BrowserWindow` 是个类                   |
 * | **`ELECTRON_RUN_AS_NODE`**（CLI / MCP 的真实处境） | **不抛**，返回 electron.exe 的路径**字符串** |
 * | `node_modules` 里没有 electron 的普通 Node | 抛 `MODULE_NOT_FOUND`                    |
 *
 * ⚠️ **中间那一行是这道函数的全部理由。** 「加载不抛就算拿到了运行时」这个直觉是错的：
 * 字符串不是模块，`BrowserWindow` 从这里读出来是 `undefined`，于是原先那句顶层
 * `import { BrowserWindow } from 'electron'` 一路走到 `new BrowserWindow(…)` 才炸，
 * 报的是**「BrowserWindow is not a constructor」**——一个离真正原因（这里根本没有 Electron）
 * 隔着十万八千里的句子。同一件事在 `core/appPaths.ts` 的文件头也记着一次。
 *
 * 所以：
 *
 * 1. **加载不抛**，两种错误码都认：
 *    - `ERR_MODULE_NOT_FOUND` —— ESM 的 `import()`
 *    - `MODULE_NOT_FOUND` —— CJS 的 `require()`；打包产物里 rollup 会把
 *      `await import('electron')` 降级成 `Promise.resolve().then(() => require(…))`，走的就是这一支
 *    两种的文案都是 `Cannot find module|package 'electron'`，所以判据里带上那句原文。
 *    **只认「找不到的正是 electron」这一个原因**，其余异常照原样抛——凡是 `MODULE_NOT_FOUND`
 *    就当成「这里没有 Electron」，会把一个**装坏了的** Electron 悄悄引到子进程那条路上。
 * 2. **拿到的确实是个运行时**（`BrowserWindow` 是个函数）。见上表。
 *
 * ## 一个如实的缺口
 *
 * `scripts/electron-stub.ts`（`tsconfig.test.json` 的 paths 把 `electron` 指到它）**会通过
 * 第二道判据**——它确实导出了一个 `BrowserWindow` 类。所以**在 tsx + 那个 paths 的测试形态下**
 * （`test-tasks` / `test-mcp-server` 里转到 pdf 的那几条），这里会走进程内分支，
 * 然后在桩那个没有 `session` 的 `webContents` 上炸掉。这是**改动前就有的行为**，
 * 没有变好也没有变坏；真正的验收只能落在打包产物上（见 `test-plugin-launch.mjs`）。
 */
async function loadElectron(): Promise<typeof import('electron') | null> {
  let loaded: unknown
  try {
    loaded = await import('electron')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code
    const message = error instanceof Error ? error.message : String(error)
    const notFound = code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND'
    if (notFound && /Cannot find (?:module|package) 'electron'/.test(message)) return null
    throw error
  }

  const runtime = loaded as typeof import('electron') | null
  return typeof runtime?.BrowserWindow === 'function' ? runtime : null
}

export interface HtmlPdfOptions {
  /** 横向纸张 */
  landscape?: boolean
  /** 页边距，单位英寸。默认约 18mm × 16mm */
  marginInch?: { top: number; bottom: number; left: number; right: number }
}

const DEFAULT_MARGIN = { top: 0.71, bottom: 0.71, left: 0.63, right: 0.63 }

/**
 * 把本地 HTML 文件渲染成 PDF 写到 `pdfPath`。
 *
 * `htmlPath` 必须是**真实文件**而不是 `data:` URL：data: 页面加载同目录的图片和
 * 相对路径样式会被拦掉，markdown 里引用的图片就全丢了。
 *
 * ## 两条超时
 *
 * - **等槽位**：`acquireSlot()` 到点自己摘出队列并返回 `false`（见那里对 `live` 的说明）。
 * - **渲染本身**：`loadFile` + `printToPDF` + 落盘整段套一个看门狗。到点抛错，
 *   而 `finally` 里照样 `destroy()` 窗口并释放槽位——所以「卡死的渲染」此后不再
 *   永久占着一份内存和两个并发位。
 *
 * ## 取消
 *
 * 这里**看不到取消令牌**，是刻意的：`printToPDF` 一旦开始就无法从中间打断，而
 * 「渲染开始之前」那一次检查放在调用方（`converters/document.ts` 的 `runDocument`）——
 * 因为这里抛出去的任何东西都会被那一层的 catch 包成 `ConversionFailed`，
 * 于是「用户主动取消」会被显示成「转换失败」。调用方认得 `ConversionCanceled`，这一层不认得。
 */
export async function renderHtmlFileToPdf(
  htmlPath: string,
  pdfPath: string,
  options: HtmlPdfOptions = {}
): Promise<void> {
  const electron = await loadElectron()
  if (electron === null) {
    // 这里是 CLI / MCP 形态：本进程里没有 Electron 运行时，起一个真的 Electron 去打。
    // **按需加载**（而不是静态 import）：GUI 那条路上永远不会走到这里，没必要把
    // 子进程那一套拖进主进程的依赖图。
    const { renderHtmlFileToPdfViaWorker } = await import('./pdfWorker')
    return await renderHtmlFileToPdfViaWorker(htmlPath, pdfPath, options)
  }

  if (!(await acquireSlot())) {
    throw new Error(
      `等待 PDF 渲染槽位超过 ${Math.round(SLOT_WAIT_TIMEOUT_MS / 60_000)} 分钟仍未空出，已放弃本次转换。` +
        '同时有别的 PDF 转换卡在渲染上没有结束；取消那些任务后重试即可。'
    )
  }

  let win: BrowserWindow | null = null
  let timer: ReturnType<typeof setTimeout> | null = null

  try {
    const window = new electron.BrowserWindow({
      show: false,
      webPreferences: {
        // 我们只要它排版，不要它执行任何东西。用户 HTML 里带的脚本一律不跑。
        javascript: false,
        // 与主窗口同一套安全姿态：沙箱 + 隔离上下文 + 无 node
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        spellcheck: false,
        devTools: false,
        // 图片要开——markdown/HTML 里的插图全靠它
        images: true,
        partition: PARTITION
      }
    })
    win = window

    hardenSession(window.webContents.session)

    // 看门狗：`loadFile` 与 `printToPDF` 都没有超时参数（见 RENDER_TIMEOUT_MS 的说明）。
    // 到点让 race 先落地，`finally` 负责销毁窗口、释放槽位。
    const limit = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(
          new Error(
            `PDF 渲染超过 ${Math.round(RENDER_TIMEOUT_MS / 60_000)} 分钟没有结束，已中止本次转换` +
              '（渲染窗口随即销毁、占用的槽位一并释放）。' +
              '渲染侧的卡死通常来自版面上某个异常大的元素或分页计算；换一份输入重试即可。'
          )
        )
      }, RENDER_TIMEOUT_MS)
      timer.unref?.()
    })

    await Promise.race([
      (async () => {
        // loadFile 在 did-finish-load 时 resolve。此时 DOM 和本地资源都已就绪。
        // 注意：javascript 关掉之后 execJavaScript 用不了，也就查不了 document.fonts.ready；
        // 我们用的是系统字体（微软雅黑等），不依赖网络字体，没有等待的必要。
        await window.loadFile(htmlPath)

        const data = await window.webContents.printToPDF({
          printBackground: true,
          pageSize: 'A4',
          landscape: options.landscape ?? false,
          margins: options.marginInch ?? DEFAULT_MARGIN
        })

        await writeFile(pdfPath, data)
      })(),
      limit
    ])
  } finally {
    if (timer) clearTimeout(timer)
    // 窗口必须销毁：隐藏窗口不会自己消失，泄漏几个就是几百 MB
    if (win && !win.isDestroyed()) win.destroy()
    releaseSlot()
  }
}
