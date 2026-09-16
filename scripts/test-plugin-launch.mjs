/**
 * Claude Code 插件的启动器验收（`plugins/arbiter/mcp/launch.mjs`）。
 *
 * ## 它盯的是哪件事
 *
 * M5 的验收判据里有一条是「在**干净机器**（没有本仓库的 checkout）上装完就能用」。
 * 那条路上只有一种形态可选：**打包好的应用**。而打包形态的判据是
 * 「打包形态里有没有 `out/main/mcp.js`」——这里有个只在那条路上现形的坑：
 *
 * **普通 Node 的 `existsSync` 看不进 asar。** asar 支持是 Electron 运行时给 `fs`
 * 打的补丁，而启动器是 `command: "node"` 起的。2026-09-13 实测：装了刚 build 出来的包，
 * 启动器却报「没有 MCP 入口」，还补一句「这个安装包可能早于 0.2.0」——判断错，方向也反。
 *
 * 开发机上永远撞不到：`candidateRoots()` 里有仓库根，那条路是普通文件系统，一切正常。
 * **所以这个脚本必须存在**，否则「插件能跑」这件事只在开发机成立。
 *
 * ## 前置
 *
 * 需要先构建出打包形态（`npm run build:unpack`）。**没构建就直接红**，不是静默跳过——
 * 一个会跳过的测试看起来和通过一模一样。
 *
 * ```bash
 * npm run build:unpack
 * node scripts/test-plugin-launch.mjs
 * ```
 */
import { spawn, spawnSync } from 'child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'

import { createPackage, extractFile, listPackage } from '@electron/asar'

import { asarHasEntry } from '../plugins/arbiter/mcp/asar.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const LAUNCH = join(ROOT, 'plugins', 'arbiter', 'mcp', 'launch.mjs')
const MCP_ENTRY = 'out/main/mcp.js'

/** 打包形态的根目录。`ARBITER_TEST_APP_DIR` 可以指到别的产物上（比如真装的应用）。 */
const APP_DIR =
  process.env.ARBITER_TEST_APP_DIR ??
  join(ROOT, 'dist', process.platform === 'win32' ? 'win-unpacked' : 'unpacked')

let pass = 0
let fail = 0

function check(name, ok, detail = '') {
  if (ok) {
    pass += 1
    console.log(`  ✔ ${name}`)
  } else {
    fail += 1
    console.log(`  ✗ ${name}${detail ? ` —— ${detail}` : ''}`)
  }
}

/**
 * 用启动器拉一次 MCP server，把它的两条流收回来。
 *
 * stdin 直接给 `ignore`：server 看到 stdin 关闭就会自己收尾退出，
 * 所以这一跑是「启动 → 就绪 → 收尾」，几秒钟，不用超时兜底。
 */
function runLauncher(env) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [LAUNCH], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...env }
    })
    let stderr = ''
    let stdout = ''
    child.stderr.on('data', (b) => (stderr += b))
    child.stdout.on('data', (b) => (stdout += b))
    child.on('error', (e) =>
      done({ code: null, stderr: `${stderr}\n[spawn 失败] ${e.message}`, stdout })
    )
    child.on('exit', (code) => done({ code, stderr, stdout }))
  })
}

console.log(`插件启动器验收（打包形态：${APP_DIR}）\n`)

// ── [1] 前置：打包产物在不在。不在就直接红，别跳过 ────────────────────────────
console.log('[1] 前置：打包产物')

const exe = join(APP_DIR, process.platform === 'win32' ? 'Arbiter.exe' : 'arbiter')
const resources = join(APP_DIR, 'resources')
const looseApp = join(resources, 'app')
const looseEntry = join(looseApp, MCP_ENTRY)

