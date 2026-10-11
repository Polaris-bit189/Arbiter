/**
 * MCP 工具的错误形状。
 *
 * **与主进程那两个错误类型的分工**：`ConversionFailed` / `ConversionCanceled`
 * （`converters/common.ts`）说的是「引擎那边出了什么事」，是**给 UI 用的**——
 * `TaskManager` 会把 `logTail` 收进卡片、把 summary 显示成一行小字。
 * 这里说的是「这次工具调用为什么不能做」，是**给 agent 读的**：它没有卡片，
 * 只有一段文本，而且下一步要拿这段文本去决定「换个参数重试 / 换个格式 / 放弃」。
 *
 * 所以这一层唯一的设计要求是：**message 必须自足**。别写「参数非法」，
 * 要写清哪个参数、合法值是什么、以及**怎么改**——agent 读不到源码，也看不到 UI。
 *
 * ## 机器可读的那一半：`code` / `retryable` / `next_steps`
 *
 * 上面那条「message 自足」只解决了「人读得懂」，没解决「程序分得清」。原先 11 处
 * 抛出点全都长成「一句中文 + 一个 hint」，agent 要判断「这是文件坏了还是引擎没装」
 * 只能去读中文——而那正是**约束 23 第 3 条**记着的那个坑（`reg.exe` 的输出是 GBK，
 * 按文案判「键存不存在」在中文机器上整条路径静默失效）。三段中文换一个版本就漂移，
 * 而**分类判据必须落在结构化信号上**：我们自己的分支 + 引擎的退出码 + 阶段的归属。
 *
 * 于是每条错误都带一张小码表里的一个码，外加两个能直接驱动决策的字段：
 *
 *   - `code`        这件事属于哪一类。取值是 `ErrorCode` 那个联合，**闭集**。
 *   - `retryable`   **同样的参数再调一次，有没有可能不同结果**。它不是常量：
 *                   `source_corrupt` 一定是 `false`（同一个坏文件转多少次都一样），
 *                   `canceled` / `internal` 是 `true`。agent 靠它决定「自动重试」
 *                   还是「换个做法 / 直接报给用户」。
 *   - `next_steps`  下一步该做什么，短句列表。`hint` 给的是**数据**（合法目标清单、
 *                   允许的根目录），这里给的是**动作**，两者互补。
 *
 * ⚠️ **`log_tail` 一个字都没少。** 码表是加在它上面的一层，不是替掉它：
 * 引擎的 stderr 尾部是这个项目相对同类最有价值的一件东西，`source_corrupt`
 * 这类码只负责说「别重试了」，具体是哪一行报错仍然只有 `log_tail` 说得清。
 * 见 `server.ts` 的 `jobFailure`。
 */

import { tKey, type KeysOf } from '@shared/i18n'

/**
 * 错误码全集。**闭集**，且每一个都有真实的抛出点（见 `POLICIES` 的逐条说明）。
 *
 * 为什么不把码表开大一点（加上 `disk_full` / `permission_denied` 之类）：
 * 一个**永远不会被抛出**的码是一句谎话——agent 会为它写一条处理分支，
 * 而那条分支永远不会被触发，反而掩盖了真实的失败形态。加码之前先有抛出点。
 *
 * 具体到 `disk_full`：MCP 这一层**拿不到**「磁盘满了」这个信号。写盘失败在
 * `converters/common.ts` 的 `finalizeOutput` 里被统一包成了 `ConversionFailed`
 * （logTail 是我们自己写的那句话），errno 到不了这里；而靠 `logTail` 的文案去认
 * 正是上面禁止的那件事。要么在引擎适配层加一个结构化字段（那不属于 MCP 这条线），
 * 要么不加——选了后者。
 */
export type ErrorCode =
  /** 认不出源格式：没扩展名、不在能力矩阵里、或该源一个出口都没有。 */
  | 'unknown_format'
  /** 源格式认得出，但矩阵里没有这个「源 → 目标」组合。 */
  | 'target_not_supported'
  /** 这条路需要某个按需下载的引擎，本机没装（LibreOffice / pandoc / Calibre）。 */
  | 'engine_missing'
  /** 路径没过闸门：越界、落在写根之外、或父目录不存在。 */
  | 'path_not_allowed'
  /** 读路径指向的文件不存在。 */
  | 'source_missing'
  /** 引擎没能完成这次转换（非零退出码 / 产物是 0 字节）。**重试不会有不同结果**。 */
  | 'source_corrupt'
  /** 要写的那个位置被别的东西占着（典型是 `output_path` 给成了一个已存在的目录）。 */
  | 'output_conflict'
  /** 任务被取消（`cancel_job` 或客户端 `notifications/cancelled`）。 */
  | 'canceled'
  /** 引用了一个不存在的 job_id（记错、或跨会话用了旧的）。 */
  | 'unknown_job'
  /**
   * `read_document`：这个文件里**抽不出任何文字**（图片型 / 扫描件 PDF 没有文本层）。
   *
   * 与 `source_corrupt` 分开，是因为 agent 该做的事完全不同：源文件没坏、重试也没有意义，
   * 需要的是「换一条路」（转成图片交给能看图的客户端，或者让用户先做 OCR）。
   * 混进 `source_corrupt` 的话，agent 只能读那句中文才知道差别——
   * 而按文案分类正是本文件开头明令禁止的那件事。
   */
  | 'no_text_content'
  /**
   * `read_document`：这个格式没有「正文」可读（音视频 / 图片 / 压缩包），
   * 或者它属于这一版明确不做的重型类别。
   */
  | 'not_readable'
  /** 我们自己的内部不一致 / 意料之外的异常。**这是唯一「可能重试成功」的兜底**。 */
  | 'internal'

