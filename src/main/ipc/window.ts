import { app, BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { CH } from '@shared/channels'

/**
 * 窗口控制的 IPC handler。
 *
 * 通道：`window:minimize` / `toggleMaximize` / `close` / `isMaximized`，
 * 外加一条 main → renderer 的广播 `window:maximizedChanged`。
 *
 * 这一整套之所以存在，是因为标题栏改成了**完全自绘**（`frame: false`，见 `window.ts`）：
 * 原生 caption 没有了，三键就得自己做。三个不能省的细节：
 *
 *   - **必须监听 `maximize` / `unmaximize` / `enter-full-screen` / `leave-full-screen`**
 *     并广播出去。只在点击按钮时翻转本地状态是不够的——用户还能双击标题栏、
 *     按 Win+↑ 改变窗口状态，那些路径不经过我们的按钮，图标会一直错着。
 *   - 标题栏**双击要能最大化**（原生 caption 的行为，自绘之后没有了）
 *   - 三键必须显式带 `.no-drag`，否则它们整体落在拖拽区里点不动
 *
 * 自绘是已知并接受的取舍：**失去 Windows 11 悬停最大化按钮弹 Snap Layouts**
 * （那需要响应 `WM_NCHITTEST`，Electron 的自绘按钮做不到）。
 */

/**
 * 取发起调用的那个窗口。
 *
 * **刻意不持有全局单例**：测试路径下 `BrowserWindow.getAllWindows()` 是空数组，
 * 而窗口本身还会在 darwin 的 `activate` 里被重建——单例在这两种情况下要么是 null、
 * 要么指向一个已经销毁的窗口，失败方式都是「三键点了没反应」。
 * `fromWebContents` 拿到的永远是调用方自己那一个。窗口已销毁时返回 null。
 */
function senderWindow(event: IpcMainInvokeEvent): BrowserWindow | null {
  return BrowserWindow.fromWebContents(event.sender)
}

/**
 * 「窗口现在处于非还原态吗」——即三键中间那个键该显示「还原」还是「最大化」。
 *
 * 全屏也算：Win+↑ 是最大化，F11（默认菜单里的 Toggle Full Screen）是全屏，
 * 两者都该让中间那个键变成「还原」，否则全屏时它会一直显示成「最大化」，
 * 而点下去又不动（已经是最大化态）。判据与动作必须成对，见 toggleMaximize。
 */
function isMaxLike(win: BrowserWindow): boolean {
  if (win.isDestroyed()) return false
  return win.isMaximized() || win.isFullScreen()
}

export function registerWindowIpc(): void {
  ipcMain.handle(CH.windowMinimize, (event) => {
    senderWindow(event)?.minimize()
  })

  ipcMain.handle(CH.windowToggleMaximize, (event) => {
    const win = senderWindow(event)
    if (win === null || win.isDestroyed()) return false

    if (win.isFullScreen()) win.setFullScreen(false)
    else if (win.isMaximized()) win.unmaximize()
    else win.maximize()

    // 顺手回一个即时值给调用方；权威值随后由下面的广播再推一次
    return isMaxLike(win)
  })

  ipcMain.handle(CH.windowClose, (event) => {
    senderWindow(event)?.close()
  })

  ipcMain.handle(CH.windowIsMaximized, (event) => {
    const win = senderWindow(event)
    // 窗口可能已经销毁（关窗途中渲染层还在问），此时 isMaximized() 直接抛
    return win !== null && isMaxLike(win)
  })

  // 挂在 `browser-window-created` 上，而不是在 createWindow() 里逐个窗口注册：
  // `registerIpc()` 在 `createWindow()` **之前**调用（见 main/index.ts），
  // 这里能覆盖到每一个窗口，包括 darwin 下 activate 重建出来的那些。
  app.on('browser-window-created', (_event, win) => {
    const broadcast = (): void => {
      if (win.isDestroyed()) return
      win.webContents.send(CH.windowMaximizedChanged, isMaxLike(win))
    }

    win.on('maximize', broadcast)
    win.on('unmaximize', broadcast)
    win.on('enter-full-screen', broadcast)
    win.on('leave-full-screen', broadcast)
  })
}
