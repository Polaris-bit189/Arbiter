import { readFile, mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { extOf } from '@shared/formats'
import { convert, ConversionCanceled, ConversionFailed } from '../main/converters'
import { CancelToken } from '../main/core/cancel'
import { McpToolError } from './errors'
import { assertEngineReady } from './jobs'
import { resolveReadPlan, type ReadPlan } from './readPlan'
import { MAX_READ_CHARS, type ReadFormat } from './schema'

/**
 * `read_document` 的**执行层**：把 `readPlan.ts` 定下来的做法真的跑一遍，
 * 再把结果按 `offset` / `max_chars` 切好。
 *
 * ## 三件必须做对的事
 *
 * 1. **中间产物只落系统临时目录，而且两条路径上都要删干净。**
 *    绝不写用户的输出目录——否则用户每问一次「这文件写了啥」，他的输出目录里就多一个
 *    `.md`（`outputDirFor()` 是给别人用的，这里一次都不调）。临时目录用 `finally` 收，
 *    失败路径与成功路径走的是同一个 `finally`。
 *
 * 2. **截断是显式的、可续读的。** `text.length <= max_chars` 由 `slice` 保证，
 *    `total_chars` 报的是**整个正文**的长度（不是这一段的），`truncated` 只回答
 *    「offset + 这一段之后还有没有」。少任何一项，agent 都会以为它读完了全文。
 *
 * 3. **「应当有内容却是空」必须说出来。** 抽出来是空串时，它和「这份文档确实是空的」
 *    在调用方眼里完全一样。PDF 那一路由 `textlessReason` 判（并**抛错**，见 `readPdfText`），
 *    其余格式在这里补一条 `warnings`——这是文字判断，不做成错误：一份真的空的 docx
 *    本来就该读成空。
 *
 * ⚠️ **本模块跑在没有 Electron 的进程里**（约束 19）。它 import 的
 * `converters/index.ts` 是**按需加载**各引擎的，`pdfText` / `common` 也都不碰 electron——
 * 别在这里加任何一个静态 import 到 `engines/`。
 */

/** 临时目录名的前缀。`scripts/test-mcp-server.ts` 靠它数「有没有残留」。 */
export const TEMP_PREFIX = 'arbiter-read-'

export interface ReadResult {
  /** 从 `offset` 开始、最多 `max_chars` 个字符的正文 */
  text: string
  /** **整个正文**的长度（不是 text 的长度），续读时拿它判「读完了没有」 */
  total_chars: number
  /** true = `offset + text.length` 之后还有内容，用 offset 接着读 */
  truncated: boolean
  /** 这次实际给出的形态。**以它为准**，未必等于调用方传的那个 */
  format: ReadFormat
  /** 源文件自己的扩展名（小写、不带点） */
  source_format: string
  /** 有话说时才出现：回落到了别的形态、max_chars 被夹、正文是空的…… */
  warnings?: string[]
}

/**
 * 读一个文件的字节当成文本。
 *
 * `decodeTextFile` **必须复用**（约束 13）：Windows 上 Excel 导出的 CSV 默认是
 * GBK，按 UTF-8 硬解会得到满屏乱码**且不报错**；反过来，导出的 CSV 我们还主动写了
 * BOM，读回来得剥掉。这套「BOM → 严格 UTF-8 → GB18030 兜底」的判据只有一份，
 * 在这里抄一份就是给自己留一个将来会漂移的副本。
 *
 * 静态 import 它会把 `htmlSource` 那一整串（mammoth / xlsx / marked / turndown）
 * 拖进 MCP 进程的启动路径，而绝大多数会话一次都不会用到这个工具。所以按需加载
 * （与 `converters/index.ts` 对引擎的做法同一个理由）。**这不是「不这样就崩」**——
 * 纯粹的启动开销取舍。
 */
async function readAsText(path: string): Promise<string> {
  const { decodeTextFile } = await import('../main/converters/htmlSource')
  return decodeTextFile(await readFile(path))
}

/**
 * PDF → 文本。
 *
 * **不走 `convert()`**：`document.ts` 那条路会把文本写进产物文件再交给调用方，
 * 而这里要的只是内存里的一串字符。更重要的是——**扫描件必须报错而不是给空串**
 * （见文件头第 3 条），而能回答「这份 PDF 有没有文本层」的判据只有一个，
 * 就是 `textlessReason`。直接调它，判据仍然只有一份，省掉的只是一次
 * 落盘 + 读回（以及由此产生的临时文件）。
 *
 * 形态的挑选照抄 `document.ts` 的同一处裁决：`md` 走 `linesToMarkdown`（按字号猜标题），
 * `txt` 走 `linesToText`。改那边的口径时这里要跟着看一眼。
 */
async function readPdfText(input: string, toExt: string, cancel: CancelToken): Promise<string> {
  const { extractPdfLines, linesToMarkdown, linesToText, textlessReason } =
    await import('../main/converters/pdfText')

  const pages = await extractPdfLines(input, cancel)
  const textless = textlessReason(pages)
  if (textless !== null) {
    // 文案整段复用 `textlessReason` 的：那段话就是这个判断的唯一来源，
    // 在这里重写一句「这是扫描件」会让两处慢慢说岔。
    // 机器可读的那一半由 `no_text_content` 这个码承担（见 errors.ts）。
    throw new McpToolError(
      textless.join('\n'),
      {
        source_format: 'pdf',
        hint: '本项目不含 OCR。要看内容就用 convert_file 转成 png / jpg 交给能看图的客户端；要文字得先让用户做一次 OCR。'
      },
      { code: 'no_text_content' }
    )
  }

  return toExt === 'md' ? linesToMarkdown(pages) : linesToText(pages)
}

/**
 * 走转换管线，并**保证临时目录在成功与失败两条路径上都删掉**。
 *
 * 产物名必须是 `content.<toExt>` 这种带正确扩展名的形状（约束 8）：
 * 各引擎完全依赖输出文件的扩展名推断封装格式，`content.part` 那种会直接开不了写。
 * `.part` 由引擎自己按 `partPathOf()` 加，这里不用操心。
 */
async function readViaConverter(
  input: string,
  fromExt: string,
  toExt: string,
  cancel: CancelToken
): Promise<string> {
  const tempDir = await mkdtemp(join(tmpdir(), TEMP_PREFIX))
  const output = join(tempDir, `content.${toExt}`)

  try {
    await convert({
      input,
      output,
      fromExt,
      toExt,
      cancel,
      // 这个工具不推 MCP 的 notifications/progress：读一份文档是秒级的事，
      // 而 `convert_file` 那条路上发进度的理由（转视频要几分钟）在这里不成立。
      onProgress: () => undefined
    })
    return await readAsText(output)
  } finally {
    // **`rm` 失败不抛**：临时目录没删掉是件该记下来的小事，而它绝不该把一次
    // 已经读成功的调用变成失败（那才是真正的「丢结果」）。
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
  }
}

/**
 * 把一次工具调用做完：定做法 → 抽出全文 → 切片。
 *
 * `input.path` 必须是**已经过路径闸门**的绝对路径（`paths.ts`）：闸门只应在一处生效，
 * 这里不重判，否则「哪个才是真判据」会分家。写路径**一次都不碰**——临时目录是我们
 * 自己的路径，与 agent 给的任何东西无关。
 */
export async function readDocument(input: {
  path: string
  format: ReadFormat
  maxChars: number
  offset: number
  signal?: AbortSignal
}): Promise<ReadResult> {
  const sourceFormat = extOf(input.path)
  const plan: ReadPlan = resolveReadPlan(sourceFormat, input.format)
  const warnings = [...plan.warnings]

  const cancel = new CancelToken()
  if (input.signal !== undefined) {
    if (input.signal.aborted) cancel.cancel()
    else input.signal.addEventListener('abort', () => cancel.cancel(), { once: true })
  }

  let full: string
  try {
    if (!plan.convert) {
      full = await readAsText(input.path)
    } else {
      // 引擎不在位就在**动手之前**拒（与 jobs.ts 同一条裁决、同一个函数，
      // 见约束 20 的最后一条）。这一版能走到这里的只有 rst 解析要的那把 pandoc。
      assertEngineReady(sourceFormat, plan.toExt)

      full =
        sourceFormat === 'pdf'
          ? await readPdfText(input.path, plan.toExt, cancel)
          : await readViaConverter(input.path, sourceFormat, plan.toExt, cancel)
    }
  } catch (error) {
    if (error instanceof McpToolError) throw error
    if (cancel.canceled || error instanceof ConversionCanceled) {
      throw new McpToolError(
        '读取被取消，没有拿到正文。',
        { source: input.path },
        { code: 'canceled' }
      )
    }
    if (error instanceof ConversionFailed) {
      // 引擎的原始报错**一个字都不留地转出去**：它是唯一说得清「哪一步不对」的东西。
      // 码给 `source_corrupt`（引擎没能完成、重试不会有不同结果），分类只由那一处决定。
      throw new McpToolError(
        `读不出正文：${error.logTail.join('\n')}`,
        { log_tail: error.logTail },
        { code: 'source_corrupt' }
      )
    }
    throw error
  }

  if (full.trim() === '') {
    warnings.push(
      '抽出来是空的。两种可能：「这份文档确实没有文字」，或者「文字都在图里」' +
        '（本项目不含 OCR，后者抽不出来）。'
    )
  }

  const total = full.length
  if (input.offset > 0 && input.offset >= total && total > 0) {
    warnings.push(
      `offset=${input.offset} 已经超出正文长度（${total} 字符），这一段是空的：读完了就不要再往下读`
    )
  }

  // 上限是第三道闸：默认值只管「不传」，管不住「传个 5000000 进来」。
  // 不报错而是**夹住并如实说明**——让 agent 拿到一份能用的结果 + 一句「被砍了」，
  // 比让它收一条参数校验错误强（与 `list_jobs` 夹 `limit` 同一个取舍）。
  const maxChars = Math.min(input.maxChars, MAX_READ_CHARS)
  if (maxChars < input.maxChars) {
    warnings.push(
      `max_chars 被夹到 ${MAX_READ_CHARS}（你要的是 ${input.maxChars}）：单次返回再多会把上下文塞爆，` +
        '要更多就用 offset 分几次读'
    )
  }

  const text = full.slice(input.offset, input.offset + maxChars)
  const result: ReadResult = {
    text,
    total_chars: total,
    truncated: input.offset + text.length < total,
    format: plan.format,
    source_format: sourceFormat
  }
  if (warnings.length > 0) result.warnings = warnings
  return result
}
