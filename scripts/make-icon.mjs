#!/usr/bin/env node
/**
 * 从一张源图派生整套应用图标。
 *
 * 用法：
 *   node scripts/make-icon.mjs <源图>     # 任意 sharp 读得动的格式：jpg / png / webp 都行
 *   node scripts/make-icon.mjs            # 不给参数：拿 build/icon.png 当主稿重新派生
 *
 * 产物：
 *   build/icon.png       512×512 主稿（electron-builder 的 buildResources）
 *   build/icon.ico       16/32/48/64/128 走 DIB + 256 走 PNG（electron-builder 与 Windows）
 *   build/icon.icns      32/64/128/256/512，PNG 载荷（macOS）
 *   resources/icon.png   与主稿逐字节相同；`src/main/window.ts` 的窗口图标读它
 *
 * **为什么自己拼 ICO / ICNS 而不引依赖**：两者本质都是「容器 + 若干张位图」，结构简单到
 * 不值得加一个包（也省得再碰 npm 镜像）。但拼错的表现极难查——ICO 里把 BGRA 写成 RGBA、
 * 或者忘了行是自下而上，产物**依然是个合法 ICO**，只是图标画出来颜色错位 / 上下颠倒，
 * 而 Windows 不会报任何错。所以脚本把自己写出去的字节再读回来逐像素比对（见 verifyIco /
 * verifyIcns），**这一步是承重的，别删**：它是这个脚本唯一能自证正确的地方。
 */
import { createHash } from 'node:crypto'
import { existsSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import sharp from 'sharp'

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

const MASTER_SIZE = 512
// 小尺寸走 DIB：Windows 对 ≤48 这些传统尺寸认 DIB 最稳。256 走 PNG——它的 DIB 要 256 KB，
// PNG 只要几 KB，而这张图剩下的体量本来就在 256 上。
const ICO_BMP_SIZES = [16, 32, 48, 64, 128]
const ICO_PNG_SIZE = 256
// ic11/ic12 是 16@2x / 32@2x，ic07/ic08/ic09 是 128/256/512。macOS 按**像素尺寸**取用，
// 不按 type 的字面含义，所以这一组覆盖了所有档位、且没有重复像素。
const ICNS_CHUNKS = [
  ['ic11', 32],
  ['ic12', 64],
  ['ic07', 128],
  ['ic08', 256],
  ['ic09', 512]
]

const OUT = {
  master: resolve('build/icon.png'),
  ico: resolve('build/icon.ico'),
  icns: resolve('build/icon.icns'),
  windowIcon: resolve('resources/icon.png')
}

const arg = process.argv[2]
const src = arg === undefined ? OUT.master : resolve(arg)
if (!existsSync(src)) {
  console.error(`找不到源图：${src}`)
  console.error('用法：node scripts/make-icon.mjs <源图>（不给参数则拿 build/icon.png 重新派生）')
  process.exit(1)
}

/** 主稿：一次裁成正方形，之后所有档位都从它派生（避免每档各裁一次、裁出不一样的结果） */
const meta = await sharp(src).metadata()
const master = await sharp(src)
  .rotate() // 按 EXIF orientation 摆正；没有这个 tag 时是空操作
  .resize(MASTER_SIZE, MASTER_SIZE, { fit: 'cover', position: 'centre' })
  .png()
  .toBuffer()

const aspect = (meta.width ?? 0) / (meta.height ?? 1)
console.log(`${src}`)
console.log(
  `  源图 ${meta.width}×${meta.height} ${meta.format}（${meta.hasAlpha ? '带 alpha' : '无 alpha'}）`
)
if (Math.abs(aspect - 1) > 0.05) {
  console.warn(
    `  ⚠️ 源图不是方的（宽高比 ${aspect.toFixed(3)}），按 cover 居中裁切到正方形——` +
      `如果裁掉了不该裁的地方，请先自己补成方形再喂进来。`
  )
}
if ((meta.width ?? 0) < MASTER_SIZE) {
  console.warn(
    `  ⚠️ 源图最宽只有 ${meta.width}px，放大到 ${MASTER_SIZE} 会偏软（这是源图的上限，不是脚本的问题）。`
  )
}

/** 某一档的 RGBA 原始像素。build 与 verify 都走它，两侧才可能在同一个基准上比对 */
function render(size) {
  return sharp(master)
    .resize(size, size, { fit: 'fill', kernel: 'lanczos3' })
    .ensureAlpha()
    .raw()
    .toBuffer()
}

/**
 * 一档 DIB（= ICO 里那种「BITMAPINFOHEADER + 像素」，不是独立 .bmp 文件）。
 *
 * 三个必须记住的点：
 * - **高度写两倍**：DIB 的下半是 XOR 位图、上半是 AND 掩码，`biHeight` 是两者之和。
 * - **行自下而上**：DIB 的原点在左下角，写的时候要倒着来。
 * - **掩码必须存在**：32bpp 下 Windows 忽略它，但少了这几行整个条目的长度就不对了。
 */
function dibEntry(rgba, size) {
  const header = Buffer.alloc(40)
  header.writeUInt32LE(40, 0) // biSize
  header.writeInt32LE(size, 4) // biWidth
  header.writeInt32LE(size * 2, 8) // biHeight = XOR + AND
  header.writeUInt16LE(1, 12) // biPlanes
  header.writeUInt16LE(32, 14) // biBitCount
  header.writeUInt32LE(0, 16) // biCompression = BI_RGB
  header.writeUInt32LE(size * size * 4, 20) // biSizeImage

  const xor = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y++) {
    const srcRow = (size - 1 - y) * size * 4 // 目标第 y 行来自源的第 (size-1-y) 行
    for (let x = 0; x < size; x++) {
      const s = srcRow + x * 4
      const d = (y * size + x) * 4
      xor[d] = rgba[s + 2] // B
      xor[d + 1] = rgba[s + 1] // G
      xor[d + 2] = rgba[s] // R
      xor[d + 3] = rgba[s + 3] // A
    }
  }

  const maskRowBytes = Math.ceil(size / 32) * 4 // 1bpp，行按 4 字节对齐
  const and = Buffer.alloc(maskRowBytes * size) // 全 0
  return Buffer.concat([header, xor, and])
}

