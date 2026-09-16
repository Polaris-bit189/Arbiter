import type { ReactNode } from 'react'

/**
 * 参数面板里**一块**参数的外壳：标题 + 内容 + 校验错误 + 应用/清除。
 *
 * 存在的理由是「三块参数面板必须长得一样、报错方式也必须一样」。它们各自的输入框与
 * 校验规则完全不同（裁剪是两个秒数、体积是一个字节数、缩放是两个像素数），
 * 但**下面这几行是共通的**，而且正是最容易各写各的那几行：
 *
 * - **校验不过就不给点「应用」**（`disabled`），并且**说清为什么**（`reason`）。
 *   主进程对非法参数是**静默不办**的（schema 直接拒），而「点了应用什么都没发生」
 *   是这个项目最不能接受的形态。
 * - **主进程拒了要说出来**（`failedText`）。`setOptions` 回 `false` 的四种情形
 *   （任务不在 / 正在跑 / 这一类不该有这项参数 / 参数本身是坏的）在界面上留下的痕迹
 *   一模一样——什么都没变。不写这一句，用户看到的就是「按钮坏了」。
 * - **「清除」只在真的设过的时候出现**。一个点了不会发生任何事的按钮比没有更糟。
 *
 * ⚠️ **每块面板在「应用」时都必须交出完整的 `TaskOptions`**（`setOptions` 是整体替换
 * 语义），用 `@shared/options` 的 `withOption` 拼。各交各的那一个字段的话，
 * 第二块面板一应用就会把第一块的静默抹掉。
 */
export function OptionsSection({
  title,
  reason,
  failedText,
  busy,
  canClear,
  onApply,
  onClear,
  children
}: {
  title: string
  /** 校验不过的原因。`null` = 通过 */
  reason: string | null
  /** 主进程拒了之后显示的那句话 */
  failedText: string
  busy: boolean
  /** 这一项当前**已经设过**（决定「清除」按钮出不出现） */
  canClear: boolean
  onApply: () => void
  onClear: () => void
  children: ReactNode
}): React.JSX.Element {
  return (
    <div className="border-t border-line pt-2.5 first:border-t-0 first:pt-0">
      <p className="text-[11px] tracking-[0.5px] text-fg-faint">{title}</p>
      {children}
      {reason !== null && <p className="mt-1.5 text-[11px] text-bad">{reason}</p>}
      {failedText !== '' && <p className="mt-1.5 text-[11px] text-bad">{failedText}</p>}

      <div className="mt-2 flex items-center gap-2">
        <button
          type="button"
          className="btn-primary"
          disabled={reason !== null || busy}
          onClick={onApply}
        >
          应用
        </button>
        {canClear && (
          <button type="button" className="btn-secondary" disabled={busy} onClick={onClear}>
            清除
          </button>
        )}
      </div>
    </div>
  )
}
