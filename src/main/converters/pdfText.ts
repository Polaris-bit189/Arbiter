import { readFile } from 'fs/promises'
import type { CancelToken } from '../core/cancel'
import { ConversionCanceled, ConversionFailed, tailLines } from './common'

/**
 * PDF 文本抽取（`pdf → txt/md`）。
 *
 * 用 pdfjs 的 **legacy build**（`pdfjs-dist/legacy/build/pdf.mjs`），走**动态 import** 加载。
 *
 * 这里**不是**「不用动态 import 就会崩」——实测 Electron 自带的 Node（22.12+）实现了
 * require(esm)，`require()` 一个 .mjs 照样跑得通（`npm run falsify:pdf` 里留了一条诊断变异
 * 盯着这件事，它**不要求翻红**）。选动态 import 是因为它不依赖这个不算老的特性：换到更旧的
 * Electron 上就会 `ERR_REQUIRE_ESM`。何况它在 CJS 里本就是标准语法，还顺带是懒加载——
 * pdfjs 的模块初始化实测约 200 ms，不该让应用启动时就把它付掉。
 *
 * 为什么不用 pdf-lib 抽文本：它能读写 PDF 的结构（合并 / 拆分 / 旋转都用它），
 * 但**不解析内容流**，从里面抽不出一个字。两个库各管一头。
 *
 * 为什么不用 Chromium 打开 PDF 再抓文本：那是渲染进程的活，要绕 IPC 传字节进传出文本，
 * 而 pdfjs 本来就是 Chromium 内置 PDF 阅读器用的那个引擎，直接在主进程跑更短。
 */

type PdfjsModule = typeof import('pdfjs-dist/legacy/build/pdf.mjs')

let cached: Promise<PdfjsModule> | null = null

export function loadPdfjs(): Promise<PdfjsModule> {
  // 只加载一次：pdfjs 的模块初始化实测约 200 ms，批量转 PDF 时不该每份都付一遍
  cached ??= import('pdfjs-dist/legacy/build/pdf.mjs')
  return cached
}

/** pdfjs 给出来的文本片段。只声明我们真正用到的字段，免得依赖它的内部类型 */
interface RawItem {
  str: string
  width: number
  height: number
  /** PDF 的变换矩阵 [a, b, c, d, e, f]，其中 e 是 x、f 是 y（原点在左下，y 向上） */
  transform: number[]
}

/** 从内容流里重建出来的一行 */
export interface ExtractedLine {
  text: string
  /** 行内最大字号，用于判断标题 */
  size: number
  /** 与**上一行**基线的距离（PDF 里上一行的 y 更大）；首行为 0 */
  gap: number
}

/**
 * CJK 字符范围。只用来回答「这里该不该补一个空格」——
 * 拼中文时补空格会得到「这 是 中 文」，而拼英文时不补会得到 `HelloWorld`。
 */
// CJK 部首补充 / 标点 / 假名 / 扩展 A / 基本区 / 兼容汉字 / 全角
const CJK = /[⺀-〿぀-ヿ㐀-䶿一-鿿豈-﫿＀-￯]/

function isCjk(ch: string | undefined): boolean {
  return ch !== undefined && CJK.test(ch)
}

/**
 * 把同一行的片段按 x 排好、拼成一行文本。
 *
 * 补空格的判据刻意保守：间距要明显大于字号（是真词距，不是字距），**且两侧都不是 CJK**。
 * 中文 PDF 的字符之间天然有间距，照着补空格会把整段中文打成散字——这是最容易写错的一处。
 */
function joinLineParts(parts: RawItem[]): string {
  const sorted = [...parts].sort((a, b) => a.transform[4] - b.transform[4])

  let out = ''
  let prevEnd: number | null = null
  let prevSize = 0

  for (const part of sorted) {
    const x = part.transform[4]
    const size = part.height > 0 ? part.height : Math.abs(part.transform[3] ?? 0)

    if (prevEnd !== null && out !== '') {
      const gap = x - prevEnd
      if (gap > Math.max(size, prevSize) * 0.25 && !isCjk(out.at(-1)) && !isCjk(part.str[0])) {
        out += ' '
      }
    }

    out += part.str
    prevEnd = x + part.width
    prevSize = size
  }

  return out.trim()
}

