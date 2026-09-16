/**
 * Arbiter 插件的 MCP 启动器。
 *
 * ## 为什么需要这一层
 *
 * MCP server 的代码在 Arbiter 应用里（`out/main/mcp.js`），**不在这个插件里**。
 * 插件安装在 `~/.claude/plugins/cache/` 下，那里既没有 `node_modules`、也没有
 * ffmpeg / sharp / 7-Zip 这些引擎——把 server 塞进插件等于把整个应用重打一遍包。
 *
 * 所以插件**借宿主**：在本机找到一份可用的 Arbiter，用它的 Electron 二进制以
 * `ELECTRON_RUN_AS_NODE=1` 去跑它的 MCP 入口。这条路实测过（2026-09-13）：
 * Electron 的 Node 模式带 asar 支持，起得来、stdout 上只有合法 JSON-RPC、日志全在 stderr。
 * 2026-09-14 又用 `electron-builder` 的产物复核过一遍（A/B，见 `electron-builder.yml`）：
 * **从 asar 里起得来，而且能真跑一次转换**（sharp 的原生模块经 `app.asar.unpacked` 解析）。
 *
 * ## 两条纪律
 *
 * - **这个文件一个字节都不能往 stdout 写。** stdio 传输下 stdout 是协议帧的通道，
 *   多一个字符就破坏 JSON-RPC 帧，表现是「本地跑得好好的、装进 Claude Code 就断连」。
 *   所有诊断走 stderr，子进程用 `stdio: 'inherit'` 直接接管管道（不经我们中转，
 *   也就没有缓冲与粘包问题）。
 * - **找不到就大声说清楚。** 插件装好了而应用没装，是最常见的失败；这时要给出
 *   「装哪个、装到哪、或者用哪个环境变量指路」，而不是一句 `ENOENT`。
 *   注意**报错也必须走 stderr 并且退出码非 0**：静默退出会让客户端显示成
 *   「server 已连接但没有任何工具」，比报错难查得多。
 *
 * ## 目录发现搬到了 `target.mjs`
 *
 * 「找应用」这件事现在有第二个消费者——`hooks/read-convert.mjs` 要拉起 CLI
 * （`out/main/cli.js`）。所以候选目录、`probe`、`resolveTarget` 与 `ARBITER_*` 的
 * 装配都在 `./target.mjs` 里，**这里一个字都不重复**；那边写清了为什么必须走
 * `asarHasEntry` 而不是 `existsSync`。
 *
 * ## 环境变量
 *
 * | 变量 | 用途 |
 * | --- | --- |
 * | `ARBITER_HOME` | 显式指定根目录（安装根 **或** 仓库根），跳过下面全部自动探测 |
 * | `ARBITER_MCP_DEBUG` | 设 `1` 时把选中的路径打到 stderr，排查「连上了但引擎说没装」 |
 */
import { spawn } from 'child_process'

import { MCP_ENTRY, entryEnv, expectedEntryPath, resolveTarget } from './target.mjs'

/** 诊断一律走 stderr，理由见文件头。 */
const log = (message) => process.stderr.write(`[arbiter-plugin] ${message}\n`)

const debug = (message) => {
  if (process.env.ARBITER_MCP_DEBUG === '1') log(message)
}

const target = resolveTarget(MCP_ENTRY)

if (!target) {
  log('没有在本机找到可用的 Arbiter。')
  log('')
  log('这个插件本身不含转换引擎——它要借用一份 Arbiter：装好的应用，或一个构建过的仓库。')
  log('请先装应用：')
  log('  Windows: 从 Releases 下载 Arbiter-Setup-*.exe 安装')
  log('  macOS:   把 Arbiter.app 拖进 /Applications')
  log('')
  log('已经装了却仍然报这一条，用 ARBITER_HOME 显式指路（写进 .mcp.json 的 env 里）：')
  log('  ARBITER_HOME=C:\\Users\\<你>\\AppData\\Local\\Programs\\Arbiter')
  process.exit(1)
}

if (!target.electron) {
  log(`找到了 ${target.root}，但里面没有 Electron 可执行文件。`)
  log('（开发形态下通常是 `npm i` 还没跑，或者 electron 没装上。）')
  process.exit(1)
}

// 判据是 `usable`，**不是** `existsSync(target.entry)`——打包形态下那个路径指向
// asar 内部，普通 Node 的 `existsSync` 恒为 false（见 `target.mjs` / `asar.mjs` 的说明）。
if (!target.usable) {
  log(`找到了 ${target.root}，但没有 MCP 入口。`)
  log(`  期望的位置：${expectedEntryPath(target, MCP_ENTRY)}`)
  if (target.kind === 'repo') {
    log('这是仓库形态，先在仓库根跑一次 `npm run build` 生成 out/main/mcp.js。')
    log('（注意 `npm run build` 会先做 typecheck；只想快的话用 `npx electron-vite build`。）')
  } else {
    log('这个安装包可能早于 MCP 功能（< 0.2.0），装新版本即可。')
  }
  process.exit(1)
}

const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', ...entryEnv(target) }

debug(`形态      = ${target.kind}`)
debug(`根目录    = ${target.root}`)
debug(`electron  = ${target.electron}`)
debug(`mcp.js    = ${target.entry}`)
debug(`userData  = ${env.ARBITER_USER_DATA ?? '(交给 main.ts 猜)'}`)

const child = spawn(target.electron, [target.entry], {
  stdio: 'inherit',
  env,
  windowsHide: true
})

child.on('error', (error) => {
  log(`拉起 MCP server 失败：${error.message}`)
  log(`  命令：${target.electron} ${target.entry}`)
  process.exit(1)
})

child.on('exit', (code, signal) => {
  // 客户端断开时 stdin 关闭，server 自己会走收尾流程后正常退出——那是 0，不是错误。
  if (signal) {
    debug(`子进程被信号 ${signal} 终止`)
    process.exit(1)
  }
  process.exit(code ?? 0)
})

// MCP 客户端断开时会关掉 stdin，子进程据此收尾。这里把信号原样转过去，
// 免得留下一个孤儿 server 占着管道（与项目里 `taskkill /T /F` 那条约束同一个道理）。
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal))
}
