import { createDecipheriv } from 'crypto'

/**
 * 各家音乐 App 的**加密容器**格式：把容器解开，拿回里面那个真正的音频文件。
 *
 * ## 这一层是纯函数，零 I/O、零 electron
 *
 * 收一个 `Uint8Array`，回一个 `Uint8Array` 加一个扩展名。这样它能脱离窗口与文件系统
 * 直接测（`scripts/test-encmusic.ts` 就是这么跑的），也符合本仓「判据住在纯函数里」
 * 的老规矩。真正的落盘与转码在 `./index.ts`。
 *
 * ## ⚠️ 这里**不做解码**，也不碰元数据
 *
 * 解出来的东西原样交给 ffmpeg 或直接落盘。刻意不学那些参考实现去改写 ID3 / FLAC 的
 * 标签（它们会往产物里嵌封面、写标题）：那是**另一个功能**，而且会让我们对「产物是不是
 * 源里那一份音频」的判据变得含糊。本项目的职责是格式转换。
 *
 * ## 算法的出处与验证口径（**这一段比代码重要**）
 *
 * 本机 GitHub 直连不通，算法是从公开实现里读出来、再用**两个互相独立的实现对着核**的：
 *
 * | 容器 | 参照物 A | 参照物 B |
 * | --- | --- | --- |
 * | `.ncm` | `ncmdump`（PyPI，Python + pycryptodome） | `ncm-decrypt`（npm，crypto-js） |
 * | `.qmc*` / `.mflac` / `.mgg` | unlock-music（GitHub 镜像，TypeScript） | — |
 * | `.kwm` / `.xm` | unlock-music | — |
 * | `.kgm` / `.kgma` | unlock-music | — |
 *
 * ⚠️ **两个参照物在哪两处对上了，值得单独记**，因为那两处是光看一份实现最容易写错的：
 *
 * - **NCM 的音频起点**：Python 是 `seek(5) → u32 image_space → u32 image_size → 图像 →
 *   seek(image_space - image_size)`，JS 是 `getUint32(offset + 5) + 13`。
 *   两者都等于「跳过 `image_space + 13` 字节」，而**读 `image_space` 的位置都在
 *   元数据之后的第 5 个字节**。少读一个 gap 就会把音频起点整体挪 4 字节，
 *   产物是一堆白噪声而**没有任何地方报错**。
 * - **NCM 的密钥流**：Python 写 `stream * n` 之后取 `[1 : 1+len]`，JS 在生成时就把下标
 *   写成 `(i + 1) & 0xff`。两者都表示**要跳过密钥流的第一个字节**。
 *   漏掉这个 `1`，产物同样是白噪声——而这次连长度都对。
 *
 * ⚠️ **已知缺口（如实记下）**：我们**没有真实世界的样本**，所以这套东西验的是
 * 「与独立实现逐字节一致」，**不是**「真文件一定解得开」。生态里的同类项目
 * （比如 `HRuiCcc/music-geshizhuanhuan`）也是这么做的——它 README 里明写
 * 「测试样本全部为自建合成数据（正弦波），不含任何版权内容」，验证靠与四个独立实现
 * 交叉比对。谁将来拿到真样本，放进 `scripts/fixtures/` 补一条断言即可。
 */

/** 音频魔数 → 扩展名。解出来的字节长什么样，就以什么为准。 */
const MAGIC: { ext: string; bytes: number[]; offset?: number }[] = [
  { ext: 'flac', bytes: [0x66, 0x4c, 0x61, 0x43] }, // fLaC
  { ext: 'ogg', bytes: [0x4f, 0x67, 0x67, 0x53] }, // OggS
  { ext: 'wav', bytes: [0x52, 0x49, 0x46, 0x46] }, // RIFF
  { ext: 'mp3', bytes: [0x49, 0x44, 0x33] }, // ID3
  { ext: 'm4a', bytes: [0x66, 0x74, 0x79, 0x70], offset: 4 }, // ....ftyp
  { ext: 'mp3', bytes: [0xff, 0xfb] }, // 裸 MPEG 帧
  { ext: 'mp3', bytes: [0xff, 0xf3] },
  { ext: 'mp3', bytes: [0xff, 0xf2] },
  { ext: 'aac', bytes: [0xff, 0xf1] }
]

