/**
 * 反证 `scripts/test-ui.ts`（处理链面板的回归网）。
 *
 *   node scripts/falsify-ui-panel.mjs
 *   node scripts/falsify-ui-panel.mjs --only=上移        # 只跑名字里带这两个字的变异
 *
 * 每个变异：改坏 `FiltersSection.tsx` 的一处 → 跑一轮 → 立刻还原。
 * 「期望翻红的断言一条都没红」即判定那条断言是装饰品，脚本退出码非零。
 *
 * ⚠️ 它会**临时改写** `src/renderer/src/components/options/FiltersSection.tsx`。
 * 所以开头先查一次「这个文件本来是不是干净的」：不干净就拒绝跑——那种情况下
 * 「还原」会把别人的在途改动覆盖成我这边的基线。跑的时候别同时有别的写入者。
 *
 * 两个对照（见文件末尾）与真实变异分开跑：
 * - **对照 1**：语义为空的操作（只在文件尾加一行注释）必须**一条都不红**。
 *   它证明「抠 ✗ 行」这套判据不是恒真的。
 * - **对照 2**：故意把一个**恒真**的断言算进期望里，确认框架报的是
 *   「有断言没红」而不是「全都抓住了」。恒真的断言在真变异下也不会红，
 *   所以「框架不会把它报成通过」这件事本身要被验一次。
 */
import { spawnSync } from 'child_process'
import { createHash } from 'crypto'
import { readFileSync, writeFileSync } from 'fs'

const PANEL = 'src/renderer/src/components/options/FiltersSection.tsx'

/** 由 `test-ui.ts` 在 `ARBITER_UI_TAUTOLOGY=1` 时才打印的那条恒真断言。 */
const TAUTOLOGY_LABEL = '[对照] 恒真断言（ARBITER_UI_TAUTOLOGY=1 时才出现，永远不该红）'

/**
 * 每项：改坏哪一处、期望哪几条断言翻红。
 *
 * `from` 一律是**可执行形态的整串**。这个文件里注释很多，只锚关键词（`parse`、
 * `disabled`、`addable`）会把注释一起网进来，命中次数一多，`replace` 就只改到第一处，
 * 于是变异停在半路——脚本会按「命中次数不符期望」报出来，但那一轮就白跑了。
 */
