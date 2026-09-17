import { McpServer, type ToolCallback } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js'
import type { z } from 'zod'
import { describeError, failureOf, McpToolError, policyFor } from './errors'
import { formatsMarkdown, listSupportedFormats } from './formatsView'
import { inspectFile } from './inspect'
import type { Job, JobRegistry, JobStatus } from './jobs'
import { normalizeExt } from './jobs'
import type { PathGate } from './paths'
import { resolveReadPath, resolveWritePath } from './paths'
import { planConversion } from './plan'
import { makeThumbnail, type Thumbnail } from './thumbnail'
import { readDocument } from './readDocument'
import {
  AUTO_TARGET,
  MAX_LIST_LIMIT,
  TOOL_DESCRIPTIONS,
  TOOL_SCHEMAS,
  type ToolName
} from './schema'

/**
 * MCP Server 本体：把本仓库的转换能力包成八个工具 + 一个 resource。
 *
 * 工具的**数量**是有意克制的（生态的共识是 1~15 个，上限断言在 `test-mcp-view.ts`）：
 * 加一个工具的成本不是那几十行，而是此后每次请求都要发给模型的一段说明书、
 * 以及它与既有工具的重叠面。**加工具的门槛是一条可计数的理由**——
 * 它替掉了几次什么调用：
 *   - `list_jobs`：`batch_convert` 转 30 个文件之后，没有它就只能对着 30 个 job_id
 *     逐个 `get_job_status`，30 → 1；
 *   - `read_document`：读一份 .docx 的正文原本要 `inspect_file` → `convert_file`
 *     （阻塞）→ 让宿主去读那个产物，3 → 1。
 * 说不出这种数字的工具不该加。
 *
 * **进程模型**：这是**一个独立的 Node 进程**，由 Claude Code 按 stdio 拉起来，
 * 不是 Electron 主进程里的一个模块。这条决定有三个后果，每一个都在代码里留了痕：
 *
 *  1. 一切路径都得**注入**（`setAppPaths()`，见 `main.ts`）——这里没有 `app.getPath`。
 *  2. **`stdout` 是协议的**。往 `process.stdout` 写一个字节就破坏 JSON-RPC 帧，
 *     客户端表现为「连着连着就断了」，而服务端什么错都不报。日志一律 stderr。
 *  3. 引擎的加载路径必须真的脱得开 electron——那正是 M3 做的事（`converters/index.ts`
 *     的按需 `import()` + `engines/registry.ts` 不读 `app`）。这个进程是那条约束的
 *     **唯一消费者**，也是它的验收现场。
 *
 * **与 PLAN 的一处偏离（如实记下）**：PLAN 的 M4 写的是「`TaskManager` 的增量 patch
 * ↔ `notifications/progress`，现有实现能直接对接，不用新写」。实际不行——`TaskManager`
 * 活在 Electron 主进程里（它构造时要一个往渲染进程广播 patch 的回调，还牵着 IPC 契约类型），
 * 而这条线的前提恰恰是**没有 Electron**。所以这里用的是 `jobs.ts` 的 `JobRegistry`：
 * 它复用真正可复用的那部分（`converters/index.ts` 的路由、`core/cancel.ts` 的进程树杀灭、
 * `core/outputName.ts` 的命名与占位），只重写「队列」这一层。
 */

export interface ServerDeps {
  gate: PathGate
  registry: JobRegistry
  /** 进程启动时的工作目录。相对路径按它解析，同时也是默认的读根之一。 */
  cwd: string
  version: string
}

/** 工具结果里的内容块。文字**永远**是第一块——见 `previewOf` 的说明。 */
type ContentBlock =
  { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }

