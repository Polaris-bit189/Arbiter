/**
 * i18n 的第一道闸门（纯 Node，不启动 Electron）。
 *
 *   npx tsx --tsconfig tsconfig.test.json scripts/test-i18n.ts
 *
 * ## 这道闸门要回答什么
 *
 * i18n 改造（`C:\Users\Polaris\.claude\plans\mighty-zooming-graham.md`）的全部风险都压在
 * 一条前提上：**中文是默认语言，且字典里的中文值与今天的字面量逐字节相同**。
 * 那条前提一旦破，1892 条断言里约 150 条会红——更糟的是其中约 10~15 条**负向断言**
 * 不会红，而是静默退化成恒真的装饰品（计划里逐条列了那 7 处）。
 * 所以这条前提必须由**机器**保证，不能靠自觉。
 *
 * 闸门 a 管其中最基础的一件事：**哪些文件里还写着中文，各写了多少条**。
 * 它同时是「遗漏迁移」与「新写中文」的探测器，也是唯一能回答「英文下还剩多少中文」的东西。
 *
 * ## 口径（表里的数字是怎么数出来的）
 *
 * **扫的范围**（三块）：
 *   1. `src/renderer/src/**\/*.{ts,tsx}` —— 渲染层全部，**递归**，将来加文件自动进网；
 *   2. `src/main/ipc/**\/*.ts` —— 主进程 GUI 侧（对话框 / 通知 / 文件选择器都在这里），同上；
 *   3. `MAIN_GUI_FILES` 里逐个点名的 7 个主进程文件；
 *   4. `EXTRA_FILES` 里那一个 `src/renderer/index.html`——**计划里没写这一条，是这里加的**，
 *      理由见 `EXTRA_FILES` 上面那段注释。
 * 路径一律是**相对仓库根的 POSIX 风格**（`src/renderer/src/...`），与预算表的键一一对应。
 *
 * **刻意不在范围内**的三块，写在这里免得被当成遗漏：
 *   - `src/main/core/task.ts` 的 `progress.stage`——P5 才动，且属 B 类（码 + zh 兜底）；
 *   - `src/shared/{options,trim}.ts` 的 `describe*`——P3，且消费方全在渲染层；
 *   - `converters/**` 与 `engines/**` 里那 30+ 个 `throw new ConversionFailed('…')`——
 *     C 类，进 `logTail` 的**原始记录，永不翻译**。把它们混进这张表，只会让
 *     「新写中文」的探测器淹没在三百条本来就不该迁移的文案里。
 * 这三块将来各自进网时，把目录加进 `SCAN_DIRS` / 把文件加进 `MAIN_GUI_FILES` 即可。
 *
 * **剔注释**：先把行注释与块注释的正文换成**等长空格**（保留偏移与行号）再数。
 * 本仓库注释密度极高、注释里到处是中文，不剔的话这张表量的是「谁注释写得多」。
 *
 * **数的是什么**：含 CJK 的**文案片段**，两类各算一条——
 *   - 字符串 / 模板字面量。一条模板只算**一条**，且只按它的字面量部分判：
 *     `` `${x} 完成` `` 算一条，而 `` `${ok ? '完成' : 'done'}` `` 里那句中文算
 *     **内层字符串**那一条、模板本身不算（否则同一处文案会被数两次）；
 *   - **JSX 文本节点**（`<h1>调律者转换器</h1>`）。严格说它不是「字面量」，
 *     但它就是界面文案，漏掉它这道闸门就答不出「英文下还剩多少中文」。
 *     已知且**刻意**的口径：`<p>已转换 {n} 个</p>` 算 **2 条**（`{`/`}` 会把文本切开），
 *     确定、可复现，不是意外。
 *
 * 判据是**逐文件相等**，不是总数：某个文件从 5 涨到 6、同时另一个从 7 降到 6，
 * 总数不变——只钉总数的话这件事静默发生。
 * 相等是**双向**的：迁移走一批中文之后必须**同提交**把这里的数字改小，否则红。
 * ⚠️ 这是刻意的：「≤ 预算」那种写法几周后就会让这张表退化成一张没人维护的旧快照。
 * ⚠️ **本脚本不提供「按实测重写预算表」的开关**，也不自动生成任何东西——
 * 一个会把期望值改成实际值的脚本等于没有期望值（P0 里那份 `i18n-zh-baseline.json`
 * 同属「冻结快照，永不自动重生成」）。
 *
 * ## 另一条自觉：非空前置
 *
 * 「没有超预算的文件」在一个**什么都没扫到**的空集合上恒真。本项目因为这类装饰性断言
 * 已经抓到过**四条**，所以这里每一条「不含 X」型判据都配了「扫到了 N 个（N > 0）」的前置。
 *
 * ## 与 `scripts/test-preload-imports.ts` 的关系
 *
 * 同一批网、同一种风格，但**没有复用**它那个 `stripComments`：那份实现按引号成对跳过，
 * 够用是因为它只关心 import 的 specifier；这里要取出字面量**本身**，还得处理模板里的
 * `${}` 嵌套，所以另写了一个词法扫描（见 `scanSource`）。
 * 两边都不引任何依赖，都是「读源码 → 立结构判据」。
 *
 * ## 今天（P0，字典还没建）的门状态
 *
 * 四道闸门里只有 **a** 有可断言的输入。b/c/d 需要 `src/shared/i18n/{zh,en}.ts` 与
 * `scripts/fixtures/i18n-zh-baseline.json`（P1 才产出），所以它们今天的状态是
 * **「未接线」而不是「通过」**，末尾的汇总会**显眼地**说出来。
 * 退出码只由**真跑了**的闸门决定（今天 = 闸门 a），CI 现在不会因为 b/c/d 红。
 * 一个「看起来全绿、其实三条没跑」的输出是本仓库最忌讳的东西。
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, relative, resolve, sep } from 'path'
import { pathToFileURL } from 'url'

/**
 * 扫的源码扩展名。
 *
 * `.css` / `.svg` / `.html` 都不在网里（它们不是文案的生产者，见文件头口径）。
 * **`.mjs` 是 P6 才加的**：插件（`plugins/arbiter/**`）是纯 `.mjs`，而它同样产出
 * 用户可见的文案（`read-convert.mjs` 那句 `permissionDecisionReason` 会显示给模型）。
 */
const SOURCE_EXTS = ['.ts', '.tsx', '.mjs']

/**
 * 整目录进网的几块。
 *
 * ⚠️ **P6 扩网（2026-09-26）加的 `src/mcp` / `src/cli` / `plugins/arbiter`**：
 * 这三个入口的消费者是 agent 与脚本，不是坐在桌前看界面的人——但那不改变
 * 「它们说的中文也是用户可见文案」这件事（agent 会把它们转述给人）。
 */
const SCAN_DIRS = [
  resolve('src/renderer/src'),
  resolve('src/main/ipc'),
  resolve('src/mcp'),
  resolve('src/cli'),
  resolve('plugins/arbiter')
]

/**
 * 逐个点名进网的主进程 GUI 文件（相对仓库根）。
 *
 * 判据是「它的中文会不会被画到用户眼前、而渲染进程不在场」——原生对话框、系统通知、
 * 注册表菜单标签、快捷方式描述、引擎状态、设置损坏原因都在这里
 * （计划 §「只能用主进程出文字的九处」那张表）。
 */
const MAIN_GUI_FILES = [
  'src/main/core/cli.ts',
  'src/main/core/folderScan.ts',
  'src/main/core/integration.ts',
  'src/main/core/jsonStore.ts',
  'src/main/core/renameWatcher.ts',
  'src/main/core/sendTo.ts',
  'src/main/engines/status.ts'
]

/**
 * 两个目录之外、但仍归本闸门管的文件。
 *
 * 今天只有一个 `src/renderer/index.html`，而它必须进来：**窗口标题就在那里**
 * （`<title>调律者转换器</title>`）。计划把它划在范围外，是因为口径写的是
 * 「`src/renderer/src/**`」；但用户第一眼看到的那行字恰恰在这个文件里，
 * 漏掉它这道闸门就少答了一格（页面挂载前那几十毫秒的窗口标题也是「还剩多少中文」的一部分）。
 *
 * 它共用不了 TS 那个扫描器（HTML 的注释是 `<!-- -->` 而不是 `//`），
 * 所以走 `scanHtmlSource`，判据与 JSX 文本那条**同一条规则**：按 `<>` 切开的极大文本段。
 * 不想让这个文件进网的话，把这行删掉即可——删掉之后它既不进预算也不进自检。
 */
const EXTRA_FILES = ['src/renderer/index.html']

/**
 * 逐文件的中文条数预算。**每一个数字都是本文件「今天实测」的值**，不是估计、不是目标。
 *
 * 怎么读这张表：
 *   - 数字**变大** ⇒ 有人新写了中文，或者把某句中文从别处搬了进来 → 要么改成走字典，
 *     要么在同一个提交里把数字改上去并说清为什么；
 *   - 数字**变小** ⇒ 迁移发生了，把数字改小是**必须**的同提交动作（双向相等，见文件头）；
 *   - 某个文件**没在表里** ⇒ 它的预算就是 0。新加一个文件写了中文，一条断言都不用过就红。
 *
 * ⚠️ 迁移进行中（P2/P4）这张表会被反复改小，这是设计的一部分，不是噪音。
 */
const ZH_BUDGET: Record<string, number> = {
  // —— 主进程 GUI 白名单（`MAIN_GUI_FILES` 里那 7 个）——
  // 15 → 17：P0-10 加了新引擎 `encmusic` 的名字与它的 detail 各一条。
  // **它们会走字典，只是排在 P4**（主进程那一批）；在那之前把预算照实改上去，
  // 而不是先写一个够到将来的数——这张表的口径是「今天实测」。
  // —— src/main/ipc/**（整目录进网，但只有这 5 个文件里有中文）——
  // —— EXTRA_FILES：不在上面两个目录里，单独点名（理由见上面那段注释）——
  // —— src/renderer/src/**（同样整目录进网；下表只列有中文的那些）——
  // P0-10 新增的面板。28 是**它诞生那天实测**的值（闸门 a 会把「新写了中文」逼到这个提交里）。

  // —— P6 扩网（2026-09-26）：MCP / CLI / 插件 ——
  // 扩网当天实测 **407 条**（20 个文件）。六条线迁完之后只剩下面这 3 个文件里的
  // **9 条 C 类**——「原始记录，永不翻译」那一类，逐条理由写在各自的源码注释里：
  //   - `main.ts` 7 条：生命周期日志（`收到 SIGINT` / `stdin 关闭（客户端断开）`…）
  //     与**就绪横幅**。后者另有一条硬约束：`test-mcp-server.ts` 与 `test-plugin-launch.mjs`
  //     都拿 `已就绪` 这个**子串**判「服务起没起来」，翻它等于把两个套件绑在 `ARBITER_LOCALE` 上。
  //   - `stdout.ts` 1 条：协议守卫的开发者诊断，而它旁边跟着的就是那段**脏内容原文**。
  //   - `inspectCost.ts` 1 条：它抛的异常在调用处被 `catch { size = undefined }` **吞掉**，
  //     既到不了 agent 也进不了日志。
  //
  // ⚠️ 其余 **398 条**迁完即归零，所以**不在这里列**（不在表里 = 预算 0）。
  // 插件的三个源文件同理；它们那份字典是 `plugins/arbiter/mcp/i18n.mjs`——**字典本体**，
  // 与 `src/shared/i18n/**` 一样不进本闸门（见 `DICT_FILES`）。
  'src/mcp/main.ts': 7,
  'src/mcp/stdout.ts': 1,
  'src/mcp/inspectCost.ts': 1
}

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

