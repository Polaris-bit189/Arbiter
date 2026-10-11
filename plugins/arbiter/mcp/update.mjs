/**
 * 「有没有新版本」——查、比对，按需把安装包下下来。
 *
 * ## 这条链路为什么在插件侧
 *
 * 它本可以做成一个 MCP 工具（那样 `/arbiter:update` 就能直接调），但没有：
 * 应用侧那条 `src/main/core/downlink.ts` 是**静态** `import { net } from 'electron'`，
 * 而 `src/mcp/` 有依赖图闸门不许碰 electron；`setInstallTransport` 全仓又只在
 * `src/main/index.ts` 调过一次，MCP/CLI 进程里根本没有传输层。为了复用那套下载，
 * 得先补一个 `node:https` 版 transport —— 那是另一件事。
 *
 * 而且语义上它就不该只在应用里：**这个功能的典型场景恰恰是「应用也落后了」**，
 * 一个只在应用已经连上时才能用的检查更新，帮不上那个场景。
 *
 * ## 契约
 *
 * **stdout 恰好一个 JSON 对象，诊断一律走 stderr。** 这与 CLI 的 `--json` 是同一条约定
 * ——调用方是 skill 里的模型，它要解析这段输出。
 *
 * ## 两条必须分开的结论
 *
 * 「查不到最新版本」与「已经是最新版本」**是两件事**。合并成一句「已是最新」是在替用户
 * 下一个我们并不知道的结论，而这个错误的方向恰好是「让他以为自己不用更新」。
 * 所以 `latest_error` 与 `app.status === 'unknown'` 各占一个字段，`notes` 里还会明说一次。
 * 判据在 `updatePlan.mjs` 的 `decideUpdate`。
 *
 * ## 它**不**做什么
 *
 * 不安装、不运行安装包、不改任何现有文件。`--download` 只多下一份安装包到下载目录，
 * 装不装由人决定。
 */

import { createHash } from 'crypto'
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeSync
} from 'fs'
import { homedir } from 'os'
import { basename, dirname, join } from 'path'
import { pathToFileURL } from 'url'

import { asarReadEntry } from './asar.mjs'
import { t } from './i18n.mjs'
import { MCP_ENTRY, resolveTarget } from './target.mjs'
import {
  decideUpdate,
  parseSha256Sums,
  pickSetupAsset,
  sameSha256,
  sha256OfAsset
} from './updatePlan.mjs'

/** 分发仓。写死是刻意的：这不是一个可以被重定向到别处的检查器。 */
const REPO = 'Polaris-bit189/Arbiter'
const LATEST_API = `https://api.github.com/repos/${REPO}/releases/latest`
const SUMS_NAME = 'SHA256SUMS.txt'

/**
 * GitHub 的 API **要求**有 User-Agent（没有会直接 403）；release 资产的下载则无所谓。
 * 带上真名与仓库地址，这是 GitHub 对自动化的建议写法。
 */
const USER_AGENT = `arbiter-plugin-update (+https://github.com/${REPO})`

/** 查版本这一步的短超时：它只是两个 GET，卡住就没意义。 */
const API_TIMEOUT_MS = 20_000

/**
 * 下载这一步的上限：**半小时**。
 *
 * ⚠️ 原先写的是 10 分钟，**实测不够**（2026-09-26 本机下 140.5 MB 跑到刚好十分钟被掐掉）。
 * 140 MB 在正常宽带上是一两分钟的事，但慢网络、被转发、或者只是赶上 GitHub 抽风，
 * 十分钟都可能不够。这个值只是「别无限挂着」的兜底，不是性能预期。
 */
const DOWNLOAD_TIMEOUT_MS = 30 * 60_000

/** 下载目录。`ARBITER_DOWNLOADS` 与 `target.mjs` 的 `entryEnv` 用的是同一个名字。 */
function downloadsDir(env, home) {
  const fromEnv = (env.ARBITER_DOWNLOADS ?? '').trim()
  return fromEnv !== '' ? fromEnv : join(home, 'Downloads')
}

