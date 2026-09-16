import { BrowserWindow, clipboard, dialog, ipcMain, shell, type OpenDialogOptions } from 'electron'
import { existsSync, statSync } from 'node:fs'
import {
  CH,
  addPathsSchema,
  afterActionSchema,
  idListSchema,
  setOptionsSchema,
  setTargetSchema,
  type AddResult,
  type AfterActionResult,
  type TasksPatchMessage
} from '@shared/ipc-contract'
import { extOf, sourceExtsByCategory, targetsFor } from '@shared/formats'
import { CATEGORIES, type Category } from '@shared/types'
import { TaskManager } from '../core/task'
import {
  planFolderEnqueue,
  reportLines,
  scanFolder,
  type FolderScope,
  type ScanPrompt
} from '../core/folderScan'
import { runAfterAction, setAfterActionIo, type AfterActionIo } from '../core/afterAction'
import { getSettings } from '../core/settings'
import type { CliParse } from '../core/cli'

let manager: TaskManager | null = null

/** 主进程里唯一的任务管理器实例 */
export function getTaskManager(): TaskManager {
  if (!manager) {
    manager = new TaskManager(broadcast)
  }
  return manager
}

/**
 * 推给所有还活着的窗口。
 *
 * 不缓存 webContents 引用：窗口关掉后那个对象会变成「已销毁」状态，
 * 往里 send 会抛异常，而这里的调用来自 setImmediate，异常会变成 unhandled rejection。
 */
function broadcast(message: TasksPatchMessage): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed() || win.webContents.isDestroyed()) continue
    win.webContents.send(CH.tasksPatch, message)
  }
}

/* ------------------------------------------------------ 外部请求（M8 右键菜单） */

/**
 * 「用本应用转换这个文件」——右键菜单、命令行、以及将来任何外部拉起我们的入口，
 * 都汇到这一个函数上。
 *
 * 三件事必须一次做完：入队、钉目标、开跑。中间任何一步失败都要**说出来**——
 * 用户是在资源管理器里点的右键，点完之后菜单消失了、界面弹出来却什么都没有，
 * 是这个功能最坏的形态（而它看起来和「程序启动慢」一模一样，无法归因）。
 *
 * 目标格式**先校验再加**：`TaskManager.setTarget()` 对不认识的目标是**静默 return**
 *（它会拿 `targetsFor()` 再验一遍），于是「--to 写错了」的后果是任务按默认目标
 * 跑完、产物是另一个格式——一个不报错的错误答案。所以这里提前用同一份能力矩阵判。
 */
export async function enqueueExternalRequest(request: {
  /** **可能不止一个**：「发送到」多选时资源管理器会把选中的文件全部追加到命令行 */
  paths: string[]
  to: string | null
}): Promise<AddResult> {
  const tasks = getTaskManager()

  // 目标格式**先校验再加**（逐个路径校验）：每个源格式的合法目标各不相同，
  // 一个 `--to mp4` 对视频行合法、对图片行可能根本不在能力矩阵里。
  // 校验不合格的那些**逐条带理由拒绝**，其余照常入队——整批一起拒会把
  // 「文件名不对」升级成「你框选的十个全都没进来」。
  const accepted: string[] = []
  const rejected: AddResult['rejected'] = []

  for (const path of request.paths) {
    const from = extOf(path)
    if (request.to !== null && !targetsFor(from).includes(request.to)) {
      rejected.push({
        path,
        reason: `.${from} 不能转成 .${request.to}（可选的还有：${targetsFor(from).join(' / ') || '无'}）`
      })
      continue
    }
    accepted.push(path)
  }

  if (accepted.length === 0) return { added: 0, rejected }

  // `addPaths()` **不返回新建任务的 id**，只给 `{ added, rejected }`。所以用「前后差集」
  // 找出刚进来的那几条。不改成「让 addPaths 返回 id」是因为那个签名被渲染层那条路共用，
  // 改它要动 IPC 契约，而这里的一次差集在主进程的同步语义下没有歧义。
  const before = new Set(tasks.list().map((task) => task.id))
  const result = await tasks.addPaths(accepted)
  const fresh = tasks.list().filter((task) => !before.has(task.id))

  for (const task of fresh) {
    if (request.to !== null) tasks.setTarget(task.id, request.to)
  }
  // **全部**开跑。只 start 第一个的话，「发送到」框选 10 个文件的结果是
  // 1 个在跑、9 个在队列里干等——用户看到的是「只转了一个」（约束 23 第 5 条那个坑的镜像）。
  if (fresh.length > 0) tasks.start(fresh.map((task) => task.id))

  return { added: result.added, rejected: [...rejected, ...result.rejected] }
}