/** 工具结果统一走这一个出口，省得六处各写一遍 content 数组的形状。 */
function ok(
  payload: unknown,
  /**
   * 追加在文字块**之后**的内容块（目前只有 R20 的产物缩略图会用到）。
   *
   * ⚠️ **文字块一定是第一块，而且必须自足**：生态里**有客户端会静默丢掉 image block**
   * （不是报错，是那一块根本不渲染、也不转发给模型）。把「转出来多大」只放在图里，
   * 等于把「agent 能不能回答」押在客户端的渲染实现上。
   */
  extra: ContentBlock[] = []
): {
  content: ContentBlock[]
  structuredContent?: Record<string, unknown>
} {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2)
  // MCP 要求 structuredContent 是 object，所以数组要包一层再给。
  // **不能不包就丢**：`list_supported_formats` 返回的正是数组，早先那版在结构化那一侧
  // 整个消失，客户端只能去 parse text——「工具返回了什么」不该取决于调用方会不会
  // 解析字符串。（这是本套件第一次跑就抓到的一处，见 test-mcp-server 第 7 条。）
  if (Array.isArray(payload)) {
    return {
      content: [{ type: 'text', text }, ...extra],
      structuredContent: { results: payload }
    }
  }
  if (typeof payload === 'object' && payload !== null) {
    return {
      content: [{ type: 'text', text }, ...extra],
      structuredContent: payload as Record<string, unknown>
    }
  }
  return { content: [{ type: 'text', text }, ...extra] }
}

/**
 * 错误出口。
 *
 * **三个都必须做对**：
 *   - 一律 `isError: true` 而**不是抛出去**。抛出去会变成 JSON-RPC 层的错误，
 *     有些客户端把它渲染成「服务器出错了」，agent 拿不到我们精心写的那句中文。
 *   - `hint` 一定要带上。agent 读不到源码也看不到 UI，hint 里那份「合法目标是哪些」
 *     是它下一轮能自己改对的唯一依据。
 *   - **机器可读的那三项（`code` / `retryable` / `next_steps`）跟在后面**。
 *     它们与 hint 一起序列化成**同一个 JSON 对象**，而不是另发一段：agent 那一侧
 *     只需要抠一处就能同时拿到「数据」（targets 清单）与「动作」（下一步做什么）。
 *     三项在前、hint 在后，是因为前三项是所有失败共有的、hint 是这一条特有的。
 *
 * ⚠️ 这段文本**不许**把 `log_tail` 挤掉（它由 `jobFailure` 塞进 hint）：
 * 错误码只回答「该不该重试」，引擎的原始报错仍然只有 stderr 尾部说得清。
 */
function fail(error: unknown): {
  content: { type: 'text'; text: string }[]
  isError: true
} {
  const fields = failureOf(error)
  const body: Record<string, unknown> = {
    code: fields.code,
    retryable: fields.retryable,
    next_steps: fields.next_steps,
    ...fields.hint
  }
  const parts = [describeError(error), '', JSON.stringify(body, null, 2)]
  return { content: [{ type: 'text', text: parts.join('\n') }], isError: true }
}

/**
 * 给 `get_job_status` / `cancel_job` / `convert_file` 用的投影。只报 agent 用得上的字段。
 *
 * 失败时给**完整的三项**（`error_code` / `retryable` / `next_steps`），与错误出口
 * 同一套语义、同一张码表：列表里省掉的那两项（见 `jobSummary`）在这里补齐，
 * 「同一件事在两条路上说法不同」是 agent 最容易踩空的一类不一致。
 */
