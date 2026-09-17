/**
 * 反证脚本：把 M7「下载 → 解包 → 落盘」的编排逐处改坏，确认对应的断言真的会翻红。
 *
 *   node scripts/falsify-engine-install.mjs
 *
 * 为什么这一块尤其需要反证：**它的失败方式全是「看起来成功了」**。
 * 装完不重置缓存 → 界面永远写「未就绪」，而磁盘上东西是对的；直接往最终目录里解
 * → 中断后留一棵半截但看着完整的树；单飞没了 → 两个 msiexec 写同一个目录，产物
 * 是两半混起来的。没有一条会抛异常，所以断言写完不复核等于没写。
 *
 * ⚠️ **锚点不要用 `String.raw` 写。** 被测代码里满是反引号与 `${…}`，而
 * `String.raw` 里的 `` \` `` 会把反斜杠**留在结果里**（它只是不做「转义解释」，
 * 那个反斜杠本来就是模板语法的一部分），于是锚点永远匹配不上，脚本报「命中 0 次」。
 * 用**普通模板字面量**，里面的 `` \` `` 与 `\${` 才正好对应源码里的那两个字符。
 *
 * 每个变异跑完立刻还原源码；任一变异「零红」即判定该条断言是装饰品，退出码非零。
 */
import { spawnSync } from 'child_process'
import { readFileSync, writeFileSync } from 'fs'

const INSTALL = 'src/main/core/engineInstall.ts'

/**
 * 每项：改坏哪个文件的哪一段、期望翻红的断言（只列必须红的）。
 *
 * 命中次数一定要打印出来。只说「没命中唯一一次」的话，0 次和 2 次根本分不清——
 * 而「锚点命中 2 次」正是这个仓库踩过的坑。
 */
