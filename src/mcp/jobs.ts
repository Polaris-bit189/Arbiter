import { randomUUID } from 'crypto'
import { existsSync, statSync } from 'fs'
import { stat } from 'fs/promises'
import { dirname } from 'path'
import type { EngineKey, RemuxMode, TaskProgress } from '@shared/types'
import {
  categoryOf,
  engineFor,
  extOf,
  requiresDownload,
  resolveDefaultTarget,
  targetsFor
} from '@shared/formats'
import { convert, ConversionCanceled, ConversionFailed } from '../main/converters'
// 「产物不得为空」的判据与文案**取自共用件**，不在这里就地写一份。
// 审计（2026-09-02 分发版）抓到的正是「同一条规矩在两个入口各写各的」：
// MCP 这条报 `source_corrupt`，GUI 那条把同一个文件显示成「已成」——
// **一个文件两个答案**就是问题本身，所以两侧必须读同一份。
import { EMPTY_OUTPUT_MESSAGE, isEmptyOutput } from '../main/converters/common'
import { CancelToken } from '../main/core/cancel'
import { resolveOutputPath } from '../main/core/outputName'
// ⚠️ 这两个是**按引擎限流的同一份常量**，不是在这里抄一份表：GUI 的 `EngineQueue`
// 与 MCP 的 `JobRegistry` 必须给出同一个答案（见文件头第 3 条）。
// `core/queue.ts` 的依赖图只有 `node:os` + 一个 type-only 的 `@shared/types`，
// **一个 electron 都不碰**，所以它能被拉进这个没有 Electron 的进程里。
import { engineLimit, taskCost } from '../main/core/queue'
import { getSettings, outputDirFor } from '../main/core/settings'
import { engineLabel, engineReady } from '../main/engines/status'
import type { ErrorCode } from './errors'
import { McpToolError } from './errors'
import { AUTO_TARGET, MAX_PRIORITY, MIN_PRIORITY } from './schema'
import { selfCheck } from './selfCheck'
import type { Verification } from './verify'

/**
 * MCP 侧的任务登记处。
 *
 * **为什么不复用 `TaskManager`**：那个类是**界面队列**——它按引擎分桶、尊重用户在设置页
 * 配的并发上限与输出目录规则、每个状态迁移都往渲染进程推一份增量 patch。MCP 这边没有
 * 渲染进程，而且它对「一批文件同时转」的期望完全不同：agent 要的是**每个 job_id 一个
 * 明确的答案**，不是一张卡片列表。把 UI 队列塞进 headless 进程，等于让它背着
 * 一整条与它无关的依赖链（settings / IPC 契约 / 广播）跑。
 *
 * 三处**刻意照抄**了 `TaskManager` 的既有裁决，因为它们是不变量而不是 UI 细节：
 *   1. 输出名占位（`claimed`）。见 docs/NOTES.md 约束 9：`resolveOutputPath` 只看磁盘，
 *      两个并发任务在各自写 `.part` 期间磁盘上还没有最终文件，会解析到同一个名字，
 *      后完成的静默覆盖先完成的。
 *   2. `toExt` 必须过 `targetsFor()`。矩阵说不能转的组合**在这里就拒**，
 *      而不是起一个进程等它失败——agent 拿到的是一句带合法目标清单的话。
 *   3. **按引擎的并发容量**（`core/queue.ts` 的 `ENGINE_CAPACITY`，经 `engineLimit()` 取）。
 *      这一条曾经漏掉，代价是这里与 GUI **对同一件事给出两个答案**：GUI 侧写着
 *      `libreoffice: 1`，理由就明明白白地写在表上——
 *      「单进程单 profile：第二个实例会静默把参数转交给第一个，退出码 0 却不产生产物」——
 *      而 MCP 侧只有全局 `maxRunning`（默认 2），于是两个并发 `convert_file`
 *      （或 MCP 与 GUI 同时）能真的拉起两个 LibreOffice，正好落进那个静默失败模式。
 *      `converters/libreoffice.ts` 还叠加一层：它把输入复制到用户输出目录下、
 *      暂存名只由输出路径推导（`<stem>.part.<fromExt>`），两个作业会共用同一个暂存文件。
 *      **表只有一份**：漏一个引擎就是编译错误，改一处两边同时生效。
 *
 * 全局并发上限比 UI 那边保守得多：MCP 的调用者是一个会连着发好几轮的 agent，
 * 它不会替你想「这会不会把用户机器打满」。**引擎容量是另一个维度的闸门**，
 * 它不由用户调、也不该由 MCP 另定一档（那不是保守，那是第二份真相）。
 */

/**
 * 同时最多跑几个。默认 2。
 *
 * 定得比 UI 那边（`AUTO_CONCURRENCY`，最多 4）低，是因为**这个数字不是给用户调的**：
 * agent 一发 batch 就可能来几十个文件，而它不看进度条。2 个并发 + 排队，
 * 让 `get_job_status` 永远能立刻回答，也不会把机器占满到界面点不动。
 *
 * ⚠️ **这是「任务个数」的闸门，不是「这个引擎撑得住几路」**。后者在
 * `core/queue.ts` 的 `ENGINE_CAPACITY` 里，**两边共用同一份**（见文件头第 3 条）：
 * 真正生效的并发 = min(这个数, 该引擎的容量, 任务按代价分摊的份数)。
 * 把两者合并成一个数字是走不通的——`libreoffice: 1` 与「同时最多 2 条任务」
 * 回答的是两个不同的问题。
 */
