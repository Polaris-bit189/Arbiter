import { useState } from 'react'
import {
  DEFAULT_TARGET_LUFS,
  DEINTERLACE_METHODS,
  DENOISE_STRENGTHS,
  IMAGE_FITS,
  MAX_SHARPEN,
  MAX_TARGET_LUFS,
  MIN_SHARPEN,
  MIN_TARGET_LUFS,
  ROTATE_DEGREES,
  type DeinterlaceMethod,
  type DenoiseStrength,
  type FilterAction,
  type ImageFit,
  type RotateDegree,
  type Task
} from '@shared/types'
import {
  MAX_FILTER_ACTIONS,
  MAX_IMAGE_DIM,
  MIN_IMAGE_DIM,
  canUseAction,
  describeAction,
  withOption
} from '@shared/options'
import { useTasks } from '../../store/useTasks'
import { cn } from '../../lib/cn'
import { CATEGORY_LABEL } from '../../lib/labels'
import { OptionsSection } from './OptionsSection'

/**
 * 处理链那一块（`TaskOptions.filters`）——**链式编辑器**。
 *
 * ## 五件事是这块面板的承重结构
 *
 * 1. **顺序就是执行顺序，所以这块面板的正事是「排」。** 数组按原样提交：不去重、不排序，
 *    任何一处改动都构造一条**新的数组**。`docs/RESEARCH.md` §4.1 钉死了其中最要紧的一段
 *    ——去隔行 → 降噪 → 锐化，反了会把隔行留下的一半行当成细节、把噪点一起锐化出来。
 *    规范次序（`KIND_RANK`）**只决定「刚添加时插在哪」**：链之所以是链，就是因为它可调，
 *    所以上移 / 下移始终可用，规范次序管不着用户的手。
 * 2. **「添加」菜单按 `canUseAction` 过滤**，判据与主进程 `setOptions` 读的是同一个函数。
 *    在界面上藏起来只挡住拖拽与点击，别的入口（MCP、右键菜单参数）绕得过去；
 *    反过来，**不按它过滤**就等于交出一个主进程会整份拒掉的载荷——表现是
 *    「点了应用什么都没发生」，界面上一个字都不提示。
 * 3. **编辑的是草稿，点「应用」才提交。** 不是「每改一下就发一次 IPC」：`setOptions`
 *    每被调用一次都会 `requeue`（状态打回 `queued`、清掉落盘产物与体积），
 *    于是连点三下「上移」会顺手把一条已完成的任务重置三次。一次提交只重置一次。
 * 4. **提交必须走 `withOption(task.options, { filters })`。** `setOptions` 是**整体替换**
 *    语义，写成 `{ filters }` 会把用户的裁剪与输出约束**静默抹掉**，而卡片上那行摘要
 *    会少一半——用户会以为是界面没刷新。
 * 5. **空链与「没有链」是同一个意思**：删光之后交 `undefined`（`withOption` 会替你收口），
 *    不留一个 `filters: []`：两种表示会让「这条任务有没有参数」有两处判断。
 *
 * ## 校验
 *
 * 主进程对非法参数是**静默不办**的（schema 直接拒），而「点了应用什么都没发生」
 * 是这个项目最不能接受的形态，所以这里自己判一次、把按钮禁掉并**说清为什么**
 * （`第 2 步「缩放」：宽高至少填一个`）。判据与 schema 共用同一组常量
 * （`MIN_IMAGE_DIM` / `MIN_SHARPEN` / `MIN_TARGET_LUFS` …），但主进程那一道**照旧独立生效**
 * ——渲染层是不可信输入。三条规矩照 `TrimSection`：用 `Number()` 而不是 `parseFloat()`
 * （后者只解前缀，`'1.5.5'` → `1.5`，用户拿到一个与他输入不一致的参数）、空串单独判
 * （`Number('')` 是 `0` 不是 `NaN`）、先「填了没」再「是不是数」最后才是范围。
 */

/* ------------------------------------------------------------------ 文案与次序 */

/** 三个档位的中文说明。写在数据旁边而不是 JSX 里，是为了让「有几档」只有一处。 */
const FIT_LABEL: Record<ImageFit, string> = {
  inside: '装进框内',
  cover: '裁切填满',
  fill: '拉伸'
}

const FIT_HINT: Record<ImageFit, string> = {
  inside: '保持比例，长边顶到框为止，不裁也不变形（最常用）。',
  cover: '保持比例，填满整个框，多出来的部分裁掉。',
  fill: '拉伸到正好这个尺寸，会变形。'
}