check(
  '1 先跑过 `npm run build:unpack`（找到打包后的应用）',
  existsSync(exe),
  `没找到 ${exe}——这个脚本不会静默跳过，先构建`
)
// ★ **这条判据与布局无关，这是刻意的。** 打包形态现在用 asar，中间试过一版松散目录
// （`asar: false`，已撤回，见 `electron-builder.yml`）——两种布局都认得了，就不必每次
// 改打包配置都回来改这个脚本。
//
// ⚠️ asar 那一支**必须走 `asarHasEntry`**：普通 Node 的 `existsSync` 看不进 asar，
// 恒为 false（docs/NOTES.md 约束 21，那是真的踩过的坑）。下面第 3～7 条把这件事单独钉住。
const asarPath = join(resources, 'app.asar')
const layout = existsSync(looseEntry) ? 'loose' : asarHasEntry(asarPath, MCP_ENTRY) ? 'asar' : null
check(
  '2 打包布局里有 MCP 入口（asar 或松散目录都认）',
  layout !== null,
  `既没有 ${looseEntry}，也没有 ${asarPath} 里的 ${MCP_ENTRY}`
)

// ⚠️ **闸门不在这里**，挪到第 4～7 条之后了。理由见那一段的注释：
// 那几条只依赖自己造的 fixture，与产物布局无关，而它们正是 `asarHasEntry` 的直接覆盖。
// 闸门卡在这儿的话，`asarHasEntry` 一坏就先被掐掉，那几条**永远跑不到**。

// ── [2] 那个坑本身：普通 Node 的 `existsSync` 读不出一份 asar ────────────────
//
// 这条是**承重的**，不是背景知识：打包形态用的就是 asar，而启动器是普通 Node。
// 判据若写成 `existsSync(<asar>/out/main/mcp.js)`，**恒为 false**，于是启动器会报
// 「没有 MCP 入口」并建议用户重装一个没问题的包（docs/NOTES.md 约束 21，2026-09-13 踩过）。
//
// 用**当场造的一份真 asar** 来验，而不是拿打包产物：产物长什么样无所谓，这里验的是
// `existsSync` 与 `asarHasEntry` 对同一份归档的分歧，所以一份 fixture 就够。
console.log('\n[2] 普通 Node 的 existsSync 看不进 asar（所以判据必须走 asar.mjs）')

const fixtureDir = join(tmpdir(), 'arbiter-asar-fixture')
const fixtureSrc = join(fixtureDir, 'src')
rmSync(fixtureDir, { recursive: true, force: true })
mkdirSync(join(fixtureSrc, 'out', 'main'), { recursive: true })
writeFileSync(join(fixtureSrc, 'out', 'main', 'mcp.js'), '// fixture\n')
writeFileSync(join(fixtureSrc, 'package.json'), '{"name":"fixture"}\n')
const fixtureAsar = join(fixtureDir, 'fixture.asar')
await createPackage(fixtureSrc, fixtureAsar)

check(
  '3 existsSync 看 asar 内部恒为 false——所以**不能**拿它当判据，也不能拿它当落点',
  existsSync(join(fixtureAsar, MCP_ENTRY)) === false,
  '它竟然为 true？那说明这个脚本跑在 Electron 里，前提不成立'
)

// ── [3] asarHasEntry 的判据（老包那条兼容分支）───────────────────────────────
console.log('\n[3] asarHasEntry')

check('4 认得出真的存在的那条（out/main/mcp.js）', asarHasEntry(fixtureAsar, MCP_ENTRY) === true)
check(
  '5 不存在的条目要返回 false，不能瞎认',
  asarHasEntry(fixtureAsar, 'out/main/nope.js') === false
)
check(
  '6 深一层也要认（asar 索引是目录树，不是一层平铺）',
  asarHasEntry(fixtureAsar, 'package.json') === true
)
check(
  '7 传一个不是 asar 的文件不抛异常，只返回 false',
  asarHasEntry(join(ROOT, 'package.json'), MCP_ENTRY) === false
)