/**
 * 把一次命令行解析的结果落实到队列上，并处理「说不出口的失败」。
 *
 * `parent` 是当前主窗口（可能还不存在——`squirrel` 之类的启动时机早于窗口），
 * 有窗口就挂成模态对话框，没有就退化成无主对话框。**绝不能静默返回**：
 * 这条路上没有任何界面元素能承载错误，弹窗是唯一的出口。
 */
export async function applyCliRequest(
  parsed: CliParse,
  parent: BrowserWindow | null
): Promise<void> {
  if (parsed.kind === 'none') return

  if (parsed.kind === 'error') {
    await showMessage(parent, '无法识别这次转换请求', parsed.message)
    return
  }

  const result = await enqueueExternalRequest(parsed.request)
  if (result.rejected.length > 0) {
    await showMessage(
      parent,
      '这个文件没能加入队列',
      result.rejected.map((item) => `${item.path}\n${item.reason}`).join('\n\n')
    )
  }
}

/** 主窗口。没有就返回 null（无头启动、或窗口已被销毁） */
export function mainWindow(): BrowserWindow | null {
  const [win] = BrowserWindow.getAllWindows()
  return win && !win.isDestroyed() ? win : null
}

/** 把窗口带到前台。右键菜单拉起时窗口大概率不在最前面，不聚焦的话用户看不到任何反应 */
export function focusMainWindow(): void {
  const win = mainWindow()
  if (!win) return
  if (win.isMinimized()) win.restore()
  win.focus()
}

async function showMessage(
  parent: BrowserWindow | null,
  title: string,
  detail: string
): Promise<void> {
  const options = {
    type: 'warning' as const,
    title: '调律者转换器',
    message: title,
    detail,
    buttons: ['知道了']
  }
  if (parent && !parent.isDestroyed()) await dialog.showMessageBox(parent, options)
  else await dialog.showMessageBox(options)
}

/**
 * 「转换完成之后的动作」的真实出口（剪贴板 / 资源管理器）。
 *
 * ⚠️ 注入点在这一层：`core/afterAction.ts` 自己不 import electron，那样它才能在普通
 * Node 下被完整驱动一遍（`scripts/test-integration.ts` 的 [9] 逐档验了「动没动剪贴板」）。
 * 忘了这一行不会崩——`runAfterAction` 会回一句「剪贴板出口未注入」并显示在界面上，
 * 刻意不做任何兜底。
 */
const electronAfterActionIo: AfterActionIo = {
  copyText(text) {
    clipboard.writeText(text)
  },

  /**
   * 「复制产物本身」= 往剪贴板里放一条**文件引用**，不是文件内容。
   *
   * `FileNameW` 是 Windows 上文件拖放那套格式（CF_HDROP 的宽字符形态）的格式名，
   * Electron 只允许按名字写自定义格式，这是官方 issue 里给的做法。
   *
   * ⚠️ **实测（2026-09-13，Windows 11 + 本机 Electron）：这两种格式无法共存。**
   * `clipboard.writeText` 会**清空**剪贴板，`writeBuffer` 同样会——谁写在后面谁留下，
   * 先写的那一份被整个抹掉：
   *
   * ```
   * writeText('X') 然后 writeBuffer('FileNameW', …)  →  readText() === ''            // 文本没了
   * writeBuffer('FileNameW', …) 然后 writeText('X')  →  readBuffer('FileNameW') === '' // 引用没了
   * ```
   *
   * 所以这里**只写文件引用**，不补文本。这正好也是我们想要的：纯路径那一档由
   * `'copy-path'` 负责（`copyText`），两档各管一件事；两样都塞进去既做不到，
   * 也会让「从剪贴板里拿到的到底是什么」变得说不清。
   *
   * （未验证：资源管理器 / 聊天工具是否认这一套格式。本机只验到「字节确实写进剪贴板、
   * 读得回来」这一步，粘贴端的行为要真装到机器上点一次才知道。）
   */
  copyFile(path) {
    // 结尾必须有一个 NUL（UTF-16 的一个空字符），接收端按 C 字符串读它
    clipboard.writeBuffer('FileNameW', Buffer.from(`${path}${String.fromCharCode(0)}`, 'ucs2'))
  },

  reveal(path) {
    shell.showItemInFolder(path)
  },

  sizeOf(path) {
    try {
      const info = statSync(path)
      return info.isFile() ? info.size : null
    } catch {
      // 产物被挪走 / 删掉 / 还没落盘。**返回 null 而不是 0**：0 会让「超过阈值」
      // 那一条判断走不到，于是我们照样往剪贴板里写一个不存在的路径。
      return null
    }
  }
}