const DEFAULT_MAX_RUNNING = 2

/** 只保留这么多条已结束的 job，防 agent 长期挂着把内存吃光。 */
const KEEP_FINISHED = 200

/** MCP 工具那一侧的用词（`convert_file` 的 `mode` 参数） */
// ⚠️ 定义已挪到 `@shared/types`（R15 的配方文件在 `src/shared/`，而那个目录不许引
// `src/mcp`）。这里**既 import 又 export**：前者是为了本文件自己用得着，
// 后者是为了 `plan.ts` 那条从 `./jobs` 引它的写法一个字都不用改。
export type { RemuxMode }

/**
 * `submit()` 与 `preview()` 共用的入参。**一份定义，两条路用**——
 * 两条路各写一份形状的话，加一个参数时总有一条会被落掉，而落掉的那条
 * 不报错：预览照旧说「能转」，真跑时那个参数却是默认值。
 */
export interface RouteSpec {
  source: string
  toExt: string
  outputPath?: string
  /**
   * `outputPath` 是**调用方按自己的规则算出来的**（`batch_convert` 的
   * `output_dir` + 源文件名），不是用户点名要的那一个。
   *
   * **默认是 `false`，也就是「它是用户要的那个」**——默认档必须是最严的那一档，
   * 因为 `outputPath` 这个字段的绝大多数来源都是「有人明确说了写到哪儿」：
   * `convert_file` 的 `output_path`、CLI 的 `--out`。反过来把默认设成宽松的话，
   * 将来多一个入口就会**静默**退回「悄悄改名」那条路，而这里不会有人报错。
   *
   * 区别是承重的：**只有点名的那条路会在目标已存在时拒**（见 `resolveOutput`）。
   * 批量那条路的落点是**我们**定的，产物与「把这一批转进那个目录」这个请求完全相符，
   * 而且每条 job 都回显了实际的 `output`；对它套用同一条拒绝规则会让
   * 「同一批再跑一次」变成整批被拒，而 agent 没有任何办法逐条改名——
   * 那是把一个可恢复的情形做成死路。
   */
  outputComputed?: boolean
  mode?: RemuxMode
}

/**
 * 一条转换的「路由」：**校验通过之后、真正开工之前的全部结论**。
 *
 * 它就是 `preview()` 的返回值，而 `submit()` 也是先算出它、再去登记与入队——
 * 于是「预览会怎么走」与「真跑怎么走」不是两套逻辑，是同一份值。
 */
export interface PlannedRoute {
  source: string
  fromExt: string
  toExt: string
  engine: EngineKey
  /** 产物落点。**`preview()` 给的这个值此刻还没有被占用**（见 `preview()` 的说明） */
  output: string
  mode: RemuxMode
}

/** 转换器那一侧的用词（`ConvertContext.remux`）。两套词**只在这一处交汇**。 */
type RemuxHint = 'auto' | 'force' | 'off'

function remuxHintOf(mode: RemuxMode): RemuxHint {
  switch (mode) {
    case 'auto':
      return 'auto'
    case 'remux':
      return 'force'
    case 'reencode':
      return 'off'
  }
}

export type JobStatus = 'queued' | 'running' | 'done' | 'failed' | 'canceled'

export interface Job {
  id: string
  source: string
  output: string
  fromExt: string
  toExt: string
  engine: EngineKey
  mode: RemuxMode
  status: JobStatus
  /**
   * 排队优先级（R16）。0 是默认档，越大越先跑。
   *
   * ⚠️ **它只在排队时起作用**：已经在跑的任务永远不会被抢——转换没有「暂停」
   * 这回事，而一个「插队把别人挤下去」的队列在 agent 眼里与「任务莫名其妙消失了」
   * 是同一种。批量时给整批一个值，不是逐条。
   */
  priority: number
  progress: TaskProgress | null
  /** 失败时的可读原因（agent 直接读这一句） */
  error?: string
  /**
   * 失败原因的**机器可读**版本（见 `errors.ts` 的码表）。
   *
   * 存在 job 上而不是只在工具结果里现算，是因为**失败发生在排队之后**：
   * `convert_file` 是当场等结果的那条路，`batch_convert` 却不是——它立刻返回，
   * 失败信息只能在之后由 `list_jobs` / `get_job_status` 读出来。那条路要能给出
   * 同一个码，就得在落定的那一刻把它记下来。
   */
  errorCode?: ErrorCode
  /** stderr 尾部，供 agent 分辨「是文件坏了还是参数不对」 */
  logTail?: string[]
  /**
   * 产物自检（E-6）。**只有提交时给了 `verify: true` 的 job 才有这个字段**——
   * 没开时连键都不出现，「默认关」因此是可观测的（而不是一个恒为空的壳）。
   *
   * 它在 job **落定之前**就算好了（见 `run()`），所以 `convert_file` 的返回值与
   * 之后任何一次 `get_job_status` 读到的是同一份，不会出现「第一次查还没有、
   * 第二次查才出现」那种随调用时机变的形状。
   */
  verification?: Verification
  sizeBytes?: number
  createdAt: number
  startedAt?: number
  finishedAt?: number
}

