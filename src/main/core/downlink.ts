/**
 * 重型引擎包（LibreOffice ~340 MB / Calibre ~200 MB）的按需下载器。
 *
 * 四件事必须同时成立，缺一个都会在下到 90% 的时候坑人：
 *
 * 1. **多镜像顺序回退** —— 国内下 GitHub Release 是抽奖，一个镜像失败就换下一个。
 * 2. **Range 续传** —— 340 MB 断一次不能从头再来，`.part` 就是断点。
 * 3. **sha256 校验** —— 哈希硬编码在 `resources/engines.manifest.json` 里，
 *    等价于签名校验：镜像站被投毒或文件被中间设备吃掉了内容，这里一定拦得住。
 * 4. **可取消** —— 用户改主意要能立刻停，而且**保留 `.part`**，下次接着下。
 *
 * 传输层刻意做成可注入的接口（`DownloadTransport`），不是「为了好看」：
 * `net.request` 只在 Electron 运行时里存在，而 `tsconfig.test.json` 会把 `electron`
 * 映射成一个只实现了一小部分 API 的桩（见 `scripts/electron-stub.ts`，里面根本没有
 * `net`）。把传输层挡在接口后面，主逻辑才能在无头环境里用本地 http 服务器测——
 * 见 `scripts/test-downlink.ts`。
 *
 * 生产代码用 `createNetTransport()`（走系统代理，比全局 fetch 可靠）；
 * 测试用指向本地服务器的实现。
 */