/**
 * 一个码对应的默认策略。单个错误可以在抛出时覆盖其中任何一项。
 *
 * ⚠️ 这是**译好之后**的形状：`next_steps` 是成品句子（给 agent 读的）。表里存的是
 * **键**，取词在 `policyFor()` 里发生——见下面 `POLICIES` 的说明。
 */
export interface ErrorPolicy {
  /** 同样的参数再调一次有没有可能不同结果。见文件头。 */
  retryable: boolean
  /** 下一步该做什么。**写给 agent 的动作**，不是数据（数据放 hint）。 */
  next_steps: string[]
}

/**
 * 码 → 默认策略。**这里是唯一的来源**：抛出点只给码，策略从这里取，
 * 免得同一种失败在十一处各写一句略有出入的 next_steps。
 *
 * `retryable` 的判据只有一句：**「同样的调用再来一次会不会有不同的结果」**。
 * 不是「严不严重」、也不是「能不能修好」：
 *   - `engine_missing` 是 `false`——用户装好引擎之前，重试一万次还是同一句拒绝。
 *     它当然**能**修好，但要用户去界面里点一下，那不是 agent 重试能等到的。
 *   - `path_not_allowed` / `source_missing` 是 `false`——要改参数，不是等一等。
 *   - `canceled` 是 `true`——取消是外部动作，重新提交一次同一个转换就是能做。
 */
/**
 * 码 → 默认策略。**这里是唯一的来源**：抛出点只给码，策略从这里取，
 * 免得同一种失败在十一处各写一句略有出入的 next_steps。
 *
 * ⚠️ **`next_steps` 存的是键，不是句子。** 这张表在 import 那一刻就求值，写 `t(…)`
 * 会让它永远停在启动时那门语言上——一条跑了很久的会话中途切语言，agent 拿到的
 * 还是旧那一门（与 `engines/status.ts` 的 `LABELS`、渲染层那些 `*_LABEL` 常量
 * 是同一个坑，见 `docs/NOTES.md` 约束 43）。取词只发生在 `policyFor()` 里，也就是
 * **每次调用时**按当前语言译一遍。
 *
 * `retryable` 的判据只有一句：**「同样的调用再来一次会不会有不同的结果」**。
 * 不是「严不严重」、也不是「能不能修好」：
 *   - `engine_missing` 是 `false`——用户装好引擎之前，重试一万次还是同一句拒绝。
 *     它当然**能**修好，但要用户去界面里点一下，那不是 agent 重试能等到的。
 *   - `path_not_allowed` / `source_missing` 是 `false`——要改参数，不是等一等。
 *   - `canceled` 是 `true`——取消是外部动作，重新提交一次同一个转换就是能做。
 */
const POLICIES: Record<
  ErrorCode,
  { retryable: boolean; next_steps: readonly KeysOf<'mcp.errors.'>[] }
> = {
  unknown_format: {
    retryable: false,
    next_steps: ['mcp.errors.unknown_format.confirmExt', 'mcp.errors.unknown_format.realExt']
  },
  target_not_supported: {
    retryable: false,
    next_steps: [
      'mcp.errors.target_not_supported.pickFromHint',
      'mcp.errors.target_not_supported.skipKnownImpossible'
    ]
  },
  engine_missing: {
    retryable: false,
    next_steps: [
      'mcp.errors.engine_missing.askUserToDownload',
      'mcp.errors.engine_missing.useOtherTarget'
    ]
  },
  path_not_allowed: {
    retryable: false,
    next_steps: [
      'mcp.errors.path_not_allowed.useAllowedRoot',
      'mcp.errors.path_not_allowed.absoluteOutput'
    ]
  },
  source_missing: {
    retryable: false,
    next_steps: [
      'mcp.errors.source_missing.checkSpelling',
      'mcp.errors.source_missing.confirmStillThere'
    ]
  },
  source_corrupt: {
    retryable: false,
    next_steps: [
      'mcp.errors.source_corrupt.readLogTail',
      'mcp.errors.source_corrupt.inspectSource',
      'mcp.errors.source_corrupt.noRetrySameTarget'
    ]
  },
  output_conflict: {
    retryable: false,
    next_steps: [
      // 这条码有**两个真实变体**（`jobs.ts` 的 `resolveOutput`）：指向目录、以及指向一个
      // 已经存在的文件。第一句必须同时说中两个，否则按它去做会把 agent 引到错的方向上
      // ——「指向文件名、不是目录」对第二个变体是一句**已经做到了**的话。
      'mcp.errors.output_conflict.fullFilePath',
      'mcp.errors.output_conflict.useFreePath'
    ]
  },
  canceled: {
    retryable: true,
    next_steps: ['mcp.errors.canceled.resubmit']
  },
  unknown_job: {
    retryable: false,
    next_steps: ['mcp.errors.unknown_job.listJobs', 'mcp.errors.unknown_job.sessionScoped']
  },
  no_text_content: {
    retryable: false,
    next_steps: [
      'mcp.errors.no_text_content.noTextLayer',
      'mcp.errors.no_text_content.convertToImage',
      'mcp.errors.no_text_content.needsOcr'
    ]
  },
  not_readable: {
    retryable: false,
    next_steps: [
      'mcp.errors.not_readable.supportedBodies',
      'mcp.errors.not_readable.useInspectOrConvert',
      'mcp.errors.not_readable.heavyEngines'
    ]
  },
  internal: {
    retryable: true,
    next_steps: ['mcp.errors.internal.retryOnce', 'mcp.errors.internal.reportToUser']
  }
}

