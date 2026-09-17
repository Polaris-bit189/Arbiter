/**
 * printToPDF 的端到端自测（**必须跑在 Electron 里**，不能用 tsx 直接跑）。
 *
 *   node scripts/run-pdf-test.mjs
 *
 * 纯逻辑那层由 scripts/test-doc.ts 盯着；这里只验那些**离开真 Chromium 就没法知道**的事：
 *
 *   1. 隐藏窗口 + `javascript: false` 下 printToPDF 到底跑不跑得起来
 *   2. 临时目录里的 HTML 靠 `<base href>` 能不能读到源文件旁边的相对路径插图
 *   3. 中文有没有真的被嵌进 PDF（Chromium 缺字时的表现是「转换成功、页面空白」）
 *   4. 横向纸张、多页分页这些排版参数有没有生效
 *
 * 第 2 条用的是**差分断言**：同样的 markdown，一份带插图一份不带，然后比两边到底
 * 嵌没嵌进真正的位图。单看一份「有没有图片」容易自欺——Chromium 在图片加载失败时会画
 * 一个占位图形，同样产出一页看着正常的内容。
 */
// 路径环境（userData / appPath / resourcesPath），必须是第一个 import——见那个文件
import './install-test-paths'
import { app } from 'electron'
import { existsSync, readFileSync, readdirSync } from 'fs'
import { mkdir, readFile, rm, writeFile } from 'fs/promises'
import { stat } from 'fs/promises'
import { basename, dirname, extname, join, resolve } from 'path'
import type { TaskProgress } from '../src/shared/types'
import { PDFDocument } from 'pdf-lib'
import sharp from 'sharp'
import { runDocument } from '../src/main/converters/document'
import { CancelToken } from '../src/main/core/cancel'

const ROOT = resolve('.tmp-test-pdf')
/** 源文件放这儿，和临时 HTML 的目录**故意错开**，这样 base 有没有生效一试便知 */
const SRC = join(ROOT, 'src')
const OUT = join(ROOT, 'out')

let passed = 0
let failed = 0

function check(label: string, ok: boolean, detail?: string): void {
  if (ok) {
    passed += 1
    console.log(`  ✓ ${label}`)
  } else {
    failed += 1
    console.log(`  ✗ ${label}${detail ? `  ← ${detail}` : ''}`)
  }
}

async function convert(input: string, fromExt: string, toExt: string): Promise<string> {
  const output = join(OUT, `${Date.now()}-${Math.round(performance.now() * 1000)}.${toExt}`)
  await runDocument({
    input,
    output,
    fromExt,
    toExt,
    cancel: new CancelToken(),
    onProgress: () => undefined
  })
  return output
}

/**
 * 转换并读回文本；**转换抛错时不上抛**，而是返回一个显眼的标记串。
 *
 * 反证时最需要的就是「这条挂了」而不是「套件提前结束」：抛出去会被 main 的兜底 catch
 * 接住，后面的场景一条都不跑，看起来像测试自己出了问题。这类「失败盖住后续断言」的坑
 * 这个项目踩过一次，别再来一次。
 */
async function convertedText(input: string, fromExt: string, toExt: string): Promise<string> {
  try {
    return await readFile(await convert(input, fromExt, toExt), 'utf8')
  } catch (error) {
    return `<<转换失败：${error instanceof Error ? error.message : String(error)}>>`
  }
}

interface PdfFacts {
  bytes: number
  header: string
  pages: number
  firstPage: { width: number; height: number }
  /** 原始字节里出现过的标记，用来判断字体到底进没进去 */
  markers: Set<string>
  /**
   * 嵌进 PDF 的位图尺寸（`宽x高`）。空数组 = 这一页里一张真正的位图都没有。
   *
   * 这是判断「插图有没有加载进来」唯一可靠的依据。**不能用 `/Image` 之类的子串去猜**：
   * Chromium 的每一页都会写 `/ProcSet [/PDF /Text /ImageB /ImageC /ImageI]`，
   * 里面那个 `/Image` 是 `/ImageB` 的前缀，于是任何文本 PDF 都会被误判成有图。
   * （这条是实测踩出来的。）
   */
  imageSizes: string[]
}

