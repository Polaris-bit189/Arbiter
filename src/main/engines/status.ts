import { spawn, type ChildProcess } from 'child_process'
import { existsSync } from 'fs'
import { ENGINE_KEYS, type EngineKey, type EngineState, type EngineStatus } from '@shared/types'
import { appPaths } from '../core/appPaths'
import { killTree } from '../core/kill'
import { getSettings } from '../core/settings'
import { ffmpegPath } from './registry'
import { pandocEngine, resetPandocCache } from './pandoc'
import { sevenZipEngine, resetSevenZipCache } from './sevenzip'
import { calibrePath, libreOfficePath, resetHeavyCache } from './heavy'

/**
 * 引擎状态的唯一来源（关于页）。
 *
 * **两层严格分开，这是本模块唯一的设计要点**：
 *
 *   `engineStatus()`        只做 `existsSync`（进函数先清一遍各解析器的缓存再重解析，
 *                           见 `resetEngineCaches()`）。页面一挂载就走这条，必须是毫秒级。
 *   `probeEngineVersions()` 真起 `spawn(exe, ['--version'])` 子进程。
 *                           LibreOffice 实测 3～5 秒、遇 profile 锁还会挂住，
 *                           Calibre 要拉起一整个 Python 解释器。
 *
 * 为什么不能合成一条（比如「顺手把版本也读了」）：这是本 track 里唯一会**被用户直接
 * 感知**的错误。页面一进来就卡五秒，用户不会想到「它在探测版本」，只会觉得应用坏了。
 * 所以版本号做成显式按钮，点了才去付那个代价。
 *
 * 每个引擎的判据都从既有的解析器复用，这里**不重新实现任何候选路径**——
 * 唯一的例外是按路径前缀判断「这份引擎是从哪来的」（`originOf`），那是纯分类，
 * 不参与「有没有」的裁决。
 */

/* ------------------------------------------------------------------ 展示用文案 */

/**
 * 引擎的中文显示名。
 *
 * 写成 `Record<EngineKey, string>` 而不是数组：`ENGINE_KEYS` 里加一个键，
 * 这里就是**编译错误**；写成数组则是一个静默少掉的行。
 */
const LABELS: Record<EngineKey, string> = {
  ffmpeg: 'FFmpeg',
  sharp: 'Sharp',
  pdf: 'Chromium 排版',
  pandoc: 'Pandoc',
  libreoffice: 'LibreOffice',
  calibre: 'Calibre',
  archive: '7-Zip'
}

/**
 * 引擎的中文名。
 *
 * 主进程内部拼用户可见文案时（比如任务被拒的理由：「需要 LibreOffice 引擎，当前未就绪」）
 * 走这里，**不要另抄一份**——关于页徽章上的那一份和它是同一个表，抄成两份之后
 * 「LibreOffice」和「libre office」这种分歧只会出现在用户看得见的地方。
 *
 * 用函数包一层而不是直接导出 `LABELS`：交出去就是把这张表变成了别人可以就地改的东西。
 */
export function engineLabel(key: EngineKey): string {
  return LABELS[key]
}

/**
 * 引擎来源 → 一句给用户看的话。
 *
 * `EngineState` 里还有 `installing` / `error` 两个值，它们不是「解析结果」而是
 * 「运行时状态」，这里给不出文案，返回 undefined 让 UI 自己兜。
 */
function originText(state: EngineState): string | undefined {
  switch (state) {
    case 'bundled':
      return '随包内置'
    case 'installed':
      return '按需下载'
    case 'system':
      return '系统安装'
    default:
      return undefined
  }
}

/* -------------------------------------------------------------- 路径 → 来源 */

