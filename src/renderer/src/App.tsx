import { useEffect } from 'react'
import { Sprite } from './components/Sprite'
import { Toast } from './components/Toast'
import { TitleBar } from './components/TitleBar'
import { Sidebar } from './components/Sidebar'
import { WorkbenchPage } from './pages/WorkbenchPage'
import { HistoryPage } from './pages/HistoryPage'
import { SettingsPage } from './pages/SettingsPage'
import { AboutPage } from './pages/AboutPage'
import { useNav } from './store/useNav'
import { useTasks } from './store/useTasks'
import { useHistory } from './store/useHistory'
import { useSettings } from './store/useSettings'
import { useIntegration } from './store/useIntegration'
import { useEngines } from './store/useEngines'

/**
 * 外壳：标题栏 44px / 金色发丝线 1px / [侧栏 224px | 页面区]。
 *
 * 整页不滚（`main.css` 里 body 已是 `overflow: hidden`），**滚动一律发生在页面区
 * 自己的容器里**——长列表的表头要始终可见、拖拽区不该被滚走，都靠这一条。
 */
function App(): React.JSX.Element {
  const page = useNav((s) => s.page)

  useEffect(() => {
    // 这两句**必须留在这一层**，不能下移到页面组件里。
    // useTasks 是模块级 store，而 onTasksPatch 的订阅是在 init() 里建立、且从不销毁的：
    // 页面卸载不会掉镜像。反过来说，一旦把 init() 挂到某个页面上，
    // 「没进过那个页面就先没有镜像」这种事就会静默发生。
    // 用 getState() 取动作，避免把函数放进依赖数组后反复重建订阅。
    void useTasks.getState().init()
    void useSettings.getState().init()
    // 历史也在这里拉一次：入队时的「上次这类文件转成了什么」要读它
    //（见 `useTasks` 的 `settle`），而用户完全可以一次都不进历史页。
    // 它是 `ready` 幂等的，历史页那一侧的 `reload()` 照样会再拉一遍。
    void useHistory.getState().init()
    // 系统集成那一份也是**一次就够**的：它读的是注册表，而在应用运行期间只有本应用
    // 会去改它。放进设置页的 useEffect 会在每次切到那一页时再起一个 reg.exe，
    // 而设置页是可反复进出的。
    // 非 Windows 上什么都不做——设置页里那一整块不渲染，拉回来也没人看。
    if (window.api.platform === 'win32') void useIntegration.getState().init()

    // 引擎下载进度同理留在这一层：一次下载是分钟级的，用户完全可能切到别的页面
    // 去干别的。订阅挂在关于页上的话，切走就丢帧，回来看到的是一个冻在某个百分比的条。
    // 顺带一提，**这里不调 useEngines.init()**：状态列表只有关于页要，让它自己去拉。
    const off = window.api.onEngineProgress((progress) => {
      useEngines.getState().setInstallProgress(progress)
    })
    return off
  }, [])

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-canvas text-fg">
      {/* 素材 sprite 全文档只挂一次：logo.svg 里的 <linearGradient id="gGold"> 只能有一份 */}
      <Sprite />

      <TitleBar />
      <div className="hairline" />

      <div className="flex min-h-0 flex-1">
        <Sidebar />

        <main className="flex min-h-0 min-w-0 flex-1 flex-col">
          {/*
            工作台用 hidden 保活而不是卸载：长列表的 scrollTop 一旦卸载就没了，
            切去「关于」再切回来会发现队列跳回顶部。
            另外三页反过来——条件渲染、用完整卸载换一份干净的表单状态。
          */}
          <div className={page === 'work' ? 'flex min-h-0 flex-1 flex-col' : 'hidden'}>
            <WorkbenchPage />
          </div>

          {page !== 'work' && (
            <div className="scroll-dark min-h-0 flex-1 overflow-y-auto">
              {page === 'history' && <HistoryPage />}
              {page === 'settings' && <SettingsPage />}
              {page === 'about' && <AboutPage />}
            </div>
          )}
        </main>
      </div>

      {/*
        Toast 宿主只挂这一处，**四个页面都不要各自挂一个**。

        它读的是模块级 store（`useToast`），宿主挂在哪一页都无所谓——但宿主本身
        必须始终在挂载状态。工作台是用 `hidden` 保活的，而 `display: none` 会让
        子树里的 `fixed` 子元素一起消失，于是「工作台里的宿主」在别的页面上等于不存在。
        在页面里补宿主能绕过去，可补的人得先想到「另外三页还没有」——设置页保存成功
        弹的那句「已归其位」就会静默消失，不报任何错。

        挂在 shell 层就与页面切换彻底无关了：新增页面不必记得带一个宿主。
      */}
      <Toast />
    </div>
  )
}

export default App
