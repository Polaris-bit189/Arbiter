/**
 * 反证：把「检查更新」的判据与下载逐处改坏，确认 `scripts/test-plugin-update.mjs`
 * 的断言真的会翻红。
 *
 *   node scripts/falsify-plugin-update.mjs
 *   npm run falsify:plugin-update
 *   node scripts/falsify-plugin-update.mjs --only=blockmap      # 只跑名字命中的变异
 *
 * 被测的是两个文件（`updatePlan.mjs` 的判据 / `update.mjs` 的下载），所以下面每个变异
 * 都带 `file`。跑一轮是秒级的（测试自己注入假 fetch，不碰网络），进 `npm run falsify`
 * 的聚合没有任何负担。
 *
 * ## 为什么这几条值得单独反证
 *
 * 这个功能**没有一条判据出错是会抛异常的**——它只会安静地说错话：
 * 把「查不到」说成「已是最新」、把 `.blockmap` 当成安装包、跳过哈希校验。
 * 所以「测试全绿」在这里说明不了任何事，**必须**把每一处改坏、看见对应的断言翻红。
 *
 * ## 两个机制上的坑（照 `falsify-plugin-target.mjs` 的先例，都实测过）
 *
 * - **`expect: []` 会被静默放行**（空清单上 `filter` 恒空，于是「一条都没红」被报成
 *   「期望的都在」）。所以空清单必须显式写 `diagnostic: true`，这里也挡一道。
 * - **套件崩了会被报成「有断言没红」**，方向正好指反——真相是它抓住了这个变异。
 *   所以解析不到汇总行时单独报「套件崩了」，不混进判定。
 */
import { spawnSync } from 'child_process'
import { readFileSync, writeFileSync } from 'fs'
import { resolve } from 'path'

const PLAN = resolve('plugins/arbiter/mcp/updatePlan.mjs')
const UPDATE = resolve('plugins/arbiter/mcp/update.mjs')
const SUITE = 'scripts/test-plugin-update.mjs'

const MUTATIONS = [
  {
    file: PLAN,
    // 这一条是整条链路上方向最坏的错误：把「这次没问到」讲成「你已经是最新的」，
    // 用户于是以为自己不用更新。
    name: 'decideUpdate：把「比不出来」折成 up-to-date',
    from: "  if (typeof installed !== 'string' || typeof latest !== 'string') return 'unknown'\n",
    to: "  if (typeof installed !== 'string' || typeof latest !== 'string') return 'up-to-date'\n",
    expect: [
      '★ 拿不到最新版 → unknown（**不是** up-to-date）',
      '★ 拿不到本机版本 → unknown',
      '★ unknown 与 up-to-date 是两个不同的值',
      '★ 状态是 unknown，不是 up-to-date'
    ]
  },
  {
    file: PLAN,
    // 版本比较恒等 → 一切都说「已是最新」。这是最容易被写错、也最难看出来的一种。
    name: 'compareSemver：主版本位永远相等',
    from: '    const x = pa.nums[i] ?? 0\n    const y = pb.nums[i] ?? 0\n    if (x !== y) return x < y ? -1 : 1\n',
    to: '    const x = pa.nums[i] ?? 0\n    const y = pb.nums[i] ?? 0\n    if (false) return x < y ? -1 : 1\n',
    expect: [
      '新 > 旧',
      '旧 < 新',
      '数字按数值比，不是字典序（0.9 < 0.10）',
      '落后 → update-available'
    ]
  },
  {
    file: PLAN,
    // `includes` 会同时匹配上 `Arbiter-0.3.5-setup.exe.blockmap`——选中哪个就全看
    // GitHub 返回数组的顺序了。测试里有一条专门把 blockmap 排到前面。
    name: 'pickSetupAsset：判据从「后缀收尾」放宽成「包含」',
    from: "    (asset) => typeof asset?.name === 'string' && asset.name.endsWith('-setup.exe')\n",
    to: "    (asset) => typeof asset?.name === 'string' && asset.name.includes('setup.exe')\n",
    expect: ['★ blockmap 排到前面时仍然不选它']
  },
  {
    file: UPDATE,
    // 跳过校验 → 一个下坏了的安装包被 rename 成正式文件，而**流程报成功**。
    name: '下载：跳过 sha256 校验',
    from: '  if (!sameSha256(actual, sha256)) {\n',
    to: '  if (false) {\n',
    expect: ['★ sha256 对不上 → 拒绝落盘', '★ 目标文件没有被留下', '★ 错误码是 sha256_mismatch']
  },
  {
    file: UPDATE,
    // 校验不过时**不删** `.part`：下一次运行会把它当成断点续传的起点，
    // 于是一个坏文件会一直坏下去，而每次都说「下载失败」。
    name: '下载：校验不过时留下 .part',
    from: '    // ⚠️ 删掉它。留着的话下一次运行会把坏的 `.part` 当成续传起点。\n    rmSync(part, { force: true })\n',
    to: '    // 变异：这一行被拿掉了\n',
    expect: ['★ .part 也没有被留下（留下会被下次当成续传起点）']
  },
  {
    file: UPDATE,
    // 证书错是本机实测**唯一真的会撞上**的那一类，而它给出的下一步与别的都不同
    // （`--use-system-ca`）。把它归进笼统的 network_failed，用户就拿不到那个提示。
    name: 'classifyFetchError：证书错被并进笼统的网络失败',
    from: "    return 'tls_certificate'\n",
    to: "    return 'network_failed'\n",
    expect: ['证书错 → tls_certificate', '错误码 = tls_certificate（本机实测的那一类）']
  },
  {
    file: UPDATE,
    // 下载失败**不能**复用查询那句文案：最新版本明明已经查到了（就在同一个报告里），
    // 再说一句「这次没能查到最新版本」是自相矛盾。这个 bug 实测踩到过。
    name: '下载失败复用查询的文案（方向反了）',
    from: "    kind === 'download' ? t('updateDownloadFailed', { reason: detail }) : messageFor(code, detail)\n",
    to: '    messageFor(code, detail)\n',
    expect: ['★ 而且文案讲的是下载，不是「没能查到最新版本」（同报告里明明有 latest）']
  }
]