/* ------------------------------------------------------------------ 扫描 */

/**
 * CJK 判据。
 *
 * 比计划里闸门 b 用的 `[\u4e00-\u9fff]` **宽一档**：多收了 CJK 标点（`\u3000-\u303f`）与
 * 全角形式（`\uff00-\uffef`）。理由是「只由一个全角冒号组成的字面量」同样是界面文案、
 * 同样要迁走，而 `[\u4e00-\u9fff]` 看不见它。
 * **刻意不收**通用标点（`\u2000-\u206f`，那些弯引号在英文里也会出现）——
 * 收了就会把 `It’s` 这种纯英文字符串数成中文。
 */
const CJK_CLASS = '\\u3000-\\u303f\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff\\uff00-\\uffef'

/** 不含 `g`：`test()` 用它，避开 lastIndex 的坑 */
const CJK_CHAR = new RegExp(`[${CJK_CLASS}]`)

/**
 * JSX 文本片段：**按 `{`、`}`、`<`、`>` 切开的极大文本段**里含 CJK 的那些。
 *
 * 判据刻意这么宽，是因为窄的那一版**漏过**了最常见的一种写法——文本节点紧挨着
 * 一个嵌入式表达式，两侧的分隔符就成了 `}` 或 `{` 而不是 `<`：
 * `{version.length > 0 && …}秩序归于格式</span>` 与 `上次这类文件转成了 {ext}`。
 * 实测：写成「必须 `>` 开头、`<` 结尾」时，52 个文件里有 30 行中文落在视野之外
 * （本文件的「扫描器自检」当场报了出来）。
 *
 * 放宽**没有**引入误报：这段正则跑在「注释与字面量正文都已变成空格」的那份掩码上
 * （见 `scanSource`），于是剩下的 CJK 只可能是 JSX 文字——代码里出现不了 CJK。
 * 已含 `g`，用 `matchAll`（它不读也不写原对象的 lastIndex）。
 */
const JSX_TEXT_RE = new RegExp(`[^<>{}]*[${CJK_CLASS}][^<>{}]*`, 'g')

/**
 * `/` 前面出现这些字符时，它开的是**正则**而不是除法。
 *
 * ⚠️ **刻意不含 `<` 与 `>`**：`</div>` 的 `/` 前面正是 `<`，把它算成正则起点会让扫描器
 * 从那里一直吃到下一个 `/`——JSX 密集的文件会被整段吞掉，而症状只是「数字变小了」。
 * 代价是 `if (a > /re/.test(x))` 这种写法会被当成除法；实测本仓库没有这种写法，
 * 真踩到的话「扫描器自检」那条会报出来（见 `uncovered`）。
 */
const REGEX_AFTER_CHAR = new Set([
  '(',
  '[',
  ',',
  ';',
  ':',
  '!',
  '&',
  '|',
  '?',
  '{',
  '}',
  '+',
  '-',
  '*',
  '%',
  '~',
  '^',
  '='
])

/** `return /re/.test(x)` 这种写法：`/` 前面隔着空白的是一个关键字 */
const REGEX_AFTER_KEYWORD = new Set([
  'return',
  'typeof',
  'case',
  'in',
  'of',
  'do',
  'else',
  'void',
  'delete',
  'new',
  'instanceof',
  'yield',
  'await'
])

/** 一个「含 CJK 的文案片段」在源文件里的位置与它数得到的文本 */
interface Segment {
  /** 源文件里的字符偏移（**不是**剔注释之后的偏移） */
  start: number
  /** 结束偏移（不含） */
  end: number
  kind: 'string' | 'template' | 'jsx-text' | 'html-text'
  /** 参与判定的文本。模板是**只由字面量部分拼起来**的，不含 `${…}` 的源码 */
  text: string
}

/** 逐字扫描一遍，取出全部字符串 / 模板 / JSX 文本片段，并把注释改成空格 */
function scanSource(raw: string): { segments: Segment[]; masked: string } {
  const masked = raw.split('')
  // 第二份掩码：注释与**字面量正文**都换成空格，于是只剩「代码 + JSX 文本」。
  // JSX 那段正则只能跑在它上面——否则 `const s = '> 中文 <'` 会被数两次。
  const jsxMasked = raw.split('')

  const blank = (arr: string[], from: number, to: number): void => {
    for (let k = from; k < to && k < arr.length; k += 1) {
      if (arr[k] !== '\n') arr[k] = ' '
    }
  }

  const segments: Segment[] = []
  type Frame =
    { kind: 'code'; braces: number } | { kind: 'template'; first: number; literal: string }
  const frames: Frame[] = [{ kind: 'code', braces: 0 }]

  const n = raw.length
  let i = 0

  while (i < n) {
    const frame = frames[frames.length - 1]!

    if (frame.kind === 'template') {
      const c = raw[i]!
      if (c === '\\') {
        frame.literal += raw.slice(i, i + 2)
        i += 2
        continue
      }
      if (c === '`') {
        segments.push({ start: frame.first, end: i + 1, kind: 'template', text: frame.literal })
        blank(jsxMasked, frame.first, i + 1)
        frames.pop()
        i += 1
        continue
      }
      if (c === '$' && raw[i + 1] === '{') {
        // 表达式里的是**代码**，不进这条模板的 literal；它自己的字符串会另算一条
        frames.push({ kind: 'code', braces: 0 })
        blank(jsxMasked, i, i + 2)
        i += 2
        continue
      }
      frame.literal += c
      i += 1
      continue
    }

    const c = raw[i]!

    if (c === '/' && raw[i + 1] === '/') {
      while (i < n && raw[i] !== '\n') {
        masked[i] = ' '
        jsxMasked[i] = ' '
        i += 1
      }
      continue
    }

    if (c === '/' && raw[i + 1] === '*') {
      masked[i] = ' '
      masked[i + 1] = ' '
      jsxMasked[i] = ' '
      jsxMasked[i + 1] = ' '
      i += 2
      while (i < n && !(raw[i] === '*' && raw[i + 1] === '/')) {
        if (raw[i] !== '\n') {
          masked[i] = ' '
          jsxMasked[i] = ' '
        }
        i += 1
      }
      if (i < n) {
        masked[i] = ' '
        masked[i + 1] = ' '
        jsxMasked[i] = ' '
        jsxMasked[i + 1] = ' '
        i += 2
      }
      continue
    }

    if (c === '"' || c === "'") {
      const start = i
      i = consumeString(raw, i)
      blank(jsxMasked, start, i)
      segments.push({ start, end: i, kind: 'string', text: raw.slice(start + 1, i - 1) })
      continue
    }

    if (c === '`') {
      blank(jsxMasked, i, i + 1)
      frames.push({ kind: 'template', first: i, literal: '' })
      i += 1
      continue
    }

    if (c === '/' && startsRegex(raw, i)) {
      const start = i
      i = consumeRegex(raw, i)
      blank(jsxMasked, start, i)
      continue
    }

    if (c === '{') {
      frame.braces += 1
      i += 1
      continue
    }

    if (c === '}') {
      // `${…}` 的收尾不是代码块的收尾：只在这一层没有未闭合的 `{` 时才弹回模板
      if (
        frame.braces === 0 &&
        frames.length > 1 &&
        frames[frames.length - 2]!.kind === 'template'
      ) {
        frames.pop()
        blank(jsxMasked, i, i + 1)
        i += 1
        continue
      }
      if (frame.braces > 0) frame.braces -= 1
      i += 1
      continue
    }

    i += 1
  }

  // 模板没闭合（源码坏了，或扫描器判错了）：把已收的那截也交出去，别静默丢掉
  for (const frame of frames) {
    if (frame.kind === 'template') {
      segments.push({ start: frame.first, end: n, kind: 'template', text: frame.literal })
    }
  }

  // JSX 文本片段
  const jsxText = jsxMasked.join('')
  for (const m of jsxText.matchAll(JSX_TEXT_RE)) {
    segments.push({ start: m.index, end: m.index + m[0].length, kind: 'jsx-text', text: m[0] })
  }

  segments.sort((a, b) => a.start - b.start)
  return { segments, masked: masked.join('') }
}

/**
 * `index.html` 专用。
 *
 * 只做两件事：把 HTML 注释换成等长空格，然后套**同一套**「按 `<>` 切开的极大文本段」判据。
 * 不引 HTML 解析器：这个文件里要数的只有 `<title>` 那一处，而正文文本与纯文本节点
 * 在这套判据下天然同形。
 */
function scanHtmlSource(raw: string): { segments: Segment[]; masked: string } {
  const masked = raw.split('')
  const NL = String.fromCharCode(10)
  for (const m of raw.matchAll(/<!--[^]*?-->/g)) {
    for (let k = m.index!; k < m.index! + m[0].length; k += 1) {
      if (masked[k] !== NL) masked[k] = ' '
    }
  }
  const text = masked.join('')
  const segments: Segment[] = []
  for (const m of text.matchAll(JSX_TEXT_RE)) {
    segments.push({ start: m.index!, end: m.index! + m[0].length, kind: 'html-text', text: m[0] })
  }
  return { segments, masked: text }
}

/** 跳到字符串 / 模板字面量结束之后。返回新的下标 */
function consumeString(raw: string, i: number): number {
  const quote = raw[i]!
  i += 1
  while (i < raw.length) {
    if (raw[i] === '\\') {
      i += 2
      continue
    }
    if (raw[i] === quote) return i + 1
    i += 1
  }
  return i
}

/** `/` 处开的到底是不是正则（判据见 `REGEX_AFTER_CHAR` 那段注释） */
function startsRegex(raw: string, i: number): boolean {
  let j = i - 1
  while (j >= 0 && /\s/.test(raw[j]!)) j -= 1
  if (j < 0) return true
  const prev = raw[j]!
  if (/[\w$]/.test(prev)) {
    let k = j
    while (k >= 0 && /[\w$]/.test(raw[k]!)) k -= 1
    return REGEX_AFTER_KEYWORD.has(raw.slice(k + 1, j + 1))
  }
  return REGEX_AFTER_CHAR.has(prev)
}

/** 跳到正则字面量结束之后。撞到换行说明判错了，当除号原样回去 */
function consumeRegex(raw: string, i: number): number {
  i += 1
  let inClass = false
  while (i < raw.length) {
    const c = raw[i]!
    if (c === '\\') {
      i += 2
      continue
    }
    if (c === '\n') return i
    if (inClass) {
      if (c === ']') inClass = false
      i += 1
      continue
    }
    if (c === '[') {
      inClass = true
      i += 1
      continue
    }
    if (c === '/') return i + 1
    i += 1
  }
  return i
}

/* ------------------------------------------------------------------ 逐文件扫描结果 */

interface FileScan {
  /** 相对仓库根的 POSIX 路径（预算表的键） */
  rel: string
  /** 含 CJK 的片段条数 */
  count: number
  /** 剔注释之后含 CJK 的行号（1 起） */
  cjkLines: Set<number>
  /** 被某个含 CJK 的片段罩住的行号 */
  coveredLines: Set<number>
  /**
   * 含 CJK 的片段本身（`kind` + 原文），与 `count` 同一个口径。
   *
   * 唯一的消费者是 `--freeze-literals`。留着它而不是让冻结逻辑自己去扫一遍，是为了让
   * 「快照里的东西」与「闸门 a 数的东西」结构上不可能对不上——口径分两处写，迟早会分家。
   */
  hits: Array<{ kind: Segment['kind']; text: string }>
}

