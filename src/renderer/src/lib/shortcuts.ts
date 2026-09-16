import type { NavPage } from '../store/useNav'

/**
 * 全局快捷键的**判据**（E-7）。
 *
 * 这个文件**零 React、零 DOM**：它收一个描述「按了什么键、当时界面是什么样」的普通对象，
 * 回一个动作名。绑定键盘那半边在 `hooks/useShortcuts.ts`。
 *
 * 分这么一刀不是为了好看，是因为**这个模块里每一条判据出错的表现都是「按了没反应」
 * 或者更糟的「不该动的时候动了」**——两种都不会崩、不会报错、也不会出现在任何日志里。
 * 而它们全都取决于「当时焦点在哪、队列什么样」，只有把状态喂进来才测得到。
 *
 * ## 三个键的定义
 *
 * | 键 | 动作 | 为什么 |
 * | --- | --- | --- |
 * | `Ctrl/Cmd + O` | 收入文件 | 与所有桌面应用一致的那个「打开」 |
 * | `Enter` | 开始调律 | 工作台的主按钮，高频用户敲得最多的一下 |
 * | `Esc` | 取消正在跑的转换 | 见下面那条关于「误触」的说明 |
 *
 * ## 为什么不认 `Enter` 的那两种情形（两条都是实测会踩的）
 *
 * - **输入法组字中**（`composing`）。中文用户敲 Enter 十有八九是在**上屏候选词**，
 *   不是要开始转换。少了这一条，用拼音打字时每选一次词就会往队列里塞一次
 *   「开始」——而队列里恰好有东西可跑时它真的会跑起来。
 * - **焦点在按钮 / 链接上**。浏览器本来就会把 Enter 派给那个元素（点一下），
 *   我们再接一手就成了「按一下干两件事」——比如焦点落在「清空」上，
 *   一次 Enter 既清空了已完成、又启动了队列。
 *
 * `Esc` 那条**是取舍，不是无风险**：它确实能一下掐掉一个跑了两小时的转码。
 * 之所以还是这么定：源文件一个字节都没动（转换从不改源），取消只丢中间产物，
 * 而重跑就是再敲一次 Enter；反过来，批量任务里「停下来」没有快捷键的话，
 * 只能一个个去点。`hooks/useShortcuts.ts` 那侧对每个动作都回一条 toast，
 * 让这一次误触**看得见**，而不是静默发生。
 */
export type ShortcutAction = 'pick-files' | 'start' | 'cancel-running'

/**
 * 对外宣称的键位表。
 *
 * **它在这里、不在设置页的 JSX 里**，理由只有一个：设置页那张表是给人看的，
 * 而「给人看的」与「判据认的」是两份东西，漂了不会有任何反应——用户照着表按，
 * 什么也不发生，且没有任何地方说得清为什么。
 *
 * 放这儿以后 `scripts/test-shortcuts.ts` 就能拿每一行去**真的喂进 `resolveShortcut`**，
 * 断言它确实产生那一行的动作。设置页只负责文案（见那边的 `SHORTCUT_HELP`）。
 */
export const SHORTCUT_TABLE: ReadonlyArray<{ keys: string; action: ShortcutAction }> = [
  { keys: 'Ctrl+O', action: 'pick-files' },
  { keys: 'Enter', action: 'start' },
  { keys: 'Esc', action: 'cancel-running' }
]

/** 事件目标的形态。取不到时给 `''` / `false`，判据一律按「不是输入框」处理 */
export interface ShortcutTarget {
  /** `event.target.tagName`，大写（DOM 给的就是大写）；`document.body` 是 `'BODY'` */
  tagName: string
  /** 目标自身或祖先上是 `contenteditable`（富文本、可编辑的 div） */
  editable: boolean
}

export interface ShortcutContext {
  /** `KeyboardEvent.key` 原样（不转小写，大小写由这里判） */
  key: string
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  shiftKey: boolean
  /** `KeyboardEvent.isComposing`——输入法组字中 */
  composing: boolean
  target: ShortcutTarget
  /** 当前页。**只有工作台认这些键**，其余三页一律不接管 */
  page: NavPage
  /** 等待开跑的任务数。为 0 时 Enter 什么都不做 */
  queued: number
  /** 正在跑的任务数。为 0 时 Esc 什么都不做 */
  running: number
}

/**
 * 这个元素会不会自己吃掉 Enter。
 *
 * `contenteditable` 单独判：它没有 tagName 可认（就是个 `div`），
 * 而「在富文本里按回车」显然不该启动队列。
 */
function eatsEnter(target: ShortcutTarget): boolean {
  if (target.editable) return true
  return target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT'
}

/** 焦点在可点元素上时，Enter 属于那个元素 */
function ownsEnter(target: ShortcutTarget): boolean {
  return target.tagName === 'BUTTON' || target.tagName === 'A'
}

/**
 * 按一下键该干什么。**没有可干的事就回 `null`**——调用方只认 `null`，
 * 所以「不该动的时候动不了」这件事是由这里保证的，不是靠调用方自觉。
 *
 * 判据的**次序是承重的**，尤其是组字那条必须排在最前：组字中敲 Enter 时
 * `event.target` 往往是个普通 div（焦点在画布上），后面任何一条都会放行它。
 */
export function resolveShortcut(ctx: ShortcutContext): ShortcutAction | null {
  // ① 输入法组字中：这一下 Enter 是「上屏」，不是我们的
  if (ctx.composing) return null

  // ② 只在工作台认。其余三页有自己的表单，接管 Enter 只会添乱
  if (ctx.page !== 'work') return null

  // ③ 带 Shift / Alt 的一律不认：那是别人的快捷键，而且我们一个都没占
  if (ctx.shiftKey || ctx.altKey) return null

  const mod = ctx.ctrlKey || ctx.metaKey

  // ④ Ctrl/Cmd + O。**刻意不看焦点**：绝大多数应用里它在输入框里也照常打开文件，
  //    而且它带修饰键，不会和「在输入框里打字」撞车
  if (mod) return ctx.key.toLowerCase() === 'o' ? 'pick-files' : null

  // ⑤ Esc：有在跑的才动，没有就什么都不做（不然会弹一句莫名其妙的 toast）
  if (ctx.key === 'Escape') return ctx.running > 0 ? 'cancel-running' : null

  if (ctx.key === 'Enter') {
    if (eatsEnter(ctx.target)) return null
    if (ownsEnter(ctx.target)) return null
    return ctx.queued > 0 ? 'start' : null
  }

  return null
}
