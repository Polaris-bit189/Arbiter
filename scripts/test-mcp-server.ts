/**
 * M4 的验收现场：**把 MCP server 当成一个真正的子进程来跑**，说 JSON-RPC。
 *
 * 为什么不能只做进程内测试：这条线的全部风险都在**进程边界**上——
 * stdout 被日志污染、路径闸门没生效、取消没杀掉进程树、引擎加载又把 electron
 * 拖了回来。这些在进程内全都会被掩盖过去。所以这里的做法是
 * `spawn(node, ['--import','tsx','src/mcp/main.ts'])`，然后用 stdin/stdout 说话。
 *
 * 三节：
 *   1. `protectStdout` 的**进程内**单测（含自证：闸门真的拦得住、也真的不误杀）
 *   2. 主线会话：八个工具 + resource + 闸门 + 真转换 + 真取消
 *   3. 第二个实例（引擎全部指不到）：证明「引擎未就绪」是**在排队之前**拒的，
 *      并且同一实例上不需要引擎的那条转换**照样成功**（否则「被拒」可能只是实例坏了）
 *   4. 输出目录设置改变落点的那一支（「不给 output_path 落在源文件旁边」是有条件的）
 *   5. `read_document`：一次调用读出正文、不写用户的输出目录、临时目录两条路径都不残留、
 *      截断可续读、扫描件 PDF 报错而不是给空串
 *
 * 跑法：
 * ```bash
 * npx tsx --tsconfig tsconfig.test.json scripts/test-mcp-server.ts
 * ```
 */
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'fs'
import Module from 'module'
import { tmpdir } from 'os'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'
import { DEFAULT_READ_CHARS, MAX_READ_CHARS } from '../src/mcp/schema'
import type { EngineKey } from '@shared/types'
import { clampPriority, pickNextIndex } from '../src/mcp/jobs'
import { isJsonRpcFrame, protectStdout } from '../src/mcp/stdout'
import sharp from 'sharp'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const FFMPEG = resolve(REPO, 'node_modules/ffmpeg-static/ffmpeg.exe')
const TMP = resolve(REPO, 'scripts/.tmp-mcp-e2e')

/* ------------------------------------------------------- 子进程计数（第 8 节用） */

/**
 * 子进程计数器。第 8 节「关掉自检时一个额外子进程都不起」用的就是它。
 *
 * **为什么必须自己数**：一次 ffmpeg 探测（`-i` 只读文件头）约 30ms，而从进程外看，
 * `tasklist` 起一次就要 200ms —— 按采样判「有没有起过引擎」必然漏，而这一节要的判据
 * 是精确的 **0 与 2**，不是「大概没起」。所以计数点在 `spawn` 本身。
 *
 * **装法是替掉 `require('child_process').spawn` 这个属性**：tsx 把 `import { spawn }
 * from 'child_process'` 落成一次属性读取，所以替掉属性对**已经加载**的模块同样生效
 * （`test-mcp-view.ts` 用同一手法替掉了 `Module._load`）。**不能**用
 * `import * as cp`——那层命名空间对象是拷贝，改它改不到真的模块。
 *
 * ⚠️ 它只在 `countingSpawns` 为真时计数，**从不改变行为**（原样转发给真的 spawn），
 * 所以本套件自己起的那些进程（server 子进程、ffmpeg）一律不受影响。
 */
type SpawnLike = (
  command: string,
  args?: readonly string[],
  options?: Record<string, unknown>
) => unknown

const childProcessModule = Module.createRequire(import.meta.url)('child_process') as {
  spawn: SpawnLike
}
const realSpawn = childProcessModule.spawn
let countingSpawns = false
let spawnedCount = 0
const spawnedWhat: string[] = []

childProcessModule.spawn = (command, args, options) => {
  if (countingSpawns) {
    spawnedCount += 1
    // 记**可执行文件名**而不是整条命令行：出问题时一眼看出起的是谁（ffmpeg? 7z?），
    // 而命令行里那些用户路径对读日志的人是噪声。
    spawnedWhat.push(command.replace(/\\/g, '/').split('/').pop() ?? command)
  }
  return realSpawn(command, args, options)
}

/** 数一段代码里起了几个子进程。**必须成对使用**，且中间不许再嵌套别的计数块。 */
async function countSpawns<T>(
  body: () => Promise<T>
): Promise<{ result: T; count: number; what: string[] }> {
  countingSpawns = true
  spawnedCount = 0
  spawnedWhat.length = 0
  try {
    const result = await body()
    return { result, count: spawnedCount, what: [...spawnedWhat] }
  } finally {
    countingSpawns = false
  }
}

/* ------------------------------------------------------------------ 断言骨架 */

let passed = 0
const failures: string[] = []

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    passed += 1
    console.log(`  ✓ ${name}${detail === '' ? '' : `  ← ${detail}`}`)
  } else {
    failures.push(name)
    console.log(`  ✗ ${name}  ← ${detail}`)
  }
}

/* ---------------------------------------------------------------- 会话客户端 */

interface RpcMessage {
  jsonrpc: string
  id?: number | string
  method?: string
  params?: Record<string, unknown>
  result?: Record<string, unknown>
  error?: { code: number; message: string }
}

/** 工具调用结果。`isError` 为真时 `text` 就是我们写给 agent 的那句话。 */
interface ToolResult {
  isError: boolean
  text: string
  structured: Record<string, unknown>
  /**
   * R20 的产物缩略图。**单独收出来，不混进 `text`**——它本来就不是文字，
   * 而且它**允许缺席**（默认关、非图片产物、做不出来，三种情况都不给）。
   */
  images: { data: string; mimeType: string }[]
  /**
   * `content` 数组里每一块的 `type`，**按原序**。
   *
   * R20 有一条断言是「文字块一定在**第一块**」（客户端会静默丢掉 image block，
   * 所以文字必须自足）。只看 `images.length` 是断不出顺序的。
   */
  blockTypes: string[]
}

function toToolResult(result: Record<string, unknown>): ToolResult {
  const content = (result.content ?? []) as {
    type: string
    text?: string
    data?: string
    mimeType?: string
  }[]
  const text = content.map((c) => c.text ?? '').join('\n')
  return {
    isError: result.isError === true,
    text,
    structured: (result.structuredContent ?? {}) as Record<string, unknown>,
    images: content
      .filter((c) => c.type === 'image' && typeof c.data === 'string')
      .map((c) => ({ data: c.data as string, mimeType: c.mimeType ?? '' })),
    blockTypes: content.map((c) => c.type)
  }
}

/**
 * 从失败文案里取出 hint。
 *
 * 失败结果走的**只有 text**（MCP 里 structuredContent 属于成功结果），所以
 * `fail()` 那侧是把 hint 序列化进文案的，测试要拿它就得从文案里捞回来。
 */
function hintOf(text: string): Record<string, unknown> {
  const at = text.indexOf('{')
  if (at < 0) return {}
  try {
    return JSON.parse(text.slice(at)) as Record<string, unknown>
  } catch {
    return {}
  }
}

class Session {
  /** 收到的**每一行**原文。协议纯净性最终就是拿它来判的。 */
  readonly lines: string[] = []
  readonly notifications: RpcMessage[] = []
  stderrText = ''
  exitCode: number | null = null

  private buffer = ''
  private seq = 0
  private readonly waiting = new Map<number, (message: RpcMessage) => void>()

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')

    child.stdout.on('data', (chunk: string) => this.onStdout(chunk))
    child.stderr.on('data', (chunk: string) => {
      this.stderrText += chunk
    })
    child.on('exit', (code) => {
      this.exitCode = code
      for (const [, resolve] of this.waiting) {
        resolve({ jsonrpc: '2.0', error: { code: -1, message: '服务端进程退出了' } })
      }
      this.waiting.clear()
    })
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk
    let index = this.buffer.indexOf('\n')
    while (index >= 0) {
      const line = this.buffer.slice(0, index).trim()
      this.buffer = this.buffer.slice(index + 1)
      if (line !== '') this.ingest(line)
      index = this.buffer.indexOf('\n')
    }
  }

  private ingest(line: string): void {
    this.lines.push(line)
    // **不 try/catch**：stdout 上出现解析不了的东西是本套件最想抓的失败，
    // 让它直接抛出去，比在断言里补一句「请检查协议纯净」更早、更准。
    const message = JSON.parse(line) as RpcMessage
    if (typeof message.id === 'number') {
      const resolve = this.waiting.get(message.id)
      if (resolve !== undefined) {
        this.waiting.delete(message.id)
        resolve(message)
      }
      return
    }
    this.notifications.push(message)
  }

  private send(message: Record<string, unknown>): void {
    this.child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  private request(method: string, params: Record<string, unknown> = {}): Promise<RpcMessage> {
    this.seq += 1
    const id = this.seq
    return new Promise<RpcMessage>((resolveMessage) => {
      this.waiting.set(id, resolveMessage)
      this.send({ jsonrpc: '2.0', id, method, params })
    })
  }

  async call(
    method: string,
    params: Record<string, unknown> = {}
  ): Promise<Record<string, unknown>> {
    const message = await this.request(method, params)
    if (message.error !== undefined)
      throw new Error(`${message.error.code}: ${message.error.message}`)
    return message.result ?? {}
  }

  /** 调一个工具。**把 `isError` 原样带出来**，不在这里抛——它是被测行为本身。 */
  async callTool(
    name: string,
    args: Record<string, unknown>,
    meta: Record<string, unknown> = {}
  ): Promise<ToolResult> {
    return toToolResult(await this.call('tools/call', { name, arguments: args, _meta: meta }))
  }

  /**
   * 发出去**不当场等**的工具调用。
   *
   * `convert_file` 是阻塞到转完的，要测「中途取消」就必须先把请求发出去、再回头取消它。
   */
  callToolRaw(
    name: string,
    args: Record<string, unknown>,
    meta: Record<string, unknown> = {}
  ): { id: number; result: Promise<ToolResult>; settled: () => boolean } {
    this.seq += 1
    const id = this.seq
    // 回话**没来**是一种要被断言的结果（取消之后就是如此），所以得能问「它到了没有」。
    // 只看 `result` 是分辨不出来的：一个永远不 resolve 的 promise 和一个慢一点的 promise
    // 长得一模一样，`await` 上去只会把套件挂死。
    let done = false
    const result = new Promise<ToolResult>((resolveTool) => {
      // ⚠️ 这里必须取 `message.result` 再进 `toToolResult`：`message` 是**整帧**
      // （`{jsonrpc, id, result:{content, isError}}`），而 `isError` 与 `content`
      // 都在 `result` 里面。早先这行传的是整帧，于是 `toToolResult` 读到的
      // `content`/`isError` 全是 undefined——`isError` 恒为 false、text 恒为空串，
      // 而这条路上一直只有 `settled()` 被用过（第 27 条），所以从没被人发现。
      // 2026-09-13 加第 29c 条（要读 `code`）时当场现形：它拿到的是一个「空结果」。
      this.waiting.set(id, (message) => {
        done = true
        resolveTool(toToolResult((message.result ?? {}) as Record<string, unknown>))
      })
      this.send({
        jsonrpc: '2.0',
        id,
        method: 'tools/call',
        params: { name, arguments: args, _meta: meta }
      })
    })
    return { id, result, settled: () => done }
  }

  /**
   * 客户端侧取消，**MCP 的标准机制**：`notifications/cancelled` + 被取消请求的 id。
   *
   * 它与 `cancel_job` 工具是两套东西，落点也不同：`cancel_job` 要 agent 先知道 job_id，
   * 这条路是「调用还挂在那儿、直接把它掐了」。agent 两种都会用，所以两种都要测。
   */
  cancelRequest(requestId: number, reason: string): void {
    this.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId, reason } })
  }

  async close(): Promise<void> {
    this.child.stdin.end()
    await new Promise((r) => setTimeout(r, 900))
    if (this.exitCode === null) this.child.kill()
  }
}

/** 起一个 server 子进程。`tsx` 走 `--import`，不碰 `npx.cmd`（Node 24 上会 EINVAL）。 */
function startServer(env: Record<string, string>): Session {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/mcp/main.ts'], {
    cwd: REPO,
    env: {
      ...process.env,
      TSX_TSCONFIG_PATH: 'tsconfig.node.json',
      ...env
    },
    windowsHide: true
  }) as ChildProcessWithoutNullStreams
  return new Session(child)
}

/** 等子进程把「已就绪」打到 stderr 上——比 sleep 一个魔数可靠。 */
async function waitReady(session: Session, timeoutMs = 15000): Promise<boolean> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (session.stderrText.includes('已就绪')) return true
    await sleep(50)
  }
  return false
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * 系统临时目录里还剩几个 `arbiter-read-*`。
 *
 * 那正是 `read_document` 干活时落中间产物的地方（`readDocument.ts` 的 `TEMP_PREFIX`）。
 * 数的是**增量**而不是「有没有」：本机别处可能正好也在跑测试。
 * 取不到时返回 -1，调用方必须把它当成「这条断言不成立」而不是「0 个残留」。
 */
/**
 * `list_jobs` 的**全局计数在 `counts` 里**（不是顶层：顶层是 matching / truncated / jobs）。
 * 取不到时返回 -1——断言拿它做比较，于是返回形状坏掉时是**红**而不是恒真
 * （本仓库抓到过四条「在空集合/undefined 上恒真」的装饰性断言）。
 */
async function totalJobs(session: Session): Promise<number> {
  const listed = await session.callTool('list_jobs', {})
  const counts = (listed.structured.counts ?? {}) as Record<string, number>
  return counts.total ?? -1
}

function countReadTempDirs(): number {
  try {
    return readdirSync(tmpdir()).filter((name) => name.startsWith('arbiter-read-')).length
  } catch {
    return -1
  }
}

/* -------------------------------------------------------------------- 工具 */

function runFfmpeg(args: string[], label: string): void {
  const result = spawnSync(FFMPEG, args, { windowsHide: true, encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(`${label} 失败（${result.status}）：${(result.stderr ?? '').slice(-400)}`)
  }
}

/**
 * 用一个假 id 换回**已经登记过的 job 清单**。
 *
 * 这是 `convert_file` 不给 job_id 时，从公开接口里找出「刚那个 job」的唯一办法
 * （见第 27 条的说明：客户端取消之后连回话都没有，更别说 id 了）。
 */
async function knownJobIds(session: Session): Promise<string[]> {
  const bogus = await session.callTool('get_job_status', { job_id: 'not-a-real-id' })
  return (hintOf(bogus.text).known_job_ids ?? []) as string[]
}

/** 当前机器上有几个 ffmpeg.exe 在跑。取差值判「取消有没有留下孤儿」。 */
function countFfmpegProcesses(): number {
  const result = spawnSync('tasklist', ['/FI', 'IMAGENAME eq ffmpeg.exe', '/NH'], {
    windowsHide: true,
    encoding: 'utf8'
  })
  return (result.stdout ?? '').split(/\r?\n/).filter((l) => /ffmpeg\.exe/i.test(l)).length
}

/* ============================================================ 第 1 节：闸门 */

function section1StdoutGuard(): void {
  console.log('\n[1] stdout 闸门（进程内单测 + 自证）')

  // 判据本身。**第 2 条是防空转的关键**：如果判据写成「是不是合法 JSON」，
  // 它会把 `{"foo":1}` 这种同样是坏帧的东西放过去。
  check('1  合法 JSON-RPC 帧 → 放行', isJsonRpcFrame('{"jsonrpc":"2.0","id":1}'))
  check('2  合法 JSON 但没有 jsonrpc 字段 → 拦下', !isJsonRpcFrame('{"foo":1}'))
  check('3  裸文本 → 拦下', !isJsonRpcFrame('hello from a stray console.log'))
  check('4  空行 → 放行（空行不是帧，也不破坏协议）', isJsonRpcFrame('   '))

  // 自证：把保护装好，然后**真写**两样东西进去，看它分别怎么处理。
  const realOut = process.stdout.write
  const realErr = process.stderr.write
  const forwarded: string[] = []
  const screamed: string[] = []

  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    forwarded.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
    return true
  }) as typeof process.stdout.write
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    screamed.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
    return true
  }) as typeof process.stderr.write

  try {
    protectStdout()

    console.log('一行本该去 stderr 的日志')
    check(
      '5  console.log 被改道 stderr（不进 stdout）',
      screamed.some((s) => s.includes('本该去 stderr')) && forwarded.length === 0,
      `stderr 命中=${screamed.some((s) => s.includes('本该去 stderr'))} stdout 转发=${forwarded.length} 段`
    )

    process.stdout.write('这行不是 JSON-RPC，本会破坏协议\n')
    check(
      '6  裸文本被拦下 + stderr 有拦截记录（自证：闸门是活的）',
      forwarded.join('') === '' && screamed.some((s) => s.includes('拦下')),
      `转发=${forwarded.length} 段，拦截告警=${screamed.filter((s) => s.includes('拦下')).length} 条`
    )

    const frame = '{"jsonrpc":"2.0","id":7,"result":{}}'
    process.stdout.write(`${frame}\n`)
    check(
      '7  合法帧原样转发（不误杀）',
      forwarded.join('') === `${frame}\n`,
      `收到 ${JSON.stringify(forwarded.join(''))}`
    )

    // 分片：SDK 内部写大消息时可能分两次 write，按行缓冲才接得住。
    forwarded.length = 0
    process.stdout.write('{"jsonrpc":"2.0","id":8,')
    const midway = forwarded.join('')
    process.stdout.write('"result":{"ok":true}}\n')
    const joined = forwarded.join('')
    check(
      '8  同一个帧分两次写入 → 拼起来后才放行一次',
      midway === '' && joined === '{"jsonrpc":"2.0","id":8,"result":{"ok":true}}\n',
      `第一次转发=${JSON.stringify(midway)} 合并后=${JSON.stringify(joined)}`
    )
  } finally {
    process.stdout.write = realOut
    process.stderr.write = realErr
  }

  check(
    '9  单测跑完把 stdout/stderr 还原回去了',
    process.stdout.write === realOut,
    `一致=${process.stdout.write === realOut}`
  )
}

/* ===================================================== 第 2 节：主线端到端 */

