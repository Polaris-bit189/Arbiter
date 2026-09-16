import { app, ipcMain } from 'electron'
import { CH } from '@shared/ipc-contract'
import type { AppInfo } from '@shared/ipc-contract'
import { registerTaskIpc } from './tasks'
import { registerSettingsIpc } from './settings'
import { registerHistoryIpc } from './history'
import { registerEngineIpc } from './engines'
import { registerIntegrationIpc } from './integration'
import { registerRenameIpc } from './rename'
import { registerWindowIpc } from './window'

/**
 * 所有 IPC handler 的注册总闸。
 *
 * 这里的每一个 `registerXxxIpc()` 都对应 `ipc/` 下的一个文件，彼此不重叠——
 * 新增通道时只改自己那一个文件，不必回来动这个入口。
 *
 * **主题通道已经整块拆掉**：设计定的是固定深色（`nativeTheme.themeSource = 'dark'`
 * 在 `main/index.ts` 里写死），没有任何代码读它、也没有路径能写它。
 * 留着不只是死代码——`Settings.theme` 马上就要被写进磁盘，
 * `settings.json` 里出现一个 `"theme": "dark"` 会让人以为有主题功能。
 */
export function registerIpc(): void {
  ipcMain.handle(CH.appInfo, (): AppInfo => ({
    name: app.getName(),
    version: app.getVersion(),
    electron: process.versions.electron ?? '',
    chrome: process.versions.chrome ?? '',
    node: process.versions.node ?? ''
  }))

  registerTaskIpc()
  registerSettingsIpc()
  registerHistoryIpc()
  registerEngineIpc()
  registerIntegrationIpc()
  registerRenameIpc()
  registerWindowIpc()
}