/**
 * 按**魔数**判音频格式，判不出回 `null`。
 *
 * ⚠️ **不按容器声明的格式走。** 各家容器里那个 `format` 字段是 App 写进去的元数据，
 * 而我们真正要回答的是「这堆字节是什么」。两件事在正常文件上一致，在异常文件上不一致——
 * 而不一致时，按字节来判断的那个答案能让 ffmpeg 正确解码，按元数据走的那个会让它报一句
 * 与用户无关的错。回 `null` 而不是猜一个默认值：猜错的表现是「拿去转 mp3、产物是噪音」，
 * 而 `null` 会让调用方报一句「认不出里面是什么」。
 */
export function sniffAudioExt(data: Uint8Array): string | null {
  for (const m of MAGIC) {
    const at = m.offset ?? 0
    if (data.length < at + m.bytes.length) continue
    if (m.bytes.every((b, i) => data[at + i] === b)) return m.ext
  }
  return null
}

const startsWith = (data: Uint8Array, prefix: readonly number[]): boolean =>
  data.length >= prefix.length && prefix.every((b, i) => data[i] === b)

const u32le = (data: Uint8Array, at: number): number =>
  (data[at] | (data[at + 1] << 8) | (data[at + 2] << 16) | (data[at + 3] << 24)) >>> 0

/** 认不出内含格式时抛这个。调用方会把它翻成一句给人看的话。 */
export class UnknownInnerFormat extends Error {
  constructor(
    readonly container: string,
    readonly head: string
  ) {
    super(`${container}: 解密之后认不出音频格式（头 8 字节 ${head}）`)
    this.name = 'UnknownInnerFormat'
  }
}

function requireInner(data: Uint8Array, container: string): string {
  const ext = sniffAudioExt(data)
  if (ext === null) {
    const head = Array.from(data.subarray(0, 8))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join(' ')
    throw new UnknownInnerFormat(container, head)
  }
  return ext
}

/* ------------------------------------------------------------------ NCM */

/** 网易云 `.ncm` 的固定密钥。它是**算法的一部分**，不是任何人的凭据。 */
const NCM_CORE_KEY = Buffer.from('687a4852416d736f356b496e62617857', 'hex')
const NCM_MAGIC = [0x43, 0x54, 0x45, 0x4e, 0x46, 0x44, 0x41, 0x4d] // "CTENFDAM"

/*
 * 这里**没有**第二个密钥（元数据那个），因为本实现**不解析 NCM 的元数据**。
 *
 * 参考实现会把它解出来拿标题 / 歌手 / 封面，再写进产物的标签里——那是它们的产品形态
 * （一个「解锁音乐」的播放器）。本项目是**格式转换器**：产物要交给 ffmpeg 或直接落盘，
 * 而音频那一段到底是 mp3 还是 flac，由**字节的魔数**说了算，元数据说什么都不影响这个答案。
 * 少解一层，就少一处「解出来是乱码但没人发现」的地方。
 */

/** AES-128-ECB + PKCS#7 解一块。ECB 是格式规定的，不是我们选的。 */
function aesEcbDecrypt(cipher: Buffer, key: Buffer): Buffer {
  const d = createDecipheriv('aes-128-ecb', key, null)
  d.setAutoPadding(true) // PKCS#7
  return Buffer.concat([d.update(cipher), d.final()])
}

/**
 * `.ncm` 的密钥盒（256 字节）。
 *
 * 它是「标准 RC4 的 KSA，再套一层输出变换」，而且**输出要整体后移一位**
 * （见文件头「密钥流」那一段）。这两句都照抄两个独立实现。
 */