/**
 * 三档降噪的中文名。
 *
 * ⚠️ 与 `shared/options.ts` 里那份 `DENOISE_LABEL` **是同一组词**（`describeAction`
 * 生成摘要时用它，所以两处必须一模一样）。它没有导出，共享不了，只能各写一份——
 * 两边都是 `Record<DenoiseStrength, string>`，加第四档时**两边都会编译不过**。
 */
const DENOISE_LABEL: Record<DenoiseStrength, string> = {
  light: '轻',
  medium: '中',
  strong: '重'
}

type ActionKind = FilterAction['kind']

/** 动作的短名。**与 `describeAction` 的输出不是一回事**：那个是整句摘要（「缩到 1920×1080」），
 *  这里只用来指认「第几步是哪个动作」（菜单项与报错里）。 */
const KIND_LABEL: Record<ActionKind, string> = {
  resize: '缩放',
  deinterlace: '去隔行',
  denoise: '降噪',
  sharpen: '锐化',
  rotate: '旋转',
  loudnorm: '响度归一化'
}

/**
 * 规范次序：**只影响「刚添加时插在哪」**，不限制手动调序。
 *
 * 依据是两组事实，不是审美：
 *
 * - `deinterlace < denoise < sharpen` 是**实测钉死的**（`docs/RESEARCH.md` §4.1：反了会把
 *   隔行留下的一半行当成细节、把噪点一起锐化出来）。这三步的相对次序不能动。
 * - `rotate < resize`：两个都是几何动作，但**旋转会换掉宽高**。`converters/image.ts` 里
 *   那次「EXIF 方向必须先于处理链」的理由写得很清楚——先摆正，随后填的宽高才对得上
 *   用户屏幕上看到的那个方向。用户填 1920×1080 时想的是最终那张图，先转后缩才是那句话
 *   的字面意思（先缩后转的最终画布是 1080×1920）。
 * - `loudnorm` 排在最后：它作用在**音频流**上，与上面几步落在不同的流，次序上无所谓；
 *   排在最后只是让「先画面、后声音」这个读法成立。
 *
 * ⚠️ 这张表是**唯一的真相源**：菜单顺序与插入位置都从它派生（`KIND_ORDER`），
 * 所以「菜单里看到的顺序」与「插进去之后的顺序」不会漂移。
 */
const KIND_RANK: Record<ActionKind, number> = {
  deinterlace: 0,
  denoise: 1,
  sharpen: 2,
  rotate: 3,
  resize: 4,
  loudnorm: 5
}

/** 按规范次序排好的动作清单。菜单按它遍历，插入按它比较。 */
const KIND_ORDER: readonly ActionKind[] = (Object.keys(KIND_RANK) as ActionKind[]).sort(
  (a, b) => KIND_RANK[a] - KIND_RANK[b]
)

/* ------------------------------------------------------------------ 草稿形状 */

/**
 * 草稿里的一步。**与 `FilterAction` 的差别只有一处**：数值字段存的是输入框里的**原文**，
 * 因为「正在输 `1.`」这种中间态是合法的界面状态，而一个 `number` 表达不了它。
 * 真值一律现算（`parse`），**不在这里维护第二份**。
 */
type DraftAction =
  | { kind: 'resize'; width: string; height: string; fit: ImageFit; withoutEnlargement: boolean }
  | { kind: 'deinterlace'; method: DeinterlaceMethod }
  | { kind: 'denoise'; strength: DenoiseStrength }
  | { kind: 'sharpen'; amount: string }
  | { kind: 'loudnorm'; targetLufs: string }
  | { kind: 'rotate'; degrees: RotateDegree }

/**
 * 草稿里的一步 + 一个 React key。`id` **不参与任何语义**，也不会被送进主进程
 * （`filterActionSchema` 是 `.strict()` 的，多一个键整份载荷就被拒）。
 *
 * 为什么不用数组下标当 key：链可以移动、可以在中间删一项，下标 key 会让 React 把
 * 「第 2 步那个 DOM」复用给「原来是第 3 步的那一步」。眼下每一步都没有自己的本地状态，
 * 所以还看不出问题——但这块面板随时可能给某一行加上展开/收起，那时它就会错位。
 */
interface Step {
  id: number
  action: DraftAction
}

