/**
 * MCP 工具的输入定义。**一份定义，三个出口**。
 *
 * 为什么非要挤在一个文件里：MCP 的 `inputSchema` 与 OpenAI 的 function calling
 * 要的是同一件事——「这个工具的入参长什么样」。各写一份的话，加一个参数时总有一边漏掉，
 * 而漏掉的那一侧**不报错**：agent 只是永远传不进那个参数，看上去像模型不会用工具。
 * 所以三者全部由 `TOOL_SCHEMAS` 派生，`jsonSchemas()` 走 zod v4 自带的 `toJSONSchema()`
 * （**不要再引 `zod-to-json-schema`**，那是个多余的依赖），`openAiTools()` 再包一层。
 * `scripts/test-mcp-view.ts` 里那条「三者键集完全一致」就是钉这件事的。
 *
 * 本文件**只描述形状，不执行任何东西**：工具真正干什么由 MCP server 那一层实现。
 * `src/mcp/` 下不许出现 electron——server 跑在普通 Node 进程里，依赖图里任何一处
 * electron 都会让用户装上之后第一次调用就崩，而 typecheck 与别的套件一条都不会红
 * （它们在 Electron 桩或真 Electron 里跑）。见 `scripts/test-mcp-view.ts` 的封锁断言。
 *
 * ## ⚠️ P6：为什么每个 schema 与整张 `TOOL_DESCRIPTIONS` 都是**工厂 / getter**
 *
 * 说明书与字段描述现在都从 `@shared/i18n` 取词，而 i18n 是**模块级的一份全局**，
 * MCP 进程的语言是**启动之后**才从设置里读出来的（`mcp/main.ts` 的 `applyLocale()`）。
 * import 永远跑在它前面——`src/mcp/main.ts` 里那句 `applyLocale()` 在函数体里，
 * 而静态 import 是在模块体之前求值的。所以写成普通常量的话，这些句子会在
 * **那一刻**被求值并**永久停在默认的中文**上：用户把语言设成英文，agent 拿到的
 * 仍是中文，而且**没有任何地方会报错**（typecheck、闸门、既有断言全都看不出来）。
 *
 * 判据是「谁在读、读的时候语言定了没有」：`server.ts` 注册工具、`jsonSchemas()` /
 * `openAiTools()` 都是启动**之后**才读，所以让它们各取各的当前语言：
 * 字段形状放 `fieldSchemas`（getter）、每个工具的 schema 写成工厂函数、
 * `TOOL_SCHEMAS` 与 `TOOL_DESCRIPTIONS` 用 getter 暴露。同一个坑在 P2 的
 * `MENU_LABEL` / `STATUS_META` 上已经踩过一次（`docs/NOTES.md` 约束 43）。
 *
 * 代价是每次访问都重建一个 zod 对象：全在启动与注册那几条路上，一次八个，可以忽略。
 * **加新工具时别退回普通常量**：那是这一整节唯一要守的东西。
 */
import { z } from 'zod'

import { t } from '@shared/i18n'
import { CATEGORIES } from '@shared/types'

/**
 * 目标扩展名的保留字：**用应用里配置的默认目标格式**，不是「让工具自己猜一个」。
 *
 * 语义只有一条：走 `shared/formats.ts` 的 `resolveDefaultTarget()`（它叠用户偏好
 * **并且再过一遍 `targetsFor` 校验**）。**不许在这里加任何「智能猜测」**——
 * 「这段视频是发微信的所以转小一点」那种推断，与整个项目「不做用户没要的事」
 * 的价值主张是冲突的。`auto` 的全部含义就是**用户自己在设置里选过的偏好**。
 *
 * 定义在这个文件里（而不是 `jobs.ts`）是为了让依赖方向只有一条：
 * `jobs.ts` → `schema.ts`。反过来会让 `schema.ts` 把主进程那一整条链
 * （`converters/` → 引擎 → `core/settings`）拖进 `test-mcp-view.ts` 的依赖图，
 * 那条「src/mcp 的依赖图里没有 src/main」的断言当场翻红——那条断言是这个进程
 * 能脱开 Electron 存在的验收判据之一。
 */
export const AUTO_TARGET = 'auto'

