import { z } from 'zod'
// 类型导入会被完全擦除，不会把 types.ts 拖成运行时依赖
import type { AfterConvertAction, Category, TaskProgress, TaskStatus } from './types'
// 这几个是**运行时**常量（不是类型），所以走值导入
import {
  AFTER_CONVERT_ACTIONS,
  CATEGORIES,
  DEINTERLACE_METHODS,
  DENOISE_STRENGTHS,
  ENGINE_KEYS,
  IMAGE_FITS,
  MAX_SHARPEN,
  MAX_TARGET_LUFS,
  MIN_SHARPEN,
  MIN_TARGET_LUFS,
  ROTATE_DEGREES,
  TRIM_MODES
} from './types'
// 裁剪时间的上界。与界面共用同一个数，理由见 shared/trim.ts
import { MAX_TRIM_SEC } from './trim'
// 新参数的限额。**与界面共用同一个数**，理由同上：两边各写一个上限的表现是
// 「界面放行了主进程会拒掉的值」——点了应用什么都不发生，而界面上一个字都不提示。
import {
  MAX_BITRATE_KBPS,
  MAX_FILTER_ACTIONS,
  MAX_IMAGE_DIM,
  MAX_TARGET_BYTES,
  MIN_BITRATE_KBPS,
  MIN_IMAGE_DIM,
  MIN_TARGET_BYTES
} from './options'

export { CH, type ChannelName } from './channels'

/* ------------------------------------------------------------------ 校验 */

/**
 * 渲染进程送来的一切都当作不可信输入。
 * 即使前端已经过滤过一遍，主进程仍要独立校验——renderer 是被攻击面。
 */

/** Windows 绝对路径：盘符 + 分隔符，或 UNC。两者都不会被当成命令行选项。 */
const WINDOWS_ABS_PATH = /^[a-zA-Z]:[\\/]|^\\\\/

export const absPathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine((p) => WINDOWS_ABS_PATH.test(p), { message: '必须是绝对路径' })

export const idSchema = z.string().min(1).max(64)

export const idListSchema = z.array(idSchema).max(1000)

/** 扩展名：小写字母数字，不含点。限定长度以杜绝把奇怪东西塞进文件名。 */
export const extSchema = z
  .string()
  .min(1)
  .max(8)
  .regex(/^[a-z0-9]+$/, { message: '扩展名只能是字母数字' })

export const addPathsSchema = z.array(absPathSchema).min(1).max(500)

export const setTargetSchema = z.object({ id: idSchema, toExt: extSchema })

/**
 * 裁剪参数。**渲染进程送来的一切都当作不可信输入**，而这一份尤其要紧——
 * 它的每一个数都会变成传给 ffmpeg 的命令行参数（`-ss` / `-t`）：
 *
 * - `.finite()` 是承重的。`z.number()` 放行 `NaN` / `Infinity`，而它们进了
 *   `String(value)` 之后是字面量 `NaN` / `Infinity`，ffmpeg 会拿它当**文件名**去解析，
 *   报一句与裁剪毫无关系的错。
 *   ⚠️ **别指望这两个值在半路上被丢掉**：IPC 搬的是**结构化克隆**（`NaN` / `Infinity`
 *   都在它的可克隆值里），JSON 那条「序列化时就没了」的隐性保护在这儿不成立。
 *   （这一句是**规范层面**的判断，没有在本项目的 Electron 里实测过一次真往返；
 *   但「一个非法值真的能走到 handler」这件事是实测过的——`scripts/test-tasks.ts`
 *   的 [16] 直接把 `NaN` 喂给 handler，`z.number()` 收得下它，`.finite()` 才是拦它的那一道。）
 * - `end > start` 必须由 schema 裁决：等量的 `-t 0`（或负数）会让 ffmpeg
 *   正常退出（退出码 0）却产出一个**没有内容的空文件**，而任务会报「已成」。
 * - `.strict()`：多给一个键是调用方写错了（多半是字段名拼错成 `from`），
 *   静默忽略的话现象是「参数设了没生效」，两端都查不出原因。
 */
export const trimSchema = z
  .object({
    start: z.number().finite().min(0).max(MAX_TRIM_SEC),
    end: z.number().finite().min(0).max(MAX_TRIM_SEC),
    mode: z.enum(TRIM_MODES)
  })
  .strict()
  // 闭开区间 `[start, end)`：零长度不是一次裁剪，是一个错误答案
  .refine((value) => value.end > value.start, { message: '终点必须大于起点' })

