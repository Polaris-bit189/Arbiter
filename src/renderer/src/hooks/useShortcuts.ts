import { useEffect } from 'react'
import { resolveShortcut, type ShortcutTarget } from '../lib/shortcuts'
import { useNav } from '../store/useNav'
import { useTasks } from '../store/useTasks'

/**
 * 全局快捷键的**绑定**那一半（E-7）。判据全在 `lib/shortcuts.ts` 里，这里只做三件事：
 * 把 `KeyboardEvent` 摊成那个纯函数的入参、读一眼当前队列、把动作派给调用方。
 *
 * ## 为什么挂在工作台而不是 `App.tsx`
 *
 * 工作台在 `App.tsx` 里是**用 `hidden` 保活的**（长列表的 `scrollTop` 不能丢），
 * 所以它切到别的页面也**始终处于挂载状态**——监听器不会掉。于是这个 hook
 * 可以安心地只属于工作台，而它要调的那三个动作（收入 / 开始 / 取消）
 * 本来就是工作台的按钮在调的那三个。
 *
 * 挂到 `App.tsx` 上反而更差：那里拿不到 `collect()` 那套「三种结果分三种说法」的回执，
 * 要么把它复制一份（两处措辞必然漂），要么搬进 store——而 store 的接口上明确写着
 * 「提示怎么说不该由 store 决定」。挂在真正干这件事的组件里，这三条就都绕开了。
 *
 * ## 为什么状态用 `getState()` 现读
 *
 * 监听器只建一次（依赖数组为空），事件来的时候才去读队列。写进依赖数组的话，
 * 进度每推送一次就拆掉重建一个 window 监听器——而队列在转换期间**每秒推十次**。
 *
 * 页面用选择器订阅：切到设置页时它变成 `false`，`resolveShortcut` 据此不接管按键
 * （见那边第 ② 条）。
 */
export function useShortcuts(handlers: {
  onPickFiles: () => void
  onStart: () => void
  onCancelRunning: () => void
}): void {
  // 依赖数组里只放**稳定引用**（三个回调都是 `useCallback` 包过的），
  // 免得每渲染一次就重建一次监听器
  const { onPickFiles, onStart, onCancelRunning } = handlers

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const { order, byId } = useTasks.getState()
      let queued = 0
      let running = 0
      for (const id of order) {
        const task = byId[id]
        if (!task) continue
        if (task.status === 'queued') queued += 1
        else if (task.status === 'running') running += 1
      }

      const action = resolveShortcut({
        key: event.key,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        altKey: event.altKey,
        shiftKey: event.shiftKey,
        composing: event.isComposing,
        target: targetOf(event.target),
        page: useNav.getState().page,
        queued,
        running
      })
      if (action === null) return

      // 认下来了才 preventDefault：不认的键要原样让给别人
      //（比如焦点在输入框里时的 Enter，浏览器还要拿它提交表单 / 换行）
      event.preventDefault()

      switch (action) {
        case 'pick-files':
          onPickFiles()
          break
        case 'start':
          onStart()
          break
        case 'cancel-running':
          onCancelRunning()
          break
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onPickFiles, onStart, onCancelRunning])
}

/**
 * 把事件目标摊成判据要的那两个字段。
 *
 * `event.target` 在 window 上收到 keydown 时**几乎总是**个元素，但类型上是 `EventTarget`，
 * 所以两条判据都写成「认得出才算」——认不出的（`document`、`window`、SVG 的某些节点）
 * 一律当成「不是输入框、不是按钮」，也就是**放行**。
 * 反过来写成「认不出就拦下」的话，一个预料之外的目标就能让所有快捷键静默失效。
 */
function targetOf(target: EventTarget | null): ShortcutTarget {
  if (!(target instanceof Element)) return { tagName: '', editable: false }
  return {
    tagName: target.tagName,
    // `closest` 而不是读 `isContentEditable`：后者在 Firefox 上对**父级**可编辑的
    // 子节点返回 false，而我们关心的是「这个位置能不能打字」
    editable: target.closest('[contenteditable]') !== null
  }
}
