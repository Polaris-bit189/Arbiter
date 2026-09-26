/**
 * 历史页的文案。
 *
 * ⚠️ 中文值必须与迁移前源码里的字面量**逐字节相同**——闸门 d 会拿冻结快照逐值比对。
 * 迁移的时候是「把字面量搬进来、原样不动」，不是「顺手把哪句读着别扭的话改通顺」。
 *
 * ## 三处「一句话拆成两个 key」是**被闸门 d 逼出来的**，不是随手拆的
 *
 * 快照的取材口径是「按 `{` / `}` / `<` / `>` 切开的极大文本段」（`test-i18n.ts` 文件头
 * 写着这条），于是 JSX 文本里嵌了表达式的句子在快照里**本来就是两段**：
 *
 * | 源码                              | 快照里的两段                                       |
 * | --------------------------------- | -------------------------------------------------- |
 * | `重跑失败（{failedIds.length}）`  | `重跑失败（` / `）`                                |
 * | `这 {n} 条的目标位置已经…`        | `这` / `条的目标位置已经有同名产物了——要怎么处理？` |
 * | `重跑：收入 {report.added} 个`    | `重跑：收入` / `个`                                |
 *
 * 把它们合成一句 `'这 {n} 条…'` 是**写得出、但闸门 d 必红**的：`stripPlaceholders`
 * 抹掉占位符之后是 `这  条…`（两段直接相接），而快照里没有这一串。所以这里保持
 * 「一段一个 key」，渲染出来的字与迁移前**一模一样**。
 * ⚠️ **不要为了好看把它们合成一个 key**——那会让闸门 d 报出三条「改写了一句中文」，
 * 而按那份文件的规矩，往 `NEW_SINCE_FREEZE` 里加一条来放行正是它要防的事。
 */

export const historyZh = {
  'history.title': '历史记录',
  'history.subtitle': '万般格式，各归其所',
  'history.subtitleCount': ' · 共 {n} 条痕迹',

  'history.filter.allCategories': '全部类别',

  'history.range.all': '全部',
  'history.range.today': '今日',
  'history.range.week': '近七日',
  'history.range.month': '近一月',

  // 相对时刻（`formatWhen`）。分档逻辑留在源码里，这里只出词——每一档一句，
  // 别合成「{n} {unit}前」：英文的 min / h / d 与中文的「分钟 / 小时 / 天」不是
  // 一个词表能对的（`libs.ts` 的 `eta.*` 同理）。
  'history.when.justNow': '方才',
  'history.when.minutes': '{n} 分钟前',
  'history.when.hours': '{n} 小时前',
  'history.when.days': '{n} 天前',

  'history.elapsed.unknown': '未详',
  'history.elapsed.milliseconds': '{n} 毫秒',
  'history.elapsed.seconds': '{n} 秒',
  'history.elapsed.minutes': '{m} 分',
  'history.elapsed.minutesSeconds': '{m} 分 {s} 秒',

  'history.status.done': '已成',
  'history.status.error': '未成',
  'history.status.canceled': '中止',

  'history.row.reveal': '打开位置',
  'history.row.rerun': '再行调律',
  'history.row.remove': '抹去这一条',

  'history.column.file': '文件',
  'history.column.size': '体积',
  'history.column.elapsed': '耗时',
  'history.column.category': '类别',
  'history.column.time': '时刻',
  'history.column.status': '结局',
  'history.column.actions': '操作',

  // 「重跑失败（N）」——表头与尾括号两个 key（理由见文件头）。
  'history.rerunFailed.none': '当前筛选里没有失败的条目',
  'history.rerunFailed.title': '重跑当前筛选里失败的 {n} 条',
  'history.rerunFailed.labelLead': '重跑失败（',
  'history.rerunFailed.labelTail': '）',

  'history.clear.arming': '再点一次以抹去全部',
  'history.clear.label': '抹去痕迹',

  // 「这 N 条的目标位置…」——同样是两段（理由见文件头）。
  'history.conflict.titleLead': '这',
  'history.conflict.titleTail': '条的目标位置已经有同名产物了——要怎么处理？',
  'history.conflict.hint': '目前一条都还没有入队。选「另存一份」会保留已有产物，新产物另起名字。',
  'history.conflict.rename': '另存一份（推荐）',
  'history.conflict.overwrite': '覆盖原产物',
  'history.conflict.cancel': '先不重跑',

  // 「重跑：收入 N 个」——同样是两段（理由见文件头）。
  'history.report.summaryLead': '重跑：收入',
  'history.report.summaryTail': '个',
  'history.report.rejected': '，{n} 个没能收入',
  'history.report.policyChanged':
    '同时把你的「同名文件」设置改成了刚选的那一档——之后的转换都会照此执行， 可在格式设置里改回。',
  'history.report.collapse': '收起',

  'history.toast.missing': '原处已无此物',
  'history.toast.added': '已收入 {n} 个，归于队列',
  'history.toast.rejected': '{n} 条没能收入队列',
  'history.toast.cleared': '已抹去 {n} 条痕迹',

  'history.empty.noEntries': '尚无文件留下痕迹',
  'history.empty.noEntriesHint': '调律过的文件都会在此留名',
  'history.empty.noMatch': '此地无符合条件的痕迹',
  'history.empty.noMatchHint': '换个筛选再来看看'
} as const

