/**
 * 主进程 IPC 层（ipc/tasks.ts、ipc/history.ts、ipc/settings.ts、ipc/integration.ts）：原生对话框标题与按钮、文件选择器、拒绝理由。
 *
 * ⚠️ 这一类与渲染层那几块有一个**关键差别**：它们的文字**由主进程产出**，
 * 而其中一部分由 OS 去画（原生对话框、系统通知、注册表菜单、快捷方式描述）——
 * 渲染进程根本不在场。所以取词必须走 `@shared/i18n` 那份**模块级全局**
 * （见 `core/locale.ts`），不能「把语言传进来」：那些调用点拿不到「这是哪个界面」。
 *
 * ⚠️ 中文值必须与迁移前逐字节相同——闸门 d 逐值比对冻结快照。
 *
 * ## 四组键
 *
 * - `ipc.dialog.*` —— 原生对话框那一摊：标题（`showMessageBox` 的 `title`、`showOpenDialog`
 *   的 `title`）、按钮文案、以及**由 OS 画给用户看的两句正文**。它们全都不过在渲染层，
 *   所以取词只能在这里。
 * - `ipc.reject.*` —— 交回渲染层的**拒绝理由**（`AddResult.rejected[].reason`、
 *   `RerunResult.rejected[].reason`）。它们是整句，因为界面只是把整句摆出来。
 * - `ipc.filter.*` —— `showOpenDialog` 的过滤器**组名**（那个下拉里的一行字，同样是 OS 画的）。
 * - `ipc.integration.*` —— 系统集成那两个入口（注册表右键菜单 / 「发送到」快捷方式）
 *   落地失败时给用户的那一句。`ipc.log.*` 则是**终端诊断**，不是给用户看的中文——
 *   它们跟着搬进来只是为了让「这个文件里还有中文吗」有一条干净的判据。
 *
 * ## `.{from} 不能转成 .{to}` 那个点为什么在值里
 *
 * 快照的取材口径是「模板字面量只按它的**字面量部分**拼起来」，而原句是
 * `` `.${from} 不能转成 .${request.to}（可选的还有：${…}）` ``——两个点都是**源码里写着**的，
 * `{from}` / `{to}` 两边各一个。所以值写成 `.{from} 不能转成 .{to}（…）`：抹掉占位符之后
 * 是 `. 不能转成 .（可选的还有：）`，与快照里那一串**一字不差**。可用目标为空时那句
 * `无` 单独成键，与快照里那条同名的片段对得上。
 */

export const ipcZh = {
  /* ---- 原生对话框 ---- */
  'ipc.dialog.appTitle': '调律者转换器',
  'ipc.dialog.ok': '知道了',
  'ipc.dialog.pickFilesTitle': '收入文件',
  'ipc.dialog.pickFolderTitle': '打开文件夹（可选含子文件夹）',
  'ipc.dialog.pickOutputDirTitle': '选择输出目录',
  /** `showMessage` 的第一句：命令行解析不出一次请求时弹的那个框 */
  'ipc.dialog.unknownRequest': '无法识别这次转换请求',
  /** 同上：外部请求里有文件没能入队（右键菜单 / 命令行拉起来的那些） */
  'ipc.dialog.enqueueFailed': '这个文件没能加入队列',

  /* ---- 交回渲染层的拒绝理由 ---- */
  'ipc.reject.cannotConvert': '.{from} 不能转成 .{to}（可选的还有：{options}）',
  'ipc.reject.noTargets': '无',
  'ipc.reject.badPayload': '参数非法',
  'ipc.reject.badPaths': '路径参数非法',
  'ipc.reject.taskGone': '这个任务已不在队列里',
  'ipc.reject.noOutputYet': '这个任务还没有产物',
  'ipc.reject.entryGone': '这条痕迹已不在记录中',

  /* ---- 文件选择器的过滤器组名 ---- */
  'ipc.filter.all': '全部支持的格式',

  /* ---- 系统集成那两个入口 ---- */
  'ipc.integration.contextMenuNotApplied': '注册表没有落到预期状态',
  'ipc.integration.sendToNotApplied': '快捷方式没有落到预期状态',
  'ipc.integration.shortcutWriteFailed': '写入快捷方式失败（shell.writeShortcutLink 返回 false）',

  /* ---- 终端诊断（`console.warn`）---- */
  'ipc.log.settingsRejected': '[settings] 拒绝了一份不合规的 patch：',
  'ipc.log.integrationRejected': '[integration] 拒绝了一份不合规的载荷：'
} as const

export const ipcEn: Record<keyof typeof ipcZh, string> = {
  'ipc.dialog.appTitle': 'Arbiter',
  'ipc.dialog.ok': 'Got it',
  'ipc.dialog.pickFilesTitle': 'Add files',
  'ipc.dialog.pickFolderTitle': 'Choose a folder (subfolders included)',
  'ipc.dialog.pickOutputDirTitle': 'Choose output folder',
  'ipc.dialog.unknownRequest': 'Could not recognize this conversion request',
  'ipc.dialog.enqueueFailed': 'This file could not be added to the queue',

  'ipc.reject.cannotConvert': '.{from} cannot be converted to .{to} (available targets: {options})',
  'ipc.reject.noTargets': 'none',
  'ipc.reject.badPayload': 'Invalid arguments',
  'ipc.reject.badPaths': 'Invalid path argument',
  'ipc.reject.taskGone': 'This task is no longer in the queue',
  'ipc.reject.noOutputYet': 'This task has no output yet',
  'ipc.reject.entryGone': 'This entry is no longer in the history',

  'ipc.filter.all': 'All supported formats',

  'ipc.integration.contextMenuNotApplied':
    'The registry entry did not end up in the expected state',
  'ipc.integration.sendToNotApplied': 'The shortcut did not end up in the expected state',
  'ipc.integration.shortcutWriteFailed':
    'Could not write the shortcut (shell.writeShortcutLink returned false)',

  'ipc.log.settingsRejected': '[settings] rejected a malformed patch:',
  'ipc.log.integrationRejected': '[integration] rejected a malformed payload:'
}
