/**
 * 渲染层「处理链」面板（`components/options/FiltersSection.tsx`）的回归网。
 *
 *   npx tsx --tsconfig tsconfig.test.json scripts/test-ui.ts
 *
 * ## 为什么要有这一支
 *
 * 这个仓库此前**没有任何 React 测试基建**，于是那块 ~830 行的面板只能靠肉眼盯着。
 * 而它恰好是最不该靠肉眼的那一类：它每一条判据出错的表现都是「点了没反应」或者
 * 「顺手改了别的东西」，没有一条会崩、也没有一条会报错。
 *
 * ## 怎么做到「测盘上那份源码」而一个字都不改它
 *
 * 面板的纯逻辑（`parse` / `compile` / 四种链改动 / `insertByRank` …）**不是导出**的，
 * 整个文件只有 `FiltersSection` 一个 export。要跑它们有两条路：抄一份到测试里
 * （那是在测自己写的副本，这一块验证的全部价值就没了），或者往源码里加标记注释
 * （`src/**` 不许动）。这里走第三条：
 *
 *   **用 esbuild 在内存里把原文包一层，只在文件末尾追加一行 `export { … }`。**
 *
 * 读盘拿到 `FiltersSection.tsx` 的**原文**，一个字节不改；顺带把两个边界换成可控的
 * 探针模块（见 `panelPlugin()`）：`./OptionsSection`（它的 props 就是这块面板对外的
 * 全部输出）与 `../../store/useTasks`（Node 里没有 `window.api`，而且 zustand v5 在
 * SSR 下读的是 `getInitialState`，`setState` 改不动它）。改的只是内存里那份构建产物，
 * 盘上的源码原封不动——所以它跑的就是用户在用的那份代码。
 *
 * 顺带一个好处：那行 `export { … }` **本身就是一道锚点**。谁把 `parse` 改了名或搬了家，
 * ESM 的链接期校验会直接抛 `does not provide an export named 'parse'`，
 * 而不是让这支套件悄悄退化成「一条都不跑还全绿」。
 *
 * ## 覆盖
 *
 * - [1]~[4] 纯逻辑：解析 / 整链校验与编译 / 规范次序 / 四种链改动
 * - [5]~[8] 真渲染（`react-dom/server`）：调序按钮的位置可用性、添加菜单的类别过滤、
 *           校验原因与「应用」禁用、提交载荷
 * - [9] 元素树：按钮到处理函数的接线。SSR 的产物里没有 `onClick`，
 *       而「按钮亮着但点下去干的是别的事」只有这一层看得见，所以直接走元素树
 * - [10] 反装饰性：把「判据本身有没有鉴别力」也钉住（见那一节的说明）
 *
 * ⚠️ **两处测不到的地方**，如实写在这里而不是假装覆盖了：
 * 1. `busy` / `failed` 只在 `setOptions` 回来之后才变，而 SSR 是一次性的
 *    （`renderToStaticMarkup` 之后 `setState` 不会再渲染）。所以「提交期间冻住编辑面」
 *    与「主进程拒了要说出来」这两条**没有断言**。
 * 2. 行内按钮的 onClick **不经过 DOM**（先用元素树直接调，见 [9]），
 *    所以「事件真的从浏览器冒上来」这一层不在覆盖内——那需要 jsdom，本仓库没有。
 */
import { build } from 'esbuild'
import { existsSync, readFileSync } from 'fs'
import { mkdir, rm } from 'fs/promises'
import { resolve } from 'path'
import { pathToFileURL } from 'url'
import { createElement, isValidElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { filterActionSchema, qualitySchema, setOptionsSchema } from '@shared/ipc-contract'
import {
  DEFAULT_CRF,
  DEFAULT_PRESET,
  MAX_FILTER_ACTIONS,
  MAX_IMAGE_DIM,
  MIN_IMAGE_DIM,
  QUALITY_OUTPUT_EXCLUSIVE
} from '@shared/options'
// ⚠️ 这四个住在 `types.ts`，不在 `options.ts` 里。写错文件名的后果**不是编译错误**：
// 经 CJS interop 取不到的名字是 `undefined`，于是 `${MIN_SHARPEN}` 安静地变成
// `"undefined"`、`MIN_SHARPEN / 2` 变成 `NaN`，只有断言的文案会变得莫名其妙
// （这一版就是这么被自己抓到的）。
import {
  MAX_SHARPEN,
  MAX_TARGET_LUFS,
  MIN_SHARPEN,
  MIN_TARGET_LUFS,
  type Category,
  type FilterAction,
  type Task,
  type TaskOptions
} from '@shared/types'

const ROOT = process.cwd()
const OPTIONS_DIR = resolve(ROOT, 'src/renderer/src/components/options')
const PANEL = resolve(OPTIONS_DIR, 'FiltersSection.tsx')
const TMP = resolve(ROOT, '.tmp-test-ui')

/* ------------------------------------------------------------------ 类型 */

/** 草稿里的一步：数值字段存的是输入框里的**原文**，所以是松散对象而不是 `FilterAction`。 */
type Draft = { kind: string } & Record<string, unknown>
interface Step {
  id: number
  action: Draft
}
type ParseResult = { ok: true; action: FilterAction } | { ok: false; issue: string }
type CompiledResult = { ok: true; actions: FilterAction[] } | { ok: false; reason: string }

/** `./OptionsSection` 探针收到的 props —— 这块面板对外的全部输出。 */
interface TapProps {
  title: string
  reason: string | null
  failedText: string
  busy: boolean
  canClear: boolean
  onApply: () => void
  onClear: () => void
}

/** 从 `FiltersSection.tsx` 的原文里取出来的东西。`EXPORTS` 是那行追加导出的镜像。 */
interface PanelModule {
  FiltersSection: (props: { task: Task }) => ReactElement
  parse: (draft: Draft) => ParseResult
  compile: (steps: Step[]) => CompiledResult
  replaceAt: (steps: Step[], index: number, action: Draft) => Step[]
  moveStep: (steps: Step[], index: number, delta: number) => Step[]
  removeStep: (steps: Step[], index: number) => Step[]
  insertByRank: (steps: Step[], action: Draft) => Step[]
  defaultAction: (kind: string) => FilterAction
  toDraft: (action: FilterAction) => Draft
  freshId: (steps: Step[]) => number
  KIND_RANK: Record<string, number>
  KIND_ORDER: string[]
  KIND_LABEL: Record<string, string>
  StepRow: (props: {
    step: Step
    index: number
    count: number
    onChange: (action: Draft) => void
    onMove: (delta: number) => void
    onRemove: () => void
  }) => unknown
  Editor: (props: { step: Step; index: number; onChange: (action: Draft) => void }) => unknown
  __taps: TapProps[]
  __store: { calls: [string, TaskOptions | null][]; ok: boolean }
}

const EXPORTS = [
  'parse',
  'compile',
  'replaceAt',
  'moveStep',
  'removeStep',
  'insertByRank',
  'defaultAction',
  'toDraft',
  'freshId',
  'KIND_RANK',
  'KIND_ORDER',
  'KIND_LABEL',
  'StepRow',
  'Editor'
]

/* ------------------------------------------------------------------ 构建 */

/**
 * 把 `FiltersSection.tsx` 的**原文**包成一个模块：追加一行导出，两个边界换成探针。
 *
 * 三处刻意的地方：
 * - `@shared/*` 是 tsconfig 里的路径别名，esbuild 不认，得自己解析。
 * - 追加上去的 `export { __taps } from './OptionsSection'` 与
 *   `export { __store } from '../../store/useTasks'` **会再次撞上同一个 onResolve**，
 *   于是指到同一个探针模块（同一个 namespace + path = 同一个模块实例），
 *   测试因此拿得到探针的内部状态，不需要往 `globalThis` 上挂东西。
 * - 探针里那句 `import … from './OptionsSection.tsx'` 用的是**带扩展名的写法**，
 *   刚好躲开 `^\.\/OptionsSection$` 这个过滤条件，于是它解析到真的那个文件——
 *   外壳（标题 + 错误行 + 应用/清除按钮）**仍然是盘上那份 `OptionsSection.tsx` 渲染的**。
 */
function panelPlugin(
  original: string,
  fileName: string,
  exports: string[],
  target: string
): import('esbuild').Plugin {
  return {
    name: 'panel-source-tap',
    setup(b) {
      b.onResolve({ filter: /^@shared\// }, (args) => ({
        path: resolve(ROOT, 'src/shared', args.path.slice('@shared/'.length) + '.ts')
      }))

      b.onResolve({ filter: /^\.\/OptionsSection$/ }, () => ({
        path: 'options-tap',
        namespace: 'tap'
      }))
      b.onLoad({ filter: /options-tap/, namespace: 'tap' }, () => ({
        contents: [
          `import { OptionsSection as Real } from './OptionsSection.tsx'`,
          `export const __taps = []`,
          `export function OptionsSection(props) {`,
          `  __taps.push(props)`,
          `  return Real(props)`,
          `}`
        ].join('\n'),
        resolveDir: OPTIONS_DIR,
        loader: 'js'
      }))

      b.onResolve({ filter: /store\/useTasks$/ }, () => ({ path: 'store-tap', namespace: 'tap' }))
      b.onLoad({ filter: /store-tap/, namespace: 'tap' }, () => ({
        contents: [
          `export const __store = {`,
          `  calls: [],`,
          `  ok: true,`,
          `  setOptions: async (id, options) => {`,
          `    __store.calls.push([id, options])`,
          `    return __store.ok`,
          `  }`,
          `}`,
          `export const useTasks = (selector) => selector(__store)`
        ].join('\n'),
        loader: 'js'
      }))

      // 被测文件本身：**原文 + 一行导出**，其余一个字节不改。
      b.onLoad({ filter: new RegExp(`${fileName.replace('.', '\\.')}$`) }, (args) => {
        const same =
          resolve(args.path).replace(/\\/g, '/').toLowerCase() ===
          target.toLowerCase().replace(/\\/g, '/')
        if (!same) return undefined
        // ⚠️ `exports` 为空时**不能**拼出 `export { }`（那是语法错误），而重复导出
        // 一个源码里本来就导出的名字（`QualitySection` 就是这种）会直接构建失败。
        // 所以那一行只在**有额外要捞的内部名字**时才追加。
        const trailer =
          (exports.length > 0 ? `\nexport { ${exports.join(', ')} }\n` : '\n') +
          `export { __taps } from './OptionsSection'\n` +
          `export { __store } from '../../store/useTasks'\n`
        return { contents: original + trailer, loader: 'tsx', resolveDir: OPTIONS_DIR }
      })
    }
  }
}