import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import type { WriteStream } from 'node:fs'
import { mkdir, readFile, rename, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { net } from 'electron'
import { ConversionCanceled, removeQuietly } from '../converters/common'
import type { CancelToken } from './cancel'

/**
 * 我们自己声明的 User-Agent。**这不是礼节，是承重的。**
 *
 * 实测（2026-09-13，两处镜像同一个判据，`curl -r 0-15` 复现）：
 *
 * | UA                                       | 清华 TUNA |
 * | ---------------------------------------- | --------- |
 * | 真·不带（`-H 'User-Agent:'`）             | **403**   |
 * | 浏览器 UA（= Electron `net.request` 的默认值） | **403**   |
 * | `Arbiter/0.3.1 (+https://…)`              | **206**   |
 *
 * pandoc 的 whl 与 LibreOffice 的 MSI 都测过，两者一致。所以**不显式设这个头，
 * 那两个国内镜像在打包后一个都下不动**，而国际源又慢——表现是「明明配了 cn 镜像
 * 却总是走 intl 甚至失败」的那类静默降级，因为镜像回退会把 403 当成普通失败吞掉。
 *
 * 形状按 RFC 9110 给自动客户端的惯例：`产品/版本 (+说明网址)`。
 * **改这串之前先复测**：别照抄别人的 UA，这个站是按「像不像浏览器」判的，
 * 随手换个串可能又落回 403。（上面表里那条 206 是 0.3.1 那轮量出来的；
 * 换的只是版本段，形状没动。）
 *
 * ------------------------------------------------------------------ 版本段
 *
 * 版本段**构建期注入**，不再手写：`electron.vite.config.ts` 的
 * `define.__ARBITER_VERSION__` 取自 package.json 的 `version`。起因是第三方审计 N1——
 * 0.3.2 的包里 UA 还写着 `Arbiter/0.3.1`，用户下载引擎时镜像日志会把版本记错。
 * 手写常量必然漂：发版时要记得回来改这一行，而没有任何东西会提醒你。
 *
 * ⚠️ **判据必须是 `typeof`，不能直接引用那个标识符。** 注入的常量只存在于
 * electron-vite 的构建产物（`out/main/*.js`）里；tsx 直接跑的 `scripts/test-downlink.ts`
 * 与 esbuild 打的脚本都认不出它，写成 `__ARBITER_VERSION__` 会
 * `ReferenceError: __ARBITER_VERSION__ is not defined`，而且是**整个模块加载期**就炸。
 * `typeof <没声明的标识符>` 是 JS 里唯一不抛的写法（`typeof` 是运算符，不求值标识符），
 * 拿不到就回落。
 *
 * 取舍（刻意的，别当 bug 改）：**测试与无构建脚本里 UA 是 `Arbiter/dev`，
 * 只有构建产物里才是真版本号。**
 * 想让两边一致只有两条路，都更差：让 tsx 也认这个 define（做不到，define 是构建器的），
 * 或者改成运行时读 package.json（主进程读到的未必是「这个包」那一份——MCP / CLI 以
 * Node 模式跑时 cwd 在别处，反而更容易拿到错的版本，而且错得静默）。
 * `dev` 在镜像日志里一眼可辨，不会被误当成某个发行版。
 */
declare const __ARBITER_VERSION__: string | undefined
const ARBITER_VERSION: string =
  typeof __ARBITER_VERSION__ === 'string' ? __ARBITER_VERSION__ : 'dev'
export const USER_AGENT = `Arbiter/${ARBITER_VERSION} (+https://github.com/Polaris-bit189/Arbiter)`

// ------------------------------------------------------------------ 传输层

export interface TransportResponse {
  status: number
  /** 头名统一小写；值可能是数组（如 set-cookie） */
  headers: Record<string, string | string[] | undefined>
  /** 订阅响应体分片。适配层必须保证「订阅之后不会漏掉任何分片」。 */
  onData(callback: (chunk: Buffer) => void): void
  onEnd(callback: () => void): void
  onError(callback: (error: Error) => void): void
}

export interface TransportRequest {
  url: string
  headers?: Record<string, string>
  /** 收到响应头时调用；此后才开始投递分片 */
  onResponse(response: TransportResponse): void
  /** 请求级别的失败：连不上、DNS 解析不了、连接被重置等 */
  onError(error: Error): void
}

export interface TransportHandle {
  abort(): void
}

export interface DownloadTransport {
  request(request: TransportRequest): TransportHandle
}

/**
 * Electron 版传输层。`redirect: 'follow'` 是默认值，这里显式写出来：
 * 清华 TUNA 之类的镜像经常用一个 302 把人转到真实文件上。
 *
 * `net.request` 的**默认 UA 是浏览器那个串**，而清华 TUNA 对它的回复是 403
 * （见 `USER_AGENT`）。这里不设默认值——调用方（`downloadFile`）每条请求都自带，
 * `setHeader` 会把 Electron 的默认值覆盖掉。**别改成「这里设一次就够」**：
 * 那样本地镜像那套自测就观察不到这个头，回归会静默溜过去。
 */
export function createNetTransport(): DownloadTransport {
  return {
    request(request: TransportRequest): TransportHandle {
      const client = net.request({ url: request.url, redirect: 'follow' })
      for (const [name, value] of Object.entries(request.headers ?? {})) {
        client.setHeader(name, value)
      }

      // 监听器必须先挂上再 end()，否则 'response' 可能在挂之前就到
      client.on('response', (response) => {
        request.onResponse({
          status: response.statusCode,
          headers: response.headers,
          onData: (callback) => response.on('data', callback),
          onEnd: (callback) => response.on('end', callback),
          onError: (callback) => response.on('error', callback)
        })
      })
      // error 一定要有监听器：Electron 的 ClientRequest 是 EventEmitter，
      // 无人认领的 'error' 会把主进程掀翻。abort() 之后这里也会来一发
      // ERR_ABORTED，调用方按 settled 忽略掉即可。
      client.on('error', (error) => request.onError(error))
      client.end()

      return {
        abort: (): void => {
          client.abort()
        }
      }
    }
  }
}

// ------------------------------------------------------------------ 对外类型

export interface DownloadProgress {
  /** 已经拿到的总字节数（**含 `.part` 里已有的**，否则续传时进度条会从 0 跳） */
  received: number
  /** 本次请求的 Content-Length + 续传起点；服务端没给长度时为 null */
  total: number | null
  /** 0~1；总长未知时为 null */
  percent: number | null
}

export interface DownloadAttemptFailure {
  url: string
  reason: string
}

/** 所有镜像都失败了。`attempts` 保留每个镜像的失败原因，供 UI 拼一句能看懂的话。 */
export class DownloadFailed extends Error {
  constructor(
    message: string,
    readonly attempts: DownloadAttemptFailure[]
  ) {
    super(message)
    this.name = 'DownloadFailed'
  }
}

export interface DownloadOptions {
  /** 候选镜像，按顺序尝试，前一个失败就换下一个 */
  urls: string[]
  /** 最终文件路径。临时文件固定是 `<dest>.part`，与 dest 同目录以保证 rename 原子 */
  dest: string
  /** 期望的 sha256（十六进制，大小写不敏感） */
  sha256: string
  transport: DownloadTransport
  /** 取消令牌。取消后保留 `.part`，抛 `ConversionCanceled` */
  cancel?: CancelToken
  onProgress?: (progress: DownloadProgress) => void
  /** 每次开始尝试一个镜像时调用，用来在 UI 上显示「正在从第 2/3 个镜像重试」 */
  onAttempt?: (url: string, index: number, count: number) => void
}

export interface DownloadResult {
  path: string
  url: string
  bytes: number
}

// ------------------------------------------------------------------ 主流程

/** `<dest>.part`：和 dest 同目录，所以校验通过后的 rename 在 NTFS 上是原子的 */
function partPathOf(dest: string): string {
  return `${dest}.part`
}

async function fileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size
  } catch {
    return 0
  }
}