/**
 * 内容流的片段 → 行。
 *
 * 同一行的判据是**基线接近**而不是相等：PDF 里同一行的片段常因上下标、不同字体的
 * 基线微调差上零点几个点，用相等去比会把一行碎成好几行。
 */
function assembleLines(items: RawItem[]): ExtractedLine[] {
  const raw: { y: number; size: number; parts: RawItem[] }[] = []
  let current: (typeof raw)[number] | null = null

  for (const item of items) {
    if (item.str === '') continue

    const y = item.transform[5] ?? 0
    const size = item.height > 0 ? item.height : Math.abs(item.transform[3] ?? 0)

    // 写成「不接近就另起一行」，而不是先算一个 sameLine 布尔量：
    // 后者 TS 窄化不出来，下一行会报 current 可能为 null
    if (current === null || Math.abs(current.y - y) > Math.max(size, current.size) * 0.5) {
      if (current !== null) raw.push(current)
      current = { y, size, parts: [] }
    }

    current.parts.push(item)
    current.size = Math.max(current.size, size)
  }
  if (current !== null) raw.push(current)

  return raw.map((line, index) => ({
    text: joinLineParts(line.parts),
    size: line.size,
    // y 向上，所以上一行的 y 更大；首行没有上一行，给 0
    gap: index === 0 ? 0 : raw[index - 1].y - line.y
  }))
}

/** 抽出一份 PDF 的所有行，外层数组按页切分 */
export async function extractPdfLines(
  input: string,
  cancel: CancelToken
): Promise<ExtractedLine[][]> {
  const pdfjs = await loadPdfjs()
  const buffer = await readFile(input)

  const task = pdfjs.getDocument({
    // 必须是 Uint8Array：给 Buffer 也能跑，但 pdfjs 会持有它的引用不放
    data: new Uint8Array(buffer),
    // 别去翻系统字体：我们只要文本，字形交给谁渲染都行，少一条到处摸文件系统的路径
    useSystemFonts: false
  })

  cancel.onCancel(() => {
    // **必须 catch**：这里是 fire-and-forget，没人 await 这条 promise，它一旦 reject 就是
    // 一条 unhandled rejection，而 Node 默认把它当致命错误——整个主进程当场退出，
    // 用户看到的是「点了个取消，应用没了」。
    //
    // 具体是哪条路径会抛不重要（`pdf.mjs:15581` 的 `destroy()` 里只有
    // `await this._transport?.destroy()` 这一处可能 reject），重要的是**不能赌它不抛**：
    // 取消本来就意味着「此刻状态已经乱了」，而这条 promise 没有任何人能接。
    // `pdfPages.ts` 的 `finally` 是同一个写法。
    void task.destroy().catch(() => undefined)
  })

  try {
    const pdf = await task.promise
    const pages: ExtractedLine[][] = []

    for (let n = 1; n <= pdf.numPages; n += 1) {
      if (cancel.canceled) throw new ConversionCanceled()
      const page = await pdf.getPage(n)
      const content = await page.getTextContent()
      pages.push(assembleLines(content.items as unknown as RawItem[]))
      page.cleanup()
    }

    return pages
  } catch (error) {
    if (cancel.canceled) throw new ConversionCanceled()
    if (error instanceof ConversionCanceled) throw error
    const message = error instanceof Error ? error.message : String(error)
    throw new ConversionFailed(tailLines(message))
  } finally {
    // 成功路径同样要销毁。`data` 是**整份 PDF 的字节**，pdfjs 在 destroy 之前一直持有
    // 它（连同一份解析出来的文档结构），只等 GC 的话，批量把大 PDF 抽成 txt 会把内存
    // 峰值堆到没必要的量级。上面返回的 `pages` 已经是纯字符串，销毁它不会伤到结果。
    //
    // 与取消路径上那次 destroy 撞在一起也没关系：`pdf.mjs:15581` 的 `destroy()` 第二次
    // 调用时 `_worker` / `_transport` 都已被置 null，两个 await 都立刻过去，是幂等的。
    // 形状照抄 `pdfPages.ts` 的 finally。
    await task.destroy().catch(() => undefined)
  }
}

