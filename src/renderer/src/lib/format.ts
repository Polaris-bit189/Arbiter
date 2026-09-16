/**
 * `formatBytes` 已挪到 `@shared/format`——它要被 `shared/options.ts` 的参数摘要共用，
 * 而那一句话在队列卡片与历史页上必须是**同一串字**（见那边的注释）。
 * 这里只做转出，调用点一个字都不用改。
 */
export { formatBytes } from '@shared/format'

/** 剩余时间。超过一小时就没必要显示秒了，“约 1 小时 20 分”更有用。 */
export function formatEta(seconds: number | undefined): string {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return ''
  if (seconds < 1) return '即将完成'
  if (seconds < 60) return `剩余 ${Math.ceil(seconds)} 秒`

  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) {
    const rest = Math.round(seconds % 60)
    return rest > 0 ? `剩余 ${minutes} 分 ${rest} 秒` : `剩余 ${minutes} 分`
  }

  const hours = Math.floor(minutes / 60)
  const restMinutes = minutes % 60
  return restMinutes > 0 ? `剩余 ${hours} 小时 ${restMinutes} 分` : `剩余 ${hours} 小时`
}

/** 倍速，如 “1.4x” */
export function formatSpeed(speed: number | undefined): string {
  if (speed === undefined || !Number.isFinite(speed) || speed <= 0) return ''
  return `${speed.toFixed(2).replace(/\.?0+$/, '')}x`
}