/** 排队/运行中的一个 job：`Job` 是给外面看的投影，这份是调度器的私有状态 */
interface Queued {
  id: string
  source: string
  output: string
  fromExt: string
  toExt: string
  mode: RemuxMode
  /** 这条占哪个引擎的容量（准入判据按它查表） */
  engine: EngineKey
  /** 占几份。由 `taskCost()` 算出来，与 GUI 那条路同一份规则 */
  cost: number
  /**
   * 跑完之后要不要做产物自检（E-6）。**只存在这份私有状态里**，不进 `Job` 的投影：
   * 它不是「这个任务是什么」，而是「这一次跑完顺手多做什么」——agent 该看的是
   * 结果（`Job.verification`），不是这个开关。
   */
  verify: boolean
  /**
   * 排队优先级。**只影响还在排队的那些**，见 `pickNextIndex`。
   * 与 `verify` 不同，它会进 `Job` 的投影——agent 得看得见自己插的队生效了没有。
   */
  priority: number
  cancel: CancelToken
}

/**
 * 一条任务实际占几份引擎容量。**夹在 [1, 该引擎容量] 之间**，理由与
 * `core/queue.ts` 的 `costOf()` 逐字相同：代价大于容量的任务会永远排不进去
 * （静默饿死），而那种死法在 agent 眼里与「任务卡住了」一模一样。
 *
 * 记账与准入判据**必须用同一个数**：准入夹了、记账没夹的话，`used` 会漂到容量之上，
 * 之后这个引擎的所有任务一起堵死。
 */
export function engineCost(engine: EngineKey, cost: number): number {
  return Math.max(1, Math.min(cost, engineLimit(engine)))
}

/**
 * 把外部给的优先级夹进合法区间。
 *
 * schema 已经挡了一道，这里再夹一次是因为 `submit()` **不止 schema 一个调用方**
 * （CLI 那条路不经过 zod）。夹取而不是报错：一个越界的优先级是**无害**的输入，
 * 为它拒掉整次转换是把主次颠倒了——真正该拒的是「目标格式不支持」那种。
 */
export function clampPriority(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 0
  return Math.max(MIN_PRIORITY, Math.min(MAX_PRIORITY, Math.trunc(value)))
}

/**
 * 下一个该起谁。**纯函数**——调度规则本身因此能被直接测，不必真起一个服务端
 * 再靠轮询去观测「谁先跑」，那种测法是抢时序、必然飘。
 *
 * 两条规则，次序是承重的：
 *
 *  1. **先过准入**：`hasSlot` 为假的直接跳过。这与原先那条「从头找第一个放得下的」
 *     是同一个理由（约束 25）——一条卡在 LibreOffice 上的任务不该把整张队列冻住。
 *  2. **在放得下的里面挑优先级最高的**。并列时取**下标最小**的那个（`>` 而不是 `>=`），
 *     也就是同优先级保持入队顺序：FIFO 是所有人对队列的默认预期，
 *     优先级只该**插队**，不该顺手把默认行为也改掉。
 *
 * 返回 `-1` 表示一个都起不了。
 */
export function pickNextIndex<T extends { engine: EngineKey; cost: number; priority: number }>(
  queue: readonly T[],
  hasSlot: (engine: EngineKey, cost: number) => boolean
): number {
  let best = -1
  for (let i = 0; i < queue.length; i += 1) {
    const item = queue[i]
    if (!hasSlot(item.engine, item.cost)) continue
    if (best < 0 || item.priority > queue[best].priority) best = i
  }
  return best
}

/**
 * 这个引擎在「已经占了 `used` 份」的前提下还能不能再开 `cost` 份。
 *
 * 抽成一个导出的纯函数，是为了让「容量表有没有被真的读」这件事能被**断言**到：
 * `pump()` 只走这一个判据，所以它在没装 LibreOffice 的机器上也能验
 * （`test-mcp-server.ts` 的第 7 节把两条作业压在容量为 1 的 `pdf` 引擎上）。
 */
export function engineHasSlot(engine: EngineKey, used: number, cost = 1): boolean {
  return used + engineCost(engine, cost) <= engineLimit(engine)
}

/** 把 agent 给的扩展名归一：去点、去空白、小写。`'.MP4'` 与 `' mp4 '` 是同一个。 */
export function normalizeExt(raw: string): string {
  return raw.trim().replace(/^\.+/, '').toLowerCase()
}

/**
 * 校验「这个源能不能转成那个目标」，不能就抛一句带**合法清单**的错误。
 *
 * 这是 MCP 里最值钱的一句错误文案：agent 最常见的失败是**猜格式名**
 * （把 `jpeg` 写成 `jpg`、或者给 `png` 挑了个 `docx`）。把 `targetsFor()` 的结果整份
 * 塞进 hint，它下一轮就能自己改对，而不是把「转换失败」五个字原样带回给用户。
 */