/**
 * 把一个**参数面板**的原文包成模块并加载。
 *
 * 两个面板共用这一套：探针（`./OptionsSection` 的 props 与 `../../store/useTasks` 的
 * `setOptions` 调用）是它们共同的两个对外边界，所以什么都不用改。
 * 各面板自己的 `exports` 那一行是**锚点**：谁把导出的东西改名或搬走，
 * ESM 链接期就会抛，而不是让套件悄悄退化成「一条都不跑还全绿」。
 */
async function loadPanelModule<T>(fileName: string, exports: string[], what: string): Promise<T> {
  await rm(TMP, { recursive: true, force: true })
  await mkdir(TMP, { recursive: true })
  const target = resolve(OPTIONS_DIR, fileName)
  const outfile = resolve(TMP, `${fileName}.mjs`)
  await build({
    entryPoints: [target],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    jsx: 'automatic',
    // node_modules 全部留成 import：sharp 那种带 .node 的原生模块打不进去，
    // 而且 React **必须**和测试这一侧是同一个实例，否则 `createElement` 造出来的元素
    // 对面不认识（两个 React 实例的表现是一堆莫名其妙的 hook 报错）。
    packages: 'external',
    plugins: [panelPlugin(readFileSync(target, 'utf8'), fileName, exports, target)],
    logLevel: 'warning'
  })
  try {
    return (await import(pathToFileURL(outfile).href)) as T
  } catch (error) {
    console.error(`\n从 ${fileName} 里取不到这些导出：${exports.join(', ')}`)
    console.error(`（${what}的导出被改名或搬走了？请更新 test-ui.ts 里的导出清单）\n`)
    throw error
  }
}

const loadPanel = (): Promise<PanelModule> =>
  loadPanelModule<PanelModule>('FiltersSection.tsx', EXPORTS, '处理链面板')

/* ------------------------------------------------------------------ 断言 */

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

/** 按**键序无关**的方式比对象。载荷的键序由构造顺序决定，不该让断言依赖它。 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  const left = a as Record<string, unknown>
  const right = b as Record<string, unknown>
  const keys = Object.keys(left)
  if (keys.length !== Object.keys(right).length) return false
  return keys.every((key) => deepEqual(left[key], right[key]))
}

/* ------------------------------------------------------------------ HTML —— 一点点解析 */

interface El {
  tag: string
  attrs: Record<string, string>
  text: string
}

function parseAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {}
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:="([^"]*)")?/g
  let m: RegExpExecArray | null
  while ((m = re.exec(raw)) !== null) attrs[m[1]] = m[2] ?? ''
  return attrs
}

function unescapeHtml(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&')
}

function elements(html: string, tag: string): El[] {
  const out: El[] = []
  const re = new RegExp(`<${tag}\\b([^>]*)>([\\s\\S]*?)</${tag}>`, 'g')
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) {
    out.push({ tag, attrs: parseAttrs(m[1]), text: unescapeHtml(m[2].replace(/<[^>]*>/g, '')) })
  }
  return out
}

const buttonsOf = (html: string): El[] => elements(html, 'button')

/**
 * ⚠️ 判「禁用」**必须落在按钮自己的属性上**，不能拿 `html.includes('disabled')` 当判据：
 * `ROW_BUTTON` / `PILL` 的类名里就写着 `disabled:cursor-not-allowed`，
 * 那条子串在**任何**渲染产物里都成立。第 [10] 节专门把这件事钉住。
 * React 渲染 `disabled={true}` 出的是 `disabled=""`，`false` 时整个属性不出现，
 * 所以判据是「这个属性在不在」。
 */
const isDisabled = (el: El): boolean => 'disabled' in el.attrs

/** 按 DOM 顺序排好的调序按钮：`[2i]` 是第 i 行的上移、`[2i+1]` 是下移。 */
function moverButtons(html: string): El[] {
  return buttonsOf(html).filter((b) => b.text === '上移' || b.text === '下移')
}

function pillLabels(html: string): string[] {
  return buttonsOf(html)
    .filter((b) => b.text.startsWith('+ '))
    .map((b) => b.text.slice(2))
}

const buttonByText = (html: string, text: string): El | undefined =>
  buttonsOf(html).find((b) => b.text === text)

/** 红色的那些句子（`text-bad` 那两行：校验原因与「主进程拒了」）。 */
function errorLines(html: string): string[] {
  return elements(html, 'p')
    .filter((p) => (p.attrs.class ?? '').split(' ').includes('text-bad'))
    .map((p) => p.text)
}

const summariesOf = (html: string): string[] => elements(html, 'span').map((s) => s.text)

/**
 * **自闭合**标签（`<input … />`）——`elements()` 要求有闭合标签，对 void 元素一条都找不到。
 *
 * 这个坑很安静：`elements(html, 'input')` 返回空数组，于是「输入框的初值对不对」
 * 这类断言拿到的 `undefined` 看起来像「值没渲染出来」，而不是「选择器选不到东西」。
 * 所以判据里凡是读 `input` 的，都必须走这里。
 */
function voidElements(html: string, tag: string): El[] {
  const out: El[] = []
  const re = new RegExp(`<${tag}\\b([^>]*?)/?>`, 'g')
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) out.push({ tag, attrs: parseAttrs(m[1]), text: '' })
  return out
}

/* ------------------------------------------------------------------ 夹具与驱动 */

let panel!: PanelModule

function makeTask(category: Category, options?: TaskOptions): Task {
  return {
    id: 't-ui',
    inputPath: 'D:/in/a.mp4',
    inputName: 'a.mp4',
    category,
    fromExt: 'mp4',
    toExt: 'mkv',
    options,
    engine: 'ffmpeg',
    status: 'queued',
    progress: null,
    createdAt: 0
  }
}

