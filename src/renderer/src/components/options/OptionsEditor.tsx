import type { Task } from '@shared/types'
import { canFilter, canOutputSize, canUseQuality } from '@shared/options'
import { canTrim } from '@shared/trim'
import { TrimSection } from './TrimSection'
import { FiltersSection } from './FiltersSection'
import { OutputSection } from './OutputSection'
import { QualitySection } from './QualitySection'

/**
 * 任务参数的**整块**面板：裁剪 + 处理链 + 输出约束 + 编码质量档，按类别显示其中几块。
 *
 * 挂在**行下方**（绝对定位），与失败日志那个面板同一个套路：队列行的行高是写死的
 * 56px（表头与数据靠同一套列宽对齐），在行内展开会把整张表撑变形。
 *
 * ## 为什么是一个面板而不是每项参数一个按钮
 *
 * 从前的裁剪面板自己带一个「裁剪」按钮。参数长到三块之后，那样会变成一排按钮
 * （裁剪 / 缩放 / 体积），而每个按钮都要自己判断「这条任务该不该有这一项」——
 * 判据散在三个地方，加第四项时必然漏掉一处，漏掉的表现是「按钮出现了，点开是空的」。
 * 现在按钮只有一个（`TaskCard` 上的「参数」），出不出现由 `hasAnyOptions()` 一处决定，
 * 里面放哪几块由这里的三行 `can…` 决定。
 *
 * ## 四块的顺序是固定的
 *
 * 裁剪 → 处理链 → 输出约束 → 编码质量档，与 `TaskOptions` 里字段的声明顺序、以及摘要
 * 那一行的拼接顺序**一致**。三处同序不是洁癖：用户在面板里从上往下读到的次序，
 * 与卡片摘要上从左往右读到的次序对不上时，他会怀疑自己记错了参数。
 *
 * ⚠️ **输出约束与编码质量档互斥**（`-crf` 与 `-b:v` 同时给会让 x264 回到质量模式、
 * 把体积目标变成一句空话，见 `shared/options.ts` 的 `QUALITY_OUTPUT_EXCLUSIVE`）。
 * 两块**都照常渲染**，各自在设了对方时把「应用」禁掉并写明理由——不藏起任何一块，
 * 因为「面板不见了」会被读成「这个版本没有这个功能」，而真正的原因是它与另一项冲突。
 *
 * ⚠️ **几块面板各自独立 apply，但 `setOptions` 是整体替换语义**，所以每一块都必须用
 * `@shared/options` 的 `withOption` 交出**完整的** `TaskOptions`。这条是最容易写错的地方：
 * 写成 `{ trim }` 的话，「先设体积再设裁剪」的结果是体积静默消失，而卡片上那行摘要
 * 会少一半——用户会以为是界面没刷新。
 */
export function OptionsEditor({
  task,
  onClose
}: {
  task: Task
  onClose: () => void
}): React.JSX.Element {
  return (
    // `max-h` + 滚动是**承重的**，不是审美：面板是绝对定位挂在行下方的，而处理链可以长到
    // `MAX_FILTER_ACTIONS`（16）步——16 行参数撑出来的高度会越过窗口下沿，而 `body` 是
    // `overflow: hidden`，于是最底下那截（「应用」按钮）永远点不到。给一个上界之后
    // 面板自己滚，按钮和内容都够得着。
    <div
      className="scroll-dark absolute right-2 top-full z-20 max-h-[70vh] w-[460px] overflow-y-auto rounded-card border border-line-2 bg-abyss p-3"
      style={{ boxShadow: '0 8px 28px rgba(0, 0, 0, 0.55)' }}
    >
      {canTrim(task.category) && <TrimSection task={task} />}
      {canFilter(task.category) && <FiltersSection task={task} />}
      {canOutputSize(task.category) && <OutputSection task={task} />}
      {canUseQuality(task.category) && <QualitySection task={task} />}

      <div className="mt-2.5 flex items-center gap-2 border-t border-line pt-2.5">
        <button type="button" className="btn-ghost" onClick={onClose}>
          收起
        </button>
      </div>
    </div>
  )
}
