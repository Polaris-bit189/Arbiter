import { resolve } from 'path'

/**
 * `electron` 模块的测试替身。
 *
 * 主进程的核心逻辑（队列、任务状态机、输出名占位）全都是纯 Node 代码，
 * 只有 `app.getPath` / `app.isPackaged` 这类边角需要 Electron 运行时。
 * 把 electron 映射到这份桩上，就能用 tsx 直接跑真实的 ffmpeg 全流程，
 * 不必启动窗口、也不必手工拖文件——见 scripts/test-tasks.ts。
 *
 * 只在 tsconfig.test.json 里通过 paths 生效，不会影响真正的构建。
 */

const TMP_ROOT = resolve('.tmp-test-stub')

export const app = {
  isPackaged: false,
  getPath(name: string): string {
    // 固定到项目内的临时目录，测试之间不会互相污染，也不会写进用户真实的 AppData
    //
    // 落盘之后这一条是承重的：`core/settings.ts` 的默认 engineDir 与
    // `core/history.ts` 的历史文件路径都从它算出来。桩里返回 undefined 的话，
    // `join(undefined, 'engines')` 会当场抛异常，而报错点在模块加载期——
    // 表现是「整个 test:tasks 套件一条都不跑」，很容易误判成套件本身坏了。
    return resolve(TMP_ROOT, name)
  },
  getAppPath: (): string => resolve('.'),
  // 关于页要用；虽然 registerIpc() 不在测试路径上，但少一个方法就会在
  // 某个将来 import 了 ipc/index.ts 的测试里变成 `app.getName is not a function`。
  getName: (): string => 'arbiter',
  getVersion: (): string => '0.0.0-test',
  whenReady: async (): Promise<void> => {},
  on: (): void => {},
  quit: (): void => {}
}

export const ipcMain = {
  handle: (): void => {},
  on: (): void => {},
  removeHandler: (): void => {}
}

export const nativeTheme = {
  themeSource: 'system' as string,
  shouldUseDarkColors: false,
  on: (): void => {}
}

export class BrowserWindow {
  static getAllWindows(): BrowserWindow[] {
    return []
  }
  static fromWebContents(): null {
    return null
  }
  isDestroyed(): boolean {
    return true
  }
  webContents = { isDestroyed: (): boolean => true, send: (): void => {} }
}

export const shell = {
  showItemInFolder: (): void => {},
  openExternal: async (): Promise<void> => {}
}

export const dialog = {
  showOpenDialog: async (): Promise<{ canceled: boolean; filePaths: string[] }> => ({
    canceled: true,
    filePaths: []
  })
}

export const webUtils = {
  getPathForFile: (): string => ''
}

/**
 * 「重命名即转换」用它发系统通知（`ipc/rename.ts`）。
 *
 * 桩里 `isSupported()` 返回 **false**，走的是那条「通知不可用、消息只留在终端」的
 * 降级路径——真实的系统通知在测试里既弹不出来、也没法断言，而这条降级路径
 * 恰好是唯一能在无头环境里跑到的分支。
 */
export class Notification {
  static isSupported(): boolean {
    return false
  }
  constructor(readonly options: { title: string; body: string }) {}
  // 写成属性箭头函数而不是方法：`no-empty-function` 在这个仓库里放行箭头函数、
  // 拦类方法（文件里其余的桩都是这个形状）。
  show = (): void => undefined
}

export default { app, ipcMain, nativeTheme, BrowserWindow, shell, dialog, webUtils, Notification }