// ------------------------------------------------------------------ 行 → 文本

/** 段落边界之一：行距明显大于行高 */
const PARAGRAPH_GAP = 1.6

/** 段落边界之二：字号与上一行差这么多就另起一段（**标题靠这条**） */
const PARAGRAPH_SIZE_RATIO = 1.15

/**
 * 切成段落。
 *
 * 两个判据缺一不可。只看行距的话标题会被正文吞掉——Chromium 排版出来的 `<h1>` 与
 * 紧接的正文之间的间距**未必**大于 1.6 倍行高，但它们的字号必然差着档次。反过来只看字号
 * 也不行：等宽字号的多段正文之间得靠行距分开。
 *
 * 字号判据是**双向**的：标题变大字要断，标题之后的正文变回小字同样要断，否则
 * `<h1>` 会和它后面的正文连成一段，整段按标题的字号去判级。
 */
function groupParagraphs(lines: ExtractedLine[]): ExtractedLine[][] {
  const out: ExtractedLine[][] = []
  let current: ExtractedLine[] = []

  for (const line of lines) {
    if (line.text === '') continue

    if (current.length > 0) {
      const prev = current[current.length - 1]
      const ref = Math.max(line.size, prev.size)
      const gapBreak = ref > 0 && line.gap > ref * PARAGRAPH_GAP
      const sizeBreak =
        line.size > 0 && prev.size > 0
          ? Math.max(line.size, prev.size) > Math.min(line.size, prev.size) * PARAGRAPH_SIZE_RATIO
          : false

      if (gapBreak || sizeBreak) {
        out.push(current)
        current = []
      }
    }

    current.push(line)
  }
  if (current.length > 0) out.push(current)

  return out
}

/** 段落内的多行连成一句。中文直接接，英文之间补空格——同一套 CJK 判据 */
function joinParagraph(lines: ExtractedLine[]): string {
  let out = lines[0]?.text ?? ''
  for (let i = 1; i < lines.length; i += 1) {
    const next = lines[i].text
    if (!isCjk(out.at(-1)) && !isCjk(next[0])) out += ' '
    out += next
  }
  return out
}

/**
 * 正文的字号基准：取**出现行数最多**的那个字号。
 *
 * 这里**不能用中位数**——实测踩过：一份「一个 h1 + 一行正文 + 一个 h2 + 一行英文」的
 * 短文档（4 行），字号排序后中位数恰好落在 h2 上，于是 h1 被算成「比正文大 1.21 倍」、
 * h2 算成「正好等于正文」，两个标题双双降级成 `###` 和正文。标题的种类再多，
 * 每一种也只占一两行，众数永远是正文——这个判据在长文档里同样成立。
 */
function bodySize(lines: ExtractedLine[]): number {
  const buckets = new Map<number, { size: number; count: number }>()

  for (const line of lines) {
    if (line.size <= 0) continue
    // 量化到 0.1 再分桶：同一个字号在不同片段上可能差出浮点尾数，
    // 直接拿浮点数当 key 会把一个字号拆成好几桶，众数就永远只有 1 票
    const key = Math.round(line.size * 10)
    const bucket = buckets.get(key)
    if (bucket) bucket.count += 1
    else buckets.set(key, { size: line.size, count: 1 })
  }

  let best = 0
  let bestCount = 0
  for (const { size, count } of buckets.values()) {
    // 平局取小的：标题的字号总在更大的那一侧
    if (count > bestCount || (count === bestCount && size < best)) {
      best = size
      bestCount = count
    }
  }

  return best
}

