import { mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import mammoth from 'mammoth'
import sharp from 'sharp'
import { categoryOf } from '@shared/formats'
import { baseNameOf, partPathOf } from '../core/outputName'
import type { CancelToken } from '../core/cancel'
import { decodeHeif } from './heic'
import { normalizeToPng } from './image'
import {
  decodeTextFile,
  docxToHtml,
  htmlToMarkdown,
  htmlToText,
  imageToHtml,
  injectBaseStyle,
  markdownToHtml,
  sheetToDelimited,
  sheetToHtml,
  textToHtml,
  wrapHtml
} from './htmlSource'
import { normalizeEncoding, pandocCommonArgs, readerFor, runPandocCli } from './pandocRun'
import { extractPdfLines, linesToMarkdown, linesToText, textlessReason } from './pdfText'
import { renderPdfPages } from './pdfPages'
import {
  ConversionCanceled,
  ConversionFailed,
  finalizeOutput,
  removeQuietly,
  tailLines,
  type ConvertContext
} from './common'

/**
 * 纯 JS / Chromium 文档引擎（能力矩阵里的 `'pdf'` 这个 key）。
 *
 * 覆盖的转换全部不需要任何外部二进制：
 *   - `md/txt/html/rst/docx/xlsx/csv → pdf`：解析成 HTML，交给 Electron 自带的 Chromium 打印
 *   - `md/txt/html/docx → html/md/txt`：纯文本层面的互转
 *   - `xlsx/csv → csv`：SheetJS 直接写
 *
 * 只有 `doc/xls/ppt/odt → 任意` 和 `→ docx`（跨标记语言）才真的需要 LibreOffice / pandoc，
 * 那两个走各自的适配器。这条边界就是计划里「用 Chromium 干掉一半 LibreOffice 需求」的落点。
 */

/** 单张图片的解码上限，与 converters/image.ts 保持一致，防止超大图把内存吃干 */
const MAX_PIXELS = 512 * 1024 * 1024

/**
 * Chromium 的 `<img>` 直接认得的格式。
 *
 * 不在这张表里的（tiff / heic / …）必须先由我们自己转成 PNG 再交给它——
 * 否则 Chromium 渲染成一个破图图标，而**转换本身会「成功」**，产出一页空白 PDF。
 * 这类静默出错是文档转换里最难归因的一种。
 */
const CHROMIUM_IMG = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif', 'bmp', 'svg', 'ico'])

/** CSS 的绝对单位：1 英寸 = 96 CSS 像素。printToPDF 按同样比例换算到 PDF 点 */
const CSS_PX_PER_INCH = 96

/** A4 尺寸（英寸），转成 CSS 像素供排版计算 */
const A4_SHORT_IN = 8.27
const A4_LONG_IN = 11.69

interface RenderPlan {
  /** 交给 Chromium 打印的完整 HTML 文档 */
  html: string
  landscape: boolean
  marginInch: { top: number; bottom: number; left: number; right: number }
}

const DEFAULT_MARGIN = { top: 0.71, bottom: 0.71, left: 0.63, right: 0.63 }
const IMAGE_MARGIN = { top: 0.4, bottom: 0.4, left: 0.4, right: 0.4 }

// ------------------------------------------------------------------ 源 → HTML

/**
 * 把「读源文件」这一步的异常翻译成**归因正确**的 `ConversionFailed`。
 *
 * 为什么需要它（审计 2026-09-15 §3.3，本机实测）：给一个内容不是 zip 的 `.docx`，
 * mammoth / JSZip 的原始异常会**未经包装**地逃到顶层，于是 MCP 侧把它归成
 * `internal` + `retryable: true`，`message` 是一句英文
 * `Can't find end of central directory : is this a zip file ?` 外加一个 jszip 文档链接。
 * 三处都不对：**档位**错（CLI 的退出码表里那是 exit 4「我们没预料到的异常，值得原样重试」，
 * 而它完全可预料、重试必然一样）、`retryable` 会真的把 agent 送去重试一个确定性失败、
 * **文案**是英文且把一个中文界面的用户指向第三方库的文档。实测同一族的还有
 * 「截断的 `.xlsx`」→ `Unsupported ZIP file`。
 *
 * 两条必须记住的：
 *
 * - **只包「读源文件」这一段，不是把整个 `runDocument` 包起来。** 毯式包装会让我们自己的
 *   代码 bug（比如排版逻辑里的 `TypeError`）也伪装成 `source_corrupt`——那是**反方向**的
 *   同类错误归属：把该归我们的账算到用户的源文件头上，而用户会去查一个无辜的文件。
 *   所以被包住的是 `run()` 而不是 `runDocument()`，四个读点各自接一次。
 * - **`ConversionFailed` 与 `ConversionCanceled` 原样放行。** 前者是下面几条链路自己抛的
 *   （例如「读不出图片尺寸，无法排版」），已经归好类；后者是用户主动取消，不是失败。
 *   多包一层会把取消也报成「源文件损坏」。
 *
 * ⚠️ **有一条刻意不归这里管**：源文件是**合法的** zip、但内容确实是空的——全零的 `.xlsx`
 * 会被 SheetJS 解析成一屏空白并**报告成功**（实测 2026-09-15）。那是「静默成功」而不是
 * 「错误归因」，属于约束 28 那一族，要单独决策。
 *
 * 验收在 `scripts/test-cli.ts` 的 `[10]`：两条出口（`docx → txt` 走 `extractRawText`
 * 那条直通车、`docx → html` 走 `htmlFragmentOf`）各测一次，外加一个合法 CSV 当对照组
 * ——只测一条出口等于只测一个调用点。
 */
async function readSourceOrFail<T>(
  input: string,
  fromExt: string,
  run: () => Promise<T>
): Promise<T> {
  try {
    return await run()
  } catch (error) {
    if (error instanceof ConversionFailed || error instanceof ConversionCanceled) throw error
    const message = error instanceof Error ? error.message : String(error)
    throw new ConversionFailed(
      [
        `读不出这个 .${fromExt} 文件的内容：它可能已损坏，或者内容根本不是 .${fromExt}`,
        `原始报错：${message}`,
        '请确认这个文件在别的程序里能正常打开；如果它是刚下载或刚传输过来的，重新获取一份再试',
        `文件路径：${input}`
      ],
      `读不出这个 .${fromExt} 文件的内容（它可能已损坏，或者内容根本不是 .${fromExt}）`
    )
  }
}

/**
 * 源文件 → HTML 片段。
 *
 * `rst` 交给 pandoc 解析（见 `rstToHtmlFragment`）。这里曾经是「RST 的语法设计目标之一
 * 就是源码本身可读，原样当纯文本渲染」——理由说得通，后果是 `documentTargets('rst')`
 * 宣称的四个出口（html / md / txt / pdf）全都输出一坨源码，界面能选、结果不是那么回事。
 * pandoc 本来就在包里（`rst → docx` 就是它做的），没有理由继续降级。
 */
async function htmlFragmentOf(
  input: string,
  fromExt: string,
  cancel: CancelToken
): Promise<string> {
  switch (fromExt) {
    case 'docx':
      return await readSourceOrFail(input, fromExt, () => docxToHtml(input))
    case 'xlsx':
    case 'csv':
      return await readSourceOrFail(input, fromExt, () => sheetToHtml(input, fromExt))
    case 'md':
    case 'markdown':
      return await markdownToHtml(decodeTextFile(await readFile(input)))
    case 'html':
    case 'htm':
      // 完整文档，不再套模板
      return decodeTextFile(await readFile(input))
    case 'rst':
      return await rstToHtmlFragment(input, cancel)
    case 'pdf':
      // 走到这里说明调用方没走上面那条 pdf 直通车。**宁可报错**——这里原来落到
      // default 分支，PDF 二进制被 decodeTextFile 当纯文本读出一屏乱码，
      // 而转换报告成功（约束 12 记的就是这个洞）。
      throw new ConversionFailed([`PDF 请走文本提取通道：${input}`])
    default:
      // txt / 其他纯文本
      return textToHtml(decodeTextFile(await readFile(input)))
  }
}

/**
 * RST → HTML 片段，靠 pandoc。
 *
 * 这给 rst 的四个出口引入了对 pandoc.exe 的**硬依赖**：没跑过 `fetch-pandoc.mjs` 时
 * 它们会直接报错，而不是像以前那样降级出一页源码。这是有意的——降级产物看起来
 * 「转换成功」，比一句明确的「缺引擎」难归因得多（约束 12 那一类静默出错）。
 *
 * 临时目录只为 GBK 输入而建：本来就是 UTF-8 时 `normalizeEncoding` 不落任何文件。
 */
async function rstToHtmlFragment(input: string, cancel: CancelToken): Promise<string> {
  const reader = readerFor('rst')
  if (!reader) {
    throw new ConversionFailed(['pandoc 的 reader 表里没有 rst'])
  }

  const tempDir = await mkdtemp(join(tmpdir(), 'msg-rst-'))
  try {
    const srcPath = await normalizeEncoding(input, 'rst', tempDir)
    const { stdout } = await runPandocCli(
      [srcPath, '-f', reader, '-t', 'html', ...pandocCommonArgs(dirname(input))],
      cancel
    )
    return stdout
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
  }
}

/**
 * 图片 → 一页 HTML。
 *
 * 之所以不肯把原文件直接丢给 Chromium：它对 TIFF 和 HEIC 都不会解码，而失败方式是
 * 「渲染成破图、转换照样成功」。所以凡是不在 CHROMIUM_IMG 白名单里的一律先转 PNG。
 */
async function imagePlan(
  input: string,
  fromExt: string,
  tempDir: string,
  cancel: CancelToken
): Promise<RenderPlan> {
  // bmp / ico 连 sharp 都读不了（见 `SHARP_UNREADABLE_SRC`），先让 ffmpeg 解成 PNG。
  // **这一步必须排在量尺寸之前**：原先那句 `sharp(input).metadata()` 对这两个格式
  // 直接抛 `Input file contains unsupported image format`，于是 `bmp → pdf` 这一格
  // 虽然登记在册、虽然 Chromium 自己就能画 BMP，却永远走不到。
  const normalized = await normalizeToPng(input, fromExt, tempDir, cancel)
  const source = normalized ?? input

  const meta = await sharp(source, { failOn: 'none', limitInputPixels: MAX_PIXELS }).metadata()
  if (!meta.width || !meta.height) {
    throw new ConversionFailed([`读不出图片尺寸，无法排版：${input}`])
  }

  // EXIF orientation 5-8 表示「显示时要旋转 90°」，宽高要跟着对调，
  // 否则横竖屏判断会反，一张竖拍的照片会被排成横向纸张再缩得很小。
  const swapped = (meta.orientation ?? 1) >= 5
  const width = swapped ? meta.height : meta.width
  const height = swapped ? meta.width : meta.height

  let srcPath = source

  if (fromExt === 'heic' || fromExt === 'heif') {
    // libheif 已经按容器的 irot 摆正了方向，这里不能再 rotate()（见约束 6）
    const pixels = await decodeHeif(input, { width: meta.width, height: meta.height })
    srcPath = join(tempDir, 'page.png')
    await sharp(pixels.data, {
      raw: { width: pixels.width, height: pixels.height, channels: 4 }
    })
      .png()
      .toFile(srcPath)
  } else if (normalized) {
    // 已经是刚解出来的 PNG：Chromium 认得上，方向也没什么好转的（BMP/ICO 没有 EXIF）
  } else if (!CHROMIUM_IMG.has(fromExt)) {
    // orientation 还没被 Chromium 应用（它只对原文件生效），这里得自己转正
    srcPath = join(tempDir, 'page.png')
    await sharp(input, { failOn: 'none', limitInputPixels: MAX_PIXELS })
      .rotate()
      .png()
      .toFile(srcPath)
  }

  const landscape = width > height
  const margin = IMAGE_MARGIN

  // 按纸张内容框等比缩放。**不放大**：把一张 200px 的图标拉伸到整页只会得到一团马赛克，
  // 小图保持原尺寸居中反而更清楚。
  const availW = (landscape ? A4_LONG_IN : A4_SHORT_IN) * CSS_PX_PER_INCH - margin.left * 2 * 96
  const availH = (landscape ? A4_SHORT_IN : A4_LONG_IN) * CSS_PX_PER_INCH - margin.top * 2 * 96
  const scale = Math.min(availW / width, availH / height, 1)

  return {
    html: imageToHtml(srcPath, width * scale),
    landscape,
    marginInch: margin
  }
}

/** 文档 → 待打印的 HTML。宽表横向排，否则列稍多一点就被挤成一条竖线 */
async function documentPlan(
  input: string,
  fromExt: string,
  cancel: CancelToken
): Promise<RenderPlan> {
  const fragment = await htmlFragmentOf(input, fromExt, cancel)
  const isHtmlSrc = fromExt === 'html' || fromExt === 'htm'
  const wide = fromExt === 'xlsx' || fromExt === 'csv'

  return {
    landscape: wide,
    marginInch: DEFAULT_MARGIN,
    // 两条路都必须带上源文件目录，理由见 `baseTagFor`：HTML 是原样返回的完整文档，
    // 但它同样被写进临时目录再由 Chromium 加载，相对路径插图一样会落空。
    html: isHtmlSrc
      ? injectBaseStyle(fragment, dirname(input))
      : wrapHtml(fragment, { title: baseNameOf(input), baseDir: dirname(input) })
  }
}

// -------------------------------------------------------------------- 落盘

/**
 * 写文本产物。
 *
 * `bom` 只给 CSV 开：Excel 读不带 BOM 的 UTF-8 CSV 会按系统 ANSI 码页解，
 * 中文全变乱码——而且是在 Excel 那一侧出错，用户只会认为是我们的问题。
 */
async function writeText(
  output: string,
  text: string,
  canceled: () => boolean,
  bom = false
): Promise<void> {
  const tempPath = partPathOf(output)
  try {
    await writeFile(tempPath, bom ? '﻿' + text : text, 'utf8')
  } catch (error) {
    await removeQuietly(tempPath)
    const message = error instanceof Error ? error.message : String(error)
    throw new ConversionFailed(tailLines(message))
  }

  if (canceled()) {
    await removeQuietly(tempPath)
    throw new ConversionCanceled()
  }
  await finalizeOutput(tempPath, output)
}

// -------------------------------------------------------------------- 入口

/**
 * 文档转换入口（能力矩阵里 `'pdf'` 这个引擎）。
 *
 * 所有中间产物都写在一次性的临时目录里，离开时整个删掉——包括那条
 * 「HEIC 先解成 PNG」的中间文件，绝不在用户的源文件旁边留东西。
 */
export async function runDocument(context: ConvertContext): Promise<void> {
  const { input, output, fromExt, toExt, cancel, onProgress } = context
  const tempDir = await mkdtemp(join(tmpdir(), 'msg-doc-'))
  const isCanceled = (): boolean => cancel.canceled

  try {
    if (toExt === 'pdf') {
      onProgress({ kind: 'indeterminate', stage: '排版中…' })

      const plan =
        categoryOf(fromExt) === 'image'
          ? await imagePlan(input, fromExt, tempDir, cancel)
          : await documentPlan(input, fromExt, cancel)

      // 渲染开始**之前**先兑现一次取消请求。`printToPDF` 一旦开始就无法从中间打断
      // （与 sharp 同一取舍，见 converters/image.ts 里那段说明），所以能省下工作量的
      // 只有动手之前这一段。
      //
      // ⚠️ 检查放在这里、而不是 `engines/chromiumPdf` 里，是因为**错误归属**：下面那个
      // catch 会把 chromiumPdf 抛出来的一切包成 `ConversionFailed`，于是一次用户主动
      // 取消会在界面上显示成「转换失败」。这个模块认得 `ConversionCanceled`，那一层不认得。
      if (isCanceled()) throw new ConversionCanceled()

      onProgress({ kind: 'indeterminate', stage: '生成 PDF…' })

      const tempPath = partPathOf(output)
      // HTML 必须先落成真实文件：renderHtmlFileToPdf 走的是 loadFile，
      // 喂它一段 HTML 字符串会被当成路径去找（而且报的是「找不到文件」这种误导性错误）。
      // 放临时目录里而不是源文件旁边，靠 wrapHtml 注入的 <base> 兜住相对路径的插图。
      const htmlPath = join(tempDir, 'page.html')
      try {
        await writeFile(htmlPath, plan.html, 'utf8')
        // **按需加载**：chromiumPdf 是 electron 的（隐藏 BrowserWindow + printToPDF），
        // 而这个模块在 MCP 那条线上是要跑的——pdf → txt/md/png/jpg 四个出口全在这里，
        // 只有 HTML 出口才需要 Chromium。静态 import 会让「pdf 转文本」也拖着一个
        // 必须活在 Electron 里的模块。
        const { renderHtmlFileToPdf } = await import('../engines/chromiumPdf')
        await renderHtmlFileToPdf(htmlPath, tempPath, {
          landscape: plan.landscape,
          marginInch: plan.marginInch
        })
      } catch (error) {
        await removeQuietly(tempPath)
        const message = error instanceof Error ? error.message : String(error)
        throw new ConversionFailed(tailLines(message))
      }

      // printToPDF 一旦开始就无法从中间打断，只能在落盘前确认一次取消状态，
      // 保证取消后不会把半成品搬成正式文件（与 converters/image.ts 同一策略）。
      if (isCanceled()) {
        await removeQuietly(tempPath)
        throw new ConversionCanceled()
      }
      await finalizeOutput(tempPath, output)
      onProgress({ kind: 'determinate', percent: 1 })
      return
    }

    onProgress({ kind: 'indeterminate', stage: '解析文档…' })

    // 这几条有直通车，不必绕 HTML 一圈，绕了反而会丢信息
    // （mammoth 的 extractRawText 比「转 HTML 再剥标签」干净得多）
    if (fromExt === 'docx' && toExt === 'txt') {
      const raw = await readSourceOrFail(input, fromExt, () =>
        mammoth.extractRawText({ path: input })
      )
      return await writeText(output, raw.value, isCanceled)
    }
    if (fromExt === 'pdf' && (toExt === 'txt' || toExt === 'md')) {
      onProgress({ kind: 'indeterminate', stage: '提取文本…' })
      const pages = await extractPdfLines(input, cancel)
      // 一个字都没抽到时**必须报错，不能写出一个空文件**：空文件与「转换成功」在
      // 调用方眼里完全同形（扫描件那条路，见 `textlessReason`）。
      const textless = textlessReason(pages)
      if (textless) throw new ConversionFailed(textless)

      const text = toExt === 'md' ? linesToMarkdown(pages) : linesToText(pages)
      return await writeText(output, text, isCanceled)
    }
    if (fromExt === 'pdf' && (toExt === 'png' || toExt === 'jpg')) {
      return await renderPdfPages(context)
    }
    if ((fromExt === 'xlsx' || fromExt === 'csv') && toExt === 'csv') {
      const text = await readSourceOrFail(input, fromExt, () =>
        sheetToDelimited(input, fromExt, ',')
      )
      return await writeText(output, text, isCanceled, true)
    }

    const fragment = await htmlFragmentOf(input, fromExt, cancel)

    if (toExt === 'html') {
      const html =
        fromExt === 'html' || fromExt === 'htm'
          ? injectBaseStyle(fragment, dirname(input))
          : wrapHtml(fragment, { title: baseNameOf(input), baseDir: dirname(input) })
      return await writeText(output, html, isCanceled)
    }

    onProgress({ kind: 'indeterminate', stage: '转换中…' })

    if (toExt === 'md') {
      return await writeText(output, htmlToMarkdown(fragment), isCanceled)
    }
    if (toExt === 'txt') {
      return await writeText(output, htmlToText(fragment), isCanceled)
    }

    throw new ConversionFailed([`不支持的文档转换：${fromExt} → ${toExt}`])
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
  }
}
