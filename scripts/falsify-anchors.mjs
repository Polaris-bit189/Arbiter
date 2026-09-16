/**
 * 全部反证脚本的**锚点总检**：几十毫秒，替代「先等一整轮基线，再发现锚点过期」。
 *
 *   node scripts/falsify-anchors.mjs
 *
 * 它依次起每支 `falsify-*.mjs`，各带一个 `--anchors-only`，汇总成一张表。
 * 「命中次数对不对」这道检查在那些脚本里原先排在**基线之后**，于是一次重构就要白等
 * 一轮（`falsify:tasks` 22 分钟、`falsify:mcp` 141 秒），而报出来的还是「有断言没红」
 * ——**读起来像断言失效，其实是锚点过期**。这里把它提前到零成本的位置。
 *
 * 四件刻意的事：
 *
 * 1. **只用 `spawnSync(process.execPath, [...])`**。不要写成 `spawn('npx.cmd', …)`：
 *    `.cmd` 是批处理，Node 24 上不带 `shell` 直接 `EINVAL`（仓库里为此踩过一次，
 *    见 `run-pdf-test.mjs` 旁边那段说明）。`process.execPath` 是 node.exe 的绝对路径，
 *    不需要 shell，`falsify-plugin-launch.mjs` 起子进程用的也是这个形状。
 * 2. **超时 30 秒当作失败报出来**。这条路上子进程只读几个源码文件，
 *    实测每支不到 1 秒；真超时说明有人把钩子写成了会跑测试的样子——那必须红，
 *    不能悄悄放过（否则这个脚本自己就退化成一句「一切正常」）。
 * 3. **子进程的 stdout 只在失败时展示**。全过时十几支的逐条锚点清单有近两百行，
 *    会把这个表冲没。
 * 4. ⚠️ **清单从目录派生，不写死**（2026-09-16 改）。原先是一份手写的 13 项数组，
 *    于是新加一支反证脚本时，它**自动失去这层保护而没有任何提示**——加 `falsify-shortcuts.mjs`
 *    时就撞上了：表上照旧写着「13/13 全部命中」，看上去一切正常。
 *    这与本仓库反复记的那类「守卫漏了一个入口」是同一种形状，
 *    所以判据改成「扫到几支就查几支」，外加一条**防空转前置**（扫到 0 支必须红）。
 */
import { spawnSync } from 'child_process'
import { readdirSync } from 'fs'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'
import { REPORT_LINE_PREFIX } from './lib/anchors.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * 目录里全部 `falsify-*.mjs`。
 *
 * **包含**那两支刻意不进 `npm run falsify` 聚合的（`-tasks` 22 分钟、
 * `-plugin-launch` 要先 `build:unpack`）——这道检查本身只读几个源码文件，
 * 对它们和对其余各支一样便宜，而漏掉它们正是上面第 4 条要防的事。
 */
const SCRIPTS = readdirSync(resolve(ROOT, 'scripts'))
  .filter((name) => /^falsify-.*\.mjs$/.test(name) && name !== 'falsify-anchors.mjs')
  .sort()

/** 子进程超时（毫秒）。只读文件，实测每支不到 1 秒 */
const TIMEOUT_MS = 30_000

/** 中文在终端里占两列，按码点估算显示宽度，好让表格对得齐 */
const displayWidth = (s) => [...s].reduce((n, ch) => n + (ch.codePointAt(0) > 0x2e7f ? 2 : 1), 0)
const padWide = (s, width) => s + ' '.repeat(Math.max(0, width - displayWidth(s)))

/** 从子进程输出里取最后一行机器可读的汇总 */
function parseReport(out) {
  const lines = out.split(/\r?\n/)
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (lines[i].startsWith(REPORT_LINE_PREFIX)) {
      try {
        return JSON.parse(lines[i].slice(REPORT_LINE_PREFIX.length))
      } catch {
        return null
      }
    }
  }
  return null
}