/**
 * 直接翻原始字节找标记。
 *
 * Chromium 的 PDF 只压缩内容流，**对象字典是不压的**，所以 `/Subtype /Image`、
 * `/Type0` 这些一定会以明文出现，不必解压。
 *
 * 这里刻意不列 `/Image`：它会在 ProcSet 里被误命中，见 PdfFacts.imageSizes 的注释。
 */
const MARKERS = ['/Subtype /Image', '/Type0', '/Identity-H', '/FontFile2', '/FontFile3']

/** 位图对象的尺寸。Chromium 写成 `/Subtype /Image /Width 400 /Height 300` */
const IMAGE_SIZE_RE = /\/Subtype \/Image\s*\/Width (\d+)\s*\/Height (\d+)/g

async function inspect(path: string): Promise<PdfFacts> {
  const raw = await readFile(path)
  const text = raw.toString('latin1')
  const doc = await PDFDocument.load(raw, { updateMetadata: false })
  const first = doc.getPage(0).getSize()

  const markers = new Set<string>()
  for (const m of MARKERS) if (text.includes(m)) markers.add(m)

  const imageSizes = [...text.matchAll(IMAGE_SIZE_RE)].map((m) => `${m[1]}x${m[2]}`)

  return {
    bytes: raw.length,
    header: text.slice(0, 5),
    pages: doc.getPageCount(),
    firstPage: { width: first.width, height: first.height },
    markers,
    imageSizes
  }
}

function markerText(facts: PdfFacts): string {
  return [...facts.markers].join(' ') || '（没有任何标记）'
}

// -------------------------------------------------------------------- 场景

async function testTextToPdf(): Promise<void> {
  console.log('\n[1] markdown → pdf（含中文）')

  const mdPath = join(SRC, 'zh.md')
  await writeFile(
    mdPath,
    [
      '# 中文标题',
      '',
      '这是一段中文正文，用来验证中文字形有没有真的被嵌进 PDF。',
      '如果字体栈没生效，Chromium 会渲染成一排方框，而转换本身照样「成功」。',
      '',
      '## 二级标题',
      '',
      '- 列表项一',
      '- 列表项二'
    ].join('\n'),
    'utf8'
  )

  const out = await convert(mdPath, 'md', 'pdf')
  const facts = await inspect(out)

  check('产物存在且非空', facts.bytes > 1000, `${facts.bytes} 字节`)
  check('是合法 PDF', facts.header === '%PDF-', facts.header)
  check('只有一页', facts.pages === 1, `${facts.pages} 页`)
  check('竖向 A4', facts.firstPage.height > facts.firstPage.width, JSON.stringify(facts.firstPage))
  check(
    '中文用了复合字体（/Type0 + Identity-H）',
    facts.markers.has('/Type0') && facts.markers.has('/Identity-H'),
    markerText(facts)
  )
  check(
    '字体被内嵌而不是引用系统字体',
    facts.markers.has('/FontFile2') || facts.markers.has('/FontFile3'),
    markerText(facts)
  )
}

async function testRelativeImage(): Promise<void> {
  console.log('\n[2] markdown 里的相对路径插图（base 差分）')

  await sharp({
    create: { width: 400, height: 300, channels: 3, background: { r: 220, g: 40, b: 60 } }
  })
    .png()
    .toFile(join(SRC, 'pic.png'))

  const withImg = join(SRC, 'with-image.md')
  await writeFile(withImg, '# 带插图\n\n![红块](pic.png)\n', 'utf8')

  // 对照组：除了没有 ![]() 之外一模一样。两份都渲染，只比较 image XObject 的有无
  const noImg = join(SRC, 'no-image.md')
  await writeFile(noImg, '# 带插图\n\n红块\n', 'utf8')

  const a = await inspect(await convert(withImg, 'md', 'pdf'))
  const b = await inspect(await convert(noImg, 'md', 'pdf'))

  // 直接比位图尺寸：源图就是 400x300，PDF 里出现同样尺寸的位图对象，
  // 说明 base 真的把「临时目录里的 HTML」引到了「源文件旁边的那张图」。
  check(
    '带插图那份嵌进了那张 400x300 的图',
    a.imageSizes.includes('400x300'),
    a.imageSizes.join(',') || '（没有任何位图）'
  )
  check(
    '对照组一张位图都没有（证明上一条不是恒真）',
    b.imageSizes.length === 0,
    b.imageSizes.join(',')
  )
}