function jobView(job: Job): Record<string, unknown> {
  const policy = job.errorCode === undefined ? null : policyFor(job.errorCode)
  return {
    job_id: job.id,
    status: job.status,
    source: job.source,
    output: job.output,
    from: job.fromExt,
    to: job.toExt,
    engine: job.engine,
    mode: job.mode,
    // 回显它，agent 才看得见自己插的队**生效了没有**。默认 0 也照给：
    // 「没给」与「给了 0」是同一件事，省掉那一格反而要多解释一句。
    priority: job.priority,
    progress: job.progress,
    ...(job.sizeBytes === undefined ? {} : { size_bytes: job.sizeBytes }),
    ...(job.error === undefined ? {} : { error: job.error }),
    ...(job.errorCode === undefined ? {} : { error_code: job.errorCode }),
    ...(policy === null ? {} : { retryable: policy.retryable, next_steps: policy.next_steps }),
    ...(job.logTail === undefined ? {} : { log_tail: job.logTail }),
    // 产物自检（E-6）**原样带出**，与 `log_tail` 同一档待遇：它是「退出码 0」之外
    // 唯一能回答「产物到底对不对」的东西，而这里正是「单独查那一条」的那个工具。
    // 没开 `verify` 的 job 上这个键**不出现**（不是空壳），于是「默认关」可观测。
    ...(job.verification === undefined ? {} : { verification: job.verification })
  }
}

/**
 * 产物缩略图（R20）。**默认关**，用 `ARBITER_MCP_THUMBNAILS=1` 打开。
 *
 * 三个刻意的决定：
 *
 * 1. **只在 `convert_file` 里取，`get_job_status` 不取。** 轮询那条路上每问一次
 *    就要重编一张缩略图，而 agent 常常连着问十几次——那是白烧 CPU。
 *    「刚转完，看一眼」才是这个功能的用途。
 * 2. **开关走环境变量而不是设置项**：它是 MCP 面的行为，而 MCP 就是在 `.mcp.json`
 *    里配的（同一个文件里还有 `ARBITER_MCP_WRITE_ROOTS` 那几项）。放进 GUI 设置页
 *    反而要解释「为什么桌面端有个我看不见的开关」。
 *    取值形状照 `ARBITER_IS_PACKAGED` 的先例：**只有 `'1'` 才算开**。
 * 3. **失败一律当作「没有缩略图」**（`makeThumbnail` 自己吞掉一切异常并回 `null`）。
 *    为了锦上添花的东西让一次成功的转换回一个错误，是把主次颠倒了。
 */
async function previewOf(job: Job): Promise<Thumbnail | null> {
  if (process.env.ARBITER_MCP_THUMBNAILS !== '1') return null
  if (job.output === undefined) return null
  return makeThumbnail(job.output, job.toExt, job.sizeBytes ?? 0)
}

/**
 * `list_jobs` 里每一条的投影：**比 `jobView` 更瘦**，两处刻意的差别。
 *
 *  1. **没有 `log_tail`。** 三十条 stderr 尾部能吃掉几千 token，而列表的用途是
 *     「谁好谁坏」；要读原始报错就 `get_job_status` 单独查那一条。这是一处**设计**，
 *     不是遗漏——`test-mcp-server.ts` 里有一条断言专门钉它（并且有对照：
 *     同一个 job 走 `get_job_status` 是**有** log_tail 的，否则那条断言在
 *     「压根没有任何 job 失败过」时也照样绿）。
 *  2. **只给 `error_code`，不给 `retryable` / `next_steps`。** 后两项是同一张码表的
 *     确定性投影（`policyFor`），逐条重复三十遍纯属浪费；单查那一条时自然会给。
 *
 * `mode` 也省掉了：agent 自己刚发的那批参数是什么它知道，而 `to` 必须留着——
 * `target_format: "auto"` 时**每条 job 的目标格式是算出来的**，不逐条回显，
 * agent 就只能猜我们替它选了什么。
 */
function jobSummary(job: Job): Record<string, unknown> {
  return {
    job_id: job.id,
    status: job.status,
    source: job.source,
    output: job.output,
    from: job.fromExt,
    to: job.toExt,
    engine: job.engine,
    created_at: job.createdAt,
    ...(job.finishedAt === undefined ? {} : { finished_at: job.finishedAt }),
    ...(job.progress === null ? {} : { progress: job.progress }),
    ...(job.sizeBytes === undefined ? {} : { size_bytes: job.sizeBytes }),
    ...(job.error === undefined ? {} : { error: job.error }),
    ...(job.errorCode === undefined ? {} : { error_code: job.errorCode }),
    // 自检**只给结论**，理由与上面省略 `log_tail` 那条一字不差：`facts` 每条都是
    // 一句话，几十条就能吃掉几千 token，而列表的用途是「谁好谁坏」。要读某个 job 的
    // 事实清单，用 get_job_status 单独查那一条（那里给的是完整的 `verification`）。
    ...(job.verification === undefined ? {} : { verification_status: job.verification.status })
  }
}

