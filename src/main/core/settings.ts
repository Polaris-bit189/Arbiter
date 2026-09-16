import { join } from 'path'
import { cpus } from 'os'
import { settingsSchema } from '@shared/ipc-contract'
import { DEFAULT_AFTER_CONVERT } from '@shared/types'
import type { Settings } from '@shared/types'
import { appPaths } from './appPaths'
import { createJsonStore, type JsonStore, type JsonStoreCorruption } from './jsonStore'

/**
 * 设置：内存里一份给主进程同步读，磁盘上一份负责跨重启活着。
 *
 * 内存那份是承重的——入队裁决目标格式、解析输出名、读并发上限全在同步路径上，
 * 不能每次去碰盘。磁盘那份只是它的影子，写走 `jsonStore` 的 500ms 合并 + 原子替换。
 *
 * 两个必须在启动 / 退出时各调一次的钩子：
 *   - `loadSettingsSync()`  —— `app.whenReady()` 里、`createWindow()` **之前**
 *   - `flushSettingsSync()`  —— `before-quit` 里（异步写在进程退出来不及完成）
 */

/** 默认并发上限：留一个核给 UI，否则第 5 个任务开始时界面会明显卡顿 */
export const AUTO_CONCURRENCY = Math.min(4, Math.max(1, cpus().length - 1))

function defaults(): Settings {
  return {
    outputDir: null,
    outputBesideSource: true,
    onConflict: 'rename',
    maxConcurrent: AUTO_CONCURRENCY,
    // 空对象 = 六个类别都用 defaultTargetFor() 的内建偏好。
    // 这里是「用户改过哪些」而不是「生效值是什么」——生效值由 resolveDefaultTarget() 逐条算。
    defaultTargets: {},
    engineDir: join(appPaths().userData, 'engines'),
    skipTasksNeedingDownload: false,
    // GPU 编码默认**关**。它不是无条件的加速（实测难编的内容净赚、好编的反而更慢），
    // 所以不能替用户做主。数字见 docs/NOTES.md 约束 22。
    hardwareEncode: false,
    // 右键菜单默认**关**。理由不是效果存疑，而是它会往注册表里写东西——
    // 用户没做过任何选择就被改了文件关联，正是 M8 那句「会变成用户投诉的来源」。
    contextMenu: false,
    // 重命名即转换默认**关**，而且是**双重关**：开关关着 + 目录白名单是空的。
    // 这不是谨慎过头——它是这条功能唯一的验收判据「默认关闭状态下零副作用」的
    // 实现方式：关着的时候一个监听器都不装，我们对用户的磁盘完全无感。
    renameConvert: false,
    renameConvertDirs: [],
    // 转换完成之后默认**什么都不做**。自动往剪贴板里写会覆盖用户手里的内容，
    // 而且事后极难归因，所以这一档必须由用户显式打开（见 DEFAULT_AFTER_CONVERT）。
    afterConvert: DEFAULT_AFTER_CONVERT,
    // 「发送到」默认**关**：它要在用户目录下放一个 .lnk，与右键菜单同一条规矩——
    // 用户没做过任何选择之前，我们不动他的环境。
    sendTo: false
  }
}

/**
 * 磁盘上那份 JSON → `Settings`。返回 `null` 表示这份数据整体不可用，
 * 由 `jsonStore` 退回 `defaults()`；**不抛异常**——一个读不动的配置文件
 * 绝不该有让整个应用起不来的权力。
 *
 * 用 `settingsSchema` 而**不是** `settingsPatchSchema`：后者的 `.strict()` 是用来
 * 挡渲染进程送来的脏 patch 的，拿它读自己写的文件，磁盘上残留的一个旧字段
 * （比如已删除的 `theme`）就会让 `safeParse` 整体失败，后果是「设置全没了」
 * 而没有任何提示。读自己的文件和收别人的输入，信任级别不同，所以是两份 schema。
 *
 * 单个字段坏掉**不走**「整份丢弃」那条路：`settingsSchema` 给每个字段挂了
 * `.catch(undefined)`，坏字段自己变成 `undefined`，由下面逐个用 `defaults()` 接住。
 * 否则用户会为了一个手改坏的值赔上其余六项。
 */
function parseSettings(raw: unknown): Settings | null {
  const parsed = settingsSchema.safeParse(raw)
  if (!parsed.success) return null

  const base = defaults()
  const file = parsed.data

  return {
    // 布尔字段用 `??` 是安全的：`false` 是合法值，只有真正的 `undefined` 会被换掉。
    // 写成 `||` 就会把用户选过的 `false` 悄悄改回 `true`——一个静默回退。
    // 「有没有设过指定目录」只能看 outputDir 是不是 null，所以那一项单独判 undefined。
    outputDir: file.outputDir === undefined ? base.outputDir : file.outputDir,
    outputBesideSource: file.outputBesideSource ?? base.outputBesideSource,
    onConflict: file.onConflict ?? base.onConflict,
    maxConcurrent: file.maxConcurrent ?? base.maxConcurrent,
    defaultTargets: file.defaultTargets ?? base.defaultTargets,
    engineDir: file.engineDir ?? base.engineDir,
    skipTasksNeedingDownload: file.skipTasksNeedingDownload ?? base.skipTasksNeedingDownload,
    hardwareEncode: file.hardwareEncode ?? base.hardwareEncode,
    contextMenu: file.contextMenu ?? base.contextMenu,
    renameConvert: file.renameConvert ?? base.renameConvert,
    renameConvertDirs: file.renameConvertDirs ?? base.renameConvertDirs,
    afterConvert: file.afterConvert ?? base.afterConvert,
    sendTo: file.sendTo ?? base.sendTo
  }
}

