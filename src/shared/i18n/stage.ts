import { tKey, tZh } from './index'
import type { MsgKey, StageRef } from './types'

// 契约类型住在 `types.ts`（`TaskProgress` 要用它，而那一层不该 import 带函数的模块）。
// 这里再导出一层，是为了让调用方只认 `@shared/i18n/stage` 一个路径。
export type { StageRef } from './types'

/**
 * `progress.stage` 的**码**：一个键加一组参数，而不是一句成品句子。
 *
 * ## 为什么它必须是码
 *
 * 阶段文案是**B 类**文本——**跨时间传递、而且会被重新渲染到界面上**。
 * 产出它的是转换进程，显示它的是渲染层的任务卡片，中间隔着主进程的状态机与一条 IPC
 * 通道。别处的文案（对话框、引擎名、扫描报告）都是「当次生成、当次显示」，语言一变
 * 自然就变了；这一族不是：**一个跑了两小时的转码，中途把界面切到英文，
 * 卡片上那行字要跟着变**。
 *
 * 只发一句成品句子的话，它就被冻在**产出它的那一刻**那门语言上了。
 *
 * ## 两个字段同时给，而且都从这里出
 *
 * | 字段 | 谁读 | 是哪门语言 |
 * | --- | --- | --- |
 * | `stage` | MCP 的线上格式、`test-tasks` 的断言、卡片的老路径 | **恒为中文** |
 * | `stageRef` | 渲染层（切语言时重新 `t()` 一次） | 跟着当前语言 |
 *
 * `stage` 恒为中文是**刻意的**：它是 `JobRegistry` 的 `progressKey` 的一部分，
 * 也是一批既有断言的比对对象。让它跟着 locale 走，等于让同一台机器上 agent 看到的行为面
 * 随操作系统语言变化——而那是一条没人会去测的分歧。
 *
 * ⚠️ **两者由同一个函数产出**，所以「码里有、兜底文本里没有」这种漂不可能发生。
 * 谁要是绕过 `stagePair()` 直接拼一句 `stage`，那条漂就回来了——反证里有一条专门盯它。
 */
/**
 * 产线**唯一**该用的入口：给一个码，回一对「码 + 中文兜底文本」。
 *
 * 用 `tZh` 而不是 `t`：兜底文本要的是**中文**，与当前 locale 无关（见上面那张表）。
 * 而 `tZh` 与 `t` 读的是**同一张表**，所以「同一个码在两处渲染出不同的字」不可能发生。
 */
export function stagePair(ref: StageRef): { stage: string; stageRef: StageRef } {
  return {
    stage: tZh(ref.key, ref.params ?? {}),
    stageRef: ref
  }
}

/**
 * 渲染层把码翻成**当前语言**的句子。
 *
 * 与 `stagePair` 分开，是因为渲染层**每次渲染都要重新翻**（那正是这一整套存在的理由），
 * 而产线那一次只翻一遍给兜底用。
 *
 * `ref` 缺失时回落到 `fallback`（也就是 `stage` 那个字段）：老任务的进度对象、
 * 或者将来某个忘了带码的生产者，都不该在卡片上显示一片空白。**这条兜底是承重的**——
 * 少了它，一次漏带 `stageRef` 就变成用户看到一个空白的状态列。
 */
export function stageText(ref: StageRef | undefined, fallback: string): string {
  if (ref === undefined) return fallback
  return tKey(ref.key, ref.params ?? {})
}

/** 给别处做类型标注用：一个「取词函数」的形状（`tKey` 就是它的实例）。 */
export type TranslateFn = (key: MsgKey, params?: Record<string, string | number>) => string
