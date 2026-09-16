import { spriteIdFor } from '../lib/icons'

/**
 * 黑金素材 sprite：把 `assets/icons/` 下的全部 SVG 合成一份 `<defs>`，
 * 每份素材变成一个 `<symbol id="…">`，由 `Icon` / `FormatTile` 用 `<use href="#id">` 引用。
 *
 * 为什么走 sprite 而不是逐个内联：
 * - 同一份素材在界面上会重复出现（队列里的格式砖、按钮上的图标），内联一次就是一份 DOM；
 * - `logo.svg` 内部有 `<linearGradient id="gGold">`，**全文档只能有一份**。
 *   多份内联的 logo 会让 Chromium 按先出现的 id 解析，渐变直接错乱。
 *   合进 sprite 后这个 id 全文档唯一，是合法的。
 *
 * id 一律由 `spriteIdFor()` 生成，**不要在这里自己拼字符串**——两侧各拼一次必然漂移，
 * 而 `<use href="#不存在的id">` 是静默失败（渲染空白，控制台最多一条 warning）。
 */

const SOURCES = import.meta.glob('../assets/icons/**/*.svg', {
  query: '?raw',
  eager: true,
  import: 'default'
}) as Record<string, string>

/** glob key 的前缀，去掉它就是 `spriteIdFor()` 要的相对路径（`formats/format-jpg.svg`）。 */
const ASSET_ROOT = '../assets/icons/'

/** 界面图标的金色改成 currentColor，好让它随着 CSS 的 color 变色（设计文档 §10.5）。 */
const FIXED_GOLD_STROKE = 'stroke="#C9A227"'
const THEMED_STROKE = 'stroke="currentColor"'

function relPathOf(key: string): string {
  return key.startsWith(ASSET_ROOT) ? key.slice(ASSET_ROOT.length) : key
}

/** 一份素材源码 → 一个 `<symbol>`。取不到 viewBox / id 就返回空串（宁缺勿错）。 */
function toSymbol(source: string, relPath: string): string {
  // ui/ 才换色：格式砖与纹样保留固定金色（设计文档 §10.5）。
  const themed = relPath.startsWith('ui/')
    ? source.split(FIXED_GOLD_STROKE).join(THEMED_STROKE)
    : source

  const rootTag = /<svg\b([^>]*)>/.exec(themed)
  if (rootTag === null) return ''

  const attrs = rootTag[1] ?? ''
  const viewBox = /viewBox\s*=\s*"([^"]*)"/.exec(attrs)?.[1]
  if (viewBox === undefined || viewBox.length === 0) return ''

  const id = spriteIdFor(relPath)
  if (id.length === 0) return ''

  // **根标签上的表现属性必须原样搬到 `<symbol>` 上**：界面图标整套样式
  // （`fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap/-linejoin`）
  // 全写在根标签里，只搬 viewBox 的话它们会跟着一起丢掉——图标渲染成实心黑块，
  // 而 `<use>` 那一侧不报任何错，与 id 拼错是同一类静默失败。
  // xmlns 不必带（sprite 本身就活在 SVG 命名空间里），viewBox 由上面单独发出。
  const kept = attrs
    .replace(/\s*xmlns(:[\w-]+)?\s*=\s*"[^"]*"/gi, '')
    .replace(/\s*viewBox\s*=\s*"[^"]*"/i, '')
    .trim()

  // 只换根标签（首个 `<svg …>`）与结尾的 `</svg>`，素材内部没有嵌套的 svg。
  const body = themed.replace(/<svg\b[^>]*>/, '').replace(/<\/svg>\s*$/, '')

  return `<symbol id="${id}" viewBox="${viewBox}"${kept.length > 0 ? ` ${kept}` : ''}>${body}</symbol>`
}

// 排序只为让产物稳定（便于肉眼对照），不排序也不影响正确性。
const SYMBOLS = Object.keys(SOURCES)
  .sort()
  .map((key) => toSymbol(SOURCES[key] ?? '', relPathOf(key)))
  .filter((symbol) => symbol.length > 0)

const SPRITE_MARKUP = `<defs>${SYMBOLS.join('')}</defs>`

/** 挂一次即可（App 顶层）。渲染成 `<svg aria-hidden style="display:none"><defs>…</defs></svg>`。 */
export function Sprite(): React.JSX.Element {
  return (
    <svg
      aria-hidden="true"
      style={{ display: 'none' }}
      dangerouslySetInnerHTML={{ __html: SPRITE_MARKUP }}
    />
  )
}