async function section2Session(tmp: string): Promise<void> {
  console.log('\n[2] 主线会话（真子进程 + JSON-RPC）')

  const src = join(tmp, 'src')
  const out = join(tmp, 'out')
  mkdirSync(src, { recursive: true })
  mkdirSync(out, { recursive: true })
  mkdirSync(join(tmp, 'userdata'), { recursive: true })

  // 素材一律用 ffmpeg 现造：内容是次要的，**解码器行为**才是（见 fixtures/README）。
  // 用 ffmpeg 造、用我们自己的代码读，就不存在「自己验自己」。
  const png = join(src, 'sample.png')
  const mp4 = join(src, 'clip.mp4')
  runFfmpeg(['-y', '-f', 'lavfi', '-i', 'color=c=red:s=64x48:d=1', '-frames:v', '1', png], '造 PNG')
  runFfmpeg(
    [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc=size=160x120:rate=15',
      '-t',
      '1',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      mp4
    ],
    '造 MP4'
  )

  const session = startServer({
    ARBITER_USER_DATA: join(tmp, 'userdata'),
    ARBITER_DOWNLOADS: tmp,
    // 写根**收窄**到临时目录：于是「仓库根」成了一个合法的读根、但不是写根，
    // 第 12 条那条断言就是拿它来分辨「读得」和「写得」的（两者必须是两回事）。
    ARBITER_MCP_WRITE_ROOTS: tmp,
    ARBITER_MCP_CONCURRENCY: '1'
  })

  const ready = await waitReady(session)
  check(
    '1  子进程起来了并把「已就绪」打到 stderr 上',
    ready,
    `stderr 前 200 字：${session.stderrText.slice(0, 200)}`
  )

  try {
    const info = (await session.call('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'arbiter-test', version: '0' }
    })) as { serverInfo?: { name?: string; version?: string } }
    check(
      '2  initialize 回的是 arbiter',
      info.serverInfo?.name === 'arbiter' && typeof info.serverInfo.version === 'string',
      `serverInfo=${JSON.stringify(info.serverInfo)}`
    )

    /* ------------------------------------------------------------ 工具清单 */
    const tools = (await session.call('tools/list')) as {
      tools?: { name: string; description?: string; inputSchema?: Record<string, unknown> }[]
    }
    const names = (tools.tools ?? []).map((t) => t.name).sort()
    const expected = [
      'batch_convert',
      'cancel_job',
      'convert_file',
      'get_job_status',
      'inspect_file',
      'list_jobs',
      'list_supported_formats',
      'read_document'
    ]
    check(
      '3  八个工具一个不少（含后加的 list_jobs 与 read_document）',
      JSON.stringify(names) === JSON.stringify(expected),
      `实际=${JSON.stringify(names)}`
    )
    const described = (tools.tools ?? []).every(
      (t) =>
        typeof t.description === 'string' &&
        t.description.length > 10 &&
        t.inputSchema?.type === 'object'
    )
    check('4  每个工具都有够用的 description 与 object 型 inputSchema', described)

    /* ------------------------------------------------------------- resource */
    const resources = (await session.call('resources/list')) as { resources?: { uri: string }[] }
    check(
      '5  resources/list 里有 converter://formats',
      (resources.resources ?? []).some((r) => r.uri === 'converter://formats'),
      `实际=${JSON.stringify((resources.resources ?? []).map((r) => r.uri))}`
    )
    const read = (await session.call('resources/read', { uri: 'converter://formats' })) as {
      contents?: { text?: string }[]
    }
    const markdown = read.contents?.[0]?.text ?? ''
    check(
      '6  resource 读出来是一张真表（含「视频」与「mp4」）',
      markdown.includes('视频') && markdown.includes('mp4') && markdown.length > 1000,
      `长度=${markdown.length}`
    )

    /* -------------------------------------------------- list_supported_formats */
    const all = await session.callTool('list_supported_formats', {})
    const categories = (all.structured.results ?? []) as { category: string; sources: unknown[] }[]
    check(
      '7  不带 category 返回全部六类，且结构化那一侧也在（数组被包成了 {results}）',
      categories.length === 6 &&
        categories.every((c) => Array.isArray(c.sources) && c.sources.length > 0),
      `类别=${JSON.stringify(categories.map((c) => c.category))}`
    )
    const videoOnly = await session.callTool('list_supported_formats', { category: 'video' })
    const only = (videoOnly.structured.results ?? []) as { category: string }[]
    check(
      '8  带 category 只返回那一类',
      only.length === 1 && only[0]?.category === 'video',
      `实际=${JSON.stringify(only.map((c) => c.category))}`
    )

    /* ------------------------------------------------------------ inspect_file */
    const inspected = await session.callTool('inspect_file', { path: mp4 })
    const probe = (inspected.structured.probe ?? {}) as Record<string, unknown>
    check(
      '9  inspect_file 认出 mp4 的分辨率与编码（逐字）',
      inspected.isError === false &&
        probe.width === 160 &&
        probe.height === 120 &&
        probe.videoCodec === 'h264',
      `probe=${JSON.stringify(probe).slice(0, 200)}`
    )

    // 闸门：拿一个**确实存在**的文件去撞。防空转——文件不存在也会被拒，
    // 那样就分不清「被闸门挡了」和「压根没这个文件」。
    const outside = 'C:\\Windows\\win.ini'
    check('10 control：闸门外那个文件确实存在（否则下一条是空转）', existsSync(outside), outside)
    const blocked = await session.callTool('inspect_file', { path: outside })
    check(
      '11 读根之外的路径被闸门拒掉',
      blocked.isError && blocked.text.includes('允许'),
      `isError=${blocked.isError} text=${blocked.text.slice(0, 160)}`
    )

    /* ------------------------------------------------------------ convert_file */
    const jpgOut = join(out, 'converted.jpg')
    const converted = await session.callTool('convert_file', {
      source: png,
      target_format: 'jpg',
      output_path: jpgOut
    })
    const head = existsSync(jpgOut) ? readFileSync(jpgOut).subarray(0, 2) : Buffer.alloc(0)
    check(
      '12 convert_file 真转出 JPEG：状态 done + 产物存在 + 魔数 FF D8',
      converted.isError === false &&
        converted.structured.status === 'done' &&
        head[0] === 0xff &&
        head[1] === 0xd8,
      `status=${String(converted.structured.status)} 大小=${existsSync(jpgOut) ? statSync(jpgOut).size : 'n/a'} 魔数=${head.toString('hex')}`
    )
    check(
      '13 产物落在指定的 output_path 上（而不是源文件旁边）',
      existsSync(jpgOut) && !existsSync(join(src, 'converted.jpg')),
      `指定处=${existsSync(jpgOut)} 源目录=${existsSync(join(src, 'converted.jpg'))}`
    )

    // 不给 output_path → 落源文件旁边（写根收窄到 tmp，源就在 tmp 里，合法）。
    const beside = await session.callTool('convert_file', { source: png, target_format: 'jpg' })
    check(
      '14 不给 output_path 时产物落在源文件旁边',
      beside.isError === false && existsSync(join(src, 'sample.jpg')),
      `status=${String(beside.structured.status)} output=${String(beside.structured.output)}`
    )

    // 读根 ≠ 写根。仓库根是合法读根（cwd），但不在 ARBITER_MCP_WRITE_ROOTS 里。
    //
    // ⚠️ 这个文件名**必须由测试自己保证干净**：这条断言一旦翻红，就意味着闸门真的放行了，
    // 产物**会被写出来**——那正是它要测的东西。可留着的那个文件会让**下一轮**的同一条断言
    // 无条件翻红（`!existsSync` 那一半恒假），于是在反证里表现为「后面每个变异都顺带把 15 带红」，
    // 而根因是残留、不是变异。第一轮 `falsify:mcp` 就是这么被带偏的，所以前后各清一次。
    const escapePath = join(REPO, 'scripts', 'escape.jpg')
    rmSync(escapePath, { force: true })
    const escape = await session.callTool('convert_file', {
      source: png,
      target_format: 'jpg',
      output_path: escapePath
    })
    const escaped = existsSync(escapePath)
    check(
      '15 写到写根之外被拒（读根不等于写根）',
      escape.isError && !escaped,
      `isError=${escape.isError} 产物被写出来=${escaped} text=${escape.text.slice(0, 140)}`
    )
    // 断言看过现场之后再收干净（`escaped` 已经取下来了，不靠文件是否还在）。
    rmSync(escapePath, { force: true })

    const illegal = await session.callTool('convert_file', { source: png, target_format: 'docx' })
    check(
      '16 非法目标格式被拒，且 hint 里带合法目标清单（agent 能自己改对）',
      illegal.isError && illegal.text.includes('targets'),
      `text=${illegal.text.slice(0, 200)}`
    )

    // mode=remux：把 h264 的 mp4 重封装进 webm。容器装不下这个编解码器，引擎在白探一次
    // 之后必须**明确拒绝**，而不是悄悄回退成重新编码——agent 要的是「秒完、无损」，
    // 不是「等两分钟」。这条同时证明 `mode` 一路传到了 ffmpegRun 的判据（只到 jobs.ts
    // 就丢掉的话，这里会返回 done）。
    // 素材必须是视频：mode 只对音视频那条路有意义，图片走 sharp，参数到不了那里。
    const remuxMismatch = await session.callTool('convert_file', {
      source: mp4,
      target_format: 'webm',
      output_path: join(out, 'remux.webm'),
      mode: 'remux'
    })
    check(
      '17 mode=remux 遇到装不下的容器被明确拒绝（说明 mode 传到了 ffmpegRun 的判据）',
      remuxMismatch.isError && remuxMismatch.text.includes('重封装'),
      `text=${remuxMismatch.text.slice(0, 240)}`
    )

    /* ---------------------------------------------------------- get_job_status */
    const known = await session.callTool('get_job_status', { job_id: 'not-a-real-id' })
    const knownIds = await knownJobIds(session)
    check(
      '18 未知 job_id 被拒，且带出已经登记过的 id 清单',
      known.isError && knownIds.length > 0,
      `清单条数=${knownIds.length} text 前 100 字=${known.text.slice(0, 100)}`
    )

    /* ----------------------------------------------------------- batch_convert */
    const badSource = join(src, 'nope.xyz')
    writeFileSync(badSource, 'this extension is not in the matrix')
    // 第二个好素材必须是**真能转成 jpg** 的。拿 mp4 当「好素材」会让这条断言实际测的是
    // 「矩阵拒了 mp4→jpg」——上坏下也坏，看着红了却红错了原因。
    const png2 = join(src, 'second.png')
    runFfmpeg(
      ['-y', '-f', 'lavfi', '-i', 'color=c=blue:s=32x32:d=1', '-frames:v', '1', png2],
      '造第二张 PNG'
    )
    const batch = await session.callTool('batch_convert', {
      sources: [png, png2, badSource],
      target_format: 'jpg',
      output_dir: out
    })
    const submitted = (batch.structured.submitted ?? []) as unknown[]
    const rejected = (batch.structured.rejected ?? []) as unknown[]
    check(
      '19 批量里一个坏的不影响其余：2 入队 / 1 被拒',
      submitted.length === 2 && rejected.length === 1,
      `submitted=${submitted.length} rejected=${rejected.length}`
    )
    const unfinished: string[] = []
    for (const entry of submitted as { job_id: string }[]) {
      let status = (await session.callTool('get_job_status', { job_id: entry.job_id })).structured
      // batch_convert 立刻返回，所以这里必然要等——轮询到终态为止。
      // （只查一次的话，转得快的小文件也大概率还在 running，那是假红。）
      for (
        let i = 0;
        i < 50 && (status.status === 'queued' || status.status === 'running');
        i += 1
      ) {
        await sleep(200)
        status = (await session.callTool('get_job_status', { job_id: entry.job_id })).structured
      }
      if (status.status !== 'done') {
        unfinished.push(`${entry.job_id.slice(0, 8)}=${String(status.status)}`)
      }
    }
    // 被拒的条目要与错误出口**同一套**机器可读字段：agent 只看 rejected 数组就该知道
    // 每一条怎么修（这是第 16 条那句「最值钱的错误文案」在批量这条路上的推广——
    // 批量里被拒的往往不止一条，逐条去试错的代价是十几次工具调用）。
    const rejectedEntry = ((batch.structured.rejected ?? []) as Record<string, unknown>[])[0] ?? {}
    check(
      '19a 被拒的条目带 code=unknown_format + retryable + next_steps（与错误出口同一套）',
      rejectedEntry.code === 'unknown_format' &&
        rejectedEntry.retryable === false &&
        Array.isArray(rejectedEntry.next_steps) &&
        (rejectedEntry.next_steps as string[]).length > 0,
      `rejected[0]=${JSON.stringify(rejectedEntry).slice(0, 220)}`
    )
    check(
      '19b 批量入队的那些最终全都 done',
      submitted.length === 2 && unfinished.length === 0,
      `核对了 ${submitted.length} 个，未完成：${JSON.stringify(unfinished)}`
    )
    check(
      '19c 每条 submitted 都回显了实际用到的 from / to（agent 照它报格式，不许自己猜）',
      submitted.length === 2 &&
        (submitted as { from?: string; to?: string }[]).every(
          (entry) => entry.from === 'png' && entry.to === 'jpg'
        ),
      `实际=${JSON.stringify(submitted)}`
    )

    /* ------------------------------- 失败：机器可读的码 + log_tail 缺一不可 */
    //
    // 一个**内容不是 MP4** 的 .mp4：扩展名过关（矩阵里有这条组合），倒在引擎那一关。
    // 这是 `source_corrupt` 唯一的真实来源——不许靠读引擎的中文报错去分类
    // （约束 23 第 3 条），所以判据只能落在「引擎非零退出」这个我们自己的分支上。
    const corrupt = join(src, 'broken.mp4')
    writeFileSync(corrupt, Buffer.from('this is not an mp4 container, not even close\n'.repeat(64)))
    const brokenRun = await session.callTool('convert_file', {
      source: corrupt,
      target_format: 'mkv',
      output_path: join(out, 'broken.mkv')
    })
    const brokenBody = hintOf(brokenRun.text)
    check(
      '19d 引擎失败 → code=source_corrupt + retryable=false + next_steps',
      brokenRun.isError &&
        brokenBody.code === 'source_corrupt' &&
        brokenBody.retryable === false &&
        Array.isArray(brokenBody.next_steps) &&
        (brokenBody.next_steps as string[]).length > 0,
      `code=${String(brokenBody.code)} retryable=${String(brokenBody.retryable)} text=${brokenRun.text.slice(0, 160)}`
    )
    check(
      '19e 失败结果里 log_tail 一个字都没少（码是加在它上面的一层，不是替掉它）',
      Array.isArray(brokenBody.log_tail) && (brokenBody.log_tail as string[]).length > 0,
      `log_tail=${JSON.stringify(brokenBody.log_tail).slice(0, 200)}`
    )
    // 码不是只挂在引擎那条路上：闸门（第 11 条）与能力矩阵（第 16 条）那两种失败
    // 也必须带同一套三项。**这两条是现成的失败结果**（前面几轮已经跑过），
    // 所以这里是在回头核一遍形状，而不是新造一个失败——「同一个服务端在不同失败上
    // 给出不同形状」是 agent 最容易踩空的一类不一致。
    const gateBody = hintOf(blocked.text)
    const illegalBody = hintOf(illegal.text)
    check(
      '19f 闸门失败与矩阵失败也带同一套三项（path_not_allowed / target_not_supported，都是不可重试）',
      gateBody.code === 'path_not_allowed' &&
        gateBody.retryable === false &&
        Array.isArray(gateBody.next_steps) &&
        illegalBody.code === 'target_not_supported' &&
        illegalBody.retryable === false &&
        Array.isArray(illegalBody.next_steps),
      `闸门=${JSON.stringify({ code: gateBody.code, retryable: gateBody.retryable })} 矩阵=${JSON.stringify({ code: illegalBody.code, retryable: illegalBody.retryable })}`
    )

    /* ------------------------- output_path 指向一个已存在的目录 → 当场拒 */
    //
    // 不拒的话 `resolveOutputPath` 会把名字改成「目录名 (1).jpg」写到**上一级目录**去：
    // 退出码 0、status: done、一个 agent 从没要过的产物路径。这才是要防的东西，
    // 所以下面那条断言特意查了「没有那个 (1) 产物」。
    const takenDir = join(out, 'taken.jpg')
    mkdirSync(takenDir, { recursive: true })
    const conflict = await session.callTool('convert_file', {
      source: png,
      target_format: 'jpg',
      output_path: takenDir
    })
    const conflictBody = hintOf(conflict.text)
    check(
      '19g output_path 给成一个已存在的目录 → output_conflict，且没有静默写出「taken (1).jpg」',
      conflict.isError &&
        conflictBody.code === 'output_conflict' &&
        existsSync(takenDir) &&
        statSync(takenDir).isDirectory() &&
        !existsSync(join(out, 'taken (1).jpg')),
      `code=${String(conflictBody.code)} 目录还在=${existsSync(takenDir)} (1)产物=${existsSync(join(out, 'taken (1).jpg'))}`
    )

    /* ------------------------------------------------------------ list_jobs */
    const listed = await session.callTool('list_jobs', {})
    const listedJobs = (listed.structured.jobs ?? []) as Record<string, unknown>[]
    const counts = (listed.structured.counts ?? {}) as Record<string, number>
    const summed = ['queued', 'running', 'done', 'failed', 'canceled'].reduce(
      (sum, key) => sum + (counts[key] ?? 0),
      0
    )
    check(
      '19h list_jobs 不带参数：counts 各项之和 = total > 0，且 jobs 非空',
      counts.total === summed &&
        counts.total > 0 &&
        listedJobs.length > 0 &&
        listed.structured.truncated === false,
      `counts=${JSON.stringify(counts)} jobs=${listedJobs.length} truncated=${String(listed.structured.truncated)}`
    )
    check(
      '19i list_jobs 的每一条只给概要：有 job_id/status/to/output，**没有 log_tail**',
      listedJobs.length > 0 &&
        listedJobs.every(
          (job) =>
            typeof job.job_id === 'string' &&
            typeof job.status === 'string' &&
            typeof job.to === 'string' &&
            typeof job.output === 'string' &&
            job.log_tail === undefined
        ),
      `第一条=${JSON.stringify(listedJobs[0])}`
    )
    const failedList = await session.callTool('list_jobs', { status: 'failed' })
    const failedJobs = (failedList.structured.jobs ?? []) as Record<string, unknown>[]
    check(
      '19j status:"failed" 只回失败的，且确实筛掉了别的（防空转：total 比它大）',
      failedJobs.length > 0 &&
        failedJobs.every((job) => job.status === 'failed') &&
        failedJobs.length < counts.total,
      `失败 ${failedJobs.length} 条 / 共 ${counts.total} 条`
    )
    check(
      '19k 列表里失败的那些带 error_code（与 get_job_status 同一套码）',
      failedJobs.length > 0 && failedJobs.every((job) => job.error_code === 'source_corrupt'),
      JSON.stringify(failedJobs.map((job) => job.error_code))
    )
    // 对照：同一个 job 走单条查询**有** log_tail。少了它，上面第 25 条在
    // 「压根没有任何 job 失败过」时也照样绿（在空集合上恒真的否定断言）。
    const oneFailed = await session.callTool('get_job_status', {
      job_id: String(failedJobs[0]?.job_id ?? '')
    })
    check(
      '19l 同一个 job 走 get_job_status：有 log_tail，且有完整的 error_code/retryable/next_steps',
      Array.isArray(oneFailed.structured.log_tail) &&
        (oneFailed.structured.log_tail as string[]).length > 0 &&
        oneFailed.structured.error_code === 'source_corrupt' &&
        oneFailed.structured.retryable === false &&
        Array.isArray(oneFailed.structured.next_steps),
      `log_tail=${(oneFailed.structured.log_tail as string[] | undefined)?.length ?? 0} 行 error_code=${String(oneFailed.structured.error_code)}`
    )
    const tight = await session.callTool('list_jobs', { limit: 1 })
    check(
      '19m limit=1 真的只回 1 条，且 truncated 如实为 true（matching > 1）',
      ((tight.structured.jobs ?? []) as unknown[]).length === 1 &&
        tight.structured.truncated === true &&
        typeof tight.structured.matching === 'number' &&
        (tight.structured.matching as number) > 1,
      `jobs=${((tight.structured.jobs ?? []) as unknown[]).length} truncated=${String(tight.structured.truncated)} matching=${String(tight.structured.matching)}`
    )
    const roomy = await session.callTool('list_jobs', { limit: 200 })
    check(
      '19n limit 够大时 truncated=false，且返回条数 = matching（截断判据不是「碰了上限」）',
      roomy.structured.truncated === false &&
        ((roomy.structured.jobs ?? []) as unknown[]).length === roomy.structured.matching,
      `jobs=${((roomy.structured.jobs ?? []) as unknown[]).length} matching=${String(roomy.structured.matching)}`
    )
    const newestAt = Number(listedJobs[0]?.created_at ?? 0)
    check(
      '19o 新的在前：第一条的 created_at 不小于其余任何一条（防空转：created_at 必须是数）',
      listedJobs.length > 0 &&
        listedJobs.every((job) => typeof job.created_at === 'number') &&
        listedJobs.every((job) => Number(job.created_at) <= newestAt),
      `第一条=${String(listedJobs[0]?.created_at)} 全部=${JSON.stringify(listedJobs.map((job) => job.created_at))}`
    )
    const since = await session.callTool('list_jobs', { since: newestAt })
    const sinceJobs = (since.structured.jobs ?? []) as Record<string, unknown>[]
    check(
      '19p since 过滤生效：只回 created_at >= since 的，且确实筛掉了一些',
      sinceJobs.length > 0 &&
        sinceJobs.every((job) => Number(job.created_at) >= newestAt) &&
        sinceJobs.length < counts.total,
      `since=${newestAt} 回 ${sinceJobs.length} 条 / 共 ${counts.total} 条`
    )
    // ⚠️ 这里原有一条「此刻全都落定了，所以 status:"unfinished" 回 0 条」的断言，
    // **已删除**：那是一条装饰。`unfinished` 的别名分支（queued + running）整个删掉时，
    // 它同样回 0 条、同样不报错——断言根本不会红。别名必须在**真的有任务没落定**
    // 的时候验，所以那一条搬到了第 20b 条（并发上限 1，此刻一个在跑、一个在排队）。

    /* ------------------------------------------------------------------ 取消 */
    // 排队中取消：并发上限 1，先占住位置，再提交第二个。
    const slow = join(src, 'slow.mp4')
    // 1080p / 20 秒：转码它必然要好几秒，而我们要的是**取消发生在它还在跑的时候**。
    // （小素材会把取消落在完成之后，测的就不是取消了——见 docs/NOTES.md 测试那节。）
    runFfmpeg(
      [
        '-y',
        '-f',
        'lavfi',
        '-i',
        'testsrc=size=1920x1080:rate=30',
        '-t',
        '20',
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-pix_fmt',
        'yuv420p',
        slow
      ],
      '造慢素材'
    )

    const running = await session.callTool('batch_convert', {
      sources: [slow],
      // webm 装不下 h264，必然重新编码——正是「慢」的来源。
      target_format: 'webm',
      output_dir: out
    })
    const runningId = ((running.structured.submitted ?? [])[0] as { job_id: string }).job_id

    const ffmpegBefore = countFfmpegProcesses()
    const queued = await session.callTool('batch_convert', {
      sources: [png],
      target_format: 'jpg',
      output_dir: out
    })
    const queuedId = ((queued.structured.submitted ?? [])[0] as { job_id: string }).job_id

    const queuedNow = await session.callTool('get_job_status', { job_id: queuedId })
    check(
      '20 并发上限 1 时第二个 job 确实在排队（不是已经在跑）',
      queuedNow.structured.status === 'queued',
      `status=${String(queuedNow.structured.status)}`
    )

    // `unfinished` 是 queued|running 的**别名**（不是第六种状态）。此刻的状态是确定的：
    // `runningId` 在跑、`queuedId` 在排队——所以这一条既要求两个都在集合里
    // （删掉别名分支里任何一半都会红），又要求集合里只有这两种状态。
    const unfinishedNow = await session.callTool('list_jobs', { status: 'unfinished' })
    const unfinishedJobs = (unfinishedNow.structured.jobs ?? []) as Record<string, unknown>[]
    check(
      '20b status:"unfinished" = queued + running（在跑的与在排队的两个都在里面）',
      unfinishedJobs.length >= 2 &&
        unfinishedJobs.every((job) => job.status === 'queued' || job.status === 'running') &&
        unfinishedJobs.some((job) => job.job_id === runningId) &&
        unfinishedJobs.some((job) => job.job_id === queuedId),
      `unfinished=${JSON.stringify(unfinishedJobs.map((job) => job.status))} 含运行中=${unfinishedJobs.some((job) => job.job_id === runningId)} 含排队中=${unfinishedJobs.some((job) => job.job_id === queuedId)}`
    )
    const canceledQueued = await session.callTool('cancel_job', { job_id: queuedId })
    check(
      '21 取消排队中的 job：立刻 canceled',
      canceledQueued.isError === false && canceledQueued.structured.status === 'canceled',
      `status=${String(canceledQueued.structured.status)}`
    )

    // 运行中取消。先确认它**真的在跑**（防空转：排队中取消上面已经测过了，
    // 如果这条也是在排队，那它什么新东西都没测到）。
    const runningNow = await session.callTool('get_job_status', { job_id: runningId })
    check(
      '22 那个慢 job 此刻正在运行（否则下一条测不到「杀运行中的进程树」）',
      runningNow.structured.status === 'running',
      `status=${String(runningNow.structured.status)}`
    )

    const cancelStarted = Date.now()
    const canceledRunning = await session.callTool('cancel_job', { job_id: runningId })
    let settled: Record<string, unknown> = {}
    for (let i = 0; i < 60; i += 1) {
      const status = await session.callTool('get_job_status', { job_id: runningId })
      settled = status.structured
      if (settled.status === 'canceled') break
      await sleep(200)
    }
    const cancelMs = Date.now() - cancelStarted
    check(
      '23 取消运行中的 job → 落定为 canceled',
      settled.status === 'canceled',
      `cancel_job 返回=${String(canceledRunning.structured.status)} 落定=${String(settled.status)} 耗时=${cancelMs}ms`
    )

    const slowOut = join(out, 'slow.webm')
    const leftovers = existsSync(out) ? readdirSync(out).filter((n) => n.includes('slow')) : []
    check(
      '24 取消之后没有产物、也没有 .part 残渣',
      !existsSync(slowOut) && leftovers.length === 0,
      `产物=${existsSync(slowOut)} 该目录下 slow*=${JSON.stringify(leftovers)}`
    )

    // 孤儿进程（约束 3）。取差值：并行线上可能有别人在跑 ffmpeg，
    // 所以只断言「没有**增加**」，并把这个前提写进失败信息里。
    await sleep(1500)
    const ffmpegAfter = countFfmpegProcesses()
    check(
      '25 取消之后没有留下孤儿 ffmpeg',
      ffmpegAfter <= ffmpegBefore,
      `取消前=${ffmpegBefore} 取消后=${ffmpegAfter}（若 > 且此时并行线在跑 ffmpeg，这条会误报）`
    )

    /* ---------------------------- 客户端侧取消（MCP 标准机制）+ 进度通知 */

    // 上面两条走的是 `cancel_job` 工具；这一条走 `notifications/cancelled`——
    // 调用还挂在 `convert_file` 里时客户端唯一叫得停它的办法。
    //
    // ⚠️ **实测出来的 MCP 约定，不踩一次写不对**：客户端发过 `notifications/cancelled`
    // 之后，服务端**不会再为那个请求回话**（SDK 把那一帧压掉了——客户端已经说了不要，
    // 再来一条晚到的结果就是多余的帧）。所以这一段**绝不能 `await inFlight.result`**：
    // 那个 promise 永远不会 resolve，会把整个套件挂死在半路，而且失败信息一个都没有。
    // 代价是没有任何返回值能告诉我们那个 job 的 id，只能靠 `known_job_ids` 的**差集**找。
    const idsBeforeCancel = await knownJobIds(session)
    const inFlight = session.callToolRaw(
      'convert_file',
      { source: slow, target_format: 'webm', output_path: join(out, 'slow2.webm') },
      { progressToken: 'tok-cancel-1' }
    )
    await sleep(1200) // 让它真的跑起来、并吐出进度
    const notesBefore = session.notifications.filter((n) => n.method === 'notifications/progress')
    const orphanBefore = countFfmpegProcesses()
    session.cancelRequest(inFlight.id, '测试：客户端侧取消')
    // 4000ms 是两件事的余量：取消走完（杀进程树 + 落定为 canceled），
    // 以及一条**本不该出现**的回话若真要迟到，也早该到了。
    await sleep(4000)

    check(
      '26 convert_file 期间推过 notifications/progress，且带的是客户端给的那个 token',
      notesBefore.length > 0 &&
        notesBefore.every((n) => n.params?.progressToken === 'tok-cancel-1') &&
        notesBefore.some((n) => typeof n.params?.message === 'string'),
      `取消前进度通知 ${notesBefore.length} 条，token 集合=${JSON.stringify([
        ...new Set(notesBefore.map((n) => String(n.params?.progressToken)))
      ])}`
    )

    // 这条既是**协议约定**也是防空转：如果哪天 SDK 改成会补发一条结果，这里会翻红，
    // 提醒我们「取消之后有回话」这件事已经不能当前提用了——那时 28 条就该改成读回话。
    check(
      '27 客户端取消之后，这个请求不会再收到回话（MCP 约定：SDK 主动压掉那一帧）',
      inFlight.settled() === false,
      `已回话=${inFlight.settled()}（true 说明该改成读回话，而不是像现在这样靠差集找 job）`
    )

    // 取消**到底生没生效**，骗不了人的只有 job 的最终状态。这里用的是差集：
    // 快照之前登记的那些全不算，新出现的那个就是刚才挂掉的那个调用建的。
    const idsAfterCancel = await knownJobIds(session)
    const newIds = idsAfterCancel.filter((id) => !idsBeforeCancel.includes(id))
    const canceledJob =
      newIds.length === 1
        ? (await session.callTool('get_job_status', { job_id: newIds[0] })).structured
        : {}
    check(
      '28 那条 job 确实落定了 canceled（取消是真生效的，不只是没回话）',
      newIds.length === 1 && canceledJob.status === 'canceled',
      `新增 job=${JSON.stringify(newIds.map((id) => id.slice(0, 8)))} status=${String(canceledJob.status)}`
    )

    await sleep(1500)
    const orphanAfter = countFfmpegProcesses()
    const slow2Leftovers = existsSync(out)
      ? readdirSync(out).filter((n) => n.includes('slow2'))
      : []
    check(
      '29 客户端侧取消之后同样没有孤儿 ffmpeg、也没有产物 / .part 残渣',
      orphanAfter <= orphanBefore &&
        !existsSync(join(out, 'slow2.webm')) &&
        slow2Leftovers.length === 0,
      `取消前=${orphanBefore} 取消后=${orphanAfter} 产物=${existsSync(join(out, 'slow2.webm'))} slow2*=${JSON.stringify(slow2Leftovers)}`
    )

    /* -------------- 工具级取消：convert_file 当场拿到 canceled（不是「没回话」） -------------- */
    //
    // 上一条走的是 `notifications/cancelled`，那条路**永远不会有回话**。这一条走
    // `cancel_job`：调用没被客户端取消，所以 SDK 会正常回话——于是它是「取消」
    // 这个码唯一能在**线上**被观测到的入口，也是 `retryable: true` 唯一的线上证据
    // （另一侧的 `false` 由第 19c 条的 source_corrupt 提供，两条合起来才证明
    // `retryable` 不是常量）。
    //
    // ⚠️ 这里**必须带超时**：万一哪天回话不来了（比如有人把 cancel 的转发改成
    // 只在通知路径上生效），裸 `await` 会把整个套件挂在半路，而挂死与
    // 「断言全绿」在输出上长得一模一样（docs/NOTES.md 里点名过这个失败形态）。
    const idsBeforeToolCancel = await knownJobIds(session)
    const toolCanceledCall = session.callToolRaw('convert_file', {
      source: slow,
      target_format: 'webm',
      output_path: join(out, 'slow3.webm')
    })
    await sleep(1200) // 让它真的跑起来（排队/运行中的取消语义不同，见下）
    const toolCancelId = (await knownJobIds(session)).find(
      (id) => !idsBeforeToolCancel.includes(id)
    )
    const cancelReturned =
      toolCancelId === undefined
        ? null
        : await session.callTool('cancel_job', { job_id: toolCancelId })
    const toolCanceledResult = await Promise.race([
      toolCanceledCall.result,
      sleep(20000).then(() => null)
    ])
    const toolCancelBody = hintOf(toolCanceledResult?.text ?? '')
    check(
      '29b control：那个慢 job 确实被建起来了、并且 cancel_job 回了它的状态',
      toolCancelId !== undefined &&
        cancelReturned !== null &&
        (cancelReturned.structured.status === 'running' ||
          cancelReturned.structured.status === 'canceled'),
      `job=${String(toolCancelId).slice(0, 8)} cancel_job 返回=${String(cancelReturned?.structured.status)}`
    )
    check(
      '29c convert_file 的任务被 cancel_job 取消 → 当场返回 code=canceled 且 retryable=true（20 秒内）',
      toolCanceledResult !== null &&
        toolCanceledResult.isError &&
        toolCancelBody.code === 'canceled' &&
        toolCancelBody.retryable === true,
      toolCanceledResult === null
        ? '20 秒内没有回话——套件差一点就挂死在这里'
        : `isError=${toolCanceledResult.isError} code=${String(toolCancelBody.code)} retryable=${String(toolCancelBody.retryable)} text=${JSON.stringify(toolCanceledResult.text.slice(0, 240))} 原始帧=${(session.lines.find((line) => line.includes(`"id":${toolCanceledCall.id}`)) ?? '(没找到)').slice(0, 300)}`
    )

    /* ------------------------------------------------------------ 协议纯净性 */
    const badLines = session.lines.filter((line) => {
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>
        return typeof parsed !== 'object' || parsed === null || !('jsonrpc' in parsed)
      } catch {
        return true
      }
    })
    check(
      '30 stdout 上每一行都是合法 JSON-RPC（整场会话）',
      badLines.length === 0 && session.lines.length > 20,
      `共 ${session.lines.length} 行，坏行 ${badLines.length}：${JSON.stringify(badLines.slice(0, 3))}`
    )
    check(
      '31 stderr 里一次「拦下」都没有（说明 30 不是因为闸门吞掉了脏东西）',
      !session.stderrText.includes('拦下'),
      `拦截次数=${(session.stderrText.match(/拦下/g) ?? []).length}`
    )
  } finally {
    await session.close()
  }
}

