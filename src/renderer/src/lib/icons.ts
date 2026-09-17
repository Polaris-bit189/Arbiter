/**
 * 图标素材的命名规则 —— sprite symbol id 的唯一真相源。
 *
 * 这个模块**必须保持零依赖**：不许 import React，不许用 `import.meta.glob` / `?raw`
 * 这类 Vite 专有语法。`scripts/` 下的断言要用 tsx 直接加载它，一旦引入这些东西就加载不了，
 * 断言与 `npm run falsify` 会整体失效。
 *
 * 素材清单见 `src/renderer/src/assets/icons/README.md`，命名规则：
 * `formats/format-<ext>.svg` / `ui/icon-<name>.svg` / `ornaments/<name>.svg` / `logo.svg`。
 */

/** 目录前缀 → symbol id 前缀。`logo.svg` 在根下，不带前缀。 */
const DIR_PREFIX: Readonly<Record<string, string>> = {
  formats: 'f-',
  ui: 'i-',
  ornaments: 'o-'
}

/** 目录内文件名本身自带的前缀，拼 id 时要去掉（避免出现 `f-format-jpg` 这种）。 */
const FILE_PREFIX: Readonly<Record<string, string>> = {
  formats: 'format-',
  ui: 'icon-'
}

/**
 * 素材相对路径 → sprite 里的 symbol id。**这是 id 的唯一真相源。**
 *
 * ```
 * 'formats/format-jpg.svg'    → 'f-jpg'
 * 'ui/icon-add-file.svg'      → 'i-add-file'
 * 'ornaments/ring-ticks.svg'  → 'o-ring-ticks'
 * 'logo.svg'                  → 'logo'
 * ```
 *
 * 两侧（Sprite 里写 `<symbol id>`、Icon/FormatTile 里写 `<use href>`）都必须走这个函数。
 * 各拼一次必然会漂移，而 `<use href="#不存在的id">` 是**静默失败**——渲染成空白，
 * 控制台最多一条 warning，正是这个项目最忌讳的那类 bug。
 */
export function spriteIdFor(relPath: string): string {
  const parts = relPath
    .replace(/\\/g, '/') // 万一拿到 Windows 反斜杠路径（Vite 的 glob key 是正斜杠，这里是兜底）
    .replace(/^\.?\//, '')
    .split('/')
    .filter((p) => p.length > 0)

  const file = parts.pop() ?? ''
  const stem = file.endsWith('.svg') ? file.slice(0, -'.svg'.length) : file
  if (stem.length === 0) return ''

  const dir = parts.pop() ?? ''
  const prefix = DIR_PREFIX[dir]
  if (prefix === undefined) return stem // 根下（logo）与未知目录：原样当 id

  const own = FILE_PREFIX[dir] ?? ''
  const name = own.length > 0 && stem.startsWith(own) ? stem.slice(own.length) : stem
  return prefix + name
}

/**
 * 别名表。**只做「同一个格式的不同写法」的归一，不做类别回退。**
 */
const EXT_ALIASES: Readonly<Record<string, string>> = {
  jpeg: 'jpg',
  tif: 'tiff',
  markdown: 'md'
}

/**
 * 有专属格式砖的扩展名（供断言用）。
 *
 * 这只是「`formats/` 下真的存在 `format-<ext>.svg`」的那批；别名（`jpeg`/`tif`/`markdown`）
 * 能解析到砖但不在此列。刻意不含 `file`——`format-file.svg` 是回退砖，不是某个扩展名的砖。
 */
export const TILE_EXTS: readonly string[] = [
  '7z',
  'bmp',
  'docx',
  'epub',
  'flac',
  'gif',
  'jpg',
  'md',
  'mkv',
  'mov',
  'mp3',
  'mp4',
  'pdf',
  'png',
  'rar',
  'svg',
  'tiff',
  'txt',
  'wav',
  'webp',
  'xlsx',
  'zip'
]

/**
 * 扩展名 → 格式砖的 symbol id。**两级回退**：小写化 → 精确命中 → 别名表 → `'f-file'`。
 *
 * 刻意**不做「按 category 回退到某个代表砖」**：给 `.heic` 显示一张 PNG 砖是在骗用户，
 * 宁可统一落 `format-file.svg`。应用支持 72 个源格式而砖只有 23 个，落回 `f-file` 是常态。
 *
 * 收 `extOf()` 那种不带点的裸扩展名；顺手容忍前导点与空白（`'.jpg'` / `' JPG '`）。
 */
export function tileForExt(ext: string): string {
  let normalized = ext.trim().toLowerCase()
  if (normalized.startsWith('.')) normalized = normalized.slice(1)

  const hit = EXT_ALIASES[normalized] ?? normalized
  return TILE_EXTS.includes(hit) ? `f-${hit}` : 'f-file'
}
