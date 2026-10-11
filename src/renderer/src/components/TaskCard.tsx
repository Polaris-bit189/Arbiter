import { t, type KeysOf } from '@shared/i18n'
// 阶段文案优先按**码**取词（`stageRef`），没有码才回落到那句中文快照。
// 理由：任务可能跑几分钟，中途用户把界面切成英文（见 shared/i18n/stage.ts 的文件头）。
import { errorText } from '@shared/i18n/errors'
import { stageText } from '@shared/i18n/stage'
import { memo, useState } from 'react'
import { targetsFor } from '@shared/formats'
import type { AfterConvertAction, TaskStatus } from '@shared/types'
import { describeOptions, hasAnyOptions } from '@shared/options'
import { useTasks } from '../store/useTasks'
import { useAfterAction } from '../store/useAfterAction'
import { useSettings } from '../store/useSettings'
import { FormatTile } from './FormatTile'
import { Icon } from './Icon'
import { ProgressBar } from './ProgressBar'
import { TargetFormatSelect } from './TargetFormatSelect'
import { OptionsEditor } from './options/OptionsEditor'
import { cn } from '../lib/cn'
import { formatBytes, formatEta, formatSpeed } from '../lib/format'
import { CATEGORY_LABEL } from '../lib/labels'

/**
 * 队列行的列宽。**表头与行必须共用这一个常量**：
 * 在两处各写一遍字面量，改一处之后表头和数据就会错位，而错位不报任何错，
 * 只是「看着别扭」，最容易在评审时被当成审美问题放过去。
 *
 * 比例照原型（设计 4.2）：文件 1.6fr / 大小 84px / 目标格式 150px / 状态 1fr / 操作 110px。
 */
export const QUEUE_COLUMNS = 'minmax(220px, 1.6fr) 84px 150px 1fr 110px'

/**
 * 状态徽章四态（设计 6.4）。
 *
 * `mark` 用字符而不是图标：`◆` 在字体里就是一个字，与旁边 12px 的文字天然对齐；
 * 换成 24px 画布的内联图标反而要再补一套对齐。`tone` 是交付物里 `.badge` 的
 * 四个修饰类，只管颜色。
 *
 * ⚠️ `label` 是 **`MsgKey` 而不是字符串**（与 `lib/CATEGORY_LABEL` 同一套写法），
 * 所以取词的地方要写 `t(badge.label)`——类型让「有一条忘了包 `t()`」变成编译错误。
 */
const STATUS_BADGE: Record<
  TaskStatus,
  { mark: string; label: KeysOf<'workbench.status.'>; tone: string }
> = {
  queued: { mark: '◆', label: 'workbench.status.queued', tone: 'waiting' },
  waiting_engine: { mark: '◆', label: 'workbench.status.waitingEngine', tone: 'waiting' },
  running: { mark: '◆', label: 'workbench.status.running', tone: 'converting' },
  done: { mark: '✓', label: 'workbench.status.done', tone: 'done' },
  error: { mark: '✕', label: 'workbench.status.error', tone: 'error' },
  canceled: { mark: '—', label: 'workbench.status.canceled', tone: 'waiting' }
}

/** 操作列里的小按钮。尺寸与 `.btn-*` 那三档不兼容（行高只有 56px），所以不复用它们 */
const ACTION_BUTTON =
  'rounded px-1.5 py-0.5 text-[12px] text-fg-muted transition-colors hover:bg-hover hover:text-gold-pale'

/**
 * 「发出去」那个按钮的文案。**按设置里那一项变**，因为「发出去」这三个字
 * 说不清点下去到底会发生什么——而它会动用户的剪贴板。
 *
 * `'open-folder'` 刻意**不在这里**：那一档与既有那个「打开位置」是同一件事
 *（`shell.showItemInFolder`），再放一个同样的按钮只会让操作列多一格。
 */
const SHARE_LABEL: Partial<Record<AfterConvertAction, KeysOf<'workbench.share.'>>> = {
  'copy-path': 'workbench.share.copyPath',
  'copy-file': 'workbench.share.copyFile'
}

/**
 * 一条队列行。
 *
 * **`memo` 是这个组件的承重结构，不能摘。**
 * 它只按自己的 id 订阅（`s.byId[id]`），所以主进程推来的增量 patch 只让被改动的那
 * 一行重渲染。四个任务并发时每秒有几十次进度推送，整列表重渲染会肉眼可见地掉帧。
 * 摘掉 memo 之后功能照旧、测试照绿，只是卡——这类回归最难被发现。
 */
