/**
 * 给人看的格式化。**放在 shared 而不是 renderer**，是因为参数摘要那一行
 * （`shared/options.ts` 的 `describeOptions`）由 main 与 renderer **共用同一句话**：
 * 队列卡片与历史页显示的必须是同一串字，两处各写一份格式化迟早会漂。
 *
 * 零依赖（连 `import type` 都不需要），与 `channels.ts` / `trim.ts` 同一个理由：
 * preload 跑在 sandbox 里，拉进任何 npm 依赖都会让整个 preload 崩掉。
 */

/** 人类可读的体积。转换场景里 1 KB = 1024 B，和资源管理器保持一致。 */
export function formatBytes(bytes: number | undefined): string {
  if (!bytes || bytes <= 0) return '—'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  const digits = value >= 100 || unit === 0 ? 0 : 1
  return `${value.toFixed(digits)} ${units[unit]}`
}
