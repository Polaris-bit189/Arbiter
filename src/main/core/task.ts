import { existsSync } from 'fs'
import { randomUUID } from 'crypto'
import { stat } from 'fs/promises'
import { dirname, join } from 'path'
import {
  baseNameOf,
  categoryOf,
  engineFor,
  extOf,
  requiresDownload,
  resolveDefaultTarget,
  targetsFor
} from '@shared/formats'
import type { Category, EngineKey, Task, TaskOptions, TaskProgress } from '@shared/types'
// 「哪几类能裁剪」的判据在 shared 里（界面也要用它来决定显不显示那个面板），
// 不是这里就地写一个 `category === 'video' || category === 'audio'`——两份判据
// 分家的表现是「面板显示出来了，设上去却被静默丢掉」。
import { canTrim } from '@shared/trim'
import { canFilter, canOutputSize, canUseAction, MAX_FILTER_ACTIONS } from '@shared/options'
import type { TaskPatch, TasksPatchMessage } from '@shared/ipc-contract'
import { CancelToken } from './cancel'
import { appendHistory } from './history'
import { EngineQueue, taskCost } from './queue'
import { getSettings, outputDirFor } from './settings'
import { isInsideDir, naturalOutputPath, resolveOutputPath } from './outputName'
import { convert, ConversionCanceled, ConversionFailed } from '../converters'
// 「产物不得为空」的判据与文案是**两个界面共用的那一份**（见那个文件的说明）。
// 从 `converters/common` 直接 import 而不是从 `../converters` 再导出一层：
// 这是给**入口层**（GUI / MCP）用的通用判据，与「路由到哪个引擎」无关。
import { assertOutputNotEmpty } from '../converters/common'
import { engineLabel, engineReady } from '../engines/status'
import { installEngine } from './engineInstall'

const MAX_TASKS = 500

export interface AddOutcome {
  added: number
  rejected: { path: string; reason: string }[]
}

/**
 * 任务的唯一真相源。
 *
 * 渲染进程只是一个镜像——所有状态迁移都发生在这里，通过增量 patch 推给 UI。
 * 这样做的好处是刷新页面、切换窗口都不会让任务状态错乱。
 */
export class TaskManager {
  private readonly tasks = new Map<string, Task>()
  /** 正在运行的任务的取消令牌 */
  private readonly tokens = new Map<string, CancelToken>()
  /**
   * 正在跑的 id（`execute()` 还没走到 finally 的那些）。
   *
   * 与 `tokens` 分开记是因为两者的生命周期**不重合**：`shutdown()` 会把 tokens 清空，
   * 而在飞的那批此刻还在等子进程咽气。退出路径要问的正是「还有没有人在跑」，
   * 见 `runningCount()` / `drain()`。
   */
  private readonly inFlight = new Set<string>()
  /** 已经被占用的输出路径，防止并发任务解析到同一个文件名互相覆盖 */
  private readonly claimed = new Set<string>()
  /**
   * 输入文件的体积，入队时顺手量一次。
   *
   * 只为一件事存在：ffmpeg 的并发代价按它分档（`queue.ts` 的 `taskCost`）。
   * **不能等到 `pump()` 里再去量**——那是同步路径，一次 `statSync` 就是一次磁盘
   * 往返，而准入判据对每个候选条目都要问一遍。而 `addPaths()` 里本来就为了
   * `inspect()` 而 `stat` 过一次，白拿。
   *
   * 与任务同生命周期：`remove()` / `clearFinished()` 里一起清掉。
   */
  private readonly inputBytes = new Map<string, number>()
  private readonly queue: EngineQueue

  // 增量推送的合并缓冲：一次拖入 20 个文件只发一条消息，而不是 20 条
  private readonly pendingUpdates = new Map<string, TaskPatch>()
  private readonly pendingRemovals = new Set<string>()
  private flushScheduled = false

  constructor(private readonly broadcast: (message: TasksPatchMessage) => void) {
    this.queue = new EngineQueue(
      (id) => this.execute(id),
      () => getSettings().maxConcurrent
    )
  }

  /* ------------------------------------------------------------ 查询 */

  list(): Task[] {
    return [...this.tasks.values()].sort((a, b) => a.createdAt - b.createdAt)
  }

  stats(): ReturnType<EngineQueue['stats']> {
    return this.queue.stats()
  }

  /** 用户改了并发数后让调度器重新评估 */
  repump(): void {
    this.queue.pump()
  }

  /* ------------------------------------------------------------ 增删 */