/**
 * 存储实例**惰性创建**，不在模块加载期就建出来。
 *
 * 这里改过一次方向：原先是「路径在加载期就算好」，前提是模块加载期
 * `app.getPath('userData')` 已经可用。M3 之后那个前提没了——路径改由
 * `core/appPaths.ts` **注入**，而注入发生在各入口的模块体里（`src/main/index.ts` 的
 * `setAppPaths(...)`），必然晚于任何被它 import 的模块的加载。若还在加载期读
 * `appPaths()`，`src/main/index.ts` 一启动就会抛「路径环境未初始化」。
 *
 * 也没有走「给 `createJsonStore` 开 `file: () => string`」那条路：惰性建整个 store
 * 顺带保证了 `defaults()`（它同样要读路径）也发生在注入之后，而只惰性化一个 file
 * 就会留下「engineDir 的默认值仍在加载期算」这个半截状态。
 * `core/history.ts` 早已出于同类理由用了同一手法。
 */
let store: JsonStore<Settings> | null = null

function settingsStore(): JsonStore<Settings> {
  return (store ??= createJsonStore<Settings>({
    file: join(appPaths().userData, 'settings.json'),
    parse: parseSettings,
    // 版本号信封加在这一层。它现在只是个便于人眼确认的标记：读的那侧对未知字段
    // 一律忽略，所以将来加字段不必靠它做迁移分支。
    serialize: (value) => ({ version: 1, ...value }),
    initial: defaults
  }))
}

/** 启动时同步读一次。必须在 `createWindow()` 之前，否则第一个 IPC 会撞上竞态 */
export function loadSettingsSync(): void {
  settingsStore().loadSync()
}

/** 退出前同步落盘。**全项目唯一该用同步 IO 的地方**，见 jsonStore.flushSync */
export function flushSettingsSync(): void {
  settingsStore().flushSync()
}

/**
 * 「这一次启动时 `settings.json` 读不出可用数据」的留档信息；没坏过就是 `null`。
 *
 * 为什么需要它：`jsonStore` 那边只能 `console.error`，而**打包后的 GUI 里没有终端**，
 * 用户看到的只是「我的设置全回到默认值了」，且那次变更之后原文件就被覆盖了。
 * 现在数据这一半已经安全（坏文件被改名留档成 `settings.json.corrupt-<时间戳>`），
 * 这个出口是给**界面**那一半用的。
 *
 * ⚠️ **目前没有任何调用者**（`npm run lint` 不会报，因为它是 export）。要把它送到界面上，
 * 得动两处**不在本次改动范围内**的文件，二选一：
 *   - 给 `Settings` 加一个只读字段（`shared/types.ts` + `ipc-contract.ts` 的两份 schema
 *     —— 注意 `settingsPatchSchema` 是 `.strict()` 的，加字段要一并处理，否则渲染层
 *     回送整份设置时会被拒）；
 *   - 或者单加一条 `settings:corruption` 通道（`shared/channels.ts` + `ipc/settings.ts` +
 *     preload + 设置页），这样既有的 `Settings` 形状一个字都不用动——**推荐这条**，
 *     理由是它与 `integration:get` 那条「意图 vs 实际状态」的通道是同一个形状。
 * 两条路都超出「只改这几个文件」的范围，所以留在这里，交给主线接线。
 */
export function getSettingsCorruption(): JsonStoreCorruption | null {
  // `get()` 先补一次 loadSync（调用方忘了调 loadSync 时），否则这里会稳定返回 null
  // 而看起来像「一切正常」——那正是本条要防的静默。
  const store = settingsStore()
  store.get()
  return store.lastCorruption()
}

export function getSettings(): Settings {
  // 必须返回副本：把内部对象交出去，调用方就地改一个字段就会绕过 store.set，
  // 结果是一份只活在内存里、永远不落盘的设置。
  return { ...settingsStore().get() }
}

/**
 * 浅合并。
 *
 * ⚠️ 浅的语义是**承重**的：`defaultTargets` 是一整个对象，patch 里带上它就会
 * 整体替换掉旧值。渲染层提交单个类别时必须自己展开旧值 —— 见
 * `renderer/src/store/useSettings.ts` 的 `setCategoryTarget()`，
 * 那是唯一一处做这件事的地方。
 */
export function updateSettings(patch: Partial<Settings>): Settings {
  const merged = { ...settingsStore().get(), ...patch }
  settingsStore().set(merged)
  return { ...merged }
}

/*
 * 这里曾经有一个 `onSettingsChanged(fn)` 订阅口，全仓零调用者，已删除。
 *
 * 不补一个使用者是因为没有这个需求：
 *   - 改设置的唯一入口是 `settings:set`，它本来就把新的 `Settings` 当返回值
 *     交给渲染层，不需要再推一次；
 *   - 主进程侧真正读设置的三个地方（并发上限、输出目录、冲突策略）全是
 *     **每次现取** `getSettings()`，不缓存任何一份副本，也就无所谓「变了要通知我」。
 * 将来真出现「有状态的东西必须跟着设置走」，再加也不迟——但那时它会有一行
 * 明确的调用者，而不是一个空转的订阅表。
 */

/** 任务实际该写到哪个目录 */
export function outputDirFor(inputPath: string): string {
  const current = settingsStore().get()
  // 两个条件缺一不可：没设过目录时（outputDir 为 null）即使 outputBesideSource
  // 是 false 也落到源文件旁边，否则会写出到空路径上。
  if (current.outputDir && !current.outputBesideSource) return current.outputDir
  const normalized = inputPath.replace(/\\/g, '/')
  const slash = normalized.lastIndexOf('/')
  return slash > 0 ? inputPath.slice(0, slash) : appPaths().downloads
}
