/**
 * downlink.ts 的自测脚本（不依赖 Electron，直接跑）。
 *
 *   npx tsx --tsconfig tsconfig.test.json scripts/test-downlink.ts
 *
 * 必须带 `--tsconfig tsconfig.test.json`：`@shared/*` 别名靠它。
 *
 * 这里能跑起来本身就是一条断言——`tsconfig.test.json` 把 `electron` 映射成了
 * `scripts/electron-stub.ts`，那份桩里**没有 `net`**。downlink.ts 把 `net.request`
 * 挡在 `DownloadTransport` 接口后面，主逻辑才可能用本地 http 服务器当镜像来测。
 * 传输层适配器是下面这个 `httpTransport()`，它跟生产用的 Electron 实现一一对应。
 *
 * 素材全是现造的随机字节：这里验的是「协议行为」（Range 头、206/200、416、
 * 断点、sha、取消），不是解码器行为，不需要第三方样本。
 *
 * 两个写法上的纪律（都是被这份测试自己咬出来的）：
 *  - 每个小节外面兜一层 try/catch。否则被测代码一抛异常，套件就崩在半路，
 *    后面几十条断言一条都不跑，红的是「崩了」而不是「哪条断言错了」。
 *  - 「不应存在 X」型断言一律带上前置条件（先确认请求真的发出去了 / 事件非空），
 *    否则在被测代码根本没走到那一步时它们会恒为真。
 */
import { createHash, randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createServer, request as httpRequest } from 'node:http'
import type { IncomingMessage, Server } from 'node:http'
import { join, resolve } from 'node:path'
import { CancelToken } from '../src/main/core/cancel'
import {
  DownloadFailed,
  ManifestError,
  MANIFEST_SCHEMA_VERSION,
  downloadEngine,
  downloadFile,
  USER_AGENT,
  engineDownloadPlan,
  fileNameFromUrl,
  loadManifest,
  manifestEntry,
  mirrorUrls,
  parseManifest,
  sha256File,
  unverifiedMirrors,
  type DownloadOptions,
  type DownloadProgress,
  type DownloadResult,
  type DownloadTransport,
  type EngineManifest,
  type EngineManifestEntry,
  type TransportHandle,
  type TransportRequest
} from '../src/main/core/downlink'
import { ConversionCanceled } from '../src/main/converters/common'
import { engineFor, requiresDownload, targetsFor } from '../src/shared/formats'

const TMP = resolve('.tmp-test-downlink')
const PAYLOAD = randomBytes(300 * 1024)
const PAYLOAD_SHA = createHash('sha256').update(PAYLOAD).digest('hex')
const CHUNK = 32 * 1024

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

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) return false
    await delay(5)
  }
  return true
}

async function freshDir(name: string): Promise<string> {
  const dir = resolve(TMP, name)
  await rm(dir, { recursive: true, force: true })
  await mkdir(dir, { recursive: true })
  return dir
}

/** 断言里要看到「失败时磁盘上到底是什么」，所以读不到就返回 null，不抛 */
async function readOrNull(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path)
  } catch {
    return null
  }
}

async function sizeOr(path: string, fallback: number): Promise<number> {
  try {
    return (await stat(path)).size
  } catch {
    return fallback
  }
}

/** 被测代码抛异常时也要把后面的断言跑完，所以不把异常往外扔 */
async function attemptDownload(
  options: DownloadOptions
): Promise<{ result: DownloadResult | null; error: unknown }> {
  try {
    return { result: await downloadFile(options), error: null }
  } catch (error) {
    return { result: null, error }
  }
}

// ------------------------------------------------------------ 客户端传输层

/** 生产实现（createNetTransport）的 node 版对照物，接口一一对应 */
function httpTransport(): DownloadTransport {
  return {
    request(request: TransportRequest): TransportHandle {
      const url = new URL(request.url)
      const client = httpRequest(
        {
          hostname: url.hostname,
          port: url.port,
          path: `${url.pathname}${url.search}`,
          method: 'GET',
          headers: request.headers ?? {}
        },
        (response: IncomingMessage) => {
          // 先攒着订阅者：'data' 可能在 onResponse 返回之前就开始投递
          let onData: ((chunk: Buffer) => void) | null = null
          let onEnd: (() => void) | null = null
          let onError: ((error: Error) => void) | null = null
          response.on('data', (chunk: Buffer) => onData?.(chunk))
          response.on('end', () => onEnd?.())
          response.on('error', (error: Error) => onError?.(error))

          request.onResponse({
            status: response.statusCode ?? 0,
            headers: response.headers,
            onData: (cb) => {
              onData = cb
            },
            onEnd: (cb) => {
              onEnd = cb
            },
            onError: (cb) => {
              onError = cb
            }
          })
        }
      )
      client.on('error', (error: Error) => request.onError(error))
      client.end()
      return {
        abort: (): void => {
          client.destroy()
        }
      }
    }
  }
}

// ------------------------------------------------------------ 本地镜像服务

interface MirrorOptions {
  payload: Buffer
  /** 分片大小，默认 32 KB */
  chunkSize?: number
  /** 每个分片之间等多久，用来制造「下到一半」的时机 */
  chunkDelayMs?: number
  /** false = 假装不认识 Range：对 Range 请求回 200 + 全量（有些 CDN 就这样） */
  supportRange?: boolean
  /** 固定回这个状态码，不回正文 */
  forceStatus?: number
  /** 只发前 N 字节就掐断连接，模拟网络中断 */
  cutAfter?: number
  /** 每次请求进来时探测一下这个路径存不存在（用来抓「坏 .part 有没有被删掉」） */
  probePath?: string
}

interface MirrorState {
  requests: number
  /** 每次请求收到的 Range 头；没发就是 undefined */
  ranges: (string | undefined)[]
  /** 每次请求收到的 User-Agent；没发就是 undefined。见 `USER_AGENT` 那条断言 */
  agents: (string | undefined)[]
  /** 服务端一侧观察到「还没写完就被断开」 */
  aborted: boolean
  /** probePath 在每次请求进来那一刻是否存在 */
  probeExists: boolean[]
}