/**
 * 注册一个 MCP 工具。**说明书从 `TOOL_DESCRIPTIONS[name]` 取，调用点连写都写不出来。**
 *
 * 这层包装是被一个真 bug 逼出来的（2026-09-13）：`convert_file` 注册时取的描述是
 * `TOOL_DESCRIPTIONS.read_document`——最常用的那个工具，客户端读到的说明书是别人的。
 * 而**光把那个字符串改对是不够的**：那个错误之所以能存在，是因为「注册用的工具名」
 * 与「取描述用的工具名」是**两个可以各写各的字面量**（`server.registerTool('convert_file', …)`
 * 里的 `'convert_file'` 与 `description: TOOL_DESCRIPTIONS.???`）。只要还允许在调用点
 * 写 description，同一个错误就会在下一次复制粘贴时再犯一次。
 *
 * 所以这里把名字收成**唯一一个来源**：调用点给 `name`，description 由它派生。
 * 类型上 `TOOL_DESCRIPTIONS` 是 `Record<ToolName, string>`，`name` 是 `ToolName`，
 * 于是「注册了一个没写说明书的工具」与「说明书张冠李戴」都不再可能。
 *
 * ⚠️ **`title` 仍然留在调用点**：它是给人看的短标签（也是工具名的中文对应），
 * 每个工具都不一样，没有办法派生——但它不承担「模型要靠它决定怎么调」这件事，
 * 那是 description 的活。
 */
function registerArbiterTool<InputArgs extends z.ZodRawShape>(
  server: McpServer,
  name: ToolName,
  config: { title: string; inputSchema: InputArgs; annotations?: ToolAnnotations },
  handler: ToolCallback<InputArgs>
): void {
  server.registerTool(name, { ...config, description: TOOL_DESCRIPTIONS[name] }, handler)
}

