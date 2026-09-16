import { realpathSync, statSync } from 'fs'
import { isAbsolute, resolve } from 'path'
import { isInsideDir } from '../main/core/outputName'
import { PathNotAllowed } from './errors'

/**
 * MCP 侧的路径闸门。
 *
 * **为什么 MCP 需要一个渲染进程没有的东西**：IPC 那条边界上，对面是**用户的手指**
 * （点选文件对话框、拖拽），路径天然是用户自己挑的。这条边界上对面是**一个自主的
 * agent**，它的路径可能来自任何地方——模型自己拼的、上一轮工具结果里读到的、
 * 或者**被转成文本喂给它的恶意文件内容**（提示注入）。`convert_file` 的 `source`
 * 要是没有闸门，等于把「读任意文件 + 把内容写到任意位置」暴露给一段不可信的文本。
 *
 * 闸门的形状是**根目录白名单**（PLAN 的 M4 定为「cwd + 用户配置目录」）：
 * 解析出来的绝对路径必须落在某个根下面。三条必须记住的实现细节：
 *
 *  1. **先 `resolve()` 再判**，判据是规范化之后的绝对路径——`..` 与相对路径
 *     在 resolve 之后就消失了，不需要（也不该）自己去数斜杠。
 *  2. **要过 `realpath`**：`resolve()` 不碰文件系统，一个指向根目录之外的符号链接
 *     闯得过纯字符串判据。这里对**已存在的路径**取 realpath；
 *     对**还不存在的输出文件**退一步取它父目录的 realpath——父目录不存在就直接判非法。
 *  3. 判据用 `isInsideDir()`（`core/outputName.ts`），**不另写一份前缀比较**：
 *     尾分隔符那件事（`C:\data` 不该放行 `C:\database\x`）在那里已经踩过并写在注释里。
 */

export interface PathGate {
  /** 允许读写的根目录（已 realpath 规范化，去重保序） */
  roots: string[]
  /** 允许**写**的根目录。默认与 roots 相同，可由 `ARBITER_MCP_WRITE_ROOTS` 收窄。 */
  writeRoots: string[]
}

/**
 * 从环境变量读额外的根。分隔符用 `;`（Windows 的 PATH 分隔符）而不是 `:`——
 * `:` 会撞上盘符（`D:\data`），那是个必然踩到的坑。
 */
function splitEnv(value: string | undefined): string[] {
  if (!value) return []
  return value
    .split(';')
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
}

/**
 * 把一组候选根规范化。
 *
 * 根目录**必须已经存在**（realpath 需要），不存在就丢掉并记一笔——但**不抛错**：
 * 默认根里的 userData 目录在首次运行时未必建出来，把它变成「MCP 起不来」是拿
 * 一个可恢复的小问题换一个致命问题。丢掉的那个会在 `describeRoots()` 里说明。
 */
function normalizeRoots(candidates: string[]): { roots: string[]; dropped: string[] } {
  const roots: string[] = []
  const dropped: string[] = []
  for (const candidate of candidates) {
    try {
      const real = realpathSync(resolve(candidate))
      if (!statSync(real).isDirectory()) {
        dropped.push(candidate)
        continue
      }
      if (!roots.includes(real)) roots.push(real)
    } catch {
      dropped.push(candidate)
    }
  }
  return { roots, dropped }
}

/**
 * 建闸门。
 *
 * `cwd` 与 `userData` 由调用方注入（`main.ts` 从环境变量与启动参数算出来再传进来），
 * 这里**不自己去读 `process.cwd()` 之外的东西**——测试要能在一个可控的根上跑。
 *
 * 默认根 = cwd + userData + `ARBITER_MCP_ROOTS`。`ARBITER_MCP_WRITE_ROOTS` 给了
 * 就**只**放行它（收窄，不是追加）：给用户一个「能读全盘、只往一个沙箱写」的组合。
 */
export function createPathGate(opts: {
  cwd: string
  userData: string
  env?: NodeJS.ProcessEnv
}): PathGate {
  const env = opts.env ?? process.env
  const readCandidates = [opts.cwd, opts.userData, ...splitEnv(env.ARBITER_MCP_ROOTS)]
  const { roots, dropped } = normalizeRoots(readCandidates)

  const writeEnv = splitEnv(env.ARBITER_MCP_WRITE_ROOTS)
  const writeRoots = writeEnv.length > 0 ? normalizeRoots(writeEnv).roots : roots

  if (roots.length === 0) {
    throw new PathNotAllowed(
      '一个可用的根目录都没有，MCP 不会放行任何路径。请用 ARBITER_MCP_ROOTS 指定。',
      { tried: readCandidates, dropped }
    )
  }
  return { roots, writeRoots }
}