interface Mirror {
  url: string
  state: MirrorState
  close: () => Promise<void>
}

async function startMirror(options: MirrorOptions): Promise<Mirror> {
  const payload = options.payload
  const total = payload.length
  const chunkSize = options.chunkSize ?? CHUNK
  const state: MirrorState = {
    requests: 0,
    ranges: [],
    agents: [],
    aborted: false,
    probeExists: []
  }

  const server: Server = createServer((req, res) => {
    state.requests += 1
    state.ranges.push(req.headers.range)
    state.agents.push(req.headers['user-agent'])
    if (options.probePath) state.probeExists.push(existsSync(options.probePath))

    if (options.forceStatus) {
      res.writeHead(options.forceStatus)
      res.end('nope')
      return
    }

    const range = req.headers.range
    let start = 0
    let status = 200
    if (range && options.supportRange !== false) {
      const matched = /^bytes=(\d+)-/.exec(range)
      start = matched ? Number(matched[1]) : 0
      if (start >= total) {
        res.writeHead(416, { 'Content-Range': `bytes */${total}` })
        res.end()
        return
      }
      status = 206
    }

    res.writeHead(status, {
      'Content-Length': String(total - start),
      ...(status === 206 ? { 'Content-Range': `bytes ${start}-${total - 1}/${total}` } : {})
    })

    let offset = start
    let sent = 0
    const push = (): void => {
      if (res.destroyed || res.writableEnded) return
      if (options.cutAfter !== undefined && sent >= options.cutAfter) {
        res.destroy()
        return
      }
      if (offset >= total) {
        res.end()
        return
      }
      let end = Math.min(offset + chunkSize, total)
      if (options.cutAfter !== undefined) {
        end = Math.min(end, start + options.cutAfter)
      }
      res.write(payload.subarray(offset, end))
      sent += end - offset
      offset = end
      if (options.chunkDelayMs) setTimeout(push, options.chunkDelayMs)
      else setImmediate(push)
    }

    if (options.chunkDelayMs) setTimeout(push, options.chunkDelayMs)
    else push()

    res.on('close', () => {
      if (!res.writableEnded) state.aborted = true
    })
  })

  await new Promise<void>((done) => server.listen(0, '127.0.0.1', () => done()))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0

  return {
    url: `http://127.0.0.1:${port}/engine.bin`,
    state,
    close: (): Promise<void> =>
      new Promise<void>((done) => {
        // keep-alive 的连接会让 close 挂着不返回
        server.closeAllConnections()
        server.close(() => done())
      })
  }
}

// ------------------------------------------------------------ [1] 正常下载

async function testPlainDownload(): Promise<void> {
  console.log('\n[1] 正常下载 + sha256 校验')
  const dir = await freshDir('plain')
  const dest = resolve(dir, 'engine.bin')
  const mirror = await startMirror({ payload: PAYLOAD })

  try {
    const events: DownloadProgress[] = []
    const { result, error } = await attemptDownload({
      urls: [mirror.url],
      dest,
      sha256: PAYLOAD_SHA,
      transport: httpTransport(),
      onProgress: (p) => events.push({ ...p })
    })
    check('下载成功', result !== null, String(error))
    check('返回 dest 路径', result?.path === dest, String(result?.path))
    check('返回的字节数是完整长度', result?.bytes === PAYLOAD.length, String(result?.bytes))
    check('返回命中的镜像 URL', result?.url === mirror.url)

    const written = await readOrNull(dest)
    check('产物字节与源逐字节一致', written?.equals(PAYLOAD) === true, `${written?.length} 字节`)
    check('校验通过的产物 sha256 对得上', (await sha256File(dest)) === PAYLOAD_SHA)
    check('已请求过镜像', mirror.state.requests === 1, String(mirror.state.requests))
    check('.part 已被 rename 掉，不留临时文件', !existsSync(`${dest}.part`))

    const last = events[events.length - 1]
    check('进度收到多次更新', events.length > 1, `${events.length} 次`)
    check(
      '进度单调不减',
      events.length > 0 && events.every((p, i) => i === 0 || p.received >= events[i - 1]!.received),
      JSON.stringify(events.map((p) => p.received))
    )
    check('最终 received = 文件长度', last?.received === PAYLOAD.length, String(last?.received))
    check('最终 total = 文件长度', last?.total === PAYLOAD.length, String(last?.total))
    check('最终 percent = 1', last?.percent === 1, String(last?.percent))
    check(
      '首次请求没有带 Range',
      mirror.state.requests === 1 && mirror.state.ranges[0] === undefined,
      String(mirror.state.ranges[0])
    )

    // UA 这条曾经是个真实缺口：Electron `net.request` 默认发浏览器 UA，而清华 TUNA
    // 对「空 UA」和「浏览器 UA」一律回 403——多镜像回退会把它当成普通失败吞掉，
    // 用户只看到「下载失败」。判据里**同时盯两头**：既要有头，也不能是浏览器那一串
    // （只比 `=== USER_AGENT` 的话，把常量本身改成浏览器 UA 就抓不住了）。
    const agent = mirror.state.agents[0]
    check(
      '请求自带 User-Agent，且不是浏览器那一串（TUNA 对两者一律 403）',
      mirror.state.requests === 1 &&
        agent === USER_AGENT &&
        !/Mozilla|AppleWebKit|Chrome|Safari|Electron/i.test(agent ?? ''),
      `requests=${mirror.state.requests} agent=${agent}`
    )
  } finally {
    await mirror.close()
  }
}

// ------------------------------------------------------------ [2] 断点续传

