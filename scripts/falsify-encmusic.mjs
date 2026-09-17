/**
 * 反证 `scripts/test-encmusic.ts`（加密音乐容器的回归网）。
 *
 *   node scripts/falsify-encmusic.mjs
 *   node scripts/falsify-encmusic.mjs --only=密钥流     # 只跑名字里带这两个字的变异
 *
 * 每个变异：改坏被测代码的一处 → 跑一轮 → 立刻还原。
 * 「期望翻红的断言一条都没红」即判定那条断言是装饰品，脚本退出码非零。
 *
 * ⚠️ 它会**临时改写** `src/main/converters/encmusic/` 下的两个文件。所以开头先查一次
 * 「这两个文件本来是不是干净的」：不干净就拒绝跑——那种情况下「还原」会把别人的在途改动
 * 覆盖成我这边的基线。
 *
 * ## 为什么这一套的反证值得单开
 *
 * 解密这类代码的错法**没有一个会崩**：偏移差 4 字节、密钥流少挪一位、认不出格式时
 * 「猜一个默认值」——三者的产物都是一份能落盘、能播放、只是内容全错的音频。
 * 而本套件里唯一有跨实现证据的只有 `[1]` 那条素材，其余靠往返。**往返是最容易被
 * 「两边一起写错」骗过去的那一类**，所以这里专门打往返够不着的地方（第 4 条）。
 */
import { spawnSync } from 'child_process'
import { createHash } from 'crypto'
import { readFileSync, writeFileSync } from 'fs'
import { resolve } from 'path'

const CONTAINERS = resolve('src/main/converters/encmusic/containers.ts')
const ADAPTER = resolve('src/main/converters/encmusic/index.ts')

const MUTATIONS = [
  {
    name: 'NCM 的音频起点少跳 4 字节（版面上最经典的一处写歪）',
    file: CONTAINERS,
    from: `  at += 4 + 4 + imageSpace`,
    to: `  at += 4 + imageSpace`,
    // ⚠️ 素材那条**必须**红：它是唯一有跨实现证据的断言，偏移差 4 字节时
    // 「解出来的头还是 RIFF 吗」立刻就答不上来。往返那条**不会**红——两边一起错。
    expect: ['⭐ 解开之后与 expected 逐字节相同（这一条背后是 Python 的 ncmdump 也解出同一份）']
  },
  {
    name: 'NCM 的密钥流不后移一位（漏掉 Python 里那个 [1:] / JS 里的 i+1）',
    file: CONTAINERS,
    from: `    const k = (i + 1) & 0xff
    box[i] = s[(s[k] + s[(k + s[k]) & 0xff]) & 0xff]`,
    to: `    const k = i & 0xff
    box[i] = s[(s[k] + s[(k + s[k]) & 0xff]) & 0xff]`,
    expect: ['⭐ 解开之后与 expected 逐字节相同（这一条背后是 Python 的 ncmdump 也解出同一份）']
  },
  {
    name: '认不出内含格式时猜一个默认值（把「不猜」换成 mp3）',
    file: CONTAINERS,
    from: `  const ext = sniffAudioExt(data)
  if (ext === null) {`,
    to: `  const ext = sniffAudioExt(data) ?? 'mp3'
  if (false) {`,
    // 这一条打的是「宁可猜一个也不报错」——本项目最忌讳的那类静默。翻转密钥块那条
    // 断言正是为它准备的：真的认不出时，它会产出一份「成功」的噪音。
    expect: ['⭐ 密钥块被改一个字节 → 直接抛错（解不出来就说解不出来，绝不返回一份猜出来的产物）']
  },
  {
    name: 'kwm 也被路由给 qmc（分派按扩展名，少一条分支就静默走错）',
    file: ADAPTER,
    from: `  if (fromExt === 'kwm') return decryptKwm(raw)`,
    to: `  if (fromExt === 'kwm') return decryptQmc(raw, fromExt)`,
    // ⚠️ 期望里**不能**写 `[3]` 那条 `kwm 往返`：它是直接调 `decryptKwm` 的，
    // 与适配器那张分派表无关，改了分派它照样绿。真正够得着的是端到端那条。
    expect: ['⭐ kwm 经适配器分派后解出的就是原音频（分派表少一条分支会静默走错函数）']
  },
  {
    name: 'qmc 的密钥长度分流反过来（≥ 0x400 当成有密钥块）',
    file: CONTAINERS,
    from: `    if (keySize < 0x400) {`,
    to: `    if (keySize >= 0x400) {`,
    // 静态盒那一支的样本末 4 字节是刻意喂成 0x1000 的，所以它一定会掉进错误的那一支。
    expect: [
      // ⚠️ 只留往返那条。另一条断的是**测试自己造的样本**（末 4 字节喂成 0x1000），
      // 实现怎么改都不会红——它是前置，不是判据，写进期望只会换来一轮假红。
      'qmc 静态盒往返（整文件即音频那一支）'
    ]
  }
]

