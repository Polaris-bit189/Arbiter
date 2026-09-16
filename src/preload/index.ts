import { contextBridge, ipcRenderer, webUtils } from 'electron'
// 只从 channels 取常量：它零依赖，不会把 zod 拖进 sandbox preload 的依赖图。
// 下面那些 @shared/types / @shared/ipc-contract 的导入全是 `import type`，编译后会被完全擦除。
import { CH } from '@shared/channels'
import type {
  AddResult,
  AfterActionResult,
  AppInfo,
  IntegrationState,
  RerunResult,
  TasksPatchMessage
} from '@shared/ipc-contract'
import type {
  EngineProgress,
  EngineStatus,
  HistoryEntry,
  Settings,
  Task,
  SettingsCorruption,
  TaskOptions
} from '@shared/types'

/**
 * 暴露给渲染进程的最小 API。
 *
 * 渲染进程拿不到任何 Node 能力，也不能拼命令行——所有实际操作都由主进程
 * 通过 IPC 完成，且主进程侧一律用 spawn(exe, args[]) 而非 shell 字符串。
 */
/**
 * 启动时探测一次 webUtils 是否可用。
 *
 * webUtils 是 renderer-only 模块，官方文档未明确保证它在 sandbox:true 的 preload
 * 中一定存在。拖拽取路径是核心功能，一旦不可用会表现为「拖进去毫无反应」这种
 * 极难排查的静默失败，所以这里显式探测并把结果交给 UI 去提示。
 */
const canResolveDropPaths = typeof webUtils?.getPathForFile === 'function'

/** `history:reveal` 的结果。产物还在原处 / 原处已空 */
export type RevealResult = 'ok' | 'missing'

