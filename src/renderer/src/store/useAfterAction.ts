import { create } from 'zustand'
import type { AfterActionResult } from '@shared/ipc-contract'

/**
 * 「转换完成之后的动作」的回执。
 *
 * 为什么要留一份回执、而不是弹个两秒的 toast 就完事：**剪贴板随时会被别的程序抢走**。
 * 用户点完「复制路径」去微信里粘贴，粘出来的是别的东西——那一刻他需要的是
 * 「我刚才复制的是什么」以及**「再复制一次」**。toast 两秒就没了，这两个问题都答不了。
 *
 * 所以这份回执**不会自动消失**，由用户自己收起（或者下一次动作把它顶掉）。
 */
interface AfterActionState {
  /** `null` = 没有待看的回执 */
  result: AfterActionResult | null
  /** 上一次动作是哪个任务——「再复制一次」要拿它再来一遍 */
  lastId: string | null
  /** 正在往返。防连点：连点两次会往剪贴板里写两次，而中间那一次的结果会被顶掉 */
  busy: boolean

  run: (id: string) => Promise<void>
  dismiss: () => void
}

export const useAfterAction = create<AfterActionState>((set, get) => ({
  result: null,
  lastId: null,
  busy: false,

  async run(id) {
    if (get().busy) return
    set({ busy: true })
    try {
      // 成败都留回执：失败的那一条同样要说话（「产物已不在原处」比什么都不弹好得多）
      set({ result: await window.api.runAfterAction(id), lastId: id })
    } finally {
      set({ busy: false })
    }
  },

  dismiss() {
    set({ result: null, lastId: null })
  }
}))
