export interface ProgressUpdate {
  /** 0..1，保证单调不减 */
  percent: number
  etaSec?: number
  /** 相对实时的倍速，如 1.02 表示 1.02x */
  speed?: number
}

/** `out_time=00:00:05.120000` */
const OUT_TIME_RE = /^(\d+):(\d{2}):(\d{2}(?:\.\d+)?)$/

function parseOutTime(value: string | undefined): number | null {
  if (!value) return null
  const m = OUT_TIME_RE.exec(value.trim())
  if (!m) return null
  const total = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])
  return Number.isFinite(total) ? total : null
}

/**
 * 解析 `ffmpeg -progress pipe:1` 的输出。
 *
 * 两个必须踩对的坑：
 *
 * 1. **不能按行即时解析。** ffmpeg 每约 0.5 秒吐一个由多行 key=value 组成的记录，
 *    `frame=` / `out_time=` / `speed=` 属于同一条记录。如果逐行处理，读到的会是
 *    上一轮的残留值。必须缓冲到遇到 `progress=` 这一行（记录的终止符）才提交。
 *
 * 2. **不要用 `out_time_ms`。** 这个名字是骗人的，它的单位实际是微秒（ffmpeg 的
 *    历史遗留 bug）。解析 `out_time` 的 HH:MM:SS.ffffff 形式最稳，且与版本无关。
 */
export class FfmpegProgressParser {
  private buffer = ''
  private pending: Record<string, string> = {}
  private lastPercent = 0
  private readonly samples: Array<{ t: number; media: number }> = []
  private readonly totalDurationSec: number

  constructor(totalDurationSec: number) {
    this.totalDurationSec = totalDurationSec
  }

  /** 喂入任意分片，返回本次是否有新的进度可上报 */
  push(chunk: string): ProgressUpdate | null {
    this.buffer += chunk

    let latest: ProgressUpdate | null = null
    let idx = this.buffer.indexOf('\n')

    while (idx >= 0) {
      const line = this.buffer.slice(0, idx).trim()
      this.buffer = this.buffer.slice(idx + 1)

      const update = this.handleLine(line)
      if (update) latest = update

      idx = this.buffer.indexOf('\n')
    }

    return latest
  }

  private handleLine(line: string): ProgressUpdate | null {
    if (line === '') return null

    const eq = line.indexOf('=')
    if (eq < 0) return null

    const key = line.slice(0, eq)
    this.pending[key] = line.slice(eq + 1)

    // progress= 是记录的终止符，此时整条记录才完整
    if (key !== 'progress') return null

    const record = this.pending
    this.pending = {}
    return this.commit(record)
  }

  private commit(record: Record<string, string>): ProgressUpdate | null {
    const outTime = parseOutTime(record.out_time)
    const isEnd = record.progress === 'end'

    if (outTime === null && !isEnd) return null

    const mediaSec = outTime ?? this.totalDurationSec
    const now = Date.now()

    this.samples.push({ t: now, media: mediaSec })
    // 只保留最近 30 秒的采样，用于 speed=N/A 时估算速率
    while (this.samples.length > 2 && now - this.samples[0].t > 30_000) {
      this.samples.shift()
    }

    let speed = Number.parseFloat(record.speed ?? '')
    if (!Number.isFinite(speed) || speed <= 0) speed = this.measureSpeed()

    let percent: number
    if (isEnd) {
      percent = 1
    } else if (this.totalDurationSec > 0) {
      percent = Math.min(1, Math.max(0, mediaSec / this.totalDurationSec))
    } else {
      percent = 0
    }

    // 进度只能前进：ffmpeg 偶尔会吐回退值，直接透传会让进度条往回跳
    percent = Math.max(this.lastPercent, percent)
    this.lastPercent = percent

    const rate = speed > 0 ? speed : 1
    const remaining = Math.max(0, this.totalDurationSec - mediaSec)

    return {
      percent,
      etaSec: isEnd ? 0 : remaining / rate,
      speed: speed > 0 ? speed : undefined
    }
  }

  /** speed=N/A 时的兜底：用最近窗口的实测速率 */
  private measureSpeed(): number {
    if (this.samples.length < 2) return 0

    const first = this.samples[0]
    const last = this.samples[this.samples.length - 1]
    const wallSec = (last.t - first.t) / 1000
    if (wallSec <= 0) return 0

    return Math.max(0, (last.media - first.media) / wallSec)
  }
}
