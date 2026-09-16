/**
 * 反证 `src/main/core/downlink.ts`。
 *
 * **为什么要有这个脚本**：`scripts/test-downlink.ts` 有 149 条断言，而在这个脚本出现之前
 * **一条都没被反证过**。按本项目的标准（PLAN §8、「断言必须反证」），这等于 149 条
 * 未兑现的声明——测试全绿和「断言其实抓不住错误」长得一模一样。
 *
 * 挑的六个变异都是**承重的判据**，不是随便找几行改坏：
 *
 *   1. User-Agent 丢掉 → 清华 TUNA 回 403，国内镜像整条链路哑火（且回退会把 403 当普通失败吞掉）
 *   2. 416 不再特判 → 「断点比资源还大」被当成失败，用户永远卡在这个文件上
 *   3. sha256 校验放行 → 投毒/截断的文件被当成功产物写进引擎目录（本项目最不能出的错）
 *   4. sha 不符时不删坏 `.part` → 每个镜像都在续传同一个坏文件，sha 永远对不上
 *   5. 续传不发 `Range` → 「续传」退化成整份重下，340 MB 断一次的代价回来了
 *   6. 镜像只试第一个 → 多镜像回退形同虚设，国内抽奖式失败照旧
 *
 * ## 用法
 *
 * ```bash
 * node scripts/falsify-downlink.mjs              # 全部
 * node scripts/falsify-downlink.mjs --only=416   # 只跑名字里含 "416" 的（基线照样跑）
 * ```
 *
 * ## 两条纪律（与 falsify-mcp.mjs 一致）
 *
 * - **锚点命中次数会被打印出来**。只说「没命中唯一一次」的话，0 次和 2 次分不清；
 *   而锚点一旦因为重构过期，变异就没生效，那时的「全绿」是个假结论。
 * - **跑这个脚本期间，磁盘上的 `downlink.ts` 就是被改坏的那一份。**
 *   这段时间里不要提交、不要跑别的套件、不要从绿灯里下任何结论。
 */
import { spawnSync } from 'child_process'
import { createHash } from 'crypto'
import { readFileSync, writeFileSync } from 'fs'
import { resolve } from 'path'

const DOWNLINK = resolve('src/main/core/downlink.ts')