/* ============================== 第 3 节：引擎指不到时的第二个实例 */

async function section3EngineMissing(tmp: string): Promise<void> {
  console.log('\n[3] 引擎全部指不到时的第二个实例')

  const nowhere = join(tmp, 'nowhere')
  mkdirSync(nowhere, { recursive: true })
  const src = join(tmp, 'src')
  const out = join(tmp, 'out')

  const session = startServer({
    // 把 appPath / resourcesPath 都指到一个空目录：随包引擎全都在
    // `<appPath>/resources/engines/` 下，于是就都「没有」了。
    ARBITER_APP_PATH: nowhere,
    ARBITER_RESOURCES_PATH: join(nowhere, 'resources'),
    ARBITER_USER_DATA: join(tmp, 'userdata-empty'),
    ARBITER_DOWNLOADS: nowhere,
    ARBITER_MCP_WRITE_ROOTS: tmp
  })
  mkdirSync(join(tmp, 'userdata-empty'), { recursive: true })

  const ready = await waitReady(session)
  check(
    '1  第二个实例也起来了（它照样得能启动，不能因为找不到引擎就崩）',
    ready,
    `stderr=${session.stderrText.slice(0, 200)}`
  )

  try {
    await session.call('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'arbiter-test', version: '0' }
    })

    const md = join(src, 'note.md')
    writeFileSync(md, '# 标题\n\n正文。\n')

    const pandocNeeded = await session.callTool('convert_file', {
      source: md,
      target_format: 'docx',
      output_path: join(out, 'note.docx')
    })
    check(
      '2  需要 pandoc 的转换在**排队之前**就被拒，理由点名是哪个引擎',
      pandocNeeded.isError &&
        pandocNeeded.text.includes('Pandoc') &&
        pandocNeeded.text.includes('还没装好'),
      `text=${pandocNeeded.text.slice(0, 200)}`
    )

    // 防空转：同一个实例上，不需要那个引擎的转换**照常成功**。
    // 少了这一条，「被拒」可能只是这个实例整体坏掉了，而不是引擎判据在起作用。
    const noEngineNeeded = await session.callTool('convert_file', {
      source: join(src, 'sample.png'),
      target_format: 'jpg',
      output_path: join(out, 'ok.jpg')
    })
    check(
      '3  control：同一实例上不需要引擎的转换成功（证明上一条拒的是引擎，不是实例）',
      noEngineNeeded.isError === false && existsSync(join(out, 'ok.jpg')),
      `status=${String(noEngineNeeded.structured.status)} text=${noEngineNeeded.text.slice(0, 120)}`
    )
    // 「引擎未装」是码表里唯一一类**只能在这条路上**被观测到的东西（第 2 节那个实例
    // 什么都装好了），所以它的码必须在这里钉住——否则那个码有可能只是个装饰，
    // 谁把它删掉都不会有人发现。
    const pandocBody = hintOf(pandocNeeded.text)
    /* ------------------------------- read_document 在同一个实例上同样要先拒 */

    // `.rst` 的解析要 pandoc（`shared/formats.ts` 的 `PANDOC_INSIDE_DOCUMENT`）。
    // 这条断言钉的是**不许降级**：引擎不在位时不能说「那我把 rst 源码当纯文本给你吧」——
    // 那正是本项目反复在堵的那类静默洞（产物看着像成功、内容其实是别的东西）。
    const rstPath = join(src, 'note.rst')
    writeFileSync(rstPath, '标题\n====\n\n正文。\n')
    const rstNeedsPandoc = await session.callTool('read_document', {
      source: rstPath,
      format: 'txt'
    })
    check(
      '5  read_document 读 .rst 时同样**在动手之前**拒（引擎未装不降级成「当纯文本读」）',
      rstNeedsPandoc.isError === true &&
        hintOf(rstNeedsPandoc.text).code === 'engine_missing' &&
        rstNeedsPandoc.text.includes('Pandoc'),
      `code=${String(hintOf(rstNeedsPandoc.text).code)} text=${rstNeedsPandoc.text.slice(0, 200)}`
    )
    // 防空转：同一个实例上不需要引擎的那条读取**照常成功**。少了它，「被拒」可能只是
    // 这个实例整体坏掉了，而不是引擎判据在起作用（与上面第 3 条同一个形状）。
    const plainRead = await session.callTool('read_document', { source: md, format: 'txt' })
    check(
      '6  control：同一实例上 .md 的读取照常成功（证明上一条拒的是引擎，不是实例）',
      plainRead.isError === false && String(plainRead.structured.text).includes('标题'),
      `isError=${plainRead.isError} text=${JSON.stringify(plainRead.structured.text)?.slice(0, 80)}`
    )

    check(
      '4  这条拒绝带 code=engine_missing + retryable=false + 点名的引擎（码表覆盖「引擎未装」）',
      pandocBody.code === 'engine_missing' &&
        pandocBody.retryable === false &&
        Array.isArray(pandocBody.next_steps) &&
        pandocBody.engine === 'pandoc',
      `code=${String(pandocBody.code)} retryable=${String(pandocBody.retryable)} engine=${String(pandocBody.engine)}`
    )

    // E-5（dry_run）也要照走这同一句裁决。这条**只能在这个实例上观测**：第 2 节那个
    // 实例什么都装好了，它报不出 `engine_missing`——所以「预览漏判引擎」这种错
    // 在那边是恒绿的。判据是「与真跑报的那份逐字相同」，而不只是「也被拒了」。
    const pandocDry = await session.callTool('convert_file', {
      source: md,
      target_format: 'docx',
      output_path: join(out, 'note.docx'),
      dry_run: true
    })
    check(
      '7  dry_run 在「引擎没装」这条路上与真跑报**同一个错**（逐字相同、code=engine_missing）',
      pandocDry.isError === true &&
        pandocDry.text === pandocNeeded.text &&
        hintOf(pandocDry.text).code === 'engine_missing',
      `code=${String(hintOf(pandocDry.text).code)} 逐字相同=${pandocDry.text === pandocNeeded.text}`
    )
  } finally {
    await session.close()
  }
}

/* ============================ 第 4 节：输出目录设置改变了落点 */

/**
 * 「不给 output_path 时产物落在源文件旁边」**是有条件的**。
 *
 * `jobs.ts` 刻意复用主进程的 `outputDirFor()`，所以用户在界面里设了「输出到指定目录」
 * 之后，产物会去那个目录。这个分支原先**一条断言都没有**——第 2 节那条 14 号断言跑的是
 * 「默认设置」那一支，于是「设了输出目录」这一支既没被覆盖、也没人发现工具描述写错了。
 *
 * 发现经过：2026-09-13 在真实 Claude Code 里做端到端验收，agent 照着 `convert_file` 的
 * 说明向用户报了「产物在源文件旁边」，而它实际落在设置里那个目录。**行为是对的**
 * （与 GUI 同一套规则，不该由 MCP 自作主张），错的是说明书。这里把规则钉成断言。
 */
async function section4OutputDirSettings(tmp: string): Promise<void> {
  console.log('\n[4] 输出目录设置改变了「不给 output_path」的落点')

  const ud = join(tmp, 'userdata-configured')
  const srcDir = join(tmp, 'outdir-src')
  const configured = join(tmp, 'configured-out')
  mkdirSync(ud, { recursive: true })
  mkdirSync(srcDir, { recursive: true })
  mkdirSync(configured, { recursive: true })

  // 设置是 server 那个**独立进程**读的，所以只能写文件，不能调 `updateSettings()`
  // ——那个改的是本进程的 userData，与子进程无关。
  // `defaultTargets` 是 `target_format: "auto"` 的**唯一**依据（`auto` 的语义就是
  // 「用户自己选过的偏好」，不许有任何别的推断），所以这里把它设成两档：
  //   - video: mkv   —— 合法，应当原样生效
  //   - image: docx  —— **非法**（png 没有 docx 出口），应当被能力矩阵否掉并回落。
  //     这一档是刻意设的：`resolveDefaultTarget` 的「偏好还要再过一遍 targetsFor」
  //     那一步正是 GUI 那条路上也依赖的裁决，靠它才能证明 MCP 没有另写一份逻辑。
  writeFileSync(
    join(ud, 'settings.json'),
    JSON.stringify({
      version: 1,
      outputDir: configured,
      outputBesideSource: false,
      onConflict: 'overwrite',
      maxConcurrent: 1,
      defaultTargets: { video: 'mkv', image: 'docx' },
      skipTasksNeedingDownload: false
    }),
    'utf8'
  )

  // 用**新的源文件**，不蹭第 2 节那个 `sample.png`：第 2 节的 14 号断言已经在
  // `tmp/src/` 里留下了 `sample.jpg`，复用它的话「源文件旁边有没有产物」就分不清
  // 是谁写的了。
  const png = join(srcDir, 'note.png')
  copyFileSync(join(tmp, 'src', 'sample.png'), png)

  const session = startServer({
    ARBITER_USER_DATA: ud,
    ARBITER_DOWNLOADS: tmp,
    ARBITER_MCP_WRITE_ROOTS: tmp,
    ARBITER_MCP_CONCURRENCY: '1'
  })

  const ready = await waitReady(session)
  check('1  第三个实例起来了', ready, `stderr=${session.stderrText.slice(0, 200)}`)

  try {
    await session.call('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'arbiter-test', version: '0' }
    })

    const besidePath = join(srcDir, 'note.jpg')
    const configuredPath = join(configured, 'note.jpg')

    const result = await session.callTool('convert_file', { source: png, target_format: 'jpg' })

    check(
      '2  设了输出目录时，产物落在**设置的那个目录**',
      result.isError === false && existsSync(configuredPath),
      `status=${String(result.structured.status)} output=${String(result.structured.output)}`
    )
    check(
      '3  这一支下**不再**落在源文件旁边（与第 2 节的 14 号是互补的两支）',
      !existsSync(besidePath),
      `源目录里有没有 note.jpg=${existsSync(besidePath)}`
    )
    check(
      '4  返回值里的 output 就是实际落点（agent 照它报路径就不会错）',
      result.structured.output === configuredPath,
      `output=${String(result.structured.output)} 期望=${configuredPath}`
    )

    /* ------------------------------------ target_format: "auto"（保留字） */
    //
    // 「自动」在这里的**唯一**含义是「用用户自己在设置里选过的偏好」，走的是
    // `shared/formats.ts` 现成的 `resolveDefaultTarget()`（叠偏好 + 再拿 `targetsFor` 校验）。
    // 刻意**不做**「智能猜测用途」那种事（「这段视频是发微信的所以转小一点」）——
    // 整个项目的价值主张是「不做用户没要的事」。
    //
    // 混合目录是批量转换的常态，所以要验的正是「一批里两条 job 各自解析」。
    const autoPng = join(srcDir, 'auto.png')
    const autoMp4 = join(srcDir, 'auto.mp4')
    copyFileSync(join(tmp, 'src', 'sample.png'), autoPng)
    copyFileSync(join(tmp, 'src', 'clip.mp4'), autoMp4)

    const autoBatch = await session.callTool('batch_convert', {
      sources: [autoPng, autoMp4],
      target_format: 'auto'
    })
    const autoSubmitted = (autoBatch.structured.submitted ?? []) as {
      to?: string
      output?: string
    }[]
    check(
      '5  auto：每条 job 都回显了**实际用到的** to（不是把保留字原样回显），且同一批里两条可以不同',
      autoSubmitted.length === 2 &&
        autoSubmitted.every(
          (entry) => typeof entry.to === 'string' && entry.to !== 'auto' && entry.to !== ''
        ) &&
        autoSubmitted[0]?.to !== autoSubmitted[1]?.to,
      `submitted=${JSON.stringify(autoSubmitted)}`
    )
    check(
      '6  auto 用上了用户偏好：video 偏好 mkv → mp4 源解析成 mkv（不是矩阵里的第一个）',
      autoSubmitted[1]?.to === 'mkv',
      `mp4 那条 to=${String(autoSubmitted[1]?.to)}`
    )
    check(
      '7  auto 的偏好**被能力矩阵否掉时回落**：image 偏好设成 docx（png 没这个出口）→ 回落到 jpg',
      autoSubmitted[0]?.to === 'jpg',
      `png 那条 to=${String(autoSubmitted[0]?.to)}`
    )
    check(
      '8  顶层回显的是**请求**（"auto"），与实际解析出来的 to 并存，两者不混为一谈',
      autoBatch.structured.target_format === 'auto' &&
        autoSubmitted.every((entry) => entry.to !== 'auto'),
      `target_format=${String(autoBatch.structured.target_format)} 各条 to=${JSON.stringify(autoSubmitted.map((entry) => entry.to))}`
    )
  } finally {
    await session.close()
  }
}