// ── 布局闸门 ────────────────────────────────────────────────────────────────
//
// **刻意放在第 4～7 条之后**：那几条只依赖自己造的 fixture，与产物布局无关，
// 而它们正是 `asarHasEntry` 的直接覆盖。放在第 2 条之后的话，一旦 `asarHasEntry`
// 坏掉，闸门会先把脚本掐掉，那几条**永远跑不到**——2026-09-14 反证时就是这样：
// 变异「读错索引长度的偏移（12 → 8）」只让第 2 条翻红，期望清单里那几条全是空跑。
if (layout === null) {
  console.log(
    `\n通过 ${pass}，失败 ${fail}。要么产物没构建（\`npm run build:unpack\`），` +
      '要么上面第 4 / 6 条说明 asar 索引读不出来。'
  )
  process.exit(1)
}

// 3b：**正向控制**——打包里的 Electron 以 Node 模式，从**真实产物**里跑一次 CLI 入口。
//
// 这条替代了原先那个「asar 里的模块 require 不进来 → ERR_INVALID_PACKAGE_CONFIG」的断言。
// 那个错误**复现不了**（2026-09-14 受控 A/B：asar 布局下 `--version` exit 0、真转换也过），
// 而一条复现不了的断言留着只会变成装饰——它红了没人知道是不是环境问题，绿了也证明不了什么。
//
// 换成的这条是**可复现且承重的**：它问的就是「用户双击 `arbiter.cmd` 时那件事成不成立」，
// 即**装的这份产物里，Electron 的 Node 模式能不能把入口跑起来**。判据取「打印出一个版本号」
// 而不只是「退出码是 0」——后者在一个「起来了却什么都没打印」的空入口上照样绿。
// 版本号**不写死**（不跟 `package.json` 比），否则每次发版都得回来改这条断言。
const cliEntry =
  layout === 'asar'
    ? join(asarPath, 'out', 'main', 'cli.js')
    : join(looseApp, 'out', 'main', 'cli.js')

// ⚠️ **2026-09-14 补：这条原先只跑 `electron.exe <入口>`,没有经过 `arbiter.cmd`——**
// 而 `arbiter.cmd` 恰恰是 D2 那个 P0 的**全部交付物**（「CLI 在装好的应用里不存在」）。
// 「等价地跑 electron + 入口」与「用户真跑的那个 .cmd」之间隔着 cmd.exe 一整套解析：
// `%~dp0` 展开、`%*` 传参、`exit /b %ERRORLEVEL%` 回传退出码。实测（同一天）：
//   - `--version` → 退出码 0、stdout **恰好** `0.3.2\n`（协议纯净：诊断全在 stderr）
//   - 带空格/中文、带 `&` 与括号的**已加引号**参数 → 退出码 2，`error.source`
//     与我们给的那个路径**逐字相同**（证明 `%*` 没有把引号吃掉、也没在空格处切一刀）
//
// ⚠️ **这条是正向控制，没有配套的变异**，与它取代的那条一样：它证明的是「这份产物是活的」，
// 而不是「某一行代码写对了」。要变异它得改**构建产物里的 .cmd**，而那不是源码——
// 每个变异都要重跑一次 `build:unpack`，代价远超收益。所以别把它当成有反证覆盖的断言。
//
// ⚠️ 探测时踩过的两次**我自己的错**（写在这里省得下次再踩）：
//   1. `spawnSync('cmd.exe', ['/c', shim, ...args])`——Node 自己拼命令行，对不含引号的参数
//      原样输出，于是 `a&b(c).mkv` 以**未加引号**的形态被 cmd 解析，`&` 成了命令分隔符。
//   2. `spawnSync('cmd.exe', ['/c', 带引号的整行])`——Node 会重新转义，行内的 `"` 变成 `\"`，
//      而 `\"` 在 cmd 里**不是转义序列**（与约束 23 记的 msiexec 那个坑同一条规则）。
//   正确做法是 `shell: true`，让 Node 把整行原样交给 cmd。
const runEntry = spawnSync(exe, [cliEntry, '--version'], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  encoding: 'utf8',
  timeout: 60000
})
check(
  '3b ★ 打包形态的 Electron（Node 模式）跑得起来 CLI 入口，且打印版本',
  runEntry.status === 0 && /^[0-9]+\.[0-9]+\.[0-9]+/.test((runEntry.stdout ?? '').trim()),
  `status=${runEntry.status} stdout=${JSON.stringify((runEntry.stdout ?? '').trim().slice(0, 80))} ` +
    `stderr=${(runEntry.stderr ?? '').replace(/\s+/g, ' ').slice(0, 160)}`
)

