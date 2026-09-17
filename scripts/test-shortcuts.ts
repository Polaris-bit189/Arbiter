/**
 * 全局快捷键判据（E-7）的自测脚本（**不依赖 Electron、不依赖 DOM**，直接跑）。
 *
 *   npx tsx --tsconfig tsconfig.test.json scripts/test-shortcuts.ts
 *
 * 被测的是 `src/renderer/src/lib/shortcuts.ts` 的 `resolveShortcut`——一个纯函数：
 * 收「按了什么键 + 当时界面什么样」，回一个动作名（或 `null`）。
 *
 * ## 为什么这一支值得单独存在
 *
 * 键盘判据错起来**全是静默的**，而且方向有两种，用户看到的都是「这东西坏了」：
 *
 * - **该动没动**：按了 Enter 没反应。用户会以为队列坏了。
 * - **不该动动了**：用拼音打字选词的那一下回车启动了整批转换；焦点在「清空」上按
 *   Enter 顺手把队列也点着了。第二种更坏——它动了东西。
 *
 * 两种都不会崩、不会报错、也不会进任何日志。所以每一组判据这里都**两个方向都断**：
 * 说「输入框里的 Enter 不算」之后，紧接着要断「同一个 Enter 放在 body 上就算」，
 * 否则一个「永远返回 null」的实现能让上面那半全绿。
 */
import {
  resolveShortcut,
  SHORTCUT_TABLE,
  type ShortcutAction,
  type ShortcutContext,
  type ShortcutTarget
} from '../src/renderer/src/lib/shortcuts'

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

/* ------------------------------------------------------------------ 夹具 */

const BODY: ShortcutTarget = { tagName: 'BODY', editable: false }
const INPUT: ShortcutTarget = { tagName: 'INPUT', editable: false }
const BUTTON: ShortcutTarget = { tagName: 'BUTTON', editable: false }
const RICH: ShortcutTarget = { tagName: 'DIV', editable: true }

/**
 * 一个「什么都具备」的上下文：在工作台、有待跑的、有在跑的、焦点在 body 上。
 * 各节只覆盖自己关心的那几个字段，**其余一律保持在这个「最容易触发」的档位上**——
 * 这样「回 null」就一定是被判据拦下的，而不是被某个没注意到的字段顺手带的。
 */
function ctx(over: Partial<ShortcutContext> = {}): ShortcutContext {
  return {
    key: '',
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    composing: false,
    target: BODY,
    page: 'work',
    queued: 1,
    running: 1,
    ...over
  }
}

/**
 * 把设置页那张表里的写法（`'Ctrl+O'`）翻成 `KeyboardEvent` 的字段。
 *
 * ⚠️ 这里**刻意不宽容**：认不出的键位回 `null`，让调用方红掉。
 * 宽容一点（比如原样把 `'Esc'` 当 `key`）的话，判据里写的是 `'Escape'`，
 * 两边永远对不上——而那一行的断言会以「快捷键不生效」的形式红，
 * 看起来像判据错了，实际是这张翻译表没跟上。
 */
function domKeyOf(part: string): string | null {
  const named: Record<string, string> = { Enter: 'Enter', Esc: 'Escape', Escape: 'Escape' }
  if (named[part] !== undefined) return named[part]
  return /^[A-Za-z]$/.test(part) ? part.toLowerCase() : null
}

/** 表里那一行说的键，按下之后应该产生什么上下文 */
function ctxFromKeys(keys: string, over: Partial<ShortcutContext> = {}): ShortcutContext | null {
  const parts = keys.split('+')
  const key = domKeyOf(parts[parts.length - 1])
  if (key === null) return null
  const mods = parts.slice(0, -1)
  return ctx({
    key,
    ctrlKey: mods.includes('Ctrl'),
    metaKey: mods.includes('Cmd') || mods.includes('Meta'),
    shiftKey: mods.includes('Shift'),
    altKey: mods.includes('Alt'),
    ...over
  })
}

/* ------------------------------------------------------- [1] 表与判据一致 */

