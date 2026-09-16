/**
 * 契约与 UI 侧那几块纯逻辑的反证：能力矩阵的类别视图（`shared/formats.ts`）、
 * 图标素材的 symbol id 映射（`renderer/src/lib/icons.ts`）、以及 IPC 契约里
 * 被 zod 4 改了语义的 `defaultTargets`（`shared/ipc-contract.ts`）。
 *
 *   node scripts/falsify-ui.mjs
 *
 * 为什么值得单独写一个：这几块都是**静默出错**——少登记一个类别、两个文件
 * 撞进同一个 symbol id、`<use href="#不存在的id">`、`defaultTargets` 被 `.catch`
 * 悄悄吞成 `{}`，全都不报错，只是界面少一块 / 图错了 / 渲染成空白 / 偏好一重启就没了。
 * 断言写完了不复核，等于没写。
 *
 * ⚠️ 它会**临时改写这三个源码文件**再还原，跑的时候别同时有别的写入者。
 *
 * 每个变异跑完立刻还原源码；任一变异「零红」即判定该条断言是装饰品，退出码非零。
 */
import { spawnSync } from 'child_process'
import { createHash } from 'crypto'
import { readFileSync, writeFileSync } from 'fs'

const FORMATS = 'src/shared/formats.ts'
const ICONS = 'src/renderer/src/lib/icons.ts'
const CONTRACT = 'src/shared/ipc-contract.ts'

/**
 * 每项：改坏哪个文件、改哪里、期望翻红的断言（只列必须红的，多红了不算错但要看得见）。
 *
 * `count` 是**锚点应当命中的次数**，默认 1。它存在的理由见最后那条变异：
 * 有些锚点在源码里本来就出现多次，此时「命中 2 次」才是正常，
 * 而「只改一处、留一个半修状态」是另一种合法变异。
 *
 * 顺带的红是正常的——比如摘掉 `targets.includes` 这道闸，除了那条显式的 mkv 断言，
 * 「穷举扫描」也会跟着红。反过来「只有期望的那条红」才说明判据定位得准。
 */
const MUTATIONS = [
  {
    file: FORMATS,
    name: 'resolveDefaultTarget 去掉 targets.includes 校验（改成信任 override）',
    // 锚点必须带上前面那行：单看 `return want && targets.includes(want) ? …`
    // 在 defaultTargetFor 里有一模一样的一份，只锚一行会命中 2 次。
    from: `  const want = overrides[category] ?? defaultTargetFor(fromExt)
  return want && targets.includes(want) ? want : targets[0]`,
    to: `  const want = overrides[category] ?? defaultTargetFor(fromExt)
  return want ?? targets[0]`,
    expect: ['override 指向源格式自身时回落到 targets[0]（mkv 不能转 mkv）']
  },
  {
    file: FORMATS,
    name: '少登记一个类别（整段摘掉 register(ebook)）',
    // 锚点是**一整条 register 调用**，而不是它的开头——只锚 `register('ebook', [`
    // 会留下一段语法残缺的代码，翻的红是编译错误，不是断言翻红。
    from: `register('ebook', ['epub', 'mobi', 'azw3', 'azw', 'fb2', 'lit', 'pdb'])`,
    to: `// 变异：整个 register('ebook', …) 调用被摘掉`,
    expect: ['六个类别一个都不能空']
  },
  {
    file: FORMATS,
    name: 'doc 那行的族表加回 xlsx（重新宣称 LO 跑不通的跨族组合）',
    // 锚点是**整行可执行代码**：`OFFICE_FAMILIES` 这个词在注释里出现 4 次，
    // 只锚关键词会把注释一网打尽（这个坑在上面两条变异上已经踩过两回了）。
    // `doc: [...]` 也不会命中 `odt: [...]`——那行的键是 `odt`。
    from: "doc: ['pdf', 'docx', 'txt'],",
    to: "doc: ['pdf', 'docx', 'xlsx', 'txt'],",
    expect: ['跨族 doc → xlsx 不该被宣称', 'doc 的出口恰好是 [docx, pdf, txt]']
  },
  {
    file: ICONS,
    name: 'tileForExt 的兜底从通用砖改成一个必然不存在的 id',
    from: "  return TILE_EXTS.includes(hit) ? `f-${hit}` : 'f-file'",
    to: "  return TILE_EXTS.includes(hit) ? `f-${hit}` : 'f-does-not-exist'",
    expect: ['兜底返回的 id 对应的素材真实存在']
  },
  {
    file: CONTRACT,
    name: 'patch schema 的 partialRecord 改回 record（zod 4 的「键必须全给」）',
    // 锚点用**可执行形态的整串**，而不是 `z.partialRecord(`：后者当前命中 2 次，
    // 因为 `lenientTargets` 上方那段注释里就写着 `` `z.partialRecord(…).catch(undefined)` ``。
    // 这个整串实测命中 **1 次**——读盘侧已改成逐键筛，不再用 partialRecord，
    // 所以这个变异的射程**只剩 patch 那一侧**，期望翻红的清单也跟着收窄了。
    from: 'z.partialRecord(z.enum(CATEGORIES), extSchema)',
    to: 'z.record(z.enum(CATEGORIES), extSchema)',
    expect: [
      'patch schema 接受「只给部分类别」（六类别逐个试）',
      'patch schema 接受 defaultTargets: {}（用户把偏好全撤掉）',
      '承重：defaultTargets 与 maxConcurrent 同时送来时两者都要在（不能连坐）'
    ]
  },
  {
    file: CONTRACT,
    name: '读盘的逐键筛不再筛键（continue 改成无条件写入）',
    // 同样是可执行形态的锚点：那段注释里散落着 `CATEGORIES`、`extSchema.safeParse`
    // 这些词，只锚其中任何一个都会把注释一起网进来。带上 `if (!(...).includes(key))`
    // 之后实测命中 1 次。
    from: 'if (!(CATEGORIES as readonly string[]).includes(key)) continue',
    to: 'kept[key as Category] = String(value)',
    expect: [
      '读盘：未知类别被剥掉，认得的键留下（逐键筛）',
      '读盘：坏值不带走好值（audio:42、image:"MKV" 都只剔掉自己）'
    ]
  }
]