/**
 * 一条**主进程收不下**的链：`resizeActionSchema` 要求宽高至少给一个。
 *
 * 为什么要造一个 schema 会拒的状态：这块面板的校验分支（禁掉「应用」并说清原因）
 * 服务的正是「用户把宽度那一格清空 / 敲进一个 abc」——而草稿只在交互里变，
 * SSR 是一次性的，键盘事件够不着。**初始草稿永远由 schema 认过的链转出来，所以走 UI
 * 到不了这个状态。** 这里直接构造它，是为了让那几条判据真的被执行到，
 * 而不是写一条永远在空集合上成立的装饰性断言。
 * 反过来说：它测的是**判据本身**，不代表这条链能从程序别的入口进来。
 */
function unreachableTask(category: Category): Task {
  const filters = [
    { kind: 'resize', fit: 'inside', withoutEnlargement: true }
  ] as unknown as FilterAction[]
  return makeTask(category, { filters })
}

interface Rendered {
  html: string
  props: TapProps
}

function render(task: Task): Rendered {
  panel.__taps.length = 0
  panel.__store.calls.length = 0
  panel.__store.ok = true
  const html = renderToStaticMarkup(createElement(panel.FiltersSection, { task }))
  return { html, props: panel.__taps[0] }
}

/** 点一次「应用」，把交出去的载荷收回来。 */
async function applyAndCapture(task: Task): Promise<{
  calls: [string, TaskOptions | null][]
  props: TapProps
}> {
  const rendered = render(task)
  rendered.props.onApply()
  await new Promise((done) => setTimeout(done, 0))
  return { calls: panel.__store.calls, props: rendered.props }
}

/* ------------------------------------------- 第二块面板：编码质量档（P0-10） */

/**
 * 质量档面板与处理链面板**共用同一套探针**：两者对外的边界完全一样
 * （`./OptionsSection` 的 props + `store.setOptions` 的载荷），所以
 * `panelPlugin` / `loadPanelModule` 一行都不用改。
 *
 * ## 这一节能覆盖什么、覆盖不到什么
 *
 * SSR 是一次性的，**键盘事件够不着**，所以「用户在 CRF 输入框里敲了个 `abc` 会怎样」
 * 这一条**没有断言**（处理链面板那支文件头也记着同一条限制）。这一节能覆盖的是
 * 三个真正会影响用户结果的位点：
 *
 * 1. **面板在该禁用的时候禁用，并把理由说出来**（出口不支持 / 与输出约束冲突）——
 *    这两条的理由都是**从任务状态算出来的**，不需要键盘事件。
 * 2. **交出去的载荷是完整的**：`setOptions` 是整体替换语义，只交 `quality` 会把用户
 *    先前设好的裁剪静默抹掉。这一条只有真跑一次 `onApply` 才看得见。
 * 3. **载荷能过契约**（`qualitySchema` + `setOptionsSchema`）——界面上放行一个主进程
 *    会拒掉的值，表现是「点了应用什么都没发生」，而那个组合极难靠肉眼发现。
 */
interface QualityPanelModule {
  QualitySection: (props: { task: Task }) => ReactElement
  __taps: TapProps[]
  __store: {
    calls: [string, TaskOptions | null][]
    ok: boolean
  }
}

let qualityPanel!: QualityPanelModule

function renderQuality(task: Task): Rendered {
  qualityPanel.__taps.length = 0
  qualityPanel.__store.calls.length = 0
  qualityPanel.__store.ok = true
  const html = renderToStaticMarkup(createElement(qualityPanel.QualitySection, { task }))
  return { html, props: qualityPanel.__taps[0] }
}

/**
 * 点一次「应用」（或 `'clear'` 时点「清除」），把交出去的载荷收回来。
 *
 * ⚠️ 两者**必须能分开点**：第一版里「清除」那一节错手调了 `onApply`，
 * 于是量到的是「应用」交出的载荷——而它当然带着 quality，断言红的，
 * 看起来像「清除没生效」。按钮点错在渲染测试里不算罕见，所以这里做成一个参数。
 */
async function applyQualityAndCapture(
  task: Task,
  which: 'apply' | 'clear' = 'apply'
): Promise<{
  calls: [string, TaskOptions | null][]
  props: TapProps
}> {
  const rendered = renderQuality(task)
  if (which === 'apply') rendered.props.onApply()
  else rendered.props.onClear()
  await new Promise((done) => setTimeout(done, 0))
  return { calls: qualityPanel.__store.calls, props: rendered.props }
}

/** 造一条视频任务，可改目标格式与参数。`fromExt` 固定 mp4（`engineFor` 那一路是 ffmpeg）。 */
function qualityTask(toExt: string, options?: TaskOptions): Task {
  return { ...makeTask('video', options), toExt }
}

/* ------------------------------------------------------------------ 元素树 */

interface ElNode {
  props: Record<string, unknown>
}

/** 把元素树摊平。`renderToStaticMarkup` 之后 props 就没了，所以要自己走一遍树。 */
function allNodes(node: unknown, out: ElNode[] = []): ElNode[] {
  if (Array.isArray(node)) {
    for (const child of node) allNodes(child, out)
    return out
  }
  if (!isValidElement(node)) return out
  const el = node as unknown as ElNode
  out.push(el)
  allNodes(el.props.children, out)
  return out
}

function stepNodes(
  step: Step,
  index: number,
  count: number,
  spies: {
    onChange: (action: Draft) => void
    onMove: (delta: number) => void
    onRemove: () => void
  }
): ElNode[] {
  return allNodes(panel.StepRow({ step, index, count, ...spies }))
}

const byText = (nodes: ElNode[], text: string): ElNode | undefined =>
  nodes.find((n) => n.props.children === text)

/** 直接触发元素上的处理器。SSR 的产物里没有事件，所以只能走到这一层。 */
function fire(node: ElNode | undefined, event?: unknown): void {
  const handler = node?.props.onClick ?? node?.props.onChange
  if (typeof handler === 'function') (handler as (e: unknown) => void)(event)
}

/* ------------------------------------------------------------------ [1] 解析 */