function assertConvertible(source: string, toExt: string): { fromExt: string; engine: EngineKey } {
  const fromExt = extOf(source)
  if (fromExt === '') {
    throw new McpToolError(
      `认不出源文件的扩展名：${source}`,
      { hint: '源文件必须带扩展名，比如 D:\\video\\a.mkv' },
      { code: 'unknown_format' }
    )
  }
  if (categoryOf(fromExt) === null) {
    throw new McpToolError(`不认识的源格式 .${fromExt}`, { fromExt }, { code: 'unknown_format' })
  }
  const targets = targetsFor(fromExt)
  if (targets.length === 0) {
    throw new McpToolError(
      `.${fromExt} 目前没有任何可用的目标格式`,
      { fromExt, targets },
      { code: 'unknown_format' }
    )
  }
  if (!targets.includes(toExt)) {
    throw new McpToolError(
      `.${fromExt} 转不了 .${toExt}`,
      {
        fromExt,
        requested: toExt,
        targets,
        hint: '请从 targets 里选一个。矩阵里没有的组合多半是实测过做不到，不是漏配。'
      },
      { code: 'target_not_supported' }
    )
  }
  const engine = engineFor(fromExt, toExt)
  if (engine === null) {
    // targetsFor 与 engineFor 同源，走到这里说明两张表分家了——那是个真 bug，
    // 报一句能直接定位的话，别让它伪装成「agent 参数给错了」。
    throw new McpToolError(
      `内部不一致：.${fromExt} → .${toExt} 在 targetsFor 里合法，却路由不到引擎`,
      { fromExt, toExt },
      { code: 'internal' }
    )
  }
  return { fromExt, engine }
}

/**
 * `target_format` 的归一 + 保留字解析。
 *
 * `auto` 走的是 `shared/formats.ts` 现成的 `resolveDefaultTarget()`——它叠用户偏好
 * **并且拿 `targetsFor()` 再校验一遍**（用户把「视频默认转 mkv」之后，拖进来的
 * 完全可能就是一个 `.mkv`，信任偏好会造出源与目标同格式的空转任务）。
 * **不要在这里另写一份**：「偏好 + 矩阵」这两步在 GUI 那条路上也是同一份逻辑，
 * 抄一份过来就是给自己留一个将来会漂移的副本。
 *
 * 解析不出来时**原样把 `auto` 交下去**，让 `assertConvertible` 去报那条更准的错
 * （「认不出扩展名」/「不认识的源格式」/「没有任何可用的目标格式」）——
 * 这里抢着报一句「不知道怎么定目标格式」会把真正的原因盖掉。
 * 两条路都不会漏：源格式合法时，`resolveDefaultTarget` 只可能在
 * `targetsFor(fromExt).length === 0` 时返回 null，而那正是 `assertConvertible` 要拒的。
 */
function resolveTargetExt(source: string, requested: string): string {
  if (requested !== AUTO_TARGET) return requested
  return resolveDefaultTarget(extOf(source), getSettings().defaultTargets) ?? requested
}

/**
 * 引擎不在位时**在排队之前**就拒掉。
 *
 * 顺序是承重的：先拒再排队，agent 拿到的是一句立刻可读的原因；排到队再失败，
 * 它可能已经又发了两轮调用，然后拿到三条「转换失败」。
 *
 * 导出给 `readDocument.ts` 用：`read_document` 那条路（`readViaConverter`）同样要
 * 「动手之前先判引擎」，而这条裁决**只该有一份**——抄一份过去的话，两条路上
 * 「引擎没装」的措辞、码、next_steps 会慢慢说岔，而 agent 恰恰是拿它们做决策的。
 */
export function assertEngineReady(fromExt: string, toExt: string): void {
  const needed = requiresDownload(fromExt, toExt)
  if (needed === null || engineReady(needed)) return
  throw new McpToolError(
    `这条转换需要 ${engineLabel(needed)} 引擎，本机还没装好，无法执行。`,
    {
      engine: needed,
      // 把「本来要转成什么」一起带上：`auto` 解析之后目标格式是**算出来的**，
      // 被拒时 agent 手里没有别的地方能知道它算成了哪个（batch 的 rejected 条目靠这个）。
      to: toExt,
      hint:
        `请在 Arbiter（调律者转换器）的关于页里下载 ${engineLabel(needed)}，` +
        '或改用不需要该引擎的目标格式。'
    },
    { code: 'engine_missing' }
  )
}

export class JobRegistry {
  private readonly jobs = new Map<string, Job>()
  private readonly queued: Queued[] = []
  private readonly active: Queued[] = []
  /** 已经占住的输出路径。见文件头第 1 条。 */
  private readonly claimed = new Set<string>()
  /**
   * 每个引擎当前占用的**份数**（不是任务个数）。准入判据看的是它。
   * 与 `core/queue.ts` 的 `EngineQueue.running` 是同一本账、同一张容量表。
   */
  private readonly used = new Map<EngineKey, number>()

  constructor(
    private readonly maxRunning: number = Number(process.env.ARBITER_MCP_CONCURRENCY) ||
      DEFAULT_MAX_RUNNING,
    /**
     * 真正干活的转换函数。**默认就是 `convert`，生产路径一个字都没变。**
     *
     * 这处注入只为一件事：调度断言要验「同一个引擎同时最多开几路」，而它
     * **不许依赖本机装没装 LibreOffice**——本项目明令反对机器相关的断言
     * （那种断言在没装的机器上是空集合恒真）。注入一个慢速替身之后，
     * 容量为 1 的引擎上压两条作业就能把准入规则验死在**纯逻辑面**上，
     * 与引擎装没装完全无关。
     *
     * 不做成模块级 `setXxxForTest()`：那是全局可变状态，两个测试节并行时会互相污染；
     * 构造参数天然是每个实例一份。
     */
    private readonly runConvert: typeof convert = convert
  ) {}