function headerValue(
  headers: Record<string, string | string[] | undefined>,
  name: string
): string | undefined {
  const raw = headers[name.toLowerCase()] ?? headers[name]
  if (raw === undefined) return undefined
  return Array.isArray(raw) ? raw[0] : raw
}

function throwIfCanceled(cancel?: CancelToken): void {
  if (cancel?.canceled) throw new ConversionCanceled()
}

/** 流式计算文件的 sha256。下载完再读一遍比边下边算省心：续传/重来都不必重置哈希状态。 */
export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256')
  const stream = createReadStream(path)
  await new Promise<void>((resolve, reject) => {
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolve())
  })
  return hash.digest('hex')
}

type AttemptOutcome =
  /** 响应体收完并落盘 */
  | { kind: 'complete'; received: number }
  /** 用户取消（调用方保留 .part 并抛 ConversionCanceled） */
  | { kind: 'canceled' }
  /** HTTP 416：`.part` 比服务端的资源还大，删掉重来一次 */
  | { kind: 'restart' }
  | { kind: 'failed'; reason: string }

interface AttemptParams {
  url: string
  partPath: string
  transport: DownloadTransport
  /** 已落盘的字节数；> 0 时发 Range 续传 */
  resumeFrom: number
  cancel?: CancelToken
  onProgress?: (progress: DownloadProgress) => void
}

/**
 * 尝试一个镜像一次。
 *
 * 只有取消会以 `ConversionCanceled` 抛出，其余失败一律走 `AttemptOutcome`——
 * 因为「失败后换下一个镜像」是常态而不是异常。
 */
function runAttempt(params: AttemptParams): Promise<AttemptOutcome> {
  const { url, partPath, transport, resumeFrom, cancel, onProgress } = params

  return new Promise<AttemptOutcome>((settle) => {
    let settled = false
    let stream: WriteStream | null = null
    let received = 0
    let total: number | null = null
    let handle: TransportHandle | null = null

    const emitProgress = (): void => {
      onProgress?.({
        received,
        total,
        percent: total !== null && total > 0 ? Math.min(received / total, 1) : null
      })
    }

    /**
     * 关掉写流并等它真正 flush 完。
     * 这一步不能省：Windows 上文件句柄没释放，紧接着的 rm/rename 会拿 EBUSY；
     * 而且最后几个分片可能还在内核缓冲里，不等就少几字节、续传点跟着错位。
     */
    const closeStream = async (): Promise<void> => {
      const current = stream
      if (!current) return
      stream = null
      await new Promise<void>((resolve) => {
        // 流已经出错/被销毁时 end 的回调不保证触发，用 'close' 兜底，避免挂死
        current.once('close', () => resolve())
        current.end(() => resolve())
      })
    }

    const done = (outcome: AttemptOutcome): void => {
      if (settled) return
      settled = true
      void closeStream().then(() => settle(outcome))
    }

    if (cancel?.canceled) {
      settle({ kind: 'canceled' })
      return
    }
    cancel?.onCancel(() => {
      // 自己 abort 自己，就不依赖传输层上报什么事件了：
      // Electron 会回一个 ERR_ABORTED，node 会回 ECONNRESET，形态不统一
      handle?.abort()
      done({ kind: 'canceled' })
    })

    const headers: Record<string, string> = { 'User-Agent': USER_AGENT }
    if (resumeFrom > 0) headers.Range = `bytes=${resumeFrom}-`

    handle = transport.request({
      url,
      headers,

      onResponse: (response) => {
        if (settled) return

        if (response.status === 416) {
          // 断点比资源还长（上次没下完、资源又换了版本）。换从头写，不当作失败。
          done({ kind: 'restart' })
          return
        }
        if (response.status < 200 || response.status >= 300) {
          done({ kind: 'failed', reason: `HTTP ${response.status}` })
          return
        }

        // 206 才是「服务端接受了 Range」。返回 200 说明它把 Range 当没看见，
        // 这时候绝不能接着往 .part 后面追加——那会拼出一个 前半段旧数据 + 完整新文件
        // 的怪物，而且 sha 要到最后才知道不对。直接截断重写。
        const resuming = response.status === 206
        const base = resuming ? resumeFrom : 0
        const lengthHeader = headerValue(response.headers, 'content-length')
        const declared = lengthHeader === undefined ? Number.NaN : Number(lengthHeader)
        total = Number.isFinite(declared) && declared >= 0 ? base + declared : null

        received = base
        stream = createWriteStream(partPath, { flags: resuming ? 'a' : 'w' })
        stream.on('error', (error) => {
          // 盘写不进去就没必要继续拉了，顺手把请求掐掉
          handle?.abort()
          done({ kind: 'failed', reason: `写入失败：${error.message}` })
        })

        // 先报一次基线。续传时第一个事件就是「已下载 N/total」，
        // 少了这一次，进度条会先显示 0 再跳到断点。
        emitProgress()

        response.onData((chunk) => {
          if (settled || !stream) return
          stream.write(chunk)
          received += chunk.length
          emitProgress()
        })
        response.onEnd(() => done({ kind: 'complete', received }))
        response.onError((error) => done({ kind: 'failed', reason: `网络错误：${error.message}` }))
      },

      onError: (error) => {
        done({ kind: 'failed', reason: `网络错误：${error.message}` })
      }
    })
  })
}

