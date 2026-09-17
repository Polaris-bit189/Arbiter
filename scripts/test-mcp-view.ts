/**
 * M4 静态面的断言：工具 schema 的三个出口不许漂移，能力矩阵的对外视图不许自己编。
 *
 *   npx tsx --tsconfig tsconfig.test.json scripts/test-mcp-view.ts
 *
 * 这一套**不跑任何转换、不起 Electron**——末尾那组封锁断言就是在钉这件事：
 * MCP server 跑在普通 Node 进程里，`src/mcp/` 下任何一处 electron 都会让用户装上之后
 * 第一次调用就崩，而 typecheck 与别的套件一条都不会红（它们在 Electron 桩或真 Electron 里跑）。
 *
 * 每条断言都带防空转的伴生条件（「在空集合上恒真的否定断言」在本仓库已经抓到过一条，
 * 见 docs/NOTES.md 的测试一节）。这一套里「集合相等」型的断言占比很高，而集合相等在
 * **两侧同时为空**时照样绿——所以凡是拿并集、行数、段落数做前提的地方都补了「非空」那一半。
 *
 * 跟 `scripts/test-electron-free.ts` 是两回事：那条线验的是**转换链路**脱得开 electron，
 * 这条线验的是**静态定义**不说话不算数（不加载任何引擎、不 spawn 任何子进程）。
 */
import Module from 'module'

import { categoryOf, sourceExtsByCategory, targetsFor, targetsForCategory } from '@shared/formats'
import { CATEGORIES, type Category } from '@shared/types'

/**
 * 工具名全集。
 *
 * 前六个是 PLAN 的 M4 一节里逐字列出的；`list_jobs` 是**后加的第七个**、
 * `read_document` 是**第八个**，PLAN 那一节还没同步（`docs/PLAN.md` 不归这条线改）。
 * 加它们的理由都是可计数的：转 30 个文件时，`batch_convert` 之后要逐个 `get_job_status`
 * 就是对 30 次工具调用，有 `list_jobs` 就是 1 次；读一份 .docx 的正文原本要
 * `inspect_file` → `convert_file`（阻塞）→ 让宿主去读那个产物共三次，
 * 有 `read_document` 就是 1 次。
 *
 * 这张表**刻意写成字面量**而不是从 `TOOL_SCHEMAS` 派生：派生了就等于自己跟自己比，
 * 删掉一个工具、或者某天多出第八个，断言一条都不会红。工具数量要克制（生态的共识是
 * 1~15 个），所以「多一个」这件事必须有人过一眼。
 */
const EXPECTED_TOOLS = [
  'convert_file',
  'list_supported_formats',
  'inspect_file',
  'batch_convert',
  'get_job_status',
  'list_jobs',
  'cancel_job',
  'read_document'
]

/**
 * 工具数量预算（E-8）。
 *
 * 生态共识的甜点区是 **1~15 个**，这里刻意压到 **12**——比共识更紧一档，因为
 * 「还能再加」这句话在 15 那里已经很难说出口了。数量本身不是目的：每加一个工具，
 * 此后**每一次**请求都要把它的整段说明书发给模型，而它还会稀释既有工具的注意力
 * （模型在十个相似工具里挑错一个的概率，远高于在八个里挑）。
 *
 * ## 加新工具的纪律（不是「尽量少加」，是「加了要能说出这句话」）
 *
 * **每个新工具都必须在它的 `TOOL_DESCRIPTIONS` 里写清它替掉了几次什么调用。**
 * 已经有的两个先例：
 *   - `list_jobs`：「转完 30 个文件后逐个 `get_job_status`」是 30 次 → 1 次；
 *   - `read_document`：「`inspect_file` → `convert_file`（阻塞）→ 去读产物」是 3 次 → 1 次。
 *
 * 说不出这种数字的工具不该加：它多半是既有工具的某个参数（`mode`、`format` 那类）。
 * 这条纪律与下面那条上限断言是一对——上限只能拦住「加太多」，
 * 拦不住「加了但说不清为什么」。
 */
const TOOL_BUDGET = 12

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

/** 逐字比（含顺序）。能力矩阵的登记顺序是承重的：并集、表格行的顺序都由它来。 */
function diffOrdered(actual: readonly string[], expected: readonly string[]): string {
  if (JSON.stringify(actual) === JSON.stringify(expected)) return ''
  return `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`
}

/** 按集合比（不看顺序）。只关心「键集/名字集一致」的场合用它，免得重排一下就假红。 */
function diffSet(actual: readonly string[], expected: readonly string[]): string {
  return diffOrdered([...actual].sort(), [...expected].sort())
}

/* ------------------------------------------------------------ electron 封锁 */

interface Loader {
  _load(request: string, parent: unknown, isMain: boolean): unknown
  _cache: Record<string, unknown>
}

const loader = Module as unknown as Loader
const originalLoad = loader._load

/**
 * 拦截台账。光看模块缓存抓不住「某个模块静态 import 了 electron 然后自己加载失败」——
 * **加载失败的模块不会进缓存**，那种情况下「缓存里没有它」是恒真的。
 * 台账从另一个方向问：有没有人**试图**加载 electron。
 */
const blocked: string[] = []
const BLOCK_MARK = 'electron 在本套件里被刻意封锁'

loader._load = function (request: string, parent: unknown, isMain: boolean): unknown {
  if (request === 'electron') {
    const caller = (parent as { filename?: string } | undefined)?.filename ?? '(未知调用方)'
    blocked.push(caller)
    throw new Error(`${BLOCK_MARK}（模拟 MCP 那个没有 Electron 的进程）`)
  }
  return originalLoad.call(loader, request, parent, isMain)
}

/**
 * 钩子自证——**必须是第一条断言**。它不成立的话后面那组加载断言一条都不算数：
 * 「加载成功」与「根本没拦住」在观测上一模一样。
 *
 * 借 `createRequire` 而不是直接 `require('electron')`：这个脚本是 ESM 语法，
 * 而 `createRequire` 走的正是 `Module._load`——也就是我们挂钩子的那个入口，
 * 于是它证明的是「钩子接在真的加载路径上」，不是「这个函数我会写」。
 * 拦不住时 `require('electron')` 会成功返回 electron 包的路径字符串（本机开发依赖里有它），
 * 不会抛错，所以「抛了错」本身就是判据。
 */
let hookProof = '没有抛错——说明钩子没接在 require 的加载路径上，整组断言都是空转'
let hookWorks = false
try {
  Module.createRequire(import.meta.url)('electron')
} catch (error) {
  hookWorks = error instanceof Error && error.message.includes(BLOCK_MARK)
  hookProof = error instanceof Error ? error.message.split('\n')[0] : String(error)
}
check('electron 封锁钩子确实生效（自证，防空转断言）', hookWorks, hookProof)
check(
  '拦截台账记下了自检那一次（防空转：台账是活的，末尾那条「台账为空」才不是装饰）',
  blocked.length >= 1,
  `记到 ${blocked.length} 条`
)
blocked.length = 0 // 自检那次是我们故意触发的，不作数

/* ------------------------------------------------------------------ 助手 */

type LoadedSchema = typeof import('../src/mcp/schema')
type LoadedView = typeof import('../src/mcp/formatsView')
type LoadedErrors = typeof import('../src/mcp/errors')
type LoadedReadPlan = typeof import('../src/mcp/readPlan')
type LoadedVerify = typeof import('../src/mcp/verify')

interface ZodLikeObject {
  shape: Record<string, { safeParse: (value: unknown) => { success: boolean } }>
}

/**
 * 拿 zod 的 `.shape` 只有这一个目的：**独立地**问一遍「哪些字段是必填的」，
 * 好跟 JSON Schema 里那份 `required` 对拍。直接读 JSON Schema 再跟自己比是同义反复。
 *
 * 判据是 `safeParse(undefined)`：`z.string()` 拒 undefined → 必填；
 * `.optional()` 与 `.default(...)` 都收 undefined → 不必填。这与 `toJSONSchema({ io:'input' })`
 * 的语义是同一件事，但走的是另一条代码路径，所以这两者能互相抓错。
 *
 * 中间那次 `as unknown as` 是因为 `TOOL_SCHEMAS[name]` 落在一个六元联合上，
 * 直接转结构类型会被 TS 判成不兼容。
 */
function shapeOf(schema: unknown): ZodLikeObject['shape'] {
  return (schema as unknown as ZodLikeObject).shape
}

/** 从 markdown 单元格里抠出所有反引号包着的名字。`` `mp4`、`mkv` `` → `['mp4','mkv']`。 */
function inlineNames(cell: string): string[] {
  return [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1])
}

interface MdRow {
  ext: string
  targets: string[]
  /** 第三格（「要下载的出口」）的原文。单独留着，好断言那一列真的渲染出了东西 */
  extra: string
}

/**
 * 按 `## <类别>` 切段，键就是类别名本身（标题后面的中文是给人看的，不参与解析——
 * 解析锚在类别名上，中文标签哪天改了也不会把这里带红）。
 */
