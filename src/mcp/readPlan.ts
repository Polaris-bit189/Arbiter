import { categoryOf, engineFor, sourceExtsByCategory, targetsFor } from '@shared/formats'
import { McpToolError } from './errors'
import type { ReadFormat } from './schema'

/**
 * `read_document` 的**决策层**：拿到源扩展名与调用方想要的形态，回答
 * 「该不该转、转成什么、有没有要交代的」——**纯函数，一行 IO 都不碰**。
 *
 * 单独成模块的理由和 `formatsView.ts` 一样：它是这一版里最容易写错、也最值得
 * 逐条钉住的一层，而 `test-mcp-view.ts` 能在**只加载纯模块**的进程里把它跑一遍
 * （那个套件同时钉着「src/mcp 的依赖图里不许出现 src/main」，所以决策与 IO
 * 必须分家——`readDocument.ts` 那边要 import 转换链路，这里一个字节都不碰）。
 *
 * ## 三条判据
 *
 * 1. **本来就是文字的源不做转换。** `.csv` / `.md` / `.txt` 的字节就是正文，
 *    再过一遍转换只会改变它（`md → txt` 会把标题的 `#` 剥掉、`txt → md` 会被
 *    包进代码围栏），而调用方要的是「读出来」，不是「换个格式」。
 *    ⚠️ 这与「把二进制当纯文本读」那条静默洞**正好相反**：那一条是拿
 *    `decodeTextFile` 去解 PDF 字节、解出一屏乱码还报成功（约束 12）。
 * 2. **能转的走能力矩阵，回落链写死顺序。** 判据一律问 `targetsFor()`，
 *    不另写一张「read_document 支持什么」的表——那必然与矩阵分家。
 * 3. **重型引擎的源**（`doc` / `xls` / `ppt` / `odt` / `ods` 要 LibreOffice、
 *    电子书要 Calibre）**在解析目标格式之前**就拒。顺序是承重的：先解析再拒的话，
 *    `xls` 会因为「md 不是它的合法目标」而报出 fallback 那一类错，
 *    而真正该说的是「这条路要下 357 MiB」。
 */

/** 形态 → 目标扩展名。三种形态恰好同名，写成映射是为了让调用点不出现裸字符串。 */
const FORMAT_EXT: Record<ReadFormat, string> = { md: 'md', txt: 'txt', csv: 'csv' }

/**
 * 回落次序。**从最像的往最不像的排**：先 txt（任何正文都能表示成纯文本），
 * 再 md，最后才是 csv（它只对本来就是表格的源成立）。
 *
 * 请求的那一种排在最前（`resolveReadPlan` 里单独判），所以这里只管「要不到时退到哪」。
 */
const FALLBACK_ORDER: ReadFormat[] = ['txt', 'md', 'csv']

export interface ReadPlan {
  /** 实际会给出的形态。就是返回值里的 `format`——**以它为准**，不是调用方传的那个 */
  format: ReadFormat
  /** true = 要过一遍转换管线（走临时目录）；false = 文件字节本身就是正文 */
  convert: boolean
  /** `convert` 为 true 时的目标扩展名 */
  toExt: string
  /** 现在就攒着要说的话（例如「你要的 md 它没有，退成 txt 了」） */
  warnings: string[]
}

/**
 * 「不经转换就能给出正文」的情形，返回**实际会给出的形态**；不是这种情形就返回 null。
 *
 * 三段，每段各自讲得通：
 *   - `.csv` 要 csv：表格文件原样就是 csv 文本，转一圈只会多一层引号。
 *   - `.md` / `.markdown` 要 md 或 txt：**这两者在字节层面是同一件事**。markdown 的
 *     设计前提之一就是源码本身可读（`shared/formats.ts` 的注释里也这么写着），
 *     而工具返回的从来不是渲染结果——所以「读成 md」与「读成 txt」拿到的是同一串字节。
 *     报成哪个形态按源自己的形态说实话（`.txt` 报 txt、`.md` 报 md）。
 *   - `.txt` 同理。
 *
 * 形状对不上时（比如拿 `.csv` 要 md）返回 null，交给回落链——那里会带上说明。
 */
