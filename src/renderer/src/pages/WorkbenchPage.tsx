import { useCallback, useEffect, useMemo, useRef } from 'react'
import { targetsFor, targetsForCategory } from '@shared/formats'
import { CATEGORIES, type Category } from '@shared/types'
import type { AddResult } from '@shared/ipc-contract'
import { AfterActionNotice } from '../components/AfterActionNotice'
import { DropZone } from '../components/DropZone'
import { Icon } from '../components/Icon'
import { QUEUE_COLUMNS, RejectedNotice } from '../components/TaskCard'
import { TaskList } from '../components/TaskList'
import { spriteIdFor } from '../lib/icons'
import { formatBytes } from '../lib/format'
import { CATEGORY_LABEL } from '../lib/labels'
import { useShortcuts } from '../hooks/useShortcuts'
import { useSettings } from '../store/useSettings'
import { useTasks } from '../store/useTasks'
import { useToast } from '../store/useToast'

/**
 * 格式转换工作台（设计 4.1）。
 *
 * 滚动方向与旧版不同：**不再是整页滚动**，而是「拖拽区 / 工具栏 / 表头 / 底栏
 * 一律 `shrink-0`，只有表体 `flex-1 overflow-y-auto`」。
 * 这是队列「像个真应用」的关键——长列表里表头始终可见，底栏的主按钮也永远在手边。
 */