/**
 * 给新加进来的一步取一个 key：**从当前草稿里算**（最大 id + 1）。
 *
 * 不用模块级的自增计数器：那种计数器只能在 render 期间自增，而在 render 里改外面的东西
 * 是纯函数禁忌（`react-hooks/globals` 直接报错，而且它确实会在 StrictMode 的双渲染下多跳号）。
 * id 只需要在**这一份草稿里**唯一（React 的 key 只在同一个列表内比较），所以
 * 「删掉最大的那个再新建会重用它的号」完全没关系——那个 key 已经不在列表里了。
 */
function freshId(steps: readonly Step[]): number {
  return steps.reduce((max, step) => Math.max(max, step.id), 0) + 1
}

/**
 * 新动作的初值。三个原则：
 *
 * - **枚举取清单的第一项**（`DEINTERLACE_METHODS` / `DENOISE_STRENGTHS` / `ROTATE_DEGREES`），
 *   不另写一张默认值表——那样加一档时界面会给出一个已经不在清单里的值；
 * - **取代价小的那一侧**：降噪默认最轻的「轻」（降噪对干净的素材是纯损失）、
 *   锐化默认 1（`MIN_SHARPEN`~`MAX_SHARPEN` 里「看得出来」的起点）。
 *   与 NVENC 默认关、降噪默认不进链是同一条纪律：拿不准时取代价小的那个。
 * - **缩放的宽高留空**，不替用户编一个尺寸：编出来的行为是「他一个字没填，链上却写着
 *   缩到 1920」，而那个数字会真的生效。留空时校验会挡住提交并说清要填什么。
 *
 * 返回的是**真正的动作**而不是草稿：菜单的过滤判据 `canUseAction` 的入参就是 `FilterAction`，
 * 拿一个半截草稿去问等于绕开类型去猜判据。草稿形状由 `toDraft()` 转（缩放的两个空格子
 * 就是由「没有宽高」转出来的）。
 */
function defaultAction(kind: ActionKind): FilterAction {
  switch (kind) {
    case 'resize':
      return { kind: 'resize', fit: 'inside', withoutEnlargement: true }
    case 'deinterlace':
      return { kind: 'deinterlace', method: DEINTERLACE_METHODS[0] }
    case 'denoise':
      return { kind: 'denoise', strength: DENOISE_STRENGTHS[0] }
    case 'sharpen':
      return { kind: 'sharpen', amount: 1 }
    case 'loudnorm':
      return { kind: 'loudnorm', targetLufs: DEFAULT_TARGET_LUFS }
    case 'rotate':
      return { kind: 'rotate', degrees: ROTATE_DEGREES[0] }
  }
}

/** 已提交的动作 → 草稿。六个分支都写全：加第七个成员时这里会编译不过。 */
function toDraft(action: FilterAction): DraftAction {
  switch (action.kind) {
    case 'resize':
      return {
        kind: 'resize',
        width: action.width === undefined ? '' : String(action.width),
        height: action.height === undefined ? '' : String(action.height),
        fit: action.fit,
        withoutEnlargement: action.withoutEnlargement
      }
    case 'deinterlace':
      return { kind: 'deinterlace', method: action.method }
    case 'denoise':
      return { kind: 'denoise', strength: action.strength }
    case 'sharpen':
      return { kind: 'sharpen', amount: String(action.amount) }
    case 'loudnorm':
      return { kind: 'loudnorm', targetLufs: String(action.targetLufs) }
    case 'rotate':
      return { kind: 'rotate', degrees: action.degrees }
  }
}

/**
 * 一步草稿 → 真正的动作，或者它哪儿不对。**两件事出自同一遍**。
 *
 * 分开写（一个 `validate` 一个 `build`）的话，「判据说能提交、构造却拿不出动作」会变成
 * 一个没有出口的状态——那种分支最后总是长成一句 `!` 或者一次静默的兜底。所以这里
 * 只有这一个函数，返回值要么是能提交的动作，要么是一句**能直接给用户看**的原因。
 */
type Parsed = { ok: true; action: FilterAction } | { ok: false; issue: string }