/** entries: [{ size, buf }] */
function buildIco(entries) {
  const dir = Buffer.alloc(6)
  dir.writeUInt16LE(0, 0) // reserved
  dir.writeUInt16LE(1, 2) // type = icon
  dir.writeUInt16LE(entries.length, 4)

  // **目录必须整块在前、载荷整块在后**。第一版把「目录项、载荷」交替着 concat，
  // 出来的仍然是个结构合法的 ICO，只是每个条目的 offset 都指到了别的条目头上——
  // Windows 那边表现为图标花掉，它自己不会报任何错。回读校验就是在这里把它挡下的。
  const records = []
  const payloads = []
  let offset = 6 + entries.length * 16
  for (const entry of entries) {
    const rec = Buffer.alloc(16)
    // 256 在这个字节里记 0（一字节放不下 256）
    rec[0] = entry.size >= 256 ? 0 : entry.size
    rec[1] = entry.size >= 256 ? 0 : entry.size
    rec[2] = 0 // 调色板数（真彩不需要）
    rec[3] = 0 // reserved
    rec.writeUInt16LE(1, 4) // planes
    rec.writeUInt16LE(32, 6) // bitCount
    rec.writeUInt32LE(entry.buf.length, 8)
    rec.writeUInt32LE(offset, 12)
    offset += entry.buf.length
    records.push(rec)
    payloads.push(entry.buf)
  }
  return Buffer.concat([dir, ...records, ...payloads])
}

/** chunks: [{ type, buf }] */
function buildIcns(chunks) {
  const body = Buffer.concat(
    chunks.map(({ type, buf }) => {
      const head = Buffer.alloc(8)
      head.write(type, 0, 'ascii')
      head.writeUInt32BE(8 + buf.length, 4)
      return Buffer.concat([head, buf])
    })
  )
  const head = Buffer.alloc(8)
  head.write('icns', 0, 'ascii')
  head.writeUInt32BE(8 + body.length, 4)
  return Buffer.concat([head, body])
}

