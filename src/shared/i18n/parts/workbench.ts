/**
 * 工作台页 / 任务卡 / 列表的文案。
 *
 * ⚠️ 中文值必须与迁移前源码里的字面量**逐字节相同**——闸门 d 会拿冻结快照逐值比对。
 * 迁移的时候是「把字面量搬进来、原样不动」，不是「顺手把哪句读着别扭的话改通顺」。
 *
 * ## 数字与那个空格归谁：三种写法，**都是闸门 d 逼出来的**
 *
 * 快照的取材口径是「按 `{` / `}` / `<` / `>` 切开的**极大文本段**」，JSX 文本还会被
 * `trim()` 掉首尾空白；而闸门 d 把字典值里的 `{...}` 抹掉之后与快照**逐字节**比。
 * 于是页面上这几处「一段中文 + 一个数字」按表达式落在哪一侧分三种写法：
 *
 * | 源码                              | 写法                                                       |
 * | --------------------------------- | ---------------------------------------------------------- |
 * | `文件 <span>{total}</span>`       | 值只写 `文件`，数字与空格留在 JSX 里（`{t(…)} <span>`）     |
 * | `{n} 项未能收入队列` / `…转成了 {ext}` | 同上，值是光秃秃那句话                        |
 * | `开始调律（{queued}）`            | **拆成 lead / tail 两个 key**（理由见下）                   |
 *
 * 前两种把 `{count} ` 写进值里的话，抹掉占位符之后会多一个空格，闸门 d 直接红。
 *
 * 第三种是**写得出、但闸门 d 必红**的：`开始调律（{count}）` 抹掉占位符是
 * `开始调律（）`，而快照里根本没有这一串——它那里是 `开始调律（` 与 `）` **两段**。
 * ⚠️ **不要为了好看把它们合成一个 key**（那样得往 `NEW_SINCE_FREEZE` 里加一条来放行，
 * 而那份名单只收**冻结之后新写的句子**，这句不是）。与 `history.ts` 文件头同一条规矩：
 * 一段一个 key，渲染出来的字与迁移前**一模一样**。
 *
 * 中文的 `（` / `）` 与英文的 `(` / `)` 不同形，但两边一起换，不会出现「前半全角后半半角」。
 */

export const workbenchZh = {
  'workbench.pageTitle': '调律工作台',

  /* ---- 顶部工具条 ---- */
  'workbench.pickFiles': '收入文件',
  'workbench.pickFilesTitle': '收入文件（Ctrl+O）',
  'workbench.pickFolder': '收入文件夹',
  'workbench.pickFolderTitle':
    '选一个文件夹：会扫它的子文件夹，先把「将加入 N 个文件」给你确认一次，点了才入队',
  'workbench.clear': '清空',
  'workbench.applyAll': '全部转为',
  'workbench.selectTarget': '选择目标格式',

  /* ---- 表头与底栏 ---- */
  'workbench.headerFiles': '文件',
  'workbench.colFile': '文件',
  'workbench.colSize': '大小',
  'workbench.colTarget': '目标格式',
  'workbench.colStatus': '状态',
  'workbench.colActions': '操作',
  'workbench.slogan': '一切转换，尽在本机之中',
  'workbench.running': '运行中',
  'workbench.limit': '上限',
  // 「开始调律（N）」——表头与尾括号两个 key（理由见文件头）。
  'workbench.startLead': '开始调律（',
  'workbench.startTail': '）',
  'workbench.startTitle': '开始调律（Enter）',

  /* ---- 回执（toast） ---- */
  'workbench.toast.settled': '万般格式，各归其所',
  'workbench.toast.applied': '已将 {count} 个目标格式设为 {ext}',
  'workbench.toast.noApplicable': '没有适用此行事的文件',
  'workbench.toast.noKnownFiles': '此处没有认得的文件',
  'workbench.toast.allSkipped': '一个文件也没收进来，{count} 项被跳过（见下方清单）',
  'workbench.toast.partialAdded': '收入 {added} 个，另有 {rejected} 项没有收入（见下方清单）',
  'workbench.toast.added': '收入 {count} 个，可以开始调律了',
  'workbench.toast.canceled': '已取消 {count} 个转换（源文件一个字节没动，可以重跑）',

  /* ---- 任务卡：状态徽章 ---- */
  'workbench.status.queued': '等待中',
  'workbench.status.waitingEngine': '等待引擎',
  'workbench.status.running': '调律中…',
  'workbench.status.done': '已成',
  'workbench.status.error': '失败',
  'workbench.status.canceled': '已止',

  /* ---- 任务卡：行内文字 ---- */
  'workbench.convertFailed': '转换失败',
  'workbench.outputSize': '产物体积',
  'workbench.presetHint': '上次这类文件转成了',

  /* ---- 任务卡：操作列 ---- */
  'workbench.action.cancel': '中止',
  'workbench.action.options': '参数',
  'workbench.action.optionsTitle': '设置转换参数',
  'workbench.action.optionsTitleRunning': '转换中不能改参数',
  'workbench.action.retry': '再行调律',
  'workbench.action.log': '日志',
  'workbench.action.reveal': '打开位置',
  'workbench.action.revealTitle': '在文件夹中显示',
  'workbench.action.remove': '删除',
  'workbench.share.copyPath': '复制路径',
  'workbench.share.copyFile': '复制产物',
  'workbench.share.copyPathTitle': '把产物路径放进剪贴板',
  'workbench.share.copyFileTitle': '把产物放进剪贴板',

  /* ---- 被拒清单与空状态 ---- */
  'workbench.rejectedCount': '项未能收入队列',
  'workbench.rejectedDismiss': '收起',
  'workbench.emptyTitle': '此处尚空，静候文件入列',
  'workbench.emptyHint': '拖入文件，或点上方「收入文件」'
} as const

