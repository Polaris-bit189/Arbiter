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
 */
import { z } from 'zod'

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
const targetExtSchema = z
  .string()
  .min(1)
  .describe(
    '不带点的目标扩展名，如 mp4 / mp3 / pdf，不要写成 .mp4 或 MP4；' +
      `也可以传保留字 "${AUTO_TARGET}"，表示用应用里配置的**默认目标格式**（仍会过一遍能力矩阵校验）`
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
const jobIdSchema = z.string().min(1).describe('convert_file / batch_convert 返回的 job_id')

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
const verifySchema = z
  .boolean()
  .default(false)
  .describe(
    '转换完成后对产物做一次自检（默认 false）。打开时返回值里会多一个 verification：' +
      '用 inspect_file 那同一套侦察链路把源与产物各读一遍，逐项对照分辨率 / 视频编解码器 / ' +
      '有没有音轨 / 时长，**只报事实、不打分**（不做 PSNR 那类画质判断）。' +
      '⚠️ 判据刻意宽：换容器会重新分装（ts → mp4 的时长会对不齐）、gif 与图片根本没有音轨和时长，' +
      '这些都写进 notes 而不是判成「不一致」。' +
      '⚠️ 代价是**每个任务多两个引擎子进程**（源一个、产物一个），批量几十个文件时这笔账不小，' +
      '所以默认关，只在「这一次的产物很重要」时打开'
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
const dryRunSchema = z
  .boolean()
  .default(false)
  .describe(
    '只预览、不执行（默认 false）。为 true 时**不建任务、不写任何文件、也不占用产物名**，' +
      '返回一份「会发生什么」：落点 output（此刻磁盘上还没有它）、实际用到的 to、engine、' +
      'cost（要准备的引擎与体积）、lossy（有没有损）、estimate（耗时区间 + confidence）。' +
      '校验走的是与真跑**同一个函数**，所以预览说不行时返回的就是真跑会返回的那个错误' +
      '（同一个 code / next_steps / 文案），不是另写一句。' +
      '⚠️ 落点是**此刻**算的：从预览到真跑之间若出现了同名文件，真跑会顺势避让成 `(1)`。'
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
const prioritySchema = z
  .number()
  .int()
  .min(MIN_PRIORITY)
  .max(MAX_PRIORITY)
  .default(0)
  .describe(
    '排队优先级，越大越先跑（默认 0）。**只影响还在排队的那些**——已经在跑的任务' +
      '永远不会被抢，转换没有「暂停」这回事。批量时用它把几个急着要的文件插到前面。'
  )

const convertFile = z.object({
  source: z.string().min(1).describe('待转换文件的绝对路径'),
  target_format: targetExtSchema,
  output_path: z
    .string()
    .optional()
    .describe('产物的完整文件路径（含文件名），不是目录；不传时落点由应用的输出目录设置决定'),
  mode: z
    .enum(['auto', 'remux', 'reencode'])
    .default('auto')
    .describe('auto=能重封装就重封装；remux=只准重封装，容器不兼容会直接失败；reencode=强制重编码'),
  verify: verifySchema,
  dry_run: dryRunSchema,
  priority: prioritySchema
})

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

const listSupportedFormats = z.object({
  category: z.enum(CATEGORIES).optional().describe('只列这一类；不传则返回全部六类')
})

const inspectFile = z.object({
  path: z.string().min(1).describe('要侦察的文件的绝对路径')
})

const batchConvert = z.object({
  sources: z.array(z.string().min(1)).min(1).describe('待转换文件的绝对路径列表，至少要有一个'),
  target_format: targetExtSchema.describe(
    '这一批共用的目标扩展名，不带点；传保留字 "auto" 时**每个源各按自己的能力矩阵与用户偏好**解析' +
      '（混合目录的常态：一条 batch 里 png 走图片偏好、mp4 走视频偏好），实际用到的是每条 job 回显的 to'
  ),
  output_dir: z
    .string()
    .optional()
    .describe('产物的输出目录（不是文件路径）；不传时落点由应用的输出目录设置决定'),
  // 与 `convert_file` 同一个开关、同一份定义。⚠️ 批量时**每一条 job 各算各的**：
  // 200 个文件打开它就是 400 次额外子进程，见 `verifySchema` 的说明。
  verify: verifySchema,
  // 整批共用一个优先级（**不是**逐条给）：批量的用途就是「这一批是一件事」，
  // 逐条给等于让调用方在这里重新排一遍队，那不如直接分两次 batch。
  priority: prioritySchema
})

const getJobStatus = z.object({ job_id: jobIdSchema })

/**
 * `list_jobs` 的状态过滤。
 *
 * `unfinished` 是个**别名**，不是第六种状态：它指 `queued` + `running`，
 * 也就是「还没落定的那些」。它是这张表里最常用的一档——agent 问得最多的那句话
 * 就是「还剩几个在跑」，而用单值枚举表达不了「两者之一」。别为了「纯粹」把它删掉，
 * 删了 agent 就得发两轮（一轮 queued、一轮 running）才能回答同一个问题。
 */
const jobFilterStatus = z
  .enum(['queued', 'running', 'done', 'failed', 'canceled', 'unfinished'])
  .optional()
  .describe('只看这一种状态；unfinished = queued 或 running（还没落定的）。不传则全部')

const listJobs = z.object({
  status: jobFilterStatus,
  limit: z
    .number()
    .int()
    .min(1)
    .default(DEFAULT_LIST_LIMIT)
    .describe(
      `最多返回几条（默认 ${DEFAULT_LIST_LIMIT}，上限 ${MAX_LIST_LIMIT}，超过按上限算）。` +
        '返回里的 truncated 说明有没有被截断'
    ),
  since: z
    .number()
    .optional()
    .describe('只返回 created_at >= 这个**毫秒时间戳**的 job（增量轮询用）；不传则不过滤')
})

const cancelJob = z.object({ job_id: jobIdSchema })

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

const readDocument = z.object({
  source: z
    .string()
    .min(1)
    .describe('要读的文档的绝对路径。支持 docx / xlsx / pdf / md / txt / html / rst / csv'),
  format: z
    .enum(READ_FORMATS)
    .default('md')
    .describe(
      '想要的文本形态：md / txt / csv（默认 md）。' +
        '源格式没有这个出口时会**回落到它支持的另一种**并在 warnings 里说明，' +
        '实际给到的是返回值里的 format——以那一个为准，不要假定等于这里传的'
    ),
  max_chars: z
    .number()
    .int()
    .min(1)
    .default(DEFAULT_READ_CHARS)
    .describe(
      `这次最多返回多少字符（默认 ${DEFAULT_READ_CHARS}，上限 ${MAX_READ_CHARS}，超过按上限算）。` +
        '被截断时 truncated 为 true，用 offset 接着读'
    ),
  offset: z
    .number()
    .int()
    .min(0)
    .default(0)
    .describe('从正文的第几个字符开始（默认 0）。续读时传「上次的 offset + 实际拿到的字符数」')
})

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
  convert_file: convertFile,
  list_supported_formats: listSupportedFormats,
  inspect_file: inspectFile,
  batch_convert: batchConvert,
  get_job_status: getJobStatus,
  list_jobs: listJobs,
  cancel_job: cancelJob,
  read_document: readDocument
}

export type ToolName = keyof typeof TOOL_SCHEMAS

/** 按登记顺序排列的工具名。派生自 `TOOL_SCHEMAS`，不另写一份字面量。 */
export const TOOL_NAMES = Object.keys(TOOL_SCHEMAS) as ToolName[]

/**
 * 名字 → 中文 description，给 agent 读。
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
 */
export const TOOL_DESCRIPTIONS: Record<ToolName, string> = {
  convert_file:
    '转换单个文件，**等它跑完再返回**（转视频可能几分钟），过程中持续汇报进度。' +
    // 这一句是实测加上的：模型会把「已经转完的任务」当成还在跑，然后白轮询好几轮。
    // 说明书写在它面前比写在别处有用——它读到这段的时机正是决定要不要轮询的那一刻。
    '**它是阻塞的：调用返回时转换已经结束了**，返回值里的 status 就是最终状态——' +
    '不要在这个调用返回之后再去轮询 get_job_status，那等于在查一个已经跑完的任务。' +
    '（要查的是**别的**任务时，用 list_jobs 一次问一批。等很多个结果时先用 batch_convert 拿 job_id，' +
    '再用 list_jobs 看整批。）' +
    'source 必须是文件的绝对路径；target_format 是不带点的扩展名（如 mp4），不是 MIME 也不是带点的后缀。' +
    '给了 output_path 就必须是产物的完整文件路径（含文件名），给成目录会失败。' +
    // 这一段曾经写的是「不给 output_path 时产物落在源文件旁边」，**那是个无条件的断言，
    // 而它并不成立**：`jobs.ts` 刻意复用主进程的 `outputDirFor()`，所以用户在界面里
    // 设了「输出到指定目录」时，产物会去那个目录。2026-09-13 在真实 Claude Code 里
    // 端到端验收时被当场抓出来——模型照着这句话向用户报了错路径。行为是对的（与 GUI
    // 同一套规则，不该由 MCP 自作主张），错的是说明书。
    '不给 output_path 时落点由**应用的输出目录设置**决定：设了「输出到指定目录」就去那里，' +
    '否则才落在源文件旁边（同名，只换扩展名）。**不要假定产物在源文件旁边**——' +
    '以返回值里的 output 为准，拿不准就用 get_job_status 查。' +
    '目标格式必须是该源格式的合法目标之一——不确定就先调 inspect_file。' +
    `target_format 也可以传保留字 "${AUTO_TARGET}"：表示用**应用里配置的默认目标格式**` +
    '（叠了用户偏好的那一档，且仍会过一遍能力矩阵校验），不传就是让工具替用户挑一个。' +
    'mode 默认 auto：能安全重封装就重封装（实测快一个数量级），否则重编码；显式传 remux 是「只准重封装」——' +
    '目标容器装不下源的编解码器时**直接失败，不会回退成重编码**，只有在已确认兼容时才用它。' +
    // E-6。为什么必须写在说明书里：模型不会用一个它没读到过的开关，而这个开关
    // 恰恰是「退出码 0」与「产物真的对」之间唯一的那层信息。
    '`verify: true` 时返回值里会多一个 `verification`：用 `inspect_file` 那**同一套**侦察链路把源与产物' +
    '各读一遍，逐项对照分辨率 / 视频编解码器 / 有没有音轨 / 时长，**只报事实、不打分**' +
    '（不做 PSNR 那类画质判断）。⚠️ 判据刻意宽：换容器会重新分装（ts → mp4 的时长会对不齐）、' +
    'gif 与图片本来就没有音轨和时长，这些都写进 `notes` 而不是判成「不一致」；' +
    '`checked` 列出这次**实际查了**哪几项，`status: "consistent"` 要配着它读——**没查到的项目不算**。' +
    '⚠️ 它给每个任务**多起两个引擎子进程**（源一个、产物一个），所以默认关，' +
    '只在这一次的产物很重要时打开；批量几十个文件时那笔账不小。' +
    // E-5。写在说明书里的理由与上面 verify 那一段逐字相同：模型不会用一个它没读到过的
    // 开关，而「先预览再动手」恰恰是这个工具最省事的那条路——省掉一次几十分钟的
    // 等待、或者一次几百 MB 的下载。
    '`dry_run: true` 时**只预览、不执行**：不建任务、不写任何文件、**也不占用产物名**' +
    '（不会把真实任务的落点挤成 `(1)`）。返回一份「会发生什么」——`output`（落点，此刻磁盘上还没有它）、' +
    '实际用到的 `to`（传 auto 时它是算出来的）、`engine`、`cost`（要准备的引擎与体积）、' +
    '`lossy`（有没有损）、`estimate`（耗时**区间** + `confidence`），外加一句 `note`。' +
    '**它走的是与真跑同一个校验函数**，所以预览说不行时返回的就是真跑会返回的那**同一个错误**' +
    '（同一份 code / next_steps / 文案，不是另写一句中文）。' +
    '⚠️ 落点是**此刻**算的：从预览到真跑之间若磁盘上出现了同名文件，真跑会顺势避让成 `(1)`。' +
    '拿不准目标格式合不合法、值不值得等、要不要让用户先确认下载引擎时，**先 dry_run 一次**。' +
    // 实测出来的约定：客户端发过 notifications/cancelled 之后，服务端不会再为这个请求
    // 回话（SDK 主动压掉那一帧）。agent 若不知道这一点，会一直等一个永远不来的结果。
    '⚠️ 调用被客户端取消时（发 notifications/cancelled）本调用**不会再返回任何东西**，' +
    '这是 MCP 的约定、不是出错；这时要查结果只能靠 get_job_status 或 list_jobs。' +
    '**失败时返回的不是一句中文，而是一个机器可读的对象**：`code`（闭集，如 ' +
    'source_corrupt / engine_missing / target_not_supported）、`retryable`（同样参数重试有没有意义）、' +
    '`next_steps`（下一步做什么），以及 `log_tail`（引擎的 stderr 尾部）。' +
    '**先看 log_tail，它才是引擎给的原始原因**；`code` 只负责告诉你该不该重试。',
  list_supported_formats:
    '列出能力矩阵：每个类别下有哪些源格式、各自能转成哪些目标格式。它只回答「支持不支持」，不做任何转换。' +
    '不传 category 时返回全部六类。**拼 target_format 之前先查这里或 inspect_file**——合法目标随源格式而变' +
    '（mkv 转不了 mkv；HEIC 与 SVG 源没有 bmp/ico 出口），猜错了 convert_file 会直接报错。' +
    '想一次看懂全局，优先读 converter://formats 那份 markdown，不必反复调这个工具试探。',
  inspect_file:
    '转换前侦察一个文件：类别、源格式、体积、有哪些合法出口、要不要下载引擎；' +
    '音视频还会给出时长、分辨率与编解码器，压缩包给条目数。' +
    '**决定目标格式之前先调它**：合法目标是从源格式问答出来的，不是猜出来的。它只读元数据，不改动、不转换文件。' +
    // E-3 的三件套。写在说明书里是**必须的**：模型不读到这三个字段就不会用它们，
    // 于是「先侦察再动手」这条唯一能省掉几百 MB 下载与几分钟等待的路就废了。
    '还会给三样**算账用**的东西，都按**默认目标格式**算：' +
    '`cost`（`engine` 要准备哪个引擎、`download_bytes` 安装包多大、`unpacked_bytes` 解包后多大、' +
    '`network_required` 这条路是否依赖一个按需下载的重型引擎）、' +
    '`lossy`（这一步会不会丢信息：true=一定有损、false=存在无损通路、null=判不了）、' +
    '`estimate`（耗时**区间** `seconds: [下限, 上限]` 秒 + `confidence`）。' +
    '⚠️ `estimate` 是**区间不是承诺**，而且**先看 `confidence`**：' +
    '`high` 才能照着安排等待，`medium` / `low` 只够判断「秒级还是分钟级」。' +
    '⚠️ 要别的目标格式时这三个数**不适用**——先看 `targets` 列出的合法目标，' +
    '`cost` 只说默认目标那一条路。' +
    '⚠️ 体积与引擎来自运行时读安装清单，读不到时是 `null`（**不是 0**）：0 的含义是「这条路不用下东西」。',
  batch_convert:
    '一次转换多个文件，共用同一个 target_format，适合「一批同格式的素材」。' +
    '**立刻返回一组 job_id，不等转换完成**，用 list_jobs 一次看完整批（**不要**对着返回的 job_id 逐个 get_job_status）。' +
    '某个源不合法只影响它自己（会出现在 rejected 里，每条都带 code / retryable / next_steps），' +
    '其余照常入队——所以拿到返回值后要看一眼 rejected。' +
    `混合目录里 target_format 传保留字 "${AUTO_TARGET}"：每个源**各按自己的能力矩阵与用户偏好**解析目标` +
    '（一批里 png 走图片偏好、mp4 走视频偏好），实际用到的是每条 job 回显的 `to`——**以它为准**，不要假定整批同一个目标。' +
    // 与 convert_file 同一处错误的另一个副本：原来写的是「各自落在源文件旁边，
    // 不会自动聚到一个目录」——设了输出目录时**正好相反**，整批会聚过去。
    '不给 output_dir 时落点由**应用的输出目录设置**决定：设了「输出到指定目录」时整批聚到那一个目录，' +
    '否则才各自落在它自己的源文件旁边。**以每个 job 返回的 output 为准**，不要假定它们散在源文件旁边。' +
    // E-6 在批量这一侧：**逐条各算各的**，所以代价要在这里点名（200 个文件 = 400 次子进程）。
    '`verify: true` 会给**每条 job** 做一次产物自检（判据与 convert_file 那份逐字相同），' +
    '于是它在这里的代价是**源文件数的两倍**那么多子进程——批量时先想清楚值不值。' +
    '结果随 `list_jobs` 的 `verification_status` 与 `get_job_status` 的 `verification` 一起给出。',
  get_job_status:
    '查**一个**任务的进度与结果。job_id 来自 convert_file / batch_convert 的返回。' +
    '任务结束时会给出产物路径与体积；失败时给出错误摘要、机器可读的 error_code 与引擎的 stderr 尾部——' +
    '**要读 stderr 尾部（`log_tail`），那里才是引擎给的原始原因**（比如 ffmpeg 具体是哪个参数不对），' +
    '只看到「转换失败」等于没有信息。`log_tail` **只有这个工具给**（列表里刻意不带，几十条 stderr 会把上下文吃掉）。' +
    '还在跑时给出百分比；pandoc / LibreOffice 这类引擎只能给阶段文案，**没有百分比是正常的**，不要据此判定卡死。' +
    // E-6：自检结果在 job **落定之前**就算好了，所以这里给的是稳定的一份。
    '提交时开了 `verify` 的任务，结束时还会带一个 `verification`（字段含义见 convert_file 的说明）：' +
    '它是任务**落定之前**算好的，所以**哪一次查都一样**，不会出现「第一次查还没有、第二次才有」。',
  list_jobs:
    '一次列出**一批**任务的进度与结果（`counts` 是全局计数，`jobs` 是筛出来的那几条，默认只给最近 ' +
    `${DEFAULT_LIST_LIMIT} 条、上限 ${MAX_LIST_LIMIT} 条，被砍时 truncated 为 true）。` +
    '**转完一批文件之后用它，而不是把 batch_convert 返回的 job_id 逐个 get_job_status**：' +
    '30 个文件一次调用就能看清谁好谁坏。' +
    '常用姿势：status:"failed" 看谁坏了、status:"unfinished" 看还剩几个在跑（= queued + running）、' +
    'since 传上一次返回里最大的 created_at 做增量。' +
    '**列表里刻意不给 log_tail**（几十条 stderr 尾部的 token 代价与它带来的信息完全不成比例）——' +
    '要在哪一条上读引擎原始报错，就用 get_job_status 单独查那一条。' +
    // 同一处取舍的第二个实例：自检的 facts 也是「每条都要几行」，**只给结论不给全文**。
    '开了 `verify` 的任务在这里只给一个 `verification_status`（consistent / differs / unknown），' +
    '完整的事实清单同样要用 get_job_status 单独查那一条（理由与 log_tail 一字不差）。',
  cancel_job:
    '取消一个排队中或运行中的任务。它会**连整棵进程树一起杀掉**——LibreOffice 会拉起 soffice.bin，' +
    '只杀父进程会留下占着 profile 锁的孤儿进程，之后所有同类转换都会静默失败。' +
    '已经结束的任务取消是空操作，返回值会如实说明它当时的状态。取消**不会留下任何残留**——' +
    '各引擎的 `.part` 临时文件在取消时都会被删掉（实测：取消后目录里既没有产物也没有 .part）。',
  read_document:
    '**直接读出文档的正文**，一次调用拿到文字，不必先 inspect_file、再 convert_file、' +
    '再去读那个产物（那是三次调用，而且产物还可能落在读不到的目录里）。' +
    '支持 `.docx`（→ md/txt）、`.xlsx`（→ csv）、文本型 `.pdf`（→ txt/md）、' +
    '以及本来就是文字的 `.md` / `.txt` / `.html` / `.rst` / `.csv`。' +
    '**它不写任何文件**：中间产物只落在系统临时目录里，用完就删，所以不会往用户的输出目录里丢东西。' +
    '⚠️ **需要重型引擎的格式这一版明确不支持，别拿它去试**：`doc` / `xls` / `ppt` / `odt` / `ods` ' +
    '要 LibreOffice（安装包 357 MiB），`epub` / `mobi` / `azw3` 要 Calibre（213 MiB）。' +
    '读一份文件的正文不该牵出一次几百 MB 的下载；这类文件要用 convert_file（它会在引擎缺失时' +
    '明确告诉你要下哪个、多大），**并且先让用户确认**。音视频 / 图片 / 压缩包没有「正文」，这个工具会直接拒。' +
    '⚠️ **图片型 / 扫描件 PDF 抽不出文字**（页面里只有图，没有文本层）。这种时候返回的是**错误**而不是空文本，' +
    '本项目不含 OCR——**重试不会有不同结果**，要看内容就改用 convert_file 转成 png/jpg 交给能看图的客户端。' +
    'format 默认 md；源格式没有这个出口时会回落到它支持的另一种，并在返回值的 warnings 里说明，' +
    '**实际拿到的是返回值里的 format**，以它为准。' +
    '结果是**截断**的：默认最多 20000 字符，`truncated: true` 时用 offset 接着读' +
    '（传上次的 offset + 这次实际拿到的字符数），total_chars 是整个正文的长度、不是这一段的长度。'
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
