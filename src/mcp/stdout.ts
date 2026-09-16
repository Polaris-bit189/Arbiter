/**
 * stdout 的守卫。
 *
 * stdio 传输下 **stdout 就是协议帧**：往里写一个字节，客户端那侧就少一帧、多一段乱码。
 * 表现是「本地连着好好的，装进客户端就断」，而**服务端什么错都不报**。所以这件事
 * 不能靠「大家记得别用 console.log」，得有一道物理闸门。
 *
 * 单独成文件的第二个理由：它是**可以被单测的纯逻辑**。`scripts/test-mcp-server.ts`
 * 直接 import 这个模块，在里面真写几段东西进去、看它拦哪个放哪个——包括「闸门是不是
 * 活的」这条自证。留在 `main.ts` 里就做不到：那个文件 import 即启动。
 */

/** 只给个能看的形状，别把整个对象塞进日志（`JSON.stringify` 遇到循环引用会抛）。 */
export function inspectShallow(value: unknown): string {
  if (value instanceof Error) return `${value.name}: ${value.message}`
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

/** 一行完整的输出是不是一个 JSON-RPC 帧。 */
export function isJsonRpcFrame(line: string): boolean {
  const trimmed = line.trim()
  if (trimmed === '') return true // 空行不是帧，但也不破坏协议
  try {
    const parsed: unknown = JSON.parse(trimmed)
    return typeof parsed === 'object' && parsed !== null && 'jsonrpc' in parsed
  } catch {
    return false
  }
}

/**
 * 把 stdout 锁起来。两道防线，各挡一种来路：
 *
 *  1. **`console.*` 全部改道 stderr。** 绝大多数日志走这里（包括依赖内部的
 *     `console.warn`），改完就没了。
 *  2. **`process.stdout.write` 外层逐帧验票。** 每一行完整输出必须是带 `jsonrpc`
 *     字段的合法 JSON，否则**拦下不转发**，并在 stderr 上喊一声。
 *
 * 第 2 条为什么是「拦下」而不是「照样转发 + 告警」：转发一个坏帧等于**保证**协议被
 * 破坏，客户端会断连；拦下来至少会话还活着，而 stderr 那行字把「写了什么」摆在了
 * 开发者面前。于是排查路径是通的：stderr 会告诉你脏内容是什么。
 *
 * 按行缓冲是安全的——SDK 的 stdio 传输每条消息都以 `\n` 结尾，所以一个帧不会被
 * 永久卡在缓冲里。反过来，**只按单次 `write` 判是不够的**：大消息可能被拆成两次写。
 */
export function protectStdout(): void {
  const toStderr = (...parts: unknown[]): void => {
    process.stderr.write(
      parts.map((p) => (typeof p === 'string' ? p : inspectShallow(p))).join(' ') + '\n'
    )
  }
  console.log = toStderr
  console.info = toStderr
  console.debug = toStderr

  let pending = ''
  const realWrite = process.stdout.write.bind(process.stdout)

  process.stdout.write = ((
    chunk: string | Uint8Array,
    encodingOrCb?: BufferEncoding | ((error?: Error | null) => void),
    cb?: (error?: Error | null) => void
  ): boolean => {
    const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
    pending += text

    let framed = ''
    let index = pending.indexOf('\n')
    while (index >= 0) {
      const line = pending.slice(0, index)
      pending = pending.slice(index + 1)
      if (isJsonRpcFrame(line)) framed += `${line}\n`
      else {
        process.stderr.write(
          `[arbiter-mcp] 拦下一段非 JSON-RPC 的 stdout 写入（它本会破坏协议帧）：${line}\n`
        )
      }
      index = pending.indexOf('\n')
    }

    // 回调语义要自己兜住：拦下之后本没有真实写入发生，但调用方（比如 SDK 的
    // 流式写入）在等这个回调，不回它就永远悬着。
    const callback = typeof encodingOrCb === 'function' ? encodingOrCb : cb
    if (framed === '') {
      if (callback) process.nextTick(() => callback(null))
      return true
    }
    if (typeof encodingOrCb === 'string') return realWrite(framed, encodingOrCb, callback)
    return realWrite(framed, callback)
  }) as typeof process.stdout.write
}
