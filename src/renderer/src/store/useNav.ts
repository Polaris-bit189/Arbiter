import { create } from 'zustand'

/** 四个静态页面。与 `pages/` 下的四个组件一一对应。 */
export type NavPage = 'work' | 'history' | 'settings' | 'about'

interface NavState {
  page: NavPage
  setPage: (page: NavPage) => void
}

/**
 * 当前页。
 *
 * **刻意不引路由库**：四个静态页面、没有 URL、没有深链，而 Electron 下跑的是
 * `file://`——真用起 history 路由，还得额外处理 base path。一个字段就够的事，
 * 不值得为它拉一份依赖进渲染层。
 *
 * 页面切换用条件渲染（工作台例外，见 `App.tsx`）：表单页卸载即清态，
 * 免得「在格式设置里改了一半、切走再切回来」看到一份陈旧值。
 */
export const useNav = create<NavState>((set) => ({
  page: 'work',
  setPage: (page) => set({ page })
}))
