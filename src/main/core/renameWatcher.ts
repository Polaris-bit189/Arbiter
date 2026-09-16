import { watch, type FSWatcher } from 'fs'
import { readdir, rename, stat } from 'fs/promises'
import { join } from 'path'
import { diffRename, watchableName, type DirEntry, type RenameCandidate } from './renameWatch'

/**
 * 「重命名即转换」的**驱动**：真的盯目录、真的改回名字、真的叫队列开跑。
 *
 * 与 `core/renameWatch.ts` 的分工是「副作用 / 判断」：判断全在那个纯模块里，
 * 这里只负责把副作用按正确顺序做出来。
 *
 * **本文件不 import electron**（只用 `fs` / `path`），窗口、通知、任务队列三件事
 * 由调用方通过 `RenameEffects` 注入 —— 于是整条链路能在普通 Node 里用真的临时目录测，
 * 与 `test-integration.ts` 其余部分的跑法一致。
 *
 * ## 两条必须记住的时序
 *
 * 1. **`fs.watch` 只当唤醒信号，重扫结果才是唯一真相。** 事件会来好几次（改名、
 *    目录元数据）、可能带着已经过期的名字，还可能因为缓冲区溢出被整批丢掉。
 *    所以事件只负责「过一会儿重扫一遍」，重扫读的是**当下的磁盘**。
 * 2. **我们自己的每一次改名之后都要立刻重建基线。** 少了这一步，「把 `a.mp4` 改回
 *    `a.mkv`」这件事在下一轮里看起来正好是一次「`mp4` → `mkv` 的改名」，
 *    于是会反向再转一次，两个方向来回震荡。入队被拒时那次**回滚**同理。
 */

/**
 * 服务本身不做的那三件事。由调用方注入。
 *
 * 三个出口都是**必须**的：改名即转换发生在用户没在看窗口的时候，静默是这个功能
 * 唯一不可接受的表现——成功了要有一句系统通知，失败了也得有个地方说出来。
 */
/**
 * 入队的结果。**失败必须带上原因**：失败路径会把用户的文件名改回去，
 * 而「名字自己变回来了」如果没有一句解释，比什么都不做更让人发毛。
 */
export type EnqueueOutcome = { ok: true } | { ok: false; reason: string }

export interface RenameEffects {
  /**
   * 把源文件按正常流程转成它现在名字所宣称的格式。
   *
   * `ok: false` 表示**被拒**（引擎没装、格式不支持……）。那种情况下这里会把文件
   * 改回用户给它的名字——我们不能一边不给转换、一边把用户的文件名也留在半路上。
   */
  enqueue(sourcePath: string, toExt: string): Promise<EnqueueOutcome>
  /** 系统通知。成功路径上唯一的回执 */
  notify(title: string, body: string): void
  /** 出错时的出口。**不弹模态框**——用户只是改了个文件名 */
  warn(message: string): void
}

export interface RenameWatcherOptions {
  /**
   * 事件到重扫之间的防抖窗口（毫秒）。
   * 一次改名会触发好几个 `fs.watch` 事件，而且文件可能还在被写。
   */
  debounceMs?: number
  /**
   * 单个目录超过这么多条目就**不监听**它。
   * 每次重扫都要 `stat` 每一个条目（体积是判据之一），几千个文件的目录不该被反复全量扫。
   */
  maxEntriesPerDir?: number
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

const DEFAULT_DEBOUNCE_MS = 400
const DEFAULT_MAX_ENTRIES = 4096

export class RenameWatcher {
  private dirs: readonly string[] = []
  private watchers: FSWatcher[] = []
  private snapshots = new Map<string, readonly DirEntry[]>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private busy = false
  private pending = false

  constructor(
    private readonly effects: RenameEffects,
    private readonly options: RenameWatcherOptions = {}
  ) {}

  private get debounceMs(): number {
    return this.options.debounceMs ?? DEFAULT_DEBOUNCE_MS
  }