function testParse(): void {
  console.log('\n--- [1] 纯逻辑：一步的解析（parse）---')
  const { parse } = panel

  const bothEmpty = parse({
    kind: 'resize',
    width: '  ',
    height: '',
    fit: 'inside',
    withoutEnlargement: true
  })
  check(
    'parse：缩放两格都空 → 拒绝，并说清「宽高至少填一个」',
    !bothEmpty.ok && bothEmpty.issue.includes('宽高至少填一个'),
    !bothEmpty.ok ? bothEmpty.issue : '居然通过了'
  )

  const notInteger = parse({
    kind: 'resize',
    width: '1.5',
    height: '',
    fit: 'inside',
    withoutEnlargement: true
  })
  check(
    'parse：宽填 1.5 → 拒绝「宽只能填整数像素」',
    !notInteger.ok && notInteger.issue.includes('宽只能填整数像素'),
    !notInteger.ok ? notInteger.issue : '居然通过了'
  )

  const notANumber = parse({
    kind: 'resize',
    width: 'abc',
    height: '',
    fit: 'inside',
    withoutEnlargement: true
  })
  check(
    'parse：宽填 abc → 拒绝「宽只能填整数像素」',
    !notANumber.ok && notANumber.issue.includes('宽只能填整数像素'),
    !notANumber.ok ? notANumber.issue : '居然通过了'
  )

  const zero = parse({
    kind: 'resize',
    width: '0',
    height: '',
    fit: 'inside',
    withoutEnlargement: true
  })
  check(
    `parse：宽填 0 → 拒绝「宽至少是 ${MIN_IMAGE_DIM} 像素」`,
    !zero.ok && zero.issue.includes(`至少是 ${MIN_IMAGE_DIM} 像素`),
    !zero.ok ? zero.issue : '居然通过了'
  )

  const huge = parse({
    kind: 'resize',
    width: String(MAX_IMAGE_DIM + 1),
    height: '',
    fit: 'inside',
    withoutEnlargement: true
  })
  check(
    `parse：宽填 ${MAX_IMAGE_DIM + 1} → 拒绝「宽不能超过 ${MAX_IMAGE_DIM} 像素」`,
    !huge.ok && huge.issue.includes(`不能超过 ${MAX_IMAGE_DIM} 像素`),
    !huge.ok ? huge.issue : '居然通过了'
  )

  const onlyWidth = parse({
    kind: 'resize',
    width: '800',
    height: '  ',
    fit: 'cover',
    withoutEnlargement: false
  })
  check(
    'parse：只填宽 800 → 通过，且产物里没有 height 这个键（逐字段显式构造）',
    onlyWidth.ok &&
      deepEqual(onlyWidth.action, {
        kind: 'resize',
        width: 800,
        fit: 'cover',
        withoutEnlargement: false
      }),
    onlyWidth.ok ? JSON.stringify(onlyWidth.action) : onlyWidth.issue
  )

  const emptySharpen = parse({ kind: 'sharpen', amount: '   ' })
  check(
    'parse：锐化空串 → 拒绝「锐化强度不能为空」（空串不是 0）',
    !emptySharpen.ok && emptySharpen.issue.includes('锐化强度不能为空'),
    !emptySharpen.ok ? emptySharpen.issue : '居然通过了'
  )

  const nanSharpen = parse({ kind: 'sharpen', amount: 'abc' })
  check(
    'parse：锐化 abc → 拒绝「只能填数字」',
    !nanSharpen.ok && nanSharpen.issue.includes('只能填数字'),
    !nanSharpen.ok ? nanSharpen.issue : '居然通过了'
  )

  const lowSharpen = parse({ kind: 'sharpen', amount: String(MIN_SHARPEN / 2) })
  check(
    `parse：锐化 ${MIN_SHARPEN / 2} → 拒绝（低于下界 ${MIN_SHARPEN}）`,
    !lowSharpen.ok && lowSharpen.issue.includes(`要在 ${MIN_SHARPEN}~${MAX_SHARPEN} 之间`),
    !lowSharpen.ok ? lowSharpen.issue : '居然通过了'
  )

  const highSharpen = parse({ kind: 'sharpen', amount: String(MAX_SHARPEN + 0.5) })
  check(
    `parse：锐化 ${MAX_SHARPEN + 0.5} → 拒绝（高于上界 ${MAX_SHARPEN}）`,
    !highSharpen.ok && highSharpen.issue.includes(`要在 ${MIN_SHARPEN}~${MAX_SHARPEN} 之间`),
    !highSharpen.ok ? highSharpen.issue : '居然通过了'
  )

  const okSharpen = parse({ kind: 'sharpen', amount: '1.5' })
  check(
    'parse：锐化 1.5 → 通过',
    okSharpen.ok && deepEqual(okSharpen.action, { kind: 'sharpen', amount: 1.5 }),
    okSharpen.ok ? JSON.stringify(okSharpen.action) : okSharpen.issue
  )

  const emptyLoud = parse({ kind: 'loudnorm', targetLufs: '' })
  check(
    'parse：响度空串 → 拒绝「目标响度不能为空」',
    !emptyLoud.ok && emptyLoud.issue.includes('目标响度不能为空'),
    !emptyLoud.ok ? emptyLoud.issue : '居然通过了'
  )

  const lowLoud = parse({ kind: 'loudnorm', targetLufs: String(MIN_TARGET_LUFS - 30) })
  check(
    `parse：响度 ${MIN_TARGET_LUFS - 30} → 拒绝（低于下限 ${MIN_TARGET_LUFS}）`,
    !lowLoud.ok && lowLoud.issue.includes(`要在 ${MIN_TARGET_LUFS}~${MAX_TARGET_LUFS} LUFS 之间`),
    !lowLoud.ok ? lowLoud.issue : '居然通过了'
  )

  const highLoud = parse({ kind: 'loudnorm', targetLufs: '0' })
  check(
    `parse：响度 0 → 拒绝（高于上限 ${MAX_TARGET_LUFS}）`,
    !highLoud.ok && highLoud.issue.includes(`要在 ${MIN_TARGET_LUFS}~${MAX_TARGET_LUFS} LUFS 之间`),
    !highLoud.ok ? highLoud.issue : '居然通过了'
  )

  const okLoud = parse({ kind: 'loudnorm', targetLufs: '-14' })
  check(
    'parse：响度 -14 → 通过',
    okLoud.ok && deepEqual(okLoud.action, { kind: 'loudnorm', targetLufs: -14 }),
    okLoud.ok ? JSON.stringify(okLoud.action) : okLoud.issue
  )

  const enums = [
    parse({ kind: 'deinterlace', method: 'yadif' }),
    parse({ kind: 'denoise', strength: 'light' }),
    parse({ kind: 'rotate', degrees: 90 })
  ]
  check(
    'parse：三种枚举型动作原样通过（控件里只有清单上那几档，造不出别的值）',
    enums.every((r) => r.ok),
    JSON.stringify(enums)
  )
}

/* ------------------------------------------------------------------ [2] 整链 */

function testCompileAndSchema(): void {
  console.log('\n--- [2] 纯逻辑：整条链的校验与编译（compile）＋ 与真实 schema 对齐 ---')
  const { compile, parse } = panel

  const empty = compile([])
  check(
    'compile：空链 → ok，得到空数组',
    empty.ok && empty.actions.length === 0,
    JSON.stringify(empty)
  )

  const bad = compile([
    { id: 1, action: { kind: 'sharpen', amount: '1' } },
    {
      id: 2,
      action: { kind: 'resize', width: '', height: '', fit: 'inside', withoutEnlargement: true }
    }
  ])
  check(
    'compile：报错指名道姓（说得出是第几步、哪个动作）',
    !bad.ok && bad.reason.startsWith('第 2 步「缩放」：') && bad.reason.includes('宽高至少填一个'),
    !bad.ok ? bad.reason : '居然通过了'
  )
  check(
    'compile：第几步是**从 1 数**的（下标 1 的步骤说成「第 2 步」）',
    !bad.ok && bad.reason.includes('第 2 步') && !bad.reason.includes('第 1 步'),
    !bad.ok ? bad.reason : '居然通过了'
  )

  const chain: Step[] = [
    { id: 1, action: { kind: 'denoise', strength: 'medium' } },
    { id: 2, action: { kind: 'sharpen', amount: '1' } },
    {
      id: 3,
      action: {
        kind: 'resize',
        width: '1920',
        height: '1080',
        fit: 'cover',
        withoutEnlargement: true
      }
    }
  ]
  const compiled = compile(chain)
  check(
    'compile：合法的多步链按原顺序产出（不排序、不去重——链是数组）',
    compiled.ok &&
      deepEqual(compiled.actions, [
        { kind: 'denoise', strength: 'medium' },
        { kind: 'sharpen', amount: 1 },
        { kind: 'resize', width: 1920, height: 1080, fit: 'cover', withoutEnlargement: true }
      ]),
    compiled.ok ? JSON.stringify(compiled.actions) : compiled.reason
  )

  // 「交出去的东西主进程收得下」这件事只有拿真的 schema 问才算数。
  const parsed = compiled.ok ? compiled.actions.map((a) => filterActionSchema.safeParse(a)) : []
  check(
    'compile：产出直接过真的 filterActionSchema（.strict() 全通过）',
    parsed.length === 3 && parsed.every((r) => r.success),
    JSON.stringify(parsed.map((r) => (r.success ? 'ok' : r.error.issues[0]?.message)))
  )

  const leaked = compile([{ id: 1, action: { kind: 'sharpen', amount: '1' } }])
  const withId = leaked.ok ? filterActionSchema.safeParse({ ...leaked.actions[0], id: 7 }) : null
  check(
    'compile：产出的每个动作都不带 id —— id 只留在草稿里',
    leaked.ok && !('id' in leaked.actions[0]),
    leaked.ok ? JSON.stringify(leaked.actions[0]) : leaked.reason
  )
  check(
    'filterActionSchema：动作里混进 id 会被拒（.strict() 是这条结论的证据）',
    withId !== null && !withId.success,
    withId === null ? '上一步没产出动作' : '居然收下了'
  )

  const schemaRejects = filterActionSchema.safeParse({
    kind: 'resize',
    fit: 'inside',
    withoutEnlargement: true
  })
  check(
    'filterActionSchema：拒绝 resize 两格都空（主进程那一道独立生效）',
    !schemaRejects.success,
    '居然收下了'
  )

  // 顺手确认 parse 与 schema 对同一条边界的判据是一致的
  const atMin = parse({ kind: 'sharpen', amount: String(MIN_SHARPEN) })
  const schemaAtMin = filterActionSchema.safeParse({ kind: 'sharpen', amount: MIN_SHARPEN })
  check(
    'parse 与 schema 在锐化下界上一致（界面放行的主进程必须收得下）',
    atMin.ok === schemaAtMin.success,
    `parse=${atMin.ok} schema=${schemaAtMin.success}`
  )
}

