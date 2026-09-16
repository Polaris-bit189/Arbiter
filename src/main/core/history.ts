import { join } from 'path'
import { baseNameOf, categoryOf, engineFor, extOf } from '@shared/formats'
import {
  CATEGORIES,
  DEINTERLACE_METHODS,
  DENOISE_STRENGTHS,
  ENGINE_KEYS,
  IMAGE_FITS,
  ROTATE_DEGREES,
  TRIM_MODES
} from '@shared/types'
import type {
  Category,
  DeinterlaceMethod,
  DenoiseStrength,
  EngineKey,
  FilterAction,
  HistoryEntry,
  HistoryStatus,
  ImageFit,
  OutputOptions,
  ResizeAction,
  RotateDegree,
  TaskOptions,
  TrimMode,
  TrimOptions
} from '@shared/types'
import { appPaths } from './appPaths'
import { createJsonStore, type JsonStore } from './jsonStore'

/**
 * 历史记录：**曾经尘埃落定过的转换**，与活动队列毫无关系。
 *
 * 存的是 `HistoryEntry` 而不是 `Task`（理由见 `@shared/types` 里那个类型的注释），
 * 这里只补一条落地层面的：一旦历史里存的是 `Task`，后人就会顺手写「启动时从历史
 * 重建队列」——那会直接破坏「主进程是活动队列唯一真相源」这条不变量。
 * 类型分开，这条路就从「顺手」变成「要刻意绕一道」。
 *
 * 「发生过」与「还找得到」是两件事：条目**不因为 `outputPath` 已经不存在而被删掉**。
 * 用户把产物挪走、改名、删掉，都不改变「这次转换发生过」这个事实。
 */

/**
 * 上限。超了从**尾部**丢，也就是丢最旧的。
 *
 * 刻意不做「按时间过期」：这是个人工具，「我的历史怎么没了」远比一份 200 KB 的
 * JSON 更糟。500 条按一条 400 字节估也就 200 KB 上下，还不到一张截图大。
 */
export const MAX_HISTORY_ENTRIES = 500

/** 磁盘信封的版本号。写在文件里是为了将来真需要迁移时有个判据 */
const FILE_VERSION = 1

const VALID_STATUS: readonly string[] = ['done', 'error', 'canceled']

/**
 * 剪枝：只留最新的 `MAX_HISTORY_ENTRIES` 条。
 *
 * **读盘与追加共用这一处**——写两遍的话，反证时改坏其中一处，另一条入口上的断言
 * 照样是绿的，于是「超过 500 条会丢最旧」这条断言只覆盖了一半的路径。
 */
function prune(entries: HistoryEntry[]): HistoryEntry[] {
  return entries.length > MAX_HISTORY_ENTRIES ? entries.slice(0, MAX_HISTORY_ENTRIES) : entries
}

/* ------------------------------------------------------------ 逐字段收敛 */

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function isStatus(value: unknown): value is HistoryStatus {
  return typeof value === 'string' && VALID_STATUS.includes(value)
}

function isCategory(value: unknown): value is Category {
  return typeof value === 'string' && (CATEGORIES as readonly string[]).includes(value)
}

function isEngine(value: unknown): value is EngineKey {
  return typeof value === 'string' && (ENGINE_KEYS as readonly string[]).includes(value)
}

