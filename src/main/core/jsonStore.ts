import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync
} from 'fs'
import { dirname } from 'path'
import type { SettingsCorruption } from '@shared/types'

/**
 * 历史名字。定义已搬到 `@shared/types`——它要跨 IPC 送到渲染层（设置页那条告警），
 * 而 preload 不能 import 主进程的模块。这里留个别名，免得改一串调用点。
 */
export type JsonStoreCorruption = SettingsCorruption

/**
 * 一个「落盘的小 JSON」的公共外壳。`core/history.ts` 与 `core/settings.ts` 共用它。
 *
 * 抽出来的动机不只是省代码，而是**让历史与设置两条线能真正并行**：
 * 原子写、脏标记、退出兜底这三件事一旦各写一份，必然会有一份写漏——
 * 而漏掉原子写的表现是「硬关机后设置文件成了半截 JSON」，
 * 下次启动时被 `parse` 判为不可用、整份设置回到默认值，且没有任何提示。
 *
 * （2026-09-14 审计后补的两处见下：写盘那侧加了 `fsync`，就是要把上面这个半截态
 * 从**源头**堵掉；读盘那侧从「静默丢弃」改成「改名留档 + 记一条 `lastCorruption()`」，
 * 因为光堵源头不够——文件已经坏了的话，用户至少不该连原始数据都留不下。）
 */

/** 合并写的延迟。个人工具里改设置是低频操作，500ms 足够把连续几次改动并成一次写 */
const FLUSH_DELAY_MS = 500

/**
 * 「磁盘上那份文件读不出可用数据」这件事的记录。**留档这一半比报错那一半重要。**
 *
 * 为什么必须留档：原实现是「解析失败 → 返回默认值 → `dirty = false`」，于是那份坏文件
 * 一直躺在那儿等着被下一次 `set()` 覆盖。用户改一个设置就把自己**全部**设置
 * （或整份历史记录）永久抹掉了，而且全程没有任何提示——审计实测过：截断的
 * `settings.json` 让 12 项设置静默变默认，历史记录同理整份丢失。
 *
 * 留档之后，那份坏文件至少还在原目录里躺着，人（或下一个版本的迁移逻辑）还能把它捞回来。
 */

export interface JsonStore<T> {
  /**
   * 同步读一次盘。
   *
   * 要在 `app.whenReady()` 里、`createWindow()` **之前**调：
   * 晚了会留下「第一个 IPC 读到的还是空数据」那种竞态窗口。
   * 忘了调也不会崩——`get()` 会补一次——但那就把竞态窗口又打开了。
   */
  loadSync(): T

  get(): T

  /** 整体替换。标脏并安排一次延迟写，不阻塞调用方 */
  set(next: T): void

  /**
   * 立即落盘。**全项目唯一该用同步 IO 的地方**：
   * 它挂在 `before-quit` 上，异步写在进程退出之前根本来不及完成。
   */
  flushSync(): void

  /**
   * 上一次 `loadSync()` 时那份文件坏掉的留档信息；没坏过就是 `null`。
   *
   * 存在的意义只有一个：**让这件事在界面上可见**。`console.error` 在打包后的 GUI 里
   * 谁都看不到（没有终端），所以上层要能问出「这次启动丢过数据吗、原文件在哪」。
   *
   * ⚠️ 目前 `core/settings.ts` 已经把它转出来了（`getSettingsCorruption()`），
   * 但**还没有任何调用者**：把它送到渲染层要动 `Settings` 的形状或加一条 IPC 通道，
   * 那是 `src/shared/ipc-contract.ts` 与 `src/main/ipc/` 的事（见审计 §3.10 的收尾）。
   * 在那之前，这里至少保证了「数据没被覆盖」这一半。
   */
  lastCorruption(): JsonStoreCorruption | null
}

export interface JsonStoreOptions<T> {
  /** 绝对路径。父目录不存在会自动建 */
  file: string
  /**
   * 从磁盘上的原始 JSON 还原成 `T`。
   *
   * 返回 `null` 表示这份数据不可用（文件损坏、或被手改成了别的形状），
   * 于是退回 `initial()`。**不要在这里抛异常**——抛出去会让整个应用起不来，
   * 而一个读不动的配置文件绝不该有这个权力。
   */
  parse: (raw: unknown) => T | null
  /** 序列化成要写进磁盘的对象（版本号之类的信封在这一层加） */
  serialize: (value: T) => unknown
  /** 磁盘上没有可用数据时的起点 */
  initial: () => T
}

