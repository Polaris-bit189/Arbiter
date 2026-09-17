/**
 * 反证：把 E-7 那套快捷键判据逐处改坏，确认 `scripts/test-shortcuts.ts` 的断言真的会翻红。
 *
 *   node scripts/falsify-shortcuts.mjs
 *   npm run falsify:shortcuts
 *   node scripts/falsify-shortcuts.mjs --only=组字      # 只跑名字命中的变异
 *
 * 被测的只有 `src/renderer/src/lib/shortcuts.ts` 一个文件，纯逻辑、不碰 DOM，
 * 所以一轮下来是秒级的——进 `npm run falsify` 的聚合没有任何负担。
 *
 * ⚠️ **这里每一条变异都必须配一条「反向控制」型断言**，理由见测试文件头：
 * 键盘判据错起来全是静默的，而「回 null」这一类断言在一个恒返回 null 的实现下
 * 会集体变绿。所以下面每一条改的都是**判据里的某一根支柱**，而不是整个函数。
 */
import { spawnSync } from 'child_process'
import { readFileSync, writeFileSync } from 'fs'
import { resolve } from 'path'

const SHORTCUTS = resolve('src/renderer/src/lib/shortcuts.ts')

const MUTATIONS = [
  {
    // 中文用户敲 Enter 十有八九是在上屏候选词，而这时焦点常常在画布（body）上——
    // 后面每一条判据都会放行它。少了这一根，用拼音打字时每选一次词就塞一次「开始」。
    name: '组字那条拿掉（输入法选词的那一下回车会启动队列）',
    from: '  if (ctx.composing) return null\n',
    to: '\n',
    expect: [
      '组字中按 Ctrl+O → 什么都不做',
      '组字中按 Enter → 什么都不做',
      '组字中按 Esc → 什么都不做'
    ]
  },
  {
    // 浏览器本来就会把 Enter 派给焦点所在的那个按钮（= 点一下）。
    // 再抢一手就成了「按一下干两件事」：焦点落在「清空」上时，一次 Enter
    // 既清空了已完成、又启动了队列。
    name: '按钮 / 链接的 Enter 也被抢（按一下干两件事）',
    from: '    if (ownsEnter(ctx.target)) return null\n',
    to: '\n',
    expect: [
      '焦点在按钮上按 Enter → 不抢（那是它自己的默认行为）',
      '焦点在链接上按 Enter → 不抢（那是它自己的默认行为）'
    ]
  },
  {
    name: 'contenteditable 不再算输入框（在富文本里按回车会启动队列）',
    from: '  if (target.editable) return true\n',
    to: '\n',
    expect: ['焦点在富文本里按 Enter → 什么都不做']
  },
  {
    // 其余三页各有一整套表单，接管 Enter 只会添乱：设置页里按回车保存时的
    // 那一下会被当成「开始调律」。
    name: '页面归属拿掉（在设置页按 Enter 也会启动队列）',
    from: "  if (ctx.page !== 'work') return null\n",
    to: '\n',
    expect: [
      '在 history 页三个键都不接管',
      '在 settings 页三个键都不接管',
      '在 about 页三个键都不接管'
    ]
  },
  {
    name: 'Esc 不再看有没有在跑的（空按一下也弹提示）',
    from: "  if (ctx.key === 'Escape') return ctx.running > 0 ? 'cancel-running' : null\n",
    to: "  if (ctx.key === 'Escape') return 'cancel-running'\n",
    expect: ['没有在跑的，Esc 不动作（否则会弹一句莫名其妙的提示）']
  },
  {
    name: 'Enter 不再看队列里有没有待跑的（启动一个空队列）',
    from: "    return ctx.queued > 0 ? 'start' : null\n",
    to: "    return 'start'\n",
    expect: ['队列里没有待跑的，Enter 不启动（不能启动一个空队列）']
  },
  {
    // 这一条打的**不是判据，是那张给人看的表**：把界面宣称的键位改成判据不认的一个。
    // 用户照着设置页按 Ctrl+P 什么都不会发生，而且没有任何地方说得清为什么——
    // 所以 [1] 那一节拿表去喂判据，漂了必须红。
    name: '键位表与判据脱节（表里把 Ctrl+O 写成 Ctrl+P）',
    from: "  { keys: 'Ctrl+O', action: 'pick-files' },",
    to: "  { keys: 'Ctrl+P', action: 'pick-files' },",
    expect: ['按下 Ctrl+P → pick-files']
  }
]

