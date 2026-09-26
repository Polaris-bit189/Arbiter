import { en } from './en'
import type { Locale, LocaleSetting, MsgKey, ParamsOf, TArgs } from './types'
import { zh } from './zh'

// 类型从入口再导出一层：调用方只需要认 @shared/i18n 这一个路径，
// 不必知道表在哪个文件、类型在哪个文件。
export { LOCALES } from './types'
export type { KeysOf, Locale, LocaleSetting, MsgKey, ParamsOf, TArgs } from './types'

/**
 * i18n 的运行时：**查表 + 插值**，仅此而已。
 *
 * ## 为什么零依赖、且放在 `src/shared`
 *
 * 它要同时被 main / renderer / mcp / cli / scripts 五方 import，还要过
 * `tsconfig.node.json` 与 `tsconfig.web.json` 两套类型检查。所以这里只允许**相对
 * import**——与 `src/shared/channels.ts` 是同一条理由（那个文件单独存在就是因为
 * preload 也要它）。
 *
 * 也**不引任何 i18n 框架**（i18next / react-intl 那一类）：本项目需要的只有
 * 「查表 + 插值」两件事，而框架会把 `Intl` 的复数规则、日期格式、异步加载全拖进来。
 * 复数只在一处真需要（英文的 `1 file` / `2 files`），那里的做法是**两个 key**，
 * 见 `zh.ts` 里那两条 `.one` / `.other`。
 *
 * ## 语言是**模块级的一份全局**
 *
 * 不是「每个调用点传一个 locale」。因为最需要翻译的两个地方——主进程的原生对话框、
 * `progress.stage` 的兜底文本——**都拿不到「这是哪个界面的请求」这个上下文**：
 * 前者由 OS 画，后者在一个与渲染进程无关的转换进程里算出。传参会一路污染到
 * `converters/**` 的签名上，而那正好是约束 19 要求不能碰 `electron` 的那条链。
 *
 * 代价是**测试里要自己管好这份全局**：谁把它设成 `'en'` 而忘了设回去，后面所有断言
 * 都会看着中文不见。所以只有两处允许调 `setLocale`：三个入口的启动代码，
 * 以及 `test-i18n.ts`（它在每条用例后恢复 `'zh'`）。
 */

const TABLES: Record<Locale, Record<MsgKey, string>> = { zh, en }

let current: Locale = 'zh'

export function currentLocale(): Locale {
  return current
}

export function setLocale(next: Locale): void {
  current = next
}

/**
 * 系统给的语言标签 → 我们支持的那两种。
 *
 * `zh`、`zh-CN`、`zh-TW`、`zh-Hans` 全部落到 `'zh'`，其余一律 `'en'`。
 * 判据只看**主语言子标签**（第一个 `-` 之前那一段），因为 `zh-TW` 的用户要的是
 * 繁体中文，而我们只有一套中文——给他英文比给他简体中文更糟，所以这里刻意**不**
 * 按地区分叉，能读中文的都用中文。
 */
export function normalizeLocale(raw: string): Locale {
  const primary = raw.trim().toLowerCase().split(/[-_]/)[0]
  return primary === 'zh' ? 'zh' : 'en'
}

/**
 * 设置里的三态 + 系统语言 → 真正生效的语言。
 *
 * 💡 这是**唯一**一处把 `'system'` 解掉的函数，GUI 与 MCP/CLI 两条路都调它——
 * 差别只在传进来的 `systemLocale`：GUI 传 `app.getLocale()`，其余入口传 `null`
 * （那里没有「系统界面语言」这个概念，见 `core/locale.ts`）。
 */
export function resolveLocale(setting: LocaleSetting, systemLocale: string | null): Locale {
  if (setting !== 'system') return setting
  return systemLocale === null ? 'zh' : normalizeLocale(systemLocale)
}

