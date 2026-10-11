/**
 * 文件夹递归扫描（folderScan.ts）：排除/跳过的原因、确认框正文与按钮、上限提示。
 *
 * ⚠️ 这一类与渲染层那几块有一个**关键差别**：它们的文字**由主进程产出**，
 * 而其中一部分由 OS 去画（原生对话框、系统通知、注册表菜单、快捷方式描述）——
 * 渲染进程根本不在场。所以取词必须走 `@shared/i18n` 那份**模块级全局**
 * （见 `core/locale.ts`），不能「把语言传进来」：那些调用点拿不到「这是哪个界面」。
 *
 * ⚠️ 中文值必须与迁移前逐字节相同——闸门 d 逐值比对冻结快照。
 *
 * ## 两条搬运约定（与 `parts/settings.ts` 的 2 / 3 同源）
 *
 * 1. **源码里用 `+` 拼起来的确认框正文，按原来的分段各占一条键**
 *    （`folderScan.prompt.truncated*` 那两条）。合成一整句读起来更整齐，但冻结快照是按
 *    **源码里的字面量**冻的：快照里只有那些分片、没有拼起来的那一整句，合成一条会被
 *    闸门 d 判成「改写了一句中文」。那两段在弹框里本来就是拼着渲染的，分成两条
 *    **渲染结果一字不差**。
 *    ⚠️ 英文那一条**以空格开头是刻意的**：中文靠「。」断句、句间不需要空格，而英文需要。
 *    拼起来之后那个空格必须来自某一侧，所以它落在英文那一侧。别顺手 trim 掉。
 * 2. **「N 个文件」那三处各占两个 key（`.one` / `.other`）**，判据在调用点上
 *    （`total === 1`）。这是全仓唯一需要复数词形的地方：英文的 `1 file` 与 `2 files`
 *    不同形，而中文那侧两个值一样——**两侧的占位符仍必须一致**（闸门 c 逐 key 比
 *    占位符集合），所以 `.one` 也带 `{total}`，调用时传 `1` 进去。
 *    其余带数字的句子一律**把数字移出主句**：写成「标签: 数字」或者把名词去掉
 *    （「已扫过 {dirs} 个目录」→ `Directories scanned: {dirs}`、「{count} 个目录读不了」→
 *    `{count} could not be read`）。判据是**不出现 `1 folders` 这种形状**——
 *    中文那侧量不出差别（汉语没有复数变化），所以这一条只能靠人写对。
 */

export const folderScanZh = {
  /* ---- 排除 / 跳过的理由（进 `ScanSkip.reason`，直接显示给用户） ---- */
  'folderScan.skip.byName': '按默认排除清单跳过（{name}），未扫描',
  'folderScan.skip.byPrefix': '按默认排除清单跳过（{name}*），未扫描',
  'folderScan.skip.bySystemRoot': '按默认排除清单跳过（系统目录 {root}），未扫描',
  'folderScan.skip.cycle': '重复目录（符号链接指向同一处或成环），未重复扫描',
  'folderScan.skip.unreadable': '无法读取（{code}），已跳过',
  'folderScan.errno.unknown': '未知错误',

  /* ---- 列表分隔符与「等 N 个」 ---- */
  // `、` 与 `；` 是**标点，但它们是文案**：英文那一侧分别是 `, ` 与 `; `
  //（半角 + 一个空格），所以它们必须走字典，不能在代码里写死。
  'folderScan.sep.names': '、',
  'folderScan.sep.summary': '；',
  'folderScan.sample.more': '{names} 等 {count} 个',

  /* ---- 确认框：标题与正文（`message` / `detail`） ---- */
  'folderScan.prompt.message.one': '将加入 {total} 个文件',
  'folderScan.prompt.message.other': '将加入 {total} 个文件',
  'folderScan.prompt.root': '文件夹：{path}',
  'folderScan.prompt.scanned': '已扫过 {dirs} 个目录，其中认得的目标文件 {total} 个。',
  'folderScan.prompt.truncatedLimit': '⚠️ 已达扫描上限 {limit}，这个文件夹里还有没扫到的部分。',
  'folderScan.prompt.truncatedRest': '这次只会加入前 {total} 个，剩下的请再选一次更小的文件夹。',
  'folderScan.prompt.topCount': '其中直接躺在这一层里的有 {count} 个。',
  'folderScan.prompt.excluded': '按默认排除清单跳过了 {count} 个目录：{names}。',
  'folderScan.prompt.skipped': '有 {count} 个目录读不了（权限不足或已不存在），已跳过：{names}。',

  /* ---- 确认框：三颗按钮（`ScanPrompt.buttons`，下标与 `choices` 一一对应） ---- */
  'folderScan.button.addCapped': '加入这 {total} 个（已达上限）',
  'folderScan.button.add.one': '加入这 {total} 个文件',
  'folderScan.button.add.other': '加入这 {total} 个文件',
  'folderScan.button.topOnly': '只加这一层（{count} 个）',
  'folderScan.button.cancel': '取消',

  /* ---- 报告出口：「未收入队列」那张清单的行 ---- */
  'folderScan.report.more': '…另有 {count} 个目录',
  'folderScan.report.sameExcluded': '同上（按默认排除清单跳过）',
  'folderScan.report.sameSkipped': '同上（读不了的目录）',
  'folderScan.report.limit': '已达扫描上限 {limit}',
  'folderScan.report.limitReason': '文件夹里还有没扫到的部分，剩下的请再选一次更小的文件夹',

  /* ---- 一句话汇总（界面上的 toast） ---- */
  'folderScan.summary.found.one': '找到 {count} 个文件',
  'folderScan.summary.found.other': '找到 {count} 个文件',
  'folderScan.summary.capped': '已达上限 {limit}，还有没扫到的',
  'folderScan.summary.excluded': '按清单跳过 {count} 个目录',
  'folderScan.summary.unreadable': '{count} 个目录读不了'
} as const