/* ------------------------------------------------------------------ [3] 次序 */

function testOrdering(): void {
  console.log('\n--- [3] 纯逻辑：规范次序与插入位置 ---')
  const { KIND_ORDER, KIND_RANK, insertByRank, defaultAction } = panel

  check(
    'KIND_ORDER：菜单顺序由 KIND_RANK 派生（去隔行→降噪→锐化→旋转→缩放→响度归一化）',
    deepEqual(KIND_ORDER, ['deinterlace', 'denoise', 'sharpen', 'rotate', 'resize', 'loudnorm']),
    JSON.stringify(KIND_ORDER)
  )
  check(
    'KIND_RANK：去隔行 < 降噪 < 锐化（反了会把隔行留下的半行当细节、把噪点一起锐化出来）',
    KIND_RANK.deinterlace < KIND_RANK.denoise && KIND_RANK.denoise < KIND_RANK.sharpen,
    JSON.stringify(KIND_RANK)
  )
  check(
    'KIND_RANK：旋转 < 缩放（先摆正、再按用户看到的那个方向填宽高）',
    KIND_RANK.rotate < KIND_RANK.resize,
    JSON.stringify(KIND_RANK)
  )

  const first = insertByRank([], { kind: 'sharpen', amount: '1' })
  check(
    'insertByRank：空链上插入第一步',
    first.length === 1 && first[0].action.kind === 'sharpen' && first[0].id > 0,
    JSON.stringify(first)
  )

  const existing: Step[] = [
    { id: 1, action: { kind: 'denoise', strength: 'light' } },
    { id: 2, action: { kind: 'denoise', strength: 'strong' } }
  ]
  const sameKind = insertByRank(existing, { kind: 'denoise', strength: 'medium' })
  check(
    'insertByRank：同类插在已有的之后（已有步骤的相对次序一个不动）',
    sameKind.length === 3 &&
      sameKind[0].id === 1 &&
      sameKind[1].id === 2 &&
      sameKind[2].action.kind === 'denoise' &&
      (sameKind[2].action as { strength?: string }).strength === 'medium',
    JSON.stringify(sameKind.map((s) => s.id))
  )

  const mixed: Step[] = [
    { id: 1, action: { kind: 'sharpen', amount: '1' } },
    { id: 2, action: { kind: 'loudnorm', targetLufs: '-14' } }
  ]
  const inserted = insertByRank(mixed, {
    kind: 'resize',
    width: '800',
    height: '',
    fit: 'inside',
    withoutEnlargement: true
  })
  check(
    'insertByRank：缩放插在锐化之后、响度归一化之前（按 KIND_RANK 找第一个更靠后的）',
    inserted.length === 3 &&
      inserted[0].id === 1 &&
      inserted[1].action.kind === 'resize' &&
      inserted[2].id === 2,
    JSON.stringify(inserted.map((s) => `${s.id}:${s.action.kind}`))
  )

  let grown: Step[] = []
  for (const kind of ['resize', 'sharpen', 'denoise', 'rotate', 'deinterlace', 'loudnorm']) {
    grown = insertByRank(grown, {
      kind,
      ...(defaultAction(kind) as unknown as Record<string, unknown>)
    })
  }
  const ids = grown.map((s) => s.id)
  check(
    'insertByRank：每次插入都拿到新的唯一 id（否则 React 会把上一行的 DOM 复用给新的一步）',
    new Set(ids).size === ids.length && ids.length === 6,
    JSON.stringify(ids)
  )
}

/* ------------------------------------------------------------------ [4] 链的改动 */

function testChainEdits(): void {
  console.log('\n--- [4] 纯逻辑：四种链改动（都是纯函数）---')
  const { moveStep, removeStep, replaceAt, freshId } = panel

  const three: Step[] = [
    { id: 1, action: { kind: 'deinterlace', method: 'yadif' } },
    { id: 2, action: { kind: 'denoise', strength: 'light' } },
    { id: 3, action: { kind: 'sharpen', amount: '1' } }
  ]

  const up = moveStep(three, 1, -1)
  check(
    'moveStep：中间项上移一位（产出新数组，原数组一个字节不动）',
    up.map((s) => s.id).join() === '2,1,3' && three.map((s) => s.id).join() === '1,2,3',
    `up=${up.map((s) => s.id).join()} 原=${three.map((s) => s.id).join()}`
  )

  const down = moveStep(three, 1, 1)
  check(
    'moveStep：中间项下移一位落在正确的位置',
    down.map((s) => s.id).join() === '1,3,2',
    down.map((s) => s.id).join()
  )

  const firstUp = moveStep(three, 0, -1)
  check(
    'moveStep：第一项上移越界 → 内容原样（两个按钮本来就是禁用的，这是第二道）',
    firstUp.map((s) => s.id).join() === '1,2,3' && firstUp !== three,
    firstUp.map((s) => s.id).join()
  )

  const lastDown = moveStep(three, 2, 1)
  check(
    'moveStep：最后一项下移越界 → 内容原样',
    lastDown.map((s) => s.id).join() === '1,2,3',
    lastDown.map((s) => s.id).join()
  )

  const removed = removeStep(three, 1)
  check(
    'removeStep：只删掉第 i 步',
    removed.map((s) => s.id).join() === '1,3',
    removed.map((s) => s.id).join()
  )

  const replaced = replaceAt(three, 1, { kind: 'denoise', strength: 'strong' })
  check(
    'replaceAt：换参数时 id 原样保留（换了它那一行的 DOM 会重建，每敲一个字就失焦）',
    replaced[1].id === 2 &&
      (replaced[1].action as { strength?: string }).strength === 'strong' &&
      replaced[0] === three[0] &&
      replaced[2] === three[2],
    JSON.stringify(replaced.map((s) => s.id))
  )

  check(
    'replaceAt：没被改到的步骤对象引用不变（不是整条链重建）',
    replaced[0] === three[0] && replaced[2] === three[2],
    '引用变了'
  )

  const added: Step[] = [{ id: 4, action: { kind: 'sharpen', amount: '1' } }]
  check(
    'freshId：取当前最大 id + 1（不是长度、也不是自增计数器）',
    freshId(added) === 5 && freshId([]) === 1,
    `${freshId(added)} / ${freshId([])}`
  )
}

/* ------------------------------------------------------------------ [5] 渲染：调序位置 */