/**
 * 扩展名统一口径：小写、不带点。**目标**那一侧额外认一个保留字 `auto`。
 *
 * 这里刻意**不加正则**（`^[a-z0-9]+$` 那种）。口径由各引擎的 `extOf()` 归一，
 * 而带 `i` 标志的正则没法表达成 JSON Schema 的 `pattern`（那个字段没有 flag 可写），
 * 加了反而要在两个出口之间做取舍。约束写进 describe 里给模型看就够了。
 *
 * 它只用于 target_format：`auto` 是「转成什么」的保留字，源文件那一侧没有这回事
 * （源格式是从文件名的扩展名读出来的，不由调用方指定）。
 */
const targetExtSchema = (): z.ZodString =>
  z
    .string()
    .min(1)
    .describe(
      t('mcp.tools.field.targetFormat.head') +
        t('mcp.tools.field.targetFormat.tail', { auto: AUTO_TARGET })
    )

/**
 * `list_jobs` 默认返回几条。
 *
 * **必须有个小默认值**：不传 limit 就全量返回，一次 `batch_convert` 之后紧接着
 * 一次 `list_jobs` 就是一次上下文炸弹（登记表最多留 200 条已结束的 job）。
 * 20 条足够回答「刚那批怎么样了」，需要更多时 agent 会自己传 limit。
 */
export const DEFAULT_LIST_LIMIT = 20

/**
 * `list_jobs` 的条数上限。与 `jobs.ts` 的 `KEEP_FINISHED`（保留多少条已结束的 job）
 * 同值：超过登记表里实际有的条数没有意义。
 *
 * 两个常量**刻意分开写**而不是互相 import——`schema.ts` 是纯形状层，不该反向依赖
 * `jobs.ts`（那会把主进程拖进静态面的依赖图，理由见上面 `AUTO_TARGET` 那段）。
 * 漂移的后果只是「要了 300 条、拿到 200 条」，`truncated` 照样如实报，不会静默。
 */
export const MAX_LIST_LIMIT = 200

/** `get_job_status` 与 `cancel_job` 的参数完全同形——一份定义，两个工具用。 */
const jobIdSchema = (): z.ZodString => z.string().min(1).describe(t('mcp.tools.field.jobId'))

/**
 * E-6 的产物自检开关。**默认 `false`，而且这一点是承重的。**
 *
 * 它每开一次，就要**多起两个引擎子进程**（源一个、产物一个，见 `selfCheck.ts`）：
 * `batch_convert` 200 个文件就是 400 次——那笔钱只有「这一次的产物很重要」时才值得付，
 * 而绝大多数转换（缩略图、格式互转、批量转码）根本不需要。判据是「默认档必须是最省的
 * 那一档」：默认开的话，第一个拿它转 200 张图的人会以为自己只是转了个格式，
 * 实际额外付了 400 次进程启动。
 *
 * 两个工具共用同一份定义（与 `jobIdSchema` 同一种做法）：两侧各写一份的话，
 * 「哪个工具默认开」这种漂移不会有任何东西发现。
 *
 * ⚠️ 加了它之后，`test-mcp-view.ts` 那条「convert_file 的 properties 恰好是这四个键」
 * 会红——**那是设计**：那份字面量就是用来让「多一个参数」这件事必须有人过一眼的
 * （它挡的正是当年那个死参数 `quality` 偷偷回来）。所以那条断言同步改成了五个键。
 */
const verifySchema = (): z.ZodDefault<z.ZodBoolean> =>
  z
    .boolean()
    .default(false)
    .describe(
      t('mcp.tools.field.verify.01') +
        t('mcp.tools.field.verify.02') +
        t('mcp.tools.field.verify.03') +
        t('mcp.tools.field.verify.04') +
        t('mcp.tools.field.verify.05') +
        t('mcp.tools.field.verify.06') +
        t('mcp.tools.field.verify.07')
    )

/**
 * E-5 的 `dry_run`：**只回答「会发生什么」，一个字节都不动**。
 *
 * 它做的是 `convert_file` 的前半段（同一套校验、同一份落点计算），然后把
 * 「落点 / 目标格式 / 引擎 / 要下多大 / 有没有损 / 多久」一次性给出来。
 *
 * **默认 `false`，而且这不需要理由**——`convert_file` 的默认语义就是「转」。
 * 这里要写清的是**另外那件事**：为真时它绝不建 job、绝不写文件、**也绝不占用产物名**
 * （`claimed` 那条规矩，见 `jobs.ts` 的 `preview()`）。最后一条最容易漏：
 * 一次预览把名字占了的话，紧接着的真实任务会静默改名成 `x (1).jpg`。
 *
 * ⚠️ **不加进 `batch_convert`**：批量的落点是我们按 `output_dir` 算的，
 * 而「预览一批」的正确形态是逐条给落点与代价——那是另一个形状的返回值，
 * 该由需要它的那次调用去决定，不该顺手塞进这个开关。
 *
 * ⚠️ 加了它之后，`test-mcp-view.ts` 那条「convert_file 的 properties 恰好是这几个键」
 * 会红——**那是设计**（与 `verifySchema` 那次同一条理由：多一个参数必须有人过一眼）。
 */