  /**
   * 登记一个 job，**同步返回**——不等待转换完成。
   *
   * `source` 与 `outputPath` 必须是**已经过路径闸门**的绝对路径（见 `paths.ts`）：
   * 闸门只应在一处生效，工具层判过之后这里不再重判，否则「哪个才是真判据」会分家。
   */
  submit(
    spec: RouteSpec & {
      /**
       * 转换完成后做一次产物自检（E-6）。**默认 false**，因为它的代价是**每个 job
       * 多两个引擎子进程**（源一个、产物一个，见 `selfCheck.ts`）——批量 200 个文件
       * 就是 400 次，而绝大多数转换的产物本来就不必验。只在「这一次的产物很重要」时打开。
       */
      verify?: boolean
      /** 排队优先级（R16）。不传 = 0；超范围由 `clampPriority` 夹住而不是报错 */
      priority?: number
    }
  ): Job {
    // 校验与落点计算全部走 `preview()`：**预览与执行是同一条路**（见那里的说明）。
    const route = this.preview(spec)
    // ⚠️ 登记**紧跟在算落点之后**，中间不许有 await：`preview()` 是同步的，所以
    // 「算」与「占」之间没有别人插进来的机会。把它改成 async 就等于给自己开一个
    // 并发撞名的窗口（约束 9 那一类静默覆盖）。
    this.claimed.add(route.output)

    const priority = clampPriority(spec.priority)

    const id = randomUUID()
    const job: Job = {
      id,
      source: route.source,
      output: route.output,
      fromExt: route.fromExt,
      toExt: route.toExt,
      engine: route.engine,
      mode: route.mode,
      status: 'queued',
      priority,
      progress: null,
      createdAt: Date.now()
    }
    this.jobs.set(id, job)
    this.queued.push({
      id,
      source: route.source,
      output: route.output,
      fromExt: route.fromExt,
      toExt: route.toExt,
      mode: route.mode,
      engine: route.engine,
      // 体积**只在这里量一次**：入队之后源文件再变（用户改盘、或上一条任务恰好
      // 把它当输入）不该让这条任务占的份数跟着变——那本账在它跑完之前是要还的。
      cost: engineCost(route.engine, taskCost(route.engine, fileSizeOrUndefined(route.source))),
      verify: spec.verify === true,
      priority,
      cancel: new CancelToken()
    })
    this.pump()
    return job
  }

  /**
   * 预览：这条路会怎么走、产物会落在哪。**只看——不建 job、不写任何文件、不占产物名。**
   *
   * 它是 `submit()` 的前半段，两者共用同一份校验与同一份落点计算
   * （`resolveTargetExt` → `assertConvertible` → `assertEngineReady` → `resolveOutput`）。
   * 各写一份的话，「预览说能转、跑起来报不支持」只是时间问题——而 agent 恰恰是拿
   * 预览的结论去向用户交代的（PLAN §9.1 的 E-5）。
   *
   * ⚠️ **绝不能在这里 `this.claimed.add()`。** `resolveOutput()` 会**读** `claimed`
   * 来避让并发撞名（约束 9），但**写**归 `submit()`：dry run 占了名，随后的真实任务
   * 就会被迫改名成 `x (1).jpg`——一个只读预览污染了真实产物名，而且不报错。
   * 判据是**直接可观测**的：先 dry run 一次、再真跑一次同名任务，产物的名字必须与
   * 「不带 dry_run」时逐字一致（`scripts/test-mcp-server.ts` 第 [9] 节钉着这件事）。
   *
   * 校验抛出来的错**原样抛**、一个字都不包装：调用方（MCP 那层）把它交给同一个
   * `fail()`，于是「预览说不行」与「真跑报错」是**同一份回话**，而不是两份各自表述的
   * 中文——「同一个错误」这件事因此是结构上的，不靠人去对齐两段文案。
   */
  preview(spec: RouteSpec): PlannedRoute {
    // 归一之后才判保留字：`'.AUTO'` 与 `' auto '` 都得认，而 `normalizeExt` 是
    // 唯一一处定义「怎么算同一个扩展名」的地方（别在这里再写一遍 trim/lowerCase）。
    const requested = normalizeExt(spec.toExt)
    const toExt = resolveTargetExt(spec.source, requested)
    const { fromExt, engine } = assertConvertible(spec.source, toExt)
    assertEngineReady(fromExt, toExt)

    return {
      source: spec.source,
      fromExt,
      toExt,
      engine,
      output: this.resolveOutput(spec.source, toExt, spec.outputPath, spec.outputComputed === true),
      mode: spec.mode ?? 'auto'
    }
  }