export function createServer(deps: ServerDeps): McpServer {
  const server = new McpServer({ name: 'arbiter', version: deps.version })

  /* ------------------------------------------------------------ convert_file */

  registerArbiterTool(
    server,
    'convert_file',
    {
      title: '转换单个文件',
      // **说明书不在调用点**：`registerArbiterTool` 按 name 从 `TOOL_DESCRIPTIONS` 取。
      // 这里曾经写的是 `TOOL_DESCRIPTIONS.read_document`（最常用的那个工具，说明书
      // 是别人的）——那类错误现在在结构上写不出来，见上面那层包装的注释。
      inputSchema: TOOL_SCHEMAS.convert_file.shape,
      // 注释里写清楚为什么：这个工具会长时间占用（转视频可能几分钟），
      // 客户端据此才知道可以发取消。
      annotations: { readOnlyHint: true, idempotentHint: true }
    },
    async (args, extra) => {
      try {
        const source = resolveReadPath(deps.gate, args.source, deps.cwd)
        const outputPath =
          args.output_path === undefined
            ? undefined
            : resolveWritePath(deps.gate, args.output_path, deps.cwd)

        // E-5：只预览。**闸门照走**（与真跑同一条 `resolveWritePath`：预览一次
        // 越界的 output_path 也必须被拒，否则 agent 会以为「这条路走得通」），
        // 而 `planConversion` 内部走的校验/落点计算与下面的 `submit()` 是**同一份**
        // （见 `jobs.ts` 的 `preview()`），所以它抛出的错由下面同一个 `catch` 交给
        // 同一个 `fail()`——预览与真跑在「不行」这件事上是**字节相同的回话**。
        if (args.dry_run === true) {
          return ok(
            await planConversion(deps.registry, {
              source,
              toExt: args.target_format,
              ...(outputPath === undefined ? {} : { outputPath }),
              ...(args.mode === undefined ? {} : { mode: args.mode })
            })
          )
        }

        const job = deps.registry.submit({
          source,
          toExt: args.target_format,
          // 这里**不**传 `outputComputed`：`output_path` 是用户点名的路径，于是
          // 它已经存在时会被 `resolveOutput` 当场拒掉（`output_conflict`），
          // 而不是悄悄改道成 `report (1).pdf`。`submit()` 的默认档就是「点名」那一档。
          ...(outputPath === undefined ? {} : { outputPath }),
          ...(args.mode === undefined ? {} : { mode: args.mode }),
          // `=== true` 而不是直接把 `args.verify` 传下去：`.default(false)` 在 SDK
          // 那侧有没有被应用、`args.verify` 是 `false` 还是 `undefined`，两件事都不该
          // 影响这条判据——**只有明确给了 `true` 才开**（默认关是承重的，见 schema.ts）。
          verify: args.verify === true,
          priority: args.priority
        })

        // 进度：MCP 的进度通知必须带**客户端给的那个 progressToken**，没有它
        // 发出去的通知会被丢弃（而不是报错），表现为「进度条一动不动」。
        const token = extra._meta?.progressToken
        const finished = await deps.registry.waitFor(job.id, {
          signal: extra.signal,
          onProgress: (current) => {
            if (token === undefined) return
            const percent =
              current.progress?.kind === 'determinate' ? current.progress.percent : undefined
            void server.server
              .notification({
                method: 'notifications/progress',
                params: {
                  progressToken: token,
                  // MCP 要的是「已完成多少」，不是「百分比」；没有百分比时退到 0，
                  // 并靠 message 说明当前在做什么。
                  progress: percent === undefined ? 0 : Math.round(percent),
                  total: 100,
                  message:
                    current.progress?.kind === 'indeterminate' ? current.progress.stage : '转换中'
                }
              })
              .catch(() => {
                // 通知发不出去不该让整个转换失败：产物已经在写了。
              })
          }
        })

        if (finished === null) return fail(new McpToolError('这个 job 不见了（内部状态异常）'))
        if (finished.status !== 'done') return fail(jobFailure(finished))

        const view = jobView(finished)
        const preview = await previewOf(finished)
        if (preview === null) return ok(view)

        // 尺寸是**文字事实**里最后缺的那一项（格式 = `to`、体积 = `size_bytes`，
        // 两者 `jobView` 里本来就有）。写进文字块之后，客户端把图丢掉时
        // agent 照样答得出「转出来多大」。
        view.output_pixels = { width: preview.facts.width, height: preview.facts.height }
        return ok(view, [{ type: 'image', data: preview.data, mimeType: preview.mimeType }])
      } catch (error) {
        return fail(error)
      }
    }
  )

  /* ---------------------------------------------------- list_supported_formats */

  registerArbiterTool(
    server,
    'list_supported_formats',
    {
      title: '列出支持的格式',
      inputSchema: TOOL_SCHEMAS.list_supported_formats.shape,
      annotations: { readOnlyHint: true, idempotentHint: true }
    },
    async (args) => {
      try {
        return ok(listSupportedFormats(args.category))
      } catch (error) {
        return fail(error)
      }
    }
  )

  /* --------------------------------------------------------------- inspect_file */

  registerArbiterTool(
    server,
    'inspect_file',
    {
      title: '侦察一个文件',
      inputSchema: TOOL_SCHEMAS.inspect_file.shape,
      annotations: { readOnlyHint: true, idempotentHint: true }
    },
    async (args) => {
      try {
        const target = resolveReadPath(deps.gate, args.path, deps.cwd)
        return ok(await inspectFile(target))
      } catch (error) {
        return fail(error)
      }
    }
  )

  /* -------------------------------------------------------------- batch_convert */

  registerArbiterTool(
    server,
    'batch_convert',
    {
      title: '批量转换',
      inputSchema: TOOL_SCHEMAS.batch_convert.shape,
      annotations: { readOnlyHint: false, destructiveHint: false }
    },
    async (args) => {
      const submitted: Record<string, unknown>[] = []
      const rejected: Record<string, unknown>[] = []
      const isAuto = normalizeExt(args.target_format) === AUTO_TARGET

      for (const raw of args.sources) {
        try {
          const source = resolveReadPath(deps.gate, raw, deps.cwd)
          const job = deps.registry.submit({
            source,
            toExt: args.target_format,
            // `outputComputed: true` —— 这个落点是**我们**按 `output_dir` + 源文件名
            // 算出来的，不是用户点名的。于是同名的产物已经存在时照旧改名，
            // 而不是把「同一批再跑一次」变成整批被拒：那条路上 agent 没有任何
            // 办法逐条改名，套用点名那条规则就是**把一个可恢复的情形做成死路**
            // （理由见 `jobs.ts` 的 `submit`）。两条路必须给出不同的答案。
            ...(args.output_dir === undefined
              ? {}
              : { outputPath: joinOutput(deps, args.output_dir, source), outputComputed: true }),
            // 与 `convert_file` 同一条判据（同一份 schema，见 schema.ts 的 verifySchema）。
            // 批量时它是**逐条**的：N 个文件 = 2N 个额外子进程，说明书里点明了这笔账。
            verify: args.verify === true,
            // 整批一个值（schema 的说明里写了为什么不做逐条）
            priority: args.priority
          })
          // `from` / `to` **逐条回显**：`target_format: "auto"` 时每条的目标格式是
          // 各自算出来的（png 走图片偏好、mp4 走视频偏好），不回显就只能靠猜。
          // 顶层那个 `target_format` 回显的是**请求**（可能是 "auto"），两者都要有。
          submitted.push({
            job_id: job.id,
            source: job.source,
            output: job.output,
            from: job.fromExt,
            to: job.toExt
          })
        } catch (error) {
          // 一条坏的不该让整批失败：agent 常常一次丢进来十来个文件，
          // 其中一个扩展名不对就整批拒绝，是它最难自己修的那种失败。
          //
          // 被拒的条目与错误出口用**同一套**机器可读字段（code / retryable /
          // next_steps），后面跟着 hint 里的数据（targets 清单、engine、要被下载的
          // 那个引擎名……）：agent 只看 rejected 数组就能知道每一条该怎么修。
          const fields = failureOf(error)
          rejected.push({
            source: raw,
            error: describeError(error),
            code: fields.code,
            retryable: fields.retryable,
            next_steps: fields.next_steps,
            ...fields.hint
          })
        }
      }

      return ok({
        target_format: normalizeExt(args.target_format),
        submitted,
        rejected,
        note: [
          rejected.length > 0
            ? '被拒的那些没有入队，每条的 code / next_steps 说明了原因与改法，修好后可以单独再调 batch_convert。'
            : '全部已入队，用 list_jobs 一次看完整批（status:"failed" 看谁坏了）。',
          ...(isAuto
            ? [
                `target_format 是 "${AUTO_TARGET}"：每条 job 的 to 是**各自**解析出来的实际目标格式，以它为准。`
              ]
            : [])
        ].join('')
      })
    }
  )

  /* ------------------------------------------------------------ get_job_status */

  registerArbiterTool(
    server,
    'get_job_status',
    {
      title: '查询任务状态',
      inputSchema: TOOL_SCHEMAS.get_job_status.shape,
      annotations: { readOnlyHint: true, idempotentHint: true }
    },
    async (args) => {
      const job = deps.registry.get(args.job_id)
      if (job === null) {
        // 带上还活着的 job 列表：agent 拿到的 job_id 记错一位时，
        // 它能立刻看出「我用错 id 了」而不是「任务丢了」。
        return fail(
          new McpToolError(
            `没有这个 job：${args.job_id}`,
            { known_job_ids: deps.registry.list().map((j) => j.id) },
            { code: 'unknown_job' }
          )
        )
      }
      return ok(jobView(job))
    }
  )

  /* ----------------------------------------------------------------- list_jobs */

  registerArbiterTool(
    server,
    'list_jobs',
    {
      title: '列出任务',
      inputSchema: TOOL_SCHEMAS.list_jobs.shape,
      annotations: { readOnlyHint: true, idempotentHint: true }
    },
    async (args) => {
      try {
        return ok(listJobsView(deps.registry.list(), args))
      } catch (error) {
        return fail(error)
      }
    }
  )

  /* --------------------------------------------------------------- cancel_job */

  registerArbiterTool(
    server,
    'cancel_job',
    {
      title: '取消任务',
      inputSchema: TOOL_SCHEMAS.cancel_job.shape,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true }
    },
    async (args) => {
      const job = deps.registry.cancel(args.job_id)
      if (job === null) {
        return fail(
          new McpToolError(
            `没有这个 job：${args.job_id}`,
            { known_job_ids: deps.registry.list().map((j) => j.id) },
            { code: 'unknown_job' }
          )
        )
      }
      return ok(jobView(job))
    }
  )

  /* ----------------------------------------------------------- read_document */

  registerArbiterTool(
    server,
    'read_document',
    {
      title: '读出文档正文',
      // 它与 `inspect_file` 是**互补**的，不是重叠的：那条回答「这是什么、能转成什么」，
      // 这条把正文直接拿出来。annotation 与 inspect_file 同档——只读、幂等、不动源文件
      // （中间产物落系统临时目录，用完就删）。
      inputSchema: TOOL_SCHEMAS.read_document.shape,
      annotations: { readOnlyHint: true, idempotentHint: true }
    },
    async (args, extra) => {
      try {
        // 闸门照旧走读路径：对面是一个自主 agent，它的路径可能来自被喂进来的文件内容。
        // 写路径这边**一次都不碰**——临时目录是我们自己造的，与它给的任何东西无关。
        const target = resolveReadPath(deps.gate, args.source, deps.cwd)
        return ok(
          await readDocument({
            path: target,
            format: args.format,
            // `max_chars` 的上限**不在这里夹**：夹的动作要能带出一句「被砍了」的说明，
            // 而那属于返回值（`readDocument` 里统一处理），不是参数校验。
            maxChars: args.max_chars,
            offset: args.offset,
            ...(extra.signal === undefined ? {} : { signal: extra.signal })
          })
        )
      } catch (error) {
        return fail(error)
      }
    }
  )

  /* ----------------------------------------------------------------- resource */

  server.registerResource(
    'formats',
    'converter://formats',
    {
      title: '能力矩阵',
      description:
        '全部六个大类的转换能力，一张 markdown 表。读一次就知道全局，' +
        '不必用 list_supported_formats 来回试探。',
      mimeType: 'text/markdown'
    },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: 'text/markdown', text: formatsMarkdown() }]
    })
  )

  return server
}