const MUTATIONS = [
  {
    // 这条是 2026-09-13 实测出来的：TUNA 对「空 UA」和「浏览器 UA」一律 403，
    // 而 Electron 的 net.request 默认就发浏览器 UA。丢了这行，国内镜像全哑。
    name: 'User-Agent 丢掉（清华 TUNA 回 403）',
    file: DOWNLINK,
    edits: [
      {
        from: "    const headers: Record<string, string> = { 'User-Agent': USER_AGENT }",
        to: '    const headers: Record<string, string> = {}'
      }
    ],
    expect: ['请求自带 User-Agent，且不是浏览器那一串（TUNA 对两者一律 403）']
  },
  {
    // 416 = 断点比服务端资源还长（上次没下完、资源换版本了）。不特判就落进
    // 「非 2xx 即失败」，而 .part 一直是那个坏文件，用户重试多少次都卡在同一个文件上。
    name: 'HTTP 416 不再特判（断点比资源大被判成失败）',
    file: DOWNLINK,
    edits: [
      {
        from: [
          '        if (response.status === 416) {',
          '          // 断点比资源还长（上次没下完、资源又换了版本）。换从头写，不当作失败。',
          "          done({ kind: 'restart' })",
          '          return',
          '        }'
        ].join('\n'),
        to: '        // 变异：416 不再特判'
      }
    ],
    expect: ['416 后仍能下载成功', '416 后产物正确', '416 后重新发了不带 Range 的请求']
  },
  {
    // 校验是「等价于签名」的那一道（清单里的 sha256）。放行它 = 镜像被投毒或内容被
    // 中间设备改过都会静默写进引擎目录，而之后所有转换都会以奇怪的方式失败。
    name: 'sha256 校验放行（坏产物被当成成功）',
    file: DOWNLINK,
    edits: [
      {
        from: ['    const actual = await sha256File(partPath)', '    if (actual !== want) {'].join(
          '\n'
        ),
        to: ['    const actual = await sha256File(partPath)', '    if (false) {'].join('\n')
      }
    ],
    expect: ['sha256 不符 → 下载失败', 'sha256 不符 → 抛 DownloadFailed']
  },
  {
    // 只删最终文件、不删 `.part`：下一个镜像会把这个坏文件当断点续传，
    // 于是每个镜像都在补同一个坏文件，sha 永远对不上——一个烧流量的死循环。
    name: 'sha 不符时不删坏 .part（下一个镜像继续续传它）',
    file: DOWNLINK,
    edits: [
      {
        // 锚点特意带上第二行：单看 `await removeQuietly(partPath)` 会撞上 416 那条
        // 分支里的同款行（本项目在这类「子串命中」上踩过）。
        from: ['      await removeQuietly(partPath)', '      failures.push({'].join('\n'),
        to: '      failures.push({'
      }
    ],
    expect: [
      '坏 .part 也被删掉（留着会让下一个镜像一直续传坏文件）',
      '第二个镜像被请求时坏 .part 已不在磁盘上'
    ]
  },
  {
    // 不发 Range，服务端就回 200 + 全量，代码那侧会截断重写——**功能看着正常**，
    // 只是 340 MB 断一次要从头再来。所以这条只能靠「服务端收到了什么」才看得出来。
    name: '续传不发 Range 头（退化成整份重下）',
    file: DOWNLINK,
    edits: [
      {
        from: '    if (resumeFrom > 0) headers.Range = `bytes=${resumeFrom}-`',
        to: '    if (false) headers.Range = `bytes=${resumeFrom}-`'
      }
    ],
    expect: ['续传时 Range 头正好从断点开始', 'Range 头正好从断点开始']
  },
  {
    // 多镜像回退是这个模块存在的第一个理由（国内下 GitHub Release 是抽奖）。
    // 只试第一个的话，整条回退链路变成装饰。
    name: '镜像只试第一个（多镜像回退失效）',
    file: DOWNLINK,
    edits: [
      {
        from: '  for (let index = 0; index < urls.length; index += 1) {',
        to: '  for (let index = 0; index < 1; index += 1) {'
      }
    ],
    // ⚠️ 期望清单里**故意不写** `回退到第二个镜像` 与 `两个镜像各只试一次（没有反复重试）`：
    // 这两条分别在 `十、pandoc 条目（清单驱动）` 与 `四、sha256 不匹配换镜像` 这两节里，
    // 而「只试第一个镜像」会让这两节**在半路抛异常**——节内更细的断言压根没被执行，
    // 于是它们不出现在红名单里是必然的，不是断言没抓住（实测：本变异翻红 14 条）。
    // 那两节的信息由节级的「整段跑完（未抛异常）」兜住，所以下面收的正是它们。
    expect: [
      '依次尝试了两个镜像',
      '最终命中第二个镜像',
      '命中第二个镜像',
      '每个镜像只试一次',
      '失败原因逐镜像记录',
      '四、sha256 不匹配换镜像 整段跑完（未抛异常）',
      '十、pandoc 条目（清单驱动） 整段跑完（未抛异常）'
    ]
  }
]

/* ------------------------------------------------------- 锚点自检
 * `--anchors-only` 时**只**数锚点命中次数：不跑基线、不跑任何测试、不改任何源码、
 * 不做任何还原、也不碰 git。全过 exit 0，有锚点命不中 exit 1（逐条打印
 * 「脚本 / 变异名 / 命中次数 / 期望次数」）。
 *
 * 存在的理由：原先「命中次数对不对」这道检查排在基线之后，于是锚点被一次重构弄丢时，
 * 脚本报出来的是「有断言没红」——**看着像断言失效，其实是锚点过期**，还白等一整轮。
 * 见 scripts/lib/anchors.mjs 的文件头。
 */
if (process.argv.slice(2).includes('--anchors-only')) {
  const { anchorsOnlyGuard } = await import('./lib/anchors.mjs')
  // 与脚本正文一致：它读盘后过了 `toLf`（见下面的 `originals` / 循环）
  anchorsOnlyGuard(MUTATIONS, { normalizeLf: true })
}

/** `--only=<名字子串>` 只跑命中的变异。基线照样跑（它是对照组，去掉它这轮结论没有意义）。 */
const ONLY = (process.argv.slice(2).find((a) => a.startsWith('--only=')) ?? '').slice(
  '--only='.length
)
const selected = ONLY ? MUTATIONS.filter((m) => m.name.includes(ONLY)) : MUTATIONS
if (ONLY && selected.length === 0) {
  console.error(`--only=${ONLY} 一个变异都没匹配上`)
  process.exit(1)
}

/**
 * 从套件输出里抠出翻红的断言标签。
 *
 * **认末尾的汇总块，不认 `✗` 行**——理由与 `falsify-mcp.mjs` 里那段一样（那里踩过一整轮）：
 * 断言自己打印的那一行可能被「正被测的东西」吃掉，而汇总块是套件跑完之后才打的。
 */
