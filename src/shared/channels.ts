/**
 * 所有 IPC 通道名的唯一来源。
 *
 * 单独成一个零依赖模块，是因为 preload 也要用它：preload 跑在 sandbox 里，
 * 任何被 require 进来的 npm 包都会让整个 preload 崩溃，所以不能为了拿几个
 * 字符串常量而把 zod（连同 ipc-contract）拖进 preload 的依赖图。
 *
 * 通道名拼错在 Electron 里不会报错，只会静默地什么都不发生——这类 bug 极难定位，
 * 所以两侧都必须从这里取，不许写字面量。
 */
export const CH = {
  // 任务
  tasksAdd: 'tasks:add',
  tasksList: 'tasks:list',
  tasksSetTarget: 'tasks:setTarget',
  /**
   * 改一条任务的**参数**（目前只有裁剪）。
   *
   * 与 `tasksSetTarget` 分成两条而不是合成一条「改任务」：两者的载荷形状、
   * 失败方式、以及界面上的入口都不同（目标格式是一个下拉，参数是一个面板），
   * 合成一条只会让「改目标时把参数一起覆盖成空」这种事故有个很自然的位置。
   */
  tasksSetOptions: 'tasks:setOptions',
  tasksStart: 'tasks:start',
  tasksCancel: 'tasks:cancel',
  tasksRemove: 'tasks:remove',
  tasksRetry: 'tasks:retry',
  tasksClearFinished: 'tasks:clearFinished',
  tasksReveal: 'tasks:reveal',
  /** 打开系统文件选择器（多选），把选中的文件收进队列 */
  tasksPickFiles: 'tasks:pickFiles',
  /**
   * 打开系统文件夹选择器，把**递归**扫到的文件收进队列（E-4）。
   *
   * 展开必须在主进程做（只有它能 readdir），而递归**不能**是简单的
   * `readdir({ recursive: true })`：那会把整棵树压进一个 macrotask，
   * 主进程一卡，整个应用连取消都点不动（主进程是唯一真相源）。
   *
   * 实际做法是「分批 + 显式让出 + 条数上限 + 默认排除清单」，而且
   * **先给「将加入 N 个」的确认**、用户点了才入队。见 `core/folderScan.ts`。
   */
  tasksPickFolder: 'tasks:pickFolder',
  /** main → renderer，批量增量推送 */
  tasksPatch: 'tasks:patch',
  /**
   * 「转换完成之后的动作」（复制路径 / 复制产物 / 打开所在目录）。
   *
   * **动作不由渲染层指定，只在载荷里给 id**：真正往剪贴板里写什么由主进程按
   * 设置里那一项决定。让渲染层指定动作等于让不可信输入决定「覆盖用户的剪贴板」，
   * 而这一条链路的副作用（剪贴板被别的程序抢走）本来就极难归因。
   */
  tasksAfterAction: 'tasks:afterAction',

  // 设置
  settingsGet: 'settings:get',
  settingsSet: 'settings:set',
  /**
   * 「磁盘上那份设置文件读不出可用数据」这件事，问一次。
   *
   * 存在的理由：`jsonStore` 读盘失败时会把原文件**改名留档**再退回默认值，
   * 而留档这件事在打包后的 GUI 里**没有任何出口**（主进程只能 `console.error`，
   * 用户看不到）。审计 §3.10 的原话是「并让它**在界面上可见**」——
   * 数据没被覆盖只解决了一半，用户不知道「我那 12 项设置怎么全变默认了」是另一半。
   *
   * 与 `integration:get` 同一个形状：**问「实际状态」而不是把它塞进 `Settings`**，
   * 后者要动那个被 `.strict()` 钉住的 schema，且会把一件一次性的告警变成常驻字段。
   */
  settingsCorruption: 'settings:corruption',
  settingsPickOutputDir: 'settings:pickOutputDir',
  /**
   * 挑一个「重命名即转换」的监听目录。与上面那条同一个形状：**主进程一次做完
   * 「弹目录选择框 + 写进设置 + 重装监听器」**，渲染层不必再补一次 `settings:set`。
   * 分两步的话中间会有一小段「目录已经写进设置、监听器却还挂在旧目录上」的状态。
   */
  settingsPickRenameDir: 'settings:pickRenameDir',
  /** 把一个目录移出监听白名单。**只是从名单里去掉**，不碰那个目录本身一根毫毛 */
  settingsRemoveRenameDir: 'settings:removeRenameDir',

  // 历史记录
  historyList: 'history:list',
  historyClear: 'history:clear',
  historyRemove: 'history:remove',
  historyReveal: 'history:reveal',
  /**
   * 「再行调律」：在主进程里一次做完「入队 + **复现当初的目标格式**」。
   *
   * 不让渲染层分两步调，是因为 `tasksAdd` 只返回 `{ added, rejected }`、
   * **不返回新任务 id**，渲染层根本无从知道该给哪一条设目标。
   * 把两步合成一个不可分割的主进程操作，IPC 契约零改动。
   *
   * 「复现」二字是承重的：目标取自历史条目自己的 `toExt`，不是当前偏好。
   * 用户在设置页改过「各类别默认目标」之后，这一行仍应产出它当初写着的那个格式。
   *
   * 载荷收的是 **id 列表**（`historyRerunSchema`），单条与整批是同一个动作——
   * 批量场景是「一批 20 个挂了 3 个，只把没成的挑出来重跑」，拆成两条通道只会
   * 让「只重跑失败项」这条规则有两个实现，而它们迟早会分叉。
   */
  historyRerun: 'history:rerun',

  // 引擎
  /**
   * 廉价：只做 existsSync，绝不 spawn。页面渲染走这条。
   */
  enginesStatus: 'engines:status',
  /**
   * 昂贵：真起 `--version` 子进程（LibreOffice 3–5 秒，Calibre 要拉 Python）。
   * 只有用户显式点「探测版本」才走这条。
   */
  enginesProbe: 'engines:probe',
  /**
   * 按需下载 + 解包一个重型引擎（M7）。
   *
   * **必须与 `enginesStatus` 分开**：这一条是分钟级的（LibreOffice 375 MB 下载
   * 加 29 秒解包），而 `enginesStatus` 是毫秒级的页面渲染路径。合成一条的话，
   * 关于页每次挂载都要等在这儿。
   *
   * 返回**装完之后的完整状态列表**（与 probe 一致），渲染层整份替换即可；
   * 中途进度走 `enginesProgress` 那条**推送**通道。
   */
  enginesInstall: 'engines:install',
  /** 下载 / 解包进度推送。载荷是 `EngineProgress` */
  enginesProgress: 'engines:progress',

  // 系统集成（M8）
  /**
   * 读右键菜单的**注册表实际状态**。与 `settings:get` 的 `contextMenu` 是两件事：
   * 那一项是用户的意图，这一条是注册表里真正躺着什么。两者会分叉——用户手删过键、
   * 或换了安装目录——而分叉的表现是「开关是打开的，右键却没有菜单」。
   */
  integrationGet: 'integration:get',
  /** 开关右键菜单。真正写/删注册表，然后返回**改完之后**的实际状态 */
  integrationSet: 'integration:set',

  // 应用信息
  appInfo: 'app:info',

  // 窗口控制（frame: false 之后三键得自己实现）
  windowMinimize: 'window:minimize',
  windowToggleMaximize: 'window:toggleMaximize',
  windowClose: 'window:close',
  windowIsMaximized: 'window:isMaximized',
  /** main → renderer，最大化状态变化，用于把三键里的中间那个换成「还原」图标 */
  windowMaximizedChanged: 'window:maximizedChanged'
} as const

export type ChannelName = (typeof CH)[keyof typeof CH]
