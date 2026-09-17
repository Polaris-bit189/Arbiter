import { app, BrowserWindow, ipcMain, nativeTheme } from 'electron'
import { electronApp, optimizer } from '@electron-toolkit/utils'
import { createWindow } from './window'
import { registerIpc } from './ipc'
import { applyCliRequest, focusMainWindow, getTaskManager, mainWindow } from './ipc/tasks'
import { appPathsFromElectron, setAppPaths } from './core/appPaths'
import { flushSettingsSync, getSettings, loadSettingsSync } from './core/settings'
import { flushHistorySync, loadHistorySync } from './core/history'
import { parseConvertRequest } from './core/cli'
import { ensureContextMenu } from './core/integration'
import { ensureSendTo } from './core/sendTo'
import { stopRenameWatch, syncRenameWatch } from './ipc/rename'
import { createNetTransport } from './core/downlink'
import { setInstallTransport } from './core/engineInstall'

// 路径环境必须在**任何读路径的代码跑起来之前**装好。
//
// 放在模块体里而不是 `whenReady` 里：`app.getPath` / `app.getAppPath` 在 ready 之前
// 就可读，而 `whenReady` 里的 `loadSettingsSync()` 已经要读 userData 了。
//
// ⚠️ 它**挡不住**各模块在加载期读路径——import 先于本模块体求值。所以那些模块
// 自己也不许在加载期读（`core/settings.ts` 的存储实例为此改成了惰性创建），
// 谁破了这条规矩，启动时就会看到 `appPaths()` 抛「路径环境未初始化」。
// 反方向：MCP 那条线不 import 这个文件，它自己调一次 `setAppPaths()`。
setAppPaths(appPathsFromElectron(app))

// 按需下载的传输层同样在这里注入，理由与上面那行一样：
// `core/engineInstall.ts` 要在没有 Electron 的进程里被加载（约束 19），
// 所以它不自己 `require('electron')`，由入口把真正的实现塞给它。
// **忘了这一行不会报错**，只会在第一次下载引擎时说「传输层未注入」。
setInstallTransport(createNetTransport())

// preload 启动自检：确认 sandbox 下 webUtils 等能力是否如期可用。
// 拖拽取路径一旦静默失效极难排查，所以在开发期把探测结果打到终端。
//
// ⚠️ **`app.isPackaged` 那道闸是承重的，不是省几行日志。** 这条自检是**开发期**的东西，
// 而 `console.log` 写的是 **stdout**——在打包版里它就是往用户/调用方的数据通道上写字。
// 实测（2026-09-14，审计 D4）：0.3.0 那个「让 `Arbiter.exe` 自己当 CLI」的形态下，
// 一次 `--json` 运行的 stdout 里除了 JSON 还混着这一行，**`JSON.parse` 在调用方那里抛**，
// 而我们这边一声不吭。修法有两层，缺一不可：
//
//   - D2 的 `arbiter.cmd`（`ELECTRON_RUN_AS_NODE=1` 跑 `out/main/cli.js`）——
//     它根本不加载本文件，所以 CLI 的 stdout 上不会再有这一行；
//   - 这一道 `isPackaged` 闸——它挡的是**另一条路**：有人直接
//     `Arbiter.exe > out.txt` 重定向 GUI 进程的 stdout，或者将来 CLI 又被接回 GUI 入口。
//
// 收窄成 dev-only 与上面那句注释的原文（「在开发期把探测结果打到终端」）是同一件事，
// 不是把功能砍掉。
if (!app.isPackaged) {
  ipcMain.on('diag:capabilities', (_event, info: unknown) => {
    console.log('[diag] preload capabilities =', info)
  })
}

// ---- CLI / MCP 的 PDF 渲染子进程（审计 2026-09-15 §3.1）----
//
// ⚠️ **这个分支必须在下面那句 `requestSingleInstanceLock()` 之前**，这不是顺序癖好：
// worker 就是同一个 `Arbiter.exe` 的第二个进程（CLI 形态下父进程自己也是它，只不过戴着
// `ELECTRON_RUN_AS_NODE=1` 那顶帽子）。去抢锁必然抢不到，然后它**安安静静地 `app.quit()`**——
// 父进程那边只能等到超时才失败，而手上一点线索都没有。
//
// 形态、协议与「为什么结果走文件而不走 stdout」见 `engines/pdfWorker.ts` 的文件头。
//
// ⚠️ **那个字面量不能改成从模块里 import**，必须在这里重写一遍
// （它与 `engines/pdfWorker.ts` 的 `PDF_WORKER_FLAG` 必须逐字相同，有一条断言钉着——
// 对不上的表现是子进程以 GUI 身份启动、抢不到单实例锁然后静默退出，父进程白等十分钟）。
//
// 下面那句 `import()` 用动态形式。⚠️ **但这是一条防御性约定，不是实测逼出来的**：
// 2026-09-15 受控变异过三次（这里静态 `import { runPdfWorker } from './engines/pdfWorkerHost'`、
// 静态 `import … from './engines/chromiumPdf'`、宿主里加一句值 import），**三种都不复现**
// 「产生 `require("../index.js")` 那条边」的说法，rollup 一律把目标留成自己的 chunk。
// 原先写成静态 import 的那一版**确实坏过**（打包 CLI 走到 pdf 出口报
// `Cannot find module 'electron'`、被包成「你的源文件坏了」），但**病根在
// `engines/chromiumPdf.ts` 顶层那句值 import**，不在本文件——详见那里的文件头。
// 本仓库对这件事的判据是 `scripts/test-plugin-launch.mjs` 第 18 条
// （遍历 CLI / MCP 可达的闭包，查加载期的 `require('electron')`），而不是这条注释。
const PDF_WORKER_FLAG = '--arbiter-pdf-worker'
const PDF_WORKER_FLAG_PREFIX = `${PDF_WORKER_FLAG}=`

