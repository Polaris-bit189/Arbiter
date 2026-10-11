import type { zh } from './zh'

/**
 * 界面语言。
 *
 * 三态而不是两态：`'system'` 是**默认值**，意思是「跟随操作系统」。
 * 少了它，一个中文系统上的英文用户第一次打开就得先去设置里改一次——而
 * 「默认值对大多数人是对的」正是这条功能要解决的第一个问题。
 *
 * ⚠️ **GUI 之外（MCP / CLI / 插件）没有「系统语言」这个概念**：那里没有 Electron、
 * 消费者是 agent 与脚本。那些入口把 `'system'` 解析成 `'zh'`——见 `core/locale.ts`。
 * 这不只是一个默认值问题：未解析时恒为 `'zh'`，现有的全部 MCP / CLI 断言与反证锚点
 * 才**原样成立**。
 */
export const LOCALES = ['system', 'zh', 'en'] as const
export type LocaleSetting = (typeof LOCALES)[number]

/** 解析之后真正生效的语言。**不含 `'system'`**——那是设置项的形状，不是语言。 */
export type Locale = 'zh' | 'en'

/**
 * 字典里所有键的并集。
 *
 * 从 `zh` 派生而不是另写一份：**`zh.ts` 是全仓唯一允许出现中文字面量的源码文件**，
 * 所以「有哪些句子」只有那里一处真相。`en.ts` 声明成 `Record<MsgKey, string>`，
 * 于是漏一条就是编译错误。
 */
export type MsgKey = keyof typeof zh

/**
 * 从一个模板字面量类型里把 `{name}` 的参数名抠出来。
 *
 * 条件类型递归：`'缩到 {w}×{h}'` → `'w' | 'h'`。没有参数时是 `never`，
 * 而 `Record<never, …>` 等于 `{}`，于是下面那个条件元组会退化成「不收参数」。
 */
export type ParamNames<S extends string> = S extends `${string}{${infer P}}${infer R}`
  ? P | ParamNames<R>
  : never

/** 某个键需要的参数对象。参数一律收 `string | number`——插值时会 `String()` 掉。 */
export type ParamsOf<K extends MsgKey> = Record<ParamNames<(typeof zh)[K]>, string | number>

/**
 * 取出**某一区域**的键：`KeysOf<'category.'>` = `'category.video' | …`。
 *
 * 为什么需要它：像 `CATEGORY_LABEL` 那样「表里存的是键」的映射，如果它的值类型写成
 * 整个 `MsgKey`，那么 `t(CATEGORY_LABEL[x])` 的类型就变成了「必须是**任意**一个键」——
 * 而那一大堆里包含 `eta.seconds` 这种带占位符的，于是 TS 会要求传参数，
 * 报的是 `Expected 2 arguments, but got 1`。那是个**假错误**：真正会被传进去的
 * 那六个键一个参数都不需要。
 *
 * 切成窄联合之后，`t()` 又能正确推出「不需要参数」了。
 */
export type KeysOf<Prefix extends string> = Extract<MsgKey, `${Prefix}${string}`>

/**
 * `t(key)` 的可变参数部分。
 *
 * ⚠️ **这个条件元组是承重的**：`zh` 的模板里有 `{engine}` 时，`t()` 就**必须**收到参数，
 * 忘了传是**编译错误**；而没有参数时多传一个也是编译错误。写成
 * `params?: ParamsOf<K>` 的话，两边都退化成「运行时才发现」——而运行时我们刻意不抛
 * （见 `index.ts` 的说明），于是表现就是界面上那句悄悄少了一个词的句子。
 */
export type TArgs<K extends MsgKey> = ParamsOf<K> extends Record<string, never> ? [] : [ParamsOf<K>]

/**
 * 一个**阶段**的码：一个键加一组参数，而不是一句成品句子。
 *
 * 为什么 `TaskProgress.stage` 不能只发成品句子：那一段是**B 类**文本——**跨时间传递、
 * 而且会被重新渲染到界面上**。产出它的是转换进程，显示它的是渲染层的任务卡片，
 * 中间隔着主进程的状态机与一条 IPC 通道。别处的文案（对话框、引擎名、扫描报告）
 * 都是「当次生成、当次显示」，语言一变自然就变了；这一族不是：**一个跑了两小时的转码，
 * 中途把界面切到英文，卡片上那行字要跟着变**。
 *
 * 定义住在这里（而不是 `stage.ts`）是因为它是**契约的一部分**——`shared/types.ts` 的
 * `TaskProgress` 要用它，而那一层不该 import 一个「带函数」的模块。
 */
export interface StageRef {
  key: KeysOf<'stage.'>
  /** 省略 = 这条文案不需要参数。参数值会 `String()` 掉 */
  params?: Record<string, string | number>
}

/**
 * **自家 error 的码** —— 与 `StageRef` 同形，只是键前缀是 `err.`。
 *
 * ## 为什么它也需要码
 *
 * 失败原因是 **B 类**文本：它跨时间传递（进 `Task`、进 `HistoryEntry`），而且会被
 * **重新渲染到界面上**——历史页里那些**几天前**失败的条目，在用户把界面切成英文之后
 * 也该跟着变。只存一句成品中文的话，它就被冻在**失败发生的那一刻**那门语言上了。
 *
 * ## 与 `stage` 的一处关键不同
 *
 * `progress.stage` 是**从码生成文本**（码是输入，`stagePair` 产出中文兜底）；
 * 失败原因**反过来**：`logTail` 里那行中文早就在 `throw` 时写定了，`ref` 只是
 * **它对应的码**。所以这里没有 `pair`，只有渲染层的 `errorText`。
 *
 * ⚠️ **`tZh(ref.key, ref.params)` 必须与那行 `logTail` 逐字节相同** —— 少了它，
 * 加码就会让卡片上的字与日志里的字对不上。`test-i18n.ts` 的 [P7] 一节钉着这件事。
 */
export interface ErrorRef {
  key: KeysOf<'err.'>
  /** 省略 = 这条文案不需要参数。参数值会 `String()` 掉 */
  params?: Record<string, string | number>
}
