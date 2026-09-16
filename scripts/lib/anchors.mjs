/**
 * 反证脚本的**锚点自检**助手。
 *
 * ## 为什么要有它
 *
 * 13 支 `scripts/falsify-*.mjs` 的每个变异都以「把 `from` 在源码里**恰好命中 N 次**的那段
 * 换成 `to`」为起点。而「命中次数对不对」这道检查原先一律**排在基线之后**——
 * 一轮 `falsify:tasks` 22 分钟、`falsify:mcp` 141 秒，人坐在那儿等着，等到的却是一句
 * 「有断言没红」。**那句话读起来像断言失效，其实是锚点过期**：有人重构了被覆盖的代码，
 * `from` 在源码里已经命中 0 次，突变根本没生效，于是「零红」是必然的。
 * 仓库里为此白等过多次，`falsify-mcp.mjs` 的注释里就在抱怨同一件事。
 *
 * 这个模块把「命中次数」这件事单独拎出来：**只读源码、只算数字**，绝不写盘、
 * 不碰 `git`、不起任何子进程。所以它可以被反复跑，代价是几十毫秒——
 * 足够挂在 CI 或提交前的钩子里，而不必等一整轮基线。
 *
 * ## 契约（这是这个模块的全部对外行为）
 *
 * ```js
 * checkAnchors(mutations, options) -> report
 * ```
 *
 * - `mutations`：某支反证脚本的 `MUTATIONS` 数组，原样传进来即可。
 * - 每条变异取哪一段、期望命中几次，**按被测脚本自己的三种形状**推断（不另立一套语义）：
 *   1. `edits: [{ from, to }, …]`——`falsify-downlink` / `-electron-free` / `-mcp` /
 *      `-plugin-launch` 用的形状。**逐段各期望 1 次**，而且和脚本一样是**累积**匹配的
 *      （第 k 段在「前 k-1 段已经替换过」的文本上数命中次数）。一段可以自带
 *      `file`（`edit.file`），表示这条变异横跨两个文件——累积因此**按文件各攒一份**。
 *   2. `from: [...]` / `to: [...]` 数组——`falsify-pdf` 用的形状。**逐段各期望 1 次**，
 *      在**原文**上数（脚本就是这么数的，别把两种形状的语义合成一个）。
 *   3. `from: '…'` 单段——其余脚本。期望 `expectHits ?? count ?? 1` 次
 *      （`expectHits` 是 `falsify-ui.mjs` 里那个变量名，`count` 是它读的字段名，两个都认）。
 * - `options.defaultFile`：变异自己没写 `file` 时用哪个文件。`falsify-doc.mjs` 与
 *   `falsify-ui-panel.mjs` 通篇只有一个文件，`falsify-pandoc.mjs` 写的是 `m.file ?? ADAPTER`。
 * - `options.normalizeLf`：匹配前把 CRLF 归一成 LF。**必须与脚本自己一致**——
 *   `cli` / `downlink` / `electron-free` / `mcp` / `tasks` / `ui` / `ui-panel` 这七支
 *   读盘后过了 `toLf`，其余六支没有。这里若擅自统一，会出现「我说命中 1 次、
 *   脚本说命中 0 次」的假绿。
 * - `options.repoRoot`：相对路径按**仓库根**解析。默认取本文件上两级
 *   （`scripts/lib/anchors.mjs` → 仓库根），与 `falsify-plugin-launch.mjs` 里
 *   `resolve(dirname(fileURLToPath(import.meta.url)), '..')` 是同一个套路。
 * - `report`：见下面 `checkAnchors` 的返回处。**命中 0 次与命中 2 次分得开**——
 *   只说「没命中唯一一次」的话两者根本不一样（前者是锚点过期，后者是锚点被别的同款行
 *   网住了），仓库里两种都踩过。
 *
 * 带 `diagnostic: true` 的变异**照样检查锚点**：它们只是「不要求翻红」，
 * 锚点失效一样会让那一轮变成白跑。
 *
 * ## 唯一的例外：`--anchors-only` 这条路上不许有副作用
 *
 * `anchorsOnlyGuard()` 是给 13 支脚本直接调的那层壳。它只在**命令行里真的有**
 * `--anchors-only` 时才做事——没有这个参数时立刻返回，脚本后面的一切行为逐字节不变。
 */
import { readFileSync } from 'fs'
import { basename, dirname, isAbsolute, resolve } from 'path'
import { fileURLToPath } from 'url'

/** 仓库根：`scripts/lib/anchors.mjs` 往上两级 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** 机器可读行的前缀。父进程（`falsify-anchors.mjs`）就靠它认这一行 */
export const REPORT_LINE_PREFIX = '__ANCHORS__ '

/** 锚点摘要只截这么长，够看清是哪一行、又不会把输出冲垮 */
const SNIPPET_LEN = 56

/** 与脚本里那份 `toLf` 逐字同义 */
const toLf = (s) => s.replace(/\r\n/g, '\n')

