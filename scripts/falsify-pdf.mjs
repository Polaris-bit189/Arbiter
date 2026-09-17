/**
 * printToPDF 那套端到端断言的反证。
 *
 *   node scripts/falsify-pdf.mjs
 *
 * 每轮要真起 Electron 打印一次 PDF，一次约十几秒，所以变异只挑**真正承重**的几处。
 * 带 `diagnostic: true` 的变异不要求翻红——它问的是「这条设计到底有没有用」，
 * 绿灯恰恰是值得记下来的结论。
 *
 * `from` / `to` 允许是数组：有的缺陷要**同时改两处**才能到达（比如「PDF 当纯文本读」
 * 既要去掉 txt/md 的直通车、又要摘掉 `case 'pdf'` 那道护栏）。命中次数是逐个报的——
 * 只说「没命中唯一一次」的话，0 次和 2 次根本分不清，这个坑仓库里踩过一次。
 */
import { spawnSync } from 'child_process'
import { readFileSync, writeFileSync } from 'fs'

const DOC = 'src/main/converters/document.ts'
const HS = 'src/main/converters/htmlSource.ts'
const PT = 'src/main/converters/pdfText.ts'
const PP = 'src/main/converters/pdfPages.ts'

const MUTATIONS = [
  {
    // 锚点原先打在 `document.ts` 的 `wrapHtml(...)` 调用上，只盖得住 markdown 那条装配路径。
    // 2026-09-12 补掉「html 源漏注入 `<base>`」那个洞之后，两条路都收敛到 `baseTagFor`
    // 这一个构造点，于是锚点也跟着收到这里——**一次变异同时盖住两条路**，
    // 而期望清单里的两条断言分别对应 markdown 侧（400x300）和 html 侧（320x240）。
    file: HS,
    name: '不注入 <base>（临时 HTML 解析不到相对路径插图）',
    from: `  if (!baseDir) return ''`,
    to: `  if (!baseDir) return ''\n  return ''`,
    expect: ['带插图那份嵌进了那张 400x300 的图', '相对路径插图真的进了 PDF（320x240）']
  },
  {
    file: DOC,
    name: '把 tiff 也当成 Chromium 认得的格式（跳过 sharp 兜底）',
    from: `const CHROMIUM_IMG = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif', 'bmp', 'svg', 'ico'])`,
    to: `const CHROMIUM_IMG = new Set(['tiff', 'png', 'jpg', 'jpeg', 'webp', 'gif', 'avif', 'bmp', 'svg', 'ico'])`,
    expect: ['tiff 的像素真的进了 PDF（走通了 sharp 转 PNG 那条兜底）']
  },
  {
    file: DOC,
    name: '表格不再横向排版',
    from: `  return {
    landscape: wide,
    marginInch: DEFAULT_MARGIN,`,
    to: `  return {
    landscape: false,
    marginInch: DEFAULT_MARGIN,`,
    expect: ['横向纸张（宽 > 高）']
  },
  {
    file: DOC,
    name: '宽图不再横向排版',
    from: `  const landscape = width > height`,
    to: `  const landscape = false`,
    expect: ['宽图走横向纸张']
  },
  // 这里原本还有一条「只把直通车摘掉」的变异。它已经**测不到东西**了：
  // `case 'pdf'` 的护栏会让那条路直接抛（一次转换失败），观察不到任何行为差异。
  // 能观察到差异的是下面这条**连护栏一起摘掉**的变异，所以只留它。
  {
    // **这条是「负向断言」的反证**：上面那条「直通车摘掉」只走到 `case 'pdf'` 的护栏就被
    // 拦住了，产物是一句「转换失败」，所以「产物里没有 PDF 的二进制特征」在它下面**照样绿**
    // ——只有护栏也一起没了（PDF 真的被当纯文本读）时才见红。所以这里必须同时改两处，
    // 否则那条负向断言就是个装饰。
    file: DOC,
    name: 'PDF 退回「当纯文本读」（直通车 + case pdf 的护栏一起去掉）',
    from: [
      `    if (fromExt === 'pdf' && (toExt === 'txt' || toExt === 'md')) {`,
      `    case 'pdf':
      // 走到这里说明调用方没走上面那条 pdf 直通车。**宁可报错**——这里原来落到
      // default 分支，PDF 二进制被 decodeTextFile 当纯文本读出一屏乱码，
      // 而转换报告成功（约束 12 记的就是这个洞）。
      throw new ConversionFailed([\`PDF 请走文本提取通道：\${input}\`])`
    ],
    to: [
      // 只把条件改成恒假：分支体留着但走不到，于是从 `case 'pdf'` 那条路出去。
      // **必须与上面的 `from` 一样是单行**，否则括号对不上、整套直接编译失败。
      `    if (fromExt === 'pdf' && false) {`,
      `    case 'pdf':
      // MUTATION: 退回「PDF 当纯文本读」
      return textToHtml(decodeTextFile(await readFile(input)))`
    ],
    expect: [
      '产物里没有 PDF 的二进制特征（%PDF- / endobj / xref / obj / %%EOF）',
      '抽出的是正文而不是二进制乱码',
      '中文整句原样抽回，中间没被塞进空格',
      '大标题标成一级'
    ]
  },
  {
    // 只写第 1 页 = 静默丢数据，本项目最忌讳的那一类
    file: PP,
    name: '只光栅化第 1 页（其余页静默丢弃）',
    from: `    for (let n = 1; n <= total; n += 1) {`,
    to: `    for (let n = 1; n <= 1; n += 1) {`,
    expect: ['[png] 每一页都产出了（不是只写第 1 页）', '[jpg] 每一页都产出了（不是只写第 1 页）']
  },
  {
    // 取消 / 失败时的清理。**前置断言**是「取消之前确实渲染过若干页」，
    // 否则「没有残留」在「什么都没来得及写」时同样成立，是个恒真的装饰。
    file: PP,
    name: '取消时不清已写出的页（含 .part）',
    from: [
      `    for (const { temp } of staged) await removeQuietly(temp)`,
      `    for (const final of written) await removeQuietly(final)`
    ],
    to: [`    void staged`, `    void written`],
    expect: ['没有残留的 .part，也没有残留的兄弟页']
  },
  {
    file: PP,
    name: '兄弟名被占用时不再顺延（直接盖掉别人的文件）',
    // γ 之后这条判据抽进了 `siblingTaken()`（里面两条：快照 + existsSync），
    // 所以锚点改锚**调用点**那一行——把整个函数体换掉会把「快照」那条判据
    // 也一起废掉，而那条正是这一支要盯的东西。
    from: '        while (siblingTaken(dir, stem, sibling, toExt, taken)) sibling += 1',
    to: '        // MUTATION: 不探占用',
    expect: ['兄弟名被占用时整体顺延（-2 让给 -3）']
  },
  {
    file: DOC,
    name: 'pdf → png/jpg 的分支摘掉（退回 htmlFragmentOf 那条路）',
    from: `    if (fromExt === 'pdf' && (toExt === 'png' || toExt === 'jpg')) {
      return await renderPdfPages(context)
    }`,
    to: `    if (fromExt === 'pdf' && false) {
      return await renderPdfPages(context)
    }`,
    expect: ['[png] 转换成功', '[jpg] 转换成功']
  },
  {
    file: PT,
    name: '正文基准退回中位数（短文档里标题会把基准带偏）',
    from: `  const body = bodySize(pages.flat())`,
    to: `  const body = (() => {
    const s = pages.flat().map((l) => l.size).filter((x) => x > 0).sort((a, b) => a - b)
    return s.length > 0 ? s[Math.floor(s.length / 2)] : 0
  })()`,
    expect: ['大标题标成一级', '二级标题标成二级']
  },
  {
    // 这条**不要求翻红**：它问的是「动态 import 到底是必需的，还是只是我偏爱它」。
    // 实测结论见下面的 diagnosticNote。
    file: PT,
    name: 'pdfjs 改成同步 require（CJS 里加载 ESM）',
    from: `  cached ??= import('pdfjs-dist/legacy/build/pdf.mjs')`,
    to: `  cached ??= Promise.resolve(require('pdfjs-dist/legacy/build/pdf.mjs'))`,
    expect: [],
    diagnostic: true,
    diagnosticNote:
      '一条都没红：`require()` 一个 .mjs 在 Electron 自带的 Node 上**能跑通**——\n' +
      '      靠的是 Node 22.12+ 的 require(esm)。所以动态 import 不是「不做就崩」的硬约束，\n' +
      '      选它是因为它不依赖这个不算老的特性（换成更旧的 Electron 就会 ERR_REQUIRE_ESM）。'
  },
  {
    file: HS,
    name: '去掉中文字体栈',
    from: `  font-family: "Microsoft YaHei", "微软雅黑", "PingFang SC", "Hiragino Sans GB",
               "Source Han Sans SC", "Noto Sans CJK SC", "Segoe UI", "Helvetica Neue", Arial, sans-serif;`,
    to: `  font-family: serif;`,
    expect: [],
    diagnostic: true,
    diagnosticNote:
      '一条都没红：Windows 上 Chromium 自己会做 CJK 字体回退，这条字体栈\n' +
      '      并不是「不写中文就变方框」那种承重约束（但它仍决定用哪套字形）。'
  }
]