/**
 * 任务参数的**宽容恢复**：认不出来的那一项就当它没设过。
 *
 * 与 `defaultTargets` 那种「逐键筛」不同，这里退到「没有这一项」是安全的，
 * 也是唯一安全的方向：参数**只影响这一次转换怎么做**，退回「没有参数」= 整段转换 /
 * 不缩放 / 不限体积，产物仍然是对的、只是长一点或大一点。反过来编一个 `start`/`end`
 * 出来，就会在用户点「再行调律」时悄悄裁掉一段他的素材——一个不报错的错误答案。
 *
 * ## 粒度：**每一项自己站得住，坏的那一项单独丢**
 *
 * 从前这里只认 `trim`，而且是「整块宽容」——`trim` 认不出来就返回 `undefined`，
 * 把整个 `options` 丢掉。参数只有一项时那是对的（没有别的可丢），
 * 但多了 `size` / `image` 之后它会变成一个**静默丢参数**的洞：
 * 一条只设了目标体积的历史记录，因为压根没有 `trim` 字段而被整条判成「没参数」，
 * 用户点「再行调律」得到的是没有体积限制的那一版，而界面上那行摘要写着「目标体积 9.5 MB」。
 *
 * 现在的粒度是：`trim` / `output` / `filters` 各自独立解析，各自失败各自丢，全丢光才回
 * `undefined`。**每一项内部仍然是全有或全无**——`trim` 的四个字段少一个就整块丢，
 * `mode` 认不出来时尤其不能猜：猜「无损」是照它原本的样子搬码流，猜「精确」是重编码，
 * 两者产出的东西差着画质和几倍的时间。`filters` 是唯一一处**更细**的粒度：
 * 坏的那一步单独丢、其余的照旧留着，理由见 `coerceFilters` 的注释。
 */
function coerceTrim(raw: unknown): TrimOptions | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined

  const row = raw as Record<string, unknown>
  const start = finiteNumber(row.start)
  const end = finiteNumber(row.end)
  if (start === null || end === null || start < 0 || !(end > start)) return undefined
  if (typeof row.mode !== 'string' || !(TRIM_MODES as readonly string[]).includes(row.mode)) {
    return undefined
  }

  return { start, end, mode: row.mode as TrimMode }
}

/** 体积与码率**二选一**，与 `ipc-contract.ts` 的 `outputSchema` 同一条判据 */
function coerceOutput(raw: unknown): OutputOptions | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined

  const row = raw as Record<string, unknown>
  const targetBytes = finiteNumber(row.targetBytes)
  const bitrateKbps = finiteNumber(row.bitrateKbps)
  if ((targetBytes === null) === (bitrateKbps === null)) return undefined

  return targetBytes !== null ? { targetBytes } : { bitrateKbps: bitrateKbps as number }
}

/**
 * 一个 `resize` 动作。`fit` 与 `withoutEnlargement` 都**必须**在，认不出来就丢掉这一步。
 *
 * `withoutEnlargement` 尤其不能猜默认值：猜 `false` 会让「长边 1920」把一张 800px 的图
 * 放大成 1920，猜 `true` 会让本来期望放大的用户拿到一张没变过的图。两者都是
 * 「不报错的错误答案」，所以宁可当作这一步没设过。
 *
 * 宽高至少给一个：都不给的动作不改变任何像素，留着只会让摘要上多出一句
 * 「缩放（未指定尺寸）」，而引擎那边白解一遍码。
 */
function coerceResize(raw: unknown): ResizeAction | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined

  const row = raw as Record<string, unknown>
  if (typeof row.fit !== 'string' || !(IMAGE_FITS as readonly string[]).includes(row.fit)) {
    return undefined
  }
  if (typeof row.withoutEnlargement !== 'boolean') return undefined

  const width = finiteNumber(row.width)
  const height = finiteNumber(row.height)
  if (width === null && height === null) return undefined

  const action: ResizeAction = {
    kind: 'resize',
    fit: row.fit as ImageFit,
    withoutEnlargement: row.withoutEnlargement
  }
  if (width !== null) action.width = width
  if (height !== null) action.height = height
  return action
}

/**
 * `deinterlace` / `denoise` / `rotate`：三个都是「在枚举里挑一档」。
 *
 * 逐 kind 显式构造而不是「按字段名拼一个对象再断言成 FilterAction」：
 * 后者那个 `as` 会**绕过类型检查**，于是字段名或取值写错时 TypeScript 一声不吭，
 * 而运行期拿到的是一条 payload 与 kind 对不上的动作。
 */