/* ------------------------------------------------------- 锚点自检
 * `--anchors-only` 时**只**数锚点命中次数：不跑基线、不跑任何测试、不改任何源码、
 * 不做任何还原、也不碰 git。全过 exit 0，有锚点命不中 exit 1（逐条打印
 * 「脚本 / 变异名 / 命中次数 / 期望次数」）。
 *
 * 这一支的变异可以带 `count`（期望命中次数**不总是 1**，见上面那段注释），
 * 助手按同一个字段读，不会把那个语义压成「必须是 1」。
 * 见 scripts/lib/anchors.mjs 的文件头。
 */
if (process.argv.slice(2).includes('--anchors-only')) {
  const { anchorsOnlyGuard } = await import('./lib/anchors.mjs')
  // 与脚本正文一致：它读盘后过了 `toLf`（见下面的 `originals` / 循环）
  anchorsOnlyGuard(MUTATIONS, { normalizeLf: true })
}

/**
 * 跑被测套件并抠出翻红的断言标签。
 *
 * 注意汇总行的分隔符是 `/`（`通过 68 / 失败 0`），与 falsify-doc 那边用的
 * 全角逗号不是同一个——照抄正则会一直拿到 -1，而 -1 不等于 0，
 * 表现是「基线就报不是全绿」，倒也不会静默通过，但白跑一整轮。
 */
function runTests() {
  const out = spawnSync('npx', ['tsx', 'scripts/test-core.ts'], {
    encoding: 'utf8',
    shell: true
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
    text
  }
}

/**
 * 锚点一律在 LF 文本上匹配：仓库当前统一了行尾，但哪天混进 CRLF 的话，
 * 跨行的锚点会一声不响地命中 0 次——脚本会报「结论无效」而不是「通过」，
 * 只是要人多花一整轮去查。
 */
const toLf = (s) => s.replace(/\r\n/g, '\n')

const originals = Object.fromEntries(
  [...new Set(MUTATIONS.map((m) => m.file))].map((f) => [f, readFileSync(f, 'utf8')])
)

const baseline = runTests()
console.log(`基线：通过 ${baseline.passed}，失败 ${baseline.failed}`)
if (baseline.failed !== 0) {
  console.error('基线不是全绿，先修好再来反证。')
  console.error(baseline.text.slice(-2000))
  process.exit(1)
}

let problems = 0

for (const m of MUTATIONS) {
  const original = toLf(originals[m.file])
  const expectHits = m.count ?? 1
  const hits = original.split(m.from).length - 1

  // 命中次数一定要打出来：只说「没命中唯一一次」的话，0 次和 2 次根本分不清。
  console.log(`\n[${m.name}] 锚点命中 ${hits} 次（期望 ${expectHits} 次）`)
  if (hits !== expectHits) {
    console.error(`  期望 ${expectHits} 次 —— 变异没生效，结论无效`)
    problems += 1
    continue
  }

  // 命中 1 次时 replace 即可；命中多次时用 split/join 全改（半修状态会让结论含混）。
  const mutated =
    expectHits === 1 ? original.replace(m.from, m.to) : original.split(m.from).join(m.to)
  writeFileSync(m.file, mutated, 'utf8')
  const result = runTests()
  writeFileSync(m.file, originals[m.file], 'utf8')

  const missed = m.expect.filter((label) => !result.reds.includes(label))
  const extra = result.reds.filter((label) => !m.expect.includes(label))

  if (missed.length === 0) {
    console.log(`  翻红 ${result.reds.length} 条，期望的都在`)
    for (const label of result.reds) {
      console.log(`    - ${label}${extra.includes(label) ? '   (顺带)' : ''}`)
    }
  } else {
    problems += 1
    console.log(`  有断言没红 —— 它们抓不住这个错误：`)
    for (const label of missed) console.log(`    ! ${label}`)
    console.log(`  实际翻红：${result.reds.join(' | ') || '（一条都没红）'}`)
  }
}

// 收尾再确认源码确实还原了
const dirty = Object.keys(originals).filter((f) => readFileSync(f, 'utf8') !== originals[f])
if (dirty.length > 0) {
  console.error('\n源码没还原干净：' + dirty.join(', '))
  process.exit(1)
}

// 把跑完之后每个文件的 sha256 打出来：这条「已还原」的结论不该只有脚本自己说了算，
// 谁想核对都可以自己先哈希一遍，再和这几行对。
for (const f of Object.keys(originals)) {
  console.log(`  ${createHash('sha256').update(readFileSync(f)).digest('hex')}  ${f}`)
}

console.log(
  problems === 0
    ? '\n反证通过：每个变异都被对应的断言抓住了，且源码已还原。'
    : `\n反证不通过：${problems} 处有问题。`
)
process.exit(problems === 0 ? 0 : 1)
