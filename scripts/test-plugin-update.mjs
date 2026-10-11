/**
 * 「检查更新」的判据与接口。
 *
 * ## 这一套的重点在哪
 *
 * 这个功能**每一条判据出错都不会抛异常**，只会安静地说错话：
 *
 *   - 版本比较写反 → 报「已是最新」而其实落后两版；
 *   - 把 `.blockmap` 当安装包 → 下回来一个 155 KB 的差分包，报成功；
 *   - 哈希没比 → 一个半截的安装包被当成好的留在磁盘上；
 *   - 把「没查成」折成「已是最新」 → 用户以为自己不用更新（**方向最坏的一条**）。
 *
 * 所以这里的断言全落在「它说了什么」而不是「它有没有崩」。
 *
 * ## 不碰真网络
 *
 * `fetch` 是**注入**的（照 `src/main/core/downlink.ts` 的 `DownloadTransport` 先例）。
 * 唯一的真实资源是现场造的临时目录——用 `mkdtempSync`，跑完删掉。
 * 素材用的是**实测抓下来的真数据**（v0.3.5 那三个资产、91 字节的 `SHA256SUMS.txt`），
 * 不是编的：形状错一点的 fixture 会让断言在真实数据上失效。
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  compareSemver,
  decideUpdate,
  parseSha256Sums,
  parseVersion,
  pickSetupAsset,
  sameSha256,
  sha256OfAsset
} from '../plugins/arbiter/mcp/updatePlan.mjs'
import {
  checkUpdate,
  classifyFetchError,
  partPathOf,
  readAppVersion,
  readPluginVersions,
  sha256OfFile
} from '../plugins/arbiter/mcp/update.mjs'

let passed = 0
let failed = 0

function check(label, ok, detail = '') {
  if (ok) {
    passed += 1
    console.log(`  ✔ ${label}`)
  } else {
    failed += 1
    console.log(`  ✗ ${label}${detail === '' ? '' : `  —— ${detail}`}`)
  }
}

// —— 实测抓下来的真数据（2026-09-26，release v0.3.5）——
// ⚠️ 顺序是**照抄 API 返回的**（安装包在前、blockmap 在后），
// 因为下面有一条断言专门测「blockmap 排前面时会不会选错」——那条不能靠这份顺序。
const SETUP = 'Arbiter-0.3.5-setup.exe'
const SETUP_SHA = '082e1fcb1198bb437a8d7f644181b7dc5a17341df988372934aad0bde7a05cf2'
const REAL_ASSETS = [
  {
    name: SETUP,
    size: 147372016,
    digest: `sha256:${SETUP_SHA}`,
    browser_download_url: `https://github.com/Polaris-bit189/Arbiter/releases/download/v0.3.5/${SETUP}`
  },
  {
    name: `${SETUP}.blockmap`,
    size: 154697,
    digest: 'sha256:5e8b21114ef39476874623bf52659a743c43cae3d355a1629fdcacd55d248f16',
    browser_download_url: `https://github.com/Polaris-bit189/Arbiter/releases/download/v0.3.5/${SETUP}.blockmap`
  },
  {
    name: 'SHA256SUMS.txt',
    size: 91,
    digest: 'sha256:9aafa51e52e2eb888abbf2bce8569138f08fbc0a2fbee29fb19734307aabecf5',
    browser_download_url:
      'https://github.com/Polaris-bit189/Arbiter/releases/download/v0.3.5/SHA256SUMS.txt'
  }
]

/** `SHA256SUMS.txt` 的真实内容（91 字节，两空格分隔）。 */
const REAL_SUMS = `${SETUP_SHA}  ${SETUP}\n`

const RELEASE_LATEST = {
  tag_name: 'v0.3.5',
  html_url: 'https://x',
  published_at: '2026-09-26T01:42:03Z',
  assets: REAL_ASSETS
}

// —— 假的 fetch ——

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body)
  }
}

function textResponse(text, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
    json: async () => JSON.parse(text)
  }
}

/** 字节响应，**走 `arrayBuffer()` 那条回退路**（不是流）。 */
function byteResponse(buf, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    arrayBuffer: async () => buf,
    body: null
  }
}