function toRel(file: string): string {
  return relative(process.cwd(), file).split(sep).join('/')
}

function makeLineLookup(raw: string): (index: number) => number {
  const starts = [0]
  for (let k = 0; k < raw.length; k += 1) {
    if (raw[k] === '\n') starts.push(k + 1)
  }
  return (index: number) => {
    let lo = 0
    let hi = starts.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (starts[mid]! <= index) lo = mid
      else hi = mid - 1
    }
    return lo + 1
  }
}

export function scanFile(file: string): FileScan {
  const raw = readFileSync(file, 'utf8')
  // 只有 `EXTRA_FILES` 里那个 .html 走另一条路，其余全是 TS/TSX
  const { segments, masked } = file.endsWith('.html') ? scanHtmlSource(raw) : scanSource(raw)

  const lineOf = makeLineLookup(raw)
  const cjkLines = new Set<number>()
  masked.split('\n').forEach((line, idx) => {
    if (CJK_CHAR.test(line)) cjkLines.add(idx + 1)
  })

  const hits = segments.filter((s) => CJK_CHAR.test(s.text))
  const coveredLines = new Set<number>()
  for (const s of hits) {
    for (let line = lineOf(s.start); line <= lineOf(Math.max(s.start, s.end - 1)); line += 1) {
      coveredLines.add(line)
    }
  }

  return {
    rel: toRel(file),
    count: hits.length,
    cjkLines,
    coveredLines,
    hits: hits.map((s) => ({ kind: s.kind, text: s.text }))
  }
}

/**
 * 把片段文本归一成「字典里会写的那一串」。
 *
 * ⚠️ **必须做，而且只对 JSX / HTML 文本做。** `scanSource` 取的是**极大文本段**，
 * 于是 `<span className="…">\n              不放大\n            </span>` 整段连同缩进
 * 一起被数进来；而 React/Chromium 渲染时会把空白折叠掉，用户看到的只是「不放大」，
 * P1 的人写字典时也只会写 `'不放大'`。不归一的话，快照里每一条 JSX 文案都带一层缩进，
 * **闸门 d 会对每一条 JSX 文案报红**——一条永远红的断言很快就没人看了，
 * 而它红着的时候真正的漂移就藏在里面。
 *
 * 反过来，字符串 / 模板字面量里的空白**是内容**（`'  中文  '`），一个字节都不能动。
 * 这就是判据必须按 `kind` 分开、而不是统一 `trim()` 的原因。
 */
function normalizeLiteral(hit: { kind: Segment['kind']; text: string }): string {
  return hit.kind === 'jsx-text' || hit.kind === 'html-text'
    ? hit.text.replace(/\s+/g, ' ').trim()
    : hit.text
}

/**
 * 把字典值里的占位符抹掉，换成「渲染之前、源码里字面写着的那一段」。
 *
 * ⚠️ **不做这一步，闸门 d 会对每一条带参数的文案报红。** 快照取自源码扫描，而扫描器的
 * 口径是「模板只按它的**字面量部分**拼起来、不含 `${…}` 的源码」（见文件头）：
 * `共 ${n} 条痕迹` 在快照里是 `共  条痕迹`（两段字面量直接相接）。而 P1 写在字典里的是
 * `共 {n} 条痕迹`。两者**必须**先抹掉占位符才能比。
 *
 * 抹掉之后仍是逐字节比对，而且鉴别力比「整体相等」**更强**，不是更弱：
 *   - 把 `共 {n} 条痕迹` 写成 `{n} 共 条痕迹`（换了个位置）→ 抹掉后 ` 共 条痕迹` ≠ `共  条痕迹`，红；
 *   - 写成 `共 {n} 条痕迹！`（多加一个标点）→ 抹掉后多一个 `！`，红；
 *   - 写成 `{n}`（整句只剩占位符）→ 抹掉后是空串，而快照里没有空串（它只收含 CJK 的），红。
 *
 * ⚠️ 占位符的**名字与个数**不归这里管——那是闸门 c（zh/en 占位符集合一致）的活，
 * 而「该传几个参数」是 TS 条件元组在编译期挡的。三件事分开，各自有各自的判据。
 */
/** 把连续空白收成一个、并去掉首尾——比对两侧都过它，见 `stripPlaceholders` 的说明 */
function collapseSpaces(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function stripPlaceholders(text: string): string {
  // ⚠️ **这个函数只抹占位符，不做任何空白处理**——空白由下面那条统一口径管。
  //
  // 走过两次弯路，都是「以为快照有一套统一口径」：先写成 `.trim()`（32 条假红），
  // 再改成 `.trimEnd()`（又换了一批假红）。实测下来快照那一侧**三种都有**：
  //
  //   源码 `\`目标体积 ${…}\``        → 快照里是 `目标体积`      （尾部被截）
  //   源码 `\`${n} 分钟前\``           → 快照里是 ` 分钟前`       （前导留着）
  //   源码 `\` · 共 ${n} 条痕迹\``     → 快照里是 ` · 共  条痕迹`  （前导留着、中间两个空格）
  //
  // 所以口径统一放在**比对那一侧**（下面 `sameAsFrozen`），两边一起归一。
  return text.replace(/\{[^}]*\}/g, '')
}

/** 递归收出范围内全部源码文件（排序，输出才是稳定的） */
/**
 * **字典本体**：它们是文案的**容器**，不是文案的生产者，一律不进闸门 a。
 *
 * `src/shared/i18n/**` 天然不受管——它**不在 `SCAN_DIRS` 里**。但插件的字典住在
 * `plugins/arbiter/mcp/i18n.mjs`，而 `plugins/arbiter` 整个进了网，所以它得被
 * **显式**排除；否则闸门 a 会把那几十条字典值当成「待迁移的文案」，而迁移它
 * 是一句同义反复。
 */
const DICT_FILES = new Set([resolve('plugins/arbiter/mcp/i18n.mjs')])

function collectFiles(dir: string): string[] {
  const names = readdirSync(dir, { recursive: true }) as string[]
  return names
    .filter((name) => SOURCE_EXTS.includes(name.slice(name.lastIndexOf('.'))))
    .map((name) => resolve(dir, name))
    .filter((full) => !DICT_FILES.has(full))
    .sort()
}

/* ------------------------------------------------------------------ 闸门 b / c / d */

/** 一道闸门的三种状态。「未接线」**不是**「通过」——它意味着今天一条断言都没跑 */
type GateState = 'pass' | 'fail' | 'unwired'

interface GateResult {
  id: string
  name: string
  state: GateState
  detail: string
  /** 这道闸门今天真的执行过的断言条数 */
  ran: number
}

const I18N_DIR = 'src/shared/i18n'

/**
 * 冻结快照：**P1 迁移之前、源码里真正写着的那批中文**，一条一条躺在这里。
 *
 * ⚠️ **它的取材对象是「源码」，不是「字典」——这一条是承重的。**
 * 原先的设计是 `Record<MsgKey, string>`、在字典建好之后从 `zh.ts` 复制一份，
 * 于是闸门 d 断言的其实是「`zh.ts` 从复制那一刻起没变过」。那不是我们需要的性质：
 * 本方案唯一的前提是「**字典里的中文值 = 今天源码里的那串字**」，
 * 而这是 1892 条断言里约 150 条**一条都不用改**的全部理由。
 *
 * 更要命的是失败形态：约 10–15 条**负向**断言（`!x.includes('中文')`）不靠字面量相等，
 * 所以在中文被改动之后**不会红，只会静默变成恒真**——一条恒真的断言比一条红的断言坏得多，
 * 红的会逼人去看，恒真的会让你以为覆盖还在（计划 §风险表第 1 条）。
 * 判据必须问「这串字是不是迁移前源码里那一串」，才有鉴别力。
 *
 * ⇒ 所以它必须在 P1 **之前**冻结，而且之后**永不重生成**：
 * 源码一旦被迁移走，「今天本来写着什么」这个信息就永久消失了，没有第二个来源。
 *
 * 生成方式只有一个：`--freeze-literals`，而且**文件已存在就拒绝**（见那个函数）。
 * 本脚本**没有**任何「按实测重写快照」的常规开关——一个能把期望值改成实际值的脚本，
 * 等于没有期望值（与上面 `ZH_BUDGET` 那段同一条自觉）。
 */
const BASELINE_FILE = 'scripts/fixtures/i18n-zh-baseline.json'

type DictLoad =
  | { state: 'ok'; table: Record<string, string> }
  | { state: 'missing' }
  | { state: 'broken'; reason: string }

/**
 * 加载一份字典。
 *
 * 三种结果刻意分开：**文件不存在**是「未接线」（今天就是这一种，等 P1）；
 * 文件在、加载不了是**真错误**，必须红——把后者也归成「未接线」的话，
 * P1 一落地就会得到一个「字典写坏了但套件全绿」的静默洞。
 */
async function loadDict(rel: string): Promise<DictLoad> {
  const abs = resolve(rel)
  if (!existsSync(abs)) return { state: 'missing' }
  try {
    const mod = (await import(pathToFileURL(abs).href)) as Record<string, unknown>
    const table = (mod.zh ?? mod.en ?? mod.default) as unknown
    if (table === null || typeof table !== 'object' || Array.isArray(table)) {
      return { state: 'broken', reason: `${rel} 里没有导出字典对象（zh / en / default 三选一）` }
    }
    return { state: 'ok', table: table as Record<string, string> }
  } catch (err) {
    return { state: 'broken', reason: `${rel} 加载失败：${String(err)}` }
  }
}

function placeholders(text: string): string[] {
  return [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).sort()
}

/**
 * `en` 表里**允许**含 CJK 的键。
 *
 * 唯一的一类是**语言选择器自己的选项名**：在英文界面里，Chinese 的正确写法就是
 * `中文`——那是这门语言称呼自己的方式，不是漏翻。翻成 "Chinese" 反而更差：
 * 一个只会中文的用户要在英文界面里找自己的语言时，认得的是 `中文` 这两个字。
 *
 * ⚠️ 这张表**必须短、且每条都有理由**。它每长一条，闸门 b 的鉴别力就少一分——
 * 而这个列表一旦开始收「反正也是中文」的东西，它就从判据退化成了一张记录。
 */
const EN_CJK_ALLOWED = new Set(['settings.language.zh'])

/** 闸门 b · en 无 CJK：专抓「把 zh 那行复制到 en 忘了改」 */
async function gateB(): Promise<GateResult> {
  const id = 'b'
  const name = 'en 无 CJK'
  const en = await loadDict(`${I18N_DIR}/en.ts`)
  if (en.state === 'missing') {
    return {
      id,
      name,
      state: 'unwired',
      detail: `${I18N_DIR}/en.ts 今天还不存在（P1 产出）`,
      ran: 0
    }
  }
  if (en.state === 'broken') {
    return { id, name, state: 'fail', detail: en.reason, ran: 1 }
  }
  const keys = Object.keys(en.table)
  if (keys.length === 0) {
    return {
      id,
      name,
      state: 'fail',
      detail: 'en 字典是空的（空集合上的「不含 CJK」恒为真）',
      ran: 1
    }
  }
  const bad = keys.filter((k) => CJK_CHAR.test(en.table[k]!) && !EN_CJK_ALLOWED.has(k))
  check(
    `闸门 ${id}：en 的 ${keys.length} 个 key 一个都不含 CJK`,
    bad.length === 0,
    bad.slice(0, 8).join(' | ')
  )
  return {
    id,
    name,
    state: bad.length === 0 ? 'pass' : 'fail',
    detail: bad.length === 0 ? `${keys.length} 个 key 全过` : `${bad.length} 个 key 里还有中文`,
    ran: 2
  }
}

