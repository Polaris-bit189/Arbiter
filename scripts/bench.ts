/**
 * 后端性能基准。
 *
 *   npm run bench                       # 默认每类 40 个文件
 *   npm run bench -- 200                # 每类 200 个
 *   npm run bench -- 40 --conc=12       # 把设置里的「并发上限」放到 12
 *   npm run bench -- 40 --heavy         # 追加 1080p60 大文件那一节（慢，约 1 分钟）
 *
 * 思路：拿「极小的文件」跑批量，让转换本身的耗时趋近于 0，于是墙钟时间里剩下的
 * 主要是**与文件大小无关的部分**——进程启动、输出名解析、状态机与 IPC 推送。
 * 那部分才是「一次拖 200 个小文件」时的瓶颈；大文件反正是转换本身说了算。
 *
 * 每轮（per-round）= 墙钟 / 轮数，也就是一个并发槽位从拿到任务到交还的总耗时。
 * **这是唯一值得横向对比的数字**，改代码前后各跑一次即可看出收益。
 *
 * 不要拿它跟「单任务墙钟」相减去算「固定开销」：单任务那次含一次性的冷启动
 * （模块加载、libvips 初始化、ffmpeg 首次落盘），必然偏高，减出来会出现负数。
 *
 * ---
 *
 * **[5] 那一节是自检，不是测量**：它在同一个进程里换「并发上限」跑同两批，
 * 把结果写成**比值**并逐条判 PASS/FAIL（有失败时进程退出码为 1）。
 * 「更快」在噪声里恒真，所以判据只能是比值；每一节的否证方法写在那一节里。
 *
 * ⚠️ 轮数不能用引擎容量算，要用**生效上限** = min(引擎容量, 全局上限)。
 * 全局默认是 4，而 ffmpeg 容量是 12——拿 12 去除会让「每轮」虚高 3 倍，
 * 看起来像全线变慢（这个坑在改自适应并发时就踩过一次）。
 */
// 路径环境（userData / appPath / resourcesPath），必须是第一个 import——见那个文件
import './install-test-paths'
import { spawn, execFile } from 'child_process'
import { cpus } from 'os'
import { mkdir, rm, stat } from 'fs/promises'
import { resolve } from 'path'
import sharp from 'sharp'
import { TaskManager } from '../src/main/core/task'
import { updateSettings } from '../src/main/core/settings'
import { engineLimit, taskCost } from '../src/main/core/queue'
import type { EngineKey } from '../src/shared/types'
import type { TasksPatchMessage } from '../src/shared/ipc-contract'

const TMP = resolve('.tmp-bench')
const FFMPEG = resolve('node_modules/ffmpeg-static/ffmpeg.exe')

/** 命令行：位置参数是每类文件数，其余是 `--key=value` */
const NO_VALUE_FLAGS = new Set(['heavy'])
const args = new Map<string, string>()
let positional = 0
for (const raw of process.argv.slice(2)) {
  const match = raw.match(/^--([^=]+)(?:=(.*))?$/)
  if (match && (match[2] !== undefined || NO_VALUE_FLAGS.has(match[1]))) {
    args.set(match[1], match[2] ?? 'true')
  } else {
    positional = Number(raw) || 0
  }
}

const N = positional || 40
const CONC = Math.max(1, Number(args.get('conc') ?? 4) || 4)
const HEAVY = args.get('heavy') === 'true'

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const median = (values: number[]): number =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]

function runFfmpeg(args: string[]): Promise<number> {
  return new Promise((done) => {
    const child = spawn(FFMPEG, args, { windowsHide: true })
    child.on('error', () => done(-1))
    child.on('close', (code) => done(code ?? -1))
  })
}

/** 每轮 = 一个并发槽位跑完一个任务 */
function rounds(count: number, limit: number): number {
  return Math.ceil(count / limit)
}

/** 这个引擎在给定的全局上限下**实际**能开几路 */
function effectiveLimit(engine: EngineKey, conc: number): number {
  return Math.max(1, Math.min(engineLimit(engine), conc))
}

/* ---------------------------------------------------------------- 内存采样 */