function testRenderPositions(): void {
  console.log('\n--- [5] 渲染：上移 / 下移在各个位置上的可用性 ---')
  const sharpen = (): FilterAction => ({ kind: 'sharpen', amount: 1 })
  const one = render(makeTask('video', { filters: [sharpen()] }))
  const two = render(makeTask('video', { filters: [sharpen(), { kind: 'rotate', degrees: 90 }] }))
  const three = render(
    makeTask('video', {
      filters: [sharpen(), { kind: 'rotate', degrees: 90 }, { kind: 'denoise', strength: 'light' }]
    })
  )

  const m1 = moverButtons(one.html)
  const m2 = moverButtons(two.html)
  const m3 = moverButtons(three.html)

  check(
    '渲染：链上每行恰好两个调序按钮（上移 / 下移）',
    m1.length === 2 && m2.length === 4 && m3.length === 6,
    `${m1.length} / ${m2.length} / ${m3.length}`
  )
  check(
    '渲染：单步链——上移与下移都禁用（它既是第一项也是最后一项）',
    isDisabled(m1[0]) && isDisabled(m1[1]),
    `上移 disabled=${isDisabled(m1[0])} 下移 disabled=${isDisabled(m1[1])}`
  )
  check(
    '渲染：两步链的第 1 行——上移禁用、下移可用',
    isDisabled(m2[0]) && !isDisabled(m2[1]),
    `上移 disabled=${isDisabled(m2[0])} 下移 disabled=${isDisabled(m2[1])}`
  )
  check(
    '渲染：两步链的第 2 行——上移可用、下移禁用',
    !isDisabled(m2[2]) && isDisabled(m2[3]),
    `上移 disabled=${isDisabled(m2[2])} 下移 disabled=${isDisabled(m2[3])}`
  )
  check(
    '渲染：三步链的第 2 行——上移与下移都可用（中间项不被任何常量挡住）',
    !isDisabled(m3[2]) && !isDisabled(m3[3]),
    `上移 disabled=${isDisabled(m3[2])} 下移 disabled=${isDisabled(m3[3])}`
  )
  check(
    '渲染：每一步的摘要是 describeAction 那一句（队列卡 / 历史页上是同一句）',
    deepEqual(
      summariesOf(three.html).filter(
        (t) => t === '锐化 1' || t === '旋转 90°' || t === '降噪（轻）'
      ),
      ['锐化 1', '旋转 90°', '降噪（轻）']
    ),
    JSON.stringify(summariesOf(three.html))
  )

  const shrink = render(
    makeTask('video', {
      filters: [
        { kind: 'resize', width: 800, fit: 'inside', withoutEnlargement: true },
        { kind: 'resize', width: 800, fit: 'inside', withoutEnlargement: false }
      ]
    })
  )
  check(
    '渲染：resize 的摘要带上「不放大」（用户拿到 800px 的图时才说得清为什么）',
    summariesOf(shrink.html).includes('缩到宽 800 · 不放大') &&
      summariesOf(shrink.html).includes('缩到宽 800'),
    JSON.stringify(summariesOf(shrink.html))
  )

  check(
    '渲染：三步链的第 3 行——上移可用、下移禁用',
    !isDisabled(m3[4]) && isDisabled(m3[5]),
    `上移 disabled=${isDisabled(m3[4])} 下移 disabled=${isDisabled(m3[5])}`
  )
}

/* ------------------------------------------------------------------ [6] 渲染：添加菜单 */

function testRenderAddMenu(): void {
  console.log('\n--- [6] 渲染：添加菜单按 canUseAction 过滤 ---')
  const video = render(makeTask('video'))
  const image = render(makeTask('image'))
  const audio = render(makeTask('audio'))

  check(
    '渲染：视频类别六项全可加，且按规范次序排（去隔行/降噪/锐化/旋转/缩放/响度归一化）',
    deepEqual(pillLabels(video.html), ['去隔行', '降噪', '锐化', '旋转', '缩放', '响度归一化']),
    JSON.stringify(pillLabels(video.html))
  )
  check(
    '渲染：图片类别只可加缩放与旋转（且按规范次序：旋转在缩放之前）',
    deepEqual(pillLabels(image.html), ['旋转', '缩放']),
    JSON.stringify(pillLabels(image.html))
  )
  check(
    '渲染：音频类别只可加响度归一化',
    deepEqual(pillLabels(audio.html), ['响度归一化']),
    JSON.stringify(pillLabels(audio.html))
  )
  check(
    '渲染：图片类别把放不下的四项点名说出来（从 canUseAction 的结果派生，不另写一张表）',
    image.html.includes(
      '「去隔行 / 降噪 / 锐化 / 响度归一化」在图片这一类上放不下，所以不在上面。'
    ),
    '那句话不在（或文案变了）'
  )
  check(
    '渲染：音频类别把放不下的五项点名说出来（去隔行 / 降噪 / 锐化 / 旋转 / 缩放）',
    audio.html.includes(
      '「去隔行 / 降噪 / 锐化 / 旋转 / 缩放」在音频这一类上放不下，所以不在上面。'
    ),
    '那句话不在（或文案变了）'
  )
  check(
    '渲染：视频类别六项全在菜单里，所以没有「放不下」那句话',
    !video.html.includes('放不下'),
    '不该出现的话出现了'
  )

  const full = render(
    makeTask('video', {
      filters: Array.from({ length: MAX_FILTER_ACTIONS }, () => ({ kind: 'sharpen', amount: 1 }))
    })
  )
  const fullPills = buttonsOf(full.html).filter((b) => b.text.startsWith('+ '))
  check(
    `渲染：链到上限（${MAX_FILTER_ACTIONS} 步）时添加按钮一个不少全是禁用态（禁掉而不是消失），并说明到上限了`,
    fullPills.length === 6 &&
      fullPills.every(isDisabled) &&
      full.html.includes(`链上已经有 ${MAX_FILTER_ACTIONS} 步，到上限了`),
    `添加按钮 ${fullPills.length} 个，其中禁用 ${fullPills.filter(isDisabled).length} 个`
  )

  const empty = render(makeTask('video'))
  check(
    '渲染：空链时给一句「链上还没有步骤」，且「清除」不出现（没设过的东西不该有清除按钮）',
    empty.html.includes('链上还没有步骤') &&
      buttonByText(empty.html, '清除') === undefined &&
      buttonByText(empty.html, '应用') !== undefined,
    `清除在不在=${buttonByText(empty.html, '清除') !== undefined}`
  )
}

/* ------------------------------------------------------------------ [7] 渲染：校验 */

function testRenderValidation(): void {
  console.log('\n--- [7] 渲染：校验原因与「应用」禁用 ---')
  const good = render(makeTask('video', { filters: [{ kind: 'sharpen', amount: 0.5 }] }))
  const bad = render(unreachableTask('video'))

  const goodApply = buttonByText(good.html, '应用')
  const badApply = buttonByText(bad.html, '应用')

  check(
    '渲染：合法链——「应用」可用，且没有红色的原因句',
    goodApply !== undefined &&
      !isDisabled(goodApply) &&
      errorLines(good.html).length === 0 &&
      good.props.reason === null,
    `reason=${JSON.stringify(good.props.reason)} 红句=${JSON.stringify(errorLines(good.html))}`
  )
  check(
    '渲染：非法输入——「应用」被禁用',
    badApply !== undefined && isDisabled(badApply),
    badApply === undefined ? '找不到应用按钮' : `disabled=${isDisabled(badApply)}`
  )
  check(
    '渲染：非法输入——原因句指名道姓（第 1 步「缩放」：宽高至少填一个…）',
    errorLines(bad.html).length === 1 &&
      errorLines(bad.html)[0] === '第 1 步「缩放」：宽高至少填一个（另一个留空则按比例算）',
    JSON.stringify(errorLines(bad.html))
  )
}

/* ------------------------------------------------------------------ [8] 渲染：提交载荷 */