/* ================== 第 5 节：read_document（一次调用把正文拿进上下文） */

/**
 * 这一节要证明的东西，全部是**可计数**的：
 *
 *  1. **一次调用拿到正文**——不是「更快」这种在噪声里恒真的话，而是
 *     「`list_jobs` 里的条数在读完前后一条都没变」，也就是 read_document 没有
 *     偷偷建一个 job 再让调用方去轮询。
 *  2. **它不写用户的输出目录**——设置里把「输出到指定目录」打开、那个目录**预先清空**，
 *     跑完一轮读取之后它必须**还是空的**（防空转前提就是那句预清空）。
 *  3. **临时目录两条路径上都不残留**——成功读一份 docx、失败读一份坏 docx，
 *     `%TEMP%\arbiter-read-*` 的数量不许增加。
 *  4. **截断可续读**——两段拼起来必须与源文件的对应切片**逐字相等**；
 *     只断言 `text.length <= max_chars` 的话，「每次都从头返回」也能绿。
 *  5. **扫描件 PDF 报错而不是给空串**——返回的是 `isError`，码是 `no_text_content`，
 *     文案里点出 OCR。这条正是「应当有内容却是空」那一类里最要命的一种。
 *
 * 素材全部现场造，而且**造素材的实现与被测实现不是同一个**：
 * pdf 用 pdf-lib 造、pdfjs 读；docx 用 jszip 造、mammoth 读；
 * xlsx 用 SheetJS 造、SheetJS 读（这一对确实是同一个库，所以那一条只断言
 * 「单元格内容到了输出里」，不当成解码器行为的证据）。
 */
async function section5ReadDocument(tmp: string): Promise<void> {
  console.log('\n[5] read_document：一次调用读出正文')

  const root = join(tmp, 'read')
  const src = join(root, 'src')
  const userdata = join(root, 'userdata')
  const configuredOut = join(root, 'configured-out')
  for (const dir of [src, userdata, configuredOut]) mkdirSync(dir, { recursive: true })

  // 设置里把「输出到指定目录」打开，并**先确认那个目录是空的**。
  // 这份设置唯一的用途就是：read_document 一旦（直接或经转换链路）用了
  // `outputDirFor()`，产物就会出现在这里，而这条断言当场翻红。
  writeFileSync(
    join(userdata, 'settings.json'),
    JSON.stringify({
      version: 1,
      outputDir: configuredOut,
      outputBesideSource: false,
      onConflict: 'overwrite',
      maxConcurrent: 1,
      defaultTargets: {},
      skipTasksNeedingDownload: false
    }),
    'utf8'
  )
  check(
    '1  前提：配置的输出目录一开始是空的（不空的话「跑完还是空的」这条是空转）',
    readdirSync(configuredOut).length === 0,
    JSON.stringify(readdirSync(configuredOut))
  )

  /* ------------------------------------------------------------ 素材 */

  // markdown：这一支必须**原样返回**（连一个字节都不动）。逐字比较才有鉴别力。
  const mdPath = join(src, 'notes.md')
  const mdText = '# 读我\n\n正文一段，带 `代码` 与 **粗体**。\n'
  writeFileSync(mdPath, mdText, 'utf8')

  // GBK 的 txt。**手写字节**（约束 13）：用库去编码就变成「编码器和解码器互相验证」。
  // 中 = D6D0、文 = CEC4、标 = B1EA、题 = CCE2
  const gbkBytes = Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0xb1, 0xea, 0xcc, 0xe2, 0x0a])
  const gbkPath = join(src, 'gbk.txt')
  writeFileSync(gbkPath, gbkBytes)
  check(
    '2  前提：那串 GBK 字节按 UTF-8 硬解**解不出**「中文标题」（否则下一条是空转）',
    !gbkBytes.toString('utf8').includes('中文标题'),
    JSON.stringify(gbkBytes.toString('utf8'))
  )

  // 一个同样内容、但是 UTF-8 的对照：两者读出来的正文必须**一字不差**
  const utf8Path = join(src, 'utf8.txt')
  writeFileSync(utf8Path, '中文标题\n', 'utf8')

  // 300000 字符的长文本：截断、续读、max_chars 上限三条都拿它测
  const longPath = join(src, 'long.txt')
  const longText = '0123456789'.repeat(30000)
  writeFileSync(longPath, longText, 'utf8')

  // xlsx（SheetJS 造）
  //
  // ⚠️ **刻意不用 `XLSX.writeFile`**，落盘交给 node 自己的 `writeFileSync`。
  // 原因是一处「解析到哪个入口」的分歧，实测（2026-09-15）：
  //
  //   - `xlsx@0.20.3` 起带了 `exports` 字段，于是 `import 'xlsx'` → **`xlsx.mjs`**；
  //     而 `require('xlsx')` → `xlsx.js`。**这是两个不同的文件、两个独立实例。**
  //   - 两个文件里的 `_fs` 都靠 `set_fs()` 注入，但只有 **CJS 那一份在末尾自己接好了**
  //     （`xlsx.mjs` 里没有 `require`，接不了）。于是 ESM 入口下 `writeFile` 会抛
  //     `cannot save file <路径>` —— 而 `read` / `utils.*` 一概正常，所以它看着像路径问题。
  //   - tsx 下 `await import('xlsx')` **保留为真 ESM import**，落到的正是 `xlsx.mjs`。
  //
  // 生产不受影响：`htmlSource.ts` 走的是 `XLSX.read(buffer, {type:'buffer'})`，**从不碰 fs**，
  // 所以这条只坑「造素材」这一侧。用 `XLSX.write(…, {type:'buffer'})` 也是同理——
  // 它在内存里出字节，于是这条素材生成与「解析器解析到哪个入口」彻底无关。
  const xlsxPath = join(src, 'table.xlsx')
  const XLSX = await import('xlsx')
  const book = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(
    book,
    XLSX.utils.aoa_to_sheet([
      ['name', 'count'],
      ['alpha', 42]
    ]),
    'Sheet1'
  )
  writeFileSync(xlsxPath, XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }))

  // 文本型 PDF（pdf-lib 造、pdfjs 读——两个实现）
  const { PDFDocument, StandardFonts } = await import('pdf-lib')
  const textPdf = join(src, 'text.pdf')
  const textDoc = await PDFDocument.create()
  const textPage = textDoc.addPage([300, 200])
  textPage.drawText('ARBITER-PDF-PROBE-42', {
    x: 20,
    y: 100,
    size: 12,
    font: await textDoc.embedFont(StandardFonts.Helvetica)
  })
  writeFileSync(textPdf, await textDoc.save())

  // 图片型 PDF：一页只有一张位图、**一个字符都没有**——扫描件就是这个形状
  const pngForScan = join(tmp, 'src', 'sample.png')
  check(
    '3  前提：第 2 节造的那张 PNG 还在（扫描件 PDF 要拿它当唯一的页面内容）',
    existsSync(pngForScan),
    pngForScan
  )
  const scanPdf = join(src, 'scan.pdf')
  const scanDoc = await PDFDocument.create()
  const scanPage = scanDoc.addPage([200, 200])
  scanPage.drawImage(await scanDoc.embedPng(readFileSync(pngForScan)), {
    x: 0,
    y: 0,
    width: 200,
    height: 200
  })
  writeFileSync(scanPdf, await scanDoc.save())
  // 判据是「它是一份**结构完好的** PDF」，不是某个大小阈值：实测 pdf-lib 嵌一张 64x48 的
  // PNG 出来是 961 字节，对着一个拍脑袋的 1000 去比只会得到一个假红。
  check(
    '4  前提：那份扫描件 PDF 是一份结构完好的 PDF（防空转：下面那条测的是「有图无字」，不是「文件坏了」）',
    existsSync(scanPdf) &&
      readFileSync(scanPdf).subarray(0, 5).toString('latin1') === '%PDF-' &&
      statSync(scanPdf).size > 400,
    `size=${existsSync(scanPdf) ? statSync(scanPdf).size : 'n/a'} magic=${JSON.stringify(
      existsSync(scanPdf) ? readFileSync(scanPdf).subarray(0, 5).toString('latin1') : 'n/a'
    )}`
  )

  // docx（jszip 手搓一个最小包，mammoth 读）。**不用 pandoc 造**：
  // 那会让这一节在没跑过 fetch-pandoc 的机器上整节失效。
  const JSZip = (await import('jszip')).default
  const zip = new JSZip()
  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
      '</Types>'
  )
  zip
    .folder('_rels')!
    .file(
      '.rels',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
        '</Relationships>'
    )
  zip
    .folder('word')!
    .file(
      'document.xml',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
        '<w:p><w:r><w:t>读我 DOCX</w:t></w:r></w:p>' +
        '<w:p><w:r><w:t>正文 PROBE-DOCX-7</w:t></w:r></w:p>' +
        '</w:body></w:document>'
    )
  const docxPath = join(src, 'note.docx')
  writeFileSync(docxPath, await zip.generateAsync({ type: 'nodebuffer' }))

  // 一个**扩展名是 docx、内容不是**的坏文件：走转换链路、在 mammoth 那里失败。
  // 它专门用来验「失败路径上临时目录同样被删掉」。
  const brokenDocx = join(src, 'broken.docx')
  writeFileSync(brokenDocx, 'this is definitely not a docx package\n')

  // 重型引擎那两类与「不是文档」的那类
  const legacyDoc = join(src, 'legacy.doc')
  writeFileSync(legacyDoc, 'x')
  const epubPath = join(src, 'book.epub')
  writeFileSync(epubPath, 'x')
  const mp4Path = join(src, 'clip.mp4')
  copyFileSync(join(tmp, 'src', 'clip.mp4'), mp4Path)

  const srcBefore = readdirSync(src).sort()

  /* ------------------------------------------------------------ 会话 */

  const session = startServer({
    ARBITER_USER_DATA: userdata,
    ARBITER_DOWNLOADS: tmp,
    ARBITER_MCP_WRITE_ROOTS: tmp,
    ARBITER_MCP_CONCURRENCY: '1'
  })
  const ready = await waitReady(session)
  check('5  读文档那个实例起来了', ready, `stderr=${session.stderrText.slice(0, 200)}`)

  try {
    await session.call('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'arbiter-test', version: '0' }
    })

    // 工具清单里必须有它，而且**只有一个读工具**（多加一个 `read_pdf` 之类的
    // 就会让「用哪个」变成模型每次都要猜的事）。
    const toolList = (await session.call('tools/list')) as { tools?: { name: string }[] }
    const readTools = (toolList.tools ?? []).filter((t) => t.name.startsWith('read_'))
    check(
      '6  tools/list 里有 read_document，且以 read_ 开头的工具**恰好只有它一个**',
      readTools.length === 1 && readTools[0].name === 'read_document',
      JSON.stringify((toolList.tools ?? []).map((t) => t.name))
    )

    /* ------------------------------------------- 可计数的收益：job 一条都没多 */

    const jobsBefore = await totalJobs(session)
    check(
      '7  前提：这个实例上此刻一条 job 都没有（下面那条要靠它做基线）',
      jobsBefore === 0,
      `total=${String(jobsBefore)}`
    )

    const tempBefore = countReadTempDirs()
    check(
      '8  前提：临时目录可枚举（下面那条「没有残留」问的就是它）',
      tempBefore >= 0,
      String(tempBefore)
    )

    /* -------------------------------------------------------------- md 原文 */

    const md = await session.callTool('read_document', { source: mdPath })
    check(
      '9  读 .md 默认给 md：正文与源文件**逐字相等**（原样返回，不过一遍转换）',
      md.isError === false && md.structured.text === mdText && md.structured.format === 'md',
      `format=${String(md.structured.format)} text=${JSON.stringify(md.structured.text)?.slice(0, 80)}`
    )
    check(
      '10 source_format 回的是源自己的扩展名，total_chars 是**整个正文**的长度',
      md.structured.source_format === 'md' && md.structured.total_chars === mdText.length,
      `source_format=${String(md.structured.source_format)} total_chars=${String(md.structured.total_chars)}`
    )
    check(
      '11 没被截断时 truncated 为 false、也没有 warnings（有话说才出现）',
      md.structured.truncated === false && md.structured.warnings === undefined,
      `truncated=${String(md.structured.truncated)} warnings=${JSON.stringify(md.structured.warnings)}`
    )

    /* --------------------------------------------------------------- GBK */

    const gbk = await session.callTool('read_document', { source: gbkPath, format: 'txt' })
    const utf8 = await session.callTool('read_document', { source: utf8Path, format: 'txt' })
    check(
      '12 GBK 的 txt 读出来是「中文标题」（GB18030 兜底生效）',
      gbk.isError === false && String(gbk.structured.text).includes('中文标题'),
      JSON.stringify(gbk.structured.text)?.slice(0, 80)
    )
    check(
      '13 同一段文字的 GBK 版与 UTF-8 版读出来**一字不差**（比「含中文」硬得多）',
      gbk.structured.text === utf8.structured.text &&
        String(utf8.structured.text).includes('中文标题'),
      `gbk=${JSON.stringify(gbk.structured.text)} utf8=${JSON.stringify(utf8.structured.text)}`
    )

    /* ------------------------------------------------------- 转换那两条路 */

    const docx = await session.callTool('read_document', { source: docxPath })
    check(
      '14 .docx 默认给 md：两段正文都在（mammoth 解出来的，不是当二进制读的）',
      docx.isError === false &&
        typeof docx.structured.text === 'string' &&
        docx.structured.text.includes('读我 DOCX') &&
        docx.structured.text.includes('PROBE-DOCX-7') &&
        docx.structured.source_format === 'docx',
      `text=${JSON.stringify(docx.structured.text)?.slice(0, 160)}`
    )
    const docxTxt = await session.callTool('read_document', { source: docxPath, format: 'txt' })
    check(
      '15 .docx 要 txt 时走 mammoth 的 extractRawText 直通车（内容在，且带 PROBE 标记）',
      docxTxt.isError === false && String(docxTxt.structured.text).includes('PROBE-DOCX-7'),
      `text=${JSON.stringify(docxTxt.structured.text)?.slice(0, 120)}`
    )

    const xlsx = await session.callTool('read_document', { source: xlsxPath, format: 'csv' })
    check(
      '16 .xlsx 要 csv：表头与单元格内容都在，且**开头没有 BOM**（写出去时加了、读回来要剥掉）',
      xlsx.isError === false &&
        String(xlsx.structured.text).includes('name') &&
        String(xlsx.structured.text).includes('alpha') &&
        String(xlsx.structured.text).includes('42') &&
        String(xlsx.structured.text).charCodeAt(0) !== 0xfeff,
      `text=${JSON.stringify(xlsx.structured.text)?.slice(0, 120)}`
    )
    const xlsxMd = await session.callTool('read_document', { source: xlsxPath })
    check(
      '17 .xlsx 要 md（它没有这个出口）：**回落成 csv 并说清**，format 如实报 csv',
      xlsxMd.isError === false &&
        xlsxMd.structured.format === 'csv' &&
        Array.isArray(xlsxMd.structured.warnings) &&
        (xlsxMd.structured.warnings as string[]).length > 0,
      `format=${String(xlsxMd.structured.format)} warnings=${JSON.stringify(xlsxMd.structured.warnings)}`
    )

    const pdfText = await session.callTool('read_document', { source: textPdf, format: 'txt' })
    check(
      '18 文本型 PDF → txt：抽出来的正文里有那个探针标记',
      pdfText.isError === false &&
        pdfText.structured.source_format === 'pdf' &&
        String(pdfText.structured.text).includes('ARBITER-PDF-PROBE-42'),
      `text=${JSON.stringify(pdfText.structured.text)?.slice(0, 160)}`
    )
    const pdfMd = await session.callTool('read_document', { source: textPdf })
    check(
      '19 PDF 默认 md（pdf 有 md 出口，不该回落）：format 就是 md',
      pdfMd.isError === false && pdfMd.structured.format === 'md',
      `format=${String(pdfMd.structured.format)}`
    )

    /* --------------------------------------------------------- 扫描件 PDF */

    const scan = await session.callTool('read_document', { source: scanPdf, format: 'txt' })
    const scanBody = hintOf(scan.text)
    check(
      '20 图片型 PDF → **报错**，码是 no_text_content（不是 source_corrupt），且点名 OCR',
      scan.isError === true &&
        scanBody.code === 'no_text_content' &&
        scanBody.retryable === false &&
        scan.text.includes('OCR'),
      `isError=${scan.isError} code=${String(scanBody.code)} text=${scan.text.slice(0, 200)}`
    )
    check(
      '21 扫描件那条错误**不是**空文本的成功结果（防空转：这是这条设计点的全部意义）',
      scan.structured.text === undefined && scan.text.trim().length > 0,
      `structured=${JSON.stringify(scan.structured).slice(0, 120)}`
    )

    /* ---------------------------------------------------------------- 闸门 */

    check(
      '22 前提：闸门外那个文件确实存在（否则下一条分不清是闸门还是没文件）',
      existsSync('C:\\Windows\\win.ini')
    )
    const blocked = await session.callTool('read_document', { source: 'C:\\Windows\\win.ini' })
    check(
      '23 读根之外的路径被闸门拒掉（read_document 没有绕开 paths.ts）',
      blocked.isError === true && hintOf(blocked.text).code === 'path_not_allowed',
      `code=${String(hintOf(blocked.text).code)} text=${blocked.text.slice(0, 160)}`
    )

    /* ------------------------------------------------------------ 重型拒绝 */

    const heavyDoc = await session.callTool('read_document', { source: legacyDoc })
    const heavyEpub = await session.callTool('read_document', { source: epubPath })
    check(
      '24 .doc → engine_missing 且把代价说出来了（357 MiB / LibreOffice），并指向 convert_file',
      heavyDoc.isError === true &&
        hintOf(heavyDoc.text).code === 'engine_missing' &&
        heavyDoc.text.includes('357') &&
        heavyDoc.text.includes('LibreOffice'),
      `text=${heavyDoc.text.slice(0, 200)}`
    )
    check(
      '25 .epub → engine_missing，代价是 Calibre 213 MiB（与上一条不是同一套文案）',
      heavyEpub.isError === true &&
        hintOf(heavyEpub.text).code === 'engine_missing' &&
        heavyEpub.text.includes('213') &&
        heavyEpub.text.includes('Calibre'),
      `text=${heavyEpub.text.slice(0, 200)}`
    )
    const notDoc = await session.callTool('read_document', { source: mp4Path })
    check(
      '26 音视频 → not_readable（不是 unknown_format：格式认得，只是没有正文可读）',
      notDoc.isError === true && hintOf(notDoc.text).code === 'not_readable',
      `code=${String(hintOf(notDoc.text).code)} text=${notDoc.text.slice(0, 160)}`
    )

    /* --------------------------------------------------------- 截断与续读 */

    const first = await session.callTool('read_document', {
      source: longPath,
      format: 'txt',
      max_chars: 100
    })
    check(
      '27 分块读：text 就是源文件的头 100 个字符、truncated 为 true、total_chars 是全文长度',
      first.structured.text === longText.slice(0, 100) &&
        first.structured.truncated === true &&
        first.structured.total_chars === longText.length,
      `len=${String(first.structured.text).length} truncated=${String(first.structured.truncated)} total=${String(first.structured.total_chars)}`
    )
    const second = await session.callTool('read_document', {
      source: longPath,
      format: 'txt',
      max_chars: 100,
      offset: 100
    })
    check(
      '28 续读接得上：两段拼起来**逐字等于**源文件的头 200 个字符（不是「有一段新内容」而已）',
      String(first.structured.text) + String(second.structured.text) === longText.slice(0, 200),
      `拼接长度=${(String(first.structured.text) + String(second.structured.text)).length}`
    )
    const tail = await session.callTool('read_document', {
      source: longPath,
      format: 'txt',
      max_chars: 100,
      offset: longText.length - 50
    })
    check(
      '29 读到尾部：只剩 50 个字符，truncated 如实为 false（判据是「还有没有剩」，不是「够不够 max_chars」）',
      tail.structured.text === longText.slice(-50) && tail.structured.truncated === false,
      `len=${String(tail.structured.text).length} truncated=${String(tail.structured.truncated)}`
    )
    const past = await session.callTool('read_document', {
      source: longPath,
      format: 'txt',
      offset: longText.length + 1000
    })
    check(
      '30 offset 超出正文：给空文本 + 一句说明（不报错、也不静默给个看起来像正文的东西）',
      past.isError === false &&
        past.structured.text === '' &&
        past.structured.truncated === false &&
        Array.isArray(past.structured.warnings),
      `text=${JSON.stringify(past.structured.text)} warnings=${JSON.stringify(past.structured.warnings)}`
    )

    // 默认值那一条：**不传 max_chars 时必须被截到一个小数字**。这是「一份 300 页 PDF
    // 不会一次把上下文塞爆」的全部依据；默认值等于上限时这条会红。
    const byDefault = await session.callTool('read_document', { source: longPath, format: 'txt' })
    check(
      `31 不传 max_chars 时按默认值截断（拿到 DEFAULT_READ_CHARS 个字符，而不是 300000）`,
      String(byDefault.structured.text).length === DEFAULT_READ_CHARS &&
        byDefault.structured.total_chars === longText.length &&
        byDefault.structured.truncated === true,
      `len=${String(byDefault.structured.text).length} DEFAULT=${DEFAULT_READ_CHARS} total=${String(byDefault.structured.total_chars)}`
    )
    const clamped = await session.callTool('read_document', {
      source: longPath,
      format: 'txt',
      max_chars: 10_000_000
    })
    check(
      `32 要一个荒唐的 max_chars（一千万）：被夹到上限 ${MAX_READ_CHARS}，并在 warnings 里如实说明`,
      String(clamped.structured.text).length === MAX_READ_CHARS &&
        String(clamped.structured.text).length < longText.length &&
        JSON.stringify(clamped.structured.warnings ?? '').includes(String(MAX_READ_CHARS)),
      `len=${String(clamped.structured.text).length} warnings=${JSON.stringify(clamped.structured.warnings)?.slice(0, 120)}`
    )

    /* --------------------------------------------------- 临时目录 / 输出目录 */

    const broken = await session.callTool('read_document', { source: brokenDocx })
    // ⚠️ **这条断言在 2026-09-15 被 §3.3 推翻过一次，旧结论留在这里当路标。**
    //
    // 它原先断言的是 `code === 'internal'`，理由听着很硬：「mammoth 抛的是原生异常，
    // `errors.ts` 明令不是 McpToolError 的一律算 internal，绝不退化成某种业务错误」。
    // **那个理由只回答了「这个异常是不是我们归的类」，没回答「agent 拿到它会去干什么」。**
    // `internal` 在码表里配的是 `retryable: true`——于是 agent 会去重试一个**确定性失败**：
    // 同一个坏文件再读一次，结果一模一样。归类的意义就在于驱动下一步动作，所以「类归对了、
    // 动作却是错的」不算对。
    //
    // §3.3 的修法是把「读源文件」那一步的异常包成 `ConversionFailed`（见
    // `converters/document.ts` 的 `readSourceOrFail`），码随之落成 `source_corrupt`。
    //
    // **原始英文报错并没有被吞掉**：它在 `log_tail` 里一字未动（`readDocument.ts` 明写
    // 「一个字都不留地转出去」）——变的只是**主文案**，从「jszip 的英文异常 + 一个第三方
    // 文档链接」换成一句中文摘要。下面那条 `includes('zip')` 因此照旧成立，而且它现在
    // 守的是另一件事：**别为了把话说好听，把引擎给的那个唯一说得清原因的字符串丢掉。**
    //
    // 这条断言在这里还有第二个作用：**先证明真的失败过**，好让下一条（临时目录没残留）
    // 不是空转。
    check(
      '33 坏 docx（扩展名过关、内容不是包）→ source_corrupt 且 retryable:false（不是 internal），而原始英文原因仍留在 log_tail 里',
      broken.isError === true &&
        hintOf(broken.text).code === 'source_corrupt' &&
        hintOf(broken.text).retryable === false &&
        broken.text.includes('zip'),
      `code=${String(hintOf(broken.text).code)} retryable=${String(hintOf(broken.text).retryable)} text=${broken.text.slice(0, 200)}`
    )

    const tempAfter = countReadTempDirs()
    check(
      '34 一条成功的转换 + 一条失败的转换之后，临时目录一个都没多（两条路径都被 finally 收干净了）',
      tempAfter >= 0 && tempAfter <= tempBefore,
      `读之前=${tempBefore} 读之后=${tempAfter}`
    )
    check(
      '35 用户配置的输出目录**仍然是空的**（read_document 一次都没往那儿写）',
      readdirSync(configuredOut).length === 0,
      JSON.stringify(readdirSync(configuredOut))
    )
    check(
      '36 源文件目录也没有多出任何东西（没有在源文件旁边落产物 / .part）',
      JSON.stringify(readdirSync(src).sort()) === JSON.stringify(srcBefore),
      `之前=${JSON.stringify(srcBefore)} 之后=${JSON.stringify(readdirSync(src).sort())}`
    )

    // **可计数的收益**：这一整轮读下来，登记表里一条 job 都没有增加。
    // 「3 次调用 → 1 次」在这里的落地形式就是：不必起任务、不必等、不必去读产物。
    const jobsAfter = await totalJobs(session)
    check(
      '37 读完这些文件之后 list_jobs 的 total 仍然是 0（read_document 不起任务）',
      jobsAfter === 0,
      `之前=${String(jobsBefore)} 之后=${String(jobsAfter)}`
    )

    /* ------------------------------------------------------------ 协议纯净 */

    const badLines = session.lines.filter((line) => {
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>
        return typeof parsed !== 'object' || parsed === null || !('jsonrpc' in parsed)
      } catch {
        return true
      }
    })
    check(
      '38 这一整节（含一次 20 万字符的大返回）stdout 上每一行都是合法 JSON-RPC',
      badLines.length === 0 && session.lines.length > 10,
      `共 ${session.lines.length} 行，坏行 ${badLines.length}`
    )
    check(
      '39 stderr 里一次「拦下」都没有（说明 38 不是因为闸门把脏东西吞了）',
      !session.stderrText.includes('拦下'),
      `拦截次数=${(session.stderrText.match(/拦下/g) ?? []).length}`
    )
  } finally {
    await session.close()
  }
}

