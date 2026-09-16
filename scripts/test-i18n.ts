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
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'fs'
import { relative, resolve, sep } from 'path'
import { pathToFileURL } from 'url'

/** 扫的源码扩展名。`.css` / `.svg` / `.html` 都不在网里（它们不是文案的生产者，见文件头口径） */
const SOURCE_EXTS = ['.ts', '.tsx']

/** 整目录进网的两块 */
const SCAN_DIRS = [resolve('src/renderer/src'), resolve('src/main/ipc')]

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
const MAIN_ZH_BUDGET: Record<string, number> = {
  // —— 主进程 GUI 白名单（`MAIN_GUI_FILES` 里那 7 个）——
  'src/main/core/cli.ts': 14,
  'src/main/core/folderScan.ts': 31,
  'src/main/core/integration.ts': 5,
  'src/main/core/jsonStore.ts': 6,
  'src/main/core/renameWatcher.ts': 10,
  'src/main/core/sendTo.ts': 5,
  'src/main/engines/status.ts': 15,
  // —— src/main/ipc/**（整目录进网，但只有这 5 个文件里有中文）——
  'src/main/ipc/history.ts': 2,
  'src/main/ipc/integration.ts': 4,
  'src/main/ipc/rename.ts': 8,
  'src/main/ipc/settings.ts': 3,
  'src/main/ipc/tasks.ts': 20,
  // —— EXTRA_FILES：不在上面两个目录里，单独点名（理由见上面那段注释）——
  'src/renderer/index.html': 1,
  // —— src/renderer/src/**（同样整目录进网；下表只列有中文的那些）——
  'src/renderer/src/components/AfterActionNotice.tsx': 11,
  'src/renderer/src/components/DropZone.tsx': 4,
  'src/renderer/src/components/Sidebar.tsx': 8,
  'src/renderer/src/components/TargetFormatSelect.tsx': 3,
  'src/renderer/src/components/TaskCard.tsx': 25,
  'src/renderer/src/components/TaskList.tsx': 2,
  'src/renderer/src/components/TitleBar.tsx': 5,
  'src/renderer/src/components/options/FiltersSection.tsx': 65,
  'src/renderer/src/components/options/OptionsEditor.tsx': 1,
  'src/renderer/src/components/options/OptionsSection.tsx': 2,
  'src/renderer/src/components/options/OutputSection.tsx': 21,
  'src/renderer/src/components/options/TrimSection.tsx': 17,
  'src/renderer/src/lib/format.ts': 6,
  'src/renderer/src/lib/labels.ts': 6,
  'src/renderer/src/pages/AboutPage.tsx': 18,
  'src/renderer/src/pages/HistoryPage.tsx': 56,
  'src/renderer/src/pages/SettingsPage.tsx': 84,
  'src/renderer/src/pages/WorkbenchPage.tsx': 28
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

function scanFile(file: string): FileScan {
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
function stripPlaceholders(text: string): string {
  return text.replace(/\{[^}]*\}/g, '')
}

/** 递归收出范围内全部源码文件（排序，输出才是稳定的） */
function collectFiles(dir: string): string[] {
  const names = readdirSync(dir, { recursive: true }) as string[]
  return names
    .filter((name) => SOURCE_EXTS.includes(name.slice(name.lastIndexOf('.'))))
    .map((name) => resolve(dir, name))
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
 * 等于没有期望值（与上面 `MAIN_ZH_BUDGET` 那段同一条自觉）。
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
  const bad = keys.filter((k) => CJK_CHAR.test(en.table[k]!))
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
  const values = Object.entries(zh.table)
  if (values.length === 0) {
    return { id, name, state: 'fail', detail: `${I18N_DIR}/zh.ts 是空表（空集合上恒真）`, ran: 1 }
  }

  // 判据是**值**落在冻结清单里，不是「key 对 key」。快照没有 key——它在字典之前就存在了。
  const allowed = new Set(frozen as string[])
  const drifted = values.filter(([, value]) => !allowed.has(stripPlaceholders(value)))
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
  const budgetKeys = Object.keys(MAIN_ZH_BUDGET)

  console.log(
    `\n  —— 逐文件条数（共 ${scans.length} 个文件，含中文的 ${withZh.length} 个，合计 ${total} 条）——`
  )
  for (const s of scans) {
    const budget = MAIN_ZH_BUDGET[s.rel]
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
  check(`前置：扫到的中文片段总数 > 0，实际 ${total}`, total > 0)
  check(
    `前置：含中文的文件 ≥ 20 个（只有一两个文件有中文，说明范围配错了），实际 ${withZh.length}`,
    withZh.length >= 20
  )
  check('前置：预算表非空（表是空的话「逐文件钉死」四个字一个字都没落地）', budgetKeys.length > 0)

  /* —— 闸门 a 的正题：逐文件相等（双向）—— */
  const over: string[] = []
  const under: string[] = []
  for (const s of scans) {
    const budget = MAIN_ZH_BUDGET[s.rel]
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

void main().catch((err: unknown) => {
  console.error('套件自己崩了：', err)
  process.exit(1)
})