function ncmKeyBox(keyData: Uint8Array): Uint8Array {
  const s = new Uint8Array(256)
  for (let i = 0; i < 256; i += 1) s[i] = i

  let j = 0
  for (let i = 0; i < 256; i += 1) {
    j = (s[i] + j + keyData[i % keyData.length]) & 0xff
    const t = s[i]
    s[i] = s[j]
    s[j] = t
  }

  const box = new Uint8Array(256)
  for (let i = 0; i < 256; i += 1) {
    const k = (i + 1) & 0xff
    box[i] = s[(s[k] + s[(k + s[k]) & 0xff]) & 0xff]
  }
  return box
}

/**
 * 解开一个 `.ncm`。
 *
 * 版面（元数据之后那一段是承重的，见文件头）：
 *
 * ```
 * "CTENFDAM" | 2 字节 | u32 keyLen | key(^0x64 → AES) | u32 metaLen | meta(^0x63 → b64 → AES)
 *            5 字节 | u32 imageSpace | u32 imageSize | image(imageSize) | 补齐到 imageSpace
 *            audio（逐字节 ^ 密钥盒）
 * ```
 */
export function decryptNcm(buf: Uint8Array): { audio: Uint8Array; ext: string } {
  if (!startsWith(buf, NCM_MAGIC)) throw new Error('ncm: 文件头不是 CTENFDAM')

  let at = 10

  const keyLen = u32le(buf, at)
  at += 4
  if (at + keyLen > buf.length) throw new Error('ncm: 密钥段越界')
  const keyCipher = Buffer.from(buf.subarray(at, at + keyLen).map((b) => b ^ 0x64))
  at += keyLen
  const keyData = aesEcbDecrypt(keyCipher, NCM_CORE_KEY).subarray(17)
  const box = ncmKeyBox(keyData)

  const metaLen = u32le(buf, at)
  at += 4
  // 空元数据是合法形态（上游会按体积猜格式）。我们不猜——反正音频那一段的格式
  // 由魔数决定，元数据认不认得出来都影响不到产物。
  if (metaLen > 0) {
    if (at + metaLen > buf.length) throw new Error('ncm: 元数据段越界')
    at += metaLen
  }

  // ⚠️ 这两行是本文件最容易写歪的地方：先跳过 5 字节，再读 imageSpace，
  // 而**总跳过是 imageSpace + 13**（5 + 4 + 4）而不是 imageSpace。
  at += 5
  const imageSpace = u32le(buf, at)
  at += 4 + 4 + imageSpace
  if (at >= buf.length) throw new Error('ncm: 封面段越界（文件可能被截断）')

  const audio = buf.slice(at)
  for (let i = 0; i < audio.length; i += 1) audio[i] ^= box[i & 0xff]

  return { audio, ext: requireInner(audio, 'ncm') }
}

/* ------------------------------------------------------------------ QMC */

/**
 * QQ 音乐的静态密码盒（`.qmc0` / `.qmc3` 这类老格式用）。
 *
 * 取字节的公式是 `box[(offset² + 27) & 0xff]`，且 offset 要先对 `0x7fff` 取模
 * ——**这个取模是承重的**：文件超过 32767 字节之后不取模就会读到盒外，
 * 在 JS 里是 `undefined`、`^` 之后变成 `NaN`，产物从那个点起全烂，而不会抛任何错。
 */
