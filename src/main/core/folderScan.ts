import { readdir, realpath, stat } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { categoryOf, extOf } from '@shared/formats'

/**
 * 文件夹递归扫描（`docs/PLAN.md` §9.1 的 E-4）。
 *
 * ## 为什么不是给 `readdir` 加一个 `recursive: true`
 *
 * 「打开文件夹」原先只收**顶层**那一层文件，而且那是**刻意的**：递归扫一个五万文件的
 * 目录会把主进程卡死若干秒，而主进程是唯一真相源——它一卡，整个应用没有任何反应
 * （连取消都点不动），任务栏还会挂上「未响应」。
 *
 * ⚠️ Node 20 起 `readdir(dir, { recursive: true })` 恰好就是那个形态：它**一次**
 * 把整棵树收进内存，中间一次都不让出事件循环。所以递归只能自己走，靠三条约束一起成立：
 *
 * 1. **异步分批 + 显式让出**：每个目录一次 `await`，并且每处理 `YIELD_EVERY` 个条目
 *    主动回一次 macrotask 队列（`yieldToLoop`）。观测点是 `scripts/test-integration.ts`
 *    里那条「扫描期间 10ms 定时器仍在触发」——整趟压在一个 macrotask 里的话它是 0 次。
 * 2. **随时可取消**：`shouldCancel` 在**每个**让出点被问一次；取消后返回的 `files`
 *    一定是**空数组**，调用方因此不可能拿到半份清单去入队。
 * 3. **条数上限**：到上限就停，并把 `truncated` 一路带回到用户面前。
 *    **不做静默截断**——「少了一半文件却什么都不说」正是本项目最忌讳的形态。
 *
 * ## 与 `MAX_TASKS`（500）为什么不是一个数
 *
 * 两个上限管的是**两种不同的资源**，混成一个数会让两边都说不清：
 *
 * - `MAX_SCAN_FILES = 5000` 管**枚举**：内存里的路径数组、确认框的规模、以及扫描本身的墙钟。
 *   它随**文件系统**涨，与我们的队列无关。
 * - `MAX_TASKS = 500`（`core/task.ts`）管**任务表**：每条任务的状态、引擎队列的分桶记账、
 *   以及界面要渲染的行数。它随**我们自己的状态**涨。
 *
 * 取成同一个数的话，「已达上限」这句话就分辨不出「这个文件夹里还有很多没扫到」
 * 与「队列满了」——前者要用户去选更小的文件夹，后者要用户先去清空。而且扫描上限
 * 必须**明显大于**队列上限，那条截断提示才有信息量：真到了 5000，说明这个文件夹
 * 本来就该分次处理。队列满了这件事由 `addPaths` 逐条拒绝并说理由，与拖入 3000 个
 * 文件走的是同一条路（E-4 不改入队那条链路）。
 *
 * ## 排除清单：默认要能挡下大目录，但宁可少排
 *
 * 用户选了一个大目录时（比如整个 `D:\`），这条决定成败：不进 `node_modules` / `.git` /
 * 系统目录，就不会去枚举几十万个与转换无关的文件。
 *
 * 判据的方向是**宁可少排**：漏排一个目录的代价只是「慢一点」，误排的代价是
 * **用户要的文件静默地没有进来**。所以 `dist` / `build` / `out` / `target` / `.cache`
 * 这类**既可能是构建产物、也可能是用户自己的素材**的目录**都不在清单里**。
 * 清单本身由 `reportLines()` 带回到界面上——用户看得见我们跳过了什么，才有机会
 * 换成「只加这一层」或者挑一个更小的文件夹。
 */

/** 一次扫描最多收多少个文件。见文件头：它管的是枚举，不是队列 */
export const MAX_SCAN_FILES = 5000

/** 每处理多少个条目主动让出一次事件循环。见文件头第 1 条 */
const YIELD_EVERY = 128

/**
 * 按**目录名**命中的排除项（大小写不敏感）。
 *
 * 每一项都是「这里面的东西不可能是一个格式转换的目标」：
 * 依赖树、版本库内部对象、Python 的缓存与虚拟环境、Windows 自己的回收站
 * 与卷影信息。核对的依据是它们各自的既有约定，不是「看起来像垃圾」。
 */
export const EXCLUDE_DIR_NAMES: readonly string[] = [
  'node_modules',
  '.git',
  '.svn',
  '.hg',
  '__pycache__',
  '.venv',
  'venv',
  '.tox',
  '.mypy_cache',
  '.pytest_cache',
  '$RECYCLE.BIN',
  'System Volume Information'
]

