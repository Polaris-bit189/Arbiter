/**
 * 设置页（`pages/SettingsPage.tsx`）。
 *
 * 语言那几条是 P1 落的，其余各节随 P2 迁进来。
 *
 * ## 三条承重的搬运约定
 *
 * 1. **中文值与源码里的字面量逐字节相同**。闸门 d 拿冻结快照逐值比对，改一个字就红——
 *    它保护的是一百多条直接断言中文字面量的老断言（`test-ui.ts` / `test-core.ts` 等）。
 *    所以这一份是**搬运**，不是润色。
 * 2. **源码里用 `+` 拼起来的长提示，按原来的分段各占一条键**（`settings.after.hint1..4`
 *    与 `settings.rename.hint1..4` 那两组）。合成一整句读起来更整齐，但冻结快照是按
 *    **源码里的字面量**冻的：快照里只有那些分片、没有拼起来的那一整句，合成一条会被
 *    闸门 d 判成「改写了一句中文」。那几段在界面上本来就是拼着渲染的，
 *    分成几条**渲染结果一字不差**。
 * 3. **英文里以空格开头的值是刻意的**：中文靠「，」「。」断句，句间不需要空格，而英文
 *    需要。拼起来之后那个空格必须来自某一侧，所以它落在英文那一侧（`' ⚠️ …'`）。
 *    别顺手 trim 掉——trim 之后两句话会粘成一个词。
 *    同理，`settings.corruption.{file,reason}` 结尾那个空格也是承重的：它后面紧跟的
 *    是一个文件名 / 一句原因，中间不能没有空格。
 */