function parse(draft: DraftAction): Parsed {
  switch (draft.kind) {
    case 'resize': {
      const width = draft.width.trim()
      const height = draft.height.trim()
      if (width === '' && height === '')
        return { ok: false, issue: '宽高至少填一个（另一个留空则按比例算）' }

      for (const [label, text] of [
        ['宽', width],
        ['高', height]
      ] as const) {
        if (text === '') continue
        const value = Number(text)
        if (!Number.isInteger(value)) return { ok: false, issue: `${label}只能填整数像素` }
        if (value < MIN_IMAGE_DIM)
          return { ok: false, issue: `${label}至少是 ${MIN_IMAGE_DIM} 像素` }
        if (value > MAX_IMAGE_DIM)
          return { ok: false, issue: `${label}不能超过 ${MAX_IMAGE_DIM} 像素` }
      }

      // 逐字段显式构造（不用展开）：`filterActionSchema` 是 `.strict()` 的，
      // 多带一个键整份载荷就被拒，而拒了之后界面上只会看到一句「没能设上」。
      return {
        ok: true,
        action: {
          kind: 'resize',
          ...(width === '' ? {} : { width: Number(width) }),
          ...(height === '' ? {} : { height: Number(height) }),
          fit: draft.fit,
          withoutEnlargement: draft.withoutEnlargement
        }
      }
    }
    case 'sharpen': {
      const text = draft.amount.trim()
      if (text === '') return { ok: false, issue: '锐化强度不能为空' }
      const value = Number(text)
      if (!Number.isFinite(value)) return { ok: false, issue: '只能填数字' }
      if (value < MIN_SHARPEN || value > MAX_SHARPEN) {
        return { ok: false, issue: `锐化强度要在 ${MIN_SHARPEN}~${MAX_SHARPEN} 之间` }
      }
      return { ok: true, action: { kind: 'sharpen', amount: value } }
    }
    case 'loudnorm': {
      const text = draft.targetLufs.trim()
      if (text === '') return { ok: false, issue: '目标响度不能为空' }
      const value = Number(text)
      if (!Number.isFinite(value)) return { ok: false, issue: '只能填数字' }
      if (value < MIN_TARGET_LUFS || value > MAX_TARGET_LUFS) {
        return { ok: false, issue: `目标响度要在 ${MIN_TARGET_LUFS}~${MAX_TARGET_LUFS} LUFS 之间` }
      }
      return { ok: true, action: { kind: 'loudnorm', targetLufs: value } }
    }
    // 枚举型动作没有「填错」这回事：控件里只有清单上那几档，造不出别的值
    case 'deinterlace':
      return { ok: true, action: { kind: 'deinterlace', method: draft.method } }
    case 'denoise':
      return { ok: true, action: { kind: 'denoise', strength: draft.strength } }
    case 'rotate':
      return { ok: true, action: { kind: 'rotate', degrees: draft.degrees } }
  }
}

/**
 * 整条链的校验 + 编译。**`reason` 与要提交的数组出自同一遍**，于是「按钮亮着但提交不了」
 * 与「按钮灰着但链其实是好的」两种状态都不存在。
 *
 * 报错**指名道姓**（`第 2 步「缩放」：宽高至少填一个`）：链上可以有六个一样的动作，
 * 只说一句「参数不合法」等于让用户自己一行行找。
 */
type Compiled = { ok: true; actions: FilterAction[] } | { ok: false; reason: string }

function compile(steps: readonly Step[]): Compiled {
  const actions: FilterAction[] = []
  for (const [index, step] of steps.entries()) {
    const parsed = parse(step.action)
    if (!parsed.ok) {
      return {
        ok: false,
        reason: `第 ${index + 1} 步「${KIND_LABEL[step.action.kind]}」：${parsed.issue}`
      }
    }
    actions.push(parsed.action)
  }
  return { ok: true, actions }
}

/* ------------------------------------------------------------------ 链的改动 */

/**
 * 四种改动都是**纯函数**：构造新的数组、新的对象，绝不就地改。
 *
 * 为什么不能就地改：`task.options.filters` 是 store 里那一份镜像，就地改它等于绕过
 * `setOptions` 去改界面——而链的顺序就是语义，改动只有经主进程才算数。
 *
 * 放在组件外面还有一个原因：这块面板里**唯一有分支的逻辑**就集中在这四个函数里
 * （其余全是 JSX），独立成纯函数之后它们可以脱离 React 逐条对着跑。
 */

/** 换掉第 i 步的参数。`id` **原样保留**：它是 React 的 key，换了会让那一行的 DOM 重建，
 *  表现是「每敲一个字输入框就失焦」。 */
function replaceAt(steps: readonly Step[], index: number, action: DraftAction): Step[] {
  return steps.map((step, i) => (i === index ? { id: step.id, action } : step))
}

/** 上下移一位。越界时**内容原样不动**（两个按钮本来就是禁用的，这里是同一件事的第二道）。 */
function moveStep(steps: readonly Step[], index: number, delta: number): Step[] {
  const to = index + delta
  const next = [...steps]
  if (to < 0 || to >= steps.length) return next
  const [picked] = next.splice(index, 1)
  next.splice(to, 0, picked)
  return next
}