const QMC_STATIC_BOX = new Uint8Array([
  0x77, 0x48, 0x32, 0x73, 0xde, 0xf2, 0xc0, 0xc8, 0x95, 0xec, 0x30, 0xb2, 0x51, 0xc3, 0xe1, 0xa0,
  0x9e, 0xe6, 0x9d, 0xcf, 0xfa, 0x7f, 0x14, 0xd1, 0xce, 0xb8, 0xdc, 0xc3, 0x4a, 0x67, 0x93, 0xd6,
  0x28, 0xc2, 0x91, 0x70, 0xca, 0x8d, 0xa2, 0xa4, 0xf0, 0x08, 0x61, 0x90, 0x7e, 0x6f, 0xa2, 0xe0,
  0xeb, 0xae, 0x3e, 0xb6, 0x67, 0xc7, 0x92, 0xf4, 0x91, 0xb5, 0xf6, 0x6c, 0x5e, 0x84, 0x40, 0xf7,
  0xf3, 0x1b, 0x02, 0x7f, 0xd5, 0xab, 0x41, 0x89, 0x28, 0xf4, 0x25, 0xcc, 0x52, 0x11, 0xad, 0x43,
  0x68, 0xa6, 0x41, 0x8b, 0x84, 0xb5, 0xff, 0x2c, 0x92, 0x4a, 0x26, 0xd8, 0x47, 0x6a, 0x7c, 0x95,
  0x61, 0xcc, 0xe6, 0xcb, 0xbb, 0x3f, 0x47, 0x58, 0x89, 0x75, 0xc3, 0x75, 0xa1, 0xd9, 0xaf, 0xcc,
  0x08, 0x73, 0x17, 0xdc, 0xaa, 0x9a, 0xa2, 0x16, 0x41, 0xd8, 0xa2, 0x06, 0xc6, 0x8b, 0xfc, 0x66,
  0x34, 0x9f, 0xcf, 0x18, 0x23, 0xa0, 0x0a, 0x74, 0xe7, 0x2b, 0x27, 0x70, 0x92, 0xe9, 0xaf, 0x37,
  0xe6, 0x8c, 0xa7, 0xbc, 0x62, 0x65, 0x9c, 0xc2, 0x08, 0xc9, 0x88, 0xb3, 0xf3, 0x43, 0xac, 0x74,
  0x2c, 0x0f, 0xd4, 0xaf, 0xa1, 0xc3, 0x01, 0x64, 0x95, 0x4e, 0x48, 0x9f, 0xf4, 0x35, 0x78, 0x95,
  0x7a, 0x39, 0xd6, 0x6a, 0xa0, 0x6d, 0x40, 0xe8, 0x4f, 0xa8, 0xef, 0x11, 0x1d, 0xf3, 0x1b, 0x3f,
  0x3f, 0x07, 0xdd, 0x6f, 0x5b, 0x19, 0x30, 0x19, 0xfb, 0xef, 0x0e, 0x37, 0xf0, 0x0e, 0xcd, 0x16,
  0x49, 0xfe, 0x53, 0x47, 0x13, 0x1a, 0xbd, 0xa4, 0xf1, 0x40, 0x19, 0x60, 0x0e, 0xed, 0x68, 0x09,
  0x06, 0x5f, 0x4d, 0xcf, 0x3d, 0x1a, 0xfe, 0x20, 0x77, 0xe4, 0xd9, 0xda, 0xf9, 0xa4, 0x2b, 0x76,
  0x1c, 0x71, 0xdb, 0x00, 0xbc, 0xfd, 0x0c, 0x6c, 0xa5, 0x47, 0xf7, 0xf6, 0x00, 0x79, 0x4a, 0x11
])

const QMC_SEGMENT = 0x7fff
const QMC_FIRST_SEGMENT = 0x80
const QMC_SEGMENT_SIZE = 5120

/** QQ 音乐自己的 TEA 变体（`decryptTencentTea`），密钥在上面那张表里现算。 */
function teaDecryptBlock(v0: number, v1: number, key: Uint32Array): [number, number] {
  const delta = 0x9e3779b9
  let sum = 0
  for (let i = 0; i < 32; i += 1) sum = (sum + delta) >>> 0
  for (let i = 0; i < 32; i += 1) {
    v1 =
      (v1 - ((((v0 << 4) >>> 0) + key[2]) ^ ((v0 + sum) >>> 0) ^ (((v0 >>> 5) + key[3]) >>> 0))) >>>
      0
    v0 =
      (v0 - ((((v1 << 4) >>> 0) + key[0]) ^ ((v1 + sum) >>> 0) ^ (((v1 >>> 5) + key[1]) >>> 0))) >>>
      0
    sum = (sum - delta) >>> 0
  }
  return [v0, v1]
}