function coerceEnumerated(kind: string, raw: Record<string, unknown>): FilterAction | undefined {
  if (kind === 'deinterlace') {
    const method = raw.method
    if (!(DEINTERLACE_METHODS as readonly unknown[]).includes(method)) return undefined
    return { kind: 'deinterlace', method: method as DeinterlaceMethod }
  }
  if (kind === 'denoise') {
    const strength = raw.strength
    if (!(DENOISE_STRENGTHS as readonly unknown[]).includes(strength)) return undefined
    return { kind: 'denoise', strength: strength as DenoiseStrength }
  }
  const degrees = raw.degrees
  if (!(ROTATE_DEGREES as readonly number[]).includes(degrees as number)) return undefined
  return { kind: 'rotate', degrees: degrees as RotateDegree }
}

/** 一个 `sharpen` 动作。`amount` 必须是有限数——`NaN` 拼进滤镜表达式是解析错。 */
function coerceSharpen(raw: Record<string, unknown>): FilterAction | undefined {
  const amount = finiteNumber(raw.amount)
  if (amount === null) return undefined
  return { kind: 'sharpen', amount }
}

/** 一个 `loudnorm` 动作。 */
function coerceLoudnorm(raw: Record<string, unknown>): FilterAction | undefined {
  const targetLufs = finiteNumber(raw.targetLufs)
  if (targetLufs === null) return undefined
  return { kind: 'loudnorm', targetLufs }
}

/**
 * 单个动作。`kind` 认不出来就丢掉这一个。
 *
 * ⚠️ **加新动作时必须在这里加分支**，别写成「不认识就当 resize 试一把」——
 * 那样一个新动作的字段会被拿去喂给 resize 的解析器，解析失败后**整个动作静默消失**，
 * 而用户看到的只是「我设的那一步不见了」。
 */
function coerceAction(raw: unknown): FilterAction | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const row = raw as Record<string, unknown>
  switch (row.kind) {
    case 'resize':
      return coerceResize(raw)
    case 'deinterlace':
    case 'denoise':
    case 'rotate':
      return coerceEnumerated(row.kind, row)
    case 'sharpen':
      return coerceSharpen(row)
    case 'loudnorm':
      return coerceLoudnorm(row)
    default:
      return undefined
  }
}

/**
 * 处理链。**逐个动作宽容**：坏的那一步单独丢，好的照旧留下。
 *
 * 为什么不整条丢：一条链是用户一步步搭出来的，其中一步的字段坏了就让**整条**消失，
 * 意味着他点「再行调律」时拿到的产物与历史里记的那条摘要完全不是一回事。
 * 丢一步、留其余，最坏的结果是「少了锐化」，而不是「什么都没做」。
 *
 * ⚠️ **不去重、不排序**：数组顺序就是执行顺序（见 `@shared/types` 的 `FilterAction`），
 * 在这里动一下顺序就是静默换一个结果。
 *
 * 全丢光时返回 `undefined`（而不是空数组）——「没有处理链」只有一种表示。
 */
function coerceFilters(raw: unknown): FilterAction[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const actions = raw
    .map(coerceAction)
    .filter((action): action is FilterAction => action !== undefined)
  return actions.length > 0 ? actions : undefined
}

function coerceOptions(raw: unknown): TaskOptions | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined

  const row = raw as Record<string, unknown>
  const next: TaskOptions = {}
  const trim = coerceTrim(row.trim)
  if (trim) next.trim = trim
  const output = coerceOutput(row.output)
  if (output) next.output = output
  const filters = coerceFilters(row.filters)
  if (filters) next.filters = filters

  return Object.keys(next).length > 0 ? next : undefined
}

/**
 * 一行原始数据 → 一条历史记录。认不出来就返回 `null`（丢掉这一条，不丢整份文件）。
 *
 * 门槛定在**四个字段**：`id` / `inputPath` / `finishedAt` / `status`。
 * 少了其中任何一个，这条记录就既定位不到、也说不清结局，留着只会在界面上
 * 露出一片空白。其余字段分成三档处理：
 *
 * - **能从 `inputPath` 推出来的**（`inputName` / `fromExt`）就地推，推不出才算坏；
 * - **枚举类的**（`category` / `engine`）存的值合法就用，不合法试着从扩展名推，
 *   再推不出就丢条目——`category` 是六选一的枚举，编一个出来就是让界面显示假信息；
 * - **纯展示字段**（`toExt` / `sizeBytes` / `error` / `outputPath` / `startedAt`）
 *   类型不对就当没有，绝不因为一个字段脏而丢掉整条。
 */