/* ------------------------------------------------------- 锚点自检
 * `--anchors-only` 时**只**数锚点命中次数：不跑基线、不跑任何测试、不改任何源码、
 * 不做任何还原、也不碰 git。全过 exit 0，有锚点命不中 exit 1（逐条打印
 * 「脚本 / 变异名 / 命中次数 / 期望次数」）。
 *
 * 这一支尤其需要：一轮要真起 Electron 打印十几次 PDF。而 `froms` / `tos` 数组那种
 * 形状是「每一段各期望 1 次」——助手按同一个语义数，不会把它改小。
 * 见 scripts/lib/anchors.mjs 的文件头。
 */
if (process.argv.slice(2).includes('--anchors-only')) {
  const { anchorsOnlyGuard } = await import('./lib/anchors.mjs')
  // 这一支没有 `--only`、也没有 `toLf`，锚点一律在原文上数（与正文逐字一致）
  anchorsOnlyGuard(MUTATIONS)
}

function runTests() {
  const out = spawnSync('node', ['scripts/run-pdf-test.mjs'], { encoding: 'utf8', shell: false })
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

const files = [...new Set(MUTATIONS.map((m) => m.file))]
const originals = Object.fromEntries(files.map((f) => [f, readFileSync(f, 'utf8')]))

const baseline = runTests()
console.log(`基线：通过 ${baseline.passed}，失败 ${baseline.failed}`)
if (baseline.failed !== 0) {
  console.error('基线不是全绿，先修好再来反证。')
  console.error(baseline.text.slice(-2000))
  process.exit(1)
}

let problems = 0

for (const m of MUTATIONS) {
  const original = originals[m.file]

  // from / to 允许是数组（同时改多处），但两边长度必须一致
  const froms = Array.isArray(m.from) ? m.from : [m.from]
  const tos = Array.isArray(m.to) ? m.to : [m.to]
  const hits = froms.map((f) => original.split(f).length - 1)

  if (froms.length !== tos.length || hits.some((n) => n !== 1)) {
    console.error(
      `\n[${m.name}] 锚点命中 ${hits.join('/')} 次（每个都期望 1 次），from/to 各 ${froms.length}/${tos.length} 段 —— 变异没生效，结论无效`
    )
    problems += 1
    continue
  }

  let mutated = original
  for (let i = 0; i < froms.length; i += 1) mutated = mutated.replace(froms[i], tos[i])

  writeFileSync(m.file, mutated, 'utf8')
  const result = runTests()
  writeFileSync(m.file, originals[m.file], 'utf8')

  if (m.diagnostic) {
    console.log(`\n[诊断] ${m.name} → 通过 ${result.passed}，失败 ${result.failed}`)
    console.log(
      result.reds.length > 0
        ? `    翻红：${result.reds.join(' | ')}\n    ⇒ 这条设计是承重的，留着。`
        : `    ⇒ ${m.diagnosticNote ?? '一条都没红：这条设计在当前环境下不是承重约束。'}`
    )
    continue
  }

  const missed = m.expect.filter((label) => !result.reds.includes(label))
  if (missed.length === 0) {
    console.log(`\n[${m.name}] 翻红 ${result.reds.length} 条，期望的都在`)
    for (const label of result.reds) console.log(`    - ${label}`)
  } else {
    problems += 1
    console.log(`\n[${m.name}] 有断言没红 —— 它们抓不住这个错误：`)
    for (const label of missed) console.log(`    ! ${label}`)
    console.log(`  实际翻红：${result.reds.join(' | ') || '（一条都没红）'}`)
  }
}

const dirty = files.filter((f) => readFileSync(f, 'utf8') !== originals[f])
if (dirty.length > 0) {
  console.error('\n源码没还原干净：' + dirty.join(', '))
  process.exit(1)
}

console.log(
  problems === 0
    ? '\n反证通过：每个变异都被对应的断言抓住了，且源码已还原。'
    : `\n反证不通过：${problems} 处有问题。`
)
process.exit(problems === 0 ? 0 : 1)