export const TaskCard = memo(function TaskCard({ id }: { id: string }): React.JSX.Element | null {
  const task = useTasks((s) => s.byId[id])
  const setTarget = useTasks((s) => s.setTarget)
  const cancel = useTasks((s) => s.cancel)
  const retry = useTasks((s) => s.retry)
  const remove = useTasks((s) => s.remove)
  const reveal = useTasks((s) => s.reveal)
  // 取到的都是**原始值**（字符串 / undefined），选择器才不会被每次进度推送骗着重渲染
  const presetExt = useTasks((s) => s.presets[id])
  const afterConvert = useSettings((s) => s.settings?.afterConvert ?? 'none')
  const runAfterAction = useAfterAction((s) => s.run)

  const [showLog, setShowLog] = useState(false)
  const [showOptions, setShowOptions] = useState(false)

  if (!task) return null

  const badge = STATUS_BADGE[task.status]
  const isRunning = task.status === 'running'
  const isDone = task.status === 'done'
  const canRetry = task.status === 'error' || task.status === 'canceled'
  const hasLog = task.status === 'error' && (task.logTail?.length ?? 0) > 0

  // 参数摘要（`裁 3.0s–8.0s · 无损（起点对齐关键帧）`）。**必须显示**：
  // 两条 `clip.mp4 → mp4` 在队列里长得一模一样，而一条是整段、另一条只裁了 5 秒。
  // 判据走 shared/options.ts 那一份，main 侧的历史页显示的是同一句话。
  const summary = describeOptions(task.options)
  /** 这条任务有没有任何参数可设。与主进程 `setOptions` 读的是**同一个**判据 */
  const settable = hasAnyOptions(task.category)

  const progress = task.progress

  /** 状态列里跟在徽章后面的那行小字：引擎给什么就说什么 */
  const detail = ((): string => {
    // P7：优先用码——`task.error` 是失败那一刻那句中文的快照，而卡片会**一直**这么显示，
    // 哪怕用户早就把界面切成英文了。没有码（老任务 / 还没加码的 throw 站点）时回落它。
    if (task.status === 'error')
      return errorText(task.errorRef, task.error ?? t('workbench.convertFailed'))
    if (progress === null) return ''
    if (progress.kind === 'determinate') {
      const parts: string[] = []
      // 有 stage 就先说在干什么（目前只有「正在下载 X 引擎…」走这条），
      // 再说百分比——反过来的话用户得先猜这几分钟在跑什么
      //
      // ⚠️ **这里优先用码取词**（`stageRef`），而不是直接用 `stage` 那串中文：
      // 后者是**产出的那一刻**那门语言的快照，而任务可能跑几分钟，中途用户把界面
      // 切成了英文。`stageText` 在没有码时回落到 `stage`（老任务的进度对象没有码）。
      const stage = stageText(progress.stageRef, progress.stage ?? '')
      if (stage) parts.push(stage)
      parts.push(`${Math.round(progress.percent * 100)}%`)
      const eta = formatEta(progress.etaSec)
      if (eta) parts.push(eta)
      const speed = formatSpeed(progress.speed)
      if (speed) parts.push(speed)
      return parts.join(' · ')
    }
    if (progress.kind === 'indeterminate') {
      return stageText(progress.stageRef, progress.stage)
    }
    return `${stageText(progress.stageRef, progress.stage)} ${progress.done}/${progress.total}`
  })()

  return (
    <li
      className={cn(
        // 描边一律按**边**写（`border-b-line` 而不是 `border-line`）：
        // `cn()` 里的 twMerge 认为 `border-line`（四边颜色）与 `border-l-bad`
        // （左边颜色）冲突，会把先前那条整个删掉——于是行的上下描边退回继承色
        // （暖白），表格里横线亮得刺眼，而且零报错。按边写就不存在这个冲突。
        'relative grid h-14 items-center gap-3 border-b border-b-line px-2 transition-colors',
        // 失败行给一条暖红左条：整行铺红底会跟「已成」那行抢注意力，
        // 而队列里同时有成功与失败是常态
        task.status === 'error' && 'border-l-2 border-l-bad',
        'hover:bg-raised'
      )}
      style={{ gridTemplateColumns: QUEUE_COLUMNS }}
    >
      {/* 文件：格式砖 + 文件名 + 「原格式 · 类别」 */}
      <div className="flex min-w-0 items-center gap-3">
        <FormatTile ext={task.fromExt} size={36} className="shrink-0" />
        <div className="min-w-0">
          <p className="truncate text-[13px] text-fg" title={task.inputPath}>
            {task.inputName}
          </p>
          <p className="mt-0.5 truncate text-[11px] tracking-[0.5px] text-fg-faint">
            {task.fromExt.toUpperCase()} · {t(CATEGORY_LABEL[task.category])}
          </p>
          {/* 参数摘要。金色而不是灰色：它是**用户自己设的**东西，
              与上面那行「源格式 · 类别」这种描述性信息不是一类 */}
          {summary !== null && (
            <p className="mt-0.5 truncate text-[11px] text-gold-pale">{summary}</p>
          )}
        </div>
      </div>

      {/* 大小：源文件的体积主进程没有回传（`Task` 上只有产物体积），
          所以这一列在转换完成前是「—」，完成后是产物的体积 */}
      <span
        className="font-mono text-xs tabular-nums text-fg-muted"
        title={t('workbench.outputSize')}
      >
        {formatBytes(task.sizeBytes)}
      </span>

      <TargetFormatSelect
        fromExt={task.fromExt}
        toExt={task.toExt}
        targets={targetsFor(task.fromExt)}
        disabled={isRunning}
        highlighted={presetExt !== undefined}
        onChange={(next) => void setTarget(id, next)}
      />

      {/* 状态：徽章 + 一行细节 + 进度条 */}
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className={cn('badge', badge.tone)}>
            {/* 调律中才脉动。等待中不脉动是刻意的：一屏十几个等待行一起闪，
                既晃眼又看不出「哪一个真的在动」 */}
            <span className={cn(isRunning && 'animate-pulse')}>{badge.mark}</span>
            {t(badge.label)}
          </span>
          {detail !== '' && (
            <span className="truncate font-mono text-[11px] text-fg-faint" title={detail}>
              {detail}
            </span>
          )}
        </div>

        {/* 「上次这类文件转成了 webm」——预置了就**必须说一句**。
            静默替用户做主（哪怕只是预置）与「自动执行」只差一步，
            而这一步正是这个项目所有「自动」都要避开的。
            排在**排队中**才显示：开跑之后目标已经定死，再说「上次」只是噪音。 */}
        {presetExt !== undefined && task.status === 'queued' && (
          <p className="mt-0.5 truncate text-[11px] text-gold-pale">
            {t('workbench.presetHint')} {presetExt.toUpperCase()}
          </p>
        )}

        {(isRunning || task.status === 'waiting_engine' || task.status === 'error') && (
          <div className="mt-1.5">
            <ProgressBar progress={progress} status={task.status} />
          </div>
        )}
      </div>

      {/* 操作。失败行三样（再行调律 / 日志 / 删除），列宽 110px 放不下时换行——
          行高 56px，两行 12px 的文字仍有余量 */}
      <div className="flex flex-wrap items-center justify-end gap-x-1 gap-y-0.5">
        {isRunning && (
          <button type="button" onClick={() => void cancel([id])} className={ACTION_BUTTON}>
            {t('workbench.action.cancel')}
          </button>
        )}

        {/* 参数：只对真的设有参数的类别出现（`hasAnyOptions` 与主进程是同一份判据）。
            运行中禁用而不是隐藏——与目标格式那个下拉同一套规矩：
            一个时有时无的按钮会让人以为功能坏了。 */}
        {settable && (
          <button
            type="button"
            disabled={isRunning}
            title={
              isRunning
                ? t('workbench.action.optionsTitleRunning')
                : t('workbench.action.optionsTitle')
            }
            onClick={() => setShowOptions((v) => !v)}
            className={cn(ACTION_BUTTON, isRunning && 'cursor-not-allowed opacity-40')}
          >
            {t('workbench.action.options')}
          </button>
        )}

        {canRetry && (
          <button type="button" onClick={() => void retry([id])} className={ACTION_BUTTON}>
            {t('workbench.action.retry')}
          </button>
        )}

        {hasLog && (
          <button type="button" onClick={() => setShowLog((v) => !v)} className={ACTION_BUTTON}>
            {t('workbench.action.log')}
          </button>
        )}

        {isDone && (
          <button
            type="button"
            title={t('workbench.action.revealTitle')}
            onClick={() => void reveal([id])}
            className={cn(ACTION_BUTTON, 'inline-flex items-center gap-1')}
          >
            <Icon name="folder" size={13} />
            {t('workbench.action.reveal')}
          </button>
        )}

        {/* 「发出去」：把「显示 → 找到 → 右键复制 → 粘贴」四步压成一次点击。
            只在设置里选了「复制路径 / 复制产物」时出现——默认那一档是「什么都不做」，
            给它一个点了不会发生任何事的按钮，比没有这个按钮更糟。 */}
        {isDone && SHARE_LABEL[afterConvert] !== undefined && (
          <button
            type="button"
            title={
              afterConvert === 'copy-file'
                ? t('workbench.share.copyFileTitle')
                : t('workbench.share.copyPathTitle')
            }
            onClick={() => void runAfterAction(id)}
            className={ACTION_BUTTON}
          >
            {t(SHARE_LABEL[afterConvert])}
          </button>
        )}

        <button
          type="button"
          title={t('workbench.action.remove')}
          aria-label={t('workbench.action.remove')}
          onClick={() => void remove([id])}
          className={cn(ACTION_BUTTON, 'inline-flex items-center p-1 hover:text-bad')}
        >
          <Icon name="close" size={13} />
        </button>
      </div>

      {/* 失败日志。用绝对定位的面板挂在行下方，而不是把 <pre> 塞进行里：
          行高是写死的 56px（表头与数据靠同一套列宽对齐），在行内展开会把整张表撑变形。
          面板浮在后续行之上，点「日志」再点一次收起。 */}
      {hasLog && showLog && (
        <pre
          className="scroll-dark absolute right-2 top-full z-20 max-h-40 w-[520px] overflow-auto rounded-card border border-line-2 bg-abyss p-2 text-[11px] leading-relaxed text-fg-muted"
          style={{ boxShadow: '0 8px 28px rgba(0, 0, 0, 0.55)' }}
        >
          {task.logTail?.join('\n')}
        </pre>
      )}

      {/* 参数面板。与日志面板同一个位置与套路（见 OptionsEditor 文件头的说明）。
          两个面板可以同时开着：一个是「看过去」，一个是「改将来」，互不遮挡 */}
      {showOptions && <OptionsEditor task={task} onClose={() => setShowOptions(false)} />}
    </li>
  )
})