/* ------------------------------------------------------- 锚点自检
 * `--anchors-only` 时**只**数锚点命中次数：不跑基线、不跑任何测试、不改任何源码、
 * 不做任何还原、也不碰 git。全过 exit 0，有锚点命不中 exit 1。
 *
 * ⚠️ 这段是**每支 falsify 脚本都要装**的一段（判据在 `scripts/lib/anchors.mjs`，共用）。
 * 漏了它的表现是 `npm run test:anchors` 那一行变成「?  ?  ✗ 没打印出锚点汇总行」——
 * 而总数照样算得出来，所以**很容易漏看**（这个功能第一版就漏了它）。
 */
if (process.argv.slice(2).includes('--anchors-only')) {
  const { anchorsOnlyGuard } = await import('./lib/anchors.mjs')
  // 这一支的变异横跨两个文件，所以**每个变异都带 `file`**；defaultFile 只是兜底。
  anchorsOnlyGuard(MUTATIONS, { defaultFile: PLAN })
}

const only = process.argv.find((a) => a.startsWith('--only='))?.slice('--only='.length) ?? null
const selected = only === null ? MUTATIONS : MUTATIONS.filter((m) => m.name.includes(only))

if (selected.length === 0) {
  console.error(`没有名字含「${only}」的变异`)
  process.exit(1)
}

/** 原始内容，逐个文件留一份。跑完要拿它核对「还原干净了」。 */
const originals = new Map()
for (const m of MUTATIONS) {
  if (!originals.has(m.file)) originals.set(m.file, readFileSync(m.file, 'utf8'))
}

function restoreAll() {
  for (const [path, text] of originals) writeFileSync(path, text)
}

