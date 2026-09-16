import { existsSync } from 'fs'
import { sep } from 'path'
import ffmpegStatic from 'ffmpeg-static'
import { bundledEnginePath } from '../core/appPaths'

/**
 * 引擎路径解析。
 *
 * dev 与打包后的路径完全不同，这是「开发时好好的、一打包就炸」的经典位置，
 * 所以统一在这里收口，并且逐个候选路径做存在性检查而不是硬编码。
 *
 * 路径**不在这里问 electron 要**：`app.isPackaged` / `process.resourcesPath` 由
 * `core/appPaths.ts` 注入。ffmpeg 是 MCP v1 的第一个引擎，这条模块必须能在
 * 不 import electron 的进程里被加载，见那份模块的文件头。
 */

/**
 * asar 里的路径**读得到、却 spawn 不了**：Electron 只给 `fs` 打了 asar 补丁，
 * `child_process` 拿到 asar 里的名字会直接 ENOENT。electron-builder 的 smartUnpack
 * 会把含 `.exe` / `.dll` / `.node` 的包整个解到 `app.asar.unpacked/` 下，所以这里
 * 换一个前缀。
 *
 * **少了这一步的表现是「dev 全绿、装上包第一次转视频就报 ENOENT」**，而且
 * `existsSync` 那条存在性检查还是**通过**的（fs 走 asar 补丁）——所以它骗得过所有
 * 非打包环境下的检查。dev 下路径里没有 `app.asar`，这个函数是恒等变换。
 */
function unpackedPath(file: string): string {
  const inside = `app.asar${sep}`
  const unpacked = `app.asar.unpacked${sep}`
  return file.includes(inside) ? file.replace(inside, unpacked) : file
}

let ffmpegCache: string | null = null

export function ffmpegPath(): string {
  if (ffmpegCache) return ffmpegCache

  const candidates: string[] = []

  // 打包后：引擎随包放在 resources/engines/ 下（extraResources，不进 asar）
  // 开发期：同一个函数的另一条分支落在仓库根，那儿通常没有 ffmpeg，existsSync 自会跳过
  candidates.push(bundledEnginePath('ffmpeg', 'ffmpeg.exe'))

  // 开发期：ffmpeg-static 的 postinstall 已经把二进制下好了
  // 打包后它落在 asar 内（smartUnpack 会把 .exe 解到 app.asar.unpacked），见 unpackedPath
  if (typeof ffmpegStatic === 'string' && ffmpegStatic.length > 0) {
    candidates.push(unpackedPath(ffmpegStatic))
  }

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      ffmpegCache = candidate
      return candidate
    }
  }

  throw new Error('找不到 ffmpeg 可执行文件，请重新安装依赖')
}

/** 供 UI 展示引擎状态用 */
export function ffmpegAvailable(): boolean {
  try {
    ffmpegPath()
    return true
  } catch {
    return false
  }
}
