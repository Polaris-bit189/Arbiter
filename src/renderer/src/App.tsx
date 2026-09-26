import { useEffect } from 'react'
import { setLocale, t } from '@shared/i18n'
import { Sprite } from './components/Sprite'
import { Toast } from './components/Toast'
import { TitleBar } from './components/TitleBar'
import { Sidebar } from './components/Sidebar'
import { WorkbenchPage } from './pages/WorkbenchPage'
import { HistoryPage } from './pages/HistoryPage'
import { SettingsPage } from './pages/SettingsPage'
import { AboutPage } from './pages/AboutPage'
import { htmlLangOf, localeOf } from './lib/locale'
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
 *
 * ## 语言切换靠 `key={locale}` 重挂，不重启
 *
 * 唯一的那个 `key` 放在**下面那个 shell 根元素**上，整个子树跟着换一次语言。
 * 这样做的代价是工作台长列表会丢 `scrollTop`——而用户一辈子改一次语言，划算。
 *
 * ⚠️ **`key` 只管「重挂」，管不了「用哪门语言重挂」。** 全局那份语言由上面渲染期的
 * `setLocale(locale)` 负责，**不能挪进 effect**——effect 在 commit 之后才跑，而重挂
 * 就发生在 commit 那一刻，挪进去的结果是「换了语言的那一次重挂，整棵树用的是旧语言」。
 * 0.3.6 实测过：那样子选英文，侧栏与页脚会翻、**工作台整页不翻**，而且不退。
 *
 * 为什么不改 URL query：`loadFile` 与 dev 的 `ELECTRON_RENDERER_URL` 是两条 bootstrap
 * 路径，语言写进 URL 之后，切完语言 F5 整页刷新会**悄悄退回旧语言**。
 */
function App(): React.JSX.Element {
  const page = useNav((s) => s.page)
  const settings = useSettings((s) => s.settings)
  const locale = localeOf(settings)

  /*
   * ⚠️ **必须在渲染期就把语言推给那份全局，不能只放在下面那个 effect 里。**
   *
   * `useEffect` 跑在 commit **之后**，而 `key={locale}` 的重挂发生在 commit **之时**——
   * 于是「换语言」的那一次渲染，子树读到的仍是**旧**的全局，重挂出来的整棵树是旧语言。
   * 之后谁自己重渲谁才翻得过来：`Sidebar` 订阅了 `useTasks`，任务列表一到它就对了；
   * **而没有任何东西触发它重渲的那些子树，就一直卡在旧语言上。**
   *
   * 这不是推理出来的隐患，是 0.3.6 实测到的：装出来把「界面语言」选成英文，
   * 侧栏 / 标题栏 / 页脚是英文，**工作台整页仍是中文**，而且稳定复现不退。
   * 文件头那句「把 key 放在这里之后『切了英文还有一半是中文』结构上不可能」——
   * 是**假的**，漏的那一半根本不需要渲染到 key 之外，它只需要「不再重渲一次」。
   *
   * `setLocale` 只是一句 `current = next`（见 `@shared/i18n`），幂等且零成本，
   * 渲染期调用没有问题——StrictMode 的二次渲染同样安全。
   */
  setLocale(locale)

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

  /**
   * 同步两个「界面之外」的标签。
   *
   * ⚠️ `setLocale` **已经提到上面渲染期**了（理由见那段注释）：它读的是 `@shared/i18n`
   * 那份全局，而 `describeOptions` / `describeTrim` 这些 shared 里的纯函数在主进程与
   * 渲染层**共用同一份实现**，读的也是那份全局——少了它，界面上的参数摘要会一直是中文，
   * 而它是用户核对「这条任务按什么参数跑的」的唯一依据。
   *
   * 留在这里的是**碰 DOM** 的两件事，它们只能在 commit 之后做。
   */
  useEffect(() => {
    document.documentElement.lang = htmlLangOf(locale)
    document.title = t('app.title')
  }, [locale])

  return (
    // ⚠️ `key={locale}` 是整条 i18n 的**重挂开关**，全仓只此一处。见文件头那段说明。
    <div key={locale} className="flex h-screen flex-col overflow-hidden bg-canvas text-fg">
      {/* 素材 sprite 全文档只挂一次：logo.svg 里的 <linearGradient id="gGold"> 只能有一份 */}
      <Sprite />

      {/*
        ⚠️ **设置到手之前只渲染空壳。**
        少了这道门控，首帧会用「没设过语言」算出一种语言、设置到手之后立刻翻成另一种，
        用户看到的是界面闪一下——而 `settings.language` 恰恰是唯一一个「值不同则整棵树
        都不同」的设置项。窗口底色由 `window.ts` 的 `backgroundColor` 顶着，所以空壳
        不是一片白。
      */}
      {settings !== null && (
        <>
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
        </>
      )}

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