/**
 * 失败时给 agent 的那句话：把 `error` / `log_tail` / 取消三种情况分开说。
 *
 * `log_tail` **必须在**：它是这个项目相对同类最有价值的一件东西（agent 比用户
 * 更能读引擎的 stderr），而码表那一层只回答「该不该重试」，回答不了「哪一行不对」。
 * 这条路径与 `get_job_status` 的区别只是**时机**——它是当场等结果的那条路。
 */
function jobFailure(job: Job): McpToolError {
  if (job.status === 'canceled') {
    return new McpToolError(
      '这个转换被取消了，没有产物。',
      { job_id: job.id },
      { code: 'canceled' }
    )
  }
  return new McpToolError(
    job.error ?? '转换失败',
    {
      job_id: job.id,
      ...(job.logTail === undefined ? {} : { log_tail: job.logTail })
    },
    // 没有码时退到 `source_corrupt`：能走到这里的失败都是「引擎那边没能完成」，
    // 而 `internal`（可重试）会把 agent 引向无意义的重试。真·内部异常在
    // `jobs.ts` 里就已经被标成 `internal` 了，不会落到这个默认值上。
    { code: job.errorCode ?? 'source_corrupt' }
  )
}

/**
 * `list_jobs` 的过滤取值 = 五种真实状态 + `unfinished` 这个别名。
 *
 * 从 `JobStatus` 派生而不是另抄一份字面量：引擎那边加一种状态时，这里会跟着有
 * （而抄一份的话，新状态能产生、却永远筛不出来，且不报错）。
 */
