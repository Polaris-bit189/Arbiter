import { rename, rm } from 'fs/promises'
import type { TaskOptions, TaskProgress } from '@shared/types'
import { killTree } from '../core/kill'
import type { CancelToken } from '../core/cancel'

/**
 * 各引擎共用的错误类型、上下文与落盘收尾。
 *
 * 单独成模块是为了避免循环依赖：`converters/index.ts` 要 import 各个引擎，
 * 各引擎又要用这里的类型——如果它们定义在 index 或 ffmpegRun 里，
 * 就会反过来 import 回去，形成一个环。
 */

/**
 * 重封装策略。省略即 `'auto'`。
 *
 * - `'auto'`   能重封装就重封装，不行就静默回退重编码（UI 那条路用的就是它）
 * - `'force'`  必须重封装，做不到就**报错**。给 MCP 的 `convert_file` 用：
 *              调用方是一个 agent，它要能明确要求「别动我的码流」，
 *              而「静默变成重编码」在它那一侧看起来是成功，代价是画质和几倍的时间
 * - `'off'`    强制重编码（MCP 的 `mode: 'reencode'`）
 *
 * **只对 ffmpeg 引擎有意义**，其余引擎读都不读——文档、图片、归档都没有「码流」这回事。
 */
export type RemuxMode = 'auto' | 'force' | 'off'

/** 引擎签名统一成这个形状，路由层（converters/index.ts）照着它分发 */
export interface ConvertContext {
  input: string
  output: string
  fromExt: string
  toExt: string
  cancel: CancelToken
  onProgress: (progress: TaskProgress) => void
  /** 省略 = `'auto'`。见 `RemuxMode`。 */
  remux?: RemuxMode
  /**
   * 任务参数（裁剪等）。**路由层原样透传，不解释它**——
   * 参数的语义只属于真正接到它的那个引擎，`converters/index.ts` 里多一个
   * `if (options?.trim)` 就等于给「裁剪能用在哪些方向」造出第二个真相源。
   *
   * 与 `remux` 一样，**只有 ffmpeg 引擎读它**：文档、图片、归档都没有时间轴。
   * 不认识它的引擎读到 `undefined` 或干脆不读，行为与加这个字段之前逐字相同。
   */
  options?: TaskOptions
}

export class ConversionCanceled extends Error {
  constructor() {
    super('已取消')
    this.name = 'ConversionCanceled'
  }
}

export class ConversionFailed extends Error {
  constructor(
    readonly logTail: string[],
    /**
     * 一句话的对外摘要（CLI / MCP 结果里的 `message`）。省略时由 `jobs.ts` 兜底成
     * 引擎那条通用文案。
     *
     * 为什么需要它：那个兜底文案「转换失败（引擎返回了非零退出码）」对**从没起过任何
     * 子进程**的那几条路是**假话**——文档解析（mammoth / SheetJS）、PDF 渲染、写盘
     * 都不返回退出码。而调用方（agent）是照着 `message` 与 `next_steps` 决定下一步的，
     * 一句错的归因比一句笼统的归因贵得多：它会去查一个无辜的源文件。
     */
    readonly summary?: string
  ) {
    super(summary ?? '转换失败')
    this.name = 'ConversionFailed'
  }
}

export const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * 外部 CLI 引擎的看门狗时限（毫秒）。
 *
 * **5 分钟是量出来的，不是拍的。** 本机实测（2026-09-14，随包引擎的真实二进制）：
 *
 * | 引擎 | 场景 | 耗时 |
 * | --- | --- | --- |
 * | pandoc | 18 字节 md → docx | 40 ms（热）/ 93 ms（会话首次） |
 * | pandoc | **2.16 MB** md → docx | **3.0 ~ 3.3 s** |
 * | LibreOffice | 小 docx → pdf | **8.3 s**（热）/ **16.0 s**（会话首次） |
 * | LibreOffice | 上面那份 2.16 MB 文档撑出的 docx → pdf（产物 26.7 MB） | **35 ~ 36 s** |
 * | Calibre | epub → docx | 0.5 s |
 * | Calibre | epub → pdf（小） | 3.6 s |
 * | Calibre | **533 KB 的 epub → pdf** | **147.8 s**，最后以 `0xC00000FD` 退出 |
 *
 * 最后那条是**这个值不能更小的直接证据**：一次真实的（虽然最终失败的）转换在
 * 两分半钟之前不会结束，任何「几十秒」量级的超时都会把这种正在干的活误杀成
 * 「引擎卡死」——而误杀的代价比多等几分钟大得多（用户拿到的是失败 + 一句错误的归因）。
 *
 * 与 `core/engineInstall.ts` 的 `EXTRACT_TIMEOUT_MS` 取同一个 5 分钟：全仓只有这一个
 * 量级，措辞与行为也一致（到点杀进程树、判据独立于退出码）。
 *
 * **覆盖范围**：三个外部 CLI 引擎（pandoc / libreoffice / calibre）。
 * ffmpeg / sharp / archive / pdfjs 不走这里——前两个没有「一个引擎占满一个槽位、
 * 后续任务全堵住」的问题（`ENGINE_LIMITS` 给它们的容量远大于 1），
 * 归档与 pdfjs 是纯 JS 或短命子进程。真要给它们也加，走同一份实现，别另写一个。
 */