/* ------------------------------------------------------- 锚点自检
 * `--anchors-only` 时**只**数锚点命中次数：不跑基线、不跑任何测试、不改任何源码。
 * ⚠️ 这段必须放在 `git status` 前置检查之前（见 `lib/anchors.mjs` 的文件头）。
 */
if (process.argv.slice(2).includes('--anchors-only')) {
  const { anchorsOnlyGuard } = await import('./lib/anchors.mjs')
  anchorsOnlyGuard(MUTATIONS, { defaultFile: CONTAINERS, normalizeLf: true })
}

const toLf = (s) => s.replace(/\r\n/g, '\n')

function runTests() {
  const out = spawnSync(
    'npx',
    ['tsx', '--tsconfig', 'tsconfig.test.json', 'scripts/test-encmusic.ts'],
    { encoding: 'utf8', shell: true }
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
    completed: total !== null,
    text
  }
}

/* ------------------------------------------------------------------ 前置 */

const fileOf = (m) => m.file ?? CONTAINERS
const FILES = [...new Set(MUTATIONS.map(fileOf))]
const shaOf = (f) => createHash('sha256').update(readFileSync(f)).digest('hex')

const dirty = spawnSync('git', ['status', '--porcelain', '--', ...FILES], { encoding: 'utf8' })
if (dirty.status !== 0) {
  console.error('`git status` 跑不起来，无法确认源码是干净的。')
  process.exit(1)
}
if (dirty.stdout.trim() !== '') {
  console.error(
    `这些文件现在**本来就有未提交的改动**：\n${dirty.stdout.trim()}\n` +
      '反证会把它们改坏再还原成「我刚读到的那一版」——那等于覆盖别人的在途改动。'
  )
  process.exit(1)
}

const ORIGINALS = new Map(FILES.map((f) => [f, toLf(readFileSync(f, 'utf8'))]))
const SHA_BEFORE = new Map(FILES.map((f) => [f, shaOf(f)]))

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

/* ------------------------------------------------------------------ 变异 */

for (const [index, m] of planned.entries()) {
  const file = fileOf(m)
  const source = ORIGINALS.get(file)
  const hits = source.split(m.from).length - 1
  console.log(`\n[${index + 1}/${planned.length}] ${m.name}`)
  if (hits !== 1) {
    console.error(`  锚点命中 ${hits} 次（期望 1）—— 变异没生效，结论无效`)
    problems += 1
    continue
  }

  writeFileSync(file, source.replace(m.from, m.to), 'utf8')
  const result = runTests()
  writeFileSync(file, source, 'utf8')

  if (!result.completed) {
    problems += 1
    console.log('  变异让套件在半路抛异常（汇总行都没打出来）——期望的断言根本没被执行。')
    console.log(result.text.slice(-900))
    continue
  }

  const missed = m.expect.filter((label) => !result.reds.includes(label))
  if (missed.length === 0) {
    console.log(`  翻红 ${result.reds.length} 条，期望的都在`)
    for (const label of result.reds) {
      console.log(`    - ${label}${m.expect.includes(label) ? '' : '   (顺带)'}`)
    }
  } else {
    problems += 1
    console.log('  有断言没红 —— 它们抓不住这个错误：')
    for (const label of missed) console.log(`    ! ${label}`)
    console.log(`  实际翻红：${result.reds.join(' | ') || '（一条都没红）'}`)
  }
}

/* ------------------------------------------------------------------ 收尾 */

const wrong = FILES.filter((f) => shaOf(f) !== SHA_BEFORE.get(f))
if (wrong.length > 0) {
  console.error(`\n源码没还原干净：\n${wrong.join('\n')}`)
  process.exit(1)
}

const leftover = spawnSync('git', ['status', '--porcelain', '--', ...FILES], { encoding: 'utf8' })
for (const f of FILES) console.log(`\n${f}\n  sha256 ${SHA_BEFORE.get(f)}`)
console.log(
  `\n  已还原（git status 对这些文件${leftover.stdout.trim() === '' ? '无输出' : `仍报：${leftover.stdout.trim()}`}）`
)
console.log(
  `  跑了 ${planned.length} / ${MUTATIONS.length} 个真实变异` + (only ? `（--only=${only}）` : '')
)

console.log(
  problems === 0
    ? '\n反证通过：每个变异都被对应的断言抓住了。'
    : `\n反证不通过：${problems} 处有问题。`
)
process.exit(problems === 0 ? 0 : 1)
