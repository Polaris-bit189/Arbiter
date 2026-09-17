/**
 * 文档转换层的自测脚本（不依赖 Electron，直接跑）。
 *
 *   npx tsx scripts/test-doc.ts
 *
 * 盯的是「转换会成功、但结果是错的」这一类毛病——它们不出现在任何错误日志里：
 * 编码猜错整篇变乱码、表格被静默丢掉、注入样式注错了位置（注进 body 里等于没注）。
 * 真正需要 Chromium 才能验的排版与分页另有 scripts/test-pdf.ts。
 */
import { mkdir, rm, writeFile } from 'fs/promises'
import { resolve } from 'path'
import {
  decodeTextFile,
  escapeHtml,
  htmlToMarkdown,
  htmlToText,
  injectBaseStyle,
  markdownToHtml,
  sheetToDelimited,
  sheetToHtml,
  textToHtml,
  wrapHtml
} from '../src/main/converters/htmlSource'
import {
  linesToMarkdown,
  linesToText,
  textlessReason,
  type ExtractedLine
} from '../src/main/converters/pdfText'
import * as XLSX from 'xlsx'

const TMP = resolve('.tmp-test-doc')

let passed = 0
let failed = 0

function check(label: string, ok: boolean, detail?: string): void {
  if (ok) {
    passed += 1
    console.log(`  \u2713 ${label}`)
  } else {
    failed += 1
    console.log(`  \u2717 ${label}${detail ? `  \u2190 ${detail}` : ''}`)
  }
}

/** 手写 GBK 字节。**不能用编码器生成**：拿同一个库编了再解，测不出「解错了」 */
const GBK_CSV = Buffer.from([
  // 姓名,城市,备注
  0xd0, 0xd5, 0xc3, 0xfb, 0x2c, 0xb3, 0xc7, 0xca, 0xd0, 0x2c, 0xb1, 0xb8, 0xd7, 0xa2, 0x0a,
  // 张三,北京,销售部
  0xd5, 0xc5, 0xc8, 0xfd, 0x2c, 0xb1, 0xb1, 0xbe, 0xa9, 0x2c, 0xcf, 0xfa, 0xca, 0xdb, 0xb2, 0xbf,
  0x0a,
  // 李四,上海,研发部
  0xc0, 0xee, 0xcb, 0xc4, 0x2c, 0xc9, 0xcf, 0xba, 0xa3, 0x2c, 0xd1, 0xd0, 0xb7, 0xa2, 0xb2, 0xbf,
  0x0a
])

const UTF8_CSV =
  '\u59d3\u540d,\u57ce\u5e02,\u5907\u6ce8\n\u5f20\u4e09,\u5317\u4eac,\u9500\u552e\u90e8\n\u674e\u56db,\u4e0a\u6d77,\u7814\u53d1\u90e8\n'

// ------------------------------------------------------------------ 编码判定

function testDecode(): void {
  console.log('\n[1] 文本解码')

  check(
    'UTF-8 带 BOM',
    decodeTextFile(Buffer.from('\ufeff\u4e2d\u6587', 'utf8')) === '\u4e2d\u6587'
  )
  const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('中文', 'utf16le')])
  check('UTF-16LE 带 BOM', decodeTextFile(utf16) === '中文', utf16.subarray(0, 2).toString('hex'))
  check('纯 ASCII', decodeTextFile(Buffer.from('hello', 'ascii')) === 'hello')
  check('UTF-8 中文原样', decodeTextFile(Buffer.from(UTF8_CSV, 'utf8')) === UTF8_CSV)

  const gbk = decodeTextFile(GBK_CSV)
  check(
    'GBK 中文按 GB18030 兜住',
    gbk.startsWith('\u59d3\u540d,\u57ce\u5e02'),
    JSON.stringify(gbk.slice(0, 12))
  )
  check('GBK 解出来不是乱码（无替换符）', !gbk.includes('\ufffd'), JSON.stringify(gbk.slice(0, 20)))
  check(
    'GBK 末行内容解对了',
    gbk.trimEnd().split('\n')[2] === '李四,上海,研发部',
    JSON.stringify(gbk.trimEnd().split('\n')[2])
  )
}

// ---------------------------------------------------------------- 基础转义

