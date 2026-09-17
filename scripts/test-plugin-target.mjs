/**
 * 插件「找应用」那一步的验收（`plugins/arbiter/mcp/target.mjs`）。
 *
 * ## 它盯的是哪件事
 *
 * `candidateRoots()` 原先只认三个**默认**安装位置：`%LOCALAPPDATA%\Programs\Arbiter`、
 * `%ProgramFiles%\Arbiter`、`%ProgramFiles(x86)%\Arbiter`——那是 NSIS 的默认值，
 * 而安装向导**允许改**（`electron-builder.yml` 的 `allowToChangeInstallationDirectory`）。
 * 2026-09-17 实测：应用装在 `D:\tools\Arbiter` 时三个标准位置一个都不存在，
 * `resolveTarget()` 返回 **null**，插件的 MCP server 直接报「没有在本机找到可用的 Arbiter」
 * 并退出——而应用明明装好了、命令行也能用。
 *
 * 修法是去注册表的卸载表里问一句（`registryRoots`）。**这个脚本就是那次修复的守卫。**
 *
 * ## 为什么它必须存在（而不是并进 test-plugin-launch.mjs）
 *
 * `test-plugin-launch.mjs` 要一个 62 MB 的构建产物（`npm run build:unpack`），
 * 所以**刻意不进聚合**——聚合得能在干净 clone 上跑。而这里判的全是纯逻辑 + 一次
 * 临时注册表键的往返，秒级、零构建，**能进聚合**；而这条 bug 恰恰是最该进聚合的那种：
 * 它的表现是「在用户机器上插件整个起不来」，而开发机上因为仓库根那条候选永远撞不到。
 *
 * ## 三条来自审计（2026-09-17）的硬约束，别退化
 *
 * - **注入的键必须是「父键 + `{GUID}` 子键」这个生产形态。** 第一版注入的是**叶子键**
 *   （值直接挂在被查询的键上），于是 `reg query` 的 `/s`（递归子键）拿掉都不会红——
 *   而生产注入的正是父键 `…\CurrentVersion\Uninstall`，条目在它的子键里。实测对照：
 *   带 `/s` 查父键能拿到子键里的值，去掉 `/s` 就是空 ⇒ **整条修复静默失效而套件全绿**。
 * - **凡「不该出现」型断言都要有非空前置。** 空集合上恒真的断言本项目抓到过四条。
 * - **环境变量要先清干净。** `ARBITER_HOME` 是**面向用户的文档化变量**
 *   （插件 README 教用户写进 `.mcp.json`），而它在 `candidateRoots()` 里是**短路**的：
 *   谁在 shell 里 export 过它，跑这个套件就会拿到三条「看不懂为什么红」的失败。
 *
 * ## 前提：只跑 Windows
 *
 * 判断里直接查注册表、找 `Arbiter.exe`。仓库本身只支持 Windows、CI 也是
 * `windows-latest`，所以不另做跳过分支——一个会跳过的测试看起来和通过一模一样。
 *
 * ## 全程不碰用户真实的卸载表
 *
 * 所有注册表操作都对着 `HKCU\Software\ArbiterPluginTargetTest\<pid>` 这个临时键做，
 * 用完就删（与 `test-integration.ts` 用临时键测右键菜单是同一套做法）。
 */
import { spawnSync } from 'child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'

import {
  MCP_ENTRY,
  REPO_ROOT,
  candidateRoots,
  decodeRegOutput,
  parseInstallRoots,
  probe,
  registryRoots,
  resolveTarget
} from '../plugins/arbiter/mcp/target.mjs'

// 用户的 shell 里可能 export 过它（插件 README 就是这么教排查的），而它是**短路**的。
// 不清掉的话 [1]~[3] 会整片红，而失败信息里一个字都不会提到这个变量。
delete process.env.ARBITER_HOME

let passed = 0
let failed = 0

function check(label, ok, detail = '') {
  if (ok) {
    passed += 1
    console.log(`  ✔ ${label}`)
  } else {
    failed += 1
    console.log(`  ✗ ${label}${detail ? `  ← ${detail}` : ''}`)
  }
}

/** 数组按元素顺序逐个比——`parseInstallRoots` 的顺序是承重的（先命中的先被 probe） */
const sameArray = (a, b) =>
  Array.isArray(a) && a.length === b.length && a.every((v, i) => v === b[i])

