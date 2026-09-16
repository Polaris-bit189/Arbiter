/**
 * 反证：把 M3「引擎按需加载 / 剥离 electron」的承重逻辑逐处改回去，确认
 * `scripts/test-electron-free.ts` 里对应的断言真的会翻红。
 *
 * 用法：
 *   node scripts/falsify-electron-free.mjs
 *   npm run falsify:electron-free
 *   node scripts/falsify-electron-free.mjs --only=台账    # 只跑名字命中的变异
 *
 * **为什么必须单独一套变异**：这套被测代码（`converters/index.ts` /
 * `engines/registry.ts` / `converters/document.ts` / `core/appPaths.ts`）在别的套件里也跑得动，
 * 但别的套件**都带着 electron**（`test:tasks` 走 `scripts/electron-stub.ts` 的 paths 映射，
 * `test:pdf` 干脆真起 Electron）。把 electron 换回真的、把动态 import 换回静态 import，
 * 在那两个套件里全是绿的——**变异在那里不会红，脚本会报「有断言没红」，
 * 也很容易被误读成「反证通过」**。变异的家必须是「观测得见这件事的那个套件」。
 *
 * ⚠️ **改 import 的变异必须让那个 import 真的被用上，否则它是空操作。**
 * 实测踩过：只把 `import { runDocument } from './document'` 加到顶部、别处不动，
 * 测试**全绿**——因为该绑定没被使用，esbuild 在 TS 上的 import elision 会把整条语句
 * （连同它的模块求值）一声不响地删掉。于是「变异没生效」伪装成了「断言抓不住错误」，
 * 和锚点命中 0 次是同一类假通过，只有拆开看编译产物才发现了。所以下面每条变异的
 * `to` 里都**同时**把调用点改成用那个静态绑定。
 *
 * 代价：一轮 `test:electron-free` 十几秒（1 秒的 ffmpeg 转码 + 一次 pdfjs 抽文本），
 * 五个变异加基线不到两分钟，所以它**进 `npm run falsify` 的聚合**没问题。
 */
import { spawnSync } from 'child_process'
import { createHash } from 'crypto'
import { readFileSync, writeFileSync } from 'fs'
import { resolve } from 'path'

const INDEX = resolve('src/main/converters/index.ts')
const REGISTRY = resolve('src/main/engines/registry.ts')
const DOCUMENT = resolve('src/main/converters/document.ts')
const CHROMIUM_PDF = resolve('src/main/engines/chromiumPdf.ts')
const APP_PATHS = resolve('src/main/core/appPaths.ts')