  /**
   * 算出产物落点。**规则与「登记」是两件事，这里是前一半。**
   *
   * ⚠️ **它只读 `claimed`，绝不写**：避让并发撞名要读（约束 9），登记归 `submit()`。
   * dry run 走的正是这一条计算（经 `preview()`），在这里登记的话，一次预览就会把
   * 真实任务挤成 `x (1).jpg`。它**是同步的**——这是「算」与「占」之间不开窗口的前提。
   *
   * 拿到了名字还要先过一遍 `resolveOutputPath`：它负责基础名净化与长路径截断
   * （`stemContext()` 那一段），绕过它就会写出一个 Windows 上存不下的名字。
   * 它的 `onConflict` 在这条路上**只兜「并发撞名」那一半**（同名的 job 还在写 `.part`，
   * 磁盘上还没有最终文件）——「目标已经存在」那一半在这之前就被下面两道闸拦掉了。
   * 至于 `'skip'`：MCP 这边根本没有「同名就跳过」那个设置在起作用（那是给用户的批量拖拽用的），
   * 半途改成「跳过」= `status: done` 却没有产物，是比改名更坏的一种撒谎。
   *
   * ⚠️ **`output_path` 指向一个已存在的目录时必须当场拒掉**，不能交给
   * `resolveOutputPath`：它的判据是 `existsSync(candidate)`，而目录也存在，
   * 于是它会「很合理地」把名字改成 `目录名 (1).jpg` 写到**上一级目录**去。
   * 全程不报错，agent 拿到 `status: done` 与一个自己从没要过的产物路径——
   * 正是这个项目最忌讳的那类静默换个结果。这条路只发生在 `output_path` 上：
   * 不给它时基础名取自源文件，源文件不可能是目录（读路径已经拦过目录了）。
   *
   * ⚠️ **「目标文件已经存在」是同一个洞的第二个变体，同样是当场拒。**
   * 它以前走的是下面那个硬编码的 `onConflict: 'rename'`：不覆盖（数据安全 ✓）、
   * 但也不报错，产物悄悄改名成 `victim (1).jpg`，返回 `status: done`。
   *
   * **为什么这不只是洁癖**：agent 明确要求写 `/out/report.pdf`，随后去读它——
   * 而那个路径上**躺着一份旧文件**（比如上周的报告）时，它读到的是**旧内容**，
   * 并且把它当成这次的新产物。产出与请求不符而不报错，比直接拒绝危险得多：
   * 拒绝是一次可识别的失败，静默改道是一条**看起来成功了**的错误路径。
   *
   * 判据是 `existsSync()`，于是 Windows 上大小写天然不敏感
   * （`Report.PDF` 与 `report.pdf` 是同一个文件）——这正是我们要的：判据与
   * 文件系统给出同一个答案，而不是与它争论。
   *
   * 只对**用户点名**的路径生效：批量那条路的落点是我们算出来的（`computed`），
   * 理由见 `RouteSpec.outputComputed`。
   */
  private resolveOutput(
    source: string,
    toExt: string,
    outputPath?: string,
    computed = false
  ): string {
    if (outputPath !== undefined && isDirectory(outputPath)) {
      throw new McpToolError(
        `output_path 指向的是一个**目录**，不是文件路径：${outputPath}`,
        {
          output_path: outputPath,
          hint: 'output_path 要写成产物的完整路径（含文件名），比如 D:\\out\\clip.jpg；想要落在某个目录里请改用 batch_convert 的 output_dir'
        },
        { code: 'output_conflict' }
      )
    }

    if (!computed && outputPath !== undefined && existsSync(outputPath)) {
      throw new McpToolError(
        `output_path 上已经有一个文件了，不会往它上面写：${outputPath}`,
        {
          output_path: outputPath,
          hint: '这条转换没有覆盖它，一个字节都没动。换一个路径，或者先自己把那个文件移走 / 删掉，再原样重发这次调用。'
        },
        { code: 'output_conflict' }
      )
    }

    const base = outputPath ?? source
    const outputDir = outputPath === undefined ? outputDirFor(source) : dirname(outputPath)

    const candidate = resolveOutputPath({
      inputPath: base,
      outputDir,
      targetExt: toExt,
      onConflict: 'rename'
    })

    // 并发避让。**不能只靠 `resolveOutputPath` 看磁盘**：另一个 job 此刻还在写 `.part`，
    // 磁盘上根本没有最终文件，两个 job 会解析出同一个名字（约束 9）。
    let reserved = candidate
    let n = 0
    while (this.claimed.has(reserved) && n < 10_000) {
      n += 1
      reserved = withSuffix(candidate, n)
    }
    return reserved
  }

  /**
   * 起任务。**两个闸门取最小值**，与 `core/queue.ts` 的 `EngineQueue.pump()` 同一条裁决：
   *
   *   1. 全局上限（`maxRunning`）——这条一直都在；
   *   2. **引擎容量**（`engineHasSlot()`，即 GUI 那张 `ENGINE_CAPACITY` 表）——这条是补上的，
   *      理由见文件头第 3 条。
   *
   * 内层每次都**从头找第一个「放得下」的**，而不是只看队首：某个引擎占满时，
   * 后面换一个引擎的 job 照样应该开跑，不能被前面那一条堵死（同 `EngineQueue.pump()`）。
   * 只看队首的话，一条卡在 LibreOffice 上的任务会把整张队列一起冻住——
   * 那正是约束 25 记着的那类「看起来像限流根本没生效」的形态。
   */
  private pump(): void {
    for (;;) {
      if (this.active.length >= this.maxRunning) return
      const index = pickNextIndex(this.queued, (engine, cost) =>
        engineHasSlot(engine, this.used.get(engine) ?? 0, cost)
      )
      if (index < 0) return

      const [item] = this.queued.splice(index, 1)
      this.used.set(item.engine, (this.used.get(item.engine) ?? 0) + item.cost)
      this.active.push(item)
      void this.run(item).finally(() => {
        // 先还账再摘人再重扫：顺序反过来的话，中间那一刻 `active` 已经少了它、
        // 而 `used` 还占着，重扫出来的结果会偏保守（不致命，但没有理由留着）。
        this.used.set(
          item.engine,
          Math.max(0, (this.used.get(item.engine) ?? item.cost) - item.cost)
        )
        const at = this.active.indexOf(item)
        if (at >= 0) this.active.splice(at, 1)
        this.claimed.delete(item.output)
        this.pump()
      })
    }
  }

