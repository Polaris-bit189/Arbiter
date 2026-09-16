import { useState } from 'react'
import { spriteIdFor } from '../lib/icons'
import { cn } from '../lib/cn'

interface Props {
  onDropPaths: (paths: string[]) => void
  /** 队列里已经有文件时压成一条窄栏。**仍然可以继续追加**，只是不再占半屏 */
  compact?: boolean
}

/**
 * 四角饰（设计 7.3）。
 *
 * 素材 `corner-ornament.svg` 画的是**左上**方向的 L（路径 `M4 44V8…h36` 贴的是自己
 * 那格的上沿与左沿，菱形落在 (6,6)）。所以把它摆到哪个角，就得让它的 L 朝哪个角张开：
 * 右下要水平镜像、左下要垂直镜像、右上要两次都镜像。
 *
 * 设计文档 10.6 说这个文件是「左下角方向」并把 `scaleX(-1)` 标成右下——那是文档
 * 与素材对不上（图形本身是左上方向的），照文档的标注摆，四个角饰会全部朝内。
 * 这里按**几何**来，文档里那四个镜像变换本身没错，只是标签串了位。
 */
const CORNERS = [
  { position: 'left-1.5 top-1.5', transform: undefined },
  { position: 'right-1.5 top-1.5', transform: 'scaleX(-1)' },
  { position: 'bottom-1.5 left-1.5', transform: 'scaleY(-1)' },
  { position: 'bottom-1.5 right-1.5', transform: 'scale(-1,-1)' }
] as const

/**
 * 拖拽区。
 *
 * 拖拽事件挂在**外层**容器上，内层内容整体 `pointer-events-none`：内容里有图标和
 * 三段文字，鼠标划过子元素时会在父元素上触发一次 `dragleave`、再触发一次 `dragover`，
 * 高亮就会疯狂闪烁。关掉内层的指针事件，`dragleave` 只在真正离开外框时触发一次。
 */
export function DropZone({ onDropPaths, compact = false }: Props): React.JSX.Element {
  const [over, setOver] = useState(false)

  const handleDrop = (e: React.DragEvent<HTMLDivElement>): void => {
    e.preventDefault()
    setOver(false)

    // Electron 32 起 File.path 已被移除，只能经 preload 的 webUtils.getPathForFile。
    // 返回空串说明该 File 是 JS 构造的、不对应磁盘文件，直接丢弃。
    const paths = Array.from(e.dataTransfer.files)
      .map((f) => window.api.pathForFile(f))
      .filter((p) => p.length > 0)

    if (paths.length > 0) onDropPaths(paths)
  }

  const dropPathsUnavailable = !window.api.capabilities.dropPaths

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault()
        setOver(true)
      }}
      onDragLeave={() => setOver(false)}
      onDrop={handleDrop}
      className={cn(
        'relative shrink-0 overflow-hidden rounded-card border transition-colors',
        compact ? 'h-[96px]' : 'h-[168px]',
        over ? 'border-gold bg-hover' : 'border-line-2 bg-panel'
      )}
    >
      {/* 蜂窝底纹 12%（设计 7.1 要求纹样一律 ≤16%，只做质感不抢焦点）。
          透明度落在这层的 opacity 上而不是纹样颜色上：将来换主题时，
          底纹整体跟着走，不会出现「底色变了、纹样还是老亮度」。 */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0"
        style={{ backgroundImage: 'var(--pattern-honeycomb)', opacity: 0.12 }}
      />

      {CORNERS.map((corner) => (
        <svg
          key={corner.position}
          width={24}
          height={24}
          aria-hidden="true"
          className={cn('pointer-events-none absolute', corner.position)}
          style={corner.transform ? { transform: corner.transform } : undefined}
        >
          <use href={`#${spriteIdFor('ornaments/corner-ornament.svg')}`} />
        </svg>
      ))}

      <div
        className={cn(
          'pointer-events-none relative flex h-full items-center justify-center px-6 text-center',
          compact ? 'flex-row gap-4' : 'flex-col gap-2'
        )}
      >
        <svg
          width={compact ? 48 : 86}
          height={compact ? 48 : 86}
          aria-hidden="true"
          className="shrink-0"
        >
          <use href={`#${spriteIdFor('ornaments/ring-ticks.svg')}`} />
        </svg>

        <div className="min-w-0">
          <p
            className={cn(
              'font-display text-fg-muted',
              compact ? 'text-[13px]' : 'text-[15px] tracking-wide'
            )}
          >
            {over ? '松手，令其归于此处' : '将文件拖入此间，令其归于应有之格式'}
          </p>

          {!compact && (
            <p className="mt-2 text-[11px] tracking-[0.5px] text-fg-faint">
              视频 · 音频 · 图片 · 文档 · 电子书 · 压缩包
            </p>
          )}

          {/* webUtils 不可用时拖拽会「毫无反应」，这种静默失败必须显式告知 */}
          {dropPathsUnavailable && (
            <p className="mt-1.5 text-xs font-medium text-bad">当前环境无法解析拖入文件的路径</p>
          )}
        </div>
      </div>
    </div>
  )
}
