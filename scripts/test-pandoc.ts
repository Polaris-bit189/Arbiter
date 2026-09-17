/**
 * pandoc 适配器的集成测试。
 *
 *   npx tsx --tsconfig tsconfig.test.json scripts/test-pandoc.ts
 *
 * 跑的是**真实的 pandoc 子进程**（resources/engines/pandoc/pandoc.exe），只有 `electron`
 * 被换成桩（见 scripts/electron-stub.ts）。覆盖的全是「不跑真 pandoc 就不可能知道」的
 * 那几件事：`.txt` 该映射成哪个 reader、GBK 输入会不会变乱码、相对路径插图靠什么才找得到。
 *
 * 素材全部现场造：被测的是 pandoc 怎么处理这些内容，而验证它的是 mammoth（第三方
 * 的 docx 读取实现）——**读写两侧不是同一个实现**，所以不存在「自己验自己」的问题。
 *
 * **每条断言都必须独立成立**：转换失败只会让产物读成空，不会把套件崩在半路。
 * 否则一个变异就能盖住后面几十条断言，反证脚本（falsify-pandoc.mjs）也就失去了意义。
 */
// 路径环境（userData / appPath / resourcesPath），必须是第一个 import——见那个文件
import './install-test-paths'
import { spawn } from 'child_process'
import { existsSync } from 'fs'
import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from 'fs/promises'
import { join, resolve } from 'path'
import { inflateRawSync } from 'zlib'
import mammoth from 'mammoth'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import sharp from 'sharp'

/**
 * ⚠️ **关掉 libvips 的运算缓存**，理由与 `test-image-options.ts` 文件头那段逐字相同：
 * 不关的话本套件跑完会在仓库根留下一整个 `.tmp-test-pandoc/`（9 个文件），
 * `rm` 报 `EBUSY` 而**重试没用**——握着句柄的是本进程自己（libvips 缓存了「读写过那个
 * 路径」这件事），进程一没它自然就开了。实测加这一句之后连跑三次都是干净的。
 *
 * 残留不致命（`.tmp-*` 已被 `electron-builder.yml` 的 `files` 排除，约束 30），
 * 但它会让打包前那道 `ls -d .tmp-*` 守卫失去信号。
 */
sharp.cache(false)
import * as XLSX from 'xlsx'
// 名字里带 Routed：本文件里那个裸 `convert()` 是「直连 pandoc 适配器」的局部辅助函数，
// 这个才是能力矩阵那条真实路径（`engineFor` 选引擎）。两者混用会让断言测错对象。
import { convert as convertRouted } from '../src/main/converters'
import { CancelToken } from '../src/main/core/cancel'
import { runDocument } from '../src/main/converters/document'
import { runPandoc } from '../src/main/converters/pandoc'
// 直接调子进程层（[13] 用）：`runPandocCli` 是被测对象，`requirePandocExe` 给「参考解码」
// 那个**独立**的读取路径用（自己 spawn、自己收原始字节，不复用被测实现）
import { requirePandocExe, runPandocCli } from '../src/main/converters/pandocRun'
import { ConversionCanceled, ConversionFailed } from '../src/main/converters/common'
import { extractPdfLines } from '../src/main/converters/pdfText'
import { engineFor, sourceExtsByCategory, targetsFor } from '../src/shared/formats'
import { CATEGORIES } from '../src/shared/types'
import type { ConvertContext } from '../src/main/converters/common'
import type { TaskProgress } from '../src/shared/types'

const TMP = resolve('.tmp-test-pandoc')
const SRC = join(TMP, 'src')
const OUT = join(TMP, 'out')

/**
 * 手写 GBK 字节。**不能用编码器生成**：拿同一个库编了再解，测不出「解错了」。
 * 内容是「姓名,城市,备注 / 张三,北京,研发部 / 李四,上海,研发部」三行。
 */
const GBK_TEXT = Buffer.from([
  0xd0, 0xd5, 0xc3, 0xfb, 0x2c, 0xb3, 0xc7, 0xca, 0xd0, 0x2c, 0xb1, 0xb8, 0xd7, 0xa2, 0x0a, 0xd5,
  0xc5, 0xc8, 0xfd, 0x2c, 0xb1, 0xb1, 0xbe, 0xa9, 0x2c, 0xd1, 0xd0, 0xb7, 0xa2, 0xb2, 0xbf, 0x0a,
  0xc0, 0xee, 0xcb, 0xc4, 0x2c, 0xc9, 0xcf, 0xba, 0xa3, 0x2c, 0xd1, 0xd0, 0xb7, 0xa2, 0xb2, 0xbf,
  0x0a
])

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

// ------------------------------------------------------------------ 读产物
// 三个读取器一律「读不到就给空值」，绝不抛异常：断言该红就红，不该把套件崩掉。

async function readBytes(file: string): Promise<Buffer | null> {
  try {
    return await readFile(file)
  } catch {
    return null
  }
}

function eocdOf(buffer: Buffer): number {
  for (let i = buffer.length - 22; i >= 0 && i > buffer.length - 66000; i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) return i
  }
  return -1
}

/**
 * 列出 docx（本质是 zip）的条目名。
 *
 * 刻意自己解析而不是引个 docx 库：这里要问的问题恰恰是「包里到底有没有 word/media/」，
 * 用库读正文回答不了。zip 的中央目录结构二十年没变过，这几行足够可靠。
 */
async function zipEntries(file: string): Promise<string[]> {
  const buffer = await readBytes(file)
  if (!buffer) return []

  const eocd = eocdOf(buffer)
  if (eocd < 0) return []

  const count = buffer.readUInt16LE(eocd + 10)
  let offset = buffer.readUInt32LE(eocd + 16)
  const names: string[] = []

  for (let n = 0; n < count; n += 1) {
    const nameLen = buffer.readUInt16LE(offset + 28)
    const extraLen = buffer.readUInt16LE(offset + 30)
    const commentLen = buffer.readUInt16LE(offset + 32)
    names.push(buffer.toString('utf8', offset + 46, offset + 46 + nameLen))
    offset += 46 + nameLen + extraLen + commentLen
  }

  return names
}

/** 取出 docx 里某个条目的文本内容（条目一般用 deflate 压过） */
async function zipEntryText(file: string, entry: string): Promise<string> {
  const buffer = await readBytes(file)
  if (!buffer) return ''

  const eocd = eocdOf(buffer)
  if (eocd < 0) return ''

  const count = buffer.readUInt16LE(eocd + 10)
  let offset = buffer.readUInt32LE(eocd + 16)

  for (let n = 0; n < count; n += 1) {
    const nameLen = buffer.readUInt16LE(offset + 28)
    const extraLen = buffer.readUInt16LE(offset + 30)
    const commentLen = buffer.readUInt16LE(offset + 32)
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLen)

    if (name === entry) {
      const method = buffer.readUInt16LE(offset + 10)
      const compressed = buffer.readUInt32LE(offset + 20)
      // 数据位置只在 local header 里精确（它自己的 name/extra 长度未必与中央目录相同）
      const local = buffer.readUInt32LE(offset + 42)
      const localNameLen = buffer.readUInt16LE(local + 26)
      const localExtraLen = buffer.readUInt16LE(local + 28)
      const start = local + 30 + localNameLen + localExtraLen
      const raw = buffer.subarray(start, start + compressed)
      return (method === 0 ? Buffer.from(raw) : inflateRawSync(raw)).toString('utf8')
    }

    offset += 46 + nameLen + extraLen + commentLen
  }

  return ''
}