/**
 * 防空转：清单从目录派生之后，「一个都没扫到」是有可能的（目录改名、都在别处）。
 * 那种情况下下面每一行都不跑，而汇总会老老实实报一句「0/0 脚本通过」——
 * **看着像一切正常**。这与本仓库抓过的装饰性断言是同一种形状，所以先钉死。
 */
if (SCRIPTS.length === 0) {
  console.error('scripts/ 下一个 falsify-*.mjs 都没有扫到——清单派生错了，本次检查无效。')
  process.exit(1)
}

const rows = []
let scriptOk = 0
let anchorTotal = 0
let anchorMisses = 0

for (const script of SCRIPTS) {
  const file = resolve(ROOT, 'scripts', script)
  const result = spawnSync(process.execPath, [file, '--anchors-only'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024
  })
  const out = `${result.stdout ?? ''}${result.stderr ?? ''}`

  if (result.error?.code === 'ETIMEDOUT') {
    rows.push({
      script,
      ok: false,
      anchors: -1,
      misses: -1,
      note: `超过 ${TIMEOUT_MS / 1000} 秒没跑完（钩子写成会跑测试的样子了？）`,
      out
    })
    continue
  }
  if (result.status === null) {
    rows.push({
      script,
      ok: false,
      anchors: -1,
      misses: -1,
      note: `子进程没起来或被杀掉（status=null，signal=${result.signal ?? '无'}）`,
      out
    })
    continue
  }

  const report = parseReport(out)
  if (report === null) {
    rows.push({
      script,
      ok: false,
      anchors: -1,
      misses: -1,
      note: '没打印出锚点汇总行（钩子没装上，或者脚本在钩子之前就抛了）',
      out
    })
    continue
  }

  rows.push({
    script,
    ok: report.ok && result.status === 0,
    anchors: report.anchors,
    misses: report.misses,
    note: report.ok ? '' : `${report.misses} 个锚点没命中：${report.failed.join('；')}`,
    out
  })
}

/* ------------------------------------------------------------------ 汇总表 */

const width = Math.max(...rows.map((r) => displayWidth(r.script)))
console.log(
  '脚本' + ' '.repeat(Math.max(1, width - displayWidth('脚本') + 2)) + '锚点   命中   结果'
)

let unknown = 0

for (const row of rows) {
  if (row.ok) scriptOk += 1
  if (row.anchors < 0) {
    unknown += 1
  } else {
    anchorTotal += row.anchors
    anchorMisses += row.misses
  }
  console.log(
    padWide(row.script, width) +
      '  ' +
      padWide(row.anchors < 0 ? '?' : String(row.anchors), 4) +
      '  ' +
      padWide(row.misses < 0 ? '?' : String(row.anchors - row.misses), 4) +
      '  ' +
      (row.ok ? '✓' : `✗ ${row.note}`)
  )
}

// 失败的那些把子进程输出原样贴出来：逐条「脚本 / 变异名 / 命中次数 / 期望次数」
// 就在里面，外面不必再回一层终端去单独跑一支。
for (const row of rows) {
  if (row.ok) continue
  const rule = '─'.repeat(Math.max(0, 60 - row.script.length))
  console.log(`\n───── ${row.script} 的输出 ${rule}`)
  console.log(row.out.trimEnd() || '（子进程一个字节都没输出）')
}

// 「多少个锚点没命中」只在真有汇总行时才有意义——没有汇总行的那些单独说，
// 否则会打出「0 个没命中」而明明有脚本是红的（读起来像一切都好）。
const suffix = unknown > 0 ? `，另有 ${unknown} 个脚本没给出锚点汇总` : ''
const summary =
  scriptOk === SCRIPTS.length
    ? `${scriptOk}/${SCRIPTS.length} 脚本通过，共 ${anchorTotal} 个锚点，全部命中期望次数`
    : `${scriptOk}/${SCRIPTS.length} 脚本通过，共 ${anchorTotal} 个锚点，其中 ${anchorMisses} 个没命中期望次数${suffix}`
console.log(`\n${summary}`)
process.exit(scriptOk === SCRIPTS.length ? 0 : 1)
