import { create } from 'zustand'
import type { Task, TaskOptions } from '@shared/types'
import { DEFAULT_AFTER_CONVERT } from '@shared/types'
import type { AddResult, TaskPatch } from '@shared/ipc-contract'
import { presetTargetFor } from '../lib/presetTarget'
import { useAfterAction } from './useAfterAction'
import { useHistory } from './useHistory'
import { useSettings } from './useSettings'

/**
 * 任务在前端的镜像。
 *
 * 用 Record + 有序 id 数组而不是数组：进度更新是按 id 增量来的，
 * 数组每次都要遍历查找再整体重建，任务一多就会明显掉帧。
 *
 * 主进程是唯一真相源，这里只做应用和转发，不自己推导任何状态。
 */
interface TasksState {
  byId: Record<string, Task>
  order: string[]
  ready: boolean
  /** 最近一次添加被拒绝的文件，UI 展示后应调用 clearRejected */
  rejected: AddResult['rejected']
  /**
   * 目标格式是**照历史预置**的那些任务：id → 那个格式。
   *
   * 单独存一份而不是往 `Task` 上加字段：`Task` 是主进程镜像的形状，
   * 加一个只有界面才知道的字段会让「镜像 == 真相源」这条不变量多出一个例外。
   *
   * ⚠️ 取值必须是**原始值**（这里是字符串/undefined），选择器才能用 `Object.is` 比对。
   * 返回 `{ toExt, hint }` 这种新对象的话，每次进度推送都会让整行重渲染，
   * `TaskCard` 的 memo 也就白做了。
   */
  presets: Record<string, string>

  init: () => Promise<void>
  addPaths: (paths: string[]) => Promise<AddResult>
  /**
   * 弹系统文件选择框（多选）并直接入队。`null` = 用户取消。
   *
   * 返回值交给调用方去 toast：入队结果是一条「一句话就能说完」的事实，
   * 提示怎么说不该由 store 决定（工作台要 toast，将来别的页面可能只要个数字）。
   */
  pickFiles: () => Promise<AddResult | null>
  pickFolder: () => Promise<AddResult | null>
  setTarget: (id: string, toExt: string) => Promise<void>
  /** 设/清参数（裁剪）。回 `false` = 主进程没接受（静默不办那条路），面板要报出来 */
  setOptions: (id: string, options: TaskOptions | null) => Promise<boolean>
  start: (ids?: string[]) => Promise<void>
  cancel: (ids: string[]) => Promise<void>
  retry: (ids: string[]) => Promise<void>
  remove: (ids: string[]) => Promise<void>
  clearFinished: () => Promise<void>
  reveal: (ids: string[]) => Promise<void>
  clearRejected: () => void
}

/** patch 里的 null 表示「清空该字段」，而 Task 上对应的是 undefined */
function applyPatch(task: Task, patch: TaskPatch): Task {
  const next: Task = { ...task }
  if (patch.status !== undefined) next.status = patch.status
  if (patch.progress !== undefined) next.progress = patch.progress
  if (patch.error !== undefined) next.error = patch.error ?? undefined
  if (patch.logTail !== undefined) next.logTail = patch.logTail ?? undefined
  if (patch.outputPath !== undefined) next.outputPath = patch.outputPath ?? undefined
  if (patch.sizeBytes !== undefined) next.sizeBytes = patch.sizeBytes ?? undefined
  if (patch.startedAt !== undefined) next.startedAt = patch.startedAt ?? undefined
  if (patch.finishedAt !== undefined) next.finishedAt = patch.finishedAt ?? undefined
  return next
}

let unsubscribe: (() => void) | null = null
/** 收到不认识的任务 id 时说明本地快照过期了，防抖后重新拉一次全量 */
let resyncTimer: ReturnType<typeof setTimeout> | null = null