/**
 * 输出体积 / 码率目标。与 `trimSchema` 同一套理由（`.finite()` 挡 `NaN`/`Infinity`、
 * `.strict()` 挡拼错的键名），另有两条是这一份独有的：
 *
 * - **必须是整数**（`.int()`）。`targetBytes` 会变成 `-b:v` 的分子、`bitrateKbps` 直接
 *   拼进命令行，一个小数在这里没有任何意义——而它不会报错，只会被 ffmpeg 四舍五入。
 * - **两个字段二选一**，用 `.refine` 裁决而不是让下游判。两个都给的时候下游必须先猜
 *   哪个优先，而猜错的表现是「用户填了 10 MB，出来是 30 MB」；一个都不给则是
 *   「参数设了没生效」。两种都不该由引擎去兜。
 */
export const outputSchema = z
  .object({
    targetBytes: z.number().int().finite().min(MIN_TARGET_BYTES).max(MAX_TARGET_BYTES).optional(),
    bitrateKbps: z.number().int().finite().min(MIN_BITRATE_KBPS).max(MAX_BITRATE_KBPS).optional()
  })
  .strict()
  .refine((value) => (value.targetBytes === undefined) !== (value.bitrateKbps === undefined), {
    message: '目标体积与目标码率必须二选一'
  })

/**
 * 处理链里的一个动作：缩放到指定尺寸。
 *
 * - **判别键 `kind` 是 `z.literal('resize')`**，不是 `z.string()`。写宽了的话，
 *   「这一串到底是不是一个 resize 动作」就答不上来，校验会退化成「看它有没有 `width`」——
 *   而拼错一个字段名（`widht`）在那种判据下是**静默通过**的。
 *   ⚠️ zod 的判别式联合还要求每个成员都是 `z.object`（不能是 `ZodEffects`），
 *   所以下面这条 `.refine()` **在成员自己身上**，不在联合上——这是它长得有点绕的原因。
 * - `fit` 与 `withoutEnlargement` **都是必填**，刻意不给默认值。
 *   `withoutEnlargement` 尤其不能省：sharp 自己的默认是「放大」，而省略即取错的默认值
 *   意味着「长边 1920」会把一张 800px 的图拉大成 1920——画质平白劣化一次，且不报错。
 *   必填之后，省略它是一个 schema 错误，而不是一个静默的错误结果。
 * - **宽高至少给一个**：都不给的动作不改变任何像素，是一个空转。体积目标不在这里，
 *   它是 `output.targetBytes`（那是编码约束，不是处理步骤，见 `@shared/types`）。
 */
export const resizeActionSchema = z
  .object({
    kind: z.literal('resize'),
    width: z.number().int().finite().min(MIN_IMAGE_DIM).max(MAX_IMAGE_DIM).optional(),
    height: z.number().int().finite().min(MIN_IMAGE_DIM).max(MAX_IMAGE_DIM).optional(),
    fit: z.enum(IMAGE_FITS),
    withoutEnlargement: z.boolean()
  })
  .strict()
  .refine((value) => value.width !== undefined || value.height !== undefined, {
    message: '缩放的宽高至少要给一个'
  })

/**
 * 处理链里的一个动作。**判别式联合**——加新动作时往这个数组里加一个成员。
 *
 * 用联合而不是「一个带一堆可选字段的对象」，是为了让「这一步是什么」是个**闭集**：
 * 后者没法回答「这个动作到底算不算合法」，校验只能退化成「看它带了哪些字段」，
 * 而那种判据对拼错的字段名是静默的。
 */
export const deinterlaceActionSchema = z
  .object({
    kind: z.literal('deinterlace'),
    method: z.enum(DEINTERLACE_METHODS)
  })
  .strict()

export const denoiseActionSchema = z
  .object({
    kind: z.literal('denoise'),
    strength: z.enum(DENOISE_STRENGTHS)
  })
  .strict()

/**
 * `amount` 必须有限且落在区间内。`NaN` / `Infinity` 在这里尤其危险：
 * 它们会被拼进 `-vf unsharp=…` 那串滤镜表达式，而 ffmpeg **不报「参数非法」**，
 * 它报一句与滤镜毫无关系的解析错（那个字符串整体是个语法）。
 */