/**
 * 所有 ffmpeg.exe 子进程的 RSS 之和（KB）。
 *
 * `process.memoryUsage()` **看不见子进程**，而「内存是真正的墙」这件事恰恰只发生在
 * 子进程上（实测单个 1080p60 的 libx264 veryfast 峰值约 914 MiB）。所以只能去问系统。
 * Windows 上用 `tasklist`：CSV 的最后一列是内存，形如 `"1,234,567 K"`。
 * 拿不到就返回 null——采样失败**不能**变成一条「内存没问题」的结论。
 *
 * ⚠️ 它数的是**这台机器上所有** ffmpeg.exe，包括不属于本次基准的那些。所以：
 *   - 读出来的值是**上界**，跑 --heavy 那一节时别同时开别的 ffmpeg 活（别的测试、
 *     另一次 bench），否则这条判据会假红；
 *   - 反过来说，它不会假绿——有外来进程只会让数字更大。
 */
function ffmpegRssKb(): Promise<number | null> {
  if (process.platform !== 'win32') return Promise.resolve(null)
  return new Promise((done) => {
    execFile('tasklist', ['/FI', 'IMAGENAME eq ffmpeg.exe', '/FO', 'CSV', '/NH'], (err, stdout) => {
      if (err) return done(null)
      let total = 0
      for (const line of stdout.split(/\r?\n/)) {
        const field = line.match(/"([^"]*)"\s*$/)?.[1]
        const kb = Number((field ?? '').replace(/[^\d]/g, ''))
        if (Number.isFinite(kb) && kb > 0) total += kb
      }
      done(total)
    })
  })
}

/** 轮询采样，返回峰值 KB。拿不到任何有效样本时返回 null（而不是 0） */
async function samplePeakRss(whileRunning: () => boolean): Promise<number | null> {
  let peak: number | null = null
  while (whileRunning()) {
    const kb = await ffmpegRssKb()
    if (kb !== null && kb > 0 && (peak === null || kb > peak)) peak = kb
  }
  return peak
}

/* ------------------------------------------------------------------ 跑批 */

interface BatchResult {
  wallMs: number
  /** 墙钟 / 轮数——横向对比就看这个 */
  perRoundMs: number
  sumTaskMs: number
  /** 实际并行度：任务时长之和 / 墙钟 */
  parallelism: number
  messages: number
  payloadBytes: number
  done: number
  rssMb: number
  /** ffmpeg 子进程的峰值 RSS（KB）。不采样、或采不到时为 null */
  peakChildRssKb: number | null
}

async function runBatch(
  manager: TaskManager,
  patches: TasksPatchMessage[],
  inputs: string[],
  toExt: string,
  limit: number,
  /** 采样 ffmpeg 子进程内存（只有 [5] 大文件那一节需要，其他节省掉这份开销） */
  sampleMemory = false
): Promise<BatchResult> {
  const before = new Set(manager.list().map((t) => t.id))
  await manager.addPaths(inputs)
  const ids = manager
    .list()
    .filter((t) => !before.has(t.id))
    .map((t) => t.id)

  for (const id of ids) manager.setTarget(id, toExt)

  const msgBefore = patches.length
  const rssBefore = process.memoryUsage().rss
  const started = Date.now()
  manager.start(ids)

  const busy = (): boolean =>
    manager
      .list()
      .some((t) => ids.includes(t.id) && (t.status === 'queued' || t.status === 'running'))

  let peakChildRssKb: number | null = null
  if (sampleMemory) {
    const sampling = (async () => {
      peakChildRssKb = await samplePeakRss(busy)
    })()
    while (busy()) await delay(20)
    await sampling
  } else {
    while (busy()) await delay(20)
  }
  const wallMs = Date.now() - started

  const tasks = manager.list().filter((t) => ids.includes(t.id))
  const done = tasks.filter((t) => t.status === 'done')
  const sumTaskMs = done.reduce((acc, t) => acc + ((t.finishedAt ?? 0) - (t.startedAt ?? 0)), 0)

  const fresh = patches.slice(msgBefore)
  const payloadBytes = fresh.reduce((acc, m) => acc + JSON.stringify(m).length, 0)

  return {
    wallMs,
    perRoundMs: wallMs / rounds(ids.length, limit),
    sumTaskMs,
    parallelism: wallMs > 0 ? sumTaskMs / wallMs : 0,
    messages: fresh.length,
    payloadBytes,
    done: done.length,
    rssMb: Math.round((process.memoryUsage().rss - rssBefore) / 1024 / 1024),
    peakChildRssKb
  }
}

