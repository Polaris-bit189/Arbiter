// 提取完整版 7z.exe + 7z.dll 到 resources/engines/7zip-full/。
//
// 为什么需要完整版：npm 上的 `7zip-bin` 发的是 standalone 的 `7za.exe`，
// 它**一个 RAR 编解码器都没有**，遇到 .rar 只会报 "Cannot open the file as archive"。
// 完整版的编解码器都在同目录的 `7z.dll` 里，两个文件必须一起放。
//
// 为什么不从官方安装包拿：7-zip.org 的下载链接会 302 到 GitHub Releases，
// 国内基本拉不动。`7zip-bin-full` 这个 npm 包装的正是官方原版二进制
// （win/x64/7z.exe + 7z.dll），走 npm 镜像反而稳定，内容也是同一份。
//
// 用它当 devDependency 是不划算的：整包解压后 80 MB，因为塞了全平台全架构，
// 而我们只要 win/x64 那两个文件（约 2.4 MB）。所以下载 tarball 后只抽这两份。
//
//   node scripts/fetch-bundled-engines.mjs [--force]
import { createHash } from 'crypto'
import { mkdirSync, existsSync, readFileSync, writeFileSync, rmSync } from 'fs'
import { gunzipSync } from 'zlib'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PKG = '7zip-bin-full'
const VERSION = process.env.SEVENZIP_FULL_VERSION ?? '26.3.1'
const MIRRORS = [
  `https://registry.npmmirror.com/${PKG}/-/${PKG}-${VERSION}.tgz`,
  `https://registry.npmjs.org/${PKG}/-/${PKG}-${VERSION}.tgz`
]

/** 只抽这两个：7z.exe 是瘦壳，编解码器全在 7z.dll 里，缺一个都跑不起来 */
const WANTED = ['package/win/x64/7z.exe', 'package/win/x64/7z.dll']

const DEST = join(ROOT, 'resources', 'engines', '7zip-full')

/**
 * 极简 tar 读取器。
 * 不想为了抽两个文件去引 tar 依赖，也不想依赖系统装没装 tar
 * （Windows 上不保证有，而且 Git Bash 的 tar 行为随版本变过）。
 *
 * @param {Buffer} buffer 解压后的 tar 字节
 * @param {string[]} wanted 要抽出的条目名
 * @returns {Map<string, Buffer>} 条目名 → 文件内容
 */
function untar(buffer, wanted) {
  const found = new Map()
  let offset = 0

  while (offset + 512 <= buffer.length) {
    const name = buffer.toString('utf8', offset, offset + 100).replace(/\0.*$/, '')
    if (name === '') break // 连续两个全零块 = 归档结束

    const sizeText = buffer
      .toString('utf8', offset + 124, offset + 136)
      .replace(/\0.*$/, '')
      .trim()
    const size = parseInt(sizeText, 8) || 0
    const dataStart = offset + 512

    if (wanted.includes(name)) {
      found.set(name, Buffer.from(buffer.subarray(dataStart, dataStart + size)))
    }

    // tar 按 512 字节对齐，所以要向上取整
    offset = dataStart + Math.ceil(size / 512) * 512
  }

  return found
}

/**
 * @param {string} url
 * @returns {Promise<Buffer>} 响应体
 */
async function download(url) {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return Buffer.from(await response.arrayBuffer())
}

const force = process.argv.includes('--force')
const targets = WANTED.map((name) => join(DEST, name.split('/').pop()))

if (!force && targets.every(existsSync)) {
  console.log('已存在，跳过。要重新拉取加 --force')
  for (const t of targets) console.log(' ', t, readFileSync(t).length, 'bytes')
  process.exit(0)
}

mkdirSync(DEST, { recursive: true })

let archive = null
for (const url of MIRRORS) {
  process.stdout.write(`下载 ${PKG}@${VERSION} … `)
  try {
    archive = await download(url)
    console.log(`${(archive.length / 1024 / 1024).toFixed(1)} MB`)
    break
  } catch (error) {
    console.log(`失败（${error.message}），换下一个源`)
  }
}

if (!archive) {
  console.error('\n所有镜像都拉不到。国内网络下 registry.npmmirror.com 通常可用，请检查网络。')
  process.exit(1)
}

const files = untar(gunzipSync(archive), WANTED)
for (const name of WANTED) {
  if (!files.has(name)) {
    console.error(`\n包里没有 ${name}，包结构可能变了。`)
    process.exit(1)
  }
}

for (const name of WANTED) {
  const data = files.get(name)
  const target = join(DEST, name.split('/').pop())
  rmSync(target, { force: true })
  writeFileSync(target, data)
  const sha = createHash('sha256').update(data).digest('hex').slice(0, 16)
  console.log(`写出 ${target}  ${(data.length / 1024).toFixed(0)} KB  sha256:${sha}…`)
}

console.log('\n完成。RAR / RAR5 支持已就绪（7z.exe 与 7z.dll 必须同目录）。')