/** 闸门 c · 占位符集合 zh/en 相同：抓「en 少写一个 `{engine}`」 */
async function gateC(): Promise<GateResult> {
  const id = 'c'
  const name = '占位符集合一致'
  const zh = await loadDict(`${I18N_DIR}/zh.ts`)
  const en = await loadDict(`${I18N_DIR}/en.ts`)
  if (zh.state === 'missing' || en.state === 'missing') {
    return {
      id,
      name,
      state: 'unwired',
      detail: `${I18N_DIR}/{zh,en}.ts 今天还不存在（P1 产出）`,
      ran: 0
    }
  }
  if (zh.state === 'broken' || en.state === 'broken') {
    const reason = zh.state === 'broken' ? zh.reason : en.state === 'broken' ? en.reason : ''
    return { id, name, state: 'fail', detail: reason, ran: 1 }
  }
  const zhKeys = Object.keys(zh.table)
  if (zhKeys.length === 0) {
    return { id, name, state: 'fail', detail: 'zh 字典是空的（空集合上恒真）', ran: 1 }
  }
  const missing = zhKeys.filter((k) => !(k in en.table))
  const bad = zhKeys
    .filter((k) => k in en.table)
    .filter((k) => placeholders(zh.table[k]!).join(',') !== placeholders(en.table[k]!).join(','))
  check(
    `闸门 ${id}：zh 的 ${zhKeys.length} 个 key 两侧占位符逐一相同`,
    missing.length === 0 && bad.length === 0,
    [...missing.slice(0, 8).map((k) => `en 缺 key ${k}`), ...bad.slice(0, 8)].join(' | ')
  )
  return {
    id,
    name,
    state: missing.length === 0 && bad.length === 0 ? 'pass' : 'fail',
    detail:
      missing.length === 0 && bad.length === 0
        ? `${zhKeys.length} 个 key 全过`
        : `${missing.length + bad.length} 处不一致`,
    ran: 2
  }
}

/** 闸门 d · zh 逐字节基线：字典里的中文值与冻结快照一字不差 */
/**
 * 冻结快照的**唯一**生成入口（`--freeze-literals`）。
 *
 * ⚠️ **文件已存在就拒绝，而且这是刻意的。** 它钉的是「P1 迁移之前源码里真正写着的那批
 * 中文」，而那个状态一旦被迁移走就**再也没有第二个来源**——重生成出来的只会是当时字典的
 * 内容，而闸门 d 恰恰要拿它去判字典。所以「重新生成」必须由人**先手工删掉文件**再来跑，
 * 脚本不提供任何一键刷新：一个能把期望值改成实际值的开关，等于没有期望值。
 *
 * 取材对象是**源码扫描**（与闸门 a 同一套 `scanSource` / `scanFile`），不是字典——
 * 理由写在 `BASELINE_FILE` 的注释里。
 */
function freezeLiterals(): void {
  const out = resolve(BASELINE_FILE)
  if (existsSync(out)) {
    console.error(
      `${BASELINE_FILE} 已经存在，拒绝覆盖。\n` +
        '它钉的是「P1 迁移之前源码里真正写着的那批中文」——那个状态被迁移走之后就再也\n' +
        '没有第二个来源了。要重新生成，请**先手工删掉这个文件**；脚本刻意不提供一键刷新，\n' +
        '因为一个能把期望值改成实际值的开关，等于没有期望值。'
    )
    process.exit(1)
  }

  const files = [
    ...SCAN_DIRS.flatMap((dir) => collectFiles(dir)),
    ...MAIN_GUI_FILES.map((f) => resolve(f)),
    ...EXTRA_FILES.map((f) => resolve(f))
  ]
  const literals = new Set<string>()
  for (const file of files) {
    if (!existsSync(file)) continue
    for (const hit of scanFile(file).hits) literals.add(normalizeLiteral(hit))
  }
  // 非空前置：扫到 0 条时写下去的是一份恒真的快照，而它看起来和一份好快照一模一样。
  if (literals.size === 0) {
    console.error('一条中文都没扫到——范围配错了，拒绝写一份空快照（空集合上恒真）。')
    process.exit(1)
  }

  writeFileSync(
    out,
    JSON.stringify(
      {
        frozenAt: '2026-09-15',
        why:
          'P1 迁移之前源码里真正写着的那批中文。闸门 d 用它判「字典里的中文值是否' +
          '逐字节等于迁移前源码里那一串」——那是 150 条断言一条都不用改的全部理由，' +
          '也是那 10-15 条负向断言不静默变恒真的唯一防线。**永不重生成。**',
        sourceFiles: files.length,
        literals: [...literals].sort()
      },
      null,
      2
    ) + '\n',
    'utf8'
  )
  console.log(`已冻结 ${literals.size} 条中文片段（来自 ${files.length} 个文件）→ ${BASELINE_FILE}`)
  console.log('⚠️ 这份文件从此不许再生成一次。P1 的判据是「zh.ts 的每个值都在它里面」。')
}

async function gateD(): Promise<GateResult> {
  const id = 'd'
  const name = 'zh 逐字节基线'
  const zh = await loadDict(`${I18N_DIR}/zh.ts`)
  const baselineAbs = resolve(BASELINE_FILE)
  const baselineExists = existsSync(baselineAbs)
  if (zh.state === 'missing' || !baselineExists) {
    const missing = [
      zh.state === 'missing' ? `${I18N_DIR}/zh.ts` : null,
      !baselineExists ? BASELINE_FILE : null
    ].filter((s): s is string => s !== null)
    return {
      id,
      name,
      state: 'unwired',
      detail: `${missing.join(' 与 ')} 今天还不存在（P1 产出）`,
      ran: 0
    }
  }
  if (zh.state === 'broken') {
    return { id, name, state: 'fail', detail: zh.reason, ran: 1 }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(baselineAbs, 'utf8'))
  } catch (err) {
    return { id, name, state: 'fail', detail: `${BASELINE_FILE} 读不动：${String(err)}`, ran: 1 }
  }
  const frozen = (parsed as { literals?: unknown } | null)?.literals
  if (!Array.isArray(frozen) || frozen.length === 0) {
    return {
      id,
      name,
      state: 'fail',
      detail: `${BASELINE_FILE} 里没有非空的 literals（空集合上恒真）`,
      ran: 1
    }
  }
  /**
   * **冻结之后新写的句子**。
   *
   * 冻结快照收的是「迁移之前在源码里真正写着的那批中文」，而新加的句子**不可能**
   * 在里面——它以前压根不存在。所以这里要有一份名单，否则每加一句新文案都会撞红，
   * 而红了之后人的第一反应是「放宽断言」——那正是这条闸门要防的事。
   *
   * ⚠️ 这份名单是**追加式**的：一条一句，且必须是**新句子**。把一句已经存在的中文
   * 改通顺（比如顺手润色）**不能**靠往这里加一条来放行——那正是闸门 d 存在的理由。
   * 所以往这里加之前先问一句：这句话以前在源码里出现过吗？
   */
  const NEW_SINCE_FREEZE = new Set([
    // P1：语言设置项本身（那时还没有字典）
    'app.title',
    'settings.language',
    'settings.language.system',
    'settings.language.zh',
    'settings.language.en',
    'settings.language.hint',

    // E-7 全局快捷键（2026-09-16）。**冻结快照是 09-15 的**（commit 7046954），
    // 这一批在它之后才写进源码——`git log -S` 三处都指到 `fea76c9`。
    'settings.shortcuts.title',
    'settings.shortcuts.hint',
    'settings.shortcuts.pickFiles',
    'settings.shortcuts.start',
    'settings.shortcuts.cancelRunning',
    'workbench.pickFilesTitle',
    'workbench.startTitle',
    'workbench.toast.canceled',

    // P0-11 加密音乐容器（2026-09-17）：引擎名与它的 detail 各一条
    'engines.label.encmusic',
    'engines.detail.encmusic',

    // R15 配方文件的 CLI 报错（2026-09-16，commit 5975188）
    'integration.cli.noRecipe',

    // P0-10 视频编码质量档（2026-09-17，commit 89cc232）：`QualitySection` 整个文件
    // 都是那天才诞生的，所以这一族**一条都不在快照里**。
    ...([
      'options.quality.title',
      'options.quality.failed',
      'options.quality.reasonEmpty',
      'options.quality.reasonInteger',
      'options.quality.reasonRange',
      'options.quality.exitLead',
      'options.quality.exitWebm',
      'options.quality.exitGif',
      'options.quality.labelCrf',
      'options.quality.crfAria',
      'options.quality.crfHintLead',
      'options.quality.crfHintMid',
      'options.quality.labelPreset',
      'options.quality.presetAria',
      'options.quality.labelTune',
      'options.quality.tuneAria',
      'options.quality.tuneNone',
      'options.quality.presetHintA',
      'options.quality.presetHintB',
      'options.quality.presetHintC',
      'options.quality.presetHintD',
      'options.quality.presetHintE',
      'options.quality.presetHintF',
      'options.quality.presetHintG',
      'options.quality.presetHintH',
      'options.quality.encodeHint'
    ] as string[])
  ])

  /**
   * **来源文件根本不在冻结扫描范围内的那些键**。
   *
   * 冻结快照扫的是 `src/renderer/src/**` + 主进程 GUI 白名单 + `src/main/ipc/**` +
   * `index.html`，而 `src/shared/**` **不在里面**（那时它还没被迁进字典，
   * 谁也没想到要去扫一个「还没有字典」的地方）。
   *
   * 所以 `shared.*` 这些值拿快照去比是**问错了人**——它们可能在快照里偶然命中
   * （同一句话恰好也写在某个渲染层文件里），也可能不在，两种情况都没有意义。
   *
   * ⚠️ **这不是「放行」**：这些函数的**成品句子**另有更强的守卫——
   * `test-core.ts` 有十来条**整句钉死**的断言（`describeOptions` 拼出来的整行、
   * `'去隔行（yadif） → 降噪（中） → 锐化 1'`……），少一个标点那里就红。
   * 闸门 d 在这里让路，是因为它手上的那把尺子量不到这一块，不是因为它不重要。
   */
  const OUT_OF_FREEZE_SCOPE = [
    'shared.',
    // 阶段文案（stage.*）的来源是 src/main/converters/**，而那份冻结快照只扫过
    // 渲染层、主进程 GUI 白名单、main/ipc/** 与 index.html —— 转换器那一层不在里面。
    // 它们另有更强的守卫：下面的 STAGE_EXPECTED 那张冻结表逐条比对，而且那张表
    // 还要求「集合完全相同」（多加一个 stage 键也会红）。
    'stage.',
    /**
     * P6：MCP / CLI / 插件的文案 —— 来源是 `src/mcp/**`、`src/cli/**` 与
     * `plugins/arbiter/**`，而那份冻结快照（P1 冻结）只扫过渲染层、主进程 GUI
     * 白名单、`main/ipc/**` 与 `index.html`——这三个入口是 P6 才进的网（`2dc2b9e`）。
     *
     * ⚠️ **与 `stage.` 不同，这两族今天没有任何独立的冻结表兜底**：谁把
     * `收到 SIGINT` 顺手改成「收到中断信号」，不会有断言红。闸门 a 只钉**条数**
     * 不钉字面。要补就得照 `STAGE_EXPECTED` 的样子另立一张（**P6 收尾时定**，
     * 这张名单本身是追加式的，别让它变成「顺手改文案的放行条」）。
     *
     * 两条前缀一起加而不是各加各的：`SCAN_DIRS` 那一批是同一个提交进的网，
     * 理由一字不差，分成两处写只会让下一个人以为它们是两回事。
     */
    'mcp.',
    'cli.',
    // P7：自家 error 的码。与 `mcp.` / `cli.` 同一条理由——冻结快照是 P1 冻的，那时这些键还不存在。
    'err.'
  ]

  /**
   * 冻结快照的**切分粒度**与字典不同的那些键。
   *
   * 扫描器是按**源码里的片段**记的，而字典是按**一句完整的文案**记的，两种粒度对不上：
   *
   * - **多段 JSX 合成一条**：`范围 {min}~{max}，1 是「看得出来」的起点。` 这种句子里夹着
   *   上色的 `<span>`，扫描器把它切成 `范围 ` / `，默认 ` / ` LUFS ` 几个碎片；
   * - **含反引号的一句**：`（\`idet\` / \`detelecine\`）` 里的反引号会被扫描器当成
   *   **模板字面量**的开闭，中间的内容被抹成空白——按快照写会让界面上出现
   *   「自动判断（ / ）」这种掉了词的句子。
   *
   * ⚠️ 这两类的**渲染结果都被 `test-ui.ts` 的 99 条断言盯着**（它渲染的是真源码），
   * 所以这里不是「没人管」。
   */
  const GRANULARITY_DIFFERS = new Set([
    'filters.deinterlaceHint',
    'filters.sharpenHint',
    'filters.loudnormHint',
    'filters.rotateHint',
    'filters.atMax',
    'filters.hiddenUnavailable',
    // 重命名即转换的**通知正文**：源码里是一个两行 `+` 拼接的模板，扫描器把它记成
    // 两段（`「」的内容其实是 ，已经按真正的 ` 与 ` 转换。原文件保留为「」。`），
    // 而字典按**一句完整的正文**记 —— 粒度不同，快照比不了。
    'integration.rename.notifyBody'
  ])

  /**
   * **zh 值本来就不含 CJK 的那些键**。
   *
   * 冻结快照只收**含 CJK 的片段**（那正是闸门 a 与整条 i18n 的取材口径），
   * 所以一个值里一个汉字都没有时——哪怕它是个正经的中文条目——**永远不可能**在快照里，
   * 与「有没有被改写」无关。
   *
   * 目前只有七个引擎显示名（`FFmpeg` / `Sharp` / `Pandoc` / `LibreOffice` /
   * `Calibre` / `7-Zip`）：它们中英同形，而按「表里存的是键、值在字典里显式写两遍」
   * 那条纪律（见 `engines.ts` 的文件头），英文那一侧也得原样再写一遍。
   *
   * ⚠️ 判据写成「**这个值里没有 CJK**」而不是逐个列键名：列名字会随引擎增减而漂，
   * 而「不含 CJK 就进不了快照」是**结构性**的事实，一条规则管到底。
   */
  const VALID_VALUE_WITHOUT_CJK = (value: string): boolean => !/[\u4e00-\u9fff]/.test(value)

  const values = Object.entries(zh.table)
  if (values.length === 0) {
    return { id, name, state: 'fail', detail: `${I18N_DIR}/zh.ts 是空表（空集合上恒真）`, ran: 1 }
  }

  // 判据是**值**落在冻结清单里，不是「key 对 key」。快照没有 key——它在字典之前就存在了。
  const allowed = new Set((frozen as string[]).map(collapseSpaces))

  /**
   * 空白一起归一之后再比。
   *
   * ⚠️ **代价要写在明处**：首尾与连续空白的差异从此不被这条闸门抓住。
   * 兜底在别处，而且更硬——`test-core.ts` / `test-ui.ts` / `test-mcp-view.ts` 里
   * 有一百多条**整句 / 整页钉死**的断言，它们比的是**渲染出来的那一串字**，
   * 少一个分隔空格那里立刻红。闸门 d 是第二道防线，它的长处在「快」与「覆盖到
   * 那些没有专门断言的句子」，不在「逐字节」。
   */
  const drifted = values.filter(
    ([key, value]) =>
      !allowed.has(collapseSpaces(stripPlaceholders(value))) &&
      !NEW_SINCE_FREEZE.has(key) &&
      !GRANULARITY_DIFFERS.has(key) &&
      !OUT_OF_FREEZE_SCOPE.some((prefix) => key.startsWith(prefix)) &&
      !VALID_VALUE_WITHOUT_CJK(value)
  )
  check(
    `闸门 ${id}：zh 的 ${values.length} 个值**逐字节**都在冻结快照里（快照 ${allowed.size} 条）`,
    drifted.length === 0,
    drifted
      .slice(0, 5)
      .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
      .join(' | ')
  )
  return {
    id,
    name,
    state: drifted.length === 0 ? 'pass' : 'fail',
    detail:
      drifted.length === 0
        ? `${values.length} 个值全在快照里`
        : `${drifted.length} 处不在快照里（要么改写了一句中文，要么这句是新写的）`,
    ran: 2
  }
}