/**
 * 测试自己的 `reg.exe` 辅助函数。
 *
 * **刻意不与被测的 `registryRoots` 共用任何东西**（本项目的老规矩，见
 * `test-integration.ts` 里那条）：共用就变成「自己验自己」——解码器或分块逻辑坏掉时
 * 两边一起坏，断言照样绿。这里只负责起进程、把字节原样收回来。
 */
function reg(args) {
  const out = spawnSync('reg.exe', args, { windowsHide: true })
  return { code: out.status, stdout: out.stdout ?? Buffer.alloc(0), error: out.error }
}

/** 手写一段 `reg query /s` 的输出块。`values` 里的缩进与列间距照真输出写。 */
const block = (guid, values) =>
  `HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${guid}\n\n${values}\n`

console.log('插件「找应用」验收（target.mjs）\n')

// ── [1] parseInstallRoots：纯逻辑，喂手写的 reg 输出 ─────────────────────────
console.log('[1] parseInstallRoots（手写输出，不起子进程）')

const cases = [
  {
    // 只给 DisplayIcon，而且路径里带空格——`UninstallString` 兜底那条路因此走不到，
    // 「先按引号取、再按 `.exe` 截」这两条判据里任何一条坏了它都会红。
    label: 'DisplayIcon（无引号、路径带空格、带 `,0` 图标序号）',
    text: block(
      '{a}',
      '    DisplayName    REG_SZ    Arbiter\n    DisplayIcon    REG_SZ    C:\\Program Files\\Arbiter\\Arbiter.exe,0'
    ),
    want: ['C:\\Program Files\\Arbiter']
  },
  {
    label: '没有 DisplayIcon 时退到 UninstallString（带引号 + 参数 + 空格路径）',
    text: block(
      '{b}',
      '    DisplayName    REG_SZ    Arbiter\n    UninstallString    REG_SZ    "D:\\My Tools\\Arbiter\\Uninstall Arbiter.exe" /currentuser'
    ),
    want: ['D:\\My Tools\\Arbiter']
  },
  {
    label: 'DisplayIcon 带引号且逗号在引号外（`"…\\Arbiter.exe",0`）',
    text: block(
      '{c}',
      '    DisplayName    REG_SZ    Arbiter\n    DisplayIcon    REG_SZ    "D:\\My Tools\\Arbiter\\Arbiter.exe",0'
    ),
    want: ['D:\\My Tools\\Arbiter']
  },
  {
    // 两者**指向不同目录**才算数：第一版让 `.ico` 与卸载器同目录，于是「DisplayIcon 优先」
    // 这条设计决策谁改都不会红（审计实测）。
    label: 'DisplayIcon 与 UninstallString 指向不同目录时，DisplayIcon 赢',
    text: block(
      '{d}',
      '    DisplayName    REG_SZ    Arbiter\n    DisplayIcon    REG_SZ    E:\\图标\\Arbiter.exe,0\n    UninstallString    REG_SZ    "D:\\tools\\Arbiter\\Uninstall Arbiter.exe" /currentuser'
    ),
    want: ['E:\\图标']
  },
  {
    // 同上：`.ico` 与卸载器必须在**不同**目录，否则「必须 `.exe` 结尾」这条判据是装饰。
    label: 'DisplayIcon 指向 `.ico`（且与卸载器不同目录）时退到 UninstallString',
    text: block(
      '{e}',
      '    DisplayName    REG_SZ    Arbiter\n    DisplayIcon    REG_SZ    C:\\Icons\\Arbiter.ico\n    UninstallString    REG_SZ    "D:\\tools\\Arbiter\\Uninstall Arbiter.exe" /currentuser'
    ),
    want: ['D:\\tools\\Arbiter']
  },
  {
    // 目录名里自己带 `.exe`：取「**第一个** `.exe`」会在这里断开、反推出一个根本不存在的
    // `D:\\`（审计 2026-09-17 的 F7 实测量到过）。所以截取必须是贪婪的。
    label: '目录名里含 `.exe` 时按**最后**一个 `.exe` 截',
    text: block(
      '{e2}',
      '    DisplayName    REG_SZ    Arbiter\n    DisplayIcon    REG_SZ    D:\\my.exe.tools\\Arbiter\\Arbiter.exe,0'
    ),
    want: ['D:\\my.exe.tools\\Arbiter']
  },
  {
    // `/f` 是**子串**匹配：「Arbiter Beta」这类邻居条目会一起被捞出来，
    // 只有 DisplayName 恰好等于 `Arbiter` 这一条判据能把它们挡掉。
    label: 'DisplayName 是「Arbiter Beta」时不认（`/f` 是子串匹配）',
    text: block(
      '{f}',
      '    DisplayName    REG_SZ    Arbiter Beta\n    DisplayIcon    REG_SZ    C:\\Other\\Arbiter.exe,0'
    ),
    want: []
  },
  {
    label: '没有 DisplayName 时不认',
    text: block('{g}', '    DisplayIcon    REG_SZ    C:\\Other\\Arbiter.exe,0'),
    want: []
  },
  {
    label: '两个条目：顺序保持（先命中的先被 probe）',
    text:
      block(
        '{h}',
        '    DisplayName    REG_SZ    Arbiter\n    DisplayIcon    REG_SZ    D:\\First\\Arbiter.exe,0'
      ) +
      block(
        '{i}',
        '    DisplayName    REG_SZ    Arbiter\n    DisplayIcon    REG_SZ    E:\\Second\\Arbiter.exe,0'
      ),
    want: ['D:\\First', 'E:\\Second']
  },
  {
    label: '同一个目录出现两次时去重',
    text:
      block(
        '{j}',
        '    DisplayName    REG_SZ    Arbiter\n    DisplayIcon    REG_SZ    D:\\tools\\Arbiter\\Arbiter.exe,0'
      ) +
      block(
        '{k}',
        '    DisplayName    REG_SZ    Arbiter\n    DisplayIcon    REG_SZ    D:\\tools\\Arbiter\\Arbiter.exe,0'
      ),
    want: ['D:\\tools\\Arbiter']
  },
  {
    // 这一条是**两个方向**的：光断「文案不产条目」在空集合上恒真（审计实测它 16 个变异
    // 一次没红过）。把文案**夹在真块两边**，才能断出「文案没被当成条目混进去」——
    // no-match 时 `reg.exe` 把提示写进 **stdout**、退出码为 1，而且那句同样是 GBK。
    label: '提示文案夹在真块中间时不混进结果',
    text:
      '找不到: 找到 0 匹配。\n' +
      block(
        '{l}',
        '    DisplayName    REG_SZ    Arbiter\n    DisplayIcon    REG_SZ    D:\\tools\\Arbiter\\Arbiter.exe,0'
      ) +
      '错误: 找到 0 匹配。\n',
    want: ['D:\\tools\\Arbiter']
  }
]