/** 码表本身，供测试与文档出口按集合断言（派生的，不另写一份字面量）。 */
export const ERROR_CODES = Object.keys(POLICIES) as ErrorCode[]

/**
 * 取一个码的默认策略。码是闭集，所以这里不可能取不到。
 *
 * **取词发生在这里**（每次调用时按当前语言译一遍）——`POLICIES` 里存的是键，
 * 理由见它上面那段。返回的是一个新对象：调用方改了它不会污染码表。
 */
export function policyFor(code: ErrorCode): ErrorPolicy {
  const policy = POLICIES[code]
  return {
    retryable: policy.retryable,
    next_steps: policy.next_steps.map((key) => tKey(key))
  }
}

/** 抛出时可覆盖的东西。三项都可选：不给就取 `POLICIES` 里那份。 */
export interface ErrorOptions {
  code?: ErrorCode
  retryable?: boolean
  next_steps?: string[]
}

export class McpToolError extends Error {
  readonly code: ErrorCode | undefined
  readonly retryable: boolean | undefined
  readonly nextSteps: string[] | undefined

  constructor(
    message: string,
    /** 给 agent 的结构化补充（比如候选路径、支持的格式清单）。序列化进工具结果。 */
    readonly hint?: Record<string, unknown>,
    options: ErrorOptions = {}
  ) {
    super(message)
    this.name = 'McpToolError'
    this.code = options.code
    this.retryable = options.retryable
    this.nextSteps = options.next_steps
  }
}

/** 路径没通过闸门（越界、不存在、不是文件）。`hint` 里带上允许的根目录。 */
export class PathNotAllowed extends McpToolError {
  constructor(message: string, hint?: Record<string, unknown>, options: ErrorOptions = {}) {
    // 码在这里定死：`paths.ts` 只管说「什么路径、为什么」，分类只此一处。
    super(message, hint, { code: 'path_not_allowed', ...options })
    this.name = 'PathNotAllowed'
  }
}

/** 把任意 throw 出来的东西压成一句能给 agent 看的话。 */
export function describeError(error: unknown): string {
  if (error instanceof McpToolError) return error.message
  if (error instanceof Error) return error.message
  return String(error)
}

/** 工具结果里那段机器可读的部分。见文件头。 */
export interface FailureFields {
  code: ErrorCode
  retryable: boolean
  next_steps: string[]
  /** 原样透传，**不合并进上面三项**：agent 关心的是键名（`targets` / `known_job_ids`）。 */
  hint?: Record<string, unknown>
}

/**
 * 把任意 throw 出来的东西摊成 `FailureFields`。
 *
 * 三件必须记住的：
 *
 *  1. **不是 `McpToolError` 的一律算 `internal`。** 走到这里说明某处代码直接
 *     抛了原生异常（比如 `fs` 的 errno）——那是我们**没预料到**的形态，
 *     而 `internal` 的 `retryable` 是 `true`，正好对应「不知道原因、值得再试一次」。
 *     绝对不要退化成「抛出的都算某种业务错误」：那会把真 bug 伪装成 agent 参数问题。
 *  2. **没给码的 `McpToolError` 也算 `internal`**，理由同上。所以每个抛出错的地方
 *     都该显式给码——这是「加一处抛出点就必须想清楚它属于哪一类」的执行方式。
 *  3. 三项**都是必填**（不给就是默认值），不是可选的：agent 侧不该出现
 *     「有时有 code 有时没有」这种形状，那比没有更难用。
 */
export function failureOf(error: unknown): FailureFields {
  const known = error instanceof McpToolError ? error : null
  const code: ErrorCode = known?.code ?? 'internal'
  const policy = policyFor(code)
  return {
    code,
    retryable: known?.retryable ?? policy.retryable,
    next_steps: known?.nextSteps ?? policy.next_steps,
    ...(known?.hint === undefined ? {} : { hint: known.hint })
  }
}
