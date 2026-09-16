import sharp from 'sharp'

/**
 * 产物缩略图（R20）——把转换出来的图片按一个「小到不会撑爆上下文」的规格回给 agent。
 *
 * ## 为什么它是**补充**而不是主角
 *
 * 生态里**有客户端会静默丢掉 image block**（不是报错，是那一块根本不渲染、也不转发给模型）。
 * 所以这个模块的产出**永远**是 `content` 数组里的第二块，第一块必须是文字，
 * 而且**文字里必须已经写全了尺寸 / 体积 / 格式**这三件事——
 * 客户端把图丢了的时候，agent 靠那几个字照样能回答「转出来多大」。
 * 把事实只放在图里，等于把「能不能回答」押在客户端的渲染实现上。
 *
 * ## 三个数值都是硬的
 *
 * `≤512px` / `q70` / `≤200 KB` 是计划里就定死的（`docs/PLAN.md` §9.6 的 R20）。
 * ⚠️ 注意 base64 会把它放大到约 **4/3**：200 KB 的 JPEG 在线上是 **≈267 KB 的字符**。
 * 那是这一档的上限，不是常态——512px q70 的实拍通常落在 30~80 KB。
 *
 * ## 失败一律是 `null`，绝不抛
 *
 * 缩略图是**锦上添花**。为了它让一次成功的转换回一个错误，是把主次颠倒了；
 * 而「图没出来」与「这个格式本来就没有缩略图」在 agent 眼里是同一件事，
 * 都不需要它做任何补救动作。
 */
export interface Thumbnail {
  /** **裸 base64，不带 `data:` 前缀**——MCP 的 image block 要的就是这个形状 */
  data: string
  mimeType: 'image/jpeg'
  /**
   * 与那张图**对应的文字事实**。调用方必须把这几项写进 `content` 的第一块（文字块）里。
   *
   * 回来的是**产物本身的**尺寸与体积，不是缩略图的——缩略图是 512px 的降采样，
   * 拿它去回答「转出来多大」是错的。
   */
  facts: {
    width: number | null
    height: number | null
    bytes: number
    /** 产物扩展名，小写、不带点 */
    format: string
  }
}

/** 长边上限（px）。512 是计划里定的：够看清「这是不是我要的那张图」，又小到能塞进上下文 */
export const THUMBNAIL_MAX_EDGE = 512

/** 首次尝试的质量。装不下就按 `QUALITY_LADDER` 往下退 */
export const THUMBNAIL_QUALITY = 70

/** JPEG 字节上限。**判的是 JPEG 本身**，线上那份 base64 约是它的 1.33 倍 */
export const THUMBNAIL_MAX_BYTES = 200 * 1024

/**
 * 装不下时依次退的质量档。
 *
 * 退的是**质量**不是尺寸：512px 是「还看得清」的下限，再缩就真的只是色块了；
 * 而 q70 → q22 在缩略图这个尺度上肉眼差别很小。**最低那一档就是终点**——
 * 全都装不下时回 `null`（一张 512px 的 q22 JPEG 还超 200 KB 的图，只能是噪声图，
 * 那种图当缩略图本来也说明不了任何事）。
 */
const QUALITY_LADDER = [THUMBNAIL_QUALITY, 50, 35, 22]

/**
 * 哪些产物值得配缩略图。
 *
 * ⚠️ **这个白名单是「sharp 读得开」而不是「它是个图片格式」**：`bmp` / `ico` 也是图片，
 * 但 `sharp.format` 里根本没有这两项（约束 28 实测：喂真文件报 `unsupported image format`）。
 * 把它们写进来，表现是这两类产物**每次都白跑一遍 sharp 再失败**——
 * 不报错、只是白花时间，正是最难发现的那种浪费。
 *
 * 视频 / 音频 / 文档一律不在内：抽一帧要起 ffmpeg，那是另一个量级的成本，
 * 而 R20 的收益（让 agent 看一眼图）值不上。
 */
const THUMBNAILABLE = new Set(['jpg', 'jpeg', 'png', 'webp', 'avif', 'tiff', 'tif', 'gif'])

export function isThumbnailable(toExt: string): boolean {
  return THUMBNAILABLE.has(toExt.toLowerCase())
}

/**
 * 给一个产物做缩略图。**不做任何路径校验**——调用方（`server.ts`）拿到的
 * 是我们自己算出来的产物路径，不是 agent 给的（那条路有 `paths.ts` 的根白名单兜着）。
 *
 * `sizeBytes` 由调用方传进来，而不是这里 `stat()`：`Job` 上本来就有这个数，
 * 再量一次是白白多一次磁盘往返，而且两次读数还可能在极端情况下不一致。
 */
export async function makeThumbnail(
  outputPath: string,
  toExt: string,
  sizeBytes: number
): Promise<Thumbnail | null> {
  const format = toExt.toLowerCase()
  if (!isThumbnailable(format)) return null

  let width: number | null = null
  let height: number | null = null

  for (const quality of QUALITY_LADDER) {
    try {
      // `failOn: 'none'` 与 `inspect.ts` 同一姿态：读一个**可能已经损坏**的产物时，
      // 我们要的是「尽力给一张图」，而不是让 libvips 的严格校验把整件事掀掉
      const pipeline = sharp(outputPath, { failOn: 'none' }).rotate().resize({
        width: THUMBNAIL_MAX_EDGE,
        height: THUMBNAIL_MAX_EDGE,
        fit: 'inside',
        // **不放大**：一张 64×64 的图标不该被拉成 512×512——那只会变大变糊，
        // 与「缩略图」这三个字要办的事正好相反（同一个坑见约束里图片参数那一节）
        withoutEnlargement: true
      })
      const data = await pipeline.jpeg({ quality, progressive: true }).toBuffer()

      // 尺寸取**产物本身**的，不是这张缩略图的：文字事实要回答的是「转出来多大」
      if (width === null) {
        const meta = await sharp(outputPath, { failOn: 'none' }).metadata()
        width = meta.width ?? null
        height = meta.height ?? null
      }

      if (data.byteLength <= THUMBNAIL_MAX_BYTES) {
        return {
          data: data.toString('base64'),
          mimeType: 'image/jpeg',
          facts: { width, height, bytes: sizeBytes, format }
        }
      }
    } catch {
      // 读不开、解不了、写不出——一律当作「这个产物没有缩略图」。
      // **不重试下一个质量档**：能走到 catch 的都不是「太大」，
      // 再试一遍只是把同一个异常再抛一次。
      return null
    }
  }

  // 每一档都装不下。**如实回 null**，不要退回最后一档硬塞——
  // 那会产出一张超过约定上限的图，而调用方是照着上限写的文案。
  return null
}