export function WorkbenchPage(): React.JSX.Element {
  const addPaths = useTasks((s) => s.addPaths)
  const start = useTasks((s) => s.start)
  const cancel = useTasks((s) => s.cancel)
  const clearFinished = useTasks((s) => s.clearFinished)
  const setTarget = useTasks((s) => s.setTarget)
  const pickFiles = useTasks((s) => s.pickFiles)
  const pickFolder = useTasks((s) => s.pickFolder)

  const rejected = useTasks((s) => s.rejected)
  const clearRejected = useTasks((s) => s.clearRejected)

  const maxConcurrent = useSettings((s) => s.settings?.maxConcurrent ?? 0)
  const showToast = useToast((s) => s.show)

  /**
   * 页面上几个数字一次算完，**拼成字符串再返回**。
   *
   * zustand 默认用 `Object.is` 比较选择器的返回值：返回 `{ total, bytes, queued }`
   * 这种新对象，每次进度推送都会被判定成「变了」，整个工作台跟着重渲染，
   * `TaskCard` 上的 `memo` 也就白做了。字符串在数值不变时相等。
   *
   * 一个订阅算四个数，也顺带避免了四个选择器各扫一遍 `order`。
   */
  const summary = useTasks((s) => {
    let bytes = 0
    let queued = 0
    let running = 0
    let done = 0
    let failed = 0
    for (const id of s.order) {
      const task = s.byId[id]
      if (!task) continue
      if (task.sizeBytes) bytes += task.sizeBytes
      switch (task.status) {
        case 'queued':
          queued += 1
          break
        case 'running':
          running += 1
          break
        case 'done':
          done += 1
          break
        case 'error':
        case 'canceled':
          failed += 1
          break
        case 'waiting_engine':
          // 等引擎既不在跑，也还没落定，两边都不算
          break
      }
    }
    return `${s.order.length}|${bytes}|${queued}|${running}|${done}|${failed}`
  })

  const [total, totalBytes, queued, running, done, failed] = summary.split('|').map(Number)

  /**
   * 整批转换跑完时报一声「万般格式，各归其所」。
   *
   * 判据写得很紧，是因为松一点就会说谎：
   *  - `done === total` 要求**每一条**都成了。只看「运行中变成 0」的话，
   *    用户手动取消了几个、或者有几个失败了，同样会归零，那时候报「各归其所」
   *    是在替一次失败粉饰。
   *  - `wasRunning` 要求 **先前真的在跑**。少了这一条，空队列启动时就会弹一次。
   *  - 之所以还要 `queued === 0`：并发上限满了的时候，一个跑完、下一个还没被
   *    调度器认领的那一瞬「运行中」也会是 0，而队列里明明还排着。
   */
  const prevRunning = useRef(0)
  useEffect(() => {
    const wasRunning = prevRunning.current > 0
    prevRunning.current = running
    if (!wasRunning || running > 0 || queued > 0) return
    if (total === 0 || done !== total) return
    showToast('万般格式，各归其所')
  }, [running, queued, total, done, showToast])

  /**
   * 队列里出现过的类别，按 `CATEGORIES` 的固定顺序拼成一个字符串。
   *
   * 同样是为了不返回数组：数组每次都是新引用。这个字符串只在「队列里出现了新类别」
   * 时变化，而它变的时候整个工作台本来也该重渲染。
   */
  const categoryKey = useTasks((s) => {
    const present = new Set<Category>()
    for (const id of s.order) {
      const task = s.byId[id]
      if (task) present.add(task.category)
    }
    return CATEGORIES.filter((category) => present.has(category)).join(',')
  })

  const globalGroups = useMemo(() => {
    if (categoryKey === '') return []
    return (categoryKey.split(',') as Category[]).map((category) => ({
      category,
      label: CATEGORY_LABEL[category],
      items: targetsForCategory(category)
    }))
  }, [categoryKey])

  /**
   * 「全部转为」：只落到**目标格式与源同类的那些行**上。
   *
   * 队列里六类文件可以混着，一个全局目标不可能对所有行都合法——把 `mp4`
   * 套到图片行上，主进程的 `setTarget` 会静默忽略（它自己有一道 `targetsFor` 校验），
   * 用户看到的是「选了下拉，一半的行没动」。所以这里先用同一份能力矩阵过一遍，
   * 只对真的能转的行出手。
   */
  const applyToAll = async (toExt: string): Promise<void> => {
    const { byId, order } = useTasks.getState()
    let applied = 0
    for (const id of order) {
      const task = byId[id]
      if (!task || task.status === 'running') continue
      if (task.toExt === toExt) continue
      if (!targetsFor(task.fromExt).includes(toExt)) continue
      await setTarget(id, toExt)
      applied += 1
    }
    showToast(
      applied > 0 ? `已将 ${applied} 个目标格式设为 ${toExt.toUpperCase()}` : '没有适用此行事的文件'
    )
  }

  /**
   * 走 pick 通道的收入动作。
   *
   * 三种结果要分三种说法，**不能混**：
   *  - `null`：用户按了取消（选择框、或者文件夹那个「将加入 N 个文件」的确认框），
   *    队列没有任何变化，一个字都不必说
   *  - 一个都没收进来：是目录里 / 选择里没有认得的文件，不是失败
   *  - 有收有拒：把两个数字都报出来，用户才知道少的那几个去哪了
   *
   * ⚠️ 第二、三种说法里的「项」不是错字：`rejected` 里除了**文件**，还会有
   * 「打开文件夹」那条路带回来的**目录**（按默认排除清单跳过的、权限不足读不了的、
   * 以及一条「已达扫描上限」）。它们同样回答「少了的东西去哪了」，
   * 所以共用同一张清单，只是措辞不能再写成「个文件」。
   */
  const collect = useCallback(
    async (run: () => Promise<AddResult | null>): Promise<void> => {
      const result = await run()
      if (result === null) return

      if (result.added === 0 && result.rejected.length === 0) {
        showToast('此处没有认得的文件')
        return
      }
      if (result.added === 0) {
        showToast(`一个文件也没收进来，${result.rejected.length} 项被跳过（见下方清单）`)
        return
      }
      showToast(
        result.rejected.length > 0
          ? `收入 ${result.added} 个，另有 ${result.rejected.length} 项没有收入（见下方清单）`
          : `收入 ${result.added} 个，可以开始调律了`
      )
    },
    [showToast]
  )

  /* -------------------------------------------------------------- 快捷键（E-7） */

  /**
   * 三个动作**复用按钮那一份实现**，一个都不复制。
   *
   * 尤其是「收入文件」：它那三种结果分三种说法的回执（取消 / 一个都没收进来 /
   * 有收有拒）看着琐碎，但每一条都对应一次「用户以为出了问题」——复制一份出来，
   * 两份措辞一定会漂，而漂了以后按快捷键和点按钮的行为就不再是同一件事了。
   */
  const shortcutPickFiles = useCallback((): void => void collect(pickFiles), [collect, pickFiles])

  const shortcutStart = useCallback((): void => void start(), [start])

  /**
   * Esc 掐掉正在跑的那些。
   *
   * 回执写在**取消回来之后**：先弹「已取消」再动作的话，主进程那边万一没接受，
   * 用户看到的就是一句与事实相反的提示。文案里点明「源文件没动」是有意的——
   * 这是这个操作**唯一**的安抚点，用户按下去的第一反应一定是「我的文件还在吗」。
   */
  const shortcutCancelRunning = useCallback((): void => {
    const { order, byId } = useTasks.getState()
    const ids = order.filter((id) => byId[id]?.status === 'running')
    if (ids.length === 0) return
    void cancel(ids).then(() => {
      showToast(`已取消 ${ids.length} 个转换（源文件一个字节没动，可以重跑）`)
    })
  }, [cancel, showToast])

  useShortcuts({
    onPickFiles: shortcutPickFiles,
    onStart: shortcutStart,
    onCancelRunning: shortcutCancelRunning
  })

  return (
    <div className="flex h-full min-h-0 flex-col px-6 pb-4 pt-5">
      <header className="shrink-0">
        <div className="flex items-baseline justify-between gap-4">
          <h1 className="grad-gold-text font-display text-2xl tracking-[0.06em]">调律工作台</h1>

          <span className="shrink-0 text-[11px] tracking-[0.5px] text-fg-muted">
            文件 <span className="font-mono text-[13px] text-gold">{total}</span>
            {/* 源文件的体积主进程没有回传（`Task` 上只有产物体积），
                所以这里统计的是「已经转出来的总量」——一个都没转完时干脆不显示 */}
            {totalBytes > 0 && (
              <>
                <span className="mx-1.5 text-fg-faint">·</span>
                <span className="font-mono text-[13px] text-gold">{formatBytes(totalBytes)}</span>
              </>
            )}
          </span>
        </div>

        <div className="mt-2.5">
          <Divider />
        </div>
      </header>

      <div className="mt-4 shrink-0">
        <DropZone onDropPaths={(paths) => void addPaths(paths)} compact={total > 0} />
      </div>

      {/* 工具栏。`.btn-*` 只提供按钮外观，外面只叠加它没碰的（margin / shrink）。
          工具类现在压得住组件类（theme.css 的组件类在 `@layer components`），
          但**不要去盖 `.btn-primary` 的 background**——那是金色渐变，盖掉就不是主按钮了 */}
      <div className="mt-3 flex shrink-0 items-center gap-2">
        <button
          type="button"
          title="收入文件（Ctrl+O）"
          onClick={() => void collect(pickFiles)}
          className="btn-secondary shrink-0"
        >
          <Icon name="add-file" size={18} />
          收入文件
        </button>

        {/* 「打开文件夹」与「收入文件」的差别不只是选什么：它会**扫子文件夹**，
            而且入队之前会先把「将加入 N 个文件」给你看一次（含按排除清单跳过、
            读不了的目录，以及「只加这一层」那个退路）。这两件事都写在 title 里——
            用户点之前就能看见，而不是点完才发现自己收进来三千个文件 */}
        <button
          type="button"
          title="选一个文件夹：会扫它的子文件夹，先把「将加入 N 个文件」给你确认一次，点了才入队"
          onClick={() => void collect(pickFolder)}
          className="btn-secondary shrink-0"
        >
          <Icon name="folder" size={18} />
          收入文件夹
        </button>

        <button
          type="button"
          disabled={done + failed === 0}
          onClick={() => void clearFinished()}
          className="btn-ghost shrink-0 disabled:cursor-not-allowed disabled:opacity-40"
        >
          清空
        </button>

        <div className="ml-auto flex shrink-0 items-center gap-2">
          <span className="text-[11px] tracking-[0.5px] text-fg-faint">全部转为</span>
          <select
            value=""
            disabled={globalGroups.length === 0}
            onChange={(e) => void applyToAll(e.target.value)}
            className="select-dark disabled:cursor-not-allowed disabled:opacity-45"
          >
            {/* 受控组件，值恒为空串：选完一项之后 select 自己弹回这一行，
                不会留下一个「当前选中」的假状态——它不是一次选择，是一次批量动作 */}
            <option value="" disabled>
              选择目标格式
            </option>
            {globalGroups.map((group) => (
              <optgroup key={group.category} label={group.label}>
                {group.items.map((item) => (
                  <option key={item} value={item}>
                    {item.toUpperCase()}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </div>
      </div>

      <RejectedNotice items={rejected} onDismiss={clearRejected} />

      {/* 「转换完成之后的动作」的回执。与上面那条被拒清单一左一右地共存：
          前者是「哪些文件没收进来」，这条是「刚才复制的是什么」，两件事都不该被对方顶掉 */}
      <AfterActionNotice />

      {/* 表头。列宽与行共用 `QUEUE_COLUMNS`，分两处写字面量必然会错位 */}
      <div
        className="mt-3 grid shrink-0 items-center gap-3 border-b border-b-line px-2 pb-2 text-[11px] tracking-[0.5px] text-fg-faint"
        style={{ gridTemplateColumns: QUEUE_COLUMNS }}
      >
        <span>文件</span>
        <span>大小</span>
        <span>目标格式</span>
        <span>状态</span>
        <span className="text-right">操作</span>
      </div>

      <TaskList />

      <footer className="mt-3 flex shrink-0 items-center gap-3 pt-3">
        <span className="text-[11px] tracking-[0.5px] text-fg-faint">一切转换，尽在本机之中</span>

        {/* 「运行中 N」从任务镜像里数出来，不读设置里的静态上限：
            一批小文件两百毫秒转完、五行同时变绿时，旁边写着「并发 4」
            看起来就像限流根本没生效。上限是常数，运行中才是事实 */}
        <span className="text-[11px] text-fg-muted">
          运行中 <span className="font-mono text-gold">{running}</span>
          <span className="mx-1 text-fg-faint">/</span>
          上限 <span className="font-mono">{maxConcurrent}</span>
        </span>

        <button
          type="button"
          title="开始调律（Enter）"
          disabled={queued === 0}
          onClick={() => void start()}
          className="btn-primary ml-auto shrink-0"
        >
          <Icon name="convert" size={18} />
          开始调律（{queued}）
        </button>
      </footer>
    </div>
  )
}

/**
 * 页面标题下的菱形节点分隔线（设计 7.3）。
 *
 * `preserveAspectRatio="none"` 是承重的：素材画布是 240×16，而这里要的是
 * 「宽度 100%、高度 12px」。默认的 `xMidYMid meet` 会保持比例缩放，在 1000px 宽的
 * 内容区里只画出中间 180px 长的一小段（缩放系数取了较小的那一个），
 * 分隔线短得像是没铺满——不报错，只是短。
 * `none` 才让它横向拉满。
 */
function Divider(): React.JSX.Element {
  return (
    <svg viewBox="0 0 240 16" preserveAspectRatio="none" className="h-3 w-full" aria-hidden="true">
      <use href={`#${spriteIdFor('ornaments/divider.svg')}`} />
    </svg>
  )
}