function testEscape(): void {
  console.log('\n[2] 转义与纯文本')

  check('转义尖括号', escapeHtml('<b>') === '&lt;b&gt;')
  check('转义 & 且不二次转义', escapeHtml('a & b') === 'a &amp; b')
  check('转义引号', escapeHtml(`"'`) === '&quot;&#39;')

  const pre = textToHtml('<script>alert(1)</script>')
  check('文本进 pre 前先转义', pre === '<pre>&lt;script&gt;alert(1)&lt;/script&gt;</pre>')
  check('保留换行与缩进', textToHtml('a\n   b').includes('a\n   b'))
}

// ------------------------------------------------------------------ markdown

async function testMarkdown(): Promise<void> {
  console.log('\n[3] markdown → HTML')

  const md = [
    '# 标题',
    '',
    '中文段落里有 **粗体** 和 `行内代码`。',
    '',
    '| 列 A | 列 B |',
    '| --- | --- |',
    '| 1 | 2 |',
    '',
    '```js',
    'const x = 1',
    '```'
  ].join('\n')

  const html = await markdownToHtml(md)
  check('标题成 h1', html.includes('<h1'))
  check('保留中文', html.includes('中文段落里'))
  check('粗体成 strong', html.includes('<strong>'))
  check('表格成 table', html.includes('<table>'))
  check('代码块带语言类名', /class="language-js"/.test(html))
  check('代码内容被转义', html.includes('const x = 1') && !html.includes('<script'))
}

// ------------------------------------------------------------------- 表格

async function testSheets(): Promise<void> {
  console.log('\n[4] 表格 → HTML')

  await mkdir(TMP, { recursive: true })

  const utf8Path = resolve(TMP, 'utf8.csv')
  await writeFile(utf8Path, UTF8_CSV, 'utf8')
  const utf8Html = await sheetToHtml(utf8Path, 'csv')

  check('UTF-8 CSV 出表头', utf8Html.includes('<th>\u59d3\u540d</th>'))
  check('UTF-8 CSV 出数据行', utf8Html.includes('<td>\u5f20\u4e09</td>'))
  check('首行是 th 不是 td', utf8Html.indexOf('<th>') < utf8Html.indexOf('<td>'))
  check('只有一行表头', utf8Html.split('<thead>').length - 1 === 1)

  const gbkPath = resolve(TMP, 'gbk.csv')
  await writeFile(gbkPath, GBK_CSV)
  const gbkHtml = await sheetToHtml(gbkPath, 'csv')
  check(
    'GBK CSV 经我们这层解码后不乱码',
    gbkHtml.includes('<td>\u674e\u56db</td>'),
    gbkHtml.slice(0, 160)
  )

  const delimited = await sheetToDelimited(gbkPath, 'csv', ',')
  check(
    'sheetToDelimited 复原出原始 CSV',
    delimited.trimEnd() === decodeTextFile(GBK_CSV).trimEnd()
  )

  // 空表不能崩，也不能吐出一个空 <table>
  const emptyPath = resolve(TMP, 'empty.csv')
  await writeFile(emptyPath, '', 'utf8')
  const emptyHtml = await sheetToHtml(emptyPath, 'csv')
  check('空 CSV 不抛异常且没有空 table', !emptyHtml.includes('<table>'), JSON.stringify(emptyHtml))
}

// ------------------------------------------------------- HTML → 文本 / Markdown

