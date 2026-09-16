import { spawn } from 'child_process'
import { appPaths } from './appPaths'
import { buildContextMenuCommand, quoteWindowsArg } from './cli'

/**
 * Windows 资源管理器右键菜单的注册与注销。
 *
 * ## 为什么写在 HKCU
 *
 * `HKCU\Software\Classes\*\shell\<动词>` 是**当前用户**的文件关联动词，写它**不需要管理员**。
 * 写到 `HKLM` 那一侧要做到同样的事就得提权，而一个转换器为了一个右键菜单弹 UAC
 * 是不可接受的。反过来说，这也意味着它只对当前用户生效——这对个人工具正是想要的范围。
 *
 * ## 四个必须记住的坑（前三个是实测出来的）
 *
 * 1. **一律 `spawn('reg.exe', args[])`，绝不 `shell: true`**（本项目约束 2）。
 *    这条命令串里带着用户安装目录，`C:\Program Files` 级别的空格和 `&`、`(`、`)`
 *    在 cmd 里全是有含义的字符，一旦经过 shell 就会被解析成别的意思。
 *    数组参数下 shell 不参与解析。
 *
 * 2. **`reg.exe` 的输出是系统 OEM 码页，不是 UTF-8。** 见 `decodeRegOutput`。
 *
 * 3. **`reg query KEY /ve` 会把值名打出来，而且它在中文系统上叫 `(默认)`**，
 *    不是 `(Default)`。原先假定「查默认值时名字那一列是空的」，实测直接翻车：
 *    正则要求行首就是 `REG_`，于是**所有 `/ve` 的读回都是 null**——
 *    表现是「装是装上了，但读不出命令行」，自愈对比永远不成立。
 *
 * 4. **卸载必须删干净，且不许误伤别人。** 我们只删自己那一个键，再在**确认为空**的
 *    前提下逐层收掉自己创建的中间层。空判断不是假想的谨慎：`HKCU\Software\Classes\*\shell`
 *    是**各家经典右键动词共用的落脚处**，开发机上实测就躺着迅雷的 `ThunderShell`。
 *    注册表没有回收站，一句不带条件的「卸载时删掉 `*\shell`」会静默删掉别人的菜单项。
 *
 *    ⚠️ **这条规则真的被执行到了，而且真的误伤过**（2026-09-13，就在这行注释旁边）。
 *    `isEmptyQueryOutput` 当时把「非空行数 ≤ 1」当成空键，而 `reg query` 对**恰好一个
 *    子键**的键也只打一行——于是卸载我们的键之后，`*\shell` 里只剩 `ThunderShell`，
 *    被判成空、删掉了。**测试当时是绿的**，因为测试自己造的邻居键让那一层凑够了 2 行。
 *    判据现已改成「非空行数为 0」，并补了直接喂真实输出的断言，见 `test-integration.ts`。
 *
 *    （别把这条教训读反：迅雷另外还注册了 `HKCU\Software\Classes\PackagedCom\Package\`
 *    下的 PackagedCom 处理器，那是**另一套机制**，两者并存。）
 *
 * 另外：**Windows 11 的新版右键菜单默认不显示 `*\shell` 动词**，它落在「显示更多选项」
 * （`Shift+F10`）那一层里。这是系统的行为，不是我们没注册上——用户看不到菜单时的第一
 * 反应是「这个功能是坏的」，所以设置页必须把这句话写在明面上。
 *
 * 整个模块**不 import electron**：它只用 `process.execPath` 与注入式的 `appPaths()`，
 * 所以能脱离窗口直接测（见 `scripts/test-integration.ts`，它对着一个临时键做真实往返）。
 */

/** 我们在注册表里的根键。子键只有一个 `command`，见下面的注释 */
const DEFAULT_ROOT = 'HKCU\\Software\\Classes\\*\\shell\\Arbiter'

let root = DEFAULT_ROOT

