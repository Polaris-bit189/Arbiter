import { existsSync, readdirSync } from 'fs'
import { readFile, writeFile } from 'fs/promises'
import { createRequire } from 'module'
import { dirname, join } from 'path'
import { baseNameOf, partPathOf } from '../core/outputName'
import { loadPdfjs } from './pdfText'
import {
  ConversionCanceled,
  ConversionFailed,
  finalizeOutput,
  removeQuietly,
  tailLines,
  type ConvertContext
} from './common'

/**
 * PDF 页 → 位图（`pdf → png/jpg`）。
 *
 * 走的是 pdfjs 的 legacy build + `@napi-rs/canvas`，**全程在主进程里完成**，
 * 不需要渲染进程、不需要新 IPC 通道、不需要 DOM。
 *
 * 为什么这条路成立（三条都是从源码里读出来的，现已实测确认）：
 *
 * - `legacy/build/pdf.mjs` 的 `isNodeJS` 判据是
 *   `!(process.versions.electron && process.type && process.type !== 'browser')`。
 *   Electron **主进程**的 `process.type === 'browser'`，所以 `isNodeJS === true`，
 *   pdfjs 会去加载 `NodeCanvasFactory`。
 * - `NodeCanvasFactory` 内部是 `require("@napi-rs/canvas")`（`@napi-rs/canvas` 本来就是
 *   pdfjs-dist 的 optionalDependency，已经在位），所以 canvas 不需要我们自己实现。
 * - `page.render({ canvas })` 可以直接收 canvas 对象，`canvasContext` 是可省的。
 *
 * 实测（A4 三页、含文字 + 真 JPEG、150 DPI）：pdfjs 模块加载 194 ms、单页渲染 35 ms、
 * 产物 1241x1754、40 KB，通道标准差 61/45/20（不是纯色空白）。
 *
 * **刻意不走渲染进程**：那条路要动 preload（sandbox 下 pdfjs worker 的打包）、要加 IPC 通道、
 * 还要处理「主进程推增量进度」这个前提被绕开的问题，代价完全不同。
 */

/** 屏幕阅读档。DPI 150 下 A4 是 1241x1754，单页 35 ms */
const DPI = 150

/** PDF 的用户空间单位是 pt，1 pt = 1/72 英寸。viewport 的 scale 就是这个换算比 */
const PT_PER_INCH = 72
const SCALE = DPI / PT_PER_INCH

/**
 * 单页像素上限，与 `converters/image.ts` / `converters/document.ts` 的 MAX_PIXELS 一致。
 * 超了**明确报错，不默默降 DPI**——静默降级在本项目是明令禁止的。
 */
const MAX_PIXELS = 512 * 1024 * 1024

/** JPEG 质量，与 `converters/image.ts` 的 90 对齐 */
const JPEG_QUALITY = 90

const require_ = createRequire(__filename)

/**
 * pdfjs 的静态资源目录（`standard_fonts` / `cmaps` / `wasm`），**必须以正斜杠结尾**。
 *
 * 三条必须记住的：
 *
 * - pdfjs 那侧是纯字符串拼接（`${baseUrl}${filename}`），而且 `getFactoryUrlProp`
 *   会断言 `endsWith('/')`——给反斜杠直接抛
 *   `Invalid factory url: "…\cmaps\" must include trailing slash`。**这是实测踩到的**。
 * - 传的是**文件系统路径而不是 `file://` URL**：Node 侧的 `NodeBinaryDataFactory`
 *   走的是 `fs.readFile(url)`。正斜杠在 Windows 上照样是合法路径，两者不冲突。
 * - `wasmUrl` 不是可选的装饰。`pdfjs-dist/wasm/` 里是 jbig2 / openjpeg / qcms，
 *   而 `useWasm` 默认开——**扫描件 PDF 大量用 JBIG2 / JPEG2000**，不给就会在解图像时抛
 *   「Unable to load wasm data at…」。`pdfText.ts` 一个都没设也跑得好，是因为它只抽文本、
 *   从不解码图像，别被那个先例误导。
 */
function assetDir(name: 'standard_fonts' | 'cmaps' | 'wasm'): string {
  const pkg = require_.resolve('pdfjs-dist/package.json')
  return join(dirname(pkg), name) + '/'
}