/** 读一个 JSON 文件，读不动一律 `null`（缺文件、坏 JSON、权限——都只是「读不到」）。 */
function readJson(path, readFile) {
  try {
    return JSON.parse(readFile(path, 'utf8'))
  } catch {
    return null
  }
}

function versionOf(json) {
  const v = json?.version
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null
}

/**
 * 本机那份**应用**是什么版本。读不到返回 `null`。
 *
 * 走的是 `resolveTarget()` 已经挑中的那一份，所以和「插件平时借用哪一份应用」是同一个
 * 答案——这一点是承重的：本机实测有**两份** `DisplayName=Arbiter` 的注册表条目，一份指向
 * 真正装着的 `D:\tools\Arbiter`（0.3.3），另一份指向一个早就删掉的临时目录（0.1.0）。
 * 不配合目录存在性过滤就去读注册表，会读到残留项。所以这里**根本不读注册表**。
 *
 * 三级回退，从不抛：
 *   1. 打包形态 → 直读 `resources/app.asar` 里的 `package.json`（毫秒级，不起进程）
 *   2. 松散目录形态 → `resources/app/package.json`
 *   3. 仓库形态 → 仓库根的 `package.json`
 *
 * ⚠️ **刻意没有「起 `arbiter.cmd --version` 兜底」这一步**（设计时本来是有的）。
 * 理由：`src/cli/main.ts` 的 `resolveVersion()` 读的是**同一个** `package.json`，
 * 只是它借 Electron 的 asar 补丁、这里用自己的解析器。所以直读读不到时，起一次
 * Electron（几百毫秒、还可能起不来）拿到的答案**不会更准**，只是换个读取器。
 * 没有信息增益的兜底会让人误以为覆盖更全，那比没有更糟。
 */
export function readAppVersion(target, deps = {}) {
  const readAsar = deps.readAsar ?? asarReadEntry
  const readFile = deps.readFile ?? ((p) => readFileSync(p, 'utf8'))
  if (!target) return null

  if (target.resources) {
    const asar = join(target.resources, 'app.asar')
    try {
      const buf = readAsar(asar, 'package.json')
      if (buf) {
        const v = versionOf(JSON.parse(buf.toString('utf8')))
        if (v !== null) return v
      }
    } catch {
      // asar 不在 / 头是坏的 / 里面不是 JSON —— 落到下一条路
    }
    const loose = versionOf(readJson(join(target.resources, 'app', 'package.json'), readFile))
    if (loose !== null) return loose
  }

  if (target.appPath) {
    const repo = versionOf(readJson(join(target.appPath, 'package.json'), readFile))
    if (repo !== null) return repo
  }
  return null
}

/**
 * 本机装的**插件**版本，以及 marketplace 源里的那一份。
 *
 * 两者都从 Claude Code 自己的记账文件里读（`~/.claude/plugins/` 下），不调
 * `claude plugin list` —— 那要起一个进程，而且它的输出是给人看的、没有稳定性承诺。
 * 读不到就是 `null`，不猜。
 */
export function readPluginVersions(deps = {}) {
  const home = deps.home ?? homedir()
  const readFile = deps.readFile ?? ((p) => readFileSync(p, 'utf8'))
  const claudePlugins = join(home, '.claude', 'plugins')

  const installed = readJson(join(claudePlugins, 'installed_plugins.json'), readFile)
  const row = installed?.plugins?.['arbiter@arbiter']
  const current = versionOf(Array.isArray(row) ? row[0] : row)

  const markets = readJson(join(claudePlugins, 'known_marketplaces.json'), readFile)
  const location = markets?.arbiter?.installLocation
  const source =
    typeof location === 'string'
      ? versionOf(
          readJson(join(location, 'plugins', 'arbiter', '.claude-plugin', 'plugin.json'), readFile)
        )
      : null

  return { current, source }
}

