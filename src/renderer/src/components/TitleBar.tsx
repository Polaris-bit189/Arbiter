import { useEffect, useState } from 'react'
import { TITLEBAR_HEIGHT } from '@shared/theme'
import { Icon } from './Icon'
import { spriteIdFor } from '../lib/icons'
import { cn } from '../lib/cn'

/**
 * 自绘标题栏。
 *
 * `frame: false` 之后原生 caption 整条没有了，连它顺手提供的两件事一起消失，
 * 都得自己补上：
 *
 *  - **最大化状态必须订阅**（`onWindowMaximizedChanged`），不能只在点按钮时读一次。
 *    用户还能双击标题栏、按 Win+↑、按 F11 改变窗口状态，那些路径都不经过我们的按钮；
 *    只读一次的话，中间那个图标会一直错着，而且**没有任何报错**。
 *  - 三键以及所有可点元素必须带 `.no-drag`。整条标题栏落在 `.drag-region` 里，
 *    而拖拽区里的元素是收不到鼠标事件的——漏一个就是「按钮点不动」。
 *
 * 高度取自 `@shared/theme`：金色发丝线与页面区的起点都挂在它上面，
 * 主进程与渲染层各写一个 44 迟早漂移。
 *
 * 已知并接受的取舍：**失去 Windows 11 悬停最大化按钮弹 Snap Layouts**
 * （那要求响应 WM_NCHITTEST，Electron 的自绘按钮做不到）。
 */
export function TitleBar(): React.JSX.Element {
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    // 先订阅、再读快照。反过来（先读、后订阅）会留下一个窗口期：
    // 快照是异步回来的，中途到达的广播会被后到的旧值盖掉。
    const off = window.api.onWindowMaximizedChanged(setMaximized)
    void window.api.isWindowMaximized().then(setMaximized)
    return off
  }, [])

  const onDoubleClick = (event: React.MouseEvent<HTMLElement>): void => {
    // 双击三键不该改变窗口状态（事件会冒泡上来）
    if ((event.target as HTMLElement).closest('.no-drag') !== null) return
    void window.api.toggleMaximizeWindow()
  }

  return (
    <header
      onDoubleClick={onDoubleClick}
      style={{ height: TITLEBAR_HEIGHT }}
      className="drag-region flex shrink-0 items-center gap-2.5 bg-abyss px-3.5"
    >
      <svg width={26} height={26} className="shrink-0" aria-hidden="true">
        <use href={`#${spriteIdFor('logo.svg')}`} />
      </svg>
      <span className="grad-gold-text font-display text-[16px] font-semibold tracking-[5px]">
        调律者转换器
      </span>

      <div className="flex-1" />

      <div className="flex items-center gap-1.5">
        <CaptionButton label="最小化" onClick={() => void window.api.minimizeWindow()}>
          <Glyph>
            <path d="M7 12h10" />
          </Glyph>
        </CaptionButton>

        <CaptionButton
          label={maximized ? '向下还原' : '最大化'}
          onClick={() => void window.api.toggleMaximizeWindow()}
        >
          <Glyph>
            {maximized ? (
              <>
                <rect x="9" y="5" width="10" height="10" rx="1" />
                <path d="M6 9v9a1 1 0 0 0 1 1h9" />
              </>
            ) : (
              <rect x="7" y="7" width="10" height="10" rx="1" />
            )}
          </Glyph>
        </CaptionButton>

        <CaptionButton label="关闭" danger onClick={() => void window.api.closeWindow()}>
          {/* 图形素材里现成的 close 走 sprite；最小化 / 最大化是两笔，素材里没有同形 */}
          <Icon name="close" size={13} />
        </CaptionButton>
      </div>
    </header>
  )
}

interface CaptionButtonProps {
  label: string
  onClick: () => void
  /** 关闭键悬停变暖红，与设计里其余破坏性动作同一套语义 */
  danger?: boolean
  children: React.ReactNode
}

function CaptionButton({
  label,
  onClick,
  danger,
  children
}: CaptionButtonProps): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className={cn(
        'no-drag grid h-7 w-9 place-items-center rounded-[4px] text-gold-dim transition-colors',
        danger ? 'hover:bg-panel hover:text-bad' : 'hover:bg-panel hover:text-gold-bright'
      )}
    >
      {children}
    </button>
  )
}

/** 三键的线条画布：24 的 viewBox 缩到 13，与图形素材的 1.5 描边同构 */
function Glyph({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <svg
      width={13}
      height={13}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  )
}
