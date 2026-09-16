import { readFile } from 'fs/promises'
import { pathToFileURL } from 'url'
import mammoth from 'mammoth'
import { marked } from 'marked'
import TurndownService from 'turndown'
import { gfm } from 'turndown-plugin-gfm'
import * as XLSX from 'xlsx'

/**
 * 把各种源文档转成一份自包含的 HTML，交给 engines/chromiumPdf.ts 打印。
 *
 * 这一层刻意只用纯 JS 库（marked / mammoth / SheetJS），不引任何外部二进制：
 * 它们解析的都是公开的文件格式，没有一处需要原生代码，装了就能离线用。
 */

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * 打印用的基础样式。
 *
 * 「注入中文字体栈」这条是必须的：Chromium 的默认 serif/sans-serif 在 Windows 上
 * 落到 Times New Roman 一类不含 CJK 字形的字体上，中文会渲染成一个个方框（tofu）。
 * 把微软雅黑排在前面就绕开了这个问题，而且这些都是系统自带字体，不需要联网。
 */
const BASE_CSS = `
:root { color-scheme: light; }
html, body { margin: 0; padding: 0; }
body {
  font-family: "Microsoft YaHei", "微软雅黑", "PingFang SC", "Hiragino Sans GB",
               "Source Han Sans SC", "Noto Sans CJK SC", "Segoe UI", "Helvetica Neue", Arial, sans-serif;
  font-size: 11pt;
  line-height: 1.7;
  color: #1a1a1a;
  /* 背景色/表格底色要打出来，默认会被省掉，条纹表和代码块底色全没了 */
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}
pre, code, kbd, samp {
  font-family: "Cascadia Mono", Consolas, "Courier New", "Microsoft YaHei", monospace;
}
pre {
  /* 长行必须折行：代码块不折行的话会被纸张右边裁掉，且不产生任何提示 */
  white-space: pre-wrap;
  word-wrap: break-word;
  background: #f6f8fa;
  padding: 10px 12px;
  border-radius: 4px;
  font-size: 9.5pt;
  line-height: 1.5;
}
code { background: #f0f2f4; padding: 1px 4px; border-radius: 3px; font-size: 0.92em; }
pre code { background: none; padding: 0; font-size: inherit; }
table { border-collapse: collapse; width: 100%; font-size: 9.5pt; }
th, td { border: 1px solid #c9ced6; padding: 4px 8px; text-align: left; vertical-align: top; }
th { background: #f0f2f5; font-weight: 600; }
/* 长表格跨页时表头要重复，否则第二页开始就是一堆没有列名的数字 */
thead { display: table-header-group; }
tr { break-inside: avoid; }
img { max-width: 100%; height: auto; }
blockquote { margin: 0.8em 0; padding: 0.1em 1em; border-left: 3px solid #d0d7de; color: #57606a; }
h1, h2, h3, h4, h5, h6 { line-height: 1.3; margin: 1.2em 0 0.5em; break-after: avoid; }
h1 { font-size: 1.7em; }
h2 { font-size: 1.4em; }
h3 { font-size: 1.15em; }
/* 长链接不该撑破页面 */
a { color: #0b5cad; word-break: break-all; }
hr { border: none; border-top: 1px solid #d8dee4; margin: 1.4em 0; }
`

export interface WrapOptions {
  title: string
  /** 相对资源（图片、样式）的基准目录。写临时 HTML 时源文件不在旁边，靠它兜住 */
  baseDir?: string
}

/**
 * `<base href>` 的构造。
 *
 * 这条在两条装配路径（`wrapHtml` 与 `injectBaseStyle`）上都是**承重的**，不是装饰：
 * 我们交给 Chromium 的 HTML 一律写在系统临时目录里（`printToPDF` 走 `loadFile`，
 * 只能喂真实文件路径），而源文件在别处。`<img src="pic.png">` 这种相对路径因此
 * 会拿**临时目录**去解析，结果是**静默画一个破图占位**——PDF 照常生成、页数照常对、
 * 转换报成功，只有那张图变成了一个 14x16 的小方块（实测就是这个尺寸）。
 *
 * 尾部那个斜杠不能省：没有它，`file:///d:/a` 会被当成一个**文件**，同级资源全部落空。
 * 返回的是给 HTML 用的字符串，所以 `&` 之类要走转义。
 */
function baseTagFor(baseDir?: string): string {
  if (!baseDir) return ''
  return `<base href="${escapeHtml(pathToFileURL(baseDir + '/').href)}">`
}

