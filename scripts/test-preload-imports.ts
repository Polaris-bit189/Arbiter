/**
 * preload 依赖图的**结构闸门**（纯 Node，不启动 Electron）。
 *
 *   npx tsx --tsconfig tsconfig.test.json scripts/test-preload-imports.ts
 *
 * ## 为什么需要这条闸门
 *
 * `docs/NOTES.md` 约束 1：`sandbox: true` 的 preload 里 `require()` **只能解析 `electron`**，
 * 任何被 externalize 的 npm 依赖都会在运行时 `module not found`，导致 **preload 整个崩掉**
 * ——表现是 `window.api` 未定义、拖拽毫无反应这类极难排查的静默失败
 * （`@electron-toolkit/preload` 就是因此被移除的）。
 *
 * 而这件事在**单元测试里看不出来**：它只在 Electron 真的加载 preload 时才发生。
 * 所以这里立一道**结构判据**——不跑代码，只看依赖图的边：
 * `src/preload/**` 的每一条 import / require，specifier 只允许是
 *
 *   1. 相对路径（`./` `../`），
 *   2. `electron` 与 `electron/*`，
 *   3. `import type` / `export type` 那类**编译期被完全擦除**的导入，
 *   4. 唯一一条具名豁免 `@shared/channels`（见下面 `ALIAS_EXEMPT`）。
 *
 * 其余任何裸模块名（`zod`、`@electron-toolkit/*`、任何 npm 包）一律失败。
 *
 * ## 这条闸门是为即将开始的 i18n 改造提前立的网
 *
 * i18n 的字典模块**绝不能被拖进 preload 的依赖图**：一旦 `src/preload/index.ts` 里
 * 出现 `import { t } from '@shared/i18n'`，打包时确实会被内联（preload 不 externalize），
 * 但那意味着字典的每一个字都被塞进 preload bundle，而且那条 import 会**越来越大**——
 * 今天拖进来的是字典，明天就是它背后的 zod schema。闸门要在第一行写下去的时候就红。
 *
 * ## 两条与「装饰性断言」有关的自觉
 *
 * - 判据全是**结构**判据（数边、看 specifier），不看「有没有报错」，所以不存在
 *   「环境不同就时绿时红」。源码是这次运行**当场读**的，不是快照。
 * - 每条豁免规则都配了一条**非空前置**（「这条豁免真的被用到过吗」）。没有它的话，
 *   把 `@shared/channels` 那条豁免规则写错成永不触发，套件照样全绿——
 *   本项目已经因为「在空集合上恒真」抓到过四条装饰性断言。
 */
import { existsSync, readdirSync, readFileSync } from 'fs'
import { relative, resolve } from 'path'

/** 被扫的目录。**递归**扫，子目录里将来放什么都跑不掉 */
const PRELOAD_DIR = resolve('src/preload')
const ENTRY = resolve(PRELOAD_DIR, 'index.ts')

/** preload bundle 里被 Vite 内联的项目内源码，没有对应的 npm 包 */
const SOURCE_EXTS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']

/**
 * **唯一**被允许的非相对、非 electron 的运行时 specifier。
 *
 * 它不是「别名白名单」，是一个具名豁免：`src/shared/channels.ts` 是零依赖的字符串常量表
 * （单独成文件正是为了让 sandbox preload 能拿到通道名而**不把 zod 拖进依赖图**，
 * 见 `docs/NOTES.md` 架构一节）。所以放行的判据是「这一个文件」，不是「`@shared/*` 这个命名空间」
 * ——放宽成命名空间等于把 i18n 字典也一起放进来，那正是这条闸门要挡的事。
 *
 * 要动这一行，先想清楚「它会不会把 npm 依赖带进来」。
 */
const ALIAS_EXEMPT = '@shared/channels'

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

/**
 * 把注释换成等长空白（**保留字节偏移与行号**）。
 *
 * 不这么做的话，注释里那些「举例说明不能这么写」的 `import … from 'zod'`
 * 会被当成真 import —— 而本仓库的注释密度正是这种假阳性的温床。
 * 字符串按引号成对跳过，免得字符串里的 `//` 被当成注释开头。
 */