  private async run(item: Queued): Promise<void> {
    const job = this.jobs.get(item.id)
    if (job === undefined) return

    job.status = 'running'
    job.startedAt = Date.now()

    try {
      await this.runConvert({
        input: item.source,
        output: item.output,
        fromExt: item.fromExt,
        toExt: item.toExt,
        cancel: item.cancel,
        remux: remuxHintOf(item.mode),
        onProgress: (progress) => {
          job.progress = progress
        }
      })
    } catch (error) {
      if (error instanceof ConversionCanceled) {
        this.finish(job, 'canceled', 'canceled')
        return
      }
      if (error instanceof ConversionFailed) {
        // logTail 原样带出去：agent 比用户更能读 stderr，而这一层唯一要做的是
        // **别把 stderr 丢掉**（只回「转换失败」四个字，它无从判断该重试还是该放弃）。
        //
        // 码是 `source_corrupt`：**引擎已经给出过它的判断了**（非零退出码 / 0 字节产物），
        // 同样参数重试一次不会有不同结果。它不总是「源文件坏了」——也可能是参数、
        // 也可能是引擎的毛病——所以那句 message 与 log_tail 一起读才有意义，
        // 码只负责回答「该不该重试」。`retryable: false` 就是这个意思。
        //
        // 这里**没有**按 logTail 的文案去细分（比如认出「磁盘已满」）。那是约束 23
        // 第 3 条明令禁止的判据形态：引擎的输出随版本与语言变，而按文案分码一旦
        // 漂移就是静默分错类。理由与取舍写在 `errors.ts` 的 `ErrorCode` 注释里。
        //
        // 那句 message 由**抛出方**决定（`ConversionFailed.summary`，可省），不在这里写死：
        // 兜底文案「引擎返回了非零退出码」对**从没起过任何子进程**的那几条路是**假话**
        // ——文档解析（mammoth / SheetJS）、PDF 渲染、写盘都不返回退出码。而 agent 是
        // 照着 message 与 next_steps 决定下一步的，一句错的归因会把它送去查一个无辜的文件。
        // 审计 2026-09-15 §3.1 与 §3.3 各是一次实例。
        this.finish(
          job,
          'failed',
          'source_corrupt',
          error.summary ?? '转换失败（引擎返回了非零退出码）',
          error.logTail
        )
        return
      }
      // 不是引擎那条错误类型：走到了我们没预料的分支（fs 的 errno、内部状态异常……）。
      this.finish(job, 'failed', 'internal', error instanceof Error ? error.message : String(error))
      return
    }

    // 体积当场 stat：`convert()` 的契约是产物已经在 `output` 上了。
    // 读不到体积不算失败——文件已经转出来了，把 done 改成 failed 反而是在撒谎。
    try {
      const info = await stat(item.output)
      job.sizeBytes = info.size
      // 判据与文案都用共用件（见文件头那条 import）：GUI 的完成路径读的是同一对。
      // 码是 `source_corrupt`：转换过程没产出任何东西，重试不会有不同结果。
      if (isEmptyOutput(info.size)) {
        this.finish(job, 'failed', 'source_corrupt', EMPTY_OUTPUT_MESSAGE)
        return
      }
    } catch {
      // 忽略
    }

    // 产物自检（E-6）。**排在 `finish()` 之前是承重的**：`convert_file` 那条路等的就是
    // 终态（`waitFor()` 一看到 done / failed / canceled 就返回），排在它之后的话，
    // agent 拿到的返回值里永远没有 `verification`——它在 100ms 的轮询里恰好读到的
    // 是「已经 done、但自检还没跑」那一帧。顺序只能是这样，不能靠「调用方等一下」。
    if (item.verify) {
      job.verification = await selfCheck(item.source, item.output)
    }
    this.finish(job, 'done')
  }

  private finish(
    job: Job,
    status: JobStatus,
    code?: ErrorCode,
    error?: string,
    logTail?: string[]
  ): void {
    job.status = status
    job.finishedAt = Date.now()
    job.progress = null
    if (code !== undefined) job.errorCode = code
    if (error !== undefined) job.error = error
    if (logTail !== undefined) job.logTail = logTail
    this.evictOld()
  }

  /** 只丢**已结束**的最老记录。跑着的 job 是 agent 唯一的凭据，不能回收。 */
  private evictOld(): void {
    const finished = [...this.jobs.values()]
      .filter((j) => j.status === 'done' || j.status === 'failed' || j.status === 'canceled')
      .sort((a, b) => (a.finishedAt ?? a.createdAt) - (b.finishedAt ?? b.createdAt))
    while (finished.length > KEEP_FINISHED) {
      const victim = finished.shift()
      if (victim === undefined) break
      this.jobs.delete(victim.id)
      this.claimed.delete(victim.output)
    }
  }

  get(id: string): Job | null {
    return this.jobs.get(id) ?? null
  }

