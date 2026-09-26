/**
 * 「检查更新」的**判据层**：零 IO、零网络、零依赖。
 *
 * ## 为什么单独一个文件
 *
 * `update.mjs` 要发网络请求、要读磁盘、要起子进程，全都不适合在测试里真跑。
 * 而这一层里每一条判据都**会静默出错**——
 *
 *   - 版本比较写反了 → 用户看到「已是最新」而其实落后两个版本；
 *   - 把 `.blockmap` 当成安装包 → 下回来一个 155 KB 的文件，还报告成功；
 *   - 哈希比错了 → 装上去的是个半截文件，而且**没有任何地方会报错**。
 *
 * 所以判据与 IO 分开，前者可以在没有网络、没有磁盘、没有应用的机器上逐条喂。
 * 这与 `src/mcp/` 里 `readPlan.ts` / `verify.ts` 从它们各自的执行层拆出来是同一条规矩。
 *
 * ## 这一层不认识「失败」
 *
 * 所有函数对「读不懂的输入」一律返回 `null` / `'unknown'` / 空集合，**不抛**。
 * 「查不到最新版本」与「已经是最新版本」是**两个不同的答案**，调用方必须能把它们分开——
 * 所以这里给的是 `'unknown'`，而不是把未知悄悄折成 `'up-to-date'`。
 */

/**
 * 解析版本号。接受 `1.2.3` / `v1.2.3` / `1.2` / `1.2.3-beta.1` / `1.2.3+build`。
 *
 * 前导 `v` 是**必须**处理的：GitHub 的 tag 是 `v0.3.5`，而 `package.json` 里的
 * version 是 `0.3.5`。这两者要能比。
 */