/* ================== 第 6 节：说明书接线 + inspect_file 的代价三件套 */

/**
 * 两件事，都是「**只有走真进程才问得出来**」的那一类。
 *
 * ## 一、`tools/list` 里的 description 必须逐字等于 `TOOL_DESCRIPTIONS[该工具名]`
 *
 * 这条断言是**唯一**能抓住 2026-09-13 那个真 bug 的判据：`convert_file` 注册时取的是
 * `TOOL_DESCRIPTIONS.read_document`——最常用的那个工具，客户端读到的说明书是别人的。
 * `test-mcp-view.ts` **抓不到它**，原因要说清楚：那个套件只加载 `schema.ts` /
 * `formatsView.ts` / `errors.ts` / `readPlan.ts` 这几个纯模块，它对描述表的全部要求
 * 是「每个工具都有一句中文」——`server.ts` 那一侧的**接线**它一次都没碰过
 * （真让它去 import `server.ts`，那条「src/mcp 的依赖图里没有 src/main」的断言当场就红，
 * 因为 server 牵着 jobs → converters）。所以这个洞只能在这里堵：**把服务端当子进程起起来，
 * 问它 `tools/list`**，拿回来的东西与描述表逐字对拍。
 *
 * 逐字对拍还不够（一个人可能只是把两边一起改错），所以下面还有两条：
 * 描述之间**互不相同**（张冠李戴多半是重复），以及 `convert_file` 的说明书里
 * **必须有它自己的话**（`转换单个文件`）而**没有别人的**（`直接读出文档的正文`）。
 *
 * ## 二、`cost` / `lossy` / `estimate` 的取值
 *
 * 判据分三层，缺一层就有一条路没人盯：
 *   1. **数字来自清单文件**——测试自己读一遍 `resources/engines.manifest.json`
 *      （独立实现，不复用被测的 `inspectCost.ts`）逐字对拍；
 *   2. **数字确实是运行时读的**——把 `ARBITER_APP_PATH` 指到一个空目录（清单读不到），
 *      那几个数必须变成 `null` 而**引擎名照旧**。少了这一条，代码里写死一个今天正确的
 *      数字照样全绿，而这正是 RESEARCH §5 点名要防的那件事；
 *   3. **判据按方向**——`mp4`（方向可 remux）报 `lossy:false` + `confidence:"high"`，
 *      `png`（图片）报 `lossy:true` + `"medium"`，两者互为对照，证明它不是常量。
 */
async function section6DescriptionsAndCost(tmp: string): Promise<void> {
  console.log('\n[6] 工具说明书的接线 + inspect_file 的代价三件套')

  const root = join(tmp, 'cost')
  const src = join(root, 'src')
  const userdata = join(root, 'userdata')
  for (const dir of [src, userdata]) mkdirSync(dir, { recursive: true })

  // 素材：音视频与图片用 ffmpeg 现造（解码器行为才是被判的东西，见 fixtures/README）；
  // 两个文档**只需要扩展名**——inspect 对 document 类根本不起子进程（`scoutFor` 的
  // document / ebook 那一支直接返回），所以内容是不是真的 rst / doc 不影响这里的判据。
  const mp4 = join(src, 'clip.mp4')
  const png = join(src, 'pic.png')
  runFfmpeg(
    [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc=size=160x120:rate=15',
      '-t',
      '1',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      mp4
    ],
    '第 6 节：造 MP4'
  )
  runFfmpeg(
    ['-y', '-f', 'lavfi', '-i', 'color=c=green:s=64x48:d=1', '-frames:v', '1', png],
    '第 6 节：造 PNG'
  )
  const rstPath = join(src, 'note.rst')
  writeFileSync(rstPath, '标题\n====\n\n正文。\n', 'utf8')
  const docPath = join(src, 'legacy.doc')
  writeFileSync(docPath, '这里不需要真的是一份 doc', 'utf8')

  // 期望值：测试自己读清单。**不复用 `inspectCost.ts` 的任何东西**——那会变成
  // 「解析器和它的输出互相验证」，而这里要证明的恰恰是「那个数是从这个文件里来的」。
  const manifest = JSON.parse(
    readFileSync(resolve(REPO, 'resources/engines.manifest.json'), 'utf8')
  ) as {
    engines: { key: string; sizeBytes: number; extract?: { expectedEntrySizeBytes?: number } }[]
  }
  const sizeOf = (key: string): number | undefined =>
    manifest.engines.find((engine) => engine.key === key)?.sizeBytes
  const unpackedOf = (key: string): number | undefined =>
    manifest.engines.find((engine) => engine.key === key)?.extract?.expectedEntrySizeBytes
  check(
    '0  前提：测试自己读到的清单是活的（三个引擎都在、pandoc 声明了解包体积）',
    manifest.engines.length === 3 &&
      sizeOf('libreoffice') !== undefined &&
      sizeOf('calibre') !== undefined &&
      unpackedOf('pandoc') !== undefined,
    JSON.stringify(manifest.engines.map((engine) => [engine.key, engine.sizeBytes]))
  )

  const session = startServer({
    ARBITER_USER_DATA: userdata,
    ARBITER_DOWNLOADS: tmp,
    ARBITER_MCP_WRITE_ROOTS: tmp,
    ARBITER_MCP_CONCURRENCY: '1'
  })
  const ready = await waitReady(session)
  check('1  第 6 节的实例起来了', ready, `stderr=${session.stderrText.slice(0, 200)}`)

  try {
    await session.call('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'arbiter-test', version: '0' }
    })

    /* -------------------------------------------- 6A：说明书的接线 */

    const schema = await import('../src/mcp/schema')
    const listed =
      (
        (await session.call('tools/list')) as {
          tools?: { name: string; description?: string }[]
        }
      ).tools ?? []
    const described = new Map(listed.map((tool) => [tool.name, tool.description ?? '']))

    const mismatched = listed.filter(
      (tool) =>
        tool.description !==
        schema.TOOL_DESCRIPTIONS[tool.name as (typeof schema.TOOL_NAMES)[number]]
    )
    check(
      '2  tools/list 里**每个**工具的 description 逐字等于 TOOL_DESCRIPTIONS[该工具名]',
      listed.length === schema.TOOL_NAMES.length && mismatched.length === 0,
      mismatched.length === 0
        ? `工具数 ${listed.length} vs 描述表 ${schema.TOOL_NAMES.length}`
        : mismatched.map((tool) => tool.name).join(', ')
    )
    // 防空转的伴生条件：上面那条在「两边都空」时也成立。
    check(
      '3  前提：确实问到了工具清单（否则上面那条是空的恒真）',
      listed.length > 0 && listed.every((tool) => (tool.description ?? '').length > 10),
      `${listed.length} 个工具`
    )
    // 张冠李戴的典型形态是「两个工具共用一段话」。独立问一遍。
    check(
      '4  每段 description 互不相同（说明书撞车 = 至少有一个工具在说别人的话）',
      listed.length > 1 && new Set(listed.map((tool) => tool.description)).size === listed.length,
      `去重后 ${new Set(listed.map((tool) => tool.description)).size} 段 / 共 ${listed.length} 个工具`
    )
    // 直接钉那个真 bug 的两半：自己的话在、别人的话不在。
    const convertText = described.get('convert_file') ?? ''
    check(
      '5  convert_file 的说明书是**它自己的**（有「转换单个文件」、没有「直接读出文档的正文」）',
      convertText.includes('转换单个文件') && !convertText.includes('直接读出文档的正文'),
      `前 80 字=${convertText.slice(0, 80)}`
    )

    /* -------------------------------------------- 6B：cost / lossy / estimate */

    const video = await session.callTool('inspect_file', { path: mp4 })
    const videoCost = (video.structured.cost ?? {}) as Record<string, unknown>
    // 防空转前提：下面三条断言全都在讲「按**默认目标**算」这件事，而 inspect_file 不收
    // target_format——所以「mp4 的默认目标是 mkv」必须单独问一遍（它决定 `lossy` 该报
    // false：mkv 是 remux 白名单里的容器；默认目标换成 avi 的话这条判据整个不成立）。
    const { defaultTargetFor } = await import('@shared/formats')
    check(
      '6  前提：mp4 的默认目标是 mkv（cost / lossy / estimate 三件套都按默认目标算）',
      defaultTargetFor('mp4') === 'mkv',
      `实际=${String(defaultTargetFor('mp4'))}`
    )
    check(
      '7  mp4 的 cost：engine=null、download_bytes=0、unpacked_bytes=null、network_required=false',
      videoCost.engine === null &&
        videoCost.download_bytes === 0 &&
        videoCost.unpacked_bytes === null &&
        videoCost.network_required === false,
      JSON.stringify(videoCost)
    )
    // 方向判据的两半：同一份代码在 mp4 上必须说「可能无损」、在 png 上必须说「有损」。
    // 只测一半的话，一个恒返回 true/false 的实现照样绿。
    check(
      '8  mp4（h264+aac → mkv，remux 白名单里）→ lossy:false；estimate 的 confidence 是 high（走的是 -c copy 那条实测过的路）',
      video.structured.lossy === false &&
        (video.structured.estimate as { confidence?: unknown } | null)?.confidence === 'high',
      `lossy=${String(video.structured.lossy)} estimate=${JSON.stringify(video.structured.estimate)}`
    )
    const videoEstimate = video.structured.estimate as { seconds?: unknown } | null
    check(
      '9  estimate 是**二元组**区间 [下限, 上限] 且 lo <= hi（防空转：验证它确实是个数组而不是一个数）',
      Array.isArray(videoEstimate?.seconds) &&
        (videoEstimate?.seconds as number[]).length === 2 &&
        (videoEstimate?.seconds as number[])[0]! <= (videoEstimate?.seconds as number[])[1]! &&
        (videoEstimate?.seconds as number[])[1]! < 60,
      JSON.stringify(videoEstimate)
    )
    check(
      '10 mp4 的 probe 与三件套并存（加字段没有把原有的侦察结果挤掉）',
      video.isError === false &&
        (video.structured.probe as { videoCodec?: unknown } | null)?.videoCodec === 'h264' &&
        video.structured.requiresDownload === null,
      `probe=${JSON.stringify(video.structured.probe).slice(0, 120)}`
    )

    const image = await session.callTool('inspect_file', { path: png })
    check(
      '11 png（默认目标 jpg）→ lossy:true，且 confidence 是 medium（与 mp4 那条互为对照：lossy 不是常量）',
      image.isError === false &&
        image.structured.lossy === true &&
        (image.structured.estimate as { confidence?: unknown } | null)?.confidence === 'medium',
      `lossy=${String(image.structured.lossy)} estimate=${JSON.stringify(image.structured.estimate)}`
    )

    // **数字来自清单**：测试自己读出来的值与服务端报的逐字相等。写死一个过时的数字
    //（375_000_000、或者按 MB 报的 357）在这里红。
    const rst = await session.callTool('inspect_file', { path: rstPath })
    const rstCost = (rst.structured.cost ?? {}) as Record<string, unknown>
    check(
      '12 rst（默认目标 pdf → 要下载 pandoc）→ download_bytes / unpacked_bytes 逐字等于清单里的值',
      rstCost.engine === 'pandoc' &&
        rstCost.download_bytes === sizeOf('pandoc') &&
        rstCost.unpacked_bytes === unpackedOf('pandoc') &&
        rstCost.network_required === true,
      `实际=${JSON.stringify(rstCost)} 清单=${JSON.stringify({
        download: sizeOf('pandoc'),
        unpacked: unpackedOf('pandoc')
      })}`
    )
    check(
      '13 rst 的 estimate 落在 pandoc 那档 [0.1, 4]（文档类按引擎给频带，confidence 一律 low）',
      JSON.stringify(rst.structured.estimate) ===
        JSON.stringify({ seconds: [0.1, 4], confidence: 'low' }),
      JSON.stringify(rst.structured.estimate)
    )
    const doc = await session.callTool('inspect_file', { path: docPath })
    const docCost = (doc.structured.cost ?? {}) as Record<string, unknown>
    check(
      '14 doc（默认目标 pdf → 要下载 libreoffice）→ download_bytes 是清单值，而 unpacked_bytes 为 **null**',
      docCost.engine === 'libreoffice' &&
        docCost.download_bytes === sizeOf('libreoffice') &&
        docCost.unpacked_bytes === null &&
        docCost.network_required === true,
      `实际=${JSON.stringify(docCost)} 清单=${String(sizeOf('libreoffice'))}`
    )
    check(
      '15 doc 的 estimate 落在 libreoffice 那档 [1.5, 30]（与 pandoc 那一档不是同一套频带）',
      JSON.stringify(doc.structured.estimate) ===
        JSON.stringify({ seconds: [1.5, 30], confidence: 'low' }),
      JSON.stringify(doc.structured.estimate)
    )
    // 三个字段的**形状**：`cost` 恒在（它是「空代价」而不是 undefined——undefined 在 JSON
    // 里会整个消失，agent 那边就成了「这个字段有时有有时没有」）。
    // 素材必须是**确实存在**的：不存在的路径会先被闸门那一层拒掉，于是这条断言测到的
    // 是「路径不合法」，而不是「扩展名认不出」——第一版就是这么红的。
    const weird = join(src, 'thing.xyz')
    writeFileSync(weird, 'x', 'utf8')
    const unknown = await session.callTool('inspect_file', { path: weird })
    check(
      '16 认不出的扩展名：cost 照旧是个对象（空代价），lossy / estimate 为 null（判不了就是判不了）',
      unknown.isError === false &&
        typeof unknown.structured.cost === 'object' &&
        unknown.structured.cost !== null &&
        (unknown.structured.cost as Record<string, unknown>).engine === null &&
        unknown.structured.lossy === null &&
        unknown.structured.estimate === null,
      JSON.stringify({
        cost: unknown.structured.cost,
        lossy: unknown.structured.lossy,
        estimate: unknown.structured.estimate
      })
    )
  } finally {
    await session.close()
  }

  /* ------- 6C：清单读不到时那几个数必须是 null（证明它们是运行时读的） ------- */

  // 把 appPath 指到一个**空目录**：`<appPath>/resources/engines.manifest.json` 不存在，
  // 于是 `costFor` 读清单那一步失败。**引擎名必须照旧**（它来自能力矩阵，与清单无关），
  // 只有两个体积数字变成 null——这与「这条路不用下东西」的 0 是**两回事**，
  // 混成一样的话 agent 会以为「不用下载」，而实际是「下不知道多大」。
  const nowhere = join(root, 'nowhere')
  mkdirSync(nowhere, { recursive: true })
  const bare = startServer({
    ARBITER_APP_PATH: nowhere,
    ARBITER_RESOURCES_PATH: join(nowhere, 'resources'),
    ARBITER_USER_DATA: join(root, 'userdata-bare'),
    ARBITER_DOWNLOADS: nowhere,
    ARBITER_MCP_WRITE_ROOTS: tmp
  })
  mkdirSync(join(root, 'userdata-bare'), { recursive: true })
  const bareReady = await waitReady(bare)
  check('17 清单读不到的那个实例也起来了', bareReady, `stderr=${bare.stderrText.slice(0, 200)}`)

  try {
    await bare.call('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'arbiter-test', version: '0' }
    })
    const bareDoc = await bare.callTool('inspect_file', { path: docPath })
    const bareCost = (bareDoc.structured.cost ?? {}) as Record<string, unknown>
    check(
      '18 清单读不到 → download_bytes / unpacked_bytes 是 **null**（不是 0、也不是编一个数），而 engine 照旧是 libreoffice',
      bareCost.engine === 'libreoffice' &&
        bareCost.download_bytes === null &&
        bareCost.unpacked_bytes === null &&
        bareCost.network_required === true,
      JSON.stringify(bareCost)
    )
    // 防空转：同一个实例上**不需要引擎**的那条路照样报 0（否则上面那条可能只是
    // 「这个实例整个坏了」，而不是「清单读不到」这条路径在起作用）。
    const barePng = await bare.callTool('inspect_file', { path: png })
    check(
      '19 同一实例上不需要引擎的 png：download_bytes 仍然是 0（证明上一条的 null 来自清单那一步，不是实例坏了）',
      (barePng.structured.cost as Record<string, unknown> | undefined)?.download_bytes === 0,
      JSON.stringify(barePng.structured.cost)
    )
  } finally {
    await bare.close()
  }
}

/* -------------------------------------------------------------------- 主流程 */

