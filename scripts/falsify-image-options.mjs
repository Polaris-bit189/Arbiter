/**
 * 反证：把图片参数那几处判据逐个改坏，确认 `scripts/test-image-options.ts` 真的会翻红。
 *
 *   node scripts/falsify-image-options.mjs
 *   npm run falsify:image-options
 *   node scripts/falsify-image-options.mjs --only=effort
 *
 * 被测的只有 `src/main/converters/image.ts` 一个文件。它跑**真的 sharp**（不是桩），
 * 所以一轮下来十几秒——进 `npm run falsify` 的聚合没有负担。
 *
 * 这个脚本补的是 `[6]` 那一节：`effort` 那个旋钮扛着 3~4× 的 PNG 体积，
 * 而它在 2026-09-16 之前**一条断言都没有**。删掉它不会有任何东西报错，
 * 只是用户拿到的 PNG 大了三倍——这正是「反证才看得见」的那类回归。
 */
import { spawnSync } from 'child_process'
import { readFileSync, writeFileSync } from 'fs'
import { resolve } from 'path'

const IMAGE = resolve('src/main/converters/image.ts')

const MUTATIONS = [
  {
    // ★ 本脚本存在的**首要理由**。「effort 看起来像个可有可无的调优参数」——
    // 实测去掉它 PNG 体积 ×3.0（真随机素材）/ ×4.1（实拍素材），而无损格式的
    // 体积变大不触发任何检查，所以除了这条断言没有任何东西拦得住。
    name: 'PNG 出口去掉 effort（体积当场翻三倍，且不报任何错）',
    from: '      return (p) => p.png({ compressionLevel: 9, effort: 7 })\n',
    to: '      return (p) => p.png({ compressionLevel: 9 })\n',
    expect: ['我们的 PNG 产物至少比「只给 compressionLevel 9」小一半（effort 还在）']
  },
  {
    // 缩放那一节最承重的一条：sharp 的 `withoutEnlargement` 默认是 false，
    // 也就是「长边 1920」会把 800px 的图**放大**成 1920——体积涨、画质平白劣化一次。
    name: 'withoutEnlargement 不再直通（省略即放大）',
    from: '      withoutEnlargement: action.withoutEnlargement\n',
    to: '      withoutEnlargement: false\n',
    expect: ['源 800×600 要求长边 1920 → 产物仍是 800×600']
  },
  {
    // 「PNG 没有质量旋钮」这条拒绝对用户是**对外承诺**：不拒的话，用户会拿到一个
    // 体积完全没变、却报「成功」的产物。
    name: 'PNG 的体积目标不再被拒（静默给一个体积没变的「成功」）',
    from: '  if (!QUALITY_TARGETS.has(toExt)) {\n',
    to: '  if (false) {\n',
    expect: ['PNG + 体积目标 → 报错', '错误文案点明 PNG 没有质量旋钮']
  }
]

/* ------------------------------------------------------- 锚点自检 */
if (process.argv.slice(2).includes('--anchors-only')) {
  const { anchorsOnlyGuard } = await import('./lib/anchors.mjs')
  anchorsOnlyGuard(MUTATIONS, { defaultFile: IMAGE })
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
    ['tsx', '--tsconfig', 'tsconfig.test.json', 'scripts/test-image-options.ts'],
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
  const total = /通过 (\d+)，失败 (\d+)/.exec(text)
  return {
    reds,
    passed: total ? Number(total[1]) : -1,
    failed: total ? Number(total[2]) : -1,
    text
  }
}

const original = readFileSync(IMAGE, 'utf8')

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
  // 锚点要查命中次数并**把数字打出来**：0 次（锚点过期）与 2 次（被同款行网住）分不清
  const hits = original.split(m.from).length - 1
  console.log(
    `[${m.name}] 锚点命中 ${hits} 次（期望 1 次）：${JSON.stringify(m.from.slice(0, 40))}`
  )
  if (hits !== 1) {
    console.error('  期望 1 次 —— 变异没生效，结论无效（多半是源码重构过，锚点过期了）')
    problems += 1
    continue
  }

  writeFileSync(IMAGE, original.replace(m.from, m.to), 'utf8')
  const result = runTests()
  writeFileSync(IMAGE, original, 'utf8')

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

// 收尾再确认源码确实还原了：中途被打断会留下一份改坏的源码，
// 而它跑起来的样子和「改回来过」一模一样。
if (readFileSync(IMAGE, 'utf8') !== original) {
  console.error('\n源码没还原干净：' + IMAGE)
  process.exit(1)
}

const scope = ONLY ? `（**只跑了 ${selected.length} / ${MUTATIONS.length} 个变异**）` : ''
console.log(
  problems === 0
    ? `\n反证通过：每个变异都被对应的断言抓住了，且源码已还原。${scope}`
    : `\n反证不通过：${problems} 处有问题。${scope}`
)
process.exit(problems === 0 ? 0 : 1)
