import { useToast } from '../store/useToast'

/**
 * 底部居中的一行提示，两秒自动消失（设计 6.5）。
 *
 * 只读 `message`：这行提示没有任何交互按钮，所以不需要 `hide()`——
 * 让用户点掉一条「收入 3 个」既没有意义，也只会挡住底栏。
 *
 * `pointer-events-none` 是必须的：这是个铺满整屏宽度的定位容器，
 * 不关掉指针事件的话，它会把底栏那一条的点击全部吃掉，而「点不动」的表现
 * 是「按钮没反应」，跟布局坏掉长得一模一样。
 */
export function Toast(): React.JSX.Element | null {
  const message = useToast((s) => s.message)
  if (message === null) return null

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-6 z-50 flex justify-center px-6">
      <div
        className="flex max-w-full items-center gap-2 rounded-card border border-gold-dim px-4 py-2 text-[13px] text-gold-pale"
        style={{
          // 暗金底：交付物里没有这一档底色，用 color-mix 现调，改 token 时会跟着变
          background: 'color-mix(in oklab, var(--c-gold-dim) 26%, var(--c-bg-elevated))',
          boxShadow: '0 6px 24px rgba(0, 0, 0, 0.45)'
        }}
        role="status"
      >
        <span aria-hidden="true" className="text-gold">
          ◆
        </span>
        <span className="truncate">{message}</span>
      </div>
    </div>
  )
}