const MUTATIONS = [
  {
    file: INSTALL,
    name: '直接往最终目录里解（不经过 .installing 暂存）',
    from: `  const staging = \`\${target}.installing\``,
    to: `  const staging = target`,
    expect: ['解包时目标目录还是 `.installing`', '解包时最终目录尚未出现']
  },
  {
    file: INSTALL,
    name: '解包失败后不清掉半截的树',
    // 锚点求短：原来锚的是「清树那一行 + throw err」两行连着，而 D1 在它们中间插了
    // 「附诊断日志路径」那一段，于是命中 0 次。改成只锚最近的那一行。
    from: `    await removeTreeQuietly(staging)
    // 把诊断日志的路径附上去。`,
    to: `    // 把诊断日志的路径附上去。`,
    expect: ['半截的 `.installing` 被清掉']
  },
  {
    // ★ 装完不重置缓存。这个 bug 用户可见的表现是「下载成功了，但永远显示未就绪」，
    //   而磁盘上一切正常——只能靠重启应用绕过。
    file: INSTALL,
    name: '★ 装完之后不重置解析器缓存（下载成功了却永远「未就绪」）',
    from: `  resetHeavyCache()
  resetPandocCache()`,
    to: `  void resetHeavyCache
  void resetPandocCache`,
    expect: ['★ 装完之后解析器立刻看得到它（缓存被重置了）']
  },
  {
    file: INSTALL,
    name: '★ 去掉单飞（同一个引擎并发装两次，两个 msiexec 写同一个 TARGETDIR）',
    from: `  const existing = inFlight.get(key)
  if (existing !== undefined) return existing`,
    to: `  const existing = undefined
  if (existing !== undefined) return existing`,
    // 单飞塌了之后的真实失效模式**不是崩溃**：两路都完整跑完（下载两次、解包两次、
    // 各自返回一个不同的 exe 路径），两条 `installEngine` 都**成功地**返回。
    // 这比崩更坏——崩了至少有人知道，而两路写同一个 `TARGETDIR` 是静默的。
    //
    // 所以收的是两条**稳定**红的：`下载也只发生了一次` / `两次调用拿到同一个结果`。
    //
    // ⚠️ **这是一条时序敏感的变异，两类断言都刻意不收进 `expect`：**
    //
    // 1. **「两次并发安装都成功返回」不会红。** 它是一条**对照组**（确认测试的装配
    //    是好的），不是这条变异的守卫。它的措辞「单飞塌了的话会有一路炸掉」
    //    是照着「必崩」那个假设写的，而实测两次都 `fulfilled`。
    // 2. **「解包只跑了一次」时红时不红。** 2026-09-13 连跑两轮：第一轮红、
    //    第二轮没红。原因是那两路的交叠深度取决于磁盘时序——多数时候其中一路
    //    在**下载阶段**就踩了同一个 `.part`，走不到解包。
    //    那次没红**不代表断言没用**：`下载也只发生了一次` 与它盯的是同一件事，
    //    只是观测点更靠前、不受时序影响。
    //
    // 把这两条写进 `expect` 只会换来一轮假红，而假红会诱人去放宽真正的断言——
    // 那比不收更坏。**变异本身仍被抓住**（两条稳定红的断言都在）。
    expect: ['下载也只发生了一次', '两次调用拿到同一个结果']
  },
  {
    // ★ 这条打的是「为了容错把下载失败吞掉」——那段代码看起来很像在做好事，
    //   实际后果是解一个没通过 sha256 的包，把整条链路里最值钱的那道闸拆了。
    file: INSTALL,
    name: '★ 下载失败被吞掉，照样去解包（剥掉 sha256 这道闸的后果）',
    from: `  await ensurePackage(mod, manifest, key, plan, packageDir, transport, report, options.cancel)`,
    to: `  await ensurePackage(mod, manifest, key, plan, packageDir, transport, report, options.cancel).catch(
    () => undefined
  )`,
    expect: ['不去解包（解一个来路不明的包等于把闸拆了）']
  },
  {
    file: INSTALL,
    name: '解包后的产物复核拿掉（7z 条目名拼错时零观测点）',
    from: `    await assertExtracted(entry, staging)`,
    to: `    void assertExtracted`,
    expect: ['没抽到产物要抛（7z 的退出码拦不住这件事）']
  },
  {
    file: INSTALL,
    name: '产物体积不复核',
    from: `  const expected = entry.extract.expectedEntrySizeBytes
  if (expected !== undefined) {`,
    to: `  const expected = entry.extract.expectedEntrySizeBytes
  if (false && expected !== undefined) {`,
    expect: ['体积与清单不符要抛']
  },
  {
    file: INSTALL,
    name: 'zip-entry 换成 `7z x`（保留归档内的目录，落点就不对了）',
    from: `    args: ['e', pkgPath, \`-o\${staging}\`, extract.entryInArchive ?? '', '-y']`,
    to: `    args: ['x', pkgPath, \`-o\${staging}\`, extract.entryInArchive ?? '', '-y']`,
    expect: ['用的是 `7z e`（丢目录），不是 `7z x`']
  },
  {
    file: INSTALL,
    // ⚠️ **这条变异原来是反的**：它把「带内嵌引号」当成正确写法，变异成「去掉引号」，
    // 期望那条「值带引号」的断言翻红——**于是反证把 D1 那个 bug 锁死了**。
    // 真机实测（真实 LibreOffice MSI，只差这一对引号）之后方向反过来：带引号才是致命的。
    name: 'msiexec 的 TARGETDIR 带上内嵌引号（msiexec 会静默挂住，实测）',
    from: '`TARGETDIR=${staging}`',
    to: '`TARGETDIR="${staging}"`',
    // 路径本身没变，所以「目录对不对」那几条分不出来——能抓住它的只有那条
    // 专门断言「值不带内层引号」的。这正是它单独存在的原因。
    expect: ['★★ TARGETDIR 的值不带内层引号（带了 msiexec 会静默挂住，实测）']
  },
  {
    // ★ D6 的正题：扫盘整个不发生。**不改 `sweepStaleStaging` 的内部**——
    // 换掉循环的迭代对象，函数还在、类型还对、调用点还在，只是它一圈都不转。
    // 锚点是 `for (const name of names) {`，与上面那句 `for (const key of inFlight.keys())`
    // 不是同一行，命中次数必须是 1。
    file: INSTALL,
    name: '★ D6：根本不扫残骸（上一次没装完的 1.4 GiB 一直躺在盘上）',
    from: `  for (const name of names) {`,
    to: `  for (const name of [] as string[]) {`,
    expect: [
      '★ 别人的残骸被扫掉了（gamma）',
      '★ 残骸的 `.log` 也一起扫掉（它与暂存目录同级、不在一起）'
    ]
  },
  {
    // ★★ D6 的另一半，而且是**会毁数据的那一半**：扫盘不跳过正在装的引擎。
    // 单飞是按引擎的，LibreOffice 与 Calibre 可以同时在装——扫掉正在解包的那棵树，
    // 产物就是一棵少了半截、却长得很完整的树（与「直接往 target 里解」同一个坑）。
    file: INSTALL,
    name: '★★ D6：扫盘不跳过正在装的引擎（会毁掉另一路正在解包的树）',
    from: `    if (busy.has(owner)) continue`,
    to: `    if (false && busy.has(owner)) continue`,
    expect: ['★★ 正在装的那个引擎的暂存目录**原封不动**（扫掉它 = 产出一棵少半截的树）']
  },
  {
    file: INSTALL,
    name: '清单里没有这个引擎时静默收场',
    from: `  if (entry === null) throw new Error(\`引擎清单里没有「\${key}」，无法下载\`)`,
    to: `  if (entry === null) return { engine: key, exe: '' }`,
    expect: ['清单里没有的引擎要明说，而不是报一个看不懂的下载失败']
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
  // 这一支没有 `--only`、也没有 `toLf`，锚点一律在原文上数（与正文逐字一致）
  anchorsOnlyGuard(MUTATIONS)
}

const TS = 'tsconfig.test.json'

function runTests() {
  const out = spawnSync('npx', ['tsx', '--tsconfig', TS, 'scripts/test-engine-install.ts'], {
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
  const counts = /通过 (\d+) \/ 失败 (\d+)/.exec(text)
  return {
    reds,
    passed: counts ? Number(counts[1]) : -1,
    failed: counts ? Number(counts[2]) : -1
  }
}

const baseline = runTests()
console.log(`基线：通过 ${baseline.passed} / 失败 ${baseline.failed}`)
if (baseline.passed < 0) {
  console.error('没读到测试的汇总行，测试本身可能崩了。先单独跑一次看输出。')
  process.exit(1)
}
if (baseline.failed !== 0) {
  console.error('基线就不是全绿，先修好再来反证。')
  process.exit(1)
}

/** 原文件内容，按路径缓存。跑完据此逐字还原并核对 */
const originals = new Map()
for (const file of new Set(MUTATIONS.map((m) => m.file))) {
  originals.set(file, readFileSync(file, 'utf8'))
}

let problems = 0

for (const m of MUTATIONS) {
  const original = originals.get(m.file)
  const hits = original.split(m.from).length - 1
  if (hits !== 1) {
    console.error(`\n[${m.name}] 锚点命中 ${hits} 次，期望 1 次 —— 变异没生效，结论无效`)
    problems += 1
    continue
  }

  writeFileSync(m.file, original.replace(m.from, m.to), 'utf8')
  const result = runTests()
  writeFileSync(m.file, original, 'utf8')

  const missed = m.expect.filter((label) => !result.reds.includes(label))
  const extra = result.reds.filter((label) => !m.expect.includes(label))

  if (missed.length === 0) {
    console.log(`\n[${m.name}] 翻红 ${result.reds.length} 条，期望的都在`)
    for (const label of result.reds) {
      console.log(`    - ${label}${extra.includes(label) ? '   (顺带)' : ''}`)
    }
  } else {
    problems += 1
    console.log(`\n[${m.name}] 有断言没红 —— 它们抓不住这个错误：`)
    for (const label of missed) console.log(`    ! ${label}`)
    console.log(`  实际翻红：${result.reds.join(' | ') || '（一条都没红）'}`)
  }
}

// 收尾再确认源码确实还原了。**这一步不能省**：反证跑着的时候磁盘上的源码就是坏的，
// 这个窗口期内任何测试结论都不作数，而「还原失败」会静默地把一个坏文件留在工作区里。
for (const [file, original] of originals) {
  if (readFileSync(file, 'utf8') !== original) {
    console.error('\n源码没还原干净，请检查 ' + file)
    process.exit(1)
  }
}

console.log(
  problems === 0
    ? '\n反证通过：每个变异都被对应的断言抓住了，且源码已还原。'
    : `\n反证不通过：${problems} 处有问题。`
)
process.exit(problems === 0 ? 0 : 1)