// 3c：**真经过 `arbiter.cmd`**（见上面那段说明：它是 D2 的全部交付物）。
// 安装目录里那份 shim 由 `electron-builder.yml` 的 `extraFiles` 落下来，位置与 `Arbiter.exe` 平级。
const packagedShim = join(APP_DIR, 'arbiter.cmd')
if (existsSync(packagedShim)) {
  const runShim = spawnSync(`"${packagedShim}" --version`, {
    shell: true,
    encoding: 'utf8',
    timeout: 60000
  })
  const shimOut = (runShim.stdout ?? '').trim()
  check(
    '3c ★ 装好的 `arbiter.cmd` 跑得起来，且 stdout 上**恰好**一个版本号（诊断全在 stderr）',
    runShim.status === 0 && /^[0-9]+\.[0-9]+\.[0-9]+$/.test(shimOut),
    `status=${runShim.status} stdout=${JSON.stringify(shimOut.slice(0, 80))} ` +
      `stderr=${(runShim.stderr ?? '').replace(/\s+/g, ' ').slice(0, 160)}`
  )

  // 经 cmd 传参是最容易静默丢字的一环：`%*` 少一层引号，带空格的路径就在空格处被切一刀，
  // 而错误信息里那一截路径**看着还挺像那么回事**。判据因此取「逐字回显」而不是「报错了」。
  const spaced = 'C:\\arbiter-no-such-dir\\我的 文件.mkv'
  const amp = 'C:\\arbiter-no-such-dir\\a&b(c).mkv'
  for (const [label, target] of [
    ['空格 + 中文', spaced],
    ['& 与括号', amp]
  ]) {
    const r = spawnSync(`"${packagedShim}" convert "${target}" --to mp4 --json`, {
      shell: true,
      encoding: 'utf8',
      timeout: 60000
    })
    let parsed = null
    try {
      parsed = JSON.parse((r.stdout ?? '').trim())
    } catch {
      /* 下面照报 */
    }
    check(
      `3d ★ 经 shim 传 ${label} 的路径：退出码 2，且回显的 source 与给的一字不差`,
      r.status === 2 && parsed !== null && parsed.error?.source === target,
      `status=${r.status} source=${JSON.stringify(parsed?.error?.source)} 期望=${JSON.stringify(target)}`
    )
  }
} else {
  // 没构建就红，不跳过——一个会跳过的测试看起来和通过一模一样。
  check(
    '3c ★ 装好的 `arbiter.cmd` 跑得起来，且 stdout 上**恰好**一个版本号（诊断全在 stderr）',
    false,
    `没有这个文件：${packagedShim}`
  )
}