/** 用 mammoth 把 docx 读回纯文本——独立的第三方实现，与 pandoc 的写侧互不相干 */
async function docxText(file: string): Promise<string> {
  try {
    const result = await mammoth.extractRawText({ path: file })
    return result.value
  } catch {
    return ''
  }
}

async function fileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size
  } catch {
    return -1
  }
}

// ------------------------------------------------------------------ 转换入口

async function convert(
  input: string,
  output: string,
  fromExt: string,
  toExt: string,
  hooks: { cancel?: CancelToken; onProgress?: (p: TaskProgress) => void } = {}
): Promise<void> {
  const context: ConvertContext = {
    input,
    output,
    fromExt,
    toExt,
    cancel: hooks.cancel ?? new CancelToken(),
    onProgress: hooks.onProgress ?? ((): void => {})
  }
  await runPandoc(context)
}

/** 转换失败时返回错误文本，成功返回 null——把「失败」变成可断言的返回值，而不是异常 */
async function tryConvert(
  input: string,
  output: string,
  fromExt: string,
  toExt: string,
  hooks: { cancel?: CancelToken; onProgress?: (p: TaskProgress) => void } = {}
): Promise<string | null> {
  try {
    await convert(input, output, fromExt, toExt, hooks)
    return null
  } catch (error) {
    return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  }
}

/** 一个转换上下文。判断都靠返回值，不靠异常，与套件其余部分同一个路数 */
function ctx(input: string, output: string, fromExt: string, toExt: string): ConvertContext {
  return { input, output, fromExt, toExt, cancel: new CancelToken(), onProgress: () => undefined }
}

/** 走**路由**（`converters/index.ts` → `engineFor`）跑一次，与真实任务同一条路 */
async function tryRoute(
  input: string,
  output: string,
  fromExt: string,
  toExt: string
): Promise<string | null> {
  try {
    await convertRouted(ctx(input, output, fromExt, toExt))
    return null
  } catch (error) {
    return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  }
}

/**
 * 走 `document.ts`（能力矩阵里的 `'pdf'` 引擎）。
 *
 * rst 的 html / md / txt 出口在这条线上——它们不落 `converters/pandoc.ts`，
 * 但解析仍然靠 pandoc，所以放在同一个套件里测。
 */
async function tryConvertDoc(
  input: string,
  output: string,
  fromExt: string,
  toExt: string
): Promise<string | null> {
  try {
    await runDocument({
      input,
      output,
      fromExt,
      toExt,
      cancel: new CancelToken(),
      onProgress: (): void => {}
    })
    return null
  } catch (error) {
    return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  }
}

/**
 * 跑一次 `document.ts` 的转换，返回**抛出的错误对象本身**（成功给 null）。
 *
 * `tryConvertDoc` 把错误折成一行文本，看不到 `logTail`——而诊断内容恰恰只在 `logTail`
 * 里（`ConversionFailed.message` 恒为「转换失败」，UI 展开排查看的也是 `logTail`）。
 */
async function docError(
  input: string,
  output: string,
  fromExt: string,
  toExt: string
): Promise<unknown> {
  try {
    await runDocument(ctx(input, output, fromExt, toExt))
    return null
  } catch (error) {
    return error
  }
}

/** 读文本产物；读不到给空串。空串会让「不含 X」型断言恒真，所以调用处必须先断非空 */
async function textOf(file: string): Promise<string> {
  const buffer = await readBytes(file)
  return buffer ? buffer.toString('utf8') : ''
}

// ------------------------------------------------------------------ 素材

const MD = `# 主标题

这是一段**中文**正文，用来验证内容真的进了 Word。

## 二级标题

- 项目一
- 项目二

| 列A | 列B |
| --- | --- |
| 值1 | 值2 |
`

const TXT = '第一行中文\n第二行中文\n'

const HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>网页</title></head>
<body><h1>网页标题</h1><p>网页正文里有中文。</p></body></html>
`

/**
 * RST 素材刻意带齐「只有真解析才会出现」与「只有降级才会出现」两类特征。
 *
 * 加粗、链接、代码块、列表是前者；`====` 那种标题下划线是后者——RST 源码原样当纯文本
 * 渲染时，下划线必然一字不差地留在产物里。两边都摆上，[8] 节才能做出差分。
 *
 * 注意 `**粗体**` 与链接都是**单独成句**的，不是嵌在中文里。RST 的 inline markup
 * 有硬性空白规则：开标记前必须是行首或空白，闭标记后必须是空白或标点。
 * 写成「含**粗体**和」这种，pandoc 会按规矩**不解析**、原样吐出来——
 * 素材不合规范时，`<strong>` 那条断言红的其实是测试自己。
 */
const RST = `标题
====

这是 reStructuredText 的正文。

**粗体** 单独成句。

参考 \`示例链接 <https://example.com>\`_ 即可。

.. code-block:: python

   print("hello")

- 甲
- 乙
`

/** GBK 那段内容对应的正确 UTF-8 文本，用来和 GBK 版的产物做差分 */
function asUtf8Text(): string {
  return '姓名,城市,备注\n张三,北京,研发部\n李四,上海,研发部\n'
}

async function stageFixtures(): Promise<void> {
  await mkdir(SRC, { recursive: true })
  await mkdir(OUT, { recursive: true })

  await writeFile(join(SRC, 'doc.md'), MD, 'utf8')
  await writeFile(join(SRC, 'doc.txt'), TXT, 'utf8')
  await writeFile(join(SRC, 'gbk.txt'), GBK_TEXT)
  await writeFile(join(SRC, 'utf8.txt'), asUtf8Text(), 'utf8')
  await writeFile(join(SRC, 'page.html'), HTML, 'utf8')
  await writeFile(join(SRC, 'page.rst'), RST, 'utf8')
  // 同一份 GBK 字节换个扩展名，走 document.ts 那条路：两处的编码归一必须是同一套
  await writeFile(join(SRC, 'gbk.rst'), GBK_TEXT)

  // 插图与引用它的 markdown 放在同一个子目录里：pandoc 按 cwd 找相对路径，
  // 而我们的实现显式给 --resource-path <源目录>，所以图必须落在源目录才找得到
  await sharp({
    create: { width: 400, height: 300, channels: 3, background: { r: 255, g: 0, b: 0 } }
  })
    .png()
    .toFile(join(SRC, 'pic.png'))

  await writeFile(join(SRC, 'with-image.md'), '# 带插图\n\n![红块](pic.png)\n', 'utf8')
  // 对照组：除了没有 ![]() 之外一模一样。两份都转，只比较 word/media 的有无
  await writeFile(join(SRC, 'without-image.md'), '# 带插图\n\n红块\n', 'utf8')
}

