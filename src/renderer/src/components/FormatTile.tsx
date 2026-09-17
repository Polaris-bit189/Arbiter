import { tileForExt } from '../lib/icons'

interface Props {
  /** 源文件扩展名（`extOf()` 那种不带点的裸扩展名）。认不出来就落通用的 FILE 砖。 */
  ext: string
  /** 边长，默认 36（列表里的推荐尺寸，见素材 README）。 */
  size?: number
  className?: string
}

/**
 * 格式图标砖。
 *
 * ```tsx
 * <FormatTile ext={fromExt} size={36} />
 * ```
 *
 * 砖的画布一律 64×64，所以 viewBox 写死；具体用哪块砖由 `tileForExt()` 决定
 * （小写化 → 精确命中 → 别名表 → `f-file`），这里不重复任何格式判断。
 */
export function FormatTile({ ext, size = 36, className }: Props): React.JSX.Element {
  return (
    <svg viewBox="0 0 64 64" width={size} height={size} className={className} aria-hidden="true">
      <use href={`#${tileForExt(ext)}`} />
    </svg>
  )
}