export function wrapHtml(body: string, options: WrapOptions): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
${baseTagFor(options.baseDir)}<title>${escapeHtml(options.title)}</title>
<style>${BASE_CSS}</style>
</head>
<body>
${body}
</body>
</html>`
}

/**
 * 给用户自己的 HTML 注入基础样式与 `<base>`。
 *
 * 注入的 style 放在 `<head>` 的**最前面**，于是用户自己的样式能覆盖它——
 * 他要的排版说了算，我们只负责兜住「中文变方框」这类默认值的坑。
 *
 * `baseDir` 与 `wrapHtml` 的 `baseDir` 是同一个东西、同一个理由（见 `baseTagFor`）。
 * 这条路径**漏过一次**：html 源是原样返回的完整文档，不套我们的模板，于是所有相对
 * 路径插图都拿临时目录去解析，静默变成破图占位——而 markdown 那条路一直是对的，
 * 差分测不出另一条路的问题（现在 `test-pdf.ts` 的 [6] 两条路都盯着了）。
 *
 * 用户自己写了 `<base>` 时不重复注入：一份文档里只有第一个 `<base>` 生效，
 * 塞第二个进去只会让人以为是我们在覆盖他的设置。
 */
export function injectBaseStyle(html: string, baseDir?: string): string {
  const injected = `${/<base[\s/>]/i.test(html) ? '' : baseTagFor(baseDir)}<style>${BASE_CSS}</style>`

  const head = /<head[^>]*>/i.exec(html)
  if (head) {
    const at = head.index + head[0].length
    return html.slice(0, at) + injected + html.slice(at)
  }

  const htmlTag = /<html[^>]*>/i.exec(html)
  if (htmlTag) {
    const at = htmlTag.index + htmlTag[0].length
    return html.slice(0, at) + `<head>${injected}</head>` + html.slice(at)
  }

  // 片段（没有 html/head 标签）：直接包一层
  return wrapHtml(html, { title: 'document', baseDir })
}

/**
 * 按 BOM 和实际字节判断编码后解码文本。
 *
 * 为什么不能直接 readFile(path, 'utf8')：Windows 上的 Excel 导出 CSV 默认用
 * **GBK/GB18030**，按 UTF-8 解会得到满屏乱码——而且不报错，静默出错。
 * 中文用户手里这种文件一大把。
 */
export function decodeTextFile(buffer: Buffer): string {
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return buffer.subarray(3).toString('utf8')
  }
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(buffer.subarray(2))
  }

  // 先按 UTF-8 严格解。多字节序列不合法时 decoder 会抛，正好当作「这不是 UTF-8」的判据。
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer)
  } catch {
    // 不是 UTF-8 就按 GB18030 解。它对 ASCII 完全兼容，解错了也只会退化成个别怪字，
    // 不会像反过来那样整篇乱码。
    try {
      return new TextDecoder('gb18030').decode(buffer)
    } catch {
      return buffer.toString('utf8')
    }
  }
}

/** 纯文本：原样进 `<pre>`，只做转义，连空格和换行都保留 */
export function textToHtml(text: string): string {
  return `<pre>${escapeHtml(text)}</pre>`
}

/** markdown（含 rst 退化处理）→ HTML */
export async function markdownToHtml(markdown: string): Promise<string> {
  return await marked.parse(markdown, { gfm: true, breaks: false })
}

/** docx → HTML。mammoth 只取正文语义（标题/列表/表格），不还原 Word 的像素级排版 */
export async function docxToHtml(path: string): Promise<string> {
  const result = await mammoth.convertToHtml({ path })
  return result.value
}

/**
 * xlsx / csv → HTML 表格。
 *
 * 自己按二维数组拼表，而不是用 SheetJS 的 `sheet_to_html`：后者吐的是一整个自带
 * 内联样式的 HTML 文档，塞进我们的模板里会打一场样式官司，而且内联样式覆盖不掉。
 */
export async function sheetToHtml(path: string, ext: string): Promise<string> {
  const buffer = await readFile(path)
  // csv 走自己的解码，避开 GBK 乱码；xlsx 是二进制包，交给 SheetJS 自己认
  const workbook =
    ext === 'csv'
      ? XLSX.read(decodeTextFile(buffer), { type: 'string' })
      : XLSX.read(buffer, { type: 'buffer' })

  const parts: string[] = []

  for (const name of workbook.SheetNames) {
    const sheet = workbook.Sheets[name]
    if (!sheet) continue

    const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
      header: 1,
      blankrows: false,
      defval: ''
    })

    // 多个工作表时给每张加个标题。只有一张就不加——多一行没用的字而已
    if (workbook.SheetNames.length > 1) {
      parts.push(`<h2>${escapeHtml(name)}</h2>`)
    }

    if (rows.length === 0) {
      parts.push('<p><em>（空表）</em></p>')
      continue
    }

    const [head, ...rest] = rows
    const cell = (v: unknown, tag: 'th' | 'td'): string =>
      `<${tag}>${escapeHtml(v === null || v === undefined ? '' : String(v))}</${tag}>`

    parts.push(
      '<table>' +
        '<thead><tr>' +
        (head ?? []).map((v) => cell(v, 'th')).join('') +
        '</tr></thead><tbody>' +
        rest.map((row) => `<tr>${(row ?? []).map((v) => cell(v, 'td')).join('')}</tr>`).join('') +
        '</tbody></table>'
    )
  }

  return parts.join('\n') || '<p><em>（空工作簿）</em></p>'
}

/**
 * 图片 → 一页 HTML。
 *
 * `displayWidth` 是**排版算好的展示宽度**（CSS 像素），由调用方按纸张内容框等比算出来；
 * 这里只管把它写进样式。高度交给 `height: auto` 按原图宽高比推，免得两处算得不一致
 * 把图拉变形。路径用绝对 file://，不依赖 `<base>`。
 */
export function imageToHtml(imagePath: string, displayWidth: number): string {
  const src = escapeHtml(pathToFileURL(imagePath).href)
  const style = `
    body { margin: 0; }
    img { display: block; margin: 0 auto; width: ${Math.round(displayWidth)}px; height: auto; }
  `
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<style>${BASE_CSS}${style}</style>
</head>
<body>
<img src="${src}" alt="">
</body>
</html>`
}