/** 仅供测试：换一个临时键做真实往返，免得污染用户环境 */
export function setContextMenuRootForTest(next: string | null): void {
  root = next ?? DEFAULT_ROOT
}

/** 当前生效的根键。测试要据此断言，生产代码不必读 */
export function contextMenuRoot(): string {
  return root
}

/** 动词的显示名。中文名与产品的中文显示名一致（见 docs/NOTES.md 的项目概述） */
const MENU_LABEL = '用调律者转换'

interface RegResult {
  code: number | null
  stdout: string
  stderr: string
}

/**
 * `reg.exe` 的输出**不是 UTF-8**，是系统 OEM 码页。
 *
 * 实测（`od -c` 抓的真实字节）：`reg query <键> /ve` 往管道里写的是
 * `B4 AC C8 CF`（GBK 的「默认」）与 `D3 C3 B5 F7 …`（GBK 的「用调律者转换」），
 * 因为命令行程序在管道上用的是控制台码页而非 UTF-8。按 UTF-8 硬解得到的是一屏乱码，
 * **而且不报错**——错误信息会原样变成乱码展示给用户，值也会静默比对失败。
 *
 * 判据与 `converters/htmlSource.ts` 的 `decodeTextFile` 是同一套（也是本项目的约束 13）：
 * 先按 UTF-8 严格解，抛错就说明它不是 UTF-8，退到 GB18030。GB18030 对 ASCII 完全兼容，
 * 所以英文机器上那些纯 ASCII 的输出（`0x1`、`notepad.exe "%1"`）两条路都对。
 *
 * **没有与 `decodeTextFile` 共用**：那个在 `converters/` 层、收的是文件字节（还要处理
 * BOM 与 UTF-16），而这里是 `core/` 层的控制台输出。为一行 TextDecoder 把 converters
 * 整个拖进 core 的加载图不划算（`htmlSource.ts` 静态 import 着 mammoth 与 marked）。
 * **第三个调用方出现时再抽公共件。**
 */
function decodeRegOutput(buffer: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer)
  } catch {
    try {
      return new TextDecoder('gb18030').decode(buffer)
    } catch {
      return buffer.toString('utf8')
    }
  }
}

/**
 * 跑一次 reg.exe，**不抛异常**——所有调用方关心的都是退出码与输出。
 *
 * `windowsHide: true` 不只是美观：不加的话每次开关菜单都会闪一个黑框，
 * 而这类「程序自己弹出来的窗口」在用户眼里就是个可疑行为。
 *
 * stdout / stderr 先按 Buffer 攒起来、退出时才解码：一个多字节字符可能被切在
 * 两个 chunk 之间，逐 chunk `toString()` 会把那个字符解坏。
 */
function runReg(args: string[]): Promise<RegResult> {
  return new Promise((done) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn('reg.exe', args, { windowsHide: true })
    } catch {
      return done({ code: -1, stdout: '', stderr: '无法启动 reg.exe' })
    }

    const out: Buffer[] = []
    const err: Buffer[] = []
    const finish = (code: number | null, extra = ''): void =>
      done({
        code,
        stdout: decodeRegOutput(Buffer.concat(out)),
        stderr: extra || decodeRegOutput(Buffer.concat(err)).trim()
      })

    child.stdout?.on('data', (chunk: Buffer) => out.push(chunk))
    child.stderr?.on('data', (chunk: Buffer) => err.push(chunk))
    child.on('error', (error: Error) => finish(-1, error.message))
    child.on('close', (code) => finish(code))
  })
}

/**
 * 从 `reg query` 的输出里取一个**具名**的值。
 *
 * 输出形如（列之间是**若干空格**，不是制表符，且各语言版本的列宽会变）：
 *
 * ```
 * HKEY_CURRENT_USER\Software\Classes\*\shell\Arbiter
 *     (默认)    REG_SZ    用调律者转换
 *     Icon    REG_SZ    "C:\...\Arbiter.exe",0
 *     MultiSelectModel    REG_SZ    Single
 * ```
 *
 * 所以按下标切列是不行的（数据本身可能含空格），按「名字 + 空白 + 类型 + 空白 + 值」
 * 整行匹配才对。
 */