/**
 * 第 10 节：产物缩略图（R20）。
 *
 * 素材自造，与顺序无关；只用到 ffmpeg 与 sharp，不碰注册表。
 *
 * ## 为什么必须起**两个**会话
 *
 * 「默认关」是这个功能的**一半**：开了会给图，那是好写的半边；难写的是
 * 「什么都不设的时候一块图都不给」——而这一半**只有另起一个进程**才测得出来
 * （环境变量是进程启动时读的，同一个会话里改不了）。
 * 少了它，一个「永远开着」的实现能让「开了之后有图」那一串全绿。
 */
async function section10Thumbnails(tmp: string): Promise<void> {
  console.log('\n[10] 产物缩略图（R20）：默认关，开了只在 convert_file 上给')

  const root = join(tmp, 's10')
  const src = join(root, 'src')
  const out = join(root, 'out')
  for (const dir of [src, out, join(root, 'userdata'), join(root, 'userdata2')])
    mkdirSync(dir, { recursive: true })

  // ① 大图：**1200×800**，两个数都是故意选的——
  //    它比 512 大，所以缩略图**必须**被缩（不缩就是 1200×800，断言当场红）；
  //    而 `output_pixels` 要报的是**产物**的 1200×800 而不是缩略图那 512×341，
  //    两个数不一样，才分得清「报的是哪一个」。
  const big = join(src, 'big.png')
  runFfmpeg(
    ['-y', '-f', 'lavfi', '-i', 'testsrc=size=1200x800:rate=1', '-frames:v', '1', big],
    '第 10 节：造 1200×800 的 PNG'
  )
  // ② 一段视频：**非图片产物**，用来验「不是图就不给图」
  const clip = join(src, 'clip.mp4')
  runFfmpeg(
    [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc=size=160x120:rate=15',
      '-t',
      '1',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      clip
    ],
    '第 10 节：造 MP4'
  )

  const brief = (value: unknown): string => JSON.stringify(value ?? null).slice(0, 200)

  /* ---------------- 会话 A：什么都不设（= 默认关） ---------------- */

  const offSession = startServer({
    ARBITER_USER_DATA: join(root, 'userdata'),
    ARBITER_DOWNLOADS: root,
    ARBITER_MCP_WRITE_ROOTS: root,
    ARBITER_MCP_CONCURRENCY: '1'
    // ⚠️ **刻意不设 ARBITER_MCP_THUMBNAILS** —— 这一支测的就是「不设的时候怎样」
  })
  check('10a 默认关的实例起来了', await waitReady(offSession), offSession.stderrText.slice(0, 200))

  try {
    await offSession.call('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'arbiter-test', version: '0' }
    })

    const off = await offSession.callTool('convert_file', {
      source: big,
      target_format: 'jpg',
      output_path: join(out, 'off.jpg')
    })
    // 防空转：这次转换**确实成功了**。没有它，下面那条「没有图」在
    // 「转换直接失败了」时照样绿——那是最经典的装饰性断言形状。
    check(
      '10b 前置：默认关那一次转换确实成功了',
      off.structured.status === 'done',
      brief(off.structured.error ?? off.text)
    )
    check(
      '10c ⭐ 默认关：回话里一块 image 都没有',
      off.images.length === 0,
      JSON.stringify(off.blockTypes)
    )
  } finally {
    await offSession.close()
  }

  /* ---------------- 会话 B：ARBITER_MCP_THUMBNAILS=1 ---------------- */

  const onSession = startServer({
    ARBITER_USER_DATA: join(root, 'userdata2'),
    ARBITER_DOWNLOADS: root,
    ARBITER_MCP_WRITE_ROOTS: root,
    ARBITER_MCP_CONCURRENCY: '1',
    ARBITER_MCP_THUMBNAILS: '1'
  })
  check('10d 开了的实例起来了', await waitReady(onSession), onSession.stderrText.slice(0, 200))

  try {
    await onSession.call('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'arbiter-test', version: '0' }
    })

    const on = await onSession.callTool('convert_file', {
      source: big,
      target_format: 'jpg',
      output_path: join(out, 'on.jpg')
    })
    check(
      '10e 前置：开了那一次转换确实成功了',
      on.structured.status === 'done',
      brief(on.structured.error ?? on.text)
    )

    check(
      '10f 图片产物：回话里给了一块 image',
      on.images.length === 1,
      JSON.stringify(on.blockTypes)
    )
    check('10g 那块图的 mimeType 是 image/jpeg', on.images[0]?.mimeType === 'image/jpeg')

    // ⭐ 这一条是 R20 全部设计里最承重的一句：生态里**有客户端会静默丢掉 image block**，
    // 只给一次「转换成功」的接口就是自废武功。
    check(
      '10h ⭐ 文字块在**第一块**（客户端丢图时 agent 照样答得出来）',
      on.blockTypes[0] === 'text' && on.blockTypes.includes('image'),
      JSON.stringify(on.blockTypes)
    )

    // 文字事实要自足：格式与体积 `jobView` 里本来就有，尺寸由这一节补上。
    const pixels = (on.structured.output_pixels ?? {}) as { width?: number; height?: number }
    check(
      '10i 文字里有**产物**的尺寸（1200×800，不是缩略图的 512×341）',
      pixels.width === 1200 && pixels.height === 800,
      brief(pixels)
    )
    check(
      '10j 文字里有体积与格式（与 jobView 同一份）',
      typeof on.structured.size_bytes === 'number' && on.structured.to === 'jpg',
      brief(on.structured.to)
    )

    // 缩略图**真的来自产物**：解出来必须是 JPEG、必须被缩到 512 那条边之内、
    // 而且不能是 1200×800（那就是「压根没缩」）。
    const buf = Buffer.from(on.images[0]?.data ?? '', 'base64')
    const meta = await sharp(buf).metadata()
    check('10k 缩略图是一张能解开的 JPEG', meta.format === 'jpeg', String(meta.format))
    check(
      '10l ⭐ 缩略图被缩到了长边 512（1200×800 → 512×341）',
      meta.width === 512 && meta.height === 341,
      `${meta.width}×${meta.height}`
    )
    check(
      '10m 缩略图不超过 200 KB（判的是 JPEG 本身）',
      buf.byteLength <= 200 * 1024,
      `${buf.byteLength} 字节`
    )

    // 非图片产物：**不能**因为「开了」就无脑给图
    const movie = await onSession.callTool('convert_file', {
      source: clip,
      target_format: 'mkv',
      output_path: join(out, 'clip.mkv')
    })
    check(
      '10n 前置：非图片那次转换确实成功了',
      movie.structured.status === 'done',
      brief(movie.structured.error ?? movie.text)
    )
    check(
      '10o 非图片产物（mp4 → mkv）不给缩略图',
      movie.images.length === 0,
      JSON.stringify(movie.blockTypes)
    )

    // ⚠️ **get_job_status 刻意不给图**：轮询那条路上每问一次就要重编一张，
    //    而 agent 常常连着问十几次。这是设计，钉住它。
    const status = await onSession.callTool('get_job_status', {
      job_id: (on.structured.job_id ?? '') as string
    })
    check(
      '10p ⭐ get_job_status 不给缩略图（轮询不该反复重编一张图）',
      status.images.length === 0,
      JSON.stringify(status.blockTypes)
    )
  } finally {
    await onSession.close()
  }
}

/**
 * 第 11 节：优先级 / 插队（R16）。
 *
 * ## 为什么这一节的重心在**纯逻辑**上
 *
 * 「谁先跑」如果只从外面观测（起服务端 → 轮询状态 → 看谁先变 running），那是一台
 * **抢时序**的测试：机器一忙就飘，而飘出来的样子恰好是「功能坏了」。调度规则因此被
 * 抽成了纯函数 `pickNextIndex`——直接把队列喂进去问它挑谁，一步到位、零等待。
 *
 * 端到端那一半只断**边界上那几件与时序无关**的事：参数回显、越界被拒、默认值。
 */
async function section11Priority(tmp: string): Promise<void> {
  console.log('\n[11] 优先级 / 插队（R16）')

  const brief = (value: unknown): string => JSON.stringify(value ?? null).slice(0, 200)

  /* ------------------------------ 纯逻辑：调度规则本身 ------------------------------ */

  /** 一条队列条目。类型写全是因为 `pickNextIndex` 只认这三个字段 */
  interface Queued {
    engine: EngineKey
    cost: number
    priority: number
  }
  const job = (priority: number, engine: EngineKey = 'ffmpeg'): Queued => ({
    engine,
    cost: 1,
    priority
  })

  const allFit = (): boolean => true
  /** 某个引擎占满时的准入判据（`hasSlot` 只看得到引擎与份数） */
  const blocked =
    (engine: EngineKey) =>
    (e: EngineKey): boolean =>
      e !== engine

  // 防空转：下面每一条都在拿它跟一个下标比，队列空的话它们会以各种姿势「恰好对上」
  check('11a 前置：空队列谁也挑不出来（回 -1）', pickNextIndex([], allFit) === -1)

  // ★ 这一节最承重的一条
  check(
    '11b ⭐ 挑的是**优先级最高的那个**，不是队首那个',
    pickNextIndex([job(0), job(0), job(9)], allFit) === 2,
    String(pickNextIndex([job(0), job(0), job(9)], allFit))
  )
  // 反面控制：全都是同一个优先级时必须退回**入队顺序**。
  // 没有这一条，一个「从后往前挑」的实现也能让 11b 变绿。
  check(
    '11c 同优先级保持入队顺序（FIFO 是默认行为，优先级只该「插队」不该把它也改掉）',
    pickNextIndex([job(0), job(0), job(0)], allFit) === 0
  )
  check('11d 负优先级真的排在 0 后面', pickNextIndex([job(-5), job(0)], allFit) === 1)

  // 准入先于优先级。这一条挡的是「一条放不下的高优先级任务把整张队列冻住」——
  // 那正是 `pump()` 原先跳过放不下的人时在防的事（约束 25），插队不能把它破坏掉。
  check(
    '11e ⭐ 最高的那条**放不下**时，退而挑放得下的（插队不能把队列冻住）',
    pickNextIndex([job(0, 'ffmpeg'), job(9, 'sharp')], blocked('sharp')) === 0,
    String(pickNextIndex([job(0, 'ffmpeg'), job(9, 'sharp')], blocked('sharp')))
  )
  check(
    '11f 一个都放不下时回 -1（调用方据此 return，不是挑一个硬跑）',
    pickNextIndex([job(0), job(9)], () => false) === -1
  )

  /* ------------------------------ 夹取 ------------------------------ */

  check(
    '11g clampPriority：不传 / 非有限数 → 0（默认档）',
    clampPriority(undefined) === 0 && clampPriority(Number.NaN) === 0
  )
  check(
    '11h clampPriority：越界夹到 ±100，并且取整',
    clampPriority(9999) === 100 && clampPriority(-9999) === -100 && clampPriority(3.7) === 3,
    `${clampPriority(9999)} / ${clampPriority(-9999)} / ${clampPriority(3.7)}`
  )

  /* ------------------------------ 端到端：边界上的确定性行为 ------------------------------ */

  const root = join(tmp, 's11')
  const src = join(root, 'src')
  const out = join(root, 'out')
  for (const dir of [src, out, join(root, 'userdata')]) mkdirSync(dir, { recursive: true })

  const png = join(src, 'pic.png')
  runFfmpeg(
    ['-y', '-f', 'lavfi', '-i', 'testsrc=size=120x80:rate=1', '-frames:v', '1', png],
    '第 11 节：造 PNG'
  )

  const session = startServer({
    ARBITER_USER_DATA: join(root, 'userdata'),
    ARBITER_DOWNLOADS: root,
    ARBITER_MCP_WRITE_ROOTS: root,
    ARBITER_MCP_CONCURRENCY: '1'
  })
  check('11i 第 11 节的实例起来了', await waitReady(session), session.stderrText.slice(0, 200))

  try {
    await session.call('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'arbiter-test', version: '0' }
    })

    const ranked = await session.callTool('convert_file', {
      source: png,
      target_format: 'jpg',
      output_path: join(out, 'ranked.jpg'),
      priority: 7
    })
    check(
      '11j 给了优先级就回显它（agent 才看得见自己插的队生效了没有）',
      ranked.structured.priority === 7,
      brief(ranked.structured.priority)
    )

    const plain = await session.callTool('convert_file', {
      source: png,
      target_format: 'jpg',
      output_path: join(out, 'plain.jpg')
    })
    check(
      '11k 不给就是 0——**照给这个键**，不是省掉（「没给」与「给了 0」是同一件事）',
      plain.structured.priority === 0,
      brief(plain.structured.priority)
    )

    // 越界由 schema 挡（zod 的 `.max(100)`），不是靠 `clampPriority` 兜。
    // 两条闸门的分工：schema 面向 agent（越界是它的**参数错**，该明说），
    // clamp 面向非 zod 的调用方（CLI 那条路，夹住比拒掉合适）。
    const tooBig = await session.callTool('convert_file', {
      source: png,
      target_format: 'jpg',
      output_path: join(out, 'toobig.jpg'),
      priority: 101
    })
    check('11l 越界的优先级被 schema 拒掉（不是悄悄夹成 100）', tooBig.isError, brief(tooBig.text))
  } finally {
    await session.close()
  }
}

async function main(): Promise<void> {
  rmSync(TMP, { recursive: true, force: true })
  mkdirSync(TMP, { recursive: true })

  // 第 3 节复用第 2 节造出来的 PNG，所以顺序是承重的（不能并行）。
  section1StdoutGuard()
  await section2Session(TMP)
  await section3EngineMissing(TMP)
  await section4OutputDirSettings(TMP)
  // 第 5 节要用第 2 节造出来的 sample.png（拿它当「扫描件 PDF」的唯一页面内容），
  // 所以顺序同样是承重的。
  await section5ReadDocument(TMP)
  // 第 6 节自造全部素材（不蹭前面几节的产物），所以放在最后、与顺序无关。
  await section6DescriptionsAndCost(TMP)
  // 第 7 节自造全部素材，而且**只起一个会话**（另有两段在进程内跑）——放在最后，
  // 与顺序无关。它刻意**不依赖本机装没装 LibreOffice**，理由写在那节的注释里。
  await section7EngineLimitAndOutputConflict(TMP)
  // 第 8 节（E-6 产物自检）自造全部素材，与顺序无关；它不碰注册表、
  // 也不依赖本机装没装 LibreOffice / Calibre（只用到 ffmpeg）。
  await section8SelfCheck(TMP)
  // 第 9 节（E-5 的 dry_run）自造全部素材，与顺序无关；它只用到 ffmpeg 与 sharp
  // （png / mp4 两个源），不碰注册表、也不依赖本机装没装 LibreOffice / Calibre。
  await section9DryRun(TMP)
  // 第 10 节（R20 产物缩略图）自造全部素材，与顺序无关；它**起两个会话**——
  // 「默认关」那半边只能另起一个进程才测得到（环境变量是启动时读的）。
  await section10Thumbnails(TMP)
  // 第 11 节（R16 优先级）自造素材、起一个会话；**它的重心在纯逻辑上**，
  // 端到端那几条只断与时序无关的边界（回显 / 默认值 / 越界被拒）。
  await section11Priority(TMP)

  console.log(`\n=== 通过 ${passed} / 失败 ${failures.length} ===`)
  if (failures.length > 0) {
    console.log('失败：')
    for (const f of failures) console.log(`  - ${f}`)
    // 红了就把临时目录留着：里面是现场（造出来的素材、半成品产物）。
    console.log(`现场保留在 ${TMP}`)
  } else {
    rmSync(TMP, { recursive: true, force: true })
  }
  process.exit(failures.length === 0 ? 0 : 1)
}

/* ============ 第 7 节：两条外部分发版审计修复的验收现场（§3.3 / §3.7） ============ */

/**
 * 审计报告 §3.3 与 §3.7。两条修的是**同一件事的两个入口**——「同一个规矩在 A 处
 * 落地了、在 B 处没铺开」，所以验收也放在同一节里。
 *
 * - §3.3：GUI 早就有 `core/queue.ts` 的按引擎容量（`libreoffice: 1`，理由写在表上：
 *   「第二个实例会静默把参数转交给第一个，退出码 0 却不产生产物」），而 MCP 侧只有
 *   全局 `maxRunning`。两个并发 `convert_file` 能真的拉起两个 LibreOffice。
 * - §3.7：`output_path` 上**已经有一个文件**时，程序不覆盖（数据安全 ✓）但也不报错，
 *   而是悄悄写到 `报告 (1).pdf` 并返回 `status: done`。作者为「指向目录」那个变体
 *   专门加了拦截，却漏了「文件已存在」这一个。
 *
 * ## 为什么这一节**不许**依赖本机装没装 LibreOffice / Calibre
 *
 * 本项目明令反对机器相关的断言：那种断言在没装的机器上是**空集合恒真**，
 * 看着绿而已（已经因此抓到过四条装饰性断言）。而 LibreOffice 恰好是最不可能装的那一个。
 * 所以容量那几条走两条互补的路：
 *
 *   A. **纯逻辑面**：`engineHasSlot()`（jobs.ts 的准入判据）与 `engineLimit()`
 *      （core/queue.ts 的那张表）**逐引擎逐档对拍**——「复用同一份常量、别抄一份」
 *      的可执行版本。抄了一份自己的表，7b 立刻红。
 *   B. **真 `JobRegistry` + 注入的转换替身**：容量为 1 的 `pdf` 引擎（与
 *      libreoffice / calibre 同一档）上压两条作业，看调度器是不是真的只放一条进去。
 *      替身不进任何子进程，所以结论在任何机器上都一样。
 *
 * `pdf` 这个引擎在 MCP 进程里**本来就跑不成**（`printToPDF` 藏在 Electron 里），
 * 而这一节恰好不需要它真跑——这正是「注入替身」要买的东西。
 */
/**
 * 等一个 job 到终态，返回它的状态。
 *
 * `batch_convert` **立刻返回**（它不等转完），所以「第二轮之前第一轮的产物在不在」
 * 这件事必须显式等——不等的话第二轮解析输出名时磁盘上还是空的，
 * 那条「目标已存在」的断言就永远碰不到它要测的分支（绿得毫无意义）。
 */
async function waitJob(session: Session, jobId: string, timeoutMs = 20000): Promise<string> {
  const started = Date.now()
  let status = ''
  while (Date.now() - started < timeoutMs) {
    status = String((await session.callTool('get_job_status', { job_id: jobId })).structured.status)
    if (status !== 'queued' && status !== 'running') return status
    await sleep(100)
  }
  return status
}

