/**
 * 反证脚本：把 pandoc 适配器逐个改坏，确认对应的断言真的会翻红。
 *
 *   node scripts/falsify-pandoc.mjs
 *
 * 断言写完不复核一遍，等于没写——这个项目已经抓到过四条「永远通过」的装饰性断言。
 * 每条变异都要求命中锚点**恰好一次**（命中 0 次或 2 次都说明变异没生效，结论无效），
 * 跑完立刻还原源码，最后再校验一次确实还原干净了。
 *
 * 只列「必须红」的断言；多红了不算错，但要打印出来看得见。
 */
import { spawnSync } from 'child_process'
import { readFileSync, writeFileSync } from 'fs'

/**
 * 大多数变异打在适配器上；涉及 rst 文本出口的那几条在 document.ts——
 * 那些出口不走适配器，但解析同样靠 pandoc，测试也就在同一个套件里。
 */
const ADAPTER = 'src/main/converters/pandoc.ts'
const RUN = 'src/main/converters/pandocRun.ts'
const DOCUMENT = 'src/main/converters/document.ts'

const MUTATIONS = [
  {
    file: RUN,
    name: '完全不带 --resource-path（相对路径插图失去解析基准）',
    from: `  return ['--resource-path', sourceDir, '--syntax-highlighting', 'none']`,
    to: `  return ['--syntax-highlighting', 'none']`,
    expect: ['带插图那份真的把图画进去了']
  },
  {
    file: RUN,
    name: '.txt 不再映射成 markdown reader',
    from: `  txt: 'markdown',`,
    to: `  txt: 'txt',`,
    expect: ['txt → docx 转换成功', 'txt → docx 内容在']
  },
  {
    file: RUN,
    name: '编码归一失效（GBK 输入直接喂给 pandoc）',
    from: `  if (buffer.equals(Buffer.from(text, 'utf8'))) return input`,
    to: `  if (text.length >= 0) return input`,
    expect: ['GBK 中文没有变成乱码', 'GBK 版产物与 UTF-8 版完全一致']
  },
  {
    file: RUN,
    name: '取消时不再杀进程（只置标志位）',
    from: `    cancel.onCancel(() => {
      void killTree(child.pid)
    })`,
    to: `    cancel.onCancel(() => {
      void child.pid
    })`,
    expect: ['取消显著快于完整转换（说明进程被杀了，不是等它跑完）']
  },
  {
    name: '临时输出名丢掉扩展名（约束 8）',
    from: `  const tempOut = partPathOf(output)`,
    to: '  const tempOut = `${output}.part`',
    expect: ['是合法 docx（含 word/document.xml）']
  },
  {
    file: DOCUMENT,
    name: 'rst 退回「原样当纯文本渲染」的降级实现',
    from: `    case 'rst':
      return await rstToHtmlFragment(input, cancel)`,
    to: `    case 'rst':
      return textToHtml(decodeTextFile(await readFile(input)))`,
    expect: ['RST 标题被解析成 <h1>', '产物里没有 RST 的标题下划线']
  },
  {
    file: DOCUMENT,
    name: 'rst 路径不做编码归一（GBK 直接喂给 pandoc）',
    from: `    const srcPath = await normalizeEncoding(input, 'rst', tempDir)`,
    to: `    const srcPath = input`,
    expect: ['GBK 的 rst 解出来不是乱码']
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
  // 与脚本正文一致：没写 file 的变异落在 ADAPTER 上（那里写的是 `m.file ?? ADAPTER`）
  anchorsOnlyGuard(MUTATIONS, { defaultFile: ADAPTER })
}

function runTests() {
  const out = spawnSync(
    'npx',
    ['tsx', '--tsconfig', 'tsconfig.test.json', 'scripts/test-pandoc.ts'],
    {
      encoding: 'utf8',
      shell: true
    }
  )
  const text = (out.stdout ?? '') + (out.stderr ?? '')
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
  return { reds, passed: total ? Number(total[1]) : -1, failed: total ? Number(total[2]) : -1 }
}

const baseline = runTests()
console.log(`基线：通过 ${baseline.passed}，失败 ${baseline.failed}`)
if (baseline.failed !== 0 || baseline.passed < 0) {
  console.error('基线就不是全绿，先修好再来反证。')
  process.exit(1)
}

/** 每个被动过的文件都留一份原文，跑完逐字比对，确认还原干净 */
const originals = new Map()
const originalOf = (file) => {
  if (!originals.has(file)) originals.set(file, readFileSync(file, 'utf8'))
  return originals.get(file)
}

let problems = 0

for (const m of MUTATIONS) {
  const file = m.file ?? ADAPTER
  const original = originalOf(file)
  const hits = original.split(m.from).length - 1
  if (hits !== 1) {
    console.error(`\n[${m.name}] 锚点命中 ${hits} 次，期望 1 次 —— 变异没生效，结论无效`)
    problems += 1
    continue
  }

  writeFileSync(file, original.replace(m.from, m.to), 'utf8')
  const result = runTests()
  writeFileSync(file, original, 'utf8')

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

// 收尾再确认源码确实还原了
for (const [file, text] of originals) {
  if (readFileSync(file, 'utf8') !== text) {
    console.error(`\n源码没还原干净，请检查 ${file}`)
    process.exit(1)
  }
}

console.log(
  problems === 0
    ? '\n反证通过：每个变异都被对应的断言抓住了，且源码已还原。'
    : `\n反证不通过：${problems} 处有问题。`
)
process.exit(problems === 0 ? 0 : 1)