/**
 * 把 fetch 的异常翻译成一个闭集里的 `code`。
 *
 * ⚠️ **不能按文案分类**（`docs/NOTES.md` 约束 23 第 3 条），所以判据尽量落在 `err.cause.code`
 * 这类结构化字段上。只有最后那条兜底才退回 message 匹配，而且只用来区分「证书」这一种
 * ——它是本机实测**唯一真的会撞上**的那一类（`unable to verify the first certificate`，
 * 因为 hosts 把 GitHub 指到了本机的转发服务），而且它给出的下一步与别的都不同。
 */
export function classifyFetchError(err) {
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') return 'network_timeout'
  const cause = err?.cause ?? err
  const code = typeof cause?.code === 'string' ? cause.code : ''
  const message = typeof cause?.message === 'string' ? cause.message : ''

  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'network_dns'
  if (code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'EHOSTUNREACH') {
    return 'network_unreachable'
  }
  if (/certificate|CERT_|SELF_SIGNED|UNABLE_TO_VERIFY/i.test(`${code} ${message}`)) {
    return 'tls_certificate'
  }
  return 'network_failed'
}

/** 查不到最新版本时，每个 `code` 对应的下一步。空数组表示「没什么可建议的」。 */
function nextStepsFor(code) {
  if (code === 'tls_certificate') return [t('updateCertHint')]
  if (code === 'rate_limited') return [t('updateRateLimitHint')]
  if (
    code === 'network_failed' ||
    code === 'network_dns' ||
    code === 'network_unreachable' ||
    code === 'network_timeout'
  ) {
    return [t('updateNetworkHint')]
  }
  return []
}

function messageFor(code, detail) {
  if (code === 'http_status' || code === 'rate_limited') {
    return t('updateHttpError', { status: detail })
  }
  return t('updateUnreachable', { reason: detail })
}

/**
 * 把 fetch 的异常包成一个带 `reportCode` 的 Error。
 *
 * ⚠️ `kind` 不是装饰：**下载失败时套查询的文案，方向就反了**。实测踩到过——
 * 一次下载超时，报告里写着「连不上 GitHub——这次没能查到最新版本」，而其实最新版本
 * 早就查到了（`latest.version` 就在同一个报告里）。用户读到的是一句**自相矛盾**的话，
 * 而它底下藏着的其实是下载失败。（第一次修只换了外层文案，`{reason}` 里套的还是
 * 内层那句，所以没修好——测试量的是最终那一整句，所以下面几处要一起改。）
 */
function wrapFetchError(err, kind = 'query') {
  const code = classifyFetchError(err)
  const detail = err?.cause?.message ?? err?.message ?? code
  const e = new Error(
    kind === 'download' ? t('updateDownloadFailed', { reason: detail }) : messageFor(code, detail)
  )
  e.reportCode = code
  return e
}

/** 一次 GET，返回解析好的 JSON。失败抛一个带 `reportCode` 的 Error。 */
async function getJson(fetchImpl, url, timeoutMs) {
  let res
  try {
    res = await fetchImpl(url, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': USER_AGENT },
      signal: AbortSignal.timeout(timeoutMs)
    })
  } catch (err) {
    throw wrapFetchError(err)
  }
  if (!res.ok) {
    const code = res.status === 403 || res.status === 429 ? 'rate_limited' : 'http_status'
    const e = new Error(messageFor(code, String(res.status)))
    e.reportCode = code
    throw e
  }
  return await res.json()
}

/** 一次 GET，返回文本（用来取 `SHA256SUMS.txt`，91 字节）。 */
async function getText(fetchImpl, url, timeoutMs) {
  let res
  try {
    res = await fetchImpl(url, {
      headers: { 'user-agent': USER_AGENT },
      signal: AbortSignal.timeout(timeoutMs)
    })
  } catch (err) {
    throw wrapFetchError(err)
  }
  if (!res.ok) {
    const e = new Error(messageFor('http_status', String(res.status)))
    e.reportCode = 'http_status'
    throw e
  }
  return await res.text()
}