const dryRunSchema = (): z.ZodDefault<z.ZodBoolean> =>
  z
    .boolean()
    .default(false)
    .describe(
      t('mcp.tools.field.dryRun.01') +
        t('mcp.tools.field.dryRun.02') +
        t('mcp.tools.field.dryRun.03') +
        t('mcp.tools.field.dryRun.04') +
        t('mcp.tools.field.dryRun.05') +
        t('mcp.tools.field.dryRun.06')
    )

/**
 * 排队优先级的取值范围（R16）。
 *
 * **两边都夹住**：无界的话第一个写的人就会写 999999，而那与 100 表达的是同一件事，
 * 却会让「把一个文件插到最前面」看起来需要一个荒谬的数字。
 * 负数是**降级**（默认 0），用来把「先看着办、但别占着我的资源」这类批量任务往后放。
 *
 * ⚠️ 常量放这里而不是 `jobs.ts`：后者会拖进整条转换依赖图，而 `test-mcp-view.ts`
 * 刻意只 import 这个文件（它断言的是**对外面**的形状，一 import `src/main` 就破了）。
 * `jobs.ts` 反过来 import 这里的常量去做夹取。
 */
export const MIN_PRIORITY = -100
export const MAX_PRIORITY = 100

/**
 * 排队优先级。**一份定义，`convert_file` 与 `batch_convert` 共用**（照 `verifySchema`
 * 的先例）——两个工具的同名参数一旦各写各的，就会出现「单文件能传 200、批量不能」。
 */
const prioritySchema = (): z.ZodDefault<z.ZodNumber> =>
  z
    .number()
    .int()
    .min(MIN_PRIORITY)
    .max(MAX_PRIORITY)
    .default(0)
    .describe(t('mcp.tools.field.priority.01') + t('mcp.tools.field.priority.02'))

/* ------------------------------------------------------------- read_document */

/**
 * `read_document` 能回的三种文本形态。**这是闭集，而且它同时是参数枚举、
 * 回落次序、以及返回值里 `format` 的取值域**——三处共用一个字面量，别各写一份。
 *
 * 为什么只有这三种：它们对应「模型的上下文里想拿到什么」。`html` 不在其中——
 * 拿一段 HTML 标签对读内容的 agent 是负担，要它就从 `.html` 源转 md/txt。
 */
export const READ_FORMATS = ['md', 'txt', 'csv'] as const

export type ReadFormat = (typeof READ_FORMATS)[number]

/**
 * `read_document` 一次默认回多少字符。
 *
 * **必须有默认值，而且必须小**：一份 300 页 PDF 的正文是几十万字符，一次全塞进
 * 上下文等于把这一轮对话废掉。20000 字符 ≈ 一万汉字上下，够回答「这文件写了啥」，
 * 不够时 agent 自己会用 `offset` 接着读（`truncated: true` 就是在提示它还有）。
 */
export const DEFAULT_READ_CHARS = 20_000

/**
 * `read_document` 的 `max_chars` 上限。
 *
 * 上限默认值之外的第三道闸：默认值只管「不传」，管不住「传个 5000000 进来」。
 * 超限不报错而是**夹住并如实说明**（`warnings` 里会写），与 `list_jobs` 的 `limit`
 * 同一个取舍：让 agent 拿到一份能用的结果 + 一句「被砍了」，比让它收一条参数校验错误强。
 */
export const MAX_READ_CHARS = 200_000

