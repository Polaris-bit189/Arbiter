import { create } from 'zustand'
import type { IntegrationState } from '@shared/ipc-contract'

interface IntegrationStore {
  /** `null` = 还没拉到。挂载时调 `init()` 之后才会有值 */
  state: IntegrationState | null
  /** 正在写注册表。reg.exe 是一次真实的子进程往返，快但也不是零 */
  busy: boolean

  init: () => Promise<void>
  /** 右键菜单（写注册表） */
  setEnabled: (enabled: boolean) => Promise<void>
  /** 「发送到」快捷方式（只放一个 `.lnk`，不碰注册表） */
  setSendTo: (enabled: boolean) => Promise<void>
}

/**
 * 「系统集成」（M8）那一段的镜像。
 *
 * **不塞进 `useSettings`**：设置那一份是「用户选了什么」，这一份是「注册表里实际
 * 躺着什么」——两个值都要显示，而设置页上那个开关必须以**这一份**为准。
 * 绑 `settings.contextMenu` 的话，「注册表写失败、设置没跟着改」那种状态下开关会
 * 显示成已经打开了，而右键菜单根本不在，且没有任何地方能看出这件事。
 */
export const useIntegration = create<IntegrationStore>((set) => ({
  state: null,
  busy: false,

  async init() {
    set({ state: await window.api.getIntegration() })
  },

  async setEnabled(enabled) {
    await toggle(() => window.api.setIntegration({ enabled }))
  },

  async setSendTo(enabled) {
    await toggle(() => window.api.setIntegration({ sendTo: enabled }))
  }
}))

/**
 * 两个开关共用的往返。**busy 是承重的**：连点两次会发出两个 `reg.exe`（或两次
 * 文件写入），而它们动的是同一个键 / 同一个文件，最终状态取决于谁先返回——
 * 那种不确定性不该让用户碰上。
 *
 * 用主进程的返回值刷新，而不是本地改 `enabled`：系统那边可能写失败，
 * 那一刻主进程返回的是**没有变**的真实状态，而本地自己翻过去就再也翻不回来了。
 */
async function toggle(run: () => Promise<IntegrationState>): Promise<void> {
  useIntegration.setState({ busy: true })
  try {
    useIntegration.setState({ state: await run() })
  } finally {
    useIntegration.setState({ busy: false })
  }
}