/** 跑一次套件，抠出翻红的标签与汇总行。 */
function runSuite() {
  const r = spawnSync(process.execPath, [SUITE], {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024
  })
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`
  const reds = []
  for (const line of out.split('\n')) {
    const m = /^\s+✗\s+(.*)$/.exec(line)
    // ⚠️ 必须切掉 `  —— detail`：`check` 把 detail 拼在同一行里，不切的话红名单里是
    // 「标签  —— 细节」，而 `expect` 写的是纯标签，于是**永远匹配不上**——
    // 后果是把「断言确实抓住了变异」报成「期望的没红」，方向正好指反。
    if (m) reds.push(m[1].split('  —— ')[0].trim())
  }
  const sum = /通过 (\d+)，失败 (-?\d+)/.exec(out)
  return {
    reds,
    failed: sum ? Number(sum[2]) : -1,
    crashed: sum === null,
    tail: out.slice(-1200)
  }
}

const labelOf = (e) => (typeof e === 'string' ? e : e.label)

console.log(`反证「检查更新」：${selected.length} 个变异\n`)

// —— 基线：一个字节都不改时必须是全绿的 ——
restoreAll()
const baseline = runSuite()
if (baseline.crashed || baseline.failed !== 0) {
  console.log('基线就不是全绿 —— 先把测试跑绿了再来反证。')
  console.log(baseline.tail)
  restoreAll()
  process.exit(1)
}
console.log(`基线：失败 0（${baseline.reds.length} 条红）\n`)

let ok = 0
let bad = 0
const skipped = []

for (const [i, m] of selected.entries()) {
  const tag = `[${i + 1}/${selected.length}]`
  if (!m.diagnostic && (!Array.isArray(m.expect) || m.expect.length === 0)) {
    console.log(`${tag} ${m.name}`)
    console.log('      这个变异既没写 expect 也没标 diagnostic —— 没写期望等于没反证。')
    bad += 1
    continue
  }

  const src = originals.get(m.file)
  if (!src.includes(m.from)) {
    // 锚点找不到 = 变异没生效。**结论无效**，不能当成通过。
    console.log(`${tag} ${m.name}`)
    console.log(`      ⚠️ 锚点没命中（${m.file} 里找不到那段代码）——变异没生效，这一轮结论无效。`)
    skipped.push(m.name)
    bad += 1
    continue
  }

  writeFileSync(m.file, src.replace(m.from, m.to))
  const result = runSuite()
  restoreAll()

  console.log(`${tag} ${m.name}`)

  if (result.crashed) {
    console.log('      套件崩了（没解析到汇总行）——这本身说明变异被抓到了，但要人工看一眼：')
    console.log(result.tail)
    bad += 1
    continue
  }

  const expects = m.expect.map(labelOf)
  const missed = expects.filter((label) => !result.reds.includes(label))

  if (m.diagnostic) {
    console.log(`      诊断型：翻红 ${result.reds.length} 条（不要求翻红）`)
    ok += 1
    continue
  }

  if (missed.length === 0) {
    console.log(`      翻红 ${result.reds.length} 条，期望的都在`)
    ok += 1
  } else {
    console.log(`      翻红 ${result.reds.length} 条，但期望的没红：`)
    for (const label of missed) console.log(`        - ${label}`)
    console.log(`      实际翻红的：${result.reds.length === 0 ? '（一条都没有）' : ''}`)
    for (const label of result.reds.slice(0, 12)) console.log(`        · ${label}`)
    bad += 1
  }
}

// —— 收尾：核对源码真的还原干净了 ——
let dirty = false
for (const [path, text] of originals) {
  if (readFileSync(path, 'utf8') !== text) {
    console.error(`\n❌ ${path} 没有还原干净！`)
    dirty = true
  }
}
if (dirty) {
  console.error('   源码现在带着变异，**别拿它去打包或提交**。')
  process.exit(1)
}

console.log(`\n反证${bad === 0 ? '通过' : '未通过'}：${ok} / ${selected.length}`)
if (only !== null) {
  console.log(`（只跑了名字含「${only}」的 ${selected.length} / ${MUTATIONS.length} 个变异。）`)
}
if (skipped.length > 0) {
  console.log(`锚点失效（结论无效）的有 ${skipped.length} 个：`)
  for (const name of skipped) console.log(`  - ${name}`)
  console.log('⇒ 改了被变异覆盖的代码之后，锚点会静默跟丢。回去修锚点，别把这里读成「通过」。')
}
process.exit(bad === 0 ? 0 : 1)