async function testResume(): Promise<void> {
  console.log('\n[2] 断点续传（中断 → 留下 .part → 带 Range 续下）')
  const dir = await freshDir('resume')
  const dest = resolve(dir, 'engine.bin')
  const part = `${dest}.part`

  // 第一趟：服务端发到 100 KB 就把连接掐了，模拟网络中断
  const flaky = await startMirror({
    payload: PAYLOAD,
    chunkSize: 16 * 1024,
    chunkDelayMs: 2,
    cutAfter: 100 * 1024
  })
  try {
    const { result, error } = await attemptDownload({
      urls: [flaky.url],
      dest,
      sha256: PAYLOAD_SHA,
      transport: httpTransport()
    })
    check('中途断流 → 下载失败', result === null, '居然下完了')
    check('中途断流 → 抛 DownloadFailed', error instanceof DownloadFailed, String(error))
    check('断流不算取消', !(error instanceof ConversionCanceled))
  } finally {
    await flaky.close()
  }

  const partSize = await sizeOr(part, 0)
  check('.part 被保留下来当断点', partSize > 0 && partSize < PAYLOAD.length, `${partSize} 字节`)
  check('断流时不生成最终文件', partSize > 0 && !existsSync(dest))
  check(
    '.part 里的内容就是已收到的前缀',
    partSize > 0 && (await readOrNull(part))?.equals(PAYLOAD.subarray(0, partSize)) === true
  )

  // 第二趟：正常镜像，应该从断点续
  const good = await startMirror({ payload: PAYLOAD, probePath: part })
  try {
    const events: DownloadProgress[] = []
    const { result, error } = await attemptDownload({
      urls: [good.url],
      dest,
      sha256: PAYLOAD_SHA,
      transport: httpTransport(),
      onProgress: (p) => events.push({ ...p })
    })
    check('续传成功', result !== null, String(error))

    check(
      '续传时 Range 头正好从断点开始',
      good.state.ranges[0] === `bytes=${partSize}-`,
      String(good.state.ranges[0])
    )
    check('续传后产物完整且正确', (await readOrNull(dest))?.equals(PAYLOAD) === true)
    check('续传后 .part 消失', good.state.requests > 0 && !existsSync(part))
    check('续传返回的字节数是全长', result?.bytes === PAYLOAD.length, String(result?.bytes))

    const first = events[0]
    check(
      '进度从断点起步而不是 0',
      first?.received === partSize && first.received > 0,
      `first=${first?.received} part=${partSize}`
    )
    check('续传时 total 已含断点部分', first?.total === PAYLOAD.length, String(first?.total))
    check(
      '续传的 received 单调不减',
      events.length > 0 && events.every((p, i) => i === 0 || p.received >= events[i - 1]!.received)
    )
  } finally {
    await good.close()
  }
}

// ------------------------------------------ [3] 服务端不支持 Range（回 200）

async function testServerIgnoresRange(): Promise<void> {
  console.log('\n[3] 服务端不支持 Range（回 200 而非 206）→ 从头重写')
  const dir = await freshDir('no-range')
  const dest = resolve(dir, 'engine.bin')
  const part = `${dest}.part`

  const stale = PAYLOAD.subarray(0, 100 * 1024)
  await writeFile(part, stale)

  const mirror = await startMirror({ payload: PAYLOAD, supportRange: false, probePath: part })
  try {
    const events: DownloadProgress[] = []
    const { result, error } = await attemptDownload({
      urls: [mirror.url],
      dest,
      sha256: PAYLOAD_SHA,
      transport: httpTransport(),
      onProgress: (p) => events.push({ ...p })
    })
    check('200 回退后能成功下载', result !== null, String(error))

    check(
      '确实发了 Range 头（服务端选择忽略）',
      mirror.state.ranges[0] === `bytes=${stale.length}-`,
      String(mirror.state.ranges[0])
    )
    const written = await readOrNull(dest)
    check(
      '产物长度是全长，不是 旧前缀 + 新全量 的拼盘',
      written?.length === PAYLOAD.length,
      `${written?.length} vs ${PAYLOAD.length}`
    )
    check('产物字节与源一致（没有被追加拼接）', written?.equals(PAYLOAD) === true)
    check('200 时进度从 0 重算', events[0]?.received === 0, String(events[0]?.received))
    check('200 时 total 仍是全长', events[0]?.total === PAYLOAD.length, String(events[0]?.total))
  } finally {
    await mirror.close()
  }
}

// ------------------------------- [4] sha256 不匹配 → 删 .part → 换下一个镜像

async function testShaMismatchSwitchesMirror(): Promise<void> {
  console.log('\n[4] sha256 不匹配 → 删掉 .part → 换下一个镜像')
  const dir = await freshDir('sha')
  const dest = resolve(dir, 'engine.bin')
  const part = `${dest}.part`

  // 长度一样、内容差一个字节：下载能「完整」跑完，只有 sha 抓得住
  const poisoned = Buffer.from(PAYLOAD)
  poisoned[12345] = poisoned[12345]! ^ 0xff

  const bad = await startMirror({ payload: poisoned, probePath: part })
  const good = await startMirror({ payload: PAYLOAD, probePath: part })

  try {
    const attempts: string[] = []
    const { result, error } = await attemptDownload({
      urls: [bad.url, good.url],
      dest,
      sha256: PAYLOAD_SHA,
      transport: httpTransport(),
      onAttempt: (url) => attempts.push(url)
    })
    check('最终下载成功', result !== null, String(error))

    check('坏镜像被完整下完过一次', bad.state.requests === 1, String(bad.state.requests))
    check('每个镜像只试一次', good.state.requests === 1, String(good.state.requests))
    check('依次尝试了两个镜像', attempts.length === 2 && attempts[1] === good.url)
    check('最终命中第二个镜像', result?.url === good.url)

    // 这三条是「坏 .part 真的被删了」的证据链。
    // 坏文件长度与正品相同，所以只要它还在磁盘上，第二个镜像必然只回 416，
    // 或者被当成断点续传（Range 头会露馅）。
    check(
      '第二个镜像被请求时，坏的 .part 已经不在磁盘上',
      good.state.probeExists.length === 1 && good.state.probeExists[0] === false,
      `probeExists=${JSON.stringify(good.state.probeExists)}`
    )
    check(
      '第二个镜像没有收到 Range 头（没有拿坏文件去续传）',
      good.state.requests === 1 && good.state.ranges[0] === undefined,
      String(good.state.ranges[0])
    )
    check('最终产物是正确的那个镜像的内容', (await readOrNull(dest))?.equals(PAYLOAD) === true)
    check('最终产物 sha256 正确', (await sha256File(dest)) === PAYLOAD_SHA)
    check('坏 .part 没有残留', bad.state.requests === 1 && !existsSync(part))
  } finally {
    await bad.close()
    await good.close()
  }
}

