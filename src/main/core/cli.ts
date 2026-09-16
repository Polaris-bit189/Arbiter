import { resolve } from 'path'

/**
 * 命令行入口的纯逻辑：解析 `--convert <文件> [--to <扩展名>]`，以及拼一条 Windows
 * 注册表命令串。**零 electron 依赖、零子进程**，所以能脱离窗口直接测。
 *
 * 存在的理由是 M8 的右键菜单：菜单项在注册表里存的就是一条**命令行**，
 * 而那条命令行由我们自己拼、由 Windows 解释、最后作为 argv 交回给我们。
 * 起点与终点都是字符串，中间隔着两层解析器，所以这中间任何一个字符的差错
 * 都不会报错，只会「右键点了没反应」。整条链路拆成两个纯函数盯住。
 */

/** 一次「用本应用转换这些文件」的请求 */
export interface ConvertRequest {
  /**
   * **绝对路径，至少一个**。
   *
   * 是一个数组而不是一个字符串，因为**「发送到」多选时资源管理器会把所有选中项
   * 都追加到命令行末尾**（这一条与右键菜单的 `%1` 正好相反：`%1` 只替换第一个，
   * 所以那边要靠 `MultiSelectModel=Single` 把多选藏起来）。收不住多参数的表现是
   * 「框选 10 个只转了 1 个，而且没有任何提示」——静默地少干活，与约束 23 第 5 条
   * 那个坑是同一件事的两个方向。
   *
   * 见下面 `parseConvertRequest` 里关于 `-` 开头文件名的说明（每个路径都 resolve 成绝对）。
   */
  paths: string[]
  /** 目标扩展名：小写、无前导点。`null` = 用用户在设置里给该类别选的默认目标 */
  to: string | null
}

export type CliParse =
  /** 这次启动与我们无关（用户双击图标、安装器拉起、`--squirrel-*` 之类） */
  | { kind: 'none' }
  | { kind: 'convert'; request: ConvertRequest }
  /** 认出了 `--convert` 但参数不对。**必须报出来**，静默什么都不做正是右键菜单最坏的表现 */
  | { kind: 'error'; message: string }

/**
 * 合法的目标扩展名。刻意只放行 `[a-z0-9]`：
 *
 * 这个值最终会走到 `TaskManager.setTarget()`，而它自己会拿能力矩阵挡掉
 * 「格式合法但不支持」的组合——那类错误该由任务管理器给出（文案更准，还带类别提示）。
 * 这里挡的是**形状**不对的：带引号、带空格、带 `..` 的值会被拼进注册表命令行，
 * 那才是能真正伤到人的一种。
 */
const EXT_SHAPE = /^[a-z0-9]{1,8}$/

/** 去掉前导点并转小写：`--to .MP4` / `--to MP4` 都收 */
function normalizeExt(value: string): string {
  return value.replace(/^\.+/, '').toLowerCase()
}

/** `--convert=x` 与 `--convert x` 两种写法都收 */
function flagValue(argv: readonly string[], index: number, name: string): string | null {
  const arg = argv[index] as string
  const prefix = `${name}=`
  if (arg.startsWith(prefix)) return arg.slice(prefix.length)
  const next = argv[index + 1]
  return next === undefined ? null : next
}

/** `--convert=x` 这种写法的下一个 token 就是普通 token，不该被当成它的值 */
function consumedExtra(argv: readonly string[], index: number, name: string): number {
  return (argv[index] as string).startsWith(`${name}=`) ? 0 : 1
}

/** 是不是我们自己认得的标志。用来决定「`--convert` 后面那一串文件收完了没有」 */
function isFlag(token: string): boolean {
  return (
    token === '--convert' ||
    token === '--to' ||
    token.startsWith('--convert=') ||
    token.startsWith('--to=')
  )
}