export function parseRegValue(stdout: string, name: string): string | null {
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^\s*(.*?)\s{2,}REG_[A-Z_]+\s{2,}(.*?)\s*$/.exec(line)
    if (match && match[1] === name) return match[2]
  }
  return null
}

/**
 * 读**默认值**：取第一条带 `REG_` 类型标记的行里的数据部分。
 *
 * 名字那一列不去匹配——它在中文系统上叫 `(默认)`、英文系统上叫 `(Default)`，
 * 拿字面量去认就是上一版翻车的那个坑（见文件头第 3 条）。
 * 只用在 `… /ve` 的输出上，那时**至多只有一个值**，所以「第一条」就是「那一条」。
 */
export function parseRegDefault(stdout: string): string | null {
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^\s*(.*?)\s{2,}REG_[A-Z_]+\s{2,}(.*?)\s*$/.exec(line)
    if (match) return match[2]
  }
  return null
}

/**
 * `reg query <键>` 的输出**是不是一个空键**（没有任何子键、也没有任何值）。
 *
 * ⚠️ **判据是「非空行数为 0」，不是「≤ 1」。** 这一条踩得很惨（2026-09-13），
 * 原文写的正是 `<= 1`，理由是一句想当然：「空键会打出键名那一行」。**不会。**
 * 实测三种形态（`reg query` 逐字节抓的）：
 *
 * | 键的状态            | 输出                                   | 非空行数 |
 * | ------------------- | -------------------------------------- | -------- |
 * | 真正空（无键无值）  | `\r\n`（就一个空行，键名都不打）        | **0**    |
 * | 恰好 1 个子键       | `\r\nHKEY_...\子键名\r\n`               | **1**    |
 * | 有值                | `\r\n    (默认)    REG_SZ    xxx\r\n`   | 1 起     |
 *
 * 所以「1 行」根本不是空键的签名，而是**恰好一个子键**的签名。代价是实打实的：
 * 开发机上 `HKCU\Software\Classes\*\shell` 里躺着迅雷的 `ThunderShell`，
 * 卸载我们的键之后它就成了那一层**唯一**的子键 → 1 行 → 被判成空键 → **删掉别人的右键菜单项**，
 * 而且是静默的。当时那条测试之所以是绿的，仅仅是因为测试自己造的邻居键让 `*\shell`
 * 凑够了 2 行——**测试的绿灯是碰巧，不是保证**。
 *
 * 不去逐行分辨「哪一行是子键、哪一行是值」是因为空与非空这件事数**非空行**就够；
 * 真正要小心的是这个下界（0），不是上界。
 *
 * 抽成纯函数是为了能直接喂真实输出测——真去造一个空键再删掉，
 * 就得动用户机器上的真实注册表位置。
 */
export function isEmptyQueryOutput(stdout: string): boolean {
  return stdout.split(/\r?\n/).filter((line) => line.trim() !== '').length === 0
}