/** 校验通过后把 `.part` 原子地搬到最终位置（同目录 rename，NTFS 上原子） */
async function placeFile(partPath: string, dest: string): Promise<void> {
  await removeQuietly(dest)
  try {
    await rename(partPath, dest)
  } catch {
    await removeQuietly(partPath)
    throw new DownloadFailed('无法写入目标文件，请检查目录是否可写、磁盘是否已满', [])
  }
}

/**
 * 按顺序尝试所有镜像，第一个「下载完整 + sha256 对上」的胜出。
 * 全部失败抛 `DownloadFailed`；用户取消抛 `ConversionCanceled`（此时 `.part` 保留）。
 */
export async function downloadFile(options: DownloadOptions): Promise<DownloadResult> {
  const { urls, dest, transport, cancel, onProgress, onAttempt } = options
  const want = options.sha256.trim().toLowerCase()

  if (urls.length === 0) throw new DownloadFailed('没有配置任何下载镜像', [])
  if (!/^[0-9a-f]{64}$/.test(want)) {
    throw new DownloadFailed(`sha256 不合法：${options.sha256}`, [])
  }

  const partPath = partPathOf(dest)
  const failures: DownloadAttemptFailure[] = []
  await mkdir(dirname(dest), { recursive: true })

  for (let index = 0; index < urls.length; index += 1) {
    const url = urls[index]!
    throwIfCanceled(cancel)
    onAttempt?.(url, index, urls.length)

    let outcome = await runAttempt({
      url,
      partPath,
      transport,
      cancel,
      onProgress,
      resumeFrom: await fileSize(partPath)
    })

    if (outcome.kind === 'restart') {
      await removeQuietly(partPath)
      outcome = await runAttempt({
        url,
        partPath,
        transport,
        cancel,
        onProgress,
        resumeFrom: 0
      })
    }

    if (outcome.kind === 'canceled') throw new ConversionCanceled()

    if (outcome.kind !== 'complete') {
      // 注意这里**不删 `.part`**：网络中断留下的前缀是有效断点，
      // 下一个镜像（或用户下次重试）接着下就行。
      failures.push({ url, reason: outcome.kind === 'restart' ? 'HTTP 416' : outcome.reason })
      continue
    }

    const actual = await sha256File(partPath)
    if (actual !== want) {
      // 校验不过必须把 `.part` 一起删掉（`removeQuietly` 顺带处理 Windows 上
      // 句柄未释放导致的 EBUSY）。只删最终文件的话，下一个镜像会把这个坏文件
      // 当断点去续传，于是每个镜像都在补同一个坏文件，sha 永远对不上——死循环。
      await removeQuietly(partPath)
      failures.push({
        url,
        reason: `sha256 不匹配（期望 ${want.slice(0, 12)}… 实际 ${actual.slice(0, 12)}…）`
      })
      continue
    }

    await placeFile(partPath, dest)
    return { path: dest, url, bytes: outcome.received }
  }

  const detail = failures.map((f) => `${f.url}：${f.reason}`).join('；')
  throw new DownloadFailed(`全部 ${urls.length} 个下载镜像都失败了（${detail}）`, failures)
}