/** 锚点摘要：换行与连续空白压成 `⏎` / 单空格，好让它落在**一行**里 */
function snippet(text) {
  const one = String(text).replace(/\r\n/g, '\n').replace(/\n/g, '⏎').replace(/\s+/g, ' ')
  return one.length > SNIPPET_LEN ? `${one.slice(0, SNIPPET_LEN)}…` : one
}

/** 期望次数：`expectHits`（ui.mjs 的变量名）与 `count`（它读的字段名）都认 */
function expectedOf(mutation) {
  const want = mutation.expectHits ?? mutation.count ?? 1
  if (typeof want !== 'number' || !Number.isInteger(want) || want < 1) {
    throw new TypeError(`锚点期望次数必须是正整数，拿到 ${JSON.stringify(want)}`)
  }
  return want
}

/**
 * 把一条变异摊成「若干段锚点 + 每段期望命中几次」。
 *
 * 摊法是照抄被测脚本自己的读法，不是另立一套：三种形状见文件头那三条。
 */
export function segmentsOf(mutation) {
  if (Array.isArray(mutation.edits)) {
    return {
      kind: 'edits',
      segments: mutation.edits.map((edit) => ({
        from: edit.from,
        to: edit.to,
        // 一段锚点可以自带 `file`（一条变异横跨两个文件时），没写就落回变异自己的 `file`。
        // **这个字段必须一路带到数命中的地方**：漏掉它的表现是「拿 A 文件的锚点去 B 文件里找」，
        // 报出来是命中 0 次——与「锚点真的过期了」长得一模一样，实为本仓库最难查的一类假红。
        file: edit.file ?? null,
        label: snippet(edit.from),
        expected: 1
      }))
    }
  }

  if (Array.isArray(mutation.from)) {
    const tos = Array.isArray(mutation.to) ? mutation.to : [mutation.to]
    return {
      kind: 'froms',
      segments: mutation.from.map((from, index) => ({
        from,
        to: tos[index],
        file: null,
        label: snippet(from),
        // 逐段各 1 次。要逐段给不同的期望值就传 `expectHits: [n, m]`
        expected: Array.isArray(mutation.expectHits)
          ? (mutation.expectHits[index] ?? 1)
          : expectedOf(mutation)
      }))
    }
  }

  if (typeof mutation.from !== 'string') {
    throw new TypeError(`变异既没有 edits，from 也不是字符串：${JSON.stringify(mutation.from)}`)
  }
  return {
    kind: 'from',
    segments: [
      {
        from: mutation.from,
        to: mutation.to,
        file: null,
        label: snippet(mutation.from),
        expected: expectedOf(mutation)
      }
    ]
  }
}

/**
 * 逐条变异数锚点命中次数。**只读**——这个函数没有任何写盘 / 子进程 / git 调用。
 *
 * 返回：
 * ```
 * {
 *   script, repoRoot,
 *   totals: { mutations, anchors, misses },
 *   ok,
 *   entries: [
 *     {
 *       name, file, kind, diagnostic, missingFile, ok,
 *       files,                      // 这条变异实际碰到的全部文件（可能不止一个）
 *       segments: [{ label, file, hits, expected, ok }],
 *       error: string | null        // 文件缺失 / 形状非法之类的硬错误
 *     }
 *   ]
 * }
 * ```
 */
export function checkAnchors(mutations, options = {}) {
  if (!Array.isArray(mutations)) throw new TypeError('mutations 必须是数组')

  const repoRoot = options.repoRoot ?? REPO_ROOT
  const normalizeLf = options.normalizeLf === true
  const script = options.script ?? basename(process.argv[1] ?? '(unknown)')

  /** 同一个文件只读一次：13 支脚本里最多的一支覆盖 9 个文件、26 条变异 */
  const texts = new Map()
  const readSource = (file) => {
    const absolute = isAbsolute(file) ? file : resolve(repoRoot, file)
    if (!texts.has(absolute)) {
      try {
        const raw = readFileSync(absolute, 'utf8')
        texts.set(absolute, { text: normalizeLf ? toLf(raw) : raw, missing: false })
      } catch {
        texts.set(absolute, { text: '', missing: true })
      }
    }
    return { ...texts.get(absolute), absolute }
  }

  const entries = []
  let anchors = 0
  let misses = 0

  for (const mutation of mutations) {
    const name = mutation.name ?? '(无名变异)'
    const file = mutation.file ?? options.defaultFile

    if (typeof file !== 'string') {
      entries.push({
        name,
        file: '(未指定)',
        kind: '(未知)',
        diagnostic: mutation.diagnostic === true,
        missingFile: false,
        ok: false,
        segments: [],
        error: '这条变异既没写 file，调用方也没给 defaultFile —— 数不了锚点'
      })
      misses += 1
      continue
    }

    const { kind, segments } = segmentsOf(mutation)
    const { absolute } = readSource(file)

    const reported = []
    // ⚠️ `edits` 形状在脚本里是**累积**匹配的（第 k 段数在「前 k-1 段已替换过」的文本上），
    // 这里照抄；`froms` 形状则在**原文**上数——两种形状在脚本里就是两种数法。
    // ⚠️ 累积必须**按文件各攒一份**：一条变异可以横跨两个文件（段自带的 `file`），
    // 而分处两个文件的两段各自只有一个「前文」。
    const working = new Map()
    const touched = new Set()
    const missingFiles = []
    for (const segment of segments) {
      const source = readSource(segment.file ?? file)
      touched.add(source.absolute)
      if (source.missing) missingFiles.push(source.absolute)
      const base = kind === 'edits' ? (working.get(source.absolute) ?? source.text) : source.text
      const hits = base.split(segment.from).length - 1
      reported.push({
        label: segment.label,
        file: source.absolute,
        hits,
        expected: segment.expected,
        ok: hits === segment.expected
      })
      if (kind === 'edits' && hits === segment.expected)
        working.set(source.absolute, base.replace(segment.from, segment.to))
    }

    // 脚本在遇到第一段坏锚点时 `break`，这里刻意不 break：一次把所有坏锚点列全，
    // 省得改一条跑一次。多报的那几条不出现在脚本自己的输出里，以这里为准即可。
    const missing = missingFiles.length > 0
    const ok = !missing && reported.every((s) => s.ok)
    anchors += reported.length
    if (!ok) misses += 1

    entries.push({
      name,
      file: absolute,
      // 这条变异实际碰到的**全部**文件。横跨两个文件时 `file` 只是变异自己声明的那个，
      // 而「哪一段在哪个文件里」在报错时要看得见，否则会去错文件里找锚点。
      files: [...touched],
      kind,
      diagnostic: mutation.diagnostic === true,
      missingFile: missing,
      ok,
      segments: reported,
      error: missing ? `文件不存在或读不了：${missingFiles.join(', ')}` : null
    })
  }

  return {
    script,
    repoRoot,
    totals: { mutations: mutations.length, anchors, misses },
    ok: misses === 0,
    entries
  }
}

