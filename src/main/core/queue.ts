import { cpus } from 'os'
import type { EngineKey, EncodePreset, TaskOptions } from '@shared/types'

/**
 * 按引擎分桶的并发调度器。
 *
 * 为什么不是一个全局线程池：各引擎的资源模型完全不同。
 *  - ffmpeg 是 CPU 密集型，开满核反而互相抢时间，留一核给 UI
 *  - LibreOffice 单进程单 profile，并发第二个实例必然失败，只能为 1
 *  - Chromium printToPDF 每个隐藏窗口 50-80 MB，也压到 1
 * 所以并发上限必须按引擎分桶，而不是一个全局数字。
 *
 * ⚠️ 下面这张表与设置页那个「并发上限」下拉（`maxConcurrent`）**是两个不同的东西**，
 * 别把它们读成同一个数字：
 *
 *   - `maxConcurrent` 是**用户选的全局上限**（1~16，`settingsPatchSchema` 也卡在 16），
 *     数的是**任务个数**。
 *   - 这张表是**每个引擎自己的安全容量**，由引擎的资源模型决定，与用户选了什么无关。
 *
 * 真正生效的并发 = min(全局上限, 该引擎的容量, 任务按代价分摊下来的份数)。
 * 所以**把下拉拉到 16 不等于 16 路并发**：图片批量仍然停在 4（实测并发 6 已经平台化，
 * 再多只是白占内存）、LibreOffice 仍然只能 1、1080p 视频仍然停在 4（内存墙，
 * 见 HEAVY_COST）。这不是「设置没生效」——**下拉是上限，不是目标**：它压得住峰值
 * （设成 1 就是全串行），只是抬不高于引擎自己的安全线。
 *
 * 但这里以前**确实是错的**，值得记一笔：这张表曾经把 ffmpeg / sharp 钉死在
 * 常量 4 / 2 上，而那时把下拉从 4 拉到 16 **一个任务也不会多跑**——对一个主要卖点
 * 就是「一次拖两百个小文件」的工具来说，「并发上限」这个设置项在它的主要场景里
 * 是个摆设，而界面上完全看不出来。修法不是把常量改大，而是让容量跟着核数走
 * （sharp）、跟着任务大小走（ffmpeg，见 `taskCost`），于是下拉第一次真的顶用。
 *
 * ---
 * 下面四个常量就是那张容量表的全部输入，每一个数都是实测的。
 */

/**
 * ffmpeg 的容量（份数）。12 是实测出来的甜点：40 个「1 秒 64x64」的 mp4 → mkv
 * （强制重编码），并发 4 是 399 ms、并发 **12 是 228 ms**（1.75×）。
 * 再往上没测，也没必要——进程启动那笔固定开销这时已是主要成本。
 */
const FFMPEG_SLOTS = 12

/** 留一核给 UI：全占满时界面会明显卡 */
const SHARP_LIMIT = Math.min(4, Math.max(1, cpus().length - 1))

/**
 * 大文件按几份计。
 *
 * **内存是真正的墙**：实测单个 1080p60 的 `libx264 veryfast` 进程峰值 RSS
 * 914~925 MiB（720p 是 345 MiB），12 路就是 11 GB。
 * 而**速度上大文件根本不吃并发**：16 个 1080p60/20 秒转 mkv，并发 4 是 24256 ms、
 * 并发 12 是 23963 ms——持平，一点没赚到。既然两头都不赚，就不放。
 *
 * 3 不是内存比值，就是让 12 / 3 = 4 这么来的：容量 12 份 ÷ 每任务 3 份 = 最多 4 路。
 * 把大文件锁死在实测过的那一档上，比去猜一个「按内存算」的模型可靠。
 */
const HEAVY_COST = 3

/**
 * 「小文件」的判据：**输入体积 ≤ 1 MiB**。
 *
 * 阈值刻意取得很低，两条理由：
 *   - 真正决定单个 ffmpeg 进程内存的是**分辨率**（实测 720p 峰值 345 MiB、
 *     1080p60 峰值 914 MiB），而分辨率在入队期拿不到——我们刻意不在启动前探测
 *     （见 docs/NOTES.md 约束 5，那次探测的钱只花在 remux 决策上）。
 *     体积只是它的代理指标，而且代理得并不好：一段 `-crf 51` 压出来的 720p/12 秒
 *     只有 813 KiB。
 *   - 所以宁可少赚：只有**明确很小**的输入才走快车道，其余一律按重文件算。
 *     误判成「轻」的代价是内存（可能打爆一台 8 GB 的机器），误判成「重」的代价
 *     只是慢一点。方向必须选后者。
 *
 * 这条快车道还有第二道闸：它照样受用户的全局上限约束，而默认就是 4。
 * 也就是说**默认配置下的行为与改动之前一模一样**——要把 12 路开出来，用户得自己
 * 显式把并发上限拉上去，那是他的选择，不是我们替他做的（设置项那句提示已经写着
 * 「越大越吃 CPU」）。
 */
const FAST_LANE_MAX_BYTES = 1024 * 1024

