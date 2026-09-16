import { targetsFor } from '@shared/formats'
import type { HistoryEntry, TaskOptions } from '@shared/types'
import { naturalOutputPath } from './outputName'

/**
 * 「重跑」的判定：从历史里挑出来的那些条目，逐条回答三件事——
 * **源文件还在不在**、**目标位置会不会盖掉已有产物**、**目标格式还合不合法**。
 *
 * ## 为什么要单独成一个模块
 *
 * 这件事的每一条判据都连着一次**不可逆的副作用**（挑错条目 = 白白重转一遍；
 * 漏判冲突 = 覆盖掉用户已有的产物）。而它是纯判定：`exists` 与 `outputDirFor`
 * 都是注入的，于是 `scripts/test-integration.ts` 能拿「20 条里 3 条坏」这种样本
 * 把它整条驱动一遍，并逐字比对那 17 个已成功的产物有没有被动过。
 *
 * ## 三条必须记住的规则
 *
 * 1. **先 stat 再入队**，而且「源文件已不在原处」要**逐条**说出来。
 *    不 stat 的话 `addPaths` 会逐条拒绝，但理由会变成「文件不存在或无法访问」——
 *    对重跑这个动作来说，「源文件已不在原处」才是用户需要看到的那句话。
 *
 * 2. **目标位置已有同名产物时，什么都不入队**，把冲突清单交回界面等用户选一次。
 *    这是全项目**唯一**会覆盖用户已有产物的入口，所以默认行为必须是「不动手」，
 *    而且要由主进程强制（而不是指望界面自觉弹框）。
 *
 * 3. **策略这一层只能改设置里那一项。** 每个任务的输出名由 `TaskManager.reserveOutput`
 *    按 `Settings.onConflict` 在**执行那一刻**算出来，没有「只对这一个任务生效」的旋钮。
 *    所以用户选了「覆盖」而当前设置是「另起一名」时，我们只能把设置改过去——
 *    但**必须如实上报**（`policyChanged`），界面要说出「已把「同名文件」设置改成…」。
 *    静默改设置的后果是：用户下次拖一批文件进来，行为莫名其妙地变了。
 */

/** 本次判定要用的冲突策略。**只有这两档**（`skip` 不是「换个名字写出去」） */
export type RerunPolicy = 'rename' | 'overwrite'

export interface RerunCandidate {
  id: string
  inputPath: string
  inputName: string
  toExt: string
  /**
   * 当初那条用的参数（裁剪等），**原样复现**。
   *
   * 「再行调律」的定义是「复现当初那一次操作」，而参数是那次操作的一半。
   * 不复现它的话，历史页上一行写着「裁 3.0s–8.0s」、点下去却出来一整段——
   * 正是这个文件头第 3 条在防的「静默换个结果」，只不过换的是长度而不是格式。
   */
  options?: TaskOptions
}

export interface RerunConflict {
  id: string
  inputName: string
  /** 那个已被占住的目标路径。界面要把它显示出来，用户才知道自己要覆盖的是什么 */
  outputPath: string
}

export interface RerunPlan {
  /** 判定通过、该入队的那些 */
  enqueue: RerunCandidate[]
  rejected: { path: string; reason: string }[]
  /** 非空 = **本次一条都不入队**，等用户在界面上选完策略再来 */
  conflicts: RerunConflict[]
  /** 这次动作会用到哪一档 */
  policy: RerunPolicy
  /** 设置里当前那一档（含 `skip`，它只影响比对，不是可选的动作） */
  previousPolicy: 'rename' | 'overwrite' | 'skip'
  /** `policy` 与 `previousPolicy` 不同 = 调用方要改设置，并且**必须**把这件事说出去 */
  policyChanged: boolean
}

export interface RerunOptions {
  /** 用户选定的策略。`null` = 还没选，此时遇到冲突就不入队 */
  conflict: RerunPolicy | null
  currentPolicy: 'rename' | 'overwrite' | 'skip'
  /** 注入而不是直接 `existsSync`：测试要能逐条记下「问过哪些路径」 */
  exists: (path: string) => boolean
  /** 输出目录的裁决者（`core/settings.ts` 的 `outputDirFor`）。同样注入 */
  outputDirFor: (inputPath: string) => string
}

export function planRerun(entries: readonly HistoryEntry[], options: RerunOptions): RerunPlan {
  const enqueue: RerunCandidate[] = []
  const rejected: { path: string; reason: string }[] = []
  const conflicts: RerunConflict[] = []

  for (const entry of entries) {
    // ---- 源文件还在不在。**必须排在入队之前**（见文件头第 1 条） ----
    if (!options.exists(entry.inputPath)) {
      rejected.push({ path: entry.inputPath, reason: '源文件已不在原处' })
      continue
    }

    if (entry.toExt.length === 0) {
      rejected.push({ path: entry.inputPath, reason: '这条痕迹没记下目标格式' })
      continue
    }

    if (!targetsFor(entry.fromExt).includes(entry.toExt)) {
      // 能力矩阵是静态的，当初转得成的现在基本仍然转得成，所以这条实际几乎走不到。
      // 正因为走不到，才要把话说清楚：宁可带理由拒绝，也不许降级成别的格式。
      rejected.push({ path: entry.inputPath, reason: `不再支持转为 ${entry.toExt}` })
      continue
    }

    // ---- 目标位置会不会盖掉已有产物 ----
    // 只在用户**还没选**的时候问。「本名」而不是「带序号的空闲名」：要问的正是
    // 「不加序号会写到哪」，那是 `naturalOutputPath` 存在的理由（略过模式同源）。
    if (options.conflict === null) {
      const outputPath = naturalOutputPath({
        inputPath: entry.inputPath,
        outputDir: options.outputDirFor(entry.inputPath),
        targetExt: entry.toExt
      })
      if (options.exists(outputPath)) {
        conflicts.push({ id: entry.id, inputName: entry.inputName, outputPath })
        continue
      }
    }

    enqueue.push({
      id: entry.id,
      inputPath: entry.inputPath,
      inputName: entry.inputName,
      toExt: entry.toExt,
      options: entry.options
    })
  }

  const policy: RerunPolicy =
    options.conflict ?? (options.currentPolicy === 'overwrite' ? 'overwrite' : 'rename')

  return {
    enqueue,
    rejected,
    conflicts,
    policy,
    previousPolicy: options.currentPolicy,
    // 没选过就不算改设置；选了且与当前不同才算
    policyChanged: options.conflict !== null && options.conflict !== options.currentPolicy
  }
}