async function testMultiPage(): Promise<void> {
  console.log('\n[3] 分页')

  const body = Array.from(
    { length: 120 },
    (_, i) => `## 第 ${i + 1} 节\n\n这是第 ${i + 1} 节的正文，用来把文档撑到多页。\n`
  ).join('\n')

  const out = await convert(await writeMd('long.md', body), 'md', 'pdf')
  const facts = await inspect(out)

  check('确实分了多页', facts.pages > 1, `${facts.pages} 页`)
  check('每页尺寸一致（A4 竖向）', facts.firstPage.height > facts.firstPage.width)
}

async function writeMd(name: string, body: string): Promise<string> {
  const p = join(SRC, name)
  await writeFile(p, body, 'utf8')
  return p
}

async function testSpreadsheet(): Promise<void> {
  console.log('\n[4] csv → pdf（横向纸张）')

  const rows = ['姓名,城市,部门,工号,入职日期,备注']
  for (let i = 0; i < 30; i += 1) {
    rows.push(`员工${i},城市${i},部门${i},E${1000 + i},2024-01-01,备注${i}`)
  }
  const csvPath = join(SRC, 'sheet.csv')
  await writeFile(csvPath, rows.join('\n') + '\n', 'utf8')

  const facts = await inspect(await convert(csvPath, 'csv', 'pdf'))
  check('产物是合法 PDF', facts.header === '%PDF-', facts.header)
  check(
    '横向纸张（宽 > 高）',
    facts.firstPage.width > facts.firstPage.height,
    JSON.stringify(facts.firstPage)
  )
}

async function testImageToPdf(): Promise<void> {
  console.log('\n[5] 图片 → pdf')

  const wide = join(SRC, 'wide.png')
  await sharp({
    create: { width: 1200, height: 400, channels: 3, background: { r: 20, g: 120, b: 220 } }
  })
    .png()
    .toFile(wide)

  const fromPng = await inspect(await convert(wide, 'png', 'pdf'))
  check('png → pdf 成功', fromPng.header === '%PDF-' && fromPng.pages === 1, `${fromPng.pages} 页`)
  check(
    '宽图走横向纸张',
    fromPng.firstPage.width > fromPng.firstPage.height,
    JSON.stringify(fromPng.firstPage)
  )
  check(
    '图片被嵌进去（尺寸与源一致）',
    fromPng.imageSizes.includes('1200x400'),
    fromPng.imageSizes.join(',') || '（没有任何位图）'
  )

  // tiff 在 CHROMIUM_IMG 白名单之外，会先经 sharp 转 PNG 再交给 Chromium。
  // 这条就是验证那条兜底路径真的走通了——走不通的话 Chromium 会画一个破图，
  // 而 PDF 照样生成、页数照样是 1。
  const tiff = join(SRC, 'pic.tiff')
  await sharp(wide).tiff().toFile(tiff)
  const fromTiff = await inspect(await convert(tiff, 'tiff', 'pdf'))
  check('tiff → pdf 成功', fromTiff.header === '%PDF-', fromTiff.header)
  check(
    'tiff 的像素真的进了 PDF（走通了 sharp 转 PNG 那条兜底）',
    fromTiff.imageSizes.includes('1200x400'),
    fromTiff.imageSizes.join(',') || '（没有任何位图）'
  )
}