/**
 * 按**名字前缀**命中的排除项（大小写不敏感）。
 *
 * `.tmp-*` / `.scratch-*` 是本项目自己的测试残留（`docs/NOTES.md` 约束 30 里那 96 MB 的
 * `blob.bin`、96 MB 的 `bulk.zip` 就躺在 `.tmp-test-tasks-*` 里）。同类工具也普遍这么命名。
 */
export const EXCLUDE_DIR_PREFIXES: readonly string[] = ['.tmp-', '.scratch-']

export interface ScanRules {
  /** 目录名，小写比较 */
  names: readonly string[]
  /** 目录名前缀，小写比较 */
  prefixes: readonly string[]
  /**
   * **绝对路径前缀**（小写比较）:系统目录。
   *
   * 为什么系统目录按绝对路径而不是目录名：用户自己完全可能有一个叫 `Windows` 的文件夹，
   * 按名字排会把他的东西一起排掉。而 `C:\Windows` 只可能是系统目录。
   * 只在**用户选的根**能被对上时才生效（比如他选了整个 `C:\`）。
   */
  roots: readonly string[]
}

/**
 * 系统目录的绝对路径。取环境变量而不是写死 `C:\Windows`：
 * 盘符与安装位置在不同机器上并不一样。
 *
 * ⚠️ 这些根**只对「用户选中目录的后代」生效，对根目录自己不生效**——
 * 用户显式选了 `C:\Windows\Fonts` 就说明他真的要那个目录里的东西。
 */
export function systemRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  return [
    env.SystemRoot,
    env.windir,
    env.ProgramFiles,
    env['ProgramFiles(x86)'],
    env.ProgramData
  ].filter((value): value is string => typeof value === 'string' && value.length > 0)
}

export function defaultRules(env: NodeJS.ProcessEnv = process.env): ScanRules {
  return {
    names: EXCLUDE_DIR_NAMES,
    prefixes: EXCLUDE_DIR_PREFIXES,
    roots: systemRoots(env)
  }
}

/** 一条「这个目录没进去」的记录。`path` 一律是绝对路径，用户要能照着去找 */
export interface ScanSkip {
  path: string
  /** 中文、可直接显示。**必须带理由**：跳过却不说为什么等于静默 */
  reason: string
}

export interface ScanReport {
  root: string
  /** 认得的目标文件，绝对路径。**取消时一定是空数组** */
  files: string[]
  /** 真正读成功的目录数（读不了的记在 `skipped` 里，不计入） */
  dirsScanned: number
  /** 到了 `limit` 就停了：文件夹里还有没扫到的部分 */
  truncated: boolean
  limit: number
  /** 权限不足 / 已不存在等原因读不了的目录 */
  skipped: ScanSkip[]
  /** 被排除清单或成环判据挡下的目录 */
  excluded: ScanSkip[]
  /** 用户在扫描过程中取消。此时 `files` 为空、`truncated` 为假 */
  cancelled: boolean
  /** 让出事件循环的次数。0 就说明整趟扫描压在了一个 macrotask 里（测试盯着它） */
  yields: number
}

/**
 * 文件系统出口。抽出来是为了让测试能构造**确定性的故障**
 * （权限不足、目录扫到一半消失），不必去赌 ACL 与磁盘状态——
 * 与 `core/downlink.ts` 把传输层抽成 `DownloadTransport` 是同一个理由。
 */
export interface ScanIo {
  listDir(dir: string): Promise<Dirent[]>
  realpath(path: string): Promise<string>
  /** 跟随符号链接看看到底是什么。**只有符号链接条目会问它** */
  kindOf(path: string): Promise<'dir' | 'file' | 'other'>
}

/**
 * 默认出口。
 *
 * ⚠️ **`listDir` / `realpath` 走 `fs/promises` 是承重的，不是风格问题。**
 * 换成同步实现之后每次调用都要自己阻塞事件循环一次，那时**只剩**「每 128 个条目
 * 显式让出一次」这一条防线；两条一起坏才是真正的原始形态——整棵树被压进一个
 * macrotask，期间定时器一次都不触发、用户点的取消也排不上队，也就是
 * `docs/PLAN.md` §9.1 说的「递归扫五万文件会卡死主进程」本身。
 * `scripts/falsify-integration.mjs` 里有一个变异把这两条一起改掉（**锚点必须同时
 * 罩住下面这个函数**：只改 I/O 那一半的话，显式让出仍然在让出，界面照样响应，
 * 断言不会红——那会伪装成「断言是装饰」）。
 */
