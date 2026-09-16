import { resolveDefaultTarget, targetsFor } from '@shared/formats'
import type { Category, HistoryEntry } from '@shared/types'

/**
 * 「上次这类文件转成了什么」——入队时的**预置**依据。
 *
 * 存在理由：类别级默认目标（设置页那六行）记的是「这一类我一般要什么格式」，
 * 而用户脑子里记的是更近的一层：「昨天我把这批 mkv 转成了 webm」。
 * 拖进来一屏文件、每个都要去改一次下拉，是这一步的全部摩擦。
 *
 * ## 三条硬规矩
 *
 * 1. **只预置，不执行。** 它改的是任务的目标格式，用户按「开始调律」才会真跑。
 *    本项目所有「自动」都该落在预置上——自动执行一个用户没确认过的格式，
 *    产出的东西可能是他完全不要的，而那时磁盘上已经多了一个文件。
 *
 * 2. **没有历史时静默回落到类别默认值**，绝不返回「空选中」。空选中会让
 *    「开始」按钮变灰（`toExt` 为空的任务根本起不来），而用户完全不知道为什么。
 *
 * 3. **推出来的格式必须过一遍能力矩阵。** 历史里那条 `mp4 → mkv` 与现在拖进来的
 *    源格式未必兼容（`mkv` 不能转 `mkv`），不校验就会造出一个不可能成功的任务。
 *    `resolveDefaultTarget` 就是这么做的，这里对它只做加法。
 */

export interface PresetChoice {
  toExt: string
  /** 这一档是**照历史预置的**（而不是类别默认值）——界面据此高亮并说一句「上次…」 */
  fromHistory: boolean
}

/**
 * 挑出这一次该给任务用的目标格式。返回 `null` 表示这个源格式压根没有出口
 * （能力矩阵为空），那种任务本来也起不来，与预置无关。
 *
 * `entries` 是**新→旧**排好的历史（主进程保证），所以 `find` 拿到的就是最近一次。
 */
export function presetTargetFor(
  input: { fromExt: string; category: Category },
  overrides: Partial<Record<Category, string>>,
  entries: readonly HistoryEntry[]
): PresetChoice | null {
  const fallback = resolveDefaultTarget(input.fromExt, overrides)
  if (fallback === null) return null

  // 只看**成功过**的条目：失败与中止那两条记录里的 `toExt` 是用户当时想转、
  // 而没转成的格式，拿它来预置等于把一次失败当成一次选择。
  //
  // 判据是「同类别」而不是「同扩展名」：用户记的是「视频都转 webm」，
  // 不是「mkv 才转 webm」。不同扩展名的合法性由下面那道 `targetsFor` 闸把住。
  const recent = entries.find(
    (entry) =>
      entry.category === input.category && entry.status === 'done' && entry.toExt.length > 0
  )

  if (recent === undefined) return { toExt: fallback, fromHistory: false }
  // 与默认值一致就不必高亮，也不必说「上次转成了 X」——那会变成天天挂在界面上的噪音
  if (recent.toExt === fallback) return { toExt: fallback, fromHistory: false }
  if (!targetsFor(input.fromExt).includes(recent.toExt)) {
    return { toExt: fallback, fromHistory: false }
  }

  return { toExt: recent.toExt, fromHistory: true }
}
