/**
 * `scripts/test-plugin-launch.mjs` 的反证。
 *
 * 盯的是那 16 条断言里**真正承重**的几条——尤其是打包分支：
 * 干净机器上只剩这一条路，而 M5 的验收判据写的正是干净机器。
 *
 * 前置：`npm run build:unpack`（跟被测脚本一样）。**别在跑这个脚本的时候提交**：
 * 磁盘上的 `launch.mjs` / `asar.mjs` 有一段时间就是被改坏的那一份。
 *
 * ```bash
 * node scripts/falsify-plugin-launch.mjs
 * node scripts/falsify-plugin-launch.mjs --only=偏移
 * ```
 */
import { spawnSync } from 'child_process'
import { createHash } from 'crypto'
import { readFileSync, writeFileSync } from 'fs'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const LAUNCH = resolve(ROOT, 'plugins/arbiter/mcp/launch.mjs')
/** C 线把「找应用 + 装配 ARBITER_*」从 launch.mjs 抽到了这里，判据跟着搬了家 */
const TARGET = resolve(ROOT, 'plugins/arbiter/mcp/target.mjs')
const ASAR = resolve(ROOT, 'plugins/arbiter/mcp/asar.mjs')
const TEST = resolve(ROOT, 'scripts/test-plugin-launch.mjs')

const MUTATIONS = [
  {
    // 这就是当初那个 bug 的原样：拿普通 Node 的 `existsSync` 去看 asar 内部。
    // 它必然为 false，于是打包分支判成「没有 MCP 入口」。
    name: '用 existsSync 看 asar 内部（当初那个原样 bug）',
    // ⚠️ 锚点跟着代码搬到了 target.mjs：C 线把「找应用」抽出去时带走了这一行，
    // 而且目标也从写死的 'out/main/mcp.js' 换成了形参 entry。
    // 这一条**就这样静默失效过一次**（命中 0 次 → 脚本报「结论无效」，
    // 而那句很容易被读成通过）——「改了被反证覆盖的代码必须重跑」的又一个实例。
    file: TARGET,
    edits: [
      {
        from: '    else if (existsSync(asar) && asarHasEntry(asar, entry)) {\n',
        to: '    else if (existsSync(join(asar, entry))) {\n'
      }
    ],
    expect: [
      // 退出码、形态、入口、错误文案、就绪——五条一起塌。
      // 顺带说明这几条不是各测各的，它们说的是同一件事的五个面。
      '8 退出码为 0',
      '9 选中的形态是 packaged',
      '10 指向的 MCP 入口在安装目录里',
      '11 没报「没有 MCP 入口」',
      '12 MCP server 真的起来了'
    ]
  },
  {
    // 只改判据的另一半：probe 是对的，但后面那道闸门又用 `existsSync` 复核了一遍。
    // 与上一条红的是同一批断言，**但走的是另一个代码路径**——两处都得堵上。
    name: '闸门用 existsSync 复核 asar 路径（probe 对了也白搭）',
    file: LAUNCH,
    edits: [
      {
        // ⚠️ 必须**连 import 一起加**：原来的写法只换了闸门那一行，而 launch.mjs
        // 并没有 import existsSync —— 求值条件时就抛 ReferenceError，根本走不到
        // 那句日志，于是「11 没报「没有 MCP 入口」」**永远不可能红**。
        // 换句话说那条变异当时测的是「启动器崩了」，不是「闸门误判了 asar 路径」。
        from: "import { spawn } from 'child_process'\n",
        to: "import { existsSync } from 'fs'\nimport { spawn } from 'child_process'\n"
      },
      {
        from: 'if (!target.usable) {\n',
        to: "if (!existsSync(target.mcpJs ?? '')) {\n"
      }
    ],
    expect: [
      '8 退出码为 0',
      '9 选中的形态是 packaged',
      '10 指向的 MCP 入口在安装目录里',
      '11 没报「没有 MCP 入口」',
      '12 MCP server 真的起来了'
    ]
  },
  {
    // 读错索引长度所在的那个偏移。头是 pickle 拼出来的，偏移 12 才是 JSON 字节数，
    // 写成 8 会读到「含自身长度的头长」，多出 4 个字节 → JSON 解不开 → 一律 false。
    // 这条也是「从别的实现里抄偏移量」最容易抄错的样子。
    name: '读错索引长度的偏移（12 → 8）',
    file: ASAR,
    edits: [
      { from: 'const size = head.readUInt32LE(12)', to: 'const size = head.readUInt32LE(8)' }
    ],
    // ⚠️ **期望清单只能收实跑观测到的文案**（约束 33 第 4 条），这一条 2026-09-14 改过。
    // 原先收 `4 / 6 / 8 / 10 / 12` 是**错的**，原因分两半，而且修法不同：
    //   - 第 8 / 10 / 12 条（端到端）**确实跑不到**：布局闸门红在前，脚本 `process.exit(1)`。
    //   - 第 4 / 6 条（fixture 级的直接覆盖）**本该跑得到**，是闸门被放在第 2 条之后就
    //     把脚本掐了。那两条恰恰最能指出病根（「认不出 asar 里那条」），让它们空跑
    //     等于把最准的那条诊断埋掉。
    // 所以**修的是被测脚本本身**（闸门挪到第 7 条之后），不是把期望清单改短——
    // 改短期望是这类脚本最该防的那件事（约束 33 第 4 条）。
    expect: ['2 打包布局里有 MCP 入口', '4 认得出真的存在的那条', '6 深一层也要认']
  },
  {
    // 索引明明解开了却不往里走，直接 return true——「不存在的条目」就认不出来了。
    // 这是最典型的装饰性实现：真路径上跑得通，判据本身是空的。
    name: '解了索引但不逐层匹配（一律 return true）',
    file: ASAR,
    edits: [
      {
        // 锚点跟着代码搬了家：asar.mjs 加了第二个出口 asarEntryNames() 之后，
        // 「读索引」被抽进了共用的 readIndex()，而「逐层走树」留在 asarHasEntry() 里。
        // 变异的意思没变 —— **解了索引却不往里走**，于是不存在的条目也认。
        // 它**就这样静默失效过一次**（命中 0 次 → 脚本报「结论无效」，不是通过）。
        from: [
          '  let node = index',
          "  for (const part of entry.split('/').filter(Boolean)) {",
          '    node = node?.files?.[part]',
          '    if (!node) return false',
          '  }',
          '  return true'
        ].join('\n'),
        to: '  void index\n  return true'
      }
    ],
    expect: ['5 不存在的条目要返回 false']
  }
]