const defaultIo: ScanIo = {
  kindOf: async (path) => {
    const info = await stat(path)
    if (info.isDirectory()) return 'dir'
    if (info.isFile()) return 'file'
    return 'other'
  },
  listDir: (dir) => readdir(dir, { withFileTypes: true }),
  realpath: (path) => realpath(path)
}

/** 回到 macrotask 队列一次。为什么用 setImmediate 而不是 setTimeout(…, 0)：见文件头。 */
function yieldToLoop(): Promise<void> {
  return new Promise<void>((done) => setImmediate(done))
}

export interface ScanOptions {
  /** 条数上限，默认 `MAX_SCAN_FILES` */
  limit?: number
  /** 排除规则，默认 `defaultRules()` */
  rules?: ScanRules
  /** 文件系统出口，默认 `defaultIo`。测试用它注入确定性故障 */
  io?: ScanIo
  /** 每个让出点被问一次：返回 true 就停止扫描，且**不留半份结果** */
  shouldCancel?: () => boolean
  /** 每多少个条目让出一次，默认 128 */
  yieldEvery?: number
}

const errnoOf = (error: unknown): string => {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return typeof code === 'string' && code.length > 0 ? code : '未知错误'
}

/** 命中哪条排除规则，没命中返回 null。**只看目录名/前缀，绝不看某一层的文件** */
function excludeReason(name: string, fullPath: string, rules: ScanRules): string | null {
  const lower = name.toLowerCase()
  if (rules.names.some((item) => item.toLowerCase() === lower)) {
    return `按默认排除清单跳过（${name}），未扫描`
  }
  if (rules.prefixes.some((prefix) => lower.startsWith(prefix.toLowerCase()))) {
    return `按默认排除清单跳过（${name}*），未扫描`
  }
  const lowerPath = fullPath.toLowerCase()
  const root = rules.roots.find((item) => {
    const prefix = item.toLowerCase().replace(/[\\/]+$/, '')
    return (
      lowerPath === prefix ||
      lowerPath.startsWith(`${prefix}\\`) ||
      lowerPath.startsWith(`${prefix}/`)
    )
  })
  if (root !== undefined) return `按默认排除清单跳过（系统目录 ${root}），未扫描`
  return null
}

/**
 * 递归扫一个目录，返回**报告**（不是「直接入队」）。
 *
 * 顺序是**广度优先、同层按名字排序**：顶层先出、再逐层往深处走，这样截断时
 * 留下的那前 N 个是可复现的（`readdir` 本身不保证顺序），而且与「只加这一层」
 * 那个选项在观感上是一致的。
 */