  private get maxEntries(): number {
    return this.options.maxEntriesPerDir ?? DEFAULT_MAX_ENTRIES
  }

  /**
   * 用这一批目录（重新）开始监听。
   *
   * 目录没变时是**幂等**的——设置页每存一次都会调到这里，重建一遍 watcher 会白白丢掉
   * 已经建好的基线，于是刚重启的那一瞬间「本来就存在的文件」会被当成刚出现。
   */
  async setDirs(dirs: readonly string[]): Promise<void> {
    const next = [...new Set(dirs)].sort()
    const same =
      next.length === this.dirs.length && next.every((dir, i) => dir === (this.dirs[i] as string))
    if (same) return

    this.teardown()

    for (const dir of next) {
      try {
        // `persistent: false`：监听目录不该成为「Node 进程还没退出」的理由。
        // Electron 主进程由 app 自己撑着，不靠这个。
        const watcher = watch(dir, { persistent: false }, () => this.schedule())
        // 目录被删掉 / 改名是常事（用户随手整理文件夹），不是错误，什么都不做。
        watcher.on('error', () => undefined)
        this.watchers.push(watcher)
      } catch (err) {
        // 目录不存在 / 没权限。**要说出来**，否则用户开了开关、配置了目录、
        // 却什么都不会发生，而界面上那个开关是打开的。
        this.effects.warn(`无法监听目录「${dir}」：${messageOf(err)}`)
      }
    }

    this.dirs = next
    // 基线必须由一次真扫描建立：`sweep` 里「没有 before 就只记基线、不下判断」那条
    // 正好保证这次扫描不会误判任何东西。
    await this.rescan()
  }

  /** 停掉监听并丢掉基线。**再 `setDirs` 就是从头开始** */
  stop(): void {
    this.teardown()
    this.dirs = []
  }

  /**
   * 立刻重扫一遍。
   *
   * `fs.watch` 只调这个。**测试也调这个**——不依赖定时器和文件系统事件的测试才是
   * 确定的，真事件只单独测一条（见 `test-integration.ts`）。
   */
  async rescan(): Promise<void> {
    if (this.busy) {
      // 正在处理上一轮。**记一笔而不是丢弃**：这一轮的事件可能就是用户在我们处理期间
      // 改的第二个文件，丢了就永远补不回来（`fs.watch` 不会再报一次）。
      this.pending = true
      return
    }
    this.busy = true
    try {
      do {
        this.pending = false
        await this.sweep()
      } while (this.pending)
    } finally {
      this.busy = false
    }
  }

  private teardown(): void {
    for (const watcher of this.watchers) {
      try {
        watcher.close()
      } catch {
        // 已经关掉了 / 目录已经没了：没有需要处理的状态
      }
    }
    this.watchers = []
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.snapshots.clear()
  }

  private schedule(): void {
    if (this.timer !== null) return
    this.timer = setTimeout(() => {
      this.timer = null
      void this.rescan()
    }, this.debounceMs)
  }

  /** 读一个目录的快照。读不到就返回 `null`（调用方据此忘掉这个目录） */
  private async snapshotDir(dir: string): Promise<readonly DirEntry[] | null> {
    let names
    try {
      names = await readdir(dir, { withFileTypes: true })
    } catch {
      // 目录不存在 / 没权限：用户删掉一个白名单目录是常事，不当作错误。
      return null
    }

    if (names.length > this.maxEntries) {
      this.effects.warn(`目录「${dir}」条目过多（${names.length}），已跳过重命名监听`)
      return null
    }

    const out: DirEntry[] = []
    for (const dirent of names) {
      // 目录、符号链接、我们的 `.part` 临时名一律不进快照
      if (!dirent.isFile()) continue
      if (!watchableName(dirent.name)) continue
      try {
        const info = await stat(join(dir, dirent.name))
        out.push({ name: dirent.name, size: info.size })
      } catch {
        // 扫描期间文件被删/被改名：跳过它，下一轮快照自然会对齐
      }
    }
    return out
  }

