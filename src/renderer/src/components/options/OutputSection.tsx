import { useState } from 'react'
import type { OutputOptions, Task } from '@shared/types'
import {
  MAX_BITRATE_KBPS,
  MAX_TARGET_BYTES,
  MIN_BITRATE_KBPS,
  MIN_TARGET_BYTES,
  withOption
} from '@shared/options'
import { useTasks } from '../../store/useTasks'
import { cn } from '../../lib/cn'
import { OptionsSection } from './OptionsSection'

const KB = 1024
const MB = 1024 * 1024
const GB = 1024 * 1024 * 1024

type Mode = keyof OutputOptions
type Unit = 'MB' | 'KB'

/** 字节 → 输入框里的字。**取整到两位小数**，避免 `0.30000000000000004` 那种浮点尾巴出现在界面上。 */
function sizeTextOf(bytes: number, unit: Unit): string {
  const value = bytes / (unit === 'MB' ? MB : KB)
  return String(Number(value.toFixed(2)))
}

/**
 * 「输出约束」那一块：目标体积 / 目标码率（`TaskOptions.output`）。
 *
 * ## 三件事是这块面板的承重结构
 *
 * 1. **二选一是结构上的，不是靠提示。** 体积与码率各有一个输入框，**同一时刻只有一个
 *    在编辑**，提交出去的 `OutputOptions` 也永远只有一个字段——用户在界面上根本
 *    造不出「两个都给」或「一个都不给」那种被 `outputSchema` 拒掉的载荷。
 *    反过来说，两个框同时可编辑、靠渲染时挑一个交出去，就会在「点了应用什么都没发生」
 *    与「静默丢掉用户填的另一半」之间选一个，两者都是这个项目最忌讳的形态。
 * 2. **上限常量取自 `@shared/options`**，与主进程 schema 是同一个数。两边各写一个的表现是
 *    「界面放行了一个主进程会拒掉的值」——点了应用什么都不发生，界面上一个字都不提示。
 * 3. **体积的输入单位是 MB / KB，而契约里是字节。** 用户想的是「压到 10 MB」，
 *    让他自己乘 1048576 是在制造错误答案。换算与取整都在这里做完，交出去的仍是整数字节。
 *
 * ## 两个必须说在明面上的代价
 *
 * - 视频的体积目标走**两遍编码**（先把整片分析一遍再编），耗时接近翻倍；
 * - 体积目标与**无损裁剪**不能同时用（后者一个字节都不重编，改不了体积），
 *   两者一起提交会被引擎拒掉并在卡片上报错。这句话不写出来，用户会以为「应用」坏了。
 */