for (const { label, text, want } of cases) {
  const got = parseInstallRoots(text)
  check(label, sameArray(got, want), `拿到 ${JSON.stringify(got)}`)
}

// 空输入是**崩溃守卫**，不是断言：它唯一会红的方式是实现返回非数组（那时调用方 spread 会炸）。
check('空输入不崩且返回空数组（调用方靠它 spread）', sameArray(parseInstallRoots(''), []))

// ── [1b] decodeRegOutput：纯函数，与机器码页无关 ─────────────────────────────
console.log('\n[1b] decodeRegOutput（纯函数，字节级）')

// 严格 UTF-8 优先这一步在本机（OEM 码页 = GBK）永远是「先成功」，所以只有喂**UTF-8 字节**
// 才测得出来。它在另一类机器上才是承重的：系统开了「使用 Unicode 为 UTF-8」之后 `reg.exe`
// 吐的是 UTF-8，只走 gb18030 会把中文路径解成乱码、`existsSync` 永远为假，**且不报错**。
const utf8Path = 'D:\\工具\\Arbiter\\Arbiter.exe,0'
check(
  'UTF-8 字节按 UTF-8 解（开了「使用 Unicode 为 UTF-8」的机器靠这条）',
  decodeRegOutput(Buffer.from(utf8Path, 'utf8')) === utf8Path,
  JSON.stringify(decodeRegOutput(Buffer.from(utf8Path, 'utf8')))
)

// `d3 c3 b5 f7` 是 GBK 的「用调」。它不是合法 UTF-8（`d3` 后面跟的 `c3` 不是续字节），
// 所以严格 UTF-8 那一步必抛——正好验兜底那一条。
const gbk = Buffer.from([0xd3, 0xc3, 0xb5, 0xf7])
check(
  '不是 UTF-8 时退到 GB18030',
  decodeRegOutput(gbk) === '用调',
  JSON.stringify(decodeRegOutput(gbk))
)

// ── [2] 真 reg.exe 往返（临时键，**父键 + 子键** = 生产形态） ─────────────────
console.log('\n[2] 真 reg.exe 往返（父键 + `{GUID}` 子键，生产形态）')