async function testRenderSubmit(): Promise<void> {
  console.log('\n--- [8] 渲染：提交路径（载荷走 withOption、id 只留在草稿里）---')
  const trim: TaskOptions['trim'] = { start: 1, end: 2.5, mode: 'lossless' }
  const chain: FilterAction[] = [
    { kind: 'sharpen', amount: 0.5 },
    { kind: 'resize', width: 800, fit: 'inside', withoutEnlargement: true }
  ]

  const withTrim = await applyAndCapture(makeTask('video', { trim, filters: chain }))
  check(
    '提交：载荷保留用户先前的 trim（走 withOption，别的字段没被整体替换语义吃掉）',
    withTrim.calls.length === 1 && deepEqual(withTrim.calls[0][1]?.trim, trim),
    JSON.stringify(withTrim.calls)
  )
  check(
    '提交：载荷里的 filters 与草稿编译结果逐字段相同',
    withTrim.calls.length === 1 && deepEqual(withTrim.calls[0][1]?.filters, chain),
    JSON.stringify(withTrim.calls[0]?.[1]?.filters)
  )
  check(
    '提交：载荷里的每个动作都不带 id',
    (withTrim.calls[0]?.[1]?.filters ?? []).every((a) => !('id' in (a as object))),
    JSON.stringify(withTrim.calls[0]?.[1]?.filters)
  )
  const payloadSchema = filterActionSchema.safeParse(withTrim.calls[0]?.[1]?.filters?.[0])
  check(
    '提交：载荷直接过真的 filterActionSchema',
    withTrim.calls.length === 1 &&
      (withTrim.calls[0][1]?.filters ?? []).every((a) => filterActionSchema.safeParse(a).success),
    payloadSchema.success ? 'ok' : payloadSchema.error.issues[0]?.message
  )
  check(
    '提交：交出去的任务 id 就是这条任务的 id',
    withTrim.calls.length === 1 && withTrim.calls[0][0] === 't-ui',
    String(withTrim.calls[0]?.[0])
  )

  const bare = await applyAndCapture(makeTask('video'))
  check(
    '提交：空链并且没有别的参数时交 null（不是空对象 ——「没有参数」只有一种表示）',
    bare.calls.length === 1 && bare.calls[0][1] === null,
    JSON.stringify(bare.calls)
  )

  const emptied = await applyAndCapture(makeTask('video', { trim }))
  check(
    '提交：链删光但还有 trim 时，载荷只留 trim（不留一个 filters: []）',
    emptied.calls.length === 1 &&
      deepEqual(emptied.calls[0][1], { trim }) &&
      !('filters' in (emptied.calls[0][1] ?? {})),
    JSON.stringify(emptied.calls[0]?.[1])
  )

  const cleared = render(makeTask('video', { trim, filters: chain }))
  cleared.props.onClear()
  await new Promise((done) => setTimeout(done, 0))
  check(
    '提交：「清除」交出的载荷里也没有 filters 键',
    panel.__store.calls.length === 1 &&
      deepEqual(panel.__store.calls[0][1], { trim }) &&
      !('filters' in (panel.__store.calls[0][1] ?? {})),
    JSON.stringify(panel.__store.calls)
  )

  const withChain = render(makeTask('video', { filters: chain }))
  check(
    '渲染：「清除」按钮只在真的设过链时出现',
    withChain.props.canClear === true && buttonByText(withChain.html, '清除') !== undefined,
    `canClear=${withChain.props.canClear}`
  )

  const invalid = await applyAndCapture(unreachableTask('video'))
  check(
    '提交：非法链上点「应用」一次 setOptions 都不发（compiled.ok 那道闸真的在拦）',
    invalid.calls.length === 0,
    `居然发了 ${invalid.calls.length} 次`
  )
}

/* ------------------------------------------------------------------ [9] 元素树接线 */

function testWidgetWiring(): void {
  console.log('\n--- [9] 元素树：按钮到处理函数的接线（SSR 的产物里没有 onClick）---')
  const editCalls: Draft[] = []
  const moveCalls: number[] = []
  const removeCalls: number[] = []
  const spies = {
    onChange: (action: Draft) => editCalls.push(action),
    onMove: (delta: number) => moveCalls.push(delta),
    onRemove: () => removeCalls.push(1)
  }

  /** 按 `children` 找按钮：比按 `title` 找稳——标题是文案，文案改了不该让接线失去覆盖。 */
  const row0 = stepNodes({ id: 1, action: { kind: 'sharpen', amount: '1' } }, 0, 2, spies)
  const row1 = stepNodes(
    {
      id: 2,
      action: { kind: 'resize', width: '800', height: '', fit: 'inside', withoutEnlargement: true }
    },
    1,
    2,
    spies
  )

  fire(byText(row0, '上移'))
  check(
    '接线：第 1 行的上移按钮点了调 onMove(-1)（往前挪一位）',
    deepEqual(moveCalls, [-1]),
    JSON.stringify(moveCalls)
  )

  fire(byText(row1, '下移'))
  check(
    '接线：第 2 行的下移按钮点了调 onMove(1)（它是另一行，不是同一个常量）',
    deepEqual(moveCalls, [-1, 1]),
    JSON.stringify(moveCalls)
  )

  fire(byText(row1, '删除'))
  check('接线：删除按钮点了调 onRemove()', removeCalls.length === 1, String(removeCalls.length))

  // `StepRow` 交出来的树里，`Editor` 还是一个**组件元素**（它的产物要等 React 渲染才有），
  // 所以要拿到输入框得自己把 `Editor` 叫一次。前提是它没有 hook —— 这一整节都建立在
  // 「StepRow / Editor 是零 hook 的纯函数组件」上，将来给某一行加了 `useState`，
  // 这里会立刻炸出一句 hook 相关的报错，而不是安静地少测几条。
  const editors = allNodes(
    panel.Editor({
      step: {
        id: 2,
        action: {
          kind: 'resize',
          width: '800',
          height: '',
          fit: 'inside',
          withoutEnlargement: true
        }
      },
      index: 1,
      onChange: spies.onChange
    })
  )
  const widthInput = editors.find((n) => n.props['aria-label'] === '第 2 步的宽度（像素）')
  fire(widthInput, { target: { value: '1024' } })
  check(
    '接线：宽度输入框的 onChange 把新值交回 onChange，且别的字段原样保留',
    deepEqual(editCalls[0], {
      kind: 'resize',
      width: '1024',
      height: '',
      fit: 'inside',
      withoutEnlargement: true
    }),
    JSON.stringify(editCalls)
  )

  const broken = stepNodes(
    {
      id: 9,
      action: { kind: 'resize', width: '', height: '', fit: 'inside', withoutEnlargement: true }
    },
    0,
    1,
    spies
  )
  check(
    '接线：数值没填对的那一步只显示动作名（「缩放 —」），不编一个数出来',
    broken.some((n) => n.props.title === '缩放 —' && n.props.children === '缩放 —'),
    JSON.stringify(broken.map((n) => n.props.title).filter((t) => typeof t === 'string'))
  )
}

/* ------------------------------------------------------------------ [10] 反装饰性 */

function testAntiDecoration(): void {
  console.log('\n--- [10] 反装饰性：把判据的鉴别力本身钉住 ---')
  const good = render(makeTask('video', { filters: [{ kind: 'sharpen', amount: 0.5 }] }))
  const goodApply = buttonByText(good.html, '应用')

  check(
    '反装饰性：合法的链上 HTML 里也有 "disabled" 子串 —— 所以判据不能写成 includes',
    good.html.includes('disabled'),
    '居然没有（那第 [5]/[7] 节的取法就不是必需的了，可以简化）'
  )
  check(
    '反装饰性：合法链的「应用」按钮自己没有 disabled 属性（与上一条成对才有意义）',
    goodApply !== undefined && !isDisabled(goodApply),
    '应用按钮被禁用了'
  )
}

/* ------------------------------------------------------------------ 对照 */

/**
 * 反证脚本的**正对照**：这条断言恒真，用来确认「恒真断言不会被反证框架报成通过」。
 * 默认不跑（`ARBITER_UI_TAUTOLOGY=1` 才出现），免得它自己变成一条躺在套件里的装饰品。
 */
const TAUTOLOGY_LABEL = '[对照] 恒真断言（ARBITER_UI_TAUTOLOGY=1 时才出现，永远不该红）'

/* ------------------------------------------------------------------ 主流程 */

/* -------------------------------------------------- [11] 编码质量档面板 */

