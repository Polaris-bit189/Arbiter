import './install-test-paths'
import { spawn, spawnSync } from 'child_process'
import { createHash } from 'crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'fs'
import { mkdir, mkdtemp, readdir, rename, rm, stat, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { dirname, join, relative, resolve } from 'path'
import {
  buildContextMenuCommand,
  buildSendToArgs,
  parseConvertRequest,
  quoteWindowsArg
} from '../src/main/core/cli'
import {
  ensureSendTo,
  installSendTo,
  readSendTo,
  sendToLinkPath,
  setSendToDirForTest,
  setSendToIo,
  syncSendTo,
  uninstallSendTo,
  type SendToIo
} from '../src/main/core/sendTo'
import {
  COPY_FILE_MAX_BYTES,
  planAfterAction,
  runAfterAction,
  setAfterActionIo,
  type AfterActionIo
} from '../src/main/core/afterAction'
import { planRerun } from '../src/main/core/rerun'
import { presetTargetFor } from '../src/renderer/src/lib/presetTarget'
import { DEFAULT_AFTER_CONVERT } from '../src/shared/types'
import type { HistoryEntry } from '../src/shared/types'
import {
  contextMenuRoot,
  expectedCommand,
  installContextMenu,
  isEmptyQueryOutput,
  parseRegDefault,
  parseRegValue,
  pruneTargetsFor,
  readContextMenu,
  setContextMenuRootForTest,
  syncContextMenu,
  uninstallContextMenu
} from '../src/main/core/integration'
import { diffRename, renameConvertible, watchableName } from '../src/main/core/renameWatch'
import type { DirEntry } from '../src/main/core/renameWatch'
import { RenameWatcher } from '../src/main/core/renameWatcher'
import {
  confirmPromptFor,
  planFolderEnqueue,
  reportLines,
  reportSummary,
  scanFolder
} from '../src/main/core/folderScan'
import type { ScanReport } from '../src/main/core/folderScan'

/**
 * M8「系统集成」的自测。
 *
 *   npx tsx --tsconfig tsconfig.test.json scripts/test-integration.ts
 *
 * ## 这一份为什么必须动真注册表
 *
 * 右键菜单的**整体**是「我们拼一条命令行 → 写进注册表 → Windows 读它 → 按那条命令行
 * 拉起我们 → 我们解析 argv」。中间两段（注册表读写、Windows 的参数替换）纯函数测不到，
 * 而它们恰好是最容易静默出错的地方：`reg.exe` 的输出编码、列宽、退出码语义、
 * 路径里的空格与反斜杠，任何一处不对的表现都是「右键点了没反应」。
 * 所以这里**真的** `reg add` / `reg query` / `reg delete` 一轮。
 *
 * **首跑抓到的三条**（都留在下面各处的注释里，别把它们「修」回去）：
 *   1. `reg query KEY /ve` 会把值名打出来，而中文系统上那个名字是 `(默认)`——
 *      原实现按「行首就是 REG_」匹配，于是**所有 `/ve` 读回都是 null**；
 *   2. `reg.exe` 的输出是 **GBK**，按 UTF-8 解得到乱码；
 *   3. 判「键不存在」时去匹配 stderr 里的本地化文案，而那段文本正是乱码，
 *      于是「重复卸载」这条幂等路径整条失效。
 *
 * ## 但绝不碰用户真正的那个键
 *
 * `setContextMenuRootForTest()` 把根键换到一个临时键上，而且**临时键挂在真实键的同一层
 * 下面**（`…\shell\ArbiterM8SelfTest\verb`），这样顺带把两件事一起测了：
 *
 *  - 逐层清理（`pruneTargetsFor`）会先删掉临时键自己那一层，再往上撞见 `*\shell`——
 *    那里的邻居键让它非空，清理必须**停在那儿**。邻居是跑之前主动建出来的，不依赖
 *    这台机器碰巧有什么。
 *    ⚠️ **这条不是洁癖，是被真事逼出来的**：`isEmptyQueryOutput` 曾经把「非空行数
 *    ≤ 1」当成空键，而开发机上 `*\shell` 本来就躺着迅雷的 `ThunderShell`——卸载我们
 *    自己的键之后它成了唯一子键（1 行）→ 被判成空 → **连别人的菜单项一起删了**。
 *    而当时的测试是绿的：测试自己造的邻居键让那一层凑够了 2 行。
 *    判据改成「非空行数为 0」，[3] 里补了直接喂下面两种真实输出的断言。
 *  - 「别人的菜单项没被误伤」这条断言于是有了真实的对手（下面的邻居键）。
 *
 * 收尾时把邻居键与临时键一并删掉，跑完不留痕迹；跑之前也先做一次同样的清理，
 * 因为上一次跑崩了会把它们留在那儿。
 */

const NEIGHBOR = 'HKCU\\Software\\Classes\\*\\shell\\ArbiterM8Neighbor'
const NEIGHBOR_PARENT = 'HKCU\\Software\\Classes\\*\\shell'
/**
 * 临时根**刻意深一层**：中间那个 `Gone` 层在删掉我们的键之后就空了，
 * 于是「空的中间层会被清掉」这条覆盖还在。
 */
const TEST_ROOT = 'HKCU\\Software\\Classes\\*\\shell\\ArbiterM8SelfTest\\Gone\\verb'
/** 上面那个会被清掉的空层 */
const GONE_LAYER = 'HKCU\\Software\\Classes\\*\\shell\\ArbiterM8SelfTest\\Gone'
/**
 * **我们自己的那一层里的**守门键，用来把「清理必须在非空的层前收手」测成
 * **与环境无关**的。
 *
 * ⚠️ 这一段是**被一次偶发的反证失败逼出来的**。原先只有 NEIGHBOR（挂在 `*\shell`
 * 那一层），而那三条「邻居没被误伤」的断言**能不能红，取决于这台机器上 `*\shell`
 * 里除了邻居之外还有没有别人的条目**——有，逐层清理的判据就不触发、断言不红；
 * 没有，才红。于是 `falsify:integration` 会**随机**报「有断言没红」，
 * 白烧一整轮（12 分钟），还诱导人去放宽真正的断言。
 *
 * 放到 `ArbiterM8SelfTest\` 下面之后判据就确定了：清理的梯子是
 * `verb → Gone → SelfTest`（**到 `*\shell` 为止，那一层与它上面的 `*` 我们一律不碰**，
 * 见 `pruneTargetsFor` 的 D5 注释）——`Gone` 空了要被删，而 `SelfTest` 里还有这一个
 * → **必然**在那里收手。
 * 而「非空行数 ≤ 1 判成空」那条变异会把它判成空 → 连这个键一起删 → **必然翻红**。
 */
const KEEP = 'HKCU\\Software\\Classes\\*\\shell\\ArbiterM8SelfTest\\KeepMe'
/** 真实键。全程只读，用来证明我们没碰到它 */
const REAL_KEY = 'HKCU\\Software\\Classes\\*\\shell\\Arbiter'
/** 写进去再读回来、用来验编码的一个带中文的值 */
const CJK_VALUE = '过期的 值 --convert "%1"'

let passed = 0
let failed = 0
let skipped = 0

function check(label: string, ok: boolean, detail?: string): void {
  if (ok) {
    passed += 1
    console.log(`  \u2713 ${label}`)
  } else {
    failed += 1
    console.log(`  \u2717 ${label}${detail ? `  \u2190 ${detail}` : ''}`)
  }
}

function notice(text: string): void {
  skipped += 1
  console.log(`  \u25CB ${text}`)
}

/**
 * 测试自己的 reg.exe 调用，只用于建键 / 拆键 / 核对，**不被测代码**。
 *
 * 解码刻意与 `core/integration.ts` 的 `decodeRegOutput` **分开写**：
 * 那一个是被测对象，用它来解就变成「自己验自己」——它的兜底分支坏掉时，
 * 两边会一起坏、断言照样绿。这里写成三段式（严格 UTF-8 → GB18030）是为了
 * 与那边**独立**，至于两边恰好用了同一个判据，那是编码事实决定的，不是抄来的。
 *
 * ⚠️ 这些断言假定控制台码页是 936（中文 Windows）。英文机器上 `reg.exe` 读回中文值
 * 时会把不可映射的字符写成 `?`，于是「中文往返」这一类断言会红——那是**环境的限制**，
 * 不是实现的问题（模块那边在英文机器上仍然正确：纯 ASCII 经过两个解码器都一样）。
 */
function reg(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((done) => {
    const child = spawn('reg.exe', args, { windowsHide: true })
    const out: Buffer[] = []
    const err: Buffer[] = []

    const decode = (buffer: Buffer): string => {
      try {
        return new TextDecoder('utf-8', { fatal: true }).decode(buffer)
      } catch {
        return new TextDecoder('gb18030').decode(buffer)
      }
    }

    const finish = (code: number | null, extra = ''): void =>
      done({
        code,
        stdout: decode(Buffer.concat(out)),
        stderr: extra || decode(Buffer.concat(err)).trim()
      })

    child.stdout.on('data', (c: Buffer) => out.push(c))
    child.stderr.on('data', (c: Buffer) => err.push(c))
    child.on('error', (e: Error) => finish(-1, e.message))
    child.on('close', (code) => finish(code))
  })
}

const hasKey = async (key: string): Promise<boolean> => (await reg(['query', key])).code === 0
const isWin = process.platform === 'win32'

/* ------------------------------------------------------------------ 纯逻辑 */

function testArgvParsing(): void {
  console.log('\n[1] argv 解析（--convert / --to）')

  const packaged = parseConvertRequest(
    ['C:\\app\\Arbiter.exe', '--convert', 'C:\\video\\a.mkv'],
    'C:\\'
  )
  check(
    '打包形态：拿到绝对路径，to 为 null（用类别默认目标）',
    packaged.kind === 'convert' &&
      packaged.request.paths.length === 1 &&
      packaged.request.paths[0] === 'C:\\video\\a.mkv' &&
      packaged.request.to === null,
    JSON.stringify(packaged)
  )

  // dev 下 argv 前面多一个仓库根，按下标取参数就会在这里错位
  const dev = parseConvertRequest(
    ['electron.exe', 'D:\\project\\message', '--convert', 'D:\\video\\a.mp4', '--to', 'webm'],
    'D:\\'
  )
  check(
    'dev 形态：多一个仓库根也不影响（按标志扫描而不是按下标取）',
    dev.kind === 'convert' &&
      dev.request.paths[0] === 'D:\\video\\a.mp4' &&
      dev.request.to === 'webm',
    JSON.stringify(dev)
  )

  const equals = parseConvertRequest(['x.exe', '--convert=C:\\a\\b.mkv', '--to=.MKV'], 'C:\\')
  check(
    '--flag=value 写法同样收，且扩展名归一化（去点 + 转小写）',
    equals.kind === 'convert' && equals.request.to === 'mkv' && equals.request.paths.length === 1,
    JSON.stringify(equals)
  )

  // `--convert=a.mkv b.mkv` 里那个 `b.mkv` **不能被忽略**：忽略了就是「只转了第一个
  // 且不报错」，与「发送到」多选收不住是同一个失效模式（只是入口不同）。
  const equalsThenMore = parseConvertRequest(
    ['x.exe', '--convert=a.mkv', 'b.mkv', '--to', 'webm'],
    'D:\\dir'
  )
  check(
    '★ `--convert=a.mkv b.mkv` 里的第二个文件也要收下（忽略了就是静默少干活）',
    equalsThenMore.kind === 'convert' &&
      equalsThenMore.request.paths.length === 2 &&
      equalsThenMore.request.paths[1] === resolve('D:\\dir', 'b.mkv'),
    JSON.stringify(equalsThenMore)
  )

  const relative = parseConvertRequest(['x.exe', '--convert', 'sub\\clip.mkv'], 'D:\\dir')
  check(
    '相对路径按 cwd 展开成绝对路径',
    relative.kind === 'convert' &&
      relative.request.paths[0] === resolve('D:\\dir', 'sub\\clip.mkv'),
    JSON.stringify(relative)
  )

  // ★ 约束 2 的核心：以 `-` 开头的文件名会被 ffmpeg / pandoc / 7z 当成**选项**
  const dashed = parseConvertRequest(['x.exe', '--convert', '-rf.mkv'], 'D:\\dir')
  check(
    '`-` 开头的文件名被 resolve 成绝对路径（否则会被引擎当成命令行选项）',
    dashed.kind === 'convert' &&
      dashed.request.paths[0] === resolve('D:\\dir', '-rf.mkv') &&
      !(dashed.request.paths[0] ?? '').startsWith('-'),
    JSON.stringify(dashed)
  )

  check(
    '没有 --convert 就是普通启动（none）',
    parseConvertRequest(['x.exe'], 'C:\\').kind === 'none'
  )

  // 这三条是**报错而不是 none**：报 none 的话上游当作普通启动，
  // 用户右键点了一下、菜单消失、什么都没发生，也没有任何地方能查出原因
  const noPath = parseConvertRequest(['x.exe', '--convert'], 'C:\\')
  check(
    '--convert 缺值 → error（不能静默当作普通启动）',
    noPath.kind === 'error',
    JSON.stringify(noPath)
  )

  const noExt = parseConvertRequest(['x.exe', '--convert', 'a.mkv', '--to'], 'C:\\')
  check('--to 缺值 → error', noExt.kind === 'error', JSON.stringify(noExt))

  const badExt = parseConvertRequest(['x.exe', '--convert', 'a.mkv', '--to', 'm"p4'], 'C:\\')
  check(
    '--to 形状非法（含引号）→ error：它会被拼进注册表命令行',
    badExt.kind === 'error',
    JSON.stringify(badExt)
  )

  /* ------------------------------------------------ 多文件参数（「发送到」） */

  // ★★ M9 最要紧的一条：**「发送到」多选时资源管理器会把所有选中项追加到命令行末尾**。
  // 只收第一个的话，用户框选 10 个文件点一下，结果是**只转了 1 个、而且没有任何提示**——
  // 这正是约束 23 第 5 条（右键菜单的 `%1` 只认第一个，只能靠 MultiSelectModel=Single
  // 把多选藏起来）那个坑的镜像，方向相反。
  const many = parseConvertRequest(
    ['C:\\app\\Arbiter.exe', '--convert', 'C:\\v\\a.mkv', 'C:\\v\\b.mkv', 'C:\\v\\c.mkv'],
    'C:\\'
  )
  check(
    '★ 多文件：--convert 后面的一串路径全部收下（「发送到」多选的落点）',
    many.kind === 'convert' &&
      many.request.paths.length === 3 &&
      many.request.paths[2] === 'C:\\v\\c.mkv',
    JSON.stringify(many)
  )

  // 带空格的路径在命令行里是被引起来的，argv 拆开之后就是普通的一个 token；
  // 中文与 emoji 同理（约束 2 说的正是「shell 根本不参与解析」）。
  const spaced = parseConvertRequest(
    ['Arbiter.exe', '--convert', 'C:\\我的 视频\\a.mkv', 'D:\\b 站\\c.mp4'],
    'C:\\'
  )
  check(
    '多文件 + 带空格 / 中文的路径原样收下（不经过 shell，不涉及引号解析）',
    spaced.kind === 'convert' &&
      spaced.request.paths[0] === 'C:\\我的 视频\\a.mkv' &&
      spaced.request.paths[1] === 'D:\\b 站\\c.mp4',
    JSON.stringify(spaced)
  )

  // 收文件的循环必须在**下一个标志**前面停下，否则 `--to` 会被当成一个文件路径
  //（表现是每个 `--to webm` 都多出一个叫 `--to` 的「文件」，任务里凭空多一条失败）
  const mixed = parseConvertRequest(
    ['Arbiter.exe', '--convert', 'a.mkv', 'b.mkv', '--to', 'webm'],
    'C:\\'
  )
  check(
    '★ 文件串在下一个标志前收手（否则 `--to` 会被当成一个文件路径）',
    mixed.kind === 'convert' && mixed.request.paths.length === 2 && mixed.request.to === 'webm',
    JSON.stringify(mixed)
  )

  const manyRelative = parseConvertRequest(['x.exe', '--convert', 'a.mkv', 'sub\\b.mkv'], 'D:\\dir')
  check(
    '多条相对路径**逐条**按 cwd 展开（只 resolve 第一条是静默的半截修复）',
    manyRelative.kind === 'convert' &&
      manyRelative.request.paths[0] === resolve('D:\\dir', 'a.mkv') &&
      manyRelative.request.paths[1] === resolve('D:\\dir', 'sub\\b.mkv'),
    JSON.stringify(manyRelative)
  )

  const noneAfter = parseConvertRequest(['x.exe', '--convert', '--to', 'webm'], 'C:\\')
  check(
    '--convert 后面直接跟标志 → error（不能默默收成 0 个文件）',
    noneAfter.kind === 'error',
    JSON.stringify(noneAfter)
  )
}

function testQuoting(): void {
  console.log('\n[2] Windows 命令行拼接')

  check('无空白的参数不加引号', quoteWindowsArg('mp4') === 'mp4')
  check(
    '含空格必须加引号',
    quoteWindowsArg('C:\\Program Files\\x.exe') === '"C:\\Program Files\\x.exe"'
  )

  // 反斜杠紧邻闭合引号时必须翻倍，否则那个引号被吃掉，
  // 后面的参数会被并进同一个参数里 —— CreateProcess 的经典坑
  check(
    '结尾反斜杠翻倍（不然会吃掉闭合引号）',
    quoteWindowsArg('C:\\Program Files\\') === '"C:\\Program Files\\\\"',
    quoteWindowsArg('C:\\Program Files\\')
  )
  check('内嵌引号转义', quoteWindowsArg('a"b') === '"a\\"b"', quoteWindowsArg('a"b'))

  // 没有空白的路径**刻意不加引号**：不加也完全合法（CreateProcess 会读到行尾），
  // 而多一层引号只是噪音。真正承重的是含空格那条（安装目录在 Program Files 下）。
  const packed = buildContextMenuCommand({
    exe: 'C:\\App\\Arbiter.exe',
    appPath: 'C:\\App\\resources\\app.asar',
    isPackaged: true
  })
  check(
    '打包形态的命令行 = <exe> --convert "%1"',
    packed === 'C:\\App\\Arbiter.exe --convert "%1"',
    packed
  )
  check('占位符 %1 不被转义（转义了 Windows 就替换不进去了）', packed.includes('"%1"'), packed)

  const dev = buildContextMenuCommand({
    exe: 'C:\\node\\electron.exe',
    appPath: 'D:\\project\\message',
    isPackaged: false
  })
  check(
    'dev 形态补上仓库根（否则 electron 不知道要跑哪个应用）',
    dev === 'C:\\node\\electron.exe D:\\project\\message --convert "%1"',
    dev
  )

  const spaced = buildContextMenuCommand({
    exe: 'C:\\Program Files\\Arbiter\\Arbiter.exe',
    appPath: 'C:\\Program Files\\Arbiter\\resources\\app.asar',
    isPackaged: true
  })
  check(
    '★ 装在带空格的目录里时 exe 被引起来（不加引号会被拆成两个参数）',
    spaced.startsWith('"C:\\Program Files\\Arbiter\\Arbiter.exe" '),
    spaced
  )

  /* -------------------------------------------------- 「发送到」的参数串 */

  const sendToPackaged = buildSendToArgs({
    appPath: 'C:\\App\\resources\\app.asar',
    isPackaged: true
  })
  check(
    '「发送到」的参数 = `--convert`（打包形态不补仓库根）',
    sendToPackaged === '--convert',
    sendToPackaged
  )
  // ★★ 这一条是「发送到」与右键菜单**唯一**的形态差异，而且两个方向都会静默出错：
  //   - 写上 `%1` → 快捷方式不做占位符替换，那个 `%1` 会作为字面量留在参数里，
  //     于是每个文件后面都跟着一个指向 `%1` 的假路径（每次转换都多报一个找不到的文件）；
  //   - 把选中的文件也写进去 → 资源管理器**还会再追加一遍**，同一个文件被转两次。
  // 正确做法是「只写 --convert，文件由系统追加」。
  check(
    '★ 「发送到」的参数里**没有** %1（文件由资源管理器追加，写了反而会多出一个假路径）',
    !sendToPackaged.includes('%1'),
    sendToPackaged
  )

  const sendToDev = buildSendToArgs({ appPath: 'D:\\project\\message', isPackaged: false })
  check(
    'dev 形态补上仓库根（否则 electron 会去找一个叫 --convert 的应用目录）',
    sendToDev === 'D:\\project\\message --convert',
    sendToDev
  )
}

function testRegParsing(): void {
  console.log('\n[3] reg query 输出解析')

  // 这一段是**真实抓下来的** `reg query HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer`
  // 输出（列之间是若干空格而不是制表符，各语言版本的列宽还会变）
  const real = [
    '',
    'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer',
    '    ExplorerStartupTraceRecorded    REG_DWORD    0x1',
    '    ShellState    REG_BINARY    240000003E2800',
    '    LogonCount    REG_QWORD    0x85',
    '    UserSignedIn    REG_DWORD    0x1',
    ''
  ].join('\r\n')

  check(
    '按名字取到具名的值',
    parseRegValue(real, 'ExplorerStartupTraceRecorded') === '0x1',
    String(parseRegValue(real, 'ExplorerStartupTraceRecorded'))
  )
  check('ShellState 的十六进制数据完整取回', parseRegValue(real, 'ShellState') === '240000003E2800')
  check('名字不匹配时返回 null', parseRegValue(real, 'NotThere') === null)

  // ★ 首跑踩到的坑，原样留在这里：`reg query KEY /ve` **会**把值名打出来，
  // 而中文系统上它叫 `(默认)`（英文系统才叫 `(Default)`）。
  // 原实现假定「查默认值时名字那一列是空的」，正则要求行首就是 REG_，
  // 于是所有 `/ve` 读回全是 null——装是装上了，却读不出命令行，自愈对比永远不成立。
  // 修法是**不认名字、只认类型标记**（/ve 至多一个值，所以「第一条」就是「那一条」）。
  const veOutput = [
    '',
    'HKEY_CURRENT_USER\\Software\\Classes\\*\\shell\\Arbiter',
    '    (默认)    REG_SZ    用调律者转换',
    ''
  ].join('\r\n')
  check(
    '★ /ve 的值名是本地化的 `(默认)`，按类型标记取而不是按名字取',
    parseRegDefault(veOutput) === '用调律者转换',
    String(parseRegDefault(veOutput))
  )
  check('没有值行时返回 null', parseRegDefault('HKEY_CURRENT_USER\\Software\\X\r\n') === null)

  // ★ 空键的判据（`isEmptyQueryOutput`）。这条补得**很晚**，代价是一次真实的误删：
  // 原判据是「非空行数 ≤ 1」，理由是一句想当然——「空键会打出键名那一行」。**不会。**
  // 下面两段是逐字节抓下来的真实输出，只有摆在一起才看得出问题在哪：
  // 两者都只剩「一个空行 + 也许一行」，光看行数根本分不出「空」和「恰好一个子键」。
  // 实测的形态表见 `core/integration.ts` 里 `isEmptyQueryOutput` 的注释。
  const emptyKeyOutput = '\r\n'
  // 这一行里的 `ThunderShell` 不是编的：开发机上 `HKCU\Software\Classes\*\shell`
  // 里真的躺着迅雷那一项，而它正是被下面这条判据误删掉的（详见文件头）。
  const oneSubkeyOutput = [
    '',
    'HKEY_CURRENT_USER\\Software\\Classes\\*\\shell\\ThunderShell',
    ''
  ].join('\r\n')

  check(
    '★ 真正空的键：只有一个空行、连键名都不打，判成空',
    isEmptyQueryOutput(emptyKeyOutput) === true,
    JSON.stringify(emptyKeyOutput)
  )
  check(
    '★ 恰好 1 个子键：同样只有 1 个非空行，但**绝不能**判成空（`≤ 1` 就是在这里翻的车）',
    isEmptyQueryOutput(oneSubkeyOutput) === false,
    JSON.stringify(oneSubkeyOutput)
  )
  const oneValueOutput = [
    '',
    'HKEY_CURRENT_USER\\Software\\X',
    '    (默认)    REG_SZ    y',
    ''
  ].join('\r\n')
  check(
    '有值的键：判成非空',
    isEmptyQueryOutput(oneValueOutput) === false,
    JSON.stringify(oneValueOutput)
  )

  console.log('\n[4] 逐层清理的键序列')

  // ★★ 生产根键**一个上层都不清**：我们自己的键由 `uninstallContextMenu` 直接删掉，
  //    而它上面就是 `*\shell` ——那是多家软件共用的地方，空也不归我们删（D5）。
  check(
    '★★ 生产根键 → 清理列表是**空的**（`*\\shell` 与 `*` 一个都不动）',
    pruneTargetsFor('HKCU\\Software\\Classes\\*\\shell\\Arbiter').length === 0,
    JSON.stringify(pruneTargetsFor('HKCU\\Software\\Classes\\*\\shell\\Arbiter'))
  )
  check(
    '更深的键 → 只清我们自己那一段，且**绝不会**走到 `*\\shell` 以上',
    JSON.stringify(pruneTargetsFor('HKCU\\Software\\Classes\\*\\shell\\A\\b')) ===
      JSON.stringify(['HKCU\\Software\\Classes\\*\\shell\\A']),
    JSON.stringify(pruneTargetsFor('HKCU\\Software\\Classes\\*\\shell\\A\\b'))
  )
  // 这一条与上一条是一对：**多深的键都不许把 `A` 之外的层带出来**。
  // 少了它，「上界被改成开区间」这件事只在生产根键那一格上被观测到。
  check(
    '★★ 再深也一样，`*\\shell` 永远不在列表里',
    !pruneTargetsFor('HKCU\\Software\\Classes\\*\\shell\\A\\b\\c\\d').includes(
      'HKCU\\Software\\Classes\\*\\shell'
    ),
    JSON.stringify(pruneTargetsFor('HKCU\\Software\\Classes\\*\\shell\\A\\b\\c\\d'))
  )
  check(
    '不在这条路径下的键 → 一个都不清理（宁可不删也不杀错）',
    pruneTargetsFor('HKCU\\Software\\Other\\Thing').length === 0
  )
}

/* ------------------------------------------------------ 真注册表往返（M8 主体） */

async function cleanup(): Promise<void> {
  await reg(['delete', TEST_ROOT, '/f'])
  await reg(['delete', 'HKCU\\Software\\Classes\\*\\shell\\ArbiterM8SelfTest', '/f'])
  await reg(['delete', NEIGHBOR, '/f'])
}

async function testRegistryRoundTrip(): Promise<void> {
  console.log('\n[7] 注册表往返（真实 reg.exe，但走临时键）')

  await cleanup()
  setContextMenuRootForTest(TEST_ROOT)

  // 先记下真实键的状态，收尾时逐字比对——整轮测试都不许碰它
  const realBefore = await reg(['query', REAL_KEY])

  // ---- 先造一个「别人家的动词」，它必须在整轮里活下来 ----
  const neighbor = await reg(['add', NEIGHBOR, '/ve', '/d', '别人的菜单项', '/f'])
  check(
    '前置：邻居键建得起来（否则「没被误伤」那条断言是空转）',
    neighbor.code === 0,
    neighbor.stderr.trim()
  )
  const neighborCmd = await reg([
    'add',
    `${NEIGHBOR}\\command`,
    '/ve',
    '/d',
    'notepad.exe "%1"',
    '/f'
  ])
  check('前置：邻居键的 command 子键建得起来', neighborCmd.code === 0, neighborCmd.stderr.trim())

  // ---- 再在**我们自己那一层**里建一个守门键（见 KEEP 的注释：它让「非空层收手」
  //      这条判据与环境无关） ----
  const keep = await reg(['add', KEEP, '/ve', '/d', '自己这一层的守门键', '/f'])
  check('前置：临时树内部的守门键建得起来', keep.code === 0, keep.stderr.trim())

  // ---- 起点必须是「没装」 ----
  const before = await readContextMenu()
  check(
    '前置：起点确实是未注册（装了的话下面「装上了」那条断言就是空转）',
    before.installed === false && before.error === null,
    JSON.stringify(before)
  )

  // ---- 装 ----
  const installedState = await installContextMenu()
  check('装上之后读回来是已注册', installedState.installed === true, JSON.stringify(installedState))
  check('没有报错', installedState.error === null, String(installedState.error))

  const rawLabel = await reg(['query', contextMenuRoot(), '/ve'])
  check(
    '中文标签写进注册表之后读回来是原样的（证明写路径送进去的是真 UTF-16，不是 GBK 乱码）',
    parseRegDefault(rawLabel.stdout) === '用调律者转换',
    String(parseRegDefault(rawLabel.stdout))
  )

  const rawAll = await reg(['query', contextMenuRoot()])
  check(
    'MultiSelectModel=Single：多选时不显示本项（%1 只会给一个文件，否则会静默少干活）',
    parseRegValue(rawAll.stdout, 'MultiSelectModel') === 'Single',
    String(parseRegValue(rawAll.stdout, 'MultiSelectModel'))
  )
  check(
    'Icon 指向一个 exe',
    (parseRegValue(rawAll.stdout, 'Icon') ?? '').includes('.exe'),
    String(parseRegValue(rawAll.stdout, 'Icon'))
  )

  const rawCommand = await reg(['query', `${contextMenuRoot()}\\command`, '/ve'])
  check(
    '★ command 键与 expectedCommand() 逐字一致（这条就是 Windows 将来要执行的那串）',
    parseRegDefault(rawCommand.stdout) === expectedCommand(),
    `${String(parseRegDefault(rawCommand.stdout))} vs ${expectedCommand()}`
  )
  check(
    'command 里带着 --convert 与 %1',
    (parseRegDefault(rawCommand.stdout) ?? '').includes('--convert') &&
      (parseRegDefault(rawCommand.stdout) ?? '').includes('"%1"')
  )

  // ★ 模块自己的解码器（`decodeRegOutput`）必须能解**非 ASCII** 的值。
  // 上一条断言用的是 ASCII 路径，过不了这一关：UTF-8 硬解 ASCII 也是对的，
  // 只有拿一个中文值走一遍 `readContextMenu()` 才能把「GBK 兜底」这条腿真的压上。
  const staleWrite = await reg([
    'add',
    `${contextMenuRoot()}\\command`,
    '/ve',
    '/d',
    CJK_VALUE,
    '/f'
  ])
  check('前置：中文的过期值写得进去', staleWrite.code === 0, staleWrite.stderr.trim())
  const stale = await readContextMenu()
  check(
    '★ 中文 command 值经模块解码后一字不差（UTF-8 硬解会在这里变成乱码）',
    stale.command === CJK_VALUE,
    `${String(stale.command)} vs ${CJK_VALUE}`
  )
  check(
    '前置：此时 command 与 expected 不同（否则下面「自愈会重写」那条是空转）',
    stale.installed === true && stale.command !== stale.expected,
    JSON.stringify(stale)
  )

  // ---- 幂等：再装一次不报错，且会把过期的值改回来 ----
  const again = await installContextMenu()
  check(
    '重复安装幂等，并把过期的 command 重写回 expected（自愈的那条路）',
    again.installed === true && again.command === again.expected && again.error === null,
    JSON.stringify(again)
  )

  // ---- 卸载 ----
  const removed = await uninstallContextMenu()
  check('卸载之后读回来是未注册', removed.installed === false, JSON.stringify(removed))
  check('卸载没有报错', removed.error === null, String(removed.error))
  check('我们的键真的没了', !(await hasKey(TEST_ROOT)))

  // ★ 逐层清理真的执行了：中间那个空层被删掉了。
  // 空判断写错（比如把非空也当空）的表现就是这里还在。
  check('★ 逐层清理执行了：中间的空层被删掉', !(await hasKey(GONE_LAYER)))

  // ★★ **这一条是「非空层必须收手」的确定性判据**（下面那三条依赖这台机器上
  //    `*\shell` 里还有没有别人的条目，只能算顺带）。判据完全在我们控制的树里：
  //    `SelfTest` 里还有 KEEP，清理到这里必须停。
  check(
    '★★ 清理在非空的层前收手：我们自己那一层里的守门键原封不动',
    (await hasKey(KEEP)) && (await hasKey('HKCU\\Software\\Classes\\*\\shell\\ArbiterM8SelfTest')),
    '守门键被连坐删掉了'
  )

  // ★ 最重要的一条：往上层撞见非空的 `*\shell` 时必须**停下**
  check(
    '★ 邻居键与它的 command 子键原封不动（清理在非空的父键前收手）',
    (await hasKey(NEIGHBOR)) && (await hasKey(`${NEIGHBOR}\\command`)),
    '别人家的菜单项被删了'
  )
  const neighborAfter = await reg(['query', `${NEIGHBOR}\\command`, '/ve'])
  check(
    '★ 邻居的 command 内容也没被动过',
    parseRegDefault(neighborAfter.stdout) === 'notepad.exe "%1"',
    String(parseRegDefault(neighborAfter.stdout))
  )
  check('`*\\shell` 键本身还在（它非空，不该被删）', await hasKey(NEIGHBOR_PARENT))

  // ---- 卸载幂等：第二次点关的时候键已经没了 ----
  // 这条首跑是红的：当时用 stderr 里的本地化文案去认「键不存在」，
  // 而那段文本正是 GBK 解出来的乱码，一律被判成真错误。
  const twice = await uninstallContextMenu()
  check(
    '重复卸载幂等（键不存在不算失败，也不该报错）',
    twice.installed === false && twice.error === null,
    JSON.stringify(twice)
  )

  // ---- syncContextMenu 的两个方向 ----
  const on = await syncContextMenu(true)
  check('syncContextMenu(true) 落到「已注册」', on.ok && on.state.installed)
  const off = await syncContextMenu(false)
  check('syncContextMenu(false) 落到「未注册」', off.ok && !off.state.installed)

  // ---- 真实键全程未被触碰 ----
  const realAfter = await reg(['query', REAL_KEY])
  check(
    '★ 整轮测试没有碰过用户真实的右键菜单键（前后状态逐字相同）',
    realBefore.code === realAfter.code && realBefore.stdout === realAfter.stdout,
    `before=${String(realBefore.code)} after=${String(realAfter.code)}`
  )

  await cleanup()
  setContextMenuRootForTest(null)

  // 收尾核对：临时键与邻居键都必须清干净，跑完不在用户机器上留东西
  check(
    '跑完不留痕迹（临时键与邻居键都已删除）',
    !(await hasKey(TEST_ROOT)) && !(await hasKey(KEEP)) && !(await hasKey(NEIGHBOR))
  )
}

/* ---------------------------------------------------------------- 主流程 */

/* ------------------------------------------- [6] 重命名即转换：判定（纯逻辑） */

const entry = (name: string, size = 1000): DirEntry => ({ name, size })

const exists = async (path: string): Promise<boolean> => {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/**
 * 判据全是「不许动用户文件」的方向，所以下面每一条**不命中**的断言都配着一个
 * 说得出的危险场景——它们不是装饰，是这道闸存在的理由。
 */
function testRenameWatch(): void {
  console.log('\n[6] 重命名即转换：判定（纯逻辑）')

  // ---- 基本命中 ----
  const hit = diffRename('D:\\w', [entry('a.mkv')], [entry('a.mp4')])
  check(
    'mkv → mp4：认出是一次改名',
    hit.length === 1 && hit[0]?.from === 'a.mkv' && hit[0]?.to === 'a.mp4'
  )
  // 路径取「改名后」那一个：待改回去的就是它
  check('候选里带的是改名后那个文件的绝对路径', hit[0]?.path === join('D:\\w', 'a.mp4'))
  check('两个扩展名都解析成小写无点', hit[0]?.fromExt === 'mkv' && hit[0]?.toExt === 'mp4')
  check(
    '词干大小写不敏感（Windows 的文件名不区分大小写）：A.mkv → a.mp4 照样配对',
    diffRename('D:\\w', [entry('A.mkv')], [entry('a.mp4')]).length === 1
  )

  // ---- 不许误判的四道闸 ----
  check(
    '★ 体积不等就不算改名 —— 挡的是「删掉 a.mkv、又从别处弄来个不相干的 a.mp4」',
    diffRename('D:\\w', [entry('a.mkv', 1000)], [entry('a.mp4', 2000)]).length === 0
  )
  check(
    '词干不同不配对（a.mkv 消失、b.mp4 出现是两件不相干的事）',
    diffRename('D:\\w', [entry('a.mkv')], [entry('b.mp4')]).length === 0
  )
  check(
    '★ 出现的那一侧有两个候选就不猜（a.mkv → a.mp4 与 a.webm 同时出现）',
    diffRename('D:\\w', [entry('a.mkv')], [entry('a.mp4'), entry('a.webm')]).length === 0
  )
  check(
    '★ 消失的那一侧有两个候选也不猜（a.mkv 与 a.avi 同时消失）',
    diffRename('D:\\w', [entry('a.mkv'), entry('a.avi')], [entry('a.mp4')]).length === 0
  )
  check(
    '没有任何变化时不产出候选',
    diffRename('D:\\w', [entry('a.mkv'), entry('b.mp4')], [entry('a.mkv'), entry('b.mp4')])
      .length === 0
  )
  // 这条是「第一次扫只建基线」在纯逻辑层的对应物：`before` 为空时 gone 必然为空
  check(
    '空基线不产出候选（启动瞬间不会把既有文件当成刚出现）',
    diffRename('D:\\w', [], [entry('a.mp4')]).length === 0
  )
  check(
    '★ 压缩包改扩展名（zip → 7z）在 diff 这一层就被挡掉（类别判据不是只挡 renameConvertible）',
    diffRename('D:\\w', [entry('a.zip')], [entry('a.7z')]).length === 0
  )

  // ---- 扩展名白名单 ----
  check('视频类内部可以（mp4 → mkv）', renameConvertible('mp4', 'mkv'))
  check('音频类内部可以（mp3 → m4a）', renameConvertible('mp3', 'm4a'))
  check('图片类内部可以（png → jpg）', renameConvertible('png', 'jpg'))
  check('同一格式不算（mp4 → mp4）', !renameConvertible('mp4', 'mp4'))
  check('空扩展名不算', !renameConvertible('', 'mp4') && !renameConvertible('mp4', ''))
  check('目标不在能力矩阵里（mkv → mkv2）不做', !renameConvertible('mkv', 'mkv2'))
  check('★ 文档类是重型按需下载引擎，一律不参与（txt → mp4）', !renameConvertible('txt', 'mp4'))
  check('★ 目标是文档类也不做（mp4 → pdf）', !renameConvertible('mp4', 'pdf'))
  check(
    '★ 需要现下引擎的组合一律不做（docx → pdf 要走 LibreOffice 的 357 MB）',
    !renameConvertible('docx', 'pdf')
  )
  check('★ 压缩包不在三类里（zip → 7z）', !renameConvertible('zip', '7z'))
  check('★ 电子书不在三类里（epub → mobi）', !renameConvertible('epub', 'mobi'))
  // 这一条是**类别判据独有的**：能力矩阵放行（图片确实能转 PDF）、也不需要下载
  // （走 Chromium 打印），挡住它的只有「只认 video/audio/image」那一条。
  // 少了它，上面那几条「不在三类里」的断言全都同时被矩阵挡着，等于没在测类别判据。
  check(
    '★ 图片 → PDF 也不做（矩阵放行、不用下载，只有类别判据挡得住）',
    !renameConvertible('png', 'pdf')
  )

  // ---- 临时名 ----
  check(
    '我们自己写出的 `.part.<ext>` 不进快照（否则每次转换都会自我触发）',
    !watchableName('a.part.mp4') && !watchableName('a.PART.mkv')
  )
  check('普通名字照收（`a.mp4`）', watchableName('a.mp4'))
  check('名字里含 part 但不是临时名的照收（`report.mp4`）', watchableName('report.mp4'))
  check(
    '`.part` 结尾但后面没有扩展名的照收（`a.part` 不是我们写的，那是用户自己的文件）',
    watchableName('a.part')
  )
}

/* ------------------------------------- [7] 重命名即转换：装配（真目录 + 真 fs） */

/**
 * 这一段驱动的是真 `RenameWatcher`、真临时目录、真 `fs.rename`。
 * 只把「入队 / 通知 / 告警」三个出口换成捕获器——那三件事在测试里做不到真的。
 */
async function testRenameService(): Promise<void> {
  console.log('\n[7] 重命名即转换：装配（真临时目录 + 真 fs）')

  const root = await mkdtemp(join(tmpdir(), 'arbiter-rename-'))
  try {
    const source = join(root, 'clip.mkv')
    const renamed = join(root, 'clip.mp4')
    // 判据只比体积，所以不必是真视频：随便一块定长内容就是合格的素材
    await writeFile(source, Buffer.alloc(2048, 7))

    const enqueued: { path: string; to: string }[] = []
    const notified: string[] = []
    const warned: string[] = []
    /** `null` = 收；非 null 时这个字符串就是拒收的理由，断言它会出现在告警里 */
    let rejectWith: string | null = null

    const watcher = new RenameWatcher(
      {
        enqueue: async (path, to) => {
          enqueued.push({ path, to })
          return rejectWith === null ? { ok: true } : { ok: false, reason: rejectWith }
        },
        notify: (_title, body) => notified.push(body),
        warn: (message) => warned.push(message)
      },
      { debounceMs: 20 }
    )

    // ---- 建基线 ----
    await watcher.setDirs([root])
    check('setDirs 之后的第一次扫描只建基线，不产出候选', enqueued.length === 0)

    // ---- 成功路径 ----
    await rename(source, renamed)
    await watcher.rescan()

    check('改名被认出，且入队的是**改回原名**那个路径', enqueued[0]?.path === source)
    check('目标格式取的是用户改成的那个扩展名', enqueued[0]?.to === 'mp4')
    check('★ 源文件原样保留在原名上（这就是「可撤销」的全部含义）', await exists(source))
    check('★ 用户给的那个名字被腾了出来（产物落在那儿）', !(await exists(renamed)))
    check(
      '成功时发了一条系统通知',
      notified.length === 1 && notified[0]?.includes('clip.mkv') === true
    )
    check('成功路径上不告警', warned.length === 0)

    // ★ 这一条是「我们自己动过磁盘之后必须重建基线」的**唯一观测点**。
    //   少了那次 refreshBaseline，磁盘当前状态（clip.mkv）与旧基线（clip.mp4）
    //   之间的差就是一次「mp4 → mkv」的改名，于是这里会再入队一次、来回震荡。
    await watcher.rescan()
    check('★ 处理完之后立刻再扫一遍：不会自我触发（基线吸收了那次改回来）', enqueued.length === 1)

    // ---- 入队被拒：必须把名字还回去 ----
    rejectWith = '引擎没装'
    await rename(source, renamed)
    await watcher.rescan()

    check('被拒时也走到过入队那一步', enqueued.length === 2)
    check('★ 被拒时把文件名还给用户（不能一边不给转换、一边改了他的名字）', await exists(renamed))
    check('★ 被拒时原名不再占着（还回去了就别留半个）', !(await exists(source)))
    check(
      '被拒时告警，且带着拒收的理由（用户得知道名字为什么变回来了）',
      warned.length === 1 && warned[0]?.includes('引擎没装') === true
    )
    check('被拒不算成功，不发成功通知', notified.length === 1)

    // 回滚本身也是一次改名，同样必须被基线吸收
    await watcher.rescan()
    check('★ 回滚之后再扫一遍：同样不自触发', enqueued.length === 2)

    // ---- 关掉监听之后什么都不发生 ----
    rejectWith = null
    await rename(renamed, source)
    watcher.stop()
    await watcher.rescan()
    check('★ stop() 之后 rescan 是空操作（关掉开关就真的不看了）', enqueued.length === 2)

    // ---- 真的 fs.watch 能唤醒重扫吗 ----
    // 上面每一条都是手动调 `rescan()`，所以「事件有没有接上」在那几条里完全没有覆盖。
    // 这一条单独验：真改一次名，只等事件。
    await testRenameWatchEvent()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

async function testRenameWatchEvent(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'arbiter-rename-ev-'))
  // `fs.watch` 建的时候是 `persistent: false`（刻意：监听目录不该撑住进程），
  // 所以在测试里它自己**撑不住事件循环**——没有这个保活定时器，Node 会在事件
  // 到达之前就退出，表现是「测试静默地什么都没跑」。
  const keepAlive = setInterval(() => undefined, 200)

  try {
    await writeFile(join(root, 'clip.mkv'), Buffer.alloc(1024, 3))

    let fire: (() => void) | null = null
    const hit = new Promise<void>((done) => {
      fire = done
    })

    const watcher = new RenameWatcher(
      {
        enqueue: async () => {
          fire?.()
          return { ok: false, reason: '测试：只关心事件有没有到达' }
        },
        notify: () => undefined,
        warn: () => undefined
      },
      { debounceMs: 20 }
    )

    await watcher.setDirs([root])
    await rename(join(root, 'clip.mkv'), join(root, 'clip.mp4'))

    const timedOut = await Promise.race([
      hit.then(() => false),
      new Promise<boolean>((done) => setTimeout(() => done(true), 8000))
    ])

    check('★ 真 fs.watch 事件能唤醒重扫（「事件接上了」这件事只有这里覆盖得到）', !timedOut)
    watcher.stop()
  } finally {
    clearInterval(keepAlive)
    await rm(root, { recursive: true, force: true })
  }
}

/* --------------------------------------------- [8] 「发送到」快捷方式（M9） */

/**
 * 这一节用**真文件**驱动 `core/sendTo.ts` 的整条逻辑，但快捷方式的**编码**
 * （`.lnk` 的二进制格式）由 Electron 的 `shell.writeShortcutLink` 负责，普通 Node 里
 * 拿不到它。所以这里注入一个「用文本文件冒充 .lnk」的 IO：
 *
 *  - 被测的是**我们自己的那部分**：什么时候写、写到哪个路径、怎么判「还在不在」、
 *    自愈的判据、只删自己那一个文件、以及没注入 IO 时**报不报错**；
 *  - 被测不到的：真实 `.lnk` 的写入与读回（`shell.writeShortcutLink` 的
 *    `create`/`update`/`replace` 语义、args 的往返）。那一条是**手工实测**过的，
 *    结论写在 `main/ipc/integration.ts` 的 `electronSendToIo` 注释里。
 *
 * 临时目录里同时造一个「别人家的快捷方式」，用来盯住「绝不碰 SendTo 目录里
 * 别的东西」这条——注册表那边正是同一类事故（误删迅雷的菜单项）。
 */
async function testSendTo(): Promise<void> {
  console.log('\n[8] 「发送到」快捷方式（注入 IO + 真文件）')

  // ---- 没注入 IO 时必须**报错**，不能静默成功 ----
  // 这条排在最前面，因为它测的正是「还没注入」那个状态。
  const noIo = installSendTo()
  check(
    '★ 没注入 IO 时报错并显示在界面上（而不是静默地什么都没做）',
    noIo.installed === false && noIo.error !== null,
    JSON.stringify(noIo)
  )

  const root = await mkdtemp(join(tmpdir(), 'arbiter-sendto-'))
  const foreign = join(root, '别人的快捷方式.lnk')

  const written: { path: string; target: string; args: string }[] = []
  let failWrite: string | null = null

  // 「.lnk」用一个 JSON 文本文件冒充：我们只关心路径与内容，不关心二进制编码
  const backing = new Map<string, string>()

  const fakeIo: SendToIo = {
    write(linkPath, spec) {
      if (failWrite !== null) return failWrite
      const payload = JSON.stringify({ target: spec.target, args: spec.args })
      backing.set(linkPath, payload)
      writeFileSync(linkPath, payload, 'utf8')
      written.push({ path: linkPath, target: spec.target, args: spec.args })
      return null
    },
    read(linkPath) {
      if (!backing.has(linkPath)) return null
      try {
        const parsed = JSON.parse(readFileSync(linkPath, 'utf8')) as {
          target: string
          args: string
        }
        return { target: parsed.target, args: parsed.args, description: '' }
      } catch {
        return null
      }
    },
    remove(linkPath) {
      backing.delete(linkPath)
      try {
        rmSync(linkPath, { force: true })
      } catch {
        return '删除失败'
      }
      return null
    }
  }

  try {
    writeFileSync(foreign, '别人的东西', 'utf8')
    setSendToDirForTest(root)
    setSendToIo(fakeIo)

    check(
      '临时目录下的 .lnk 路径由模块自己算出来，落在测试自己的目录里',
      sendToLinkPath() === join(root, 'Arbiter.lnk'),
      sendToLinkPath()
    )

    // ---- 起点：没装 ----
    const before = readSendTo()
    check(
      '前置：起点确实没装（否则下面「装上了」那条是空转）',
      before.installed === false && before.error === null,
      JSON.stringify(before)
    )

    // ---- 装 ----
    const installed = installSendTo()
    check('装上之后读回来是已安装', installed.installed === true, JSON.stringify(installed))
    check('没有报错', installed.error === null, String(installed.error))
    // ★ 只写**一个**文件：多写一个（比如顺手往目录里塞别的东西）就是往用户的
    //   「发送到」菜单里多塞一项，而用户完全不会把这件事联系到我们头上
    check(
      '★ 只写了我们自己那一个文件',
      written.length === 1 && written[0]?.path === sendToLinkPath(),
      JSON.stringify(written)
    )
    check(
      '内容 = 当前 exe + `--convert`（Windows 将来就是按这条命令拉起我们的）',
      installed.actual?.target === process.execPath &&
        installed.actual.args === installed.expected.args,
      JSON.stringify(installed.actual)
    )

    // ---- 幂等 ----
    const again = installSendTo()
    check('重复安装幂等（不报错、仍是已安装）', again.installed && again.error === null)

    // ---- 自愈：内容被人改坏 / 换了安装目录 ----
    writeFileSync(
      sendToLinkPath(),
      JSON.stringify({ target: 'C:\\旧目录\\Arbiter.exe', args: '' }),
      'utf8'
    )
    const stale = readSendTo()
    check(
      '前置：此时读回来的 target 与 expected 不同（否则下面「自愈会重写」是空转）',
      stale.installed === true && stale.actual?.target !== stale.expected.target,
      JSON.stringify(stale.actual)
    )
    ensureSendTo()
    const healed = readSendTo()
    check(
      '★ 自愈把指向旧 exe 的快捷方式重写成当前 exe（不修的话点了会拉起一个不存在的程序）',
      healed.actual?.target === process.execPath && healed.actual.args === healed.expected.args,
      JSON.stringify(healed.actual)
    )

    // ---- 已经正确时不重写：无条件的重写会惊动杀软与文件监控工具 ----
    const rounds = written.length
    ensureSendTo()
    check(
      '★ 内容已经正确时自愈不再写盘（它是一次读操作，不是一次写操作）',
      written.length === rounds
    )

    // ---- 卸载 ----
    const removed = uninstallSendTo()
    check('卸载之后读回来是未安装', removed.installed === false, JSON.stringify(removed))
    check('卸载没有报错', removed.error === null, String(removed.error))
    check('我们那个文件真的没了', !existsSync(sendToLinkPath()))

    // ★ 与注册表那边逐层清理必须判空是同一条：SendTo 目录里躺着用户自家的
    //   「邮件收件人」「压缩(zipped)文件夹」等等，删错一个就是静默毁掉别人的东西
    check(
      '★ 同级目录里别人家的快捷方式原封不动',
      existsSync(foreign) && readFileSync(foreign, 'utf8') === '别人的东西'
    )

    const twice = uninstallSendTo()
    check('重复卸载幂等（文件不存在不算失败）', twice.installed === false && twice.error === null)

    // ---- syncSendTo 的两个方向 ----
    const on = syncSendTo(true)
    check('syncSendTo(true) 落到「已安装」', on.ok && on.state.installed)
    const off = syncSendTo(false)
    check('syncSendTo(false) 落到「未安装」', off.ok && !off.state.installed)

    // ---- 写失败要如实回报 ----
    failWrite = '磁盘被锁住了（模拟）'
    const failed = installSendTo()
    check(
      '写失败时带错误回去、且状态仍是未安装（界面据此把开关留在原地）',
      failed.installed === false && failed.error === '磁盘被锁住了（模拟）',
      JSON.stringify(failed)
    )
    failWrite = null
  } finally {
    setSendToIo(null)
    setSendToDirForTest(null)
    await rm(root, { recursive: true, force: true })
  }
}

/* ------------------------------------ [9] 转换完成之后的动作（剪贴板 / 目录） */

/**
 * 两条必须同时成立的判据：
 *
 *  - **默认那一档一次 IO 都不做**（连 stat 都不做）。这条要能被反证：
 *    把 `runAfterAction` 里那个提前返回挪到 `sizeOf` 之后，它就翻红。
 *  - 打开之后**写进去的内容逐字符等于产物路径**（不是文件名、不是「路径」两个字）。
 */
async function testAfterAction(): Promise<void> {
  console.log('\n[9] 转换完成之后的动作')

  const root = await mkdtemp(join(tmpdir(), 'arbiter-after-'))
  const small = join(root, 'clip.mp4')
  const big = join(root, 'huge.mp4')
  const gone = join(root, 'already-moved.mp4')

  const calls: string[] = []
  const copyTexts: string[] = []
  let copyFiles: string[] = []

  const fakeIo: AfterActionIo = {
    copyText: (text) => {
      calls.push('copyText')
      copyTexts.push(text)
    },
    copyFile: (path) => {
      calls.push('copyFile')
      copyFiles.push(path)
    },
    reveal: (path) => calls.push(`reveal:${path}`),
    sizeOf: (path) => {
      calls.push(`sizeOf:${path}`)
      if (!existsSync(path)) return null
      return statSync(path).size
    }
  }

  try {
    writeFileSync(small, Buffer.alloc(1024, 7))
    writeFileSync(big, Buffer.alloc(COPY_FILE_MAX_BYTES + 1, 7))

    check('默认档就是「什么都不做」', DEFAULT_AFTER_CONVERT === 'none')
    check('默认档不改变动作（规划层对它原样放行）', planAfterAction('none', 10).action === 'none')

    // ---- ★ 默认设置下不动剪贴板 ----
    const quiet = runAfterAction(DEFAULT_AFTER_CONVERT, small)
    check(
      '★ 默认档：整条链路一次 IO 都没做（连 stat 都没有）',
      quiet.ok && calls.length === 0,
      `calls=${calls.join(',')}`
    )
    check('默认档下剪贴板里的东西一个字都没动', copyTexts.length === 0 && copyFiles.length === 0)

    // 出口注入放在这条之后：上面那条要测的正是「还没做什么」的那个状态
    setAfterActionIo(fakeIo)

    // ---- 复制路径：逐字符等于产物路径 ----
    const pathResult = runAfterAction('copy-path', small)
    check('复制路径：成功', pathResult.ok, String(pathResult.error))
    check('★ 写进剪贴板的内容**逐字符等于**产物路径', copyTexts[0] === small, String(copyTexts[0]))
    check('回执里带着产物名（界面要说出「已复制 XXX 的路径」）', pathResult.name === 'clip.mp4')
    check('没有降级', pathResult.degradeReason === null && pathResult.action === 'copy-path')

    // ---- 复制产物本身：小文件走文件引用 ----
    calls.length = 0
    copyFiles = []
    const fileResult = runAfterAction('copy-file', small)
    check('复制产物：小文件走「文件本身」而不是路径', fileResult.ok && copyFiles[0] === small)
    check(
      '此时不往文本槽里写（写了两边不一致时，用户拿到的会是哪一个说不清）',
      copyTexts.length === 1,
      String(copyTexts.length)
    )

    // ---- ★ 超过阈值：降级成路径，而且**必须说出原因** ----
    calls.length = 0
    copyFiles = []
    const degraded = runAfterAction('copy-file', big)
    check('★ 产物超过阈值时降级为复制路径', degraded.action === 'copy-path' && degraded.ok)
    check('降级后写进剪贴板的是路径', copyTexts[1] === big, String(copyTexts[1]))
    check(
      '★ 降级必须给出原因（否则用户看到的是「选了复制产物、拿到的却是路径」）',
      degraded.degradeReason !== null && degraded.degradeReason.includes('MB'),
      String(degraded.degradeReason)
    )
    check(
      'requested 与 action 分开回报（界面才能把「你选的」与「实际做的」都说清楚）',
      degraded.requested === 'copy-file'
    )

    // ---- 边界：恰好等于阈值不降级 ----
    check(
      '恰好等于阈值时不降级（判据是「大于」而不是「大于等于」）',
      planAfterAction('copy-file', COPY_FILE_MAX_BYTES).action === 'copy-file'
    )

    // ---- 产物没了：不动剪贴板 ----
    calls.length = 0
    const wroteBefore = copyTexts.length
    const missing = runAfterAction('copy-path', gone)
    check(
      '产物不在原处时失败',
      !missing.ok && missing.error === '产物已不在原处',
      String(missing.error)
    )
    check(
      '★ 产物不在时**不往剪贴板里写**（写一个坏路径比什么都不写更糟：用户拿到的是「已复制」）',
      copyTexts.length === wroteBefore
    )

    // ---- 打开所在目录 ----
    calls.length = 0
    const revealed = runAfterAction('open-folder', small)
    check(
      '打开所在目录走 reveal，且不碰剪贴板',
      revealed.ok && calls.includes(`reveal:${small}`) && copyTexts.length === wroteBefore,
      calls.join(',')
    )

    // ---- 渲染进程送来的动作不可信 ----
    calls.length = 0
    const bogus = runAfterAction('copy-everything' as 'copy-path', small)
    check(
      '★ 不认识的动作被拒绝，且一次 IO 都不做（不能默默当成「什么都不做」）',
      !bogus.ok && bogus.error !== null && calls.length === 0,
      String(bogus.error)
    )
  } finally {
    setAfterActionIo(null)
    await rm(root, { recursive: true, force: true })
  }
}

/* ------------------------------------------- [10] 只重跑失败的那几条 */

/**
 * 样本照着真实场景搭：**20 条里 3 条坏**。要盯住的其实只有两件事——
 * 入队的**恰好是那 3 条**，以及那 17 个已成功的产物**一个字节都没被动过**
 * （比对 mtime 与 sha256，双份证据）。
 */
async function testRerunPlan(): Promise<void> {
  console.log('\n[10] 重跑失败项（20 条里 3 条坏）')

  const root = await mkdtemp(join(tmpdir(), 'arbiter-rerun-'))
  const srcDir = join(root, 'src')
  const outDir = join(root, 'out')
  await mkdir(srcDir, { recursive: true })
  await mkdir(outDir, { recursive: true })

  const sources: string[] = []
  const outputs: string[] = []
  const entries: HistoryEntry[] = []

  const entryOf = (
    raw: Partial<HistoryEntry> & { id: string; inputPath: string }
  ): HistoryEntry => ({
    inputName: raw.inputPath.split(/[\\/]/).pop() ?? 'x.mp4',
    category: 'video',
    fromExt: 'mp4',
    toExt: 'mkv',
    engine: 'ffmpeg',
    status: 'done',
    createdAt: 1,
    finishedAt: 2,
    ...raw
  })

  try {
    // 20 个源文件：每一个都在（源文件缺失那一条单独造）
    for (let i = 0; i < 20; i++) {
      const src = join(srcDir, `clip-${i}.mp4`)
      writeFileSync(src, Buffer.from(`source-${i}`, 'utf8'))
      sources.push(src)
    }

    for (let i = 0; i < 17; i++) {
      const out = join(outDir, `clip-${i}.mkv`)
      writeFileSync(out, Buffer.from(`产物-${i}`, 'utf8'))
      outputs.push(out)
      entries.push(
        entryOf({
          id: `done-${i}`,
          inputPath: sources[i] as string,
          outputPath: out,
          status: 'done',
          finishedAt: 100 + i
        })
      )
    }

    // 3 条失败的：源文件都还在（失败是转换自己失败，不是文件没了）
    const failedIds = ['failed-a', 'failed-b', 'failed-c']
    for (let i = 17; i < 20; i++) {
      entries.push(
        entryOf({
          id: failedIds[i - 17] as string,
          inputPath: sources[i] as string,
          status: 'error',
          error: '转换失败',
          finishedAt: 200 + i
        })
      )
    }

    // 开工前把这个目录的状态拍下来：mtime + 内容哈希
    const snapshot = (): string =>
      outputs
        .map(
          (p) =>
            `${p}|${statSync(p).mtimeMs}|${createHash('sha256').update(readFileSync(p)).digest('hex')}`
        )
        .join('\n')
    const before = snapshot()

    const asked: string[] = []
    const plan = planRerun(
      entries.filter((entry) => entry.status === 'error'),
      {
        conflict: null,
        currentPolicy: 'rename',
        exists: (path) => {
          asked.push(path)
          return existsSync(path)
        },
        outputDirFor: () => outDir
      }
    )

    check(
      '★ 只挑出失败的那 3 条（20 条里挂的 3 个，其余 17 个不参与）',
      plan.enqueue.length === 3 && plan.enqueue.every((item) => failedIds.includes(item.id)),
      JSON.stringify(plan.enqueue.map((item) => item.id))
    )
    check('没有冲突（失败的那几条本来就没有产物）', plan.conflicts.length === 0)
    check('没有拒绝', plan.rejected.length === 0, JSON.stringify(plan.rejected))

    // ★ 「没有触碰那 17 个已成功的产物」——两条证据：
    //   1. 代码层面：那 17 个产物的路径**从没被问过**（`asked` 里能逐条核对）；
    //   2. 磁盘层面：mtime 与内容哈希逐字相同。
    //   只做第 2 条是不够的：一次「先读再原样写回」的操作会留下相同的哈希，
    //   却已经改过文件（何况那还会把只读文件搞坏）。
    const touched = outputs.filter((p) => asked.includes(p))
    check('★ 那 17 个产物一次都没被 stat 过', touched.length === 0, touched.join(','))
    check('★ 17 个产物的 mtime 与 sha256 逐字未变', snapshot() === before)

    // ---- 源文件没了：逐条说出来，且不混进队列 ----
    const ghost = join(srcDir, 'gone.mp4')
    const withGhost = [
      ...entries.filter((entry) => entry.status === 'error'),
      entryOf({ id: 'failed-gone', inputPath: ghost, status: 'error' })
    ]
    const ghostPlan = planRerun(withGhost, {
      conflict: null,
      currentPolicy: 'rename',
      exists: (path) => existsSync(path),
      outputDirFor: () => outDir
    })
    check(
      '★ 源文件不在时逐条拒绝，理由就说「源文件已不在原处」',
      ghostPlan.rejected.length === 1 &&
        ghostPlan.rejected[0]?.path === ghost &&
        ghostPlan.rejected[0]?.reason === '源文件已不在原处',
      JSON.stringify(ghostPlan.rejected)
    )
    check('★ 同一批里其余还在的照常入队（一条坏的不能带走三条）', ghostPlan.enqueue.length === 3)

    // ---- 冲突：目标位置已有同名产物 ----
    // 直接拿一条「已成」的条目来重跑：它的自然输出名就是磁盘上那个产物
    const conflictPlan = planRerun([entries[0] as HistoryEntry], {
      conflict: null,
      currentPolicy: 'rename',
      exists: (path) => existsSync(path),
      outputDirFor: () => outDir
    })
    check(
      '★ 有同名产物且用户还没选时：**一条都不入队**，把冲突交回去',
      conflictPlan.enqueue.length === 0 && conflictPlan.conflicts.length === 1,
      JSON.stringify(conflictPlan)
    )
    check(
      '冲突清单里带着那个已被占住的目标路径（用户才知道自己要覆盖的是什么）',
      conflictPlan.conflicts[0]?.outputPath === outputs[0]
    )

    const renamePlan = planRerun([entries[0] as HistoryEntry], {
      conflict: 'rename',
      currentPolicy: 'overwrite',
      exists: (path) => existsSync(path),
      outputDirFor: () => outDir
    })
    check(
      '选了「另存」：入队，且不再报冲突',
      renamePlan.enqueue.length === 1 && renamePlan.conflicts.length === 0
    )
    check('★ 这一档与设置不同时必须上报（调用方要改设置并说出去）', renamePlan.policyChanged)

    const samePolicy = planRerun([entries[0] as HistoryEntry], {
      conflict: 'overwrite',
      currentPolicy: 'overwrite',
      exists: (path) => existsSync(path),
      outputDirFor: () => outDir
    })
    check(
      '选择与当前设置相同时不算改设置（否则界面会平白说一句「已改设置」）',
      !samePolicy.policyChanged
    )

    check('★ 整轮跑完，17 个产物仍然是逐字未变', snapshot() === before)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

/* ------------------------------- [11] 「上次这类文件转成了什么」（预置） */

function testPresetTarget(): void {
  console.log('\n[11] 上次的选择（预置，不是自动执行）')

  const historyOf = (
    rows: {
      category: HistoryEntry['category']
      toExt: string
      status?: HistoryEntry['status']
    }[]
  ): HistoryEntry[] =>
    rows.map((row, index) => ({
      id: `h-${index}`,
      inputPath: `C:\\x\\f${index}.mp4`,
      inputName: `f${index}.mp4`,
      category: row.category,
      fromExt: 'mp4',
      toExt: row.toExt,
      engine: 'ffmpeg',
      status: row.status ?? 'done',
      createdAt: index,
      finishedAt: 100 - index // 序号小的更新（历史是新→旧）
    }))

  const fromHistory = presetTargetFor(
    { fromExt: 'mp4', category: 'video' },
    {},
    historyOf([{ category: 'video', toExt: 'webm' }])
  )
  check(
    '★ 历史里最近一次视频转成了 webm 时，预置 webm 并标记「来自历史」',
    fromHistory?.toExt === 'webm' && fromHistory.fromHistory === true,
    JSON.stringify(fromHistory)
  )

  const noHistory = presetTargetFor({ fromExt: 'mp4', category: 'video' }, {}, [])
  check(
    '★ 没有历史时**静默回落**到类别默认值（绝不返回空选中——那会让「开始」莫名其妙地变灰）',
    noHistory !== null && noHistory.toExt.length > 0 && noHistory.fromHistory === false,
    JSON.stringify(noHistory)
  )

  const sameAsDefault = presetTargetFor(
    { fromExt: 'mp4', category: 'video' },
    {},
    historyOf([{ category: 'video', toExt: 'mkv' }])
  )
  check(
    '历史与内建默认一致时不高亮（内建默认就是 mkv）',
    sameAsDefault?.toExt === 'mkv' && sameAsDefault.fromHistory === false
  )

  const chosenAlready = presetTargetFor(
    { fromExt: 'mp4', category: 'video' },
    { video: 'webm' },
    historyOf([{ category: 'video', toExt: 'webm' }])
  )
  check(
    '历史与用户在设置里选的一致时也不高亮（否则界面天天挂着一句「上次…」）',
    chosenAlready?.toExt === 'webm' && chosenAlready.fromHistory === false,
    JSON.stringify(chosenAlready)
  )

  // ★ 这条是**能力矩阵**那一侧的闸：历史里那条 `mp4 → mkv` 对现在拖进来的 `.mkv`
  //   是非法的（不能转成自己），信任历史会造出一个不可能成功的任务
  const illegal = presetTargetFor(
    { fromExt: 'mkv', category: 'video' },
    {},
    historyOf([{ category: 'video', toExt: 'mkv' }])
  )
  check(
    '★ 历史里那一档对这个源格式不合法时回落到默认（mkv 不能转 mkv）',
    illegal !== null && illegal.toExt !== 'mkv' && illegal.fromHistory === false,
    JSON.stringify(illegal)
  )

  const failedOnly = presetTargetFor(
    { fromExt: 'mp4', category: 'video' },
    {},
    historyOf([{ category: 'video', toExt: 'avi', status: 'error' }])
  )
  check(
    '★ 只认成功过的条目（失败那条记的是「当时想转」，不是一次选择）',
    failedOnly?.fromHistory === false,
    JSON.stringify(failedOnly)
  )

  const otherCategory = presetTargetFor(
    { fromExt: 'mp4', category: 'video' },
    {},
    historyOf([{ category: 'audio', toExt: 'webm' }])
  )
  check(
    '别的类别的历史不参与（音视频混着用时否则会互相污染）',
    otherCategory?.fromHistory === false
  )
}

/* --------------------------- [12] 文件夹递归（E-4）：异步、可取消、有上限 */

/** icacls 只用来造「读不了的目录」，输出不解析（只看退出码），所以不必管码页 */
function icacls(args: string[]): number | null {
  const out = spawnSync('icacls', args, { encoding: 'utf8', windowsHide: true })
  return out.status
}

/** 这个目录现在读得了吗。用来确认 ACL 真的生效（否则下面那条断言就是空转） */
async function canList(dir: string): Promise<boolean> {
  try {
    await readdir(dir)
    return true
  } catch {
    return false
  }
}

/**
 * E-4「文件夹递归」的验收。
 *
 * 这一节盯的是**递归怎么走**，不是「能不能递归」：递归本身用一行 `readdirSync` 就写完了，
 * 而那样写出来的东西会把主进程卡死——`docs/NOTES.md` 开头那句「主进程是唯一真相源，
 * 它一卡整个应用连取消都点不动」说的就是它。所以下面每一条判据都是关于**代价**的：
 *
 *  1. 扫描期间事件循环仍然在转（10ms 定时器 + `setImmediate` 轮次，两个都数）；
 *  2. 随时可取消，取消后**不留半份清单**（拿不到清单就不可能入队）；
 *  3. 有条数上限，到顶了**明说**，不静默截断；
 *  4. 「没进去的东西」都要说得出理由：排除清单、符号链接成环、权限不足。
 *
 * 素材是**现场造的真目录树**（含一个 junction 环和一个 icacls 拒绝读取的目录），
 * 不用假的 IO 替身：递归的全部风险都在真实文件系统的行为上——实测 junction 的
 * dirent 是「既不是文件也不是目录，而是符号链接」（`isDirectory()` 返回 **false**），
 * 少判这一条就会把用户目录里的 junction 整棵子树静默漏掉。
 */
async function testFolderScan(): Promise<void> {
  console.log('\n[12] 文件夹递归（E-4）')

  const root = await mkdtemp(join(tmpdir(), 'arbiter-scan-'))
  const denied = join(root, 'denied')
  let aclOn = false

  const write = (rel: string): void => {
    const full = join(root, rel)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, 'x')
  }

  try {
    write('a.mp4')
    write('b.mkv')
    // 认不出的扩展名：与「这一层认得的文件」用的是同一份能力矩阵判据
    write('junk.xyz')
    write('sub1/c.mp4')
    write('sub1/d.mp3')
    write('sub1/deep/e.png')
    // 前缀排除：本项目自己的测试残留就是这么命名的（约束 30 里那 96 MB 的 blob.bin）
    write('sub1/deep/.tmp-hidden/f.mp4')
    write('node_modules/g.mp4')
    write('.tmp-abc/h.mp4')
    write('denied/i.mp4')

    // 成环：junction 指回它自己的祖先。用 junction 而不是 symlink：
    // Windows 上目录符号链接要开发者模式或管理员，junction **免权限**（实测）。
    let loopReady = false
    try {
      symlinkSync(root, join(root, 'loop'), 'junction')
      loopReady = true
    } catch {
      // 造不出来就明说「没跑」，绝不用一条恒真的断言把它盖过去
    }

    // 权限不足：用 icacls 拒绝当前用户的「列目录/读数据」权限。**故意不注入假的
    // readdir 失败**——「跳过它、继续扫别的」这条判据依赖真实错误对象的形状
    // （抛的是 EPERM 还是别的、`readdir` 到底抛不抛）。
    if (isWin) {
      const user = process.env.USERNAME ?? ''
      aclOn = icacls([denied, '/deny', `${user}:(RD)`]) === 0 && !(await canList(denied))
    }

    const expected = ['a.mp4', 'b.mkv', 'sub1/c.mp4', 'sub1/d.mp3', 'sub1/deep/e.png'].sort()
    const report = await scanFolder(root)
    const got = report.files.map((path) => relative(root, path).replace(/\\/g, '/')).sort()

    check('前置：临时树造好了（下面每一条都对着它）', existsSync(join(root, 'sub1/deep/e.png')))

    check(
      '递归收下嵌套层的文件（顶层 2 + 嵌套 3 = 5），认不出的扩展名不进结果',
      JSON.stringify(got) === JSON.stringify(expected),
      `${JSON.stringify(got)}（上限 ${report.limit}）`
    )

    // ★ 环必须自己挡。挡不住的形态有两种，而它们都不报错：无限递归（把主进程
    //   挂在那儿），或者同一批文件被收进来两遍（用户看到重名的两条任务）。
    check(
      '★ 符号链接成环被自己挡下：不重复扫、也不无限递归（文件数仍是 5 且无重复）',
      loopReady &&
        report.files.length === new Set(report.files).size &&
        report.excluded.some((item) => item.path === join(root, 'loop')),
      `${String(report.files.length)} 个 / 去重后 ${String(new Set(report.files).size)} 个 / 环 ${
        loopReady ? '造好了' : '没造出来'
      }`
    )

    // ★ 排除清单：用户选了一个大目录时，这条决定成败。两项分开断言，
    //   因为它们是两条不同的规则（名字命中 / 前缀命中），坏一条不该带出另一条。
    check(
      '★ node_modules 按名字命中排除清单，未扫描',
      report.excluded.some((item) => item.path === join(root, 'node_modules'))
    )
    check(
      '★ .tmp-* 按前缀命中排除清单，未扫描',
      report.excluded.some((item) => item.path === join(root, '.tmp-abc'))
    )

    if (aclOn) {
      check(
        '★ 读不了的目录只跳过它自己，其余文件照常收进来（权限不足 ≠ 整趟失败）',
        report.skipped.some((item) => item.path === denied) && got.length === expected.length,
        JSON.stringify(report.skipped.map((item) => item.path))
      )
    } else {
      notice('这个环境造不出「读不了的目录」（icacls 没生效），权限那条判据没跑')
    }

    // 只读了 3 个目录（根 / sub1 / sub1-deep）：排除项、成环那条、读不了的目录
    // 一个都没有被走下去。这条是「排除真的省下了工作」的直接证据——不看它的话，
    // 「跳过了 node_modules」可能只是「报告里写了一行，实际照扫不误」。
    check(
      '只读了 3 个目录：排除项、成环的那条、读不了的都没有被走下去',
      report.dirsScanned === 3,
      String(report.dirsScanned)
    )

    // ★ 上限：到顶就停，而且**说出来**。静默截断正是本项目最忌讳的形态
    //   （界面上一切正常，用户以为那 5 个就是全部）。
    const capped = await scanFolder(root, { limit: 3 })
    const capLines = reportLines(capped)
    check(
      '★ 超过条数上限时明说还有没扫到的（不是静默截断）',
      capped.truncated &&
        capped.files.length === 3 &&
        capLines.some((line) => line.path.includes('上限')),
      JSON.stringify(capLines.at(-1))
    )

    // ★ 报告要回到界面上：排除清单、跳过的目录、上限这三件事都必须在
    //   「未收入队列」那张清单里逐条说得出，否则用户没有任何办法知道少的是什么。
    const lines = reportLines(report)
    check(
      '报告的排除清单会随结果回到界面上（用户看得见跳过了什么）',
      lines.some((line) => line.path === join(root, 'node_modules')) &&
        lines.some((line) => line.path === join(root, '.tmp-abc')),
      JSON.stringify(lines)
    )
    check(
      '报告汇总里带着跳过的目录数与上限（界面上一句话就能说完）',
      reportSummary(capped).includes('上限') && reportSummary(report).includes('跳过'),
      reportSummary(report)
    )

    /* ---------------------------------------------------- 确认框那条路 */
    // 「先给 N，用户点了才入队」。判据是**顺序**：`ask` 被问到之前，
    // 调用方手里没有任何文件清单（`planFolderEnqueue` 的返回值就是清单本身）。
    // 收集进数组而不是一个 `let x: T | null = null`：赋值发生在回调里，
    // TS 的收窄看不见它，于是 `x?.buttons` 会被判成 `never`（编译期就报错）
    const asked: { message: string; buttons: string[] }[] = []
    const prompt = confirmPromptFor(report)
    const recursive = await planFolderEnqueue(report, async (p) => {
      asked.push({ message: p.message, buttons: p.buttons })
      return 'recursive'
    })
    check(
      '★ 确认框先给「将加入 N 个文件」，用户点了才入队',
      asked.length === 1 &&
        prompt !== null &&
        prompt.message === '将加入 5 个文件' &&
        recursive.length === 5 &&
        asked[0]?.buttons[0]?.includes('5') === true,
      JSON.stringify(asked[0] ?? null)
    )

    const onlyTop = await planFolderEnqueue(report, async () => 'top')
    check(
      '★ 确认框上「只加这一层」是递归之外的退路（原行为没被替换掉）',
      prompt?.choices.includes('top') === true &&
        onlyTop.length === 2 &&
        onlyTop.every((path) => dirname(path) === root),
      JSON.stringify(onlyTop.map((path) => relative(root, path)))
    )

    const cancelledByUser = await planFolderEnqueue(report, async () => 'cancel')
    check(
      '★ 确认框上按取消 → 一个文件都不入队（不是「入队 0 个」）',
      cancelledByUser.length === 0 && prompt?.choices.at(-1) === 'cancel'
    )

    // 0 个文件时不弹框：那不是一次确认，是一句噪音（调用方会给「此处没有认得的文件」）
    let askedForEmpty = 0
    const nothing = await planFolderEnqueue({ ...report, files: [] }, async () => {
      askedForEmpty += 1
      return 'recursive'
    })
    check(
      '一个文件都没有时不弹确认框（不出现「将加入 0 个文件」）',
      askedForEmpty === 0 && nothing.length === 0
    )

    // 报告最多逐条列 20 项，多出来的折成一行汇总：一张一千行的清单等于没有清单
    const flood: ScanReport = {
      ...report,
      skipped: [],
      truncated: false,
      excluded: Array.from({ length: 30 }, (_item, index) => ({
        path: join(root, `skip-${index}`),
        reason: '按默认排除清单跳过，未扫描'
      }))
    }
    const floodLines = reportLines(flood)
    check(
      '报告里最多逐条列 20 项，多出来的折成一行汇总',
      floodLines.length === 21 && (floodLines.at(-1)?.path ?? '').includes('另有 10 个'),
      JSON.stringify(floodLines.at(-1))
    )

    /* -------------------------------------------- 事件循环：扫描期间还得转 */
    // 素材：600 个目录 × 4 个文件。让出次数由**目录数**决定（每个目录一次
    // `await readdir`），实测这一棵树扫完约 100 ms。
    // 造两棵：第二棵给「扫到一半取消」用，它必须是**没被扫过的**——
    // 复用同一棵的话目录项与 realpath 都已经进了系统缓存，扫描会快出一个量级，
    // 那个 10 ms 的定时器就落不到中间了。
    const big = buildWideTree('arbiter-scan-big-')
    const mid = buildWideTree('arbiter-scan-mid-')

    try {
      let ticks = 0
      let turns = 0
      let spinning = true
      const spin = (): void => {
        if (!spinning) return
        turns += 1
        setImmediate(spin)
      }
      const timer = setInterval(() => {
        ticks += 1
      }, 10)
      setImmediate(spin)

      const t0 = Date.now()
      const bigReport = await scanFolder(big)
      const ms = Date.now() - t0
      spinning = false
      clearInterval(timer)

      // ★ 这一条是「异步分批」的全部意义。写成同步遍历（`readdirSync`）的话，
      //   整棵树会在**一个 macrotask 里**跑完：这 100 ms 里定时器一次都不触发、
      //   `setImmediate` 一次都轮不到，界面上的取消按钮自然也点不动——
      //   那正是 `docs/PLAN.md` §9.1 说「现阶段的『不递归』是刻意的」时指的东西。
      check(
        '★ 扫描期间事件循环没被堵：10ms 定时器与 setImmediate 都在转',
        ticks > 0 && turns > 0 && bigReport.files.length === 2400,
        `扫描 ${ms} ms：定时器 ${ticks} 次 / 让出 ${bigReport.yields} 次 / setImmediate ${turns} 轮 / 文件 ${bigReport.files.length} 个`
      )
      // 实测数字**主动打出来**：这一条判据的全部意义就是「这段时间里事件循环转了多少次」，
      // 只在翻红时把数字显示出来，等于平时看不见自己的余量（3 次和 300 次是两回事）。
      console.log(
        `  · 实测：${bigReport.files.length} 个文件 / ${bigReport.dirsScanned} 个目录扫了 ${ms} ms，` +
          `期间 10ms 定时器触发 ${ticks} 次、setImmediate 轮 ${turns} 次、显式让出 ${bigReport.yields} 次`
      )

      // ★ 可取消：取消点**只能是让出点**，所以「取消落没落在扫描中间」这件事
      //   本身就是「事件循环有没有在转」的第二个证据（同步遍历下这个定时器
      //   要等整棵树扫完才会触发，那时报告已经是完整的了）。
      let userCancelled = false
      const cancelTimer = setTimeout(() => {
        userCancelled = true
      }, 10)
      const t1 = Date.now()
      const stopped = await scanFolder(mid, { shouldCancel: () => userCancelled })
      const stoppedMs = Date.now() - t1
      clearTimeout(cancelTimer)

      check(
        '★ 扫到一半取消：取消真的落在了扫描中间，且不留半个状态',
        stopped.cancelled &&
          stopped.files.length === 0 &&
          stopped.truncated === false &&
          stopped.dirsScanned < 601 &&
          stoppedMs < ms,
        `取消时已读 ${stopped.dirsScanned} 个目录 / 用掉 ${stoppedMs} ms（整棵 ${ms} ms）/ 文件 ${stopped.files.length} 个`
      )
      console.log(
        `  · 实测：10 ms 的取消定时器落定时，扫描只走了 ${stoppedMs} ms（整棵要 ${ms} ms）、` +
          `读了 ${stopped.dirsScanned} / 601 个目录，报告里的文件数是 ${stopped.files.length}`
      )

      const cancelledPlan = await planFolderEnqueue(stopped, async () => 'recursive')
      check('取消掉的报告不可能被入队（确认与入队都拿不到清单）', cancelledPlan.length === 0)
    } finally {
      await rm(big, { recursive: true, force: true })
      await rm(mid, { recursive: true, force: true })
    }
  } finally {
    // ACL 必须先还回去：拒绝读权限之后连删都删不掉（实测 EPERM）
    if (aclOn) icacls([denied, '/remove:d', process.env.USERNAME ?? ''])
    await rm(root, { recursive: true, force: true })
  }
}

/** 造一棵「600 个目录 × 4 个文件」的宽树，用来量事件循环有没有被堵住 */
function buildWideTree(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix))
  for (let d = 0; d < 600; d++) {
    const sub = join(root, `d${d}`)
    mkdirSync(sub)
    for (let i = 0; i < 4; i++) writeFileSync(join(sub, `f${i}.mp4`), 'x')
  }
  return root
}

async function main(): Promise<void> {
  console.log('=== 系统集成自测（M8）===')

  testArgvParsing()
  testQuoting()
  testRegParsing()
  testRenameWatch()
  await testRenameService()
  await testSendTo()
  await testAfterAction()
  await testRerunPlan()
  testPresetTarget()
  await testFolderScan()

  if (!isWin) {
    // 非 Windows 上整个功能不存在（`reg.exe` 都没有），所以**只跳过注册表那一段**，
    // 上面的纯逻辑照跑。这里用 notice 而不是 check(true)：一句恒真的断言是装饰，
    // 而「这台机器上没跑」这件事应该看起来就是「没跑」。
    notice('非 Windows：跳过注册表往返（该平台上整个功能不存在）')
    await cleanup()
  } else {
    await testRegistryRoundTrip()
  }

  console.log(`\n=== 通过 ${passed} / 失败 ${failed} / 跳过 ${skipped} ===`)
  process.exit(failed === 0 ? 0 : 1)
}

void main()