/**
 * 从 argv 里找出转换请求。
 *
 * 三条要点：
 *
 * 1. **按标志扫描，不按位置取。** `process.argv` 的形状与启动方式有关：
 *    打包后是 `[<exe>, --convert, <文件>]`，dev 下是 `[electron.exe, <仓库根>, --convert, <文件>]`，
 *    而从 `second-instance` 事件拿到的又是一份**新的** argv。按下标取必然在某个形态上错位。
 *
 * 2. **路径一律 `path.resolve()` 成绝对路径**（本项目的约束 2）。右键菜单把
 *    用户可控的路径直接交给我们，而以 `-` 开头的文件名会被 ffmpeg / pandoc / 7z
 *    当成**选项**——参数注入比 shell 注入更隐蔽，因为它看起来只是「文件没转成功」。
 *    `resolve()` 之后路径必然以盘符或 `/` 开头，`-` 开头的名字天然不可能存活。
 *    相对路径则按 `cwd` 解析（`second-instance` 会把发起方的 cwd 一起给我们）。
 *
 * 3. **空路径 / 缺值一律报 error，不报 none。** 上游收到 `none` 会当作
 *    「这是次普通启动」，于是用户右键点了一下，菜单消失了，什么都没发生，
 *    也没有任何地方能查出原因。
 */
export function parseConvertRequest(argv: readonly string[], cwd: string): CliParse {
  const paths: string[] = []
  let to: string | null = null
  let sawConvert = false

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === undefined) continue

    if (arg === '--convert' || arg.startsWith('--convert=')) {
      sawConvert = true

      // `--convert=x` 形态：这一个 token 自己带值。
      // 「发送到」不会产生这种形态，它是给命令行手动调用留的口子。
      let took = 0
      if (arg.startsWith('--convert=')) {
        const value = flagValue(argv, i, '--convert')
        if (value === null || value === '') {
          return { kind: 'error', message: '--convert 后面没有跟文件路径' }
        }
        paths.push(value)
        took += 1
      }

      // **把后面所有不以标志开头的 token 都收进来**，直到撞见下一个标志。
      // 这一条正是「发送到」多选的落点（见 `ConvertRequest.paths`）。
      //
      // 判据只看「是不是标志」，不看位置：文件个数由上游（资源管理器）决定，
      // 我们这边没有任何依据去猜「应该有几个」。
      //
      // ⚠️ 这个循环对 `--convert=x` 那一种**也要跑**：写成「`=` 形态只收一个、
      // 后面的 token 直接忽略」的话，`--convert=a.mkv b.mkv` 会静默地只转第一个——
      // 又是一次「少干活且不报错」（与多选那条是同一个失效模式）。
      while (i + 1 < argv.length && !isFlag(argv[i + 1] as string)) {
        i += 1
        paths.push(argv[i] as string)
        took += 1
      }
      if (took === 0) return { kind: 'error', message: '--convert 后面没有跟文件路径' }
      continue
    }

    if (arg === '--to' || arg.startsWith('--to=')) {
      const value = flagValue(argv, i, '--to')
      i += consumedExtra(argv, i, '--to')
      if (value === null || value === '') {
        return { kind: 'error', message: '--to 后面没有跟目标格式' }
      }
      const ext = normalizeExt(value)
      if (!EXT_SHAPE.test(ext)) {
        return { kind: 'error', message: `目标格式不像个扩展名：${value}` }
      }
      to = ext
    }
  }

  if (!sawConvert) return { kind: 'none' }
  // `paths` 非空是必然的：上面每一条 `--convert` 分支要么 push 了东西、要么已经返回
  if (paths.length === 0) return { kind: 'error', message: '--convert 后面没有跟文件路径' }
  // **每一个**都 resolve 成绝对路径：以 `-` 开头的文件名会被引擎当成选项，
  // 而 `resolve()` 之后路径必然以盘符或 `/` 开头，那种名字天然不可能存活（约束 2）。
  return { kind: 'convert', request: { paths: paths.map((item) => resolve(cwd, item)), to } }
}