function testHtmlToText(): void {
  console.log('\n[5] HTML → 纯文本')

  const html =
    '<html><body><h1>标题</h1><p>第一段</p><p>第二段</p><ul><li>甲</li><li>乙</li></ul></body></html>'
  const out = htmlToText(html)

  check('剥掉所有标签', !out.includes('<'), out)
  check('h1 与 p 之间有换行', out.includes('标题\n'), JSON.stringify(out))
  check('两个段落没粘成一行', out.includes('第一段\n第二段'), JSON.stringify(out))
  check('列表项各自成行', out.includes('甲\n乙'), JSON.stringify(out))

  const styled = htmlToText(
    '<body><style>p{color:red}</style><script>var a=1</script><p>正文</p></body>'
  )
  check('style 内容不混进正文', !styled.includes('color:red'), styled)
  check('script 内容不混进正文', !styled.includes('var a'), styled)
  check('正文还在', styled.includes('正文'), styled)

  const entities = htmlToText('<body><p>a &amp; b &lt;c&gt; &nbsp;d &#20013; &#x6587;</p></body>')
  check('命名实体还原', entities.includes('a & b <c>'), entities)

  // 超界码位不能把整次导出搞崩：`String.fromCodePoint` 对 >U+10FFFF 抛 RangeError，
  // 而 markdown 源里的数值实体是**原样穿过** marked 的（它只转义「看着不像实体」的 `&`），
  // 所以这是用户文档能真实触发的路径，不是理论边界。
  // **异常必须在这里就地接住**：反证脚本把上界拿掉之后，`String.fromCodePoint`
  // 会当场抛 RangeError，异常一路穿出套件、后面几十条断言一条都不跑，
  // 于是那条断言根本不会以 `✗` 的形式出现，变异脚本只会判「期望的断言没红」——
  // 看起来像反证脚本自己坏了。（这个仓库为「失败盖住后续断言」踩过一次。）
  let over: string
  try {
    over = htmlToText('<body><p>&#x110000; 和 &#1114112;</p></body>')
  } catch (error) {
    over = `<<抛异常：${error instanceof Error ? error.message : String(error)}>>`
  }
  check(
    '超界数值实体原样留着，而不是抛 RangeError 把导出搞崩',
    over.includes('&#x110000;') && over.includes('&#1114112;'),
    JSON.stringify(over)
  )
  check('十进制实体还原', entities.includes('\u4e2d'), entities)
  check('十六进制实体还原', entities.includes('\u6587'), entities)
}

function testHtmlToMarkdown(): void {
  console.log('\n[6] HTML → markdown')

  const md = htmlToMarkdown('<h2>标题</h2><p>正文 <em>斜体</em></p>')
  check('标题成 ##', md.startsWith('## 标题'), JSON.stringify(md))
  check('斜体保留', md.includes('*斜体*'), JSON.stringify(md))

  // 这条是 gfm 插件存在的唯一理由：turndown 内置规则里没有表格，
  // 不装插件的话整张表会被静默丢掉、只剩几行挤在一起的字。
  const withTable = htmlToMarkdown(
    '<table><thead><tr><th>列A</th><th>列B</th></tr></thead>' +
      '<tbody><tr><td>1</td><td>2</td></tr></tbody></table>'
  )
  check('表格没被丢掉', withTable.includes('| 列A |'), JSON.stringify(withTable))
  check('表头分隔行在', /\|\s*---\s*\|/.test(withTable), JSON.stringify(withTable))
  check('数据行在', withTable.includes('| 1 | 2 |'), JSON.stringify(withTable))

  // 反证用：没有 gfm 插件时表格确实会没
  const links = htmlToMarkdown('<a href="https://example.com/x">链接</a>')
  check('链接成 []()', links.includes('[链接](https://example.com/x)'), JSON.stringify(links))
}

// ------------------------------------------------------------------ 模板