/**
 * 插值。**缺参数不抛**——一个文案 bug 不该让整个界面白屏。
 *
 * 把 `{name}` 原样留在句子里，并 `console.error`：用户看到的是一个看得见的
 * `{engine}`（一眼就知道哪里不对），开发者看到的是一条能顺藤摸瓜的报错。
 * 抛出去的话，渲染层那棵树会整棵卸载，而根因只是一句话少了个词。
 *
 * 参数值一律 `String()`：`describeOptions` 那类地方会把数字直接传进来，
 * 而 `String(3)` 与模板字面量的行为一致，不需要调用方先转。
 */
function interpolate(template: string, params: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const value = params[name]
    if (value === undefined) {
      console.error(`[i18n] 占位符 {${name}} 没有对应的参数：${template}`)
      return whole
    }
    return String(value)
  })
}

/**
 * **强制走中文表**取一句。参数是**可选**的（与 `t` 的条件元组不同）。
 *
 * 两个用途，都是「键在变量里、推不出字面量类型」的场合：
 *
 * - `stagePair()` 要产出 `progress.stage` 的**中文兜底文本**——那一段必须是中文，
 *   与当前 locale 无关（它是 MCP 的线上格式，见 `stage.ts`）；
 * - 于是参数类型只能放宽：调用方手上是一个 `MsgKey` 联合，条件元组在那里推不出
 *   「要不要传参」——硬要用 `t` 就会报一堆假错误（P2 里四个并行线都踩过）。
 *
 * ⚠️ 放宽的只是**类型**，不是判据：缺参数照样原样留下 `{name}` 并 `console.error`，
 * 与 `t` 走同一个 `interpolate`。
 */
/**
 * 按**当前语言**取一句，而**键在变量里**（类型是整个 `MsgKey` 联合）。
 *
 * 存在的理由：`t` 的参数是条件元组（该传参数时忘了传是**编译错误**），而那个机制
 * 依赖「键是字面量」。键一旦落在变量里（`stageRef.key`、表里存的键名），类型就退化成
 * 联合，条件元组再也推不出「要不要传参」，于是 `t()` 会报一堆**假错误**。
 *
 * ⚠️ **放宽的只是类型，不是判据**：缺参数照样原样留下 `{name}` 并 `console.error`，
 * 与 `t` 走同一个 `interpolate`。所以「界面上出现一个看得见的 `{count}`」这条
 * 兜底一点没少。
 */
export function tKey(key: MsgKey, params: Record<string, string | number> = {}): string {
  const table = TABLES[current]
  // 表里缺这个键时回落到中文（`en.ts` 漏一条是编译错误，所以只可能是运行时被塞了
  // 一个不认识的键）。回落到中文而不是抛，与「缺参数不抛」同一条理由。
  const template = table[key] ?? zh[key]
  return interpolate(template ?? '', params)
}

/**
 * 同上，但**强制走中文表**——与当前语言无关。
 *
 * 唯一的用途是 `progress.stage` 的**中文兜底文本**：那个字段要跨进程传、还要进 MCP
 * 的线上格式，所以它必须是**恒定的中文**（见 `stage.ts` 的文件头）。别在别处用。
 */
export function tZh(key: MsgKey, params: Record<string, string | number> = {}): string {
  return interpolate(zh[key] ?? '', params)
}

/** 按**当前语言**取一句。 */
export function t<K extends MsgKey>(key: K, ...rest: TArgs<K>): string {
  return tf(key, (rest[0] ?? {}) as ParamsOf<K>)
}

/**
 * 显式传参数的版本。
 *
 * 什么时候需要它：参数**在变量里**、推不出字面量类型的时候（例如 `stagePair` 把
 * 一个 `Record<string, string>` 原样转发）。有它，那些地方就不必为了类型去写
 * `as`——而 `as` 一多，条件元组那层保护就形同虚设了。
 */
export function tf<K extends MsgKey>(key: K, params: ParamsOf<K>): string {
  const table = TABLES[current]
  // 表里缺这个键时回落到中文（`en.ts` 漏一条是编译错误，所以只可能是运行时被塞了
  // 一个不认识的键）。回落到中文而不是抛，与「缺参数不抛」同一条理由。
  const template = table[key] ?? zh[key]
  return interpolate(template, params as Record<string, string | number>)
}