async function testQualityPanel(): Promise<void> {
  console.log('\n[11] 编码质量档面板（真渲染）')

  const applyBtn = (html: string): El | undefined => buttonByText(html, '应用')
  const crfInput = (html: string): El | undefined =>
    voidElements(html, 'input').find((i) => i.attrs['aria-label'] === '恒定质量 CRF')

  // ---- 1. 正常状态：可应用、没有理由、没有「清除」 ----
  const plain = renderQuality(qualityTask('mkv'))
  check('正常：可应用（reason 为 null）', plain.props.reason === null, String(plain.props.reason))
  check(
    '正常：「应用」按钮可用',
    applyBtn(plain.html) !== undefined && !isDisabled(applyBtn(plain.html)!)
  )
  check(
    '正常：没设过质量档时不显示「清除」（点了不会发生任何事的按钮比没有更糟）',
    !plain.props.canClear
  )
  check(
    '正常：CRF 输入框的初值是引擎的默认值（不是留空——留空会被当成 0，那是最差的一档）',
    crfInput(plain.html)?.attrs.value === String(DEFAULT_CRF),
    String(crfInput(plain.html)?.attrs.value)
  )
  check(
    '正常：速度档的初值是引擎的默认值',
    elements(plain.html, 'option').some(
      (o) => o.attrs.value === DEFAULT_PRESET && o.attrs.selected !== undefined
    ),
    elements(plain.html, 'option')
      .map((o) => `${o.attrs.value}${o.attrs.selected !== undefined ? '*' : ''}`)
      .join(',')
  )
  check(
    '正常：两个下拉里的档位与常量数组一致（ENCODE_PRESETS 10 档 + 调优 6 档 + 一个「不调优」）',
    elements(plain.html, 'option').length >= 17,
    String(elements(plain.html, 'option').length)
  )

  // ---- 2. 设过质量档：回填 + 出现「清除」 ----
  const filled = renderQuality(
    qualityTask('mkv', { quality: { crf: 30, preset: 'slow', tune: 'film' } })
  )
  check(
    '回填：CRF 从已设值读出来（不是永远显示默认值）',
    crfInput(filled.html)?.attrs.value === '30'
  )
  check(
    '回填：已设过时显示「清除」',
    filled.props.canClear && buttonByText(filled.html, '清除') !== undefined
  )

  // ---- 3. 与输出约束冲突：禁用 + 用**同一句常量**说清理由 ----
  const conflict = renderQuality(qualityTask('mkv', { output: { targetBytes: 10 * 1024 * 1024 } }))
  check(
    '⭐ 冲突：设了体积/码率目标时「应用」被禁用',
    applyBtn(conflict.html) !== undefined && isDisabled(applyBtn(conflict.html)!)
  )
  check(
    '⭐ 冲突：理由用的是 `QUALITY_OUTPUT_EXCLUSIVE` 那一句（与引擎抛出的是同一句话）',
    conflict.props.reason === QUALITY_OUTPUT_EXCLUSIVE,
    String(conflict.props.reason)
  )
  check(
    '冲突：那句话确实渲染到了界面上（不只是一个 props）',
    errorLines(conflict.html).includes(QUALITY_OUTPUT_EXCLUSIVE),
    errorLines(conflict.html).join(' | ')
  )

  // ---- 4. 出口不支持：禁用 + 说清楚是哪个出口、为什么 ----
  const webm = renderQuality(qualityTask('webm'))
  check(
    '出口：目标改成 webm 时「应用」被禁用',
    applyBtn(webm.html) !== undefined && isDisabled(applyBtn(webm.html)!)
  )
  check(
    '出口：理由点到了 VP9 与「另一条尺子」（不是一句「不支持」）',
    (webm.props.reason ?? '').includes('VP9'),
    String(webm.props.reason)
  )
  const gif = renderQuality(qualityTask('gif'))
  check(
    '出口：gif 的理由说的是调色板滤镜（两种出口的原因不同，不能共用一句话）',
    (gif.props.reason ?? '').includes('调色板'),
    String(gif.props.reason)
  )
  // 反装饰性：三条「禁用」必须**不是**同一个渲染产物——否则 isDisabled 恒真的话
  // 上面三节全是绿的。这里断「不冲突的那一条确实没被禁用」。
  check(
    '⭐ 反装饰：不冲突的那一条确实**没有** disabled（否则上面三条「被禁用」恒真）',
    applyBtn(plain.html) !== undefined && !isDisabled(applyBtn(plain.html)!)
  )

  // ---- 5. 载荷：完整、能过契约、不给空值 ----
  const withTrim: TaskOptions = { trim: { start: 1, end: 5, mode: 'exact' } }
  const submitted = await applyQualityAndCapture(qualityTask('mkv', withTrim))
  check('载荷：调用了一次 setOptions', submitted.calls.length === 1, String(submitted.calls.length))
  const payload = submitted.calls[0]?.[1] ?? null
  check(
    '⭐ 载荷：**先前设好的裁剪还在**（`setOptions` 是整体替换，只交 quality 会把它静默抹掉）',
    payload?.trim?.start === 1 && payload?.trim?.end === 5 && payload?.trim?.mode === 'exact',
    JSON.stringify(payload)
  )
  check(
    '载荷：质量档三项都在，且 CRF 是**数字**（字符串会被 zod 拒，而界面上一声不吭）',
    payload?.quality?.crf === DEFAULT_CRF &&
      payload?.quality?.preset === DEFAULT_PRESET &&
      typeof payload?.quality?.crf === 'number',
    JSON.stringify(payload?.quality)
  )
  check(
    '⭐ 载荷：调优选「不调优」时**不交这个键**（交出空串会被 schema 拒，用户看到的是「点了没反应」）',
    payload?.quality !== undefined && !('tune' in payload.quality),
    JSON.stringify(payload?.quality)
  )
  check(
    '⭐ 载荷能过契约：qualitySchema 收得下',
    payload?.quality !== undefined && qualitySchema.safeParse(payload.quality).success,
    JSON.stringify(payload?.quality)
  )
  check(
    '⭐ 载荷能过契约：整个 setOptions 载荷收得下（界面放行了一个主进程会拒的值 = 点了没反应）',
    payload !== null && setOptionsSchema.safeParse({ id: 't-ui', options: payload }).success
  )

  // ---- 6. 「清除」交出的是「没有质量档」，而不是一个空对象 ----
  const cleared = await applyQualityAndCapture(
    qualityTask('mkv', { quality: { crf: 30 }, trim: withTrim.trim }),
    'clear'
  )
  const clearPayload = cleared.calls[0]?.[1] ?? null
  check(
    '清除：quality 整个消失，而裁剪仍然留着（清除只该动它自己那一项）',
    clearPayload !== null && clearPayload.quality === undefined && clearPayload.trim !== undefined,
    JSON.stringify(clearPayload)
  )
  check(
    '清除：载荷仍然能过契约（`{ trim }` 而不是 `{ trim, quality: {} }`）',
    clearPayload !== null &&
      setOptionsSchema.safeParse({ id: 't-ui', options: clearPayload }).success,
    JSON.stringify(clearPayload)
  )
}

async function main(): Promise<void> {
  if (!existsSync(PANEL)) {
    console.error(`找不到 ${PANEL} —— 请在仓库根目录下运行这支套件。`)
    process.exit(1)
  }

  console.log('=== 参数面板回归网（处理链 + 编码质量档）===')
  // ⚠️ 顺序有讲究：两块面板各自 bundle 一次到**同一个临时目录**，而
  // `loadPanelModule` 开头会 `rm -rf` 那个目录。所以第二块必须等第一块的模块
  // 已经 `import` 进来之后再加载——先 load 两个再跑测试的话，后加载的会把前一个
  // 的 bundle 文件删掉，而 ESM 的模块图已经建好了，症状是「跑起来没事，跑一半找不到文件」。
  panel = await loadPanel()
  qualityPanel = await loadPanelModule<QualityPanelModule>(
    'QualitySection.tsx',
    [],
    '编码质量档面板'
  )
  // 锚点：`QualitySection` 是源码本来就导出的那个名字（不像处理链面板要捞内部函数），
  // 所以「改名了」不会在构建期被发现——改成**在这里当场撞一下**。
  // 少了它，改名之后 `createElement(undefined, …)` 会抛一句与改名毫无关系的 React 报错。
  if (typeof qualityPanel.QualitySection !== 'function') {
    console.error('\nQualitySection.tsx 里找不到导出的 `QualitySection`（改名或搬走了？）\n')
    process.exit(1)
  }

  testParse()
  testCompileAndSchema()
  testOrdering()
  testChainEdits()
  testRenderPositions()
  testRenderAddMenu()
  testRenderValidation()
  await testRenderSubmit()
  testWidgetWiring()
  testAntiDecoration()
  await testQualityPanel()

  if (process.env.ARBITER_UI_TAUTOLOGY === '1') check(TAUTOLOGY_LABEL, true)

  await rm(TMP, { recursive: true, force: true }).catch(() => {})

  console.log(`\n=== 通过 ${passed} / 失败 ${failed} ===`)
  process.exit(failed === 0 ? 0 : 1)
}

void main()