async function section7EngineLimitAndOutputConflict(tmp: string): Promise<void> {
  console.log('\n[7] 按引擎限流（复用 GUI 的 ENGINE_CAPACITY）+ output_path 已存在时当场拒')

  /* ------------------- A：纯逻辑面 —— 容量表就是 GUI 那一份 ------------------- */

  const { engineLimit } = await import('../src/main/core/queue')
  const { engineHasSlot } = await import('../src/mcp/jobs')
  const { ENGINE_KEYS } = await import('@shared/types')

  check(
    '7a 前提：GUI 那张表上 LibreOffice / Calibre 的容量就是 1（MCP 必须照做的那个数字）',
    engineLimit('libreoffice') === 1 && engineLimit('calibre') === 1,
    `libreoffice=${engineLimit('libreoffice')} calibre=${engineLimit('calibre')}`
  )

  // 逐引擎 × 逐档占用量对拍。两侧是**两个不同的来源**（jobs.ts 的判据 vs core/queue.ts
  // 的表），所以这不是同义反复：把容量表抄一份到 jobs.ts 里，或让判据自己写死一个数字，
  // 这里都会红。
  const mismatched: string[] = []
  for (const engine of ENGINE_KEYS) {
    const limit = engineLimit(engine)
    if (!Number.isInteger(limit) || limit < 1) {
      mismatched.push(`${engine}: 容量不是正整数（${String(limit)}）`)
      continue
    }
    for (let used = 0; used <= limit; used += 1) {
      const expected = used + 1 <= limit
      if (engineHasSlot(engine, used, 1) !== expected) {
        mismatched.push(`${engine}: 已占 ${used} 份时判成了 ${String(!expected)}`)
      }
    }
  }
  check(
    `7b ${ENGINE_KEYS.length} 个引擎 × 每一档占用量：MCP 的准入判据与 GUI 的容量表逐格一致`,
    mismatched.length === 0 && ENGINE_KEYS.length > 0,
    mismatched.join(' | ')
  )

  // 「两条 LibreOffice 不会同时跑」在纯逻辑面上的全部内容。**不依赖本机装没装。**
  // 审计点名的那个方向（doc → pdf）落的正是这一档，所以顺便把它一起钉住。
  const { engineFor } = await import('@shared/formats')
  check(
    '7c 容量为 1 的引擎占满之后第二条被拒；且审计点名的 doc → pdf 落的正是这一档',
    engineHasSlot('libreoffice', 0, 1) === true &&
      engineHasSlot('libreoffice', 1, 1) === false &&
      engineHasSlot('calibre', 1, 1) === false &&
      engineFor('doc', 'pdf') === 'libreoffice' &&
      engineLimit(engineFor('doc', 'pdf') ?? 'pdf') === 1,
    `libreoffice 空=${String(engineHasSlot('libreoffice', 0, 1))} 满=${String(engineHasSlot('libreoffice', 1, 1))} doc→pdf=${String(engineFor('doc', 'pdf'))}`
  )
  // 代价夹取：一条 ffmpeg 大文件占 3 份（HEAVY_COST），而「代价大于容量」的任务
  // **不能被饿死**（夹到容量）——它永远排不进去时，在 agent 眼里与「任务卡住了」一样。
  check(
    '7d 代价被夹在 [1, 容量] 之间：代价大于容量的任务照样排得进去（不会被静默饿死）',
    engineHasSlot('libreoffice', 0, 99) === true && engineHasSlot('libreoffice', 1, 99) === false,
    `空=${String(engineHasSlot('libreoffice', 0, 99))} 满=${String(engineHasSlot('libreoffice', 1, 99))}`
  )

  /* ----------- B：output_path 已存在 → 当场拒（走真服务端，端到端） ----------- */

  const dir = join(tmp, 's7')
  const srcDir = join(dir, 'src')
  const out = join(dir, 'out')
  mkdirSync(srcDir, { recursive: true })
  mkdirSync(out, { recursive: true })
  const png = join(srcDir, 'note.png')
  runFfmpeg(
    ['-y', '-f', 'lavfi', '-i', 'color=c=green:s=32x32:d=1', '-frames:v', '1', png],
    '造第 7 节的 PNG'
  )

  const session = startServer({
    ARBITER_USER_DATA: join(dir, 'userdata'),
    ARBITER_DOWNLOADS: dir,
    ARBITER_MCP_WRITE_ROOTS: dir,
    ARBITER_MCP_CONCURRENCY: '1'
  })
  const ready = await waitReady(session)
  check('7e 第 7 节的实例起来了', ready, `stderr=${session.stderrText.slice(0, 200)}`)

  try {
    await session.call('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'arbiter-test', version: '0' }
    })

    const target = join(out, 'report.jpg')
    const first = await session.callTool('convert_file', {
      source: png,
      target_format: 'jpg',
      output_path: target
    })
    check(
      '7f control：先正常转出一次，产物确实落在那个路径上（否则下面那条分不清「被拒」与「本来就没转成」）',
      first.isError === false && first.structured.status === 'done' && existsSync(target),
      `status=${String(first.structured.status)} 产物=${String(existsSync(target))}`
    )
    const before = statSync(target)

    const again = await session.callTool('convert_file', {
      source: png,
      target_format: 'jpg',
      output_path: target
    })
    const againBody = hintOf(again.text)
    check(
      '7g output_path 上已经有一个文件 → output_conflict，且没有悄悄改道写出「report (1).jpg」',
      again.isError &&
        againBody.code === 'output_conflict' &&
        !existsSync(join(out, 'report (1).jpg')) &&
        !existsSync(join(out, 'report (2).jpg')),
      `code=${String(againBody.code)} (1)=${String(existsSync(join(out, 'report (1).jpg')))} text=${again.text.slice(0, 140)}`
    )
    const after = statSync(target)
    check(
      '7h 被拒的那一次一个字节都没动原文件（大小与 mtime 都没变）',
      after.size === before.size && after.mtimeMs === before.mtimeMs,
      `前=${before.size}B/${before.mtimeMs} 后=${after.size}B/${after.mtimeMs}`
    )

    // 审计实测的那个原始形态：路径上躺着的是**别人**的文件（上周的报告），
    // 而不是我们刚产出的。agent 之后去读 `/out/report.pdf` 时会读到**旧内容**
    // 并当成新产物——所以对它的拒绝不是洁癖。
    const victim = join(out, 'victim.jpg')
    writeFileSync(victim, 'PREVIOUS REPORT — do not lose me')
    const victimBefore = readFileSync(victim)
    const onVictim = await session.callTool('convert_file', {
      source: png,
      target_format: 'jpg',
      output_path: victim
    })
    check(
      '7i 路径上躺着的是**旧文件**（审计实测的 victim.jpg）→ 同样拒，且旧文件原封不动',
      onVictim.isError &&
        hintOf(onVictim.text).code === 'output_conflict' &&
        readFileSync(victim).equals(victimBefore) &&
        !existsSync(join(out, 'victim (1).jpg')),
      `isError=${String(onVictim.isError)} 内容未变=${String(readFileSync(victim).equals(victimBefore))} (1)=${String(existsSync(join(out, 'victim (1).jpg')))}`
    )

    // 大小写：Windows 上 `VICTIM.JPG` 与 `victim.jpg` 是**同一个文件**，判据必须经得起。
    // 判据用的是 `existsSync()`，于是它天然与文件系统同口径——而不是与它争论。
    // （这一套本来就只在 Windows 上跑：下面第 25 条用的是 `tasklist`、素材是 `ffmpeg.exe`。）
    const upper = await session.callTool('convert_file', {
      source: png,
      target_format: 'jpg',
      output_path: join(out, 'VICTIM.JPG')
    })
    check(
      '7j 大小写变体也算撞上同一个文件（VICTIM.JPG ≡ victim.jpg）→ 照样拒，且没有 VICTIM (1).JPG',
      upper.isError &&
        hintOf(upper.text).code === 'output_conflict' &&
        !existsSync(join(out, 'VICTIM (1).JPG')),
      `isError=${String(upper.isError)} code=${String(hintOf(upper.text).code)} (1)=${String(existsSync(join(out, 'VICTIM (1).JPG')))}`
    )

    // **对照（这条同样承重）**：批量那条路的落点是**我们**按 `output_dir` + 源文件名
    // 算出来的，不是用户点名的，所以它**不走**上面那条拒绝。对它套用同一条规则，
    // 会让「同一批再转一次」变成整批被拒，而 agent 没有任何办法逐条改名——
    // 那是把一个可恢复的情形做成死路。两条路必须给出不同的答案，所以这里要显式钉住。
    //
    // ⚠️ 两处细节是承重的，缺一个这条断言就变成空转（第一版两个都缺，绿得毫无意义）：
    //
    //  1. **`output_dir` 选源文件所在的那个目录**。`batch_convert` 交下来的 `outputPath`
    //     其实是「`<output_dir>/<源文件名>`」——注意它带的是**源的那个扩展名**，
    //     不是目标格式的。所以只有当源就在输出目录里（就地转格式）时，
    //     `existsSync(outputPath)` 才为真、这条断言才碰得到那个判据；
    //     输出目录是别处时它天然为假，改不改 `outputComputed` 都一个样
    //     （这一点我实测过：把 server.ts 那个 `outputComputed` 改成 `false`，
    //     第一版断言照样全绿）。
    //  2. **第二轮必须在第一轮落定之后才发**（`waitJob` 就是干这个的）。连着发的话，
    //     第二轮解析输出名时第一轮的产物还没写出来，测到的只是 `claimed` 那条避让路径。
    const batchOut = srcDir
    const batchRounds: { jobId: string; rejected: number }[] = []
    for (let round = 0; round < 2; round += 1) {
      const batch = await session.callTool('batch_convert', {
        sources: [png],
        target_format: 'jpg',
        output_dir: batchOut
      })
      const rejectedNow = (batch.structured.rejected ?? []) as unknown[]
      const firstJob = ((batch.structured.submitted ?? []) as { job_id: string }[])[0]
      batchRounds.push({ jobId: firstJob?.job_id ?? '', rejected: rejectedNow.length })
      if (firstJob !== undefined) await waitJob(session, firstJob.job_id)
    }
    // 防空转的前提：源文件自己在那个目录里（也就是 `outputPath` 上确实有东西），
    // 否则下面两条证明不了「批量的落点规则与点名那条不同」——它们只会证明
    // 「没有冲突的时候不冲突」。
    check(
      '7k control：批量要求写的那个路径上确实已经有一个文件（源自己），冲突条件成立',
      existsSync(png) && existsSync(join(batchOut, 'note.png')),
      `源=${String(existsSync(png))} 输出目录里的同名源=${String(existsSync(join(batchOut, 'note.png')))}`
    )
    check(
      '7l 批量两轮都入队、一轮都没被拒：它的落点是**我们**算的，不套用「点名」那条拒绝规则',
      batchRounds.length === 2 && batchRounds.every((round) => round.rejected === 0),
      `两轮的 rejected = ${JSON.stringify(batchRounds.map((r) => r.rejected))}`
    )
    check(
      '7lb 对照：两轮产物并存（note.jpg 与 note (1).jpg），而**点名**那条路同一个条件下是拒绝',
      existsSync(join(batchOut, 'note.jpg')) && existsSync(join(batchOut, 'note (1).jpg')),
      `目录=${JSON.stringify(readdirSync(batchOut))}`
    )
  } finally {
    await session.close()
  }

  /* ------ C：真 JobRegistry + 注入的转换替身：引擎容量真的在调度里生效 ------ */

  const { setAppPaths } = await import('../src/main/core/appPaths')
  const { JobRegistry } = await import('../src/mcp/jobs')

  // `core/appPaths.ts` 是**注入式**的（刻意不 import electron），所以在进程内就能装一份。
  // 这一节只用到「设置 / 输出目录怎么算」，不碰引擎解析 → 不需要任何真引擎。
  const registryRoot = join(tmp, 's7-registry')
  const regSrc = join(registryRoot, 'src')
  mkdirSync(regSrc, { recursive: true })
  mkdirSync(join(registryRoot, 'userdata'), { recursive: true })
  mkdirSync(join(registryRoot, 'downloads'), { recursive: true })
  setAppPaths({
    isPackaged: false,
    resourcesPath: '',
    appPath: REPO,
    userData: join(registryRoot, 'userdata'),
    downloads: join(registryRoot, 'downloads')
  })

  const pngA = join(regSrc, 'a.png')
  const pngB = join(regSrc, 'b.png')
  copyFileSync(png, pngA)
  copyFileSync(png, pngB)
  // mp4 那两个只是**存在且够小**（走 taskCost 的快车道），替身根本不解码它们。
  const mp4A = join(regSrc, 'a.mp4')
  const mp4B = join(regSrc, 'b.mp4')
  writeFileSync(mp4A, 'not really an mp4\n')
  writeFileSync(mp4B, 'not really an mp4\n')

  /**
   * 注入的转换替身：**不进任何子进程**，只记「这个目标格式上同时有几条在跑、峰值是多少」。
   *
   * 记峰值而不是某一瞬间采样，是因为「同时」二字是承重的：只看一次采样的话，
   * 一次错开的 10ms 重叠会被漏过去（本项目在这一类断言上吃过亏）。
   */
  const overlap = new Map<string, { active: number; peak: number }>()
  const registry = new JobRegistry(8, async (context) => {
    const row = overlap.get(context.toExt) ?? { active: 0, peak: 0 }
    overlap.set(context.toExt, row)
    row.active += 1
    row.peak = Math.max(row.peak, row.active)
    try {
      await sleep(500)
    } finally {
      row.active -= 1
    }
  })

  // 容量为 1 的引擎（`pdf`，与 libreoffice / calibre 同一档）。`maxRunning` 给到 8，
  // 于是**唯一可能挡住第二条的就是引擎容量**——全局上限这时离得很远。
  const pdfA = registry.submit({ source: pngA, toExt: 'pdf' })
  const pdfB = registry.submit({ source: pngB, toExt: 'pdf' })
  check(
    '7m 前提：这两条确实落在容量为 1 的引擎上（否则下面测的不是那张表）',
    pdfA.engine === 'pdf' && pdfB.engine === 'pdf' && engineLimit('pdf') === 1,
    `engine=${pdfA.engine}/${pdfB.engine} 容量=${engineLimit('pdf')}`
  )
  // 这一步是**确定性**的，不靠 sleep 去赌：`submit()` 是同步的，
  // 第一条在 `pump()` 里当场进 `running`，第二条被容量挡住、留在 `queued`。
  check(
    '7n 容量为 1 的引擎上：第一条在跑，第二条还在排队（两条 LibreOffice 不会同时被拉起）',
    pdfA.status === 'running' && pdfB.status === 'queued',
    `第一条=${pdfA.status} 第二条=${pdfB.status}`
  )

  // 对照：容量够的引擎（ffmpeg，12 份）上两条**必须**同时开跑。少了这一条，
  // 「一次只准跑一条」这种把整个队列串行化的改坏也能让 7n 全绿。
  const ffA = registry.submit({ source: mp4A, toExt: 'webm' })
  const ffB = registry.submit({ source: mp4B, toExt: 'webm' })
  check(
    '7o 对照：容量够的引擎上两条同时开跑（7n 拒的是「这个引擎满了」，不是「一次只准跑一条」）',
    ffA.engine === 'ffmpeg' &&
      ffB.engine === 'ffmpeg' &&
      ffA.status === 'running' &&
      ffB.status === 'running',
    `engine=${ffA.engine}/${ffB.engine} 状态=${ffA.status}/${ffB.status}`
  )

  await Promise.all([pdfA, pdfB, ffA, ffB].map((job) => registry.waitFor(job.id, { pollMs: 20 })))
  check(
    '7p 全程并发峰值：容量为 1 的引擎上是 1，容量为 12 的引擎上是 2（判据是峰值，不是采样）',
    overlap.get('pdf')?.peak === 1 && overlap.get('webm')?.peak === 2,
    `pdf=${JSON.stringify(overlap.get('pdf'))} webm=${JSON.stringify(overlap.get('webm'))}`
  )

  // **份数分档**（`taskCost()` 的 HEAVY_COST）：ffmpeg 的输入若大于 1 MiB 就占 **3 份**，
  // 于是容量 12 份最多同时跑 4 条大文件。这条**不是**「容量表生效吗」的复述——
  // 它问的是另一件事：份数有没有真的**按体积算出来并记进那本账**。
  // 少了它，「所有任务一律占 1 份」这种改坏不会被任何断言发现。
  // 5 条一起提交、状态当场可读（`submit()` 是同步的），所以依然不靠 sleep 赌。
  const heavyPaths: string[] = []
  for (let i = 0; i < 5; i += 1) {
    const heavyPath = join(regSrc, `heavy-${i}.mp4`)
    // 2 MiB：越过 FAST_LANE_MAX_BYTES（1 MiB）即可，内容是什么无所谓——替身不解码。
    writeFileSync(heavyPath, Buffer.alloc(2 * 1024 * 1024, 0x41))
    heavyPaths.push(heavyPath)
  }
  // 目标钉成 `mkv` 而不是上面那个 `webm`：让 7r 的峰值是一张**干净**的账，
  // 不必去减上一批留下的数。
  const heavyJobs = heavyPaths.map((source) => registry.submit({ source, toExt: 'mkv' }))
  check(
    '7q 份数分档生效：容量 12 份 ÷ 每条大文件 3 份 = 最多 4 条同时跑，第 5 条排队',
    heavyJobs.filter((job) => job.status === 'running').length === 4 &&
      heavyJobs.filter((job) => job.status === 'queued').length === 1,
    `状态=${heavyJobs.map((job) => job.status).join(',')}`
  )
  await Promise.all(heavyJobs.map((job) => registry.waitFor(job.id, { pollMs: 20 })))
  check(
    '7r 那批大文件的并发峰值正好是 4（不是 5、也不是 1）',
    overlap.get('mkv')?.peak === 4,
    JSON.stringify(overlap.get('mkv'))
  )
}

/* ============================= 第 8 节：E-6 产物自检 ============================= */

/**
 * E-6 的验收现场。三件事各在一个层面上验，因为它们在别处都看不见：
 *
 *  1. **真转换 + 真自检**（走真 server 子进程 + JSON-RPC）：`verify: true` 时返回里有一个
 *     `status: consistent` 的 `verification`；**不传时连键都没有**（默认关是可观测的）。
 *  2. **音轨那一条真事实**：带音轨的 mp4 → gif，自检必须报出「产物没有音轨，而源有」。
 *     它既是整个自检里最值钱的一条，又**不是故障**——换个目标格式就必然如此。这正是
 *     「只报事实、不做判断」的用处：agent 拿到事实，判断留给它和用户。
 *  3. **关掉时一个额外子进程都不起**：这一条在进程外看不见（理由见子进程计数器那段），
 *     所以在**进程内**用真 `JobRegistry` + 一个不 spawn 的转换替身来数，判据是 0 与 2。
 */
async function section8SelfCheck(tmp: string): Promise<void> {
  console.log('\n[8] 产物自检（E-6）')

  const root = join(tmp, 's8')
  const src = join(root, 'src')
  const out = join(root, 'out')
  mkdirSync(src, { recursive: true })
  mkdirSync(out, { recursive: true })
  // `batch_convert` 的 output_dir **得先存在**：那一路只管算落点，不负责建目录
  // （GUI 那条路上目录是用户在界面上选的，一定存在）。少了这一行，下面那批会全部
  // 失败在「写不进去」上，而那时的红会指错方向。
  mkdirSync(join(out, 'batch'), { recursive: true })
  mkdirSync(join(root, 'userdata'), { recursive: true })
  mkdirSync(join(root, 'downloads'), { recursive: true })

  // 素材**必须有音轨**：自检要回答「音轨还在不在」，源里没有音轨就无从谈起
  // （而「有音轨的源」恰好是这条功能唯一的鉴别力所在）。`-f lavfi` 的 sine 是合成源，
  // 不依赖任何外部素材；整段 12KB、转起来几十毫秒。
  const talkie = join(src, 'talkie.mp4')
  runFfmpeg(
    [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc=d=1:s=64x48:r=10',
      '-f',
      'lavfi',
      '-i',
      'sine=f=440:d=1',
      '-shortest',
      '-pix_fmt',
      'yuv420p',
      '-c:v',
      'libx264',
      '-c:a',
      'aac',
      talkie
    ],
    '造带音轨的 mp4'
  )

  const session = startServer({
    ARBITER_USER_DATA: join(root, 'userdata'),
    ARBITER_DOWNLOADS: root,
    ARBITER_MCP_WRITE_ROOTS: root,
    ARBITER_MCP_CONCURRENCY: '1'
  })
  const ready = await waitReady(session)
  check('8a 第 8 节的实例起来了', ready, `stderr=${session.stderrText.slice(0, 200)}`)

  // 详情串用。⚠️ `JSON.stringify(undefined)` 返回的是 **`undefined` 而不是字符串**，
  // 直接 `.slice()` 会把整个套件崩在半路（表现是「后面一条断言都没红」——而那与
  // 「断言抓不住错误」在输出上一模一样）。凡是 detail 里可能为 undefined 的地方都走它。
  const brief = (value: unknown): string => JSON.stringify(value ?? null).slice(0, 240)

  try {
    await session.call('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'arbiter-test', version: '0' }
    })

    /* ------------------------------------------- 真转换 + 真自检：报「一致」 */

    const verified = await session.callTool('convert_file', {
      source: talkie,
      target_format: 'mkv',
      output_path: join(out, 'talkie.mkv'),
      verify: true
    })
    const verification = verified.structured.verification as Record<string, unknown> | undefined
    check(
      '8b 真转换 + verify: true → 自检报 consistent，且五项都查了（分辨率 / 编解码器 / 音轨 / 视频流 / 时长）',
      verified.isError === false &&
        verified.structured.status === 'done' &&
        verification !== undefined &&
        verification.status === 'consistent' &&
        JSON.stringify(verification.checked) ===
          JSON.stringify(['resolution', 'video_codec', 'audio', 'video_stream', 'duration']) &&
        Array.isArray(verification.facts) &&
        (verification.facts as string[]).some((f) => f.includes('分辨率 64x48')),
      `status=${String(verification?.status)} checked=${JSON.stringify(
        verification?.checked
      )} facts=${JSON.stringify(verification?.facts)}`
    )
    // 自检把**两侧**都量了（源与产物各一份），不是只读产物就下结论——
    // 少了源那一半，「和源一致」这句话无从谈起。
    check(
      '8c verification 里源与产物两份实测都在（不是只探了产物）',
      (verification?.source as Record<string, unknown> | undefined)?.probe !== null &&
        (verification?.output as Record<string, unknown> | undefined)?.probe !== null &&
        (verification?.source as Record<string, unknown> | undefined)?.path === talkie,
      brief({ source: verification?.source, output: verification?.output })
    )

    /* ------------------------------------------------ 默认关：键根本不出现 */

    const unverified = await session.callTool('convert_file', {
      source: talkie,
      target_format: 'mkv',
      output_path: join(out, 'talkie-again.mkv')
    })
    check(
      '8d 不传 verify（默认关）→ 返回里**连 verification 这个键都没有**，而同一个工具 + 同一个源开了就有',
      unverified.isError === false &&
        unverified.structured.status === 'done' &&
        !('verification' in unverified.structured) &&
        'verification' in verified.structured,
      `关=${JSON.stringify(Object.keys(unverified.structured))}`
    )

    /* -------------------------------------------------- 音轨：真事实（gif） */

    const toGif = await session.callTool('convert_file', {
      source: talkie,
      target_format: 'gif',
      output_path: join(out, 'talkie.gif'),
      verify: true
    })
    const gifCheck = toGif.structured.verification as Record<string, unknown> | undefined
    const gifComparison = (gifCheck?.comparison ?? {}) as Record<string, unknown>
    check(
      '8e 带音轨的 mp4 → gif：自检报 differs，并说出「产物没有音轨，而源有」这条事实',
      toGif.isError === false &&
        gifCheck?.status === 'differs' &&
        gifComparison.audio_lost === true &&
        ((gifCheck?.facts ?? []) as string[]).includes('产物没有音轨，而源有'),
      `status=${String(gifCheck?.status)} facts=${JSON.stringify(gifCheck?.facts)}`
    )
    // 判据宽的那一半，在真产物上验一遍：gif 没有时长，这一项必须是**没查**
    // （`comparable: false`、`delta: null`），而不是被算成差异或被编一个数出来。
    check(
      '8f 同一次自检里，时长那一项是「没查」而不是「不一致」（gif 报不出时长，那不该算差异）',
      gifCheck !== undefined &&
        gifComparison.duration_comparable === false &&
        gifComparison.duration_delta_sec === null &&
        !((gifCheck.facts ?? []) as string[]).some((f) => f.startsWith('时长')),
      JSON.stringify(gifComparison)
    )
    check(
      '8g 真产物那一侧：图片出口没有视频流，但自检没把它算成「丢了视频流」',
      gifComparison.video_lost === null &&
        !((gifCheck?.checked ?? []) as string[]).includes('video_stream'),
      `checked=${JSON.stringify(gifCheck?.checked)} video_lost=${JSON.stringify(
        gifComparison.video_lost
      )}`
    )

    /* ------------------------------------ 结果从哪读：完整那份 vs 结论那一份 */

    const jobId = String(verified.structured.job_id)
    const status = await session.callTool('get_job_status', { job_id: jobId })
    check(
      '8h get_job_status 给的是**同一份**自检（不是「只有当场那条路才有」）',
      (status.structured.verification as Record<string, unknown> | undefined)?.status ===
        'consistent',
      brief(status.structured.verification)
    )
    const listed = await session.callTool('list_jobs', { limit: 20 })
    const rows = (listed.structured.jobs ?? []) as Record<string, unknown>[]
    const verifiedRow = rows.find((row) => row.job_id === jobId)
    const plainRow = rows.find((row) => row.job_id === String(unverified.structured.job_id))
    check(
      '8i list_jobs 只给结论（verification_status），**不给完整的事实清单**（理由与 log_tail 一字不差）',
      verifiedRow?.verification_status === 'consistent' &&
        'verification' in (verifiedRow ?? {}) === false &&
        plainRow !== undefined &&
        !('verification_status' in plainRow),
      `有自检的那条=${JSON.stringify(verifiedRow)} 没自检的那条=${JSON.stringify(plainRow)}`
    )

    /* -------------------------------- batch_convert：开关也得传下去（否则哑参数） */

    const copy = join(src, 'talkie-copy.mp4')
    copyFileSync(talkie, copy)
    const batch = await session.callTool('batch_convert', {
      sources: [copy],
      target_format: 'mkv',
      output_dir: join(out, 'batch'),
      verify: true
    })
    const submitted = (batch.structured.submitted ?? []) as Record<string, unknown>[]
    const batchJobId = String(submitted[0]?.job_id ?? '')
    const batchStatus = await waitJob(session, batchJobId)
    const batchView = await session.callTool('get_job_status', { job_id: batchJobId })
    check(
      '8j batch_convert 也把 verify 传下去了（这条路上它不能是个哑参数）',
      batch.isError === false &&
        submitted.length === 1 &&
        batchStatus === 'done' &&
        (batchView.structured.verification as Record<string, unknown> | undefined)?.status ===
          'consistent',
      `status=${batchStatus} verification=${brief(batchView.structured.verification)} rejected=${JSON.stringify(
        batch.structured.rejected
      )}`
    )
  } finally {
    await session.close()
  }

  /* -------- 关掉时一个额外子进程都不起（进程内：数 spawn） -------- */

  // 与第 7 节 C 段同一个套路：**真 `JobRegistry` + 注入一个不进任何子进程的转换替身**
  // （只把源复制到产物），于是这一段里除自检之外**没有任何东西会 spawn**——spawn 计数
  // 就是自检自己的开销。替身不能是「真的跑一次转换」：那样转换自己的 ffmpeg
  // 会混进计数，0 与 2 就分不出来了。
  const { setAppPaths } = await import('../src/main/core/appPaths')
  const { JobRegistry } = await import('../src/mcp/jobs')
  const regRoot = join(root, 's8-registry')
  const regSrc = join(regRoot, 'src')
  const regOut = join(regRoot, 'out')
  mkdirSync(regSrc, { recursive: true })
  mkdirSync(regOut, { recursive: true })
  mkdirSync(join(regRoot, 'userdata'), { recursive: true })
  mkdirSync(join(regRoot, 'downloads'), { recursive: true })
  // `core/appPaths.ts` 是注入式的（刻意不 import electron），进程内就能装一份。
  // 这一节要**真探针**（自检读的必须是真的 ffmpeg），所以 `appPath` 指仓库根，
  // 让 `ffmpegPath()` 按开发期那条路解析到 ffmpeg-static。
  setAppPaths({
    isPackaged: false,
    resourcesPath: '',
    appPath: REPO,
    userData: join(regRoot, 'userdata'),
    downloads: join(regRoot, 'downloads')
  })

  const copied = join(regSrc, 'clip.mp4')
  copyFileSync(talkie, copied)
  const registry = new JobRegistry(4, async (context) => {
    // 替身：产物是源的副本，内容与源一模一样（所以真自检应当报 consistent）。
    copyFileSync(context.input, context.output)
  })

  const off = await countSpawns(async () => {
    const job = registry.submit({
      source: copied,
      toExt: 'mkv',
      outputPath: join(regOut, 'off.mkv')
    })
    await registry.waitFor(job.id, { pollMs: 20 })
    return job
  })
  check(
    '8k verify 关着（默认）时：整个 job 生命周期里**一个子进程都没起**（精确的 0）',
    off.result.status === 'done' && off.count === 0 && off.result.verification === undefined,
    `起了 ${off.count} 个（${off.what.join(', ')}），status=${off.result.status}`
  )

  // ⚠️ 这一半是**防空转的**：计数器没接上（比如 tsx 那边换成了命名空间拷贝）时，
  // 8k 会以「0 个」的形式假绿。所以「开着时必须正好是 2」要有它自己的一条断言。
  const on = await countSpawns(async () => {
    const job = registry.submit({
      source: copied,
      toExt: 'mkv',
      outputPath: join(regOut, 'on.mkv'),
      verify: true
    })
    await registry.waitFor(job.id, { pollMs: 20 })
    return job
  })
  check(
    '8l verify 开着时：正好多起**两个**子进程（源一个、产物一个）——8k 那个 0 因此不是计数器没接上',
    on.result.status === 'done' &&
      on.count === 2 &&
      on.result.verification?.status === 'consistent',
    `起了 ${on.count} 个（${on.what.join(', ')}），自检=${JSON.stringify(
      on.result.verification?.status
    )}`
  )
}