export const ENGINE_TIMEOUT_MS = 5 * 60_000

/** 看门狗的构造参数。`timeoutMs` 可覆写是为了让测试用几百毫秒跑完一轮。 */
export interface EngineWatchdogConfig {
  /** 超时文案里的引擎名（用户看到的那句「谁超时了」） */
  label: string
  /** 时限，毫秒。省略 = `ENGINE_TIMEOUT_MS` */
  timeoutMs?: number
}

/**
 * 引擎看门狗：到点**杀掉整棵进程树**，并把「超时」这件事固化下来供调用方判读。
 *
 * 为什么需要它：`libreoffice` / `calibre` 的引擎容量都是 1（见 `core/queue.ts`），
 * 一个卡死的引擎会占着那个槽位不放，**该引擎之后的所有任务一起堵到会话结束**；
 * 而在此之前用户看到的只是「正在转换…」永远转下去，不报错、不失败。
 * 用户点取消确实能把进程树带走（约束 3），但那要求用户先意识到出事了。
 *
 * 三个必须记住的点：
 *
 * - **杀的是进程树，判据是 pid**：LibreOffice 的 `soffice.exe` 之下是 `soffice.bin`，
 *   Calibre 之下有 `calibre-parallel.exe` 与二十多个 `QtWebEngineProcess.exe`，
 *   只杀父进程会留下占着 profile 锁的孤儿（约束 3）。
 * - **`expired` 必须由看门狗自己记，不能靠调用方比对时间**：超时之后我们主动杀了树，
 *   而杀树会让 `close` 报一个非零码——不把这件事记下来的话，用户看到的是
 *   「退出码 1」或者引擎自己的半截报错，与真正发生的事（我们杀的）毫无关系。
 *   `core/engineInstall.ts` 里 `timedOut` 那个局部变量是同一件事的先例。
 * - **`stop()` 要在进程收尾的每条路径上都调到**（`close` 与 `error` 都要）：漏了的话，
 *   一次早就结束的转换会在 5 分钟后凭空多杀一次 pid——那个 pid 可能已经被系统
 *   回收给了别的进程。
 */
export class EngineWatchdog {
  private readonly label: string
  private readonly timeoutMs: number
  private timer: ReturnType<typeof setTimeout> | null = null
  private timedOut = false

  constructor(config: EngineWatchdogConfig) {
    this.label = config.label
    this.timeoutMs = config.timeoutMs ?? ENGINE_TIMEOUT_MS
  }

  /** 起表。`pid` 是子进程的 pid，杀的却是整棵树（约束 3） */
  arm(pid: number | undefined): void {
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timedOut = true
      void killTree(pid)
    }, this.timeoutMs)
    // 不让一个已经没人等的表把进程钉住（killTree 的兜底计时器也是这么做的）
    this.timer.unref?.()
  }

  /** 进程收尾时调用。可重复调用。 */
  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  /** 是否**已经**超时过（并因此杀过树） */
  get expired(): boolean {
    return this.timedOut
  }

  /**
   * 超时那条错误的内容。
   *
   * 措辞写在这里而不是三个引擎各写一份：这是要用户照着排查的，
   * 三份文案迟早漂成三种说法（`requirePandocExe` 那类提示同此理由）。
   */
  reason(): string[] {
    const seconds = this.timeoutMs / 1000
    const human = seconds >= 60 ? `${Math.round(seconds / 60)} 分钟` : `${Math.round(seconds)} 秒`
    return [
      `${this.label} 超过 ${human}没有结束，已强制终止（引擎超时）`,
      '这一条与「转换失败」不同：进程是我们主动杀掉的，产物可能只写了一半（不会有半成品留在输出目录）。',
      '常见原因：输入文件损坏让引擎陷进死循环、目标目录在网络盘或不可写的盘上、引擎在等一个已经不存在的资源。',
      '确认输入没问题后可以直接重试；这一次不会自动重试。'
    ]
  }
}

/**
 * 删除文件，失败时重试几次。
 *
 * Windows 上进程刚退出时文件句柄未必立刻释放，紧接着 rm 会拿到 EBUSY/EPERM。
 * 这不是错误，只是时序问题，重试即可——不重试的话取消任务后会残留 .part 文件。
 */
export async function removeQuietly(target: string): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await rm(target, { force: true })
      return
    } catch {
      await delay(120)
    }
  }
}

/**
 * 把临时产物原子地搬到最终路径。
 *
 * 同一目录内的 rename 在 NTFS 上是原子的：用户要么看到完整的旧文件，
 * 要么看到完整的新文件，不会看到半截的。这也是临时文件必须和产物同目录的原因。
 */