function report(label: string, r: BatchResult, limit: number): void {
  console.log(`\n  ${label}`)
  console.log(`    完成          ${r.done}`)
  console.log(`    墙钟          ${r.wallMs} ms`)
  console.log(`    每轮          ${r.perRoundMs.toFixed(1)} ms   ← 横向对比看这个`)
  console.log(`    任务时长之和  ${r.sumTaskMs} ms`)
  console.log(`    实际并行度    ${r.parallelism.toFixed(2)}  （生效上限 ${limit}）`)
  console.log(`    推送          ${r.messages} 条，${(r.payloadBytes / 1024).toFixed(1)} KB`)
  console.log(`    RSS 增量      ${r.rssMb} MB`)
  if (r.peakChildRssKb !== null) {
    console.log(`    子进程峰值 RSS ${(r.peakChildRssKb / 1024 / 1024).toFixed(0)} MiB`)
  }
}

/* ------------------------------------------------------- [5] 自检的小工具 */

let gates = 0
let gateFailures = 0

/**
 * 一条**比值**判据。
 *
 * 判据只写比值，因为「更快」单独拿出来在噪声里恒真：同一份代码连跑三次，
 * 总有一次碰巧最小。`limit` 是比值上限，`label` 里要写清比的是哪两个上限。
 *
 * 否证方法就写在每一处调用点上（把哪一行改坏 → 这条翻红）。
 */
function ratio(label: string, numerator: number, denominator: number, limit: number): void {
  const value = numerator / denominator
  gates += 1
  const ok = value < limit
  if (!ok) gateFailures += 1
  console.log(
    `  ${ok ? '✓' : '✗'} ${label}：${value.toFixed(2)}（要求 < ${limit}）` +
      `  [${numerator} / ${denominator} ms]`
  )
}

interface Level {
  key: string
  label: string
  engine: EngineKey
  inputs: string[]
  toExt: string
  /** 设置里的「并发上限」。**不是**这一档实际能跑的路数——那是 min(引擎容量, 它) */
  conc: number
  sampleMemory?: boolean
}

interface LevelResult {
  wallMs: number
  peakChildRssKb: number | null
  /** 生效上限（打印用） */
  limit: number
}

/**
 * 把几档并发**交替**跑 reps 轮，每档取中位数。
 *
 * 交替是刻意的：机器上还有别的活在跑（开发时的编译、别的测试），某一档连着跑三轮
 * 恰好撞上那一段，就成了系统性偏差——实测同一批文件同一个上限，墙钟在 699~1007 ms
 * 之间飘，足以让 0.7 这条判据假红。交替之后噪声对每一档是公平的。
 */
async function compare(levels: Level[], reps: number): Promise<Map<string, LevelResult>> {
  const managers = new Map<string, TaskManager>()
  for (const level of levels) managers.set(level.key, new TaskManager(() => {}))

  const walls = new Map<string, number[]>()
  const peaks = new Map<string, number | null>()

  for (let round = 0; round < reps; round += 1) {
    for (const level of levels) {
      updateSettings({ maxConcurrent: level.conc })
      const limit = effectiveLimit(level.engine, level.conc)
      const result = await runBatch(
        managers.get(level.key)!,
        [],
        level.inputs,
        level.toExt,
        limit,
        level.sampleMemory ?? false
      )
      const list = walls.get(level.key) ?? []
      list.push(result.wallMs)
      walls.set(level.key, list)
      if (result.peakChildRssKb !== null) {
        peaks.set(level.key, Math.max(peaks.get(level.key) ?? 0, result.peakChildRssKb))
      }
    }
  }

  for (const manager of managers.values()) manager.shutdown()

  const out = new Map<string, LevelResult>()
  for (const level of levels) {
    out.set(level.key, {
      wallMs: median(walls.get(level.key) ?? [0]),
      peakChildRssKb: peaks.get(level.key) ?? null,
      limit: effectiveLimit(level.engine, level.conc)
    })
  }
  return out
}