// ----------------------------------------------- [5] HTTP 500 → 自动换镜像

async function testHttpErrorSwitchesMirror(): Promise<void> {
  console.log('\n[5] 第一个镜像 HTTP 500 → 自动换第二个镜像')
  const dir = await freshDir('http500')
  const dest = resolve(dir, 'engine.bin')

  const broken = await startMirror({ payload: PAYLOAD, forceStatus: 500 })
  const good = await startMirror({ payload: PAYLOAD })
  try {
    const { result, error } = await attemptDownload({
      urls: [broken.url, good.url],
      dest,
      sha256: PAYLOAD_SHA,
      transport: httpTransport()
    })
    check('最终下载成功', result !== null, String(error))
    check('产物与源一致', (await readOrNull(dest))?.equals(PAYLOAD) === true)
    check('命中第二个镜像', result?.url === good.url)
    check('坏镜像只被敲了一次', broken.state.requests === 1, String(broken.state.requests))
    check('好镜像被敲了一次', good.state.requests === 1, String(good.state.requests))

    // 全部镜像都挂时，错误里要能看出每个镜像为什么挂
    const dead = resolve(dir, 'dead.bin')
    const all = await attemptDownload({
      urls: [broken.url, broken.url],
      dest: dead,
      sha256: PAYLOAD_SHA,
      transport: httpTransport()
    })
    const failedAll = all.error instanceof DownloadFailed ? all.error : null
    check('全挂 → 下载失败', all.result === null)
    check('全挂 → DownloadFailed', failedAll !== null, String(all.error))
    check(
      '失败原因逐镜像记录',
      failedAll?.attempts.length === 2,
      String(failedAll?.attempts.length)
    )
    check(
      '失败原因带上了 HTTP 状态码',
      failedAll?.attempts.every((a) => a.reason.includes('HTTP 500')) === true,
      JSON.stringify(failedAll?.attempts)
    )
    check('全挂时不留下最终文件', broken.state.requests >= 2 && !existsSync(dead))
  } finally {
    await broken.close()
    await good.close()
  }
}

// ---------------------------------------------------- [6] 进度累加（续传起点）

async function testProgressAccumulates(): Promise<void> {
  console.log('\n[6] 进度累加：续传时不从 0 开始')
  const dir = await freshDir('progress')
  const dest = resolve(dir, 'engine.bin')
  const part = `${dest}.part`
  const done = 64 * 1024
  await writeFile(part, PAYLOAD.subarray(0, done))

  const mirror = await startMirror({ payload: PAYLOAD, chunkSize: 16 * 1024 })
  try {
    const events: DownloadProgress[] = []
    const { result, error } = await attemptDownload({
      urls: [mirror.url],
      dest,
      sha256: PAYLOAD_SHA,
      transport: httpTransport(),
      onProgress: (p) => events.push({ ...p })
    })
    check('续传成功', result !== null, String(error))

    check(
      '第一个进度事件 = .part 已有字节',
      events[0]?.received === done,
      String(events[0]?.received)
    )
    check(
      '后续每个事件都含断点基数',
      events.length > 0 && events.every((p) => p.received >= done && p.received <= PAYLOAD.length),
      JSON.stringify(events.map((p) => p.received))
    )
    check(
      'received 单调不减且收尾等于全长',
      events.length > 0 &&
        events.every((p, i) => i === 0 || p.received >= events[i - 1]!.received) &&
        events[events.length - 1]?.received === PAYLOAD.length
    )
    check(
      '每个事件的 total 都是全长',
      events.length > 0 && events.every((p) => p.total === PAYLOAD.length)
    )
    check(
      'percent 单调不减且收尾为 1',
      events.length > 0 &&
        events.every((p, i) => i === 0 || (p.percent ?? 0) >= (events[i - 1]!.percent ?? 0)) &&
        events[events.length - 1]?.percent === 1
    )
  } finally {
    await mirror.close()
  }
}

// -------------------------------------------------------- [7] 416 断点比资源大

async function testRangeNotSatisfiable(): Promise<void> {
  console.log('\n[7] .part 比资源还大（HTTP 416）→ 删掉重来')
  const dir = await freshDir('416')
  const dest = resolve(dir, 'engine.bin')
  const part = `${dest}.part`
  // 上次下到一半资源换了版本，断点比新资源还长
  await writeFile(part, Buffer.concat([PAYLOAD, randomBytes(4096)]))

  const mirror = await startMirror({ payload: PAYLOAD })
  try {
    const { result, error } = await attemptDownload({
      urls: [mirror.url],
      dest,
      sha256: PAYLOAD_SHA,
      transport: httpTransport()
    })
    check('416 后仍能下载成功', result !== null, String(error))
    check('416 后产物正确', (await readOrNull(dest))?.equals(PAYLOAD) === true)
    check(
      '416 后重新发了不带 Range 的请求',
      mirror.state.ranges.length === 2,
      String(mirror.state.ranges.length)
    )
    check(
      '第二次请求没有 Range 头',
      mirror.state.ranges.length === 2 && mirror.state.ranges[1] === undefined,
      String(mirror.state.ranges[1])
    )
    check('返回字节数是全长', result?.bytes === PAYLOAD.length, String(result?.bytes))
  } finally {
    await mirror.close()
  }
}