/**
 * `.part` 的落点：**标记插在扩展名之前**（`Arbiter-0.3.5-setup.part.exe`）。
 *
 * 与 `src/main/core/outputName.ts` 的 `partPathOf` 同一条规矩（`docs/NOTES.md` 约束 8）：
 * 保留扩展名，别让任何按扩展名推断格式的东西把它当成另一种文件。
 */
export function partPathOf(dest) {
  const dir = dirname(dest)
  const base = basename(dest)
  const dot = base.lastIndexOf('.')
  if (dot <= 0) return join(dir, `${base}.part`)
  return join(dir, `${base.slice(0, dot)}.part${base.slice(dot)}`)
}

/** 流式算一个文件的 sha256。 */
export function sha256OfFile(path) {
  const hash = createHash('sha256')
  const fd = openSync(path, 'r')
  try {
    const chunk = Buffer.alloc(1024 * 1024)
    for (;;) {
      const n = readSync(fd, chunk, 0, chunk.length, null)
      if (n <= 0) break
      hash.update(chunk.subarray(0, n))
    }
  } finally {
    closeSync(fd)
  }
  return hash.digest('hex')
}

/** 磁盘上那份是不是正好就是我们要的那份（大小 + sha256）。 */
function alreadyGood(path, sha256, expectedSize) {
  try {
    if (typeof sha256 !== 'string' || !existsSync(path)) return false
    if (Number.isSafeInteger(expectedSize) && expectedSize >= 0) {
      if (statSync(path).size !== expectedSize) return false
    }
    return sameSha256(sha256OfFile(path), sha256)
  } catch {
    return false
  }
}

/**
 * 下载并校验。**校验不过就删掉 `.part` 并抛**——绝不留下半个文件。
 *
 * 不留残骸这一点是承重的：应用侧那次下载会把已存在的 `.part` 当成断点续传的起点
 * （`src/main/core/downlink.ts`），于是一个坏文件会一直坏下去。这里没有续传，
 * 所以更简单：**失败就整个删掉**。
 */
async function download(fetchImpl, { url, dest, sha256, timeoutMs }) {
  const part = partPathOf(dest)
  try {
    rmSync(part, { force: true })
  } catch {
    // 删不掉就让它被下面的 'w' 覆盖；真写不了会在写入时报错
  }

  let res
  try {
    res = await fetchImpl(url, {
      headers: { 'user-agent': USER_AGENT },
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs)
    })
  } catch (err) {
    throw wrapFetchError(err, 'download')
  }
  if (!res.ok) {
    const e = new Error(t('updateDownloadFailed', { reason: `HTTP ${res.status}` }))
    e.reportCode = 'http_status'
    throw e
  }

  const hash = createHash('sha256')
  let bytes = 0
  const fd = openSync(part, 'w')
  try {
    if (res.body) {
      for await (const chunk of res.body) {
        const buf = Buffer.from(chunk)
        hash.update(buf)
        writeSync(fd, buf)
        bytes += buf.length
      }
    } else {
      // 注入的假 fetch 可能只有 `arrayBuffer()`、没有流。照收。
      const buf = Buffer.from(await res.arrayBuffer())
      hash.update(buf)
      writeSync(fd, buf)
      bytes = buf.length
    }
  } catch (err) {
    closeSync(fd)
    rmSync(part, { force: true })
    throw wrapFetchError(err, 'download')
  }
  closeSync(fd)

  const actual = hash.digest('hex')
  if (!sameSha256(actual, sha256)) {
    // ⚠️ 删掉它。留着的话下一次运行会把坏的 `.part` 当成续传起点。
    rmSync(part, { force: true })
    const e = new Error(t('updateHashMismatch', { expected: sha256, actual }))
    e.reportCode = 'sha256_mismatch'
    throw e
  }

  renameSync(part, dest)
  return { path: dest, sha256: actual, bytes }
}

