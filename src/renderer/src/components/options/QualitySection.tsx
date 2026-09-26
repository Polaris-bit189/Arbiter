import { useState } from 'react'
import { t } from '@shared/i18n'
import type { EncodePreset, EncodeTune, QualityOptions, Task } from '@shared/types'
import { ENCODE_PRESETS, ENCODE_TUNES } from '@shared/types'
import {
  DEFAULT_CRF,
  DEFAULT_PRESET,
  MAX_CRF,
  MIN_CRF,
  QUALITY_OUTPUT_EXCLUSIVE,
  supportsQuality,
  withOption
} from '@shared/options'
import { useTasks } from '../../store/useTasks'
import { OptionsSection } from './OptionsSection'

/**
 * 「编码质量档」那一块：恒定质量（CRF）+ 速度档（preset）+ 调优（tune）。
 *
 * 三件套的形状取自 HandBrake 的 Video 页——不是因为它是标准，而是因为**这三件事
 * 本来就是独立的三个旋钮**，而本项目在此之前只暴露过「目标体积 / 目标码率」。
 *
 * ## ⚠️ 这一块与「输出约束」互斥，而且那句话是**写死的**
 *
 * 设了体积/码率目标就不能再有质量档。互斥的理由不是洁癖：`-crf` 与 `-b:v` 同时出现时
 * x264 会回到**质量模式**、把 `-b:v` 只当上限，产物体积与目标彻底脱钩**而任务报成功**。
 * 文案取 `@shared/options` 的 `QUALITY_OUTPUT_EXCLUSIVE`，与引擎抛出来的是同一句。
 *
 * 这里刻意**不做「设了这一个就自动清掉那一个」**：那是在用户的另一个设置上做静默写操作，
 * 而本项目最忌讳的就是「我明明设了 X，它悄悄给我变成了 Y」。所以改成**说清楚**
 * ——把「应用」禁掉、把理由写在面板上、告诉用户去清掉哪一块。
 *
 * ## ⚠️ 「越慢的预设体积越小」是**错的**，界面文案不能这么写
 *
 * 本机实测（真实照片推镜的 640x640 片段，crf 23 固定，3 次取中位）：
 *
 * | preset    | 时间  | 体积    | SSIM   |
 * | --------- | ----- | ------- | ------ |
 * | ultrafast | 81 ms | 812.6KB | 0.9791 |
 * | veryfast  | 118ms | 213.4KB | 0.9802 |
 * | fast      | 171ms | 290.9KB | 0.9861 |
 * | medium    | 199ms | 259.7KB | 0.9860 |
 * | veryslow  | 667ms | 233.6KB | 0.9856 |
 *
 * 体积**不是单调的**（`veryfast` 反而最小），画质是（`veryfast` 最差）。
 * 换句话说同一个 CRF 数字在不同预设下**不是同一个画质**——所以这两者不能互相换算，
 * 下面那段提示只承诺时间与「同一 CRF 下的画质/体积权衡」，一个字都不提「会更小」。
 *
 * ## 校验
 *
 * 与 `TrimSection` / `OutputSection` / `FiltersSection` 三条规矩逐字相同：
 * 用 `Number()` 而不是 `parseFloat()`（后者只解前缀，`'1.5.5'` → `1.5`，
 * 用户拿到一个与他输入不一致的参数）、空串单独判（`Number('')` 是 `0` 不是 `NaN`）、
 * 先「填了没」再「是不是数」最后才是范围。判据与 schema 共用同一组常量
 * （`MIN_CRF` / `MAX_CRF`），但主进程那一道**照旧独立生效**——渲染层是不可信输入。
 */
