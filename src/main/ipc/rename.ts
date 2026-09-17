import { BrowserWindow, Notification, dialog, ipcMain } from 'electron'
import { CH } from '@shared/ipc-contract'
import { getSettings, updateSettings } from '../core/settings'
import { RenameWatcher } from '../core/renameWatcher'
import { enqueueExternalRequest } from './tasks'

/**
 * 「重命名即转换」的**electron 侧接线**。
 *
 * 判断在 `core/renameWatch.ts`（纯逻辑），副作用顺序在 `core/renameWatcher.ts`
 * （只碰 `fs`），需要窗口/通知/队列的那三件事在这里注入——于是那两个模块
 * 都能在普通 Node 里测，而这里剩下的东西少到没有分支可藏。
 *
 * ## 三条与「谨慎形态」直接对应的实现选择
 *
 * 1. **默认什么都不装。** `syncRenameWatch()` 只在「开关打开**且**目录非空」时
 *    才建监听器，其余情况一律 `stop()`。这是 §M8 那条唯一验收判据
 *    「默认关闭状态下零副作用」的落地形式——关着的时候这个模块对磁盘完全无感。
 * 2. **成功要有一句系统通知。** 用户没在看窗口，静默地让一个文件凭空多出个兄弟、
 *    或者让文件名自己变了一下，是这个功能唯一不可接受的表现。
 * 3. **失败不弹模态框。** 用户只是改了个文件名，不该被一个对话框拦住；
 *    出口是通知 + 终端。
 */

let watcher: RenameWatcher | null = null

function notify(title: string, body: string): void {
  try {
    // `isSupported()` 在个别 Windows 环境上是 false（通知被策略关掉）。
    // 那种情况下 `.show()` 不抛异常、也不显示——所以**先问一句**，别静默丢消息。
    if (!Notification.isSupported()) {
      console.warn(`[rename] 系统通知不可用，消息只留在终端：${title} — ${body}`)
      return
    }
    new Notification({ title, body }).show()
  } catch (err) {
    console.warn('[rename] 弹系统通知失败：', err)
  }
}

function warn(message: string): void {
  // 刻意不弹框：用户只是改了个文件名，一个模态框会把它变成一件「出事了」的事。
  console.warn(`[rename] ${message}`)
  notify('调律者转换器', message)
}

/**
 * 按当前设置（重）装监听器。**幂等**：目录没变时 `setDirs` 直接返回，
 * 所以可以在任何一次设置写入之后无脑调它。
 */
export async function syncRenameWatch(): Promise<void> {
  const settings = getSettings()
  const dirs = settings.renameConvert ? settings.renameConvertDirs : []

  if (dirs.length === 0) {
    watcher?.stop()
    return
  }

  if (watcher === null) {
    watcher = new RenameWatcher({
      enqueue: async (sourcePath, toExt) => {
        // 一次只来一个文件（改名是逐个发生的），但入口收的是路径数组——
        // 「发送到」那条路要多文件，两条路共用同一个入口（见 `enqueueExternalRequest`）
        const result = await enqueueExternalRequest({ paths: [sourcePath], to: toExt })
        if (result.added > 0) return { ok: true }
        // 被队列拒绝（文件读不了、格式其实不支持……）。**只把原因带出去**：
        // 「文件名已经还给你了」那句由 watcher 连同回滚一起说——回滚是它做的，
        // 这里再说一遍就是同一件事说两次，而且说不出后半句。
        return {
          ok: false,
          reason: result.rejected.map((r) => r.reason).join('；') || '原因不明'
        }
      },
      notify,
      warn
    })
  }

  await watcher.setDirs(dirs)
}

/** 退出路径上用，避免监听器把进程钉住 */
export function stopRenameWatch(): void {
  watcher?.stop()
  watcher = null
}

export function registerRenameIpc(): void {
  ipcMain.handle(CH.settingsPickRenameDir, async (event) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    const result = window
      ? await dialog.showOpenDialog(window, {
          title: '选择要监听的文件夹',
          properties: ['openDirectory', 'createDirectory']
        })
      : await dialog.showOpenDialog({
          title: '选择要监听的文件夹',
          properties: ['openDirectory', 'createDirectory']
        })

    if (result.canceled || result.filePaths.length === 0) return getSettings().renameConvertDirs

    const chosen = result.filePaths[0] as string
    const current = getSettings().renameConvertDirs
    // 重复挑同一个目录不该产生两条（`setDirs` 会去重，但设置里出现两条会让界面上
    // 出现两个一模一样的条目，用户只能靠猜哪条是多余的）。
    const dirs = current.includes(chosen) ? current : [...current, chosen]
    updateSettings({ renameConvertDirs: dirs })
    await syncRenameWatch()
    return dirs
  })

  ipcMain.handle(CH.settingsRemoveRenameDir, async (_event, raw) => {
    const target = typeof raw === 'string' ? raw : null
    if (target === null) {
      // 与 settings:set 同一个口径：被拒比被静默忽略好，但痕迹要留在终端上。
      console.warn('[rename] 拒绝了一份不合规的移除请求：', raw)
      return getSettings().renameConvertDirs
    }
    const dirs = getSettings().renameConvertDirs.filter((dir) => dir !== target)
    updateSettings({ renameConvertDirs: dirs })
    await syncRenameWatch()
    return dirs
  })
}