function splitSections(md: string): Map<string, string> {
  const out = new Map<string, string>()
  let current: string | null = null
  let buffer: string[] = []
  for (const line of md.split('\n')) {
    const heading = /^## (\S+)/.exec(line)
    if (heading) {
      if (current !== null) out.set(current, buffer.join('\n'))
      current = heading[1]
      buffer = []
      continue
    }
    if (current !== null) buffer.push(line)
  }
  if (current !== null) out.set(current, buffer.join('\n'))
  return out
}

/** 数据行形如 `| \`mkv\` | \`mp4\`、\`webm\` | — |`。表头与分隔行第一格没有反引号，天然不匹配。 */
function parseRows(body: string): MdRow[] {
  const out: MdRow[] = []
  for (const line of body.split('\n')) {
    const cells = /^\| `([^`]+)` \| (.+?) \| (.+?) \|$/.exec(line)
    if (cells) out.push({ ext: cells[1], targets: inlineNames(cells[2]), extra: cells[3] })
  }
  return out
}

function cacheKeys(): string[] {
  return Object.keys(loader._cache).map((key) => key.replace(/\\/g, '/'))
}

/* ------------------------------------------------------------------ 主流程 */

async function main(): Promise<void> {
  let schemaModule: LoadedSchema | null = null
  let viewModule: LoadedView | null = null
  let errorsModule: LoadedErrors | null = null
  let readPlanModule: LoadedReadPlan | null = null
  let loadError = ''
  try {
    schemaModule = await import('../src/mcp/schema')
    viewModule = await import('../src/mcp/formatsView')
    // `errors.ts` 是纯的（零 import），但它的**消费者**（`jobs.ts` / `server.ts`）
    // 牵着主进程那一整条链——所以码表本身必须在这条封锁线上单独加载一次：
    // 哪天有人为了图省事把 `jobs.ts` 里的什么搬进 `errors.ts`，这里会先红。
    errorsModule = await import('../src/mcp/errors')
    // 决策层（`readPlan.ts`）必须是**纯的**：它只 import `@shared/formats` 与 `./errors`，
    // 一个 src/main 都不碰——否则下面那一节就只能在没有 electron 的进程之外跑，
    // 而这一套的前提恰恰是「这个进程里根本没有 electron」。
    readPlanModule = await import('../src/mcp/readPlan')
  } catch (error) {
    loadError = error instanceof Error ? error.message.split('\n')[0] : String(error)
  }
  check(
    'src/mcp 的三个模块能在封锁 electron 的进程里加载（动态 import，加载期就碰 electron 会在这里红）',
    schemaModule !== null &&
      viewModule !== null &&
      errorsModule !== null &&
      readPlanModule !== null,
    loadError
  )
  if (!schemaModule || !viewModule || !errorsModule || !readPlanModule) {
    console.log('  ⊘ 模块没加载起来，后面的断言无从谈起——不装作通过，也不静默略过')
    report()
    return
  }
  const { TOOL_SCHEMAS, TOOL_NAMES, TOOL_DESCRIPTIONS, jsonSchemas, openAiTools } = schemaModule

  /* ------------------------------------------------ A：三个出口不许漂移 */

  console.log('\n[A] 工具定义的三个出口')
  const nameKeys = TOOL_NAMES
  const jsonKeys = Object.keys(jsonSchemas())
  const tools = openAiTools()
  const openAiKeys = tools.map((tool) => tool.function.name)

  check(
    '八个工具名齐全（前六个与 PLAN 的 M4 一节逐字一致，list_jobs 与 read_document 是后加的）',
    diffSet(nameKeys, EXPECTED_TOOLS) === '',
    diffSet(nameKeys, EXPECTED_TOOLS)
  )
  check(
    'jsonSchemas() 的键集与 TOOL_SCHEMAS 完全一致',
    diffSet(jsonKeys, nameKeys) === '',
    diffSet(jsonKeys, nameKeys)
  )
  check(
    'openAiTools() 的键集与 TOOL_SCHEMAS 完全一致',
    diffSet(openAiKeys, nameKeys) === '',
    diffSet(openAiKeys, nameKeys)
  )
  // 防空转：上面三条在「三个出口同时为空」时也会通过（期望集非空只挡住了部分情形，
  // 而 TOOL_NAMES 派生自 TOOL_SCHEMAS，两者一起空掉时前两条仍是绿的）
  check(
    '三个出口都非空（防空转）',
    nameKeys.length > 0 && jsonKeys.length > 0 && openAiKeys.length > 0,
    `${nameKeys.length} / ${jsonKeys.length} / ${openAiKeys.length}`
  )
  // E-8：**上限**断言。上面那条集合相等管的是「名字对不对」，管不了「要不要再多加一个」
  // ——加一个工具时人会顺手把 `EXPECTED_TOOLS` 一起改掉，集合相等照样绿。
  // `nameKeys.length > 0` 那一半是防空转的伴生条件：空集合也「不超过 12」。
  check(
    `工具数量在预算内（${nameKeys.length} <= ${TOOL_BUDGET}；甜点区是 1~15，这里刻意更紧）`,
    nameKeys.length > 0 && nameKeys.length <= TOOL_BUDGET,
    `实际 ${nameKeys.length} 个：${nameKeys.join(', ')}`
  )
  check(
    '每个工具都有一句中文 description',
    nameKeys.length > 0 &&
      nameKeys.every((name) => {
        const text = TOOL_DESCRIPTIONS[name]
        return typeof text === 'string' && text.length > 20 && /[一-龥]/.test(text)
      }),
    nameKeys.filter((name) => !/[一-龥]/.test(TOOL_DESCRIPTIONS[name] ?? '')).join(', ')
  )

  /* ------------------------------------------ B：能力矩阵视图（结构化那份） */

  console.log('\n[B] list_supported_formats 的对外视图')
  const views = viewModule.listSupportedFormats()
  const byCategory = sourceExtsByCategory()

  check(
    'listSupportedFormats() 覆盖六个类别且没有多余的',
    diffSet(
      views.map((view) => view.category),
      [...CATEGORIES]
    ) === '',
    `实际：${views.map((view) => view.category).join(', ')}`
  )
  check(
    '六个类别都有非空中文标签（防空转：漏一行会变成 undefined 而看起来只是少一段）',
    diffSet(Object.keys(viewModule.CATEGORY_LABELS), [...CATEGORIES]) === '' &&
      CATEGORIES.every((cat) => (viewModule.CATEGORY_LABELS[cat] ?? '').length > 0),
    JSON.stringify(viewModule.CATEGORY_LABELS)
  )

  for (const view of views) {
    const cat = view.category
    check(
      `[${cat}] 源格式数 > 0（防空转：下面两条在空列表上恒真）`,
      view.sources.length > 0,
      `拿到 ${view.sources.length} 个`
    )
    check(
      `[${cat}] 源格式与 sourceExtsByCategory() 逐字一致（含登记顺序）`,
      diffOrdered(
        view.sources.map((source) => source.ext),
        byCategory[cat]
      ) === '',
      diffOrdered(
        view.sources.map((source) => source.ext),
        byCategory[cat]
      )
    )
    check(
      `[${cat}] 目标并集与 targetsForCategory() 逐字一致`,
      diffOrdered(view.targets, targetsForCategory(cat)) === '',
      diffOrdered(view.targets, targetsForCategory(cat))
    )
    const wrongTargets = view.sources.filter(
      (source) => diffOrdered(source.targets, targetsFor(source.ext)) !== ''
    )
    check(
      `[${cat}] 每个源的目标与 targetsFor() 逐字一致`,
      view.sources.length > 0 && wrongTargets.length === 0,
      wrongTargets.map((source) => `${source.ext}: ${JSON.stringify(source.targets)}`).join(' | ')
    )
    // 逐源目标之并集必须等于类别并集：`targetsForCategory()` 的定义就是这个，
    // 两边各问一次才分得清「少了一个」与「多了一个」
    const union = [...new Set(view.sources.flatMap((source) => source.targets))]
    check(
      `[${cat}] 各源目标的并集 = 类别目标并集`,
      diffOrdered(union, targetsForCategory(cat)) === '',
      diffOrdered(union, targetsForCategory(cat))
    )
  }

  const oneCategory = viewModule.listSupportedFormats('ebook')
  check(
    "listSupportedFormats('ebook') 只返回一类",
    oneCategory.length === 1 && oneCategory[0].category === 'ebook',
    JSON.stringify(oneCategory.map((view) => view.category))
  )
  let unknownMessage = ''
  try {
    viewModule.listSupportedFormats('nope' as Category)
  } catch (error) {
    unknownMessage = error instanceof Error ? error.message : String(error)
  }
  check(
    '未知类别抛错而不是静默返回空数组（防空转：报的必须是带类别名单的那条）',
    unknownMessage.includes('nope') && unknownMessage.includes('video'),
    unknownMessage || '没有抛错——空数组会被当成「这个类别没有格式」'
  )

  const needingDownload = views.flatMap((view) =>
    view.sources.flatMap((source) =>
      Object.keys(source.downloadFor).map((to) => `${source.ext}→${to}`)
    )
  )
  check(
    '视图里确实标出了「需要先下载引擎」的出口（防空转：这一列整体空掉的话它会静默消失）',
    needingDownload.length > 0,
    `${needingDownload.length} 个出口要下载，例如 ${needingDownload.slice(0, 3).join(', ')}`
  )

  /* --------------------------------------------------- C：markdown resource */

  console.log('\n[C] converter://formats 的 markdown')
  const md = viewModule.formatsMarkdown()
  check('markdown 非空', md.length > 0, `${md.length} 字符`)
  check(
    'resource URI 与函数放在一起（server 那侧直接用它）',
    viewModule.FORMATS_RESOURCE_URI === 'converter://formats'
  )
  const sections = splitSections(md)
  check(
    'markdown 里六个类别一个不少（防空转：段落表为空时下面的循环一条都不跑）',
    diffSet([...sections.keys()], [...CATEGORIES]) === '' && sections.size > 0,
    `实际段落：${[...sections.keys()].join(', ')}`
  )

  for (const cat of CATEGORIES) {
    const body = sections.get(cat) ?? ''
    const expectedExts = byCategory[cat]
    check(`[${cat}] markdown 段落非空`, body.length > 0)

    const unionCell = /^目标格式并集：(.*)$/m.exec(body)?.[1] ?? ''
    check(
      `[${cat}] 声明的目标并集与 targetsForCategory() 逐字一致`,
      diffOrdered(inlineNames(unionCell), targetsForCategory(cat)) === '',
      diffOrdered(inlineNames(unionCell), targetsForCategory(cat))
    )

    const rows = parseRows(body)
    check(
      `[${cat}] 表格行数 = 该类别源格式数（防空转：下面两条在空表上恒真）`,
      rows.length === expectedExts.length && rows.length > 0,
      `表里 ${rows.length} 行，登记 ${expectedExts.length} 个源格式`
    )
    check(
      `[${cat}] 表格里的源格式与登记顺序逐字一致`,
      diffOrdered(
        rows.map((row) => row.ext),
        expectedExts
      ) === '',
      diffOrdered(
        rows.map((row) => row.ext),
        expectedExts
      )
    )
    const lying = rows.filter((row) => diffOrdered(row.targets, targetsFor(row.ext)) !== '')
    check(
      `[${cat}] 每一行声明的目标与 targetsFor() 逐字一致`,
      rows.length > 0 && lying.length === 0,
      lying.map((row) => `${row.ext}: ${JSON.stringify(row.targets)}`).join(' | ')
    )
    // 表行里出现过的目标合起来必须正好是类别并集——两侧都断言才分得清「漏了」与「多了」
    const fromRows = [...new Set(rows.flatMap((row) => row.targets))]
    check(
      `[${cat}] 表行目标的并集 = 类别目标并集`,
      diffOrdered(fromRows, targetsForCategory(cat)) === '',
      diffOrdered(fromRows, targetsForCategory(cat))
    )
    // 「要下载的出口」那一列同样要有覆盖：上面几条只比目标格式，引擎列整体渲染成 `—`
    // 也一条都不会红。这里按视图逐个源反查——该源的每个要下载的目标与该引擎名，
    // 都必须出现在它那一行的第三格里。
    const categorySources = views.find((item) => item.category === cat)?.sources ?? []
    const missingDownloads = categorySources.filter((source) => {
      const cell = rows.find((row) => row.ext === source.ext)?.extra ?? ''
      const wanted = [...Object.keys(source.downloadFor), ...Object.values(source.downloadFor)]
      return wanted.some((name) => !cell.includes(`\`${name}\``))
    })
    check(
      `[${cat}] 每一行都把「要下载的出口」写全了（目标与引擎名都点名）`,
      rows.length > 0 && categorySources.length > 0 && missingDownloads.length === 0,
      missingDownloads.map((source) => source.ext).join(', ')
    )
  }

  // 上面那条逐行反查只在「该源确实有要下载的出口」时有鉴别力：video / audio / image /
  // archive 四类的 `downloadFor` 全是空对象，把渲染改成「引擎列恒为 `—`」它们照样全绿
  // （`wanted` 是空数组，`some` 恒为 false）——这正是 docs/NOTES.md 点名的「空集合上恒真」。
  // 所以这里换个方向再问一遍：视图里出现过的每个引擎名，都必须出现在**表格第三格**里。
  // **不收整篇 markdown**：正文的示例句里也写着 `pandoc`，拿整篇去搜会把这条断言喂饱。
  const renderedDownloads = new Set(
    CATEGORIES.flatMap((cat) =>
      parseRows(sections.get(cat) ?? '').flatMap((row) => inlineNames(row.extra))
    )
  )
  const downloadEngines = [
    ...new Set(
      views.flatMap((view) => view.sources.flatMap((item) => Object.values(item.downloadFor)))
    )
  ]
  check(
    'markdown 的引擎列写出了每一个「要下载的引擎」（防空转：名单为空时下面恒真）',
    downloadEngines.length > 0 && downloadEngines.every((engine) => renderedDownloads.has(engine)),
    `名单 ${downloadEngines.join(', ')}，表里出现的是 ${[...renderedDownloads].join(', ')}`
  )

  /* -------------------------------------------- D：OpenAI function calling */

  console.log('\n[D] openAiTools() 的 parameters')
  let requiredSeen = 0
  for (const tool of tools) {
    const name = tool.function.name
    const params = tool.function.parameters
    const properties = params.properties ?? {}
    check(
      `${name}: type 是 function、parameters 是带 properties 的 object schema`,
      tool.type === 'function' &&
        params.type === 'object' &&
        typeof params.properties === 'object' &&
        Object.keys(properties).length > 0,
      JSON.stringify({ type: params.type, keys: Object.keys(properties) })
    )
    const shape = shapeOf(TOOL_SCHEMAS[name])
    check(
      `${name}: properties 的键与 zod 的 shape 完全一致（没被 toJSONSchema 吃掉字段）`,
      Object.keys(shape).length > 0 && diffSet(Object.keys(properties), Object.keys(shape)) === '',
      diffSet(Object.keys(properties), Object.keys(shape))
    )
    // 独立地问一遍 zod「哪些是必填」，再跟 JSON Schema 里那份 required 对拍
    const requiredByZod = Object.keys(shape).filter(
      (key) => !shape[key].safeParse(undefined).success
    )
    const requiredInSchema = [...(params.required ?? [])]
    requiredSeen += requiredInSchema.length
    check(
      `${name}: required 与 zod 的必填判定一致`,
      Object.keys(shape).length > 0 && diffSet(requiredInSchema, requiredByZod) === '',
      `schema ${JSON.stringify(requiredInSchema)} vs zod ${JSON.stringify(requiredByZod)}`
    )
  }
  check(
    '至少有一个工具声明了必填项（防空转：全部 required 为空时上面那条对拍会退化成恒真）',
    requiredSeen > 0,
    `${requiredSeen} 个必填项`
  )

  const convertParams = tools.find((tool) => tool.function.name === 'convert_file')?.function
    .parameters
  const convertProps = (convertParams?.properties ?? {}) as Record<string, { default?: unknown }>
  const convertRequired = convertParams?.required ?? []
  check(
    'convert_file：mode 带默认值、因此不在 required 里（`io:"input"` 是承重的）',
    convertRequired.includes('source') &&
      convertRequired.includes('target_format') &&
      !convertRequired.includes('mode') &&
      convertProps.mode?.default === 'auto',
    `required=${JSON.stringify(convertRequired)}，mode.default=${JSON.stringify(convertProps.mode?.default)}`
  )

  // `quality` 曾经在这里：声明了、描述里讲了，**执行路径里从没读过**
  // （`submit()` 的签名里没有它，`ConvertContext` 里也没有）。传了它的 agent 会拿到
  // `status: done` 与正常的 size_bytes，没有任何提示说这个参数被忽略了——
  // 「以为设了、其实没设」正是这个项目最忌讳的那类静默失败。它已删除，
  // 这条断言钉的是「不许回来」：键集写死成字面量，多一个键就红。
  //
  // 2026-09-14 加了第五个键 `verify`（E-6 产物自检）。**这次改动正是这条断言在起作用**：
  // 它逼着「多一个参数」这件事必须有人过一眼，而那个「人」在这里留了这一行说明。
  // 那第四个键（`mode`）是承重的，别顺手删——删了它就挡不住死参数回来了。
  // 同日又加了第六个 `dry_run`（E-5 预览），同一个道理：这里是**刻意的字面量**，
  // 多一个键必须有人过一眼（底下 [I] 那组把它的形状、默认值与说明书逐条钉住）。
  //
  // 2026-09-16 加第七个 `priority`（R16 优先级）：**这条断言又一次正好在起作用**
  // ——加参数的那一步它会红，逼着人回来写这行说明。它与 `dry_run` 的性质不同：
  // `dry_run` 是「只预览不写盘」，而这个是**真的会改变调度顺序**的旋钮。
  // 别顺手删任何一个：`mode` 挡的是死参数回来，`quality` 那行注释记着它为什么不该回来。
  check(
    'convert_file：properties 恰好是这七个键（quality 已删不许回来；verify=E-6，dry_run=E-5，priority=R16）',
    diffSet(Object.keys(convertProps), [
      'source',
      'target_format',
      'output_path',
      'mode',
      'verify',
      'dry_run',
      'priority'
    ]) === '',
    `实际=${JSON.stringify(Object.keys(convertProps))}`
  )

  const listParams = tools.find((tool) => tool.function.name === 'list_jobs')?.function.parameters
  const listProps = (listParams?.properties ?? {}) as Record<string, { default?: unknown }>
  const listRequired = listParams?.required ?? []
  check(
    `list_jobs：limit 有小的默认值（${String(listProps.limit?.default)}）且不在 required 里`,
    typeof listProps.limit?.default === 'number' &&
      (listProps.limit.default as number) > 0 &&
      !listRequired.includes('limit'),
    `required=${JSON.stringify(listRequired)}，limit.default=${JSON.stringify(listProps.limit?.default)}`
  )
  check(
    'list_jobs：默认条数远小于上限（防空转：默认值等于上限时，上面那条挡不住「一次全量」）',
    typeof listProps.limit?.default === 'number' &&
      listProps.limit.default < schemaModule.MAX_LIST_LIMIT,
    `默认=${JSON.stringify(listProps.limit?.default)} 上限=${schemaModule.MAX_LIST_LIMIT}`
  )
  check(
    'list_jobs：三个参数都在（status / limit / since）',
    diffSet(Object.keys(listProps), ['status', 'limit', 'since']) === '',
    `实际=${JSON.stringify(Object.keys(listProps))}`
  )
  // read_document 的参数形状与那三个常量是**一处定义**的（schema.ts）。这里钉的是
  // 「它真的从 zod 派生出来了」：format 的取值域、默认值、上限三者必须对得上，
  // 而不是描述里写着一套、代码里另一套（那正是这个文件开篇要防的漂移）。
  const readParams = tools.find((tool) => tool.function.name === 'read_document')?.function
    .parameters
  const readProps = (readParams?.properties ?? {}) as {
    format?: { enum?: unknown; default?: unknown }
    max_chars?: { default?: unknown }
    offset?: { default?: unknown }
  }
  const readRequired = readParams?.required ?? []
  check(
    'read_document：properties 恰好是这四个键（source / format / max_chars / offset）',
    diffSet(Object.keys(readProps), ['source', 'format', 'max_chars', 'offset']) === '',
    `实际=${JSON.stringify(Object.keys(readProps))}`
  )
  check(
    'read_document：只有 source 是必填（三个带默认值的都不进 required，io:"input" 是承重的）',
    diffSet(readRequired, ['source']) === '',
    `required=${JSON.stringify(readRequired)}`
  )
  check(
    'read_document：format 的枚举就是 READ_FORMATS（三个出口与执行层共用一份字面量）',
    schemaModule.READ_FORMATS.length > 0 &&
      JSON.stringify(readProps.format?.enum) === JSON.stringify([...schemaModule.READ_FORMATS]),
    `enum=${JSON.stringify(readProps.format?.enum)} READ_FORMATS=${JSON.stringify([
      ...schemaModule.READ_FORMATS
    ])}`
  )
  check(
    'read_document：format 默认 md、offset 默认 0',
    readProps.format?.default === 'md' && readProps.offset?.default === 0,
    `format.default=${JSON.stringify(readProps.format?.default)} offset.default=${JSON.stringify(
      readProps.offset?.default
    )}`
  )
  // 默认值必须**远小于**上限。两者相等时，「一次把 300 页 PDF 塞进上下文」这件事就挡不住了，
  // 而那正是这个参数存在的全部理由——这条断言是防它变成装饰的那一半。
  check(
    `read_document：max_chars 默认 ${String(readProps.max_chars?.default)} 且远小于上限 ${schemaModule.MAX_READ_CHARS}`,
    typeof readProps.max_chars?.default === 'number' &&
      (readProps.max_chars.default as number) > 0 &&
      (readProps.max_chars.default as number) < schemaModule.MAX_READ_CHARS,
    `默认=${JSON.stringify(readProps.max_chars?.default)} 上限=${schemaModule.MAX_READ_CHARS}`
  )
  // 说明书里那句「重型格式别拿它去试」是这一版最重要的边界：不写死的话，模型一定会拿它
  // 去读一个 .ppt，然后拿到一句它读不懂的拒绝。所以点名要有那两个引擎与它们的下载体积。
  const readDocText = TOOL_DESCRIPTIONS.read_document ?? ''
  check(
    'read_document 的说明书点名了不做的那两类重型引擎与代价（LibreOffice 357 / Calibre 213）',
    readDocText.includes('LibreOffice') &&
      readDocText.includes('357') &&
      readDocText.includes('Calibre') &&
      readDocText.includes('213'),
    readDocText.slice(0, 100)
  )
  check(
    'read_document 的说明书写明了「扫描件 PDF 没有文本层、本项目不含 OCR」（否则模型会反复重试）',
    readDocText.includes('OCR') && readDocText.includes('文本层'),
    readDocText.slice(0, 100)
  )
  check(
    'read_document 的说明书交代了分块续读（offset / truncated / total_chars 三个词都在）',
    readDocText.includes('offset') &&
      readDocText.includes('truncated') &&
      readDocText.includes('total_chars'),
    readDocText.slice(0, 100)
  )

  // E-3 的三件套**必须写在说明书里**：模型不会用一个它没读到过的字段。
  // 判据分两半——先把「这段文字确实是 inspect_file 的」（防空转：换成一个空串或
  // 一段别的话，两个 includes 都会失败，但失败原因看不出来），再逐个点名。
  const inspectText = TOOL_DESCRIPTIONS.inspect_file ?? ''
  check(
    'inspect_file 的说明书点名了代价三件套（cost / lossy / estimate 各字段名都在）',
    inspectText.includes('侦察') &&
      inspectText.includes('cost') &&
      inspectText.includes('download_bytes') &&
      inspectText.includes('network_required') &&
      inspectText.includes('lossy') &&
      inspectText.includes('estimate') &&
      inspectText.includes('seconds') &&
      inspectText.includes('confidence'),
    inspectText.slice(0, 120)
  )
  // `estimate` 是**区间 + 置信度**，而「没有置信度」正是 agent 会把区间当承诺的那条路
  // （RESEARCH §5 点名过）。所以「它是区间」「要先看 confidence」两句话必须在。
  check(
    'inspect_file 的说明书写明了 estimate 是区间、且要先看 confidence',
    inspectText.includes('区间') &&
      inspectText.includes('confidence') &&
      inspectText.includes('high'),
    inspectText.slice(0, 120)
  )

  /* --------------------------------------------------- E：错误码表（机器可读） */

  console.log('\n[E] 错误码表')
  const { ERROR_CODES, failureOf, McpToolError, PathNotAllowed, policyFor } = errorsModule
  check(
    '码表非空（防空转：下面几条在空表上恒真）',
    ERROR_CODES.length > 0,
    `拿到 ${ERROR_CODES.length} 个码`
  )
  const retryableFlags = ERROR_CODES.map((code) => policyFor(code).retryable)
  check(
    '**retryable 不是常量**：至少一个 true、至少一个 false',
    retryableFlags.some((flag) => flag === true) && retryableFlags.some((flag) => flag === false),
    ERROR_CODES.map((code) => `${code}=${String(policyFor(code).retryable)}`).join(' ')
  )
  check(
    'source_corrupt 是 retryable=false（同一个坏文件转多少次都一样）',
    policyFor('source_corrupt').retryable === false,
    `retryable=${String(policyFor('source_corrupt').retryable)}`
  )
  check(
    '每个码都有非空的 next_steps（空数组等于「你自己想办法」）',
    ERROR_CODES.length > 0 && ERROR_CODES.every((code) => policyFor(code).next_steps.length > 0),
    ERROR_CODES.filter((code) => policyFor(code).next_steps.length === 0).join(', ')
  )
  // 三项是**所有人**都拿得到，不是「给了码才给」：agent 侧不该出现
  // 「有时有 code 有时没有」这种形状。
  const plainFailure = failureOf(new Error('一个原生异常'))
  check(
    '非 McpToolError 的原生异常 → code=internal / retryable=true / 有 next_steps',
    plainFailure.code === 'internal' &&
      plainFailure.retryable === true &&
      plainFailure.next_steps.length > 0,
    JSON.stringify(plainFailure)
  )
  const coded = failureOf(
    new McpToolError('转不了', { targets: ['jpg'] }, { code: 'target_not_supported' })
  )
  check(
    '抛出的错误带上码与 hint：码取自己的、next_steps 取码表的、hint 原样透传',
    coded.code === 'target_not_supported' &&
      coded.retryable === false &&
      coded.next_steps.length > 0 &&
      JSON.stringify(coded.hint) === JSON.stringify({ targets: ['jpg'] }),
    JSON.stringify(coded)
  )
  const gate = failureOf(new PathNotAllowed('越界了', { roots: ['D:\\a'] }))
  check(
    'PathNotAllowed 自带 path_not_allowed 码（分类只此一处）',
    gate.code === 'path_not_allowed' && gate.retryable === false,
    JSON.stringify(gate)
  )
  // 抛出时的覆盖**必须生效**：`Next` 那三条都是 `??` 落下来的，写成恒取码表值
  // 就会让「这一处的重试语义与同类不同」这件事静默失效。
  const overridden = failureOf(
    new McpToolError('某处特殊的失败', undefined, {
      code: 'source_corrupt',
      retryable: true,
      next_steps: ['就这一处不一样']
    })
  )
  check(
    '抛出时给的三项覆盖码表默认值（覆盖分支是承重的，不是装饰）',
    overridden.retryable === true &&
      JSON.stringify(overridden.next_steps) === JSON.stringify(['就这一处不一样']),
    JSON.stringify(overridden)
  )
  check(
    '码是去重的、且全是小写 snake_case（agent 要拿它做 switch，命名是契约的一部分）',
    new Set(ERROR_CODES).size === ERROR_CODES.length &&
      ERROR_CODES.every((code) => /^[a-z]+(_[a-z]+)*$/.test(code)),
    ERROR_CODES.join(', ')
  )

  /* --------------------------- F：read_document 的决策层（纯函数，不起任何进程） */

  console.log('\n[F] read_document 的决策层（resolveReadPlan）')

  // 防空转前提：下面那些「某个格式 → 某个计划」的断言，在可读集合为空时会退化成
  // 「这个扩展名本来就不该能读」——**空集合上的否定断言恒真**（本仓库抓到过四条）。
  const readable = readPlanModule.readableExts()
  check(
    'readableExts() 恰好是那十个纯 JS 可读的文档格式（防空转前提）',
    diffSet(readable, [
      'md',
      'markdown',
      'txt',
      'html',
      'htm',
      'rst',
      'docx',
      'xlsx',
      'pdf',
      'csv'
    ]) === '',
    `实际=${JSON.stringify(readable)}`
  )

  // 三条拒绝路径的**码各不相同**，因为 agent 该做的事完全不同：重型引擎 → 要先让用户
  // 决定下不下（engine_missing）；不是文档 → 换工具（not_readable）；认不出 → 改路径
  // （unknown_format）。三条都从「抛了没有」与「码是什么」两个方向问。
  function planErrorOf(ext: string, format: 'md' | 'txt' | 'csv'): Record<string, unknown> {
    try {
      readPlanModule!.resolveReadPlan(ext, format)
      return { threw: false }
    } catch (error) {
      return { ...(failureOf(error) as unknown as Record<string, unknown>), threw: true }
    }
  }

  // 防空转：这两个格式必须真的被矩阵认得。否则它们是被 unknown_format 拒的，
  // 下面两条就完全测不到「重型引擎」那条分支。
  check(
    '前提：doc / epub 在能力矩阵里是认得的格式（否则下面两条测的不是重型引擎分支）',
    categoryOf('doc') === 'document' && categoryOf('epub') === 'ebook',
    `doc=${String(categoryOf('doc'))} epub=${String(categoryOf('epub'))}`
  )
  const docPlan = planErrorOf('doc', 'md')
  check(
    'doc → 拒，码是 engine_missing，且 hint 把代价说出来了（357 MiB + 点名 libreoffice）',
    docPlan.threw === true &&
      docPlan.code === 'engine_missing' &&
      docPlan.retryable === false &&
      JSON.stringify(docPlan.hint).includes('357') &&
      JSON.stringify(docPlan.hint).includes('libreoffice'),
    JSON.stringify(docPlan).slice(0, 240)
  )
  const epubPlan = planErrorOf('epub', 'md')
  check(
    'epub → 拒，码是 engine_missing，代价是 Calibre 213 MiB（与 doc 那条不是同一套文案）',
    epubPlan.threw === true &&
      epubPlan.code === 'engine_missing' &&
      JSON.stringify(epubPlan.hint).includes('213') &&
      JSON.stringify(epubPlan.hint).includes('calibre'),
    JSON.stringify(epubPlan).slice(0, 240)
  )
  // 重型那一条**必须排在解析目标格式之前**：`.xls` 的目标里根本没有 md/txt/csv。
  // 顺序反了的话它会走到「没有可读的文本出口」那条兜底错上——同样是拒绝，但 agent
  // 看到的是一句「没有出口」，而不是「要下 357 MiB」。这条专门钉那个顺序。
  const xlsPlan = planErrorOf('xls', 'md')
  check(
    'xls（目标里一个文本出口都没有）报的仍然是「要下 357 MiB」，而不是「没有出口」',
    xlsPlan.threw === true &&
      xlsPlan.code === 'engine_missing' &&
      JSON.stringify(xlsPlan.hint).includes('357'),
    JSON.stringify(xlsPlan).slice(0, 240)
  )

  const videoPlan = planErrorOf('mp4', 'md')
  check(
    'mp4 → 拒，码是 not_readable（不是 unknown_format：格式认得，只是没有「正文」可读）',
    videoPlan.threw === true && videoPlan.code === 'not_readable' && videoPlan.retryable === false,
    JSON.stringify(videoPlan).slice(0, 200)
  )
  check(
    'png / zip 同样走 not_readable（防空转：证明上面那条不是「只有 mp4 被特判」）',
    planErrorOf('png', 'md').code === 'not_readable' &&
      planErrorOf('zip', 'md').code === 'not_readable',
    `png=${String(planErrorOf('png', 'md').code)} zip=${String(planErrorOf('zip', 'md').code)}`
  )
  check(
    '认不出的扩展名与空扩展名走 unknown_format（要改的是路径，不是做法）',
    planErrorOf('xyz', 'md').code === 'unknown_format' &&
      planErrorOf('', 'md').code === 'unknown_format',
    `xyz=${String(planErrorOf('xyz', 'md').code)} 空=${String(planErrorOf('', 'md').code)}`
  )

  // 回落链：源格式没有请求的那个出口时，**必须换一个并在 warnings 里说出来**。
  // 每条都同时断言「换成了什么」与「有没有说」——只断言前者的话，
  // 悄悄换一个而不吭声（agent 会把它当成自己要的那个）同样能绿。
  const pdfCsv = readPlanModule.resolveReadPlan('pdf', 'csv')
  check(
    'pdf + csv：退到 txt，且 warnings 里有话（pdf 的出口只有 png/jpg/txt/md）',
    pdfCsv.convert === true && pdfCsv.toExt === 'txt' && pdfCsv.warnings.length > 0,
    JSON.stringify(pdfCsv)
  )
  const docxCsv = readPlanModule.resolveReadPlan('docx', 'csv')
  check(
    'docx + csv：退到 txt（不是 csv、也不是 md），且 warnings 里有话',
    docxCsv.convert === true && docxCsv.toExt === 'txt' && docxCsv.warnings.length > 0,
    JSON.stringify(docxCsv)
  )
  const xlsxMd = readPlanModule.resolveReadPlan('xlsx', 'md')
  check(
    'xlsx + md：退到 csv（表格唯一说得通的文本形态），且 warnings 里有话',
    xlsxMd.convert === true && xlsxMd.toExt === 'csv' && xlsxMd.warnings.length > 0,
    JSON.stringify(xlsxMd)
  )

  // 要得到的那几支：**不带 warnings**（没有东西被换掉或丢掉就不该有噪声）。
  // 它与上面三条互为对照——少了它，把 warnings 写成恒定非空也能全绿。
  const pdfMd = readPlanModule.resolveReadPlan('pdf', 'md')
  const docxMd = readPlanModule.resolveReadPlan('docx', 'md')
  check(
    'pdf + md 与 docx + md 直接命中（convert、无 warning）——防空转：证明上面三条的 warnings 不是恒非空',
    pdfMd.convert === true &&
      pdfMd.toExt === 'md' &&
      pdfMd.warnings.length === 0 &&
      docxMd.convert === true &&
      docxMd.toExt === 'md' &&
      docxMd.warnings.length === 0,
    `pdf=${JSON.stringify(pdfMd)} docx=${JSON.stringify(docxMd)}`
  )
  const htmlMd = readPlanModule.resolveReadPlan('html', 'md')
  check(
    'html + md 走转换（要真的剥标签），不是原样返回',
    htmlMd.convert === true && htmlMd.toExt === 'md',
    JSON.stringify(htmlMd)
  )
  const rstMd = readPlanModule.resolveReadPlan('rst', 'md')
  check(
    'rst + md 走转换（解析要 pandoc，引擎那条判据在运行时那道闸上，不在这里）',
    rstMd.convert === true && rstMd.toExt === 'md',
    JSON.stringify(rstMd)
  )

  // 本来就是文字的源：**原样返回**，一个字节都不动。这一支最容易写错成「反正矩阵里有
  // md，那就转一圈」——`txt → md` 会绕 HTML 一趟，纯文本被包进代码围栏、`#` 变标题。
  const txtMd = readPlanModule.resolveReadPlan('txt', 'md')
  const mdMd = readPlanModule.resolveReadPlan('md', 'md')
  const csvCsv = readPlanModule.resolveReadPlan('csv', 'csv')
  check(
    '已原文文本：.txt 报 txt、.md 报 md、.csv 要 csv 报 csv，三者都不转换、也不告警',
    txtMd.convert === false &&
      txtMd.format === 'txt' &&
      txtMd.warnings.length === 0 &&
      mdMd.convert === false &&
      mdMd.format === 'md' &&
      csvCsv.convert === false &&
      csvCsv.format === 'csv',
    `txt+md=${JSON.stringify(txtMd)} md+md=${JSON.stringify(mdMd)} csv+csv=${JSON.stringify(csvCsv)}`
  )
  const csvMd = readPlanModule.resolveReadPlan('csv', 'md')
  check(
    'csv + md：矩阵里没有这个出口，退成「csv 原文」并说清（既不报错，也不硬造一个 md）',
    csvMd.convert === false && csvMd.format === 'csv' && csvMd.warnings.length > 0,
    JSON.stringify(csvMd)
  )
  const markdownMd = readPlanModule.resolveReadPlan('markdown', 'md')
  check(
    '.markdown 与 .md 是同一个东西（别名），走同一条原文分支',
    markdownMd.convert === false && markdownMd.format === 'md',
    JSON.stringify(markdownMd)
  )

  // 普适不变量：**凡是要转换的计划，目标必须在能力矩阵里**。逐格式的断言挡不住
  // 「回落链给了一个矩阵里没有的出口」——那会在运行时直接抛错，而恰好可能没有一个
  // 逐格式断言覆盖到那个格式。这里把 30 种组合全扫一遍，`format` 的取值域也一起扫。
  const illegal: string[] = []
  for (const ext of readable) {
    for (const format of ['md', 'txt', 'csv'] as const) {
      let plan
      try {
        plan = readPlanModule.resolveReadPlan(ext, format)
      } catch {
        continue // 拒绝是另一条断言的事，这里只管放行了的那一些
      }
      if (plan.convert && !targetsFor(ext).includes(plan.toExt)) {
        illegal.push(`${ext}+${format}→${plan.toExt} 不在矩阵里`)
      }
      if (!schemaModule.READ_FORMATS.includes(plan.format)) {
        illegal.push(`${ext}+${format} 的 format=${plan.format}`)
      }
    }
  }
  check(
    `每个可读格式 × 三种请求（${readable.length * 3} 种）：放行的计划要么不转换、要么目标在矩阵里，且 format 恒在 READ_FORMATS 内`,
    illegal.length === 0 && readable.length > 0,
    illegal.join(', ')
  )

  /* ------------------------------- H：E-6 产物自检（参数形状 + 判据的宽严） */

  console.log('\n[H] 产物自检（E-6）')

  // 判据那一半（`verify.ts`）必须是**纯的**：零运行时 import，所以它能在封锁 electron
  // 的进程里被逐条钉住。这不是洁癖——「判据宽不宽」这件事**只能**靠人造探针去问：
  // 真跑一遍转换根本造不出「时长差 0.03s」「gif 没有音轨」这些边界，而判据过严
  // （把正常产物判成「不对」）比不做更坏，所以它必须是被钉住的那一半。
  let verifyModule: LoadedVerify | null = null
  let verifyLoadError = ''
  try {
    verifyModule = await import('../src/mcp/verify')
  } catch (error) {
    verifyLoadError = error instanceof Error ? error.message.split('\n')[0] : String(error)
  }
  check(
    'verify.ts 能在封锁 electron 的进程里加载（判据那一半是纯的，零运行时 import）',
    verifyModule !== null,
    verifyLoadError
  )
  // 这是「判据与侦察分家」那条界线的可执行版本：判据**不许**把 `inspect.ts`
  // （进而 src/main、sharp）拖进来。少了这条，某次「顺手 import 一下」会在 [G] 里
  // 以「没有 src/main」的形态红掉——那条断言说的是另一件事（它读整个缓存），
  // 定位要绕一圈才找得到这里。
  const mcpCached = cacheKeys().filter((key) => key.includes('src/mcp/'))
  check(
    '加载 verify.ts 没有把 inspect.ts 拖进来（判据可以被单测，侦察不行）',
    verifyModule !== null && !mcpCached.some((key) => key.includes('src/mcp/inspect')),
    mcpCached.join(', ')
  )

  const convertText = TOOL_DESCRIPTIONS.convert_file ?? ''
  const batchText = TOOL_DESCRIPTIONS.batch_convert ?? ''
  const zodDefaultOf = (schema: unknown): unknown => {
    // 独立地问一遍 zod：**不传这个参数时它算出来是什么**。`safeParse(undefined).success`
    // 只能回答「是不是必填」，而「默认关」这件事问的是值，不是必填性。
    try {
      return (schema as { parse: (value: unknown) => unknown }).parse(undefined)
    } catch {
      return '（抛错了）'
    }
  }
  const knownJobStatusText = TOOL_DESCRIPTIONS.get_job_status ?? ''
  const listJobsText = TOOL_DESCRIPTIONS.list_jobs ?? ''

  for (const toolName of ['convert_file', 'batch_convert'] as const) {
    const jsonProperties = (jsonSchemas()[toolName].properties ?? {}) as Record<string, unknown>
    const jsonRequired = jsonSchemas()[toolName].required ?? []
    const openAiParameters = tools.find((tool) => tool.function.name === toolName)?.function
      .parameters
    const openAiProperties = (openAiParameters?.properties ?? {}) as Record<string, unknown>
    const zodShape = shapeOf(TOOL_SCHEMAS[toolName])
    // **一份定义、三个出口**：三者都由 `TOOL_SCHEMAS` 派生，「漏在某一边」在结构上
    // 写不出来——但本文件开篇防的就是这类漂移，所以三个出口各问一遍（照 [D] 那条
    // 「键集与 zod 的 shape 完全一致」的先例）。
    check(
      `H1 ${toolName}：verify 在三个出口里都在（zod shape / JSON Schema / OpenAI parameters）`,
      Object.keys(zodShape).includes('verify') &&
        Object.keys(jsonProperties).includes('verify') &&
        Object.keys(openAiProperties).includes('verify'),
      `zod=${Object.keys(zodShape).includes('verify')} json=${Object.keys(jsonProperties).includes(
        'verify'
      )} openai=${Object.keys(openAiProperties).includes('verify')}`
    )
    const jsonDefault = (jsonProperties.verify as { default?: unknown } | undefined)?.default
    const openAiDefault = (openAiProperties.verify as { default?: unknown } | undefined)?.default
    check(
      `H2 ${toolName}：verify 默认 false（两个 JSON Schema 出口都写着）且不在 required 里`,
      jsonDefault === false &&
        openAiDefault === false &&
        !jsonRequired.includes('verify') &&
        !(openAiParameters?.required ?? []).includes('verify'),
      `json.default=${JSON.stringify(jsonDefault)} openai.default=${JSON.stringify(
        openAiDefault
      )} required=${JSON.stringify(jsonRequired)}`
    )
    check(
      `H3 ${toolName}：zod 那侧独立问一遍——不传 verify 时算出来是 false（不是 true，也不是 undefined）`,
      zodDefaultOf(zodShape.verify) === false,
      `parse(undefined)=${JSON.stringify(zodDefaultOf(zodShape.verify))}`
    )
  }
  // 说明书是模型唯一的入口：模型不会用一个它没读到过的开关（与 E-3 的三件套同一条理由）。
  // 判据分两半——先证明这段文字确实是 convert_file 的（防空转：换成一个空串也会让
  // 下面两个 includes 失败，但看不出失败原因），再逐个点名。
  check(
    'H4 convert_file 的说明书写明了 verify 的两件事：多起两个引擎子进程、所以默认关',
    convertText.includes('侦察链路') &&
      convertText.includes('verify') &&
      convertText.includes('两个引擎子进程') &&
      convertText.includes('默认关') &&
      convertText.includes('只报事实'),
    convertText.length > 0 ? convertText.slice(convertText.indexOf('verify') - 20, 200) : '空'
  )
  check(
    'H5 batch_convert 的说明书也点名了 verify（同一个开关，第二个工具上不能没有）',
    batchText.includes('verify') && batchText.includes('两倍'),
    batchText.slice(-160)
  )
  // 自检结果从哪读：两条路都要说（否则模型只会去 convert_file 的返回值里找，
  // 而批量那条路**当场不等结果**，它只能从 list_jobs / get_job_status 拿）。
  check(
    'H6 get_job_status / list_jobs 的说明书写明了自检结果的读法（完整事实 vs 结论）',
    knownJobStatusText.includes('verification') &&
      listJobsText.includes('verification_status') &&
      listJobsText.includes('consistent'),
    `status=${knownJobStatusText.includes('verification')} list=${listJobsText.includes(
      'verification_status'
    )}`
  )

  if (verifyModule === null) {
    console.log('  ⊘ 判据模块没加载起来，[H] 那一组判据断言无从谈起——不装作通过')
  } else {
    const compare = verifyModule.compareConversion
    type SideProbe = Parameters<typeof compare>[0]['probe']
    type Side = Parameters<typeof compare>[0]
    const VIDEO: NonNullable<SideProbe> = {
      durationSec: 12.5,
      width: 1920,
      height: 1080,
      hasVideo: true,
      hasAudio: true,
      videoCodec: 'h264',
      audioCodec: 'aac'
    }
    const IMAGE: NonNullable<SideProbe> = {
      durationSec: null,
      width: 1920,
      height: 1080,
      hasVideo: false,
      hasAudio: false,
      videoCodec: null,
      audioCodec: null
    }
    const EMPTY: NonNullable<SideProbe> = {
      durationSec: null,
      width: null,
      height: null,
      hasVideo: false,
      hasAudio: false,
      videoCodec: null,
      audioCodec: null
    }
    const side = (
      probe: SideProbe,
      category: Side['category'],
      ext: string,
      note: string | null = null
    ): Side => ({ path: `D:\\tmp\\x.${ext}`, ext, category, size_bytes: 2048, probe, note })

    /* ---- 判据要宽：三条「看着像差异、其实不是」的正常路径 ---- */

    const plain = compare(side(VIDEO, 'video', 'mp4'), side(VIDEO, 'video', 'mkv'))
    check(
      'H7 正常转换（同一条流换容器）→ consistent，五项全查、facts 给数、notes 不废话',
      plain.status === 'consistent' &&
        plain.checked.length === 5 &&
        plain.notes.length === 0 &&
        plain.facts.some((f) => f.includes('分辨率 1920x1080')) &&
        plain.facts.some((f) => f.includes('音轨：源与产物都有')),
      JSON.stringify({ status: plain.status, checked: plain.checked, notes: plain.notes })
    )

    // `ts → mp4` 要**重新分装**，容器报的时长会变——判成「不一致」就是把正常产物判成坏
    const reframed = compare(
      side(VIDEO, 'video', 'ts'),
      side({ ...VIDEO, durationSec: 12.8 }, 'video', 'mp4')
    )
    check(
      'H8 时长对不齐不算差异（ts → mp4 会重新分装）：仍是 consistent，差如实报出来',
      reframed.status === 'consistent' &&
        reframed.comparison.duration_delta_sec === 0.3 &&
        reframed.facts.some((f) => f.includes('+0.30s')) &&
        reframed.facts.some((f) => f.includes('12.50s')),
      JSON.stringify(reframed.comparison)
    )
    // 差得再多也**不改判定**：容器的时长是「报」出来的，判成不一致就是又一条会撒谎的断言。
    // 但它必须被说出来——所以这里同时钉「不改判定」与「多一条说明」两半。
    const bigGap = compare(
      side(VIDEO, 'video', 'mp4'),
      side({ ...VIDEO, durationSec: 16.5 }, 'video', 'mp4')
    )
    check(
      'H9 时长差到 4 秒也**不改判定**，只多一条说明（判据宽的那一侧，不是把差异藏起来）',
      bigGap.status === 'consistent' &&
        bigGap.notes.length === 1 &&
        bigGap.notes[0].includes('+4.00s'),
      JSON.stringify({ status: bigGap.status, notes: bigGap.notes })
    )
    // 换容器必然换编码器（mp4 → webm 一定从 h264 变 vp9/vp8）。把它算成差异的话，
    // 「webm 转出来总是不对」会成为一个恒红且无从下手的结论。
    const recoded = compare(
      side(VIDEO, 'video', 'mp4'),
      side({ ...VIDEO, videoCodec: 'vp9', audioCodec: 'opus' }, 'video', 'webm')
    )
    check(
      'H10 编解码器变了不算差异（mp4 → webm 必然 h264 → vp9）：只报事实 + 一条说明',
      recoded.status === 'consistent' &&
        recoded.comparison.video_codec_matches === false &&
        recoded.facts.some((f) => f.includes('源 h264 → 产物 vp9')) &&
        recoded.notes.some((n) => n.includes('不算差异')),
      JSON.stringify({ status: recoded.status, facts: recoded.facts })
    )

    /* ---- 判据要宽：图片 / gif / 文档 / 压缩包都不该「编」出编解码器与时长 ---- */

    // gif 的尺寸刻意**与源不同**（64x48 的源转出来是 480 宽）：那正是真产物的形态，
    // 也正是判据最容易写严的地方——`GIF_FILTER` 里那个 `scale=480:-1` 是我们自己写的。
    const gif = compare(
      side(VIDEO, 'video', 'mp4'),
      side({ ...IMAGE, width: 480, height: 360 }, 'image', 'gif')
    )
    check(
      'H11 源有音轨而产物没有（video → gif）→ differs，事实里点名了音轨（这是最值钱的一条）',
      gif.status === 'differs' &&
        gif.comparison.audio_lost === true &&
        gif.facts.includes('产物没有音轨，而源有'),
      JSON.stringify({ status: gif.status, facts: gif.facts })
    )
    check(
      'H12 gif 没有时长 → 时长那一项**没查**（不是「不一致」），facts 里不许出现时长',
      gif.comparison.duration_comparable === false &&
        gif.comparison.duration_delta_sec === null &&
        gif.comparison.source_duration_sec === null &&
        !gif.facts.some((f) => f.startsWith('时长')),
      JSON.stringify(gif.comparison)
    )
    check(
      'H13 图片出口「没有视频流」不算丢了视频流（那正是 video → gif 的正常形态）',
      gif.comparison.video_lost === null && !gif.checked.includes('video_stream'),
      JSON.stringify({ checked: gif.checked, video_lost: gif.comparison.video_lost })
    )
    // ⚠️ 这一条是**判据宽不宽的分水岭**：视频 → 图片只有 gif 一条边，而 gif 的尺寸是
    // 我们的调色板链定的（`scale=480:-1`），与源无关。把它算成「不一致」的话，
    // 每一次 video → gif 都会红——而那是完全正常的产物。
    check(
      'H14 视频 → gif：尺寸**不参与判定**（不进 checked，也不报「不一致」），但两个数照报',
      gif.comparison.resolution_matches === null &&
        !gif.checked.includes('resolution') &&
        gif.facts.some((f) => f.startsWith('尺寸：') && f.includes('480x360')) &&
        gif.notes.some((n) => n.includes('scale=480')),
      JSON.stringify({ checked: gif.checked, res: gif.comparison.resolution_matches })
    )

    const imgToImg = compare(side(IMAGE, 'image', 'png'), side(IMAGE, 'image', 'jpg'))
    check(
      'H15 图片 → 图片：只查得到分辨率（不编时长、不编编解码器、也不比音轨）',
      imgToImg.status === 'consistent' &&
        JSON.stringify(imgToImg.checked) === JSON.stringify(['resolution']) &&
        !imgToImg.facts.some(
          (f) => f.includes('时长') || f.includes('编解码器') || f.includes('音轨')
        ),
      JSON.stringify({ checked: imgToImg.checked, facts: imgToImg.facts })
    )

    const docSide = (ext: string): Side => ({
      path: `D:\\tmp\\x.${ext}`,
      ext,
      category: 'document',
      size_bytes: 1024,
      probe: null,
      note: '文档不做子进程侦察：时长 / 分辨率 / 编解码器对它没有意义'
    })
    const doc = compare(docSide('md'), docSide('docx'))
    check(
      'H16 文档：一项都没查到 → unknown（**不是 consistent**——那会被读成「检查过了，好的」）',
      doc.status === 'unknown' &&
        doc.checked.length === 0 &&
        doc.notes.some((n) => n.includes('没有可比的项目') && n.includes('文档')),
      JSON.stringify({ status: doc.status, notes: doc.notes })
    )
    // 压缩包**刻意不比条目数**：拆开重打包是正常路径（tgz 那类套娃源在 7z 眼里只有
    // 一个条目，产物却是一堆文件），比了就是一条必假的差异。
    const arch = compare(side(EMPTY, 'archive', 'zip'), side(EMPTY, 'archive', '7z'))
    check(
      'H17 压缩包：不比条目数 → unknown + 那句「为什么不比」的说明',
      arch.status === 'unknown' && arch.notes.some((n) => n.includes('压缩包不比内容')),
      JSON.stringify({ status: arch.status, notes: arch.notes })
    )

    /* ---- 拿不到就不下结论 ---- */

    const blind = compare(side(VIDEO, 'video', 'mp4'), {
      path: 'D:\\tmp\\out.mkv',
      ext: 'mkv',
      category: 'video',
      size_bytes: 0,
      probe: null,
      note: 'ffmpeg 读不出流信息，文件可能损坏或不是它扩展名宣称的格式：moov atom not found'
    })
    check(
      'H18 产物读不出元数据 → unknown（**不是 differs**：拿不到就不下结论），并把引擎那句话带出来',
      blind.status === 'unknown' &&
        blind.comparison.audio_lost === null &&
        blind.comparison.resolution_matches === null &&
        blind.notes.some((n) => n.includes('moov atom not found')),
      JSON.stringify({ status: blind.status, notes: blind.notes })
    )

    /* ---- 硬差异（只有这三条能改判定）---- */

    const scaled = compare(
      side(VIDEO, 'video', 'mp4'),
      side({ ...VIDEO, width: 1280, height: 720 }, 'video', 'mp4')
    )
    check(
      'H19 分辨率与源不同 → differs（三条硬差异之一），事实里给出两个尺寸',
      scaled.status === 'differs' &&
        scaled.comparison.resolution_matches === false &&
        scaled.facts.some((f) => f.includes('1920x1080') && f.includes('1280x720')),
      JSON.stringify({ status: scaled.status, facts: scaled.facts })
    )

    /* ---- 只报事实、不做评分 ---- */

    const all = [plain, reframed, bigGap, recoded, gif, imgToImg, doc, arch, blind, scaled]
    const rendered = JSON.stringify(all)
    check(
      'H20 **只报事实、不做评分**：整个返回里没有 score / psnr / 质量 / 评分 / 等级 这类东西',
      all.length === 10 && !/psnr|score|quality|评分|质量|等级/i.test(rendered),
      rendered.length > 0
        ? `命中=${/psnr|score|quality|评分|质量|等级/i.exec(rendered)?.[0]}`
        : '空'
    )
    const outside = all
      .flatMap((item) => item.checked)
      .filter((key) => !verifyModule!.CHECK_KEYS.includes(key))
    check(
      `H21 checked 里只出现 CHECK_KEYS 那 ${verifyModule.CHECK_KEYS.length} 项（闭集，agent 可以穷举）`,
      outside.length === 0 && all.some((item) => item.checked.length > 0),
      `越界的：${outside.join(', ') || '（无）'}`
    )
    // `status` 的取值域同样是闭集——agent 要拿它做 switch，多一个值就是它没处理的分支。
    const statuses = [...new Set(all.map((item) => item.status))]
    check(
      'H22 status 的取值域是闭集 {consistent, differs, unknown}，三种都出现过（防空转）',
      statuses.every((value) => ['consistent', 'differs', 'unknown'].includes(value)) &&
        statuses.length === 3,
      statuses.join(', ')
    )
  }

  /* --------------------------------------- I：dry_run（E-5）的参数面 */

  console.log('\n[I] convert_file 的 dry_run（E-5）')

  // 这一组只问**静态面**：参数在不在三个出口里、默认值是什么、说明书有没有讲到。
  // 「dry run 到底有没有写文件 / 有没有占产物名」是行为面，只能在真进程里问——
  // 那部分在 `scripts/test-mcp-server.ts` 的第 [9] 节（这一套不起任何子进程）。
  const dryRunShape = shapeOf(TOOL_SCHEMAS.convert_file)
  const dryRunJson = (jsonSchemas().convert_file.properties ?? {}) as Record<
    string,
    { default?: unknown }
  >
  const dryRunJsonRequired = jsonSchemas().convert_file.required ?? []
  const dryRunOpenAi = (convertParams?.properties ?? {}) as Record<string, { default?: unknown }>

  check(
    'I1 dry_run 在三个出口里都在（zod shape / JSON Schema / OpenAI parameters）',
    Object.keys(dryRunShape).includes('dry_run') &&
      Object.keys(dryRunJson).includes('dry_run') &&
      Object.keys(dryRunOpenAi).includes('dry_run'),
    `zod=${Object.keys(dryRunShape).includes('dry_run')} json=${Object.keys(dryRunJson).includes(
      'dry_run'
    )} openai=${Object.keys(dryRunOpenAi).includes('dry_run')}`
  )
  // 默认值必须是 `false`：`convert_file` 的默认语义就是「转」，而一个默认开着的
  // 预览开关会让每一次调用都拿到一份说明、且**什么都不转**——那是最坏的一种默认。
  check(
    'I2 dry_run 默认 false（两个 JSON Schema 出口都写着）且不在 required 里',
    dryRunJson.dry_run?.default === false &&
      dryRunOpenAi.dry_run?.default === false &&
      !dryRunJsonRequired.includes('dry_run') &&
      !convertRequired.includes('dry_run'),
    `json.default=${JSON.stringify(dryRunJson.dry_run?.default)} openai.default=${JSON.stringify(
      dryRunOpenAi.dry_run?.default
    )} required=${JSON.stringify(dryRunJsonRequired)}`
  )
  check(
    'I3 zod 那侧独立问一遍：不传 dry_run 时算出来是 false（不是 true，也不是 undefined）',
    zodDefaultOf(dryRunShape.dry_run) === false,
    `parse(undefined)=${JSON.stringify(zodDefaultOf(dryRunShape.dry_run))}`
  )
  const dryRunText = TOOL_DESCRIPTIONS.convert_file ?? ''
  // 三件事缺一不可，而且**每一件都是承重的**：
  //  -「不写任何文件」：不写清的话 agent 会以为「预览一次、产物就有了」；
  //  -「不占用产物名」：那条是 `claimed` 的行为，模型看不到源码，只能从说明书里知道；
  //  -「不建任务」：不写的话它会拿着返回值去找 job_id。
  check(
    'I4 说明书写清了 dry_run 的三件事：不建任务 / 不写任何文件 / 不占用产物名',
    dryRunText.includes('dry_run') &&
      dryRunText.includes('不建任务') &&
      dryRunText.includes('不写任何文件') &&
      dryRunText.includes('不占用产物名'),
    dryRunText.slice(0, 80)
  )
  // 「预览说不行 = 真跑报同一个错」是 E-5 第二条定死的约束，它靠的是**共用校验函数**。
  // 说明书里不点名这件事的话，模型不会知道预览的失败是可当真的。
  check(
    'I5 说明书写明了「预览与真跑走同一个校验函数、报同一个错误」，并列出返回的那几项',
    dryRunText.includes('同一个校验函数') &&
      dryRunText.includes('同一个错误') &&
      dryRunText.includes('output') &&
      dryRunText.includes('cost') &&
      dryRunText.includes('lossy') &&
      dryRunText.includes('estimate'),
    dryRunText.slice(0, 80)
  )
  // E-5 明写「推荐 convert_file({..., dry_run: true})，**不是独立工具**」。
  // 这条钉住那个选择：加一个 `plan_convert` 会让工具预算白花一格，而它替掉的
  // 调用次数是 0（同一个参数就能表达）。
  check(
    'I6 dry_run 是 convert_file 的**参数**，不是第九个工具（E-5 要求同一条代码路径）',
    !(nameKeys as string[]).includes('dry_run') && EXPECTED_TOOLS.includes('convert_file'),
    `工具名里有 dry_run=${(nameKeys as string[]).includes('dry_run')}`
  )

  /* --------------------------------------------------- G：依赖图脱得开 electron */

  console.log('\n[G] src/mcp 的依赖图')

  // 防空转：缓存读不到东西的话，「缓存里没有 src/main」是恒真的
  const keys = cacheKeys()
  check(
    '模块缓存可观测（防空转：下一条问的是缓存）',
    keys.some((key) => key.includes('src/mcp/')),
    `缓存里 ${keys.length} 个模块`
  )
  const mainLeak = keys.filter((key) => key.includes('src/main/'))
  check(
    'src/mcp 的依赖图里没有主进程代码（src/main 一个都没进来）',
    mainLeak.length === 0,
    mainLeak.join(', ')
  )
  check(
    '加载全程没有任何模块试图加载 electron（台账为空）',
    blocked.length === 0,
    `${blocked.length} 处试图加载，调用方：${blocked.join(' , ')}`
  )

  report()
}

function report(): void {
  console.log(`\n=== 通过 ${passed} / 失败 ${failed} ===`)
  process.exit(failed === 0 ? 0 : 1)
}

// 套件自己崩掉要**显式报出来**：静默崩在中间的话，只会看到「后面几条断言没红」，
// 而那与「断言确实抓不住错误」在输出上一模一样。
main().catch((error) => {
  failed += 1
  console.error('\n套件自身抛异常（这是基础设施失败，不是断言红）：', error)
  report()
})