function teaKeyOf(raw: Uint8Array): Uint32Array {
  const key = new Uint32Array(4)
  for (let i = 0; i < 4; i += 1) {
    key[i] =
      ((raw[i * 4] << 24) | (raw[i * 4 + 1] << 16) | (raw[i * 4 + 2] << 8) | raw[i * 4 + 3]) >>> 0
  }
  return key
}

/**
 * QMC 的流密码。三种形态，按**密钥长度**分流（上游也是这么分的）：
 * 没有密钥时是静态盒，密钥 > 300 字节时是分段 RC4，否则是映射盒。
 */
class QmcCipher {
  constructor(private readonly key: Uint8Array | null) {}

  decrypt(buf: Uint8Array, offset: number): void {
    if (this.key === null) return this.staticStream(buf, offset)
    if (this.key.length > 300) return this.rc4Stream(buf, offset)
    return this.mapStream(buf, offset)
  }

  private staticStream(buf: Uint8Array, offset: number): void {
    for (let i = 0; i < buf.length; i += 1) {
      let at = offset + i
      if (at > QMC_SEGMENT - 1) at %= QMC_SEGMENT
      buf[i] ^= QMC_STATIC_BOX[(at * at + 27) & 0xff]
    }
  }

  private mapStream(buf: Uint8Array, offset: number): void {
    const key = this.key as Uint8Array
    for (let i = 0; i < buf.length; i += 1) {
      let at = offset + i
      if (at > QMC_SEGMENT - 1) at %= QMC_SEGMENT
      const idx = (at * at + 71214) % key.length
      const rotate = (((idx & 0x7) + 4) % 8) >>> 0
      const value = key[idx]
      buf[i] ^= (((value << rotate) | (value >> rotate)) & 0xff) >>> 0
    }
  }

  private rc4Stream(buf: Uint8Array, offset: number): void {
    const key = this.key as Uint8Array
    const n = key.length

    const s = new Uint8Array(n)
    for (let i = 0; i < n; i += 1) s[i] = i & 0xff
    let j = 0
    for (let i = 0; i < n; i += 1) {
      j = (s[i] + j + key[i % n]) % n
      const t = s[i]
      s[i] = s[j]
      s[j] = t
    }

    let hash = 1
    for (let i = 0; i < n; i += 1) {
      const value = key[i]
      if (!value) continue
      const next = Math.imul(hash, value) >>> 0
      if (next === 0 || next <= hash) break
      hash = next
    }

    const segmentKey = (id: number): number => {
      const seed = key[id % n]
      return Math.floor((hash / ((id + 1) * seed)) * 100.0) % n
    }

    let toProcess = buf.length
    let processed = 0

    const firstSegment = (len: number): void => {
      for (let i = 0; i < len; i += 1) buf[i] ^= key[segmentKey(offset + i)]
    }

    const aSegment = (start: number, len: number, at: number): void => {
      const box = s.slice(0)
      const skipLen = (at % QMC_SEGMENT_SIZE) + segmentKey(Math.floor(at / QMC_SEGMENT_SIZE))
      let jj = 0
      let kk = 0
      for (let i = -skipLen; i < len; i += 1) {
        jj = (jj + 1) % n
        kk = (box[jj] + kk) % n
        const t = box[kk]
        box[kk] = box[jj]
        box[jj] = t
        if (i >= 0) buf[start + i] ^= box[(box[jj] + box[kk]) % n]
      }
    }

    if (offset < QMC_FIRST_SEGMENT) {
      const len = Math.min(buf.length, QMC_FIRST_SEGMENT - offset)
      firstSegment(len)
      toProcess -= len
      processed += len
      offset += len
      if (toProcess === 0) return
    }

    if (offset % QMC_SEGMENT_SIZE !== 0) {
      const len = Math.min(QMC_SEGMENT_SIZE - (offset % QMC_SEGMENT_SIZE), toProcess)
      aSegment(processed, len, offset)
      toProcess -= len
      processed += len
      offset += len
      if (toProcess === 0) return
    }

    while (toProcess > QMC_SEGMENT_SIZE) {
      aSegment(processed, QMC_SEGMENT_SIZE, offset)
      toProcess -= QMC_SEGMENT_SIZE
      processed += QMC_SEGMENT_SIZE
      offset += QMC_SEGMENT_SIZE
    }

    if (toProcess > 0) aSegment(processed, toProcess, offset)
  }
}