// ------------------------------------------------------ 引擎清单（消费侧）

/**
 * `resources/engines.manifest.json` 的读取、校验与「计划」。
 *
 * **清单是唯一真相源**：sha256、字节数、镜像列表都只有这一份，代码里不复写。
 * 这里的校验全部是「宁可拒绝也不将就」型的——清单写错一个字符，结果不是下载失败，
 * 而是**下载到一个哈希对不上的文件、每个镜像都白跑一遍**（那些镜像加起来是几百 MB）。
 * 所以下列每一条不合格都直接抛 `ManifestError`，绝不做「兜底成默认值」：
 *
 *  - `schemaVersion` 不认识 → 抛。将来清单升版时，老程序去读新清单必须**当场**报错，
 *    而不是按老 schema 猜着读（猜错了就是 sha256 被静默忽略）。
 *  - `sha256` 不是 64 位十六进制 → 抛。它等价于签名，一个空串或 `TODO` 是最危险的输入：
 *    `downloadFile` 那道 `/^[0-9a-f]{64}$/` 闸会拦下它，但那时已经在 UI 上弹过一次
 *    「开始下载」了，用户看到的是「全部镜像失败」这种牛头不对马嘴的理由。
 *  - `sizeBytes` 不是正整数 → 抛。它是唯一能在下载**之前**发现「资源被换成了别的版本」的
 *    交叉校验；`downloadFile` 只认 sha256，而 sha256 只能在几百 MB 下完之后才算得了。
 *  - `mirrors` 为空 / url 不是 http(s) → 抛。零个镜像的条目只会让调用方拿到一句
 *    「没有配置任何下载镜像」。
 *
 * `ManifestError` 刻意**不继承 `DownloadFailed`**：前者是「程序自带的配置坏了」，
 * 重试一万次都一样；后者是「网络/镜像的问题」，值得换镜像。混成一个类型的话，
 * UI 会把「清单里 sha256 写错了」渲染成「请检查网络后重试」。
 */
export class ManifestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ManifestError'
  }
}

/** 本程序认识的清单版本。清单升版 = 语义变更，必须改这里并同步 reader。 */
export const MANIFEST_SCHEMA_VERSION = 1

export interface ManifestMirror {
  url: string
  region?: string
  /**
   * 是否已实测可达。**不再由代码据此重排或过滤**（见 `mirrorUrls`），
   * 它只是「这份清单能不能发出去」的验收标记，由测试与 CI 盯着。
   */
  verified?: boolean
  note?: string
}

/**
 * 下载完之后怎么把它变成一棵**能跑的目录树**。
 *
 * 这张表是清单里最容易被写坏的一块：`msiexec /a` 与 `7z x` 解 MSI 出来的东西
 * 长得完全不一样（前者保留 Directory 表，后者 100% 扁平），而**扁平的树照样
 * 「解压成功」**——跑起来才是 `0xC0000135 STATUS_DLL_NOT_FOUND`（约束 16）。
 * 所以这里逐字段校验，宁可当场拒收一份清单，也不要装出一个跑不起来的引擎。
 */
export interface ManifestExtract {
  /** `msiexec-a` 给 MSI 用；`zip-entry` 给那种「整包里只挑一个文件」的（wheel） */
  method: 'msiexec-a' | 'zip-entry'
  /**
   * 解到 `engineDir/<targetDir>/` 下。
   *
   * **必须是单个路径段**（不含分隔符、不是 `.` / `..`）：这个值会被 `join` 到
   * 用户目录下，一个 `../..` 就能让它往外写。清单是我们自己发的文件，
   * 但它同样可能被手改坏，而写坏的方向不是「报错」而是「往别处写」。
   */
  targetDir: string
  /** `zip-entry` 专用：从归档里挑哪个条目。用 `7z e` 抽，落盘时只剩文件名 */
  entryInArchive?: string
  /** `zip-entry` 专用：抽出来的文件应当是多少字节。对不上说明取错了条目 */
  expectedEntrySizeBytes?: number
}

export interface EngineManifestEntry {
  key: string
  label: string
  version: string
  kind: string
  sizeBytes: number
  /** 十六进制小写，64 位。下载完成后逐字节校验的就是它 */
  sha256: string
  mirrors: ManifestMirror[]
  /**
   * 解包方式。**只有三个重型引擎需要它**，而它们恰好都必须按需下载，
   * 所以「下载完了怎么装」这件事的真相源只有这里一处。
   */
  extract: ManifestExtract
  /** 解包之后，可执行文件在 `engineDir/<targetDir>/` 下的相对路径 */
  entry?: string
  covers?: string[]
  /** 需要该引擎的 `[源格式, 目标格式]` 对。见 pandoc 那条的说明 */
  routes?: string[][]
  optional?: boolean
}