function testTable(): void {
  console.log('\n[1] 设置页那张表说的，判据真的认')

  // 防空转：下面几条都在遍历这张表，表要是空的它们一条都不跑还报绿
  check('前置：键位表非空', SHORTCUT_TABLE.length > 0, String(SHORTCUT_TABLE.length))

  for (const row of SHORTCUT_TABLE) {
    const c = ctxFromKeys(row.keys)
    if (c === null) {
      check(`表里的 ${row.keys} 能被测试认出来`, false, '翻译表认不出这个键位，请同步 domKeyOf')
      continue
    }
    const got = resolveShortcut(c)
    check(`按下 ${row.keys} → ${row.action}`, got === row.action, `实际 ${JSON.stringify(got)}`)
  }

  // 两行说同一个动作 = 有一个动作在界面上根本没有键位，而用户看不出来
  const actions = SHORTCUT_TABLE.map((r) => r.action)
  check(
    '每一行的动作互不相同（没有两个键位抢同一件事）',
    new Set(actions).size === actions.length,
    actions.join(', ')
  )

  // ⚠️ 这张清单是**手写的**：加了第四个动作时它会红，提醒你来表里补一行。
  // TS 帮不上忙——`ShortcutAction` 是类型，运行时不存在。
  const known: ShortcutAction[] = ['pick-files', 'start', 'cancel-running']
  check(
    '三个已定义的动作在表里都有键位',
    known.every((a) => actions.includes(a)),
    `表里有 ${actions.join(', ')}`
  )
}

/* --------------------------------------------------------- [2] 输入法组字 */

function testComposing(): void {
  console.log('\n[2] 输入法组字中：一个键都不认')

  // 这一节最值钱的一条。中文用户敲 Enter 十有八九是在**上屏候选词**，
  // 而这时焦点往往在画布（body）上——少了 composing 这条，后面每一条都会放行它。
  for (const row of SHORTCUT_TABLE) {
    const c = ctxFromKeys(row.keys, { composing: true })
    check(
      `组字中按 ${row.keys} → 什么都不做`,
      c !== null && resolveShortcut(c) === null,
      c === null ? '（翻译表认不出这个键位）' : JSON.stringify(resolveShortcut(c))
    )
  }

  // 反向：同一个 Enter，不组字时必须真的启动——否则上面那三条在
  // 「判据永远返回 null」的实现下也全绿
  const plain = ctxFromKeys('Enter', { composing: false })
  check(
    '反向：同一个 Enter，不组字时确实启动队列',
    plain !== null && resolveShortcut(plain) === 'start'
  )
}

/* --------------------------------------------------------------- [3] 焦点 */

function testFocus(): void {
  console.log('\n[3] Enter 的归属：输入框和按钮的归它们自己')

  for (const [name, target] of [
    ['输入框', INPUT],
    ['下拉框', { tagName: 'SELECT', editable: false }],
    ['多行文本', { tagName: 'TEXTAREA', editable: false }],
    ['富文本', RICH]
  ] as const) {
    check(
      `焦点在${name}里按 Enter → 什么都不做`,
      resolveShortcut(ctx({ key: 'Enter', target })) === null
    )
  }

  // 按钮 / 链接：浏览器本来就会把 Enter 派给它们（= 点一下）。
  // 我们再接一手就成了「按一下干两件事」。
  for (const [name, target] of [
    ['按钮', BUTTON],
    ['链接', { tagName: 'A', editable: false }]
  ] as const) {
    check(
      `焦点在${name}上按 Enter → 不抢（那是它自己的默认行为）`,
      resolveShortcut(ctx({ key: 'Enter', target })) === null
    )
  }

  // **正向控制**：同一个 Enter、同一个队列，只把焦点挪到 body 上就必须启动。
  // 没有这一条，上面六条在「Enter 一律不算」的实现下照样全绿。
  check(
    '反向：焦点在 body 上按 Enter → 启动',
    resolveShortcut(ctx({ key: 'Enter', target: BODY })) === 'start'
  )

  // Ctrl+O 与焦点无关：绝大多数应用里它在输入框里也照常打开文件，
  // 而且它带修饰键，不会跟「在输入框里打字」撞车。这是**刻意的**，钉住它。
  check(
    'Ctrl+O 在输入框里照样生效（它与 Enter 的归属规则刻意不同）',
    resolveShortcut(ctx({ key: 'o', ctrlKey: true, target: INPUT })) === 'pick-files'
  )
}

/* ----------------------------------------------------------- [4] 页面归属 */