/** 把写出去的 ICO 读回来，逐像素与 render(size) 比对。返回不一致的描述（空数组 = 没问题） */
async function verifyIco(buf) {
  const problems = []
  const count = buf.readUInt16LE(4)
  if (6 + count * 16 > buf.length) return ['ICONDIR 声明的条目数比文件还大']

  for (let i = 0; i < count; i++) {
    const rec = 6 + i * 16
    const size = buf[rec] === 0 ? 256 : buf[rec]
    const len = buf.readUInt32LE(rec + 8)
    const off = buf.readUInt32LE(rec + 12)
    if (off + len > buf.length) {
      problems.push(`#${i} 载荷越界（off=${off} len=${len}，文件只有 ${buf.length}）`)
      continue
    }

    const payload = buf.subarray(off, off + len)
    const want = await render(size)
    let got
    if (payload.subarray(0, 8).equals(PNG_SIG)) {
      got = await sharp(payload).ensureAlpha().raw().toBuffer()
    } else {
      // 按 dibEntry 的逆运算读回来：跳过 40 字节头，再自下而上的 BGRA
      got = Buffer.alloc(size * size * 4)
      for (let y = 0; y < size; y++) {
        const row = (size - 1 - y) * size * 4
        for (let x = 0; x < size; x++) {
          const s = 40 + row + x * 4
          const d = (y * size + x) * 4
          got[d] = payload[s + 2]
          got[d + 1] = payload[s + 1]
          got[d + 2] = payload[s]
          got[d + 3] = payload[s + 3]
        }
      }
    }

    if (!got.equals(want)) {
      let diff = 0
      for (let k = 0; k < want.length; k++) if (got[k] !== want[k]) diff += 1
      problems.push(`#${i} ${size}×${size} 像素对不上（${diff} / ${want.length} 字节不同）`)
    }
  }
  return problems
}

/** 把写出去的 ICNS 读回来，确认每块是合法 PNG 且尺寸对得上 */
async function verifyIcns(buf) {
  const problems = []
  if (buf.subarray(0, 4).toString('ascii') !== 'icns') return ['魔数不是 icns']
  if (buf.readUInt32BE(4) !== buf.length) {
    problems.push(`头部记的总长 ${buf.readUInt32BE(4)} 与文件实际长度 ${buf.length} 不一致`)
  }

  let offset = 8
  let seen = 0
  while (offset + 8 <= buf.length) {
    const type = buf.subarray(offset, offset + 4).toString('ascii')
    const len = buf.readUInt32BE(offset + 4)
    if (len < 8 || offset + len > buf.length) {
      problems.push(`${type} 的块长 ${len} 越界`)
      break
    }
    const payload = buf.subarray(offset + 8, offset + len)
    const expected = ICNS_CHUNKS.find(([t]) => t === type)?.[1]
    if (expected === undefined) {
      problems.push(`${type} 不在预期清单里`)
    } else {
      const info = await sharp(payload).metadata()
      if (info.width !== expected || info.height !== expected) {
        problems.push(`${type} 应为 ${expected}×${expected}，实际 ${info.width}×${info.height}`)
      }
    }
    seen += 1
    offset += len
  }
  if (seen !== ICNS_CHUNKS.length) problems.push(`块数 ${seen}，期望 ${ICNS_CHUNKS.length}`)
  return problems
}

// ── 生成 ────────────────────────────────────────────────────────────────────

const icoEntries = []
for (const size of ICO_BMP_SIZES) icoEntries.push({ size, buf: dibEntry(await render(size), size) })
icoEntries.push({
  size: ICO_PNG_SIZE,
  buf: await sharp(master).resize(ICO_PNG_SIZE).png().toBuffer()
})

const icnsChunks = []
for (const [type, size] of ICNS_CHUNKS) {
  icnsChunks.push({ type, buf: await sharp(master).resize(size, size).png().toBuffer() })
}

const ico = buildIco(icoEntries)
const icns = buildIcns(icnsChunks)

// ── 自证 ────────────────────────────────────────────────────────────────────

const problems = [...(await verifyIco(ico)), ...(await verifyIcns(icns))]
if (problems.length > 0) {
  console.error('\n❌ 生成的图标没通过回读校验，**没有落盘**：')
  for (const p of problems) console.error(`   ${p}`)
  process.exit(1)
}

// ── 落盘 ────────────────────────────────────────────────────────────────────

writeFileSync(OUT.master, master)
writeFileSync(OUT.ico, ico)
writeFileSync(OUT.icns, icns)
writeFileSync(OUT.windowIcon, master) // 与主稿逐字节相同：同一个东西不该有两份内容

const kb = (b) => `${(b.length / 1024).toFixed(1)} KB`
console.log('\n回读校验通过（每个档位都逐像素比对过），已写入：')
for (const [label, path, buf] of [
  ['主稿 512×512 PNG  ', OUT.master, master],
  ['ICO 16~256        ', OUT.ico, ico],
  ['ICNS 32~512       ', OUT.icns, icns],
  ['窗口图标(同主稿)  ', OUT.windowIcon, master]
]) {
  console.log(`  ${label} ${kb(buf).padStart(9)}  ${path}`)
  console.log(`  ${' '.repeat(18)}sha256 ${createHash('sha256').update(buf).digest('hex')}`)
}