export interface EngineManifest {
  schemaVersion: number
  engines: EngineManifestEntry[]
}

const SHA256_RE = /^[0-9a-f]{64}$/i

function fail(message: string): never {
  throw new ManifestError(message)
}

function asNonEmptyString(value: unknown, where: string): string {
  if (typeof value !== 'string' || value.trim() === '') fail(`${where} 必须是非空字符串`)
  return value
}

/** 单个路径段：不含分隔符、不是 `.` / `..`。见 `ManifestExtract.targetDir` 的注释 */
function asSingleSegment(value: unknown, where: string): string {
  const text = asNonEmptyString(value, where)
  if (text.includes('/') || text.includes('\\') || text === '.' || text === '..') {
    fail(
      `${where} 必须是单个路径段（不能含分隔符，也不能是 . 或 ..），实得 ${JSON.stringify(text)}`
    )
  }
  return text
}

function parseExtract(raw: unknown, where: string): ManifestExtract {
  if (typeof raw !== 'object' || raw === null) fail(`${where} 缺少 extract（下载完了怎么装）`)
  const source = raw as Record<string, unknown>

  const method = source.method
  if (method !== 'msiexec-a' && method !== 'zip-entry') {
    fail(`${where} 的 extract.method 只能是 msiexec-a 或 zip-entry，实得 ${JSON.stringify(method)}`)
  }

  const targetDir = asSingleSegment(source.targetDir, `${where} 的 extract.targetDir`)

  if (method === 'zip-entry') {
    if (typeof source.entryInArchive !== 'string' || source.entryInArchive.trim() === '') {
      fail(`${where} 的 extract.entryInArchive 在 zip-entry 下是必填的`)
    }
    // 归档内的路径同样不给 `..`：`7z e` 是按条目名匹配的，一个拼错的条目名
    // 不会报错，只会一个文件都不抽出来——那种失败要等到「找不到可执行文件」才现形。
    if (source.entryInArchive.startsWith('/') || source.entryInArchive.includes('..')) {
      fail(`${where} 的 extract.entryInArchive 不能是绝对路径或含 ..：${source.entryInArchive}`)
    }
  }

  let expectedEntrySizeBytes: number | undefined
  if (source.expectedEntrySizeBytes !== undefined) {
    if (
      typeof source.expectedEntrySizeBytes !== 'number' ||
      !Number.isSafeInteger(source.expectedEntrySizeBytes) ||
      source.expectedEntrySizeBytes <= 0
    ) {
      fail(`${where} 的 extract.expectedEntrySizeBytes 必须是正整数`)
    }
    expectedEntrySizeBytes = source.expectedEntrySizeBytes
  }

  return {
    method,
    targetDir,
    ...(typeof source.entryInArchive === 'string' ? { entryInArchive: source.entryInArchive } : {}),
    ...(expectedEntrySizeBytes === undefined ? {} : { expectedEntrySizeBytes })
  }
}

