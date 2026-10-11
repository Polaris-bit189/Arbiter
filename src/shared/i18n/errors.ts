import { tKey } from './index'
import type { ErrorRef } from './types'

// 契约类型住在 `types.ts`（`Task` / `HistoryEntry` 要用它，而那一层不该 import
// 带函数的模块）。这里再导出一层，让调用方只认 `@shared/i18n/errors` 一个路径。
export type { ErrorRef } from './types'

/**
 * 渲染层把**失败原因的码**翻成当前语言的句子；没有码时回落 `fallback`。
 *
 * `fallback` 就是 `Task.error` / `HistoryEntry.error` 里那句——它是 `summarize(logTail)`
 * 的结果（**恒为中文**，与 `progress.stage` 同一条规矩：那是原始记录的样子，
 * 而且一批既有断言直接钉着它）。
 *
 * **这条兜底是承重的**：码是 P7 才加的，所以盘上一定躺着**没有码的老历史条目**；
 * 少了它，那些条目会在历史页上显示成一片空白。
 *
 * ⚠️ 与 `stageText` 是同一形状的两个函数，**刻意没有合并**：它们的 `fallback` 来源与
 * 「没有码时该显示什么」的语义不同（那边回落到空串是可以接受的——进度那一列本来就可能
 * 什么都没有；这边回落到空串意味着用户看不到失败原因）。合并会让其中一边的取舍被另一边
 * 悄悄改掉。
 */
export function errorText(ref: ErrorRef | undefined, fallback: string): string {
  if (ref === undefined) return fallback
  return tKey(ref.key, ref.params ?? {})
}