const MUTATIONS = [
  {
    name: '上移按钮永远可用（拿走 index === 0 那道闸）',
    from: 'disabled={index === 0}',
    to: 'disabled={false}',
    expect: [
      '渲染：单步链——上移与下移都禁用（它既是第一项也是最后一项）',
      '渲染：两步链的第 1 行——上移禁用、下移可用'
    ]
  },
  {
    name: '下移按钮永远可用（拿走 index === count - 1 那道闸）',
    from: 'disabled={index === count - 1}',
    to: 'disabled={false}',
    expect: [
      '渲染：单步链——上移与下移都禁用（它既是第一项也是最后一项）',
      '渲染：两步链的第 2 行——上移可用、下移禁用',
      '渲染：三步链的第 3 行——上移可用、下移禁用'
    ]
  },
  {
    name: '添加菜单不过滤（addable 直接等于 KIND_ORDER）',
    from: 'const addable = KIND_ORDER.filter((kind) => canUseAction(defaultAction(kind), task.category))',
    to: 'const addable = KIND_ORDER',
    // 视频那一侧「没有放不下那句话」**不会**红：hidden 从 addable 派生，两边一起变空，
    // 那一句本来就该消失。这正说明期望清单要一条条想清楚「它在那个变异下到底跑得到吗」。
    expect: [
      '渲染：图片类别只可加缩放与旋转（且按规范次序：旋转在缩放之前）',
      '渲染：音频类别只可加响度归一化',
      '渲染：图片类别把放不下的四项点名说出来（从 canUseAction 的结果派生，不另写一张表）',
      '渲染：音频类别把放不下的五项点名说出来（去隔行 / 降噪 / 锐化 / 旋转 / 缩放）'
    ]
  },
  {
    name: '「放不下」的说明从「从 addable 派生」改成写死成空表',
    from: 'const hidden = KIND_ORDER.filter((kind) => !addable.includes(kind))',
    to: 'const hidden: ActionKind[] = []',
    expect: [
      '渲染：图片类别把放不下的四项点名说出来（从 canUseAction 的结果派生，不另写一张表）',
      '渲染：音频类别把放不下的五项点名说出来（去隔行 / 降噪 / 锐化 / 旋转 / 缩放）'
    ]
  },
  {
    name: '提交不走 withOption（整体替换语义会吃掉用户的裁剪）',
    from: 'withOption(task.options, { filters }) ?? null',
    to: '({ filters } ?? null)',
    expect: [
      '提交：载荷保留用户先前的 trim（走 withOption，别的字段没被整体替换语义吃掉）',
      '提交：空链并且没有别的参数时交 null（不是空对象 ——「没有参数」只有一种表示）',
      '提交：链删光但还有 trim 时，载荷只留 trim（不留一个 filters: []）'
    ]
  },
  {
    name: '空链交 [] 而不是 undefined（「没有参数」于是有两种表示）',
    from: 'const filters = compiled.actions.length > 0 ? compiled.actions : undefined',
    to: 'const filters = compiled.actions.length > 0 ? compiled.actions : []',
    expect: [
      '提交：空链并且没有别的参数时交 null（不是空对象 ——「没有参数」只有一种表示）',
      '提交：链删光但还有 trim 时，载荷只留 trim（不留一个 filters: []）'
    ]
  },
  {
    name: '宽度不判整数（isInteger 放宽成 isFinite）',
    from: '!Number.isInteger(value)',
    to: '!Number.isFinite(value)',
    expect: ['parse：宽填 1.5 → 拒绝「宽只能填整数像素」']
  },
  {
    name: '缩放两格都空也放行（校验的最外那道闸）',
    from: "if (width === '' && height === '')",
    to: 'if (false)',
    expect: [
      'parse：缩放两格都空 → 拒绝，并说清「宽高至少填一个」',
      'compile：报错指名道姓（说得出是第几步、哪个动作）',
      'compile：第几步是**从 1 数**的（下标 1 的步骤说成「第 2 步」）',
      '渲染：非法输入——「应用」被禁用',
      '渲染：非法输入——原因句指名道姓（第 1 步「缩放」：宽高至少填一个…）',
      '提交：非法链上点「应用」一次 setOptions 都不发（compiled.ok 那道闸真的在拦）'
    ]
  },
  {
    name: '校验原因不再指名道姓（去掉「第 N 步「动作」」）',
    from: 'reason: `第 ${index + 1} 步「${KIND_LABEL[step.action.kind]}」：${parsed.issue}`',
    to: 'reason: `「${KIND_LABEL[step.action.kind]}」：${parsed.issue}`',
    expect: [
      'compile：报错指名道姓（说得出是第几步、哪个动作）',
      'compile：第几步是**从 1 数**的（下标 1 的步骤说成「第 2 步」）',
      '渲染：非法输入——原因句指名道姓（第 1 步「缩放」：宽高至少填一个…）'
    ]
  },
  {
    name: 'freshId 不再是「最大 id + 1」（新步骤会拿到重复的 React key）',
    from: 'return steps.reduce((max, step) => Math.max(max, step.id), 0) + 1',
    to: 'return steps.reduce((max, step) => Math.max(max, step.id), 0)',
    expect: [
      'freshId：取当前最大 id + 1（不是长度、也不是自增计数器）',
      'insertByRank：空链上插入第一步',
      'insertByRank：每次插入都拿到新的唯一 id（否则 React 会把上一行的 DOM 复用给新的一步）'
    ]
  },
  {
    name: '上移按钮点下去反而往后挪（onMove 的符号写反）',
    from: 'onClick={() => onMove(-1)}',
    to: 'onClick={() => onMove(1)}',
    expect: [
      '接线：第 1 行的上移按钮点了调 onMove(-1)（往前挪一位）',
      '接线：第 2 行的下移按钮点了调 onMove(1)（它是另一行，不是同一个常量）'
    ]
  },
  {
    name: '宽度输入框把值写进 height（改错了字段）',
    from: 'onChange={(e) => onChange({ ...action, width: e.target.value })}',
    to: 'onChange={(e) => onChange({ ...action, height: e.target.value })}',
    expect: ['接线：宽度输入框的 onChange 把新值交回 onChange，且别的字段原样保留']
  },
  {
    // 这一条刻意**不**写成 `describeAction(parsed.action)`（那是最直白的「去掉兜底」）：
    // `parsed` 不 ok 时 `parsed.action` 是 `undefined`，StepRow 会当场抛，
    // 整套在第 [7] 节就断了——而断掉的套件与「一条都没红」在输出上分不出。
    // 改用「拿默认值编一个数」，既是不崩的偷懒写法，又正好是这条断言要挡的那件事。
    name: '数值没填对时也编一个摘要出来（不再退回动作名）',
    from: 'const summary = parsed.ok ? describeAction(parsed.action) : `${KIND_LABEL[step.action.kind]} —`',
    to: 'const summary = describeAction(parsed.ok ? parsed.action : defaultAction(step.action.kind))',
    expect: ['接线：数值没填对的那一步只显示动作名（「缩放 —」），不编一个数出来']
  },
  {
    name: '「清除」按钮永远不出现（canClear 写死 false）',
    from: 'canClear={current.length > 0}',
    to: 'canClear={false}',
    expect: ['渲染：「清除」按钮只在真的设过链时出现']
  },
  {
    name: '「放不下」那句话不再判空（链上什么都没有也照样说）',
    from: '{hidden.length > 0 && (',
    to: '{(',
    expect: ['渲染：视频类别六项全在菜单里，所以没有「放不下」那句话']
  }
]