/**
 * 引擎并发容量：同一引擎同时最多被占用多少「份」。
 *
 * 这张表给的是**每个引擎自己的安全上界**，与用户选的 `maxConcurrent` 是两回事——
 * 文件头那段注释里的三条（图片停 4、大视频停 4、LibreOffice 只能 1）说的就是它。
 */
const ENGINE_CAPACITY: Record<EngineKey, number> = {
  /** 12 份 = 小文件实测的并发甜点；大文件按 3 份计，于是自动收敛到 4 路，见 taskCost */
  ffmpeg: FFMPEG_SLOTS,
  /**
   * sharp 从常量 2 提到核数（上限 4）。实测 1600x1200 JPEG → JPEG q90 共 24 张
   * （3 轮取中位）：并发 2 是 1450 ms、并发 4 是 **825 ms**（1.76×）；
   * 换 4032x3024 的实拍尺寸重做一遍是 6343 → 3629 ms（1.75×），同一个结论。
   *
   * 上限取 4 而不是跟着核数走：**并发 6 就是平台**（实测 796 ms，只比 4 快 3.5%），
   * 而 libvips 自己每个操作就开线程池，外面再叠一层只是过订阅。
   */
  sharp: SHARP_LIMIT,
  pdf: 1,
  pandoc: 2,
  /** 单进程单 profile：第二个实例会静默把参数转交给第一个，退出码 0 却不产生产物 */
  libreoffice: 1,
  calibre: 1,
  archive: 2
}

/** 引擎的并发容量（份数）。准入判据见 `pump()` */
export function engineLimit(engine: EngineKey): number {
  return ENGINE_CAPACITY[engine] ?? 1
}

/**
 * 一条任务占几份并发。只有 ffmpeg 分档，其余引擎一律 1 份。
 *
 * `inputBytes` 为 `undefined` 表示量不到体积（理论上不该发生）——**按重的算**：
 * 在一个来历不明的文件上放大并发，赌的是一台机器的内存。
 */
/**
 * 慢预设比 `veryfast` 多吃多少内存。
 *
 * ## 为什么这张表存在
 *
 * 它补的正是 `FAST_LANE_MAX_BYTES` 那段注释自己承认的那个洞：「真正决定内存的是
 * 分辨率，而分辨率在入队期拿不到，体积只是个代理」。**编码预设是第二个决定内存的量，
 * 而它在入队期就在 `task.options` 里**——白拿，没有任何理由不记。
 *
 * ## 数据（本机实测，2026-09-17）
 *
 * 口径：同一份 1080p30 真实照片推镜素材、`-crf 23`、单个进程采样
 * `PeakWorkingSet64`（20 ms 一次），取全程峰值。
 *
 * | preset    | 峰值 RSS   | 对 veryfast |
 * | --------- | ---------- | ----------- |
 * | ultrafast | 887 MiB    | 0.57        |
 * | superfast | 1373 MiB   | 0.89        |
 * | veryfast  | 1544 MiB   | 1.00        |
 * | faster    | 1652 MiB   | 1.07        |
 * | fast      | 1759 MiB   | 1.14        |
 * | medium    | 2007 MiB   | 1.30        |
 * | slow      | 2125 MiB   | 1.38        |
 * | slower    | 2222 MiB   | 1.44        |
 * | veryslow  | 2525 MiB   | 1.64        |
 * | placebo   | 3556 MiB   | **2.30**    |
 *
 * 曲线是干净的单调，所以这张表不是拍的。取值按「实测比值四舍五入到 0.5」定，
 * **下界夹在 1**：比 `veryfast` 更省内存的档位不该让这本账放宽——
 * 那等于拿「用户选了个更省内存的档」去赌另一条任务的分辨率，方向是错的。
 *
 * ⚠️ **这一条与本文件其它常量的口径有一个重要差别**：那些数是「相对比值」（它描述的是
 * 引擎**内部**的取舍），而张表只影响并发账。所以它不需要和别的常量凑同一台机器、
 * 同一份素材——**只有比值有意义**，绝对值换个素材就变（同一份数据换 640x640 素材，
 * veryfast 是 118 ms / 213 KB，那张表里一样用）。
 */
const PRESET_MEMORY_FACTOR: Record<EncodePreset, number> = {
  ultrafast: 1,
  superfast: 1,
  veryfast: 1,
  faster: 1,
  fast: 1,
  medium: 1.5,
  slow: 1.5,
  slower: 1.5,
  veryslow: 1.5,
  placebo: 2.5
}

/**
 * 一条任务占几份并发。只有 ffmpeg 分档，其余引擎一律 1 份。
 *
 * 两个输入，先后判：
 *
 * 1. **输入体积**判轻重（`FAST_LANE_MAX_BYTES`），理由见那里；
 * 2. **编码预设**再乘一个倍率（`PRESET_MEMORY_FACTOR`）——它比体积那个代理准得多，
 *    因为它真的是「这条任务要吃掉多少编码器内存」的直接原因。
 *
 * `inputBytes` 为 `undefined` 表示量不到体积（理论上不该发生）——**按重的算**：
 * 在一个来历不明的文件上放大并发，赌的是一台机器的内存。
 *
 * `options` **必须显式传**（可以是 `undefined`，表示这条任务没有参数）。做成必填
 * 而不是可选，是为了让「忘了传」变成编译错误：省掉一个参数就少乘一次倍率，
 * 而那个错误**不会有任何症状**——队列只是悄悄地多放进去几条重编码。
 * MCP 那条路（`src/mcp/jobs.ts`）今天没有质量档，它显式传 `undefined`。
 */
