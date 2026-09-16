/**
 * `heic-decode` 没带类型声明，这里按它的实际实现手写一份。
 * 依据是 node_modules/heic-decode/index.js 与 lib.js：
 *   module.exports = one        // one({buffer}) → { width, height, data }
 *   module.exports.all = all    // all({buffer}) → 带 dispose() 的图像数组
 */
declare module 'heic-decode' {
  export interface HeifDecodedImage {
    width: number
    height: number
    /** RGBA 原始像素，长度 = width * height * 4 */
    data: Uint8ClampedArray
  }

  export interface HeifImageHandle {
    width: number
    height: number
    decode: () => Promise<HeifDecodedImage>
  }

  /**
   * 图像数组，附带一个不可枚举的 dispose()。
   * 里面引用着 WASM 堆上的解码结果，用完必须 dispose，否则内存不释放。
   */
  export interface HeifImageList extends Array<HeifImageHandle> {
    dispose: () => void
  }

  export function all(options: { buffer: Buffer }): Promise<HeifImageList>

  export default function decode(options: { buffer: Buffer }): Promise<HeifDecodedImage>
}