/** 字节响应，走**流**那条路（模拟真 fetch）。每次给 1024 字节。 */
function streamResponse(buf, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    arrayBuffer: async () => buf,
    body: (async function* chunks() {
      for (let i = 0; i < buf.length; i += 1024) yield buf.subarray(i, i + 1024)
    })()
  }
}

function makeFetch(routes) {
  return async (url) => {
    const key = Object.keys(routes).find((k) => String(url).startsWith(k))
    if (key === undefined) {
      throw Object.assign(new TypeError('fetch failed'), {
        cause: new Error(`no route for ${url}`)
      })
    }
    const r = routes[key]
    return typeof r === 'function' ? r(url) : r
  }
}

/** 一个「打包形态」的假 target：`resources` 指向临时目录，asar 由注入的 readAsar 顶替。 */
function fakeTarget(resources) {
  return { kind: 'packaged', root: resources, resources, usable: true, appPath: null }
}

/** 通用注入：不读真文件系统、不跑 reg.exe。 */
function baseDeps(dir, extra = {}) {
  return {
    target: fakeTarget(dir),
    readAsar: () => Buffer.from(JSON.stringify({ name: 'arbiter', version: '0.3.3' })),
    home: dir,
    env: { ARBITER_DOWNLOADS: dir },
    ...extra
  }
}

const scratch = mkdtempSync(join(tmpdir(), 'arbiter-test-update-'))

// ============================================================================
console.log('\n[1] 版本号的解析与比较')
// ============================================================================
{
  check('0.3.5 → [0,3,5]', JSON.stringify(parseVersion('0.3.5')?.nums) === '[0,3,5]')
  check(
    '前导 v 也认（GitHub 的 tag 是 v0.3.5，package.json 里没有 v）',
    JSON.stringify(parseVersion('v0.3.5')?.nums) === '[0,3,5]'
  )
  check('预发布段解析出来', parseVersion('1.0.0-rc.1')?.pre === 'rc.1')
  check(
    '读不懂的返回 null 而不是抛',
    parseVersion('latest') === null && parseVersion(null) === null
  )

  check('新 > 旧', compareSemver('0.3.5', '0.3.3') === 1)
  check('旧 < 新', compareSemver('0.3.3', '0.3.5') === -1)
  check('v 前缀不影响相等', compareSemver('0.3.5', 'v0.3.5') === 0)
  check('位数不同按 0 补（1.2 == 1.2.0）', compareSemver('1.2', '1.2.0') === 0)
  check('数字按数值比，不是字典序（0.9 < 0.10）', compareSemver('0.9', '0.10') === -1)
  check('预发布比正式版旧（1.0.0-rc.1 < 1.0.0）', compareSemver('1.0.0-rc.1', '1.0.0') === -1)
  check('★ 比不出来返回 null，不是 0', compareSemver('nope', '1.0.0') === null)
}

// ============================================================================
console.log('\n[2] 从 assets 里挑安装包')
// ============================================================================
{
  const picked = pickSetupAsset(REAL_ASSETS)
  check('真实资产里挑中安装包', picked?.name === SETUP, `挑到 ${picked?.name}`)

  // ⚠️ 这一条**不能**靠真数据的顺序（真数据里安装包恰好排在前）。
  // 它测的是判据本身：把 `.blockmap` 排到前面，仍然不能选中它。
  const flipped = [REAL_ASSETS[1], REAL_ASSETS[0], REAL_ASSETS[2]]
  check(
    '★ blockmap 排到前面时仍然不选它',
    pickSetupAsset(flipped)?.name === SETUP,
    `挑到 ${pickSetupAsset(flipped)?.name}`
  )

  check('没有安装包的 release → null', pickSetupAsset([REAL_ASSETS[2]]) === null)
  check('不是数组 → null', pickSetupAsset(undefined) === null && pickSetupAsset('x') === null)
}