export async function finalizeOutput(tempPath: string, outputPath: string): Promise<void> {
  await removeQuietly(outputPath)
  try {
    await rename(tempPath, outputPath)
  } catch {
    await removeQuietly(tempPath)
    throw new ConversionFailed(['无法写入输出文件，请检查目标目录是否可写、磁盘是否已满'])
  }
}

/**
 * 「产物不得为空」那句**统一文案**。
 *
 * 两个界面共用同一句：MCP 侧（`src/mcp/jobs.ts`）把它当 `source_corrupt` 的 message，
 * GUI 侧把它当 `ConversionFailed` 的第一行日志。分家的话，**同一次转换在两个界面上
 * 会给出两种说法**，而用户与 agent 正是靠这句话判断「到底哪一步没产出东西」。
 * 改这一句 = 改对外报错文案，别顺手润色。
 */
export const EMPTY_OUTPUT_MESSAGE = '产物是 0 字节：转换进程正常退出了，但没有写出任何内容'

/**
 * 判据本身：这个体积算不算「0 字节产物」。
 *
 * 用**字节数**而不是「文本内容为空」，后者对二进制产物毫无意义——一个 0 字节的 mp4
 * 与「文本是空的」不是一回事，判据必须落在两个界面都拿得到、且所有引擎都有的量上。
 *
 * `null`（读不到体积，即 `stat` 失败）**不归这条判据管**：产物已经转出来了，
 * 把「读不出大小」改判成失败才是撒谎。MCP 侧同一处也是这个口径。
 *
 * ⚠️ **刻意放过的一档**：`xlsx/csv → csv` 在首个工作表为空时会写一个 **UTF-8 BOM**，
 * 也就是 **1 字节**而不是 0 字节，因此不命中这里（审计列的四个触发场景里只有它漏网）。
 * 要拦住它得另立一条「文本类产物只含 BOM」的判据，那是第二个真相源，
 * 而且只对文本出口成立——不值得为一格单开一个判据。宁可漏一档，不要判错一片。
 */
export function isEmptyOutput(sizeBytes: number | null): boolean {
  return sizeBytes === 0
}

/**
 * 判据的 GUI 形态：命中就抛 `ConversionFailed`。
 *
 * 抛这个类型而不是普通 `Error`：`TaskManager.execute` 的 catch 会把 `logTail`
 * 原样收进卡片，而这里恰好有一句「为什么」要说。
 *
 * ⚠️ **`logTail` 的最后一行才是卡片上显示的那一行**（`core/task.ts` 的 `summarize()`
 * 取的是最后一条有内容的），所以「怎么办」必须写在最后，第一行只是结论。
 *
 * ---- 为什么判在共用件里，而不是各引擎各判一次 ----
 *
 * 这条规矩原先在代码里有**四份**实现（MCP 侧全部引擎、LibreOffice、Calibre、
 * `pdf → txt/md` 的 `textlessReason`），而**覆盖面最广的那条通用完成路径
 * （GUI 的完成路径）恰好没有**——于是同一次 `md → txt`（正文只有一张图）
 * 经 MCP 走报 `source_corrupt`，在桌面界面里却显示「已成 0 字节」。
 * 判据下沉到这里之后，任何入口接一次就继承；MCP 侧接的是上面那个谓词
 * （它要自己决定错误码与 message），GUI 侧接的是这个抛异常的形态。
 *
 * 审计列的四个触发场景：`md → txt`（正文只有一张图）、`html → txt`（正文只有
 * style/script）、`docx → txt`（文档里没有任何文本 run）、`xlsx/csv → csv`
 * （首个工作表为空，见上面那一档）。
 *
 * ---- 哪些出口本来就可能合法产出 0 字节？**一个都没有** ----
 *
 * ffmpeg / sharp 的产物有容器头与元数据、归档有索引、PDF 有文件尾、docx 是 zip、
 * 文本出口在「源里有内容」时必然非空。真出现 0 字节，含义只有一种：引擎声称成功、
 * 而磁盘上什么都没写出来——正是本项目最忌讳的那类静默失败。
 * （这也是唯一需要检查的：`libreoffice.ts` / `calibre.ts` 自己那两道 `ensureProduced`
 * 挡在 `finalizeOutput` 之前，产物根本落不到这条判据上。）
 */
export function assertOutputNotEmpty(sizeBytes: number | null, productPath: string): void {
  if (!isEmptyOutput(sizeBytes)) return
  throw new ConversionFailed([
    EMPTY_OUTPUT_MESSAGE,
    `产物路径：${productPath}`,
    '常见原因是源文件里没有可转换的内容：正文只有一张图片、正文只有样式或脚本、表格的首个工作表为空',
    '请检查源文件里是否有可转换的内容'
  ])
}

/** 取输出尾部若干行，供 UI 展开排查 */
export function tailLines(text: string, max = 50): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== '')
    .slice(-max)
}
