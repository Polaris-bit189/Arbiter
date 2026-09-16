import { create } from 'zustand'
import type { RerunResult } from '@shared/ipc-contract'
import type { HistoryEntry } from '@shared/types'

/** 与 preload 里 `revealHistory()` 的返回一致 */
export type RevealResult = 'ok' | 'missing'

/**
 * 历史记录的只读镜像。
 *
 * 与 `useTasks` 不同，这里**没有订阅**：历史只会在任务走到终态时被主进程追加，
 * 而那一刻用户多半正在工作台上，看不到历史页。与其为「后台可能变了」维护一条
 * 推送通道，不如在页面挂载时拉一次全量——最多 500 条，一次 IPC 就够。
 *
 * 也**不做本地推导**：删一条就让主进程删，返回 true 再改镜像，绝不先斩后奏。
 */
interface HistoryState {
  entries: HistoryEntry[]
  /**
   * 是否已经从主进程拉过一次。
   *
   * `init()` 用它做幂等：页面是条件渲染的，来回切换会反复重挂，
   * 每次都全量拉一遍会让切换有肉眼可见的停顿。
   */
  ready: boolean

  init: () => Promise<void>
  reload: () => Promise<void>
  clear: () => Promise<number>
  remove: (id: string) => Promise<boolean>
  reveal: (id: string) => Promise<RevealResult>
  /**
   * 重跑一批（单条就是长度为 1 的那一批）。
   *
   * ⚠️ `conflict` 不传时，目标位置已有同名产物的话**一条都不会入队**：
   * 主进程回一份 `conflicts` 清单，界面必须先问用户一次。
   * 这是全项目唯一会覆盖用户已有产物的入口，见 `core/rerun.ts`。
   */
  rerun: (ids: string[], conflict?: 'rename' | 'overwrite') => Promise<RerunResult>
}

export const useHistory = create<HistoryState>((set, get) => ({
  entries: [],
  ready: false,

  async init() {
    if (get().ready) return
    await get().reload()
  },

  async reload() {
    const entries = await window.api.listHistory()
    set({ entries, ready: true })
  },

  /** 返回删了几条，调用方拿它去说「已抹去 N 条痕迹」 */
  async clear() {
    const removed = await window.api.clearHistory()
    set({ entries: [], ready: true })
    return removed
  },

  async remove(id) {
    const removed = await window.api.removeHistory(id)
    if (removed) set({ entries: get().entries.filter((entry) => entry.id !== id) })
    return removed
  },

  async reveal(id) {
    // 「产物找不到了」和「转换没发生过」是两回事，所以这里**不删条目**——
    // 主进程那边也刻意不因为 outputPath 消失而剪枝。只把结果交给调用方去提示。
    return window.api.revealHistory(id)
  },

  async rerun(ids, conflict) {
    // **不吞返回值**：调用方要拿 added 去说「已收入 N 个」，拿 rejected 逐条说
    // 「源文件已不在原处」，拿 conflicts 去弹那次覆盖/另存的选择。
    // 也不在这里刷新任务列表——新任务入队时主进程会广播 patch，
    // `useTasks` 收到不认识的 id 会自己重拉全量（见那里的 `resync`）。
    return window.api.rerunHistory(ids, conflict)
  }
}))