function coerceEntry(raw: unknown): HistoryEntry | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const row = raw as Record<string, unknown>

  const id = nonEmptyString(row.id)
  const inputPath = nonEmptyString(row.inputPath)
  const finishedAt = finiteNumber(row.finishedAt)
  if (id === null || inputPath === null || finishedAt === null) return null
  if (!isStatus(row.status)) return null

  const fromExt = nonEmptyString(row.fromExt) ?? extOf(inputPath)
  const category = isCategory(row.category) ? row.category : categoryOf(fromExt)
  if (category === null) return null

  const toExt = typeof row.toExt === 'string' ? row.toExt : ''

  const entry: HistoryEntry = {
    id,
    inputPath,
    inputName: nonEmptyString(row.inputName) ?? baseNameOf(inputPath),
    category,
    fromExt,
    toExt,
    // 引擎只影响展示、不参与任何调度，所以这里可以兜底；真正的裁决者是 formats.ts
    engine: isEngine(row.engine) ? row.engine : (engineFor(fromExt, toExt) ?? 'ffmpeg'),
    status: row.status as HistoryStatus,
    // createdAt 缺失时用 finishedAt 顶——排序与展示都够用，不值得为此丢一条
    createdAt: finiteNumber(row.createdAt) ?? finishedAt,
    finishedAt
  }

  const outputPath = nonEmptyString(row.outputPath)
  if (outputPath !== null) entry.outputPath = outputPath

  const sizeBytes = finiteNumber(row.sizeBytes)
  if (sizeBytes !== null) entry.sizeBytes = sizeBytes

  const startedAt = finiteNumber(row.startedAt)
  if (startedAt !== null) entry.startedAt = startedAt

  // 只可能是 summarize 过的一行；`logTail` 那个字段从来不进历史文件
  const error = nonEmptyString(row.error)
  if (error !== null) entry.error = error

  // 丢的是「当初用了什么参数」，不丢这条记录本身——理由见 coerceOptions 的注释
  const options = coerceOptions(row.options)
  if (options !== undefined) entry.options = options

  return entry
}

/**
 * 磁盘上的原始 JSON → 历史列表。**返回 `null` 表示这份数据不可用**（退回初始值）。
 *
 * 按 `jsonStore` 的约定，这里**不抛异常**：一份被手改坏的历史绝不该有让应用起不来的权力。
 * 信封读不动（不是对象、`entries` 不是数组）就整份作废；信封没坏但里面有脏行，
 * 就逐行收敛、坏的丢、好的留——丢一行用户还能看见其余 499 行，丢整份就什么都看不见了。
 *
 * 导出它是为了让这条收敛逻辑能脱离 electron 直接测（纯函数，`parse` 只吃一个 unknown）。
 */
export function parseHistoryFile(raw: unknown): HistoryEntry[] | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null

  const rows = (raw as { entries?: unknown }).entries
  if (!Array.isArray(rows)) return null

  const seen = new Set<string>()
  const valid: HistoryEntry[] = []
  for (const row of rows) {
    const entry = coerceEntry(row)
    if (entry === null) continue
    // 同一个 id 只留一条。手改过的文件里出现重复 id 是常事，
    // 而界面上两行同 id 会让「删除」和 React 的 key 双双失准。
    if (seen.has(entry.id)) continue
    seen.add(entry.id)
    valid.push(entry)
  }

  // 新→旧。排序而不是信任磁盘顺序：文件可能被手改过，而我们对外承诺的是「已排序」。
  valid.sort((a, b) => b.finishedAt - a.finishedAt)
  return prune(valid)
}

/* ------------------------------------------------------------ 落盘 */

let store: JsonStore<HistoryEntry[]> | null = null