export const historyEn: Record<keyof typeof historyZh, string> = {
  'history.title': 'History',
  'history.subtitle': 'Every format, to its rightful place',
  'history.subtitleCount': ' · {n} traces in all',

  'history.filter.allCategories': 'All categories',

  'history.range.all': 'All time',
  'history.range.today': 'Today',
  'history.range.week': 'Last 7 days',
  'history.range.month': 'Last 30 days',

  // 单字母后缀照 `libs.ts` 的 `eta.*`（`{n}s left`）——同一块界面上两种量纲写法
  // 并排出现会显得是两套东西。
  'history.when.justNow': 'Just now',
  'history.when.minutes': '{n}m ago',
  'history.when.hours': '{n}h ago',
  'history.when.days': '{n}d ago',

  'history.elapsed.unknown': 'Unknown',
  'history.elapsed.milliseconds': '{n} ms',
  'history.elapsed.seconds': '{n}s',
  'history.elapsed.minutes': '{m}m',
  'history.elapsed.minutesSeconds': '{m}m {s}s',

  // 三态徽章：`.badge` 那一行只有 12px 的行内图标加两个字的宽度，所以用单词不用短语。
  'history.status.done': 'Done',
  'history.status.error': 'Failed',
  'history.status.canceled': 'Canceled',

  'history.row.reveal': 'Show in folder',
  'history.row.rerun': 'Convert again',
  'history.row.remove': 'Remove this entry',

  'history.column.file': 'File',
  'history.column.size': 'Size',
  'history.column.elapsed': 'Took',
  'history.column.category': 'Category',
  'history.column.time': 'When',
  'history.column.status': 'Result',
  'history.column.actions': 'Actions',

  // ⚠️ 中英两侧的括号刻意不同形：中文那半是**全角**的 `（`，而英文这里用半角 `(`。
  // 值仍然由两个 key 拼出来，换语言时两边一起换，不会出现「前半全角后半半角」。
  'history.rerunFailed.none': 'Nothing failed in the current filter',
  'history.rerunFailed.title': 'Re-run the {n} failed items in the current filter',
  'history.rerunFailed.labelLead': 'Re-run failed (',
  'history.rerunFailed.labelTail': ')',

  'history.clear.arming': 'Click again to erase everything',
  'history.clear.label': 'Erase history',

  'history.conflict.titleLead': 'These',
  'history.conflict.titleTail':
    'targets already have a file with the same name — how should this be handled?',
  'history.conflict.hint':
    'Nothing has been queued yet. Choosing “Save a copy” keeps the existing file and gives the new one a fresh name.',
  'history.conflict.rename': 'Save a copy (recommended)',
  'history.conflict.overwrite': 'Overwrite the existing file',
  'history.conflict.cancel': 'Skip for now',

  // ⚠️ 首尾**不带空格**：这一句由 JSX 用空格把两半与数字拼起来
  // （`{lead} {n} {tail}`），值里再写一个空格会渲染成两个。
  'history.report.summaryLead': 'Re-run:',
  'history.report.summaryTail': 'queued',
  'history.report.rejected': ', {n} could not be queued',
  'history.report.policyChanged':
    'Your “Files with the same name” setting was also switched to the option you just picked — later conversions will follow it too. You can change it back in Format settings.',
  'history.report.collapse': 'Collapse',

  'history.toast.missing': 'It is no longer there',
  'history.toast.added': 'Queued {n} — they are in the list now',
  'history.toast.rejected': '{n} could not be queued',
  'history.toast.cleared': 'Erased {n} traces',

  'history.empty.noEntries': 'No files have left a trace yet',
  'history.empty.noEntriesHint': 'Every file you convert is recorded here',
  'history.empty.noMatch': 'No traces match here',
  'history.empty.noMatchHint': 'Try a different filter'
}
