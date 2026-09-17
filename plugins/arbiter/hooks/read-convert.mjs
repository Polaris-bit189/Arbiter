/**
 * PreToolUse(Read) hook：**把 `Read(报告.docx)` 改写成读一份临时转出来的 Markdown。**
 *
 * Claude Code 自带的 Read 读不了 `.docx` / `.xlsx` 这类压缩容器格式，直接读会得到
 * 一屏二进制乱码。MCP 工具能转，但 **hook 调不到 MCP 工具**（这是 E-1 这条线存在的
 * 全部理由），所以它走的是 `arbiter` CLI——由 `plugins/arbiter/mcp/target.mjs`
 * 找到本机的 Arbiter，用它的 Electron 以 `ELECTRON_RUN_AS_NODE=1` 跑
 * `out/main/cli.js`（形状与 `launch.mjs` 拉起 MCP server 完全一致）。
 *
 * ## 铁律：**失败必须放行**
 *
 * 这个 hook 站在**每一次 Read**的路径上。它一旦挡住或报错，用户正常的读文件就坏了——
 * 而 hook 的默认超时是 60 秒（这里显式收窄到 30），一次挂住就等于把会话卡住 30 秒。
 * 所以：
 *
 *   - **任何一条不成立都原样放行**：stdin 不是 JSON、工具不是 Read、扩展名不在表里、
 *     找不到应用、这个安装包还没有 CLI 入口、引擎没装（CLI 退出码 3）、转换失败、
 *     超时、产物是 0 字节——全部 **exit 0 且 stdout 一个字节都没有**。
 *   - **绝不 exit 2**。PreToolUse 上退出码 2 是**阻断**，stderr 会被当成拒绝原因
 *     喂给模型——那是「拦住用户」的意思，与这里要做的正好相反。
 *   - **stdout 只许出现那一个 JSON**，日志一律 stderr。空 stdout + 退出码 0
 *     = 没有裁决 = 一切照旧，这是「放行」的**唯一**可靠写法。
 *
 * ## 三件必须记住的
 *
 * 1. **超时要杀进程树。** 只杀父进程会留下 `soffice.bin` 占着 LibreOffice 的
 *    profile 锁，之后**所有** LibreOffice 转换静默失败（docs/NOTES.md 约束 3）。
 *    所以这里用异步 spawn + 自己 `taskkill /pid <pid> /T /F`，而不是 `spawnSync` 的
 *    `timeout`——后者拿不到 pid，收不了那棵树。
 * 2. **产物必须有确定的名字，而且要能复用。** 同名文件第二次读不该再转一遍：
 *    「源没变、产物还在」就直接用。名字由源文件的绝对路径哈希而来，所以换个目录
 *    不会撞车，同一个文件重复读也不会在磁盘上堆出 `x (1).md`。
 * 3. **`--out` 是承重的。** 不给它的话产物的落点由应用的输出目录设置决定
 *    （用户很可能设成了 `D:\wjzcq`），而且撞名会加 ` (1)`——同一个 docx 读三次
 *    就在用户的目录里留下三个文件。这条链路上不许污染用户的目录。
 */
import { spawn, spawnSync } from 'child_process'
import { createHash } from 'crypto'
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeSync } from 'fs'
import { tmpdir } from 'os'
import { basename, extname, join } from 'path'

import { CLI_ENTRY, entryEnv, resolveTarget } from '../mcp/target.mjs'

/**
 * 值得转的扩展名 → 转成什么。
 *
 * **只放「不用额外下载、或引擎已在位时秒级完成」的两类**（E-1 的原文：hook 里只能做
 * 已就绪引擎的快转）。逐条的理由：
 *
 *   - `docx → md`：mammoth 纯 JS，实测毫秒级，**这条是主角**。
 *   - `xlsx → csv`：SheetJS 纯 JS，同样不下载。
 *   - `doc / odt → txt`：要 LibreOffice（357 MiB）。**CLI 永远不会去下载**——
 *     `JobRegistry` 在排队之前就问 `assertEngineReady()`，没装就退出码 3，
 *     于是这里放行、用户照常读到「二进制乱码」，代价只有一次进程启动。
 *   - `epub / mobi / azw3 → txt`：要 Calibre（213 MiB），同上。
 *
 * ⚠️ **这里刻意没有 `pdf` 这个目标。** `→ pdf` 走 `engines/chromiumPdf.ts` 的
 * `BrowserWindow`，而 CLI 跑在 `ELECTRON_RUN_AS_NODE=1` 下、**没有 Electron 运行时**
 * （见 `src/cli/main.ts` 的文件头）。把 `pptx` / `ppt` 放进表里只会每次白起一次进程、
 * 然后失败放行。`Read` 自己就能读文本型 PDF，这条损失可以接受。
 */