// ---------------------------------------------------------------- [8] 取消

async function testCancel(): Promise<void> {
  console.log('\n[8] 取消：请求真停、.part 保留、抛取消类错误')
  const dir = await freshDir('cancel')
  const dest = resolve(dir, 'engine.bin')
  const part = `${dest}.part`

  // 慢镜像：40 个分片 × 15ms，保证取消能落在「下到一半」
  const mirror = await startMirror({ payload: PAYLOAD, chunkSize: 8 * 1024, chunkDelayMs: 15 })
  const token = new CancelToken()
  const events: DownloadProgress[] = []

  try {
    const pending = downloadFile({
      urls: [mirror.url],
      dest,
      sha256: PAYLOAD_SHA,
      transport: httpTransport(),
      cancel: token,
      onProgress: (p) => events.push({ ...p })
    })

    const started = await waitFor(() => events.some((p) => p.received > 0), 3000)
    check('取消前已经在收数据了（取消落在下载途中）', started)

    const countAtCancel = events.length
    const receivedAtCancel = events[events.length - 1]?.received ?? 0
    token.cancel()

    let error: unknown = null
    try {
      await pending
    } catch (e) {
      error = e
    }

    check('抛的是 ConversionCanceled', error instanceof ConversionCanceled, String(error))
    check('错误名与项目其它引擎一致', (error as Error | null)?.name === 'ConversionCanceled')
    check('取消不生成最终文件', !existsSync(dest))

    const partSize = await sizeOr(part, -1)
    check('.part 被保留（下次能续）', partSize > 0 && partSize < PAYLOAD.length, `${partSize} 字节`)
    check(
      '.part 内容 = 已收到的字节（取消时也把缓冲刷干净了）',
      partSize === receivedAtCancel,
      `part=${partSize} received=${receivedAtCancel}`
    )

    await delay(200)
    check(
      '取消后不再有进度回调',
      countAtCancel > 0 && events.length === countAtCancel,
      `${countAtCancel} → ${events.length}`
    )
    check(
      '服务端观察到请求真的被断开',
      mirror.state.aborted === true,
      `aborted=${mirror.state.aborted}`
    )
  } finally {
    await mirror.close()
  }
}

// ------------------------------------------- [9] 引擎清单（消费侧：读、校验、计划）

const MANIFEST_PATH = resolve('resources/engines.manifest.json')
/** 清单里 pandoc 那条的 sha256。2026-09-13 两个镜像各整份下完一遍，实测都是这个值 */
const PANDOC_WHEEL_SHA = '76fae066cd2d7e78fb97f0ec8e9e36f437b07187b689b0b415ca18216f8f898a'

/** 跑一个表达式：抛了就返回那个错误，没抛就返回它的返回值。两边都用同一处断言。 */
function thrownBy(fn: () => unknown): unknown {
  try {
    return fn()
  } catch (error) {
    return error
  }
}

/**
 * 造一份最小合法清单，只为了拿 `parseManifest` 去撞各种非法输入。
 * `engines` 里那条的字段可以逐个盖掉/删掉。
 */
function rawManifest(
  entryPatch: Record<string, unknown> = {},
  drop: string[] = [],
  patch: Record<string, unknown> = {}
): Record<string, unknown> {
  const entry: Record<string, unknown> = {
    key: 'demo',
    label: 'Demo',
    version: '1',
    kind: 'msi',
    sizeBytes: 1024,
    sha256: PAYLOAD_SHA,
    mirrors: [{ url: 'https://example.invalid/demo.msi', region: 'cn', verified: true }],
    extract: { method: 'msiexec-a', targetDir: 'demo' },
    ...entryPatch
  }
  for (const name of drop) delete entry[name]
  return { schemaVersion: MANIFEST_SCHEMA_VERSION, engines: [entry], ...patch }
}

/** 假镜像的清单：url 全是本地 http 服务器，sha256 由调用方给（用来造「对不上」） */
function miniManifest(urls: string[], sha256: string): EngineManifest {
  return parseManifest({
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    engines: [
      {
        key: 'pandoc',
        label: 'Pandoc',
        version: '3.9 (test)',
        kind: 'wheel',
        sizeBytes: PAYLOAD.length,
        sha256,
        mirrors: urls.map((url, i) => ({ url, region: i === 0 ? 'cn' : 'intl', verified: true })),
        extract: {
          method: 'zip-entry',
          targetDir: 'pandoc',
          entryInArchive: 'pypandoc/files/pandoc.exe'
        },
        routes: [['md', 'docx']]
      }
    ]
  })
}

async function attemptDownloadEngine(
  manifest: EngineManifest,
  key: string,
  destDir: string
): Promise<{ result: DownloadResult | null; error: unknown }> {
  try {
    return { result: await downloadEngine(manifest, key, destDir, httpTransport()), error: null }
  } catch (error) {
    return { result: null, error }
  }
}