/**
 * 按 Windows 的规则给**一个**参数加引号。
 *
 * 规则来自 CreateProcess 的 `CommandLineToArgvW` 逆运算，三条：
 * 含空白或引号才需要加引号；字面量 `"` 写成 `\"`；紧跟在引号前的连续反斜杠要**翻倍**
 *（否则 `C:\` 结尾的路径会把闭合引号吃掉，`"C:\Program Files\" --convert` 会被解释成
 * 一个带空格的参数）。
 *
 * 最后一条不是理论：注册表命令里第一个参数是安装目录下的 exe 路径，
 * 而用户完全可以把它装在 `D:\我的 工具\` 这种目录里。
 */
export function quoteWindowsArg(arg: string): string {
  if (arg !== '' && !/[\s"]/.test(arg)) return arg

  let out = '"'
  let backslashes = 0

  for (const ch of arg) {
    if (ch === '\\') {
      backslashes++
      continue
    }
    if (ch === '"') {
      // 引号前的反斜杠全部翻倍，再补一个转义引号
      out += '\\'.repeat(backslashes * 2 + 1) + '"'
      backslashes = 0
      continue
    }
    out += '\\'.repeat(backslashes) + ch
    backslashes = 0
  }

  return out + '\\'.repeat(backslashes * 2) + '"'
}

/**
 * 拼出注册表里 `command` 键要写的那条命令行。
 *
 * 形状：`<exe> [<仓库根>] --convert "%1"`
 *
 * - **dev 下必须补一层仓库根**：`process.execPath` 那时是 `electron.exe`，
 *   光给它 `--convert x.mkv` 只会让它去找一个叫 `--convert` 的应用目录。
 *   打包后才是「exe 就是应用」。
 * - **`%1` 不走 `quoteWindowsArg()`，是手写死的 `"%1"`**。它不是要传给程序的字面量，
 *   而是给 Windows 的**替换占位符**：系统会把选中文件的路径替换进去，外面这对引号
 *   保证带空格的路径不变形。对它做转义反而会让替换失效（`\"%1\"` 里没有占位符）。
 * - **不带 `--to`**：右键菜单只有一个动词，而同一个动词会被用在视频、音频、图片……
 *   各种文件上，硬写一个目标格式必然对其中一部分是错的（`mp3` 转 `mp4` 根本不在
 *   能力矩阵里）。交给用户的类别默认目标，与界面上「拖进来直接开跑」完全同一条路。
 */
export function buildContextMenuCommand(options: {
  exe: string
  appPath: string
  isPackaged: boolean
  to?: string | null
}): string {
  const parts = [quoteWindowsArg(options.exe)]
  if (!options.isPackaged) parts.push(quoteWindowsArg(options.appPath))
  parts.push('--convert', '"%1"')
  // 只有显式给了目标格式才带上。目前调用方从不传，留着是为了让「右键直接转成某个格式」
  // 这条将来能走通时不必再改这里的形状。
  if (options.to) parts.push('--to', quoteWindowsArg(options.to))
  return parts.join(' ')
}

/* --------------------------------------------------------------- 独立 CLI 入口 */

/**
 * `--json`。抽成常量是因为**两个地方**要认它：下面的解析器，以及
 * 「解析失败时也要回一个 JSON 对象」那条路（见 `CliCommand` 的 `error` 变体）。
 */
export const CLI_JSON_FLAG = '--json'

/** `arbiter convert …` 解析出来的东西。 */
export interface CliConvertOptions {
  /** 复用右键菜单那一套：多文件、路径一律 resolve 成绝对（约束 2） */
  request: ConvertRequest
  /** `--json`：结果以**恰好一个** JSON 对象打到 stdout */
  json: boolean
  /**
   * `--out <路径>`：产物写到这里。
   *
   * 存在的理由是 Claude Code 的 hook：那条路要一个**确定名字的临时产物**
   * （见 `plugins/arbiter/hooks/read-convert.mjs`），而默认落点是「源文件旁边 +
   * 撞名就加 ` (1)`」——同一个 docx 读三次会在用户的目录里留下
   * `x.md` / `x (1).md` / `x (2).md`。**这个参数是那条链路里承重的一环**，不是顺手加的。
   */
  out: string | null
  /**
   * `--recipe <路径>`：配方文件（R15）。**已经 resolve 成绝对路径**。
   *
   * ⚠️ 这里只解析出**路径**，读文件与 `JSON.parse` 是调用方的事——
   * 这个模块是纯逻辑（`parseConvertRequest` / `parseCliRequest` 都零 I/O），
   * 一读盘就没法在测试里喂各种坏 JSON 进去了。
   */
  recipePath: string | null
}

/**
 * `arbiter` 独立可执行入口（`src/cli/main.ts`）的命令行形状。
 *
 * 与上面 `parseConvertRequest` 的关系：那个认的是**应用自己**的启动参数
 * （`--convert <文件>`，由右键菜单与「发送到」写进注册表 / 快捷方式），
 * 这个认的是**外部调用方**敲的子命令（`arbiter convert <文件>`）。
 * 两条路的语义一致、形状不同，所以是两个函数而不是一个带 mode 的。
 * `parseConvertRequest` 一个字都没改——164 条断言盯着的就是它（M8）。
 */
export type CliCommand =
  /** `-h` / `--help` / 裸 `help`。用法文本打 **stdout**、退出码 0 */
  | { kind: 'help' }
  /** `-v` / `--version`。版本号打 stdout、退出码 0 */
  | { kind: 'version' }
  | { kind: 'convert'; options: CliConvertOptions }
  /**
   * 用法错：未知子命令 / 未知选项 / `--to` 形状不对 / 一个文件都没给。
   *
   * `json` 跟着一起带出来是**承重**的，不是顺手：`--json` 的契约是「stdout 上恰好一个
   * JSON 对象」，而参数错恰恰是实现最容易只往 stderr 吼一嗓子、stdout 空空如也的一类。
   * 调用方（agent / hook）拿到的是 `Unexpected end of JSON input`，
   * 而真正的原因（哪个选项不认）在 stderr 上，它多半读不到。
   */
  | { kind: 'error'; message: string; json: boolean }

/**
 * 从 argv 里解析出一条 CLI 命令。
 *
 * 四条要点：
 *
 * 1. **`-h` / `--help` / `-v` / `--version` 在任何位置都生效**（写在子命令后面也算）。
 *    裸 `help` 只认第一个 token——否则一个恰好叫 `help` 的文件就没法转了。
 *
 * 2. **认不出的 `--xxx` 一律报错，不静默当成文件名。** 一个拼错的选项静默变成路径，
 *    报出来的是「找不到源文件：--too」，和真正的原因（选项名拼错了）看起来毫不相干。
 *    ⚠️ **单横线开头的 token 刻意不报**：`-foo.mp4` 是一个合法的相对文件名，
 *    而 `resolve()` 之后它必然以盘符或 `/` 开头，引擎不会把它当成选项（约束 2）。
 *    这正是「不能靠 `-` 前缀去判选项」的原因，也是这里唯一正确的折中。
 *
 * 3. **每个路径都 `resolve(cwd, …)` 成绝对路径**——与 `parseConvertRequest` 同一条
 *    理由（约束 2：参数注入比 shell 注入更隐蔽）。
 *
 * 4. **`--out` 只允许配一个源文件。** 多个源共用同一个产物路径没有意义，
 *    而静默地只给第一个用、或者让它们互相覆盖，都是「少干活还不报错」。
 *
 * 5. **`--to` 排在 `--recipe` 里的 `target` 前面。** 命令行上写出来的那个更具体、
 *    也更近，它赢。配方文件的用途是「把常用的那一套存下来」，
 *    不是「覆盖我这次手敲的」。
 */
export function parseCliRequest(argv: readonly string[], cwd: string): CliCommand {
  const json = argv.includes(CLI_JSON_FLAG)

  for (const arg of argv) {
    if (arg === '-h' || arg === '--help') return { kind: 'help' }
    if (arg === '-v' || arg === '--version') return { kind: 'version' }
  }

  const first = argv[0]
  if (first === 'help') return { kind: 'help' }
  if (first === undefined) return { kind: 'error', message: '缺少子命令', json }
  if (first !== 'convert') return { kind: 'error', message: `未知的子命令：${first}`, json }

  const paths: string[] = []
  let to: string | null = null
  let out: string | null = null
  let recipePath: string | null = null

  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i] as string

    if (arg === CLI_JSON_FLAG) continue

    if (arg === '--to' || arg.startsWith('--to=')) {
      const value = flagValue(argv, i, '--to')
      i += consumedExtra(argv, i, '--to')
      if (value === null || value === '') {
        return { kind: 'error', message: '--to 后面没有跟目标格式', json }
      }
      const ext = normalizeExt(value)
      if (!EXT_SHAPE.test(ext)) {
        return { kind: 'error', message: `目标格式不像个扩展名：${value}`, json }
      }
      to = ext
      continue
    }

    if (arg === '--out' || arg.startsWith('--out=')) {
      const value = flagValue(argv, i, '--out')
      i += consumedExtra(argv, i, '--out')
      if (value === null || value === '') {
        return { kind: 'error', message: '--out 后面没有跟输出路径', json }
      }
      out = resolve(cwd, value)
      continue
    }

    if (arg === '--recipe' || arg.startsWith('--recipe=')) {
      const value = flagValue(argv, i, '--recipe')
      i += consumedExtra(argv, i, '--recipe')
      if (value === null || value === '') {
        return { kind: 'error', message: '--recipe 后面没有跟配方文件路径', json }
      }
      recipePath = resolve(cwd, value)
      continue
    }

    if (arg.startsWith('--')) {
      return { kind: 'error', message: `未知的选项：${arg}`, json }
    }

    paths.push(arg)
  }

  if (paths.length === 0) return { kind: 'error', message: 'convert 后面没有跟文件路径', json }
  if (out !== null && paths.length > 1) {
    return {
      kind: 'error',
      message: `--out 只能配一个源文件，这次给了 ${paths.length} 个`,
      json
    }
  }

  return {
    kind: 'convert',
    options: {
      request: { paths: paths.map((item) => resolve(cwd, item)), to },
      json,
      out,
      recipePath
    }
  }
}