  async addPaths(paths: string[]): Promise<AddOutcome> {
    const rejected: AddOutcome['rejected'] = []
    let added = 0

    for (const path of paths) {
      if (this.tasks.size >= MAX_TASKS) {
        rejected.push({ path, reason: `任务数已达上限 ${MAX_TASKS}` })
        continue
      }

      const inspected = await this.inspect(path)
      if (inspected.failure !== null) {
        rejected.push({ path, reason: inspected.failure })
        continue
      }

      const fromExt = extOf(path)
      const category = categoryOf(fromExt) as Category
      // 默认目标要过用户偏好（格式设置页的「各类别默认目标格式」）。
      //
      // **必须在这里裁决，不能只靠渲染层补一刀。** 入队不止一个入口：渲染层拖拽/选文件
      // 走 `tasks:add`，而 `history:rerun`（再行调律）是主进程自己发起的——渲染层
      // 那侧根本没机会插手，于是同一个设置项会对一半入口生效、对另一半静默失效。
      //
      // `resolveDefaultTarget` 内部会拿 `targetsFor(fromExt)` 校验一遍偏好：
      // 用户把「视频默认转 mkv」之后拖进一个 .mkv，偏好被否掉、回落该格式自己的默认值，
      // 不会造出 fromExt === toExt 的空转任务。下面 `inspect()` 里那句
      // `targetsFor(ext).length === 0` 是另一回事（防的是「这个源根本没有出口」），
      // 两道闸不重复，都留着。
      const toExt = resolveDefaultTarget(fromExt, getSettings().defaultTargets)
      if (!toExt) {
        rejected.push({ path, reason: `不支持转换 ${fromExt || '该类型'} 文件` })
        continue
      }

      // 「引擎未备时跳过」：这条路线要靠一个还没准备好的重型引擎，就别排进队列干等。
      //
      // **也判在入队**，理由与下面那个「略过」逐字相同：`rejected` 是唯一看得见的出口，
      // 而任务的四个终态没有一个能诚实地表达「按你的要求没做」。
      //
      // 位置在那条**之前**不是随手排的：两个判据都命中时，引擎未备是更根本的那个——
      // 用户换个不重名的文件照样办不成，先报「目标已存在」会把他引到错的地方去。
      if (getSettings().skipTasksNeedingDownload) {
        const reason = unavailableEngineReason(fromExt, toExt)
        if (reason !== null) {
          rejected.push({ path, reason })
          continue
        }
      }

      // 「同名文件 → 略过」：目标本名已存在就不办这件事。
      //
      // **判在入队、判在自然名上，两条都是有意的。**
      //   - 判在**入队**，因为只有这里的结论看得见：`rejected` 会进「收入 N 个，略过 M 个」
      //     那张列表，用户能知道是哪个文件、为什么没办。落到任务上就没有诚实的终态可用——
      //     四个状态里没有一个能表达「按你的要求没做」，而 `logTail` 在非 error 时
      //     根本不渲染（`TaskCard.tsx` 那句 `hasLog`），收成 done 就是在说谎。
      //   - 判在**自然名**上，因为「略过」要保护的正是「同名会被盖掉」这件事：
      //     `resolveOutputPath` 问不出这个，它见到文件存在就直接跳去下一个序号，
      //     返回的必然是个空闲名字，事实被它自己吃掉了。
      //
      // 只看磁盘、不看 `claimed`：入队时还没有任何东西被占位（占位发生在 `execute` 里），
      // 这里要问的就是磁盘。两个文件在同一批里转向同一个本名时，磁盘上谁都不存在，
      // 于是都放行、由 `reserveOutput` 改名区分——那种情况下用户**没有**任何已有文件
      // 需要保护，不在「略过」的适用范围里。
      if (getSettings().onConflict === 'skip') {
        const natural = naturalOutputPath({
          inputPath: path,
          outputDir: outputDirFor(path),
          targetExt: toExt
        })
        if (existsSync(natural)) {
          rejected.push({ path, reason: '目标已存在，按设置略过' })
          continue
        }
      }

      const task: Task = {
        id: randomUUID(),
        inputPath: path,
        inputName: baseNameOf(path),
        category,
        fromExt,
        toExt,
        engine: engineOf(fromExt, toExt),
        status: 'queued',
        progress: null,
        createdAt: Date.now()
      }

      this.tasks.set(task.id, task)
      // 体积要**在入队时就记下来**：它是并发代价的输入，而 `pump()` 是同步路径
      // （见 inputBytes 的说明）。
      this.inputBytes.set(task.id, inspected.sizeBytes)
      this.mark(task.id, { status: 'queued' })
      added += 1
    }

    return { added, rejected }
  }

  /**
   * 返回拒绝原因（`null` 表示通过）与文件体积。
   *
   * **体积是顺带量的，不是新加的一次 IO**：这里本来就要 `stat` 一次看它是不是空文件，
   * 而并发代价（`taskCost`）要的正是这个数。拒绝时 `sizeBytes` 给 0，调用方不会用。
   */
  private async inspect(path: string): Promise<{ failure: string | null; sizeBytes: number }> {
    const ext = extOf(path)
    if (ext === '') return { failure: '文件没有扩展名，无法判断类型', sizeBytes: 0 }
    if (!categoryOf(ext)) return { failure: `不支持的文件类型 .${ext}`, sizeBytes: 0 }

    let sizeBytes = 0
    try {
      const info = await stat(path)
      if (info.isDirectory()) {
        return { failure: '这是一个文件夹（文件夹递归展开将在后续版本支持）', sizeBytes: 0 }
      }
      if (!info.isFile()) return { failure: '不是普通文件', sizeBytes: 0 }
      if (info.size === 0) return { failure: '文件为空', sizeBytes: 0 }
      sizeBytes = info.size
    } catch {
      return { failure: '文件不存在或无法访问', sizeBytes: 0 }
    }

    if (targetsFor(ext).length === 0) {
      return { failure: `没有可用的目标格式（源格式 .${ext}）`, sizeBytes: 0 }
    }
    return { failure: null, sizeBytes }
  }