/** Windows 路径比较：大小写不敏感、分隔符统一成 `\`、根目录补上尾分隔符 */
function under(child: string, root: string): boolean {
  if (root.length === 0) return false
  const c = child.toLowerCase().replace(/\//g, '\\')
  const r = `${root.toLowerCase().replace(/\//g, '\\').replace(/\\+$/, '')}\\`
  // 尾分隔符是必须的：少了它 `/engines-extra/x.exe` 会被判成 `/engines` 下的东西。
  return c.startsWith(r)
}

/**
 * 解析到的路径是「从哪来的」。
 *
 * 这一步刻意**不重新实现候选路径**，只看解析结果落在哪个根下面，所以它不会与
 * 各 `engines/*.ts` 里的优先级判断分家。顺序即优先级：
 *
 *   engineDir    → 按需下载（用户自己配的引擎目录，理论上可能落在仓库里，先判）
 *   appPath      → 随包内置（开发期就是仓库根，`resources/engines/` 与
 *                  `node_modules/ffmpeg-static/` 都在它下面）
 *   resourcesPath→ 随包内置（打包后引擎被 extraResources 拷到 resources/ 下）
 *   其余         → 系统安装（Program Files / %LOCALAPPDATA%）
 */
function originOf(path: string | null): EngineState {
  if (path === null) return 'missing'
  if (under(path, getSettings().engineDir)) return 'installed'
  const paths = appPaths()
  if (under(path, paths.appPath)) return 'bundled'
  if (under(path, paths.resourcesPath)) return 'bundled'
  return 'system'
}

/* ---------------------------------------------------------------- 廉价层 */

interface Resolved {
  path: string | null
  state: EngineState
  detail?: string
}

/**
 * ffmpeg 的解析器是唯一一个**失败时抛异常**的，包一层。
 *
 * 它也因此没有 `resetFfmpegCache()` 可调：`registry.ts` 里 `ffmpegCache` 只在成功时
 * 被写入，失败直接抛、不留痕，所以不存在「null 被永久缓存」那个坑（其余四个解析器
 * 都有，那是三态缓存的必然产物）。这不是疏漏，别去给它补一个 reset。
 */
function ffmpegOrNull(): string | null {
  try {
    return ffmpegPath()
  } catch {
    return null
  }
}

/** 只做 `existsSync`（外加一次设置读取）。这条路径上不许出现 `spawn`。 */
function resolveCheap(key: EngineKey): Resolved {
  switch (key) {
    case 'ffmpeg': {
      const path = ffmpegOrNull()
      const state = originOf(path)
      return { path, state, detail: originText(state) }
    }

    case 'pandoc': {
      const path = pandocEngine()
      const state = originOf(path)
      return { path, state, detail: originText(state) }
    }

    case 'libreoffice': {
      const path = libreOfficePath()
      const state = originOf(path)
      return { path, state, detail: originText(state) }
    }

    case 'calibre': {
      const path = calibrePath()
      const state = originOf(path)
      return { path, state, detail: originText(state) }
    }

    case 'archive': {
      const engine = sevenZipEngine()
      if (engine === null) return { path: null, state: 'missing' }
      return {
        path: engine.path,
        state: originOf(engine.path),
        // 这一行是关于页最有价值的输出：`supportsRar` 直接决定 `.rar` 能不能转，
        // 而「已就绪」三个字会把它盖掉——用户看到「已就绪」却转不了 rar 才是最坏的情况。
        detail: engine.supportsRar ? '完整版，支持 RAR' : '精简版，不支持 RAR'
      }
    }

    /**
     * sharp 与 pdf **不是可执行文件**，既没有路径也没有版本可探：
     *   sharp 是 npm 原生模块（libvips 编进 .node）
     *   pdf   是 Chromium 自带的 printToPDF（藏在 Electron 里，没有独立进程）
     * 所以它们的 state 恒为「可用」，且**不编造版本号**——Chromium 的版本号在关于页
     * 顶部已经有一行（`AppInfo.chrome`），在这里再报一遍是同一份数据的第二种说法。
     */
    case 'sharp':
      return { path: null, state: 'bundled', detail: '原生模块（libvips）' }
    case 'pdf':
      return { path: null, state: 'bundled', detail: 'Chromium 内置' }
  }
}

/**
 * 「这个引擎现在就绪了吗」。入队时判「要不要按设置跳过这条任务」走这里。
 *
 * **刻意复用 `resolveCheap()`，不另写一份候选路径**：这段判据和关于页徽章上那个
 * 「已就绪 / 未就绪」必须给出同一个答案，两边分家的表现是最难查的那种——
 * 关于页写着「已就绪」，用户拖进文件却被一句「当前未就绪，按设置已跳过」挡回来。
 *
 * 更要紧的是它**按值裁决，没有「其余一律放行」的兜底分支**：以前 `task.ts` 里写的是
 * 「不是 LibreOffice 就是 Calibre」的三元链，于是 pandoc 那 10 条转换（`md → docx` 等）
 * 即使 `requiresDownload()` 判出来了，`ready` 也会落到 `true` 上——开关形同虚设。
 * 现在少写一个 `case` 是不可能的：`resolveCheap()` 的 switch 覆盖全部 `EngineKey`，
 * 漏一个就是编译错误。
 */
export function engineReady(key: EngineKey): boolean {
  return resolveCheap(key).state !== 'missing'
}

/**
 * 已探到的版本号，跨次缓存。
 *
 * 存在的理由：`probeEngineVersions(key)` 只探一个引擎，但返回的是**完整列表**
 * （契约如此：渲染层的 store 整份替换）。不在主进程留住上一次的结果，
 * 探完 7-Zip 之后再探 LibreOffice，7-Zip 那一行好不容易探到的版本号就没了。
 */
const probed = new Map<EngineKey, { version?: string; error?: string }>()

/**
 * 清掉各引擎解析器的缓存，强制下一次解析重新探测。
 *
 * **两条路径都必须先调它，所以抽成一个函数而不是把三行抄成两份**：抄成两份之后，
 * 再加第四个引擎时必然只改其中一处，而那种漏改不报任何错——它只会让某个引擎
 * 永远显示成「未就绪」。
 *
 * 为什么连「廉价」的 `engineStatus()` 也要清：那些缓存是三态的，`undefined` = 还没
 * 探过、`null` = 探过了、**没有**。解析失败的结果同样会被写进缓存并永久生效，所以
 * 首次解析没找到引擎之后，此后无论磁盘上多了什么，解析器都一直返回 `null`。
 * 用户可见的表现正是计划里点名的那个：关于页写着「未就绪」→ 用户照做装好引擎
 * → **回到关于页还是未就绪**，只能重启应用。
 *
 * 那个场景里的动作恰恰就是「回到关于页」，走的是 `engineStatus()` 这条路径，
 * 所以清缓存不能只挂在 probe 上。只挂 probe 等于把「永远未就绪」削弱成「未就绪到
 * 用户点一下探测按钮为止」——而徽章在那一刻**给出的是错的**，用户又没有任何理由
 * 去点那个按钮：他刚装完引擎，回来看一眼，看到「未就绪」，只会认为装失败了。
 *
 * 代价是每次多约 20 次 `existsSync`。这不是热路径（进页面一次、不轮询），拿它换一个
 * 不会撒谎的徽章是笔明显划算的账。
 *
 * 三个 reset 覆盖四个引擎（`heavy.ts` 一个函数管 LibreOffice + Calibre）。
 * ffmpeg 不在此列——它失败时直接抛、不写缓存，见 `ffmpegOrNull()` 的注释。
 */
function resetEngineCaches(): void {
  resetSevenZipCache()
  resetPandocCache()
  resetHeavyCache()
}

/**
 * 七个引擎的当前状态。**廉价路径**，页面渲染走这条。
 *
 * 「廉价」指的是**不 spawn**——只做 `existsSync`，清缓存重解析也在这个预算之内。
 *
 * `downloadBytes` 一律不填：按需下载流程还没接上，填一个估算体积就是在 UI 上骗人。
 */
export function engineStatus(): EngineStatus[] {
  // 每次进关于页都重新探测：用户可能正是在上一次「未就绪」之后才把引擎装上的。
  resetEngineCaches()

  return ENGINE_KEYS.map((key) => {
    const r = resolveCheap(key)
    const status: EngineStatus = { key, label: LABELS[key], state: r.state }
    if (r.path !== null) status.path = r.path
    if (r.detail !== undefined) status.detail = r.detail

    // 探测结果只在引擎当前真的解析得到时才回填：引擎已经没了的行上挂着一个上次探到的
    // 版本号，比不显示更糟——那会让用户以为「明明装好了」。
    if (r.state !== 'missing') Object.assign(status, probed.get(key) ?? {})
    return status
  })
}

/* ---------------------------------------------------------------- 昂贵层 */

/** LibreOffice 给 8 秒：它要起 soffice.bin，冷启动实测 3～5 秒 */
const LIBREOFFICE_TIMEOUT_MS = 8000
/** 其余引擎 5 秒：ffmpeg / pandoc / 7z 都是热启动几十毫秒，5 秒已经是「它挂了」的量级 */
const DEFAULT_TIMEOUT_MS = 5000

/** 单条流最多留多少字节。`--version` 的输出只有几 KB，这只是防呆上限。 */
const MAX_OUTPUT_BYTES = 64 * 1024

/**
 * 版本号的锚点。
 *
 * **必须锚在各家自己的关键字上，不做「取输出里第一个 x.y.z」那种通用匹配。**
 * 通用匹配会张冠李戴：Calibre 的启动器顺嘴打一行 Python 版本，7z 的格式表里
 * 每行都有数字——猜错的情况下报出来的是一个**看起来很像但不对**的版本号，
 * 用户和后人都无从分辨。宁可解析不出来（UI 显示「输出里没有版本号」）也不猜。
 */
const VERSION_RE: Partial<Record<EngineKey, RegExp>> = {
  ffmpeg: /ffmpeg\s+version\s+(\d+\.\d+(?:\.\d+)*)/i,
  pandoc: /pandoc(?:\.exe)?[\s]+(\d+\.\d+(?:\.\d+)*)/i,
  libreoffice: /libreoffice\s+(\d+(?:\.\d+)+)/i,
  calibre: /calibre\s+(\d+(?:\.\d+)+)/i,
  // `7z i` 首行：「7-Zip 24.09 (x64) : Copyright …」，精简版是「7-Zip (z) 24.09 (x64)」，
  // 所以关键字与数字之间允许任意非数字字符。
  archive: /7-Zip[^\d\r\n]*(\d+(?:\.\d+)+)/i
}

type ProbeRun = { ok: true; output: string } | { ok: false; error: string }

/**
 * 跑一次 `--version` 并把输出收回来。
 *
 * 四个必须项（缺一个都是踩过的坑）：
 *  1. `spawn(exe, args)` 数组参数，没有 shell（约束 2）
 *  2. 超时
 *  3. 超时后 `child.kill()` **外加 `killTree()`**——`soffice.com` 会拉起 `soffice.bin`，
 *     只杀父进程会留下孤儿占着 profile 锁，之后所有 LibreOffice 转换**静默失败**
 *     （退出码 0 但没产物，约束 3）。`killTree` 复用 `core/kill.ts`，这里不另写一份
 *     `taskkill` 调用。
 *  4. 输出从 stdout 取，取不到再退到 stderr
 */
async function runVersionProbe(exe: string, args: string[], timeoutMs: number): Promise<ProbeRun> {
  return new Promise<ProbeRun>((resolve) => {
    let settled = false

    const finish = (result: ProbeRun): void => {
      if (settled) return
      settled = true
      resolve(result)
    }

    let child: ChildProcess
    try {
      // windowsHide：不闪黑框。这是 GUI 应用，弹一个控制台窗口出来非常突兀。
      child = spawn(exe, args, { windowsHide: true })
    } catch (error) {
      finish({ ok: false, error: `无法启动进程：${(error as Error).message}` })
      return
    }

    // 超时收尾。三个点都不能省：
    //   - `child.kill()` 之后还要 `killTree()`：`soffice.com` 会拉起 `soffice.bin`，
    //     只杀父进程会留个孤儿占着 profile 锁（约束 3），之后所有 LibreOffice 转换
    //     静默失败（退出码 0 但没产物）。
    //   - **等 taskkill 真的跑完再回话**：soffice.bin 死之前锁还占着，这时候就把按钮
    //     解禁，用户再点一次会撞上同一把锁、再超时一次——表现出来是「探测按钮点几次
    //     都是超时」，很难归因到上一轮那个正在死的进程上。
    //   - 定时器刻意**不** unref（与 core/kill.ts 里那个兜底计时器相反）：unref 掉的
    //     话，应用退出那一刻它可能还没触发，被这次探测拉起来的 soffice.bin 就成了孤儿。
    //     多活 8 秒远比留一个孤儿进程划算。
    const timer = setTimeout(async () => {
      child.kill()
      await killTree(child.pid)
      finish({ ok: false, error: `探测超时（${Math.round(timeoutMs / 1000)} 秒）` })
    }, timeoutMs)

    let out = ''
    let err = ''
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    // 版本号都是 ASCII，编码不会出问题；上限只是防一个满嘴报错的实现把内存吃光
    child.stdout?.on('data', (chunk: string) => {
      if (out.length < MAX_OUTPUT_BYTES) out += chunk
    })
    child.stderr?.on('data', (chunk: string) => {
      if (err.length < MAX_OUTPUT_BYTES) err += chunk
    })

    /**
     * 进程自己收尾了就把计时器撤掉。
     *
     * 这件事**不能**放在 `finish()` 里做：`finish` 要在 spawn 抛异常的同步分支上被调用，
     * 那一路上计时器还没声明（`const timer` 在 try 之后），引用它就是 TDZ 报错。
     * 反过来放在这里没有代价——超时那一路定时器本来就已经打过了，`clearTimeout`
     * 对一个已触发的句柄是空操作。
     */
    const stopTimer = (): void => clearTimeout(timer)

    child.on('error', (error) => {
      stopTimer()
      finish({ ok: false, error: `无法启动进程：${error.message}` })
    })

    child.on('close', (code) => {
      stopTimer()
      if (code !== null && code !== 0) {
        const last = err
          .trim()
          .split(/\r?\n/)
          .filter((l) => l.trim().length > 0)
          .pop()
        finish({ ok: false, error: last ? `退出码 ${code}：${last}` : `退出码 ${code}` })
        return
      }
      // stdout 优先：这几家的 `--version` 都写 stdout。退到 stderr 是给 Calibre 那类
      // 「Python 启动器先打 banner」的实现兜底——反正后面还有关键字锚定的正则把关，
      // 混进无关输出不会被误判成版本号。
      finish({ ok: true, output: out.length > 0 ? out : err })
    })
  })
}

/**
 * 单个引擎的版本探测。返回 `null` 表示这个引擎**没有可探测的东西**（sharp / pdf，
 * 或者是压根没解析到路径——那种情况徽章已经写着「未就绪」，再报一次是噪音）。
 */
async function probeOne(key: EngineKey): Promise<{ version?: string; error?: string } | null> {
  const pattern = VERSION_RE[key]

  const run = async (
    exe: string,
    args: string[],
    timeoutMs = DEFAULT_TIMEOUT_MS
  ): Promise<ProbeRun> => runVersionProbe(exe, args, timeoutMs)

  let result: ProbeRun | null = null

  switch (key) {
    case 'ffmpeg': {
      const exe = ffmpegOrNull()
      // `-version` 是单横线，写成 `--version` 它会当成非法参数直接报错
      if (exe !== null) result = await run(exe, ['-version'])
      break
    }

    case 'pandoc': {
      const exe = pandocEngine()
      if (exe !== null) result = await run(exe, ['--version'])
      break
    }

    case 'calibre': {
      const exe = calibrePath()
      if (exe !== null) result = await run(exe, ['--version'])
      break
    }

    case 'archive': {
      const engine = sevenZipEngine()
      // 7-Zip 没有 `--version` 这个开关（给了会被当成文件路径），`i` 才是「打印信息」：
      // 它的首行就是版本号，顺带还能看出是不是带 RAR 的完整版。
      if (engine !== null) result = await run(engine.path, ['i'])
      break
    }

    case 'libreoffice': {
      const exe = libreOfficePath()
      if (exe === null) break
      /**
       * **必须换成同目录的 `soffice.com`。** 实测：`soffice.exe --version`
       * 退出码 0 但输出 **0 字节**（重定向到文件也是 0，等 8 秒仍是 0，不是竞态），
       * 拿 `.exe` 去捕获版本只会得到一句「输出里没有版本号」。
       * `.com` 才吐 `LibreOffice 26.8.0.3 …`。别「顺手简化」掉这一句。
       */
      const com = exe.replace(/\.exe$/i, '.com')
      if (!existsSync(com)) {
        // 到这一步说明引擎本体是在的（`libreOfficePath()` 已经验过 soffice.exe +
        // soffice.bin），所以这里的失败是「装得不完整」而不是「没装」，值得单说一句。
        result = { ok: false, error: '同目录下没有 soffice.com，捕获不到版本输出' }
        break
      }
      result = await run(com, ['--version'], LIBREOFFICE_TIMEOUT_MS)
      break
    }

    case 'sharp':
    case 'pdf':
      return null
  }

  if (result === null) return null
  if (!result.ok) return { error: result.error }

  const matched = pattern?.exec(result.output)
  if (matched === null || matched === undefined || matched[1] === undefined) {
    return { error: '输出里没有版本号' }
  }
  return { version: matched[1] }
}

/**
 * 真起子进程探版本。**只有用户显式点「探测版本」才走这条**（见文件头的分层说明）。
 *
 * `key` 省略表示探测全部；不要拿它做页面加载——七个子进程同时起，LibreOffice 那一个
 * 就要 3～5 秒，等于把整页渲染吊住。
 */
export async function probeEngineVersions(key?: EngineKey): Promise<EngineStatus[]> {
  /**
   * 探测前照样先清一遍缓存：用户「点了探测才发现装上了」与「回到关于页就看到了」
   * 应当得到同一个答案，两条路径不能各有一套判据（理由见 `resetEngineCaches()`）。
   */
  resetEngineCaches()

  const targets: EngineKey[] = key === undefined ? [...ENGINE_KEYS] : [key]

  // 并行：各引擎互不相干，串行只会把「全部探测」做成 10 秒以上的等待。
  // 只有一次探测会话，所以不会出现两个 LibreOffice 同时去抢 profile 锁那种组合
  // （渲染层在探测期间把所有按钮都禁用了，主进程这边也靠它兜住）。
  await Promise.all(
    targets.map(async (target) => {
      const result = await probeOne(target)
      if (result !== null) probed.set(target, result)
    })
  )

  return engineStatus()
}