function stripComments(source: string): string {
  const out = source.split('')
  let i = 0
  while (i < source.length) {
    const c = source[i]
    const n = source[i + 1]
    if (c === '/' && n === '/') {
      while (i < source.length && source[i] !== '\n') {
        out[i] = ' '
        i += 1
      }
      continue
    }
    if (c === '/' && n === '*') {
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) {
        if (source[i] !== '\n') out[i] = ' '
        i += 1
      }
      if (i < source.length) {
        out[i] = ' '
        out[i + 1] = ' '
        i += 2
      }
      continue
    }
    if (c === '"' || c === "'" || c === '`') {
      const quote = c
      i += 1
      while (i < source.length && source[i] !== quote) {
        if (source[i] === '\\') i += 1
        i += 1
      }
      i += 1
      continue
    }
    i += 1
  }
  return out.join('')
}

/** 一条被扫出来的依赖边 */
interface Edge {
  file: string
  line: number
  form: string
  spec: string
  typeOnly: boolean
}

/** 是不是「整个 import 子句都是类型」——那种写法编译后一点运行时痕迹都不留 */
function isTypeOnlyClause(clause: string): boolean {
  const trimmed = clause.trim()
  // `import type { A } from` / `import type * as N from` / `import type A from`
  if (/^type\s+[A-Za-z_$*{]/.test(trimmed)) return true
  // `import { type A, type B } from`：逐项都要带 `type` 才算
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    const items = trimmed
      .slice(1, -1)
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s !== '')
    return items.length > 0 && items.every((s) => /^type\s/.test(s))
  }
  return false
}

/** 数第几行（1 起）。只用来打诊断信息，不参与判定 */
function lineAt(source: string, index: number): number {
  return source.slice(0, index).split('\n').length
}

