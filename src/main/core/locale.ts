import { resolveLocale, setLocale, type Locale } from '@shared/i18n'
import { getSettings } from './settings'

/**
 * 「现在该说哪种语言」——主进程侧的裁决，也是**唯一**一处把三态设置解成实际语言的地方。
 *
 * ## 与 `core/appPaths.ts` 同形，但默认值是合法的
 *
 * 两者都靠入口**注入**一个外部事实（那里是三个路径，这里是系统界面语言），
 * 但对待「没人注入」的态度相反，而那个差别是刻意的：
 *
 * - `appPaths()` **没装就抛**：它的降级会不报错地给出**错答案**（`app.isPackaged`
 *   读成 `undefined` → 判成未打包 → 静默走错分支）。
 * - `effectiveLocale()` **没装就用 `'zh'`**：这不是错答案，是「没人告诉我就说中文」。
 *   真正要防的是「GUI 入口忘了注入系统语言源」，而那个由入口声明闸门挡
 *   （`test-i18n.ts` 会检查三个入口各自声明了语言），不该用抛异常挡——
 *   抛在生产里意味着**整个应用起不来**，代价与收益完全不成比例。
 *
 * ## 三个入口的优先级不同（这是刻意的）
 *
 * ```
 * 环境变量 ARBITER_LOCALE  >  settings.json 里显式的 zh/en  >  'system' 的解析结果
 * ```
 *
 * `ARBITER_LOCALE` 排在最前是为了让**测试与 agent 宿主**能钉死语言：
 * `test-pdf` 会真起 Electron，而 CI 的 runner 是英文系统——不钉住的话，
 * 「中文断言在 CI 上红、在本机绿」这种最难查的失败就会出现。
 *
 * ⚠️ **MCP / CLI / 插件没有「系统语言」**：那里没有 Electron，消费者是 agent 与脚本。
 * 它们调 `effectiveLocale()` 时 `systemSource` 是 `null`，于是 `'system'` 解析成 `'zh'`，
 * 未设置时**恒为 `'zh'`**——现有的全部 MCP / CLI 断言与反证锚点因此原样成立。
 */

/** 系统界面语言的来源。由 GUI 入口注入（`app.getLocale()`）；其余入口不注入。 */
let systemSource: (() => string) | null = null

/** 环境变量的显式覆盖。`''` 与未设同义。 */
const envOverride = process.env.ARBITER_LOCALE?.trim() || null

/**
 * GUI 入口在 `app.whenReady()` 之后调一次。
 *
 * 传的是**函数**而不是字符串：`app.getLocale()` 在 `ready` 之前不可靠，而
 * 语言可能在运行中被改（用户改设置）。存一个取值函数，`effectiveLocale()`
 * 每次现问，就不存在「缓存了一份旧值」这件事。
 */
export function setSystemLocaleSource(fn: () => string): void {
  systemSource = fn
}

/** 现在该说哪种语言。**每次现算**，不缓存。 */
export function effectiveLocale(): Locale {
  if (envOverride !== null) {
    // 只认 'zh' / 'en' 两个字面量；写别的（比如 'en-US'）就按规范化处理。
    return envOverride.startsWith('zh') ? 'zh' : 'en'
  }
  const want = getSettings().language
  return resolveLocale(want, systemSource === null ? null : systemSource())
}

/**
 * 把当前语言推给 `@shared/i18n` 的全局，并回它。
 *
 * 调用点只有两处：入口启动时、以及用户改设置时（`ipc/settings.ts`）。
 * 别在别处顺手调——那份全局是**唯一**的，而测试里忘了设回去会让后续断言集体失明。
 */
export function applyLocale(): Locale {
  const next = effectiveLocale()
  setLocale(next)
  return next
}