export async function scanFolder(root: string, options: ScanOptions = {}): Promise<ScanReport> {
  const limit = options.limit ?? MAX_SCAN_FILES
  const rules = options.rules ?? defaultRules()
  const io = options.io ?? defaultIo
  const yieldEvery = options.yieldEvery ?? YIELD_EVERY
  const shouldCancel = options.shouldCancel ?? ((): boolean => false)

  const start = resolve(root)
  const files: string[] = []
  const skipped: ScanSkip[] = []
  const excluded: ScanSkip[] = []
  /** 已经进过的目录（按 realpath）。符号链接成环全靠这个集合挡下来 */
  const seen = new Set<string>()

  let dirsScanned = 0
  let yields = 0
  let sinceYield = 0
  let truncated = false

  const empty = (cancelled: boolean): ScanReport => ({
    root: start,
    // ⚠️ 取消时**一定是空的**：调用方只有拿到完整清单才允许入队，
    // 「半份清单」在界面上与「完整清单」长得一模一样，却少了一部分文件。
    files: [],
    dirsScanned,
    truncated: false,
    limit,
    skipped,
    excluded,
    cancelled,
    yields
  })

  // 广度优先：`cursor` 当读指针而不是 `shift()`，后者在十万级目录上是 O(n²)
  const queue: string[] = [start]
  let cursor = 0

  while (cursor < queue.length) {
    if (shouldCancel()) return empty(true)

    const dir = queue[cursor] as string
    cursor += 1

    // 环判据放在**进入之前**：`realpath` 会把符号链接与 junction 一并解析掉，
    // 于是「junction 指回祖先」与「两个 junction 指向同一处」都落到同一个集合里。
    // 解析不了（权限、路径已经在消失）就退回字面路径：宁可多扫一次，也不要漏掉一个目录。
    const real = await io.realpath(dir).catch(() => dir)
    if (seen.has(real)) {
      excluded.push({ path: dir, reason: '重复目录（符号链接指向同一处或成环），未重复扫描' })
      continue
    }
    seen.add(real)

    let entries: Dirent[]
    try {
      entries = await io.listDir(dir)
    } catch (error) {
      // 权限不足 / 目录刚被移走**都只跳过这一个目录**，不是整趟失败：
      // 一棵树里有一个别人的私有目录，不该让另外两千个文件也收不进来。
      skipped.push({ path: dir, reason: `无法读取（${errnoOf(error)}），已跳过` })
      continue
    }
    dirsScanned += 1

    // 同层按名字排序：`readdir` 的顺序由文件系统给，同机不同次都可能不一样，
    // 而截断要截前 N 个，所以顺序必须是可复现的。
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))

    for (const entry of entries) {
      const full = join(dir, entry.name)

      // ⚠️ 顺序是承重的：`isDirectory()` 对 junction / 符号链接返回 **false**
      //（实测：Windows 上 junction 的 dirent 是「既不是文件也不是目录，而是符号链接」），
      // 所以先判它、再跟随链接问一次真实类型。少这一条的话，用户目录里的
      // junction 会被当成「其他东西」静默忽略——连同它指向的那一整棵子树。
      let kind: 'dir' | 'file' | 'other'
      if (entry.isDirectory()) kind = 'dir'
      else if (entry.isFile()) kind = 'file'
      else if (entry.isSymbolicLink()) kind = await io.kindOf(full).catch((): 'other' => 'other')
      else kind = 'other'

      if (kind === 'dir') {
        const reason = excludeReason(entry.name, full, rules)
        if (reason === null) queue.push(full)
        else excluded.push({ path: full, reason })
      } else if (kind === 'file') {
        // 认不出的扩展名（`.DS_Store`、`.lnk`、没有扩展名的）不进结果：交给
        // `addPaths` 逐条拒绝的话，用户会收到一屏「不支持的文件类型」，而这些噪音
        // 本来就是这一个目录自己产生的。判据与 `addPaths` 用的是同一份能力矩阵。
        if (categoryOf(extOf(entry.name)) === null) continue
        if (files.length >= limit) {
          truncated = true
          break
        }
        files.push(full)
      }
      // else：套接字、FIFO 之类，不进结果也不进报告（它们既不是目录也不是候选文件）

      sinceYield += 1
      if (sinceYield >= yieldEvery) {
        sinceYield = 0
        yields += 1
        await yieldToLoop()
        // 让出点是取消的落点：取消只可能发生在事件循环转起来之后
        if (shouldCancel()) return empty(true)
      }
    }

    if (truncated) break
  }

  return {
    root: start,
    files,
    dirsScanned,
    truncated,
    limit,
    skipped,
    excluded,
    cancelled: false,
    yields
  }
}

/* ---------------------------------------------------------------- 确认与入队 */

/** 用户在确认框上的三种选择 */
export type FolderScope = 'recursive' | 'top' | 'cancel'

export interface ScanPrompt {
  /** 一句话说清「将加入 N 个文件」 */
  message: string
  detail: string
  /** 与 `choices` **一一对应**，下标就是用户在系统弹框里点的第几颗 */
  buttons: string[]
  choices: FolderScope[]
}

const MAX_SAMPLE = 5

/** 把报告里的一部分路径缩成「a、b、c 等 N 个」 */
function sampleOf(items: ScanSkip[], limit = MAX_SAMPLE): string {
  const names = items.slice(0, limit).map((item) => item.path.split(/[\\/]/).pop() ?? item.path)
  return items.length > limit ? `${names.join('、')} 等 ${items.length} 个` : names.join('、')
}

/**
 * 扫描结果 → 确认框的文案。
 *
 * 返回 `null` 表示**不必问**：一个文件都没有时不弹「将加入 0 个文件」——那不是一次
 * 确认，而是一句噪音（调用方会给「此处没有认得的文件」那句话）。
 *
 * ⚠️ **默认两颗按钮是「含子文件夹 / 取消」，只有真的存在顶层文件时才多出「只加这一层」。**
 * 这一条就是「可选递归」的落点：递归不是替换掉原来的行为，而是多出来的一个选项；
 * 用户在确认框上能看见它到底会加多少个，也随时能退回到原先那一层。
 */