type ListStatus = JobStatus | 'unfinished'

/** 状态过滤。`unfinished` 是别名（queued + running），见 `schema.ts` 的说明。 */
function matchesStatus(job: Job, status: ListStatus | undefined): boolean {
  if (status === undefined) return true
  if (status === 'unfinished') return job.status === 'queued' || job.status === 'running'
  return job.status === status
}

/** 全局计数。**算的是全部 job**，不是筛出来的那一批——它的用途正是「一眼看全局」。 */
function countsOf(all: Job[]): Record<JobStatus, number> & { total: number } {
  const counts = { total: all.length, queued: 0, running: 0, done: 0, failed: 0, canceled: 0 }
  for (const job of all) counts[job.status] += 1
  return counts
}

/**
 * `list_jobs` 的视图。
 *
 * 三条承重的约定：
 *
 *  1. **新的在前**（`createdAt` 降序）。旧的在前的话，截断永远砍掉最新的那几条——
 *     agent 刚发完一批、回头看进度，看到的却是几小时前那批。
 *  2. `limit` **在这里夹到 `MAX_LIST_LIMIT`**，而不是写进 zod 的 `.max()`：
 *     schema 那一侧越界会变成 SDK 的参数校验错误（一条 JSON-RPC 的报错），
 *     而 agent 拿到的是「我的调用坏了」；夹一下 + `truncated: true` 才是可读的结果。
 *  3. `truncated` **如实反映**「有没有被砍」：它的判据是「筛出来的条数 > 实际返回的
 *     条数」。**不许**写成「limit 到了上限」——那是两回事。
 */