function parseReds(text) {
  const lines = text.split(/\r?\n/)
  const start = lines.lastIndexOf('失败：')
  const summary = []
  if (start >= 0) {
    for (const line of lines.slice(start + 1)) {
      const m = /^\s*-\s*(.+?)\s*$/.exec(line)
      if (!m) break
      summary.push(m[1])
    }
  }
  if (summary.length > 0) return summary
  return lines
    .filter((line) => line.includes('✗'))
    .map((line) =>
      line
        .replace(/.*✗\s*/, '')
        .replace(/\s+←.*$/, '')
        .trim()
    )
}

/** 跑被测套件。通过/失败的分隔符是 `通过 149 / 失败 0`（斜杠）。 */
function runTests() {
  const out = spawnSync(
    'npx',
    ['tsx', '--tsconfig', 'tsconfig.test.json', 'scripts/test-downlink.ts'],
    { encoding: 'utf8', shell: true, maxBuffer: 32 * 1024 * 1024 }
  )
  const text = out.stdout + out.stderr
  const reds = parseReds(text)
  const total = /通过 (\d+) \/ 失败 (\d+)/.exec(text)
  return {
    reds,
    passed: total ? Number(total[1]) : -1,
    failed: total ? Number(total[2]) : -1,
    text
  }
}

/** 锚点一律在 LF 文本上匹配：混进 CRLF 的话跨行锚点会一声不响地命中 0 次 */
const toLf = (s) => s.replace(/\r\n/g, '\n')

const originals = Object.fromEntries(
  [...new Set(MUTATIONS.map((m) => m.file))].map((f) => [f, readFileSync(f, 'utf8')])
)

const scope = ONLY ? `（**只跑了 ${selected.length} / ${MUTATIONS.length} 个变异**）` : ''
console.log(
  ONLY
    ? `只跑 ${selected.length} / ${MUTATIONS.length} 个变异（--only=${ONLY}），基线照样跑一轮…`
    : `${MUTATIONS.length} 个变异，基线跑一轮，每个变异再各跑一轮（每轮不到一分钟，整轮约五分钟）…`
)
const baseline = runTests()
console.log(`基线：通过 ${baseline.passed}，失败 ${baseline.failed}`)
if (baseline.failed !== 0) {
  console.error('基线不是全绿，先修好再来反证。')
  if (baseline.failed < 0) {
    console.error('（连「通过 N / 失败 M」那行都没解析到——多半是套件自己崩了）')
  }
  console.error(baseline.text.slice(-2000))
  process.exit(1)
}

let problems = 0

for (const m of selected) {
  let mutated = toLf(originals[m.file])

  // 逐条 edit 各自查命中次数。**命中次数一定要打出来**：只说「没命中唯一一次」的话，
  // 0 次和 2 次根本分不清（同款缩进的行互为子串，踩过；锚点过期则会让这一轮变成假通过）。
  let bad = ''
  for (const edit of m.edits) {
    const hits = mutated.split(edit.from).length - 1
    console.log(
      `[${m.name}] 锚点命中 ${hits} 次（期望 1 次）：${JSON.stringify(edit.from.slice(0, 40))}`
    )
    if (hits !== 1) {
      bad = '期望 1 次 —— 变异没生效，结论无效（多半是源码重构过，锚点过期了）'
      break
    }
    mutated = mutated.replace(edit.from, edit.to)
  }
  if (bad) {
    console.error(`  ${bad}`)
    problems += 1
    continue
  }

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
    console.log('  有断言没红 —— 它们抓不住这个错误：')
    for (const label of missed) console.log(`    ! ${label}`)
    console.log(`  实际翻红：${result.reds.join(' | ') || '（一条都没红）'}`)
    // 把原始输出尾巴贴出来：光看「一条都没红」分不清「变异是空操作」还是
    // 「套件崩在半路」，而这两种情况的修法完全不同（前者改变异，后者修套件）。
    console.log('  套件输出末尾：' + JSON.stringify(result.text.slice(-400)))
  }
}

// 收尾再确认源码确实还原了。**这一步不能省**：反证中途被打断（Ctrl-C、崩溃）
// 会留下一份改坏的源码，而它跑起来的样子和「改回来过」一模一样。
const dirty = Object.keys(originals).filter((f) => readFileSync(f, 'utf8') !== originals[f])
if (dirty.length > 0) {
  console.error(`\n⚠️ 有源码没还原干净：${dirty.join(', ')}`)
  problems += 1
} else {
  for (const file of Object.keys(originals)) {
    console.log(`  ${createHash('sha256').update(readFileSync(file)).digest('hex')}  ${file}`)
  }
}

console.log(
  problems === 0
    ? `\n反证通过：每个变异都被对应的断言抓住了，且源码已还原。${scope}`
    : `\n反证不通过：${problems} 处有问题。${scope}`
)
process.exit(problems === 0 ? 0 : 1)
