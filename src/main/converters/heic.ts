import { readFile } from 'fs/promises'
import type { HeifImageHandle, HeifImageList } from 'heic-decode'

/**
 * HEIC/HEIF 解码——两个主力引擎都指望不上，只能走 WASM 版 libheif。
 *
 * 为什么不能直接用 sharp 或 ffmpeg（都用真实 iPhone 照片实测过）：
 *
 *  - **sharp**：预编译的 libvips 出于 HEVC 专利剔除了 libde265。最有迷惑性的是
 *    它能把元数据读出来——`metadata()` 会正常返回 `format:'heif'` 和正确尺寸，
 *    看起来一切正常；但一取像素就报 `bad seek to <文件末尾之后的偏移>`，
 *    而那个偏移量在原文件里根本不存在（用 box 解析器逐层核对过，文件结构严丝合缝）。
 *  - **ffmpeg-static 6.1.1-essentials**：连 heif 解复用器都没有（`-demuxers` 里只有
 *    `mov,mp4,...`），只有 `avif` 复用器且仅用于编码。它会拿 .heic 当 MP4 解，
 *    报 `moov atom not found`。
 *
 * libheif-js 把这些编解码器都编进 WASM 了，解出 RGBA 后交给 sharp 编码成任意目标格式。
 */

export interface HeifPixels {
  data: Buffer
  width: number
  height: number
}

type DecodeAllFn = (options: { buffer: Buffer }) => Promise<HeifImageList>

interface DecodeModule {
  default?: unknown
  all?: unknown
}

// WASM 包有 8.5 MB，而且是 base64 内嵌在 JS 里的——不做懒加载的话，
// 每次启动都要白解析这 8.5 MB，哪怕这次一个 HEIC 都不转。
let loader: Promise<{ all: DecodeAllFn }> | null = null

function loadDecoder(): Promise<{ all: DecodeAllFn }> {
  loader ??= import('heic-decode').then((raw) => {
    // heic-decode 是 `module.exports = one` 的 CJS 包，不同转译模式下
    // default 落在哪一层会变，所以直接读 all 这个具名成员，两种都能命中
    const mod = raw as DecodeModule
    const all = mod.all ?? (mod.default as DecodeModule | undefined)?.all
    if (typeof all !== 'function') {
      throw new Error('heic-decode 的 all() 不可用，依赖可能被破坏了')
    }
    return { all: all as DecodeAllFn }
  })
  return loader
}

/**
 * 挑出真正的主图。
 *
 * 不能像 `heic-decode` 默认那样直接取 `data[0]`——libheif 是按文件顺序返回图像的，
 * 而很多 HEIC 会把缩略图排在前面。实测 `d3.heic`（iPhone 拍的实图）里 5 张图，
 * 前四张都是 480x320 的缩略图/连拍帧，真正的主图 1000x680 排在最后。
 * 取 data[0] 就会静默地转出一张缩略图——不报错，只是画质莫名其妙地差。
 *
 * 优先按 sharp 读出的主图尺寸精确匹配，匹配不上再退到「面积最大」。
 */
function pickPrimary(
  list: HeifImageList,
  expected?: { width: number; height: number }
): HeifImageHandle {
  if (expected) {
    const exact = list.find((i) => i.width === expected.width && i.height === expected.height)
    if (exact) return exact
  }

  let best = list[0]
  for (const image of list) {
    if (image.width * image.height > best.width * best.height) best = image
  }
  return best
}

/**
 * 把 HEIC/HEIF 解成 RGBA 原始像素。
 *
 * `expected` 是 sharp 读出的主图尺寸（sharp 读 HEIC 元数据是好的，只是取不到像素），
 * 用来从多张图中精准挑出主图。
 *
 * 关于方向：libheif 解码时会应用容器里的 `irot`/`imir` 变换，而 Apple 正是用 `irot`
 * 记录旋转的（所以这些实拍样本的 EXIF orientation 全是空的，方向信息根本不在 EXIF 里）。
 * 因此这里**不再额外旋转**，否则会把已经转正的竖拍照片再转回去。
 */
export async function decodeHeif(
  input: string,
  expected?: { width: number; height: number }
): Promise<HeifPixels> {
  const { all } = await loadDecoder()

  const list = await all({ buffer: await readFile(input) })
  try {
    if (list.length === 0) throw new Error('HEIC 里没有找到图像')

    const primary = pickPrimary(list, expected)
    const decoded = await primary.decode()

    // Buffer.from(Uint8ClampedArray) 会复制一份：原始像素还在 WASM 堆上，
    // dispose() 之后就失效了，必须先把数据搬出来
    return { data: Buffer.from(decoded.data), width: decoded.width, height: decoded.height }
  } finally {
    list.dispose()
  }
}