/**
 * 懒创建，**不在模块顶层建**。
 *
 * 顶层建会在 `import` 的那一刻就去读路径环境（`appPaths()`，原先直接是
 * `app.getPath('userData')`），于是这个模块变得必须活在 Electron 里——而
 * `parseHistoryFile` 是纯函数，本该能脱离窗口直接测。M3 之后还多了一层硬约束：
 * 路径是**注入**的，注入点在入口的模块体里，比任何被 import 的模块都晚，
 * 加载期读它必然抛「路径环境未初始化」。
 */
function historyStore(): JsonStore<HistoryEntry[]> {
  store ??= createJsonStore<HistoryEntry[]>({
    file: join(appPaths().userData, 'history.json'),
    parse: parseHistoryFile,
    serialize: (entries) => ({ version: FILE_VERSION, entries }),
    initial: () => []
  })
  return store
}

/**
 * 同步读一次盘。**要在 `app.whenReady()` 里、`createWindow()` 之前调**。
 *
 * 早了没有 `userData` 路径，晚了会留下一个竞态窗口：窗口一挂载就发 `history:list`，
 * 而那次调用可能赶在第一次读盘之前，界面于是先闪一下空列表再被填满。
 */
export function loadHistorySync(): void {
  historyStore().loadSync()
}

/**
 * 立即落盘。挂在 `before-quit` 上。
 *
 * 没建过 store 就什么都不做——那说明这一轮根本没写过历史，
 * 没必要为了 flush 一次反而去读一遍盘。
 */
export function flushHistorySync(): void {
  store?.flushSync()
}

/**
 * 收一条终态任务进历史。由 `task.ts` 的四个终态位点调用。
 *
 * **按 id 去重，但要换掉旧的那条，而不是把新的丢掉。**
 *
 * 去重本身是刻意的：这个设计最怕的失效模式就是同一个任务反复入库（早期想法是挂在
 * `mark()` 上，那会让每一条进度更新都写一次历史）。这里是 `filter` 掉同 id 再插入，
 * 「同一个 id 只有一条」这个不变量照样成立。
 *
 * 之所以不能简单地「见 id 就 return」：**一个任务可以有第二段生命周期**。
 *   - 已成/失败/取消的行，用户把目标格式改一下再跑（`setTarget` 会把它放回 queued）
 *   - 失败或取消的行点「再行调律」（`retry` 就是 `start`，**复用同一个 id**）
 * 这两条路第二次走到终态时，`archive()` 送来的还是同一个 id。旧写法会把它整条吞掉，
 * 于是历史永远停在第一次的结果上：状态是旧的、`toExt` 是旧的、`outputPath` 指向一个
 * 早就不存在的产物，而刚刚成功的那次转换在历史里根本查不到。
 *
 * 新的排在最前（新→旧），超上限从尾部丢——尾部就是最旧的那几条。
 */
export function appendHistory(entry: HistoryEntry): void {
  const target = historyStore()
  const existing = target.get()
  const rest = existing.filter((item) => item.id !== entry.id)

  target.set(prune([entry, ...rest]))
}

export function listHistory(): HistoryEntry[] {
  // 返回副本：把内部数组直接交出去，调用方（或 IPC 序列化路径上的任何一处）
  // 就地排序/删除都会悄悄改掉真相源
  return [...historyStore().get()]
}

/** 清空并返回删了几条——UI 要拿这个数字说「已抹去 N 条痕迹」 */
export function clearHistory(): number {
  const target = historyStore()
  const removed = target.get().length
  target.set([])
  return removed
}

/** 返回是否真的删掉了。删不存在的 id 时**不要**标脏，否则会平白写一次盘 */
export function removeHistory(id: string): boolean {
  const target = historyStore()
  const entries = target.get()
  const next = entries.filter((entry) => entry.id !== id)
  if (next.length === entries.length) return false
  target.set(next)
  return true
}

export function getHistory(id: string): HistoryEntry | null {
  return (
    historyStore()
      .get()
      .find((entry) => entry.id === id) ?? null
  )
}
