import { existsSync } from 'fs'
import { basename, dirname, join } from 'path'
import { path7za } from '7zip-bin'
import { bundledEnginePath } from '../core/appPaths'

/**
 * 7-Zip 可执行文件的解析。
 *
 * 有两档二进制，能力差别很大，必须选对：
 *
 *   `7z.exe` + `7z.dll`  完整版，支持 RAR / RAR5 / ISO / CAB 等专有格式。
 *   `7za.exe`            standalone 精简版，**一个 RAR 编解码器都没有**，
 *                        拿到 .rar 直接报 "Cannot open the file as archive"。
 *
 * `7zip-bin` 这个 npm 包发的正是 `7za.exe`，所以 RAR 必须靠完整版。
 * 完整版从官方包的 win/x64 里提取，见 `scripts/fetch-bundled-engines.mjs`。
 */

export interface SevenZipEngine {
  path: string
  /** 能不能解 RAR。不能的话遇到 .rar 要给明确提示，而不是让它报个含糊的错 */
  supportsRar: boolean
}

let cache: SevenZipEngine | null | undefined

/** 打包后引擎随包放在 resources/engines/ 下（extraResources，不进 asar） */
function bundledFull(): string | null {
  const candidate = bundledEnginePath('7zip-full', '7z.exe')
  return existsSync(candidate) ? candidate : null
}

/** 用户自己装过 7-Zip 就直接复用，不重复下载（阶段 5 的四段式解析里也是这个优先级） */
function systemFull(): string | null {
  for (const key of ['ProgramFiles', 'ProgramFiles(x86)'] as const) {
    const base = process.env[key]
    if (!base) continue
    const candidate = join(base, '7-Zip', '7z.exe')
    if (existsSync(candidate)) return candidate
  }
  return null
}

/**
 * 完整版 `7z.exe` 是个瘦壳，真正的编解码器都在同目录的 `7z.dll` 里，
 * 缺了它 `7z.exe` 根本起不来。所以「有同名 DLL」正好也是「这是完整版」的判据，
 * 比每次启动都跑一遍 `7z i` 解析格式表便宜得多（那是一次几十毫秒的进程启动）。
 */
function isFullBuild(exe: string): boolean {
  return basename(exe).toLowerCase() === '7z.exe' && existsSync(join(dirname(exe), '7z.dll'))
}

function resolve(): SevenZipEngine | null {
  for (const candidate of [bundledFull(), systemFull()]) {
    if (candidate) return { path: candidate, supportsRar: isFullBuild(candidate) }
  }

  // 兜底：7zip-bin 发的 7za.exe。解 zip/7z/tar 够用，只是没有 RAR。
  if (typeof path7za === 'string' && existsSync(path7za)) {
    return { path: path7za, supportsRar: false }
  }

  return null
}

export function sevenZipEngine(): SevenZipEngine | null {
  if (cache === undefined) cache = resolve()
  return cache
}

/**
 * 清掉缓存，强制下一次 `sevenZipEngine()` 重新探测。
 *
 * 必须有这个函数，是因为 `cache` 是**三态**的：`undefined` 是「还没探过」，
 * `null` 是「探过了、没有」。探测失败的结果同样会被写进缓存并永久生效——
 * 首次解析没找到引擎，此后无论磁盘上多了什么，`sevenZipEngine()` 都一直返回 null。
 * 用户可见的表现是：关于页显示「7-Zip 未就绪」→ 用户照提示装好（或按需下载完成）
 * → 回到关于页**永远还是未就绪**，只能重启应用。
 *
 * 所以凡是「用户可能在这之后才补上引擎」的入口（重新检测、按需下载落盘、
 * 引擎目录设置变更）都要在重新探测前调一次它。
 */
export function resetSevenZipCache(): void {
  cache = undefined
}

export function sevenZipPath(): string {
  const engine = sevenZipEngine()
  if (!engine) {
    throw new Error(
      '找不到 7-Zip 可执行文件，请重新安装依赖或运行 scripts/fetch-bundled-engines.mjs'
    )
  }
  return engine.path
}

export function sevenZipSupportsRar(): boolean {
  return sevenZipEngine()?.supportsRar ?? false
}
