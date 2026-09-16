import { create } from 'zustand'
import type { EngineKey, EngineProgress, EngineStatus } from '@shared/types'

/**
 * 引擎状态在前端的镜像（关于页用）。
 *
 * **两条路径的代价差三个数量级，所以状态也分成两份**：
 *   `loading`  首次拉取（主进程只做 existsSync），整页范围的忙碌
 *   `probing`  版本探测（真起子进程，LibreOffice 3～5 秒），**只让那一个按钮转圈**
 *
 * 探测期间绝不能把 `loading` 也置上：整页变成加载态、七行一起转圈，用户会以为
 * 应用卡死了——而实际上只有一行在等一个进程。
 */
interface EnginesState {
  statuses: EngineStatus[]
  /** 首次拉取进行中（廉价路径） */
  loading: boolean
  /**
   * 正在探测版本的那个引擎；`'all'` 对应不传 key 的「全部探测」。
   * `null` 表示没有探测在跑。
   *
   * 存 key 而不是 boolean，是为了让 UI 只给**那一行**转圈——boolean 做不到区分
   * 「我在探 7-Zip」和「我在探 LibreOffice」，只能七行一起转。
   */
  probing: EngineKey | 'all' | null
  /**
   * 正在下载/解包的那个引擎。
   *
   * 与 `probing` 分成两个字段而不是共用一个：**两者可以同时发生**——用户一边等
   * LibreOffice 下载，一边点「探测版本」看 ffmpeg。共用一个字段的话，第二个动作
   * 会把第一个的转圈状态顶掉，UI 上表现为「下载到一半进度条没了」。
   */
  installing: EngineKey | null
  /** 下载/解包进度。`null` 表示没有在装 */
  installProgress: EngineProgress | null

  init: () => Promise<void>
  probe: (key?: EngineKey) => Promise<void>
  /** 按需下载并解包一个引擎。失败时**抛**，由调用方决定怎么说给用户听 */
  install: (key: EngineKey) => Promise<void>
  /** 进度推送的入口（`App.tsx` 挂载时接上） */
  setInstallProgress: (progress: EngineProgress | null) => void
}

export const useEngines = create<EnginesState>((set, get) => ({
  statuses: [],
  loading: false,
  probing: null,
  installing: null,
  installProgress: null,

  async init() {
    set({ loading: true })
    try {
      set({ statuses: await window.api.getEngineStatus() })
    } finally {
      // 用 finally 而不是在 then 里收尾：IPC 断了的时候 reject 会让 loading 永远为真，
      // 页面就永远停在加载态上，比没有这个状态还糟。
      set({ loading: false })
    }
  },

  async probe(key) {
    // 已有的探测还没结束就直接返回。主进程侧也有一道同样的闸（见 ipc/engines.ts），
    // 但两边都要有：这里能省掉一次没意义的 IPC 往返与一次按钮状态抖动。
    if (get().probing !== null) return

    set({ probing: key ?? 'all' })
    try {
      set({ statuses: await window.api.probeEngines(key) })
    } catch {
      // 探测失败**不改动既有列表**：单条引擎的失败在主进程那侧已经写进了它自己的
      // `error` 字段，能走到这里的只可能是 IPC 本身断了（比如主进程正在退出），
      // 那种情况下把列表清空只会让页面闪一下空态，反而不如保持原样。
    } finally {
      set({ probing: null })
    }
  },

  async install(key) {
    if (get().installing !== null) return

    set({ installing: key, installProgress: null })
    try {
      // 状态不由这里拼：主进程返回的就是**装完之后**那一份，直接整份替换。
      // 自己拼一份的话，「引擎目录设置指向别处」这类分歧会让页面显示一个
      // 与磁盘不符的「已就绪」。
      set({ statuses: await window.api.installEngine(key) })
    } finally {
      // 失败也收尾：`installing` 卡住的话，那一行的按钮会永远停在「下载中…」，
      // 而主进程那边其实早就返回了。**异常照常往外抛**，页面据此弹一句通知。
      set({ installing: null, installProgress: null })
    }
  },

  setInstallProgress(progress) {
    set({ installProgress: progress })
  }
}))
