import { BrowserWindow, shell } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import { SHELL } from '@shared/theme'

/**
 * 窗口图标。dev 下 `__dirname` 是 `<仓库根>/out/main`，往上两层正好是 `resources/`；
 * 打包后同一相对路径落在 asar 内，而 `resources/**` 在 electron-builder.yml 里是
 * `asarUnpack` 的，Electron 读 asar 时会自动落到 `app.asar.unpacked/` 上——两边都成立。
 *
 * 用 PNG 而不是 `build/icon.ico`：`build/` 是 electron-builder 的 buildResources，
 * **不会进包**，拿它当窗口图标只有 dev 能跑。任务栏要的小尺寸由系统从这张 512 自己缩，
 * `.ico` 里那 16/32/48/64/128 逐档渲染的版本留给打包那条路。
 */
const icon = join(__dirname, '../../resources/icon.png')

/**
 * 主窗口。
 *
 * **整条标题栏自绘**（`frame: false`，三键与拖拽区见 `renderer/components/TitleBar.tsx`，
 * 通道见 `ipc/window.ts`）。所以这里不再有 `titleBarStyle` / `titleBarOverlay`——
 * 那两个选项是留给原生 caption 的，留着只会让「谁负责画标题栏」有两份答案。
 */
export function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    // 1280×800 是设计稿的窗口尺寸。最小尺寸按「224px 侧栏 + 还能放下一整行内容」
    // 反推：旧的 560×420 是按单列布局选的，塞进侧栏后主区只剩 336px。
    width: 1280,
    height: 800,
    minWidth: 980,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    // 页面首帧绘制出来之前的那几百毫秒，窗口显示的就是这个颜色。
    // 取 SHELL.bgDeep（= CSS 的 --c-bg-deep）而不是随手写一个深色：
    // 原先这里是 '#0b1220'（slate 蓝），换黑金之后启动瞬间会闪一道蓝光。
    backgroundColor: SHELL.bgDeep,
    frame: false,
    icon,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // 待验证：webUtils.getPathForFile 在 sandbox preload 中是否可用。
      // 不可用则退到 false（前两项仍保证安全边界）。
      sandbox: true,
      spellcheck: false
    }
  })

  win.on('ready-to-show', () => win.show())

  // 外链一律不在应用内打开；只放行 https
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })

  // 这里原先挂着 nativeTheme.on('updated')：它的行为是重设 titleBarOverlay，
  // 以及给一个**已经不存在的通道**发消息（主题三通道已整块删除，固定深色）。
  // 留着等于在生产代码里放一条指向已删通道的 send；它还有个副作用——
  // 注册在 createWindow() 内部，darwin 下每次 activate 重建窗口都会累积监听器。

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return win
}