// ============================================================================
console.log('\n[3] sha256：两个来源')
// ============================================================================
{
  check('digest 直接取（零额外请求）', sha256OfAsset(REAL_ASSETS[0]) === SETUP_SHA)
  check('没有 digest → null', sha256OfAsset({ name: 'x' }) === null)
  check('digest 形状不对 → null', sha256OfAsset({ digest: 'sha256:abc' }) === null)
  check('不是 sha256 的算法 → null', sha256OfAsset({ digest: `sha512:${SETUP_SHA}` }) === null)

  const table = parseSha256Sums(REAL_SUMS)
  check('SHA256SUMS.txt 解析出文件名 → 哈希', table.get(SETUP) === SETUP_SHA)
  check(
    '两个来源逐字相同（这是能用 digest 顶替下载的理由）',
    table.get(SETUP) === sha256OfAsset(REAL_ASSETS[0])
  )
  check('空行与乱码行被跳过，不抛', parseSha256Sums('\n\n乱七八糟\n').size === 0)
  check(
    '大小写归一',
    parseSha256Sums(`${SETUP_SHA.toUpperCase()}  ${SETUP}`).get(SETUP) === SETUP_SHA
  )
  check('sameSha256 忽略大小写', sameSha256(SETUP_SHA.toUpperCase(), SETUP_SHA))
  check('一边不是字符串就是「不同」', !sameSha256(SETUP_SHA, null))
}

// ============================================================================
console.log('\n[4] 三个取值，尤其是 unknown')
// ============================================================================
{
  check(
    '落后 → update-available',
    decideUpdate({ installed: '0.3.3', latest: '0.3.5' }) === 'update-available'
  )
  check('持平 → up-to-date', decideUpdate({ installed: '0.3.5', latest: '0.3.5' }) === 'up-to-date')
  check(
    '本机更新 → up-to-date',
    decideUpdate({ installed: '0.4.0', latest: '0.3.5' }) === 'up-to-date'
  )

  check(
    '★ 拿不到最新版 → unknown（**不是** up-to-date）',
    decideUpdate({ installed: '0.3.3', latest: null }) === 'unknown'
  )
  check(
    '★ 拿不到本机版本 → unknown',
    decideUpdate({ installed: null, latest: '0.3.5' }) === 'unknown'
  )
  check(
    '★ 版本读不懂 → unknown',
    decideUpdate({ installed: '0.3.3', latest: 'latest' }) === 'unknown'
  )
  check(
    '★ unknown 与 up-to-date 是两个不同的值',
    decideUpdate({ installed: '0.3.3', latest: null }) !==
      decideUpdate({ installed: '0.3.5', latest: '0.3.5' })
  )
}

// ============================================================================
console.log('\n[5] 应用版本的三级回退')
// ============================================================================
{
  const t = fakeTarget(join(scratch, 'app1'))
  check(
    '打包形态：走 asar 读取器',
    readAppVersion(t, { readAsar: () => Buffer.from('{"version":"1.2.3"}') }) === '1.2.3'
  )

  check(
    'asar 读不出来 → 松散目录的 package.json',
    readAppVersion(
      { kind: 'packaged', resources: join(scratch, 'app2') },
      {
        readAsar: () => null,
        readFile: (p) =>
          p.includes('app') && p.endsWith('package.json') ? '{"version":"9.9.9"}' : ''
      }
    ) === '9.9.9'
  )

  check(
    '仓库形态：读仓库根的 package.json',
    readAppVersion(
      { kind: 'repo', appPath: scratch },
      { readFile: () => '{"version":"7.7.7"}' }
    ) === '7.7.7'
  )

  check('全读不到 → null（不猜）', readAppVersion(null) === null)
  check(
    'asar 里不是 JSON 也不抛',
    readAppVersion(t, { readAsar: () => Buffer.from('not json'), readFile: () => '' }) === null
  )
}