/** 图片素材的尺寸，断言要用它比对（写死一个 1x1 的「有产物」是装饰性断言） */
const IMG_W = 40
const IMG_H = 30

/**
 * PDF 素材：**用 pdf-lib 现造**，因为这几节要问的正是「有没有文本层」。
 *
 * - `scan.pdf` —— 三页，每页只有一张位图，**一个文本操作符都没有**。扫描件就是这个形状。
 * - `probe.pdf` —— 一页文本层（标准字体 + ASCII；标准字体没有 CJK 字形，写中文会画不出来）。
 * - `mixed.pdf` —— 一页文本 + 一页图。局部没有文本的文档**不该**被当成扫描件。
 *
 * 素材必须是真的 PDF 字节流：手搓一个「空文本」的假文件测不出 pdfjs 的行为。
 */
async function stagePdfFixtures(): Promise<void> {
  const block = await sharp({
    create: { width: IMG_W, height: IMG_H, channels: 3, background: { r: 210, g: 40, b: 40 } }
  })
    .png()
    .toBuffer()
  await writeFile(join(SRC, 'block.png'), block)

  const scan = await PDFDocument.create()
  const scanImage = await scan.embedPng(block)
  for (let i = 0; i < 3; i += 1) {
    scan.addPage([300, 400]).drawImage(scanImage, { x: 60, y: 120, width: 180, height: 180 })
  }
  await writeFile(join(SRC, 'scan.pdf'), await scan.save())

  const probe = await PDFDocument.create()
  const font = await probe.embedFont(StandardFonts.Helvetica)
  probe.addPage([400, 300]).drawText(PROBE_TEXT, { x: 20, y: 200, size: 14, font })
  await writeFile(join(SRC, 'probe.pdf'), await probe.save())

  const mixed = await PDFDocument.create()
  const mixedFont = await mixed.embedFont(StandardFonts.Helvetica)
  mixed.addPage([400, 300]).drawText(PROBE_TEXT, { x: 20, y: 200, size: 14, font: mixedFont })
  const mixedImage = await mixed.embedPng(block)
  mixed.addPage([300, 400]).drawImage(mixedImage, { x: 60, y: 120, width: 180, height: 180 })
  await writeFile(join(SRC, 'mixed.pdf'), await mixed.save())
}

/** 文本层里那句探针文本（ASCII：标准字体没有 CJK 字形） */
const PROBE_TEXT = 'Arbiter text layer probe'

/**
 * bmp / ico 素材：**用 ffmpeg 现造**（就是 `png → bmp` / `png → ico` 那两格）。
 * 手搓字节的话，被测的其实是我的手艺，而不是 ffmpeg / sharp 能不能读。
 */
async function stageImageFixtures(): Promise<void> {
  for (const ext of ['bmp', 'ico'] as const) {
    await convertRouted(ctx(join(SRC, 'block.png'), join(SRC, `block.${ext}`), 'png', ext))
  }
}

/**
 * 逐格审计（[11]）用的源文件：文档类每一种源格式各一份，文件名统一 `audit-<格式>.<格式>`。
 *
 * - `docx` 用**真 pandoc** 造（它本来就是被测对象之一，产物再由 mammoth 读回来）。
 * - `xlsx` 只能由 SheetJS 自己造，而读侧也是 SheetJS——**这一格的读写是同一个实现**，
 *   所以它证明得了「路由通、有产物」，证明不了内容解析对不对（报告里如实写明）。
 *   其余格式的读写两侧都是不同实现（pandoc 写 / mammoth 读、Chromium 写 / pdfjs 读）。
 */
async function stageAuditFixtures(): Promise<void> {
  const md = '# 审计标题\n\n中文正文一段。\n'
  const html =
    '<!doctype html>\n<html lang="zh-CN"><head><meta charset="utf-8"><title>审计</title>' +
    '</head><body><h1>网页标题</h1><p>网页正文里有中文。</p></body></html>\n'

  await writeFile(join(SRC, 'audit-md.md'), md, 'utf8')
  await writeFile(join(SRC, 'audit-markdown.markdown'), md, 'utf8')
  await writeFile(join(SRC, 'audit-txt.txt'), '第一行中文\n第二行中文\n', 'utf8')
  await writeFile(join(SRC, 'audit-html.html'), html, 'utf8')
  await writeFile(join(SRC, 'audit-htm.htm'), html, 'utf8')
  await writeFile(
    join(SRC, 'audit-rst.rst'),
    '标题\n====\n\n这是 reStructuredText 的正文。\n',
    'utf8'
  )
  await writeFile(join(SRC, 'audit-csv.csv'), '姓名,城市\n张三,北京\n', 'utf8')
  await convertRouted(ctx(join(SRC, 'audit-md.md'), join(SRC, 'audit-docx.docx'), 'md', 'docx'))

  const workbook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet([
      ['姓名', '城市'],
      ['张三', '北京']
    ]),
    'Sheet1'
  )
  XLSX.writeFile(workbook, join(SRC, 'audit-xlsx.xlsx'))

  // pdf 源用有文本层那份（`scan.pdf` 抽不出字，是 [9] 的素材，不该混进这一节）
  await copyFile(join(SRC, 'probe.pdf'), join(SRC, 'audit-pdf.pdf'))
}

// ------------------------------------------------------------------ 用例

/**
 * 「一个字都没抽到」必须**显式说出来**。
 *
 * 这一节盯的是本项目最忌讳的那类错：产物是个空文件、任务却报成功——调用方（UI、
 * MCP agent）从返回值里看不出任何异常，只会以为那份文档本来就是空的。素材是
 * **没有文本层的图片型 PDF**（扫描件的形状），而本项目不含 OCR，所以「抽不到」
 * 是必然结果，能选的只有「说」与「不说」。
 */