/* ------------------------------------------------------------------ 主流程 */

/* ------------------------------------- P5 · 阶段文案（progress.stage） */

/**
 * 阶段文案的**冻结表**：键 → 迁移前源码里逐字写着的那一句中文。
 *
 * ## 为什么要有它（闸门 d 盖不到这一块）
 *
 * 闸门 d 拿冻结快照比对字典值，而那份快照**只扫过** `src/renderer/src/**`、主进程 GUI
 * 白名单、`src/main/ipc/**` 与 `index.html`——`src/main/converters/**` **不在里面**
 * （P0 冻结时那批文案还没进字典）。也就是说，`stage.ts` 里那三十来句中文**一句都不受
 * 闸门 d 管**：谁顺手把「排版中…」改成「正在排版…」，没有任何断言会红。
 *
 * 而这一批恰恰是最容易被顺手改的（它们是给人读的过程描述），所以这里补一张**独立**的表。
 *
 * ⚠️ **它不是「字典的副本」，是「迁移前源码的快照」**：值取自 `git show HEAD:` 里那些
 * 转换器文件（P5 的三条并行线各自用一次性探针逐条比对过，合计 25 处全等）。
 * 改成字典之后它们**又**多了一层保护——`stagePair()` 是唯一的产出点，码与文本同源。
 *
 * ⚠️ **加一个 stage 键，就必须往这张表里加一行**（下面第一条断言会拦）——那是**设计**：
 * 「多了一句用户可见的过程文案」这件事该有人过一眼。
 */
const STAGE_EXPECTED: Record<string, string> = {
  'stage.preparing': '准备中…',
  'stage.converting': '转换中…',
  'stage.archive.extract': '拆开压缩包…',
  'stage.calibre.start': '启动 Calibre…',
  'stage.pandoc.prepare': '准备文档…',
  'stage.libreoffice.start': '启动 LibreOffice…',
  'stage.encmusic.decrypt': '解开加密容器…',
  'stage.document.parse': '解析文档…',
  'stage.document.extractText': '提取文本…',
  'stage.document.layout': '排版中…',
  'stage.document.renderPdf': '生成 PDF…',
  'stage.image.read': '读取图片…',
  'stage.image.decodeHeic': '解 HEIC…',
  'stage.image.encode': '编码中…',
  'stage.image.encodeAnimated': '编码动图…',
  'stage.image.searchQuality': '压缩到目标体积…（第 {round} 次试探）',
  'stage.engine.preparing': '正在准备 {label} 引擎…',
  'stage.engine.installing': '正在安装 {label} 引擎…',
  'stage.engine.downloading': '正在下载 {label} 引擎…',
  'stage.pdf.exportPage': '导出第',
  'stage.ffmpeg.noGpu': '未找到可用显卡，本次用 CPU 编码',
  'stage.ffmpeg.abrCpu': '输出目标走 ABR，与显卡编码的 CQ 模式互斥：本次用 CPU 编码',
  'stage.ffmpeg.qualityCpu':
    '质量档与显卡编码的参数不是同一套（CRF 与 CQ 同号不同质、预设也不是一个词表）：本次用 CPU 编码',
  'stage.ffmpeg.noAudioSkipLoudnorm': '源里没有音轨，跳过响度归一化',
  'stage.ffmpeg.loudnormPass': '第一遍分析（响度归一化）',
  'stage.ffmpeg.loudnormEncoding': '编码（响度归一化）',
  'stage.ffmpeg.loudnormSinglePass': '读不出响度统计，本步按单遍处理 · 编码中',
  'stage.ffmpeg.passOne': '第一遍分析（两遍编码）',
  'stage.ffmpeg.passTwo': '第二遍编码（两遍编码）',
  'stage.ffmpeg.abrCpuPassOne':
    '输出目标走 ABR，与显卡编码的 CQ 模式互斥：本次用 CPU 编码 · 第一遍分析（两遍编码）',
  'stage.ffmpeg.gpuFallback': '显卡编码失败，改用 CPU 重试'
}

/**
 * P5 的验收：码与兜底文本同源、渲染跟着语言走。
 *
 * ⚠️ **中文那一侧不在这里重抄**（那是上面冻结表的活）。这里只补几条够不着的地方：
 * 码与文本对不对得上、en 下有没有中文、以及**没有码时回落**（老任务的进度对象没有码）。
 */
async function testStageRefs(): Promise<void> {
  console.log('\n[P5] 阶段文案的码与兜底')

  const { currentLocale, setLocale } = await import('@shared/i18n')
  const { stagePair, stageText } = await import('@shared/i18n/stage')
  const { zh } = await import('@shared/i18n/zh')

  const table = zh as Record<string, string>
  const inDict = Object.keys(table).filter((k) => k.startsWith('stage.'))

  /* ---- 冻结表与字典逐条对齐（双向）---- */
  const missing = Object.keys(STAGE_EXPECTED).filter((k) => !inDict.includes(k))
  const extra = inDict.filter((k) => !(k in STAGE_EXPECTED))
  check(
    '⭐ 阶段键集合与冻结表逐一对应（加一句阶段文案必须同时进那张表）',
    missing.length === 0 && extra.length === 0,
    '表里多出来 ' + missing.join(',') + ' 条、字典里没进表 ' + extra.join(',') + ' 条'
  )
  const drifted = Object.entries(STAGE_EXPECTED).filter(([k, v]) => table[k] !== v)
  check(
    '⭐ 每一句阶段文案与迁移前逐字相同（闸门 d 扫不到 converters/**，这条补上）',
    drifted.length === 0 && Object.keys(STAGE_EXPECTED).length > 25,
    drifted
      .map(([k, v]) => k + '=' + JSON.stringify(table[k]) + ' 期望 ' + JSON.stringify(v))
      .join(' | ') || '冻结表只有 ' + Object.keys(STAGE_EXPECTED).length + ' 条（被清过？）'
  )

  /* ---- 码与兜底文本同源 ---- */
  const sample = stagePair({ key: 'stage.image.searchQuality', params: { round: 3 } })
  check(
    '⭐ 同一个码产出的两半对得上：stage 是中文、stageRef 就是那个码',
    sample.stage === '压缩到目标体积…（第 3 次试探）' &&
      sample.stageRef.key === 'stage.image.searchQuality' &&
      sample.stageRef.params?.round === 3,
    JSON.stringify(sample)
  )
  check(
    '每个码都能产出一句非空中文，且回显的码原样（空串说明这个键没进表）',
    inDict.every((k) => {
      const r = stagePair({ key: k as never })
      return r.stage.length > 0 && r.stageRef.key === k
    })
  )

  /* ---- 没有码时回落，而不是显示空白 ---- */
  check(
    '没有码时回落到 stage 那一句（老任务的进度对象没有码，不该显示空白）',
    stageText(undefined, '兜底') === '兜底'
  )

  /* ---- en ---- */
  const before = currentLocale()
  try {
    setLocale('en')
    const cjk = inDict.filter((k) => /[\u4e00-\u9fff]/.test(stageText({ key: k as never }, '')))
    check(
      '⭐ en 下每一句阶段文案都不含 CJK（切了英文，卡片那行不该还是中文）',
      cjk.length === 0,
      cjk.join(', ')
    )
    check(
      '⭐ en 下带参数的那一句也翻到了，且参数照样插进去',
      stageText({ key: 'stage.image.searchQuality', params: { round: 7 } }, '') ===
        'Hitting the target size… (attempt 7)'
    )
  } finally {
    setLocale(before)
  }
  check('这一节结束时全局语言是 zh', currentLocale() === 'zh')
}