export function OutputSection({ task }: { task: Task }): React.JSX.Element {
  const setOptions = useTasks((s) => s.setOptions)

  const current = task.options?.output
  const initialUnit: Unit =
    current?.targetBytes !== undefined && current.targetBytes < MB ? 'KB' : 'MB'

  const [mode, setMode] = useState<Mode>(
    current?.bitrateKbps !== undefined ? 'bitrateKbps' : 'targetBytes'
  )
  const [unit, setUnit] = useState<Unit>(initialUnit)
  const [sizeText, setSizeText] = useState(
    current?.targetBytes !== undefined ? sizeTextOf(current.targetBytes, initialUnit) : '10'
  )
  const [rateText, setRateText] = useState(
    current?.bitrateKbps !== undefined ? String(current.bitrateKbps) : '2000'
  )
  const [busy, setBusy] = useState(false)
  /** 上一次「应用」到底成没成。主进程静默不办，所以**必须**有一条回执 */
  const [failed, setFailed] = useState(false)

  /**
   * 校验。三条规矩与 `TrimSection` 一致：用 `Number()` 而不是 `parseFloat`（后者只解前缀，
   * `'1.5.5'` 会变成 `1.5`，用户拿到一个与他输入不一致的参数）、空串单独判
   * （`Number('')` 是 `0` 不是 `NaN`）、先判「填了没」再判数值最后才判上下界。
   */
  const reason: string | null = ((): string | null => {
    if (mode === 'targetBytes') {
      const raw = sizeText.trim()
      if (raw === '') return '体积不能为空'
      const value = Number(raw)
      if (!Number.isFinite(value)) return '只能填数字'
      if (value <= 0) return '体积要大于 0'
      const bytes = Math.round(value * (unit === 'MB' ? MB : KB))
      if (bytes < MIN_TARGET_BYTES) return `不能小于 ${MIN_TARGET_BYTES / KB} KB`
      if (bytes > MAX_TARGET_BYTES) return `不能大于 ${MAX_TARGET_BYTES / GB} GB`
      return null
    }

    const raw = rateText.trim()
    if (raw === '') return '码率不能为空'
    const value = Number(raw)
    if (!Number.isFinite(value)) return '只能填数字'
    if (!Number.isInteger(value)) return '码率是整数（单位 kbps）'
    if (value < MIN_BITRATE_KBPS) return `不能小于 ${MIN_BITRATE_KBPS} kbps`
    if (value > MAX_BITRATE_KBPS) return `不能大于 ${MAX_BITRATE_KBPS} kbps`
    return null
  })()

  const apply = async (): Promise<void> => {
    if (reason !== null || busy) return
    // 只交出被编辑的那一个字段：二选一在这里是**结构上**成立的
    const output: OutputOptions =
      mode === 'targetBytes'
        ? { targetBytes: Math.round(Number(sizeText.trim()) * (unit === 'MB' ? MB : KB)) }
        : { bitrateKbps: Number(rateText.trim()) }

    setBusy(true)
    // ⚠️ `withOption` 而不是 `{ output }`：`setOptions` 是**整体替换**语义，
    // 只交这一项的话，用户先前设好的裁剪与处理链会被这块面板静默抹掉。
    const ok = await setOptions(task.id, withOption(task.options, { output }) ?? null)
    setBusy(false)
    // 主进程**静默**不办（任务在跑 / 这一类不该有这项参数），所以这里必须把它说出来
    setFailed(!ok)
  }

  const clear = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    await setOptions(task.id, withOption(task.options, { output: undefined }) ?? null)
    setBusy(false)
    setFailed(false)
  }

  const modeButton = (key: Mode, label: string): React.JSX.Element => (
    <button
      key={key}
      type="button"
      onClick={() => setMode(key)}
      className={cn(
        'rounded-full border px-2.5 py-0.5 text-[11px] transition-colors',
        mode === key
          ? 'border-gold bg-raised text-gold-pale'
          : 'border-line text-fg-muted hover:border-line-2 hover:text-fg'
      )}
    >
      {label}
    </button>
  )

  return (
    <OptionsSection
      title="输出约束（体积 / 码率，二选一）"
      reason={reason}
      failedText={failed ? '没能设上——这条任务不接受输出约束，或它正在跑' : ''}
      busy={busy}
      canClear={current !== undefined}
      onApply={() => void apply()}
      onClear={() => void clear()}
    >
      <div className="mt-1.5 flex items-center gap-1.5">
        {modeButton('targetBytes', '目标体积')}
        {modeButton('bitrateKbps', '目标码率')}
      </div>

      {mode === 'targetBytes' ? (
        <div className="mt-2 flex items-center gap-2">
          <input
            type="text"
            inputMode="decimal"
            value={sizeText}
            aria-label="目标体积"
            onChange={(e) => setSizeText(e.target.value)}
            className="w-24 rounded border border-line bg-canvas px-2 py-1 font-mono text-xs text-fg outline-none focus:border-gold-dim"
          />
          <div className="flex items-center gap-1">
            {(['MB', 'KB'] as const).map((key) => (
              <button
                key={key}
                type="button"
                onClick={() => setUnit(key)}
                className={cn(
                  'rounded border px-2 py-0.5 text-[11px] transition-colors',
                  unit === key
                    ? 'border-gold bg-raised text-gold-pale'
                    : 'border-line text-fg-muted hover:border-line-2 hover:text-fg'
                )}
              >
                {key}
              </button>
            ))}
          </div>
        </div>
      ) : (
        <div className="mt-2 flex items-center gap-2">
          <input
            type="text"
            inputMode="numeric"
            value={rateText}
            aria-label="目标码率"
            onChange={(e) => setRateText(e.target.value)}
            className="w-24 rounded border border-line bg-canvas px-2 py-1 font-mono text-xs text-fg outline-none focus:border-gold-dim"
          />
          <span className="text-xs text-fg-faint">kbps</span>
        </div>
      )}

      <p className="mt-2 text-[11px] leading-relaxed text-fg-faint">
        {mode === 'targetBytes' ? (
          <>
            视频的体积目标要先把整片分析一遍再编（
            <span className="text-gold-pale">耗时接近翻倍</span>
            ），换来的是产物体积确实受控。图片改的是质量（二分搜索），音频直接按码率压。
            它要求引擎重新编码，所以与「无损裁剪」不能同时用——两者一起提交会被拒。
          </>
        ) : (
          <>
            直接指定码率（kb<span className="text-gold-pale">ps</span>
            ），单遍编码，比体积目标快得多。它同样要求重新编码，与无损裁剪互斥。
          </>
        )}
      </p>
    </OptionsSection>
  )
}
