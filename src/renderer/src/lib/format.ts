import { t } from '@shared/i18n'

/**
 * `formatBytes` 已挪到 `@shared/format`——它要被 `shared/options.ts` 的参数摘要共用，
 * 而那一句话在队列卡片与历史页上必须是**同一串字**（见那边的注释）。
 * 这里只做转出，调用点一个字都不用改。
 */
export { formatBytes } from '@shared/format'

/**
 * 剩余时间。超过一小时就没必要显示秒了，「1 小时 20 分」更有用。
 *
 * ⚠️ 五句中文原样搬进字典（`libsZh` 那六条 `eta.*`），一个字的改通顺都不行——
 * 闸门 d 拿冻结快照逐值比对。分档的**阈值**（1 秒 / 60 秒 / 60 分）留在这里，
 * 它们是逻辑不是文案。
 */
export function formatEta(seconds: number | undefined): string {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return ''
  if (seconds < 1) return t('eta.almost')
  if (seconds < 60) return t('eta.seconds', { n: Math.ceil(seconds) })

  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) {
    const rest = Math.round(seconds % 60)
    return rest > 0
      ? t('eta.minutesSeconds', { m: minutes, s: rest })
      : t('eta.minutes', { m: minutes })
  }

  const hours = Math.floor(minutes / 60)
  const restMinutes = minutes % 60
  return restMinutes > 0
    ? t('eta.hoursMinutes', { h: hours, m: restMinutes })
    : t('eta.hours', { h: hours })
}

/** 倍速，如 “1.4x” */
export function formatSpeed(speed: number | undefined): string {
  if (speed === undefined || !Number.isFinite(speed) || speed <= 0) return ''
  return `${speed.toFixed(2).replace(/\.?0+$/, '')}x`
}
