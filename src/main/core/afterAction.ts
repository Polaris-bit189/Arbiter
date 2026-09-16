import { basename } from 'path'
import { AFTER_CONVERT_ACTIONS, type AfterConvertAction } from '@shared/types'
import type { AfterActionResult } from '@shared/ipc-contract'

/**
 * 「转换完成之后的动作」：把「去文件夹里找」那一步去掉。
 *
 * 卡片上只有「打开位置」时，用户想把产物发出去要走四步：
 * 显示 → 找到 → 右键复制 → 粘到别处。这里做的是把中间三步收成一次选择，
 * 而默认那一档**什么也不做**（见 `DEFAULT_AFTER_CONVERT`）。
 *
 * ## 三条承重的设计约束
 *
 * 1. **默认不动剪贴板。** 往剪贴板里写东西会覆盖用户此刻手里的内容，而且没有任何
 *    提示能让他知道。所以 `'none'` 这条路径上**一次 IO 都不做**（连 stat 都不做，
 *    见 `runAfterAction` 里那个提前返回）——它必须是一个能被反证的断言，
 *    而不是「读起来好像没动」。
 *
 * 2. **复制完必须说清楚复制的是什么，并给「再复制一次」。** 剪贴板随时会被别的程序
 *    抢走（这一类归因极难：用户看到的是「复制了，但粘出来是别的东西」），
 *    所以结果里带着产物名与路径，由界面说出来；重试就是同一个函数再调一次。
 *
 * 3. **产物太大就降级成复制路径，并把原因说出来。**
 *    「复制产物本身」走的是**文件引用**（`FileNameW` 格式），我们这边不复制数据，
 *    但目标程序（聊天 / 邮件客户端）会在粘贴那一刻把整个文件读进去再重编码。
 *    所以超过阈值时「把路径给对方」更常用，我们改做那一件事——并且**必须把
 *    降级这件事说出来**，否则用户看到的是「设置里选了复制产物，拿到的却是路径」，
 *    唯一的解释是「这个开关没生效」。
 *
 * 出口同样是注入式的（`AfterActionIo`）：真实的剪贴板在 Electron 的 `clipboard` 里，
 * 而这个模块要能在普通 Node 下被完整地驱动一遍（`scripts/test-integration.ts` 的 [9]）。
 */

/**
 * 「复制产物本身」的体积上限：8 MiB。
 *
 * 这个数字是**产品决策，不是技术限制**：走文件引用时我们并不搬运字节。
 * 定在 8 MiB 是因为它大致是「聊天工具里直接甩一个文件」与「甩一条路径/自己去拿」
 * 的分界——再往上，收件人那边多半是个大附件，而用户更可能想说的是位置。
 * 阈值只影响我们下手的那**一件事**，判错也只是多复制一条路径，不会丢东西。
 */
export const COPY_FILE_MAX_BYTES = 8 * 1024 * 1024

/** 动作的出口。测试里注入捕获器，生产里注入 Electron 的 clipboard / shell */
export interface AfterActionIo {
  copyText(text: string): void
  copyFile(path: string): void
  reveal(path: string): void
  /** 产物的真实体积。**文件不在就返回 null**——对着一个不存在的产物做动作是最坏的结果 */
  sizeOf(path: string): number | null
}

let io: AfterActionIo | null = null

/** 由 Electron 那一侧（`main/ipc/tasks.ts` 的 `registerTaskIpc`）注入 */
export function setAfterActionIo(next: AfterActionIo | null): void {
  io = next
}

export interface AfterActionPlan {
  /** 真正要执行的那一个 */
  action: AfterConvertAction
  /** 降级的原因（没降级则为 null） */
  degradeReason: string | null
}

/**
 * 纯粹的「该做什么」判定，不碰任何 IO。抽出来是为了能逐档喂尺寸进去测。
 *
 * 唯一会改写动作的情况：`copy-file` 且产物超过 `COPY_FILE_MAX_BYTES`
 *（尺寸未知时不降级——那是「文件在不在」的问题，由 `runAfterAction` 先挡掉）。
 */
export function planAfterAction(
  requested: AfterConvertAction,
  sizeBytes: number | null
): AfterActionPlan {
  if (requested === 'copy-file' && sizeBytes !== null && sizeBytes > COPY_FILE_MAX_BYTES) {
    return {
      action: 'copy-path',
      degradeReason: `产物 ${formatMiB(sizeBytes)} 偏大（超过 ${formatMiB(
        COPY_FILE_MAX_BYTES
      )}），已改为复制路径`
    }
  }
  return { action: requested, degradeReason: null }
}

/**
 * 判定并执行。**同步**：剪贴板与「在文件夹里显示」都是同步 API。
 *
 * 顺序上有一处承重：**先问尺寸，再决定动作**。反过来先执行、失败再补救的话，
 * 产物不在了也会先把一个坏路径写进剪贴板——那才是最坏的结果，因为用户拿到的
 * 是一句「已复制」，而粘出来什么都没有。
 */
export function runAfterAction(
  requested: AfterConvertAction,
  outputPath: string
): AfterActionResult {
  const base = {
    requested,
    action: requested,
    path: outputPath,
    name: basename(outputPath),
    sizeBytes: null as number | null,
    degradeReason: null as string | null
  }

  // 渲染进程是不可信输入：动作虽然由主进程从设置里读（不是载荷里来的），
  // 但设置文件本身可能被手改坏。不认识的档位必须**拒绝**，不能默默当成
  // 「什么都不做」——那样用户改坏了设置，现象是「点了没反应」，两端都查不出原因。
  if (!isAfterConvertAction(requested)) {
    return { ...base, ok: false, error: `不认识的动作：${String(requested)}` }
  }

  // ★ 默认那一档在这里就结束了：**一次 IO 都不做**（含 stat）。
  //   这是「默认设置下不动剪贴板」那条断言的落点，别把下面的 sizeOf 提到前面来。
  if (requested === 'none') {
    return { ...base, ok: true, error: null }
  }

  if (io === null) {
    return { ...base, ok: false, error: '剪贴板出口未注入' }
  }

  let sizeBytes: number | null
  try {
    sizeBytes = io.sizeOf(outputPath)
  } catch (error) {
    return { ...base, ok: false, error: describe(error) }
  }

  if (sizeBytes === null) {
    // 产物被挪走 / 删掉 / 还没落盘。**不动剪贴板**，并把原因说出来。
    return { ...base, ok: false, error: '产物已不在原处' }
  }

  const plan = planAfterAction(requested, sizeBytes)

  try {
    if (plan.action === 'copy-path') io.copyText(outputPath)
    else if (plan.action === 'copy-file') io.copyFile(outputPath)
    else if (plan.action === 'open-folder') io.reveal(outputPath)
  } catch (error) {
    return { ...base, action: plan.action, sizeBytes, ok: false, error: describe(error) }
  }

  return {
    ...base,
    action: plan.action,
    sizeBytes,
    degradeReason: plan.degradeReason,
    ok: true,
    error: null
  }
}

function isAfterConvertAction(value: string): value is AfterConvertAction {
  return (AFTER_CONVERT_ACTIONS as readonly string[]).includes(value)
}

/** `12.3 MB`。刻意不用 renderer 那份 `formatBytes`：它属于另一个进程，跨不过来 */
function formatMiB(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