const MUTATIONS = [
  {
    // 最容易发生的那种回退：有人「顺手」把某个引擎改回静态 import。
    // 它**不报错**——`document.ts` 自己不在模块层碰 electron，加载得进来，
    // 代价只是「转一个 mp4 也把 pdfjs 拖进了依赖图」。不拆开看依赖图就抓不住。
    name: 'converters/index 把 document 退回静态 import',
    file: INDEX,
    edits: [
      {
        from: "import { ConversionFailed, type ConvertContext } from './common'\n",
        to:
          "import { ConversionFailed, type ConvertContext } from './common'\n" +
          "import { runDocument } from './document'\n"
      },
      {
        // 关键的一半：调用点也必须改用那个静态绑定，否则它被 elide，变异成空操作
        from: [
          "    case 'pdf': {",
          "      const { runDocument } = await import('./document')",
          '      return runDocument(context)',
          '    }'
        ].join('\n'),
        to: ["    case 'pdf': {", '      return runDocument(context)', '    }'].join('\n')
      }
    ],
    expect: ['A 只有被请求的那个引擎进了依赖图（没有别的引擎被静态拉进来）']
  },
  {
    // 引擎路径解析退回「直接读 app」——M3 之前 `registry.ts` 就是读 `app.isPackaged` 的。
    // 静态 import 让整份模块在封锁环境里根本加载不起来，所以整条断言链从加载那一步就断。
    name: 'engines/registry 退回静态读 app（M3 之前的形状）',
    file: REGISTRY,
    edits: [
      {
        from: "import { bundledEnginePath } from '../core/appPaths'\n",
        to: "import { bundledEnginePath } from '../core/appPaths'\nimport { app } from 'electron'\n"
      },
      {
        // 关键的一半：`app` 必须真的出现在**值位置**，否则整个 import 被 elide（见文件头）
        from: "  candidates.push(bundledEnginePath('ffmpeg', 'ffmpeg.exe'))\n",
        to:
          [
            '  candidates.push(',
            '    app.isPackaged',
            "      ? bundledEnginePath('ffmpeg', 'ffmpeg.exe')",
            "      : bundledEnginePath('ffmpeg', 'ffmpeg.exe')",
            '  )'
          ].join('\n') + '\n'
      }
    ],
    expect: ['转换依赖图能在封锁 electron 的情况下加载（静态 import 一个引擎就会红）']
  },
  {
    // 上面那条是**加载期**就炸（整条链在第一步断掉，粒度粗）。这条是**调用期**才碰
    // electron：模块照样加载得进来，只在解析路径那一刻出事——这才是将来真会溜进去的
    // 形态（有人图省事在函数体里写 require('electron')，编译器与 reviewer 都容易放过）。
    name: 'engines/registry 在函数体里 require electron（加载期看不出来）',
    file: REGISTRY,
    edits: [
      {
        from: "  candidates.push(bundledEnginePath('ffmpeg', 'ffmpeg.exe'))\n",
        to:
          [
            '  candidates.push(',
            "    require('electron').app.isPackaged",
            "      ? require('path').join(process.resourcesPath, 'engines', 'ffmpeg', 'ffmpeg.exe')",
            "      : bundledEnginePath('ffmpeg', 'ffmpeg.exe')",
            '  )'
          ].join('\n') + '\n'
      }
    ],
    // 台账那条也是红的：这次 require 的调用方就是 registry.ts，账上会记下来
    expect: [
      '封锁之后仍能解析出 ffmpeg 可执行文件',
      '整轮转换里没有任何模块试图加载 electron（台账为空）'
    ]
  },
  {
    // 最隐蔽的一条，也是台账存在的**唯一理由**：chromiumPdf 一加载就抛错，
    // 于是它进不了模块缓存——「chromiumPdf 没被加载」那条断言在改坏之后
    // **照样是绿的**（空集合上恒真的经典形态）。台账问的是另一个方向，
    // 「有没有人**试图**加载 electron」，它抓得住。
    //
    // ⚠️ **2026-09-15 重写**（原本只改 `document.ts` 那一半）。原先它靠的前提是
    // 「`chromiumPdf.ts` 顶层有 `import { BrowserWindow } from 'electron'`，
    // 所以静态拉它 = 加载期就炸」——而 §3.1 把那个顶层 import 改成了 `import type`
    // + 函数里的惰性 `await import('electron')`。于是「静态拉它」**不再是错误**，
    // 这条变异退化成空操作，断言合理地不红，脚本报的却是「有断言没红」。
    // 现在把 §3.1 **之前的形状完整重建**：`chromiumPdf.ts` 的 electron 挪回模块顶层
    // ＋ `document.ts` 静态拉它。两者缺一不可，见下面每条 edit 上的说明。
    name: 'chromiumPdf 把 electron 挪回模块顶层 + document 静态拉它（§3.1 之前的形状）',
    file: DOCUMENT,
    edits: [
      {
        // 缺陷的**正身**：electron 回到加载期，于是 CLI / MCP（没有 Electron）里
        // 只要沾到 pdf 出口就炸——这正是 §3.1 修掉的那个 P0。
        file: CHROMIUM_PDF,
        from: "import type { BrowserWindow, Session } from 'electron'\n",
        to: "import { BrowserWindow, type Session } from 'electron'\n"
      },
      {
        // 上面那行**必须**配这一条：`BrowserWindow` 今天只出现在类型位置
        // （`let win: BrowserWindow | null`），只加 import 的话 esbuild 的
        // import elision 会把它连模块求值一起删掉——变异成空操作，
        // 伪装成「断言抓不住错误」（约束 34 记过同一个坑）。
        file: CHROMIUM_PDF,
        from: '    const window = new electron.BrowserWindow({\n',
        to: '    const window = new BrowserWindow({\n'
      },
      {
        // 另一半：必须有人**在加载期**把它拉进来，本套件才观测得到。
        // 少了它这条变异是空操作——本套件的 B 节走 `pdf → txt`（pdfjs），
        // 那条路**根本不加载 chromiumPdf**（「B 没把 chromiumPdf 拖进来」那条断言
        // 钉的就是这件事），所以光改 chromiumPdf.ts 的话它一次都不会被求值、
        // 台账永远是空的。
        file: DOCUMENT,
        from: "import { mkdtemp, readFile, rm, writeFile } from 'fs/promises'\n",
        to:
          "import { renderHtmlFileToPdf } from '../engines/chromiumPdf'\n" +
          "import { mkdtemp, readFile, rm, writeFile } from 'fs/promises'\n"
      },
      {
        // 调用点的动态 import 去掉，让上面那个静态绑定真的被用上
        file: DOCUMENT,
        from: "        const { renderHtmlFileToPdf } = await import('../engines/chromiumPdf')\n",
        to: '\n'
      }
    ],
    // 「B 没把 chromiumPdf 拖进来」那条**刻意不在期望里**：chromiumPdf 加载期抛错后
    // 不进缓存，那条断言在改坏之后**照样绿**——空集合上恒真的经典形态。
    // 它能被抓住，靠的正是台账。
    expect: [
      '整轮转换里没有任何模块试图加载 electron（台账为空）',
      'B pdf 出口确实走的是 converters/document'
    ]
  },
  {
    // ------------------------------------------------------------------
    // 诊断型变异：**不要求翻红**。它问的是「这条设计到底有没有用」，
    // 绿灯本身就是结论——而且这一条会绿，这个绿是**坏消息**：
    // 本套件抓不住「appPaths 退化成问 electron 要」这个错误。
    //
    // 原因：`install-test-paths` 早就把路径装好了，兜底分支根本走不到。
    // 也就是说这条退化只能靠两样别的东西盯着：
    //   1. `appPaths.ts` 文件头那段「刻意不兜底」的说明（给人看的）；
    //   2. M4 的 MCP 入口自己必须断言「没调 setAppPaths 时它是抛的」——
    //      那条断言**属于 MCP 那个套件**，不属于这里。别把它记成已覆盖。
    // ------------------------------------------------------------------
    name: 'appPaths 退化成「没装就问 electron 要」（诊断，不要求翻红）',
    diagnostic: true,
    file: APP_PATHS,
    edits: [
      {
        from: '  if (current === null) {\n',
        to:
          [
            '  if (current === null) {',
            '    // 变异（诊断）：退化成「没装就问 electron 要」——设计明文禁止的那条路',
            "    current = appPathsFromElectron(require('electron').app)",
            '    return current'
          ].join('\n') + '\n'
      }
    ],
    expect: []
  }
]