/** `simpleMakeKey`：用正切表现算 8 字节。上游说它导出只是为了单测。 */
function simpleMakeKey(salt: number, length: number): number[] {
  const out: number[] = []
  for (let i = 0; i < length; i += 1) {
    const tmp = Math.tan(salt + i * 0.1)
    out[i] = 0xff & (Math.abs(tmp) * 100.0)
  }
  return out
}

const MIX_KEY_1 = new Uint8Array([
  0x33, 0x38, 0x36, 0x5a, 0x4a, 0x59, 0x21, 0x40, 0x23, 0x2a, 0x24, 0x25, 0x5e, 0x26, 0x29, 0x28
])
const MIX_KEY_2 = new Uint8Array([
  0x2a, 0x2a, 0x23, 0x21, 0x28, 0x23, 0x24, 0x25, 0x26, 0x5e, 0x61, 0x31, 0x63, 0x5a, 0x2c, 0x54
])

const SALT_LEN = 2
const ZERO_LEN = 7

/**
 * 腾讯 TEA 的 CBC 变体（`decryptTencentTea`）。
 *
 * 密文版式：`PadLen(1) | Padding(0~7) | Salt(2) | Body | Zero(7)`。
 * 收尾那 7 个零是**校验位**，不对就说明密钥错了——所以这里保留校验并抛错，
 * 而不是「解出来是乱码也照样往下走」。
 */
function decryptTencentTea(inBuf: Uint8Array, key: Uint8Array): Uint8Array {
  if (inBuf.length % 8 !== 0) throw new Error('qmc: TEA 输入不是 8 的倍数')
  if (inBuf.length < 16) throw new Error('qmc: TEA 输入太短')

  const teaKey = teaKeyOf(key)
  const tmp = new Uint8Array(8)
  const view = new DataView(tmp.buffer)

  const block = (): void => {
    const [v0, v1] = teaDecryptBlock(view.getUint32(0, false), view.getUint32(4, false), teaKey)
    view.setUint32(0, v0, false)
    view.setUint32(4, v1, false)
  }

  const first = new DataView(inBuf.buffer, inBuf.byteOffset, 8)
  view.setUint32(0, first.getUint32(0, false), false)
  view.setUint32(4, first.getUint32(4, false), false)
  block()

  const padLen = tmp[0] & 0x7
  const outLen = inBuf.length - 1 - padLen - SALT_LEN - ZERO_LEN
  if (outLen <= 0) throw new Error('qmc: TEA 输出长度不合理')
  const out = new Uint8Array(outLen)

  let ivPrev = new Uint8Array(8)
  let ivCur = inBuf.slice(0, 8)
  let inPos = 8
  let tmpIdx = 1 + padLen

  const cryptBlock = (): void => {
    ivPrev = ivCur
    ivCur = inBuf.slice(inPos, inPos + 8)
    for (let j = 0; j < 8; j += 1) tmp[j] ^= ivCur[j]
    block()
    inPos += 8
    tmpIdx = 0
  }

  for (let i = 1; i <= SALT_LEN;) {
    if (tmpIdx < 8) {
      tmpIdx += 1
      i += 1
    } else cryptBlock()
  }

  let outPos = 0
  while (outPos < outLen) {
    if (tmpIdx < 8) {
      out[outPos] = tmp[tmpIdx] ^ ivPrev[tmpIdx]
      outPos += 1
      tmpIdx += 1
    } else cryptBlock()
  }

  for (let i = 1; i <= ZERO_LEN; i += 1) {
    if (tmp[tmpIdx] !== ivPrev[tmpIdx]) throw new Error('qmc: TEA 校验失败（密钥不对）')
  }
  return out
}