/**
 * 从根键往上、直到 `HKCU\Software\Classes\*\shell` 为止的那一串祖先键，由内向外。
 * `uninstallContextMenu()` 会按这个顺序逐个「空了就删」。
 *
 * ⚠️ **上界是开区间：`*\shell` 与 `*` 本身一个都不删**，哪怕它们当时是空的。
 * 这条是审计（2026-09-14，D5）逼出来的，理由不是洁癖：
 *
 *  - `HKCU\Software\Classes\*\shell` 是**多家软件共用的落脚处**（`*` 下面还躺着
 *    `OpenWithProgids` / `shellex`）。删掉一个空键的收益是**零**——空键不占体积、
 *    不影响任何行为；代价却是非零的：别的软件可能刚建好这个键、正等着往里写，
 *    而我们这一删是静默的，对方看到的是「我写的键没了」。
 *  - 「空了就删」这一整条逻辑的**存在意义**是收掉**我们自己**造出来的中间层
 *    （临时根测试里那个 `Gone` 层就是它的样本）。共用层的回收不在我们的职责里。
 *
 * **由键算出来，而不是写死一个数组**：写死的版本在测试里**够不着**——临时键必然在
 * 真实键下面一层，而写死的清理列表永远只指向真实键，于是「逐层清理」这条逻辑在测试里
 * 一次都不会被执行（改了也不知道）。从键推导之后，临时键的祖先也在列表里。
 *
 * 再往上（`HKCU\Software\Classes`、`HKCU\Software`）同理，更是 Windows 自己的地盘。
 */
export function pruneTargetsFor(rootKey: string): string[] {
  const STOP = 'HKCU\\Software\\Classes\\*\\shell'
  const out: string[] = []
  let current = rootKey

  while (current.length > STOP.length && current.startsWith(`${STOP}\\`)) {
    const parent = current.slice(0, current.lastIndexOf('\\'))
    if (parent.length <= STOP.length) break
    out.push(parent)
    current = parent
  }

  return out
}

/** 这次该写进注册表的那条命令行。UI 拿它显示「实际注册的是什么」，也用于自愈比对 */
export function expectedCommand(): string {
  const paths = appPaths()
  return buildContextMenuCommand({
    // dev 下这是 electron.exe，`buildContextMenuCommand` 会补上仓库根那个参数
    exe: process.execPath,
    appPath: paths.appPath,
    isPackaged: paths.isPackaged
  })
}

export interface ContextMenuState {
  /** 注册表里有没有我们的键 */
  installed: boolean
  /** 注册表里 `command` 键当前的值（没装或读不到时为 null） */
  command: string | null
  /** 按当前 exe 路径应该写什么 */
  expected: string
  /** reg.exe 本身报的错（没报错则为 null）。有值就说明整个功能不可用 */
  error: string | null
}

/** 读一次注册表现状。**只读，不写。** */
export async function readContextMenu(): Promise<ContextMenuState> {
  const expected = expectedCommand()
  const query = await runReg(['query', root, '/ve'])

  if (query.code !== 0) {
    // 键不存在时 reg.exe 返回 1，stderr 是「系统找不到指定的注册表项」——这是**正常**结果，
    // 不是错误。真出错（reg.exe 起不来）时 code 是 -1，那才要报。
    //
    // ⚠️ 判据只用退出码，**绝不匹配 stderr 里的文案**：那是随系统语言变的，
    // 而且它是 GBK 写出来的（见 decodeRegOutput）。这一版最初写成
    // `/find|找到|cannot find/` 去认，结果在中文系统上拿到的是乱码，一律判成「真错误」——
    // 于是「重复卸载」这条幂等路径整条失效。
    const error = query.code === -1 ? query.stderr || 'reg.exe 不可用' : null
    return { installed: false, command: null, expected, error }
  }

  const commandQuery = await runReg(['query', `${root}\\command`, '/ve'])
  return {
    installed: true,
    command: commandQuery.code === 0 ? parseRegDefault(commandQuery.stdout) : null,
    expected,
    error: null
  }
}

/**
 * 写注册表。**只注册当前进程的 exe 路径**——换了个安装目录（重装到别处、
 * 或 dev 与打包版来回切）之后注册表里那条命令行就指向一个不存在的文件，
 * 表现是「右键点了没反应」。所以 `ensureContextMenu()` 每次启动会比对一次并自愈。
 */