async function testHtmlPassthrough(): Promise<void> {
  console.log('\n[6] html → pdf（保留用户自己的样式 + 相对路径插图）')

  const htmlPath = join(SRC, 'styled.html')
  await writeFile(
    htmlPath,
    '<!doctype html><html><head><style>body{font-size:20pt}h1{color:#c00}</style></head>' +
      '<body><h1>红色大标题</h1><p>正文</p></body></html>',
    'utf8'
  )

  const facts = await inspect(await convert(htmlPath, 'html', 'pdf'))
  check('html → pdf 成功', facts.header === '%PDF-' && facts.pages === 1)
  check('中文进了 PDF', facts.markers.has('/Type0'), markerText(facts))

  // 相对路径插图。这条与 [2] 的 markdown 差分同源，但**走的是另一条装配路径**：
  // html 源由 `injectBaseStyle` 处理（用户文档原样保留），markdown 源走 `wrapHtml`。
  // 两份 HTML 都落在临时目录里，`<img src="htmlpic.png">` 只能靠 `<base href>` 引回
  // 源文件旁边——少了它就是静默画一个破图占位，而 PDF 照常生成、页数照常是 1。
  await sharp({
    create: { width: 320, height: 240, channels: 3, background: { r: 30, g: 160, b: 90 } }
  })
    .png()
    .toFile(join(SRC, 'htmlpic.png'))

  const withImg = join(SRC, 'styled-img.html')
  await writeFile(
    withImg,
    '<!doctype html><html><head><style>body{font-size:20pt}</style></head>' +
      '<body><h1>带插图</h1><img src="htmlpic.png"></body></html>',
    'utf8'
  )

  // 对照组就是上面那份 styled.html（除插图外结构一样），
  // 有它才证明「嵌进了 320x240」不是一条恒真的断言。
  const imgFacts = await inspect(await convert(withImg, 'html', 'pdf'))
  check(
    '相对路径插图真的进了 PDF（320x240）',
    imgFacts.imageSizes.includes('320x240'),
    imgFacts.imageSizes.join(',') || '（没有任何位图）'
  )
  check(
    '对照组一张位图都没有（证明上一条不是恒真）',
    facts.imageSizes.length === 0,
    facts.imageSizes.join(',')
  )
}

async function testTextAndMdExports(): Promise<void> {
  console.log('\n[7] 顺带验一下同引擎的非 pdf 出口')

  const mdPath = join(SRC, 'export.md')
  await writeFile(
    mdPath,
    '# 标题\n\n正文**加粗**\n\n| 列A | 列B |\n| --- | --- |\n| 1 | 2 |\n',
    'utf8'
  )

  const htmlOut = await convert(mdPath, 'md', 'html')
  const html = await readFile(htmlOut, 'utf8')
  check('md → html 出完整文档', html.includes('<!doctype html>'))
  check('md → html 注入中文字体栈', html.includes('Microsoft YaHei'))
  check('md → html 保留表格', html.includes('<table>'))

  const mdOut = await convert(mdPath, 'md', 'html')
  void mdOut

  const txtOut = await convert(htmlOut, 'html', 'txt')
  const txt = await readFile(txtOut, 'utf8')
  check('html → txt 剥掉标签', !txt.includes('<h1'), JSON.stringify(txt.slice(0, 80)))
  check('html → txt 保住中文', txt.includes('标题'), JSON.stringify(txt.slice(0, 80)))

  const csvOut = await convert(join(SRC, 'sheet.csv'), 'csv', 'csv')
  const csv = await readFile(csvOut, 'utf8')
  check('csv → csv 带 UTF-8 BOM（Excel 读中文才不乱码）', csv.charCodeAt(0) === 0xfeff)
  check('csv → csv 内容还在', csv.includes('员工0'), JSON.stringify(csv.slice(0, 40)))

  const size = (await stat(csvOut)).size
  check('csv → csv 真的落了盘', size > 100, `${size} 字节`)
}