/** `.mflac` / `.mgg` 这一代：密钥在文件尾部的 key 块里，自己派生得出来，不需要密钥表。 */
function qmcDeriveKey(raw: Uint8Array): Uint8Array {
  let dec = Buffer.from(Buffer.from(raw).toString('latin1'), 'base64')

  const ENC_V2 = 'QQMusic EncV2,Key:'
  if (dec.length >= 18 && dec.subarray(0, 18).toString('latin1') === ENC_V2) {
    let out = Buffer.from(decryptTencentTea(dec.subarray(18), MIX_KEY_1))
    out = Buffer.from(decryptTencentTea(out, MIX_KEY_2))
    dec = Buffer.from(out.toString('latin1'), 'base64')
  }

  if (dec.length < 16) throw new Error('qmc: 密钥太短')

  const simple = simpleMakeKey(106, 8)
  const teaKey = new Uint8Array(16)
  for (let i = 0; i < 8; i += 1) {
    teaKey[i << 1] = simple[i]
    teaKey[(i << 1) + 1] = dec[i]
  }
  const sub = decryptTencentTea(dec.subarray(8), teaKey)
  dec.set(sub, 8)
  return dec.subarray(0, 8 + sub.length)
}

const QMC_TAG = [0x51, 0x54, 0x61, 0x67] // "QTag"

/**
 * 解开一个 `.qmc*` / `.mflac` / `.mgg`。
 *
 * 音频长度从**文件尾部**反推：尾部若是 `QTag`，前 4 字节是密钥长度（大端）；
 * 否则最后 4 字节是密钥长度（小端），且**长度 ≥ 0x400 就说明整个文件都是音频**
 * （老格式没有密钥块，用的是静态盒）。
 */
export function decryptQmc(buf: Uint8Array, ext: string): { audio: Uint8Array; ext: string } {
  const size = buf.length
  if (size < 8) throw new Error(`qmc: 文件太短（${size} 字节）`)

  const last4 = buf.subarray(size - 4)
  let audioSize = size
  let cipher: QmcCipher

  if (startsWith(last4, QMC_TAG)) {
    const keySize =
      ((buf[size - 8] << 24) | (buf[size - 7] << 16) | (buf[size - 6] << 8) | buf[size - 5]) >>> 0
    audioSize = size - keySize - 8
    if (audioSize <= 0) throw new Error('qmc: 密钥块长度越界')
    const rawKey = buf.subarray(audioSize, size - 8)
    const comma = rawKey.indexOf(0x2c) // ','
    if (comma < 0) throw new Error('qmc: 密钥块里找不到分隔符')
    cipher = new QmcCipher(qmcDeriveKey(rawKey.subarray(0, comma)))
  } else {
    const keySize = u32le(buf, size - 4)
    if (keySize < 0x400) {
      audioSize = size - keySize - 4
      if (audioSize <= 0) throw new Error('qmc: 密钥块长度越界')
      cipher = new QmcCipher(qmcDeriveKey(buf.subarray(audioSize, size - 4)))
    } else {
      cipher = new QmcCipher(null)
    }
  }

  const audio = buf.slice(0, audioSize)
  cipher.decrypt(audio, 0)
  return { audio, ext: requireInner(audio, ext) }
}

/* ------------------------------------------------------------------ 酷我 / 虾米 */

