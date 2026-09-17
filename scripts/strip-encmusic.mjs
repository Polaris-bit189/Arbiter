/**
 * 从一个**已经导出好的目录**里剥掉「加密音乐容器」这一整类功能。
 *
 *     node scripts/strip-encmusic.mjs D:/change/Arbiter
 *
 * ## 它为什么存在
 *
 * 这一类功能的性质与其余全部功能不同：它解开的是各家音乐 App 的加密容器，
 * 而那件事在别处有过下架记录。所以「万一被下架，能立刻重出一份不含它的版本」
 * 是**一条必须能在几分钟内走完的路**，而不是一句安慰。
 *
 * ## 三条设计约束
 *
 * - **规则是数据，不是代码**（`encmusic-strip.json`），因为它随代码漂：
 *   加一个容器格式、改一次引擎表，接线点就变了。写死在导出脚本里的话，
 *   漂的表现是「剥完之后树编译不过」，或者更糟——**剥不干净而没人发现**。
 * - **每一步都验命中次数**，对不上就**整个中止**，不写半份结果。
 * - **最后有一道全局复核**：在整棵树里搜这一类的特征串，**搜到一个就非零退出**。
 *   前两步保证「我删掉了我认识的那些」，这一步保证「没有我没想到的那些」。
 *
 * ⚠️ 它**只动目标目录**，绝不碰开发仓。开发仓里这一类功能永远在（那是它的家）。
 */
import { readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const RULES = JSON.parse(readFileSync(join(HERE, 'encmusic-strip.json'), 'utf8'))

const target = process.argv[2]
if (!target) {
  console.error('用法：node scripts/strip-encmusic.mjs <已导出的目录>')
  process.exit(2)
}
const ROOT = resolve(target)
if (!statSync(ROOT).isDirectory()) {
  console.error(`不是目录：${ROOT}`)
  process.exit(2)
}

console.log(RULES.why.join('\n'))
console.log('')

/* ------------------------------------------- 1. 改接线（先改，失败时规则还在） */

for (const s of RULES.substitutions) {
  const p = join(ROOT, s.file)
  let text
  try {
    text = readFileSync(p, 'utf8')
  } catch {
    console.error(`✗ 读不到 ${s.file}（规则过期了？）`)
    process.exit(1)
  }

  const startHits = text.split(s.start).length - 1
  if (startHits !== 1) {
    console.error(`✗ ${s.file}｜${s.note}：起点锚命中 ${startHits} 次（期望 1）`)
    console.error('  规则与代码漂了。**先修规则再剥**——硬剥会留下一棵编译不过的树。')
    process.exit(1)
  }
  const at = text.indexOf(s.start)
  // `end: null` = 「从起点到文件尾」——给的是「这个文件里最后一节」那种规则。
  const endAt = s.end === null ? text.length : text.indexOf(s.end, at + s.start.length)
  if (endAt < 0) {
    console.error(`✗ ${s.file}｜${s.note}：终点锚在起点之后找不到`)
    process.exit(1)
  }

  writeFileSync(p, text.slice(0, at) + s.to + text.slice(endAt), 'utf8')
  console.log(`✓ ${s.file}｜${s.note}`)
}

/* ---------------------------------------------------------------- 2. 删文件 */
//
// ⚠️ 删除放在替换**之后**：万一替换那一步中止，树里还留着规则，人可以就地看明白是哪条
// 锚点过期了。反过来先删的话，一次失败就只剩「一堆接线 + 实现没了」。
// 名单里包含剥离工具自己——理由见 JSON 的 why。

for (const rel of RULES.delete) {
  try {
    rmSync(join(ROOT, rel), { recursive: true, force: true })
    console.log(`✓ 删掉 ${rel}`)
  } catch (error) {
    console.error(`✗ 删不掉 ${rel}：${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
}

/* ---------------------------------------------------------------- 3. 复核 */

const SKIP = new Set(['node_modules', '.git', 'dist', 'out'])
const hits = []

;(function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) {
      walk(full)
      continue
    }
    // 只扫文本类文件；二进制里出现这几个字节是巧合，不是残留
    if (!/\.(ts|tsx|mjs|js|json|md|yml|yaml|html|nsh|txt)$/.test(name)) continue
    let text
    try {
      text = readFileSync(full, 'utf8')
    } catch {
      continue
    }
    for (const needle of RULES.forbidden) {
      if (text.includes(needle)) {
        hits.push(`${full.slice(ROOT.length + 1)} ← ${needle}`)
        break
      }
    }
  }
})(ROOT)

console.log('')
if (hits.length > 0) {
  console.error(`✗ 复核没过：还有 ${hits.length} 个文件提到这一类功能——`)
  for (const h of hits) console.error(`    ${h}`)
  console.error('\n剥不干净就**不要发**。补规则，重出一份。')
  process.exit(1)
}

console.log(`✓ 复核通过：整棵树里搜不到 ${RULES.forbidden.length} 个特征串中的任何一个。`)
console.log('  这份目录不含「加密音乐容器」这一类功能。')