/** 下载失败时的下一步。超时单独说，因为它的建议与别的不一样。 */
function downloadNextSteps(code) {
  if (code === 'network_timeout') return [t('updateDownloadTimeoutHint')]
  return nextStepsFor(code)
}

/**
 * 主流程。永远返回一个可序列化的报告，**不抛**。
 *
 * `deps` 全部可注入，测试因此不碰真网络、不碰真磁盘布局：
 *   `fetchImpl` / `readFile` / `readAsar` / `home` / `env` / `target` / `timeoutMs`
 */
export async function checkUpdate(deps = {}) {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch
  const env = deps.env ?? process.env
  const home = deps.home ?? homedir()
  const readFile = deps.readFile ?? ((p) => readFileSync(p, 'utf8'))
  const target = deps.target !== undefined ? deps.target : resolveTarget(MCP_ENTRY)
  const wantDownload = deps.download === true
  const timeoutMs = deps.timeoutMs ?? API_TIMEOUT_MS

  const notes = []
  const report = {
    ok: true,
    latest: null,
    latest_error: null,
    app: { installed: null, status: 'unknown', asset: null },
    plugin: { installed: null, source: null, status: 'unknown', commands: [] },
    download: null,
    download_error: null,
    notes
  }

  // —— 本机应用 ——
  report.app.installed = readAppVersion(target, { readAsar: deps.readAsar, readFile })
  if (report.app.installed === null) notes.push(t('updateNoApp'))

  // —— 本机插件 ——
  const pluginVersions = readPluginVersions({ home, readFile })
  report.plugin.installed = pluginVersions.current
  report.plugin.source = pluginVersions.source

  // —— 最新版本 ——
  let release = null
  try {
    release = await getJson(fetchImpl, LATEST_API, timeoutMs)
  } catch (err) {
    const code = err.reportCode ?? 'network_failed'
    report.latest_error = { code, message: err.message, next_steps: nextStepsFor(code) }
    // 「没查成」不是「已是最新」——这一句是这条链路上最重要的一句话。
    notes.push(t('updateUnknownWarning'))
    notes.push(...report.latest_error.next_steps)
    report.ok = false
  }

  if (release !== null) {
    const tag = typeof release.tag_name === 'string' ? release.tag_name : null
    report.latest = {
      version: tag === null ? null : tag.replace(/^v/, ''),
      tag,
      url: typeof release.html_url === 'string' ? release.html_url : null,
      published_at: typeof release.published_at === 'string' ? release.published_at : null
    }

    const assets = Array.isArray(release.assets) ? release.assets : []
    const asset = pickSetupAsset(assets)
    let sha256 = sha256OfAsset(asset)
    if (sha256 === null && asset !== null) {
      // `digest` 拿不到（老资产可能是空串）→ 回落去下 `SHA256SUMS.txt`。
      // 91 字节，比重新下一次 140 MB 便宜得多。
      const sumsUrl = assets.find((a) => a?.name === SUMS_NAME)?.browser_download_url
      if (typeof sumsUrl === 'string') {
        try {
          sha256 =
            parseSha256Sums(await getText(fetchImpl, sumsUrl, timeoutMs)).get(asset.name) ?? null
        } catch {
          // 取不到校验和就没法校验 —— 下面按「没有 sha256」处理，而那一档**拒绝下载**。
        }
      }
    }

    report.app.asset =
      asset === null
        ? null
        : {
            name: asset.name,
            size_bytes: typeof asset.size === 'number' ? asset.size : null,
            url: typeof asset.browser_download_url === 'string' ? asset.browser_download_url : null,
            sha256
          }
  }

  // —— 两处比对 ——
  report.app.status = decideUpdate({
    installed: report.app.installed,
    latest: report.latest?.version ?? null
  })
  report.plugin.status = decideUpdate({
    installed: report.plugin.installed,
    latest: report.plugin.source
  })

  if (report.plugin.status === 'update-available') {
    report.plugin.commands = [
      'claude plugin marketplace update arbiter',
      'claude plugin update arbiter@arbiter --yes'
    ]
    notes.push(t('updatePluginHint'))
    notes.push(...report.plugin.commands)
  }

  // —— 下载（只在真要，且真有新版时）——
  if (wantDownload) {
    const asset = report.app.asset
    if (report.app.status !== 'update-available' || asset === null || asset.url === null) {
      report.download_error =
        report.app.status === 'update-available'
          ? { code: 'no_asset', message: t('updateNoAsset'), next_steps: [] }
          : { code: 'not_needed', message: '', next_steps: [] }
    } else if (asset.sha256 === null) {
      // **没有校验和就不下。** 下回来一个没法验证的 140 MB 安装包，不如让用户自己去
      // Releases 页面拿——那里至少有 GitHub 的 TLS。
      report.download_error = {
        code: 'no_checksum',
        message: t('updateNoChecksum'),
        next_steps: []
      }
    } else {
      const dest = join(downloadsDir(env, home), asset.name)
      try {
        if (alreadyGood(dest, asset.sha256, asset.size_bytes)) {
          // 幂等：同一个安装包已经在这儿且哈希对得上，就不重下。
          report.download = {
            path: dest,
            sha256: asset.sha256,
            bytes: asset.size_bytes,
            reused: true
          }
        } else {
          report.download = {
            ...(await download(fetchImpl, {
              url: asset.url,
              dest,
              sha256: asset.sha256,
              timeoutMs: deps.downloadTimeoutMs ?? DOWNLOAD_TIMEOUT_MS
            })),
            reused: false
          }
        }
        notes.push(t('updateDownloaded', { path: report.download.path }))
        notes.push(t('updateDownloadHint'))
      } catch (err) {
        const code = err.reportCode ?? 'download_failed'
        // ⚠️ **不能复用查询那两句文案。** 实测踩到过：一次下载超时，报告里却写着
        // 「这次没能查到最新版本」——方向整个是反的。哈希不符那条自己就是完整句子，
        // 不必再套一层。
        report.download_error = {
          code,
          // `download()` 抛出来的一律**已经是完整句子**（它自己挑下载那套文案）——
          // 这里再套一层就会变成「安装包没能下完：安装包没能下完：…」。
          message: err.message,
          next_steps: downloadNextSteps(code)
        }
      }
    }
  }

  return report
}