async function testManifest(): Promise<void> {
  console.log('\n[9] 引擎清单：读取 / 校验 / 生成下载计划')
  const dir = await freshDir('manifest-plan')

  let manifest: EngineManifest
  try {
    manifest = await loadManifest(MANIFEST_PATH)
  } catch (error) {
    check('清单能读出来并通过校验', false, String(error))
    return
  }
  check(
    '清单能读出来并通过校验',
    manifest.schemaVersion === MANIFEST_SCHEMA_VERSION,
    String(manifest.schemaVersion)
  )

  const keys = manifest.engines.map((e) => e.key)
  check('三个引擎登记在册（前置条件）', keys.length === 3, keys.join(','))
  check(
    '含 libreoffice / calibre / pandoc',
    ['libreoffice', 'calibre', 'pandoc'].every((k) => keys.includes(k)),
    keys.join(',')
  )

  for (const engine of manifest.engines) {
    const problems = unverifiedMirrors(engine)
    check(
      `${engine.key} 的每条镜像都标了 verified`,
      engine.mirrors.length > 0 && problems.length === 0,
      problems.join(' | ')
    )
    check(
      `${engine.key} 的 sha256 是 64 位十六进制`,
      /^[0-9a-f]{64}$/.test(engine.sha256),
      engine.sha256
    )
    check(
      `${engine.key} 的 sizeBytes 是正整数`,
      Number.isSafeInteger(engine.sizeBytes) && engine.sizeBytes > 0,
      String(engine.sizeBytes)
    )
  }

  const pandoc = manifestEntry(manifest, 'pandoc')
  check('能按 key 拿到 pandoc 条目', pandoc !== null, 'null')
  check('pandoc 的 sha256 = 实测值', pandoc?.sha256 === PANDOC_WHEEL_SHA, String(pandoc?.sha256))
  check('pandoc 的 sizeBytes = 实测值', pandoc?.sizeBytes === 40891661, String(pandoc?.sizeBytes))
  check(
    'pandoc 有两条镜像（cn + intl）',
    pandoc !== null && mirrorUrls(pandoc).length === 2,
    pandoc === null ? 'null' : String(mirrorUrls(pandoc).length)
  )

  if (pandoc !== null) {
    const plan = engineDownloadPlan(manifest, 'pandoc', dir)
    check('计划的 sha256 取自清单', plan.sha256 === PANDOC_WHEEL_SHA, plan.sha256)
    check('计划的 sizeBytes 取自清单', plan.sizeBytes === pandoc.sizeBytes, String(plan.sizeBytes))
    check(
      '落盘名取自第一个镜像的 URL',
      plan.dest === join(dir, 'pypandoc_binary-1.17-py3-none-win_amd64.whl'),
      plan.dest
    )
    check(
      '镜像顺序 = 清单声明顺序（cn 在前）',
      plan.urls.length === 2 && plan.urls[0] === pandoc.mirrors[0]!.url,
      plan.urls.join(' , ')
    )
    check(
      '未知引擎 key → ManifestError',
      thrownBy(() => engineDownloadPlan(manifest, 'nope', dir)) instanceof ManifestError
    )
  }

  // 非法清单必须当场拒绝。逐条都是「宁可拒绝也不将就」——放过一条的代价是：
  // 下载完几百 MB 才发现哈希对不上，而理由会显示成「全部镜像失败」。
  const rejected: [string, unknown][] = [
    ['schemaVersion 不认识', rawManifest({}, [], { schemaVersion: 2 })],
    ['engines 缺失', { schemaVersion: MANIFEST_SCHEMA_VERSION }],
    ['engines 为空', { schemaVersion: MANIFEST_SCHEMA_VERSION, engines: [] }],
    ['sha256 写成 TODO', rawManifest({ sha256: 'TODO' })],
    ['sha256 缺一位', rawManifest({ sha256: PAYLOAD_SHA.slice(1) })],
    ['sizeBytes = 0', rawManifest({ sizeBytes: 0 })],
    ['sizeBytes 不是整数', rawManifest({ sizeBytes: 1024.5 })],
    ['mirrors 为空', rawManifest({ mirrors: [] })],
    ['url 不是 http(s)', rawManifest({ mirrors: [{ url: 'ftp://example.invalid/x' }] })],
    ['mirror 缺 url', rawManifest({ mirrors: [{ region: 'cn' }] })],
    [
      'verified 不是布尔',
      rawManifest({ mirrors: [{ url: 'https://example.invalid/x', verified: 'yes' }] })
    ],
    ['key 为空串', rawManifest({ key: '' })],
    ['covers 里有空串', rawManifest({ covers: ['md', ''] })],
    ['routes 不是两元组数组', rawManifest({ routes: ['md', 'docx'] })],
    [
      '重复的 key',
      {
        schemaVersion: MANIFEST_SCHEMA_VERSION,
        engines: [rawManifest().engines, rawManifest().engines].flat()
      }
    ]
  ]
  for (const [label, raw] of rejected) {
    check(`非法清单被拒：${label}`, thrownBy(() => parseManifest(raw)) instanceof ManifestError)
  }

  const upper = thrownBy(() => parseManifest(rawManifest({ sha256: PAYLOAD_SHA.toUpperCase() })))
  check(
    '大写 sha256 被接受并归一成小写',
    upper instanceof Error === false &&
      (upper as EngineManifest).engines[0]!.sha256 === PAYLOAD_SHA,
    String(upper instanceof Error ? upper : (upper as EngineManifest).engines[0]!.sha256)
  )
  check(
    'ManifestError 不是 DownloadFailed（配置坏了不该被当成网络问题）',
    !(new ManifestError('x') instanceof DownloadFailed)
  )

  const nameCases: [string, string, boolean][] = [
    ['https://example.invalid/a/b/pandoc.exe', 'pandoc.exe', true],
    [
      'https://example.invalid/a/pypandoc_binary-1.17-py3-none-win_amd64.whl?x=1',
      'pypandoc_binary-1.17-py3-none-win_amd64.whl',
      true
    ],
    ['https://example.invalid/a/', '', false],
    ['https://example.invalid/a/b%2F..%2Fc', '', false],
    ['不是 URL', '', false]
  ]
  for (const [url, want, ok] of nameCases) {
    const got = thrownBy(() => fileNameFromUrl(url))
    check(
      `落盘名 ${ok ? '正确' : '被拒'}：${url}`,
      ok ? got === want : got instanceof ManifestError,
      String(got instanceof Error ? got.name : got)
    )
  }

  // 未实测过的镜像不能被静默吞掉：它要么被验证过，要么报出来
  const synthetic: EngineManifestEntry = {
    key: 'demo',
    label: 'Demo',
    version: '1',
    kind: 'msi',
    sizeBytes: 1,
    sha256: PAYLOAD_SHA,
    mirrors: [
      { url: 'https://example.invalid/a.msi', verified: true },
      { url: 'https://example.invalid/b.msi' },
      { url: 'https://example.invalid/c.msi', verified: false }
    ],
    // `extract` 在清单里是必填的（解析器强制），这个夹具走的是**类型**而不是解析器，
    // 所以也得给一个——否则「清单少写解包方式」这件事在类型层面就没有约束了。
    extract: { method: 'msiexec-a', targetDir: 'demo' }
  }
  const missing = unverifiedMirrors(synthetic)
  check(
    'unverifiedMirrors 挑出没实测过的那两条',
    synthetic.mirrors.length === 3 && missing.length === 2,
    String(missing.length)
  )
  check(
    'mirrorUrls 保留声明顺序且不过滤（不因未实测就丢镜像）',
    mirrorUrls(synthetic).length === 3,
    String(mirrorUrls(synthetic).length)
  )
}