/* ------------------------------------------------------- 锚点自检
 * `--anchors-only` 时**只**数锚点命中次数：不跑基线、不跑任何测试、不改任何源码、
 * 不做任何还原、也不碰 git。全过 exit 0，有锚点命不中 exit 1（逐条打印
 * 「脚本 / 变异名 / 命中次数 / 期望次数」）。
 *
 * 这一支的变异用的是 `edits: [{ from, to }, …]` 形状，助手按**累积**语义数
 * （第 k 段数在「前 k-1 段已替换过」的文本上）——与下面那个循环逐字一致。
 * 它还有两条锚点**就这样静默失效过**（命中 0 次，见上面那两条注释）。
 * 见 scripts/lib/anchors.mjs 的文件头。
 */
if (process.argv.slice(2).includes('--anchors-only')) {
  const { anchorsOnlyGuard } = await import('./lib/anchors.mjs')
  anchorsOnlyGuard(MUTATIONS)
}

// ── 跑一轮被测套件，把翻红的断言名抠出来 ──────────────────────────────────────
function runSuite() {
  const r = spawnSync(process.execPath, [TEST], { encoding: 'utf8', cwd: ROOT })
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`
  const red = []
  // ⚠️ 这里的切行必须同时吃掉回车：detail 里带 Windows 堆栈的那些行，
  // 行尾留着一个 CR，而正则里的点号 **不匹配 CR**、美元锚（没有 m 标志）
  // 又只在输入末尾才成立 —— 整行匹配失败，于是**真红了的断言被报成
  // 「抓不住错误」**。实测过：同一行只差一个 CR，一个 false 一个 true。
  // 这个方向最坏：把脚本自己的解析 bug 说成断言失效，会诱导人去放宽断言。
  // （仓库里其余 13 支反证脚本的切行都处理了 CR，只有这一支漏了。）
  for (const line of out.split(/\r?\n/)) {
    const m = /^\s*✗\s+(.*?)(?:\s+——.*)?$/.exec(line)
    if (m) red.push(m[1].trim())
  }
  const passed = Number(/通过 (\d+)，失败 (\d+)/.exec(out)?.[1] ?? -1)
  const failed = Number(/通过 (\d+)，失败 (\d+)/.exec(out)?.[2] ?? -1)
  return { red, passed, failed, out }
}

const ONLY = (process.argv.slice(2).find((a) => a.startsWith('--only=')) ?? '').slice(
  '--only='.length
)
const selected = ONLY ? MUTATIONS.filter((m) => m.name.includes(ONLY)) : MUTATIONS
if (ONLY && selected.length === 0) {
  console.error(`没有名字含「${ONLY}」的变异。现有：`)
  for (const m of MUTATIONS) console.error(`  - ${m.name}`)
  process.exit(1)
}

console.log(
  ONLY
    ? `只跑 ${selected.length} / ${MUTATIONS.length} 个变异（--only=${ONLY}），基线照样跑一轮…`
    : `${MUTATIONS.length} 个变异，每个各跑一轮（每轮要真起一次打包后的 Electron，几秒）…`
)

// ── 基线：先确认没改坏的时候是全绿的 ──────────────────────────────────────────
const base = runSuite()
console.log(`基线：通过 ${base.passed}，失败 ${base.failed}`)
if (base.failed !== 0 || base.passed <= 0) {
  console.error('\n基线就不绿，后面的结论没有意义。先修好再跑反证。')
  console.error(base.out.slice(-2000))
  process.exit(1)
}

let problems = 0

for (const m of selected) {
  const original = readFileSync(m.file, 'utf8')
  let mutated = original

  let anchorOk = true
  for (const edit of m.edits) {
    const hits = mutated.split(edit.from).length - 1
    // **命中次数一定要打出来**：只说「没命中唯一一次」的话，0 次和 2 次分不清——
    // 重构会让锚点静默失效（命中 0 次），而那种变异是「假通过」。
    console.log(
      `[${m.name}] 锚点命中 ${hits} 次（期望 1 次）：${JSON.stringify(edit.from.slice(0, 44))}`
    )
    if (hits !== 1) anchorOk = false
    mutated = mutated.replace(edit.from, edit.to)
  }

  if (!anchorOk) {
    console.log('  变异没生效，结论无效——先修锚点。')
    problems += 1
    continue
  }

  writeFileSync(m.file, mutated, 'utf8')
  let result
  try {
    result = runSuite()
  } finally {
    writeFileSync(m.file, original, 'utf8')
  }

  const missing = m.expect.filter((e) => !result.red.some((r) => r.includes(e)))
  if (missing.length > 0) {
    problems += 1
    console.log(`  ✗ 有断言没红（说明它抓不住这个错误）：`)
    for (const e of missing) console.log(`    - ${e}`)
    console.log(`  实际翻红 ${result.red.length} 条：`)
    for (const r of result.red) console.log(`    - ${r}`)
  } else {
    console.log(`  翻红 ${result.red.length} 条，期望的都在`)
    for (const r of result.red) {
      const expected = m.expect.some((e) => r.includes(e))
      console.log(`    - ${r}${expected ? '' : '   (顺带)'}`)
    }
  }
}

// 把每个文件的 sha256 打出来：这条「已还原」的结论不该只有脚本自己说了算
console.log()
for (const f of [LAUNCH, ASAR]) {
  console.log(`  ${createHash('sha256').update(readFileSync(f)).digest('hex')}  ${f}`)
}

const scope = ONLY ? `（**只跑了 ${selected.length} / ${MUTATIONS.length} 个变异**）` : ''
console.log(
  problems === 0
    ? `\n反证通过：每个变异都被对应的断言抓住了，且源码已还原。${scope}`
    : `\n反证未通过：${problems} 个变异没被抓住。${scope}`
)
process.exit(problems === 0 ? 0 : 1)
