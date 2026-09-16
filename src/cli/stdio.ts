/**
 * CLI 的 stdout / stderr 纪律，以及退出码。
 *
 * ## 为什么要有这一层
 *
 * `arbiter` 的 stdout **不是给人看的日志通道，是数据通道**：`--json` 时它是
 * 恰好一个 JSON 对象，否则是产物路径（一行一个）。只要往它里面混进一行日志，
 * 调用方（Claude Code 的 hook、任何会跑 bash 的 agent）解析出来的就是垃圾——
 * 而**我们这边一声不吭**。这与 MCP 的 stdio 传输是同一件事的两个表面
 * （见 `src/mcp/stdout.ts` 与 docs/NOTES.md 约束 20），只是那边混进去会破 JSON-RPC 帧，
 * 这边会让 `JSON.parse` 抛在调用方那里。
 *
 * 所以纪律不靠「大家记得别用 console.log」，而是**一道物理闸门**：
 * `protectStdout()` 把 `process.stdout.write` 整个换掉，唯一能到达 stdout 的出口是
 * 本模块的 `writeStdout()`。任何人（包括依赖内部）绕过去写，那一行会被拦下来、
 * 改道 stderr 并附一句说明。**这条是承重的**：`converters/` 那条依赖链里有
 * sharp / mammoth / pdfjs 这些第三方库，指望它们都不往 stdout 写是不现实的。
 *
 * ## 编码
 *
 * 写出去的字节**显式构造成 UTF-8**（`Buffer.from(text, 'utf8')`），不依赖
 * `process.stdout` 上可能被改过的默认编码。Windows 上把输出重定向到文件时，
 * 读回那一侧按 UTF-8 解就能拿到原样的中文——这一点在开发机上永远看不出问题
 * （终端里码页恰好对），所以它必须落成断言（见 `scripts/test-cli.ts`），
 * 与 docs/NOTES.md 约束 23 第 3 条（`reg.exe` 经管道吐 GBK）是同一类坑。
 */

/**
 * 退出码。**三者必须互不相同**，因为 agent 是拿它决定下一步的：
 * 「参数写错了」要改参数、「引擎没装」要去装（或换目标格式）、
 * 「转换失败」要去看引擎的 stderr。
 *
 * 全退 1 的话，调用方唯一的出路是去读 stderr 里的中文——而那正是约束 23 第 3 条
 * 明令禁止的判据形态（按文案分类，文案一改就静默分错）。
 */
export const EXIT = {
  OK: 0,
  /** 引擎跑了，但没成功（非零退出码 / 0 字节产物 / 我们自己的内部错） */
  CONVERT_FAILED: 1,
  /** 参数错：用法不对、源文件不存在、这个格式组合不支持、输出路径被占 */
  USAGE: 2,
  /** 这条转换需要某个按需下载的引擎，本机还没装 */
  ENGINE_MISSING: 3,
  /** 我们没预料到的异常（`internal` 码）。**与上面三个都不同**：它值得原样重试一次 */
  INTERNAL: 4,
  /** 被 Ctrl-C / SIGTERM 打断 */
  INTERRUPTED: 130
} as const

export type ExitCode = (typeof EXIT)[keyof typeof EXIT]

/** 真实 stdout 写入。**只有 `writeStdout()` 能碰它**，见文件头。 */
let realWrite: typeof process.stdout.write | null = null

function channel(): typeof process.stdout.write {
  if (realWrite === null) {
    realWrite = process.stdout.write.bind(process.stdout) as typeof process.stdout.write
  }
  return realWrite
}

/** 诊断一律走这里（= stderr）。名字短是因为调用点很多。 */
export function log(message: string): void {
  process.stderr.write(`${message}\n`)
}

/**
 * 装上 stdout 闸门。**幂等**，重复调用不会把闸门套在自己身上。
 *
 * 三件事：
 *   - `console.log` / `info` / `debug` 改道 stderr（`warn` / `error` 本来就是 stderr，
 *     不动它们）；
 *   - `process.stdout.write` 换成「拦下 + 改道 stderr」；
 *   - `stdout` 上挂一个空的 `error` 处理器。`arbiter convert x --json | head -1`
 *     会让下游提前关掉管道，没有它的话 EPIPE 会以未捕获异常的形式把进程打崩，
 *     退出码变成一个看不懂的 1 —— 而那时候转换其实已经成功了。
 */
export function protectStdout(): void {
  if (realWrite !== null) return
  channel()

  const toStderr = (...parts: unknown[]): void => {
    log(parts.map((p) => (typeof p === 'string' ? p : inspect(p))).join(' '))
  }
  console.log = toStderr
  console.info = toStderr
  console.debug = toStderr

  process.stdout.on('error', () => {
    // 下游把管道关了。忽略——数据通道已断，再报什么也没有接收方，
    // 而退出码由调用方自己决定（见上面那句）。
  })

  process.stdout.write = ((
    chunk: string | Uint8Array,
    encodingOrCb?: BufferEncoding | ((error?: Error | null) => void),
    cb?: (error?: Error | null) => void
  ): boolean => {
    const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
    log(`[arbiter] 拦下一段本会污染 stdout 的写入（stdout 是数据通道）：${text.trimEnd()}`)
    // 拦下之后本没有真实写入发生，但调用方可能在等这个回调（流式写入就是这样）。
    // 不回它就永远悬着。
    const callback = typeof encodingOrCb === 'function' ? encodingOrCb : cb
    if (callback) process.nextTick(() => callback(null))
    return true
  }) as typeof process.stdout.write
}

/**
 * 往 stdout 写一段数据。**这是唯一的出口。**
 *
 * 等写入回调再 resolve：Windows 上管道写入是异步的，写完就 `process.exit()`
 * 会把输出截断——而截断的 JSON 在调用方那里表现为「转换明明成功了，解析却失败」。
 * 另有一个兜底计时器，防的是「回调压根不触发」（流被销毁）：那时宁可早一点退出，
 * 也不要挂在那儿等到 hook 超时。
 */
export function writeStdout(text: string): Promise<void> {
  if (text === '') return Promise.resolve()
  const write = channel()

  return new Promise<void>((done) => {
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      done()
    }
    const timer = setTimeout(finish, 5000)
    try {
      write(Buffer.from(text, 'utf8'), () => finish())
    } catch {
      finish()
    }
  })
}

/** `JSON.stringify` 遇到循环引用会抛，别让日志把它变成第二个异常 */
function inspect(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}
