/**
 * SessionStart：会话开始时**轻量**看一眼有没有新版本，有就提一句，其余情况一律闭嘴。
 *
 * ## 这个脚本的全部难点是「怎么不出声」
 *
 * 它每次开会话都会跑一遍，所以**任何**多余的行为都会被乘以「用户每天开多少次会话」。
 * 四条硬约束，每一条都有具体理由：
 *
 * 1. **静默 = 空 stdout + 退出码 0**。⚠️ **绝不能用 `exit 2`**：SessionStart 是
 *    「不可阻断」事件，`exit 2` 不会拦住会话，但它会让 harness **忽略 stdout**
 *    （于是这次注入必然失败）并且多渲染一条 `hook error` 通知——既不静默，也办不成事。
 *    `exit 1` 同样会渲染通知。**唯一的静默写法就是什么错都不算。**
 *
 * 2. **注入必须走信封**：`hookSpecificOutput.additionalContext`。
 *    ⚠️ **顶层写 `additionalContext` 是不生效的**——有项目因此**静默丢了 12 天**的注入，
 *    而 hook 每次都报成功。这条坑的特点正是「写错了没有任何反馈」。
 *
 * 3. **不能 async**（hooks.json 里不能写 `"async": true`）：异步 hook 的注入点已经过去了，
 *    `additionalContext` 送不进去。要注入就得同步等它跑完——所以才必须快。
 *
 * 4. **两层控时**：hooks.json 里 `"timeout": 3`（单位是**秒**）是硬兜底，而**脚本内部
 *    必须自己先认输**——网络请求带 `AbortSignal.timeout()`，超时/异常一律走静默出口。
 *    指望 harness 那个 timeout 当兜底是不够的：被它掐掉会留下取消痕迹，
 *    而我们要的是「安静地说没有新版本」。
 *
 * ## 缓存是承重的，不是优化
 *
 * 没有缓存的话，**每个会话**都会打一次 GitHub API（未认证限流 60/小时），而且每次都要等
 * 网络——一次 2.5 秒，用户会明显感到会话启动变慢。
 *
 * ⚠️ **失败也要缓存**（用更短的 TTL）。只缓存成功的话，一台连不上 GitHub 的机器
 * （本机就是：hosts 把 github.com 指向 127.0.0.1 的转发服务）**每次开会话都要白等 2.5 秒**。
 *
 * **本机版本不进缓存**：直读 asar 是毫秒级的，每次现读才不会在用户刚更新完之后还说旧版本。
 * 也正是因为这一点，读版本的逻辑**直接用 `update.mjs` 导出的那个**，不在这里重写一份
 * ——重写一份就多了一个会与它漂移的副本，而漂移的表现是「报出一个不存在的版本差」。
 */

import { readFileSync, writeFileSync, writeSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { t } from '../mcp/i18n.mjs'
import { MCP_ENTRY, resolveTarget } from '../mcp/target.mjs'
import { checkUpdate, readAppVersion } from '../mcp/update.mjs'
import { decideUpdate } from '../mcp/updatePlan.mjs'

/** 查到之后可以信多久。一天两次足够——发布不是每小时都在发生。 */
const OK_TTL_MS = 12 * 60 * 60 * 1000

/** 没查到之后隔多久再试。比成功的短得多，这样网络一恢复就能提示上。 */
const FAIL_TTL_MS = 60 * 60 * 1000

/** 这一次查询自己的上限，**必须**小于 hooks.json 里的 `timeout`（3 秒）。 */
const NET_TIMEOUT_MS = 2500

const CACHE_PATH = join(tmpdir(), 'arbiter-plugin-update-check.json')

/** 什么都不说地退出。**这是本文件最重要的一个出口。** */
function silent() {
  process.exitCode = 0
}

/**
 * 把 stdin 读完。返回解析后的对象（读不动就给 `null`）。
 *
 * 必须读完：不读的话，往我们这边写输入的那一端可能撞上 broken pipe。
 * 内容只用得到 `source` 一个字段。
 */
async function readInput() {
  try {
    const chunks = []
    for await (const chunk of process.stdin) chunks.push(chunk)
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return null
  }
}

function readCache(now) {
  try {
    const parsed = JSON.parse(readFileSync(CACHE_PATH, 'utf8'))
    const age = now - Number(parsed?.checked_at)
    if (!Number.isFinite(age) || age < 0) return null
    const latest = typeof parsed.latest === 'string' ? parsed.latest : null
    return age < (latest === null ? FAIL_TTL_MS : OK_TTL_MS) ? { latest } : null
  } catch {
    return null
  }
}

function writeCache(now, latest) {
  try {
    writeFileSync(CACHE_PATH, JSON.stringify({ checked_at: now, latest }))
  } catch {
    // 写不进去（临时目录不可写？）只是下次多查一次，不值得出声
  }
}

/** 拿到「最新版本」，优先用缓存。任何失败都返回 `null`（= 这次不知道）。 */
async function latestVersion(now, target) {
  const cached = readCache(now)
  if (cached !== null) return cached.latest

  try {
    const report = await checkUpdate({ target, timeoutMs: NET_TIMEOUT_MS, download: false })
    const latest = report.latest?.version ?? null
    writeCache(now, latest)
    return latest
  } catch {
    // `checkUpdate` 设计上不抛，但真抛了也照静默处理——这个脚本不该有会响的失败路径。
    writeCache(now, null)
    return null
  }
}

async function main() {
  const input = await readInput()

  // matcher 已经把范围钉在 `startup` 上了，这里再判一次是**防御性**的：
  // 万一某个版本不认 matcher，也不至于在 resume / clear 时把那句话说第二遍。
  // `input` 读不出来（null）时不拦——那更可能是 harness 换了输入格式，不是「不该跑」。
  if (input !== null && typeof input.source === 'string' && input.source !== 'startup') {
    return silent()
  }

  const target = resolveTarget(MCP_ENTRY)
  if (!target?.usable) return silent()

  const installed = readAppVersion(target)
  if (installed === null) return silent()

  const latest = await latestVersion(Date.now(), target)
  if (latest === null) return silent()

  if (decideUpdate({ installed, latest }) !== 'update-available') return silent()

  // ⚠️ 用 `writeSync`：管道上异步写会**截断**输出，而截断的 JSON 会让 harness 解析失败
  // ——那时它会当成「这个 hook 出了错」，于是我们精心设计的静默就白费了。
  writeSync(
    1,
    `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: t('updateSessionNotice', { latest, installed })
      }
    })}\n`
  )
  process.exitCode = 0
}

main().catch(() => {
  // 兜底：任何逃出来的异常都按「没有新版本」处理。**这不是掩饰错误**——
  // 一条检查更新的提示不值得让用户的会话启动报一次错。
  silent()
})