async function testPdfTextless(): Promise<void> {
  console.log('\n[9] 图片型 PDF → txt/md：不许静默产出空文件')

  const scan = join(SRC, 'scan.pdf')

  // 素材前提：这份 PDF **确实**没有文本层。少了这条，一个「其实抽得出字」的素材会让
  // 整节空转——下面每条「没有产物」都会因为别的理由成立，而它们看起来一模一样。
  const pages = await extractPdfLines(scan, new CancelToken())
  check(
    '素材前提：scan.pdf 三页、每页一行都抽不出来',
    pages.length === 3 && pages.every((lines) => lines.length === 0),
    JSON.stringify(pages.map((lines) => lines.length))
  )

  // 对照组：同一条管线在**有文本层**的 PDF 上必须是好的。没有它，「报错」那几条断言
  // 在一个「整条路都坏掉、什么 PDF 都报错」的实现上照样绿。
  const probeOut = join(OUT, 'probe.txt')
  const probeError = await tryConvertDoc(join(SRC, 'probe.pdf'), probeOut, 'pdf', 'txt')
  check('对照：有文本层的 PDF → txt 成功', probeError === null, probeError ?? '')
  const probeText = await textOf(probeOut)
  check(
    '对照：正文真的抽出来了',
    probeText.includes(PROBE_TEXT),
    JSON.stringify(probeText.slice(0, 40))
  )

  for (const to of ['txt', 'md'] as const) {
    const out = join(OUT, `scan.${to}`)
    const error = await docError(scan, out, 'pdf', to)
    check(
      `scan → ${to} 抛的是 ConversionFailed，而不是「成功」`,
      error instanceof ConversionFailed,
      error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    )
    // 诊断在 `logTail` 里（`ConversionFailed.message` 恒为「转换失败」，UI 展开看的也是它）
    const tail = error instanceof ConversionFailed ? error.logTail.join('\n') : ''
    check(`scan → ${to} 的诊断点明「一行文本都没抽到」`, tail.includes('一行文本都没抽到'), tail)
    check(
      `scan → ${to} 的诊断点明可能是扫描件、且本项目没有 OCR`,
      tail.includes('扫描件') && tail.includes('OCR'),
      tail
    )
    // 「不应存在 X」型断言的前置条件在前面两条里：真的跑过、而且是因为**这条**理由
    // 停下的；同一个目录里 `probe.txt` 那份产物则证明这管线正常时会写出文件来。
    check(`scan → ${to} 没有留下空产物`, !existsSync(out))
    check(`scan → ${to} 没有留下 .part`, !existsSync(`${out}.part`))
  }

  // 局部没有文本 ≠ 没有文本层。判据是**整份文档**的字符数：写成逐页判的话，
  // 「一页正文 + 一页插图」这种最常见的文档会被整个拒掉。
  const mixedOut = join(OUT, 'mixed.txt')
  const mixedError = await tryConvertDoc(join(SRC, 'mixed.pdf'), mixedOut, 'pdf', 'txt')
  check('混合文档（一页正文 + 一页插图）仍然转得出来', mixedError === null, mixedError ?? '')
  check(
    '混合文档的正文在产物里',
    (await textOf(mixedOut)).includes(PROBE_TEXT),
    JSON.stringify((await textOf(mixedOut)).slice(0, 40))
  )
}

/**
 * `bmp` / `ico` 作为源：矩阵登记过的每一格都要**真的**跑得起来。
 *
 * 这两个格式 sharp 的输入侧读不了（`sharp.format` 里根本没有它们，实测），而矩阵把
 * png/jpg/webp/avif/tiff/gif 六个出口全路由给了 sharp——曾经六格**一格都不通**，
 * 报的是 sharp 那句 `Input file contains unsupported image format`。修法是让 `runSharp`
 * 先请 ffmpeg 解一步（`SHARP_UNREADABLE_SRC`），而不是改路由：ffmpeg 自己写不出 gif
 * （实测 `bmp → gif` 直接失败），改过去等于用六个坏格子换七个坏格子。
 */
async function testBmpIcoSources(): Promise<void> {
  console.log('\n[10] bmp / ico 作为源：矩阵里的每一格都要跑得起来')

  for (const from of ['bmp', 'ico'] as const) {
    const targets = targetsFor(from)
    // 前置：目标集合非空。否则下面那个 for 一次都不转，整节「全绿」而什么都没测
    check(`${from} 在矩阵里有目标格式`, targets.length > 0, targets.join(','))

    for (const to of targets) {
      if (to === 'pdf') {
        // 打印 PDF 要真 Electron（test-pdf.ts 那条线），这里只钉路由；
        // `bmp/ico → pdf` 这一步在 imagePlan 里靠 `normalizeToPng` 落地
        check(`${from} → pdf 路由到 pdf 引擎`, engineFor(from, to) === 'pdf')
        continue
      }

      const out = join(OUT, `${from}-to-${to}.${to}`)
      const error = await tryRoute(join(SRC, `block.${from}`), out, from, to)
      const size = await fileSize(out)
      check(
        `${from} → ${to} 成功且产物非空`,
        error === null && size > 0,
        `${error ?? ''} 产物 ${size} 字节`
      )
      // 尺寸必须保住：只断「文件存在且非空」的话，一张 1x1 的空白图同样满足
      // （sharp 读不了 ico/bmp 产物，那两格只断字节数）
      if (to !== 'ico' && to !== 'bmp') {
        const meta = await sharp(out)
          .metadata()
          .catch(() => null)
        check(
          `[${from} → ${to}] 尺寸没变（${IMG_W}x${IMG_H}）`,
          meta?.width === IMG_W && meta?.height === IMG_H,
          `${meta?.width ?? '?'}x${meta?.height ?? '?'}`
        )
      }
    }
  }
}

/**
 * `pdf → png/jpg` 的兄弟名避让。
 *
 * 第 k≥2 页落在 `<stem>-<k>.<ext>` 上，而这个名字**不进** `TaskManager.claimed`
 * （约束 9 那套占位机制管不到兄弟名，`core/` 这一线不动）。真正会撞名的场景是同目录里
 * 躺着一份**拆页导出的兄弟源** `a-2.pdf`：它转 png 时的本名正是我们的第 2 页。
 * 所以 `siblingTaken` 多了一条判据——目录里存在 `<stem>-<k>.*` 就不占那个号。
 *
 * 素材用三页的 `scan.pdf`：页数固定，落几个文件数得清。
 */
async function testSiblingAvoidance(): Promise<void> {
  console.log('\n[12] pdf → png 的兄弟名避让')

  for (const withBrother of [false, true]) {
    const dir = join(OUT, withBrother ? 'sib-yes' : 'sib-no')
    await mkdir(dir, { recursive: true })
    if (withBrother) {
      // 兄弟源换个扩展名（jpg）：判据看的是 stem，不是「同名同扩展名的产物」
      await writeFile(join(dir, 'a-2.jpg'), 'brother')
    }

    const error = await docError(join(SRC, 'scan.pdf'), join(dir, 'a.png'), 'pdf', 'png')
    check(`[${withBrother ? '有' : '没有'}兄弟源] 三页都转得完`, error === null, String(error))

    const names = await readdir(dir)
    const pages = names.filter((n) => n.endsWith('.png'))
    // 前置：页数对不对。少了这条，「让号」那一条在少写一页时也会因为别的原因成立
    check(
      `[${withBrother ? '有' : '没有'}兄弟源] 三页一个不少`,
      pages.length === 3 && names.includes('a.png'),
      names.join(', ')
    )
    // 「别人的文件原封不动」并进这一条，不单列：单列的话它没有任何自然的变异能让它
    // 翻红（扩展名不同，我们本来就写不到它身上），那就是一条装饰性断言。
    const neighborIntact =
      !withBrother || (await readFile(join(dir, 'a-2.jpg'), 'utf8')) === 'brother'
    check(
      withBrother
        ? '[有兄弟源] a-2.jpg 占着号 → 第 2 页让到 a-3.png，且兄弟源原封不动'
        : '[没有兄弟源] 第 2 页落在 a-2.png（避让不是无条件跳号）',
      names.includes(withBrother ? 'a-3.png' : 'a-2.png') &&
        !(withBrother && names.includes('a-2.png')) &&
        neighborIntact,
      names.join(', ')
    )
  }
}