/* ------------------------------------------------------- 锚点自检
 * `--anchors-only` 时**只**数锚点命中次数：不跑基线、不跑任何测试、不改任何源码、
 * 不做任何还原、也不碰 git。全过 exit 0，有锚点命不中 exit 1（逐条打印
 * 「脚本 / 变异名 / 命中次数 / 期望次数」）。
 *
 * ⚠️ 这段**必须放在下面那个 `git status` 前置检查之前**：那条路上会调 `git`，
 * 也会读盘和写盘，而 `--anchors-only` 要的是「零副作用的只读数锚点」。
 * 见 scripts/lib/anchors.mjs 的文件头。
 */
if (process.argv.slice(2).includes('--anchors-only')) {
  const { anchorsOnlyGuard } = await import('./lib/anchors.mjs')
  // 这一支通篇只有一个文件，变异里不写 `file`；读了之后同样过 `toLf`
  anchorsOnlyGuard(MUTATIONS, { defaultFile: PANEL, normalizeLf: true })
}

const toLf = (s) => s.replace(/\r\n/g, '\n')

function runTests(extraEnv) {
  const out = spawnSync('npx', ['tsx', '--tsconfig', 'tsconfig.test.json', 'scripts/test-ui.ts'], {
    encoding: 'utf8',
    shell: true,
    env: { ...process.env, ...extraEnv }
  })
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
    // 汇总行只在 main() 跑到最后才打。**它没出现 = 套件在半路抛异常了**，
    // 这时候 reds 是空的——而「空」和「一条都没红」长得一模一样。
    completed: total !== null,
    text
  }
}

/** 期望与实际的比对单独成函数：两个对照要直接调它。 */
function assess(result, expect) {
  const missed = expect.filter((label) => !result.reds.includes(label))
  const extra = result.reds.filter((label) => !expect.includes(label))
  return { missed, extra }
}

function printReds(result, expect) {
  for (const label of result.reds) {
    console.log(`    - ${label}${expect.includes(label) ? '' : '   (顺带)'}`)
  }
}

/* ------------------------------------------------------------------ 前置检查 */

// 这个文件本来就不干净时拒绝跑：那种情况下「还原」会写回我读到的那一版，
// 把别人的在途改动覆盖掉。宁可什么都不做。
const dirtyBefore = spawnSync('git', ['status', '--porcelain', '--', PANEL], { encoding: 'utf8' })
if (dirtyBefore.status !== 0) {
  console.error('`git status` 跑不起来，无法确认 FiltersSection.tsx 是干净的，先修好再来。')
  process.exit(1)
}
if (dirtyBefore.stdout.trim() !== '') {
  console.error(
    `${PANEL} 现在**本来就有未提交的改动**。\n` +
      '反证会把它改坏再还原成「我刚读到的那一版」——那等于覆盖别人的在途改动。\n' +
      '请先让这个文件回到干净状态（或等那个写入者提交完）再跑。'
  )
  process.exit(1)
}

const original = toLf(readFileSync(PANEL, 'utf8'))
const SHA_BEFORE = createHash('sha256').update(readFileSync(PANEL)).digest('hex')

const only = (process.argv.find((a) => a.startsWith('--only=')) ?? '').slice('--only='.length)
const planned = only ? MUTATIONS.filter((m) => m.name.includes(only)) : MUTATIONS
if (planned.length === 0) {
  console.error(`--only=${only} 一个变异都没匹配上。`)
  process.exit(1)
}

/* ------------------------------------------------------------------ 基线 */

const baseline = runTests()
console.log(`基线：通过 ${baseline.passed}，失败 ${baseline.failed}`)
if (!baseline.completed || baseline.failed !== 0 || baseline.passed <= 0) {
  console.error('基线不是全绿（或一条都没跑），先修好再来反证。')
  console.error(baseline.text.slice(-2000))
  process.exit(1)
}

let problems = 0

/* ------------------------------------------------------------------ 真实变异 */