function testWrap(): void {
  console.log('\n[7] 模板与样式注入')

  const wrapped = wrapHtml('<p>正文</p>', { title: '我的 文档' })
  check('带上 charset', wrapped.includes('<meta charset="utf-8">'))
  check('标题被转义', wrapped.includes('<title>我的 文档</title>'))
  check('注入中文字体栈', wrapped.includes('Microsoft YaHei'))
  check('正文在 body 里', wrapped.includes('<body>\n<p>正文</p>'))
  check('没有 baseDir 时不写 base', !wrapped.includes('<base '))

  const based = wrapHtml('<p>x</p>', { title: 't', baseDir: 'D:\\a b\\docs' })
  check(
    'baseDir 转成 file:// 且编码空格',
    based.includes('<base href="file:///D:/a%20b/docs/">'),
    /<base[^>]*>/.exec(based)?.[0] ?? '没找到 base'
  )

  // 注入位置：必须在 head 里且排在用户样式之前，用户的样式才覆盖得掉我们
  const full = injectBaseStyle(
    '<html><head><style>p{color:red}</style></head><body><p>x</p></body></html>'
  )
  check(
    '注入进 head',
    full.indexOf('Microsoft YaHei') < full.indexOf('</head>'),
    full.slice(0, 160)
  )
  check('注入在用户样式之前', full.indexOf('Microsoft YaHei') < full.indexOf('color:red'))

  // html 源的相对路径插图**只靠这条**：文档是原样返回的完整 HTML，不套我们的模板，
  // 而它同样被写进临时目录再由 Chromium 加载。少了 <base> 就是静默画一个 14x16 的
  // 破图占位——PDF 照常生成、页数照常对、转换报成功（test-pdf 的 [6] 盯着实物）。
  const withBody =
    '<html><head><style>p{color:red}</style></head><body><img src="a.png"></body></html>'
  const basedInject = injectBaseStyle(withBody, 'D:\\a b\\docs')
  check(
    'injectBaseStyle 也注入 base',
    basedInject.includes('<base href="file:///D:/a%20b/docs/">'),
    /<base[^>]*>/.exec(basedInject)?.[0] ?? '没找到 base'
  )
  check(
    'base 排在用户样式之前（用户在 head 里自己写相对 URL 也吃得到）',
    // 前置条件不能省：`indexOf` 找不到时返回 -1，而 -1 比任何下标都小——
    // 少了左边这句，「base 排在样式之前」在 base 根本没注入时**恒为真**。
    basedInject.indexOf('<base') >= 0 &&
      basedInject.indexOf('<base') < basedInject.indexOf('color:red'),
    basedInject.slice(0, 200)
  )
  check('不给 baseDir 时不写 base', !injectBaseStyle(withBody).includes('<base '))

  const ownBase = injectBaseStyle(
    '<html><head><base href="https://example.com/"></head><body>x</body></html>',
    'D:\\a b\\docs'
  )
  check(
    '用户自己写了 base 就不重复注入（一份文档里只有第一个生效）',
    ownBase.includes('https://example.com/') && ownBase.split('<base').length - 1 === 1,
    ownBase.slice(0, 200)
  )

  const noHead = injectBaseStyle('<html><body><p>x</p></body></html>')
  check('没有 head 时补一个', noHead.includes('<head><style>'), noHead.slice(0, 60))
  check('补的 head 在 body 之前', noHead.indexOf('<head>') < noHead.indexOf('<body>'))

  const fragment = injectBaseStyle('<p>片段</p>')
  check('片段被包成完整文档', fragment.includes('<!doctype html>') && fragment.includes('片段'))
  check('片段只注入了一次样式', fragment.split('<style>').length - 1 === 1)
}

// ---------------------------------------------------- PDF 的行 / 段落 / 标题

/** 手写一行抽出来的结果。`gap` 是「与上一行基线的距离」，与 `assembleLines` 同一口径 */
function line(text: string, size: number, gap: number): ExtractedLine {
  return { text, size, gap }
}

/**
 * 输出里**正好有一行**是这段文字。
 *
 * **不能写成 `md.includes('# 标题')`**：标题降级一级时产物是 `## 标题` / `### 标题`，
 * 而它们都包含 `# 标题` 这个子串——于是「一级标题」那条断言在阈值被改错之后
 * **照样是绿的**（写这条断言时实测踩到：把一级的门槛从 1.55 改成 2.0，它一声不吭）。
 */
function hasExactLine(md: string, text: string): boolean {
  return md.split('\n').includes(text)
}

/**
 * `pdf → txt/md` 的纯逻辑部分（行 → 段落 → 标题）。
 *
 * 这一节盯的是「**抽出来的东西对不对**」，而「什么都没抽到」那一半在 `[9]`——
 * 那是这一节的对偶面：这里的函数**没有能力**表达「一个字都没抽到」。
 */