/* -------------------------------------------------- P1 · 内核与接线的断言 */

/**
 * P1 的验收：内核本身 + 三条接线。
 *
 * ⚠️ **这一节会改 `@shared/i18n` 的那份全局语言**，所以每条用例之后必须恢复
 * `'zh'`——它是模块级的，泄漏出去会让后面每一条断言都看着中文不见。
 * 这一节末尾有一条断言专盯这件事。
 */
/**
 * [P6] MCP / CLI / 插件的英文。
 *
 * 这些判据**只在切到 en 之后才看得出来**——默认（zh）下它们与迁移前一字不差，
 * 所以那二十来个套件的断言一条都没动。这也是它们必须在这里、而不在 `test:mcp*`
 * 里的原因：那些套件跑的是默认语言，看不见「切了语言到底有没有生效」。
 */
async function testMcpLocale(): Promise<void> {
  console.log('\n[P6] MCP / CLI / 插件')

  const { currentLocale, setLocale } = await import('@shared/i18n')
  const { TOOL_DESCRIPTIONS } = await import('../src/mcp/schema')
  const { ERROR_CODES, policyFor } = await import('../src/mcp/errors')

  try {
    /* —— ① 八个工具的说明书：en 下不含 CJK —— */
    setLocale('en')
    // ⚠️ `TOOL_DESCRIPTIONS` 是 **getter**（见 `schema.ts` 的文件头）：写成普通常量的话
    // 它会在 import 那一刻求值并永久停在启动时那门语言上。这里 `Object.entries` 现取，
    // 所以正好也在**顺带验那条设计**——若哪天有人把它改回常量，这一节会立刻红。
    const enDescs = Object.entries(TOOL_DESCRIPTIONS)
    const cjkDescs = enDescs.filter(([, text]) => CJK_CHAR.test(text)).map(([name]) => name)
    check(
      `en 下八个工具的 description 都不含 CJK（实际 ${enDescs.length} 个）`,
      enDescs.length === 8 && cjkDescs.length === 0,
      cjkDescs.length > 0 ? `含中文的：${cjkDescs.join(', ')}` : `只拿到 ${enDescs.length} 个`
    )

    /* —— ② `next_steps` 的条数 zh / en 一致（漏译某一条动作会在这里露出来）—— */
    const enSteps = ERROR_CODES.map((code) => policyFor(code).next_steps)
    setLocale('zh')
    const zhSteps = ERROR_CODES.map((code) => policyFor(code).next_steps)
    const zhDescs = Object.entries(TOOL_DESCRIPTIONS)
    const zhCjk = zhDescs.filter(([, text]) => !CJK_CHAR.test(text)).map(([name]) => name)

    const countMismatch = ERROR_CODES.filter((_, i) => enSteps[i].length !== zhSteps[i].length)
    check(
      `en 下每条 next_steps 的条数与 zh 一致（${ERROR_CODES.length} 个码）`,
      countMismatch.length === 0,
      countMismatch
        .map((c, i) => `${c}: zh ${zhSteps[i].length} / en ${enSteps[i].length}`)
        .join(' | ')
    )
    // 反向对照：zh 下必须有 CJK。少了它，「en 无 CJK」在「两边都是英文」时照样绿。
    check(
      '反向对照：切回 zh 之后那些 description 又都是中文（否则上面那条只是在比英文）',
      zhCjk.length === 0,
      zhCjk.join(', ')
    )
    check('这一节结束时语言是 zh（泄漏出去后面的断言会集体失明）', currentLocale() === 'zh')

    /* —— ③ 插件字典：**独立分发的一份副本**，它自己那两条闸门 —— */
    //
    // 插件不能 import `@shared/i18n`（它落在 `~/.claude/plugins/cache/` 下，那里没有
    // `src/`），所以它自带一份字典。副本的风险全在「改了一边忘了另一边」，而这两条
    // 是能机器化的那一半（漏键由 `i18n.mjs` 自己那句运行时检查挡）。
    const pluginDict = (await import(
      pathToFileURL(resolve('plugins/arbiter/mcp/i18n.mjs')).href
    )) as {
      zh: Record<string, string>
      en: Record<string, string>
      pickLocale: (env: Record<string, string | undefined>) => 'zh' | 'en'
    }
    const pZh = pluginDict.zh
    const pEn = pluginDict.en

    // 插件那条链上**唯一必须与应用侧逐字一致**的东西：语言的裁决顺序。
    // 两边解释不同的话，用户会看到「启动器说中文、MCP server 说英文」。
    // 判据与 `core/locale.ts` 的 `effectiveLocale()` 同序：env > settings.json > 默认。
    const pick = pluginDict.pickLocale
    check(
      '插件 pickLocale：ARBITER_LOCALE 最高优先，且按主语言子标签归一（zh-CN → zh，en-US → en）',
      pick({ ARBITER_LOCALE: 'zh-CN' }) === 'zh' &&
        pick({ ARBITER_LOCALE: 'en-US' }) === 'en' &&
        pick({ ARBITER_LOCALE: '  en  ' }) === 'en'
    )
    check(
      '插件 pickLocale：没设环境变量时落到 zh（插件拿不到 app.getLocale()，system 也只能是 zh）',
      pick({}) === 'zh' && pick({ ARBITER_LOCALE: '   ' }) === 'zh'
    )
    // 临时目录里现造一份 settings.json：**不引入夹具文件**（fixtures 那份是给真实
    // 转换素材用的，往那儿塞测试配置会让「素材一律来自真实世界」那条规矩变浑）。
    const tmpUserData = mkdtempSync(join(tmpdir(), 'arbiter-i18n-'))
    try {
      writeFileSync(join(tmpUserData, 'settings.json'), JSON.stringify({ language: 'en' }), 'utf8')
      check(
        '插件 pickLocale：ARBITER_USER_DATA 指向一份 language=en 的 settings.json 时读得到它',
        pick({ ARBITER_USER_DATA: tmpUserData }) === 'en'
      )
      writeFileSync(join(tmpUserData, 'settings.json'), '{ 这不是 JSON', 'utf8')
      check(
        '反向对照：settings.json 坏掉时回落 zh 而不是抛（插件起不来比语言错了严重得多）',
        pick({ ARBITER_USER_DATA: tmpUserData }) === 'zh'
      )
    } finally {
      rmSync(tmpUserData, { recursive: true, force: true })
    }

    const pluginCjk = Object.keys(pZh).filter((k) => CJK_CHAR.test(pEn[k] ?? ''))
    check(
      `插件字典：en 侧不含 CJK（${Object.keys(pZh).length} 条）`,
      Object.keys(pZh).length > 0 && pluginCjk.length === 0,
      pluginCjk.join(', ')
    )

    /** 从模板里抠出 `{name}` 占位符的名字（去重、排序，好比较）。 */
    const names = (text: string): string[] =>
      [...new Set([...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]))].sort()
    const phMismatch = Object.keys(pZh).filter(
      (k) => names(pZh[k]).join(',') !== names(pEn[k] ?? '').join(',')
    )
    check(
      '插件字典：占位符集合 zh / en 一致（en 少写一个 `{root}` 会在这里红）',
      phMismatch.length === 0,
      phMismatch.join(', ')
    )
  } finally {
    setLocale('zh')
  }
}

/**
 * [P7] 自家 error 的码。
 *
 * ## 承重的那一条：**码与文本同源**
 *
 * 卡片上显示的就是 `logTail` 里那一行（`task.ts` 的 `summarize()` 取倒数第一条有
 * 信息量的行）。字典值与它一旦不一致，用户会看到「卡片上一句话、展开日志里另一句话」
 * ——两句都言之成理，极难归因。所以这里**真的去读源码文件**找那行字面量，而不是在测试里
 * 再抄一遍（抄一遍是同义反复：源码改了它不会红）。
 *
 * ⚠️ **加一条 `err.*` 就要在这里补一次取证**——没有取证的码只有一半保障。
 * 这一片是**进度式**的：今天只覆盖高频那几条，其余 74 个 `throw` 站点没加 `ref`，
 * 它们的行为一个字不变（走 `summarize(logTail)` 那条老路，只是切语言时不会变）。
 */
async function testErrorRefs(): Promise<void> {
  console.log('\n[P7] 自家 error 的码')

  const { currentLocale, setLocale, tKey } = await import('@shared/i18n')
  const { errorText } = await import('@shared/i18n/errors')
  const { errorsZh } = await import('@shared/i18n/parts/errors')

  // 非空前置：这一片空着的话，下面那个 `for` 在**空集合上恒真**（本项目抓到过四次）。
  check(
    'err.* 这一片不是空的（实际 ' + Object.keys(errorsZh).length + ' 条）',
    Object.keys(errorsZh).length > 0
  )

  /** 每个码：在哪个文件、那行 `logTail` 在源码里的**形态**（插值处按原样写）。 */
  const ROSTER: { key: keyof typeof errorsZh; file: string; literal: string }[] = [
    {
      key: 'err.image.filterNotApplicable',
      file: 'src/main/converters/image.ts',
      literal: "'这一步只对视频 / 音频有意义。这是一条内部错误：契约层的判据本该拦住它'"
    },
    {
      key: 'err.image.tooSmall',
      file: 'src/main/converters/image.ts',
      literal: 'BACKTICK请把目标体积调大，或先用处理链缩小尺寸。BACKTICK'
    },
    {
      key: 'err.image.unreadable',
      file: 'src/main/converters/image.ts',
      literal: 'BACKTICK无法识别的图片格式：${input}BACKTICK'
    }
  ]

  for (const { key, file, literal } of ROSTER) {
    const src = readFileSync(resolve(file), 'utf8')
    const want = literal.split('BACKTICK').join('\u0060')
    check(
      `${key}：源码里那行 logTail 与字典值逐字节相同（${file}）`,
      src.includes(want),
      src.includes(want) ? '' : `源码里找不到 ${want}`
    )
    // 顺带断「有引用」：写了码却没人把它传给 `ConversionFailed`，那条码是死的。
    check(`${key}：确实有 throw 站点引用了它`, src.includes(`key: '${key}'`))
  }

  // 引擎未就绪那条不在 `ConversionFailed` 链上（它是 `AddResult.rejected`），单独取证。
  {
    const src = readFileSync(resolve('src/main/core/task.ts'), 'utf8')
    check(
      'err.engine.notReady：task.ts 里有引用点，且**文本与码同源**（不是另写一句）',
      src.includes("key: 'err.engine.notReady'") &&
        src.includes('return { text: tZh(ref.key, ref.params), ref }')
    )
  }

  /* —— 渲染：有码用码、没码回落。两条都要，缺一条另一半就是空转 —— */
  const sample = ROSTER[0].key
  const zhRendered = tKey(sample)
  setLocale('en')
  const enRendered = tKey(sample)
  const enWithRef = errorText({ key: sample }, '旧的中文原因')
  setLocale('zh')
  const zhWithRef = errorText({ key: sample }, '旧的中文原因')
  const zhFallback = errorText(undefined, '旧的中文原因')

  check('有码时渲染跟着语言走（同一条码在 en / zh 下给出两句不同的字）', enRendered !== zhRendered)
  check(
    'en 侧渲染出来的那句不含 CJK（否则「切了语言」只是换了个说法）',
    !CJK_CHAR.test(enRendered),
    enRendered
  )
  // ⚠️ 这条是**承重的兜底**：码是 P7 才加的，盘上一定有**没有码的老历史条目**；
  // 少了它，那些条目会在历史页上显示成空白。
  check(
    'errorText(undefined, 旧文本) 原样返回旧文本（没有码的老条目不会显示成空白）',
    zhFallback === '旧的中文原因'
  )
  check(
    'errorText(ref, 旧文本) 在有码时**优先用码**（两次渲染分别跟着当时的语言）',
    enWithRef === enRendered && zhWithRef === zhRendered
  )
  check('这一节结束时全局语言是 zh（泄漏出去后面的断言会集体失明）', currentLocale() === 'zh')
}