/**
 * 能力矩阵逐格审计。
 *
 * 两件事：**(a)** 每个 category 的每个源 × 每个目标都分得到一个引擎；**(b)** 文档类
 * 逐格**真跑**——`document.ts` 末尾那句 `不支持的文档转换：x → y` 是它自己承认
 * 「这个组合我处理不了」，矩阵里登记了却撞上它的格子，就是约束 11 记的 `tbz2`/`txz`
 * 那种「配置写了却永远走不到」。只看 `engineFor` 非空是不够的：引擎选得出来，
 * 引擎内部照样可能没有那条分支。
 */
async function testMatrixAudit(): Promise<void> {
  console.log('\n[11] 能力矩阵逐格审计')

  const byCategory = sourceExtsByCategory()
  const unrouted: string[] = []
  let pairs = 0
  for (const category of CATEGORIES) {
    for (const from of byCategory[category]) {
      for (const to of targetsFor(from)) {
        pairs += 1
        if (engineFor(from, to) === null) unrouted.push(`${category} ${from} → ${to}`)
      }
    }
  }
  // `pairs > 200` 是前置条件：矩阵被清空时这条在空集合上恒真
  check(
    `矩阵里的每一格都分得到引擎（共 ${pairs} 格）`,
    pairs > 200 && unrouted.length === 0,
    unrouted.join('、') || '（没有走不到的组合）'
  )

  const sources = ['md', 'markdown', 'txt', 'html', 'htm', 'rst', 'docx', 'xlsx', 'csv', 'pdf']
  const cases: [string, string][] = []
  for (const from of sources) {
    for (const to of targetsFor(from)) {
      // `→ pdf` 要在真 Chromium 里打印（test-pdf.ts 覆盖），这里跳过并明说
      if (to === 'pdf') continue
      cases.push([from, to])
    }
  }

  const failures: string[] = []
  for (const [from, to] of cases) {
    const out = join(OUT, `audit-${from}.${to}`)
    // **走路由**，不是直连 document.ts：`md → docx` 这类出口的引擎是 pandoc，
    // 直连 `runDocument` 会撞上它那句 `不支持的文档转换`——那是测试自己认错了对象。
    const error = await tryRoute(join(SRC, `audit-${from}.${from}`), out, from, to)
    const size = await fileSize(out)
    if (error !== null || size <= 0) failures.push(`${from} → ${to}: ${error ?? '产物是空的'}`)
  }
  check(
    `文档类每一格都真的转得出来（${cases.length} 格，跳过 ${sources.length} 个 → pdf）`,
    cases.length >= 30 && failures.length === 0,
    failures.join(' | ')
  )

  // 上面那条只问「有没有产物」，而**降级路径同样会产出非空的产物**：`htmlFragmentOf`
  // 的 default 分支把源文件当纯文本塞进 `<pre>`，产物照样是文件。所以再钉一组
  // **结构性判据**——每一条都问「这产物是不是那个解析器写的」，而不是「有没有内容」。
  // 判据取的都是各解析器的指纹标签，降级路径不可能碰巧写出来。
  const shapes: Record<string, (text: string) => boolean> = {
    // marked：`# 审计标题` → `<h1>`；降级路径只会给出 `<pre># 审计标题</pre>`
    'md>html': (t) => /<h1[\s>]/.test(t),
    'markdown>html': (t) => /<h1[\s>]/.test(t),
    // mammoth：docx 的 Word 标题样式 → `<h1>`（降级路径是 zip 二进制的乱码）
    'docx>html': (t) => /<h1[\s>]/.test(t),
    // SheetJS → 我们自己拼的表格（降级路径只有 `<pre>`）
    'csv>html': (t) => /<table>/.test(t) && /<th>/.test(t),
    'xlsx>html': (t) => /<table>/.test(t) && /<th>/.test(t),
    'xlsx>csv': (t) => t.includes('姓名,城市') && t.includes('张三,北京'),
    // html 源是**原样穿过**的完整文档：降级路径会把它转义成 `&lt;h1&gt;`。
    // 用 `htm → html` 而不是 `html → html`：同格式出口在矩阵里被 filter 掉了，
    // 写 `html>html` 会去读一个没人写过的路径（这坑写这一节时踩到过）
    'htm>html': (t) => /<h1[\s>]/.test(t) && !t.includes('&lt;h1'),
    // pandoc 解析 rst：降级路径会把 `====` 原样留下（[8] 已从两侧钉过，这里顺带覆盖）
    'rst>html': (t) => /<h1[\s>]/.test(t) && !t.includes('====')
  }

  // 前置：判据表里的每一格都得真的在审计清单里。否则那条判据会去读一个没人写过的
  // 路径，读成空串——**恒红**，而且看起来像「解析器没生效」。
  const missingCases = Object.keys(shapes).filter(
    (key) => !cases.some(([from, to]) => `${from}>${to}` === key)
  )
  check('结构性判据表与实际审计清单一致', missingCases.length === 0, missingCases.join('、'))

  const wrongShape: string[] = []
  for (const [key, shape] of Object.entries(shapes)) {
    const [from, to] = key.split('>')
    const text = await textOf(join(OUT, `audit-${from}.${to}`))
    if (!shape(text)) wrongShape.push(`${from} → ${to}: ${JSON.stringify(text.slice(0, 60))}`)
  }
  check(
    `每一格的产物都出自它该走的那个解析器（${Object.keys(shapes).length} 项结构性判据）`,
    wrongShape.length === 0,
    wrongShape.join(' | ')
  )

  // office 族（doc/xls/ppt/odt…）要 LibreOffice，这台机器上没有：只钉路由。
  // 它们的 `OFFICE_FAMILIES` 是实测出来的（跨应用一律 `no export filter`），
  // 真正的实现验证不在本套件里。
  const office = ['doc', 'odt', 'xls', 'ods', 'ppt', 'pptx', 'odp']
  const officeBad = office.filter((from) =>
    targetsFor(from).some((to) => engineFor(from, to) !== 'libreoffice')
  )
  check('office 族的每一格都路由到 LibreOffice', officeBad.length === 0, officeBad.join('、'))
}