// ---------------------------------------------------------------- HTML → 文本

/**
 * HTML 实体表。只列 marked / mammoth 真会吐出来的那些，不做完整 HTML5 实体表
 * （那张表有两千多项，而这里能遇到的来源只有这两个库）。
 */
const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  middot: '·',
  times: '×',
  copy: '©'
}

/**
 * 数值实体必须**卡上界**。
 *
 * `String.fromCodePoint` 对超出 U+10FFFF 的码位**抛 RangeError**，而原来的判据只有
 * `code > 0`——`&#x110000;` 这种就一路抛到底，把一次 txt 导出变成一条
 * 「Invalid code point 1114112」的失败。而 markdown 源里的数值实体是**原样穿过**
 * marked 的（它只转义「看起来不像实体」的 `&`），所以这条是用户文档能真实触发的。
 * 超界时按原文留着，比抛出去合理：那不是我们能解释的东西，但也不该让整次转换失败。
 */
function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, body: string) => {
    if (body[0] === '#') {
      const hex = body[1] === 'x' || body[1] === 'X'
      const code = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10)
      // 上界是 Unicode 的硬上限，代理区（0xD800-0xDFFF）不算错、留着即可
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : whole
    }
    return ENTITIES[body.toLowerCase()] ?? whole
  })
}

/**
 * HTML → 纯文本。
 *
 * 块级标签的闭合位置换行，其余标签直接剥掉，最后解一次实体。
 * 这是给「导出成 txt 看」用的，不需要精确还原排版，只要不把段落粘成一坨。
 */
export function htmlToText(html: string): string {
  const body = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html)?.[1] ?? html

  const text = body
    // script/style 的内容是代码不是正文，必须整块删掉而不是剥标签
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|tr|blockquote|pre|section|article)>/gi, '\n')
    .replace(/<[^>]+>/g, '')

  return decodeEntities(text)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

let turndown: TurndownService | null = null

/**
 * HTML → Markdown。
 *
 * `gfm` 插件必须装：turndown 的内置规则里**没有表格**，不装的话 Word 文档里的表格
 * 会被整张静默丢掉，只剩一堆挤在一起的单元格文字。
 *
 * 实例缓存在模块级：TurndownService 构造时要建一整棵规则树，而它本身是无状态的，
 * 每个任务重建一遍纯属浪费。
 */
export function htmlToMarkdown(html: string): string {
  if (!turndown) {
    turndown = new TurndownService({
      headingStyle: 'atx',
      codeBlockStyle: 'fenced',
      bulletListMarker: '-',
      emDelimiter: '*'
    })
    turndown.use(gfm)
  }
  return turndown.turndown(html)
}

/**
 * xlsx / csv → 分隔符文本。
 *
 * 多工作表时**只导出第一张**：CSV 这种格式根本没有「第二张表」的概念，
 * 硬塞进去只能得到一份谁也不敢用的拼接文件。
 */
export async function sheetToDelimited(
  input: string,
  fromExt: string,
  fs: string
): Promise<string> {
  const buffer = await readFile(input)
  const workbook =
    fromExt === 'csv'
      ? XLSX.read(decodeTextFile(buffer), { type: 'string' })
      : XLSX.read(buffer, { type: 'buffer' })

  const first = workbook.SheetNames[0]
  const sheet = first ? workbook.Sheets[first] : undefined
  if (!sheet) return ''

  return XLSX.utils.sheet_to_csv(sheet, { FS: fs })
}