export function registerTaskIpc(): void {
  const tasks = getTaskManager()
  setAfterActionIo(electronAfterActionIo)

  ipcMain.handle(CH.tasksList, () => tasks.list())

  /**
   * 「转换完成之后的动作」。**动作不由渲染层指定**，它读的是设置里那一项——
   * 让载荷指定等于让不可信输入决定「覆盖用户的剪贴板」。
   */
  ipcMain.handle(CH.tasksAfterAction, (_event, raw): AfterActionResult => {
    const parsed = afterActionSchema.safeParse(raw)
    const action = getSettings().afterConvert

    if (!parsed.success) {
      return {
        ok: false,
        requested: action,
        action,
        path: null,
        name: null,
        sizeBytes: null,
        degradeReason: null,
        error: '参数非法'
      }
    }

    const task = tasks.list().find((item) => item.id === parsed.data.id)
    if (!task) {
      return {
        ok: false,
        requested: action,
        action,
        path: null,
        name: null,
        sizeBytes: null,
        degradeReason: null,
        error: '这个任务已不在队列里'
      }
    }

    if (task.outputPath === undefined) {
      // 还没落盘（在跑、或者失败了）。**不报「文件不存在」**——那会把
      // 「还没有产物」说成「产物丢了」，两件事的下一步动作完全不同。
      return {
        ok: false,
        requested: action,
        action,
        path: null,
        name: task.inputName,
        sizeBytes: null,
        degradeReason: null,
        error: '这个任务还没有产物'
      }
    }

    return runAfterAction(action, task.outputPath)
  })

  ipcMain.handle(CH.tasksAdd, async (_event, raw): Promise<AddResult> => {
    const parsed = addPathsSchema.safeParse(raw)
    if (!parsed.success) {
      return { added: 0, rejected: [{ path: String(raw), reason: '路径参数非法' }] }
    }
    return tasks.addPaths(parsed.data)
  })

  ipcMain.handle(CH.tasksSetTarget, (_event, raw) => {
    const parsed = setTargetSchema.safeParse(raw)
    if (!parsed.success) return false
    tasks.setTarget(parsed.data.id, parsed.data.toExt)
    return true
  })

  /**
   * 改一条任务的参数（目前只有裁剪）。
   *
   * **入参是不可信输入，而且这一份会变成 ffmpeg 的命令行参数**，所以校验一步都不能省：
   * schema 管住「形状与非法的数」（`NaN` / 负值 / `end <= start` / 未知的 mode），
   * `TaskManager.setOptions` 再管住「这条任务允不允许带这个参数」（裁剪只对视频音频有意义）。
   *
   * **回的是 `TaskManager.setOptions` 的结论，不是一个恒真的 `true`。**
   * 这一条链路上「静默不办」有四种（任务不在 / 正在跑 / 这一类不该有参数 /
   * 区间本身是坏的），而它们在界面上留下的痕迹一模一样：什么都没变。
   * 上面的 schema 只判得了最后一种，所以这里必须把下层的结论原样回上去——
   * 写成 `setOptions(...); return true` 的话，「图片任务不该有裁剪」这种拒绝
   * 在渲染层看起来就是**成功**，裁剪面板会得意地关掉，而参数根本没设上。
   * （实测踩到过：脚本里那条「图片任务不接受裁剪参数」正是这么红的。）
   */
  ipcMain.handle(CH.tasksSetOptions, (_event, raw) => {
    const parsed = setOptionsSchema.safeParse(raw)
    if (!parsed.success) return false
    return tasks.setOptions(parsed.data.id, parsed.data.options ?? undefined)
  })

  ipcMain.handle(CH.tasksStart, (_event, raw) => {
    const parsed = idListSchema.nullable().safeParse(raw ?? null)
    if (!parsed.success) return false
    tasks.start(parsed.data ?? undefined)
    return true
  })

  ipcMain.handle(CH.tasksCancel, (_event, raw) => {
    const parsed = idListSchema.safeParse(raw)
    if (!parsed.success) return false
    tasks.cancel(parsed.data)
    return true
  })

  ipcMain.handle(CH.tasksRetry, (_event, raw) => {
    const parsed = idListSchema.safeParse(raw)
    if (!parsed.success) return false
    tasks.retry(parsed.data)
    return true
  })

  ipcMain.handle(CH.tasksRemove, (_event, raw) => {
    const parsed = idListSchema.safeParse(raw)
    if (!parsed.success) return false
    tasks.remove(parsed.data)
    return true
  })

  ipcMain.handle(CH.tasksClearFinished, () => tasks.clearFinished())

  ipcMain.handle(CH.tasksReveal, async (_event, raw) => {
    const parsed = idListSchema.safeParse(raw)
    if (!parsed.success || parsed.data.length === 0) return false

    const wanted = new Set(parsed.data)
    const target = tasks.list().find((t) => wanted.has(t.id))

    // 产物还没生成时退回到源文件位置，总比什么都不做强。
    //
    // **但下落不明的产物不能直接当 `??` 的左边。** `shell.showItemInFolder` 对不存在的
    // 路径是**静默**的（不抛错、不返回任何东西），于是「产物被挪走或删掉之后点打开位置」
    // 会什么都不发生，而这个 handler 照样返回 true、界面照样报「已打开」——用户点第二次、
    // 第三次，还是什么都没有。所以先判一次存在性再决定退不退。
    // （历史页的 `historyReveal` 出于同样的理由也自己判了一次，见 ipc/history.ts。）
    const path = [target?.outputPath, target?.inputPath].find(
      (candidate): candidate is string => typeof candidate === 'string' && existsSync(candidate)
    )
    if (!path) return false

    shell.showItemInFolder(path)
    return true
  })

  /* -------------------------------------------------------- 文件选择器 */

  /**
   * 这两个 handler **没有任何入参**。
   *
   * 别的通道都要 `safeParse(raw)`，是因为渲染进程送来的东西不可信；这里渲染层
   * 只是说了一句「弹框吧」，没有任何数据过界，所以连 `_event` 之外都不接。
   * 选了哪些文件由主进程自己从对话框拿——那条链路不经渲染层，天然可信。
   */
  ipcMain.handle(CH.tasksPickFiles, async (event): Promise<AddResult | null> => {
    const result = await openDialog(event, {
      title: '收入文件',
      properties: ['openFile', 'multiSelections'],
      filters: sourceFilters()
    })

    // 取消 = 什么事都没发生，与「选了但全被拒」严格区分：前者一个字都不该提示，
    // 后者要告诉用户哪些文件不认得。合约上用 `null` 表示取消。
    if (result.canceled || result.filePaths.length === 0) return null
    return tasks.addPaths(result.filePaths)
  })

  ipcMain.handle(CH.tasksPickFolder, async (event): Promise<AddResult | null> => {
    const result = await openDialog(event, {
      title: '打开文件夹（可选含子文件夹）',
      properties: ['openDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) return null

    const dir = result.filePaths[0] as string
    const window = BrowserWindow.fromWebContents(event.sender)

    /**
     * 扫描走 `core/folderScan.ts`：异步分批、随时可取消、有条数上限、有排除清单。
     *
     * ⚠️ **递归在这里是有代价的**，代价全在「主进程是唯一真相源」这一条上：
     * 它一卡，整个应用没有任何反应（连取消都点不动）。所以递归**不是**把
     * `readdir` 加个 `recursive: true`——那个形态一次把整棵树收进内存，中间
     * 一次都不让出事件循环。判据与实测见那个文件的说明。
     *
     * 取消在**生产里的唯一接线**是「发起这次扫描的窗口已经没了」（用户把窗口关了
     * 或者应用正在退出）。扫描本身很短，界面上的取消按钮没有落点（它跑在一次
     * IPC 往返里），所以这里刻意不假装有一个。
     */
    const report = await scanFolder(dir, {
      shouldCancel: () => window !== null && window.isDestroyed()
    })

    // 窗口没了 / 扫描被取消：什么都不做，也不提示（与用户按了取消同形）。
    // `report.cancelled` 为真时 `files` 一定是空的，所以这里绝不会入队半份清单。
    if (report.cancelled) return null

    // 目录里一个认得的文件都没有，**不是「取消」也不是「失败」**：
    // 返回 `null` 会被当成用户取消了，那就什么都提示不出来了；返回空结果让渲染层
    // 换一句提示（「此处没有认得的文件」）。而排除/跳过的清单要一起带回去——
    // 「扫过 12 个目录、跳过了 node_modules、一个都没找到」和「这个目录是空的」
    // 是两件事，只有报告能分得开。
    if (report.files.length === 0) return { added: 0, rejected: reportLines(report) }

    // **先给「将加入 N 个文件」的确认，用户点了才开始入队。**
    // 这一步是纯函数（`core/folderScan.ts` 的 `planFolderEnqueue`），
    // 这里只负责把系统弹框接上去——「点没点、点了哪一个」因此能在普通 Node 下
    // 被完整驱动一遍（`scripts/test-integration.ts` 的 [12]）。
    const files = await planFolderEnqueue(report, async (prompt) => {
      const answer = await showChoice(window, prompt)
      return answer
    })

    // 空数组只可能是「用户在确认框上按了取消」（`top` 那一档只在真有顶层文件时才出现，
    // 而一个文件都没有的情况上面已经返回了）。与取消选择框一样：一个字都不提示。
    if (files.length === 0) return null

    const added = await tasks.addPaths(files)
    // 报告与逐条拒绝**一起**回去：前者是「我跳过了什么」，后者是「哪些文件没能进来」。
    // 两者的去向是同一个（界面下方那张清单），因为它们回答的是同一句「少了的东西去哪了」。
    return { added: added.added, rejected: [...reportLines(report), ...added.rejected] }
  })
}

/**
 * 「将加入 N 个文件」的那个确认框。
 *
 * `noLink: true` 是给 Windows 的：默认会把按钮画成**命令链接**（一行大字 + 一行小字），
 * 而我们的按钮文案本身就是完整的句子，画成链接会挤成两行，反而看不清。
 *
 * 点掉窗口右上角的叉 = `cancelId`，也就是最后那一颗「取消」——
 * 这个对应关系由 `choices` 的最后一项是 `'cancel'` 保证（`confirmPromptFor` 里排的），
 * 不认识的下标一律当取消处理：**宁可什么都不做，也不要误当成「加入」。**
 */
async function showChoice(window: BrowserWindow | null, prompt: ScanPrompt): Promise<FolderScope> {
  const options = {
    type: 'question' as const,
    title: '调律者转换器',
    message: prompt.message,
    detail: prompt.detail,
    buttons: prompt.buttons,
    defaultId: 0,
    cancelId: prompt.buttons.length - 1,
    noLink: true
  }
  const answer =
    window && !window.isDestroyed()
      ? await dialog.showMessageBox(window, options)
      : await dialog.showMessageBox(options)
  return prompt.choices[answer.response] ?? 'cancel'
}

/**
 * 把对话框挂到发起请求的那个窗口上。
 *
 * 不挂父窗口（`dialog.showOpenDialog(options)`）在 Windows 上会弹出一个不属于本应用的
 * 顶层窗口：不跟随主窗口最小化、任务栏上多一个图标，而且**不是模态的**——用户能点回
 * 主窗口再拖一批文件进来，两次入队交叠在一起。
 */
function openDialog(
  event: Electron.IpcMainInvokeEvent,
  options: OpenDialogOptions
): Promise<Electron.OpenDialogReturnValue> {
  const window = BrowserWindow.fromWebContents(event.sender)
  return window ? dialog.showOpenDialog(window, options) : dialog.showOpenDialog(options)
}

/**
 * 类别 → 中文名。**只给系统对话框的过滤器当标签用。**
 *
 * 写成 `Record<Category, string>` 而不是普通对象：将来往 `CATEGORIES` 里加一类却忘了
 * 在这里补一行，就直接是编译错误，而不是一个没有标签的空过滤器。
 * 渲染层另有一份同类映射（队列行副标题要用），两边服务的是两个进程，没法共用。
 */
const CATEGORY_LABEL: Record<Category, string> = {
  video: '视频',
  audio: '音频',
  image: '图片',
  document: '文档',
  ebook: '电子书',
  archive: '压缩包'
}

/**
 * 文件对话框的扩展名过滤器。
 *
 * **必须传**：不传的话用户在对话框里能选中任何文件（`.exe` / `.dll` / 无扩展名的都行），
 * 然后被 `addPaths` 逐条拒掉——本来在选择阶段就可以不让他选。
 *
 * 扩展名从 `sourceExtsByCategory()` 现取，不在主进程另抄一份清单：能力矩阵加了新格式，
 * 这里自动跟上。抄一份的下场是「支持了 `.avif`，但文件对话框里选不中它」。
 */
function sourceFilters(): OpenDialogOptions['filters'] {
  const byCategory = sourceExtsByCategory()
  const all: string[] = []

  const groups = CATEGORIES.map((category) => {
    const extensions = byCategory[category]
    all.push(...extensions)
    return { name: CATEGORY_LABEL[category], extensions }
  })

  return [...groups, { name: '全部支持的格式', extensions: all }]
}
