import { spriteIdFor } from '../lib/icons'

interface Props {
  /** 素材名，即 `ui/icon-<name>.svg` 里的 `<name>`，如 `add-file`、`arrow-right`。 */
  name: string
  /** 边长，默认 24（素材画布就是 24×24）。 */
  size?: number
  /** 用 text-* 之类的工具类控制颜色：界面图标的描边已改成 currentColor。 */
  className?: string
}

/**
 * 界面图标。
 *
 * ```tsx
 * <Icon name="add-file" size={24} className="text-amber-400" />
 * ```
 *
 * id 走 `spriteIdFor()`，与 `Sprite.tsx` 里写 `<symbol id>` 用的是同一个函数——
 * 拼错了不会有任何报错，只会渲染出一片空白，所以这里绝不允许手写 `#i-…`。
 */
export function Icon({ name, size = 24, className }: Props): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} className={className} aria-hidden="true">
      <use href={`#${spriteIdFor(`ui/icon-${name}.svg`)}`} />
    </svg>
  )
}
