/**
 * 系统集成那一摊（core/cli.ts、core/integration.ts、core/sendTo.ts、core/jsonStore.ts、core/renameWatch*.ts、ipc/rename.ts）：命令行解析错误、注册表菜单标签、快捷方式描述、设置损坏原因、重命名监听的通知。
 *
 * ⚠️ 这一类与渲染层那几块有一个**关键差别**：它们的文字**由主进程产出**，
 * 而其中一部分由 OS 去画（原生对话框、系统通知、注册表菜单、快捷方式描述）——
 * 渲染进程根本不在场。所以取词必须走 `@shared/i18n` 那份**模块级全局**
 * （见 `core/locale.ts`），不能「把语言传进来」：那些调用点拿不到「这是哪个界面」。
 *
 * ⚠️ 中文值必须与迁移前逐字节相同——闸门 d 逐值比对冻结快照。
 *
 * ## 两条与别处不同的注意
 *
 * 1. **`MENU_LABEL` 存的是键、不是句子**（`core/integration.ts`）：那是个模块级常量，
 *    写成 `t(...)` 会让它**永远停在启动时那门语言**上。取词放在用到的那一处。
 * 2. **注册表标签与 `.lnk` 的 description 是 Windows 画在磁盘上的死文本**，
 *    不会自己跟着语言变。`ipc/settings.ts` 里已有「语言变了就催一次自愈」的逻辑，
 *    这里不必额外做什么——但改文案时要知道那一层存在。
 */

export const integrationZh = {
  /* ------------------------------------------- core/cli.ts（会进原生对话框） */

  'integration.cli.noConvertPath': '--convert 后面没有跟文件路径',
  'integration.cli.noConvertFile': 'convert 后面没有跟文件路径',
  'integration.cli.noTo': '--to 后面没有跟目标格式',
  'integration.cli.badExt': '目标格式不像个扩展名：{value}',
  'integration.cli.noOut': '--out 后面没有跟输出路径',
  'integration.cli.outSingleSource': '--out 只能配一个源文件，这次给了 {count} 个',
  'integration.cli.noRecipe': '--recipe 后面没有跟配方文件路径',
  'integration.cli.unknownOption': '未知的选项：{name}',
  'integration.cli.missingSubcommand': '缺少子命令',
  'integration.cli.unknownSubcommand': '未知的子命令：{name}',

  /* ------------------------------------- core/integration.ts（注册表右键菜单） */

  'integration.menu.label': '用调律者转换',
  'integration.reg.spawnFailed': '无法启动 reg.exe',
  'integration.reg.unavailable': 'reg.exe 不可用',
  'integration.reg.exitCode': 'reg.exe 退出码 {code}',

  /* ---------------------------------------- core/sendTo.ts（「发送到」快捷方式） */

  'integration.sendTo.description': '把文件送入调律者转换器',
  'integration.sendTo.noIo': '快捷方式读写未注入',
  'integration.sendTo.readBackFailed': '快捷方式写完之后读不到',

  /* ---------------------------------------------------------------- core/jsonStore.ts */

  'integration.jsonStore.badShape': '内容不是认识的形状（被手改过，或来自不兼容的版本）',
  // 下面三条与 badShape 一样，只写进终端与留档记录——但读盘发生在**窗口之前**，
  // 那时连渲染进程都还没起来，所以它照样只能由主进程取词（A 类）。
  'integration.jsonStore.readFailed': '[jsonStore] {file} 读不出可用数据（{reason}）；',
  'integration.jsonStore.quarantined': '原文件已留档为 {path}',
  'integration.jsonStore.quarantineFailed': '留档失败，原文件仍在原地',
  'integration.jsonStore.fallbackToDefaults': '，本次改用默认值。',
  'integration.jsonStore.writeFailed': '[jsonStore] 写不动 {file}：',

  /* ------------------ core/renameWatcher.ts 与 ipc/rename.ts（重命名即转换的通知） */

  'integration.notify.title': '调律者转换器',
  'integration.log.notifyUnsupported': '[rename] 系统通知不可用，消息只留在终端：{title} — {body}',
  'integration.log.notifyFailed': '[rename] 弹系统通知失败：',
  'integration.log.removeRejected': '[rename] 拒绝了一份不合规的移除请求：',
  // 几个理由拼成一串时用的分隔符。与 `folderScan.sep.summary` 同一条规矩：
  // 全角标点在中文里是文案的一部分，英文那一侧要换成半角加空格。
  'integration.rename.reasonSep': '；',
  'integration.rename.pickDirTitle': '选择要监听的文件夹',
  'integration.rename.watchFailed': '无法监听目录「{dir}」：{reason}',
  'integration.rename.tooManyEntries': '目录「{dir}」条目过多（{count}），已跳过重命名监听',
  'integration.rename.revertFailed': '把「{to}」改回「{from}」失败：{reason}',
  'integration.rename.enqueueRejected': '「{to}」没能转成 {ext}：{reason}',
  'integration.rename.nameRestored': '。文件名已改回「{to}」',
  'integration.rename.nameNotRestored': '。文件名没能还原，请手动检查',
  'integration.rename.reasonUnknown': '原因不明',
  'integration.rename.notifyBody':
    '「{to}」的内容其实是 {fromExt}，已经按真正的 {toExt} 转换。原文件保留为「{from}」。'
} as const