/**
 * 拖入被拒的批量清单。
 *
 * 与 Toast 是两种语义，所以**不并进 toast**：这里要回答的是「哪个文件、为什么被拒」，
 * 一条一句话的提示承载不了；而且这份清单要一直留着直到用户看完，
 * toast 两秒就没了。被拒的文件越多，越不能只给一句话。
 */
export function RejectedNotice({
  items,
  onDismiss
}: {
  items: { path: string; reason: string }[]
  onDismiss: () => void
}): React.JSX.Element | null {
  if (items.length === 0) return null

  return (
    <div className="mt-3 shrink-0 rounded-card border border-line-2 bg-raised px-3 py-2">
      <div className="flex items-center gap-2">
        <Icon name="error" size={14} className="shrink-0 text-bad" />
        {/* 「项」而不是「个文件」：这张清单里的条目**不一定都是文件**。
            「收入文件夹」那条路会把目录也放进来（按默认排除清单跳过的、权限不足
            读不了的、还有一条「已达扫描上限」）——它们是「少了的东西去哪了」的答案，
            与逐条被拒的文件回答的是同一个问题，所以共用这一张清单 */}
        <span className="flex-1 text-xs text-gold-pale">
          {items.length} {t('workbench.rejectedCount')}
        </span>
        <button
          type="button"
          onClick={onDismiss}
          aria-label={t('workbench.rejectedDismiss')}
          className="rounded p-0.5 text-fg-faint transition-colors hover:bg-hover hover:text-fg"
        >
          <Icon name="close" size={13} />
        </button>
      </div>

      <ul className="scroll-dark mt-1.5 max-h-28 space-y-0.5 overflow-y-auto">
        {items.map((item) => (
          <li key={item.path} className="truncate text-xs text-fg-muted">
            <span className="text-fg">{item.path.split(/[\\/]/).pop()}</span>
            <span className="opacity-75"> — {item.reason}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
