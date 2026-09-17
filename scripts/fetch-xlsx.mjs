#!/usr/bin/env node
/**
 * 重新进一份 `xlsx` 的 vendor tarball（`vendor/xlsx-<版本>.tgz`）。
 *
 * ## 平时不需要跑它
 *
 * `vendor/` 里的 tarball **已经随仓库提交**，所以新 clone / CI 上 `npm ci` 直接就能用，
 * 与本项目的 `fetch-bundled-engines.mjs` / `fetch-pandoc.mjs` **形态不同**——
 * 那两个是「跑一次、产物进 `resources/engines/`，而那个目录不进版本控制」。
 * 这个脚本的语义只有一个：**升级版本时重新进一次货**。
 *
 * 用法：
 *
 * ```bash
 * node scripts/fetch-xlsx.mjs 0.20.3      # 不带参数则用 DEFAULT_VERSION
 * ```
 *
 * ## 那道 sha256 校验是真的还是装饰，取决于 `KNOWN` 这张表怎么填
 *
 * ⚠️ **表里的哈希只能人工核对后填进去。** 如果让脚本「下载 → 自己算哈希 → 自己信」，
 * 那它只是把下载到的东西原样放行，一道闸都没有——那正是本项目反复记的
 * 「装饰性断言」。所以：**版本不在表里 → 直接拒绝写入**，并把实测到的
 * sha256 / 字节数打出来，由人从另一个可信来源核对之后再补进 `KNOWN`。
 *
 * 另一条同样承重：`vendor/README.md` 与 `package.json` 里的版本**不会被这个脚本改**。
 * 脚本只管把文件放到位、然后打印下一步要改哪儿——它替你把关，但**不替你做决定**。
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const VENDOR_DIR = join(ROOT, 'vendor')

const DEFAULT_VERSION = '0.20.3'

/**
 * 已人工核对过的版本 → 期望值。
 *
 * ⚠️ 加新版本时，`sha256` / `bytes` **必须**来自一次独立核对（换一个网络、
 * 换一台机器、或者与 SheetJS 官方发布的哈希对上），不能是上一次运行这个脚本
 * 自己打印出来的那串——那等于让被测对象给自己出题。
 *
 * `bytes` 是第二道闸：它挡不住定向篡改，但能一眼看穿「下到了半截 / 下到了错误页」，
 * 而那种情况下 sha256 报错的原因会很难读。
 */
const KNOWN = {
  '0.20.3': {
    sha256: '8dc73fc3b00203e72d176e85b50938627c7b086e607c682e8d3c22c02bb99fe8',
    bytes: 2409319
  }
}

function fail(message) {
  console.error(`\n✗ ${message}\n`)
  process.exit(1)
}

const version = process.argv[2] ?? DEFAULT_VERSION
const expected = KNOWN[version]

const url = `https://cdn.sheetjs.com/xlsx-${version}/xlsx-${version}.tgz`
const dest = join(VENDOR_DIR, `xlsx-${version}.tgz`)

console.log(`下载 ${url}`)

let buffer
try {
  const response = await fetch(url)
  if (!response.ok) {
    fail(
      `${url} 回了 HTTP ${response.status}。\n  版本号是不是写错了？可用的版本见 https://cdn.sheetjs.com/`
    )
  }
  buffer = Buffer.from(await response.arrayBuffer())
} catch (error) {
  fail(
    `下载失败：${error instanceof Error ? error.message : String(error)}\n` +
      `  这条链路没有镜像可回退（见 vendor/README.md），网络不通就只能换个时间再试。`
  )
}

const actual = {
  sha256: createHash('sha256').update(buffer).digest('hex'),
  bytes: buffer.length
}

console.log(`  字节数 = ${actual.bytes}`)
console.log(`  sha256 = ${actual.sha256}`)

if (expected === undefined) {
  // 关键分支：**不写盘**。让脚本自己算、自己信，等于把校验这件事删掉。
  fail(
    `版本 ${version} 不在 KNOWN 表里，拒绝写入。\n\n` +
      `  先把上面这两行拿去做一次独立核对（换网络 / 换机器 / 对官方公布的哈希），\n` +
      `  核对无误之后补进 scripts/fetch-xlsx.mjs 的 KNOWN 表：\n\n` +
      `      '${version}': {\n` +
      `        sha256: '${actual.sha256}',\n` +
      `        bytes: ${actual.bytes}\n` +
      `      }\n\n` +
      `  ⚠️ 核对这一步不能省，也不能拿「上一次跑这个脚本打出来的」充当核对——\n` +
      `  那等于让被测对象给自己出题。`
  )
}

if (actual.bytes !== expected.bytes) {
  fail(
    `字节数对不上：期望 ${expected.bytes}，实际 ${actual.bytes}。\n  大概率是下到了半截或错误页，别写入。`
  )
}

if (actual.sha256 !== expected.sha256) {
  fail(
    `sha256 对不上：\n  期望 ${expected.sha256}\n  实际 ${actual.sha256}\n\n` +
      `  **别急着把 KNOWN 表改成实际值**——先弄清楚为什么不一样。\n` +
      `  哈希不匹配是这道闸唯一的作用，绕过它等于没有闸。`
  )
}

if (existsSync(dest)) {
  const onDisk = createHash('sha256').update(readFileSync(dest)).digest('hex')
  if (onDisk === expected.sha256) {
    console.log(`\n✓ ${dest} 已存在且哈希吻合，无需改动。`)
    process.exit(0)
  }
  fail(`盘上已有的 ${dest} 哈希对不上（${onDisk}），先查清楚它是什么再覆盖。`)
}

mkdirSync(VENDOR_DIR, { recursive: true })
writeFileSync(dest, buffer)
console.log(`\n✓ 已写入 ${dest}`)

console.log(
  `
接下来手动做两件事（这个脚本不替你做决定）：

  1. package.json 里那一行的版本要跟着改：

         "xlsx": "file:vendor/xlsx-${version}.tgz"

  2. 重新解析 lock（**不能只在盘上换文件**——lock 里的 integrity 是 npm 自己算的
     sha512，少这一步，npm ci 会因为 lock 与 package.json 对不上而失败）：

         npm install

  3. 顺手把 vendor/README.md 顶部的表格改成新的版本 / 字节数 / sha256，
     并确认旧版本的 tarball 已从 vendor/ 里删掉（留着会让仓库白胖一圈，
     而且下一个人分不清哪一份才是 package.json 指的那份）。
`
)