export function QualitySection({ task }: { task: Task }): React.JSX.Element {
  const setOptions = useTasks((s) => s.setOptions)

  const current = task.options?.quality
  const [crfText, setCrfText] = useState(
    current?.crf !== undefined ? String(current.crf) : String(DEFAULT_CRF)
  )
  const [preset, setPreset] = useState<EncodePreset>(current?.preset ?? DEFAULT_PRESET)
  /** 空串 = 不传 `-tune`。用 `''` 而不是 `undefined` 才能直接喂给 `<select>` 的 value */
  const [tune, setTune] = useState<EncodeTune | ''>(current?.tune ?? '')
  const [busy, setBusy] = useState(false)
  /** 上一次「应用」到底成没成。主进程静默不办，所以**必须**有一条回执 */
  const [failed, setFailed] = useState(false)

  const crfReason: string | null = ((): string | null => {
    const raw = crfText.trim()
    if (raw === '') return t('options.quality.reasonEmpty')
    const value = Number(raw)
    if (!Number.isFinite(value)) return t('options.common.reasonNotNumber')
    if (!Number.isInteger(value)) return t('options.quality.reasonInteger')
    if (value < MIN_CRF || value > MAX_CRF)
      return t('options.quality.reasonRange', { min: MIN_CRF, max: MAX_CRF })
    return null
  })()

  /**
   * 出口不支持时的理由。
   *
   * 判据是 `supportsQuality(task.toExt)`——**与主进程 `setOptions` 和引擎读的是同一个
   * 函数**。在这里另写一句 `task.toExt === 'webm'` 的话，两处漂了的表现是
   * 「界面上能设、转换时才报错」，或者更糟：界面上禁掉了一个其实能用的出口。
   *
   * 目标格式在参数设完之后还能改（`setTarget` 不碰 `options`），所以这一段**每帧重算**，
   * 不是初始化一次就算完——用户把 mp4 改成 webm 之后必须当场看见这句话。
   */
  const exitReason: string | null = supportsQuality(task.toExt)
    ? null
    : t('options.quality.exitLead', { ext: task.toExt }) +
      (task.toExt === 'webm' ? t('options.quality.exitWebm') : t('options.quality.exitGif'))

  const conflictReason: string | null =
    task.options?.output === undefined ? null : QUALITY_OUTPUT_EXCLUSIVE

  const reason = crfReason ?? exitReason ?? conflictReason

  const apply = async (): Promise<void> => {
    if (reason !== null || busy) return
    const quality: QualityOptions = {
      crf: Number(crfText.trim()),
      preset,
      // 空串表示「不调优」：**不能交出 `tune: ''`**，那会被 schema 拒掉，
      // 而用户看到的是「点了应用什么都没发生」。
      ...(tune === '' ? {} : { tune })
    }

    setBusy(true)
    // ⚠️ `withOption` 而不是 `{ quality }`：`setOptions` 是**整体替换**语义，
    // 只交这一项的话，用户先前设好的裁剪、处理链与输出约束会被这块面板静默抹掉。
    const ok = await setOptions(task.id, withOption(task.options, { quality }) ?? null)
    setBusy(false)
    // 主进程**静默**不办（任务在跑 / 出口不支持 / 与输出约束打架），所以必须说出来
    setFailed(!ok)
  }

  const clear = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    await setOptions(task.id, withOption(task.options, { quality: undefined }) ?? null)
    setBusy(false)
    setFailed(false)
  }

  return (
    <OptionsSection
      title={t('options.quality.title')}
      reason={reason}
      failedText={failed ? t('options.quality.failed') : ''}
      busy={busy}
      canClear={current !== undefined}
      onApply={() => void apply()}
      onClear={() => void clear()}
    >
      <div className="mt-2 flex items-center gap-2">
        <span className="w-14 shrink-0 text-[11px] text-fg-muted">
          {t('options.quality.labelCrf')}
        </span>
        <input
          type="text"
          inputMode="numeric"
          value={crfText}
          aria-label={t('options.quality.crfAria')}
          onChange={(e) => setCrfText(e.target.value)}
          className="w-20 rounded border border-line bg-canvas px-2 py-1 font-mono text-xs text-fg outline-none focus:border-gold-dim"
        />
        <span className="text-[11px] text-fg-faint">
          {t('options.quality.crfHintLead')}
          {MIN_CRF}~{MAX_CRF}
          {t('options.quality.crfHintMid')}
          {DEFAULT_CRF}
          {t('options.quality.crfHintTail')}
        </span>
      </div>

      <div className="mt-2 flex items-center gap-2">
        <span className="w-14 shrink-0 text-[11px] text-fg-muted">
          {t('options.quality.labelPreset')}
        </span>
        <select
          className="select-dark"
          aria-label={t('options.quality.presetAria')}
          value={preset}
          onChange={(e) => setPreset(e.target.value as EncodePreset)}
        >
          {ENCODE_PRESETS.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
      </div>

      <div className="mt-2 flex items-center gap-2">
        <span className="w-14 shrink-0 text-[11px] text-fg-muted">
          {t('options.quality.labelTune')}
        </span>
        <select
          className="select-dark"
          aria-label={t('options.quality.tuneAria')}
          value={tune}
          onChange={(e) => setTune(e.target.value as EncodeTune | '')}
        >
          <option value="">{t('options.quality.tuneNone')}</option>
          {ENCODE_TUNES.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
      </div>

      {/* 这一段是「一句话 + 四处内联强调」，而字典的粒度是文本片段（扫描器按花括号与
          尖括号切开），所以它是 presetHintA 到 presetHintH 八条拼出来的。
          片段之间那些空格不是装饰：拉丁字母与汉字之间本来就有空格，
          而字典值两侧不能带空格（闸门 d 对 JSX 文本先 trim 再比），
          所以空格只能留在源码这一侧。⚠️ 别把它们排到行首行尾——JSX 会吃掉
          带换行的首尾空白，那个空格就没了（`{' '}` 也会被 Prettier 归一成空格）。 */}
      <p className="mt-2 text-[11px] leading-relaxed text-fg-faint">
        <span className="text-gold-pale">{t('options.quality.presetHintA')}</span>
        {t('options.quality.presetHintB')} <span className="font-mono">veryfast</span>{' '}
        {t('options.quality.presetHintC')} <span className="font-mono">medium</span>{' '}
        {t('options.quality.presetHintD')} <span className="font-mono">veryfast → veryslow</span>{' '}
        {t('options.quality.presetHintE')} <span className="font-mono">fast</span>{' '}
        {t('options.quality.presetHintF')}
        <span className="font-mono">placebo</span> {t('options.quality.presetHintG')}{' '}
        <span className="font-mono">veryfast</span> {t('options.quality.presetHintH')}
      </p>
      <p className="mt-1 text-[11px] leading-relaxed text-fg-faint">
        {t('options.quality.encodeHint')}
      </p>
    </OptionsSection>
  )
}