/** 删掉第 i 步。删光之后是空链——**空链与「没有链」是同一个意思**，由 `apply` 收口成 `undefined`。 */
function removeStep(steps: readonly Step[], index: number): Step[] {
  return steps.filter((_, i) => i !== index)
}

/**
 * 按规范次序插入一步。**只决定这一步插在哪**，已有几步的相对次序一个不动。
 *
 * 判据是「第一个次序**比它靠后**的步骤」，插在那一步之前；没有更靠后的（或链是空的）
 * 就追加到末尾。同类之间因此排在**已有的之后**——链是数组，稳定插入（不改变已有步骤的
 * 相对次序）比「插到同类前面」可预期。
 */
function insertByRank(steps: readonly Step[], action: DraftAction): Step[] {
  const at = steps.findIndex((step) => KIND_RANK[step.action.kind] > KIND_RANK[action.kind])
  const index = at < 0 ? steps.length : at
  const next = [...steps]
  next.splice(index, 0, { id: freshId(steps), action })
  return next
}

/* ------------------------------------------------------------------ 样式 */

/** 「几个里挑一个」的按钮。与 `TrimSection` / `OutputSection` 里那几处逐字同款。 */
const PILL = 'rounded-full border px-2.5 py-0.5 text-[11px] transition-colors'
const PILL_ON = 'border-gold bg-raised text-gold-pale'
const PILL_OFF = 'border-line text-fg-muted hover:border-line-2 hover:text-fg'

/**
 * 行内的上移 / 下移 / 删除。尺寸照 `TaskCard` 的 `ACTION_BUTTON`——面板里一行只有一行高，
 * `.btn-*` 那三档 38px 放不下。**禁用态要看得出来**：按钮禁掉而不是让它们消失，
 * 时有时无的按钮会让人以为界面坏了（第一项不能上移、最后一项不能下移，两处都是）。
 */
const ROW_BUTTON =
  'rounded px-1.5 py-0.5 text-[12px] text-fg-muted transition-colors hover:bg-hover hover:text-gold-pale disabled:cursor-not-allowed disabled:opacity-30'

const INPUT =
  'w-20 rounded border border-line bg-canvas px-2 py-1 font-mono text-xs text-fg outline-none focus:border-gold-dim'

function Pill({
  active,
  disabled,
  title,
  onClick,
  children
}: {
  active: boolean
  disabled?: boolean
  title?: string
  onClick: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={cn(PILL, active ? PILL_ON : PILL_OFF, disabled && 'disabled:opacity-30')}
    >
      {children}
    </button>
  )
}

/* ------------------------------------------------------------------ 一行 */