export function createJsonStore<T>(options: JsonStoreOptions<T>): JsonStore<T> {
  let current: T | null = null
  let dirty = false
  let timer: NodeJS.Timeout | null = null
  let lastCorruption: JsonStoreCorruption | null = null

  /**
   * 把读不动的文件改名留档。
   *
   * 改名而不是复制：**原文件必须从那个位置上消失**，否则下一次 `set()` 照样会覆盖它。
   * 用 rename 的另一个好处是它不动内容——留档那份与用户原本写下的那份逐字节相同，
   * 人拿它去比对 / 手工修复时不会被「我们顺手格式化了一遍」干扰。
   *
   * 时间戳取 ISO 再把 `:` `.` 换成 `-`：Windows 文件名里不许有冒号，而带毫秒是为了
   * 「同一个文件在一秒内坏两次」也能各自留一份（下面的循环兜重复）。
   *
   * 失败返回 `null`：**这里绝不抛**。文件被别的进程占着、目录只读，都不该让应用起不来——
   * 那正是本模块开头那句「一个读不动的配置文件绝不该有这个权力」。
   */
  function quarantine(): string | null {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    let target = `${options.file}.corrupt-${stamp}`
    for (let n = 2; existsSync(target) && n < 100; n += 1) {
      target = `${options.file}.corrupt-${stamp}-${n}`
    }
    try {
      renameSync(options.file, target)
      return target
    } catch {
      return null
    }
  }

  function readFromDisk(): T {
    if (!existsSync(options.file)) return options.initial()

    let reason: string | null = null
    try {
      const raw: unknown = JSON.parse(readFileSync(options.file, 'utf8'))
      // `options.parse` 按约定不抛，返回 `null` 才表示「这份数据整体不可用」。
      // 两种失败（JSON 解不开 / 形状不认识）走同一条留档路径：它们对用户的后果一样
      // ——「我的设置全没了」——而区分它们只会多一条没人看的支路。
      const parsed = options.parse(raw)
      if (parsed !== null) return parsed
      reason = '内容不是认识的形状（被手改过，或来自不兼容的版本）'
    } catch (error) {
      reason = error instanceof Error ? error.message : String(error)
    }

    // ⚠️ 先留档、再返回默认值。**顺序是承重的**：晚一步的话，紧接着的第一次
    // `set()`（用户随手改一个开关）就会把那唯一一份原始数据永久覆盖掉。
    const quarantinePath = quarantine()
    lastCorruption = { file: options.file, quarantinePath, reason }
    console.error(
      `[jsonStore] ${options.file} 读不出可用数据（${reason}）；` +
        (quarantinePath ? `原文件已留档为 ${quarantinePath}` : '留档失败，原文件仍在原地') +
        '，本次改用默认值。'
    )
    return options.initial()
  }

  function writeNow(): void {
    if (!dirty || current === null) return

    const tempPath = `${options.file}.tmp`
    try {
      mkdirSync(dirname(options.file), { recursive: true })
      const payload = JSON.stringify(options.serialize(current), null, 2)

      // 写 `.tmp` → **fsync** → rename。少了中间那一步，掉电恰好落在 rename 之前
      // 就会留下一个「名字对、内容半截」的 JSON，下次启动被判为损坏——那正是
      // 上面那段留档逻辑要兜的入口，能不从这头进就别从这头进。
      //
      // 为什么不用 `writeFileSync`：它拿不到 fd，而 fsync 必须对着 fd 做。
      const fd = openSync(tempPath, 'w')
      try {
        writeSync(fd, payload, null, 'utf8')
        fsyncSync(fd)
      } finally {
        // close 放在 finally 里：fsync 失败时也不能漏掉 fd（Windows 上一个没关的
        // 句柄会让下面那句 rename 自己撞上 EBUSY，把「掉电」这条支路变成必现的写失败）。
        closeSync(fd)
      }

      // rename 在 Windows 上映射到 MoveFileEx(..., MOVEFILE_REPLACE_EXISTING)，
      // **能覆盖已存在的目标**——这是 Windows 上的经典雷区（POSIX 的 rename 语义
      // 与此不同，很多人按 POSIX 的直觉写会以为要先删）。仓内 core/downlink.ts
      // 已在用同一手法，等于这里不必再从零验证一遍。
      //
      // 目录本身的 fsync **刻意不做**：Windows 上对着目录句柄调 fsync 会失败
      // （Node 侧表现为 EPERM / EISDIR），而 NTFS 的元数据变更走日志，rename 的
      // 持久化由它保证。写一段在目标平台上必然抛的代码，只会让「写成功」这件事
      // 从此看起来像「写失败」。
      renameSync(tempPath, options.file)
      dirty = false
    } catch (error) {
      // 写失败**不打消脏标记**：下一次 set() 或 before-quit 的 flushSync() 会再试。
      // 但也不重排定时器——磁盘满的时候那样会变成每 500ms 一次的忙循环。
      try {
        unlinkSync(tempPath)
      } catch {
        // 临时文件可能压根没建出来，无所谓
      }
      console.error(`[jsonStore] 写不动 ${options.file}：`, error)
    }
  }

  function schedule(): void {
    timer ??= setTimeout(() => {
      timer = null
      writeNow()
    }, FLUSH_DELAY_MS)
    // 这个定时器不该拖住事件循环：测试脚本里 import 一下这个模块就跑不掉进程会很怪
    timer.unref?.()
  }

  return {
    loadSync(): T {
      // 留档信息描述的是「**这一次**读盘」，所以先清掉上一轮的，再读
      lastCorruption = null
      current = readFromDisk()
      dirty = false
      return current
    },

    get(): T {
      // 兜底：调用方忘了 loadSync() 时补一次，而不是返回一个空壳
      if (current === null) return this.loadSync()
      return current
    },

    set(next: T): void {
      current = next
      dirty = true
      schedule()
    },

    flushSync(): void {
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
      writeNow()
    },

    lastCorruption(): JsonStoreCorruption | null {
      return lastCorruption
    }
  }
}
