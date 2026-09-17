import { homedir } from 'os'
import { join } from 'path'
import { appPaths } from './appPaths'
import { buildSendToArgs } from './cli'

/**
 * 「发送到」菜单集成：往 `%APPDATA%\Microsoft\Windows\SendTo\` 放一个 `.lnk`。
 *
 * ## 为什么不复用右键菜单那套（M8 的 `core/integration.ts`）
 *
 * 两个入口解决的是同一个问题（「把文件拖进转换器」这一步别让用户自己走），
 * 但它们的代价完全不同：
 *
 * | | 右键菜单 | 发送到 |
 * |---|---|---|
 * | 写什么 | `HKCU\Software\Classes\*\shell\Arbiter` 一整个键树 | 用户目录下一个 `.lnk` 文件 |
 * | 卸载 | 要逐层清理、还要判空防误删别人（约束 23 第 5 条那次真误删） | 删掉自己那一个文件 |
 * | 菜单层级 | **Windows 11 上落进「显示更多选项」（Shift+F10）** | **一级菜单** |
 * | 多选 | `%1` 只替换第一个，只能靠 `MultiSelectModel=Single` 把多选藏掉 | 选中的文件**全部**追加到命令行 |
 *
 * 最后两行是这条功能存在的理由：它少两步点击，而且不需要教育用户「请按 Shift+F10」。
 * 代价是它同样在用户的环境里留了东西（一个 .lnk），所以开关**默认关**，
 * 与右键菜单同一条规矩：用户没做过任何选择之前，我们不动他的环境。
 *
 * ## 三个必须记住的点
 *
 * 1. **多选是把所有路径都追加到命令行末尾。** 快捷方式不做占位符替换，
 *    所以 `core/cli.ts` 的 `parseConvertRequest` 必须收得住多参数——收不住的表现是
 *    「框选 10 个只转了 1 个，而且没有任何提示」。这也是 `buildSendToArgs` 里
 *    刻意**不写** `%1` 的原因。
 *
 * 2. **读写都走注入的 `SendToIo`，本模块不 import electron。** 真实的实现是
 *    Electron 的 `shell.writeShortcutLink` / `readShortcutLink`（见 `main/ipc/integration.ts`
 *    的注入点），而那两个 API 只有 Electron 里有。抽成注入式之后这个模块能在普通
 *    Node 里跑完整的往返测试（`scripts/test-integration.ts` 对着一个临时目录做真读写）。
 *    **没注入就返回错误，不做任何兜底**：一句「未注入」会显示在设置页上，
 *    而「静默地什么都没做」在界面上与成功长得一模一样（同 `core/appPaths.ts` 的取向）。
 *
 * 3. **只删自己那一个文件，绝不碰 SendTo 目录本身、也不做任何通配删除。**
 *    那个目录里躺着用户自家的「发送到 > 邮件收件人 / 压缩文件夹」等等。
 *    这与注册表那边的教训是同一条：清理的射程必须由**我们自己创建的东西**决定。
 *
 * 整个模块是**同步**的：`writeShortcutLink` / `rmSync` 都是同步 API，
 * 没有子进程要等。所以不需要 Promise 那套包装。
 */

/** 快捷方式文件名。产品名保持一致（见 electron-builder.yml 的 productName） */
export const SEND_TO_LINK_NAME = 'Arbiter.lnk'

/** `shell.writeShortcutLink` 那个选项对象的我方子集 */
export interface ShortcutSpec {
  target: string
  args: string
  description: string
}

/**
 * 快捷方式的读写出口。**返回 `null` 表示成功**，非 null 是一句能显示给用户的错误。
 *
 * 与 `core/integration.ts` 的 `runReg` 同一个取向：错误不抛异常，而是被逐层带回界面。
 * 抛异常的话 IPC 那边会变成一次 invoke 失败，界面只能显示一句「调用出错」——
 * 而「为什么写不进去」才是用户需要看到的。
 */
export interface SendToIo {
  write(linkPath: string, spec: ShortcutSpec): string | null
  read(linkPath: string): ShortcutSpec | null
  /** 删一个文件。**文件不存在不算错误**（重复卸载是正常路径） */
  remove(linkPath: string): string | null
}

let io: SendToIo | null = null

/** 由 Electron 那一侧（`main/ipc/integration.ts`）在注册 IPC 时注入 */
export function setSendToIo(next: SendToIo | null): void {
  io = next
}

let dirOverride: string | null = null

/** 仅供测试：换一个临时目录做真读写，免得往用户真实的「发送到」里放东西 */
export function setSendToDirForTest(next: string | null): void {
  dirOverride = next
}

/**
 * 「发送到」目录。`%APPDATA%\Microsoft\Windows\SendTo`。
 *
 * 直接用 `process.env.APPDATA` 而不是 `app.getPath('appData')`，是为了让这个模块
 * 不 import electron（理由见文件头第 2 条）。Electron 主进程里这个变量必然存在；
 * 退一步用 `homedir()` 拼一个——真走到那条兜底上说明环境异常，但至少还有个具体路径
 * 能显示给用户，而不是一个空字符串。
 */
export function sendToDir(): string {
  if (dirOverride !== null) return dirOverride
  const roaming = process.env.APPDATA
  const base =
    roaming !== undefined && roaming.length > 0 ? roaming : join(homedir(), 'AppData', 'Roaming')
  return join(base, 'Microsoft', 'Windows', 'SendTo')
}