/** 命令行入口。stdout 只出那一个 JSON。 */
async function main() {
  const argv = process.argv.slice(2)
  const report = await checkUpdate({ download: argv.includes('--download') })
  // ⚠️ 用 `writeSync` 而不是 `process.stdout.write`：走管道时异步写会**截断 JSON**
  // （`read-convert.mjs` 踩过同一个坑）。这份输出是给模型解析的，截断了就是坏数据。
  writeSync(1, `${JSON.stringify(report, null, 2)}\n`)
  // 退出码：0 = 查询本身跑通了（有没有新版都算），1 = 没查成。只有这两档。
  // ⚠️ 用 `exitCode` 而不是 `process.exit()`：后者在 undici 还留着连接池句柄时会撞
  // libuv 的断言——Windows 实测 `Assertion failed: ... win\async.c, line 94`，退出码成 127。
  process.exitCode = report.ok ? 0 : 1
}

// 只在被当脚本跑时执行；被 import（测试）时不起作用。
// 用 `pathToFileURL` 而不是手拼 `file://`：Windows 的盘符与反斜杠在两种写法下不一致，
// 手拼的那个判据会恒假——表现为「脚本跑起来什么都不做，也没有报错」。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    process.stderr.write(`${err?.stack ?? err}\n`)
    process.exitCode = 1
  })
}