// ============================================================================
console.log('\n[6] 插件版本：从 Claude Code 的记账文件读')
// ============================================================================
{
  const home = join(scratch, 'home')
  const plugins = join(home, '.claude', 'plugins')
  const market = join(scratch, 'market')
  mkdirSync(plugins, { recursive: true })
  mkdirSync(join(market, 'plugins', 'arbiter', '.claude-plugin'), { recursive: true })

  writeFileSync(
    join(plugins, 'installed_plugins.json'),
    JSON.stringify({
      version: 2,
      plugins: { 'arbiter@arbiter': [{ scope: 'user', version: '0.3.2' }] }
    })
  )
  writeFileSync(
    join(plugins, 'known_marketplaces.json'),
    JSON.stringify({
      arbiter: { source: { source: 'directory', path: market }, installLocation: market }
    })
  )
  writeFileSync(
    join(market, 'plugins', 'arbiter', '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: 'arbiter', version: '0.3.5' })
  )

  const v = readPluginVersions({ home })
  check('读出本机装的版本', v.current === '0.3.2')
  check('读出 marketplace 源里的版本', v.source === '0.3.5')
  check(
    '两者不同 → 这就是「插件该更新了」的判据',
    decideUpdate({ installed: v.current, latest: v.source }) === 'update-available'
  )

  check(
    '记账文件不在 → 两个都是 null（不猜）',
    JSON.stringify(readPluginVersions({ home: join(scratch, 'nope') })) ===
      '{"current":null,"source":null}'
  )
}

// ============================================================================
console.log('\n[7] checkUpdate：查到新版本')
// ============================================================================
{
  const fetchImpl = makeFetch({ 'https://api.github.com': jsonResponse(RELEASE_LATEST) })
  const r = await checkUpdate(baseDeps(scratch, { fetchImpl, download: false }))
  check('ok', r.ok === true)
  check('最新版本 = 0.3.5', r.latest?.version === '0.3.5')
  check('本机版本 = 0.3.3（来自注入的 asar）', r.app.installed === '0.3.3')
  check('判定为有新版本', r.app.status === 'update-available')
  check(
    '资产名与体积来自 API',
    r.app.asset?.name === SETUP && r.app.asset?.size_bytes === 147372016
  )
  check('sha256 取自 digest', r.app.asset?.sha256 === SETUP_SHA)
  check('没要下载就不下', r.download === null && r.download_error === null)
  check('latest_error 为 null', r.latest_error === null)
}

// ============================================================================
console.log('\n[8] checkUpdate：查不到时**绝不能**说成「已是最新」')
// ============================================================================
{
  const certErr = Object.assign(new TypeError('fetch failed'), {
    cause: new Error('unable to verify the first certificate')
  })
  const fetchImpl = async () => {
    throw certErr
  }
  const r = await checkUpdate(baseDeps(scratch, { fetchImpl, download: false }))

  check('ok = false', r.ok === false)
  check('★ 状态是 unknown，不是 up-to-date', r.app.status === 'unknown', `实际 ${r.app.status}`)
  check('错误码 = tls_certificate（本机实测的那一类）', r.latest_error?.code === 'tls_certificate')
  check(
    '★ 有一条明说「没查成 ≠ 已是最新」的提示',
    r.notes.some((n) => n.includes('没查成') || n.includes('could not check'))
  )
  check(
    '给出了下一步',
    Array.isArray(r.latest_error?.next_steps) && r.latest_error.next_steps.length > 0
  )

  // 版本号读不出来时同理
  const r2 = await checkUpdate(
    baseDeps(scratch, {
      fetchImpl: makeFetch({ 'https://api.github.com': jsonResponse(RELEASE_LATEST) }),
      readAsar: () => null,
      readFile: () => '',
      download: false
    })
  )
  check('★ 本机版本读不出来时也是 unknown（不是 up-to-date）', r2.app.status === 'unknown')
  check('并且会说一句「没找到已安装的 Arbiter」', r2.notes.length > 0)
}

// ============================================================================
console.log('\n[9] 下载：校验通过才落盘')
// ============================================================================
{
  const dir = mkdtempSync(join(scratch, 'dl1-'))
  const body = Buffer.from('arbiter installer bytes '.repeat(500))
  const realSha = createHash('sha256').update(body).digest('hex')

  const fetchImpl = makeFetch({
    'https://api.github.com': jsonResponse(RELEASE_LATEST),
    'https://github.com': streamResponse(body)
  })
  const r = await checkUpdate(
    baseDeps(dir, {
      fetchImpl,
      download: true,
      // 把 sha256 换成「这段字节真正的哈希」，这样校验才会通过
      target: fakeTarget(dir)
    })
  )
  // 上面那次用的 digest 是真安装包的，必然对不上 —— 正好验证「不匹配就拒绝」
  check(
    '★ sha256 对不上 → 拒绝落盘',
    r.download === null && r.download_error !== null,
    JSON.stringify(r.download_error)
  )
  check('★ 错误码是 sha256_mismatch', r.download_error?.code === 'sha256_mismatch')
  check('★ 目标文件没有被留下', !existsSync(join(dir, SETUP)))
  check(
    '★ .part 也没有被留下（留下会被下次当成续传起点）',
    !existsSync(join(dir, 'Arbiter-0.3.5-setup.part.exe'))
  )

  // 现在给一个**对得上**的哈希，应该成功落盘
  const dir2 = mkdtempSync(join(scratch, 'dl2-'))
  const assets = [
    { ...REAL_ASSETS[0], digest: `sha256:${realSha}`, size: body.length },
    REAL_ASSETS[1],
    REAL_ASSETS[2]
  ]
  const fetchImpl2 = makeFetch({
    'https://api.github.com': jsonResponse({ ...RELEASE_LATEST, assets }),
    'https://github.com': streamResponse(body)
  })
  const r2 = await checkUpdate(baseDeps(dir2, { fetchImpl: fetchImpl2, download: true }))
  check(
    '哈希对得上 → 落盘成功',
    r2.download !== null && r2.download_error === null,
    JSON.stringify(r2.download_error)
  )
  check('落点就是下载目录下的资产名', r2.download?.path === join(dir2, SETUP))
  check('字节数正确', r2.download?.bytes === body.length)
  check('★ 落盘后 .part 不在了', !existsSync(join(dir2, 'Arbiter-0.3.5-setup.part.exe')))
  check(
    '文件真的在那儿且内容一致',
    existsSync(join(dir2, SETUP)) && readFileSync(join(dir2, SETUP)).equals(body)
  )
  // ⚠️ 先判存在再算哈希：文件不在时 `sha256OfFile` 会**抛**，而未捕获的异常会把整个套件
  // 崩在半路——后面几节一条都不跑。反证那边会把它读成「有断言没红」，方向正好指反。
  check(
    '★ 落盘文件重算的 sha256 与报告逐字相同',
    existsSync(join(dir2, SETUP)) && sha256OfFile(join(dir2, SETUP)) === r2.download?.sha256
  )

  // 幂等：同一个文件再下一次，**不该再发一次下载请求**。
  // 断「请求次数」比断 `reused === true` 硬——后者只说明它记了个标记，
  // 前者才说明那 140 MB 真的没有被重新搬一遍。
  let downloadCalls = 0
  const countingFetch = makeFetch({
    'https://api.github.com': jsonResponse({ ...RELEASE_LATEST, assets }),
    'https://github.com': () => {
      downloadCalls += 1
      return streamResponse(body)
    }
  })
  const r3 = await checkUpdate(baseDeps(dir2, { fetchImpl: countingFetch, download: true }))
  check('★ 复用时标记为 reused', r3.download?.reused === true)
  check('★ 复用时不发下载请求（0 次）', downloadCalls === 0, `实际 ${downloadCalls} 次`)

  // ⚠️ 上面几条走的都是**流**那条路（`streamResponse`）。而 `plugins/arbiter/mcp/update.mjs`
  // 里还有一条**显式的回退**，那里的注释写着「注入的假 fetch 可能只有 `arrayBuffer()`、
  // 没有流。照收。」——**这条回退一直没被覆盖**：`byteResponse` 这个替身写好了、
  // 却一次都没被调用过。
  //
  // 它是被 lint 的 `no-unused-vars` 捅出来的，而那条 error 正好挡住了 0.3.6 的发布
  // （Release 工作流的第 6 步 `npm run lint`）。**修法不是删掉那个替身**——作者写了
  // 它、还给了一句点明路径的注释，说明他本来就想覆盖这里。所以下面这条把它接上。
  const dir4 = mkdtempSync(join(scratch, 'dl4-'))
  const r4 = await checkUpdate(
    baseDeps(dir4, {
      fetchImpl: makeFetch({
        'https://api.github.com': jsonResponse({ ...RELEASE_LATEST, assets }),
        'https://github.com': byteResponse(body)
      }),
      download: true
    })
  )
  check(
    '★ 响应只有 arrayBuffer()、没有流，也照收（回退路径）',
    r4.download !== null && r4.download_error === null,
    JSON.stringify(r4.download_error)
  )
  check(
    '回退路径落盘的字节与流那条路完全一致',
    existsSync(join(dir4, SETUP)) && readFileSync(join(dir4, SETUP)).equals(body)
  )
}

// ============================================================================
console.log('\n[10] 下载：几个「拒绝」的分支')
// ============================================================================
{
  const dir = mkdtempSync(join(scratch, 'dl3-'))

  // 已经是最新 → 不下
  const r = await checkUpdate(
    baseDeps(dir, {
      fetchImpl: makeFetch({
        'https://api.github.com': jsonResponse({ ...RELEASE_LATEST, tag_name: 'v0.3.3' })
      }),
      download: true
    })
  )
  check(
    '已是最新时 --download 不下东西',
    r.download === null && r.download_error?.code === 'not_needed'
  )

  // 没有校验和 → 拒绝（宁可不下，也不下一个验证不了的东西）
  const noDigest = [{ ...REAL_ASSETS[0], digest: null }, REAL_ASSETS[1], REAL_ASSETS[2]]
  const r2 = await checkUpdate(
    baseDeps(dir, {
      fetchImpl: makeFetch({
        'https://api.github.com': jsonResponse({ ...RELEASE_LATEST, assets: noDigest }),
        // SHA256SUMS.txt 也拿不到 → sha256 就是 null
        'https://github.com': textResponse('garbage')
      }),
      download: true
    })
  )
  check(
    '★ 拿不到校验和 → 拒绝下载',
    r2.download === null && r2.download_error?.code === 'no_checksum'
  )
  check(
    '拒绝的原因写清楚了',
    typeof r2.download_error?.message === 'string' && r2.download_error.message.length > 0
  )

  // 没有安装包资产
  const r3 = await checkUpdate(
    baseDeps(dir, {
      fetchImpl: makeFetch({
        'https://api.github.com': jsonResponse({ ...RELEASE_LATEST, assets: [REAL_ASSETS[2]] })
      }),
      download: true
    })
  )
  check('没找到安装包 → no_asset', r3.download_error?.code === 'no_asset')

  // 下载**阶段**网络失败：文案必须是「下载」，不能是查询那套。
  // 实测踩到过——一次下载超时，报告里写着「这次没能查到最新版本」，
  // 而 `latest.version` 就在同一个报告里，读起来自相矛盾。
  const r4 = await checkUpdate(
    baseDeps(dir, {
      fetchImpl: makeFetch({
        'https://api.github.com': jsonResponse(RELEASE_LATEST),
        'https://github.com': () => {
          throw Object.assign(new TypeError('fetch failed'), { cause: new Error('socket hang up') })
        }
      }),
      download: true
    })
  )
  check('★ 下载阶段失败 → 有 download_error', r4.download_error !== null)
  check(
    '★ 而且文案讲的是下载，不是「没能查到最新版本」（同报告里明明有 latest）',
    !(r4.download_error?.message ?? '').includes('查到最新版本'),
    r4.download_error?.message
  )
}

// ============================================================================
console.log('\n[11] 零碎但承重的两个')
// ============================================================================
{
  check(
    '★ .part 插在扩展名之前（约束 8）',
    partPathOf('C:\\x\\Arbiter-0.3.5-setup.exe') === 'C:\\x\\Arbiter-0.3.5-setup.part.exe',
    partPathOf('C:\\x\\Arbiter-0.3.5-setup.exe')
  )
  check('没有扩展名时直接加后缀', partPathOf('C:\\x\\file').endsWith('file.part'))

  check(
    '证书错 → tls_certificate',
    classifyFetchError(
      Object.assign(new TypeError('fetch failed'), {
        cause: new Error('unable to verify the first certificate')
      })
    ) === 'tls_certificate'
  )
  check(
    'ENOTFOUND → network_dns',
    classifyFetchError(
      Object.assign(new TypeError('fetch failed'), {
        cause: Object.assign(new Error('x'), { code: 'ENOTFOUND' })
      })
    ) === 'network_dns'
  )
  check(
    '超时 → network_timeout',
    classifyFetchError(Object.assign(new Error('x'), { name: 'TimeoutError' })) ===
      'network_timeout'
  )
  check(
    '认不出的 → network_failed（有个闭集兜底）',
    classifyFetchError(new Error('???')) === 'network_failed'
  )
}

// —— 收尾 ——
try {
  rmSync(scratch, { recursive: true, force: true })
} catch {
  // 临时目录删不掉不该让套件失败
}

console.log(`\n通过 ${passed}，失败 ${failed}`)
if (failed > 0) process.exit(1)