/* ------------------------------------------------------- 锚点自检
 * `--anchors-only` 时**只**数锚点命中次数：不跑基线、不跑任何测试、不改任何源码、
 * 不做任何还原、也不碰 git。全过 exit 0，有锚点命不中 exit 1（逐条打印
 * 「脚本 / 变异名 / 命中次数 / 期望次数」）。
 *
 * 存在的理由：原先「命中次数对不对」这道检查排在基线之后，于是锚点被一次重构弄丢时，
 * 脚本报出来的是「有断言没红」——**看着像断言失效，其实是锚点过期**，还白等一整轮。
 * 见 scripts/lib/anchors.mjs 的文件头。
 */
if (process.argv.slice(2).includes('--anchors-only')) {
  const { anchorsOnlyGuard } = await import('./lib/anchors.mjs')
  // 与脚本正文一致：它读盘后过了 `toLf`（见下面的 `originals` / 循环）
  anchorsOnlyGuard(MUTATIONS, { normalizeLf: true })
}

/**
 * `--only=<名字子串>` 只跑命中的变异。基线照样跑（它是对照组，去掉它这轮结论就没有意义），
 * 但结尾会显著说明「这次只跑了 N / M 个」，免得一次只跑一个变异的绿灯看起来像整轮通过。
 */
