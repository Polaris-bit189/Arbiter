import { create } from 'zustand'
import type { Category, Settings, SettingsCorruption } from '@shared/types'

interface SettingsState {
  /** `null` = 还没拉到。`App.tsx` 挂载时调 `init()` 之后才会有值 */
  settings: Settings | null

  /**
   * 上次读盘时那份设置文件是不是**坏的**（坏了的话原文件已被改名留档）。`null` = 没坏过。
   *
   * 为什么要有这一项：`jsonStore` 读盘失败时会把原文件改名成
   * `settings.json.corrupt-<时间戳>` 再退回默认值——**数据没被覆盖，但用户不知道**。
   * 主进程那边只能 `console.error`，而打包后的 GUI 里那是**没有出口**的。
   * 审计 §3.10 的原话是「并让它**在界面上可见**」，这一项就是那句话的落点。
   */
  corruption: SettingsCorruption | null

  init: () => Promise<void>

  /** 通用 patch。**浅合并**，语义与主进程的 `updateSettings` 一一对应 */
  update: (patch: Partial<Settings>) => Promise<void>

  /**
   * 改某个类别的默认目标格式；`ext` 传 `null` 表示撤掉这个偏好。
   *
   * 存在的理由是把「展开旧值」这一步收进唯一一处。`updateSettings` 是浅合并，
   * 直接送 `{ defaultTargets: { video: 'mkv' } }` 会把其余五个类别一起抹掉，
   * **而且不报任何错**——用户改一个类别、另外五个悄悄回到内建偏好，
   * 从界面上完全看不出来。收在这里，页面就没有机会写错。
   */
  setCategoryTarget: (category: Category, ext: string | null) => Promise<void>

  pickOutputDir: () => Promise<string | null>

  /**
   * 往监听白名单里加一个目录。**弹框、写设置、重装监听器都在主进程里一次做完**
   *（见 `main/ipc/rename.ts`），这里只负责把新的整份列表拉回来。
   *
   * 不走 `update({ renameConvertDirs })`：那样渲染层得自己展开旧列表，
   * 而它与 `setCategoryTarget` 是同一个坑——浅合并下漏掉旧值就会把用户配好的
   * 其余目录**静默清空**。
   */
  pickRenameDir: () => Promise<void>

  /** 把某个目录移出监听白名单。**只是从名单里去掉**，不碰目录本身 */
  removeRenameDir: (dir: string) => Promise<void>
}

export const useSettings = create<SettingsState>((set, get) => ({
  settings: null,
  corruption: null,

  async init() {
    // 两份一起拉：损坏告警与设置本身是同一次读盘的产物，分两次拉会让界面
    // 有一个「设置已经刷新、告警还没到」的中间态。
    const [settings, corruption] = await Promise.all([
      window.api.getSettings(),
      window.api.getSettingsCorruption()
    ])
    set({ settings, corruption })
  },

  async update(patch) {
    // 用主进程的返回值刷新，而不是本地自己合并：主进程是唯一真相源，
    // 它那边的浅合并 / 校验结果才是生效值（写盘也是它的事）。
    set({ settings: await window.api.setSettings(patch) })
  },

  async setCategoryTarget(category, ext) {
    // ⚠️ 展开旧值这一步是承重的，见上面的类型注释。
    // 撤掉偏好用 `delete` 而不是塞一个空串：`extSchema` 不接受空扩展名，
    // 而这里要表达的本来就是「这个键不存在」。
    const overrides = { ...(get().settings?.defaultTargets ?? {}) }
    if (ext === null) delete overrides[category]
    else overrides[category] = ext

    set({ settings: await window.api.setSettings({ defaultTargets: overrides }) })
  },

  async pickOutputDir() {
    const chosen = await window.api.pickOutputDir()
    if (chosen) {
      // 主进程在弹框那一步已经把 outputDir 与 outputBesideSource 一起改好了
      //（见 `main/ipc/settings.ts`），所以这里只需要重新拉一次全量设置。
      set({ settings: await window.api.getSettings() })
    }
    return chosen
  },

  async pickRenameDir() {
    await window.api.pickRenameDir()
    set({ settings: await window.api.getSettings() })
  },

  async removeRenameDir(dir) {
    await window.api.removeRenameDir(dir)
    set({ settings: await window.api.getSettings() })
  }
}))