const PLAN = {
  docx: 'md',
  xlsx: 'csv',
  doc: 'txt',
  odt: 'txt',
  epub: 'txt',
  mobi: 'txt',
  azw3: 'txt'
}

/** 临时产物住哪儿。刻意用子目录：清理时只碰我们自己那一层。 */
const CACHE_DIR = join(tmpdir(), 'arbiter-read-hook')

/** CLI 的硬超时。留在 hooks.json 那 30 秒**之内**，好让我们自己先收手。 */
const CLI_TIMEOUT_MS = 25_000

/** 产物最多留几天。临时目录不是无限的，而用户不会来帮我们删。 */
const KEEP_DAYS = 3

const log = (message) => process.stderr.write(`[arbiter-hook] ${message}\n`)

/* ------------------------------------------------------------------ 放行 */

/** 什么都不做、什么都不说地放行。**所有**失败路径都走它。 */
function pass(reason) {
  if (reason) log(`${reason} —— 放行（不改写这次 Read）`)
  process.exit(0)
}

/* ------------------------------------------------------------------ 主体 */

/** 同步读干 stdin。同步是刻意的：下面每一步的失败都要能干净地 `pass()` 掉。 */
function readStdin() {
  try {
    // fd 0。客户端写完 JSON 就会关掉它，所以这句不会永久阻塞。
    return readFileSync(0, 'utf8')
  } catch {
    return ''
  }
}

/** 源文件的绝对路径 → 一个稳定、无冲突的产物路径。 */
function cachePathFor(filePath, to) {
  const digest = createHash('sha256').update(filePath).digest('hex').slice(0, 16)
  const stem = basename(filePath, extname(filePath))
    .replace(/[\\/:*?"<>|]/g, '_')
    .slice(0, 60)
  return join(CACHE_DIR, `${stem || 'doc'}-${digest}.${to}`)
}

/** 产物还在、而且不比源文件旧（源被改过就得重转）。 */
function isFresh(outPath, sourcePath) {
  try {
    const out = statSync(outPath)
    if (!out.isFile() || out.size === 0) return false
    return out.mtimeMs >= statSync(sourcePath).mtimeMs
  } catch {
    return false
  }
}

/**
 * 跑一次 CLI，返回是否成功。
 *
 * ⚠️ **不用 `spawnSync` 的 `timeout`**：那条路拿不到 pid，超时时只能杀掉父进程，
 * 而被它拉起来的 `soffice.bin` / `ffmpeg` 会变成孤儿——`soffice.bin` 还占着
 * LibreOffice 的 profile 锁，之后所有 LibreOffice 转换都**静默失败**（约束 3）。
 */
function runCli(exe, args, env) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(exe, args, {
        env,
        // 三条流全部 ignore：**这是 hook，stdout 上只许出现最后那一个 JSON**。
        // 子进程的输出一个字节都不能漏过来。
        stdio: ['ignore', 'ignore', 'ignore'],
        windowsHide: true
      })
    } catch {
      resolve(false)
      return
    }

    let settled = false
    const finish = (ok) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(ok)
    }

    const timer = setTimeout(() => {
      killTree(child.pid)
      finish(false)
    }, CLI_TIMEOUT_MS)

    child.on('error', () => finish(false))
    child.on('exit', (code) => finish(code === 0))
  })
}

/** 杀**整棵**进程树。Windows 上靠 `taskkill /T /F`，别的平台退到 SIGKILL。 */
function killTree(pid) {
  if (!pid) return
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true
      })
    } else {
      process.kill(pid, 'SIGKILL')
    }
  } catch {
    // 进程可能已经自己退了，或者我们没有权限——两种都不该让 hook 失败。
  }
}

/** 顺手扫掉过期的产物。**失败一律吞掉**：它只是卫生，不是这条链路的一环。 */
function pruneCache() {
  try {
    const cutoff = Date.now() - KEEP_DAYS * 24 * 60 * 60 * 1000
    for (const name of readdirSync(CACHE_DIR)) {
      const full = join(CACHE_DIR, name)
      try {
        if (statSync(full).mtimeMs < cutoff) rmSync(full, { force: true })
      } catch {
        // 单个条目坏了不影响其余
      }
    }
  } catch {
    // 目录还不存在，或者读不动。忽略。
  }
}