/* ------------------------------------------------------- 锚点自检
 * `--anchors-only` 时**只**数锚点命中次数：不跑基线、不跑任何测试、不改任何源码、
 * 不做任何还原、也不碰 git。全过 exit 0，有锚点命不中 exit 1。
 * 见 scripts/lib/anchors.mjs 的文件头。
 */
if (process.argv.slice(2).includes('--anchors-only')) {
  const { anchorsOnlyGuard } = await import('./lib/anchors.mjs')
  anchorsOnlyGuard(MUTATIONS, { defaultFile: SHORTCUTS })
}

/** `--only=<名字子串>` 只跑命中的变异。基线照样跑（它是对照组，去掉它这轮结论没有意义） */
const ONLY = (process.argv.slice(2).find((a) => a.startsWith('--only=')) ?? '').slice(
  '--only='.length
)
const selected = ONLY === '' ? MUTATIONS : MUTATIONS.filter((m) => m.name.includes(ONLY))
if (selected.length === 0) {
  console.error(`--only=${ONLY} 没命中任何变异`)
  process.exit(1)
}

function runTests() {
  const out = spawnSync(
    'npx',
    ['tsx', '--tsconfig', 'tsconfig.test.json', 'scripts/test-shortcuts.ts'],
    {
      encoding: 'utf8',
      shell: true,
      maxBuffer: 32 * 1024 * 1024
    }
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
  const total = /通过 (\d+)，失败 (\d+)/.exec(text)
  return {
    reds,
    passed: total ? Number(total[1]) : -1,
    failed: total ? Number(total[2]) : -1,
    text
  }
}

const original = readFileSync(SHORTCUTS, 'utf8')

console.log(
  ONLY
    ? `只跑 ${selected.length} / ${MUTATIONS.length} 个变异（--only=${ONLY}），基线照样跑一轮…`
    : `${MUTATIONS.length} 个变异，基线跑一轮，每个变异再各跑一轮…`
)
const baseline = runTests()
console.log(`基线：通过 ${baseline.passed}，失败 ${baseline.failed}`)
if (baseline.failed !== 0) {
  console.error('基线不是全绿，先修好再来反证。')
  if (baseline.failed < 0) console.error('（连「通过 N，失败 M」都没解析到——多半是套件自己崩了）')
  console.error(baseline.text.slice(-2000))
  process.exit(1)
}

let problems = 0

for (const m of selected) {
  // 锚点一定要查命中次数并**把数字打出来**：只说「没命中唯一一次」的话，
  // 0 次（锚点过期）与 2 次（锚点被同款行网住）分不清，两种修法完全不同。
  const hits = original.split(m.from).length - 1
  console.log(
    `[${m.name}] 锚点命中 ${hits} 次（期望 1 次）：${JSON.stringify(m.from.slice(0, 40))}`
  )
  if (hits !== 1) {
    console.error('  期望 1 次 —— 变异没生效，结论无效（多半是源码重构过，锚点过期了）')
    problems += 1
    continue
  }

  writeFileSync(SHORTCUTS, original.replace(m.from, m.to), 'utf8')
  const result = runTests()
  writeFileSync(SHORTCUTS, original, 'utf8')

  const missed = m.expect.filter((label) => !result.reds.includes(label))
  const extra = result.reds.filter((label) => !m.expect.includes(label))

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
    console.log('  套件输出末尾：' + JSON.stringify(result.text.slice(-400)))
  }
}

// 收尾再确认源码确实还原了。**这一步不能省**：反证中途被打断（Ctrl-C、崩溃）
// 会留下一份改坏的源码，而它跑起来的样子和「改回来过」一模一样。
if (readFileSync(SHORTCUTS, 'utf8') !== original) {
  console.error('\n源码没还原干净：' + SHORTCUTS)
  process.exit(1)
}

const scope = ONLY ? `（**只跑了 ${selected.length} / ${MUTATIONS.length} 个变异**）` : ''
console.log(
  problems === 0
    ? `\n反证通过：每个变异都被对应的断言抓住了，且源码已还原。${scope}`
    : `\n反证不通过：${problems} 处有问题。${scope}`
)
process.exit(problems === 0 ? 0 : 1)