const api = {
  platform: process.platform,

  capabilities: {
    dropPaths: canResolveDropPaths
  },

  /**
   * 把拖拽进来的 File 对象换回磁盘绝对路径。
   *
   * Electron 32 起 File.path 已被移除，官方替代方案就是 webUtils.getPathForFile。
   * 它只在 preload 里可用（renderer-only 模块），页面代码拿不到。
   *
   * 返回空字符串说明这个 File 是 JS 构造的、不对应磁盘文件，主进程应当拒绝。
   */
  pathForFile(file: File): string {
    try {
      return webUtils.getPathForFile(file)
    } catch {
      return ''
    }
  },

  /* ---------------------------------------------------------------- 任务 */

  listTasks(): Promise<Task[]> {
    return ipcRenderer.invoke(CH.tasksList)
  },

  addPaths(paths: string[]): Promise<AddResult> {
    return ipcRenderer.invoke(CH.tasksAdd, paths)
  },

  /**
   * 弹系统文件选择框（多选），选中的文件**直接入队**，返回入队结果。
   *
   * 不是「返回路径、再由渲染层调 addPaths」——两步会多一次 IPC 往返，
   * 且中间那一瞬渲染层手里的路径列表与队列真实状态不一致。
   * 取消选择返回 `null`（与「选了但全被拒」区分开，两者提示文案不同）。
   */
  pickFiles(): Promise<AddResult | null> {
    return ipcRenderer.invoke(CH.tasksPickFiles)
  },

  /**
   * 弹系统文件夹选择框，把扫到的文件入队（**递归**，E-4）。
   *
   * 展开在主进程做（只有它能 readdir），而且是**分批 + 可取消 + 有条数上限**的：
   * 递归扫一个五万文件的目录如果压进一个 macrotask，会把主进程卡死。
   * 递归之前会先弹一个「将加入 N 个」的确认。取消返回 `null`。
   */
  pickFolder(): Promise<AddResult | null> {
    return ipcRenderer.invoke(CH.tasksPickFolder)
  },

  setTaskTarget(id: string, toExt: string): Promise<boolean> {
    return ipcRenderer.invoke(CH.tasksSetTarget, { id, toExt })
  },

  /**
   * 设/清一条任务的参数（目前只有裁剪）。`null` = 清空。
   *
   * 回布尔而不是 void：主进程对不合法的参数是**静默不办**的
   *（「参数只对视频音频有意义」那条判据在 TaskManager 里），
   * 界面只有拿到这个布尔才能把「点了没反应」与「改了」分开。
   *
   * 载荷只用 `TaskOptions` 这个窄类型，**不是** `Partial<Task>`：
   * 让渲染层能把任意任务字段推上来，等于把「哪一列该由谁改」这条边界抹掉。
   */
  setTaskOptions(id: string, options: TaskOptions | null): Promise<boolean> {
    return ipcRenderer.invoke(CH.tasksSetOptions, { id, options })
  },

  /** ids 省略表示「全部开始」 */
  startTasks(ids?: string[]): Promise<boolean> {
    return ipcRenderer.invoke(CH.tasksStart, ids ?? null)
  },

  cancelTasks(ids: string[]): Promise<boolean> {
    return ipcRenderer.invoke(CH.tasksCancel, ids)
  },

  retryTasks(ids: string[]): Promise<boolean> {
    return ipcRenderer.invoke(CH.tasksRetry, ids)
  },

  removeTasks(ids: string[]): Promise<boolean> {
    return ipcRenderer.invoke(CH.tasksRemove, ids)
  },

  clearFinishedTasks(): Promise<number> {
    return ipcRenderer.invoke(CH.tasksClearFinished)
  },

  revealTask(ids: string[]): Promise<boolean> {
    return ipcRenderer.invoke(CH.tasksReveal, ids)
  },

  /**
   * 转换完成之后的动作（复制路径 / 复制产物 / 打开所在目录）。
   *
   * **只传 id，不传动作**：做什么由主进程按设置里那一项决定。让渲染层指定动作
   * 等于让不可信输入决定「往用户的剪贴板里写什么」——那会覆盖他手里的内容，
   * 而且事后极难归因（别的程序随时会抢剪贴板）。
   *
   * 返回值里带着产物名与路径，界面据此说清楚**复制的是什么**；
   * 「再复制一次」就是拿同一个 id 再调一次。
   */
  runAfterAction(id: string): Promise<AfterActionResult> {
    return ipcRenderer.invoke(CH.tasksAfterAction, { id })
  },

  /** 任务增量推送订阅，返回取消订阅函数 */
  onTasksPatch(cb: (message: TasksPatchMessage) => void): () => void {
    const handler = (_e: unknown, message: TasksPatchMessage): void => cb(message)
    ipcRenderer.on(CH.tasksPatch, handler)
    return () => ipcRenderer.off(CH.tasksPatch, handler)
  },

  /* ---------------------------------------------------------------- 设置 */

  getSettings(): Promise<Settings> {
    return ipcRenderer.invoke(CH.settingsGet)
  },

  /**
   * 上次读盘时那份设置文件是不是坏的（坏了的话原文件已被改名留档）。
   * `null` = 没坏过。与 `integration:get` 同一个形状。
   */
  getSettingsCorruption(): Promise<SettingsCorruption | null> {
    return ipcRenderer.invoke(CH.settingsCorruption)
  },

  /**
   * 改设置。**主进程是浅合并**，所以提交 `defaultTargets` 时必须自己展开旧值：
   * `{ ...settings.defaultTargets, [cat]: ext }`。
   * 直接送 `{ video: 'mkv' }` 会把其余五个类别悄悄抹掉，且不报错。
   */
  setSettings(patch: Partial<Settings>): Promise<Settings> {
    return ipcRenderer.invoke(CH.settingsSet, patch)
  },

  /** 弹系统目录选择框，返回选中路径；取消则返回 null */
  pickOutputDir(): Promise<string | null> {
    return ipcRenderer.invoke(CH.settingsPickOutputDir)
  },

  /**
   * 挑一个「重命名即转换」的监听目录。主进程一次做完「弹框 + 写设置 + 重装监听器」，
   * 回的是**新的整份目录列表**（取消时回原样），渲染层不必自己拼。
   */
  pickRenameDir(): Promise<string[]> {
    return ipcRenderer.invoke(CH.settingsPickRenameDir)
  },

  /** 把一个目录移出监听白名单。**只是从名单里去掉**，不碰那个目录本身 */
  removeRenameDir(dir: string): Promise<string[]> {
    return ipcRenderer.invoke(CH.settingsRemoveRenameDir, dir)
  },

  /* ------------------------------------------------------------ 历史记录 */

  listHistory(): Promise<HistoryEntry[]> {
    return ipcRenderer.invoke(CH.historyList)
  },

  clearHistory(): Promise<number> {
    return ipcRenderer.invoke(CH.historyClear)
  },

  removeHistory(id: string): Promise<boolean> {
    return ipcRenderer.invoke(CH.historyRemove, { id })
  },

  /** 在资源管理器里选中产物。原处已无此物时返回 'missing'，UI 据此换个说法 */
  revealHistory(id: string): Promise<RevealResult> {
    return ipcRenderer.invoke(CH.historyReveal, { id })
  },

  /**
   * 「再行调律」：源文件重新入队并设好目标格式。**收的是 id 列表**——
   * 单条与「重跑失败的那几条」是同一个动作，拆成两条通道只会让「只重跑失败项」
   * 这条规则有两个实现，而它们迟早会分叉。
   *
   * 之所以合成一个通道、而不是让渲染层分两步调 `addPaths` + `setTaskTarget`：
   * `addPaths` 只返回 `{ added, rejected }`、**不返回新任务的 id**，
   * 渲染层根本无从知道该给哪一条设目标。合起来之后还顺带成了不可分割的操作。
   *
   * ⚠️ `conflict` 不传时，只要目标位置已有同名产物，主进程**一条都不会入队**，
   * 而是回一份 `conflicts` 清单让你先问用户一次（覆盖 / 另存，默认另存）。
   */
  rerunHistory(ids: string[], conflict?: 'rename' | 'overwrite'): Promise<RerunResult> {
    return ipcRenderer.invoke(CH.historyRerun, conflict ? { ids, conflict } : { ids })
  },

  /* ---------------------------------------------------------------- 引擎 */

  /**
   * 引擎状态。**廉价**：主进程只做 existsSync，绝不 spawn 子进程。
   * 页面渲染走这条——LibreOffice 的 `--version` 要真起进程、3～5 秒，
   * 放在渲染路径里等于每次点「关于」卡五秒。
   */
  getEngineStatus(): Promise<EngineStatus[]> {
    return ipcRenderer.invoke(CH.enginesStatus)
  },

  /**
   * 探测引擎版本。**昂贵**：真起 `--version` 子进程（Calibre 还要拉起 Python）。
   * 只有用户显式点「探测版本」才走这条，返回探测后的完整状态。
   */
  probeEngines(key?: string): Promise<EngineStatus[]> {
    return ipcRenderer.invoke(CH.enginesProbe, key ? { key } : {})
  },

  /**
   * 按需下载并解包一个重型引擎（M7）。
   *
   * **分钟级**：LibreOffice 是 375 MB 下载 + 29 秒解包。所以它是独立的一条 invoke，
   * 而不是挂在 `getEngineStatus()` 上——后者是页面渲染路径，必须毫秒级返回。
   *
   * 返回的是**装完之后**的完整状态列表（与 `probeEngines` 同形）。中途进度走
   * `onEngineProgress` 那条推送通道，不必轮询。
   */
  installEngine(key: string): Promise<EngineStatus[]> {
    return ipcRenderer.invoke(CH.enginesInstall, { key })
  },

  /** 下载/解包进度推送订阅，返回取消订阅函数 */
  onEngineProgress(cb: (progress: EngineProgress) => void): () => void {
    const handler = (_e: unknown, progress: EngineProgress): void => cb(progress)
    ipcRenderer.on(CH.enginesProgress, handler)
    return () => ipcRenderer.off(CH.enginesProgress, handler)
  },

  /* ---------------------------------------------------------- 系统集成 */

  /**
   * 右键菜单的**实际**状态（读注册表）。与设置里那个 `contextMenu` 是两回事：
   * 那一个是用户的意图，这一条是注册表里真正躺着什么，两者会分叉。
   */
  getIntegration(): Promise<IntegrationState> {
    return ipcRenderer.invoke(CH.integrationGet)
  },

  /**
   * 开关系统集成的两个入口：`{ enabled }` = 右键菜单（写注册表）、
   * `{ sendTo }` = 「发送到」快捷方式（只放一个 `.lnk`）。**两者可以只给一个**。
   *
   * 返回**改完之后**的实际状态。失败时设置不变，所以界面上的开关会留在原地，
   * 同时拿到一句可显示的 `error` / `sendToError`。
   */
  setIntegration(patch: { enabled?: boolean; sendTo?: boolean }): Promise<IntegrationState> {
    return ipcRenderer.invoke(CH.integrationSet, patch)
  },

  /* ------------------------------------------------------------ 应用信息 */

  getAppInfo(): Promise<AppInfo> {
    return ipcRenderer.invoke(CH.appInfo)
  },

  /* ------------------------------------------------------------ 窗口控制 */

  // frame:false 之后三键要自己实现，见 main/ipc/window.ts。
  // 这三个都不返回有意义的值，只是把动作转给主进程。
  minimizeWindow(): Promise<void> {
    return ipcRenderer.invoke(CH.windowMinimize)
  },

  toggleMaximizeWindow(): Promise<boolean> {
    return ipcRenderer.invoke(CH.windowToggleMaximize)
  },

  closeWindow(): Promise<void> {
    return ipcRenderer.invoke(CH.windowClose)
  },

  isWindowMaximized(): Promise<boolean> {
    return ipcRenderer.invoke(CH.windowIsMaximized)
  },

  /**
   * 最大化状态变化订阅，返回取消订阅函数。
   *
   * 必须订阅而不是只在点击时读一次：用户还可能通过**双击标题栏**或
   * Win+↑ 改变窗口状态，那些路径不经过我们的按钮，不同步的话中间那个图标会一直错着。
   */
  onWindowMaximizedChanged(cb: (maximized: boolean) => void): () => void {
    const handler = (_e: unknown, maximized: boolean): void => cb(maximized)
    ipcRenderer.on(CH.windowMaximizedChanged, handler)
    return () => ipcRenderer.off(CH.windowMaximizedChanged, handler)
  }
}

export type Api = typeof api

// 开发期把能力探测结果送到主进程终端，方便确认 sandbox 下的实际边界
try {
  ipcRenderer.send('diag:capabilities', {
    dropPaths: canResolveDropPaths,
    sandboxed: process.sandboxed,
    contextIsolated: process.contextIsolated
  })
} catch {
  // 诊断本身失败不应影响启动
}

// 注意：这里只暴露我们自己定义的 api。
// 不引入 @electron-toolkit/preload —— sandbox:true 的 preload 里
// require() 只能解析 electron，任何外部化的 npm 依赖都会让 preload 整个崩掉。
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.api = api
}