// ------------------------------- [10] pandoc 条目：清单驱动（注入假镜像，不真下载）

async function testPandocEntryDownload(): Promise<void> {
  console.log('\n[10] pandoc 条目：清单驱动的多镜像回退 / sha 拒绝 / Range 续传')
  const dir = await freshDir('pandoc-entry')
  const dest = resolve(dir, 'engine.bin')
  const part = `${dest}.part`

  // [10a] 多镜像回退。第一个镜像的字节「长度一样、坏一个字节」——只有 sha256 抓得住
  const poisoned = Buffer.from(PAYLOAD)
  poisoned[999] = poisoned[999]! ^ 0xff
  const bad = await startMirror({ payload: poisoned, probePath: part })
  const good = await startMirror({ payload: PAYLOAD, probePath: part })
  try {
    const manifest = miniManifest([bad.url, good.url], PAYLOAD_SHA)
    const result = await downloadEngine(manifest, 'pandoc', dir, httpTransport())
    check('清单驱动的下载成功', result.path === dest, result.path)
    check('返回的 engine key 是 pandoc', result.engine === 'pandoc', result.engine)
    check('回退到第二个镜像', result.url === good.url, result.url)
    check('第一个镜像确实被完整下过一遍', bad.state.requests === 1, String(bad.state.requests))
    check(
      '换镜像时坏 .part 已经被删（没被拿去续传）',
      good.state.probeExists.length === 1 && good.state.probeExists[0] === false,
      JSON.stringify(good.state.probeExists)
    )
    check(
      '第二个镜像没收到 Range 头',
      good.state.ranges[0] === undefined,
      String(good.state.ranges[0])
    )
    check('产物与源逐字节一致', (await readOrNull(dest))?.equals(PAYLOAD) === true)
    check('产物 sha256 与清单一致', (await sha256File(dest)) === PAYLOAD_SHA)
    check('不留 .part', !existsSync(part))
  } finally {
    await bad.close()
    await good.close()
  }

  // [10b] 清单里的 sha256 与镜像内容对不上 → 必须拒绝，且不能死循环重试
  const shaDir = await freshDir('pandoc-sha')
  const shaDest = resolve(shaDir, 'engine.bin')
  const shaPart = `${shaDest}.part`
  const wrongSha = createHash('sha256').update('这不是那一份文件').digest('hex')
  const m1 = await startMirror({ payload: PAYLOAD, probePath: shaPart })
  const m2 = await startMirror({ payload: PAYLOAD, probePath: shaPart })
  try {
    const manifest = miniManifest([m1.url, m2.url], wrongSha)
    const { result, error } = await attemptDownloadEngine(manifest, 'pandoc', shaDir)
    check('sha256 不符 → 下载失败', result === null, '居然成功了')
    check('sha256 不符 → 抛 DownloadFailed', error instanceof DownloadFailed, String(error))
    const attempts = error instanceof DownloadFailed ? error.attempts : []
    check(
      '两个镜像各只试一次（没有反复重试）',
      m1.state.requests === 1 && m2.state.requests === 1,
      `${m1.state.requests}/${m2.state.requests}`
    )
    check('失败原因逐镜像记录', attempts.length === 2, String(attempts.length))
    check(
      '失败原因点明是 sha256 不匹配',
      attempts.length > 0 && attempts.every((a) => a.reason.includes('sha256 不匹配')),
      JSON.stringify(attempts)
    )
    check('不留最终文件', !existsSync(shaDest))
    check(
      '坏 .part 也被删掉（留着会让下一个镜像一直续传坏文件）',
      m1.state.probeExists.length === 1 && !existsSync(shaPart)
    )
    check(
      '第二个镜像被请求时坏 .part 已不在磁盘上',
      m2.state.probeExists.length === 1 && m2.state.probeExists[0] === false,
      JSON.stringify(m2.state.probeExists)
    )
  } finally {
    await m1.close()
    await m2.close()
  }

  // [10c] Range 续传：.part 里的断点必须是计划里那个 dest 的 .part
  const resumeDir = await freshDir('pandoc-resume')
  const resumeDest = resolve(resumeDir, 'engine.bin')
  const resumePart = `${resumeDest}.part`
  const done = 96 * 1024
  await writeFile(resumePart, PAYLOAD.subarray(0, done))
  const mirror = await startMirror({ payload: PAYLOAD, chunkSize: 16 * 1024 })
  try {
    const manifest = miniManifest([mirror.url], PAYLOAD_SHA)
    const events: DownloadProgress[] = []
    const result = await downloadEngine(manifest, 'pandoc', resumeDir, httpTransport(), {
      onProgress: (p) => events.push({ ...p })
    })
    check('续传成功', result.path === resumeDest, result.path)
    check(
      'Range 头正好从断点开始',
      mirror.state.ranges[0] === `bytes=${done}-`,
      String(mirror.state.ranges[0])
    )
    check('进度从断点起步而不是 0', events[0]?.received === done, String(events[0]?.received))
    check('产物 sha256 与清单一致', (await sha256File(resumeDest)) === PAYLOAD_SHA)
    check('续传后 .part 消失', !existsSync(resumePart))
  } finally {
    await mirror.close()
  }
}

