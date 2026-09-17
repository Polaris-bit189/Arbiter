import './assets/main.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'

/**
 * 全窗口的拖放兜底：**只做 preventDefault，不在这里收文件**。
 *
 * 少了这两行，把文件拖到拖拽区**以外**的任何地方松手，Chromium 会执行 drop 的默认行为
 * ——把顶层框架导航到 `file:///<那个文件>`。界面当场被文件内容顶掉（PDF 阅读器、视频、
 * 一屏纯文本），而我们 `frame: false` + `autoHideMenuBar`，没有后退按钮也没有菜单，
 * 用户只能去杀进程。这个坑不需要手抖就能踩到：拖拽区只有 168px，队列一长就压成 96px，
 * 而切到历史 / 设置 / 关于页时它整个是 `hidden` 的——那时窗口上**没有一处**是安全落点。
 *
 * 为什么不在这一层顺手把文件入队：`DropZone` 自己的 `onDrop` 负责收，挂在这层再收一次，
 * 拖到框内的文件会被加两遍（React 的事件是委托到 root 容器的，两处都会跑）。
 *
 * 为什么不在主进程加 `will-navigate` 兜底（`window.ts` 的 `setWindowOpenHandler` 只管
 * 新窗口，管不了这条同框架导航）：dev 下 HMR 的整页刷新就是一次渲染进程发起的导航，
 * 一刀切拦掉会把热更新打断。要拦就得先放行 `ELECTRON_RENDERER_URL` 的源，多出来的
 * 那点复杂度换不来什么——下面这两行才是这条路径的正解。
 */
window.addEventListener('dragover', (event) => event.preventDefault())
window.addEventListener('drop', (event) => event.preventDefault())

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