  /**
   * 等一个 job 落定，中途把进度回调出去。**`convert_file` 用它喂 MCP 的
   * `notifications/progress`**，而不是让 agent 反复调 `get_job_status` 轮询——
   * 轮询在 agent 那一侧既费 token，又拿不到「卡在哪一步」。
   *
   * 两条必须记住的：
   *
   *  1. **取消信号来自请求本身**（MCP 的 `extra.signal`，客户端发 `notifications/cancelled`
   *     时触发），不是我们自己发明的机制。收到就转发给 `cancel()`，它再去触发
   *     `CancelToken` → `killTree`，进程树才真的会死（约束 3）。
   *  2. 收到取消信号之后**继续轮询**，不立刻返回：取消是异步的（要等进程树真的被杀），
   *     提前回一个「已请求取消」的中间态，调用方会以为任务已经停了。
   */
  async waitFor(
    id: string,
    opts: { signal?: AbortSignal; onProgress?: (job: Job) => void; pollMs?: number } = {}
  ): Promise<Job | null> {
    const pollMs = opts.pollMs ?? 100
    let lastKey = ''
    let forwarded = false

    for (;;) {
      const job = this.jobs.get(id)
      // `Map.get` 给的是 undefined，不是 null——写成 `=== null` 永远不会命中，
      // 后面每一处 `job.xxx` 都会被 TS 判成 possibly undefined。
      if (job === undefined) return null
      if (job.status === 'done' || job.status === 'failed' || job.status === 'canceled') return job

      if (opts.signal?.aborted === true && !forwarded) {
        forwarded = true
        this.cancel(id)
      }

      // 只报**有变化**的那些次：进度处于「不确定」阶段时内容恒等，逐次上报等于刷屏。
      const key = progressKey(job.progress)
      if (key !== lastKey) {
        lastKey = key
        opts.onProgress?.(job)
      }

      await sleep(pollMs)
    }
  }

  list(): Job[] {
    return [...this.jobs.values()]
  }

  /** 排队中 + 运行中的条数 */
  activeCount(): number {
    return this.active.length + this.queued.length
  }

  /**
   * 取消一个 job。返回它**当时**的状态。
   *
   * 三种情况必须分清，别都回一句「已取消」：
   *   - 排队中 → 直接出队标记取消，不会起进程
   *   - 运行中 → 触发 CancelToken，引擎侧的 `killTree` 负责杀进程树（约束 3）
   *   - 已结束 → 回话说明它已经完成了，取消是**空操作**。假装「已取消」会让 agent
   *     以为产物没生成，而磁盘上那份文件是真的
   */
  cancel(id: string): Job | null {
    const job = this.jobs.get(id)
    if (job === undefined) return null
    if (job.status === 'done' || job.status === 'failed' || job.status === 'canceled') return job

    const at = this.queued.findIndex((q) => q.id === id)
    if (at >= 0) {
      this.queued.splice(at, 1)
      this.claimed.delete(job.output)
      this.finish(job, 'canceled', 'canceled')
      return job
    }

    const running = this.active.find((q) => q.id === id)
    if (running !== undefined) {
      running.cancel.cancel()
      // 状态由 `run()` 的 catch 落定（ConversionCanceled），这里**只发信号**：
      // 就地标成 canceled 会与「进程其实已经跑完了」抢同一格状态。
      return job
    }

    // 既不在队列也不在跑，却还不是终态——调度器自己出问题了，别静默返回。
    this.finish(job, 'failed', 'internal', '内部状态异常：这个 job 既不在队列里也不在运行中')
    return job
  }

  /** 进程退出前收尾：取消所有还在跑的，别留孤儿进程占着引擎锁（约束 3）。 */
  shutdown(): void {
    for (const q of [...this.active, ...this.queued]) q.cancel.cancel()
  }
}

/**
 * 进度的「内容指纹」。用来判断「这次进度和上次是不是同一件事」——
 * 不确定进度阶段的 `stage` 文案是恒定的，指纹相同就不必再报一次。
 */
function progressKey(progress: TaskProgress | null): string {
  if (progress === null) return ''
  switch (progress.kind) {
    case 'determinate':
      return `d:${Math.round(progress.percent)}`
    case 'indeterminate':
      return `i:${progress.stage}`
    case 'batch':
      return `b:${progress.done}/${progress.total}`
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * 这个路径是不是一个**已存在的目录**。读不到（不存在、没权限、竞态）一律算「不是」——
 * 这里只是把「静默写错地方」这一类拦下来，不负责报 IO 错误：真读不动的时候，
 * 后面的转换会给出比我们在这里猜更准的错。
 */
function isDirectory(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isDirectory()
  } catch {
    return false
  }
}

/**
 * 输入体积，给 `taskCost()` 判「轻/重」用。
 *
 * **读不到就给 `undefined`**，而 `taskCost()` 把 `undefined` 当**重的**算——
 * 与 `core/queue.ts` 里那句「在一个来历不明的文件上放大并发，赌的是一台机器的内存」
 * 是同一条裁决。这里不报错：真读不动的时候，后面的转换会给出比我们在这里猜更准的错。
 */
function fileSizeOrUndefined(path: string): number | undefined {
  try {
    return statSync(path).size
  } catch {
    return undefined
  }
}

/** `x.mp4` → `x (1).mp4`。与 `outputName.ts` 里的冲突命名规则保持一致（空格 + 括号）。 */
function withSuffix(path: string, n: number): string {
  const dot = path.lastIndexOf('.')
  const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  if (dot <= slash + 1) return `${path} (${n})`
  return `${path.slice(0, dot)} (${n})${path.slice(dot)}`
}
