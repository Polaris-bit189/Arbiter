/**
 * 加密音乐容器（`.ncm` / `.qmc*` / `.kwm` / `.xm`）的回归网。
 *
 *   npx tsx --tsconfig tsconfig.test.json scripts/test-encmusic.ts
 *
 * ## 这一套「验到了哪一层」，先说清楚
 *
 * 解密这种东西最难的地方是**没有真实样本就没法说「真文件一定能解开」**。本仓不许用
 * 自造样本去证明自己（「自己能造的多半也能验自己」），而这个生态里的同类项目也都不提交
 * 真实样本（`HRuiCcc/music-geshizhuanhuan` 的 README 明写「测试样本全部为自建合成数据，
 * 不含任何版权内容」）。所以这一套分两层，**两层各自能证明什么是不一样的**：
 *
 * | 层 | 做法 | 能证明什么 | 不能证明什么 |
 * | --- | --- | --- | --- |
 * | 素材 `[1]` | `fixtures/encmusic/sample.ncm` —— 合成正弦波容器，但**由 Python 的 `ncmdump` 独立解过**，产物逐字节相同 | 我们的读取器与**另一个实现**在版面与密钥流上一致 | 真实 App 产出的文件一定长这样 |
 * | 合成往返 `[3]` | 现场造容器 → 现场解开 | 读取器与写入器没写岔（抓拼写与偏移错） | 版面本身对不对（两边可能一起错） |
 *
 * 所以 `[1]` 是**唯一**有跨实现证据的那一条，别把它与 `[3]` 混为一谈。
 * 真实样本的缺口如实记在 `docs/NOTES.md` 与 `converters/encmusic/containers.ts` 的文件头。
 *
 * ## 素材是怎么来的（可复现）
 *
 * `sample.ncm` 由一个固定密钥的合成写入器产出（不是随机的，所以每次生成都得到同一个
 * 文件），音频是一段 0.05 秒的 440 Hz 正弦波 WAV。**交叉验证只做过一次、在开发机上**，
 * 复现方式是装 `pycryptodome` + `mutagen` 之后跑：
 *
 * ```
 * python -c "from ncmdump.core import dump; dump('scripts/fixtures/encmusic/sample.ncm', 'out.bin')"
 * ```
 *
 * 产物应与 `sample.expected.wav` 逐字节相同。**这一步不在 CI 里**（要 Python 依赖），
 * 所以它是「一次性取证」，不是持续保证——与 `falsify:plugin-launch` 那条同一个道理。
 */
// 路 2 会去问 ffmpeg 的路径，而那要 appPaths 先初始化（与 test-tasks 同一个前置）
import './install-test-paths'
import { spawnSync } from 'node:child_process'
import { createCipheriv } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'fs/promises'
import { join, resolve } from 'path'
import { engineFor, categoryOf, targetsFor } from '../src/shared/formats'
import { convert, ConversionFailed } from '../src/main/converters'
import { CancelToken } from '../src/main/core/cancel'
import { runEncMusic } from '../src/main/converters/encmusic'
import {
  decryptKwm,
  decryptNcm,
  decryptQmc,
  decryptXm
} from '../src/main/converters/encmusic/containers'

const ROOT = process.cwd()
const FIXTURES = resolve(ROOT, 'scripts/fixtures/encmusic')
const TMP = resolve(ROOT, `.tmp-test-encmusic-${process.pid}`)
const FFMPEG = resolve(ROOT, 'node_modules/ffmpeg-static/ffmpeg.exe')

let passed = 0
let failed = 0

function check(label: string, ok: boolean, detail?: string): void {
  if (ok) {
    passed += 1
    console.log(`  ✓ ${label}`)
  } else {
    failed += 1
    console.log(`  ✗ ${label}${detail ? `  ← ${detail}` : ''}`)
  }
}

const same = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0

const hex = (u: Uint8Array, n = 8): string =>
  Array.from(u.subarray(0, n))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join(' ')

/* ------------------------------------------------------------ 合成写入器 */