/**
 * 工具的入参形状。前六个的名字与 `docs/PLAN.md` 的 M4 一节逐字对应；
 * **后加的两个**是 `list_jobs`（第 7 个）与 `read_document`（第 8 个），PLAN 那一节
 * 还没同步，加它们的理由（各自替掉了几次调用）写在 `server.ts` 的文件头。
 *
 * 顺序有意与 PLAN 一致：`openAiTools()` 按它输出，稳定顺序让 diff 好读。
 * `list_jobs` 插在 `get_job_status` 后面而不是末尾：两个都是「查任务」，
 * 挨着放模型更容易看出「一条查一个、一条查一批」。
 *
 * ⚠️ **这里是工具名的唯一定义处**，而且是 `TOOL_DESCRIPTIONS` / `jsonSchemas()` /
 * `openAiTools()` 三个出口的共同来源；`server.ts` 注册时只能从 `ToolName` 里取名字
 * （`registerArbiterTool` 会因为这个名字去拿说明书），所以不存在「注册名与说明书
 * 对不上」这种状态。
 */
export const TOOL_SCHEMAS = {
  // ⚠️ **八项都是 getter，别改回 `convert_file: convertFile` 那种写法**：
  // 那样一来每个 schema 在 import 那一刻就被构造好、`.describe()` 里的说明书也就
  // 在那一刻定了语言（那时 `applyLocale()` 还没跑）。理由与代价见文件头那一节。
  // ⚠️ 也**别给 getter 加上 `(): z.ZodObject<z.ZodRawShape>` 那种返回注解**：
  // 那会把 `.parse()` 的返回类型宽成 unknown，而 `server.ts` 每个 handler 都靠它
  // 拿 `args.xxx` 的类型——宽了之后那边会报一片 unknown（实测 20 处）。
  /*
   * 这里曾经还有一个 `quality` 参数，**已删除**（2026-09-13）。
   *
   * 它是个**死参数**：声明了、在 description 里讲了、执行路径里从头到尾没读过——
   * `submit()` 的签名里没有它，`ConvertContext` 里也没有。后果是 agent 传
   * `quality: 18` 会拿到 `status: done`、`size_bytes` 正常，**没有任何提示说它被忽略了**。
   * 「用户以为设了、其实没设」正是这个项目最忌讳的那类静默失败，而它伪装成成功。
   *
   * 删而不是接通：接通等于开启「任务参数通道」，而 `Task` 只有
   * `inputPath/fromExt/toExt` 三个字段，这条通道会牵动 `core/task.ts` 与 `core/queue.ts`
   * （枢纽文件，属于另一条线）——那该是一次独立的决策，不该顺手塞进 MCP 这一层。
   *
   * 想知道它有没有偷偷回来：`test-mcp-view.ts` 里那条「convert_file 的 properties
   * 恰好是这几个键」就是钉这件事的（多一个键就红）。那份字面量到今天是六个键
   * （source / target_format / output_path / mode / verify / dry_run）。
   *
   * ---- 2026-09-17 的补充：GUI 那条路已经有真的质量档了，**MCP 这边仍然没有** ----
   *
   * P0-10 给 `TaskOptions` 加了 `quality`（CRF / 预设 / 调优），并且**真的接到了**
   * `engines/ffmpeg.ts` 的参数上——所以「死参数」那个隐患不再是不接的理由。
   * 今天不接，是因为它要扩的是 MCP 自己的参数面，而那与 `mode`（M2）、`priority`（R16）
   * 那两次一样，属于**独立决策**（要同步改工具描述、`test-mcp-view` 的键表、
   * 以及「agent 传了一个这个出口不认的值该怎么办」那一套判据）。
   * 一句话：**别把它当成「顺手补一行」**，但也不必再拿上面那条「通道还没开」当理由。
   */
  get convert_file() {
    return z.object({
      source: z.string().min(1).describe(t('mcp.tools.field.convertSource')),
      target_format: targetExtSchema(),
      output_path: z.string().optional().describe(t('mcp.tools.field.convertOutputPath')),
      mode: z
        .enum(['auto', 'remux', 'reencode'])
        .default('auto')
        .describe(t('mcp.tools.field.convertMode')),
      verify: verifySchema(),
      dry_run: dryRunSchema(),
      priority: prioritySchema()
    })
  },
  get list_supported_formats() {
    return z.object({
      category: z.enum(CATEGORIES).optional().describe(t('mcp.tools.field.formatCategory'))
    })
  },
  get inspect_file() {
    return z.object({
      path: z.string().min(1).describe(t('mcp.tools.field.inspectPath'))
    })
  },
  get batch_convert() {
    return z.object({
      sources: z.array(z.string().min(1)).min(1).describe(t('mcp.tools.field.batchSources')),
      target_format: targetExtSchema().describe(
        t('mcp.tools.field.batchTargetFormat.01') + t('mcp.tools.field.batchTargetFormat.02')
      ),
      output_dir: z.string().optional().describe(t('mcp.tools.field.batchOutputDir')),
      // 与 `convert_file` 同一个开关、同一份定义。⚠️ 批量时**每一条 job 各算各的**：
      // 200 个文件打开它就是 400 次额外子进程，见 `verifySchema` 的说明。
      verify: verifySchema(),
      // 整批共用一个优先级（**不是**逐条给）：批量的用途就是「这一批是一件事」，
      // 逐条给等于让调用方在这里重新排一遍队，那不如直接分两次 batch。
      priority: prioritySchema()
    })
  },
  get get_job_status() {
    return z.object({ job_id: jobIdSchema() })
  },
  get list_jobs() {
    return z.object({
      /**
       * `list_jobs` 的状态过滤。
       *
       * `unfinished` 是个**别名**，不是第六种状态：它指 `queued` + `running`，
       * 也就是「还没落定的那些」。它是这张表里最常用的一档——agent 问得最多的那句话
       * 就是「还剩几个在跑」，而用单值枚举表达不了「两者之一」。别为了「纯粹」把它删掉，
       * 删了 agent 就得发两轮（一轮 queued、一轮 running）才能回答同一个问题。
       *
       * ⚠️ 这个枚举**就地写在这里**（原先是 `jobFilterStatus` 那个常量）：理由与
       * 文件头「每一项都是工厂 / getter」同一条——`.describe()` 也是要给模型读的说明书。
       */
      status: z
        .enum(['queued', 'running', 'done', 'failed', 'canceled', 'unfinished'])
        .optional()
        .describe(t('mcp.tools.field.jobStatus')),
      limit: z
        .number()
        .int()
        .min(1)
        .default(DEFAULT_LIST_LIMIT)
        .describe(
          t('mcp.tools.field.listLimit.01', {
            limit: DEFAULT_LIST_LIMIT,
            max: MAX_LIST_LIMIT
          }) + t('mcp.tools.field.listLimit.02')
        ),
      since: z.number().optional().describe(t('mcp.tools.field.listSince'))
    })
  },
  get cancel_job() {
    return z.object({ job_id: jobIdSchema() })
  },
  get read_document() {
    return z.object({
      source: z.string().min(1).describe(t('mcp.tools.field.readSource')),
      format: z
        .enum(READ_FORMATS)
        .default('md')
        .describe(
          t('mcp.tools.field.readFormat.01') +
            t('mcp.tools.field.readFormat.02') +
            t('mcp.tools.field.readFormat.03')
        ),
      max_chars: z
        .number()
        .int()
        .min(1)
        .default(DEFAULT_READ_CHARS)
        .describe(
          t('mcp.tools.field.readMaxChars.01', {
            chars: DEFAULT_READ_CHARS,
            max: MAX_READ_CHARS
          }) + t('mcp.tools.field.readMaxChars.02')
        ),
      offset: z.number().int().min(0).default(0).describe(t('mcp.tools.field.readOffset'))
    })
  }
}