async function main(): Promise<void> {
  await rm(TMP, { recursive: true, force: true })
  await mkdir(TMP, { recursive: true })

  console.log('=== 后端性能基准 ===')
  console.log(
    `CPU 核数 ${cpus().length}   N=${N}   并发上限 ${CONC}` +
      `   sharp.concurrency()=${sharp.concurrency()}`
  )
  console.log(
    `引擎容量 ffmpeg ${engineLimit('ffmpeg')} / sharp ${engineLimit('sharp')} / ` +
      `pandoc ${engineLimit('pandoc')} / archive ${engineLimit('archive')} / pdf ${engineLimit('pdf')}`
  )

  updateSettings({
    outputBesideSource: true,
    outputDir: null,
    onConflict: 'rename',
    maxConcurrent: CONC
  })

  /* ---------------------------------------------------------- [0] 素材 */

  console.log('\n[0] 造极小素材')

  const pngs: string[] = []
  for (let i = 0; i < N; i += 1) {
    const p = resolve(TMP, `img-${i}.png`)
    await runFfmpeg([
      '-hide_banner',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc=size=64x64:rate=1',
      '-frames:v',
      '1',
      p
    ])
    pngs.push(p)
  }
  console.log(`  生成 ${pngs.length} 张 64x64 png`)

  const clips: string[] = []
  for (let i = 0; i < N; i += 1) {
    const p = resolve(TMP, `clip-${i}.mp4`)
    await runFfmpeg([
      '-hide_banner',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc=duration=1:size=64x64:rate=15',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-pix_fmt',
      'yuv420p',
      p
    ])
    clips.push(p)
  }
  console.log(`  生成 ${clips.length} 段 1 秒 64x64 mp4`)

  const { size: clipBytes } = await statOf(clips[0])
  console.log(
    `  单个 mp4 ${clipBytes} 字节 → ffmpeg 代价 ${taskCost('ffmpeg', clipBytes, undefined)} 份` +
      `（≤ 1 MiB 才算小文件）`
  )

  /* ------------------------------------------- [1] 单任务（看冷启动） */

  console.log('\n[1] 单任务墙钟（含一次性冷启动，仅供了解量级，不要拿来做差）')

  const soloManager = new TaskManager(() => {})
  const soloPatches: TasksPatchMessage[] = []
  const soloPng = await runBatch(soloManager, soloPatches, [pngs[0]], 'jpg', 1)
  console.log(`  png → jpg  ${soloPng.wallMs} ms`)
  const soloClip = await runBatch(soloManager, soloPatches, [clips[0]], 'mkv', 1)
  console.log(`  mp4 → mkv  ${soloClip.wallMs} ms`)
  soloManager.shutdown()

  /* ------------------------------------------------- [2][3] 批量 */

  const patches: TasksPatchMessage[] = []
  const manager = new TaskManager((m) => patches.push(m))

  const sharpLimit = effectiveLimit('sharp', CONC)
  const ffmpegLimit = effectiveLimit('ffmpeg', CONC)

  console.log(`\n[2] sharp 批量 ×${N}（生效上限 ${sharpLimit}）`)
  const pngBatch = await runBatch(manager, patches, pngs, 'jpg', sharpLimit)
  report(`png → jpg  ×${N}`, pngBatch, sharpLimit)

  console.log(`\n[3] ffmpeg 批量 ×${N}（生效上限 ${ffmpegLimit}）`)
  const clipBatch = await runBatch(manager, patches, clips, 'mkv', ffmpegLimit)
  report(`mp4 → mkv  ×${N}`, clipBatch, ffmpegLimit)

  /* ------------------------------------------------------- [4] 汇总 */

  console.log('\n[4] 汇总')

  const totalTasks = N * 2
  const totalMsgs = pngBatch.messages + clipBatch.messages
  const totalPayload = pngBatch.payloadBytes + clipBatch.payloadBytes

  console.log(
    `  sharp  每轮 ${pngBatch.perRoundMs.toFixed(1)} ms（并行度 ${pngBatch.parallelism.toFixed(2)}/${sharpLimit}）`
  )
  console.log(
    `  ffmpeg 每轮 ${clipBatch.perRoundMs.toFixed(1)} ms（并行度 ${clipBatch.parallelism.toFixed(2)}/${ffmpegLimit}）`
  )
  console.log(
    `  IPC    ${totalTasks} 个任务 → ${totalMsgs} 条 / ${(totalPayload / 1024).toFixed(1)} KB` +
      `（每任务 ${(totalMsgs / totalTasks).toFixed(1)} 条，每条均 ${(totalPayload / Math.max(1, totalMsgs)).toFixed(0)} 字节）`
  )
  console.log(
    `  吞吐   ${totalTasks} 个任务总墙钟 ${pngBatch.wallMs + clipBatch.wallMs} ms` +
      ` → ${((totalTasks / ((pngBatch.wallMs + clipBatch.wallMs) / 1000)) * 60).toFixed(0)} 个/分钟`
  )

  manager.shutdown()

  /* ------------------------------- [5] 并发上限到底有没有用（比值自检） */

  console.log('\n[5] 并发上限对照（同一份代码，只换设置里的「并发上限」）')
  console.log('  判据全是比值：单个上限下的「更快」在噪声里恒真，比不出任何东西。')

  // 每一档跑 3 次取中位数。取中位而不是均值：3 次里只要一次被系统干扰，均值就废了。
  const REPS = 3

  // 素材用**真实尺寸**的图，而不是 [2] 那批 64x64 的 png。
  // 后者单张只要几毫秒，量到的基本是进程与 IO 的固定开销，并发收益被稀释掉
  // （实测同一份代码用它算出来的比值是 0.74，看着像「改了没用」——那是尺子不对）。
  const photo = resolve(TMP, 'photo.jpg')
  await runFfmpeg([
    '-hide_banner',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'testsrc=size=1600x1200:rate=1',
    '-frames:v',
    '1',
    '-q:v',
    '2',
    photo
  ])
  // 同一张图重复入队：省掉「造 24 张」的时间，量的仍是真实的解码 + 编码
  const photos = Array.from({ length: 24 }, () => photo)

  const levels: Level[] = [
    {
      key: 'sharp2',
      label: 'sharp 上限 2',
      engine: 'sharp',
      inputs: photos,
      toExt: 'jpg',
      conc: 2
    },
    {
      key: 'sharp4',
      label: 'sharp 上限 4',
      engine: 'sharp',
      inputs: photos,
      toExt: 'jpg',
      conc: 4
    },
    {
      key: 'small4',
      label: 'ffmpeg 小文件 上限 4',
      engine: 'ffmpeg',
      inputs: clips,
      toExt: 'mkv',
      conc: 4
    },
    {
      key: 'small12',
      label: 'ffmpeg 小文件 上限 12',
      engine: 'ffmpeg',
      inputs: clips,
      toExt: 'mkv',
      conc: 12
    }
  ]

  const heavyLevels: Level[] = []

  if (HEAVY) {
    /* --- 大文件那一侧：必须**不变慢**，而且不能因为放宽而吃爆内存 --- */
    // 注意这一节**另起一组**（下面 `compare(heavyLevels, 1)`）：大文件一档就是二十几秒，
    // 让上面那两档也跟着它只跑 1 轮，中位数就没了——实测那样做时小文件那一档
    // 会在机器有别的活时飘到 0.74 而假红。

    const COUNT = 16
    console.log(`\n  造大素材：${COUNT} 段 1080p60 / 20 秒的 mp4（每条约 66 MiB）`)
    const heavy: string[] = []
    for (let i = 0; i < COUNT; i += 1) {
      const p = resolve(TMP, `heavy-${i}.mp4`)
      await runFfmpeg([
        '-hide_banner',
        '-y',
        '-f',
        'lavfi',
        '-i',
        'testsrc2=duration=20:size=1920x1080:rate=60',
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-pix_fmt',
        'yuv420p',
        p
      ])
      heavy.push(p)
    }
    const { size: heavyBytes } = await statOf(heavy[0])
    console.log(
      `  单个 ${(heavyBytes / 1024 / 1024).toFixed(1)} MiB → ffmpeg 代价 ` +
        `${taskCost('ffmpeg', heavyBytes, undefined)} 份（于是容量 12 只能开出 4 路）`
    )
    // 目标钉 avi：h264 → mkv 会命中 remux（`-c copy`，一百多毫秒就跑完），
    // 那样这一节测的是「复制文件」而不是「编码」，比值全是噪声。
    // avi 不在 remux 白名单里（见约束 18），必然走 libx264 重编码。
    console.log('  目标钉 avi（h264 → mkv 会 remux，测不到编码）')
    heavyLevels.push(
      {
        key: 'heavy4',
        label: 'ffmpeg 大文件 上限 4',
        engine: 'ffmpeg',
        inputs: heavy,
        toExt: 'avi',
        conc: 4,
        sampleMemory: true
      },
      {
        key: 'heavy12',
        label: 'ffmpeg 大文件 上限 12',
        engine: 'ffmpeg',
        inputs: heavy,
        toExt: 'avi',
        conc: 12,
        sampleMemory: true
      }
    )
  }

  const measured = await compare(levels, REPS)
  if (heavyLevels.length > 0) {
    for (const [key, value] of await compare(heavyLevels, 1)) measured.set(key, value)
  }
  const at = (key: string): LevelResult => measured.get(key)!

  console.log('\n  sharp（素材：一张 1600x1200 的 JPEG，重复入队 24 次）')
  console.log(
    `    上限 2 中位墙钟 ${at('sharp2').wallMs} ms    上限 4 中位墙钟 ${at('sharp4').wallMs} ms`
  )
  // 否证：把 queue.ts 的 ENGINE_CAPACITY.sharp 改回常量 2 → 两档都只能跑到 2 → 比值 ≈ 1 → 翻红
  ratio('sharp：上限 4 比上限 2 快', at('sharp4').wallMs, at('sharp2').wallMs, 0.7)

  console.log('\n  ffmpeg 小文件（1 秒 64x64 mp4，每条约 8 KB → 1 份代价）')
  console.log(
    `    上限 4 中位墙钟 ${at('small4').wallMs} ms    上限 12 中位墙钟 ${at('small12').wallMs} ms`
  )
  // 否证：把 taskCost() 里 ffmpeg 那一支改成恒返回 HEAVY_COST（或把 FFMPEG_SLOTS 改回 4）
  //       → 上限 12 那一档也最多 4 路 → 比值回到 1 附近 → 翻红
  // 阈值比 sharp 那条松一点（0.75 而不是 0.7），是**量出来的余量**：空载时实测
  // 0.62~0.68（4 次），机器上有别的活在跑时飘到 0.74。而真正的回归值是 1.11，
  // 0.75 离它远得很——收紧到 0.7 只会换来假红，不会多抓到什么。
  ratio('ffmpeg 小文件：上限 12 比上限 4 快', at('small12').wallMs, at('small4').wallMs, 0.75)

  if (HEAVY) {
    const rss = (key: string): string => {
      const kb = at(key).peakChildRssKb
      return kb === null ? '（未能采样）' : `${(kb / 1024 / 1024).toFixed(1)} GiB`
    }
    console.log('\n  ffmpeg 大文件（1080p60 / 20 秒 ×16，必然重编码）')
    console.log(`    上限 4  墙钟 ${at('heavy4').wallMs} ms   子进程峰值 RSS ${rss('heavy4')}`)
    console.log(`    上限 12 墙钟 ${at('heavy12').wallMs} ms   子进程峰值 RSS ${rss('heavy12')}`)

    // 判据 1：大文件**不变慢**。上限 12 这一档被代价模型锁死在 4 路，所以应当持平。
    // ⚠️ 这一条**不是闸门的判据**：把闸门去掉（HEAVY_COST 改 1）它照样绿——实测
    //    12 路与 4 路的墙钟本来就持平（24256 / 23963 ms），大文件根本不吃并发。
    //    它红只说明「变慢了」。闸门由下面那条内存判据盯着。
    ratio('ffmpeg 大文件：上限 12 没有变慢', at('heavy12').wallMs, at('heavy4').wallMs, 1.15)

    // 判据 2：内存闸门。4 路 ≈ 3.6 GiB；去掉闸门就是 12 路 ≈ 11 GiB——
    // 这台 31 GiB 的机器扛得住，所以**只有**这条比值判据抓得住它。
    // 否证：HEAVY_COST 改 1 → 12 路 → 峰值 RSS 涨到约 3 倍 → 翻红。
    if (at('heavy12').peakChildRssKb === null) {
      console.log('  · 采不到子进程内存（非 Windows 或 tasklist 不可用），内存闸门这条无从验证')
    } else {
      const giB = at('heavy12').peakChildRssKb! / 1024 / 1024
      const ok = giB < 6
      gates += 1
      if (!ok) gateFailures += 1
      console.log(
        `  ${ok ? '✓' : '✗'} 内存闸门：上限 12 时 ffmpeg 子进程峰值 RSS ${giB.toFixed(1)} GiB` +
          `（要求 < 6；4 路实测约 3.6）`
      )
    }
  } else {
    console.log('\n  （大文件那一节要 --heavy 才跑：npm run bench -- 40 --heavy）')
  }

  console.log(`\n=== 自检 ${gates - gateFailures} / 失败 ${gateFailures} ===`)
  if (gateFailures > 0) process.exitCode = 1

  await rm(TMP, { recursive: true, force: true }).catch(() => {})
}

/** 只取文件大小，读不到时给 -1（调用方只是打印，不拿它做判断） */
function statOf(path: string): Promise<{ size: number }> {
  return stat(path)
    .then((s) => ({ size: s.size }))
    .catch(() => ({ size: -1 }))
}

void main()