/** 一步的参数编辑器。按 `kind` 分派，六个分支都写全（少一个就编译不过）。 */
function Editor({
  step,
  index,
  onChange
}: {
  step: Step
  index: number
  onChange: (action: DraftAction) => void
}): React.JSX.Element {
  const action = step.action
  const at = (field: string): string => `第 ${index + 1} 步的${field}`

  switch (action.kind) {
    case 'resize': {
      const bothDims = action.width.trim() !== '' && action.height.trim() !== ''
      return (
        <>
          <div className="flex items-center gap-1.5">
            <input
              type="text"
              inputMode="numeric"
              value={action.width}
              aria-label={at('宽度（像素）')}
              placeholder="留空"
              onChange={(e) => onChange({ ...action, width: e.target.value })}
              className={INPUT}
            />
            <span className="text-xs text-fg-faint">宽</span>
            <input
              type="text"
              inputMode="numeric"
              value={action.height}
              aria-label={at('高度（像素）')}
              placeholder="留空"
              onChange={(e) => onChange({ ...action, height: e.target.value })}
              className={INPUT}
            />
            <span className="text-xs text-fg-faint">高</span>

            {/* ⚠️ 默认**开**。sharp 自己的默认是「放大」——「长边 1920」会把一张 800px 的
                图拉大成 1920，体积涨、画质降、用户没要求，而且**不报错**。 */}
            <label className="ml-1 flex items-center gap-1 text-xs text-fg-muted">
              <input
                type="checkbox"
                checked={action.withoutEnlargement}
                onChange={(e) => onChange({ ...action, withoutEnlargement: e.target.checked })}
              />
              不放大
            </label>
          </div>

          <div className="mt-1.5 flex items-center gap-1.5">
            {IMAGE_FITS.map((fit) => (
              <Pill
                key={fit}
                active={action.fit === fit}
                onClick={() => onChange({ ...action, fit })}
              >
                {FIT_LABEL[fit]}
              </Pill>
            ))}
          </div>

          <p className="mt-1.5 text-[11px] leading-relaxed text-fg-faint">
            {bothDims
              ? FIT_HINT[action.fit]
              : '只填一个维度时，另一侧按原比例算；「裁切填满 / 拉伸」只在宽高都填了时才生效。'}
            {action.withoutEnlargement &&
              ' 「不放大」开着时，比目标尺寸小的那一侧保持原样、不会被拉大。'}
          </p>
        </>
      )
    }

    case 'deinterlace':
      return (
        <>
          <div className="flex items-center gap-1.5">
            {DEINTERLACE_METHODS.map((method) => (
              <Pill
                key={method}
                active={action.method === method}
                onClick={() => onChange({ ...action, method })}
              >
                {method}
              </Pill>
            ))}
          </div>
          {/* 「有滤镜」不等于「能用」，也不等于「自动判断得了」——这两句都是实测的结论
              （见 `@shared/types` 的 `DEINTERLACE_METHODS` 与 docs/RESEARCH.md §3）。 */}
          <p className="mt-1.5 text-[11px] leading-relaxed text-fg-faint">
            两档都实测可用。ffmpeg 的自动判断（`idet` / `detelecine`）实测缺失，所以「这段到底
            是不是隔行的」要你自己看着办，拿不准就用 yadif。
          </p>
        </>
      )

    case 'denoise':
      return (
        <>
          <div className="flex items-center gap-1.5">
            {DENOISE_STRENGTHS.map((strength) => (
              <Pill
                key={strength}
                active={action.strength === strength}
                onClick={() => onChange({ ...action, strength })}
              >
                {DENOISE_LABEL[strength]}
              </Pill>
            ))}
          </div>
          <p className="mt-1.5 text-[11px] leading-relaxed text-fg-faint">
            降噪越重越慢、细节也越少。它对**本来干净**的素材是纯损失，所以这一步默认不在链上；
            加了它是有意的取舍，不是「顺手加一个会更好」。
          </p>
        </>
      )

    case 'sharpen':
      return (
        <>
          <div className="flex items-center gap-1.5">
            <input
              type="text"
              inputMode="decimal"
              value={action.amount}
              aria-label={at('锐化强度')}
              onChange={(e) => onChange({ ...action, amount: e.target.value })}
              className={INPUT}
            />
            <span className="text-xs text-fg-faint">强度</span>
          </div>
          <p className="mt-1.5 text-[11px] leading-relaxed text-fg-faint">
            范围 {MIN_SHARPEN}~{MAX_SHARPEN}，1 是「看得出来」的起点。它会把噪点一起放大，
            所以要排在降噪之后（规范次序已经这么排了）。
          </p>
        </>
      )

    case 'loudnorm':
      return (
        <>
          <div className="flex items-center gap-1.5">
            <input
              type="text"
              inputMode="decimal"
              value={action.targetLufs}
              aria-label={at('目标响度')}
              onChange={(e) => onChange({ ...action, targetLufs: e.target.value })}
              className={INPUT}
            />
            <span className="text-xs text-fg-faint">LUFS</span>
          </div>
          <p className="mt-1.5 text-[11px] leading-relaxed text-fg-faint">
            范围 {MIN_TARGET_LUFS}~{MAX_TARGET_LUFS}，默认 {DEFAULT_TARGET_LUFS} LUFS
            （流媒体平台的事实标准）。它作用在**音频流**上，视频文件里的音轨照样能归一化。
          </p>
        </>
      )

    case 'rotate':
      return (
        <>
          <div className="flex items-center gap-1.5">
            {ROTATE_DEGREES.map((degrees) => (
              <Pill
                key={degrees}
                active={action.degrees === degrees}
                onClick={() => onChange({ ...action, degrees })}
              >
                {degrees}°
              </Pill>
            ))}
          </div>
          {/* 与「旋转元数据」划清界限：这条是承重的，见 `@shared/types` 的 `RotateAction` */}
          <p className="mt-1.5 text-[11px] leading-relaxed text-fg-faint">
            这是**真的重排像素**，所以必须重新编码。手机视频里那个记在容器里的旋转标记是另一回事
            ——`-c copy` 会把它原样搬走，有的播放器转、有的不转。
          </p>
        </>
      )
  }
}