  setTarget(id: string, toExt: string): void {
    const task = this.tasks.get(id)
    if (!task) return
    // 运行中的任务改目标没有意义，会让人以为改了就生效
    if (task.status === 'running') return
    if (!targetsFor(task.fromExt).includes(toExt)) return

    task.toExt = toExt
    task.engine = engineOf(task.fromExt, toExt)
    this.requeue(id, task)

    // 队列里那条记录**同样要跟着改**。
    //
    // `EngineQueue` 的条目在入队时就把 `engine` 快照下来了，而并发上限是按这个字段
    // 分桶算的（`pump()` 里那句 `running.get(e.engine) < engineLimit(e.engine)`）。
    // 只改任务不改条目，一个原本排给 sharp 的任务改用 ffmpeg 之后仍然占着 sharp 的桶、
    // 不占 ffmpeg 的，于是 ffmpeg 那一侧能同时跑起超过自己上限的个数。
    // 这是真实可达的：图片类别下同一个源在不同目标格式上会落到不同引擎
    // （`.heic` → `png` 走 sharp，`.heic` → `gif` 走 ffmpeg），排队期间改一次目标格式就能造出来。
    //
    // **必须放在上面这句 `mark` 之后**：`push()` 会顺手 `pump()`，调度器可能当场把这条
    // 挑走开跑，而 `execute()` 会推一条 `running`。放在前面的话那条 running 会被这里的
    // queued 盖掉（`mark` 按 id 合并，后写的赢），界面上这一行会卡在「等待中」不动。
    if (this.queue.remove(id)) this.queue.push({ id, engine: task.engine, cost: this.costOf(task) })
  }

  /**
   * 改一条任务的**参数**（目前只有裁剪）。语义与 `setTarget` 完全一致，两条规矩：
   *
   * 1. **运行中改参数没有意义**，直接不办。参数在 `execute()` 里就已经交给引擎了，
   *    改完这条任务也不会回头重跑——而界面上看起来改了、产物却还是按旧参数出来的。
   * 2. **改完打回「等待中」并清掉上一轮的痕迹**（`requeue`）。上一次的产物是按旧参数
   *    跑出来的，留在卡片上就是一条「产物体积 4.2 MB」的假信息。
   *
   * `options` 给 `undefined` = 清空参数。清空之后这条任务与从未设过参数**逐字相同**，
   * 所以下游（引擎、历史、摘要那一行）都不需要认识「空参数」这个第三种状态。
   *
   * 与 `setTarget` 不同的是**没有「队列条目要跟着改」那一段**：参数不参与并发分桶
   *（`EngineQueue` 的条目只快照 `engine`），所以这里不必也不该动队列。
   *
   * ⚠️ **回布尔，而 `setTarget` 是 void。** 这个差别是有意的，不是忘了对齐：
   * 这条链路上全是一类「静默不办」（任务不在 / 正在跑 / 这一类不该有这项参数 /
   * 参数本身是坏的），而它们在界面上留下的痕迹一模一样——什么都没变。
   * 参数面板据此才能说一句「没能设上」，否则用户看到的就是「点了应用、什么都没发生」。
   * 参数每多一项，这里的拒绝分支就多一条，所以这个布尔只会更重要。
   * （`setTarget` 那条路不必回：一个被拒的目标格式会让下拉**弹回原值**，
   * 那个视觉反馈本身就是回执。）
   */
  setOptions(id: string, options: TaskOptions | undefined): boolean {
    const task = this.tasks.get(id)
    if (!task) return false
    if (task.status === 'running') return false

    const trim = options?.trim
    const output = options?.output
    const filters = options?.filters

    // 每一项参数只对某些类别有意义。判在**这里**而不只是判在界面上：界面藏起来
    // 只挡住了拖拽与点击那两条路，别的入口（MCP、右键菜单参数）绕得过去，
    // 而绕过去的表现是「参数设上了、引擎按另一条分支跑，参数静默失效」。
    if (trim && !canTrim(task.category)) return false
    if (output && !canOutputSize(task.category)) return false
    if (filters && filters.length > 0 && !canFilter(task.category)) return false

    // 零长度或反向的区间不是一次裁剪。schema 已经拦过 IPC 那一道，这里是
    // 「谁也别想绕过 TaskManager 塞进来一个坏区间」的那一道（同一个类里 setTarget
    // 也自己拿 targetsFor 复核一遍），而不是对 schema 的重复信任。
    if (trim && !(trim.end > trim.start)) return false
    // 体积与码率二选一。两个都给时下游必须先猜哪个优先，而猜错的表现是
    // 「用户填了 10 MB，出来 30 MB」——两种都不该由引擎去兜。
    if (output && (output.targetBytes === undefined) === (output.bitrateKbps === undefined)) {
      return false
    }
    // 链长上限。挡住的是「一条必然是算错了的链」——与其让它跑几小时再失败，
    // 不如在这里就说清楚。上界比任何合理配方的十倍还大，不会误伤。
    if (filters && filters.length > MAX_FILTER_ACTIONS) return false
    // 每一项动作还有自己的适用范围（去隔行只对视频有意义、响度只对音频流有意义……），
    // 判据与界面「添加」菜单读的是**同一个函数**。
    if (filters?.some((action) => !canUseAction(action, task.category))) return false
    // 逐个动作验：每个动作也必须自己站得住。`resize` 要求宽高至少给一个，
    // 两个都不给是一条**什么都不做的空转步骤**——它会让摘要上多出一句
    // 「缩放（未指定尺寸）」，而引擎那边也只是白解一遍码。
    // ⚠️ 加新动作时这里要跟着加分支，**别写成「只认 resize」的兜底**——
    // 那样新动作会静默免检。
    if (
      filters?.some(
        (action) =>
          action.kind === 'resize' && action.width === undefined && action.height === undefined
      )
    ) {
      return false
    }

    // ⚠️ **整体替换，不是逐字段合并。** 一份 `options` 里没提到的字段会被清掉——
    // 这是刻意的：合并语义没法表达「清除某一项」（省掉一个键与删掉一个键长得一样）。
    // 代价是界面上每一块参数面板在「应用」时都必须交出完整的 `TaskOptions`，
    // 见 `shared/options.ts` 的 `withOption`。
    const next: TaskOptions = {}
    if (trim) next.trim = trim
    if (output) next.output = output
    // 空数组与「没有处理链」是同一个意思，收敛成 `undefined`（照 `trim` 的先例）。
    // 顺手复制一份：任务持有的不该是调用方那个数组的引用。
    if (filters && filters.length > 0) next.filters = [...filters]

    task.options = Object.keys(next).length > 0 ? next : undefined
    this.requeue(id, task)
    return true
  }