/**
 * PDF → 一页一个位图文件。
 *
 * `Task` 只有一个 `outputPath`，而 PDF 有 N 页，所以约定是：
 * **第 1 页落在 `output` 上**（`TaskManager` 完成时会 `stat()` 那个被预留的路径拿体积，
 * 第一页不落在那里，「打开位置」就会退化到源文件），第 k≥2 页落在同目录的兄弟名
 * `<stem>-<k>.<toExt>` 上，从 k=2 起探占用、占用就整体往后顺延。
 *
 * **页数 > 1 时绝不只写第 1 页**——那是静默丢数据，正是本项目最忌讳的那一类。
 *
 * ⚠️ **兄弟名不进 `TaskManager.claimed`**（那是约束 9 防并发撞名的机制，`core/` 的东西
 * 这条线不动），所以跨任务的撞名只能在**本地**堵。真正会撞的场景是「另一个源的主产物
 * 恰好等于本任务的某个兄弟名」，也就是同目录里同时有 `a.pdf` 与 `a-2.pdf`——
 * 拆页导出的常见命名，`a-2.pdf` 转 png 时本名正是 `a-2.png`。`resolveOutputPath`
 * 那时看不到它（两个任务都停在 `.part` 上）。`siblingTaken` 因此多了一条判据：
 * **目录里存在 `a-2.*` 就不占 `-2` 这个号**（`siblingStems` 的快照）。
 * 残余的窄缝只剩一种：**源文件在别的目录**而输出目录被设置成同一个时，
 * 那条避让看不到那个兄弟源。彻底堵掉要动 `core/task.ts` 的 `claimed`，不在本次范围。
 *
 * 其余常见路径都验过是安全的：同一个 PDF 连转两次（第二次整体顺延到 `a (1)-*`）、
 * 两个同名不同目录的源（本名先被改成 `a (1)`，兄弟名跟着派生）、同源转不同格式
 * （扩展名不同，兄弟名不可能相同）。
 */

/**
 * 目录里所有条目的「去掉最后一个扩展名」名，**小写**，只读一次。
 *
 * 读不到就给空集合：探测失败只是退化成原来的行为（只看最终名），不该让转换崩。
 */
function siblingStems(dir: string): Set<string> {
  try {
    return new Set(readdirSync(dir).map((name) => baseNameOf(name).toLowerCase()))
  } catch {
    return new Set()
  }
}

/**
 * 第 n 页的兄弟名能不能用。
 *
 * 两条判据缺一不可：
 *
 * - `existsSync` 是原行为（磁盘上已经有同名产物就顺延），它在转换过程中会变，得现问。
 * - `taken` 那份快照是**避让兄弟源**用的，见文件头那段：`a.pdf` 的第 2 页要占
 *   `a-2.png`，而 `a-2.pdf` 转出来的本名正是它。快照取自转换开始时，而那个源文件
 *   是**用户磁盘上一直躺着的东西**，不是我们写出来的，所以快照是可靠的。
 */
function siblingTaken(
  dir: string,
  stem: string,
  n: number,
  toExt: string,
  taken: Set<string>
): boolean {
  if (taken.has(`${stem}-${n}`.toLowerCase())) return true
  return existsSync(join(dir, `${stem}-${n}.${toExt}`))
}