function testPage(): void {
  console.log('\n[4] 只有在工作台才接管')

  for (const page of ['history', 'settings', 'about'] as const) {
    const results = SHORTCUT_TABLE.map((row) => {
      const c = ctxFromKeys(row.keys, { page })
      return c === null ? '(认不出)' : resolveShortcut(c)
    })
    check(
      `在 ${page} 页三个键都不接管`,
      results.every((r) => r === null),
      results.join(', ')
    )
  }

  check(
    '反向：同一组上下文放在工作台就认',
    resolveShortcut(ctx({ key: 'Escape' })) === 'cancel-running'
  )
}

/* --------------------------------------------------------- [5] 修饰键组合 */

function testModifiers(): void {
  console.log('\n[5] 修饰键')

  check(
    'Shift+Enter → 不认（那是别人的键）',
    resolveShortcut(ctx({ key: 'Enter', shiftKey: true })) === null
  )
  check('Alt+Enter → 不认', resolveShortcut(ctx({ key: 'Enter', altKey: true })) === null)
  check('Shift+Esc → 不认', resolveShortcut(ctx({ key: 'Escape', shiftKey: true })) === null)
  check(
    'Ctrl+Enter → 不认（我们没占这一对，不能顺手吞掉）',
    resolveShortcut(ctx({ key: 'Enter', ctrlKey: true })) === null
  )

  // macOS 的 Cmd 键：同一个「打开」，那边按的是 Cmd 而不是 Ctrl
  check(
    'Cmd+O（macOS）与 Ctrl+O 等价',
    resolveShortcut(ctx({ key: 'o', metaKey: true })) === 'pick-files'
  )
  // 大写 'O'（按住 Shift 时 key 就是大写）——但 Shift 那条已经先拦下了，
  // 这里断的是**大小写本身**不影响：'O' 与 'o' 是同一个键
  check(
    "Ctrl+'O'（大写）与 Ctrl+'o' 等价",
    resolveShortcut(ctx({ key: 'O', ctrlKey: true })) === 'pick-files'
  )
}

/* ------------------------------------------------------------- [6] 边界 */

function testEdges(): void {
  console.log('\n[6] 没有可干的事就什么都不做')

  check(
    '队列里没有待跑的，Enter 不启动（不能启动一个空队列）',
    resolveShortcut(ctx({ key: 'Enter', queued: 0 })) === null
  )
  check(
    '没有在跑的，Esc 不动作（否则会弹一句莫名其妙的提示）',
    resolveShortcut(ctx({ key: 'Escape', running: 0 })) === null
  )
  check(
    '反向：有在跑的，Esc 确实取消',
    resolveShortcut(ctx({ key: 'Escape', running: 1 })) === 'cancel-running'
  )

  for (const key of ['a', 'F5', 'ArrowUp', ' ', 'Tab']) {
    check(`无关键 ${JSON.stringify(key)} → 不接管`, resolveShortcut(ctx({ key })) === null)
  }
}

/* ------------------------------------------------- [7] 判据本身有没有鉴别力 */

function testNotDecorative(): void {
  console.log('\n[7] 反装饰性：判据得本来就能回非 null')

  // 这一节钉的是「上面所有『回 null』的断言合起来有没有意义」。
  // 一个恒返回 null 的实现能让它们**全部**变绿——那正是本仓库抓过四次的
  // 装饰性断言。所以这里要求两个方向都真有实例。
  let nonNull = 0
  let nulls = 0
  for (const row of SHORTCUT_TABLE) {
    for (const page of ['work', 'history'] as const) {
      for (const composing of [true, false]) {
        const c = ctxFromKeys(row.keys, { page, composing })
        if (c === null) continue
        resolveShortcut(c) === null ? (nulls += 1) : (nonNull += 1)
      }
    }
  }
  check('判据确实回得出动作（不是恒 null 的实现）', nonNull >= 3, `非 null ${nonNull} 次`)
  check('判据也确实回得出 null（不是见键就接）', nulls >= 3, `null ${nulls} 次`)
}

/* -------------------------------------------------------------------- main */

function main(): void {
  testTable()
  testComposing()
  testFocus()
  testPage()
  testModifiers()
  testEdges()
  testNotDecorative()

  console.log(`\n通过 ${passed}，失败 ${failed}`)
  if (failed > 0) process.exitCode = 1
}

main()