async function main(): Promise<void> {
  await rm(TMP, { recursive: true, force: true })
  await stageFixtures()
  await stagePdfFixtures()
  await stageImageFixtures()
  await stageAuditFixtures()

  console.log('\n[1] md → docx（中文与结构）')
  {
    const out = join(OUT, 'doc.docx')
    const error = await tryConvert(join(SRC, 'doc.md'), out, 'md', 'docx')
    check('转换成功', error === null, error ?? '')

    const entries = await zipEntries(out)
    check(
      '是合法 docx（含 word/document.xml）',
      entries.includes('word/document.xml'),
      entries.join(',') || '（没有条目）'
    )

    const text = await docxText(out)
    check('中文正文进了产物', text.includes('这是一段中文正文'), JSON.stringify(text.slice(0, 60)))
    check('标题进了产物', text.includes('主标题') && text.includes('二级标题'))
    check('列表项进了产物', text.includes('项目一') && text.includes('项目二'))
    check('表格内容进了产物', text.includes('值1') && text.includes('值2'))

    // **转成 Word 而不是把 markdown 原样塞进去**，这是 pandoc 存在的理由。
    // 只验文本在不在是不够的：文本在、但全是普通段落的话，这份 docx 就没有价值。
    const xml = await zipEntryText(out, 'word/document.xml')
    check('标题带上了 Word 的 Heading 样式（不是一坨纯文本）', /w:val="Heading1"/.test(xml))
  }

  console.log('\n[2] .txt 必须映射成 markdown reader')
  {
    const out = join(OUT, 'doc-txt.docx')
    const error = await tryConvert(join(SRC, 'doc.txt'), out, 'txt', 'docx')
    check('txt → docx 转换成功', error === null, error ?? '')

    // pandoc 既没有 txt reader 也没有 plain reader，映射错了这里读到的是空
    const text = await docxText(out)
    check('txt → docx 内容在', text.includes('第一行中文'), JSON.stringify(text.slice(0, 40)))
  }

  console.log('\n[3] GBK 输入（差分：同一段文字，UTF-8 版与 GBK 版的产物必须一字不差）')
  {
    const gbkOut = join(OUT, 'gbk.docx')
    const utf8Out = join(OUT, 'utf8.docx')
    const gbkError = await tryConvert(join(SRC, 'gbk.txt'), gbkOut, 'txt', 'docx')
    const utf8Error = await tryConvert(join(SRC, 'utf8.txt'), utf8Out, 'txt', 'docx')
    check('两份都转换成功', gbkError === null && utf8Error === null, `${gbkError} / ${utf8Error}`)

    const gbkText = await docxText(gbkOut)
    const utf8Text = await docxText(utf8Out)

    check(
      'GBK 中文没有变成乱码',
      gbkText.includes('张三') && gbkText.includes('研发部'),
      JSON.stringify(gbkText.slice(0, 60))
    )
    check('解出来不含替换符', !gbkText.includes('�'))
    // 前置条件：两份都不是空的。否则下面那条「一致」在两边都读空时恒真
    check('差分的前置条件：两份产物都有内容', gbkText.length > 0 && utf8Text.length > 0)
    check(
      'GBK 版产物与 UTF-8 版完全一致',
      gbkText.length > 0 && gbkText === utf8Text,
      `GBK ${JSON.stringify(gbkText.slice(0, 40))} vs UTF-8 ${JSON.stringify(utf8Text.slice(0, 40))}`
    )
  }

  console.log('\n[4] 相对路径插图（--resource-path 差分）')
  {
    const withOut = join(OUT, 'with-image.docx')
    const withoutOut = join(OUT, 'without-image.docx')
    const withError = await tryConvert(join(SRC, 'with-image.md'), withOut, 'md', 'docx')
    const withoutError = await tryConvert(join(SRC, 'without-image.md'), withoutOut, 'md', 'docx')
    check(
      '两份都转换成功',
      withError === null && withoutError === null,
      `${withError} / ${withoutError}`
    )

    const withEntries = await zipEntries(withOut)
    const withoutEntries = await zipEntries(withoutOut)
    const withMedia = withEntries.filter((n) => n.startsWith('word/media/'))
    const withoutMedia = withoutEntries.filter((n) => n.startsWith('word/media/'))

    check(
      '带插图那份真的把图画进去了',
      withMedia.length > 0,
      withMedia.join(',') || '（没有 media）'
    )
    check(
      '对照组一张图都没有（证明上一条不是恒真）',
      withoutEntries.length > 0 && withoutMedia.length === 0,
      `${withoutEntries.length} 个条目 / ${withoutMedia.length} 张图`
    )
  }

  console.log('\n[5] html / rst → docx')
  {
    const htmlOut = join(OUT, 'page.docx')
    const htmlError = await tryConvert(join(SRC, 'page.html'), htmlOut, 'html', 'docx')
    check('html → docx 转换成功', htmlError === null, htmlError ?? '')
    const htmlText = await docxText(htmlOut)
    check(
      'html → docx 内容在',
      htmlText.includes('网页正文里有中文'),
      JSON.stringify(htmlText.slice(0, 50))
    )

    const rstOut = join(OUT, 'page-rst.docx')
    const rstError = await tryConvert(join(SRC, 'page.rst'), rstOut, 'rst', 'docx')
    check('rst → docx 转换成功', rstError === null, rstError ?? '')
    const rstText = await docxText(rstOut)
    check('rst → docx 内容在', rstText.includes('这是 reStructuredText 的正文'))
  }

  console.log('\n[6] 取消：必须真的把进程杀掉，而不是等它跑完')
  {
    // 取消要打在「转换进行中」才有意义。小文件 pandoc 几十毫秒就转完了，取消会落在
    // 完成之后——那测的其实不是取消。所以先量一次完整转换的耗时当基准。
    const big = join(SRC, 'big.md')
    const parts: string[] = []
    for (let i = 0; i < 200000; i += 1) {
      parts.push(`## 小节 ${i}\n\n这是第 ${i} 段中文正文，用来把文档撑大。\n\n`)
    }
    await writeFile(big, parts.join(''), 'utf8')

    const baseOut = join(OUT, 'big.docx')
    const t0 = Date.now()
    const baseError = await tryConvert(big, baseOut, 'md', 'docx')
    const fullMs = Date.now() - t0
    check(
      '基准：大文档能正常转完',
      baseError === null && (await fileSize(baseOut)) > 0,
      `${fullMs} ms`
    )

    const canceledOut = join(OUT, 'big-canceled.docx')
    const cancel = new CancelToken()
    let scheduled = false
    const onProgress = (): void => {
      // 进入转换阶段后约好取消，确保信号落在进程正在跑的时候（只安排一次）
      if (scheduled) return
      scheduled = true
      setTimeout(() => cancel.cancel(), 300)
    }

    const t1 = Date.now()
    let caught: unknown = null
    try {
      await convert(big, canceledOut, 'md', 'docx', { cancel, onProgress })
    } catch (error) {
      caught = error
    }
    const cancelMs = Date.now() - t1

    check('抛的是 ConversionCanceled', caught instanceof ConversionCanceled, String(caught))
    check('取消后没有留下产物', (await fileSize(canceledOut)) < 0)
    check('取消后没有留下 .part', (await fileSize(`${canceledOut}.part`)) < 0)
    // 这条才是「真的中断了」的证据：若无人生杀，它必然会跑满基准耗时。
    // 注意前三条在「取消落在完成之后」时**照样会绿**，所以它们单独证明不了取消真的生效。
    check(
      '取消显著快于完整转换（说明进程被杀了，不是等它跑完）',
      cancelMs < fullMs / 2,
      `取消 ${cancelMs} ms vs 完整 ${fullMs} ms`
    )
  }

  console.log('\n[7] 能力矩阵与适配器一致')
  {
    check('engineFor(md → docx) 路由到 pandoc', engineFor('md', 'docx') === 'pandoc')
    check('engineFor(txt → docx) 路由到 pandoc', engineFor('txt', 'docx') === 'pandoc')
    check('md → docx 出现在可选目标里', targetsFor('md').includes('docx'))
    check('engineFor(docx → pdf) 不走 pandoc', engineFor('docx', 'pdf') === 'pdf')
  }

  console.log('\n[8] rst 的四个出口：解析靠 pandoc，不再降级成源码')
  {
    // ---- html：真解析 vs 降级的分水岭在这里
    const htmlErr = await tryConvertDoc(
      join(SRC, 'page.rst'),
      join(OUT, 'page.html'),
      'rst',
      'html'
    )
    const html = await textOf(join(OUT, 'page.html'))

    check('rst → html 转换成功', htmlErr === null, htmlErr ?? undefined)
    // 前置条件：产物真读到东西。否则下面几条「不含 X」会恒真（空集合上永远成立）
    check('rst → html 产物非空', html.length > 0)
    check('RST 标题被解析成 <h1>', /<h1[\s>]/.test(html))
    check('**粗体** 被解析成 <strong>', /<strong[\s>]/.test(html))
    check('RST 超链接被解析成 <a href>', /<a [^>]*href="https:\/\/example\.com"/.test(html))
    check('RST 列表被解析成 <ul>/<li>', /<ul[\s>]/.test(html) && /<li[\s>]/.test(html))
    // 承重的一条：原样降级时整段源码被 <pre> 包住，「====」必然一字不差地留着
    check('产物里没有 RST 的标题下划线', !html.includes('===='))

    // ---- md：走 html → turndown，标题层级由 turndown 决定，只要还是标题就行
    const mdErr = await tryConvertDoc(join(SRC, 'page.rst'), join(OUT, 'page.md'), 'rst', 'md')
    const md = await textOf(join(OUT, 'page.md'))

    check('rst → md 转换成功', mdErr === null, mdErr ?? undefined)
    check('rst → md 产物非空', md.length > 0)
    check('rst → md 出的是 markdown 标题', /^#{1,6}\s+标题/m.test(md))
    check('rst → md 里没有标题下划线', !md.includes('===='))

    // ---- txt：剥标签，正文得留住
    const txtErr = await tryConvertDoc(join(SRC, 'page.rst'), join(OUT, 'page.txt'), 'rst', 'txt')
    const txt = await textOf(join(OUT, 'page.txt'))

    check('rst → txt 转换成功', txtErr === null, txtErr ?? undefined)
    check('rst → txt 产物非空', txt.length > 0)
    check('rst → txt 保住了正文', txt.includes('甲') && txt.includes('乙'))
    check('rst → txt 里没有标题下划线', !txt.includes('===='))

    // ---- GBK：document.ts 这条路也得过编码归一，不能只在 pandoc.ts 那条路上做
    const gbkErr = await tryConvertDoc(join(SRC, 'gbk.rst'), join(OUT, 'gbk.html'), 'rst', 'html')
    const gbkHtml = await textOf(join(OUT, 'gbk.html'))

    check('GBK 的 rst → html 成功', gbkErr === null, gbkErr ?? undefined)
    check('GBK 的 rst 产物非空', gbkHtml.length > 0)
    check('GBK 的 rst 解出来不是乱码', gbkHtml.includes('张三') && gbkHtml.includes('北京'))
    check('GBK 的 rst 里没有替换符', !gbkHtml.includes('�'))

    // 矩阵宣称的目标必须真的转得出来——这正是「界面能选、结果不是那么回事」那个洞
    const advertised = targetsFor('rst')
    check(
      '矩阵宣称 rst 能转 html/md/txt',
      ['html', 'md', 'txt'].every((t) => advertised.includes(t))
    )
  }

  await testPdfTextless()
  await testBmpIcoSources()
  await testSiblingAvoidance()
  await testMatrixAudit()
  await testChunkedDecode()
}

/**
 * [13] 多字节字符跨越管道边界时，正文不得被解码坏。
 *
 * 审计报告 §3.2：`Buffer.toString('utf8')` 是**对每个 chunk 独立解码**——一个 UTF-8
 * 多字节序列只要跨了管道边界（Node 按 64 KiB 读），就被拆成两个 `�`。
 * 而 pandoc 那条 stdout **就是文档正文**：`document.ts` 的 `rstToHtmlFragment` 直接
 * 把它交给 htmlToText / htmlToMarkdown / wrapHtml / PDF。所以这是**唯一会静默损坏
 * 用户文档正文的缺陷**——产物里零星几个字变成替换符，而任务照报 done。
 *
 * 判据刻意做成**差分**（同一段字节、两种解法），而不是只写一句「产物里没有替换符」：
 * 后者在素材小到一次读完时是**恒真的装饰性断言**（本项目已经因此抓到过四条）。所以：
 *
 *   1. `raw`：**直接 spawn pandoc、不做任何解码**，把 stdout 的原始字节与真实分块一起
 *      收下来（刻意不复用被测的 `runPandocCli`——那是「自己验自己」）；
 *   2. `naive`：把这段字节**按 64 KiB 硬切**再逐块 `toString('utf8')`，即被修掉的那一行
 *      的做法（64 KiB 是管道的读上限）。它**必须**出现替换符，否则说明素材压根触发不了
 *      这个缺陷，后面几条断言全部空转（0 次与「真的没坏」长得一模一样）；
 *   3. 被测的 `runPandocCli` 必须**一字不差地等于「整段字节一次性解码」**，且不含替换符
 *      ——这就是那条不变量：流式解码 == 整段解码；
 *   4. 端到端那半走 `document.ts`（`rst → txt`）：产物里不许有替换符，首尾两段都必须在
 *      （既没被替换、也没被半路截断），正是审计报告举的那个场景。
 *
 * ⚠️ **这条缺陷的触发是看时序的，要说得比「够大就必然坏」更准**（实测，2026-09-14）。
 * 同一份素材、同一台机器上量了 11 次：只有当某一次读**顶到 64 KiB 上限**时（也就是那
 * 一次读切在了一个写的中间），逐块解码才会丢字符（每次丢 3 个）；而大多数运行里读块
 * 恰好与 pandoc 的**写块**对齐（它的 stdout 是 ~5 KB 一块，实测两万多个块里绝大多数
 * 都不到 64 KiB），于是一个字符都不丢——**那时候绿并不证明那一行是对的**。
 * 实测命中率：1.15 MB 素材约 1/6，9.7 MB 素材约 2/5。
 * 所以除那条不变量断言外，下面还补了一条**结构性判据**：把跨块残字节交给 Node 的
 * StringDecoder，而不是自己逐块解码——这一条是确定性的，反证那一侧靠它才有准头。
 */
async function testChunkedDecode(): Promise<void> {
  console.log('\n[13] 多字节字符跨块：正文不得出现替换符')

  const COUNT = 12000
  const parts: string[] = []
  for (let i = 0; i < COUNT; i += 1) {
    parts.push(`这是第 ${i} 段中文正文，调律者转换器会把它原样搬到产物里去。\n\n`)
  }
  const bigRst = join(SRC, 'big-zh.rst')
  await writeFile(bigRst, parts.join(''), 'utf8')

  // ---- 素材前提：原始字节 +「旧解法会丢字符」 ----
  //
  // `raw.chunks` 是**本次真实的分块**（自己 spawn、不发 setEncoding，收什么就是什么），
  // 只用来把管道的真实行为报在 detail 里；判据用的是「按 64 KiB 硬切」那种**确定性**写法
  // ——真实的读边界每次都不一样（见上面那段实测命中率）。
  const raw = await rawPandocStdout(bigRst)
  check(
    '素材前提：直接 spawn 拿到了 pandoc 的原始 stdout 字节',
    raw.bytes.length > 0,
    `${raw.bytes.length} 字节`
  )
  check(
    '素材前提：stdout 分了多次读取（「跨块」是这件事发生的前提）',
    raw.chunks.length > 3,
    `${raw.chunks.length} 块 / 最大块 ${Math.max(...raw.chunks.map((c) => c.length))} / ${raw.bytes.length} 字节`
  )
  let naive = ''
  for (let i = 0; i < raw.bytes.length; i += 65536) {
    naive += raw.bytes.subarray(i, i + 65536).toString('utf8')
  }
  check(
    '素材前提：这段字节按 64 KiB 硬切再逐块解码（被修掉的那一行的做法）就会丢字符',
    naive.includes('�'),
    `替换符 ${(naive.match(/�/g) ?? []).length} 个`
  )

  // ---- 被测代码：runPandocCli 的 stdout 必须等于「整段字节一次性解码」 ----
  //
  // 跨运行比对是成立的：pandoc 对同一份输入的输出**逐字节确定**（实测同素材 10 次运行
  // sha256 全同），所以 `raw.bytes` 就是这一次 `runPandocCli` 拿到的同一段字节。
  const { stdout } = await runPandocCli(
    ['-f', 'rst', '-t', 'html', '--syntax-highlighting', 'none', resolve(bigRst)],
    new CancelToken()
  )
  const reference = raw.bytes.toString('utf8')
  check('runPandocCli 的 stdout 非空且够大', stdout.length > 100_000, `${stdout.length} 字符`)
  check(
    'runPandocCli 的 stdout 与「整段一次性解码」逐字相同（流式解码 == 整段解码）',
    stdout === reference,
    `长度 ${stdout.length} vs ${reference.length}，替换符 ${(stdout.match(/�/g) ?? []).length} 个`
  )
  check(
    'runPandocCli 的 stdout 里没有替换符',
    !stdout.includes('�'),
    `替换符 ${(stdout.match(/�/g) ?? []).length} 个`
  )

  // ---- 结构性判据：解码方式本身（补上面那条的概率性） ----
  //
  // 上面那条不变量断言的**判别力是有概率的**（约 1/6~2/5，见函数头那段实测）：
  // 「绿」并不能证明那一行是对的。而 `libreoffice` / `calibre` 那两处**连行为都测不了**
  // （本机没装那两个引擎），`ffmpegRun` 的 stderr 同理很难构造出跨块的中文。
  // 所以再钉一条**结构性**判据：这五个子进程适配器必须把跨块残字节交给 Node 的
  // StringDecoder（`setEncoding('utf8')`），而不是自己逐块 `toString('utf8')`。
  // 判据前先剥掉行注释——注释里正当地提到过那个坏写法（"不能在 data 回调里
  // `chunk.toString('utf8')`"），把它算进来会得到一条恒红的假断言。
  const decodeTargets: [string, boolean][] = [
    ['src/main/converters/pandocRun.ts', false],
    ['src/main/converters/libreoffice.ts', false],
    ['src/main/converters/calibre.ts', false],
    ['src/main/converters/ffmpegRun.ts', false],
    // archive 的 stdout 是 7z 的进度流，**刻意**保留逐块解码（取舍写在 `consume` 上面）——
    // 所以它只要求 stderr 走 setEncoding
    ['src/main/converters/archive.ts', true]
  ]
  const badDecode: string[] = []
  for (const [rel, allowChunkToString] of decodeTargets) {
    const source = await readFile(resolve(rel), 'utf8')
    const code = source
      .split('\n')
      .map((line) => line.replace(/\/\/.*$/, ''))
      .join('\n')
    const ok =
      code.includes("setEncoding('utf8')") &&
      (allowChunkToString || !code.includes("chunk.toString('utf8')"))
    if (!ok) badDecode.push(rel)
  }
  check(
    `结构性：${decodeTargets.length} 个子进程适配器都把跨块解码交给 StringDecoder（setEncoding）`,
    badDecode.length === 0,
    badDecode.join('、') || '（都走 setEncoding 了）'
  )

  // ---- 端到端：正文真的落到产物里，且首尾完整 ----
  const out = join(OUT, 'big-zh.txt')
  const error = await tryConvertDoc(bigRst, out, 'rst', 'txt')
  check('rst（一万两千段中文）→ txt 转换成功', error === null, error ?? '')
  const text = await textOf(out)
  check(
    '产物非空且够大（前置：否则下面两条在空串上恒真）',
    text.length > 100_000,
    `${text.length} 字符`
  )
  check('产物里没有替换符', !text.includes('�'))
  check(
    '首尾两段都在产物里（不是半路截断）',
    text.includes('这是第 0 段中文正文') && text.includes(`这是第 ${COUNT - 1} 段中文正文`),
    JSON.stringify(text.slice(0, 24))
  )
}

/**
 * 直接 spawn pandoc、**不做任何解码**，把 stdout 的原始字节与**真实分块**一起收下来。
 *
 * 刻意不复用被测的 `runPandocCli`（那是「自己验自己」）。返回 `chunks` 是为了让
 * 「旧解法在这份素材上必然坏」成为**实测**：被修掉的那一行（逐块 `toString('utf8')`）
 * 的输出，就是 `chunks.map((c) => c.toString('utf8')).join('')`。
 */
function rawPandocStdout(input: string): Promise<{ bytes: Buffer; chunks: Buffer[] }> {
  return new Promise((done) => {
    const child = spawn(
      requirePandocExe(),
      ['-f', 'rst', '-t', 'html', '--syntax-highlighting', 'none', resolve(input)],
      { windowsHide: true }
    )
    const chunks: Buffer[] = []
    child.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk))
    child.on('error', () => done({ bytes: Buffer.alloc(0), chunks }))
    child.on('close', () => done({ bytes: Buffer.concat(chunks), chunks }))
  })
}

main()
  .catch((error) => {
    failed += 1
    console.error('\n测试自身抛异常：', error)
  })
  .then(async () => {
    // 同 `test-image-options.ts` 那处：不吞错误，但**别用 `maxRetries`**（实测会让套件挂死）。
    // 实测（2026-09-15）本套件跑完会留下 `.tmp-test-pandoc/`，而残留会被 electron-builder
    // 静默打进 asar（约束 30），所以至少要让它在终端上出一声。
    await rm(TMP, { recursive: true, force: true }).catch((error: NodeJS.ErrnoException) =>
      console.warn(
        `⚠️ 临时目录没删干净（${TMP}）：${error?.code ?? error?.message ?? String(error)}`
      )
    )
    console.log(`\n通过 ${passed}，失败 ${failed}`)
    process.exit(failed > 0 ? 1 : 0)
  })