export async function installContextMenu(): Promise<ContextMenuState> {
  const command = expectedCommand()

  const steps: string[][] = [
    ['add', root, '/ve', '/d', MENU_LABEL, '/f'],
    ['add', root, '/v', 'Icon', '/d', `${quoteWindowsArg(process.execPath)},0`, '/f'],
    // 多选时**隐藏**本项。`%1` 只替换成第一个选中文件的路径，不设这个值的话
    // 用户框选 10 个文件点一下，会只转一个、而且没有任何提示——静默地少干活。
    ['add', root, '/v', 'MultiSelectModel', '/d', 'Single', '/f'],
    ['add', `${root}\\command`, '/ve', '/d', command, '/f']
  ]

  for (const step of steps) {
    const result = await runReg(step)
    if (result.code !== 0) {
      return {
        installed: false,
        command: null,
        expected: command,
        error: (result.stderr || `reg.exe 退出码 ${String(result.code)}`).trim()
      }
    }
  }

  return readContextMenu()
}

/**
 * 只删自己那一个键，然后**在确认为空的前提下**逐层收掉中间层。
 *
 * `reg delete` 不带 `/f` 会等交互确认，而我们没有终端可问，所以必须带。
 *
 * 退出码这里**不当判据**（除了「reg.exe 压根没跑起来」）：键不存在时 reg.exe 返回 1，
 * 而那正是「重复卸载」这条正常路径。与其去分辨 1 到底是「没找到」还是别的错，
 * 不如以**结果**为准——函数末尾会重新读一次注册表，键真没删掉的话 `installed`
 * 就是 true，调用方据此把开关留在原地并显示出来。这比猜退出码可靠。
 */
export async function uninstallContextMenu(): Promise<ContextMenuState> {
  const expected = expectedCommand()
  const removed = await runReg(['delete', root, '/f'])

  if (removed.code === -1) {
    return {
      installed: true,
      command: null,
      expected,
      error: (removed.stderr || 'reg.exe 不可用').trim()
    }
  }

  for (const key of pruneTargetsFor(root)) {
    if (!(await keyIsEmpty(key))) break
    const result = await runReg(['delete', key, '/f'])
    if (result.code !== 0) break
  }

  // 返回**实际**读回来的状态，而不是我们自以为做了的事：UI 上那个开关显示的是
  // 注册表真相，只有这样「删失败了」才会在界面上露出来。
  const state = await readContextMenu()
  // 键还在，但 delete 又报了非 0——把 reg.exe 的话带上，否则界面上只剩一个
  // 纹丝不动的开关，没有任何可归因的线索。
  if (state.installed && removed.code !== 0 && removed.stderr) {
    return { ...state, error: removed.stderr }
  }
  return state
}

/** 这个键是不是空的。判据见 `isEmptyQueryOutput` */
async function keyIsEmpty(key: string): Promise<boolean> {
  const result = await runReg(['query', key])
  if (result.code !== 0) return false
  return isEmptyQueryOutput(result.stdout)
}

/**
 * 把注册表对齐到「用户想要的状态」。
 *
 * 返回的是注册表的**实际**状态，不是我们发出过的指令——调用方据此决定要不要把
 * 开关真的翻过去。失败时不吞错：界面必须说出来，而不是开关显示已打开、实际什么都没有。
 */
export async function syncContextMenu(
  enabled: boolean
): Promise<{ ok: boolean; state: ContextMenuState }> {
  const state = enabled ? await installContextMenu() : await uninstallContextMenu()
  return { ok: state.error === null && state.installed === enabled, state }
}

/**
 * 启动时的自愈：设置里开着、但注册表里那条命令行指向的不是**这一次**的 exe
 * （换了安装目录、重装了、或者用户手删过键），就重写一遍。
 *
 * 不做成「无条件重写」是因为每次启动都写一遍注册表会惊动杀软与注册表监控工具，
 * 而这本可以是个读操作。
 */
export async function ensureContextMenu(): Promise<void> {
  const state = await readContextMenu()
  if (state.error !== null) return
  if (state.installed && state.command === state.expected) return
  await installContextMenu()
}