// ★ **约束 30 的守卫。** `electron-builder` 的 `files` 规则**不看 `.gitignore`**，
// 所以任何一次测试崩溃或被 kill 留下的 `.tmp-*` / `.scratch-*` 目录都会被
// **静默**打进安装目录 —— 实测过一次瘦包从 141 MB 涨到 446 MB，**而构建全程零报错**。
// 这条守卫此前只能人工查（先 `ls -d .tmp-*` 再读 asar 头），现在由这里自动查。
//
// 两种布局都要能列：asar 走 `listPackage`（只读索引，不碰载荷），松散目录走 `readdirSync`。
// 两种残留都算：目录（`.tmp-test-tasks-123/`）与**文件**（`.scratch-build.txt`）——后者
// 真的漏过一次，因为 `files` 里写的是 `!.scratch-*/**`，那只匹配目录**里面**的东西。
//
// ⚠️ **必须带非空前置**：读不到东西时「里面没有 .tmp」恒真 —— 这条断言会绿着
// 告诉你「一切正常」，而它其实只是「什么都没读到」。本仓库因这类空集合恒真
// 抓到过四条装饰性断言。
// ⚠️ `listPackage` 给的是 `\out\main\index.js`（**带前导分隔符**），归一成
// `out/main/index.js` 才能与下面 [5] 那段按相对路径写的遍历对上。松散目录那边
// `readdirSync` 给的本就是相对路径，但同样过一遍这个归一，两边形状一致。
const entryNames = (
  layout === 'asar' ? listPackage(asarPath) : readdirSync(looseApp, { recursive: true })
).map((p) => String(p).split('\\').join('/').replace(/^\/+/, ''))
const stray = entryNames.filter((n) => /(^|\/)\.(tmp|scratch)-/.test(n))
check(
  '14 安装目录里确实有条目（否则下面那条在空集合上恒真）',
  entryNames.length > 0,
  String(entryNames.length)
)
check(
  '15 ★ 安装目录里没有测试残留（约束 30：files 不看 .gitignore，会静默打包）',
  stray.length === 0,
  stray.slice(0, 5).join(', ')
)

// ── [4] 整体：启动器真的选出打包形态并起得来 ────────────────────────────────
console.log('\n[4] 端到端：启动器选中打包形态')

const base = join(tmpdir(), 'arbiter-plugin-launch')
const result = await runLauncher({
  // 显式指路，跳过全部自动探测——这条测的就是打包分支本身。
  ARBITER_HOME: APP_DIR,
  ARBITER_MCP_DEBUG: '1',
  // 别把真实的 userData / Downloads 卷进来。
  ARBITER_USER_DATA: join(base, 'userdata'),
  ARBITER_DOWNLOADS: join(base, 'downloads')
})

check('8 退出码为 0（不是「找不到应用」那种 1）', result.code === 0, `实际 ${result.code}`)
check(
  '9 选中的形态是 packaged',
  /形态\s+= packaged/.test(result.stderr),
  result.stderr.slice(0, 300)
)
check(
  '10 指向的 MCP 入口在安装目录里（不是仓库那份）',
  /mcp\.js\s+=.*app(\.asar)?[\\/]out[\\/]main[\\/]mcp\.js/.test(result.stderr),
  result.stderr.slice(0, 400)
)
check('11 没报「没有 MCP 入口」', !/没有 MCP 入口/.test(result.stderr))
check('12 MCP server 真的起来了（打过「已就绪」）', /\[arbiter-mcp\] 已就绪/.test(result.stderr))
check(
  '13 stdout 上一个字节都没有（stdout 是协议通道，多一个字就断连）',
  result.stdout === '',
  JSON.stringify(result.stdout.slice(0, 120))
)

