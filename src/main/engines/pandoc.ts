import { existsSync } from 'fs'
import { join } from 'path'
import { bundledEnginePath } from '../core/appPaths'
import { getSettings } from '../core/settings'

/**
 * pandoc 可执行文件的解析。
 *
 * 只有 `md/txt/html/rst → docx` 这一类**跨标记语言**的转换才需要它：markdown 的
 * 标题、列表、表格要变成 Word 的样式，靠正则改写 HTML 是做不来的。同为文本层的
 * html/md/txt 互转由 converters/document.ts 的纯 JS 路径覆盖，不惊动它。
 *
 * 它是单个自包含的 exe（221 MiB），不需要任何 DLL，所以这里没有「同目录还得有谁」
 * 那类判据——`existsSync` 过了就是能用。提取见 `scripts/fetch-pandoc.mjs`。
 */

let cache: string | null | undefined

/** 打包后随包放在 resources/engines/ 下（extraResources，不进 asar） */
function bundled(): string | null {
  const candidate = bundledEnginePath('pandoc', 'pandoc.exe')
  return existsSync(candidate) ? candidate : null
}

/**
 * 按需下载的落地位置：解到 `engineDir/pandoc/pandoc.exe`。
 *
 * 与 `heavy.ts` 的 `downloaded()` 同构——那个模块先有这条候选，这里一直没有，
 * 于是「下载完了却永远找不到」这件事在 pandoc 这一侧**根本不可能被发现**：
 * 下载那一侧当时也还没接上（见 `core/engineInstall.ts` 的文件头）。
 */
function downloaded(): string | null {
  const candidate = join(getSettings().engineDir, 'pandoc', 'pandoc.exe')
  return existsSync(candidate) ? candidate : null
}

/**
 * 用户自己装过 pandoc 就直接复用，省掉 39 MB 的下载。
 *
 * 三个候选对应三种装法：机器级安装（Program Files）、32 位机器级安装、
 * 以及 Windows 安装器默认的**用户级**安装（`%LOCALAPPDATA%\Pandoc\`）。
 * 最后一个最常见，别漏。
 */
function systemInstalled(): string | null {
  const roots = [
    process.env.ProgramFiles,
    process.env['ProgramFiles(x86)'],
    process.env.LOCALAPPDATA
  ]

  for (const root of roots) {
    if (!root) continue
    const candidate = join(root, 'Pandoc', 'pandoc.exe')
    if (existsSync(candidate)) return candidate
  }
  return null
}

/**
 * 顺序与 `heavy.ts` 一致：随包内置优先（版本与行为我们验过）→ 按需下载那份
 * （版本也是我们挑的）→ 系统安装（版本未知）。
 *
 * 系统安装**排在下载之后**是有意为之：用户机器上的 pandoc 可能是 2.x，
 * 而我们验过 3.9 的 `-f markdown` 那套参数（约束 14），版本漂了报错方式也漂。
 */
export function pandocEngine(): string | null {
  if (cache === undefined) cache = bundled() ?? downloaded() ?? systemInstalled()
  return cache
}

/**
 * 清掉缓存，强制下一次 `pandocEngine()` 重新探测。
 *
 * 必须有这个函数，是因为 `cache` 是**三态**的：`undefined` 是「还没探过」，
 * `null` 是「探过了、没有」。探测失败的结果同样会被写进缓存并永久生效——
 * 首次解析没找到引擎，此后无论磁盘上多了什么，`pandocEngine()` 都一直返回 null。
 * 用户可见的表现是：关于页显示「pandoc 未就绪」→ 用户照提示装好（或按需下载完成）
 * → 回到关于页**永远还是未就绪**，只能重启应用。
 *
 * 所以凡是「用户可能在这之后才补上引擎」的入口（重新检测、按需下载落盘、
 * 引擎目录设置变更）都要在重新探测前调一次它。
 */
export function resetPandocCache(): void {
  cache = undefined
}