const PARENT = `HKCU\\Software\\ArbiterPluginTargetTest\\${process.pid}`
const DECOY = `${PARENT}-decoy`
const SECOND = `${PARENT}-second`
const HIDEOUT = 'HKCU\\Software\\ArbiterPluginTargetTest'
const sandbox = mkdtempSync(join(tmpdir(), 'arbiter-plugin-target-'))
// 目录名带中文，是为了把 GBK 那条解码路一并验掉：`reg.exe` 往管道里写的是
// 系统 OEM 码页而不是 UTF-8，按 UTF-8 硬解会得到一屏乱码、而且**不报错**。
const installDir = join(sandbox, '测试安装目录')
// 只有 `Arbiter.exe`、没有入口——用来钉 `probe()` 的 `usable === false`
// （`resolveTarget` 靠它跳过「存在但不可用」的候选）。
const brokenDir = join(sandbox, '半截安装')

/** 造一个「父键 + `{GUID}` 子键」的卸载表条目——**与生产同形**，`/s` 才进得了网。 */
const addEntry = (parent, guid, displayName, icon) => {
  const child = `${parent}\\{${guid}}`
  reg(['add', child, '/v', 'DisplayName', '/t', 'REG_SZ', '/d', displayName, '/f'])
  reg(['add', child, '/v', 'DisplayIcon', '/t', 'REG_SZ', '/d', icon, '/f'])
}

