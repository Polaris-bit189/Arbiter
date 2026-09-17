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

/** 一个码对应的默认策略。单个错误可以在抛出时覆盖其中任何一项。 */
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
const POLICIES: Record<ErrorCode, ErrorPolicy> = {
  unknown_format: {
    retryable: false,
    next_steps: [
      '先确认源文件的扩展名在能力矩阵里：调 list_supported_formats（或读 converter://formats）',
      '路径必须带真实扩展名，别拿 .part / .tmp 这类中间文件去转'
    ]
  },
  target_not_supported: {
    retryable: false,
    next_steps: [
      '从返回值 hint.targets 里挑一个目标格式改调一次',
      '矩阵里没有的组合多半是实测过做不到，别用同一个目标重复试'
    ]
  },
  engine_missing: {
    retryable: false,
    next_steps: [
      '这条转换需要额外引擎，得请用户先在 Arbiter（调律者转换器）里下载它',
      '在那之前改用不需要该引擎的目标格式（hint 里有具体是哪个引擎）'
    ]
  },
  path_not_allowed: {
    retryable: false,
    next_steps: [
      '把路径改到 hint.roots 列出的目录里',
      '输出路径必须写成绝对路径，且它的**上级目录要已经存在**'
    ]
  },
  source_missing: {
    retryable: false,
    next_steps: [
      '核对路径拼写；以工具的返回值/hint 里的路径为准，不要自己拼',
      '确认这个文件确实还在（可能刚被移动或改名了）'
    ]
  },
  source_corrupt: {
    retryable: false,
    next_steps: [
      '读这次返回里的 log_tail —— 引擎的原始报错在那里，它才说得清是哪一步不对',
      '用 inspect_file 看看这个源还能不能被识别',
      '同一个源 + 同一个目标重试不会有不同结果，要换就换源或换目标格式'
    ]
  },
  output_conflict: {
    retryable: false,
    next_steps: [
      // 这条码有**两个真实变体**（`jobs.ts` 的 `resolveOutput`）：指向目录、以及指向一个
      // 已经存在的文件。第一句必须同时说中两个，否则按它去做会把 agent 引到错的方向上
      // ——「指向文件名、不是目录」对第二个变体是一句**已经做到了**的话。
      'output_path 要写成产物的完整路径（含文件名），而且那上面**当前不能有东西**',
      '换一个没被占用的路径；hint 里有冲突的那个路径'
    ]
  },
  canceled: {
    retryable: true,
    next_steps: ['任务是**被取消**的，不是失败；需要的话重新提交一次同样的转换']
  },
  unknown_job: {
    retryable: false,
    next_steps: [
      '用 list_jobs 拿一份当前登记的 job_id 清单（hint 里也带了一份）',
      'job_id 只在**当前这次 MCP 会话**里有效，换一个会话就是全新的登记表'
    ]
  },
  no_text_content: {
    retryable: false,
    next_steps: [
      '这份文档没有文本层（图片型 / 扫描件 PDF），本项目不含 OCR，**重试这个文件不会有不同结果**',
      '要看内容就用 convert_file 把它转成 png / jpg（一页一张图），交给能看图的客户端',
      '要拿到文字得先由用户对这份文件做一次 OCR'
    ]
  },
  not_readable: {
    retryable: false,
    next_steps: [
      'read_document 只读文档正文：docx / xlsx / pdf / md / txt / html / rst / csv',
      '音视频 / 图片 / 压缩包的信息用 inspect_file 查；要换格式用 convert_file',
      '需要重型引擎的类别（doc/xls/ppt/odt/ods 与电子书）改用 convert_file，并把要下载多大的引擎一并告诉用户'
    ]
  },
  internal: {
    retryable: true,
    next_steps: ['先原样重试一次', '连续两次同样失败就把这条错误的原文报给用户，不要自己反复重试']
  }
}

/** 码表本身，供测试与文档出口按集合断言（派生的，不另写一份字面量）。 */
export const ERROR_CODES = Object.keys(POLICIES) as ErrorCode[]

/** 取一个码的默认策略。码是闭集，所以这里不可能取不到。 */
export function policyFor(code: ErrorCode): ErrorPolicy {
  return POLICIES[code]
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
  const policy = POLICIES[code]
  return {
    code,
    retryable: known?.retryable ?? policy.retryable,
    next_steps: known?.nextSteps ?? policy.next_steps,
    ...(known?.hint === undefined ? {} : { hint: known.hint })
  }
}