/** 命中次数按脚本自己的口径写成一行：「1 次」或「1/0 次」 */
const hitsText = (segments) => segments.map((s) => s.hits).join('/')

/** 人类可读的逐条报告 + 一行机器可读的汇总（父进程靠 `REPORT_LINE_PREFIX` 认它） */
export function printReport(report) {
  console.log(
    `[锚点] ${report.script} —— ${report.totals.mutations} 个变异 / ${report.totals.anchors} 个锚点`
  )
  console.log(`       仓库根 ${report.repoRoot}`)

  for (const entry of report.entries) {
    const diag = entry.diagnostic ? '  [diagnostic：不要求翻红，但锚点仍必须命中]' : ''
    if (entry.error) {
      console.log(
        `  ✗ ${report.script} | ${entry.name} | ${entry.error} | 期望 ${entry.segments.map((s) => s.expected).join('/') || 1} 次${diag}`
      )
      continue
    }
    if (entry.ok) {
      console.log(
        `  ✓ ${entry.name} —— 命中 ${hitsText(entry.segments)} 次（期望 ${entry.segments.map((s) => s.expected).join('/')} 次）${diag}`
      )
      continue
    }
    // 失败这一行按「脚本 / 变异名 / 命中次数 / 期望次数」四段写：
    // 命中 0 次与 2 次必须分得开（前者是锚点过期，后者是锚点被同款行网住了）。
    console.log(
      `  ✗ ${report.script} | ${entry.name} | 命中 ${hitsText(entry.segments)} 次 | 期望 ${entry.segments.map((s) => s.expected).join('/')} 次${diag}`
    )
    for (const segment of entry.segments) {
      if (!segment.ok)
        console.log(
          `        ↳ ${segment.hits} 次 / 期望 ${segment.expected} 次：${segment.label}` +
            // 这条变异横跨多个文件时把所在文件也报出来：不报的话，
            // 「拿 A 的锚点去 B 里找」与「锚点真的过期了」在输出上分不开
            (entry.files.length > 1 ? `  ← ${basename(segment.file)}` : '')
        )
    }
  }

  console.log(
    report.ok
      ? `  ${report.script}：${report.totals.anchors} 个锚点全部命中期望次数`
      : `  ${report.script}：${report.totals.misses} 个变异有锚点没命中期望次数`
  )
  console.log(
    REPORT_LINE_PREFIX +
      JSON.stringify({
        script: report.script,
        ok: report.ok,
        mutations: report.totals.mutations,
        anchors: report.totals.anchors,
        misses: report.totals.misses,
        failed: report.entries.filter((e) => !e.ok).map((e) => e.name)
      })
  )
}

/**
 * 13 支脚本调的那层壳。
 *
 * 命令行里没有 `--anchors-only` 时**立刻返回 `false`**，脚本照原样往下跑
 * （逐字节不变）。有它时：只跑锚点检查——不跑基线、不跑任何测试、不改任何源码、
 * 不做任何还原、不碰 git——全过 `exit 0`，否则 `exit 1`。
 *
 * @returns {false} 只有「没带这个参数」这一种返回值，其余情况都 `process.exit`
 */
export function anchorsOnlyGuard(mutations, options = {}) {
  if (!process.argv.slice(2).includes('--anchors-only')) return false
  const report = checkAnchors(mutations, options)
  printReport(report)
  process.exit(report.ok ? 0 : 1)
}