export const folderScanEn: Record<keyof typeof folderScanZh, string> = {
  /* ---- 排除 / 跳过的理由 ---- */
  'folderScan.skip.byName': 'Skipped by the default exclusion list ({name}), not scanned',
  'folderScan.skip.byPrefix': 'Skipped by the default exclusion list ({name}*), not scanned',
  'folderScan.skip.bySystemRoot':
    'Skipped by the default exclusion list (system directory {root}), not scanned',
  'folderScan.skip.cycle':
    'Duplicate directory (symlink to the same place, or a cycle) — not scanned again',
  'folderScan.skip.unreadable': 'Could not read ({code}), skipped',
  'folderScan.errno.unknown': 'unknown error',

  /* ---- 列表分隔符与「等 N 个」 ---- */
  'folderScan.sep.names': ', ',
  'folderScan.sep.summary': '; ',
  'folderScan.sample.more': '{names} and {count} more',

  /* ---- 确认框：标题与正文 ---- */
  'folderScan.prompt.message.one': 'Add {total} file',
  'folderScan.prompt.message.other': 'Add {total} files',
  'folderScan.prompt.root': 'Folder: {path}',
  // ⚠️ 这一条刻意写成**「标签: 数字」**的形状：`{dirs} folders` 在 dirs=1 时是
  // `1 folders`，而按 plan §复数那样为它再开一对 key 不划算（见文件头第 2 条）。
  'folderScan.prompt.scanned': 'Directories scanned: {dirs}. Recognized target files: {total}.',
  // ⚠️ 下面这一条**以空格开头**：它要与上一条 `+` 拼成一句话，两段之间那个空格
  // 只能来自某一侧（中文那侧是「。」，不需要空格）。别 trim。
  'folderScan.prompt.truncatedLimit':
    '⚠️ Scan limit of {limit} reached — some parts of this folder were not scanned.',
  'folderScan.prompt.truncatedRest':
    ' Only the first {total} will be added; pick a smaller folder to get the rest.',
  'folderScan.prompt.topCount': 'Directly in this folder: {count}.',
  'folderScan.prompt.excluded':
    'Skipped by the default exclusion list: {names} — {count} in total.',
  'folderScan.prompt.skipped':
    'Could not read (no permission, or gone) — skipped: {names}; {count} in total.',

  /* ---- 确认框：三颗按钮 ---- */
  'folderScan.button.addCapped': 'Add {total} (limit reached)',
  'folderScan.button.add.one': 'Add this {total} file',
  'folderScan.button.add.other': 'Add these {total} files',
  'folderScan.button.topOnly': 'Top level only ({count})',
  'folderScan.button.cancel': 'Cancel',

  /* ---- 报告出口 ---- */
  'folderScan.report.more': '…and {count} more',
  'folderScan.report.sameExcluded': 'Same as above (skipped by the default exclusion list)',
  'folderScan.report.sameSkipped': 'Same as above (folders that could not be read)',
  'folderScan.report.limit': 'Scan limit {limit} reached',
  'folderScan.report.limitReason':
    'Some parts of this folder were not scanned; pick a smaller folder to get the rest',

  /* ---- 一句话汇总 ---- */
  'folderScan.summary.found.one': 'Found {count} file',
  'folderScan.summary.found.other': 'Found {count} files',
  'folderScan.summary.capped': 'Limit of {limit} reached — some were not scanned',
  // 这两条同样把名词移出主句：`{count} folders` 在 count=1 时是 `1 folders`。
  'folderScan.summary.excluded': '{count} skipped by the list',
  'folderScan.summary.unreadable': '{count} could not be read'
}