export async function renderPdfPages(context: ConvertContext): Promise<void> {
  const { input, output, toExt, cancel, onProgress } = context
  const jpeg = toExt === 'jpg' || toExt === 'jpeg'

  const pdfjs = await loadPdfjs()
  const buffer = await readFile(input)

  const task = pdfjs.getDocument({
    // 必须是 Uint8Array：给 Buffer 也能跑，但 pdfjs 会持有它的引用不放（同 pdfText.ts）
    data: new Uint8Array(buffer),
    // 光栅化要算字形，这三个目录都离不了（文本抽取那份可以不要，这里不行）
    standardFontDataUrl: assetDir('standard_fonts'),
    cMapUrl: assetDir('cmaps'),
    cMapPacked: true,
    wasmUrl: assetDir('wasm'),
    // 光栅化要的是「跟打印出来一致」的字形，不是系统里恰好装了什么。
    // 关掉它还能少一条到处摸文件系统的路径。
    useSystemFonts: false
  })

  cancel.onCancel(() => {
    // 与下面的 finally 同款：这里是 fire-and-forget，没人 await 这条 promise，
    // 它一旦 reject 就是一条 unhandled rejection，Node 默认当致命错误处理——
    // 主进程当场退出。会抛的只有 `await this._transport?.destroy()`（`pdf.mjs:15581`），
    // 但取消那一刻状态本来就是乱的，不能赌它不抛。
    void task.destroy().catch(() => undefined)
  })

  const dir = dirname(output)
  const stem = baseNameOf(output)
  /** 转换开始时目录里已有的名字快照，用来避让兄弟源（见 `siblingTaken`） */
  const taken = siblingStems(dir)

  /**
   * 已经渲染完、但还没搬到最终路径的页。
   *
   * 全部页都渲染成功之后才逐个 `finalizeOutput`，是为了「中途任何一页失败都不留半份产物」。
   * 每个 `temp` 都带 `.part`，且 `.part` 插在扩展名之前（约束 8）。
   */
  const staged: { temp: string; final: string }[] = []
  /** 已经搬到最终路径的页，失败 / 取消时按这个列表逐个删 */
  const written: string[] = []

  try {
    const pdf = await task.promise
    const total = pdf.numPages
    const { createCanvas } = await import('@napi-rs/canvas')

    // 第 2 页起的新路径从这个计数往下顺延。**只探最终名、不探 .part**：
    // 与 `resolveOutputPath` 同一口径，.part 是转换期间的私有中间态。
    let sibling = 2

    for (let n = 1; n <= total; n += 1) {
      if (cancel.canceled) throw new ConversionCanceled()

      const page = await pdf.getPage(n)
      const viewport = page.getViewport({ scale: SCALE })
      const width = Math.ceil(viewport.width)
      const height = Math.ceil(viewport.height)

      if (width * height > MAX_PIXELS) {
        throw new ConversionFailed([
          `第 ${n} 页在 ${DPI} DPI 下是 ${width}x${height}，超过单页像素上限（${MAX_PIXELS}）。`,
          `不自动降低 DPI——分辨率是用户的预期，静默降级只会产出一张看不懂的糊图。`
        ])
      }

      // canvas 由 pdfjs 认的那同一个包造；render 直接收 canvas，不必自己取 context。
      // 这个 as 只在**类型层面**：pdfjs 的 d.ts 按浏览器环境把 canvas 声明成
      // HTMLCanvasElement，而运行时走的是 isNodeJS 那条分支，收的就是
      // @napi-rs/canvas 的 Canvas（已实测渲染成功）。
      const canvas = createCanvas(width, height)
      await page.render({ canvas: canvas as unknown as HTMLCanvasElement, viewport }).promise

      let finalPath: string
      if (n === 1) {
        finalPath = output
      } else {
        while (siblingTaken(dir, stem, sibling, toExt, taken)) sibling += 1
        finalPath = join(dir, `${stem}-${sibling}.${toExt}`)
        // 自己刚占下的号也记进快照：下一轮问的是同一份快照，不记的话它看不到
        // 自己（.part 不在快照里，那是转换期间的私有中间态）
        taken.add(`${stem}-${sibling}`.toLowerCase())
        sibling += 1
      }

      const tempPath = partPathOf(finalPath)
      try {
        // 两个分支分开写而不是先算一个联合值：encode 是重载签名，
        // `'png' | 'jpeg'` 这个联合两边都匹配不上（png 那份不收 quality）
        const encoded = jpeg
          ? await canvas.encode('jpeg', JPEG_QUALITY)
          : await canvas.encode('png')
        await writeFile(tempPath, encoded)
      } catch (error) {
        await removeQuietly(tempPath)
        const message = error instanceof Error ? error.message : String(error)
        throw new ConversionFailed(tailLines(message))
      }

      staged.push({ temp: tempPath, final: finalPath })
      page.cleanup()
      onProgress({ kind: 'batch', done: n, total, stage: '导出第' })
    }

    // 最后一页渲染完到落盘之间还有一段，取消要在这里再确认一次
    if (cancel.canceled) throw new ConversionCanceled()

    for (const { temp, final } of staged) {
      if (cancel.canceled) throw new ConversionCanceled()
      await finalizeOutput(temp, final)
      written.push(final)
    }
  } catch (error) {
    // 取消 / 失败时把已写出的页**逐个删掉**（含 .part），照 converters/archive.ts 的形状
    for (const { temp } of staged) await removeQuietly(temp)
    for (const final of written) await removeQuietly(final)

    if (cancel.canceled) throw new ConversionCanceled()
    if (error instanceof ConversionCanceled) throw error
    if (error instanceof ConversionFailed) throw error
    const message = error instanceof Error ? error.message : String(error)
    throw new ConversionFailed(tailLines(message))
  } finally {
    await task.destroy().catch(() => undefined)
  }
}