// ── [5] CLI 链上不许在**加载期** require electron（审计 2026-09-15 §3.1）────────────
//
// 这一节盯的是一个**只在打包形态现形、且完全静默**的坑。它值得一条结构判据，
// 因为行为判据（下面 [6] 那条）报出来的是 `code=source_corrupt` + 「你的源文件坏了」——
// 一个把因果指反了的句子，实测时在这上面绕了很久。
//
// ## 坑的形状（实测，2026-09-15）
//
// `engines/chromiumPdf.ts` 顶层原来写的是**值** import：
// `import { BrowserWindow, type Session } from 'electron'`。于是它那个 chunk
// （`chunks/chromiumPdf-*.js`）在**加载期**就 `require("electron")`，而它正是 CLI 上
// pdf 出口必经的一环（`converters/document.ts` 动态 import 它）。打包形态下 asar 里
// 没有 `node_modules/electron`，于是：
//
//   `arbiter.cmd convert x.md --to pdf` → `Cannot find module 'electron'`
//   → 被包成「你的源文件坏了」（`code=source_corrupt`）
//
// ⚠️ 而它在 **dev 形态下永远不现形**：`tsconfig.test.json` 把 `electron` 指到
// `scripts/electron-stub.ts`，桩里的 `BrowserWindow` 让「这里有没有 Electron」答「有」。
//
// ⚠️ **顺带撤掉一条错误归因**：这里原先写着「静态进了 `index.js` 的模块，别处对它的
// 动态 import 会被降级成 `require("../index.js")`」。2026-09-15 做了三组受控变异
// （`index.ts` 静态拉 `pdfWorkerHost` / 静态拉 `chromiumPdf` / 宿主里加一句值 import），
// **三种都不复现那条边**——rollup 一律把目标留成自己的 chunk。所以下面的判据只问一件事：
// **闭包里有没有人在加载期 require electron**，不去猜它是怎么进去的。
//
// 反证（同一天实测）：把那句值 import 放回去，**并且让调用点真的用上它**，第 18 条立刻
// 翻红、第 19/20 条一起红。⚠️ 只改 import 不改调用点会**变异成空操作**：`BrowserWindow`
// 在当前代码里只出现在类型位置，rollup 会把整条 import 抹掉（docs/NOTES.md 记过这个坑）。
//
// ## 判据
//
// 从 `cli.js` / `mcp.js` 出发走**所有** require 边（惰性与加载期都跟，因为一条惰性边
// 一旦被走到，那个文件自己的加载期 require 照样会执行），然后对闭包里的每个文件问：
// **你有没有在加载期 require electron？**
//
// ⚠️ **惰性与加载期必须分开**，不能一刀切成「文件里出现过 electron 就算」：本项目
// 到处是 `await import(...)`，rollup 把那些降级成 `Promise.resolve().then(() => require(…))`，
// 而那些边在加载期不会发生（约束 19 全靠这个）。构建产物里的区分是**机械可判**的：
// rollup 的输出里注释被完全剥掉，加载期的 require 一律顶格，惰性的一律裹在
// `Promise.resolve().then(() => require(` 里。
//
// ⚠️ **例外清单只有一条，而且是如实记的**：`chunks/downlink-*.js` 静态
// `import { net } from 'electron'`（`core/downlink.ts:27`），而 `engineInstall` 会惰性地
// `import('./downlink')`。它**今天在 CLI / MCP 上够不到**——2026-09-15 实测：打包形态的
// `arbiter.cmd convert 中文.md --to docx` 在排队之前就回了 `engine_missing`（退出码 3），
// 下载目录一个字节都没动。但这是**行为**保证，不是结构保证：哪天真让 CLI 自动装引擎，
// 它会以同一张面孔炸掉。所以列在这里当**已知缺口**，而不是假装它不存在。
// 清单写死是承重的：来第二条就得有人来解释，而不是静默多一条。
const LOAD_TIME_ELECTRON_ALLOWED = ['chunks/downlink-']