/** 链上的一步：序号 + 摘要 + 上移/下移/删除 + 它自己的参数。 */
function StepRow({
  step,
  index,
  count,
  onChange,
  onMove,
  onRemove
}: {
  step: Step
  index: number
  /** 链长，用来判断「最后一项」——两个按钮禁用而不是消失，见 `ROW_BUTTON` */
  count: number
  onChange: (action: DraftAction) => void
  onMove: (delta: number) => void
  onRemove: () => void
}): React.JSX.Element {
  const parsed = parse(step.action)
  // 摘要走 `describeAction`——**与队列卡片、历史页上那一行是同一句话**。数值还没填对时
  // **不编一个数**（「锐化 1」而框里是空的，就是本项目最忌讳的「不报错的错误答案」），
  // 只把动作名摆出来，具体哪儿不对由下面那句校验原因说清。
  const summary = parsed.ok ? describeAction(parsed.action) : `${KIND_LABEL[step.action.kind]} —`

  return (
    <div className="mt-2 rounded border border-line bg-canvas px-2 py-1.5">
      <div className="flex items-center gap-1.5">
        <span className="font-mono text-[11px] tabular-nums text-fg-faint">{index + 1}</span>
        <span className="min-w-0 flex-1 truncate text-xs text-gold-pale" title={summary}>
          {summary}
        </span>
        <button
          type="button"
          title="上移（排在上面的先执行）"
          disabled={index === 0}
          onClick={() => onMove(-1)}
          className={ROW_BUTTON}
        >
          上移
        </button>
        <button
          type="button"
          title="下移"
          disabled={index === count - 1}
          onClick={() => onMove(1)}
          className={ROW_BUTTON}
        >
          下移
        </button>
        <button
          type="button"
          title="从链上删掉这一步"
          onClick={onRemove}
          className={cn(ROW_BUTTON, 'hover:text-bad')}
        >
          删除
        </button>
      </div>

      <div className="mt-1.5">
        <Editor step={step} index={index} onChange={onChange} />
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ 面板 */

export function FiltersSection({ task }: { task: Task }): React.JSX.Element {
  const setOptions = useTasks((s) => s.setOptions)

  // 草稿的初值取自**当前已提交的那条链**，之后只在「应用」时写回去。
  // 本块面板的每一次重渲染都会重跑这个初始化函数，但 `useState` 只认第一次的结果——
  // 应用成功之后 store 里的链变了，草稿不会跟着跳（不然用户刚排好的顺序会被冲掉）。
  const [steps, setSteps] = useState<Step[]>(() =>
    (task.options?.filters ?? []).map((action, index) => ({
      id: index + 1,
      action: toDraft(action)
    }))
  )
  /**
   * 「草稿与已提交的不一样」。
   *
   * 用一个布尔而不是逐字段比对：比对的实现必须把 `parse` 里每一个字段都复述一遍，
   * 而那正是「第二份真相」——将来加一个字段时漏掉一处，表现是**该提示时不提示**。
   * 布尔的方向是安全的：它至多把「改了又改回来」也说成有改动（多提示一次而已），
   * 绝不会把真改动说成没有。
   */
  const [unsaved, setUnsaved] = useState(false)
  const [busy, setBusy] = useState(false)
  /** 上一次「应用」到底成没成。主进程静默不办，所以**必须**有一条回执 */
  const [failed, setFailed] = useState(false)

  const compiled = compile(steps)
  const current = task.options?.filters ?? []

  /**
   * 这一类装得下的动作。**用真实动作去问 `canUseAction`**（判据与主进程读的是同一份），
   * 不造一个半截对象去猜：契约的入参就是 `FilterAction`。
   */
  const addable = KIND_ORDER.filter((kind) => canUseAction(defaultAction(kind), task.category))
  /** 这一类放不下的那些。**从上面的结果派生**，所以不会与判据漂移（不另写一张说明表）。 */
  const hidden = KIND_ORDER.filter((kind) => !addable.includes(kind))
  const atMax = steps.length >= MAX_FILTER_ACTIONS

  // 四种改动都只是「换一条新的数组」——纯逻辑在组件外面（见「链的改动」那一节），
  // 这里只负责把它交给 `setSteps` 并记下「有改动还没提交」。
  const replace = (index: number, action: DraftAction): void => {
    setSteps((prev) => replaceAt(prev, index, action))
    setUnsaved(true)
  }

  /** `delta` 为 ±1。调序是这块面板的正事，所以这里**不动别的任何东西**。 */
  const move = (index: number, delta: number): void => {
    setSteps((prev) => moveStep(prev, index, delta))
    setUnsaved(true)
  }

  const removeAt = (index: number): void => {
    setSteps((prev) => removeStep(prev, index))
    setUnsaved(true)
  }

  const add = (kind: ActionKind): void => {
    if (busy || atMax) return
    setSteps((prev) => insertByRank(prev, toDraft(defaultAction(kind))))
    setUnsaved(true)
  }

  const apply = async (): Promise<void> => {
    if (busy || !compiled.ok) return
    setBusy(true)
    // 空链与「没有链」是同一个意思：交 `undefined`，`withOption` 会把这个键删掉，
    // 于是任务回到「没有参数」——不是留一个 `filters: []`（那会让「有没有参数」
    // 在主进程与界面两边各判一次）。
    const filters = compiled.actions.length > 0 ? compiled.actions : undefined
    // ⚠️ `withOption` 而不是 `{ filters }`：`setOptions` 是**整体替换**语义，
    // 只交这一项的话，用户先前设好的裁剪与输出约束会被这块面板静默抹掉。
    const ok = await setOptions(task.id, withOption(task.options, { filters }) ?? null)
    setBusy(false)
    setFailed(!ok)
    // 主进程没收下时草稿仍是「没提交」的那一份，别把它说成已生效
    setUnsaved(!ok)
  }

  const clear = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    setSteps([])
    await setOptions(task.id, withOption(task.options, { filters: undefined }) ?? null)
    setBusy(false)
    setFailed(false)
    setUnsaved(false)
  }

  return (
    <OptionsSection
      title="处理链（从上到下依次执行）"
      reason={compiled.ok ? null : compiled.reason}
      failedText={failed ? '没能设上——这条任务正在转换中，或这一步不适用于它的类别' : ''}
      busy={busy}
      canClear={current.length > 0}
      onApply={() => void apply()}
      onClear={() => void clear()}
    >
      {/* 提交期间把编辑面冻住（`pointer-events-none`）。`apply` 交出去的是**这一次渲染**
          算出来的 `compiled`，而它是个快照——在这中间改出来的东西不会被提交，却会被
          `setUnsaved(false)` 说成已生效。这个窗口只有一次 IPC 往返，但冻住比解释一个竞态便宜。
          点「应用」会把焦点移到按钮上，所以键盘也改不到已经失焦的输入框。 */}
      <div className={cn(busy && 'pointer-events-none opacity-60')}>
        {steps.length === 0 ? (
          <p className="mt-1.5 text-[11px] leading-relaxed text-fg-faint">
            链上还没有步骤。从下面挑一个动作加进来——加进来的每一步都会按这个顺序执行。
          </p>
        ) : (
          steps.map((step, index) => (
            <StepRow
              key={step.id}
              step={step}
              index={index}
              count={steps.length}
              onChange={(action) => replace(index, action)}
              onMove={(delta) => move(index, delta)}
              onRemove={() => removeAt(index)}
            />
          ))
        )}

        <p className="mt-2 text-[11px] text-fg-faint">添加一步：</p>
        <div className="mt-1 flex flex-wrap items-center gap-1.5">
          {addable.map((kind) => (
            <Pill key={kind} active={false} disabled={busy || atMax} onClick={() => add(kind)}>
              + {KIND_LABEL[kind]}
            </Pill>
          ))}
        </div>

        {atMax && (
          <p className="mt-1.5 text-[11px] text-fg-faint">
            链上已经有 {MAX_FILTER_ACTIONS} 步，到上限了（更长的链必然是算错了的配方）。
          </p>
        )}

        {/* 菜单是**按类别过滤**的，所以「为什么没有那一个」要说出来。这一句是从
            `canUseAction` 的结果里派生的，不是另写一张说明表——说明表迟早与判据漂移。 */}
        {hidden.length > 0 && (
          <p className="mt-1.5 text-[11px] leading-relaxed text-fg-faint">
            「{hidden.map((kind) => KIND_LABEL[kind]).join(' / ')}」在
            {CATEGORY_LABEL[task.category]}这一类上放不下，所以不在上面。
          </p>
        )}
      </div>

      {unsaved && (
        <p className="mt-2 text-[11px] text-gold-pale">链上的改动还没生效——点「应用」才会提交。</p>
      )}
    </OptionsSection>
  )
}