  /**
   * 把一条任务打回「等待中」，并清掉上一轮跑出来的所有痕迹。
   *
   * **必须是同一个实现**（`setTarget` 与 `setOptions` 共用），因为这几行漏一个就是
   * 一条静默的假信息：`sizeBytes` 尤其危险——那一列的标题是「产物体积」，
   * 而此时上一次的产物已经不再是这条任务的东西了（它会被按新参数重新转一遍）。
   * 少了这一行，改完参数的行会立刻变回「等待中」，体积列却还写着上一份产物的大小，
   * 而卡片上没有任何东西提示它是旧的。
   *
   * ⚠️ 调用方要在**改完自己的字段之后**调它，且**队列条目那一段要放在它后面**
   *（见 `setTarget` 里那段说明：`mark` 按 id 合并、后写的赢）。
   */
  private requeue(id: string, task: Task): void {
    task.status = 'queued'
    task.progress = null
    task.error = undefined
    task.logTail = undefined
    task.outputPath = undefined
    task.sizeBytes = undefined
    task.startedAt = undefined
    task.finishedAt = undefined
    this.mark(id, {
      status: 'queued',
      progress: null,
      error: null,
      logTail: null,
      outputPath: null,
      sizeBytes: null,
      startedAt: null,
      finishedAt: null
    })
  }

  /* ------------------------------------------------------------ 启动 */

  /** ids 为空表示「全部开始」 */
  start(ids?: string[]): void {
    const targets = ids && ids.length > 0 ? ids : [...this.tasks.keys()]
    for (const id of targets) {
      const task = this.tasks.get(id)
      if (!task) continue
      if (task.status === 'running') continue
      if (task.status === 'done') continue
      // 取消过的任务要重新排队，状态得先归位
      if (task.status === 'canceled' || task.status === 'error') {
        task.status = 'queued'
        task.progress = null
        task.error = undefined
        task.logTail = undefined
        this.mark(id, { status: 'queued', progress: null, error: null, logTail: null })
      }
      if (this.queue.isWaiting(id)) continue
      this.queue.push({ id, engine: task.engine, cost: this.costOf(task) })
    }
  }

  /**
   * 这条任务该占几份并发。
   *
   * **必须在每次入队时现算**，不能跟着任务一起快照：`setTarget()` 会把一条任务换到
   * 别的引擎上（`.heic → png` 走 sharp，`.heic → gif` 走 ffmpeg），而「几份」是
   * 引擎的函数。与 `engine` 那个字段同理——队列条目必须跟着任务一起改。
   */
  private costOf(task: Task): number {
    return taskCost(task.engine, this.inputBytes.get(task.id))
  }

  retry(ids: string[]): void {
    this.start(ids)
  }

  /* ------------------------------------------------------------ 取消 */