export const useTasks = create<TasksState>((set, get) => {
  /** 拉一次全量快照灌进镜像，返回这份快照 */
  const pullInto = async (): Promise<Task[]> => {
    const tasks = await window.api.listTasks()
    set({
      byId: Object.fromEntries(tasks.map((t) => [t.id, t])),
      order: tasks.map((t) => t.id)
    })
    return tasks
  }

  const resync = (): void => {
    if (resyncTimer) return
    resyncTimer = setTimeout(() => {
      resyncTimer = null
      void pullInto()
    }, 250)
  }

  /**
   * 入队之后统一收尾：刷新镜像，再把格式设置页里配的类别偏好补上。
   *
   * `before` 是这次操作**之前**的 id 快照，用它把「刚入队的那几条」挑出来。
   * 这一点是承重的：拿整份快照去比对，就会把用户手动改过目标格式的老任务
   * 一起按偏好改回去——而那条偏好只是个默认值，不该覆盖人的显式选择。
   *
   * `wasReady` 同样承重：`init()` 还没跑完时镜像是空的，「不在 before 里」
   * 说明不了任何事，那样会把主进程里所有任务都当成刚入队的。
   */
  const settle = async (before: Set<string>, wasReady: boolean): Promise<void> => {
    const tasks = await pullInto()
    if (!wasReady) return

    const fresh = tasks.filter((t) => !before.has(t.id))
    if (fresh.length === 0) return

    // 主进程的 `addPaths` 用的是内建的 `defaultTargetFor()`，它不知道用户在设置页
    // 改过什么，也不看历史，所以这一档只能在镜像这一侧补。`presetTargetFor` 会拿
    // `targetsFor(fromExt)` 再校验一遍——用户把「视频默认转 mkv」之后，拖进来的
    // 完全可能就是一个 `.mkv`，信任偏好会造出源与目标同格式的任务。
    //
    // 没配过偏好、也没有可用的历史时，它与主进程算出的值一致，于是这里一次 IPC
    // 都不会发——绝大多数入队走的就是这条零开销路径。
    const overrides = useSettings.getState().settings?.defaultTargets ?? {}

    // 「上次这类文件转成了什么」要拿**最新**的历史。平时这份镜像只在历史页挂载时
    // 刷新，而用户在这一次会话里刚转过一批同格式的文件，同样算一次「上次」。
    // 只在真的有新任务时才拉（见上面的 `fresh.length === 0` 返回）。
    await useHistory.getState().reload()
    const entries = useHistory.getState().entries

    let changed = false
    const presets: Record<string, string> = {}
    for (const task of fresh) {
      const choice = presetTargetFor(task, overrides, entries)
      if (choice === null) continue
      if (choice.fromHistory) presets[task.id] = choice.toExt
      if (choice.toExt === task.toExt) continue
      await window.api.setTaskTarget(task.id, choice.toExt)
      changed = true
    }
    if (Object.keys(presets).length > 0) set({ presets: { ...get().presets, ...presets } })

    // `TaskPatch` 里**没有 `toExt`**（那是入队后就定死、只有用户显式改才动的东西），
    // 所以主进程推回来的那条增量 patch 带不回新的目标格式，改过的必须再拉一次全量，
    // 否则界面上显示的还是旧目标，直到下一次别的什么动作触发重拉。
    if (changed) await pullInto()
  }

  /**
   * 两个 pick 通道的公共部分：取消不动任何状态，入队后走 settle。
   *
   * `rejected` 也要在这里落一次，不能只让 `addPaths` 落：拖入和按钮选文件是**同一个
   * `AddResult`**，被拒的文件是「哪个文件、为什么没收进来」的唯一来源。少这一次赋值，
   * 走按钮那条路上的拒绝清单会被整体丢掉——用户只看到一句「略过 N 个不认识的文件」，
   * 而拖同样一批文件时提示是逐条列出来的。上一轮拖入留下的旧清单也会一直挂在界面上，
   * 因为再没有别的地方会去动它。
   */
  const pickVia = async (run: () => Promise<AddResult | null>): Promise<AddResult | null> => {
    const before = new Set(get().order)
    const wasReady = get().ready
    const result = await run()
    if (!result) return null
    await settle(before, wasReady)
    set({ rejected: result.rejected })
    return result
  }

  /**
   * 「转换完成之后的动作」的自动触发。
   *
   * 两条判据都是刻意的，缺一个就会做出让人恼火的行为：
   *
   *  - **默认档一次 IPC 都不发**（`'none'` 直接 return）。这是「默认设置下不动剪贴板」
   *    那条断言的落点：自动路径上连一次调用都不该发生。
   *  - **只在队列里只有一个任务时触发**。一次转 50 个文件时「复制产物」没有意义——
   *    剪贴板只有一个格子，而且我们连用户要的是哪一个都不知道。批量场景下这件事
   *    只做成卡片上的按钮，由用户点。
   */
  const autoAfterAction = (doneIds: string[], total: number): void => {
    const action = useSettings.getState().settings?.afterConvert ?? DEFAULT_AFTER_CONVERT
    if (action === 'none') return
    if (total !== 1) return
    for (const id of doneIds) void useAfterAction.getState().run(id)
  }

  return {
    byId: {},
    order: [],
    ready: false,
    rejected: [],
    presets: {},

    async init() {
      // HMR 会重复执行 init，重复订阅会让每次进度更新应用两遍
      unsubscribe?.()
      unsubscribe = window.api.onTasksPatch((message) => {
        const state = get()
        const byId: Record<string, Task> = { ...state.byId }
        let order = state.order
        let unknown = false
        /** 这一批推送里刚落定的任务。自动动作只认它，不认「镜像里所有 done 的」 */
        const doneNow: string[] = []

        for (const patch of message.updated) {
          const existing = byId[patch.id]
          if (!existing) {
            unknown = true
            continue
          }
          byId[patch.id] = applyPatch(existing, patch)
          if (patch.status === 'done') doneNow.push(patch.id)
        }

        let presets = state.presets
        if (message.removed.length > 0) {
          const gone = new Set(message.removed)
          for (const id of gone) delete byId[id]
          order = order.filter((id) => !gone.has(id))
          // 预置表跟着队列一起收：任务一多，这个表不清就会一直涨
          if (Object.keys(presets).some((id) => gone.has(id))) {
            presets = Object.fromEntries(Object.entries(presets).filter(([id]) => !gone.has(id)))
          }
        }

        set({ byId, order, presets })
        if (unknown) resync()
        // `state.order.length` 是**这一批之前**的队列规模，正是我们要的那一个数：
        // 「这次转换一共涉及几个文件」
        autoAfterAction(doneNow, state.order.length)
      })

      await pullInto()
      set({ ready: true })
    },

    async addPaths(paths) {
      const before = new Set(get().order)
      const wasReady = get().ready

      // **分批送。** `addPathsSchema` 上有 `.max(500)`（一条 IPC 消息不该无界增长），
      // 而「一次拖 501 个文件」过不了它：整批被拒，返回的 `rejected` 只有一条，
      // 理由是「路径参数非法」，`String(raw)` 还会把 501 条路径拼成一整串塞进 `path`
      // 字段——界面按文件名取尾部，于是显示成「1 个文件未能收入队列 + 一个文件名」，
      // 而实际**一个都没进来**。分批之后每一批都走正常路径，被拒的也是逐条真实的理由
      // （比如第二批会撞上主进程的「任务数已达上限 500」）。
      const BATCH = 500
      const results: AddResult[] = []
      for (let i = 0; i < paths.length; i += BATCH) {
        results.push(await window.api.addPaths(paths.slice(i, i + BATCH)))
      }
      const result: AddResult = {
        added: results.reduce((n, r) => n + r.added, 0),
        rejected: results.flatMap((r) => r.rejected)
      }

      // 主进程新增任务时会广播 patch，但那条 patch 只有 id 和状态，
      // 不含文件名等信息，所以这里主动重新拉一次全量。
      await settle(before, wasReady)
      set({ rejected: result.rejected })
      return result
    },

    pickFiles() {
      return pickVia(() => window.api.pickFiles())
    },

    pickFolder() {
      return pickVia(() => window.api.pickFolder())
    },

    /**
     * 改完目标格式**必须再拉一次全量**。
     *
     * `TaskPatch` 里没有 `toExt`（那是入队后就定死、只有用户显式改才动的东西，见
     * `settle` 里那段注释），主进程推回来的增量 patch 带不回新值；而
     * `TargetFormatSelect` 是**受控**的，`value` 直接来自这份镜像——镜像不更新，
     * 下一次重渲染（哪怕只是一条进度推送）就会把下拉**弹回旧格式**，
     * 用户以为没改成，转完却在磁盘上得到新格式的产物。
     * `settle()` 那条路早就补了这道拉取，逐行/批量改走的这条路漏了。
     */
    async setTarget(id, toExt) {
      await window.api.setTaskTarget(id, toExt)
      await pullInto()
    },

    /**
     * 设/清一条任务的参数。**与 `setTarget` 逐字同构，包括那次 `pullInto()`。**
     *
     * 参数和 `toExt` 一样不在 `TaskPatch` 里（见 `settle` 里那段注释）：主进程推回来的
     * 增量 patch 带不回新参数，而卡片上「裁 3.0s–8.0s」那一行直接读镜像——
     * 不重拉的话，下一次重渲染（哪怕只是一条进度推送）就会把它**抹掉**，
     * 用户以为没设上，产物却是按新参数出来的。
     *
     * 返回值一路透传主进程那个布尔：`setOptions` 对不合法/不适用的参数是
     * **静默不办**的，面板要用它来给出回执。
     */
    async setOptions(id, options) {
      const ok = await window.api.setTaskOptions(id, options)
      await pullInto()
      return ok
    },

    async start(ids) {
      await window.api.startTasks(ids)
    },

    async cancel(ids) {
      await window.api.cancelTasks(ids)
    },

    async retry(ids) {
      await window.api.retryTasks(ids)
    },

    async remove(ids) {
      await window.api.removeTasks(ids)
    },

    async clearFinished() {
      await window.api.clearFinishedTasks()
    },

    async reveal(ids) {
      await window.api.revealTask(ids)
    },

    clearRejected() {
      set({ rejected: [] })
    }
  }
})
