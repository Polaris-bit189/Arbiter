import { BrowserWindow, dialog, ipcMain } from 'electron'
import { CH, settingsPatchSchema } from '@shared/ipc-contract'
import { getSettings, getSettingsCorruption, updateSettings } from '../core/settings'
import { getTaskManager } from './tasks'
import { syncRenameWatch } from './rename'

export function registerSettingsIpc(): void {
  ipcMain.handle(CH.settingsGet, () => getSettings())

  // 没坏过就回 null（而不是一个空对象）：渲染层要判的是「这一行要不要渲染」，
  // 与 `describeOptions` 那条同一个理由——空对象会渲染出一块 0 高度的空白。
  ipcMain.handle(CH.settingsCorruption, () => getSettingsCorruption())

  ipcMain.handle(CH.settingsSet, (_event, raw) => {
    const parsed = settingsPatchSchema.safeParse(raw)
    if (!parsed.success) {
      // schema 的注释说「被拒比被静默忽略好——被拒至少能查」，那就得真的留下痕迹：
      // 只返回当前设置的话，渲染层看到的仅仅是「改了没生效」，从两端都查不出原因。
      // 最典型的一例是旧渲染层还在发已经删掉的 `theme`，`.strict()` 会连它一起拒掉。
      console.warn('[settings] 拒绝了一份不合规的 patch：', parsed.error.issues)
      return getSettings()
    }

    const before = getSettings()
    const next = updateSettings(parsed.data)

    // 并发数调大之后，原本在排队的任务应该立刻有机会开跑
    if (next.maxConcurrent !== before.maxConcurrent) {
      getTaskManager().repump()
    }

    // 「重命名即转换」的监听器跟着设置走：开关关掉、或目录白名单被清空时，
    // 必须**当场**把监听器拆掉。留到下次启动才生效的话，用户关掉开关之后
    // 我们还在动他的文件——那是这条功能最不能出的事。
    // `syncRenameWatch()` 是幂等的，所以这里不判「哪一项变了」。
    void syncRenameWatch()

    return next
  })

  ipcMain.handle(CH.settingsPickOutputDir, async (event) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    const result = window
      ? await dialog.showOpenDialog(window, {
          title: '选择输出目录',
          properties: ['openDirectory', 'createDirectory']
        })
      : await dialog.showOpenDialog({
          title: '选择输出目录',
          properties: ['openDirectory', 'createDirectory']
        })

    if (result.canceled || result.filePaths.length === 0) return null
    const chosen = result.filePaths[0]
    // 两个字段一次写完，**不能只写 outputDir**：`outputDirFor()` 要求
    // 「有目录」且「不跟随源文件」两条同时成立才会用这个目录，只写一条的话
    // 用户选完目录界面毫无变化（设置页的「指定目录」也是这样切过去的）。
    // 放在主进程做完还有个好处：`settings:pickOutputDir` 的调用方不必再补一次
    // `setSettings`，中间不会出现「目录已改、模式未改」的半截状态。
    updateSettings({ outputDir: chosen, outputBesideSource: false })
    return chosen
  })
}