const ONLY = (process.argv.slice(2).find((a) => a.startsWith('--only=')) ?? '').slice(
  '--only='.length
)
const selected = ONLY ? MUTATIONS.filter((m) => m.name.includes(ONLY)) : MUTATIONS
if (ONLY && selected.length === 0) {
  console.error(`--only=${ONLY} 一个变异都没匹配上`)
  process.exit(1)
}

/** 跑被测套件，抠出翻红的断言标签。分隔符是 `通过 13 / 失败 0`（斜杠） */
function runTests() {
  const out = spawnSync(
    'npx',
    ['tsx', '--tsconfig', 'tsconfig.test.json', 'scripts/test-electron-free.ts'],
    { encoding: 'utf8', shell: true, maxBuffer: 32 * 1024 * 1024 }
  )
  const text = out.stdout + out.stderr
  const reds = text
    .split(/\r?\n/)
    .filter((line) => line.includes('✗'))
    .map((line) =>
      line
        .replace(/.*✗\s*/, '')
        .replace(/\s+←.*$/, '')
        .trim()
    )
  const total = /通过 (\d+) \/ 失败 (\d+)/.exec(text)
  return {
    reds,
    passed: total ? Number(total[1]) : -1,
    failed: total ? Number(total[2]) : -1,
    text
  }
}

/** 锚点一律在 LF 文本上匹配：混进 CRLF 的话跨行锚点会一声不响地命中 0 次 */
const toLf = (s) => s.replace(/\r\n/g, '\n')

/**
 * 这次变异会碰到哪些文件。
 *
 * 默认是 `m.file`，但**一条 edit 可以自带 `file`**：有的缺陷天然横跨两个文件
 * （「chromiumPdf 加载期碰 electron」要连同「谁在加载期把它拉进来」一起才观测得到），
 * 而一条变异改两个文件是**一个缺陷的两半**，不该拆成两条各自都不成立的变异。
 */
const filesOf = (m) => m.edits.map((edit) => edit.file ?? m.file)

// 必须在**任何变异跑之前**把全部目标文件读进内存，否则还原的依据会是别人改过的版本
const originals = Object.fromEntries(
  [...new Set(MUTATIONS.flatMap(filesOf))].map((f) => [f, readFileSync(f, 'utf8')])
)

console.log(
  ONLY
    ? `只跑 ${selected.length} / ${MUTATIONS.length} 个变异（--only=${ONLY}），基线照样跑一轮…`
    : `${MUTATIONS.length} 个变异，基线跑一轮（约十几秒，每个变异还要各跑一轮）…`
)
// ⚠️ 反证跑着的时候，磁盘上的源码就是**改坏过的**。这段时间里别提交、别下结论。
const baseline = runTests()
console.log(`基线：通过 ${baseline.passed}，失败 ${baseline.failed}`)
if (baseline.failed !== 0) {
  console.error('基线不是全绿，先修好再来反证。')
  if (baseline.failed < 0) {
    console.error('（连「通过 N / 失败 M」那行都没解析到——多半是套件自己崩了）')
  }
  console.error(baseline.text.slice(-2000))
  process.exit(1)
}

let problems = 0