// ------------------------- [11] 清单的 routes ↔ 能力矩阵（把「哪 10 条要 pandoc」钉住）

async function testManifestRoutesMatchMatrix(): Promise<void> {
  console.log('\n[11] 清单 routes ↔ 能力矩阵：哪 10 条转换真的要 pandoc')
  const manifest = await loadManifest(MANIFEST_PATH)
  const pandoc = manifestEntry(manifest, 'pandoc')!
  const routes = pandoc.routes ?? []
  const key = (pair: string[]): string => `${pair[0]}>${pair[1]}`
  const routeKeys = routes.map(key)
  const covers = pandoc.covers ?? []

  check('pandoc 条目的 routes 有 10 条（前置条件）', routes.length === 10, String(routes.length))
  check('routes 无重复', new Set(routeKeys).size === routes.length, routeKeys.join(','))

  const notSupported = routes.filter(([f, t]) => !targetsFor(f).includes(t))
  check(
    'routes 里每一条都是矩阵认可的转换',
    routes.length > 0 && notSupported.length === 0,
    notSupported.map(key).join(',')
  )

  const engines = routes.map(([f, t]) => `${key([f, t])}=${String(engineFor(f, t))}`)
  check(
    'routes 每条都落在 pandoc 引擎或 rst 的 document 路径上',
    routes.length > 0 &&
      routes.every(([f, t]) => ['pandoc', 'pdf'].includes(String(engineFor(f, t)))),
    engines.join(' ')
  )

  // 矩阵里「路由到 pandoc 引擎」的那几条必须全被 routes 收录——否则清单漏一条，
  // 那条转换就会在没提示的情况下失败
  const byEngine = covers.flatMap((f) =>
    targetsFor(f)
      .filter((t) => engineFor(f, t) === 'pandoc')
      .map((t) => [f, t])
  )
  check(
    '矩阵里路由到 pandoc 引擎的 6 条都在 routes 里',
    byEngine.length === 6 && byEngine.every((p) => routeKeys.includes(key(p))),
    byEngine.map(key).join(',')
  )
  check(
    'routes 的源格式集合 = covers',
    JSON.stringify([...new Set(routes.map(([f]) => f))].sort()) ===
      JSON.stringify([...covers].sort()),
    `${routes.map(([f]) => f).join(',')} vs ${covers.join(',')}`
  )

  // 另外 4 条落在 document 引擎里、内部照样拉起 pandoc（约束 14 的 rst 出口）。
  // 这 4 条是「看 engine key 看不出来」的那一半，单独钉住。
  const documented = [
    ['rst', 'html'],
    ['rst', 'md'],
    ['rst', 'txt'],
    ['rst', 'pdf']
  ].map(key)
  const rest = routes.filter(([f, t]) => engineFor(f, t) !== 'pandoc').map(key)
  check(
    'routes 里非 pandoc 引擎的正好是 rst 的四个 document 出口',
    JSON.stringify([...rest].sort()) === JSON.stringify([...documented].sort()),
    rest.join(',')
  )

  // 判据侧：`requiresDownload()` 必须认出**全部 10 条**。
  //
  // 缺口期间这里写的是 `check(..., covered === routes.length ? true : …)` 那种「等补齐了
  // 自然就变真断言」的写法，而**补齐之后它退化成了 `check(..., true)`**——一条恒真的装饰。
  // formats.ts 补齐的那次改动没有回来动它，于是缺口补没补，这条都绿。
  // 现在写成硬断言：漏一条的表现是「pandoc 缺席时那条转换既不提示下载、也不进 task.ts
  // 的跳过分支」，用户拖进来只会看到一次莫名其妙的失败。
  const covered = routes.filter(([f, t]) => requiresDownload(f, t) === 'pandoc')
  const missed = routes.filter(([f, t]) => requiresDownload(f, t) !== 'pandoc').map(key)
  check(
    'requiresDownload 覆盖全部 10 条 pandoc 转换',
    routes.length > 0 && covered.length === routes.length,
    `覆盖 ${covered.length}/${routes.length}${missed.length > 0 ? `，缺 ${missed.join(' ')}` : ''}`
  )
}

// ---------------------------------------------------------------- 主流程

async function main(): Promise<void> {
  console.log('=== 下载器自测（本地 http 镜像）===')
  await rm(TMP, { recursive: true, force: true }).catch(() => {})

  const sections: [string, () => Promise<void>][] = [
    ['一、正常下载', testPlainDownload],
    ['二、断点续传', testResume],
    ['三、服务端不支持 Range', testServerIgnoresRange],
    ['四、sha256 不匹配换镜像', testShaMismatchSwitchesMirror],
    ['五、HTTP 500 换镜像', testHttpErrorSwitchesMirror],
    ['六、进度累加', testProgressAccumulates],
    ['七、416 断点比资源大', testRangeNotSatisfiable],
    ['八、取消', testCancel],
    ['九、引擎清单消费侧', testManifest],
    ['十、pandoc 条目（清单驱动）', testPandocEntryDownload],
    ['十一、清单 routes ↔ 能力矩阵', testManifestRoutesMatchMatrix]
  ]

  try {
    for (const [name, section] of sections) {
      try {
        await section()
      } catch (error) {
        // 小节里冒出未预期的异常时，记一条红并继续跑后面的——
        // 否则一个异常就把剩下的断言全盖住，红的是「崩了」而不是「哪条错了」
        check(
          `${name} 整段跑完（未抛异常）`,
          false,
          error instanceof Error ? `${error.name}: ${error.message}` : String(error)
        )
      }
    }
  } finally {
    await rm(TMP, { recursive: true, force: true }).catch(() => {})
  }

  console.log(`\n=== 通过 ${passed} / 失败 ${failed} ===`)
  process.exit(failed === 0 ? 0 : 1)
}

void main()
