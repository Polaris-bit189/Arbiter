import { t, type KeysOf } from '@shared/i18n'
import { errorText } from '@shared/i18n/errors'
import { memo, useCallback, useEffect, useMemo, useState } from 'react'
import { CATEGORIES } from '@shared/types'
import type { Category, HistoryEntry, HistoryStatus } from '@shared/types'
import type { RerunResult } from '@shared/ipc-contract'
import { FormatTile } from '../components/FormatTile'
import { Icon } from '../components/Icon'
import { cn } from '../lib/cn'
import { formatBytes } from '../lib/format'
import { spriteIdFor } from '../lib/icons'
import { CATEGORY_LABEL } from '../lib/labels'
import { describeOptions } from '@shared/options'
import { useHistory } from '../store/useHistory'
import { useSettings } from '../store/useSettings'
import { useToast } from '../store/useToast'

/**
 * 历史记录页：曾经尘埃落定的转换。
 *
 * 筛选与排序**全在渲染层做**：历史最多 500 条，一次 IPC 拉全量之后在本地切分，
 * 比每条筛选都往返一趟主进程快得多，也不必为「按类别筛」再开一个通道。
 * 排序则由主进程保证（落盘时就是新→旧），这里不再排第二遍。
 */

/**
 * 三态徽章。刻意只用 `.badge` 及其 `done` / `error` 两个修饰类——
 * 设计给的另一个状态是 `.badge.converting`，而历史里不存在「正在转换」。
 * 取消没有对应修饰类，就落回 `.badge` 的中性外观。
 */
/**
 * ⚠️ 下面两个表里的 `label` 存的是**字典键**而不是词（与 `libs.ts` 的 `CATEGORY_LABEL`
 * 同一个做法），取词的地方写 `t(meta.label)`。**不能**在这里写成 `label: t(…)`：
 * 模块级常量在 import 那一刻就求值，而语言是可以在运行中途换的——那样徽章与筛选
 * 会永远停在启动时那一门语言上。
 */
const STATUS_META: Record<
  HistoryStatus,
  { label: KeysOf<'history.status.'>; badge: string; icon: string }
> = {
  done: { label: 'history.status.done', badge: 'badge done', icon: 'check' },
  error: { label: 'history.status.error', badge: 'badge error', icon: 'error' },
  canceled: { label: 'history.status.canceled', badge: 'badge', icon: 'close' }
}

const RANGES = [
  { key: 'all', label: 'history.range.all' },
  { key: 'today', label: 'history.range.today' },
  { key: 'week', label: 'history.range.week' },
  { key: 'month', label: 'history.range.month' }
] as const

type RangeKey = (typeof RANGES)[number]['key']

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * 列宽模板。表头与数据行共用一份，否则两处各写一遍必然错位。
 * 写成常量而不是内联在 JSX 里，是为了让 `@source` 扫到它就够了（Tailwind v4 扫的是文本）。
 */
const ROW_GRID = 'grid grid-cols-[minmax(0,1.6fr)_76px_74px_64px_88px_86px_auto] items-center gap-3'

/* -------------------------------------------------------------- 展示辅助 */