  private async sweep(): Promise<void> {
    for (const dir of this.dirs) {
      const next = await this.snapshotDir(dir)
      if (next === null) {
        // 目录没了就忘掉基线。**不能留着旧基线**：目录再回来时留着的话，
        // 中间这段时间的增删会一次性算成「刚刚发生的改名」。
        this.snapshots.delete(dir)
        continue
      }
      const before = this.snapshots.get(dir)
      this.snapshots.set(dir, next)
      // 第一次扫只建基线：`before` 为空时 `diffRename` 本来就返回空，
      // 但把这个意图写明更好——将来若给 diff 加了「新文件也算」之类的判据，
      // 这里仍然不会在启动瞬间误判。
      if (before === undefined) continue

      for (const candidate of diffRename(dir, before, next)) {
        await this.handle(dir, candidate)
      }
    }
  }

  /** 把这次改名吸收进基线。**凡是我们动过磁盘就必须调**，否则自己会被自己触发 */
  private async refreshBaseline(dir: string): Promise<void> {
    const next = await this.snapshotDir(dir)
    if (next === null) this.snapshots.delete(dir)
    else this.snapshots.set(dir, next)
  }

  private async handle(dir: string, candidate: RenameCandidate): Promise<void> {
    const sourcePath = join(dir, candidate.from)
    const renamedPath = candidate.path

    try {
      // 把文件改回它内容真正的扩展名。**用户取的那个名字就此腾出来给产物**，
      // 而源文件以原来的名字**原样保留**——这就是「可撤销」的全部含义：
      // 我们一个字节都没删，用户想反悔只需要把它改回去。
      await rename(renamedPath, sourcePath)
    } catch (err) {
      this.effects.warn(`把「${candidate.to}」改回「${candidate.from}」失败：${messageOf(err)}`)
      // 失败也可能留下了半截状态（比如目标名被占），照样重建基线
      await this.refreshBaseline(dir)
      return
    }
    // ★ 立刻重建基线：少了这一句，上面这次 `rename` 在下一轮里就是一次
    // 「mp4 → mkv」的改名，于是会反向再转一次。
    await this.refreshBaseline(dir)

    let outcome: EnqueueOutcome
    try {
      outcome = await this.effects.enqueue(sourcePath, candidate.toExt)
    } catch (err) {
      outcome = { ok: false, reason: messageOf(err) }
    }

    if (!outcome.ok) {
      // 入队被拒。**必须把名字还回去**：否则我们等于偷偷改了用户的文件名、
      // 而且什么也没换来——比什么都不做还坏。
      let restored = true
      try {
        await rename(sourcePath, renamedPath)
      } catch (err) {
        restored = false
        this.effects.warn(`把「${candidate.from}」改回「${candidate.to}」失败：${messageOf(err)}`)
      }
      if (restored) await this.refreshBaseline(dir)

      // 告警只发一条，而且**由这里发**——回滚是这里做的，说清「名字为什么变回去了」
      // 也只有这里知道。放在调用方的 `enqueue` 里发的话，同一件事会被说两遍，
      // 而且那一条说不出「文件名已经还给你了」。
      this.effects.warn(
        `「${candidate.to}」没能转成 ${candidate.toExt.toUpperCase()}：${outcome.reason}` +
          (restored ? `。文件名已改回「${candidate.to}」` : '。文件名没能还原，请手动检查')
      )
      return
    }

    this.effects.notify(
      '调律者转换器',
      `「${candidate.to}」的内容其实是 ${candidate.fromExt.toUpperCase()}，已经按真正的 ` +
        `${candidate.toExt.toUpperCase()} 转换。原文件保留为「${candidate.from}」。`
    )
  }
}