/** 给 agent 看的一句话：当前放行哪些根。工具报错时带上它，agent 才知道该往哪放文件。 */
export function describeRoots(gate: PathGate): string {
  return `允许的目录：${gate.roots.join('、')}`
}

/**
 * 落在**任意一个**根里就算放行。
 *
 * 逐根走 `isInsideDir()`（`core/outputName.ts`），**不在这里另写一份前缀比较**：
 * 尾分隔符那件事（`C:\data` 不该放行 `C:\database\x`）在那里已经踩过并写在注释里，
 * 抄一份到这里就是给自己留一个将来会漂移的副本。
 */
function insideAny(target: string, roots: string[]): boolean {
  return roots.some((root) => isInsideDir(target, root))
}

/**
 * 把候选路径规范化成真实绝对路径。
 *
 * 不存在的叶子节点（还没生成的输出文件）取父目录的 realpath 再拼回去——
 * **父目录本身必须存在**，否则算非法：`D:\nonexistent\..\..\Windows\x` 这类路径
 * 的 realpath 是靠不住的（Windows 上对不存在的路径 realpath 会抛，行为随版本而变），
 * 与其猜不如直接拒绝。
 */
function realish(input: string, cwd: string): string {
  const absolute = isAbsolute(input) ? resolve(input) : resolve(cwd, input)
  try {
    return realpathSync(absolute)
  } catch {
    // 叶子不存在：退到父目录
  }
  const parent = resolve(absolute, '..')
  const realParent = realpathSync(parent) // 父目录不存在 → 抛，由调用方转成可读错误
  return resolve(realParent, absolute.slice(parent.length).replace(/^[\\/]+/, ''))
}

function toAbsolute(input: string, cwd: string): string {
  return isAbsolute(input) ? resolve(input) : resolve(cwd, input)
}

/**
 * 读路径：必须存在、必须是文件、必须落在某个读根内。返回规范化后的绝对路径。
 *
 * **两条失败路径的码不同，因为 agent 该做的事不同**（见 `errors.ts` 的码表）：
 *   - 越界 → `path_not_allowed`（默认）：要改的是**根目录**，换到允许的地方去。
 *   - 文件不可用（不存在 / 读不到 / 是个目录）→ `source_missing`：要改的是**这个路径本身**，
 *     多半是拼错了、或者文件被挪走了。两者都 `retryable: false`，但 next_steps 不一样，
 *     而 next_steps 才是 agent 下一轮真正照着做的东西。
 */
export function resolveReadPath(gate: PathGate, input: string, cwd: string): string {
  const absolute = toAbsolute(input, cwd)
  let real: string
  try {
    real = realish(input, cwd)
  } catch {
    throw new PathNotAllowed(
      `路径不存在（或所在目录不存在）：${absolute}`,
      { roots: gate.roots },
      { code: 'source_missing' }
    )
  }

  // 先判「在不在根里」再 stat：越界的路径不该泄露「它存在不存在」这个信息。
  if (!insideAny(real, gate.roots)) {
    throw new PathNotAllowed(`路径不在允许的目录里：${absolute}。${describeRoots(gate)}`, {
      roots: gate.roots
    })
  }

  let stat
  try {
    stat = statSync(real)
  } catch {
    throw new PathNotAllowed(
      `路径读不到：${absolute}`,
      { roots: gate.roots },
      { code: 'source_missing' }
    )
  }
  if (stat.isDirectory()) {
    throw new PathNotAllowed(`这是一个目录，不是文件：${absolute}`, undefined, {
      code: 'source_missing'
    })
  }
  return real
}

/**
 * 写路径：可以不存在的文件，但**父目录必须存在**且落在写根内。
 * 返回规范化后的绝对路径（尚未创建任何东西）。
 */
export function resolveWritePath(gate: PathGate, input: string, cwd: string): string {
  const absolute = toAbsolute(input, cwd)
  let real: string
  try {
    real = realish(input, cwd)
  } catch {
    throw new PathNotAllowed(`输出路径的上级目录不存在：${absolute}`, {
      roots: gate.writeRoots,
      hint: '先建好目录，或把产物写到已有的目录里'
    })
  }

  if (!insideAny(real, gate.writeRoots)) {
    throw new PathNotAllowed(`输出路径不在允许的目录里：${absolute}。${describeRoots(gate)}`, {
      roots: gate.writeRoots
    })
  }
  return real
}