const REQUIRE_RE = /require\((['"])([^'"]+)\1\)/g

/**
 * 一个文件里的 require 分成「加载期」与「惰性」两拨。
 *
 * 判据只看 require 前面那 40 个字符里有没有 `.then(() => `——那是 rollup 降级动态
 * import 的固定形状。够用且机械，不必去解析语法树。
 */
function classifyRequires(source) {
  const loadTime = []
  const lazy = []
  REQUIRE_RE.lastIndex = 0
  let match
  while ((match = REQUIRE_RE.exec(source)) !== null) {
    const before = source.slice(Math.max(0, match.index - 40), match.index)
    if (/\.then\(\(\)\s*=>\s*$/.test(before)) lazy.push(match[2])
    else loadTime.push(match[2])
  }
  return { loadTime, lazy }
}

/** `out/main/chunks/x.js` + `../index.js` → `out/main/index.js`。纯字符串，不碰盘。 */
function joinEntryPath(fromEntry, spec) {
  const stack = fromEntry.split('/').slice(0, -1)
  for (const part of spec.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') stack.pop()
    else stack.push(part)
  }
  return stack.join('/')
}

const entrySet = new Set(entryNames)
// ⚠️ `extractFile` 认的是**平台分隔符、不带前导分隔符**的那种写法（实测：`out\main\x.js` 可以，
// `\out\main\x.js` 与 `out/main/x.js` 都报 not found）。`join(...)` 正好给出这个形状，
// 且在 POSIX 上同样成立。
const readEntry = (rel) =>
  layout === 'asar'
    ? extractFile(asarPath, join(...rel.split('/'))).toString('utf8')
    : readFileSync(join(looseApp, rel), 'utf8')

/** 从入口出发走遍所有能走到的 `.js`，返回 [走到过的文件, 加载期 require electron 的文件]。 */
function walkReachable(entry) {
  const seen = new Set()
  const offenders = []
  const queue = [entry]
  while (queue.length > 0) {
    const current = queue.shift()
    if (seen.has(current) || !entrySet.has(current)) continue
    seen.add(current)
    const { loadTime, lazy } = classifyRequires(readEntry(current))
    if (loadTime.includes('electron')) offenders.push(current)
    for (const spec of [...loadTime, ...lazy]) {
      if (!spec.startsWith('.')) continue // 裸模块名（sharp / zod / 7zip-bin）不是我们的分块
      const target = joinEntryPath(current, spec)
      for (const candidate of [target, `${target}.js`]) {
        if (entrySet.has(candidate)) {
          queue.push(candidate)
          break
        }
      }
    }
  }
  return { seen, offenders }
}

// 正向控制：判据得先证明它**认得出**这件事本身。`index.js` 就是那个必须被认出来的样本
// （它是 GUI 入口，加载期 require electron 是它的本职工作）。
// 少了这条，下面那句「闭包里没有人加载 electron」在分类器**永不命中**时也照样绿——
// 本项目抓到过四条空集合恒真的装饰性断言。
const indexProbe = 'out/main/index.js'
check(
  '16 ★ 判据自证：它认得出 `index.js` 在加载期 require electron',
  entrySet.has(indexProbe) && classifyRequires(readEntry(indexProbe)).loadTime.includes('electron'),
  '分类器没命中——那么下面那条「闭包里没有人加载 electron」是恒真的'
)

const closure = new Set()
const offenders = new Set()
for (const entry of ['out/main/cli.js', 'out/main/mcp.js']) {
  if (!entrySet.has(entry)) continue
  const { seen, offenders: bad } = walkReachable(entry)
  for (const f of seen) closure.add(f)
  for (const f of bad) offenders.add(f)
}
const pdfLeg = [...closure].filter((f) => /^out\/main\/chunks\/chromiumPdf-/.test(f))

// 防空转：pdf 那条腿**必须**在闭包里。它正是这个坑的落点，而它离入口隔着三层动态 import
// （converters/index → document → chromiumPdf）——走不到它，说明这个遍历根本没有穿过惰性边，
// 那么「没人在加载期 require electron」只在入口那两个文件上成立，什么都没验到。
check(
  '17 ★ 遍历确实穿过了惰性边，走到了 pdf 那条腿（chromiumPdf 分块在闭包里）',
  pdfLeg.length > 0,
  `闭包 ${closure.size} 个文件，没有一个是 chromiumPdf 分块`
)

const unexpected = [...offenders]
  .filter((f) => !LOAD_TIME_ELECTRON_ALLOWED.some((prefix) => f.includes(prefix)))
  .sort()
check(
  '18 ★ CLI / MCP 可达的闭包里，加载期 require electron 的只有已知的那一条',
  unexpected.length === 0,
  `多出来：${unexpected.join(', ')} —— CLI / MCP 的进程里没有 Electron 运行时，` +
    '这些文件一被加载就会 require("electron")，报出来的却是「你的源文件坏了」'
)

// ── [6] 端到端：CLI 形态真能产出 PDF（审计 §3.1 的正题）─────────────────────
//
// [5] 是结构判据，这条是行为判据，两条都要：结构那条说得出「为什么」，
// 这条证明「装好的这份产物真的能干活」。
//
// 这条**必须走 `arbiter.cmd`**（用户的真实入口），理由与 3c/3d 那段一样。
// 素材现场造一份 markdown：`md → pdf` 走的是纯 JS 管线 + Chromium 排版，
// `requiresDownload()` 刻意让它不必拖 357 MiB 的 LibreOffice——也就是**不需要任何外部引擎**，
// 干净机器上就能跑。判据取「真 PDF 魔数」，不取「退出码 0」：后者在产物是 0 字节时照样绿。
console.log('\n[6] 端到端：CLI 形态产出 PDF')

if (existsSync(packagedShim)) {
  const pdfDir = join(tmpdir(), 'arbiter-plugin-launch-pdf')
  rmSync(pdfDir, { recursive: true, force: true })
  mkdirSync(pdfDir, { recursive: true })
  const srcPath = join(pdfDir, 'probe.md')
  writeFileSync(
    srcPath,
    '# Arbiter\n\n这一段是 **markdown**，用来确认排版走的是真 Chromium。\n',
    'utf8'
  )
  const productPath = join(pdfDir, 'probe.pdf')

  // env 里**刻意不带** ELECTRON_RUN_AS_NODE：那是 shim 自己设的，我们要验的正是它设对了。
  // 两个 ARBITER_* 把 userData / downloads 隔到临时目录里去，别碰真实的 AppData。
  const r = spawnSync(`"${packagedShim}" convert "${srcPath}" --to pdf --json`, {
    shell: true,
    encoding: 'utf8',
    timeout: 300000,
    env: {
      ...process.env,
      ARBITER_USER_DATA: join(pdfDir, 'userdata'),
      ARBITER_DOWNLOADS: join(pdfDir, 'downloads')
    }
  })

  let parsed = null
  try {
    parsed = JSON.parse((r.stdout ?? '').trim())
  } catch {
    /* 下面照报 */
  }

  const head = existsSync(productPath)
    ? readFileSync(productPath).subarray(0, 5).toString('latin1')
    : ''
  check(
    '19 ★ `arbiter.cmd convert x.md --to pdf` 退出码 0、stdout **恰好**一个 JSON 且 ok',
    r.status === 0 && parsed !== null && parsed.ok === true,
    `status=${r.status} stdout=${JSON.stringify((r.stdout ?? '').slice(0, 200))} ` +
      `stderr=${(r.stderr ?? '').replace(/\s+/g, ' ').slice(0, 200)}`
  )
  check(
    '20 ★ 产物是**真的 PDF**（魔数，不是「退出码 0 但 0 字节」）',
    head === '%PDF-',
    `产品头 ${JSON.stringify(head)}（不存在或不是 PDF）`
  )
} else {
  check(
    '19 ★ `arbiter.cmd convert x.md --to pdf` 退出码 0、stdout **恰好**一个 JSON 且 ok',
    false,
    `没有这个文件：${packagedShim}`
  )
  check(
    '20 ★ 产物是**真的 PDF**（魔数，不是「退出码 0 但 0 字节」）',
    false,
    `没有这个文件：${packagedShim}`
  )
}

console.log(`\n通过 ${pass}，失败 ${fail}。`)
if (fail > 0) process.exit(1)
