/**
 * 反证脚本：把被测代码逐个改坏，确认对应的断言真的会翻红。
 *
 *   node scripts/falsify-doc.mjs
 *
 * 为什么值得单独写一个：这个项目已经抓到过三条「永远通过」的装饰性断言
 * （空集合上的 some()、插错分支的补丁、测试自己抛异常把套件崩在半路）。
 * 断言写完不复核一遍，等于没写。
 *
 * 每个变异跑完立刻还原源码；任一变异「零红」即判定该条断言是装饰品，退出码非零。
 */
import { spawnSync } from 'child_process'
import { readFileSync, writeFileSync } from 'fs'

const HS = 'src/main/converters/htmlSource.ts'

/** 每项：改坏哪里、期望翻红的断言（只列必须红的，多红了不算错但要看得见） */
const MUTATIONS = [
  {
    name: 'GB18030 兜底拿掉',
    from: `      return new TextDecoder('gb18030').decode(buffer)`,
    to: `      throw new Error('变异：不兜底')`,
    expect: ['GBK 中文按 GB18030 兜住', 'GBK 末行内容解对了']
  },
  {
    name: 'turndown 不装 gfm 插件',
    from: `    turndown.use(gfm)`,
    to: `    void gfm`,
    expect: ['表格没被丢掉', '数据行在']
  },
  {
    name: '注入样式从 head 挪到文档末尾',
    from: `    const at = head.index + head[0].length
    return html.slice(0, at) + injected + html.slice(at)`,
    to: `    void head
    return html + injected`,
    expect: ['注入在用户样式之前', '注入进 head']
  },
  {
    name: 'baseDir 不转 file:// URL',
    from: `  return \`<base href="\${escapeHtml(pathToFileURL(baseDir + '/').href)}">\``,
    to: `  return \`<base href="\${escapeHtml(baseDir)}">\``,
    expect: ['baseDir 转成 file:// 且编码空格', 'injectBaseStyle 也注入 base']
  },
  {
    // 这条盯的是 html 源的相对路径插图：注入少了 <base> 之后，Chromium 会拿临时目录
    // 去解析 `pic.png`，静默画一个 14x16 的破图占位——PDF 照常生成、转换报成功。
    // test-pdf 的 [6] 在真 Chromium 里盯着同一个洞。
    name: 'injectBaseStyle 不注入 base',
    from: `  const injected = \`\${/<base[\\s/>]/i.test(html) ? '' : baseTagFor(baseDir)}<style>\${BASE_CSS}</style>\``,
    to: `  const injected = \`<style>\${BASE_CSS}</style>\``,
    expect: [
      'injectBaseStyle 也注入 base',
      // 标签要**逐字**抄断言上的那一整句：变异脚本是按 `✗` 后面的全文精确比对的，
      // 截断了会报「有断言没红」，而其实红的是同一条——白查一轮。
      'base 排在用户样式之前（用户在 head 里自己写相对 URL 也吃得到）'
    ]
  },
  {
    name: '数值实体的上界拿掉（回到会抛 RangeError 的写法）',
    from: `      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : whole`,
    to: `      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : whole`,
    expect: ['超界数值实体原样留着，而不是抛 RangeError 把导出搞崩']
  },
  {
    name: 'HTML→文本 不删 script/style 内容',
    from: `    .replace(/<(script|style)[\\s\\S]*?<\\/\\1>/gi, '')`,
    to: `    .replace(/(?!)/g, '')`,
    expect: ['style 内容不混进正文', 'script 内容不混进正文']
  },
  {
    name: 'HTML→文本 不解实体',
    from: `    return ENTITIES[body.toLowerCase()] ?? whole`,
    to: `    return whole`,
    expect: ['命名实体还原']
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
  anchorsOnlyGuard(MUTATIONS, { defaultFile: HS })
}

function runTests() {
  const out = spawnSync('npx', ['tsx', 'scripts/test-doc.ts'], {
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
  const total = /通过 (\d+)，失败 (\d+)/.exec(text)
  return { reds, passed: total ? Number(total[1]) : -1, failed: total ? Number(total[2]) : -1 }
}

const baseline = runTests()
console.log(`基线：通过 ${baseline.passed}，失败 ${baseline.failed}`)
if (baseline.failed !== 0) {
  console.error('基线就不是全绿，先修好再来反证。')
  process.exit(1)
}

const original = readFileSync(HS, 'utf8')
let problems = 0

for (const m of MUTATIONS) {
  const hits = original.split(m.from).length - 1
  if (hits !== 1) {
    console.error(`\n[${m.name}] 锚点命中 ${hits} 次，期望 1 次 —— 变异没生效，结论无效`)
    problems += 1
    continue
  }

  writeFileSync(HS, original.replace(m.from, m.to), 'utf8')
  const result = runTests()
  writeFileSync(HS, original, 'utf8')

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
if (readFileSync(HS, 'utf8') !== original) {
  console.error('\n源码没还原干净，请检查 ' + HS)
  process.exit(1)
}

console.log(
  problems === 0
    ? '\n反证通过：每个变异都被对应的断言抓住了，且源码已还原。'
    : `\n反证不通过：${problems} 处有问题。`
)
process.exit(problems === 0 ? 0 : 1)