/** 把一份源码里所有 import / require 的 specifier 抠出来 */
function edgesOf(file: string, raw: string): Edge[] {
  const source = stripComments(raw)
  const edges: Edge[] = []

  const push = (
    m: RegExpExecArray,
    clauseIndex: number | null,
    specIndex: number,
    form: string
  ): void => {
    const spec = m[specIndex]
    const clause = clauseIndex === null ? '' : m[clauseIndex]
    edges.push({
      file,
      line: lineAt(source, m.index),
      form,
      spec,
      typeOnly: clauseIndex !== null && isTypeOnlyClause(clause)
    })
  }

  for (const m of source.matchAll(/\bimport\s+([^'"]*?)\s+from\s+(['"])([^'"]+)\2/g)) {
    push(m, 1, 3, 'import … from')
  }
  for (const m of source.matchAll(/\bexport\s+([^'"]*?)\s+from\s+(['"])([^'"]+)\2/g)) {
    push(m, 1, 3, 'export … from')
  }
  for (const m of source.matchAll(/\bimport\s+(['"])([^'"]+)\1/g)) {
    push(m, null, 2, 'import（副作用）')
  }
  for (const m of source.matchAll(/\brequire\s*\(\s*(['"])([^'"]+)\1\s*\)/g)) {
    push(m, null, 2, 'require')
  }
  for (const m of source.matchAll(/\bimport\s*\(\s*(['"])([^'"]+)\1\s*\)/g)) {
    push(m, null, 2, 'import()（动态）')
  }

  return edges
}

/** 非字面量的 specifier：静态数不出来，所以只能判失败 */
function dynamicSpecifiers(source: string): string[] {
  const stripped = stripComments(source)
  const found: string[] = []
  for (const re of [/\brequire\s*\(\s*[^'")\s]/g, /\bimport\s*\(\s*[^'")\s]/g]) {
    for (const m of stripped.matchAll(re)) {
      found.push(`第 ${lineAt(stripped, m.index)} 行：${m[0].trim()}`)
    }
  }
  return found
}

/** 判定一条边界，并给出人话理由 */
function classify(edge: Edge): { ok: boolean; why: string } {
  const { spec, form, typeOnly } = edge
  if (spec.startsWith('./') || spec.startsWith('../')) {
    return { ok: true, why: '相对路径' }
  }
  if (spec === 'electron' || spec.startsWith('electron/')) {
    return { ok: true, why: 'electron（sandbox preload 里唯一能 require 的包）' }
  }
  if (typeOnly) {
    return { ok: true, why: '`import type`：编译期被完全擦除，不进运行时依赖图' }
  }
  if (spec === ALIAS_EXEMPT) {
    return { ok: true, why: `具名豁免 ${ALIAS_EXEMPT}（零依赖的字符串常量表）` }
  }
  return {
    ok: false,
    why:
      `${form} 引入裸模块名 ${JSON.stringify(spec)} —— sandbox preload 里 require() 只能解析 electron，` +
      '它会在运行时 module not found 并让 preload 整个崩掉（docs/NOTES.md 约束 1）'
  }
}

function main(): void {
  console.log('=== preload 依赖图结构闸门 ===')

  if (!existsSync(PRELOAD_DIR)) {
    console.error(`找不到 ${relative(process.cwd(), PRELOAD_DIR)}，这条闸门无从判起。`)
    process.exit(1)
  }

  // 前置：入口文件必须在。少了它，「一个 import 都没扫到」也会是全绿
  check('前置：src/preload/index.ts 存在（它才是被 Electron 加载的那个入口）', existsSync(ENTRY))

  const files = (readdirSync(PRELOAD_DIR, { recursive: true }) as string[])
    .filter((name) => SOURCE_EXTS.includes(name.slice(name.lastIndexOf('.'))))
    .map((name) => resolve(PRELOAD_DIR, name))
    .sort()

  check(
    `前置：扫到 ≥ 2 个 preload 源文件（index.ts + index.d.ts），实际 ${files.length}`,
    files.length >= 2
  )

  const edges = files.flatMap((file) =>
    edgesOf(relative(process.cwd(), file), readFileSync(file, 'utf8'))
  )
  const dynamic = files.flatMap((file) =>
    dynamicSpecifiers(readFileSync(file, 'utf8')).map(
      (d) => `${relative(process.cwd(), file)} ${d}`
    )
  )

  console.log(`\n  —— 扫到的依赖边（共 ${edges.length} 条）——`)
  const violations: string[] = []
  for (const edge of edges) {
    const verdict = classify(edge)
    if (!verdict.ok) violations.push(`${edge.file}:${edge.line}  ${edge.spec}`)
    console.log(
      `  ${verdict.ok ? '✓' : '✗'} ${edge.file}:${edge.line}  ${edge.spec}   —— ${verdict.why}`
    )
  }
  if (dynamic.length > 0) {
    console.log('  —— 非字面量 specifier（静态数不出来）——')
    for (const d of dynamic) console.log(`  ✗ ${d}`)
  }

  console.log('')
  check(
    `前置：至少扫到 1 条 import / require（空集合上的「不含违规」恒为真）`,
    edges.length >= 1,
    `实际 ${edges.length} 条`
  )
  // 每条豁免规则都真被用到过，否则那条规则是装饰品：写错成永不触发也照样全绿
  check(
    '豁免规则真被用到：≥ 1 条 `import type`（编译期擦除那条）',
    edges.filter((e) => e.typeOnly).length >= 1
  )
  check(
    '豁免规则真被用到：≥ 1 条相对路径',
    edges.filter((e) => e.spec.startsWith('./') || e.spec.startsWith('../')).length >= 1
  )
  check(
    '豁免规则真被用到：≥ 1 条 electron',
    edges.filter((e) => e.spec === 'electron' || e.spec.startsWith('electron/')).length >= 1
  )
  check(
    `具名豁免 ${ALIAS_EXEMPT} 真被用到（否则这条豁免是摆设，改坏了也没人发现）`,
    edges.filter((e) => e.spec === ALIAS_EXEMPT).length >= 1
  )

  check(
    'preload 的每一条 import / require 都不是裸 npm 模块名',
    violations.length === 0,
    violations.join(' | ')
  )
  check(
    'preload 的 import / require 全是字面量（动态 specifier 静态验不了，一律拒）',
    dynamic.length === 0,
    dynamic.join(' | ')
  )

  console.log(`\n=== 通过 ${passed} / 失败 ${failed} ===`)
  process.exit(failed === 0 ? 0 : 1)
}

main()