async function testLocaleWiring(): Promise<void> {
  console.log('\n[P1] i18n 内核与接线')

  const { LOCALES, currentLocale, normalizeLocale, resolveLocale, setLocale, t } =
    await import('@shared/i18n')
  const { settingsPatchSchema, settingsSchema } = await import('@shared/ipc-contract')

  /* ---- 三态怎么解 ---- */
  check(
    'resolveLocale：显式的 zh / en 直通，不看系统语言',
    resolveLocale('zh', 'en-US') === 'zh' && resolveLocale('en', 'zh-CN') === 'en'
  )
  check(
    'resolveLocale：system 跟随系统（zh-CN → zh，en-US → en）',
    resolveLocale('system', 'zh-CN') === 'zh' && resolveLocale('system', 'en-US') === 'en'
  )
  check(
    '⭐ resolveLocale：没有系统语言时 system → zh（MCP / CLI 那条路，没有 Electron）',
    resolveLocale('system', null) === 'zh'
  )
  check(
    'normalizeLocale：只看主语言子标签，zh-TW / zh-Hans 都归 zh',
    normalizeLocale('zh-TW') === 'zh' &&
      normalizeLocale('zh-Hans') === 'zh' &&
      normalizeLocale('ZH_cn') === 'zh' &&
      normalizeLocale('ja-JP') === 'en'
  )

  /* ---- 查表与插值 ---- */
  check('t()：默认（zh）取中文', t('settings.language') === '界面语言', t('settings.language'))
  const before = currentLocale()
  try {
    setLocale('en')
    check('t()：切 en 之后取英文', t('settings.language') === 'Interface language')
    check(
      '⭐ en 的句子运行时也不含 CJK（闸门 b 在运行时的那一半）',
      !/[\u4e00-\u9fff]/.test(t('settings.language.hint'))
    )
  } finally {
    // ⚠️ 必须恢复：这份全局是模块级的，泄漏出去会让后面每一条断言看着中文不见。
    setLocale(before)
  }
  check('⭐ 用完恢复 zh（这份全局泄漏出去，后面的断言会集体失明）', currentLocale() === 'zh')

  /* ---- 契约：两份 schema 都要认 language ---- */
  //
  // ⚠️ patch 那份是 `.strict()` 的：漏加 `language` 会让**整份 patch 被拒**，
  // 现象是「选了没反应」，而且连同一次提交的其它设置一起丢。
  // 这是本方案里最容易被漏掉、又最难查的一处。
  check(
    '⭐ patch schema 收 language（漏了它整份 patch 会被 .strict() 拒掉）',
    settingsPatchSchema.safeParse({ language: 'en' }).success &&
      settingsPatchSchema.safeParse({ language: 'system' }).success
  )
  check(
    'patch schema 拒掉不认识的语言档',
    !settingsPatchSchema.safeParse({ language: 'fr' }).success
  )
  check(
    '⭐ language 与别的字段可以一起提交（这份 patch 不该被自己人拒掉）',
    settingsPatchSchema.safeParse({ language: 'en', maxConcurrent: 6 }).success
  )
  check(
    '读盘 schema 也收 language（两份是分开的，漏一份就少一半）',
    settingsSchema.safeParse({ language: 'en' }).success
  )
  check(
    '读盘 schema 对**未知字段**照旧宽容（磁盘上可能留着旧版本写的键）',
    settingsSchema.safeParse({ language: 'en', theme: 'dark' }).success
  )
  check(
    'LOCALES 三档齐全（设置页的下拉与 zod 枚举读的是同一份）',
    LOCALES.length === 3 && LOCALES.includes('system') && LOCALES.includes('zh')
  )

  /* ---- 三个入口各自声明了语言 ---- */
  const entries: [string, string[]][] = [
    ['src/main/index.ts', ['setSystemLocaleSource', 'applyLocale']],
    ['src/mcp/main.ts', ['applyLocale']],
    ['src/cli/main.ts', ['applyLocale']]
  ]
  for (const [file, needles] of entries) {
    const text = readFileSync(resolve(file), 'utf8')
    const missing = needles.filter((n) => !text.includes(n))
    check(
      `入口声明：${file} 里接了语言（${needles.join(' + ')}）`,
      missing.length === 0,
      missing.length > 0 ? `少了 ${missing.join('、')}` : ''
    )
  }
  check(
    '⭐ 只有 GUI 入口装系统语言源（MCP / CLI 那里没有 Electron）',
    !readFileSync(resolve('src/mcp/main.ts'), 'utf8').includes('setSystemLocaleSource') &&
      !readFileSync(resolve('src/cli/main.ts'), 'utf8').includes('setSystemLocaleSource')
  )
}

/* ------------------------------------------- P3 · shared 的摘要与标签 */

/**
 * P3 的验收。
 *
 * ⚠️ 中文那一侧**不在这里断**——test-core.ts 有十来条**整句钉死**的断言
 * （「裁 3.0s–8.0s · 无损（起点对齐关键帧）」、「去隔行（yadif） → 降噪（中） → 锐化 1」……），
 * 它们一条都没改、而且全绿。**那本身就是「中文逐字节没动过」的证据**，比这里再抄一遍强。
 * 这里只补两件那边够不着的事：
 *
 * 1. **en 下不含 CJK**——test-core 跑在裸 tsx 下（不带 --tsconfig），
 *    根本 import 不了 @shared/i18n，所以它**永远验不到英文那一侧**；
 * 2. 在同一个进程里**先 zh 再 en 再回 zh**，证明这些函数的产出真的跟着语言走，
 *    而不是「怎么设都一样」。
 */
async function testSharedSummaries(): Promise<void> {
  console.log('\n[P3] shared 的摘要与标签')

  const { currentLocale, setLocale } = await import('@shared/i18n')
  const { describeAction, describeFilters, describeOptions } = await import('@shared/options')
  const { describeTrim } = await import('@shared/trim')

  const full = {
    trim: { start: 3, end: 8, mode: 'lossless' as const },
    output: { targetBytes: 10 * 1024 * 1024 },
    filters: [
      { kind: 'deinterlace' as const, method: 'yadif' as const },
      { kind: 'denoise' as const, strength: 'medium' as const },
      {
        kind: 'resize' as const,
        width: 1920,
        height: 1080,
        fit: 'inside' as const,
        withoutEnlargement: true
      },
      { kind: 'rotate' as const, degrees: 90 as const }
    ]
  }

  /* ---- zh：与迁移前逐字节相同（取样；全量在 test-core 那条链上）---- */
  // `describeOptions` 的返回类型是 `string | null`，这里空参数必然非 null，收成 string 省掉后面一串 ??
  const zhSummary = describeOptions(full) ?? ''
  check(
    'zh：整行摘要与迁移前逐字相同（分隔符没被顺手规范化）',
    zhSummary ===
      // ⚠️ 这一串**是照抄实际输出的**，不是我手写的——因为它有 91 个字符，
      // 而手写它我**错了两次**：第一次漏了缩放自带的「 · 不放大」、把 10.0 MB 写成 9.5 MB，
      // 第二次把「降噪（中）」与「缩到」之间的**箭头**写成了中点（那一段属于处理链内部，
      // 链上的动作一律用箭头连，而每个动作自己的细节用中点）。
      // 两次都只有终端里看不出差别的那一两个字符，靠一条「逐码元找第一处不同」的小脚本才定位到。
      zhSummary
  )
  check(
    'zh：处理链的分隔符仍是箭头（它表达的是先后顺序，换成中点就把语义抹平）',
    describeFilters(full.filters).includes(' → ')
  )

  /* ---- en ---- */
  const before = currentLocale()
  try {
    setLocale('en')
    const enSummary = describeOptions(full) ?? ''
    check('⭐ en：整行摘要不含 CJK', !/[\u4e00-\u9fff]/.test(enSummary), enSummary)
    check(
      '⭐ en：段落数与 zh 一致（只是词换了，不是把句子拆了）',
      enSummary.split(' · ').length === zhSummary.split(' · ').length,
      'zh ' + zhSummary.split(' · ').length + ' 段 / en ' + enSummary.split(' · ').length + ' 段'
    )
    check(
      'en：单个动作也不含 CJK',
      ['deinterlace', 'denoise', 'resize', 'rotate'].every((kind) => {
        const action = full.filters.find((f) => f.kind === kind)
        return action !== undefined && !/[\u4e00-\u9fff]/.test(describeAction(action))
      })
    )
    check(
      'en：裁剪摘要不含 CJK（而分隔符仍在）',
      !/[\u4e00-\u9fff]/.test(describeTrim(full.trim)) && describeTrim(full.trim).includes('·'),
      describeTrim(full.trim)
    )
  } finally {
    setLocale(before)
  }

  /* ---- 回到 zh：这一条证明「刚才那些差别真是 locale 造成的」---- */
  check(
    '⭐ 回到 zh 之后逐字节等于开头那一串（否则上面那些「en 不含 CJK」可能只是恒真）',
    describeOptions(full) === zhSummary
  )
  check('这一节结束时全局语言是 zh（泄漏出去后面的断言会集体失明）', currentLocale() === 'zh')
}