export const sharpenActionSchema = z
  .object({
    kind: z.literal('sharpen'),
    amount: z.number().finite().min(MIN_SHARPEN).max(MAX_SHARPEN)
  })
  .strict()

export const loudnormActionSchema = z
  .object({
    kind: z.literal('loudnorm'),
    targetLufs: z.number().finite().min(MIN_TARGET_LUFS).max(MAX_TARGET_LUFS)
  })
  .strict()

export const rotateActionSchema = z
  .object({
    kind: z.literal('rotate'),
    // ⚠️ 判据挂在那份**唯一的**常量清单上（`ROTATE_DEGREES`），不是就地写三个字面量：
    // 两边各写一份的表现是「界面上选得出来的某一档，schema 不认」。
    //
    // ⚠️ **不能用 `z.number().refine(…)数组.includes`**：`.refine` 只做运行时校验，
    // **不窄化推断出来的类型**——于是解析结果的 `degrees` 是 `number`，
    // 而 `RotateDegree` 是 `90 | 180 | 270`，两侧就对不上了（实测：`ipc/tasks.ts`
    // 把 parse 结果交给 `setOptions` 时编译不过）。`z.literal(数组)` 既认那份常量，
    // 又能推出字面量联合。
    degrees: z.literal(ROTATE_DEGREES)
  })
  .strict()

export const filterActionSchema = z.discriminatedUnion('kind', [
  resizeActionSchema,
  deinterlaceActionSchema,
  denoiseActionSchema,
  sharpenActionSchema,
  loudnormActionSchema,
  rotateActionSchema
])

/**
 * `tasks:setOptions` 的载荷。
 *
 * `options: null` = **清空这条任务的参数**，与「给一个没有任何字段的 TaskOptions」
 * 是同一个意思，两者都收敛到 `undefined`。之所以还留 `null` 这一档：
 * 界面上「清除」是一个明确的动作，用 `{}` 表达它需要调用方知道
 * 「空对象等于没有」，而那是个只有实现者记得住的约定。
 *
 * ⚠️ **`filters` 的顺序就是执行顺序**（见 `@shared/types` 的 `FilterAction`），
 * 数组按原样收下，**不去重、不排序**。长度上限挡住的是「一条必然是算错了的链」。
 *
 * ⚠️ **语义是整体替换，不是逐字段合并**（`TaskManager.setOptions`）。
 * 一份载荷里没提到的字段会被**清掉**，所以界面上的每一块参数面板在「应用」时
 * 必须交出完整的 `TaskOptions`——用 `shared/options.ts` 的 `withOption` 拼，
 * 别各交各的那一个字段（第二块面板会把第一块静默抹掉）。
 * 合并语义看着更「贴心」，但它让「清除某一项」没法表达：省掉一个键与删掉一个键
 * 会长得一模一样。
 */
export const setOptionsSchema = z
  .object({
    id: idSchema,
    options: z
      .object({
        trim: trimSchema.optional(),
        output: outputSchema.optional(),
        filters: z.array(filterActionSchema).max(MAX_FILTER_ACTIONS).optional()
      })
      .strict()
      .nullable()
  })
  .strict()

/**
 * ⚠️ `defaultTargets` 必须用 `partialRecord`，**绝不能用 `record`**。
 *
 * zod 4 把 `z.record(keySchema, valueSchema)` 的语义改成了「**键必须全给**」：
 * `z.record(z.enum(CATEGORIES), extSchema)` 要求六个类别一个不缺。zod 3 里缺键是可选的，
 * 所以这是照着旧写法抄就会踩的坑，**而且两个方向都是静默的**：
 *
 *   - **读盘**：该字段挂着 `.catch(undefined)`，解析失败被吞掉 → 静默退回 `{}`，
 *     用户改过的类别偏好一重启就没了，没有任何提示；
 *   - **收 patch**：`.strict()` 把**整份** patch 拒掉，连一起送来的 `maxConcurrent`
 *     都跟着丢，现象只是「改了没生效」。
 *
 * 实测（zod 4.6.2）：`record` 解 `{}` 与 `{ video: 'mkv' }` 均失败，
 * 报错是五条 `expected string, received undefined`；`partialRecord` 两者均通过，
 * 且推断类型正好是我们要的 `Partial<Record<Category, string>>`。
 */
