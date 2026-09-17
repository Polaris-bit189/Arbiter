import { readFile, writeFile } from 'fs/promises'
import type { PdfWorkerRequest, PdfWorkerResponse } from './pdfWorker'

/**
 * PDF 渲染子进程的**宿主侧**——即被 `Arbiter.exe --arbiter-pdf-worker=<request.json>` 起来的
 * 那个真 Electron 主进程要做的事（审计 2026-09-15 §3.1）。
 *
 * 客户端那半边在 `./pdfWorker`，两者的分工只有一句：**客户端准备请求、宿主干活、回话走文件**。
 * 协议、为什么不用 stdout 传结果、以及深度闸，都写在 `./pdfWorker` 的文件头，这里不重复。
 *
 * ## 为什么这个文件里**一个字都不许 import electron**
 *
 * ⚠️ **先记一次纠正（2026-09-15）。** 这里原先写着「凡是静态进了 `index.js` 的模块，
 * 任何别处对它的动态 import 都会被 rollup 降级成 `require("../index.js")`」，并把它
 * 当成 §3.1 那个 P0 的机制。**这个归因是错的，而且复现不出来**——当天做了三组受控变异
 * （`index.ts` 静态拉 `pdfWorkerHost` / 静态拉 `chromiumPdf` / 宿主里加一句值 import），
 * 三种都不产生那条边，rollup 一律把目标留成自己的 chunk。按约束 21b 的规矩，
 * 一条只观测到一次、又拒绝复现的结论不配写进约束，所以那段叙述撤掉。
 *
 * **实测成立的那条**（它才是 §3.1 的病，见 `chromiumPdf.ts` 的文件头）：
 * `chromiumPdf.ts` 顶层那句**值** import（`import { BrowserWindow, type Session } from 'electron'`）
 * 让它自己的 chunk 在加载期就 `require("electron")`。打包形态下 asar 里没有
 * `node_modules/electron`，于是 CLI 走到 pdf 出口时抛 `Cannot find module 'electron'`，
 * 被包成 `source_corrupt`「你的源文件坏了」。**判据是「CLI / MCP 可达的闭包里有没有
 * 加载期的 `require('electron')`」**，由 `test-plugin-launch.mjs` 第 18 条盯着。
 *
 * ## 那这两条规矩呢
 *
 * 它们**保留，但降为防御性约定**（不是被实测逼出来的）：
 *
 * ① `index.ts` 对这里用 `await import()`——宿主只在那一个分支里用得上，静态吃进来会让
 * `index.js` 白背着它；
 * ② 这里不许出现 `import { app } from 'electron'`——需要 `app` 就让调用方**传进来**
 * （下面 `WorkerHostApp`）。真正的收益是**可测**：对 electron 零依赖，这个模块就能在
 * 不起 Electron 的前提下被单测。手法与 `core/appPaths.ts` 的 `setAppPaths()` 同源，
 * 只是方向相反：那个是入口把路径推进来，这个是入口把 `app` 递进来。
 */

/**
 * 宿主实际用到 `app` 的三件东西。
 *
 * 写成结构类型而不是 `import type { App } from 'electron'`，图的是**编译期能验真**：
 * `index.ts` 里传的是真 `app`，形状对不上就编译不过；而这个文件本身对 electron 零依赖，
 * 因此可以为它写一个不启动 Electron 的测试。
 */
export interface WorkerHostApp {
  /** 约束 17：Electron 默认「最后一个窗口关掉就退出应用」，而渲染窗口每次用完都 destroy */
  on(event: 'window-all-closed', listener: () => void): unknown
  whenReady(): Promise<void>
  exit(code?: number): void
}

/**
 * 干一次活，然后把结果写进请求里指定的那个 `responsePath`，最后退出。
 *
 * **本函数永不 reject**：一切异常都被收进回话里。理由是父进程等的是一个文件，
 * 而一个「子进程自己崩了」的现场在父进程那侧只剩下一个退出码——把话说清楚的机会
 * 只有这里一次。
 */
export async function runPdfWorker(app: WorkerHostApp, requestPath: string): Promise<void> {
  let request: PdfWorkerRequest | null = null
  let response: PdfWorkerResponse = { ok: false, message: '子进程在写回话之前就退出了' }

  // ⚠️ 注册在 try **之外**：连请求文件都读不出来的时候，这条防线同样得在。
  // 少了它，`window-all-closed` 会让 Electron 在渲染窗口 destroy 的那一刻就退出进程——
  // 那时回话还没写，父进程只能等到超时。实测过的现场就是「一条失败信息都没有」。
  app.on('window-all-closed', () => {
    /* 什么时候退出由本函数自己决定（`app.exit`），见 `chromiumPdf.ts` 用完即 destroy */
  })

  try {
    request = JSON.parse(await readFile(requestPath, 'utf8')) as PdfWorkerRequest
    await app.whenReady()

    // 按需加载：宿主这条路上 chromiumPdf 一定会被用到，但这个文件是被**动态** import 的，
    // 静态吃进来只会让它顺带落进别的 chunk，没有好处。
    const { renderHtmlFileToPdf } = await import('./chromiumPdf')
    await renderHtmlFileToPdf(request.htmlPath, request.pdfPath, request.options ?? {})

    response = { ok: true }
  } catch (error) {
    response = { ok: false, message: error instanceof Error ? error.message : String(error) }
  }

  if (request !== null) {
    try {
      await writeFile(request.responsePath, JSON.stringify(response), 'utf8')
    } catch (error) {
      // 回话写不出去就真的没别的办法了，至少让 stderr 上留一句
      console.error('[pdf] 写回话失败：', error)
    }
  }

  app.exit(response.ok ? 0 : 1)
}