/*
 * 下面这几个是**写入器**，只服务于 `[3]` 的往返。它们的取值方式刻意与
 * `containers.ts` 相反（那边是解、这边是加），所以**共用一份常量是刻意的**：
 * 共用一份常量，往返通了只能说明「两个方向自洽」；常量写错了两边一起错。
 * 真正兜底的是 `[1]` 那条跨实现证据。
 */

/** 固定密钥的 WAV：同 `[1]` 的素材，保证可复现。 */
function sineWav(seconds = 0.05, rate = 8000): Buffer {
  const n = Math.round(seconds * rate)
  const data = Buffer.alloc(n * 2)
  for (let i = 0; i < n; i += 1) {
    data.writeInt16LE(Math.round(Math.sin((i / rate) * 2 * Math.PI * 440) * 12000), i * 2)
  }
  const h = Buffer.alloc(44)
  h.write('RIFF', 0)
  h.writeUInt32LE(36 + data.length, 4)
  h.write('WAVE', 8)
  h.write('fmt ', 12)
  h.writeUInt32LE(16, 16)
  h.writeUInt16LE(1, 20)
  h.writeUInt16LE(1, 22)
  h.writeUInt32LE(rate, 24)
  h.writeUInt32LE(rate * 2, 28)
  h.writeUInt16LE(2, 32)
  h.writeUInt16LE(16, 34)
  h.write('data', 36)
  h.writeUInt32LE(data.length, 40)
  return Buffer.concat([h, data])
}

const NCM_CORE_KEY = Buffer.from('687a4852416d736f356b496e62617857', 'hex')

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
 * ⚠️ **不要手工补 PKCS7。** `createCipheriv` 默认 `autoPadding=true`，它自己会补；
 * 手工再补一次的结果是「33 字节明文 → 48 → 又加一整块 → 64」，密钥块整体多出 16 字节，
 * 而**两个读取器都会解出一堆看着像随机的字节**——这一版就是这么被抓出来的：
 * 与 Python 那份实现对拍时两边都不对，最后定位到写入器。
 */
function buildNcm(audio: Buffer, keyData: Buffer): Buffer {
  const plain = Buffer.concat([Buffer.alloc(17, 0x5a), keyData])
  const ciph = createCipheriv('aes-128-ecb', NCM_CORE_KEY, null)
  const keyCipher = Buffer.concat([ciph.update(plain), ciph.final()])
  const masked = Buffer.from(keyCipher.map((b) => b ^ 0x64))

  const box = ncmKeyBox(keyData)
  const enc = Buffer.from(audio)
  for (let i = 0; i < enc.length; i += 1) enc[i] ^= box[i & 0xff]

  const head = Buffer.alloc(10)
  head.write('CTENFDAM', 0, 'latin1')
  const keyLen = Buffer.alloc(4)
  keyLen.writeUInt32LE(masked.length, 0)
  return Buffer.concat([head, keyLen, masked, Buffer.alloc(4 + 13), enc])
}

/** `.kwm`：16 字节魔数 + 0x18 处的 8 字节密钥 + 补齐到 0x400 + 异或过的音频 */
function buildKwm(audio: Buffer, keyBytes = Buffer.from('0123456789abcdef', 'hex')): Buffer {
  const magic = Buffer.from('yeelion-kuwo-tme', 'latin1')
  const head = Buffer.alloc(0x400)
  magic.copy(head, 0)
  keyBytes.copy(head, 0x18)

  const keyStr = keyBytes.readBigUInt64LE(0).toString()
  const trimmed =
    keyStr.length > 32
      ? keyStr.slice(0, 32)
      : keyStr.length < 32
        ? keyStr.padEnd(32, keyStr)
        : keyStr
  const predefined = 'MoOtOiTvINGwd2E6n0E1i7L5t2IoOoNk'
  const mask = new Uint8Array(32)
  for (let i = 0; i < 32; i += 1) mask[i] = predefined.charCodeAt(i) ^ trimmed.charCodeAt(i)

  const enc = Buffer.from(audio)
  for (let i = 0; i < enc.length; i += 1) enc[i] ^= mask[i % 0x20]
  return Buffer.concat([head, enc])
}