export const settingsPatchSchema = z
  .object({
    outputDir: z.string().max(4096).nullable().optional(),
    outputBesideSource: z.boolean().optional(),
    onConflict: z.enum(['rename', 'overwrite', 'skip']).optional(),
    maxConcurrent: z.number().int().min(1).max(16).optional(),
    defaultTargets: z.partialRecord(z.enum(CATEGORIES), extSchema).optional(),
    engineDir: z.string().max(4096).optional(),
    skipTasksNeedingDownload: z.boolean().optional(),
    hardwareEncode: z.boolean().optional(),
    contextMenu: z.boolean().optional(),
    renameConvert: z.boolean().optional(),
    renameConvertDirs: z.array(absPathSchema).max(32).optional(),
    afterConvert: z.enum(AFTER_CONVERT_ACTIONS).optional(),
    sendTo: z.boolean().optional()
  })
  .strict()

/**
 * `defaultTargets` 在**读盘**那条路上的逐键宽容。
 *
 * 为什么不能只用 `z.partialRecord(…).catch(undefined)`：`.catch` 的宽容粒度是
 * **整个字段**。字段里任何一个键坏掉（值不是合法扩展名、或键不是已知类别），
 * 六类偏好会**一起**退回内建默认——本文件上方那段注释防的正是「设置全丢而没有
 * 任何提示」，只不过那说的是顶层字段；**一个键坏掉就全丢，是同一个问题下沉了一层**。
 *
 * 触发面很窄：设置页只会写 `targetsForCategory()` 给出的合法值，patch 侧还有
 * `settingsPatchSchema` 的 strict 挡一道。但有一条真实通路——**将来删掉或改名一个
 * 类别**时，用户 `settings.json` 里那个旧键就变成了未知键，于是六类偏好一起清零，
 * 用户只会觉得「我的偏好怎么没了」。
 *
 * 所以这里不做「解析失败就整块丢」，改成**逐键筛**：认得的键 + 合法的值留下，
 * 其余静默剔除（`settingsSchema` 本就不 strict，剥掉未知字段是它的一贯行为）。
 *
 * ⚠️ 不能写成 `extSchema.catch(undefined)` 来逐键兜底：zod 4 里 `.catch()` 的兜底值
 * 必须能被**该 schema 的输出类型**接受，`string` 收不下 `undefined`，实测直接 TS2769。
 *
 * `z.record(z.string(), z.unknown())` 这一层是**必要的**：它负责挡掉非对象输入
 * （数组 / 字符串 / `null` / 数字全部解析失败，于是外层的 `.catch` 接手）。
 * 实测过 `z.record(string, unknown)` / `z.object({}).catchall(unknown)` /
 * `z.looseObject({})` 三者在这件事上行为一致，取第一个是因为它读起来最直白。
 */
const lenientTargets = z.record(z.string(), z.unknown()).transform((raw) => {
  const kept: Partial<Record<Category, string>> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (!(CATEGORIES as readonly string[]).includes(key)) continue
    const ext = extSchema.safeParse(value)
    if (ext.success) kept[key as Category] = ext.data
  }
  return kept
})

/**
 * 「重命名即转换」的目录白名单，**读盘**那一侧的逐条宽容。
 *
 * 与 `lenientTargets` 同一套理由：`.catch` 的宽容粒度是**整个字段**，
 * 而这份列表里一条坏路径（用户手改过、或早先版本写下的相对路径）不该让
 * 他配的其余目录**一起消失**——那正是本文件反复在防的「设置全丢而没有提示」。
 *
 * 逐条筛的好处是**失败朝安全方向**：剔掉一条 = 少监听一个目录，
 * 而整份列表退回 `[]` 也安全（等于不开工），两个方向都不会多监听任何东西。
 */
const lenientDirs = z
  .array(z.unknown())
  .transform((raw) => raw.filter((v): v is string => absPathSchema.safeParse(v).success))
  .catch([])