/** 校验一条引擎。任何一处不合格都抛，理由带上 `key`，方便直接去清单里定位。 */
function parseEntry(raw: unknown, index: number): EngineManifestEntry {
  if (typeof raw !== 'object' || raw === null) fail(`engines[${index}] 不是对象`)
  const source = raw as Record<string, unknown>
  const key = asNonEmptyString(source.key, `engines[${index}].key`)
  const where = `引擎 ${key}`

  const label = asNonEmptyString(source.label, `${where} 的 label`)
  const version = asNonEmptyString(source.version, `${where} 的 version`)
  const kind = asNonEmptyString(source.kind, `${where} 的 kind`)

  if (typeof source.sizeBytes !== 'number' || !Number.isSafeInteger(source.sizeBytes)) {
    fail(`${where} 的 sizeBytes 必须是整数，实得 ${JSON.stringify(source.sizeBytes)}`)
  }
  if (source.sizeBytes <= 0) fail(`${where} 的 sizeBytes 必须为正，实得 ${source.sizeBytes}`)
  const sizeBytes = source.sizeBytes

  if (typeof source.sha256 !== 'string' || !SHA256_RE.test(source.sha256)) {
    fail(`${where} 的 sha256 不是 64 位十六进制：${JSON.stringify(source.sha256)}`)
  }
  const sha256 = source.sha256.toLowerCase()

  if (!Array.isArray(source.mirrors) || source.mirrors.length === 0) {
    fail(`${where} 没有配置任何下载镜像`)
  }
  const mirrors: ManifestMirror[] = source.mirrors.map((item, i) => {
    if (typeof item !== 'object' || item === null) fail(`${where} 的 mirrors[${i}] 不是对象`)
    const mirror = item as Record<string, unknown>
    const url = asNonEmptyString(mirror.url, `${where} 的 mirrors[${i}].url`)
    if (!/^https?:\/\//i.test(url)) fail(`${where} 的 mirrors[${i}].url 不是 http(s) 地址：${url}`)
    if (mirror.verified !== undefined && typeof mirror.verified !== 'boolean') {
      fail(`${where} 的 mirrors[${i}].verified 必须是布尔值`)
    }
    return {
      url,
      ...(typeof mirror.region === 'string' ? { region: mirror.region } : {}),
      ...(typeof mirror.verified === 'boolean' ? { verified: mirror.verified } : {}),
      ...(typeof mirror.note === 'string' ? { note: mirror.note } : {})
    }
  })

  const extract = parseExtract(source.extract, where)

  let routes: string[][] | undefined
  if (source.routes !== undefined) {
    if (!Array.isArray(source.routes) || source.routes.length === 0)
      fail(`${where} 的 routes 不是非空数组`)
    routes = source.routes.map((pair, i) => {
      if (!Array.isArray(pair) || pair.length !== 2)
        fail(`${where} 的 routes[${i}] 必须是 [源, 目标] 两元组`)
      return [
        asNonEmptyString(pair[0], `${where} 的 routes[${i}][0]`),
        asNonEmptyString(pair[1], `${where} 的 routes[${i}][1]`)
      ]
    })
  }

  let covers: string[] | undefined
  if (source.covers !== undefined) {
    if (!Array.isArray(source.covers)) fail(`${where} 的 covers 不是数组`)
    covers = source.covers.map((ext, i) => asNonEmptyString(ext, `${where} 的 covers[${i}]`))
  }

  return {
    key,
    label,
    version,
    kind,
    sizeBytes,
    sha256,
    mirrors,
    extract,
    ...(typeof source.entry === 'string' ? { entry: source.entry } : {}),
    ...(covers === undefined ? {} : { covers }),
    ...(routes === undefined ? {} : { routes }),
    ...(typeof source.optional === 'boolean' ? { optional: source.optional } : {})
  }
}

/**
 * 校验并规范化清单。传进来的是已 `JSON.parse` 的任意值——因为它可能来自用户可编辑的文件，
 * 按 `unknown` 处理，不做任何「看起来像就当成是」的转换。
 */
export function parseManifest(raw: unknown): EngineManifest {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) fail('引擎清单的根不是对象')
  const source = raw as Record<string, unknown>

  if (source.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    fail(
      `不支持的引擎清单版本：${JSON.stringify(source.schemaVersion)}（本程序只认 ${MANIFEST_SCHEMA_VERSION}）。` +
        '清单升版必须同步更新 downlink.ts 的 reader，不能按老 schema 猜着读'
    )
  }
  if (!Array.isArray(source.engines) || source.engines.length === 0) fail('引擎清单里没有任何引擎')

  const engines = source.engines.map((entry, index) => parseEntry(entry, index))
  const seen = new Set<string>()
  for (const engine of engines) {
    if (seen.has(engine.key)) fail(`引擎清单里有重复的 key：${engine.key}`)
    seen.add(engine.key)
  }

  return { schemaVersion: MANIFEST_SCHEMA_VERSION, engines }
}

/** 读文件 + 校验。路径由调用方给（打包前后 resourcesPath 不同，这里不猜）。 */
export async function loadManifest(path: string): Promise<EngineManifest> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    throw new ManifestError(
      `读不到引擎清单 ${path}：${error instanceof Error ? error.message : String(error)}`
    )
  }
  try {
    return parseManifest(JSON.parse(text))
  } catch (error) {
    if (error instanceof ManifestError) throw error
    throw new ManifestError(
      `引擎清单 ${path} 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`
    )
  }
}

export function manifestEntry(manifest: EngineManifest, key: string): EngineManifestEntry | null {
  return manifest.engines.find((engine) => engine.key === key) ?? null
}