export const settingsZh = {
  'settings.language': '界面语言',
  'settings.language.system': '跟随系统',
  'settings.language.zh': '中文',
  'settings.language.en': 'English',
  'settings.language.hint':
    '跟随系统时，中文系统用中文、其余用英文。切换立即生效，不需要重启；右键菜单与「发送到」会在下次刷新时跟着变。',

  /* ---- 页面外壳 ---- */
  'settings.title': '格式设置',
  'settings.loading': '正在读取设置…',

  /* ---- 设置文件读不动时的告警 ---- */
  'settings.corruption.title': '设置文件读不动，已重置为默认值',
  'settings.corruption.file': '出错的文件：',
  'settings.corruption.reason': '原因：',
  'settings.corruption.kept':
    '原文件仍在原地（改名留档失败了），但内容没有被覆盖——先把它拷出来再改设置，否则下一次写盘会覆盖它。',
  'settings.corruption.quarantined': '原文件已留档到 {path}，内容一个字节都没被动过。',

  /* ---- 各类别默认目标 ---- */
  'settings.category.title': '各类别默认目标',
  'settings.category.hint': '源格式不支持时会自动改用该格式的默认目标',
  'settings.category.inherit': '随源格式而定',

  /* ---- 输出目录 ---- */
  'settings.output.title': '输出目录',
  'settings.output.where': '写入何处',
  'settings.output.beside': '源文件所在目录',
  'settings.output.custom': '指定目录',
  'settings.output.unset': '尚未指定',
  'settings.output.dir': '目录',
  'settings.output.change': '更改',

  /* ---- 同名文件 ---- */
  'settings.conflict.title': '同名文件',
  'settings.conflict.label': '已存在时',
  'settings.conflict.rename': '另起一名',
  'settings.conflict.rename.hint': '同名文件保留，新产物自动加序号',
  'settings.conflict.overwrite': '取而代之',
  'settings.conflict.overwrite.hint': '直接覆盖同名文件，旧产物不再保留',
  'settings.conflict.skip': '略过',
  'settings.conflict.skip.hint': '同名文件已存在时不再转换',

  /* ---- 并发上限 ---- */
  'settings.concurrency.title': '并发上限',
  'settings.concurrency.hint': '同时最多调律几个任务。越大越吃 CPU，界面也越容易卡。',
  'settings.concurrency.label': '同时最多',

  /* ---- 引擎未备时跳过 ---- */
  'settings.skip.title': '引擎未备时跳过',
  'settings.skip.hint':
    '引擎尚未备妥的文件不会先排进队列干等，直接略过——之后补好引擎再拖一次即可。',
  'settings.skip.label': '引擎未备',
  'settings.skip.checkbox': '引擎未备时跳过',

  /* ---- GPU 硬件编码 ---- */
  'settings.gpu.title': 'GPU 硬件编码',
  'settings.gpu.hint':
    '用 NVIDIA 显卡编码视频，速度优先。只在难编的素材上是净赚（实测同规格下 3.89s → 2.89s），好编的素材反而更慢（1.77s → 2.16s），所以默认不开。没卡或驱动不支持时会自动改用 CPU。',
  'settings.gpu.label': '硬件编码',
  'settings.gpu.checkbox': '速度优先（GPU）',

  /* ---- 转换完成之后 ---- */
  'settings.after.title': '转换完成之后',
  'settings.after.label': '完成后',
  'settings.after.none': '什么都不做',
  'settings.after.none.hint': '默认：不动你的剪贴板',
  'settings.after.copyPath': '复制路径',
  'settings.after.copyPath.hint': '把产物的完整路径放进剪贴板',
  'settings.after.copyFile': '复制产物本身',
  'settings.after.copyFile.hint':
    '把文件放进剪贴板，可以直接粘到别处；产物偏大时会改成复制路径并说明',
  'settings.after.openFolder': '打开目录',
  'settings.after.openFolder.hint': '在资源管理器里打开并选中产物',
  // ⚠️ 这四条是**一段话的四个分片**，界面上按这个顺序拼接（见文件头第 2 条约定）。
  'settings.after.hint1': '省掉「去文件夹里找」那一步：转换完成后直接把它送到手边。',
  'settings.after.hint2':
    '⚠️ 只有 1 个文件转完时才会自动做这件事——一次转几十个的时候剪贴板只有一个格子，',
  'settings.after.hint3': '我们无从知道你要的是哪一个，那种情况下请用卡片上的按钮逐个点。',
  'settings.after.hint4':
    '⚠️ 剪贴板随时会被别的程序接管，所以复制之后会留一条回执，写着复制的是什么，并给你一次「再复制一次」。',

  /* ---- 系统集成（M8）---- */
  'settings.integration.title': '系统集成',
  'settings.integration.hint1':
    '两个入口都是「把文件交给转换器，不用先打开应用」，做的是同一件事，可以各开各的。',
  'settings.integration.hint2': '两者都只在当前用户下生效，都不需要管理员。',
  'settings.integration.menu': '右键菜单',
  'settings.integration.menu.checkbox': '在资源管理器里加一项「用调律者转换」',
  'settings.integration.menu.win11':
    '⚠️ Windows 11 的新版右键菜单默认不显示这一类菜单项，要按 Shift+F10 或点「显示更多选项」才看得到——这是系统行为，不是没装成功。',
  'settings.integration.error': '注册表操作失败：{msg}',
  'settings.integration.mismatchOn': '设置里开着，但注册表里没有这一项。重新开关一次即可补上。',
  'settings.integration.mismatchOff':
    '注册表里还留着这一项（设置里已是关闭）。重新开关一次即可清掉。',
  'settings.sendTo.label': '发送到',
  'settings.sendTo.checkbox': '在「发送到」菜单里加一项',
  'settings.sendTo.note':
    '右键 →「发送到」是一级菜单，比上面那一项少两步，也不用教用户按 Shift+F10。 它不写注册表，只在你的「发送到」文件夹里放一个快捷方式，关掉开关或卸载时删掉。 多选时会一次把它们全部收进队列，而右键菜单那一项只认得第一个文件。',
  'settings.sendTo.error': '快捷方式操作失败：{msg}',
  'settings.sendTo.mismatchOn': '设置里开着，但那个快捷方式不在。重新开关一次即可补上。',
  'settings.sendTo.mismatchOff':
    '「发送到」里还留着那个快捷方式（设置里已是关闭）。重新开关一次即可清掉。',

  /* ---- 重命名即转换（M8）---- */
  'settings.rename.title': '重命名即转换',
  // ⚠️ 同样是**一段话的四个分片**（见文件头第 2 条约定）。
  'settings.rename.hint1': '在下面这些文件夹里，把 a.mkv 改名成 a.mp4，就自动按 mp4 重转一遍——',
  'settings.rename.hint2': '相当于用改名表达「我要这个格式」。只认视频 / 音频 / 图片三类，',
  'settings.rename.hint3': '且源与目标都必须是能力矩阵里真有的组合。',
  'settings.rename.hint4': '⚠️ 源文件不会被删：它会被改回原来的名字原样留着，你随时能反悔。',
  'settings.rename.label': '开关',
  'settings.rename.checkbox': '在下面的文件夹里，改扩展名就等于要求转换',
  'settings.rename.note': '默认关闭。关着的时候我们不装任何目录监听，对你的磁盘完全无感。',
  'settings.rename.noDirs':
    '开关是打开的，但一个文件夹都没选——现在还什么都不会发生。请在下面加一个。',
  'settings.rename.dirs': '文件夹',
  'settings.rename.dirs.empty': '还没有选择文件夹',
  'settings.rename.remove': '移除',
  'settings.rename.addDir': '添加文件夹…',
  'settings.rename.watchNote':
    '只监听这一层，不递归子文件夹。删除一个文件夹条目只是不再监听它， 不会碰里面的任何文件。',

  /* ---- 快捷键（E-7）---- */
  'settings.shortcuts.title': '快捷键',
  'settings.shortcuts.hint':
    '只在工作台生效。焦点在输入框里时 Enter 归输入框——用拼音选词的那一下回车不会启动队列。',
  'settings.shortcuts.pickFiles': '收入文件（同「收入文件」按钮）',
  'settings.shortcuts.start': '开始调律（队列里有待跑的才有用）',
  'settings.shortcuts.cancelRunning': '取消正在跑的转换——源文件一个字节都不动，随时可以重跑'
} as const