export function taskCost(
  engine: EngineKey,
  inputBytes: number | undefined,
  options: TaskOptions | undefined
): number {
  if (engine !== 'ffmpeg') return 1
  const base = inputBytes === undefined || inputBytes > FAST_LANE_MAX_BYTES ? HEAVY_COST : 1
  const preset = options?.quality?.preset
  if (preset === undefined) return base
  // 向上取整：代价是**份数**，小数份在 `costOf` 那一层会被夹成整数，两个方向都难看。
  // 取整方向选「多占」——宁可少赚一点吞吐，也不要在内存上赌。
  return Math.ceil(base * PRESET_MEMORY_FACTOR[preset])
}

interface Entry {
  id: string
  engine: EngineKey
  /** 占几份并发（`taskCost()` 算出来的）。缺省 1 */
  cost?: number
}

/** 缺省 1，并且夹在 [1, 容量] 之间——代价大于容量会让这条任务永远排不进去（静默饿死） */
function costOf(entry: Entry): number {
  const raw = entry.cost ?? 1
  return Math.max(1, Math.min(raw, engineLimit(entry.engine)))
}

export interface QueueStats {
  waiting: number
  running: number
  perEngine: Partial<Record<EngineKey, number>>
}

export class EngineQueue {
  private waiting: Entry[] = []
  /**
   * 每个引擎当前占用的**份数**（不是任务个数）。准入判据看的是它。
   *
   * 「份数」与「个数」分家正是自适应的实现方式：容量 12 份，小文件一条占 1 份
   * （能跑 12 路），大文件一条占 3 份（只能跑 4 路）。两个数都是实测的，见 taskCost。
   */
  private running = new Map<EngineKey, number>()
  /** 每个引擎当前在跑的**任务个数**。只给 `stats()` 看，别拿它做准入 */
  private runningTasks = new Map<EngineKey, number>()
  private runningTotal = 0
  private pumping = false

  constructor(
    private readonly execute: (id: string) => Promise<void>,
    /** 全局上限，取设置里的 maxConcurrent */
    private readonly globalLimit: () => number
  ) {}

  push(entry: Entry): void {
    this.waiting.push(entry)
    this.pump()
  }

  /** 从等待队列里摘掉（任务还没开跑就被取消/删除的情况） */
  remove(id: string): boolean {
    const index = this.waiting.findIndex((e) => e.id === id)
    if (index < 0) return false
    this.waiting.splice(index, 1)
    return true
  }

  isWaiting(id: string): boolean {
    return this.waiting.some((e) => e.id === id)
  }

  /** 让调度器重新评估——任务跑完、或者用户改了并发数时调用 */
  pump(): void {
    if (this.pumping) return
    this.pumping = true
    try {
      const global = Math.max(1, this.globalLimit())
      // 内层循环每次都从头找第一个「放得下」的任务：某个引擎占满时
      // 后面的任务只要引擎有空位仍然应该开跑，不能被前面那个卡住。
      for (;;) {
        if (this.runningTotal >= global) return
        const index = this.waiting.findIndex(
          (e) => (this.running.get(e.engine) ?? 0) + costOf(e) <= engineLimit(e.engine)
        )
        if (index < 0) return

        const [entry] = this.waiting.splice(index, 1)
        const cost = costOf(entry)
        this.running.set(entry.engine, (this.running.get(entry.engine) ?? 0) + cost)
        this.runningTasks.set(entry.engine, (this.runningTasks.get(entry.engine) ?? 0) + 1)
        this.runningTotal += 1

        // execute 内部保证不抛（错误在任务状态机里消化），这里的 catch 只是防漏
        void this.execute(entry.id)
          .catch(() => {})
          .finally(() => {
            this.running.set(
              entry.engine,
              Math.max(0, (this.running.get(entry.engine) ?? cost) - cost)
            )
            this.runningTasks.set(
              entry.engine,
              Math.max(0, (this.runningTasks.get(entry.engine) ?? 1) - 1)
            )
            this.runningTotal = Math.max(0, this.runningTotal - 1)
            this.pump()
          })
      }
    } finally {
      this.pumping = false
    }
  }

  stats(): QueueStats {
    const perEngine: Partial<Record<EngineKey, number>> = {}
    // 数的是**任务个数**而不是份数：这个出口的读者（测试、退出路径）问的是
    // 「那个引擎上有几条任务在跑」，而份数是给准入判据用的内部记账。
    for (const [engine, count] of this.runningTasks) {
      if (count > 0) perEngine[engine] = count
    }
    return { waiting: this.waiting.length, running: this.runningTotal, perEngine }
  }

  /** 退出前清空等待队列，防止已排队的任务在窗口关闭后继续冒出来 */
  clearWaiting(): void {
    this.waiting = []
  }
}