export type ToolName = keyof typeof TOOL_SCHEMAS

/** 按登记顺序排列的工具名。派生自 `TOOL_SCHEMAS`，不另写一份字面量。 */
export const TOOL_NAMES = Object.keys(TOOL_SCHEMAS) as ToolName[]

/**
 * 工具对世界的**副作用等级**——`annotations` 由它派生，所以写不出自相矛盾的组合。
 *
 * ## 为什么要有这一层
 *
 * `readOnlyHint: true` 在客户端那里**就是自动放行的依据**。Anthropic 的目录审核标准
 * 原文（`claude.com/docs/connectors/building/review-criteria`）：
 *
 * > Every tool must include a `title` and the applicable hint: `readOnlyHint: true`
 * > for read-only tools, and `destructiveHint: true` for tools that modify or delete
 * > data. **These determine auto-permissions in Claude.** Read-only tools can run
 * > without per-call confirmation, and destructive tools always prompt.
 *
 * 而 `convert_file` 曾经标的就是 `readOnlyHint: true`——**它会往用户盘上写产物**
 * （同一个 handler 里走的是 `resolveWritePath`）。后果是 agent 可以写文件而不弹确认，
 * 与本项目路径闸门的立意正相反（README 原话：*an MCP tool hands an agent filesystem
 * access, and that deserves better than an assumption of good faith*）。
 *
 * 它活下来的原因很朴素：`grep readOnlyHint scripts/` → **零命中**。这三个 hint 在整套
 * 测试里一处断言都没有，所以标错了不会有任何地方红。
 *
 * 所以现在不再让调用点各写各的 `annotations: {…}`（那正是写错的形状），改成
 * **声明等级、由 `ACCESS_HINTS` 派生**。三种等级的 hint 组合只有下面那三种写法。
 *
 * ⚠️ 但**等级本身仍可能被定错**（把一个会写盘的工具标成 `read`）——那是判断，不是形状，
 * 结构挡不住。挡它的是 `scripts/test-mcp-view.ts` 里那张「哪些工具不是只读」的清单：
 * 加新工具而忘了归类，那条断言**两个方向都会红**。
 */