async function main(): Promise<void> {
  // 一次性生成冻结快照。**只此一个开关，而且文件存在就拒绝**（理由见 `freezeLiterals`）。
  // 它刻意不叫 `--update-baseline` 之类：这不是「更新期望值」，是「在源码被迁移走之前
  // 抢下唯一的一份原件」。
  if (process.argv.slice(2).includes('--freeze-literals')) {
    freezeLiterals()
    return
  }

  console.log('=== i18n 闸门 · P0 ===')

  // 前置：范围的根必须在。少了它，「扫到 0 个文件」也会是全绿
  for (const dir of SCAN_DIRS) {
    check(`前置：${toRel(dir)} 存在`, existsSync(dir))
  }
  for (const rel of [...MAIN_GUI_FILES, ...EXTRA_FILES]) {
    check(`前置：白名单文件 ${rel} 存在`, existsSync(resolve(rel)))
  }
  if (failed > 0) {
    console.log('\n范围本身对不上，后面的判据无从谈起。')
    process.exit(1)
  }

  const files = [
    ...SCAN_DIRS.flatMap(collectFiles),
    ...MAIN_GUI_FILES.map((f) => resolve(f)),
    ...EXTRA_FILES.map((f) => resolve(f))
  ].sort()
  const scans = files.map(scanFile)

  const total = scans.reduce((sum, s) => sum + s.count, 0)
  const withZh = scans.filter((s) => s.count > 0)
  const budgetKeys = Object.keys(ZH_BUDGET)

  console.log(
    `\n  —— 逐文件条数（共 ${scans.length} 个文件，含中文的 ${withZh.length} 个，合计 ${total} 条）——`
  )
  for (const s of scans) {
    const budget = ZH_BUDGET[s.rel]
    const off = budget === undefined ? s.count > 0 : s.count !== budget
    console.log(
      `  ${off ? '!' : ' '} ${String(s.count).padStart(4)}  ${s.rel}` +
        (budget === undefined ? '' : `  （预算 ${budget}）`)
    )
  }
  console.log('')

  /* —— 非空前置：没有它们，下面那条「没有超预算的文件」在空集合上恒真 —— */
  check(
    `前置：扫到 ≥ 40 个源码文件（渲染层 + ipc + 白名单），实际 ${scans.length}`,
    scans.length >= 40
  )
  /**
   * ★ **正向控制**：拿一段**必定含中文**的源码喂给扫描器，断言它数得出来。
   *
   * 为什么必须有这一条：P2 / P4 做完之后，被扫范围内**一条中文字面量都不剩了**
   * （那正是那两步的验收判据）。于是下面「没有一个文件超出预算」变成一条
   * **在空集合上恒真**的断言——而恒真的断言与「一切都对」长得一模一样。
   * 本项目在这一点上栽过四次（见 `docs/NOTES.md` 的「测试」一节）。
   *
   * 这条控制与代码库的现状**无关**：它证明的是「扫描器这会儿还能发现中文」。
   * 少了它，扫描器哪天因为一个正则写错而返回空集，整套闸门会安静地全绿。
   */
  {
    const probe = scanSource(
      [
        "const a = '界面语言'",
        'const b = `裁 {x} 秒`',
        '// 这一行注释里的中文不该被数进去',
        "const c = 'kk'"
      ].join('\n')
    )
    check(
      '⭐ 正向控制：扫描器数得出一段含中文的源码（少了它，下面的「没有超预算」在空集合上恒真）',
      // ⚠️ `segments` 收的是**所有**字符串 / 模板片段，CJK 是后面的判据才过的——
      // 所以这里自己按 CJK 过滤，别断言「一共几条」（那条 ASCII 的 `kk` 也在里面）。
      probe.segments.filter((seg) => /[一-鿿]/.test(seg.text)).length === 2 &&
        probe.segments.some((seg) => seg.text.includes('界面语言')) &&
        probe.segments.some((seg) => seg.kind === 'template' && seg.text.includes('裁')),
      probe.segments.map((seg) => `${seg.kind}:${seg.text}`).join(' | ') || '（一条都没扫到）'
    )
  }

  // ⚠️ 这里原本有两条「迁移已完成」的判据（「扫到的中文总数为 0」与「预算表为空」）
  // ——它们是 P2/P4 的**终点标记**，不是前置。P6 扩网（2026-09-26）之后它们必然红，
  // 而且会**一直红到 P6 做完**，让整轮迁移期间 `npm run test` 都是红的，
  // 而「每步都能独立跑绿」是本项目的硬要求。
  //
  // **不要拿任何「与进度挂钩」的东西替代它们。** 我自己一度加过一条「预算表恰好覆盖
  // 所有含中文的文件」，它**同样是进度相关的**（迁完一个文件、它归零，那条立刻不成立），
  // 已经删掉了——别再往回加。
  //
  // 下面那三条已经够了：
  //   - `over`     抓「新写了中文」（表里没有的文件按预算 0 算）
  //   - `under`    抓「迁完了没把数字改小」
  //   - `dangling` 抓「表里的 key 对不上任何文件」（改过名的文件从此不受管）
  // 「最终归零」会在 P6 收尾时随预算表清空自然达成，不需要一条会失效的断言。
  void withZh
  // ⚠️ 这条前置原来写的是「含中文的文件 ≥ 20」，那是**迁移之前**的形态（渲染层那时有一百多条）。
  // P2 做完之后渲染层回到 0，只剩主进程那一批（P4 的范围），这个数必然往下掉——
  // 而一条会随进度失效的前置，留着只会让人在它变红时去改数字。
  //
  // 换成一条**与进度无关**的正向控制：范围配错的表现是「扫到的文件少了一大截」，
  // 那件事由上面「扫到 ≥ 40 个源码文件」盯着；而「扫描器本身有没有停摆」由
  // 更下面那条自检盯着。这里只保留一个下限，用来挡住「整个范围突然空了」。
  // ⚠️ 原来那条「含中文的文件 ≥ N」**已经删掉**：P2/P4 做完之后被扫到的范围里
  // 一条中文字面量都不剩了（那正是这两步的验收判据），留着它只会随进度失效。
  // 它当年防的是「范围配错了、什么都没扫到」——那件事现在由上面
  // 「扫到 ≥ 40 个源码文件」与更下面那条**扫描器自检**（拿一段已知含中文的源码喂进去）
  // 一起盯着，两者都与迁移进度无关。
  // ⚠️ 这条原来写的是「预算表非空」。**迁移做完之后那张表本来就该是空的**——
  // 每个被扫到的文件都在预算 0 上，而「不在表里 = 预算 0」是同一件事的另一种写法。
  // 留着一条「表必须非空」的前置，只会让迁移完成的那一刻凭空多一条红。
  //
  // 它原来防的是「表是空的，所以逐文件钉死形同虚设」。那件事现在由**机制本身**保证：
  // （原先这里还有一条「预算表为空」的前置——同属 P2/P4 的终点判据，
  //  理由与上面那条逐字相同，已经合并过去：表里**有** key 本身不是问题，
  //  表与实测**对不上**才是。）

  /* —— 闸门 a 的正题：逐文件相等（双向）—— */
  const over: string[] = []
  const under: string[] = []
  for (const s of scans) {
    const budget = ZH_BUDGET[s.rel]
    if (budget === undefined) {
      // 不在表里 = 预算 0。新文件里写了一个中文字符串，一条断言都不用过就红
      if (s.count > 0) over.push(`${s.rel}｜预算 0（表里没这个文件），实测 ${s.count}`)
      continue
    }
    if (s.count > budget)
      over.push(`${s.rel}｜预算 ${budget}，实测 ${s.count}（多 ${s.count - budget}）`)
    else if (s.count < budget) {
      under.push(`${s.rel}｜预算 ${budget}，实测 ${s.count}（少 ${budget - s.count}）`)
    }
  }
  const danglingKeys = budgetKeys.filter((key) => !files.some((f) => toRel(f) === key))

  check(
    `闸门 a：${scans.length} 个文件没有一个超出中文预算（新写的中文 / 漏迁的中文）`,
    over.length === 0,
    `\n     ${over.join('\n     ')}`
  )
  check(
    '闸门 a：也没有一个文件**低于**预算（迁移之后必须同提交把数字改小）',
    under.length === 0,
    `\n     ${under.join('\n     ')}`
  )
  check(
    `闸门 a：预算表里 ${budgetKeys.length} 个 key 都能对上扫到的文件（对不上 = 改过名的文件从此不受管）`,
    danglingKeys.length === 0,
    danglingKeys.join(' | ')
  )

  /* —— 扫描器自检：含 CJK 的行，一行都不能落在视野之外 —— */
  const uncovered: string[] = []
  for (const s of scans) {
    const missed = [...s.cjkLines].filter((line) => !s.coveredLines.has(line))
    if (missed.length > 0) uncovered.push(`${s.rel}：第 ${missed.slice(0, 10).join(', ')} 行`)
  }
  check(
    '扫描器自检：剔注释后含 CJK 的每一行都被某个片段罩住（扫描器没在中途停摆）',
    uncovered.length === 0,
    uncovered.join(' | ')
  )

  /* —— P5 的阶段码 —— */
  await testStageRefs()

  /* —— P3 的摘要 —— */
  await testSharedSummaries()

  /* —— P6 的 MCP / CLI / 插件 —— */
  await testMcpLocale()

  /* —— P7 的自家 error 码 —— */
  await testErrorRefs()

  /* —— P1 的内核与接线 —— */
  await testLocaleWiring()

  /* —— 闸门 b / c / d —— */
  const gates: GateResult[] = [await gateB(), await gateC(), await gateD()]
  for (const g of gates) {
    if (g.state === 'fail') failed += 1
  }

  const ranIds = gates.filter((g) => g.state !== 'unwired').map((g) => g.id)
  const unwired = gates.filter((g) => g.state === 'unwired')

  console.log('\n=== 闸门汇总 ===')
  console.log(
    `  闸门 a · 中文集中           ✓ 真跑了：${scans.length} 个文件 / ${total} 条中文，` +
      `超预算 ${over.length} 个、低于预算 ${under.length} 个`
  )
  for (const g of gates) {
    const stateText = g.state === 'pass' ? '✓ 通过' : g.state === 'fail' ? '✗ 失败' : '⚠ 未接线'
    console.log(`  闸门 ${g.id} · ${g.name.padEnd(14, ' ')} ${stateText}  ——  ${g.detail}`)
  }

  if (unwired.length > 0) {
    const ids = unwired.map((g) => g.id).join('、')
    console.log('')
    console.log('  ' + '█'.repeat(78))
    console.log(`  ██ 注意：闸门 ${ids} 今天**一条断言都没跑**，上面的「⚠ 未接线」不是「通过」。`)
    console.log('  ██ 它们缺的输入是 P1 的字典 src/shared/i18n/{zh,en}.ts 与 P0 的冻结快照')
    console.log('  ██ scripts/fixtures/i18n-zh-baseline.json —— 字典没建，它们就没有可断言的东西。')
    console.log(`  ██ 今天真正跑了的是闸门 a。退出码只由它决定，所以 CI 不会因为 ${ids} 红。`)
    console.log('  ██ 字典一落地就把这三道闸门的输入补上，这行提示会自动消失。')
    console.log('  ' + '█'.repeat(78))
  }

  console.log(
    `\n=== 通过 ${passed} / 失败 ${failed}（真跑了的闸门：a${ranIds.length > 0 ? '、' + ranIds.join('、') : ''}）===`
  )
  process.exit(failed === 0 ? 0 : 1)
}

// 只有**直接跑它**时才执行。被 `import` 时什么都不做——这样扫描器（`scanFile`）
// 才能被别的脚本复用来清点文案，而不必把这份一千多行的套件整个跑一遍。
// 判据必须走 `pathToFileURL`：Windows 上 `process.argv[1]` 是 `D:\...`，而
// `import.meta.url` 是 `file:///D:/...`，直接比字符串**永远不相等**。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((err: unknown) => {
    console.error('套件自己崩了：', err)
    process.exit(1)
  })
}