function listJobsView(
  all: Job[],
  args: { status?: ListStatus; limit: number; since?: number }
): Record<string, unknown> {
  const matching = all
    .filter(
      (job) =>
        matchesStatus(job, args.status) && (args.since === undefined || job.createdAt >= args.since)
    )
    // 同一毫秒里建的那几个用 id 兜底排序，让同一个登记表每次给出同一个顺序。
    .sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))

  const jobs = matching.slice(0, Math.min(args.limit, MAX_LIST_LIMIT)).map(jobSummary)
  return {
    counts: countsOf(all),
    matching: matching.length,
    truncated: matching.length > jobs.length,
    jobs
  }
}

/**
 * 批量的输出目录：把每个源文件的**基础名**接到 `output_dir` 下面。
 *
 * 用 `basename` 而不是原始路径拼接，是因为源文件可能散在不同的目录里，
 * 直接拼会把目录层级带进去（`--sources D:\a\x.mkv E:\b\y.mkv --output_dir C:\out`
 * 会变成 `C:\out\D:\a\x.mkv` 这种不可能存在的路径）。
 */
function joinOutput(deps: ServerDeps, outputDir: string, source: string): string {
  const dir = resolveWritePath(deps.gate, outputDir, deps.cwd)
  const base = source.replace(/\\/g, '/').split('/').pop() ?? source
  return resolveWritePath(deps.gate, `${dir}/${base}`, deps.cwd)
}