/**
 * ⚠️ 这一侧刻意比中文短：操作列只有 110px 宽、行高写死 56px，按钮是换行排的。
 * 「打开位置」「复制路径」直译成 "Show in folder" / "Copy output path" 会把
 * 失败行（三样按钮）挤到第四行，整张表被撑变形——所以取的是最短的那几个常见词。
 */
export const workbenchEn: Record<keyof typeof workbenchZh, string> = {
  'workbench.pageTitle': 'Workbench',

  'workbench.pickFiles': 'Add files',
  'workbench.pickFilesTitle': 'Add files (Ctrl+O)',
  'workbench.pickFolder': 'Add folder',
  'workbench.pickFolderTitle':
    'Pick a folder: subfolders are scanned, and you get to confirm an “N files will be added” list before anything is queued',
  'workbench.clear': 'Clear',
  'workbench.applyAll': 'Convert all to',
  'workbench.selectTarget': 'Choose a target format',

  'workbench.headerFiles': 'Files',
  'workbench.colFile': 'File',
  'workbench.colSize': 'Size',
  'workbench.colTarget': 'Target',
  'workbench.colStatus': 'Status',
  'workbench.colActions': 'Actions',
  'workbench.slogan': 'Every conversion stays on this machine',
  'workbench.running': 'Running',
  'workbench.limit': 'Limit',
  // ⚠️ 中英两侧的括号刻意不同形：中文那半是**全角**的 `（`，英文这里用半角 `(`。
  'workbench.startLead': 'Start (',
  'workbench.startTail': ')',
  'workbench.startTitle': 'Start (Enter)',

  'workbench.toast.settled': 'Every format in its place',
  'workbench.toast.applied': 'Set {count} target formats to {ext}',
  'workbench.toast.noApplicable': 'No files here can use that',
  'workbench.toast.noKnownFiles': 'No recognizable files here',
  'workbench.toast.allSkipped': 'Nothing was added — {count} items skipped (see the list below)',
  'workbench.toast.partialAdded': 'Added {added}, skipped {rejected} (see the list below)',
  'workbench.toast.added': 'Added {count} — ready to start',
  'workbench.toast.canceled':
    'Canceled {count} conversions (the source files are untouched, so you can run them again)',

  'workbench.status.queued': 'Queued',
  'workbench.status.waitingEngine': 'Waiting for engine',
  'workbench.status.running': 'Converting…',
  'workbench.status.done': 'Done',
  'workbench.status.error': 'Failed',
  'workbench.status.canceled': 'Stopped',

  'workbench.convertFailed': 'Conversion failed',
  'workbench.outputSize': 'Output size',
  'workbench.presetHint': 'Files like this were last converted to',

  'workbench.action.cancel': 'Stop',
  'workbench.action.options': 'Options',
  'workbench.action.optionsTitle': 'Conversion options',
  'workbench.action.optionsTitleRunning': 'Options can’t be changed mid-conversion',
  'workbench.action.retry': 'Retry',
  'workbench.action.log': 'Log',
  'workbench.action.reveal': 'Reveal',
  'workbench.action.revealTitle': 'Show in folder',
  'workbench.action.remove': 'Delete',
  'workbench.share.copyPath': 'Copy path',
  'workbench.share.copyFile': 'Copy file',
  'workbench.share.copyPathTitle': 'Put the output path on the clipboard',
  'workbench.share.copyFileTitle': 'Put the output on the clipboard',

  'workbench.rejectedCount': 'items could not be added',
  'workbench.rejectedDismiss': 'Dismiss',
  'workbench.emptyTitle': 'Nothing here yet — waiting for files',
  'workbench.emptyHint': 'Drop files in, or click “Add files” above'
}