export function parseVersion(text) {
  if (typeof text !== 'string') return null
  const m = /^v?(\d+(?:\.\d+)*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(text.trim())
  if (!m) return null
  const nums = m[1].split('.').map((part) => Number(part))
  if (nums.some((n) => !Number.isSafeInteger(n) || n < 0)) return null
  return { nums, pre: m[2] ?? null }
}

/** 预发布段之间的比较（semver §11）。数字段按数值比，且**数字段小于字母段**。 */
function comparePrerelease(a, b) {
  const as = a.split('.')
  const bs = b.split('.')
  const len = Math.max(as.length, bs.length)
  for (let i = 0; i < len; i += 1) {
    const x = as[i]
    const y = bs[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const xn = /^\d+$/.test(x)
    const yn = /^\d+$/.test(y)
    if (xn && yn) {
      const d = Number(x) - Number(y)
      if (d !== 0) return d < 0 ? -1 : 1
      continue
    }
    if (xn) return -1
    if (yn) return 1
    if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

/**
 * 比较两个版本号：`a` 比 `b` 新返回 `1`，旧返回 `-1`，相同返回 `0`。
 *
 * **任一侧解析不出来就返回 `null`**——不是 0。把「比不出来」答成「一样新」
 * 会让一个坏 tag 悄悄变成「你已经是最新的」。
 *
 * 位数不同时短的一方按 0 补（`1.2` == `1.2.0`），这是 semver 的规矩。
 * 预发布段比正式版**旧**：`1.0.0-rc.1 < 1.0.0`。
 */
export function compareSemver(a, b) {
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  if (pa === null || pb === null) return null

  const len = Math.max(pa.nums.length, pb.nums.length)
  for (let i = 0; i < len; i += 1) {
    const x = pa.nums[i] ?? 0
    const y = pb.nums[i] ?? 0
    if (x !== y) return x < y ? -1 : 1
  }

  if (pa.pre === null && pb.pre === null) return 0
  if (pa.pre === null) return 1
  if (pb.pre === null) return -1
  return comparePrerelease(pa.pre, pb.pre)
}

/**
 * 从 release 的 assets 里挑出安装包。挑不到返回 `null`。
 *
 * ⚠️ **判据是「以后缀收尾」而不是「包含」**：
 * `.blockmap` 的文件名长这样——`Arbiter-0.3.5-setup.exe.blockmap`——它**含有** `setup.exe`
 * 这个子串，所以 `name.includes('setup.exe')` 会同时匹配上两者，选中哪个就取决于
 * GitHub 返回数组的顺序（选中 `.blockmap` 的后果：下回来一个 155 KB 的差分包，流程还报成功）。
 *
 * 实测（2026-09-26）那份 release 的三个资产顺序是【安装包、`.blockmap`、`SHA256SUMS.txt`】——
 * 也就是说 `includes` 那种写法**这一次侥幸没踩中**。但那是 GitHub 返回数组的顺序，不是承诺，
 * 换一台机器、换一次请求都可能变；而真踩中的后果是悄悄下回来一个 155 KB 的差分包。
 * 还刻意**不写死版本号**：文件名来自 `electron-builder.yml` 的
 * `artifactName: ${productName}-${version}-setup.${ext}`，写死会在下次升版本时失效。
 */
export function pickSetupAsset(assets) {
  if (!Array.isArray(assets)) return null
  const found = assets.find(
    (asset) => typeof asset?.name === 'string' && asset.name.endsWith('-setup.exe')
  )
  return found ?? null
}

/**
 * 取一个 asset 的 sha256，取不到返回 `null`。
 *
 * 优先用 GitHub API 自带的 `digest` 字段（形如 `sha256:082e1fcb…`）：它**零额外请求**，
 * 不必再去下一份 `SHA256SUMS.txt`。实测（2026-09-26，v0.3.5）两者**逐字相同**，
 * 所以 `digest` 拿不到时（老资产可能是空串）回落去解析 `SHA256SUMS.txt` 是安全的。
 */
export function sha256OfAsset(asset) {
  const digest = asset?.digest
  if (typeof digest !== 'string') return null
  const m = /^sha256:([0-9a-fA-F]{64})$/.exec(digest.trim())
  return m === null ? null : m[1].toLowerCase()
}

/**
 * 解析 `SHA256SUMS.txt`，返回 `文件名 → 小写 sha256`。
 *
 * 行格式是 `<64 位十六进制><两个空格><文件名>`——两空格是 `sha256sum` 与
 * PowerShell `Get-FileHash` 那两族工具的共同约定（本项目的 CI 用后者生成，
 * 见 `.github/workflows/release.yml` 的 `Compute checksums` 一步）。
 * 有的实现会在文件名前加一个 `*`（二进制模式标记），一并吃掉。
 *
 * 认不出的行**跳过**而不是抛：这份文件将来多一行注释或换一种写法时，
 * 整条检查不该因此整个失败——真正承重的是「用到的那个哈希对不对」。
 */
export function parseSha256Sums(text) {
  const out = new Map()
  if (typeof text !== 'string') return out
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const m = /^([0-9a-fA-F]{64})\s+\*?(.+)$/.exec(line)
    if (m === null) continue
    out.set(m[2].trim(), m[1].toLowerCase())
  }
  return out
}

/** 两个 sha256 是不是同一个（忽略大小写）。任一侧不是字符串就是「不同」。 */
export function sameSha256(a, b) {
  return typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase()
}

/**
 * 版本比对结论：`'update-available'` / `'up-to-date'` / `'unknown'`。
 *
 * ⚠️ **第三个取值是这一层的全部意义所在。** `'unknown'` 表示「这次没能比」——
 * 没查到最新版本、拿到一个读不懂的 tag、本机版本读不出来，都落这里。
 * 调用方**必须**把它与 `'up-to-date'` 分开说：把「查不到」讲成「已是最新」
 * 是在替用户下一个我们并不知道的结论，而这个错误的方向恰好是「让他以为自己不用更新」。
 */
export function decideUpdate({ installed, latest }) {
  if (typeof installed !== 'string' || typeof latest !== 'string') return 'unknown'
  const cmp = compareSemver(latest, installed)
  if (cmp === null) return 'unknown'
  return cmp > 0 ? 'update-available' : 'up-to-date'
}