/**
 * `pdf → txt/md`：把文本从 PDF 里抽回来。
 *
 * 这是一条**往返**测试，但它不是「自己验自己」——写那一侧是 Chromium 的 printToPDF，
 * 读这一侧是 pdfjs 的内容流解析，两个完全不同的实现，中间隔着一份真实的 PDF 字节。
 * 中文尤其要这么测：Chromium 把中文写成 Identity-H 编码的字体子集，全靠 ToUnicode
 * CMap 才映射得回 Unicode，这条链路断了就会抽出一屏乱码而**不报任何错**。
 */
async function testPdfTextExport(): Promise<void> {
  console.log('\n[8] pdf → txt/md（抽回中文与标题）')

  const mdPath = join(SRC, 'roundtrip.md')
  await writeFile(
    mdPath,
    [
      '# 季度汇报',
      '',
      '这是一段中文正文，用来验证文本能不能从 PDF 里原样抽回来。',
      '',
      '## 数据小节',
      '',
      'The quick brown fox jumps over the lazy dog.'
    ].join('\n'),
    'utf8'
  )

  const pdf = await convert(mdPath, 'md', 'pdf')

  const txt = await convertedText(pdf, 'pdf', 'txt')
  console.log(`    抽出来的文本：${JSON.stringify(txt)}`)

  check(
    '中文整句原样抽回，中间没被塞进空格',
    txt.includes('这是一段中文正文，用来验证文本能不能从 PDF 里原样抽回来。'),
    JSON.stringify(txt.slice(0, 100))
  )
  check('标题文字也在', txt.includes('季度汇报'), JSON.stringify(txt.slice(0, 40)))
  check(
    '英文单词之间的空格保住了',
    /The quick brown fox jumps/.test(txt),
    JSON.stringify(txt.slice(-120))
  )

  // 旧实现（PDF 落到 htmlFragmentOf 的 default 分支）会把 PDF 二进制当纯文本解出来，
  // 产物是一屏长度与文件体积同量级的乱码，而转换报告成功。
  // **不能用「含不含 U+FFFD」去判**：那条兜底是 GB18030，几乎任何字节都能解成合法汉字，
  // 替换字符一个都不会有——这条断言会恒真。长度才是能真正分开两者的判据。
  check('抽出的是正文而不是二进制乱码', txt.length > 50 && txt.length < 1000, `${txt.length} 字符`)

  // 负向断言：产物里**不能**有 PDF 的二进制特征。
  // 旧实现（pdf 落到 htmlFragmentOf 的 default 分支）会把 PDF 二进制当纯文本解出来，
  // 而 `%PDF-` / `endobj` / `xref` / `%%EOF` 全是 ASCII——GB18030 兜底会原样保留它们，
  // 所以这几个标记真能分开「抽出了正文」和「读了一坨二进制」。
  // **前置条件是 length > 0**：不然「不应包含 X」在空产物上恒为真，正是这个仓库踩过的坑。
  const BINARY_MARKERS = /%PDF-|endobj|xref|\d+ \d+ obj|%%EOF/
  check(
    '产物里没有 PDF 的二进制特征（%PDF- / endobj / xref / obj / %%EOF）',
    txt.length > 0 && !BINARY_MARKERS.test(txt),
    `长度 ${txt.length}，命中 ${JSON.stringify(txt.match(BINARY_MARKERS)?.[0] ?? null)}`
  )

  const md = await convertedText(pdf, 'pdf', 'md')
  console.log(`    抽出来的 markdown：${JSON.stringify(md)}`)
  check('大标题标成一级', /^# 季度汇报$/m.test(md), JSON.stringify(md.slice(0, 120)))
  check('二级标题标成二级', /^## 数据小节$/m.test(md), JSON.stringify(md.slice(0, 120)))
}

/**
 * 光栅化的辅助：自己带 cancel 与 onProgress 直接调 runDocument。
 *
 * 上边那个 `convert()` 不给 cancel、也不看进度，而这两样正是光栅化要验的东西
 * （取消能不能清干净、进度是不是 batch）。
 */
async function runTo(
  input: string,
  fromExt: string,
  toExt: string,
  output: string,
  cancel: CancelToken = new CancelToken(),
  onProgress: (p: TaskProgress) => void = () => undefined
): Promise<void> {
  await runDocument({ input, output, fromExt, toExt, cancel, onProgress })
}

/**
 * 跑一次转换，**抛错时返回错误信息而不是上抛**。
 *
 * 转换挂掉时若直接抛出去，会被 main 的兜底 catch 接住、后面的场景一条都不跑，
 * 看起来像测试自己出了问题——这个仓库为这件事踩过一次坑，别再来一次。
 */
async function tryRun(
  input: string,
  fromExt: string,
  toExt: string,
  output: string
): Promise<string> {
  try {
    await runTo(input, fromExt, toExt, output)
    return ''
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

/** 输出名带时间戳，免得同一秒里的多次转换互相撞名 */
function newOutput(tag: string, toExt: string): string {
  return join(OUT, `${tag}-${Date.now()}-${Math.round(performance.now() * 1000)}.${toExt}`)
}

/**
 * 第 1 页在 output 上，第 k≥2 页在同目录的兄弟名 `<stem>-<k>.<ext>` 上。
 * 这个函数就是「产物该长什么样」的规格，断言直接照它列清单。
 */
function pageFiles(output: string, pages: number): string[] {
  const dir = dirname(output)
  const base = basename(output)
  const ext = extname(base)
  const stem = base.slice(0, -ext.length)
  return Array.from({ length: pages }, (_, i) =>
    i === 0 ? output : join(dir, `${stem}-${i + 1}${ext}`)
  )
}

/** 造一份「页数确定且够多」的真 Chromium PDF（含中文 Type0 字体子集） */
async function makePdf(name: string, sections: number): Promise<string> {
  const body = Array.from(
    { length: sections },
    (_, i) => `## 第 ${i + 1} 节\n\n这是第 ${i + 1} 节的正文，用来把文档撑到足够多页。\n`
  ).join('\n')
  return convert(await writeMd(name, body), 'md', 'pdf')
}

/**
 * `pdf → png/jpg`：主进程里把每一页光栅化成位图（pdfjs legacy build + @napi-rs/canvas）。
 *
 * 素材是**真 Chromium 打出来的 PDF**而不是手搓的字节串——手搓的样本测不出 pdfjs 的解码器行为。
 */
async function testPdfToImages(): Promise<void> {
  console.log('\n[9] pdf → png / jpg（每页一个文件）')

  const srcPdf = await makePdf('raster-src.md', 60)
  const facts = await inspect(srcPdf)
  const pages = facts.pages
  check('素材确实是多页 PDF', pages > 1, `${pages} 页`)

  // 期望尺寸从 PDF 自己的页面点尺寸推出来，而不是写死一个数——这样连 DPI 一起锁住。
  // **别拿「大于 0」当断言**：一张 1x1 的空白图也满足它。
  const SCALE = 150 / 72
  const expectW = Math.ceil(facts.firstPage.width * SCALE)
  const expectH = Math.ceil(facts.firstPage.height * SCALE)

  for (const ext of ['png', 'jpg'] as const) {
    const out = newOutput(`raster-${ext}`, ext)
    const failure = await tryRun(srcPdf, 'pdf', ext, out)
    check(`[${ext}] 转换成功`, failure === '', failure)
    // 转换挂了就不再往下走：`sharp(不存在的文件)` 会抛出去把套件崩在半路，
    // 后面的场景一条都不跑，看起来像测试本身出了问题
    if (failure !== '') continue

    const meta = await sharp(out).metadata()
    check(
      `[${ext}] 第 1 页落在 output 上，且是 150 DPI 的整页尺寸`,
      meta.width === expectW && meta.height === expectH,
      `${meta.width}x${meta.height}，期望 ${expectW}x${expectH}`
    )

    // 非空白的证据。全白图的通道均值是 255、标准差 0，而
    // 「文件存在」「字节数 > 0」对一张全白图同样成立，那两条不算断言。
    const stats = await sharp(out).stats()
    check(
      `[${ext}] 像素不是纯色（真的画出了内容）`,
      stats.channels.some((c) => c.stdev > 1),
      `通道标准差 ${stats.channels.map((c) => c.stdev.toFixed(2)).join(', ')}`
    )

    // 多页：N 页就该有 N 个文件，一个都不能少（只写第 1 页是静默丢数据）
    const expected = pageFiles(out, pages)
    const missing = expected.filter((p) => !existsSync(p))
    check(
      `[${ext}] 每一页都产出了（不是只写第 1 页）`,
      expected.length === pages && missing.length === 0,
      `${expected.length - missing.length}/${pages} 个文件；缺 ${missing.map((p) => basename(p)).join(', ') || '无'}`
    )

    const second = existsSync(expected[1]) ? await sharp(expected[1]).metadata() : null
    check(
      `[${ext}] 第 2 页也是整页尺寸（兄弟页不是空壳）`,
      second?.width === expectW && second?.height === expectH,
      second ? `${second.width}x${second.height}` : '兄弟页根本不存在'
    )

    // 转换期间所有中间产物都得带 .part 且**保住扩展名**（约束 8），落盘后一个都不该剩。
    //
    // **必须按本场景的 stem 收窄**：这个目录是所有场景共用的（`newOutput` 只是给名字加个
    // 不重名的后缀），全目录扫的话，另一份套件并发跑时正写着的临时文件会被数进来，
    // 报成「有残留」——而那条红与本场景毫无关系，只会把人引去查一个不存在的 bug。
    // [10] 那条同样的断言早就是这么收窄的（`startsWith(stem)`），这里对齐。
    const rasterStem = basename(out).replace(/\.[^.]+$/, '')
    const partMarker = String.fromCharCode(46) + 'part' + String.fromCharCode(46)
    const leftover = readdirSync(dirname(out)).filter(
      (n) => n.startsWith(rasterStem) && n.includes(partMarker)
    )
    check(
      `[${ext}] 没有残留 .part（临时名保住了扩展名）`,
      leftover.length === 0,
      leftover.join(', ') || '干净'
    )
  }

  // 占用探测：先把 `-2` 占掉，页序要整体往后顺延，而不是覆盖别人的文件
  const busy = newOutput('raster-busy', 'png')
  const busyDir = dirname(busy)
  const busyBase = basename(busy)
  const busyStem = busyBase.slice(0, -extname(busyBase).length)
  const occupied = join(busyDir, `${busyStem}-2.png`)
  await writeFile(occupied, 'occupied', 'utf8')
  const busyFailure = await tryRun(srcPdf, 'pdf', 'png', busy)
  check(
    '兄弟名被占用时整体顺延（-2 让给 -3）',
    busyFailure === '' &&
      existsSync(join(busyDir, `${busyStem}-3.png`)) &&
      readFileSync(occupied, 'utf8') === 'occupied',
    busyFailure ||
      readdirSync(busyDir)
        .filter((n) => n.startsWith(busyStem))
        .join(', ')
  )
}

/**
 * 取消：**不能留下半份产物**。
 *
 * 这条最容易被写成装饰性断言——「没有残留」在「什么都没来得及写」时同样成立。
 * 所以前置条件必须一起断言：取消之前确实已经渲染过若干页（数 batch 进度事件），
 * 且取消耗时明显短于完整转换（否则取消落在完成之后，测的根本不是取消）。
 */
async function testPdfRasterCancel(): Promise<void> {
  console.log('\n[10] pdf → png 的取消')

  // 素材必须在**慢的那一侧**够慢：单页 35 ms，页数少了取消会落在完成之后
  const srcPdf = await makePdf('cancel-src.md', 400)
  const pages = (await inspect(srcPdf)).pages
  check('取消用的素材够多页（否则取消落在完成之后，这条测不出东西）', pages >= 25, `${pages} 页`)

  // 先量一遍完整转换的耗时做基准。此时 pdfjs 模块已经热了（场景 9 跑过），
  // 所以这个基准里几乎没有一次性开销
  const t0 = performance.now()
  const baselineFailure = await tryRun(srcPdf, 'pdf', 'png', newOutput('full', 'png'))
  const full = performance.now() - t0
  check('取消场景的基准转换跑得起来', baselineFailure === '', baselineFailure)
  // 基准都跑不起来，后面的耗时比较就没意义了——直接收工，
  // 而不是让一个异常把套件崩在半路、盖住后面几十条断言（这个仓库踩过一次）
  if (baselineFailure !== '') return
  console.log(`    完整转换 ${pages} 页用了 ${Math.round(full)} ms`)

  const cancel = new CancelToken()
  let batches = 0
  const out = newOutput('cc', 'png')
  const t1 = performance.now()
  const timer = setTimeout(() => cancel.cancel(), Math.max(150, full * 0.4))
  let message = ''
  try {
    await runTo(srcPdf, 'pdf', 'png', out, cancel, (p) => {
      if (p.kind === 'batch') batches += 1
    })
  } catch (error) {
    message = error instanceof Error ? error.message : String(error)
  } finally {
    clearTimeout(timer)
  }
  const elapsed = performance.now() - t1

  check('取消抛的是 ConversionCanceled', message === '已取消', JSON.stringify(message))
  // **这是下面「清干净了」的前置条件**：batch 为 0 说明取消落在渲染开始之前，
  // 那时「没有残留」是空集合上的恒真断言，什么也证明不了
  check('取消之前确实已经渲染过若干页', batches >= 2, `${batches} 次 batch 进度（共 ${pages} 页）`)
  check(
    '取消耗时不到完整转换的一半（真的打断了，而不是跑完才发现取消了）',
    elapsed < full / 2,
    `${Math.round(elapsed)}ms vs ${Math.round(full)}ms`
  )

  const stem = basename(out).replace(/\.png$/, '')
  const leftovers = readdirSync(OUT).filter((n) => n.startsWith(stem))
  check('产物目录里确实有东西（确认我们数的是对的那个目录）', readdirSync(OUT).length > 0)
  check(
    '没有残留的 .part，也没有残留的兄弟页',
    leftovers.length === 0,
    leftovers.join(', ') || '干净'
  )
}

// -------------------------------------------------------------------- main

async function main(): Promise<void> {
  await rm(ROOT, { recursive: true, force: true })
  await mkdir(SRC, { recursive: true })
  await mkdir(OUT, { recursive: true })

  let code = 0
  try {
    await testTextToPdf()
    await testRelativeImage()
    await testMultiPage()
    await testSpreadsheet()
    await testImageToPdf()
    await testHtmlPassthrough()
    await testTextAndMdExports()
    await testPdfTextExport()
    await testPdfToImages()
    await testPdfRasterCancel()
  } catch (error) {
    failed += 1
    console.log(`\n  ✗ 未捕获异常：${error instanceof Error ? error.stack : String(error)}`)
  } finally {
    console.log(`\n通过 ${passed}，失败 ${failed}`)
    // 失败时保留现场：产物删了就只剩「失败了」三个字，没法自己看
    if (failed === 0) await rm(ROOT, { recursive: true, force: true }).catch(() => undefined)
    else console.log(`（产物保留在 ${ROOT} 供排查）`)
    code = failed === 0 ? 0 : 1
  }

  app.exit(code)
}

/**
 * Electron 的默认行为是「最后一个窗口关闭就退出应用」。我们的隐藏窗口每次打印完都会
 * destroy，于是**第一个场景跑完进程就自己没了**——后面的场景一条都不跑、也不报错，
 * 终端上只剩一个提前结束的 [1]。这个钩子必须接管掉。
 *
 * 顺带一提：这也说明生产环境里 window.ts 必须自己管 window-all-closed，
 * 否则用户关掉主窗口之后、还挂着的 PDF 窗口会让应用的退出时机变得很怪。
 */
app.on('window-all-closed', () => undefined)

void app.whenReady().then(main)