/** `.xm`：`ifmt` + 类型（4） + dataOffset（0x0c 起 3 字节） + 密钥（0x0f） + 数据 */
function buildXm(audio: Buffer, type: string, key: number, dataOffset: number): Buffer {
  const head = Buffer.alloc(0x10)
  head.write('ifmt', 0, 'latin1')
  head.write(type, 4, 'latin1')
  head.writeUInt32LE(0xfefefefe, 8)
  head[0x0c] = dataOffset & 0xff
  head[0x0d] = (dataOffset >> 8) & 0xff
  head[0x0e] = (dataOffset >> 16) & 0xff
  head[0x0f] = key

  const enc = Buffer.from(audio)
  for (let i = dataOffset; i < enc.length; i += 1) enc[i] = (enc[i] - key) ^ 0xff
  return Buffer.concat([head, enc])
}

/** `.qmc*` 的静态盒形态：没有密钥块，整个文件都是音频，靠密钥长度 ≥ 0x400 分流。 */
function buildQmcStatic(audio: Buffer): Buffer {
  const enc = Buffer.from(audio)
  for (let i = 0; i < enc.length; i += 1) {
    let at = i
    if (at > 0x7ffe) at %= 0x7fff
    enc[i] ^= QMC_BOX[(at * at + 27) & 0xff]
  }
  return enc
}

const qmcStaticMask = (at: number): number => {
  let pos = at
  if (pos > 0x7ffe) pos %= 0x7fff
  return QMC_BOX[(pos * pos + 27) & 0xff]
}

/**
 * 把「整文件即音频」那一支的判据喂饱：读取器把**末 4 字节**当小端读出来的密钥长度，
 * ≥ 0x400 才走静态分支。
 *
 * ⚠️ **不能事后去改密文的末 4 字节**——那等于把明文也改坏了，往返就不再相等，
 * 而那条断言会以「实现坏了」的样子红（第一版就是这么错的）。正确的做法是**先定明文**：
 * 把 WAV 末尾那 4 个采样字节设成「想要的值 ^ 掩码」，密文末 4 字节自然就是想要的那个数，
 * 而往返比较用的正是这份改过的 WAV。
 */
function forceStaticBranch(wav: Buffer): Buffer {
  const want = 0x00001000
  const out = Buffer.from(wav)
  for (let i = 0; i < 4; i += 1) {
    out[out.length - 4 + i] = ((want >> (8 * i)) & 0xff) ^ qmcStaticMask(out.length - 4 + i)
  }
  return out
}

