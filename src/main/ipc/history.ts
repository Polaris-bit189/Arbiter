import { existsSync } from 'fs'
import { ipcMain, shell } from 'electron'
import { CH, historyRerunSchema, idPayloadSchema } from '@shared/ipc-contract'
import type { RerunResult } from '@shared/ipc-contract'
import type { HistoryEntry } from '@shared/types'
import { clearHistory, getHistory, listHistory, removeHistory } from '../core/history'
import { planRerun } from '../core/rerun'
import { getSettings, outputDirFor, updateSettings } from '../core/settings'
import { getTaskManager } from './tasks'

/**
 * 历史记录的 IPC handler。
 *
 * 通道：`history:list` / `clear` / `remove` / `reveal` / `rerun`（见 `channels.ts`）。
 *
 * 入参一律先过 `@shared/ipc-contract` 的 schema（渲染进程是不可信输入）：
 * `historyRemove` / `reveal` / `rerun` 共用 `idPayloadSchema`。
 *
 * `historyRerun` 在主进程里一次做完「入队 + **复现当初的目标格式**」，**不拆成两个通道**：
 * `tasks:add` 只返回 `{ added, rejected }`、不返回新任务 id，渲染层无从知道
 * 该给哪一条设目标。详见 `channels.ts` 里那个通道的注释。
 *
 * 注意这里的目标格式取自**条目自身**（`entry.toExt`）而不是当前偏好：详见 `historyRerun`
 * 里的注释，那是这个动作的定义所在。
 *
 * 重跑（`historyRerun`）还有一条独有的规矩：**目标位置已有同名产物时什么都不入队**，
 * 先把冲突清单交回界面让用户选一次（覆盖 / 另存，默认另存）。它是全项目唯一会覆盖
 * 用户已有产物的入口，所以这条判断落在主进程，不指望界面自觉。判定本身在
 * `core/rerun.ts`——那里是纯函数，能拿「20 条里 3 条坏」这种样本整条驱动着测。
 */

/** `history:reveal` 的结果：产物仍在原处 / 原处已空。与 preload 暴露给渲染层的同名类型一致 */
type RevealResult = 'ok' | 'missing'