function testPdfLines(): void {
  console.log('\n[8] PDF 抽取的行 / 段落 / 标题')

  // 行距明显大于行高 → 另起一段（PARAGRAPH_GAP 1.6，这里 20 > 10*1.6）
  check(
    '行距大 → 段落之间空一行',
    linesToText([[line('第一段', 10, 0), line('第二段', 10, 20)]]) === '第一段\n\n第二段\n',
    JSON.stringify(linesToText([[line('第一段', 10, 0), line('第二段', 10, 20)]]))
  )
  // 行距接近 → 同一段；**中文之间不补空格**（补了会变成「这 是 中 文」那种散字）
  check(
    '行距近 + 两边都是中文 → 接成一句，不补空格',
    linesToText([[line('这是同一段', 10, 0), line('接着写下去', 10, 12)]]) ===
      '这是同一段接着写下去\n',
    JSON.stringify(linesToText([[line('这是同一段', 10, 0), line('接着写下去', 10, 12)]]))
  )
  // 同一判据的另一侧：英文之间**必须**补空格，否则 HelloWorld
  check(
    '行距近 + 英文 → 补一个空格',
    linesToText([[line('Hello', 10, 0), line('World', 10, 12)]]) === 'Hello World\n',
    JSON.stringify(linesToText([[line('Hello', 10, 0), line('World', 10, 12)]]))
  )
  // 页与页之间同样是段落边界
  check(
    '页与页之间也断开',
    linesToText([[line('第一页', 10, 0)], [line('第二页', 10, 0)]]) === '第一页\n\n第二页\n',
    JSON.stringify(linesToText([[line('第一页', 10, 0)], [line('第二页', 10, 0)]]))
  )

  // 字号用的是**实测**值：Chromium 打印 `<h1>2em + <h2>1.5em + 正文1em` 抽出来是
  // 18.697 / 15.398 / 10.995pt（相对正文 1.70 / 1.40 / 1.00），不是 2.0 / 1.5 / 1.0。
  // 按 em 值设阈值会把两个标题全判错，所以这里照实测值写素材。
  const H1 = 18.697
  const H2 = 15.398
  const BODY = 10.995
  const doc = [
    [line('大标题', H1, 0)],
    [line('正文第一行', BODY, 20), line('正文第二行', BODY, BODY * 1.5)],
    [line('二级标题', H2, 20)],
    [line('正文第三行', BODY, 20)]
  ]
  const md = linesToMarkdown(doc)

  check('大字号段落判成一级标题', hasExactLine(md, '# 大标题'), JSON.stringify(md))
  check('中字号段落判成二级标题', hasExactLine(md, '## 二级标题'), JSON.stringify(md))
  // 正面判据的另一半：正文字号**不能**被当成标题（写成 ratio >= 0 那种「总能命中」的
  // 判据时，这条会红——没有它，上面两条断言在「全都判成标题」时照样绿）
  check('正文字号没有被误判成标题', /^正文第一行正文第二行$/m.test(md), JSON.stringify(md))

  // 正文字号基准取**众数**而不是中位数。这份 4 行素材是专门为这条造的：
  // 字号排序后是 [10.995, 10.995, 13.2, 17.6]，中位数落在 10.995 与 13.2 之间（12.1），
  // 于是 17.6 / 12.1 = 1.45 < 1.55，那个大标题会被判成正文；众数取 10.995 时
  // 它是 1.60，正好过线。两份基准在**长文档**上结论一样，所以素材必须是短的、
  // 标题占比高的那种——实测踩过的就是这个形状。
  const short = [
    [line('唯一的大标题', 17.6, 0)],
    [line('正文一行', BODY, 20)],
    [line('正文二行', BODY, 16)],
    [line('稍大的小标题', 13.2, 20)]
  ]
  const shortMd = linesToMarkdown(short)
  check(
    '短文档里的大标题仍然判得出来（正文基准取众数，不是中位数）',
    hasExactLine(shortMd, '# 唯一的大标题'),
    JSON.stringify(shortMd)
  )

  // `linesToText` 对「一页都没有的行」也**照样吐一个非空的换行**——这正是
  // `textlessReason` 必须存在的原因：调用方无法从这个返回值里看出「什么都没抽到」。
  // 反证：把它的 `+ '\n'` 去掉，这条就红。
  check(
    '空输入喂进 linesToText 会得到「看着像有内容」的一个换行（所以判空不能靠它）',
    linesToText([[]]) === '\n',
    JSON.stringify(linesToText([[]]))
  )
}

/**
 * 「一页文本都没抽到」的判据。
 *
 * 这是**扫描件那个静默洞的哨兵**：空产物与「转换成功」在调用方眼里完全同形，
 * 所以判空这件事必须由生产文本的这一层显式回答，而不是留给调用方去猜。
 */
function testTextless(): void {
  console.log('\n[9] 一个字都没抽到的 PDF 必须被认出来')

  const empty = textlessReason([[]])
  check('单页无文本 → 认出来', empty !== null)
  const three = textlessReason([[], [], []])
  check(
    '三页全无文本 → 认出来，且说明页数',
    three !== null && three.join('\n').includes('3 页'),
    JSON.stringify(three)
  )

  // **两条方向都要断**：只断「空 → 报警」的话，一个恒为真的实现（永远返回错误）
  // 也能通过，而那种实现会把所有正常的 PDF 都废掉。
  check('有文本 → 放行（不能一律报警）', textlessReason([[line('正文', 10, 0)]]) === null)
  check(
    '只有空白行的页 → 也算没抽到（判据按字符数，不是按行数）',
    textlessReason([[line('   ', 10, 0), line('\t', 10, 12)]]) !== null
  )
  check('同一份文档里只要有字就不算空', textlessReason([[], [line('第二页有字', 10, 0)]]) === null)

  // 诊断要**说出来**才有用：只说「没有文本层」而不说这是扫描件、不说没有 OCR，
  // 用户只会以为是我们没实现。反证：把 'OCR' 那句删掉，这条红。
  const text = (empty ?? []).join('\n')
  check('诊断里点明「扫描件 / 图片型」这条路', text.includes('扫描件'))
  check('诊断里点明本项目没有 OCR', text.includes('OCR'))
}