export type ToolAccess = 'read' | 'add' | 'destroy'

/** 与 SDK 的 `ToolAnnotations` 结构兼容。不 import 它——本文件不碰任何运行时依赖。 */
export interface ToolHints {
  readOnlyHint?: boolean
  destructiveHint?: boolean
  idempotentHint?: boolean
}

/**
 * 三种等级 → 三种 hint 组合。**唯一的映射**，`server.ts` 注册时按名字取。
 *
 * - `read`：只看不动。幂等，客户端可自动放行。
 * - `add`：**增量写入**，不删不覆盖（产物先落 `.part.<ext>`、成功才改名，撞名顺延）。
 *   标 `destructiveHint: false` 是 MCP 规格的原意：*if false, the tool only performs
 *   additive updates*。
 * - `destroy`：会删东西（取消任务会杀掉整棵进程树）。
 */
export const ACCESS_HINTS: Record<ToolAccess, ToolHints> = {
  read: { readOnlyHint: true, idempotentHint: true },
  add: { readOnlyHint: false, destructiveHint: false },
  destroy: { readOnlyHint: false, destructiveHint: true, idempotentHint: true }
}

/**
 * 每个工具的等级。类型是 `Record<ToolName, ToolAccess>`——**加工具却忘了归类是编译错误**。
 *
 * ⚠️ `read_document` 定为 `read` 是**有意的取舍**：它在系统临时目录里落中间产物，
 * 但**从不写用户的输出目录**（那正是它存在的理由之一，见 `removeTempOnExit` 那一族注释）。
 * 判据取的是「会不会动用户的文件」，不是「有没有碰过磁盘」——否则整台机器上没有一个
 * 工具算只读。
 */
export const TOOL_ACCESS: Record<ToolName, ToolAccess> = {
  convert_file: 'add',
  inspect_file: 'read',
  read_document: 'read',
  list_supported_formats: 'read',
  batch_convert: 'add',
  get_job_status: 'read',
  list_jobs: 'read',
  cancel_job: 'destroy'
}

/**
 * 名字 → description，给 agent 读（**跟着当前语言走**，见文件头那一节）。
 *
 * 单独一张表，而不是把这段文字塞进 zod 的 `.describe()`：MCP 的 tool 定义里
 * `description` 与 `inputSchema` 是**兄弟字段**，塞进 schema 只会白多一层包装；
 * 而且字段级 describe 那点长度说不清「不给 output_path 会怎样」这类跨字段的坑。
 * 字段级的短 describe 仍然留着——它会自动流进两个 JSON Schema 出口。
 *
 * 类型写成 `Record<ToolName, string>` 是**故意的**：往 `TOOL_SCHEMAS` 加一个工具
 * 却忘了在这里补一句，会直接是编译错误，而不是某个工具在模型眼里没有说明书。
 *
 * **这里是唯一的来源**：`src/mcp/server.ts` 注册工具时读的就是这张表
 * （`description: TOOL_DESCRIPTIONS.convert_file`），不在那里另写一份。
 * 一处曾经的重复已经合并——两份文字漂移的话，同一个工具在 Claude Code 里和
 * ChatGPT 里会拿到不一样的说明书，而这正是本文件开篇要防的那类错误。
 *
 * ⚠️ 每一句都是**一串片段拼出来的**（`t(...) + t(...) + …`），片段与迁移前源码里的
 * 字面量一一对应、一个字都没合并。拼接契约（英文片段尾巴上那个空格是有意的）与
 * 为什么按段记，写在 `@shared/i18n/parts/mcpTools.ts` 的文件头——改任何一句之前先读那两段。
 */