/** 相对时刻。「3 分钟前」比一个完整时间戳好扫得多，超过一周才退化成日期。 */
function formatWhen(timestamp: number): string {
  const diff = Date.now() - timestamp
  if (diff < 60_000) return t('history.when.justNow')
  if (diff < 3_600_000) return t('history.when.minutes', { n: Math.floor(diff / 60_000) })
  if (diff < DAY_MS) return t('history.when.hours', { n: Math.floor(diff / 3_600_000) })
  if (diff < 7 * DAY_MS) return t('history.when.days', { n: Math.floor(diff / DAY_MS) })

  const date = new Date(timestamp)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** 耗时。`startedAt` 理论上必有（没开跑的任务根本不进历史），缺了就说「未详」而不是编一个数。 */
function formatElapsed(entry: HistoryEntry): string {
  if (entry.startedAt === undefined) return t('history.elapsed.unknown')

  const ms = entry.finishedAt - entry.startedAt
  if (ms < 0) return '—'
  if (ms < 1000) return t('history.elapsed.milliseconds', { n: ms })
  if (ms < 60_000) return t('history.elapsed.seconds', { n: (ms / 1000).toFixed(1) })

  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.round((ms % 60_000) / 1000)
  return seconds > 0
    ? t('history.elapsed.minutesSeconds', { m: minutes, s: seconds })
    : t('history.elapsed.minutes', { m: minutes })
}

function withinRange(timestamp: number, range: RangeKey): boolean {
  if (range === 'all') return true
  if (range === 'today') {
    const now = new Date()
    return timestamp >= new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  }
  return Date.now() - timestamp <= (range === 'week' ? 7 : 30) * DAY_MS
}

/* ------------------------------------------------------------------ 行 */

interface RowProps {
  entry: HistoryEntry
  onReveal: (entry: HistoryEntry) => void
  onRerun: (entry: HistoryEntry) => void
  onRemove: (entry: HistoryEntry) => void
}

/**
 * `memo` 是承重的：切筛选、弹提示都会让本页重渲染，而 `filtered` 虽然每次都新建
 * 数组，元素却还是同一批对象引用——没有 memo 的话 500 行会跟着一起重画。
 */
const HistoryRow = memo(function HistoryRow({
  entry,
  onReveal,
  onRerun,
  onRemove
}: RowProps): React.JSX.Element {
  const meta = STATUS_META[entry.status]
  /** 参数摘要，没有就是 `null`（不是空串——那会渲染出一行空白，见 shared/trim.ts） */
  const options = describeOptions(entry.options)

  return (
    <div className={cn(ROW_GRID, 'border-b border-line px-2 py-2.5 hover:bg-hover')}>
      <div className="flex min-w-0 items-center gap-2.5">
        <FormatTile ext={entry.fromExt} size={36} className="shrink-0" />
        <div className="min-w-0">
          <p className="truncate text-sm text-fg" title={entry.inputPath}>
            {entry.inputName}
          </p>
          <p className="mt-0.5 truncate font-mono text-[11px] text-fg-muted">
            {entry.fromExt || '—'} <span className="text-gold-dim">→</span> {entry.toExt || '—'}
          </p>
          {/* 当初用了什么参数。与队列卡片上那一行**同一句话**（shared/trim.ts 的
              describeOptions），两处不一致的话用户会以为自己记错了。
              参数排在失败原因**之前**：它是这次操作的一部分，而失败原因是意外 */}
          {options !== null && (
            <p className="mt-0.5 truncate text-[11px] text-gold-pale" title={options}>
              {options}
            </p>
          )}
          {/* 失败原因存下来就是为了这一刻：只说「未成」等于什么都没说 */}
          {entry.status === 'error' && entry.error ? (
            <p
              className="mt-0.5 truncate text-[11px] text-bad"
              title={errorText(entry.errorRef, entry.error)}
            >
              {errorText(entry.errorRef, entry.error)}
            </p>
          ) : null}
        </div>
      </div>

      <span className="font-mono text-xs text-fg-muted">{formatBytes(entry.sizeBytes)}</span>
      <span className="font-mono text-xs text-fg-muted">{formatElapsed(entry)}</span>
      <span className="text-xs text-fg-muted">{t(CATEGORY_LABEL[entry.category])}</span>
      <span className="text-xs text-fg-faint">{formatWhen(entry.finishedAt)}</span>

      <span className={meta.badge}>
        <Icon name={meta.icon} size={12} />
        {t(meta.label)}
      </span>

      <div className="flex items-center justify-end gap-1">
        {/*
          「打开位置」只在真有产物时出现：失败/中止的条目没有 outputPath，
          给一个点了没反应的按钮比不给更糟。
        */}
        {entry.outputPath ? (
          <button type="button" className="btn-secondary" onClick={() => onReveal(entry)}>
            {t('history.row.reveal')}
          </button>
        ) : null}

        {/*
          「再行调律」**不做存在性判断**：渲染层没有 fs，源文件还在不在只有主进程知道。
          点了之后主进程先 existsSync 再入队，源文件没了就回一条
          「源文件已不在原处」，由页面上的回执逐条说给用户听。
        */}
        <button type="button" className="btn-ghost" onClick={() => onRerun(entry)}>
          {t('history.row.rerun')}
        </button>

        <button
          type="button"
          className="btn-ghost"
          title={t('history.row.remove')}
          aria-label={t('history.row.remove')}
          onClick={() => onRemove(entry)}
        >
          <Icon name="trash" size={14} />
        </button>
      </div>
    </div>
  )
})

/* ------------------------------------------------------------------ 页 */

export function HistoryPage(): React.JSX.Element {
  const entries = useHistory((state) => state.entries)
  const reload = useHistory((state) => state.reload)
  const clear = useHistory((state) => state.clear)
  const remove = useHistory((state) => state.remove)
  const reveal = useHistory((state) => state.reveal)
  const rerun = useHistory((state) => state.rerun)
  const showToast = useToast((state) => state.show)

  const [category, setCategory] = useState<Category | 'all'>('all')
  const [range, setRange] = useState<RangeKey>('all')
  const [armingClear, setArmingClear] = useState(false)

  /** 上一次重跑的回执（逐条的拒绝理由就靠它说出来，toast 只说得出一个数字） */
  const [report, setReport] = useState<RerunResult | null>(null)
  /**
   * 等待用户选一次冲突策略的那一次重跑。
   *
   * **主进程在拿到这个选择之前一条都不会入队**，所以这里不是一个「提示」，
   * 而是那条动作的第二半：不选就等于放弃这次重跑（用户也可以直接关掉这个面板）。
   */
  const [conflict, setConflict] = useState<{
    ids: string[]
    items: RerunResult['conflicts']
  } | null>(null)

  // 每次进页面都重新拉一次：上次离开之后可能又转换过好几个文件，
  // 而历史没有推送通道（见 useHistory 里的说明）。最多 500 条，一次 IPC。
  useEffect(() => {
    void reload()
  }, [reload])

  // 「抹去痕迹」是不可逆的，所以要点两次。比原生 confirm 更贴主题，也不必引依赖。
  useEffect(() => {
    if (!armingClear) return
    const timer = setTimeout(() => setArmingClear(false), 3200)
    return () => clearTimeout(timer)
  }, [armingClear])

  const filtered = useMemo(
    () =>
      entries.filter(
        (entry) =>
          (category === 'all' || entry.category === category) &&
          withinRange(entry.finishedAt, range)
      ),
    [entries, category, range]
  )

  /**
   * 「失败的那些」= 当前筛选结果里状态是 `error` 的条目。
   *
   * 跟随筛选（而不是「全部历史里的失败项」）是刻意的：用户往往是先按类别 / 时间
   * 把范围收到那一批，再点重跑。带筛选的两次点击正好是「我要重跑这几条」这句话。
   *
   * **不含 `canceled`**：中止是用户自己按的，把它混进「失败」里会让人莫名其妙地
   * 多转几个文件。要重跑中止的那几条，逐条点「再行调律」。
   */
  const failedIds = useMemo(
    () => filtered.filter((entry) => entry.status === 'error').map((entry) => entry.id),
    [filtered]
  )

  const handleReveal = useCallback(
    (entry: HistoryEntry) => {
      void reveal(entry.id).then((result) => {
        if (result === 'missing') showToast(t('history.toast.missing'))
      })
    },
    [reveal, showToast]
  )

  /**
   * 重跑一批（单条就是长度为 1 的那种）。
   *
   * 两条分支是这条动作的全部：
   *
   *  - **主进程回了冲突清单** → 什么都不入队，把选择权摆到界面上（覆盖 / 另存，默认另存）。
   *    这是全项目唯一会覆盖用户已有产物的入口，所以「先问一次」由主进程强制，
   *    界面这侧只负责把问题问清楚。
   *  - 正常结果 → 逐条说清楚：收进来几个、哪几个没收进来、为什么。
   *    只弹一句「已收入 3 个」是不够的——用户点了 20 个失败项，凭什么知道少了 17 个。
   */
  const runRerun = useCallback(
    (ids: string[], choice?: 'rename' | 'overwrite') => {
      void rerun(ids, choice).then((result) => {
        if (result.conflicts.length > 0) {
          setConflict({ ids, items: result.conflicts })
          return
        }
        setConflict(null)
        setReport(result)

        if (result.policyChanged) {
          // 主进程顺带改了设置里的「同名文件」策略（没有别的旋钮能做到「只覆盖这一次」，
          // 见 `core/rerun.ts`）。镜像要跟上，否则设置页那一栏显示的还是旧值。
          void useSettings.getState().init()
        }

        if (result.added > 0) showToast(t('history.toast.added', { n: result.added }))
        else if (result.rejected.length > 0)
          showToast(t('history.toast.rejected', { n: result.rejected.length }))
      })
    },
    [rerun, showToast]
  )

  const handleRerun = useCallback((entry: HistoryEntry) => runRerun([entry.id]), [runRerun])

  const handleRemove = useCallback(
    (entry: HistoryEntry) => {
      void remove(entry.id)
    },
    [remove]
  )

  const handleClear = useCallback(() => {
    // 第一次点只是「上膛」，第二次才真删
    if (!armingClear) {
      setArmingClear(true)
      return
    }
    setArmingClear(false)
    void clear().then((removed) => showToast(t('history.toast.cleared', { n: removed })))
  }, [armingClear, clear, showToast])

  return (
    <div className="flex h-full flex-col bg-canvas">
      <header className="shrink-0 px-6 pt-5">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="grad-gold-text font-display text-xl tracking-wide">
              {t('history.title')}
            </h1>
            <p className="mt-1 text-xs text-fg-faint">
              {t('history.subtitle')}
              {entries.length > 0 ? t('history.subtitleCount', { n: entries.length }) : ''}
            </p>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            {/* 「一批 20 个挂了 3 个」之后的下一步：把那 3 个挑出来重跑，
                而不是让用户去磁盘上一个个找回来重拖。
                禁用而不是隐藏：一个时有时无的按钮会让人以为功能坏了。 */}
            <button
              type="button"
              className="btn-secondary"
              disabled={failedIds.length === 0}
              title={
                failedIds.length === 0
                  ? t('history.rerunFailed.none')
                  : t('history.rerunFailed.title', { n: failedIds.length })
              }
              onClick={() => runRerun(failedIds)}
            >
              {t('history.rerunFailed.labelLead')}
              {failedIds.length}
              {t('history.rerunFailed.labelTail')}
            </button>

            <button
              type="button"
              className={armingClear ? 'btn-secondary' : 'btn-ghost'}
              disabled={entries.length === 0}
              onClick={handleClear}
            >
              <Icon name="trash" size={14} />
              {armingClear ? t('history.clear.arming') : t('history.clear.label')}
            </button>
          </div>
        </div>

        {/*
          分隔用素材里的纹样。**不要写成 `<div className="divider">`**：theme.css
          里没有 `.divider`，那个类名会渲染成一个 0 高度的空 div——没有线，也不报错。
          `preserveAspectRatio="none"` 是因为纹样画布是 240×16 而这里要拉通整页。
        */}
        <svg
          viewBox="0 0 240 16"
          preserveAspectRatio="none"
          className="my-3 h-3 w-full"
          aria-hidden="true"
        >
          <use href={`#${spriteIdFor('ornaments/divider.svg')}`} />
        </svg>

        <div className="flex flex-wrap items-center gap-3 pb-3">
          <div className="flex flex-wrap items-center gap-1.5">
            <FilterChip
              label={t('history.filter.allCategories')}
              active={category === 'all'}
              onClick={() => setCategory('all')}
            />
            {CATEGORIES.map((key) => (
              <FilterChip
                key={key}
                label={t(CATEGORY_LABEL[key])}
                active={category === key}
                onClick={() => setCategory(key)}
              />
            ))}
          </div>

          <span className="h-4 w-px bg-line" />

          <div className="flex flex-wrap items-center gap-1.5">
            {RANGES.map((item) => (
              <FilterChip
                key={item.key}
                label={t(item.label)}
                active={range === item.key}
                onClick={() => setRange(item.key)}
              />
            ))}
          </div>
        </div>
      </header>

      {/* ------------------------------------------- 重跑：冲突选择 / 回执 */}

      {conflict !== null && (
        <div className="mx-6 mt-3 shrink-0 rounded-card border border-gold-dim bg-raised px-3 py-2.5">
          <p className="text-xs text-gold-pale">
            {t('history.conflict.titleLead')} {conflict.items.length}{' '}
            {t('history.conflict.titleTail')}
          </p>
          <ul className="scroll-dark mt-1.5 max-h-24 space-y-0.5 overflow-y-auto">
            {conflict.items.map((item) => (
              <li
                key={item.id}
                className="truncate font-mono text-[11px] text-fg-muted"
                title={item.outputPath}
              >
                {item.inputName} → {item.outputPath}
              </li>
            ))}
          </ul>
          <p className="mt-1.5 text-[11px] leading-relaxed text-fg-faint">
            {t('history.conflict.hint')}
          </p>
          <div className="mt-2 flex items-center gap-2">
            {/* **默认那一档摆在前面**，而且写全「另存一份」而不是「确定」——
                这个选择会决定用户磁盘上多一个文件还是少一个文件，不该靠位置去猜。 */}
            <button
              type="button"
              className="btn-primary"
              onClick={() => runRerun(conflict.ids, 'rename')}
            >
              {t('history.conflict.rename')}
            </button>
            <button
              type="button"
              className="btn-secondary"
              onClick={() => runRerun(conflict.ids, 'overwrite')}
            >
              {t('history.conflict.overwrite')}
            </button>
            <button type="button" className="btn-ghost" onClick={() => setConflict(null)}>
              {t('history.conflict.cancel')}
            </button>
          </div>
        </div>
      )}

      {report !== null && (
        <div className="mx-6 mt-3 shrink-0 rounded-card border border-line-2 bg-raised px-3 py-2">
          <div className="flex items-center gap-2">
            <Icon
              name={report.rejected.length > 0 ? 'error' : 'check'}
              size={14}
              className={report.rejected.length > 0 ? 'shrink-0 text-bad' : 'shrink-0 text-gold'}
            />
            <span className="flex-1 text-xs text-gold-pale">
              {t('history.report.summaryLead')} {report.added} {t('history.report.summaryTail')}
              {report.rejected.length > 0
                ? t('history.report.rejected', { n: report.rejected.length })
                : ''}
            </span>
            <button
              type="button"
              onClick={() => setReport(null)}
              aria-label={t('history.report.collapse')}
              className="rounded p-0.5 text-fg-faint transition-colors hover:bg-hover hover:text-fg"
            >
              <Icon name="close" size={13} />
            </button>
          </div>

          {report.policyChanged && (
            // 主进程为了让这一次的动作成立，顺带改了设置里的「同名文件」策略
            //（没有「只对这一条生效」的旋钮）。改了就**必须说出来**：
            // 静默改设置的后果是用户下次拖一批文件进来，行为莫名其妙地变了。
            <p className="mt-1.5 text-[11px] leading-relaxed text-amber-400">
              {t('history.report.policyChanged')}
            </p>
          )}

          {/* 逐条列出来，而不是只说一句「有 3 个没收进来」。用户点了 20 个失败项，
              必须能看出少的是哪几个、为什么——「源文件已不在原处」正是他要去处理的事 */}
          {report.rejected.length > 0 && (
            <ul className="scroll-dark mt-1.5 max-h-28 space-y-0.5 overflow-y-auto">
              {report.rejected.map((item) => (
                <li key={item.path} className="truncate text-xs text-fg-muted" title={item.path}>
                  <span className="text-fg">{item.path.split(/[\\/]/).pop()}</span>
                  <span className="opacity-75"> — {item.reason}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="scroll-dark min-h-0 flex-1 overflow-y-auto px-6">
        {entries.length === 0 ? (
          <EmptyState
            seal
            title={t('history.empty.noEntries')}
            hint={t('history.empty.noEntriesHint')}
          />
        ) : filtered.length === 0 ? (
          <EmptyState title={t('history.empty.noMatch')} hint={t('history.empty.noMatchHint')} />
        ) : (
          <>
            <div
              className={cn(
                ROW_GRID,
                'sticky top-0 z-10 border-b border-line-2 bg-canvas px-2 py-2 text-[11px] text-fg-faint'
              )}
            >
              <span>{t('history.column.file')}</span>
              <span>{t('history.column.size')}</span>
              <span>{t('history.column.elapsed')}</span>
              <span>{t('history.column.category')}</span>
              <span>{t('history.column.time')}</span>
              <span>{t('history.column.status')}</span>
              <span className="text-right">{t('history.column.actions')}</span>
            </div>

            {filtered.map((entry) => (
              <HistoryRow
                key={entry.id}
                entry={entry}
                onReveal={handleReveal}
                onRerun={handleRerun}
                onRemove={handleRemove}
              />
            ))}
          </>
        )}
      </div>

      {/*
        ⚠️ **本页不要挂 `<Toast />`。** 宿主在 `App.tsx` 的 shell 层，只挂一次，
        与页面切换无关——本页 `showToast` 弹得出来。

        这里直接记下当初为什么会误挂一个，免得下一个人照着补回来：工作台是用 `hidden`
        保活的，`display:none` 会把整棵子树连同 `fixed` 的 toast 一起吞掉，所以确实
        需要「一个不在页面里的宿主」。但在**页面里**补宿主只堵住了补的那一页，
        设置页 / 关于页照样静默丢提示、不报任何错。宿主挂到 shell 层才一次性覆盖所有页面，
        新增页面也不必记得带宿主。
      */}
    </div>
  )
}

/* ---------------------------------------------------------------- 零件 */

interface ChipProps {
  label: string
  active: boolean
  onClick: () => void
}

function FilterChip({ label, active, onClick }: ChipProps): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'rounded-full border px-2.5 py-1 text-xs transition-colors',
        active
          ? 'border-gold bg-raised text-gold-pale'
          : 'border-line text-fg-muted hover:border-line-2 hover:text-fg'
      )}
    >
      {label}
    </button>
  )
}

interface EmptyStateProps {
  /** 有没有大纹样。空历史给 `#o-seal`，筛出来是空的就不必再摆一次大纹样 */
  seal?: boolean
  title: string
  hint: string
}

function EmptyState({ seal = false, title, hint }: EmptyStateProps): React.JSX.Element {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 pb-16">
      {seal ? (
        // id 走 `spriteIdFor()`——`<use href="#不存在">` 是**静默失败**（画个空白，
        // 控制台最多一条 warning），而手写 id 在素材改名那天就会变成那样。
        // 透明度用行内样式而不是 `opacity-55`：类名写错的话它照常全不透明地渲染出来，
        // 而设计要的是「淡金」——这种错只看得见、查不出来。
        <svg
          viewBox="0 0 160 160"
          width={150}
          height={150}
          style={{ opacity: 0.55 }}
          aria-hidden="true"
        >
          <use href={`#${spriteIdFor('ornaments/seal.svg')}`} />
        </svg>
      ) : (
        <svg
          viewBox="0 0 120 120"
          width={72}
          height={72}
          style={{ opacity: 0.4 }}
          aria-hidden="true"
        >
          <use href={`#${spriteIdFor('ornaments/ring-ticks.svg')}`} />
        </svg>
      )}

      <div className="text-center">
        <p className="font-display text-base tracking-wide text-fg-muted">{title}</p>
        <p className="mt-1 text-xs text-fg-faint">{hint}</p>
      </div>
    </div>
  )
}