function nativeFormat(fromExt: string, requested: ReadFormat): ReadFormat | null {
  if (fromExt === 'csv') return requested === 'csv' ? 'csv' : null
  if (fromExt === 'txt') return requested === 'csv' ? null : 'txt'
  if (fromExt === 'md' || fromExt === 'markdown') return requested === 'csv' ? null : 'md'
  return null
}

/** 这一版不做的那两类源，各自要用户先下多大的引擎。 */
const HEAVY: Record<'libreoffice' | 'calibre', { label: string; size: string; save: string }> = {
  libreoffice: {
    label: 'LibreOffice',
    size: '357 MiB',
    // 这些是「不用下引擎就能读」的替代出口，报错时一并给出去，agent 下一轮就能自己改对
    save: '.docx / .xlsx / .pptx'
  },
  calibre: { label: 'Calibre', size: '213 MiB', save: '.txt / .docx / .pdf' }
}

/**
 * 这个源要的重型引擎，没有就返回 null。
 *
 * **判据从能力矩阵推出来，不另写一张表。** 直觉上要写
 * `new Set(['doc','xls','ppt','odt','ods','odp','epub',…])`，但那张表一旦与矩阵
 * 分家，表现是「某个格式明明要下引擎，read_document 却当它能直接读」——
 * 一路走到引擎缺席的失败里，而那句失败还说不清代价。
 *
 * 取 `targetsFor(fromExt)[0]` 就够，是因为这两类的 `engineFor` 与目标无关：
 * `shared/formats.ts` 里 `OFFICE_BINARY_SRC` 恒路由到 `libreoffice`、`ebook` 类
 * 恒路由到 `calibre`，换哪个合法目标问出来的都是同一个 key。
 * （`rst` 走的是另一条：它解析要 pandoc，但 `engineFor` 报的是 `pdf`，
 * 所以天然不会被这里误判成重型——它由 `assertEngineReady` 在启动前拦。）
 */
function heavyEngineOf(fromExt: string): 'libreoffice' | 'calibre' | null {
  const targets = targetsFor(fromExt)
  if (targets.length === 0) return null
  const engine = engineFor(fromExt, targets[0])
  return engine === 'libreoffice' || engine === 'calibre' ? engine : null
}

/**
 * `read_document` 这一版**读得动**的扩展名。
 *
 * 从矩阵派生（文档类全体减去要重型引擎的那些），不写死——写死的话，
 * 矩阵里加一个纯 JS 能解析的文档格式时，这里会**静默**少一个出口，
 * 而 agent 只会看到「不支持」，无从知道是漏配。形状与 `sourceExtsByCategory()`
 * 一样返回副本。
 */
export function readableExts(): string[] {
  return sourceExtsByCategory().document.filter((ext) => heavyEngineOf(ext) === null)
}

/**
 * 定下这一次读取到底怎么做。**要么给一份可执行的计划，要么抛一条说清代价的错。**
 *
 * 三种拒绝分得很清，因为 agent 该做的事完全不同：
 *   - 扩展名认不出 / 没有扩展名 → `unknown_format`（要改的是路径）
 *   - 是文档但这一版不读（`doc` / 电子书）→ `engine_missing`（要改的是**做法**，
 *     而且要先把「下 357 MiB」这个代价摆到用户面前）
 *   - 压根不是文档（音视频 / 图片 / 压缩包）→ `not_readable`（要改的是**工具**）
 */
