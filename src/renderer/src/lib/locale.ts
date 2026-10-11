import { resolveLocale, type Locale } from '@shared/i18n'
import type { Settings } from '@shared/types'

/**
 * 渲染层从设置算出「现在该说哪种语言」。
 *
 * 系统语言的来源是 `navigator.language`——**不是**再走一次 IPC 去问主进程的
 * `app.getLocale()`。两者在 Electron 里指向同一个值（Chromium 的 locale 就是
 * `app.getLocale()`），而走 IPC 的代价是首屏要多等一轮往返：那期间
 * `document.title` 与整棵界面都停在默认语言上，改一次设置就闪一下。
 *
 * ⚠️ **`settings` 为 `null`（还没拉到）时按 `'system'` 算**，也就是先用
 * `navigator.language` 顶一下。真正防「闪一下」的是 `App.tsx` 的门控：
 * `App` 在设置到手之前只渲染空壳，所以这一条只是兜底，不是主路径。
 */
export function localeOf(settings: Settings | null): Locale {
  return resolveLocale(settings?.language ?? 'system', navigator.language)
}

/**
 * 屏幕阅读器与任务栏看到的那个标签。
 *
 * 中文一律报 `zh-CN`：我们只有一套中文（简体），报 `zh` 会让某些读屏软件
 * 按「未指定地区」处理。英文报 `en`。
 */
export function htmlLangOf(locale: Locale): string {
  return locale === 'zh' ? 'zh-CN' : 'en'
}