  cancel(ids: string[]): void {
    for (const id of ids) {
      const task = this.tasks.get(id)
      if (!task) continue

      if (this.queue.remove(id)) {
        // 还没开跑，直接从队列里摘掉即可
        task.status = 'canceled'
        task.finishedAt = Date.now()
        task.progress = null
        this.mark(id, { status: 'canceled', progress: null, finishedAt: task.finishedAt })
        continue
      }

      if (task.status === 'running') {
        // 杀掉进程树；execute 的 catch 会把状态置为 canceled
        this.tokens.get(id)?.cancel()
      }
    }
  }

  remove(ids: string[]): void {
    for (const id of ids) {
      this.queue.remove(id)
      this.tokens.get(id)?.cancel()
      this.tokens.delete(id)
      this.inputBytes.delete(id)
      if (this.tasks.delete(id)) this.pendingRemovals.add(id)
    }
    this.scheduleFlush()
  }

  /** 清掉所有已结束的任务，并返回被清理的数量 */
  clearFinished(): number {
    let removed = 0
    for (const [id, task] of this.tasks) {
      if (task.status === 'done' || task.status === 'canceled' || task.status === 'error') {
        this.tasks.delete(id)
        // 与任务同生命周期：不清的话这张表会跟着「已清理但还在列表里」的 id 一起长
        this.inputBytes.delete(id)
        this.pendingRemovals.add(id)
        removed += 1
      }
    }
    this.scheduleFlush()
    return removed
  }

  /** 窗口关闭时调用：停掉调度、杀掉所有子进程 */
  shutdown(): void {
    this.queue.clearWaiting()
    for (const token of this.tokens.values()) token.cancel()
    this.tokens.clear()
  }

  /**
   * 正在跑的任务数（等待中的不算）。
   *
   * **不能用 `this.tokens.size`**：`shutdown()` 发完取消信号就把 tokens 清空了，
   * 而那一刻子进程还没死、`execute()` 的 catch 也还没跑——用它数出来的永远是 0，
   * 退出路径会以为「已经收尾完毕」而直接刷盘。所以另记一份在飞的集合，
   * 由 `execute()` 自己在 finally 里摘除。
   */
  runningCount(): number {
    return this.inFlight.size
  }