/**
 * 从**磁盘**读设置时用的 schema。与上面那个的**信任级别不同**，所以是两份。
 *
 * `settingsPatchSchema` 校验的是渲染进程送来的 patch，保持 `.strict()`：
 * 旧渲染层若还在发已经删掉的 `theme`，被拒比被静默忽略好——被拒至少能查。
 *
 * 这一份读的是**我们自己上一版写下的文件**。磁盘上完全可能留着旧版本写的 `theme`，
 * strict 会让 `safeParse` 直接失败，后果是「设置全部回到默认值」而没有任何提示——
 * 用户只会觉得「我的设置怎么没了」。所以这里：不 strict（未知字段被剥掉）、
 * 字段全部可选、且每个字段都挂了 `.catch(undefined)`。
 *
 * **唯一的例外是 `defaultTargets`**：它的宽容粒度是**逐键**而不是整个字段，
 * 走下面的 `lenientTargets`。理由见那个常量自己的注释。
 *
 * 那个 `.catch` 是第二道保险：zod 默认「一个字段坏掉 → 整个对象解析失败」，
 * 于是 `onConflict` 里躺着一个手改坏的值，照样能让其余六项一起陪葬。
 * 挂上 `.catch` 之后坏掉的字段退回 `undefined`，由 `core/settings.ts` 的默认值接住。
 *
 * 字段默认值**刻意不在这里给**：`engineDir` 的默认值依赖 `app.getPath('userData')`，
 * 那是主进程才知道的事，shared 层写不出来。
 */

export const settingsSchema = z.object({
  outputDir: z.string().max(4096).nullable().optional().catch(undefined),
  outputBesideSource: z.boolean().optional().catch(undefined),
  onConflict: z.enum(['rename', 'overwrite', 'skip']).optional().catch(undefined),
  maxConcurrent: z.number().int().min(1).max(16).optional().catch(undefined),
  // 读盘用逐键宽容的 lenientTargets；patch 侧仍是 partialRecord —— 那两个是不同的东西，
  // 理由分别见上方那段长注释与 lenientTargets 自己的注释
  defaultTargets: lenientTargets.optional().catch(undefined),
  engineDir: z.string().max(4096).optional().catch(undefined),
  skipTasksNeedingDownload: z.boolean().optional().catch(undefined),
  hardwareEncode: z.boolean().optional().catch(undefined),
  contextMenu: z.boolean().optional().catch(undefined),
  renameConvert: z.boolean().optional().catch(undefined),
  // 逐条宽容，理由见 lenientDirs 自己的注释
  renameConvertDirs: lenientDirs.optional(),
  afterConvert: z.enum(AFTER_CONVERT_ACTIONS).optional().catch(undefined),
  sendTo: z.boolean().optional().catch(undefined)
})

/** 磁盘上那份设置文件的形状——解读出来的东西，喂给 `defaults()` 兜底 */
export type SettingsFile = z.infer<typeof settingsSchema>

/** `{ id }` 形态的载荷。history 的 remove / reveal / rerun 三处共用 */
export const idPayloadSchema = z.object({ id: idSchema }).strict()

/** `engines:probe` 的载荷。不给 `key` 就是探测全部引擎 */
export const engineProbeSchema = z.object({ key: z.enum(ENGINE_KEYS).optional() }).strict()

/**
 * `engines:install` 的载荷。**key 必填**——「下载全部」不是一个操作：
 * 三个引擎加起来 610 MiB，用户点一下就开始下全部，是这个功能最坏的表现。
 */
export const engineInstallSchema = z.object({ key: z.enum(ENGINE_KEYS) }).strict()

/**
 * `integration:set` 的载荷：**两个入口各给一个可选的布尔**，至少要给一个。
 *
 * 两个开关走同一条通道而不是各开一条，是因为它们本该被一起读（设置页那一段
 * 要一次拿到「右键菜单 + 发送到」两个入口的**实际**状态）。载荷里两个字段都可选，
 * 于是「只翻其中一个开关」这件事在契约上就是明确的，而不是靠调用方自己拼一份完整状态。
 *
 * ⚠️ 一个字段都不给会被拒。空载荷是**调用方写错了**（多半是字段名拼错），
 * 静默返回当前状态的话，现象是「点了开关没反应」，两端都查不出原因。
 */
export const integrationSetSchema = z
  .object({ enabled: z.boolean().optional(), sendTo: z.boolean().optional() })
  .strict()
  .refine((value) => value.enabled !== undefined || value.sendTo !== undefined, {
    message: '至少要给一个开关'
  })

/**
 * 「系统集成」页要展示的状态。
 *
 * `enabled`（设置里的意图）与 `installed`（注册表里的实际）**必须分开**，
 * 不能只给一个布尔：用户手删过注册表键、或把应用装到了另一个目录之后，
 * 两者会分叉，而分叉的表现正是「开关是打开的，右键却没有菜单」——
 * 只给一个布尔的话，这种状态在界面上无法表达，也无法归因。
 */