export function registerHistoryIpc(): void {
  ipcMain.handle(CH.historyList, () => listHistory())

  ipcMain.handle(CH.historyClear, () => clearHistory())

  ipcMain.handle(CH.historyRemove, (_event, raw) => {
    const parsed = idPayloadSchema.safeParse(raw)
    return parsed.success ? removeHistory(parsed.data.id) : false
  })

  ipcMain.handle(CH.historyReveal, (_event, raw): RevealResult => {
    const parsed = idPayloadSchema.safeParse(raw)
    if (!parsed.success) return 'missing'

    const outputPath = getHistory(parsed.data.id)?.outputPath
    // **`shell.showItemInFolder` 不会告诉你文件在不在**：路径不存在时它静默地
    // 什么都不做（也不抛错），于是界面永远只能显示「已打开」。要区分「打开了」与
    // 「原处已无此物」就必须自己先判一次存在性，这也正是这个通道要回字符串的原因。
    if (!outputPath || !existsSync(outputPath)) return 'missing'

    shell.showItemInFolder(outputPath)
    return 'ok'
  })

  /**
   * 「再行调律」：**单条与整批是同一个动作**（载荷收 id 列表）。
   *
   * 判定全在 `core/rerun.ts` 里（纯函数，能被逐条驱动着测），这里只做三件事：
   * 把 id 换成历史条目、按判定结果入队、以及**在用户没选过冲突策略时什么都不入队**。
   *
   * 最后一条是这条链路上最要紧的：重跑是全项目**唯一**会覆盖用户已有产物的入口，
   * 所以「先问一次」必须是主进程的硬性行为，而不是指望界面自觉弹框。
   */
  ipcMain.handle(CH.historyRerun, async (_event, raw): Promise<RerunResult> => {
    const parsed = historyRerunSchema.safeParse(raw)
    if (!parsed.success) {
      return {
        added: 0,
        rejected: [{ path: String(raw), reason: '参数非法' }],
        conflicts: [],
        policyChanged: false
      }
    }

    // 认不出来的 id 逐条说出来。静默丢掉的话，用户点「重跑失败项」之后
    // 会看到「收入 3 个」而实际少了两个——而他没有任何办法知道少了谁。
    const entries: HistoryEntry[] = []
    const rejected: RerunResult['rejected'] = []
    for (const id of parsed.data.ids) {
      const entry = getHistory(id)
      if (entry === null) {
        rejected.push({ path: id, reason: '这条痕迹已不在记录中' })
        continue
      }
      entries.push(entry)
    }

    const manager = getTaskManager()
    const plan = planRerun(entries, {
      conflict: parsed.data.conflict ?? null,
      currentPolicy: getSettings().onConflict,
      // 注入真实的存在性判断与输出目录裁决：这两个是 `core/rerun.ts` 与磁盘、与设置
      // 之间唯一的接触面，接在这里就等于把那边留成纯函数
      exists: (path) => existsSync(path),
      outputDirFor
    })

    if (plan.conflicts.length > 0) {
      // **一条都不入队。** 界面拿这份清单弹一次明确的选择（覆盖 / 另存，默认另存），
      // 用户选完带 `conflict` 再来一次。
      return {
        added: 0,
        rejected: [...rejected, ...plan.rejected],
        conflicts: plan.conflicts,
        policyChanged: false
      }
    }

    // 用户选的策略与设置里那一档不同时必须改设置——每个任务的输出名由
    // `TaskManager.reserveOutput` 按 `Settings.onConflict` 在执行那一刻算出来，
    // 没有「只对这一个任务生效」的旋钮。改了就要如实上报（`policyChanged`），
    // 界面得说出「已把「同名文件」改成…」，否则用户下次拖文件进来会发现行为变了。
    if (plan.policyChanged) updateSettings({ onConflict: plan.policy })

    if (plan.enqueue.length === 0) {
      return {
        added: 0,
        rejected: [...rejected, ...plan.rejected],
        conflicts: [],
        policyChanged: plan.policyChanged
      }
    }

    // 快照必须在 await **之前**取：`addPaths` 里有一次 `stat` 的 await，
    // 期间别的入队请求可能已经把自己的任务塞进 map 了。
    const before = new Set(manager.list().map((task) => task.id))
    const result = await manager.addPaths(plan.enqueue.map((item) => item.inputPath))

    // `addPaths` 只回计数、不回 id，所以靠前后差集把这次新加的认出来，
    // 再按 inputPath 对上判定里的目的一一对号入座。
    //
    // 这一步**不是**给默认裁决「补一刀」，而是**覆盖**它：`TaskManager.addPaths` 会按
    // 当前偏好填一个默认目标，而「再行调律」要的是条目上写着的那一个
    //（`resolveDefaultTarget` 算的是当前偏好，偏好一改结果就变——那正是本项目最忌讳的
    // 「静默换个结果」）。
    //
    // 参数（裁剪）同理一起复现：它是「当初那一次操作」的另一半，只还原格式不还原参数，
    // 结果就是「历史页写着裁了 5 秒、重跑出来的却是整段」。
    const wanted = new Map(plan.enqueue.map((item) => [item.inputPath, item]))
    for (const task of manager.list()) {
      if (before.has(task.id)) continue
      const desired = wanted.get(task.inputPath)
      if (desired === undefined) continue
      manager.setTarget(task.id, desired.toExt)
      // `addPaths` 造出来的任务没有参数，所以这里**无条件设一次**（含设成 undefined）：
      // 只在有参数时才调的话，`setOptions` 里那条「打回等待中」的语义会时有时无，
      // 而这条任务此刻本来就还没开跑，多一次 no-op 不会改变任何东西。
      manager.setOptions(task.id, desired.options)
    }

    return {
      added: result.added,
      rejected: [...rejected, ...plan.rejected, ...result.rejected],
      conflicts: [],
      policyChanged: plan.policyChanged
    }
  })
}