async function main() {
  const raw = readStdin()
  if (raw.trim() === '') return pass('stdin 是空的')

  let input
  try {
    input = JSON.parse(raw)
  } catch {
    return pass('stdin 不是合法 JSON')
  }

  // 事件名要核：一个 hook 脚本被配到别的 matcher 上时，这里能挡住误用。
  if (input?.hook_event_name !== 'PreToolUse')
    return pass(`事件不是 PreToolUse：${input?.hook_event_name}`)
  if (input?.tool_name !== 'Read') return pass(`工具不是 Read：${input?.tool_name}`)

  const toolInput = input?.tool_input
  const filePath = toolInput?.file_path
  if (typeof filePath !== 'string' || filePath === '')
    return pass('tool_input.file_path 不是非空字符串')

  const ext = extname(filePath).replace(/^\./, '').toLowerCase()
  const to = PLAN[ext]
  if (to === undefined) return pass(`.${ext} 不在快转表里`)

  // 找本机的 Arbiter。找不到、没有 Electron、或者这份安装包还没有 CLI 入口（早于 0.3.0）
  // ——统统放行。**判据是 `usable`，不是 `existsSync(target.entry)`**：打包形态下那个
  // 路径指向 asar 内部，普通 Node 的 `existsSync` 恒为 false（见 `mcp/asar.mjs`）。
  const target = resolveTarget(CLI_ENTRY)
  if (!target || !target.electron) return pass('本机没有找到可用的 Arbiter')
  if (!target.usable) return pass(`找到了 ${target.root}，但里面没有 CLI 入口（out/main/cli.js）`)

  const outPath = cachePathFor(filePath, to)

  // 转过一次、源也没改过 → 直接复用。这条短路同时保证了「同一个文件读十次
  // 只转一次」，而 `--out` 那套确定命名让短路**可能**成立。
  if (!isFresh(outPath, filePath)) {
    try {
      mkdirSync(CACHE_DIR, { recursive: true })
    } catch {
      return pass('临时目录建不出来')
    }
    pruneCache()

    const ok = await runCli(
      target.electron,
      [target.entry, 'convert', filePath, '--to', to, '--out', outPath, '--json'],
      { ...process.env, ELECTRON_RUN_AS_NODE: '1', ...entryEnv(target) }
    )
    // 退出码 0 才算数。1（转换失败）/ 2（参数错）/ 3（引擎没装）/ 130（被打断）
    // 一律放行——用户至少还能看到 Read 的原始结果（对 docx 是一屏乱码，
    // 但那本来就是他会得到的东西，我们没有把事情变得更坏）。
    if (!ok) return pass('CLI 没能完成这次转换')
    if (!isFresh(outPath, filePath)) return pass('CLI 退出了，但产物不在或为空')
  }

  // 改写。`updatedInput` 是**整份替换**，所以必须把原来的字段全部带上
  // （只有 `file_path` 换成临时产物）——只给一个字段会把 offset / limit 丢掉。
  const output = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      // `allow` 只跳过这一次读取的**交互式提示**，压不过任何 deny / ask 规则
      // （也就压不过受保护路径）。用在这里是合适的：用户本来就是要读这个文件的
      // 内容，我们只是换了一份能读的表示，而且源文件一个字节都没动。
      permissionDecision: 'allow',
      permissionDecisionReason:
        `Arbiter（调律者转换器）已把这份 .${ext} 转成 .${to} 的临时副本：${outPath}` +
        `（源文件未改动）。读完不必删它——它在系统临时目录里，会自己过期。`,
      updatedInput: { ...toolInput, file_path: outPath }
    }
  }

  // **同步写 fd 1**：`process.stdout.write` 在管道上是异步的，写完立刻退出会截断
  // ——而一个被截断的 JSON 在客户端那里等于「这个 hook 什么也没说」，
  // 表现是「明明成功了却还是读到乱码」，极难归因。
  writeSync(1, `${JSON.stringify(output)}\n`)
  process.exit(0)
}

main().catch((error) => {
  // 兜底：`main()` 里任何一处漏掉的异常都不能变成一次拦截。
  log(`内部错误：${error instanceof Error ? error.message : String(error)} —— 放行`)
  process.exit(0)
})