// ------------------------------------------------------------ xlsx 依赖版本

/**
 * ⚠️ 这一节守的是一件**现有测试网抓不住**的事：`xlsx` 被悄悄换回旧版。
 *
 * 实测过：`xlsx@0.18.5` 与 `0.20.3` 在本项目用到的那几个 API 上**输出逐字节相同**
 * ——上面 `testSheets` 那一节全是**行为**断言，而两版行为一样，所以在 0.18.5 下
 * 它们**照样全绿**。可 0.18.5 恰好带着两个已公开的漏洞：
 *
 *   - **CVE-2023-30533**（原型污染）—— 修在 0.19.3
 *   - **CVE-2024-22363**（ReDoS）—— 修在 0.20.2
 *
 * 而本项目是在**主进程**里拿它解析**用户提供的** `.xlsx` / `.xls`，两个都在路径上，
 * 所以升到 0.20.3 的**全部理由**就是修它们。⇒ 判据只能落在**版本号**上：
 * 行为那一侧无论怎么测都分不出这两版。
 *
 * 「怎么装进来的」是 vendor tarball 而不是 URL 依赖，理由见 `vendor/README.md`。
 */
function testXlsxVersion(): void {
  console.log('\n[10] xlsx 依赖版本')

  const version = String((XLSX as unknown as { version?: unknown }).version ?? '')

  // 非空前置：下面两条都要拿它去比，解析不出来时它们会**静默变成空转**——
  // 一条在空集合上恒真的断言，看起来和「一切正常」一模一样。
  const parsed = /^(\d+)\.(\d+)\.(\d+)/.exec(version)
  check('xlsx 报得出一个三段版本号', parsed !== null, `version=${JSON.stringify(version)}`)
  if (parsed === null) return

  const [major, minor, patch] = [Number(parsed[1]), Number(parsed[2]), Number(parsed[3])]
  const atLeast = (a: number, b: number, c: number): boolean =>
    major !== a ? major > a : minor !== b ? minor > b : patch >= c

  // 门槛取两条修复线里**较晚**的那条（0.20.2）。写成「不低于」而不是「等于 0.20.3」，
  // 是为了将来升到 0.21 时这条不用改——否则它会变成每次升级都要手动放宽的绊脚石，
  // 而那种断言的下场通常是被删掉。
  check(
    'xlsx ≥ 0.20.2（CVE-2023-30533 修在 0.19.3、CVE-2024-22363 修在 0.20.2）',
    atLeast(0, 20, 2),
    `实际 ${version}`
  )

  // 守的是**另一件事**：依赖形态被改坏（vendor 路径写错、`exports` 解析变了、
  // tarball 被换掉）导致 `htmlSource.ts` 静默降级那一类。上面 `testSheets` 是走真转换的，
  // 这条把「包本身还完整」单独钉住——红了能一眼分清是依赖没了，而不是逻辑写错了。
  const utils = (XLSX as unknown as { utils?: Record<string, unknown> }).utils ?? {}
  check(
    'utils.sheet_to_csv / sheet_to_json 都还在',
    typeof utils.sheet_to_csv === 'function' && typeof utils.sheet_to_json === 'function'
  )
}

// -------------------------------------------------------------------- main

async function main(): Promise<void> {
  await rm(TMP, { recursive: true, force: true })
  try {
    testDecode()
    testEscape()
    await testMarkdown()
    await testSheets()
    testHtmlToText()
    testHtmlToMarkdown()
    testWrap()
    testPdfLines()
    testTextless()
    testXlsxVersion()
  } finally {
    await rm(TMP, { recursive: true, force: true }).catch(() => undefined)
  }

  console.log(`\n通过 ${passed}，失败 ${failed}`)
  if (failed > 0) process.exitCode = 1
}

void main()