/**
 * 按清单里的**声明顺序**返回镜像地址。刻意不按 `verified` 重排：
 * 清单的 `_notes` 写着「mirrors 的顺序 = 尝试顺序」，那是个对外契约，
 * 代码偷偷重排会让「为什么先试了第二个」变得无法解释。
 * 「有的镜像还没实测过」是清单自身的质量问题，交给 `unverifiedMirrors` 暴露给测试/CI，
 * 而不是在这里静默换顺序。
 */
export function mirrorUrls(entry: EngineManifestEntry): string[] {
  if (entry.mirrors.length === 0) fail(`引擎 ${entry.key} 没有配置任何下载镜像`)
  return entry.mirrors.map((mirror) => mirror.url)
}

/** 尚未实测可达的镜像（`verified !== true`）。M7 的验收判据是「这个集合必须为空」。 */
export function unverifiedMirrors(entry: EngineManifestEntry): string[] {
  return entry.mirrors.filter((mirror) => mirror.verified !== true).map((mirror) => mirror.url)
}

/**
 * 从 URL 取落盘文件名。
 *
 * **`basename` 不能直接用**：`new URL()` 的 pathname 是百分号编码的，
 * `%2F` 解出来是 `/`、`%5C` 是 `\`——先 basename 再解码就等于没检查。
 * 所以先解码、再确认结果里不含任何路径分隔符，否则一个被投毒的清单
 * （或写错了的镜像地址）能把文件写到目标目录之外去。
 */
export function fileNameFromUrl(url: string): string {
  let pathname: string
  try {
    pathname = new URL(url).pathname
  } catch {
    fail(`镜像地址不是合法 URL：${url}`)
  }
  const last = pathname.split('/').pop() ?? ''
  let name: string
  try {
    name = decodeURIComponent(last)
  } catch {
    fail(`镜像地址的文件名无法解码：${url}`)
  }
  if (name === '' || name === '.' || name === '..') fail(`镜像地址里没有文件名：${url}`)
  if (/[/\\]/.test(name) || name.includes('\0')) fail(`镜像地址的文件名里含路径分隔符：${url}`)
  return name
}

export interface EngineDownloadPlan {
  engine: EngineManifestEntry
  /** 按清单声明顺序排列的候选镜像 */
  urls: string[]
  sha256: string
  sizeBytes: number
  /** 落盘路径：`destDir` + 第一个镜像 URL 的文件名（换镜像不改名，`.part` 才能续） */
  dest: string
}

/**
 * 把一条清单条目翻译成一次下载要做的事。
 *
 * 落盘名固定取**第一个**镜像的文件名，不是「当前正在试的那个」：
 * 中途换镜像时 dest 一变，`<dest>.part` 就跟着变，续传点直接作废——
 * 而「换镜像」正是这条链路最常见的路径。
 */
export function engineDownloadPlan(
  manifest: EngineManifest,
  key: string,
  destDir: string
): EngineDownloadPlan {
  const engine = manifestEntry(manifest, key)
  if (engine === null) fail(`引擎清单里没有 ${key}`)
  const urls = mirrorUrls(engine)
  return {
    engine,
    urls,
    sha256: engine.sha256,
    sizeBytes: engine.sizeBytes,
    dest: join(destDir, fileNameFromUrl(urls[0]!))
  }
}

export interface EngineDownloadResult extends DownloadResult {
  engine: string
}

/**
 * 「按清单下载一个引擎」的完整入口——`formats.ts` 的 `requiresDownload()` 给出引擎 key 之后，
 * 拿它去清单里查一次就能跑。
 *
 * 请求头由 `downloadFile()` 统一带上（`USER_AGENT` + 需要时的 `Range`）。**UA 那条曾是
 * 一个真实缺口**：清华 TUNA 对浏览器 UA 回 403，而 Electron `net.request` 的默认 UA 正是
 * 浏览器那个串，于是 LibreOffice 与 pandoc 的国内镜像在打包后一个都下不动——
 * 多镜像回退会把这个 403 当成普通失败吞掉，用户只看到「下载失败」。见 `USER_AGENT` 的注释。
 */
export async function downloadEngine(
  manifest: EngineManifest,
  key: string,
  destDir: string,
  transport: DownloadTransport,
  extra: Omit<DownloadOptions, 'urls' | 'dest' | 'sha256' | 'transport'> = {}
): Promise<EngineDownloadResult> {
  const plan = engineDownloadPlan(manifest, key, destDir)
  const result = await downloadFile({
    ...extra,
    urls: plan.urls,
    dest: plan.dest,
    sha256: plan.sha256,
    transport
  })
  return { ...result, engine: key }
}