for (const [index, m] of planned.entries()) {
  const hits = original.split(m.from).length - 1
  console.log(`\n[${index + 1}/${planned.length}] ${m.name}`)
  // 命中次数一定要打出来：只说「没命中唯一一次」的话，0 次和 2 次根本分不清。
  if (hits !== 1) {
    console.error(`  锚点命中 ${hits} 次（期望 1 次）—— 变异没生效，结论无效`)
    problems += 1
    continue
  }

  writeFileSync(PANEL, original.replace(m.from, m.to), 'utf8')
  const result = runTests()
  writeFileSync(PANEL, original, 'utf8')

  // ⚠️ 先判「有没有跑完」。变异让套件在半路抛异常时，reds 是空的——
  // 而那和「期望的断言全是装饰品」在输出上一模一样。同一轮里踩过一次：
  // 一条变异把 StepRow 的摘要分支改成对 `undefined` 取 `.kind`，第 [7] 节当场炸，
  // 于是「零红」被报成「有断言没红」，白等一轮还会诱发去放宽断言。
  if (!result.completed) {
    problems += 1
    console.log('  变异让套件在半路抛异常（汇总行都没打出来）——')
    console.log('  期望的断言根本没被执行，「零红」在这里说明不了任何事。换一个不炸的变异。')
    console.log(result.text.slice(-900))
    continue
  }

  const { missed } = assess(result, m.expect)
  if (missed.length === 0) {
    console.log(`  翻红 ${result.reds.length} 条，期望的都在`)
    printReds(result, m.expect)
  } else {
    problems += 1
    console.log('  有断言没红 —— 它们抓不住这个错误：')
    for (const label of missed) console.log(`    ! ${label}`)
    console.log(`  实际翻红：${result.reds.join(' | ') || '（一条都没红）'}`)
  }
}

/* ------------------------------------------------------------------ 对照 */

console.log('\n================ 对照（验的是这套反证框架本身）================')

// 对照 1：语义为空的操作必须零红。
{
  console.log('\n[对照 1] 语义为空的操作（只在文件尾加一行注释）→ 期望**一条都不红**')
  writeFileSync(PANEL, `${original}\n// 对照：这一行不改变任何行为\n`, 'utf8')
  const result = runTests()
  writeFileSync(PANEL, original, 'utf8')
  if (result.completed && result.reds.length === 0 && result.failed === 0) {
    console.log('  ✓ 零红 —— 「抠 ✗ 行」这套判据不是恒真的')
  } else {
    problems += 1
    console.log(`  ! 翻红了 ${result.reds.length} 条，说明判据对无关改动也敏感：`)
    printReds(result, [])
  }
}

// 对照 2：恒真的断言必须被判成「没红」，而不是被当成抓住了错误。
{
  console.log('\n[对照 2] 期望清单里混进一条恒真断言 → 期望框架报「有断言没红」')
  const target = MUTATIONS[0]
  writeFileSync(PANEL, original.replace(target.from, target.to), 'utf8')
  const result = runTests({ ARBITER_UI_TAUTOLOGY: '1' })
  writeFileSync(PANEL, original, 'utf8')

  const { missed } = assess(result, [...target.expect, TAUTOLOGY_LABEL])
  const falselyPassed = assess(result, [TAUTOLOGY_LABEL]).missed.length === 0
  if (result.completed && missed.includes(TAUTOLOGY_LABEL) && !falselyPassed) {
    console.log(`  ✓ 框架把它判成「有断言没红」（${missed.length} 条没红），没有当成通过`)
    console.log(`    没红的：${missed.join(' | ')}`)
  } else {
    problems += 1
    console.log('  ! 框架居然把一条恒真的断言算成了「抓住错误」')
  }
}

/* ------------------------------------------------------------------ 收尾 */

const SHA_AFTER = createHash('sha256').update(readFileSync(PANEL)).digest('hex')
if (SHA_AFTER !== SHA_BEFORE) {
  console.error(`\n源码没还原干净：${PANEL}`)
  process.exit(1)
}

const leftover = spawnSync('git', ['status', '--porcelain', '--', PANEL], { encoding: 'utf8' })
console.log(`\n${PANEL}`)
console.log(`  sha256 ${SHA_BEFORE}`)
console.log(
  `  已还原（git status 对本文件${leftover.stdout.trim() === '' ? '无输出' : `仍报：${leftover.stdout.trim()}`}）`
)
console.log(
  `  跑了 ${planned.length} / ${MUTATIONS.length} 个真实变异` + (only ? `（--only=${only}）` : '')
)

console.log(
  problems === 0
    ? '\n反证通过：每个变异都被对应的断言抓住了，两个对照都符合预期。'
    : `\n反证不通过：${problems} 处有问题。`
)
process.exit(problems === 0 ? 0 : 1)