/**
 * 「一页文本都没抽到」的判据，返回可以直接报给用户的若干行；抽到了东西就返回 null。
 *
 * **这条判据的存在理由是「空产物与转换成功长得一模一样」。** 抽出来是空串时，
 * `linesToText` 照样吐一个只有换行的文件、任务照样收成「已成」——用户打开产物看到
 * 一个字都没有，而界面上没有任何地方说得清这是「这份 PDF 没有文本层」还是
 * 「我们抽错了」。本项目最忌讳的就是这一类：`pdf → txt/md` 曾经把 PDF 二进制
 * 当纯文本解出一屏乱码而报告成功（约束 12），这是同一个坑的另一半。
 *
 * 按**文本长度**判而不是按行数：`assembleLines` / `groupParagraphs` 都会产出
 * `text === ''` 的行（纯空白的片段、空白的页），数行数会把它们算成「有内容」。
 *
 * 判据只能到此为止：**一份 PDF 有没有文本层**是能问出来的，而「它是不是扫描件」
 * 问不出来（空白页与扫描页在这里完全同形）。所以文案把两种可能都摆出来，
 * 并明说本项目不含 OCR——不去猜、也不替用户下结论。
 */
export function textlessReason(pages: ExtractedLine[][]): string[] | null {
  let chars = 0
  for (const lines of pages) {
    for (const line of lines) chars += line.text.trim().length
  }
  if (chars > 0) return null

  return [
    `${pages.length} 页里一行文本都没抽到。`,
    '两种可能，这里分不出来：',
    '  1. 这是扫描件 / 图片型 PDF——只有图像、没有文本层。本项目不含 OCR，文字抽不出来。',
    '  2. 这份文档确实是空的。',
    '刻意不写出一个空文件：那样它和「转换成功」在任何人眼里都一模一样。',
    '要拿到里面的文字，先做一次 OCR（或先用本应用把它转成 png/jpg 再另作处理）。'
  ]
}

/** 纯文本：段落之间空一行 */
export function linesToText(pages: ExtractedLine[][]): string {
  const blocks: string[] = []
  for (const lines of pages) {
    for (const para of groupParagraphs(lines)) blocks.push(joinParagraph(para))
  }
  return blocks.join('\n\n') + '\n'
}

/**
 * 标题判级的门槛，相对正文字号（`bodySize`）。
 *
 * 这几个数是**实测**出来的，不是照着 `h1{2em} / h2{1.5em}` 推的——Chromium 打印 PDF
 * 时各字体的 em 归一不一样，实测一份 `<h1>2em + <h2>1.5em + 正文1em` 的文档，
 * 抽出来是 18.697pt / 15.398pt / 10.995pt，相对正文是 **1.70 / 1.40 / 1.00**，
 * 而不是想当然的 2.0 / 1.5 / 1.0。阈值必须照着实测留余量，按 em 值设会全部判错。
 */
const HEADING_LEVELS: { level: string; min: number }[] = [
  { level: '#', min: 1.55 },
  { level: '##', min: 1.3 },
  { level: '###', min: 1.1 }
]

/**
 * markdown：段落之间空一行，字号明显大的段落当标题。
 *
 * 这是**启发式**，不是真正的结构还原——PDF 里根本没有「这是标题」这种信息，
 * 只有字号和位置。所以别指望它总能给出完美的 markdown。
 */
export function linesToMarkdown(pages: ExtractedLine[][]): string {
  const body = bodySize(pages.flat())
  const blocks: string[] = []

  for (const lines of pages) {
    for (const para of groupParagraphs(lines)) {
      const text = joinParagraph(para)
      if (text === '') continue

      const size = Math.max(...para.map((l) => l.size))
      const ratio = body > 0 ? size / body : 1
      const heading = HEADING_LEVELS.find((h) => ratio >= h.min)

      blocks.push(heading ? `${heading.level} ${text}` : text)
    }
  }

  return blocks.join('\n\n') + '\n'
}