/**
 * 「发送到」那个快捷方式的**参数**部分（目标 exe 由上层的 `shell.writeShortcutLink` 给）。
 *
 * 形状：`[<仓库根>] --convert`
 *
 * ⚠️ **这里没有 `%1`，这是与上一条刻意相反的地方。** 快捷方式不做占位符替换：
 * 资源管理器是把选中的文件**追加**到命令行末尾的（选 10 个就追加 10 个路径，
 * 选中项里带空格的由系统自己引起来）。写成 `--convert "%1"` 的话那个 `%1` 会作为
 * 字面量留在参数里，于是每个文件后面都跟着一个指向 `%1` 的假路径——
 * 表现是「每次转换都多报一个找不到的文件」。
 *
 * 反过来说，这也正是「发送到」比右键菜单更适合多选的原因：那边的 `%1` 只替换第一个，
 * 只能靠 `MultiSelectModel=Single` 把多选藏掉（约束 23）；这边天然是全给的。
 */
export function buildSendToArgs(options: { appPath: string; isPackaged: boolean }): string {
  const parts: string[] = []
  // dev 下 `process.execPath` 是 electron.exe，光给 `--convert` 会让它去找一个叫
  // `--convert` 的应用目录。理由与 `buildContextMenuCommand` 里那一条完全相同。
  if (!options.isPackaged) parts.push(quoteWindowsArg(options.appPath))
  parts.push('--convert')
  return parts.join(' ')
}
