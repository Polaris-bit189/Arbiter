import { create } from 'zustand'

/**
 * 一闪而过的提示。
 *
 * 刻意不引第三方 toast 库：要的全部功能就是「存一句话、两秒后清掉」，
 * 引库会把一个渲染在 body 上的组件树、自己的 portal 与样式表一起带进来，
 * 而本项目的界面是固定深色 + 一套自己的 token，那些默认样式全都要覆盖掉。
 *
 * 计时器放在 store 而不是组件里：toast 的宿主组件将来可能被条件渲染
 * （工作台用 `hidden` 保活、别的页面可能压根不挂载），计时一旦跟着组件卸载，
 * 就会出现「切页时弹的 toast 永远不消失」。store 是模块级的，与挂载无关。
 */
const VISIBLE_MS = 2000

interface ToastState {
  message: string | null
  /** 自增序号：同一条文案连着弹两次时，`message` 没变而 effect 要重跑，靠它区分 */
  seq: number
  show: (message: string) => void
  hide: () => void
}

let timer: ReturnType<typeof setTimeout> | null = null

export const useToast = create<ToastState>((set) => ({
  message: null,
  seq: 0,

  show(message) {
    // 后一条顶掉前一条并重新计时：不 clear 的话，第一条的计时器会把
    // 刚弹出来的第二条提前掐掉。
    if (timer) clearTimeout(timer)
    set((state) => ({ message, seq: state.seq + 1 }))
    timer = setTimeout(() => {
      timer = null
      set({ message: null })
    }, VISIBLE_MS)
  },

  hide() {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    set({ message: null })
  }
}))