export const TOOL_DESCRIPTIONS: Record<ToolName, string> = {
  // ⚠️ **八项都是 getter，别改回 `convert_file:` 那种字面量**：说明书要跟着当前语言走，
  // 而常量在 import 那一刻就求值了——那时 `applyLocale()` 还没跑（见文件头那一节）。
  get convert_file() {
    return (
      t('mcp.tools.desc.convert_file.01') +
      t('mcp.tools.desc.convert_file.02') +
      t('mcp.tools.desc.convert_file.03') +
      t('mcp.tools.desc.convert_file.04') +
      t('mcp.tools.desc.convert_file.05') +
      t('mcp.tools.desc.convert_file.06') +
      t('mcp.tools.desc.convert_file.07') +
      t('mcp.tools.desc.convert_file.08') +
      t('mcp.tools.desc.convert_file.09') +
      t('mcp.tools.desc.convert_file.10') +
      t('mcp.tools.desc.convert_file.11') +
      t('mcp.tools.desc.convert_file.12', { auto: AUTO_TARGET }) +
      t('mcp.tools.desc.convert_file.13') +
      t('mcp.tools.desc.convert_file.14') +
      t('mcp.tools.desc.convert_file.15') +
      t('mcp.tools.desc.convert_file.16') +
      t('mcp.tools.desc.convert_file.17') +
      t('mcp.tools.desc.convert_file.18') +
      t('mcp.tools.desc.convert_file.19') +
      t('mcp.tools.desc.convert_file.20') +
      t('mcp.tools.desc.convert_file.21') +
      t('mcp.tools.desc.convert_file.22') +
      t('mcp.tools.desc.convert_file.23') +
      t('mcp.tools.desc.convert_file.24') +
      t('mcp.tools.desc.convert_file.25') +
      t('mcp.tools.desc.convert_file.26') +
      t('mcp.tools.desc.convert_file.27') +
      t('mcp.tools.desc.convert_file.28') +
      t('mcp.tools.desc.convert_file.29') +
      t('mcp.tools.desc.convert_file.30') +
      t('mcp.tools.desc.convert_file.31') +
      t('mcp.tools.desc.convert_file.32') +
      t('mcp.tools.desc.convert_file.33') +
      t('mcp.tools.desc.convert_file.34') +
      t('mcp.tools.desc.convert_file.35') +
      t('mcp.tools.desc.convert_file.36')
    )
  },
  get list_supported_formats() {
    return (
      t('mcp.tools.desc.list_supported_formats.01') +
      t('mcp.tools.desc.list_supported_formats.02') +
      t('mcp.tools.desc.list_supported_formats.03') +
      t('mcp.tools.desc.list_supported_formats.04')
    )
  },
  get inspect_file() {
    return (
      t('mcp.tools.desc.inspect_file.01') +
      t('mcp.tools.desc.inspect_file.02') +
      t('mcp.tools.desc.inspect_file.03') +
      t('mcp.tools.desc.inspect_file.04') +
      t('mcp.tools.desc.inspect_file.05') +
      t('mcp.tools.desc.inspect_file.06') +
      t('mcp.tools.desc.inspect_file.07') +
      t('mcp.tools.desc.inspect_file.08') +
      t('mcp.tools.desc.inspect_file.09') +
      t('mcp.tools.desc.inspect_file.10') +
      t('mcp.tools.desc.inspect_file.11') +
      t('mcp.tools.desc.inspect_file.12') +
      t('mcp.tools.desc.inspect_file.13')
    )
  },
  get batch_convert() {
    return (
      t('mcp.tools.desc.batch_convert.01') +
      t('mcp.tools.desc.batch_convert.02') +
      t('mcp.tools.desc.batch_convert.03') +
      t('mcp.tools.desc.batch_convert.04') +
      t('mcp.tools.desc.batch_convert.05', { auto: AUTO_TARGET }) +
      t('mcp.tools.desc.batch_convert.06') +
      t('mcp.tools.desc.batch_convert.07') +
      t('mcp.tools.desc.batch_convert.08') +
      t('mcp.tools.desc.batch_convert.09') +
      t('mcp.tools.desc.batch_convert.10') +
      t('mcp.tools.desc.batch_convert.11')
    )
  },
  get get_job_status() {
    return (
      t('mcp.tools.desc.get_job_status.01') +
      t('mcp.tools.desc.get_job_status.02') +
      t('mcp.tools.desc.get_job_status.03') +
      t('mcp.tools.desc.get_job_status.04') +
      t('mcp.tools.desc.get_job_status.05') +
      t('mcp.tools.desc.get_job_status.06') +
      t('mcp.tools.desc.get_job_status.07')
    )
  },
  get list_jobs() {
    return (
      t('mcp.tools.desc.list_jobs.01') +
      t('mcp.tools.desc.list_jobs.02', { limit: DEFAULT_LIST_LIMIT, max: MAX_LIST_LIMIT }) +
      t('mcp.tools.desc.list_jobs.03') +
      t('mcp.tools.desc.list_jobs.04') +
      t('mcp.tools.desc.list_jobs.05') +
      t('mcp.tools.desc.list_jobs.06') +
      t('mcp.tools.desc.list_jobs.07') +
      t('mcp.tools.desc.list_jobs.08') +
      t('mcp.tools.desc.list_jobs.09') +
      t('mcp.tools.desc.list_jobs.10')
    )
  },
  get cancel_job() {
    return (
      t('mcp.tools.desc.cancel_job.01') +
      t('mcp.tools.desc.cancel_job.02') +
      t('mcp.tools.desc.cancel_job.03') +
      t('mcp.tools.desc.cancel_job.04')
    )
  },
  get read_document() {
    return (
      t('mcp.tools.desc.read_document.01') +
      t('mcp.tools.desc.read_document.02') +
      t('mcp.tools.desc.read_document.03') +
      t('mcp.tools.desc.read_document.04') +
      t('mcp.tools.desc.read_document.05') +
      t('mcp.tools.desc.read_document.06') +
      t('mcp.tools.desc.read_document.07') +
      t('mcp.tools.desc.read_document.08') +
      t('mcp.tools.desc.read_document.09') +
      t('mcp.tools.desc.read_document.10') +
      t('mcp.tools.desc.read_document.11') +
      t('mcp.tools.desc.read_document.12') +
      t('mcp.tools.desc.read_document.13') +
      t('mcp.tools.desc.read_document.14') +
      t('mcp.tools.desc.read_document.15')
    )
  }
}