export const integrationEn: Record<keyof typeof integrationZh, string> = {
  /* ------------------------------------------- core/cli.ts（会进原生对话框） */

  'integration.cli.noConvertPath': '--convert was not followed by a file path',
  'integration.cli.noConvertFile': 'convert was not followed by a file path',
  'integration.cli.noTo': '--to was not followed by a target format',
  'integration.cli.badExt': 'That target format does not look like a file extension: {value}',
  'integration.cli.noOut': '--out was not followed by an output path',
  'integration.cli.outSingleSource': '--out takes a single source file, but {count} were given',
  'integration.cli.noRecipe': '--recipe was not followed by a recipe file path',
  'integration.cli.unknownOption': 'Unknown option: {name}',
  'integration.cli.missingSubcommand': 'Missing subcommand',
  'integration.cli.unknownSubcommand': 'Unknown subcommand: {name}',

  /* ------------------------------------- core/integration.ts（注册表右键菜单） */

  // 与设置页那句 `settings.integration.menu.checkbox`（Add “Convert with Arbiter” in
  // Explorer）同一个说法：菜单上那行字就是 Explorer 里画出来的东西，两处必须一致。
  'integration.menu.label': 'Convert with Arbiter',
  'integration.reg.spawnFailed': 'Could not start reg.exe',
  'integration.reg.unavailable': 'reg.exe is unavailable',
  'integration.reg.exitCode': 'reg.exe exited with code {code}',

  /* ---------------------------------------- core/sendTo.ts（「发送到」快捷方式） */

  // 这句会作为 description 写进 `.lnk` 里，由资源管理器画在「发送到」菜单上
  'integration.sendTo.description': 'Send files to Arbiter',
  'integration.sendTo.noIo': 'Shortcut I/O has not been wired up',
  'integration.sendTo.readBackFailed': 'The shortcut could not be read back after it was written',

  /* ---------------------------------------------------------------- core/jsonStore.ts */

  'integration.jsonStore.badShape':
    'The content is not a shape we recognize (hand-edited, or from an incompatible version)',
  'integration.jsonStore.readFailed': '[jsonStore] {file} holds no usable data ({reason});',
  'integration.jsonStore.quarantined': 'the original file was set aside as {path}',
  'integration.jsonStore.quarantineFailed':
    'setting it aside failed, the original file is still there',
  'integration.jsonStore.fallbackToDefaults': ', so defaults are in use for this run.',
  'integration.jsonStore.writeFailed': '[jsonStore] could not write {file}:',

  /* ------------------ core/renameWatcher.ts 与 ipc/rename.ts（重命名即转换的通知） */

  'integration.notify.title': 'Arbiter',
  'integration.log.notifyUnsupported':
    '[rename] system notifications are unavailable, the message stays in the terminal: {title} — {body}',
  'integration.log.notifyFailed': '[rename] showing the system notification failed:',
  'integration.log.removeRejected': '[rename] rejected a malformed removal request:',
  'integration.rename.reasonSep': '; ',
  // 通知的按钮/标题栏很窄，标题只要产品名；「哪个功能」由正文说
  'integration.rename.pickDirTitle': 'Choose a folder to watch',
  'integration.rename.watchFailed': 'Cannot watch the folder “{dir}”: {reason}',
  'integration.rename.tooManyEntries':
    'The folder “{dir}” has too many entries ({count}) — rename watching is off for it',
  'integration.rename.revertFailed': 'Could not rename “{to}” back to “{from}”: {reason}',
  'integration.rename.enqueueRejected': '“{to}” could not be converted to {ext}: {reason}',
  // 下面两条是接在 `enqueueRejected` 后面的**半句**：开头那个句点是内容的
  // （与 `filters.resizeHintNoEnlarge` 开头那个空格同一个道理），别顺手删掉。
  'integration.rename.nameRestored': '. The file name has been changed back to “{to}”',
  'integration.rename.nameNotRestored':
    '. The file name could not be restored — please check it yourself',
  'integration.rename.reasonUnknown': 'reason unknown',
  'integration.rename.notifyBody':
    '“{to}” is really {fromExt}, so it was converted as {toExt}. The original file is kept as “{from}”.'
}
