// 提取原生 pandoc.exe 到 resources/engines/pandoc/。
//
// 为什么不用 pandoc-wasm：实测它会阻塞事件循环——79 KiB 输入转一次 4189 ms，
// 期间 10 ms 定时器触发 0 次（预期约 418 次）。在 Electron 主进程里这等于整个应用
// 卡死，推不了进度也取不了消，直接违反「主进程推增量进度」这个前提。它还是 ESM-only
// 加 top-level await，与主进程的 CJS 对不上，而且实测图片不嵌入。
//
// 为什么不从官方发行版拿：pandoc 的官方 win 包只放 GitHub Releases，这台机器直连
// 不通（HTTP 000）。清华 TUNA 的 PyPI 上 `pypandoc-binary` 这个 wheel 里装的正是
// 官方原版的 pandoc.exe —— 单个自包含 exe（231,717,128 字节），不需要任何 DLL，
// 连默认 reference.docx 和语法高亮定义都在 exe 内部。走国内镜像反而稳定。
//
//   node scripts/fetch-pandoc.mjs [--force]
import { createHash } from 'crypto'
import { existsSync, mkdirSync, writeFileSync, rmSync, statSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'
import { inflateRawSync } from 'zlib'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** wheel 里的条目名。pypandoc 把二进制原样放在 pypandoc/files/ 下，不带版本后缀。 */
const ENTRY = 'pypandoc/files/pandoc.exe'

const VERSION = '1.17'
/** 与 PyPI 索引页上公布的 sha256 一致；校验它可以整份地锁住 pandoc.exe 的内容 */
const WHEEL_SHA256 = '76fae066cd2d7e78fb97f0ec8e9e36f437b07187b689b0b415ca18216f8f898a'
/** 解出来的 exe 大小，兜住「zip 解析写错了但不报错」的情况 */
const PANDOC_BYTES = 231717128

const HASH_DIR = 'c6/b9/f47b77ba75ed5d47ec85fcc2ecfbf7f78e3a73347f3a09836634d930de98'
const FILENAME = `pypandoc_binary-${VERSION}-py3-none-win_amd64.whl`
const MIRRORS = [
  `https://pypi.tuna.tsinghua.edu.cn/packages/${HASH_DIR}/${FILENAME}`,
  `https://files.pythonhosted.org/packages/${HASH_DIR}/${FILENAME}`
]

const DEST = join(ROOT, 'resources', 'engines', 'pandoc')
const TARGET = join(DEST, 'pandoc.exe')

/**
 * 极简 zip 读取器，只认「按 central directory 找条目、再按 local header 定位数据」。
 * 不引依赖：zip 的中央目录结构二十年没变过，而这一个包我们只抽一个条目。
 *
 * @param {Buffer} buffer wheel 原始字节
 * @param {string} entryName 要抽出的条目名
 * @returns {Buffer} 条目内容（已解压）
 */
function extractFromZip(buffer, entryName) {
  // EOCD 在文件末尾，注释最长 65535 字节，所以从尾部往前扫这段就够了
  let eocd = -1
  for (let i = buffer.length - 22; i >= 0 && i > buffer.length - 66000; i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('找不到 zip 结尾记录，文件可能没下全')

  const count = buffer.readUInt16LE(eocd + 10)
  let offset = buffer.readUInt32LE(eocd + 16)

  for (let n = 0; n < count; n += 1) {
    const method = buffer.readUInt16LE(offset + 10)
    const compressed = buffer.readUInt32LE(offset + 20)
    const nameLen = buffer.readUInt16LE(offset + 28)
    const extraLen = buffer.readUInt16LE(offset + 30)
    const commentLen = buffer.readUInt16LE(offset + 32)
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLen)

    if (name === entryName) {
      // 条目数据的位置只在 local header 里精确（它自己的 name/extra 长度可能与中央目录不同）
      const local = buffer.readUInt32LE(offset + 42)
      const localNameLen = buffer.readUInt16LE(local + 26)
      const localExtraLen = buffer.readUInt16LE(local + 28)
      const start = local + 30 + localNameLen + localExtraLen
      const raw = buffer.subarray(start, start + compressed)

      if (method === 0) return Buffer.from(raw)
      if (method === 8) return inflateRawSync(raw)
      throw new Error(`不认识的压缩方式 ${method}`)
    }

    offset += 46 + nameLen + extraLen + commentLen
  }

  throw new Error(`wheel 里没有 ${entryName}，包结构可能变了`)
}

const force = process.argv.includes('--force')

if (!force && existsSync(TARGET) && statSync(TARGET).size === PANDOC_BYTES) {
  console.log('已存在，跳过。要重新拉取加 --force')
  console.log(' ', TARGET, statSync(TARGET).size, 'bytes')
  process.exit(0)
}

let wheel = null
let from = ''
for (const url of MIRRORS) {
  process.stdout.write(`下载 ${FILENAME} … `)
  try {
    const response = await fetch(url)
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    wheel = Buffer.from(await response.arrayBuffer())
    from = new URL(url).host
    console.log(`${(wheel.length / 1024 / 1024).toFixed(1)} MB（${from}）`)
    break
  } catch (error) {
    console.log(`失败（${error.message}），换下一个源`)
  }
}

if (!wheel) {
  console.error('\n所有镜像都拉不到。请检查网络，或改用 ghfast.top 代理取官方 zip。')
  process.exit(1)
}

// 先验 wheel 再解包：镜像换源时，这一步能防住「拿到的其实是另一个版本」
const wheelSha = createHash('sha256').update(wheel).digest('hex')
if (wheelSha !== WHEEL_SHA256) {
  console.error(`\nwheel 的 sha256 对不上：\n  期望 ${WHEEL_SHA256}\n  实得 ${wheelSha}`)
  process.exit(1)
}

const pandoc = extractFromZip(wheel, ENTRY)
if (pandoc.length !== PANDOC_BYTES) {
  console.error(`\npandoc.exe 大小对不上：期望 ${PANDOC_BYTES}，实得 ${pandoc.length}`)
  process.exit(1)
}

mkdirSync(DEST, { recursive: true })
rmSync(TARGET, { force: true })
writeFileSync(TARGET, pandoc)

const sha = createHash('sha256').update(pandoc).digest('hex')
console.log(`写出 ${TARGET}`)
console.log(`  ${(pandoc.length / 1024 / 1024).toFixed(1)} MB  sha256:${sha}`)
console.log('\n完成。text/md/html → docx 已就绪（单文件自包含，不需要任何 DLL）。')