for (const m of selected) {
  // 每个变异各自从 originals 起一份草稿；一条 edit 改哪个文件由它自己的 `file` 说了算
  const drafts = new Map()
  const draftOf = (f) => {
    if (!drafts.has(f)) drafts.set(f, toLf(originals[f]))
    return drafts.get(f)
  }

  // 逐条 edit 各自查命中次数。**命中次数一定要打出来**：只说「没命中唯一一次」的话，
  // 0 次和 2 次根本分不清（6 空格缩进的锚点是 10 空格缩进同款行的子串，踩过）。
  let bad = ''
  for (const edit of m.edits) {
    const file = edit.file ?? m.file
    const current = draftOf(file)
    const hits = current.split(edit.from).length - 1
    console.log(
      `[${m.name}] 锚点命中 ${hits} 次（期望 1 次）：${JSON.stringify(edit.from.slice(0, 40))}`
    )
    if (hits !== 1) {
      bad = `期望 1 次 —— 变异没生效，结论无效（多半是源码重构过，锚点过期了）：${file}`
      break
    }
    drafts.set(file, current.replace(edit.from, edit.to))
  }
  if (bad) {
    console.error(`  ${bad}`)
    problems += 1
    continue
  }

  for (const [file, text] of drafts) writeFileSync(file, text, 'utf8')
  const result = runTests()
  // 还原**这次变异碰过的每一个**文件，不是只有 m.file
  for (const file of drafts.keys()) writeFileSync(file, originals[file], 'utf8')

  const missed = m.expect.filter((label) => !result.reds.includes(label))
  const extra = result.reds.filter((label) => !m.expect.includes(label))

  if (m.diagnostic) {
    // 诊断型：问的是「这条设计有没有用」，绿才是结论。红反而是意外发现，值得说一声。
    console.log(
      result.reds.length === 0
        ? '  绿灯 —— 本套件**抓不住**这个错误（这不是缺陷，是这条断言的已知盲区，见变异里的注释）'
        : `  意外翻红 ${result.reds.length} 条：${result.reds.join(' | ')}`
    )
    continue
  }

  if (missed.length === 0) {
    console.log(`  翻红 ${result.reds.length} 条，期望的都在`)
    for (const label of result.reds) {
      console.log(`    - ${label}${extra.includes(label) ? '   (顺带)' : ''}`)
    }
  } else {
    problems += 1
    console.log('  有断言没红 —— 它们抓不住这个错误：')
    for (const label of missed) console.log(`    ! ${label}`)
    console.log(`  实际翻红：${result.reds.join(' | ') || '（一条都没红）'}`)
    // 把原始输出尾巴贴出来：光看「一条都没红」分不清「变异是空操作」还是
    // 「套件崩在半路」，而这两种情况的修法完全不同（前者改变异，后者修套件）
    console.log('  套件输出末尾：' + JSON.stringify(result.text.slice(-400)))
  }
}

// 收尾再确认源码确实还原了。**这一步不能省**：反证中途被打断（Ctrl-C、崩溃）
// 会留下一份改坏的源码，而它跑起来的样子和「改回来过」一模一样。
const dirty = Object.keys(originals).filter((f) => readFileSync(f, 'utf8') !== originals[f])
if (dirty.length > 0) {
  console.error('\n源码没还原干净：' + dirty.join(', '))
  process.exit(1)
}

// 把每个文件的 sha256 打出来：这条「已还原」的结论不该只有脚本自己说了算
for (const f of Object.keys(originals)) {
  console.log(`  ${createHash('sha256').update(readFileSync(f)).digest('hex')}  ${f}`)
}

const scope = ONLY ? `（**只跑了 ${selected.length} / ${MUTATIONS.length} 个变异**）` : ''
console.log(
  problems === 0
    ? `\n反证通过：每个变异都被对应的断言抓住了，且源码已还原。${scope}`
    : `\n反证不通过：${problems} 处有问题。${scope}`
)
process.exit(problems === 0 ? 0 : 1)