  /**
   * 等所有在飞的任务走到终态（返回是否等到了）。
   *
   * 退出的那一刻需要它：`shutdown()` 只发信号，进程被 `taskkill /T /F` 杀掉之后
   * `execute()` 才会落终态、才会 `archive()` 进历史——原地就刷盘的话刷的是一份
   * 还没有这批记录的内存，最后那批被取消的任务在历史里查无此项。
   *
   * 超时是上限不是预期（杀进程是毫秒级的）：到点也照样返回，绝不能因为某个引擎
   * 僵住就让用户关不掉应用。
   */
  async drain(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (this.inFlight.size > 0) {
      if (Date.now() >= deadline) return false
      // 让出事件循环：终态是在子进程 exit 回调里落的，同步空转一万年也等不到
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    return true
  }

  /* ------------------------------------------------------------ 执行 */

  /**
   * 这条路线需要的重型引擎没装就地装一个。
   *
   * 三个阶段各报一次进度：**下载**（有百分比）、**解包**（没有百分比，msiexec 的
   * `-qn` 不吐进度，所以只能给一句 indeterminate 的话）。
   *
   * 不需要引擎、或引擎已就绪时这里是**两次纯内存判断**（各解析器的缓存 + 能力矩阵），
   * 所以放在每条任务的必经之路上不心疼。
   */
  private async installIfNeeded(id: string, task: Task, token: CancelToken): Promise<void> {
    const needed = requiresDownload(task.fromExt, task.toExt)
    if (needed === null || engineReady(needed)) return

    const label = engineLabel(needed)
    this.setProgress(id, { kind: 'indeterminate', stage: `正在准备 ${label} 引擎…` })

    const result = await installEngine(needed, {
      cancel: token,
      onProgress: (progress) => {
        // 与 convert 的 onProgress 同一个理由：任务可能已被删掉
        if (!this.tasks.has(id)) return
        this.setProgress(
          id,
          progress.phase === 'extract'
            ? { kind: 'indeterminate', stage: `正在安装 ${label} 引擎…` }
            : {
                kind: 'determinate',
                percent: progress.percent ?? 0,
                stage: `正在下载 ${label} 引擎…`
              }
        )
      }
    })

    // 装完再确认一次。**不能省**：installEngine 只保证「文件落到清单说的位置」，
    // 而「能不能用」是各解析器的判据（LibreOffice 还要求同目录有 soffice.bin）。
    // 少了这一句，装出一个跑不起来的引擎会以「转换失败」的面目出现，
    // 用户看到的是引擎报的错，而真正的原因在安装那一步。
    if (!engineReady(needed)) {
      // 抛**普通 Error** 而不是 ConversionFailed：后者的 message 是固定文案，
      // 内容全靠 logTail，而这条信息既不是引擎的 stderr、也不该被 summarize() 截短。
      // execute 的 catch 对普通 Error 用的是 error.message，正好是我们想说的那句。
      throw new Error(`${label} 引擎已下载并解包到 ${result.exe}，但仍不可用。请检查设置的引擎目录`)
    }
  }

  private async execute(id: string): Promise<void> {
    const task = this.tasks.get(id)
    if (!task || task.status === 'canceled') return

    const token = new CancelToken()
    this.tokens.set(id, token)
    // 与 tokens 分开记：shutdown() 会把 tokens 清空，而在飞的这批还没咽气
    this.inFlight.add(id)

    task.status = 'running'
    task.startedAt = Date.now()
    task.error = undefined
    task.logTail = undefined
    this.setProgress(id, { kind: 'indeterminate', stage: '准备中…' })
    this.mark(id, { status: 'running', startedAt: task.startedAt, error: null, logTail: null })

    let reserved: string | null = null

    try {
      // ★ 「转换时自动下载」（M7）：这条路线要靠一个还没下过的重型引擎，就地下完再开跑。
      //
      // **判在 reserveOutput 之前**：一次下载是分钟级的（LibreOffice 375 MB），
      // 期间占着一个输出名只会让同目录的另一条任务绕开一个其实还没被用的名字。
      // 下载失败时也因此不会留下任何占位。
      //
      // 与 `skipTasksNeedingDownload` 的关系：那个开关是「引擎没装就别排队」，
      // 开了它任务在**入队**就被拒（见 unavailableEngineReason），走不到这里；
      // 关着它（默认）才轮到这条自动下载。两者不冲突，顺序也是对的——
      // 用户明说了「未备就跳过」，我们就不该背着他下几百兆。
      await this.installIfNeeded(id, task, token)

      const outputDir = outputDirFor(task.inputPath)
      reserved = this.reserveOutput(task, outputDir)

      await convert({
        input: task.inputPath,
        output: reserved,
        fromExt: task.fromExt,
        toExt: task.toExt,
        // 参数原样传给引擎。这里**不做任何解释**：哪一类任务允许带哪些参数是
        // `setOptions` 与能力矩阵的事，引擎只负责按参数干活。
        options: task.options,
        cancel: token,
        onProgress: (progress) => {
          // 任务可能已在打开文件夹等操作中被删掉
          if (!this.tasks.has(id)) return
          this.setProgress(id, progress)
        }
      })

      // 读不到体积给 `null`（而不是 0）：0 是下面那条判据的输入，两者混起来会让
      // 「`stat` 失败」被报成「产物是 0 字节」——一条成功的转换被扣上一个假罪名。
      const size = await stat(reserved)
        .then((s) => s.size)
        .catch(() => null)

      // ★ 「产物不得为空」：**与 MCP 侧同一个判据、同一句文案**（见 `converters/common.ts`）。
      //
      // 少了这一句，一次 `md → txt`（正文只有一张图）会在这里收成 done、卡片上写着
      // 「0 字节」，而**同一次转换经 MCP 走**报的是 `source_corrupt`——两个界面给出
      // 两种判定，正好落在本项目明写的那条规矩上（绝不用空文件冒充成功）。
      // 判据住在共用件里，所以 GUI / MCP / 将来的任何入口接一次就继承；
      // 这里只负责「拿到体积之后、宣布成功之前」这一个位点。
      //
      // 抛 `ConversionFailed` 之后由下面的 catch 收成 `error` 终态：`logTail` 会进卡片，
      // `outputPath` 保持 `undefined`（那条 0 字节的文件**留在磁盘上**，与 MCP 侧行为
      // 一致——两边都只改判定、不动用户的目录，见报告里的取舍说明）。
      assertOutputNotEmpty(size, reserved)

      task.status = 'done'
      task.outputPath = reserved
      // `null` 退成 0 只影响展示（原来 `stat` 失败时就是 0），判定已经在上面做完
      task.sizeBytes = size ?? 0
      task.finishedAt = Date.now()
      this.archive(task)
      task.progress = { kind: 'determinate', percent: 1 }
      this.mark(id, {
        status: 'done',
        outputPath: reserved,
        sizeBytes: size,
        finishedAt: task.finishedAt,
        progress: task.progress
      })
    } catch (error) {
      if (error instanceof ConversionCanceled || token.canceled) {
        task.status = 'canceled'
        task.progress = null
        task.finishedAt = Date.now()
        this.archive(task)
        this.mark(id, { status: 'canceled', progress: null, finishedAt: task.finishedAt })
      } else if (error instanceof ConversionFailed) {
        task.status = 'error'
        task.error = error.logTail.length > 0 ? summarize(error.logTail) : error.message
        task.logTail = error.logTail
        task.progress = null
        task.finishedAt = Date.now()
        this.archive(task)
        this.mark(id, {
          status: 'error',
          error: task.error,
          logTail: task.logTail,
          progress: null,
          finishedAt: task.finishedAt
        })
      } else {
        task.status = 'error'
        task.error = error instanceof Error ? error.message : String(error)
        task.logTail = []
        task.progress = null
        task.finishedAt = Date.now()
        this.archive(task)
        this.mark(id, {
          status: 'error',
          error: task.error,
          logTail: [],
          progress: null,
          finishedAt: task.finishedAt
        })
      }
    } finally {
      this.tokens.delete(id)
      this.inFlight.delete(id)
      // 释放输出名占位：成功的任务产物已在磁盘上，后续任务自然能避开；
      // 失败/取消的没留下文件，名字应该还回去。
      if (reserved) this.claimed.delete(reserved.toLowerCase())
    }
  }

  /**
   * 把一条走到终态的任务抄进历史。
   *
   * **只被三个终态分支调用，绝不要改挂到 `mark()` 上。** `mark()` 也被
   * `running` / `progress` 这类非终态 patch 调用（每一条进度更新都要走它），
   * 挂过去就会变成同一个任务反复入库。调用点一律紧挨 `task.finishedAt = Date.now()`——
   * 「这条只写一次」的位置认的就是那一行。
   *
   * 三个**状态**对应四个**位点**：`error` 有两个分支（`ConversionFailed` 与
   * 兜底的普通异常），两边都要抄一次，否则工具链之外的异常会静默地不进历史。
   *
   * `cancel()` 里那个「还没开跑就被摘掉」的终态**刻意不入库**：那次转换从未发生，
   * 收进历史只会在 500 条上限里挤掉一条真的跑过的记录。
   */
  private archive(task: Task): void {
    const status = task.status
    // 兜底：将来若有人把调用点挪到别处，也不至于把非终态写进历史
    if (status !== 'done' && status !== 'error' && status !== 'canceled') return

    try {
      appendHistory({
        id: task.id,
        inputPath: task.inputPath,
        inputName: task.inputName,
        category: task.category,
        fromExt: task.fromExt,
        toExt: task.toExt,
        // 参数要跟着进历史：两条 clip.mp4 → mp4 在历史页里长得一模一样，
        // 而它们一条是整段、一条只裁了 5 秒。重跑也照它复现（见 core/rerun.ts）。
        options: task.options,
        engine: task.engine,
        status,
        // 产物后来被挪走/删掉都不影响这一条的存续：转换发生过就是发生过，
        // 「打开位置」那边自会告诉用户「原处已无此物」。
        outputPath: task.outputPath,
        sizeBytes: task.sizeBytes,
        // 只留 summarize 过的那一行。`logTail` 可能有几百行、含文件内容片段，
        // 让那种东西长期躺在 userData 里没有任何好处。
        error: task.error,
        createdAt: task.createdAt,
        startedAt: task.startedAt,
        finishedAt: task.finishedAt ?? Date.now()
      })
    } catch (error) {
      // **历史写不进去，不能把一次成功的转换改判成失败。** 三个调用点都落在
      // `execute` 的 try 里面，异常会一路走到 catch 把状态改成 error——
      // 而产物其实已经好好躺在磁盘上了。记一笔日志，然后放它过去。
      console.error('[task] 写入历史失败：', error)
    }
  }

  /**
   * 解析并占位输出路径。
   *
   * 光靠 resolveOutputPath 不够：它只看磁盘上有没有同名文件，而两个并发任务
   * 在各自写 `.part` 期间，磁盘上都还不存在最终文件，于是会解析到同一个名字，
   * 后完成的那个会静默覆盖先完成的。所以额外用 claimed 集合占位。
   *
   * resolveOutputPath 是同步的，claimed 的读写也是同步的，两者之间不会被
   * 其他任务的 await 插入，因此「检查 + 占位」是原子的。
   *
   * ⚠️ **这里不处理 `onConflict === 'skip'`**，它落在下面的 rename 分支里——这是
   * 刻意留的，不是漏了。略过问的是「用户已有的文件会不会被盖掉」，那个问题在**入队**
   * 时就有确定答案（见 `addPaths` 里的自然名判据），而且只有在那里能给出**看得见**的
   * 结果（`rejected` 列表）。放到这儿判就必须落到任务上，而任务的终态只有四个：
   * 收成 `error` 是在为一次用户主动要求的略过报错，收成 `done` 则要在 `logTail` 里
   * 解释「其实什么都没做」——可 `TaskCard.tsx` 只在 `status === 'error'` 时渲染
   * `logTail`，那句话根本没人看得见，绿色「已成」就成了假话。
   *
   * 留在这里的那半是**并发撞名**：两个文件同时转向同一个本名，磁盘上此刻谁都不存在，
   * 用户没有任何东西需要被保护。此时改名出一个 ` (1)` 是正确的，不属于「略过」的适用范围。
   */
  private reserveOutput(task: Task, outputDir: string): string {
    const settings = getSettings()

    if (settings.onConflict === 'overwrite') {
      const path = resolveOutputPath({
        inputPath: task.inputPath,
        outputDir,
        targetExt: task.toExt,
        onConflict: 'overwrite'
      })
      const key = path.toLowerCase()

      // 这个名字已经被**本会话里另一个正在跑的任务**占住时，落到下面的 rename 分支
      // 去另要一个。用户说的「覆盖」针对的是他磁盘上已有的那个文件，不包括我们自己
      // 两个并发任务抢同一个名字：临时名是最终名的纯函数（见 outputName.ts 的
      // partPathOf），解析到同一个最终名就等于两条流水线往**同一个 .part** 里写
      // ——产物内容取决于时序，而先收工的那条 rename 时会发现源文件已被另一条
      // rename 走，报出来的是一句「磁盘已满？」，把人引向完全错的方向。
      if (!this.claimed.has(key)) {
        this.claimed.add(key)
        return path
      }
    }

    const dir = dirname(task.inputPath)
    const base = baseNameOf(task.inputPath)
    const dot = base.lastIndexOf('.')
    const stem = dot > 0 ? base.slice(0, dot) : base

    for (let n = 0; n < 1000; n += 1) {
      // n > 0 时伪造一个带序号的名字再走一遍净化，得到 `movie (1).mp4` 这样的结果
      const probe = n === 0 ? task.inputPath : join(dir, `${stem} (${n}).${task.fromExt}`)
      const candidate = resolveOutputPath({
        inputPath: probe,
        outputDir,
        targetExt: task.toExt,
        onConflict: 'rename'
      })

      const key = candidate.toLowerCase()
      if (this.claimed.has(key)) continue

      // 纵深防御：净化 + resolveOutputPath 之后仍要确认没跳出目标目录
      if (!isInsideDir(candidate, outputDir)) {
        throw new ConversionFailed(['输出路径超出了目标目录，已阻止写入'])
      }

      this.claimed.add(key)
      return candidate
    }

    throw new ConversionFailed(['无法为该文件找到可用的输出文件名'])
  }

  /* ------------------------------------------------------------ 推送 */

  private setProgress(id: string, progress: TaskProgress): void {
    const task = this.tasks.get(id)
    if (!task) return
    task.progress = progress
    this.mark(id, { progress })
  }

  private mark(id: string, patch: Omit<TaskPatch, 'id'>): void {
    const existing = this.pendingUpdates.get(id)
    this.pendingUpdates.set(id, existing ? { ...existing, ...patch } : { id, ...patch })
    this.scheduleFlush()
  }

  private scheduleFlush(): void {
    if (this.flushScheduled) return
    this.flushScheduled = true
    // 让同一轮事件循环里的多次变更合并成一条 IPC 消息
    setImmediate(() => {
      this.flushScheduled = false
      const updated = [...this.pendingUpdates.values()]
      const removed = [...this.pendingRemovals]
      this.pendingUpdates.clear()
      this.pendingRemovals.clear()
      if (updated.length === 0 && removed.length === 0) return
      this.broadcast({ updated, removed })
    })
  }
}

/* -------------------------------------------------------------- 辅助 */

/**
 * 「引擎未备时跳过」的判据。返回拒绝理由，`null` 表示放行。
 *
 * **判的是「引擎在不在」，不是「这条路线需不需要引擎」。** 后者恒为真——所有电子书转换
 * 都走 Calibre、所有二进制办公格式都走 LibreOffice，只判路线的话这个开关一打开就等于把
 * 那两类转换整个关掉，而设置页上写的明明是「引擎未备时跳过」。
 *
 * 就绪判据交给 `engineReady()`（`engines/status.ts`），**这里不自己探路径**：
 *   - 它与关于页徽章是同一份裁决，两边分家的表现是「徽章写着已就绪，任务却被跳过」；
 *   - 它是**逐值 switch**（覆盖全部 `EngineKey`，漏一个就是编译错误）。早先这里写的是
 *     「不是 libreoffice 就是 calibre」的三元链，正因此漏掉了 pandoc：`md → docx` 那 10 条
 *     的 `needed` 是 `'pandoc'`，`ready` 却恒为 `true`——**开关对这些转换完全无效，
 *     而它看起来是生效的**，别的转换照样被正常跳过。
 *
 * 不用 `engineStatus()`：那个聚合件每次调用都先 `resetEngineCaches()` 把四个引擎的解析
 * 缓存清一遍（它在关于页有正当理由——用户可能正是刚装完引擎回来看一眼），而这里每拖入
 * 一个文件就要问一次，用它会变成缓存白清、`existsSync` 白跑。`engineReady()` 走的是
 * 各解析器「只探一次、把结果留住」的那条路。
 */
function unavailableEngineReason(fromExt: string, toExt: string): string | null {
  const needed = requiresDownload(fromExt, toExt)
  if (needed === null) return null
  return engineReady(needed) ? null : `需要 ${engineLabel(needed)} 引擎，当前未就绪，按设置已跳过`
}

function engineOf(fromExt: string, toExt: string): EngineKey {
  return engineFor(fromExt, toExt) ?? 'ffmpeg'
}

/** 取 stderr 里最有信息量的一行做卡片上的短提示 */
function summarize(logTail: string[]): string {
  const meaningful = [...logTail].reverse().find((line) => {
    const trimmed = line.trim()
    if (trimmed === '') return false
    if (trimmed.startsWith('frame=') || trimmed.startsWith('size=')) return false
    return true
  })
  const text = (meaningful ?? logTail[0] ?? '转换失败').trim()
  return text.length > 200 ? `${text.slice(0, 200)}…` : text
}