export function confirmPromptFor(report: ScanReport): ScanPrompt | null {
  if (report.cancelled || report.files.length === 0) return null

  const total = report.files.length
  const recursiveButton = report.truncated
    ? `加入这 ${total} 个（已达上限）`
    : `加入这 ${total} 个文件`

  const lines: string[] = [
    `文件夹：${report.root}`,
    `已扫过 ${report.dirsScanned} 个目录，其中认得的目标文件 ${total} 个。`
  ]

  if (report.truncated) {
    lines.push(
      `⚠️ 已达扫描上限 ${report.limit}，这个文件夹里还有没扫到的部分。` +
        `这次只会加入前 ${total} 个，剩下的请再选一次更小的文件夹。`
    )
  }

  const topCount = report.files.filter((path) => dirname(path) === report.root).length
  if (topCount > 0) lines.push(`其中直接躺在这一层里的有 ${topCount} 个。`)

  if (report.excluded.length > 0) {
    lines.push(
      `按默认排除清单跳过了 ${report.excluded.length} 个目录：${sampleOf(report.excluded)}。`
    )
  }
  if (report.skipped.length > 0) {
    lines.push(
      `有 ${report.skipped.length} 个目录读不了（权限不足或已不存在），已跳过：${sampleOf(report.skipped)}。`
    )
  }

  const buttons: string[] = [recursiveButton]
  const choices: FolderScope[] = ['recursive']

  if (topCount > 0) {
    buttons.push(`只加这一层（${topCount} 个）`)
    choices.push('top')
  }

  buttons.push('取消')
  choices.push('cancel')

  return {
    message: `将加入 ${total} 个文件`,
    detail: lines.join('\n'),
    buttons,
    choices
  }
}

/**
 * 确认框那条路：**先给 N，用户点了才开始入队**。
 *
 * 抽成纯函数（`ask` 是回调）是为了让「点没点、点了哪个」这件事在普通 Node 下
 * 就能被完整驱动一遍——真弹框的只有 `ipc/tasks.ts` 里那几行接线。
 *
 * 返回空数组 = 什么都不该入队（用户取消，或者报告本身是空的/被取消的），
 * **不是**「可以入队一批空清单」。
 */
export async function planFolderEnqueue(
  report: ScanReport,
  ask: (prompt: ScanPrompt) => Promise<FolderScope>
): Promise<string[]> {
  const prompt = confirmPromptFor(report)
  if (prompt === null) return []

  const choice = await ask(prompt)
  if (choice === 'cancel') return []
  if (choice === 'top') return report.files.filter((path) => dirname(path) === report.root)
  return report.files
}

/* ------------------------------------------------------------------ 报告出口 */

/** 报告里最多逐条列出多少项（再多就折成一行汇总） */
const MAX_REPORT_LINES = 20

/**
 * 报告 → 界面上那张「未收入队列」清单的行。
 *
 * 之所以把报告塞进 `AddResult.rejected`：那条链路**已经**是「哪些东西没进来、
 * 为什么」的唯一出口（拖入 3000 个文件被拒也是它），复用它意味着契约与界面都不用动。
 * 而排除清单**必须让用户看见**——他才知道我们跳过了什么，才有机会换个目录或只加一层。
 */
export function reportLines(report: ScanReport): { path: string; reason: string }[] {
  const lines: { path: string; reason: string }[] = []

  const push = (items: ScanSkip[], fallback: string): void => {
    for (const item of items.slice(0, MAX_REPORT_LINES)) {
      lines.push({ path: item.path, reason: item.reason })
    }
    if (items.length > MAX_REPORT_LINES) {
      // 这条的 `path` 特意做成一句话而不是路径：它在界面上只显示名字那一列，
      // 而「还有 N 个」这件事本身就是要说的话。不重复列出前 20 个之外的路径，
      // 是因为那些路径的**理由全都一样**，列出来只会把清单淹掉。
      lines.push({
        path: `…另有 ${items.length - MAX_REPORT_LINES} 个目录`,
        reason: fallback
      })
    }
  }

  push(report.excluded, '同上（按默认排除清单跳过）')
  push(report.skipped, '同上（读不了的目录）')

  if (report.truncated) {
    lines.push({
      path: `已达扫描上限 ${report.limit}`,
      reason: '文件夹里还有没扫到的部分，剩下的请再选一次更小的文件夹'
    })
  }

  return lines
}

/** 一句话汇总，给界面上的 toast 用 */
export function reportSummary(report: ScanReport): string {
  const parts = [`找到 ${report.files.length} 个文件`]
  if (report.truncated) parts.push(`已达上限 ${report.limit}，还有没扫到的`)
  if (report.excluded.length > 0) parts.push(`按清单跳过 ${report.excluded.length} 个目录`)
  if (report.skipped.length > 0) parts.push(`${report.skipped.length} 个目录读不了`)
  return parts.join('；')
}