function pdfWorkerRequestPath(argv: readonly string[]): string | null {
  for (const arg of argv) {
    if (arg.startsWith(PDF_WORKER_FLAG_PREFIX)) return arg.slice(PDF_WORKER_FLAG_PREFIX.length)
  }
  return null
}

const pdfWorkerRequest = pdfWorkerRequestPath(process.argv)
if (pdfWorkerRequest !== null) {
  void import('./engines/pdfWorkerHost')
    .then(({ runPdfWorker }) => runPdfWorker(app, pdfWorkerRequest))
    .catch((error: unknown) => {
      // `runPdfWorker` 自己把一切异常收进回话里、永不 reject，所以这里接住的是
      // 「这个模块压根没加载起来」。那时没人给父进程回话，父进程只能等到十分钟超时——
      // 至少把原因留在 stderr 上。
      console.error('[pdf] PDF 渲染子进程没能启动：', error)
      app.exit(1)
    })
} else if (!app.requestSingleInstanceLock()) {
  // 单实例锁：两个实例会抢同一份任务队列与引擎目录，必须挡住
  app.quit()
} else {
  // 第二次启动的 argv 走这里（右键菜单连点几个文件就是这种形态：第一个实例照常启动，
  // 之后每一次点击都是「第二个实例」，它自己退出、把 argv 甩给我们）。
  //
  // ⚠️ 参数**必须从事件里取**，不能去读 `process.argv`：那读到的始终是**第一次**启动的
  // 命令行，于是「右键转第二个文件」会变成「把第一个文件又转一遍」——产物同名、
  // 看起来只是「多点了一次没反应」。
  app.on('second-instance', (_event, argv, workingDirectory) => {
    focusMainWindow()
    // cwd 用事件给的那一个：文件路径可能相对，而相对谁由**发起那次**的进程决定
    const parsed = parseConvertRequest(argv, workingDirectory || process.cwd())
    void applyCliRequest(parsed, mainWindow()).catch((error: unknown) => {
      // 这条链路上没有任何界面元素能承载异常，吞掉就等于静默失败
      console.error('[cli] 处理外部转换请求失败：', error)
    })
  })

  app.whenReady().then(() => {
    // ⚠️ 这个字符串必须与 electron-builder.yml 的 **appId 逐字一致**。
    // 不一致时 Windows 会把应用和它的快捷方式当成两个东西：任务栏固定失效、
    // 通知归错组、装了新版本看起来像装了个新程序——而且它**不会报任何错**。
    // 这里和 appId 原本都是脚手架残留，两个还互不相同。
    electronApp.setAppUserModelId('io.github.polaris-bit189.arbiter')

    // **固定深色**，界面不再跟随系统。这一行就是总闸：它让整棵 Chromium 的
    // prefers-color-scheme 恒为 dark，配合 main.css 里那句 `color-scheme: dark`，
    // 原生滚动条 / 原生 <select> 的下拉面板 / <input> 才真的会是深色。
    // 换言之「看不出是浅色」这件事不靠任何渲染层代码，所以也别在这里改回 'system'。
    nativeTheme.themeSource = 'dark'

    // 同步读盘，且必须在 createWindow() **之前**：渲染层一挂载就会调
    // settings:get / history:list，异步加载必然抢不过第一轮 IPC，
    // 于是「首屏看到的是一份空设置 / 空历史」，刷新一下又好了。
    loadSettingsSync()
    loadHistorySync()

    app.on('browser-window-created', (_, window) => {
      optimizer.watchWindowShortcuts(window)
    })

    registerIpc()
    createWindow()

    // ---- M8：外部拉起与右键菜单 ----

    // 右键菜单的自愈。设置里开着、但注册表里那条命令行指向的不是**这一次**的 exe
    // （换了安装目录、重装了、被别的清理工具删过），就在这里补回去。
    // 它是纯读 + 必要时写，所以不 await——`createWindow()` 已经回来了，这里慢一点
    // 不影响首屏；反过来 await 会让「reg.exe 卡住」变成「应用打不开」。
    if (getSettings().contextMenu) {
      void ensureContextMenu().catch((error: unknown) => {
        console.error('[integration] 右键菜单自愈失败：', error)
      })
    }

    // 「发送到」快捷方式的自愈，判据与上面完全同类：设置里开着、但那个 `.lnk` 不在
    // （被清理工具删了）或者它指向的不是**这一次**的 exe（重装到别的目录、dev 与打包版
    // 来回切），就重写一遍。它同样是「先读、必要时才写」，而且是同步的（`rmSync` /
    // `writeShortcutLink` 都不起子进程），所以这里连 await 都不需要。
    //
    // ⚠️ 它与右键菜单是**两个独立的开关**：卸载时各自的清理也分在两处
    //（注册表那半在 `build/installer.nsh` 的 `customUnInstall` 里）。
    if (getSettings().sendTo) {
      try {
        ensureSendTo()
      } catch (error) {
        console.error('[integration] 发送到快捷方式自愈失败：', error)
      }
    }

    // 「重命名即转换」的监听器。**默认什么都不装**——`syncRenameWatch()` 自己判
    // 「开关打开且目录非空」，两条缺一条就直接返回，连 `fs.watch` 都不建。
    // 这是 §M8 那条唯一验收判据「默认关闭状态下零副作用」的落点。
    // 文件名也要给 `console.warn` 留出空间，所以不 await，只兜住异常。
    void syncRenameWatch().catch((error: unknown) => {
      console.error('[rename] 装配重命名监听失败：', error)
    })

    // 启动参数里带着 `--convert <文件>` 就是右键菜单/命令行拉起来的，直接把那个文件
    // 收进队列并开跑。**放在 createWindow() 之后**：入队要推增量事件，
    // 而窗口还没建时 broadcast 找不到接收者，任务会进了队列却不显示
    //（渲染层挂载时拉的快照能补回来，但中间那一瞬的状态是错的）。
    //
    // 首次启动走 `process.argv`，后续每一次走上面的 `second-instance`。
    void applyCliRequest(parseConvertRequest(process.argv, process.cwd()), mainWindow()).catch(
      (error: unknown) => {
        console.error('[cli] 处理启动参数失败：', error)
      }
    )

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  // 退出前杀掉所有在跑的转换进程。
  // 不这么做的话，关窗后 ffmpeg.exe 会带着已断开的 stdio 继续跑完整个转码，
  // 用户会觉得「关了还在占 CPU」，而且残留的 .part 文件永远不会被清理。
  //
  // 顺序有讲究：**先让队列收尾，再刷盘**。被 shutdown 取消掉的任务会在收尾时
  // 落一条终态（进历史），反过来刷就会把这批刚产生的记录留在内存里丢掉。
  // 同步写是这里唯一正确的选择：before-quit 之后事件循环很快就没了，
  // 异步写、以及 jsonStore 里那个「500ms 合并写」的定时器，根本来不及跑完。
  // 这是全项目唯一该用同步 IO 的地方。
  const flush = (): void => {
    flushHistorySync()
    flushSettingsSync()
  }

  // ⚠️ 「先收尾再刷盘」这件事**是异步的**，所以不能像原来那样刷完就放行。
  // `shutdown()` 只是发一个取消信号：进程要被 `taskkill /T /F` 杀掉之后，
  // `execute()` 的 catch 才会跑、才会 `archive()` 落那条终态。原地同步刷完就走，
  // 刷的是一份**还没有这批记录**的内存，上面那句承诺并不成立——表现是「关掉应用之后，
  // 最后那批被取消的任务在历史页里查无此项」。
  //
  // 所以拦下这一次退出，等 `drain()` 回来再刷。2 秒是上限而不是预期（杀进程是毫秒级的），
  // 到点也照样往下走：绝不能因为某个引擎僵住就让用户关不掉应用。
  let quitting = false

  app.on('before-quit', (event) => {
    if (quitting) return

    // 退出路径上不该还挂着一个「看着用户文件夹」的东西。建的时候就没让 `fs.watch`
    // persistent，本来就撑不住进程，所以这里是**显式**收尾而不是必须——
    // 但它同样保证了「开关关掉之后不可能还有人动你的文件」这条性质在整个生命周期成立。
    stopRenameWatch()

    const manager = getTaskManager()
    manager.shutdown()

    // 没有在跑的（绝大多数情况）就直接刷，不绕这一圈 preventDefault
    if (manager.runningCount() === 0) {
      flush()
      return
    }

    event.preventDefault()
    void (async () => {
      await manager.drain(2000)
      flush()
      // 置位之后再调 quit，这一趟会直接放行，不会又绕回等一遍
      quitting = true
      app.quit()
    })()
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