export interface IntegrationState {
  enabled: boolean
  installed: boolean
  /** 注册表里 `command` 键当前的值 */
  command: string | null
  /** 按当前 exe 路径应该写进去的值 */
  expected: string
  /** reg.exe 自己报的错（没有则为 null） */
  error: string | null

  /* ---- 「发送到」（SendTo）：同一套「意图 / 实际」二分，但完全不写注册表 ---- */

  /** 设置里的意图 */
  sendToEnabled: boolean
  /** `%APPDATA%\…\SendTo\Arbiter.lnk` 实际在不在 */
  sendToInstalled: boolean
  /** 那个 .lnk 的完整路径。**无论装没装都回**：没装时界面要能告诉用户会放到哪儿 */
  sendToPath: string
  /** 快捷方式读写本身的错误（没注入 IO、写盘失败等），没有则为 null */
  sendToError: string | null
}

/**
 * `tasks:afterAction` 的载荷。
 *
 * **只给 id，不给动作。** 动作是设置里那一项，由主进程自己读——让渲染层指定动作
 * 等于把「往剪贴板写什么」交给不可信输入去决定，而这条链路会覆盖用户手里的剪贴板。
 */
export const afterActionSchema = z.object({ id: idSchema }).strict()

/**
 * 一次「转换之后的动作」的结果，回给界面去说清楚**到底做了什么**。
 *
 * `requested` 与 `action` **必须分开**：选的是「复制产物本身」，而产物超过阈值时
 * 实际做的是「复制路径」。只回一个字段的话，那句「已复制路径」在界面上的位置
 * 会与用户的选择对不上，而用户唯一的解释是「设置没生效」。
 */
export interface AfterActionResult {
  ok: boolean
  /** 设置里要求的那一个 */
  requested: AfterConvertAction
  /** 真正执行的那一个（可能因为体积降级而不同） */
  action: AfterConvertAction
  path: string | null
  /** 产物文件名，用于「已复制 XXX」这句话 */
  name: string | null
  sizeBytes: number | null
  /** 降级的原因（没有则为 null）。**必须展示**，否则就是一次静默的行为变更 */
  degradeReason: string | null
  error: string | null
}

/* ------------------------------------------------------- 历史：重跑的载荷 */

/**
 * `history:rerun` 的载荷。
 *
 * `conflict` **缺席时主进程不会入队**：目标位置已经有同名产物的话，它会把这批条目
 * 装进 `RerunResult.conflicts` 回给界面，让用户先明确选一次（覆盖 / 另存）。
 * 这是全项目**唯一**会覆盖用户已有产物的入口，所以「默认不动手」这一条必须是
 * 主进程的硬性行为，而不是界面自觉。
 */
export const historyRerunSchema = z
  .object({
    ids: z.array(idSchema).min(1).max(500),
    conflict: z.enum(['rename', 'overwrite']).optional()
  })
  .strict()

/**
 * 重跑的结果。比 `AddResult` 多两样：
 *
 *  - `conflicts`：目标位置已有同名产物的条目。非空即表示**本次一条都没入队**，
 *    正在等用户在界面上选一次策略。
 *  - `policyChanged`：这次动作顺带改掉了设置里的「同名文件」策略。必须如实回给界面，
 *    否则用户会以为那个设置是自己变的（详见 `main/core/rerun.ts` 里的说明）。
 */
export interface RerunResult {
  added: number
  rejected: { path: string; reason: string }[]
  conflicts: { id: string; inputName: string; outputPath: string }[]
  policyChanged: boolean
}

/* ------------------------------------------------------------------ 推送载荷 */

/** 增量更新。只带变化的字段，避免每个进度 tick 都把整条任务序列化一遍。 */
export interface TaskPatch {
  id: string
  status?: TaskStatus
  progress?: TaskProgress | null
  error?: string | null
  logTail?: string[] | null
  outputPath?: string | null
  sizeBytes?: number | null
  startedAt?: number | null
  finishedAt?: number | null
}

export interface TasksPatchMessage {
  updated: TaskPatch[]
  removed: string[]
}

export interface AddResult {
  added: number
  /** 被拒绝的文件及原因，UI 需要逐条提示，不能静默吞掉 */
  rejected: { path: string; reason: string }[]
}

/** 关于页要展示的版本信息。全仓此前没有任何地方把版本号暴露给渲染层。 */
export interface AppInfo {
  name: string
  version: string
  electron: string
  chrome: string
  node: string
}