const KWM_MAGIC_A = [
  0x79, 0x65, 0x65, 0x6c, 0x69, 0x6f, 0x6e, 0x2d, 0x6b, 0x75, 0x77, 0x6f, 0x2d, 0x74, 0x6d, 0x65
]
const KWM_MAGIC_B = [
  0x79, 0x65, 0x65, 0x6c, 0x69, 0x6f, 0x6e, 0x2d, 0x6b, 0x75, 0x77, 0x6f, 0x00, 0x00, 0x00, 0x00
]
const KWM_PREDEFINED = 'MoOtOiTvINGwd2E6n0E1i7L5t2IoOoNk'

/** 酷我 `.kwm`：文件头 0x400 字节之后，用「预定义串 ^ 文件里的 8 字节做十进制再补齐」得到的 32 字节面膜异或。 */
export function decryptKwm(buf: Uint8Array): { audio: Uint8Array; ext: string } {
  if (!startsWith(buf, KWM_MAGIC_A) && !startsWith(buf, KWM_MAGIC_B)) {
    throw new Error('kwm: 文件头不是 yeelion-kuwo')
  }

  const raw = Buffer.from(buf.subarray(0x18, 0x20))
  const keyStr = raw.readBigUInt64LE(0).toString()
  const trimmed =
    keyStr.length > 32
      ? keyStr.slice(0, 32)
      : keyStr.length < 32
        ? keyStr.padEnd(32, keyStr)
        : keyStr

  const mask = new Uint8Array(32)
  for (let i = 0; i < 32; i += 1) mask[i] = KWM_PREDEFINED.charCodeAt(i) ^ trimmed.charCodeAt(i)

  const audio = buf.slice(0x400)
  for (let i = 0; i < audio.length; i += 1) audio[i] ^= mask[i % 0x20]

  return { audio, ext: requireInner(audio, 'kwm') }
}

const XM_MAGIC = [0x69, 0x66, 0x6d, 0x74] // "ifmt"
const XM_MAGIC2 = [0xfe, 0xfe, 0xfe, 0xfe]
const XM_TYPES: Record<string, string> = {
  ' WAV': 'wav',
  FLAC: 'flac',
  ' MP3': 'mp3',
  ' A4M': 'm4a'
}

/** 虾米 `.xm`：文件头声明类型与密钥，`0x10` 之后按 `(byte - key) ^ 0xff` 还原。 */
export function decryptXm(buf: Uint8Array): { audio: Uint8Array; ext: string } {
  if (!startsWith(buf, XM_MAGIC) || !startsWith(buf.subarray(8), XM_MAGIC2)) {
    throw new Error('xm: 文件头不是 ifmt')
  }
  const typeText = Buffer.from(buf.subarray(4, 8)).toString('latin1')
  const ext = XM_TYPES[typeText]
  // 声明的类型认不出就**不猜**：这里的类型是文件头里写的，与 NCM 那种「按魔数判」
  // 不同——它同时决定了下面那个 `dataOffset` 的解释，猜错会解出一堆废字节。
  if (ext === undefined) throw new Error(`xm: 认不出的类型标记 ${JSON.stringify(typeText)}`)

  const key = buf[0x0f]
  const dataOffset = buf[0x0c] | (buf[0x0d] << 8) | (buf[0x0e] << 16)

  const audio = buf.slice(0x10)
  for (let i = dataOffset; i < audio.length; i += 1) audio[i] = (audio[i] - key) ^ 0xff

  // 与上面那张表是**两个方向**：表认的是文件头声明的类型，这里认的是解出来的字节。
  // 以**字节**为准（ffmpeg 认的是字节），声明的那个只当兜底——两者不一致的样本我们
  // 没见过，但真出现时，按字节走才解得开。兜底而不是抛错：文件头都合法、只是
  // 我们对这个类型的魔数没登记，这种情况不该让整条任务失败。
  return { audio, ext: sniffAudioExt(audio) ?? ext }
}