/** 我们那个快捷方式的完整路径。UI 要显示它，所以导出了 */
export function sendToLinkPath(): string {
  return join(sendToDir(), SEND_TO_LINK_NAME)
}

/** 按**这一次**的 exe 算出来该写进去的内容 */
export function expectedSendToLink(): ShortcutSpec {
  const paths = appPaths()
  return {
    // dev 下这是 electron.exe，`buildSendToArgs` 会补上仓库根那个参数
    target: process.execPath,
    args: buildSendToArgs({ appPath: paths.appPath, isPackaged: paths.isPackaged }),
    description: '把文件送入调律者转换器'
  }
}

export interface SendToState {
  /** 磁盘上真有那个 `.lnk` */
  installed: boolean
  /** 那个 `.lnk` 的完整路径。**装没装都回**：界面要能说出会放到哪儿 */
  path: string
  /** 读回来的内容（没装 / 读不了时为 null） */
  actual: ShortcutSpec | null
  /** 按当前 exe 路径应该写什么 */
  expected: ShortcutSpec
  /** 读写本身的错误（没注入 IO、写盘失败等），没有则为 null */
  error: string | null
}

/** 读一次现状。**只读，不写。** */
export function readSendTo(): SendToState {
  const expected = expectedSendToLink()
  const path = sendToLinkPath()

  if (io === null) {
    return { installed: false, path, actual: null, expected, error: '快捷方式读写未注入' }
  }

  let actual: ShortcutSpec | null
  try {
    actual = io.read(path)
  } catch (error) {
    // IO 实现自己抛了（比如 Electron 那边没包住的异常）。**不能让它变成静默的
    // 「没装」**——那样自愈会每次都重写一遍，而用户看到的是一个永远装不上的开关。
    return { installed: false, path, actual: null, expected, error: describe(error) }
  }

  return { installed: actual !== null, path, actual, expected, error: null }
}

/**
 * 写那个 `.lnk`。**幂等**：已经存在就直接覆盖（`write` 那边的 operation 是 `create`，
 * 它自带「必要时覆盖」的语义）。
 */
export function installSendTo(): SendToState {
  const expected = expectedSendToLink()
  const path = sendToLinkPath()

  if (io === null) {
    return { installed: false, path, actual: null, expected, error: '快捷方式读写未注入' }
  }

  const failure = io.write(path, expected)
  if (failure !== null) {
    return { installed: false, path, actual: null, expected, error: failure }
  }

  // 回的是**读回来的**状态，不是我们以为自己写进去的东西：写盘成功但读不回
  // 某些值时（比如目标路径被系统规范化过），界面必须显示真相而不是我们的意图。
  const after = readSendTo()
  if (!after.installed) {
    return { ...after, error: after.error ?? '快捷方式写完之后读不到' }
  }
  return after
}

/**
 * 删掉那个 `.lnk`。**重复卸载是正常路径**，不是错误。
 *
 * 只删自己这一个文件：SendTo 目录里还有用户自家的「邮件收件人」「压缩(zipped)文件夹」
 * 等等，任何一次通配删除都会静默毁掉它们（与注册表那边逐层清理必须判空是同一条教训）。
 */
export function uninstallSendTo(): SendToState {
  const expected = expectedSendToLink()
  const path = sendToLinkPath()

  if (io === null) {
    return { installed: false, path, actual: null, expected, error: '快捷方式读写未注入' }
  }

  const failure = io.remove(path)
  if (failure !== null) {
    // 删不掉就把现状（含那句错）如实报回去，界面据此把开关留在原地
    return { ...readSendTo(), error: failure }
  }

  return readSendTo()
}

/**
 * 把磁盘对齐到「用户想要的状态」，返回**实际**状态。
 *
 * 调用方（`ipc/integration.ts`）据 `ok` 决定要不要把设置翻过去——
 * 顺序必须是「先动文件、成功了才改意图」，否则失败后的状态是
 * 「开关显示已打开、发送到里却没有那一项」。
 */
export function syncSendTo(enabled: boolean): { ok: boolean; state: SendToState } {
  const state = enabled ? installSendTo() : uninstallSendTo()
  return { ok: state.error === null && state.installed === enabled, state }
}

/**
 * 启动时的自愈：设置里开着、但那个 `.lnk` 不在，或者它指向的不是**这一次**的 exe
 * （换了安装目录、重装了、被清理工具删过），就重写一遍。
 *
 * 与 `ensureContextMenu()` 同一个形状：**不做无条件重写**——每次启动都写一遍
 * 用户目录会惊动杀软与文件监控工具，而这本可以是个读操作。
 */
export function ensureSendTo(): void {
  const state = readSendTo()
  if (state.error !== null) return
  if (state.installed && sameLink(state.actual, state.expected)) return
  installSendTo()
}

/**
 * 内容比对。**只比两个承重字段**（target / args）：
 *
 * description 是我们的文案，用户改过它（或者系统换了个说法）不该触发重写；
 * 而 target / args 里任何一个不对，那个 .lnk 就是坏的——点了会拉起错的程序，
 * 或者拉起我们却不带 `--convert`（表现是「点了「发送到」只是把应用打开了」）。
 */
function sameLink(a: ShortcutSpec | null, b: ShortcutSpec): boolean {
  if (a === null) return false
  return a.target === b.target && normalizeArgs(a.args) === normalizeArgs(b.args)
}

/** 参数串比对前先归一空白：`.lnk` 里存的是命令行片段，多余空格不影响它的含义 */
function normalizeArgs(args: string): string {
  return args.trim().replace(/\s+/g, ' ')
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
