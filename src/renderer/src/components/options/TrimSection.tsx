import { useState } from 'react'
import { TRIM_MODES, type Task, type TrimMode, type TrimOptions } from '@shared/types'
import { MAX_TRIM_SEC } from '@shared/trim'
import { withOption } from '@shared/options'
import { useTasks } from '../../store/useTasks'
import { cn } from '../../lib/cn'
import { OptionsSection } from './OptionsSection'

/**
 * 裁剪参数那一块。
 *
 * ## 三件事是这块面板的承重结构
 *
 * 1. **无损那句提示是常驻的，不是 tooltip。** 无损裁剪的起点一定落在最近的关键帧上
 *    （`-ss` 放在 `-i` 之前的行为，见 `engines/ffmpeg.ts`），也就是说用户要
 *    `3.0–8.0` 拿到的可能是 `2.0–8.0`。这是功能行为的一部分，必须在**做选择的那一刻**
 *    写在明面上。藏在 tooltip 里等于没说。
 * 2. **非法输入不靠主进程兜底。** 主进程对非法参数是静默不办的（schema 直接拒），
 *    而「点了应用什么都没发生」是这个项目最不能接受的形态，所以这里自己判一次、
 *    把按钮禁掉并**说清为什么**。判据与 schema 是同一组数（`MAX_TRIM_SEC` 共用），
 *    但主进程那一道**照旧独立生效**——渲染层是不可信输入。
 * 3. **模式默认是「精确」。** 无损更快、不损画质，但它的起点不准；
 *    默认给「精确」= 默认给用户**他填的那个区间**，无损是他为了速度做的显式取舍。
 *    （反过来默认无损的话，用户第一次用就会遇到「我要 3 秒，它给了我 2 秒」。）
 */
export function TrimSection({ task }: { task: Task }): React.JSX.Element {
  const setOptions = useTasks((s) => s.setOptions)

  const current = task.options?.trim
  const [start, setStart] = useState(current ? String(current.start) : '0')
  const [end, setEnd] = useState(current ? String(current.end) : '10')
  const [mode, setMode] = useState<TrimMode>(current?.mode ?? 'exact')
  const [busy, setBusy] = useState(false)
  /** 上一次「应用」到底成没成。主进程静默不办，所以**必须**有一条回执 */
  const [failed, setFailed] = useState(false)

  /**
   * 校验。三条规矩都是刻意的：
   *
   * - **用 `Number()` 而不是 `Number.parseFloat()`。** 后者只解前缀：`'1.5.5'` → `1.5`，
   *   于是用户打错了却拿到一个**与他输入不一致**的参数，而界面上没有任何东西提示。
   *   `Number()` 对同一串给 `NaN`，被下面那句挡下来。
   * - **空串单独判。** `Number('')` 是 `0` 而不是 `NaN`，两个空格子会一路走到
   *   「终点必须大于起点」上——那句提示对着两个空格子说，用户不知道该改哪里。
   * - **顺序**：先「填了没」、再「是不是数」、最后才是区间。反过来的话，
   *   空输入落到的永远是区间那条。
   */
  const reason: string | null = ((): string | null => {
    const rawStart = start.trim()
    const rawEnd = end.trim()
    if (rawStart === '' || rawEnd === '') return '起点与终点都要填'

    const parsedStart = Number(rawStart)
    const parsedEnd = Number(rawEnd)
    if (!Number.isFinite(parsedStart) || !Number.isFinite(parsedEnd))
      return '只能填数字（单位是秒）'
    if (parsedStart < 0 || parsedEnd < 0) return '时间不能是负数'
    if (parsedEnd <= parsedStart) return '终点必须大于起点'
    if (parsedEnd > MAX_TRIM_SEC) return `终点不能超过 ${MAX_TRIM_SEC} 秒（24 小时）`
    return null
  })()

  // 只有校验通过时才取数，避免把 `NaN` 带进下一句
  const wanted = reason === null ? { start: Number(start), end: Number(end) } : null

  const apply = async (): Promise<void> => {
    if (wanted === null || busy) return
    setBusy(true)
    const trim: TrimOptions = { start: wanted.start, end: wanted.end, mode }
    // ⚠️ `withOption` 而不是 `{ trim }`：`setOptions` 是**整体替换**语义，
    // 只交这一项的话，用户先前设好的目标体积会被这块面板静默抹掉。
    const ok = await setOptions(task.id, withOption(task.options, { trim }) ?? null)
    setBusy(false)
    // 主进程**静默**不办（例如这条任务其实不该有裁剪），所以这里必须把它说出来，
    // 否则「点了应用、卡片上也没多出一行」会被当成按钮坏了。
    setFailed(!ok)
  }

  const clear = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    await setOptions(task.id, withOption(task.options, { trim: undefined }) ?? null)
    setBusy(false)
    setFailed(false)
  }

  return (
    <OptionsSection
      title="裁剪区间（秒）"
      reason={reason}
      failedText={failed ? '没能设上——这条任务不接受裁剪参数' : ''}
      busy={busy}
      canClear={current !== undefined}
      onApply={() => void apply()}
      onClear={() => void clear()}
    >
      <div className="mt-1.5 flex items-center gap-2">
        <input
          type="text"
          inputMode="decimal"
          value={start}
          aria-label="起点（秒）"
          onChange={(e) => setStart(e.target.value)}
          className="w-24 rounded border border-line bg-canvas px-2 py-1 font-mono text-xs text-fg outline-none focus:border-gold-dim"
        />
        <span className="text-xs text-fg-faint">起</span>
        <input
          type="text"
          inputMode="decimal"
          value={end}
          aria-label="终点（秒）"
          onChange={(e) => setEnd(e.target.value)}
          className="w-24 rounded border border-line bg-canvas px-2 py-1 font-mono text-xs text-fg outline-none focus:border-gold-dim"
        />
        <span className="text-xs text-fg-faint">止</span>
      </div>

      <div className="mt-2 flex items-center gap-1.5">
        {TRIM_MODES.map((key) => (
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
            {key === 'lossless' ? '无损（不重编码）' : '精确（重新编码）'}
          </button>
        ))}
      </div>

      {/* 无损模式的**行为说明**。它说的是「你会多拿到一段开头」，不是一句免责声明，
          所以放在这里常驻，而不是包成 tooltip 或者只在第一次用时弹一次。 */}
      <p className="mt-2 text-[11px] leading-relaxed text-fg-faint">
        {mode === 'lossless' ? (
          <>
            无损裁剪一个字节都不重编，所以它只能在关键帧上落刀：起点会对齐到最近的关键帧，
            <span className="text-gold-pale">可能比你要的早一点</span>
            （最多早一个关键帧间隔），终点不受影响。另外它要求源里的编解码器能原样装进目标
            容器（比如 h264 就进不了 webm），装不下时任务会失败并让你改用精确模式——
            不会背着你偷偷重编一遍。
          </>
        ) : (
          <>精确裁剪会重新编码（H.264 + AAC），帧级准确，画质会有一次损失，耗时也长得多。</>
        )}
      </p>
    </OptionsSection>
  )
}