// 与 `containers.ts` 里那张表同源。**测试自己抄一份**是刻意的：真要与实现分家，
// 抄一份反而更早暴露（实现改了表、这里没改，往返立刻红）。
const QMC_BOX = new Uint8Array([
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

/* ------------------------------------------------------------------ 断言 */

function testFixture(): void {
  console.log('\n[1] NCM 素材（有跨实现证据的那一条）')

  const ncm = readFileSync(join(FIXTURES, 'sample.ncm'))
  const expected = readFileSync(join(FIXTURES, 'sample.expected.wav'))
  check(
    '素材存在且非空',
    ncm.length > 0 && expected.length > 0,
    `${ncm.length} / ${expected.length}`
  )

  const out = attempt(
    '⭐ 解开之后与 expected 逐字节相同（这一条背后是 Python 的 ncmdump 也解出同一份）',
    () => decryptNcm(new Uint8Array(ncm))
  )
  if (out !== null) {
    check(
      '⭐ 解开之后与 expected 逐字节相同（这一条背后是 Python 的 ncmdump 也解出同一份）',
      same(out.audio, expected),
      `${out.audio.length} 字节，头 ${hex(out.audio)}`
    )
    check('嗅探出 wav', out.ext === 'wav', out.ext)
    check('产物以 RIFF 开头', Buffer.from(out.audio.subarray(0, 4)).toString('latin1') === 'RIFF')
  }
}

function testTamper(): void {
  console.log('\n[2] 结构性拒收（坏了就要说得出话，不能产出噪音）')

  const good = readFileSync(join(FIXTURES, 'sample.ncm'))

  const noMagic = Buffer.from(good)
  noMagic[0] = 0x00
  check(
    '文件头不对 → 抛错，而不是硬解',
    throws(() => decryptNcm(new Uint8Array(noMagic)))
  )

  const truncated = good.subarray(0, 40)
  check(
    '截断的容器 → 抛错（不静默产出一份短音频）',
    throws(() => decryptNcm(new Uint8Array(truncated)))
  )

  // ⚠️ 这一条是这一节的重点：**密钥块被改一个字节**之后，绝不能出现
  // 「解出一份看起来正常、其实是噪音的音频」。要么抛，要么在内含格式那一关被拦下。
  //
  // ⚠️ 变异的位置是**承重**的：改**第一个** AES 块（密文偏移 14..29）等于没改——
  // 那 16 字节解出来落在明文的前 16 字节里，而读取器要的是 `subarray(17)`，
  // 前 17 字节本来就要丢掉。第一版就是这么写的，于是断言「失败」得莫名其妙。
  // 真正的密钥数据从明文第 17 字节起，所以要改到**第二块**去。
  const badKey = Buffer.from(good)
  badKey[34] ^= 0xff
  // ⚠️ 判据是「**必须抛**」，不是「嗅探认不认得出来」。后者看着更宽，实则抓不住真正的错法：
  // 「认不出时猜一个默认值」那个变异恰恰是让函数**返回**一个 mp3，而那时嗅探对着一堆随机
  // 字节本来就返回 null——于是断言照样绿。第一版就是这么写的，反查了半天才发现是它自己太弱。
  check(
    '⭐ 密钥块被改一个字节 → 直接抛错（解不出来就说解不出来，绝不返回一份猜出来的产物）',
    throws(() => decryptNcm(new Uint8Array(badKey)))
  )

  check(
    '空输入 → 抛错',
    throws(() => decryptNcm(new Uint8Array(0)))
  )
}

/**
 * 跑一次解密，**失败就当成一条失败断言**而不是让它抛出去。
 *
 * ⚠️ 这一条不是好看：解密失败会抛 `UnknownInnerFormat` / 各类 `Error`，直接让它冒出去的话
 * 整个套件**崩在那一行**——后面的断言一条都不跑，而输出上只看得到一段异常栈。
 * 本仓在别处已经踩过这个坑（「测试代码自己用 `task!.outputPath!` 在失败时抛异常把整个套件
 * 崩在半路盖住后面几十条断言」），而反证脚本那边表现为「变异让套件在半路抛异常」——
 * 意思是**期望的断言根本没被执行**，于是那一轮结论作废、白跑。
 */
function attempt<T>(label: string, fn: () => T): T | null {
  try {
    return fn()
  } catch (error) {
    check(label, false, error instanceof Error ? error.message : String(error))
    return null
  }
}

/** `attempt` 的异步版：端到端那几条路是 await 出来的。 */
async function attemptAsync<T>(label: string, fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn()
  } catch (error) {
    check(label, false, error instanceof Error ? error.message : String(error))
    return null
  }
}

function throws(fn: () => unknown): boolean {
  try {
    fn()
    return false
  } catch {
    return true
  }
}

function testRoundTrip(): void {
  console.log('\n[3] 合成往返（抓拼写与偏移错，不抓「版面本身对不对」）')

  const wav = sineWav()
  const key = Buffer.from('0123456789abcdef0123456789abcdef', 'hex')

  const ncmOut = attempt('ncm 往返', () => decryptNcm(new Uint8Array(buildNcm(wav, key))))
  if (ncmOut !== null) check('ncm 往返', same(ncmOut.audio, wav) && ncmOut.ext === 'wav')

  const kwmOut = attempt('kwm 往返（含 0x400 的头与 32 字节面膜）', () =>
    decryptKwm(new Uint8Array(buildKwm(wav)))
  )
  if (kwmOut !== null) {
    check(
      'kwm 往返（含 0x400 的头与 32 字节面膜）',
      same(kwmOut.audio, wav) && kwmOut.ext === 'wav',
      `${kwmOut.audio.length} 字节，头 ${hex(kwmOut.audio, 4)}`
    )
  }

  const xmOut = attempt('xm 往返（`(byte - key) ^ 0xff`）', () =>
    decryptXm(new Uint8Array(buildXm(wav, ' WAV', 0x5a, 0x10)))
  )
  if (xmOut !== null) {
    check(
      'xm 往返（`(byte - key) ^ 0xff`）',
      same(xmOut.audio, wav) && xmOut.ext === 'wav',
      `${xmOut.audio.length} 字节，头 ${hex(xmOut.audio, 4)}`
    )
  }

  const qmcWav = forceStaticBranch(wav)
  const qmcIn = buildQmcStatic(qmcWav)
  const qmcOut = attempt('qmc 静态盒往返（整文件即音频那一支）', () =>
    decryptQmc(new Uint8Array(qmcIn), 'qmc0')
  )
  if (qmcOut !== null) {
    check(
      'qmc 静态盒往返（整文件即音频那一支）',
      same(qmcOut.audio, qmcWav) && qmcOut.ext === 'wav',
      `${qmcOut.audio.length} 字节，头 ${hex(qmcOut.audio, 4)}`
    )
  }
  check(
    'qmc 的密钥长度分流走对了：末 4 字节 ≥ 0x400 才是「整文件即音频」',
    qmcIn.readUInt32LE(qmcIn.length - 4) >= 0x400,
    `末 4 字节 = ${qmcIn.readUInt32LE(qmcIn.length - 4)}`
  )
}

function testRouting(): void {
  console.log('\n[4] 路由与能力矩阵')

  check('ncm 归在音频类', categoryOf('ncm') === 'audio', String(categoryOf('ncm')))
  check(
    'ncm → mp3 路由到 encmusic',
    engineFor('ncm', 'mp3') === 'encmusic',
    String(engineFor('ncm', 'mp3'))
  )
  check('mflac → flac 也走 encmusic', engineFor('mflac', 'flac') === 'encmusic')
  check(
    '⭐ 反方向：普通音频仍然走 ffmpeg（没被这条路由顺手吞掉）',
    engineFor('mp3', 'flac') === 'ffmpeg' && engineFor('wav', 'mp3') === 'ffmpeg'
  )
  const targets = targetsFor('ncm')
  check(
    'ncm 的可选目标是音频那一套（mp3 / flac / wav 都在）',
    targets.includes('mp3') && targets.includes('flac') && targets.includes('wav'),
    targets.join(',')
  )
  check(
    '⚠️ kgm 刻意**没有**登记（掩码表没拿到，登记一个必然失败的扩展名更糟）',
    categoryOf('kgm') === null && categoryOf('kgma') === null
  )
}

async function testEndToEnd(): Promise<void> {
  console.log('\n[5] 端到端（真跑一次转换，走完整条路由）')

  const expected = readFileSync(join(FIXTURES, 'sample.expected.wav'))

  // 路 1：解出来就是目标格式 → 直接落盘，一个字节都不转
  //
  // ⚠️ 这两条都包在 attemptAsync 里：`convert()` 失败会抛，直接让它冒出去的话整个套件
  // 崩在这一行，后面几条断言一条都不跑——而反证那边把它读成「变异让套件在半路抛异常」，
  // 那一轮结论作废、白跑。失败要变成一条 ✗。
  const directOut = join(TMP, 'direct.wav')
  const cancel = new CancelToken()
  const direct = await attemptAsync(
    '⭐ ncm → wav 直接落盘：产物与素材解出来的完全一致（没有经过编码器）',
    async () => {
      await convert({
        input: join(FIXTURES, 'sample.ncm'),
        output: directOut,
        fromExt: 'ncm',
        toExt: 'wav',
        cancel,
        onProgress: () => {}
      })
      return readFile(directOut)
    }
  )
  if (direct !== null) {
    check(
      '⭐ ncm → wav 直接落盘：产物与素材解出来的完全一致（没有经过编码器）',
      same(new Uint8Array(direct), expected),
      `${direct.length} 字节`
    )
  }

  // 路 2：要换格式 → 解到临时文件再交给 ffmpeg（引擎调引擎那条路）
  const mp3Out = join(TMP, 'via-ffmpeg.mp3')
  const mp3 = await attemptAsync('ncm → mp3：转换跑通', async () => {
    await convert({
      input: join(FIXTURES, 'sample.ncm'),
      output: mp3Out,
      fromExt: 'ncm',
      toExt: 'mp3',
      cancel,
      onProgress: () => {}
    })
    return readFile(mp3Out)
  })
  if (mp3 === null) return
  check('ncm → mp3：产物非空', mp3.length > 0, `${mp3.length} 字节`)
  check(
    '⭐ ncm → mp3 的产物是**真 MP3**（ffmpeg 那一步真的跑到了）',
    mp3.subarray(0, 3).toString('latin1') === 'ID3' ||
      (mp3[0] === 0xff && (mp3[1] & 0xe0) === 0xe0),
    hex(new Uint8Array(mp3), 4)
  )
  check(
    '中间那个临时文件已经清掉（临时目录里不该留我们的垃圾）',
    (await readDirSafe(join(process.env.TEMP ?? '/tmp'))).every(
      (n) => !n.startsWith(`arbiter-encmusic-${process.pid}`)
    )
  )
  // 路 3：kwm 走完整条分派。⚠️ 上面 `[3]` 那条往返是**直接调 `decryptKwm`** 的，
  // 它测不到适配器里那张按扩展名分派的表——少一条分支、或者指错一个函数，那条照样绿。
  const kwmPath = join(TMP, 'dispatched.kwm')
  await writeFile(kwmPath, buildKwm(expected))
  const kwmOutPath = join(TMP, 'dispatched.wav')
  const kwmOk = await attemptAsync(
    '⭐ kwm 经适配器分派后解出的就是原音频（分派表少一条分支会静默走错函数）',
    async () => {
      await convert({
        input: kwmPath,
        output: kwmOutPath,
        fromExt: 'kwm',
        toExt: 'wav',
        cancel: new CancelToken(),
        onProgress: () => {}
      })
      return readFile(kwmOutPath)
    }
  )
  if (kwmOk !== null) {
    check(
      '⭐ kwm 经适配器分派后解出的就是原音频（分派表少一条分支会静默走错函数）',
      same(new Uint8Array(kwmOk), expected),
      `${kwmOk.length} 字节`
    )
  }

  // 坏容器要报一句人话，而不是把 ffmpeg 的报错端上来
  const badPath = join(TMP, 'broken.ncm')
  await writeFile(badPath, Buffer.from('not an ncm at all, really not'))
  let message = ''
  try {
    await runEncMusic({
      input: badPath,
      output: join(TMP, 'broken.wav'),
      fromExt: 'ncm',
      toExt: 'wav',
      cancel,
      onProgress: () => {}
    })
  } catch (error) {
    message = error instanceof ConversionFailed ? (error.logTail[0] ?? '') : String(error)
  }
  check(
    '坏容器 → ConversionFailed，且第一句说的是「解不开这个 ncm 容器」',
    message.includes('解不开这个 ncm 容器'),
    message || '（没抛）'
  )
}

async function readDirSafe(dir: string): Promise<string[]> {
  const { readdir } = await import('fs/promises')
  return await readdir(dir).catch(() => [] as string[])
}

async function main(): Promise<void> {
  console.log('=== 加密音乐容器自测 ===')
  await rm(TMP, { recursive: true, force: true })
  await mkdir(TMP, { recursive: true })

  testFixture()
  testTamper()
  testRoundTrip()
  testRouting()
  await testEndToEnd()

  // ffmpeg 只在这条命令里用到，这里显式确认它在（不在的话上一条会以别的方式红）
  check('ffmpeg 二进制在位（路 2 依赖它）', spawnSync(FFMPEG, ['-version']).status === 0)

  await rm(TMP, { recursive: true, force: true }).catch(() => {})
  console.log(`\n=== 通过 ${passed} / 失败 ${failed} ===`)
  process.exit(failed === 0 ? 0 : 1)
}

void main()