export function resolveReadPlan(rawExt: string, requested: ReadFormat): ReadPlan {
  const fromExt = rawExt.trim().toLowerCase()

  if (fromExt === '') {
    throw new McpToolError(
      '源文件没有扩展名，判断不了它是什么',
      {
        readable: readableExts(),
        hint: '源文件必须带真实扩展名，别拿 .part / .tmp 这类中间文件来读'
      },
      { code: 'unknown_format' }
    )
  }

  const category = categoryOf(fromExt)
  if (category === null) {
    throw new McpToolError(
      `不认识的源格式 .${fromExt}`,
      { fromExt, readable: readableExts() },
      { code: 'unknown_format' }
    )
  }

  // 重型那两类**排在解析目标格式之前**，理由见文件头第 3 条
  const heavy = heavyEngineOf(fromExt)
  if (heavy !== null) {
    const info = HEAVY[heavy]
    throw new McpToolError(
      `.${fromExt} 读不了：它要先转成别的格式才能拿到文字，而那条路要 ${info.label}` +
        `（安装包 ${info.size}）。read_document 这一版不做这类转换——` +
        `「这个文件写了啥」不该牵出一次几百 MB 的下载。`,
      {
        fromExt,
        engine: heavy,
        download_size: info.size,
        hint:
          `最省事的是让用户在原应用里另存为 ${info.save}，这些格式不用下引擎就能读；` +
          `要用 ${info.label} 就改用 convert_file（它会在引擎缺失时点名说要下什么、多大），` +
          '**并且先让用户确认**再下。'
      },
      {
        code: 'engine_missing',
        next_steps: [
          `让用户把这份文件另存为 ${info.save} 再读——那几种这一版直接支持`,
          `或者改用 convert_file：它会说明要下 ${info.label}（${info.size}），由用户决定要不要下`,
          '这一步**不要**自己重试：引擎不在位，重试一万次还是同一句拒绝'
        ]
      }
    )
  }

  if (category !== 'document') {
    throw new McpToolError(
      `read_document 读的是**文档正文**，而 .${fromExt} 是 ${category} 类，没有「正文」可读`,
      {
        fromExt,
        category,
        readable: readableExts(),
        hint: '音视频 / 图片 / 压缩包的信息用 inspect_file 查，要换格式用 convert_file'
      },
      { code: 'not_readable' }
    )
  }

  // ① 本来就是文字的源：原样给，不动它
  const native = nativeFormat(fromExt, requested)
  if (native !== null) {
    return { format: native, convert: false, toExt: '', warnings: [] }
  }

  // ② 能力矩阵里有这个出口就直接用
  const targets = targetsFor(fromExt)
  const wanted = FORMAT_EXT[requested]
  if (targets.includes(wanted)) {
    return { format: requested, convert: true, toExt: wanted, warnings: [] }
  }

  // ③ 要不到就沿回落链退一格，**退到哪一格必须说出来**——
  //    悄悄换成另一种形态而 `format` 又照调用方说的报，agent 会拿一个它没要的东西当要到了
  for (const candidate of FALLBACK_ORDER) {
    const same = nativeFormat(fromExt, candidate)
    if (same !== null) {
      return {
        format: same,
        convert: false,
        toExt: '',
        warnings: [`.${fromExt} 没有 ${requested} 出口，已按 ${same} 原样返回（没有做任何转换）`]
      }
    }
    const ext = FORMAT_EXT[candidate]
    if (targets.includes(ext)) {
      return {
        format: candidate,
        convert: true,
        toExt: ext,
        warnings: [
          `.${fromExt} 没有 ${requested} 出口，已改按 ${candidate} 返回（可选的是 ${targets.join(' / ')}）`
        ]
      }
    }
  }

  // 文档类里每一个扩展名都至少有一个 md/txt/csv 出口，走到这里说明矩阵变了
  throw new McpToolError(
    `.${fromExt} 没有可读的文本出口（能力矩阵给的是 ${targets.join(' / ') || '空'}）`,
    { fromExt, targets },
    { code: 'not_readable' }
  )
}