export const settingsEn: Record<keyof typeof settingsZh, string> = {
  'settings.language': 'Interface language',
  'settings.language.system': 'Match system',
  // ⚠️ 这一条**故意**是中文，别「修」它：语言选择器里 Chinese 的正确写法就是
  // 这两个字，翻成 "Chinese" 反而让只会中文的用户在英文界面里找不到自己的语言。
  // `test-i18n.ts` 的 `EN_CJK_ALLOWED` 就是为它开的口子。
  'settings.language.zh': '中文',
  'settings.language.en': 'English',
  'settings.language.hint':
    'With “Match system”, a Chinese system gets Chinese and everything else gets English. Switching takes effect immediately — no restart. The right-click menu and “Send to” follow the next time they are refreshed.',

  /* ---- 页面外壳 ---- */
  'settings.title': 'Format settings',
  'settings.loading': 'Loading settings…',

  /* ---- 设置文件读不动时的告警 ---- */
  'settings.corruption.title': 'The settings file could not be read, so it was reset to defaults',
  // ⚠️ 结尾那个空格是承重的：它后面紧跟着一个文件名 / 一句原因（见文件头第 3 条约定）。
  'settings.corruption.file': 'File that failed: ',
  'settings.corruption.reason': 'Reason: ',
  'settings.corruption.kept':
    'The original file is still where it was (renaming it aside failed), but nothing has overwritten its contents — copy it out before you change any setting, or the next write will overwrite it.',
  'settings.corruption.quarantined':
    'The original file was kept as {path}, and not one byte of it was touched.',

  /* ---- 各类别默认目标 ---- */
  'settings.category.title': 'Default target per category',
  'settings.category.hint':
    'Falls back to that format’s default target when the source format is unsupported',
  'settings.category.inherit': 'Depends on source format',

  /* ---- 输出目录 ---- */
  'settings.output.title': 'Output folder',
  'settings.output.where': 'Write to',
  'settings.output.beside': 'Source file’s folder',
  'settings.output.custom': 'Chosen folder',
  'settings.output.unset': 'Not chosen yet',
  'settings.output.dir': 'Folder',
  'settings.output.change': 'Change',

  /* ---- 同名文件 ---- */
  'settings.conflict.title': 'Name collisions',
  'settings.conflict.label': 'If it exists',
  'settings.conflict.rename': 'Give it a new name',
  'settings.conflict.rename.hint': 'Keeps the existing file and numbers the new result',
  'settings.conflict.overwrite': 'Replace it',
  'settings.conflict.overwrite.hint': 'Overwrites the file of that name; the old one is not kept',
  'settings.conflict.skip': 'Skip it',
  'settings.conflict.skip.hint': 'Does not convert when a file of that name already exists',

  /* ---- 并发上限 ---- */
  'settings.concurrency.title': 'Concurrency limit',
  'settings.concurrency.hint':
    'How many tasks to tune at the same time. Higher values use more CPU and make the interface laggier.',
  'settings.concurrency.label': 'Max at once',

  /* ---- 引擎未备时跳过 ---- */
  'settings.skip.title': 'Skip when the engine is not ready',
  'settings.skip.hint':
    'Files whose engine is not ready yet are skipped instead of waiting in the queue — install the engine and drag them in again.',
  'settings.skip.label': 'Engine missing',
  'settings.skip.checkbox': 'Skip when the engine is not ready',

  /* ---- GPU 硬件编码 ---- */
  'settings.gpu.title': 'GPU hardware encoding',
  'settings.gpu.hint':
    'Encodes video on your NVIDIA card, favoring speed. It is a clear win only on hard-to-encode footage (measured 3.89s → 2.89s at the same settings) and is actually slower on easy footage (1.77s → 2.16s), so it is off by default. Falls back to the CPU when there is no card or the driver does not support it.',
  'settings.gpu.label': 'Hardware encoding',
  'settings.gpu.checkbox': 'Favor speed (GPU)',

  /* ---- 转换完成之后 ---- */
  'settings.after.title': 'After a conversion',
  'settings.after.label': 'When done',
  'settings.after.none': 'Do nothing',
  'settings.after.none.hint': 'Default: leaves your clipboard alone',
  'settings.after.copyPath': 'Copy the path',
  'settings.after.copyPath.hint': 'Puts the full path of the result on the clipboard',
  'settings.after.copyFile': 'Copy the result itself',
  'settings.after.copyFile.hint':
    'Puts the file on the clipboard so you can paste it elsewhere; a large result falls back to copying the path, and says so',
  'settings.after.openFolder': 'Open the folder',
  'settings.after.openFolder.hint': 'Opens the folder in Explorer with the result selected',
  'settings.after.hint1':
    'Saves you the trip to the folder: the result is put right at hand once it is done.',
  // ⚠️ 这三条以空格开头，为的是与上一条拼起来时两句话之间有个空格（见文件头第 3 条约定）。
  'settings.after.hint2':
    ' ⚠️ This only happens by itself when exactly one file finishes — with dozens of files converted at once there is only one clipboard slot,',
  'settings.after.hint3':
    ' and there is no way for us to know which one you want, so use the buttons on the cards to copy them one at a time.',
  'settings.after.hint4':
    ' ⚠️ Another program can take the clipboard over at any moment, so after copying we leave a receipt saying what was copied and give you one chance to copy it again.',

  /* ---- 系统集成（M8）---- */
  'settings.integration.title': 'System integration',
  'settings.integration.hint1':
    'Both entries do the same job — hand a file to the converter without opening the app first — and you can turn either one on by itself.',
  'settings.integration.hint2':
    ' Both apply to the current user only, and neither needs administrator rights.',
  'settings.integration.menu': 'Right-click menu',
  'settings.integration.menu.checkbox': 'Add “Convert with Arbiter” in Explorer',
  'settings.integration.menu.win11':
    '⚠️ The new Windows 11 right-click menu hides this kind of entry by default: press Shift+F10 or pick “Show more options” to see it. That is how the system behaves, not a failed install.',
  'settings.integration.error': 'Registry operation failed: {msg}',
  'settings.integration.mismatchOn':
    'It is on in settings, but the registry has no such entry. Toggle it off and on to add it.',
  'settings.integration.mismatchOff':
    'The registry still has this entry (settings say off). Toggle it off and on to clear it.',
  'settings.sendTo.label': 'Send to',
  'settings.sendTo.checkbox': 'Add an entry to the “Send to” menu',
  'settings.sendTo.note':
    'Right-click → “Send to” is a first-level menu: two steps fewer than the entry above, and no need to teach anyone Shift+F10. It writes nothing to the registry — it only puts a shortcut in your “Send to” folder, and removes it when you turn the switch off or uninstall. With several files selected it takes them all in at once, while the right-click entry only ever sees the first file.',
  'settings.sendTo.error': 'Shortcut operation failed: {msg}',
  'settings.sendTo.mismatchOn':
    'It is on in settings, but the shortcut is not there. Toggle it off and on to add it.',
  'settings.sendTo.mismatchOff':
    'The shortcut is still in “Send to” (settings say off). Toggle it off and on to clear it.',

  /* ---- 重命名即转换（M8）---- */
  'settings.rename.title': 'Convert on rename',
  'settings.rename.hint1':
    'In the folders below, renaming a.mkv to a.mp4 converts it to mp4 again automatically —',
  'settings.rename.hint2':
    ' it is how you ask for a format by renaming. Only video / audio / image count,',
  'settings.rename.hint3':
    ' and both the source and the target have to be a combination that really exists in the capability matrix.',
  'settings.rename.hint4':
    ' ⚠️ The source file is never deleted: it is renamed back and kept exactly as it was, so you can change your mind at any time.',
  'settings.rename.label': 'Switch',
  'settings.rename.checkbox': 'In the folders below, changing an extension means “convert it”',
  'settings.rename.note':
    'Off by default. While it is off we install no folder watchers at all, so your disk is entirely untouched.',
  'settings.rename.noDirs':
    'The switch is on but no folder is chosen yet, so nothing will happen. Add one below.',
  'settings.rename.dirs': 'Folders',
  'settings.rename.dirs.empty': 'No folder chosen yet',
  'settings.rename.remove': 'Remove',
  'settings.rename.addDir': 'Add folder…',
  'settings.rename.watchNote':
    'Only this level is watched, not subfolders. Removing a folder entry only stops watching it; nothing inside it is touched.',

  /* ---- 快捷键（E-7）---- */
  'settings.shortcuts.title': 'Keyboard shortcuts',
  'settings.shortcuts.hint':
    'They only work on the workbench. When the focus is in a text field, Enter belongs to that field — the Enter you press to pick a pinyin candidate will not start the queue.',
  'settings.shortcuts.pickFiles': 'Add files (same as the “Add files” button)',
  'settings.shortcuts.start': 'Start tuning (only does something when a task is waiting)',
  'settings.shortcuts.cancelRunning':
    'Cancel the running conversion — not a single byte of the source file is touched, and you can run it again any time'
}