/* ==================== 第 9 节：dry_run（E-5，动手之前一次说清） ==================== */

/**
 * 这一节要证的，全部是**可观测**的，而不是「代码看起来对」：
 *
 *  1. **`claimed` 一个字都没被动过**——先 dry run、再真跑同一个落点，产物名必须与
 *     「不带 dry_run」时**逐字相同**（不许出现 `(1)`）。这是本功能最容易踩的一脚，
 *     而且踩了**不报错**：占名发生在 `jobs.ts` 的 `claimed` 里，肉眼看不见，
 *     受害者是随后那条真实任务（它的产物被悄悄改了名）。
 *  2. **预览与执行给出同一个答案**——能转的那一对，落点逐字相同；不能转的那几对，
 *     **报错逐字相同**（判据是「同一个错误」，不是「都失败了」）。三对分别打矩阵、
 *     `output_conflict`、路径闸门三条不同的校验分支。
 *  3. **零副作用三条分别断言**：不建 job、产物目录里不多一个文件、落点上没有产物。
 *     三条各问一次，而不是合成一句「什么都没变」——后者在某一处失效时仍然绿。
 *
 * ⚠️ 凡「不变 / 不存在」型的判据都带非空前提（`total > 0`、目录非空）：本仓库已经
 * 抓到过四条在空集合上恒真的装饰性断言，而那类断言绿得毫无信息。
 */
async function section9DryRun(tmp: string): Promise<void> {
  console.log('\n[9] dry_run：预览与执行共用同一条路')

  const root = join(tmp, 's9')
  const src = join(root, 'src')
  const out = join(root, 'out')
  for (const dir of [src, out, join(root, 'userdata')]) mkdirSync(dir, { recursive: true })

  // 素材两种都要：
  //  - png → sharp（不惊动任何引擎子进程），用来验落点、零副作用与 `claimed`；
  //  - mp4（h264+aac）→ 用来验代价三件套与 `inspect_file` 逐字对得上
  //    （那条路的 estimate 置信度是 high，正是最容易被「另算一套」写歪的地方）。
  const png = join(src, 'pic.png')
  const mp4 = join(src, 'clip.mp4')
  runFfmpeg(
    ['-y', '-f', 'lavfi', '-i', 'color=c=red:s=64x48:d=1', '-frames:v', '1', png],
    '第 9 节：造 PNG'
  )
  runFfmpeg(
    [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc=size=160x120:rate=15',
      '-t',
      '1',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      mp4
    ],
    '第 9 节：造 MP4'
  )

  const session = startServer({
    ARBITER_USER_DATA: join(root, 'userdata'),
    ARBITER_DOWNLOADS: root,
    ARBITER_MCP_WRITE_ROOTS: root,
    ARBITER_MCP_CONCURRENCY: '1'
  })
  const ready = await waitReady(session)
  check('9a 第 9 节的实例起来了', ready, `stderr=${session.stderrText.slice(0, 200)}`)

  // detail 里可能为 undefined 时统一走它（`JSON.stringify(undefined)` 返回的是
  // `undefined` 而不是字符串，直接 `.slice()` 会把套件崩在半路——与第 8 节同一个坑）。
  const brief = (value: unknown): string => JSON.stringify(value ?? null).slice(0, 240)

  try {
    await session.call('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'arbiter-test', version: '0' }
    })

    /* -------- 先把 out 目录弄成非空的：空目录上「没多一个文件」是恒真的 -------- */

    const seed = await session.callTool('convert_file', {
      source: png,
      target_format: 'jpg',
      output_path: join(out, 'seed.jpg')
    })
    check(
      '9b 前提：先真跑一次把 out 目录弄成非空的（否则 9k 那条「没多一个文件」是空转）',
      seed.isError === false && existsSync(join(out, 'seed.jpg')),
      `status=${String(seed.structured.status)}`
    )
    const jobsBefore = await totalJobs(session)
    const outBefore = readdirSync(out).sort()
    check(
      '9c 前提：登记表非空、out 非空（两条快照都得有内容，后面那些「不变」才不是恒真）',
      jobsBefore > 0 && outBefore.length > 0,
      `jobs=${jobsBefore} out=${JSON.stringify(outBefore)}`
    )

    /* -------------------------------- 预览本身：形状与内容 -------------------------------- */

    const plannedPath = join(out, 'planned.jpg')
    const planned = await session.callTool('convert_file', {
      source: png,
      target_format: 'jpg',
      output_path: plannedPath,
      dry_run: true
    })
    const plan = planned.structured
    check(
      '9d dry_run 交回来的是「一份说明」而不是一个 job：dry_run=true，且没有 job_id / status',
      planned.isError === false &&
        plan.dry_run === true &&
        plan.job_id === undefined &&
        plan.status === undefined,
      brief(plan)
    )
    check(
      '9e 落点就是点名的 output_path，而**此刻磁盘上还没有它**',
      plan.output === plannedPath && !existsSync(plannedPath),
      `output=${String(plan.output)} 存在=${existsSync(plannedPath)}`
    )
    check(
      '9f from / to / engine 与真跑是同一套值（png → jpg 走 sharp）',
      plan.from === 'png' && plan.to === 'jpg' && plan.engine === 'sharp',
      `from=${String(plan.from)} to=${String(plan.to)} engine=${String(plan.engine)}`
    )
    const planCost = (plan.cost ?? {}) as Record<string, unknown>
    const planEstimate = plan.estimate as { seconds?: unknown; confidence?: unknown } | null
    check(
      '9g 代价三件套齐全且形状对：cost（png 不惊动引擎 → download_bytes=0）、lossy=true、estimate 是二元组区间 + 闭集里的 confidence',
      typeof plan.cost === 'object' &&
        plan.cost !== null &&
        planCost.engine === null &&
        planCost.download_bytes === 0 &&
        planCost.network_required === false &&
        plan.lossy === true &&
        Array.isArray(planEstimate?.seconds) &&
        (planEstimate?.seconds as number[]).length === 2 &&
        (planEstimate?.seconds as number[])[0]! <= (planEstimate?.seconds as number[])[1]! &&
        ['high', 'medium', 'low'].includes(String(planEstimate?.confidence)),
      `cost=${JSON.stringify(planCost)} lossy=${String(plan.lossy)} estimate=${brief(planEstimate)}`
    )
    check(
      '9h note 恒非空、且第一句就说明「只预览、什么都没做」（模型据此才知道还要再真跑一次）',
      typeof plan.note === 'string' && plan.note.includes('只预览') && plan.note.length > 20,
      brief(plan.note)
    )

    /* ------------------------- 零副作用三条 + claimed 没被动过 ------------------------- */

    const again = await session.callTool('convert_file', {
      source: png,
      target_format: 'jpg',
      output_path: plannedPath,
      dry_run: true
    })
    check(
      '9i 连做两次 dry run：两次落点**逐字相同**（预览不会被自己上一次的结论影响）',
      again.structured.output === plan.output,
      `第一次=${String(plan.output)} 第二次=${String(again.structured.output)}`
    )

    const jobsAfter = await totalJobs(session)
    const outAfter = readdirSync(out).sort()
    check(
      '9j 副作用①：dry run 不建 job——list_jobs 的 total 一条都没多（防空转：前后都 > 0）',
      jobsBefore > 0 && jobsAfter === jobsBefore,
      `前=${jobsBefore} 后=${jobsAfter}`
    )
    check(
      '9k 副作用②：产物目录里不多一个文件——条目清单逐字相同（防空转：清单非空）',
      outBefore.length > 0 && JSON.stringify(outAfter) === JSON.stringify(outBefore),
      `前=${JSON.stringify(outBefore)} 后=${JSON.stringify(outAfter)}`
    )
    check(
      '9l 副作用③：落点上既没有产物、也没有 `.part` 残渣',
      !existsSync(plannedPath) && !readdirSync(out).some((name) => name.includes('planned')),
      `planned.jpg=${existsSync(plannedPath)} out=${JSON.stringify(readdirSync(out))}`
    )

    // ⭐ 这一节最值钱的一条：预览**没有**把那个名字占住。
    // 判据是「真跑的落点与预览逐字相同」——占了名的话，`resolveOutput` 的避让
    // 会把真跑挤成 `planned (1).jpg`，而它照样 `status: done`、照样不报错。
    const real = await session.callTool('convert_file', {
      source: png,
      target_format: 'jpg',
      output_path: plannedPath
    })
    check(
      '9m ⭐ 预览之后真跑同一个落点：产物就在预览说的那个路径上，**没有被挤成 `planned (1).jpg`**',
      real.isError === false &&
        real.structured.output === plan.output &&
        existsSync(plannedPath) &&
        !existsSync(join(out, 'planned (1).jpg')),
      `真跑=${String(real.structured.output)} 预览=${String(plan.output)} ` +
        `(1) 产物=${existsSync(join(out, 'planned (1).jpg'))}`
    )

    /* -------------------- 不给 output_path 的那条路（自动避让就发生在这一支） -------------------- */

    const besideDry = await session.callTool('convert_file', {
      source: png,
      target_format: 'jpg',
      dry_run: true
    })
    const besidePath = join(src, 'pic.jpg')
    check(
      '9n 不给 output_path 时预览落在源文件旁边，且此刻磁盘上还没有它',
      besideDry.structured.output === besidePath && !existsSync(besidePath),
      `output=${String(besideDry.structured.output)} 期望=${besidePath}`
    )
    const besideReal = await session.callTool('convert_file', { source: png, target_format: 'jpg' })
    check(
      '9o ⭐ 同一条路真跑：产物名与预览**逐字相同**，源目录里没有 `pic (1).jpg`',
      besideReal.isError === false &&
        besideReal.structured.output === besideDry.structured.output &&
        existsSync(besidePath) &&
        !existsSync(join(src, 'pic (1).jpg')),
      `真跑=${String(besideReal.structured.output)} 预览=${String(besideDry.structured.output)} ` +
        `(1) 产物=${existsSync(join(src, 'pic (1).jpg'))}`
    )

    /* ---------------------- 预览与执行报的是**同一个错**（三条不同分支） ---------------------- */

    const badDry = await session.callTool('convert_file', {
      source: png,
      target_format: 'docx',
      dry_run: true
    })
    const badReal = await session.callTool('convert_file', { source: png, target_format: 'docx' })
    check(
      '9p 矩阵里没有的组合：预览说不行、真跑也报**同一个**错——两段文本逐字相同（不是「都失败了」）',
      badDry.isError === true &&
        badReal.isError === true &&
        badDry.text === badReal.text &&
        hintOf(badDry.text).code === 'target_not_supported',
      `逐字相同=${badDry.text === badReal.text} code=${String(hintOf(badDry.text).code)}`
    )

    // `output_path` 指向一个已存在的目录：`resolveOutput` 里那条「当场拒」的分支。
    const takenDir = join(out, 'taken.jpg')
    mkdirSync(takenDir, { recursive: true })
    const dirDry = await session.callTool('convert_file', {
      source: png,
      target_format: 'jpg',
      output_path: takenDir,
      dry_run: true
    })
    const dirReal = await session.callTool('convert_file', {
      source: png,
      target_format: 'jpg',
      output_path: takenDir
    })
    check(
      '9q output_path 给成一个已存在的目录：预览与真跑报同一个 output_conflict（逐字相同），且没有静默写出 `taken (1).jpg`',
      dirDry.isError === true &&
        dirReal.isError === true &&
        dirDry.text === dirReal.text &&
        hintOf(dirDry.text).code === 'output_conflict' &&
        statSync(takenDir).isDirectory() &&
        !existsSync(join(out, 'taken (1).jpg')),
      `code=${String(hintOf(dirDry.text).code)} 逐字相同=${dirDry.text === dirReal.text}`
    )

    // 路径闸门：**预览也照走写路径闸门**。不照走的话，agent 会从一次「预览成功」
    // 里得出「这条路走得通」，然后被真跑那句拒绝打回来——那正是 E-5 要堵的分家。
    const escapeDry = join(REPO, 'scripts', 'escape-dry.jpg')
    rmSync(escapeDry, { force: true })
    const gateDry = await session.callTool('convert_file', {
      source: png,
      target_format: 'jpg',
      output_path: escapeDry,
      dry_run: true
    })
    const gateReal = await session.callTool('convert_file', {
      source: png,
      target_format: 'jpg',
      output_path: escapeDry
    })
    const gateWritten = existsSync(escapeDry)
    check(
      '9r 写根之外：预览与真跑报同一个 path_not_allowed（逐字相同），而且那个文件一个字节都没被写出来',
      gateDry.isError === true &&
        gateReal.isError === true &&
        gateDry.text === gateReal.text &&
        hintOf(gateDry.text).code === 'path_not_allowed' &&
        !gateWritten,
      `code=${String(hintOf(gateDry.text).code)} 逐字相同=${gateDry.text === gateReal.text} 被写出来=${gateWritten}`
    )
    rmSync(escapeDry, { force: true })

    /* ------------------- 三件套就是 inspect_file 的那一份（不是另算一套） ------------------- */

    const { defaultTargetFor } = await import('@shared/formats')
    check(
      '9s 前提：mp4 的默认目标是 mkv（下面那条对拍只在「请求的目标 == 默认目标」时才有意义）',
      defaultTargetFor('mp4') === 'mkv',
      `实际=${String(defaultTargetFor('mp4'))}`
    )
    const inspected = await session.callTool('inspect_file', { path: mp4 })
    const dryMkv = await session.callTool('convert_file', {
      source: mp4,
      target_format: 'mkv',
      dry_run: true
    })
    check(
      '9t 同一目标下：dry_run 的 cost / lossy / estimate 与 inspect_file 的**逐字相同**（E-3 那份实现，不是照抄一遍）',
      JSON.stringify(dryMkv.structured.cost) === JSON.stringify(inspected.structured.cost) &&
        dryMkv.structured.lossy === inspected.structured.lossy &&
        JSON.stringify(dryMkv.structured.estimate) ===
          JSON.stringify(inspected.structured.estimate),
      `dry=${JSON.stringify({
        cost: dryMkv.structured.cost,
        lossy: dryMkv.structured.lossy,
        estimate: dryMkv.structured.estimate
      })} inspect=${JSON.stringify({
        cost: inspected.structured.cost,
        lossy: inspected.structured.lossy,
        estimate: inspected.structured.estimate
      })}`
    )
    const dryGif = await session.callTool('convert_file', {
      source: mp4,
      target_format: 'gif',
      dry_run: true
    })
    check(
      '9u 换个目标就换个答案：mp4→gif 的 lossy 是 true（gif 必须过调色板重编码），而 mkv 那条是 false——lossy 按方向判，不是常量',
      dryGif.structured.lossy === true && dryMkv.structured.lossy === false,
      `gif=${String(dryGif.structured.lossy)} mkv=${String(dryMkv.structured.lossy)}`
    )

    /* ---------------------- mode 与 estimate 的口径（预览说得出的那一部分） ---------------------- */

    const remuxDry = await session.callTool('convert_file', {
      source: mp4,
      target_format: 'webm',
      mode: 'remux',
      dry_run: true
    })
    check(
      '9v mode=remux 而容器装不下时：预览**仍然成功**（那是一对合法组合），但 note 点名「真跑会直接失败、不会回退成重编码」',
      remuxDry.isError === false &&
        String(remuxDry.structured.note).includes('remux') &&
        String(remuxDry.structured.note).includes('直接失败'),
      brief(remuxDry.structured.note)
    )
    const remuxReal = await session.callTool('convert_file', {
      source: mp4,
      target_format: 'webm',
      mode: 'remux',
      output_path: join(out, 'remux.webm')
    })
    check(
      '9w 对照：同一组参数真跑确实失败（所以 9v 那句预兆不是空话），且没有留下产物',
      remuxReal.isError === true &&
        remuxReal.text.includes('重封装') &&
        !existsSync(join(out, 'remux.webm')),
      `isError=${remuxReal.isError} 产物=${existsSync(join(out, 'remux.webm'))} text=${remuxReal.text.slice(0, 160)}`
    )
  } finally {
    await session.close()
  }
}

void main()