try {
  mkdirSync(join(installDir, 'resources', 'app', dirname(MCP_ENTRY)), { recursive: true })
  writeFileSync(join(installDir, 'Arbiter.exe'), '')
  writeFileSync(join(installDir, 'resources', 'app', MCP_ENTRY), '// 占位\n')
  mkdirSync(brokenDir, { recursive: true })
  writeFileSync(join(brokenDir, 'Arbiter.exe'), '')

  addEntry(
    PARENT,
    '11111111-2222-3333-4444-555555555555',
    'Arbiter',
    `${installDir}\\Arbiter.exe,0`
  )
  addEntry(
    DECOY,
    '66666666-7777-8888-9999-000000000000',
    'Arbiter Beta',
    `${installDir}\\Arbiter.exe,0`
  )
  // 同一台机器上 per-user 与全机都装过时，两个键会给出**同一个**目录
  addEntry(
    SECOND,
    'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    'Arbiter',
    `${installDir}\\Arbiter.exe,0`
  )

  const roundTrip = registryRoots([PARENT])
  check(
    '父键里的安装目录被逐字读回来（含中文路径 → 走的是 GB18030 那条兜底）',
    sameArray(roundTrip, [installDir]),
    `拿到 ${JSON.stringify(roundTrip)}，期望 ${JSON.stringify([installDir])}`
  )

  check(
    '跨键去重：两个键给出同一个目录时只留一个（per-user + 全机都装过的机器）',
    sameArray(registryRoots([PARENT, SECOND]), [installDir]),
    JSON.stringify(registryRoots([PARENT, SECOND]))
  )

  const decoy = registryRoots([DECOY])
  check(
    'DisplayName 不匹配的邻居键不参与（否则会去 probe 一个别人的目录）',
    sameArray(decoy, []),
    `拿到 ${JSON.stringify(decoy)}`
  )

  check(
    '键读不到时返回空数组（这里给一个根本不存在的键）',
    sameArray(registryRoots([`${HIDEOUT}\\never-${process.pid}`]), [])
  )

  // ── [3] candidateRoots 的次序与组成 ────────────────────────────────────────
  console.log('\n[3] candidateRoots 的次序与组成')

  const roots = candidateRoots([PARENT])
  const at = roots.indexOf(installDir)

  check('自定义目录进了候选表', at >= 0, JSON.stringify(roots))

  // 三个标准位置是**多数用户**走的那条路，第一版一条都没断言（审计实测：拿掉
  // `ProgramFiles` 那条不会有任何反应）。
  const standard = [
    join(process.env.LOCALAPPDATA, 'Programs', 'Arbiter'),
    join(process.env.ProgramFiles, 'Arbiter'),
    join(process.env['ProgramFiles(x86)'], 'Arbiter')
  ]
  check(
    '三个标准安装位置都在候选表里（默认安装的用户走的就是这条）',
    standard.every((r) => roots.includes(r)),
    JSON.stringify(roots.slice(0, 4))
  )
  check(
    '它们排在注册表那条之前（安装位置不分高低，但都要压过开发形态）',
    Math.min(...standard.map((r) => roots.indexOf(r))) < at
  )

  check(
    '注册表那条排在开发形态（仓库根）之前 —— 用户机器上没有仓库时，这条就是唯一的依靠',
    at >= 0 && roots.indexOf(REPO_ROOT) > at,
    `indexOf(安装目录)=${at}，indexOf(仓库根)=${roots.indexOf(REPO_ROOT)}`
  )

  // `cwd === REPO_ROOT` 时（从仓库根跑测试就是这么回事）上一条与这一条量的是**同一个下标**，
  // 区分度是假的。所以先切到沙箱里去再问一次——cwd 与仓库根这时才真的是两回事。
  const cwdBefore = process.cwd()
  process.chdir(sandbox)
  try {
    const fromSandbox = candidateRoots([PARENT])
    check(
      '排在 cwd 之前（cwd 只是「开发形态」的兜底，不该压过装好的应用）',
      fromSandbox.indexOf(installDir) >= 0 &&
        fromSandbox.indexOf(process.cwd()) > fromSandbox.indexOf(installDir),
      `indexOf(安装目录)=${fromSandbox.indexOf(installDir)}，indexOf(cwd)=${fromSandbox.indexOf(process.cwd())}`
    )
  } finally {
    process.chdir(cwdBefore)
  }

  check(
    '同样的键送去一个不匹配的条目时，候选表里没有它',
    !candidateRoots([DECOY]).includes(installDir)
  )

  const target = probe(installDir, MCP_ENTRY)
  check(
    'probe 认得出它是打包形态且可用（不然找得到也没用）',
    target?.kind === 'packaged' && target?.usable === true,
    JSON.stringify(target)
  )
  check(
    'probe 对「有 exe 但没有入口」的目录判 usable = false（resolveTarget 靠它跳过）',
    probe(brokenDir, MCP_ENTRY)?.usable === false,
    JSON.stringify(probe(brokenDir, MCP_ENTRY))
  )

  // ── [3b] 端到端：resolveTarget 真的挑中了那份应用 ──────────────────────────
  console.log('\n[3b] 端到端（resolveTarget）')

  const picked = resolveTarget(MCP_ENTRY, [PARENT])
  check(
    '★ 注入临时键后，resolveTarget 真的挑中自定义目录里那份应用（这次修复的全部意义）',
    picked?.root === installDir && picked?.usable === true && picked?.kind === 'packaged',
    JSON.stringify(picked)
  )

  // 反向对照：把键换成不匹配的那一个，它就该挑不中——只断「挑中了」在恒返回同一个值的
  // 实现下也会绿（本项目为此抓到过装饰性断言）。
  const control = resolveTarget(MCP_ENTRY, [DECOY])
  check(
    '★ 反向对照：换成不匹配的键时挑不中它（回落，不报错）',
    control?.root !== installDir,
    JSON.stringify(control)
  )

  // ── [4] ARBITER_HOME 短路 ────────────────────────────────────────────────
  console.log('\n[4] ARBITER_HOME')

  process.env.ARBITER_HOME = sandbox
  try {
    const shorted = candidateRoots([PARENT])
    check(
      '设了 ARBITER_HOME 就只认它一个（不做任何探测，注册表也不查）',
      sameArray(shorted, [sandbox]),
      JSON.stringify(shorted)
    )
  } finally {
    delete process.env.ARBITER_HOME
  }
} finally {
  reg(['delete', PARENT, '/f'])
  reg(['delete', DECOY, '/f'])
  reg(['delete', SECOND, '/f'])
  // 临时键的父层也收掉：留一层空壳在 `HKCU\Software` 下不好看，而且它是我们建的
  reg(['delete', HIDEOUT, '/f'])
  rmSync(sandbox, { recursive: true, force: true })
}

// 判据是**退出码**，不是 stderr 里的文案：那句文案在中文系统上是 GBK，
// 拿它做 `/find/` 匹配必然失效（本项目约束 23 第 4 条，那里为此踩过一回）。
const leftover = reg(['query', HIDEOUT])
check(
  '临时键已清理干净（连父层一起收掉，不给用户的注册表留空壳）',
  leftover.code !== 0,
  `reg query 退出码 ${leftover.code}（0 表示键还在）`
)

console.log(`\n通过 ${passed}，失败 ${failed}`)
if (failed > 0) process.exit(1)