/**
 * zod 生成的 JSON Schema。
 *
 * 不直接用 `Record<string, unknown>`：那个类型没有索引签名，zod 的 schema 类型赋不进去
 * （TS 只在「类型别名 + 对象字面量」的场合才给隐式索引签名）。这里把本模块与测试真正
 * 会读的几个字段显式声明出来，其余原样透传——**不做任何加工**，`jsonSchemas()` 出来的
 * 就是 `toJSONSchema()` 的原始产物，MCP 那侧直接当 `inputSchema` 用。
 */
export interface ToolJsonSchema {
  type?: string
  properties?: Record<string, unknown>
  required?: string[]
  [key: string]: unknown
}

/**
 * JSON Schema 出口（MCP 的 `inputSchema` 与 OpenAI 的 `parameters` 共用这一份）。
 *
 * `io: 'input'` 是**承重的**，不是装饰：zod 默认按**输出**类型生成，而带 `.default()`
 * 的字段在输出侧必然有值、于是被算进 `required`。工具参数的语义是「调用方要**传**什么」，
 * 所以 `mode` 这种「不给就用默认值」的字段不能进 required——否则模型每次都被要求
 * 显式给出 mode，白白多一轮。测试里锁了这条（convert_file 的 mode 在 properties 里
 * 带 default，却不在 required 里）。
 */
export function jsonSchemas(): Record<ToolName, ToolJsonSchema> {
  const out = {} as Record<ToolName, ToolJsonSchema>
  for (const name of TOOL_NAMES) {
    out[name] = z.toJSONSchema(TOOL_SCHEMAS[name], { io: 'input' }) as ToolJsonSchema
  }
  return out
}

/** OpenAI function calling 的 tool 定义。 */
export interface OpenAiTool {
  type: 'function'
  function: { name: ToolName; description: string; parameters: ToolJsonSchema }
}

/**
 * OpenAI 风格的 function calling schema（ChatGPT 那侧的入口）。
 *
 * 刻意**直接复用 `jsonSchemas()`**，不再生成一遍——两份定义各自漂移正是本文件要避免的事。
 * 也没有额外裁剪（比如去掉 `$schema`）：那属于「未实测的加工」，真遇上报错再改，
 * 比现在凭猜测削字段强。
 */
export function openAiTools(): OpenAiTool[] {
  const parameters = jsonSchemas()
  return TOOL_NAMES.map((name) => ({
    type: 'function' as const,
    function: { name, description: TOOL_DESCRIPTIONS[name], parameters: parameters[name] }
  }))
}
