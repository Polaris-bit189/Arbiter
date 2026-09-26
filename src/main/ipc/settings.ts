import { BrowserWindow, dialog, ipcMain } from 'electron'
import { t } from '@shared/i18n'
import { CH, settingsPatchSchema } from '@shared/ipc-contract'
import { getSettings, getSettingsCorruption, updateSettings } from '../core/settings'
import { getTaskManager } from './tasks'
import { syncRenameWatch } from './rename'
import { applyLocale } from '../core/locale'
import { ensureContextMenu } from '../core/integration'
import { ensureSendTo } from '../core/sendTo'

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
      console.warn(t('ipc.log.settingsRejected'), parsed.error.issues)
      return getSettings()
    }

    const before = getSettings()
    const next = updateSettings(parsed.data)

    // ---- 语言 ----
    //
    // 改语言的连带效果有两处，**都是静默类**，所以必须在这里一次做完：
    //
    // 1. 把新语言推给 @shared/i18n 那份全局——主进程之后产出的对话框、通知、
    //    引擎状态文案才会跟着变。少了它，渲染层是英文而主进程仍是中文，
    //    同一个窗口里两半说不同的语言。
    // 2. 注册表右键菜单与「发送到」的快捷方式**不会自己跟着语言变**：
    //    那两样是 Windows 画出来的、存在磁盘上的死文本。切了英文而右键菜单还是中文，
    //    用户的第一反应是「切失败了」。两者本来就带自愈（实际 ≠ 期望就重写），
    //    所以这里只负责「语言变了就催一次」。
    if (next.language !== before.language) {
      applyLocale()
      if (next.contextMenu) void ensureContextMenu().catch(() => {})
      // `ensureSendTo()` 是同步的（它自己吞掉失败），`ensureContextMenu()` 是异步的——
      // 两者形状不同是既有的，别为了对称去改其中一边。
      if (next.sendTo) ensureSendTo()
    }

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
          title: t('ipc.dialog.pickOutputDirTitle'),
          properties: ['openDirectory', 'createDirectory']
        })
      : await dialog.showOpenDialog({
          title: t('ipc.dialog.pickOutputDirTitle'),
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
