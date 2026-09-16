/**
 * 主进程编排逻辑的集成测试。
 *
 *   npx tsx --tsconfig tsconfig.test.json scripts/test-tasks.ts
 *
 * 跑的是真实的 TaskManager + 真实的 ffmpeg 子进程，只有 `electron` 被替换成桩
 * （见 scripts/electron-stub.ts）。覆盖那些「光看 UI 看不出来、出错又很难查」的路径：
 * 并发上限、输出名占位、取消是否真的杀掉了进程树、损坏文件的错误回传。
 */
import { spawn } from 'child_process'
import { randomBytes } from 'crypto'
import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from 'fs/promises'
import { cpus, tmpdir } from 'os'
import { dirname, resolve } from 'path'
// 路径环境（userData / appPath / resourcesPath），必须是第一个 import——见那个文件
import './install-test-paths'
import { dialog, ipcMain } from 'electron'
import sharp, { type Metadata } from 'sharp'
import { appendHistory, parseHistoryFile } from '../src/main/core/history'
import { TaskManager } from '../src/main/core/task'
import { getSettings, updateSettings } from '../src/main/core/settings'
import { engineLimit, taskCost } from '../src/main/core/queue'
import {
  categoryOf,
  engineFor,
  extOf,
  resolveDefaultTarget,
  targetsFor
} from '../src/shared/formats'
import { partPathOf } from '../src/main/core/outputName'
// 「产物不得为空」的共用判据（[19] 用）：GUI 与 MCP 两个入口共用同一份裁决与文案
import {
  assertOutputNotEmpty,
  ConversionCanceled,
  ConversionFailed,
  type ConvertContext
} from '../src/main/converters/common'
// 图片引擎的入口本身（[9] 里那条「取消必须拦在编码之前」要直接调它，绕开 TaskManager）
import { runSharp } from '../src/main/converters/image'
import { CancelToken } from '../src/main/core/cancel'
import { parseProbeOutput, type MediaInfo } from '../src/main/core/probe'
import { buildFfmpegArgs, buildPassOneArgs, supportsOutputTarget } from '../src/main/engines/ffmpeg'
import { probeHardwareEncode, setHardwareEncodeProbe } from '../src/main/engines/nvenc'
import { registerHistoryIpc } from '../src/main/ipc/history'
import {
  applyCliRequest,
  enqueueExternalRequest,
  getTaskManager,
  registerTaskIpc
} from '../src/main/ipc/tasks'
import { CH } from '../src/shared/ipc-contract'
import type { Settings, Task, TaskProgress } from '../src/shared/types'
import type { AddResult, TasksPatchMessage } from '../src/shared/ipc-contract'

const FFMPEG = resolve('node_modules/ffmpeg-static/ffmpeg.exe')
/**
 * 本次运行独占的临时目录。
 *
 * ⚠️ 早先它是固定名 `.tmp-test-tasks`，于是**两个实例同时跑会互相删文件**：
 * 每边开头都 `rm -rf` 一次整个目录。实测（2026-09-13，四线并行验证）：
 * `falsify:tasks` 在跑 test-tasks 的同时另一条线也跑了一次，
 * 结果 `.tmp-test-tasks/external.mp4` 在「刚验证它存在」和「下一步用它」之间
 * 被另一个进程删掉，套件直接崩在半路——**而那不是被测代码的问题**。
 *
 * 带上 pid 之后两个实例各用各的，互不可见。（`.tmp-*` 已在 .gitignore 里，
 * 崩掉留下的目录不会进版本控制；正常路径由 [17] 清理。）
 */
const TMP = resolve(`.tmp-test-tasks-${process.pid}`)
const FIXTURES = resolve('scripts/fixtures')
/** 完整版 7-Zip（含 7z.dll），RAR 支持全靠它；精简版 7za.exe 一个 RAR 解码器都没有 */
const SEVENZIP = resolve('resources/engines/7zip-full/7z.exe')

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

function runFfmpeg(args: string[]): Promise<{ code: number; stderr: string }> {
  return new Promise((done) => {
    const child = spawn(FFMPEG, args, { windowsHide: true })
    let stderr = ''
    child.stderr.on('data', (c: Buffer) => {
      stderr += c.toString('utf8')
    })
    child.on('error', () => done({ code: -1, stderr }))
    child.on('close', (code) => done({ code: code ?? -1, stderr }))
  })
}

async function makeVideo(path: string, seconds: number): Promise<boolean> {
  const result = await runFfmpeg([
    '-hide_banner',
    '-y',
    '-f',
    'lavfi',
    '-i',
    `testsrc=duration=${seconds}:size=320x240:rate=30`,
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-pix_fmt',
    'yuv420p',
    path
  ])
  return result.code === 0
}

/**
 * 给取消测试专用的素材。
 *
 * 取消必须打在「转换进行中」才有意义，但 testsrc 的编码极快——一段 120 秒的
 * 320x240 视频用 veryfast 也能在一秒内转完，取消会落在完成之后，测的就不是取消了。
 * 所以这里用高分高时长、但生成时用 ultrafast + crf 51 压到几乎不耗时的方式造素材，
 * 让「生成得快」和「转码得慢」同时成立。
 */
async function makeLongVideo(path: string, seconds: number): Promise<boolean> {
  const result = await runFfmpeg([
    '-hide_banner',
    '-y',
    '-f',
    'lavfi',
    '-i',
    `testsrc2=duration=${seconds}:size=1280x720:rate=30`,
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-crf',
    '51',
    '-pix_fmt',
    'yuv420p',
    path
  ])
  return result.code === 0
}

/**
 * 造一个「画面 + 音轨」的素材，两条流的编解码器都能指定（容器由扩展名决定）。
 *
 * `makeVideo()` 只有画面、没有音轨，而 remux 的判据里**音频那一侧是承重的**：
 * 实测同一个 vp9 视频流，音轨是 opus 时能原样搬进 webm，换成 aac 就报
 * `Only VP8 or VP9 or AV1 video and Vorbis or Opus audio`。
 * 素材必须能把两侧分别摆好，才测得出「音频也参与判定」。
 */
async function makeAv(path: string, vcodec: string, acodec: string, seconds = 2): Promise<boolean> {
  // `-preset` 是 x264 的开关，libvpx 那一族不认（会打一行警告）；vp9 的等效开关是 `-deadline`
  const video =
    vcodec === 'libx264'
      ? ['-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p']
      : ['-c:v', vcodec, '-deadline', 'realtime', '-cpu-used', '8', '-pix_fmt', 'yuv420p']

  const result = await runFfmpeg([
    '-hide_banner',
    '-y',
    '-f',
    'lavfi',
    '-i',
    `testsrc2=duration=${seconds}:size=320x240:rate=25`,
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=440:duration=${seconds}`,
    ...video,
    '-c:a',
    acodec,
    path
  ])
  return result.code === 0
}

/** 复制一份素材：同一路径重复入队、以及 `onConflict: 'rename'` 产生的 ` (1)` 后缀都会干扰断言 */
async function copyOf(src: string, name: string): Promise<string> {
  const dest = resolve(TMP, name)
  await copyFile(src, dest)
  return dest
}

/**
 * 取一条流的码流指纹，用来证明「到底有没有真的 remux」。
 *
 * `-c copy -f md5 -` 算的是**解复用之后的包字节**，与容器无关——实测同一份 h264
 * 装进 mp4 / mkv / mov 算出来是同一个值，而重编码一次就一定不同。
 *
 * 光比对编解码器名是抓不住这件事的：**重编码成 h264 之后名字照样是 h264**，
 * 那条断言会在「其实重编码了」的情况下照样绿。
 *
 * 指纹走 **stdout**（`-f md5 -`），所以不能复用 `runFfmpeg`——那个只收 stderr。
 * 注意 mp4 那类容器要过一遍 `faststart` 重写索引，实测**不影响**指纹（索引不在包字节里）。
 */
function streamFingerprint(file: string, map: string): Promise<string> {
  return new Promise((done) => {
    const child = spawn(
      FFMPEG,
      ['-v', 'error', '-i', file, '-map', map, '-c', 'copy', '-f', 'md5', '-'],
      { windowsHide: true }
    )
    let out = ''
    child.stdout.on('data', (c: Buffer) => {
      out += c.toString('utf8')
    })
    child.on('error', () => done(''))
    child.on('close', () => done(out.match(/[0-9a-f]{32}/)?.[0] ?? ''))
  })
}

/* ------------------------------------------------ 裁剪（P-1）用的几个量具 */

/**
 * 造一份**关键帧位置确定**的裁剪素材。
 *
 * `-g 60 -keyint_min 60 -sc_threshold 0` 三条缺一不可：只给 `-g` 的话，
 * 场景切换（`sc_threshold`）和最小间隔都会插进额外的 I 帧，于是「关键帧每 2 秒一个」
 * 不再成立——而这一节最核心的判据（无损裁剪的起点回退到**哪一个**关键帧）
 * 完全建立在关键帧位置之上。默认 GOP 同理：它随分辨率与预设漂移，不能拿来当基准。
 */
async function makeTrimSource(path: string, seconds: number): Promise<boolean> {
  const result = await runFfmpeg([
    '-hide_banner',
    '-y',
    '-f',
    'lavfi',
    '-i',
    `testsrc2=duration=${seconds}:size=640x360:rate=30`,
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=440:duration=${seconds}`,
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '23',
    '-g',
    '60',
    '-keyint_min',
    '60',
    '-sc_threshold',
    '0',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-b:a',
    '128k',
    path
  ])
  return result.code === 0
}

/** 收 stdout 的 ffmpeg 调用。`runFfmpeg` 只收 stderr，而 `framemd5` / `psnr` 都走 stdout */
function ffmpegOut(args: string[]): Promise<{ code: number; out: string; err: string }> {
  return new Promise((done) => {
    const child = spawn(FFMPEG, args, { windowsHide: true })
    let out = ''
    let err = ''
    child.stdout.on('data', (c: Buffer) => {
      out += c.toString('utf8')
    })
    child.stderr.on('data', (c: Buffer) => {
      err += c.toString('utf8')
    })
    child.on('error', () => done({ code: -1, out, err }))
    child.on('close', (code) => done({ code: code ?? -1, out, err }))
  })
}

interface PacketRows {
  /** 每个包在**它自己那个流的时间基**下的时间（秒） */
  times: number[]
  hashes: string[]
}

/**
 * 逐包指纹：`-f framemd5` 每个包一行 md5。
 *
 * 这是「无损裁剪到底有没有重编码」唯一干净的判据，而**整条流的 md5 在裁剪上用不了**：
 * `-c copy` 出来的产物只是源的一段，整条流的指纹必然与源不同——哪怕一个字节都没重编。
 * 逐包比对能同时回答两件事：产物的每个包是不是源的包（**逐位相同** = 没重编），
 * 以及它是源的**哪一段**（后半句正是「起点对齐到哪个关键帧」的实验判据）。
 *
 * 时间基从 `#tb 0: 1/15360` 那行读出来，**不写死**：mp4 是 1/15360、mkv 是 1/1000，
 * 写死的话换个容器算出来的时间全是错的，而断言只会以「对不上」的形式表现，
 * 看不出是解析错了还是行为变了。
 */
async function packetRows(file: string, map = '0:v:0'): Promise<PacketRows> {
  const { out } = await ffmpegOut([
    '-v',
    'error',
    '-i',
    file,
    '-map',
    map,
    '-c',
    'copy',
    '-f',
    'framemd5',
    '-'
  ])

  const tbMatch = out.match(/#tb 0: (\d+)\/(\d+)/)
  const tb = tbMatch ? Number(tbMatch[1]) / Number(tbMatch[2]) : 1

  const times: number[] = []
  const hashes: string[] = []
  for (const line of out.split(/\r?\n/)) {
    if (!line.startsWith('0,')) continue
    const parts = line.split(',').map((s) => s.trim())
    times.push(Number(parts[2]) * tb)
    hashes.push(parts[5])
  }
  return { times, hashes }
}

interface CopyWindow {
  /** 产物第一个包在源里的下标 */
  index: number
  /** 与源**连续逐位相同**的包数 */
  matched: number
  /** 产物的包总数 */
  total: number
  /** 覆盖到的源时间区间（秒） */
  startSec: number
  endSec: number
}

/**
 * 产物是不是源的一段**连续**码流。
 *
 * 首包在源里找不到就回 `null`——那说明产物被重编码过（包字节变了）。
 * `matched === total` 才是完整的「一个字节都没重编」：只查首包会漏掉
 * 「前面拷、后面编」这种半截情况。
 */
function locateCopy(src: PacketRows, out: PacketRows): CopyWindow | null {
  const first = out.hashes[0]
  if (first === undefined) return null

  const index = src.hashes.indexOf(first)
  if (index < 0) return null

  let matched = 0
  while (matched < out.hashes.length && src.hashes[index + matched] === out.hashes[matched]) {
    matched += 1
  }

  return {
    index,
    matched,
    total: out.hashes.length,
    startSec: src.times[index] ?? 0,
    endSec: src.times[index + out.hashes.length - 1] ?? 0
  }
}

/** 抽一帧存成 png。`ss` 非 null 时先定位，用来取「源在某一刻的那一帧」 */
async function extractFrame(file: string, out: string, ss: number | null): Promise<void> {
  const args = ['-hide_banner', '-v', 'error', '-y']
  if (ss !== null) args.push('-ss', String(ss))
  args.push('-i', file, '-frames:v', '1', out)
  await ffmpegOut(args)
}

/**
 * 两张同尺寸图的 PSNR（dB）。
 *
 * ⚠️ **`inf` 必须单独接住**：两个像素完全相同的帧给出的正是 `average:inf`，
 * 而 `Number('inf')` 是 `NaN`——直接用 `Number()` 会把「一模一样」读成「无法比较」，
 * 于是最强的那条断言（无损产物的首帧与源的关键帧**逐像素相同**）会静默变成
 * 一条永远不成立的装饰。实测踩到过。
 */
async function psnr(a: string, b: string): Promise<number> {
  const { err } = await ffmpegOut([
    '-hide_banner',
    '-i',
    a,
    '-i',
    b,
    '-lavfi',
    'psnr',
    '-f',
    'null',
    '-'
  ])
  const raw = err.match(/average:([0-9.]+|inf)/)?.[1]
  if (raw === undefined) return Number.NaN
  return raw === 'inf' ? Number.POSITIVE_INFINITY : Number(raw)
}

/** 直接问 ffmpeg 这个文件里有什么。`-i` 不带输出时退出码非 0，信息全在 stderr 上 */
async function probeOf(file: string): Promise<MediaInfo> {
  const result = await runFfmpeg(['-hide_banner', '-nostdin', '-i', file])
  return parseProbeOutput(result.stderr)
}

/**
 * 轮询直到所有任务都到达终态。
 *
 * ⚠️ **早退那一条是承重的，不是优化。** 以前这里只有「等到没有 queued / running 为止」，
 * 而**前面几节会留下一批「入队了但从不 start」的任务**（永远停在 queued）——
 * 于是此后**每一次** settle 都要白等满 90 秒超时。29 处调用乘以 90 秒就是四十多分钟，
 * 而那正是这个套件从约 7 分钟涨到半个钟头的**真正原因**（不是那些慢用例本身）。
 *
 * 判据是**结构性的**，不是「等够了就算」：一个 queued 任务要变成 running 只有两条路——
 * 测试自己调 start() / repump()（同步的，一轮轮询之内就发生了），
 * 或者**某个正在跑的任务结束时队列自己 pump**。而下面这条早退的前提正是
 * 「一个 running 都没有」，那时第二条路不可能发生，第一条路测试也不会再走
 * （它已经 await 到这里了）。所以「没有 running + 排队集合连着几轮不变 = 不可能再有进展」。
 *
 * 留 5 轮（600ms）余量而不是立刻返回：start() 与轮询之间本来就有调度间隙。
 */
async function settle(manager: TaskManager, timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  /** 上一轮看到的「排队中」的 id 集合。与这一轮相同、且没有 running 时，计一次停滞 */
  let lastQueued = ''
  let stalled = 0

  for (;;) {
    const tasks = manager.list()
    const running = tasks.filter((t) => t.status === 'running')
    const queued = tasks.filter((t) => t.status === 'queued')

    if (running.length === 0 && queued.length === 0) return

    const signature = queued
      .map((t) => t.id)
      .sort()
      .join(',')
    if (running.length === 0 && signature === lastQueued) {
      stalled += 1
      if (stalled >= 5) return
    } else {
      stalled = 0
    }
    lastQueued = signature

    if (Date.now() > deadline) return
    await delay(120)
  }
}

interface PeakSample {
  /** 采样期内「同时处于 running 的任务数」的最大值 */
  peak: number
  /** 是否观察到背压：有任务在跑的同时、还有任务在排队 */
  sawWaiting: boolean
  done: number
}

/**
 * 起 count 个同源任务，用 15ms 采样「同时处于 running 的任务数」的峰值。
 *
 * 15ms 比 UI 的 10Hz 推送节流快得多，所以抓得到任何瞬时越界。而这件事**看 UI 是看不出来的**：
 * 一批小文件两百毫秒就跑完了，几块卡片几乎是同时变绿的，跟「全都并发跑了」长得一模一样。
 */
async function measurePeak(
  manager: TaskManager,
  src: string,
  count: number,
  /** 目标格式。默认 mkv；测**并发档位**时必须显式钉一个必然重编码的目标 */
  toExt = 'mkv'
): Promise<PeakSample> {
  const ids: string[] = []
  for (let i = 0; i < count; i += 1) {
    const id = await addOne(manager, src)
    if (!id) continue
    manager.setTarget(id, toExt)
    ids.push(id)
  }

  let peak = 0
  let sawWaiting = false
  let sampling = true
  const sampler = (async () => {
    while (sampling) {
      const tasks = manager.list()
      const running = tasks.filter((t) => t.status === 'running').length
      if (running > peak) peak = running
      // 必须要求「同时」：任务刚加入时本来就全在排队，只看到排队说明不了任何事
      if (running > 0 && tasks.some((t) => t.status === 'queued')) sawWaiting = true
      await delay(15)
    }
  })()

  manager.start(ids)
  await settle(manager)
  sampling = false
  await sampler

  const done = manager.list().filter((t) => ids.includes(t.id) && t.status === 'done').length
  return { peak, sawWaiting, done }
}

async function waitFor(
  manager: TaskManager,
  predicate: (tasks: Task[]) => boolean,
  timeoutMs = 30_000
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (predicate(manager.list())) return true
    if (Date.now() > deadline) return false
    await delay(60)
  }
}

/**
 * 还有几个**本测试自己的**指定进程在跑（按命令行里的临时目录认）。
 *
 * ⚠️ 这里原先数的是**全机** `ffmpeg.exe` 个数（`tasklist /FI IMAGENAME eq ffmpeg.exe`）。
 * 那条判据在单线跑时没问题，但只要机器上**任何别的** ffmpeg 活着——并行的另一条线、
 * 用户自己开的一个转码、上一次跑崩留下的孤儿——它就会假红。实测（2026-09-13，
 * 四线并行验证时）：「2 秒内无残留」那一轮里红了 2 次，报的是 `取消前=1 取消后=3`，
 * 而那个「3」跟本次取消毫无关系。
 *
 * 判据要落在**本次转换的私有资源**上，所以用命令行里的临时目录把进程认出来。
 * ⚠️ `tasklist` **拿不到命令行**，只能走 PowerShell 的 CIM；代价是每次约 1 秒，
 * 而这一节只调两次，可以接受。
 *
 * ⚠️ 匹配用 `.Contains()` 而不是 `-like`：临时目录名里万一有 `[` 或 `*`，
 * `-like` 会把它当成通配符，于是匹配到别的进程——那是**静默地放松判据**。
 */
function countOwnProcesses(image: string): Promise<number> {
  // PowerShell 单引号串里只须转义单引号本身；反斜杠是字面量，不必翻倍
  const needle = TMP.replace(/'/g, "''")
  const script =
    `@(Get-CimInstance Win32_Process -Filter "Name='${image}'" | ` +
    `Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${needle}') }).Count`

  return new Promise((done) => {
    const child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true
    })
    let out = ''
    child.stdout.on('data', (c: Buffer) => {
      out += c.toString('utf8')
    })
    // 拿不到就报 0：这一节的两条断言都靠它，报一个假的非零数会让「取消前确实
    // 有 ffmpeg 在跑」那条红得莫名其妙
    const finish = (): void => done(Number.parseInt(out.trim(), 10) || 0)
    child.on('close', finish)
    child.on('error', () => done(0))
  })
}

/**
 * 直接调 7z.exe 造测试素材。
 *
 * 这属于 arrange 阶段「把引擎当工具用」，不是被测代码——就像用 ffmpeg 生成测试视频一样。
 * 好处是输入素材不是我们的打包逻辑造出来的，闭环不会自我印证。
 */
function run7z(args: string[], cwd?: string): Promise<{ code: number; out: string }> {
  return new Promise((done) => {
    const child = spawn(SEVENZIP, args, { windowsHide: true, cwd })
    let out = ''
    child.stdout.on('data', (c: Buffer) => (out += c.toString('utf8')))
    child.stderr.on('data', (c: Buffer) => (out += c.toString('utf8')))
    child.on('error', () => done({ code: -1, out }))
    child.on('close', (code) => done({ code: code ?? -1, out }))
  })
}

/**
 * 列出压缩包里的条目（相对路径、正斜杠、已排序）。
 *
 * 光断言「产物存在且非空」是查不出问题的：打包时漏掉子目录、或者把中间层的
 * `.tar` 当成内容压进去，产物一样是「存在且非空」。必须核对条目本身。
 */
async function listArchive(archive: string): Promise<string[]> {
  const { out } = await run7z(['l', '-slt', archive])
  const self = archive.replace(/\\/g, '/')
  return out
    .split(/\r?\n/)
    .filter((line) => line.startsWith('Path = '))
    .map((line) => line.slice('Path = '.length).trim().replace(/\\/g, '/'))
    .filter((name) => name !== self)
    .sort()
}

/** 用 ffmpeg 生成一张静态图（png / bmp ...），避开 sharp 自产自销 */
async function makeStill(path: string, size = '320x240'): Promise<boolean> {
  const result = await runFfmpeg([
    '-hide_banner',
    '-y',
    '-f',
    'lavfi',
    '-i',
    `testsrc=size=${size}:rate=1`,
    '-frames:v',
    '1',
    path
  ])
  return result.code === 0
}

/**
 * 把素材从 fixtures 复制到临时目录再用。
 *
 * 转换默认把产物写在源文件旁边，所以直接拿 fixtures 里的文件起任务，输出就会落进
 * 素材目录、把受版本控制的内容写脏。而且同名文件会被自动改名为 `xxx (1).jpg`，
 * 看起来像是测试自己在造素材，跑几轮才发现目录里多了几十个文件。
 */
async function stageFixture(name: string): Promise<string> {
  const dest = resolve(TMP, 'fixtures', name)
  await mkdir(dirname(dest), { recursive: true })
  await copyFile(resolve(FIXTURES, name), dest)
  return dest
}

/** 加入一个文件并返回新任务的 id（按 id 差集取，避免误命中同路径的历史任务） */
async function addOne(manager: TaskManager, input: string): Promise<string | null> {
  const before = new Set(manager.list().map((t) => t.id))
  const outcome = await manager.addPaths([input])
  if (outcome.added !== 1) return null
  return manager.list().find((t) => !before.has(t.id))?.id ?? null
}

/** 加任务 → 设目标格式 → 跑到终态，返回最终的任务状态 */
async function convertOne(
  manager: TaskManager,
  input: string,
  toExt: string
): Promise<Task | null> {
  const id = await addOne(manager, input)
  if (!id) return null
  manager.setTarget(id, toExt)
  manager.start([id])
  await settle(manager)
  return manager.list().find((t) => t.id === id) ?? null
}

/**
 * 后续断言一律通过这两个取数函数拿产物，不要直接写 `task!.outputPath!`。
 *
 * 加 `!` 的写法在转换失败时会抛异常，整个套件崩在半路——后面几十条断言一条都不会执行，
 * 真正的回归原因被一个 TypeError 盖住。返回 null / 空数组则只会让对应那条断言报 ✗。
 */
function outputOf(task: Task | null): string | null {
  return task?.status === 'done' && task.outputPath ? task.outputPath : null
}

async function imageMeta(task: Task | null): Promise<Metadata | null> {
  const path = outputOf(task)
  if (!path) return null
  return sharp(path)
    .metadata()
    .catch(() => null)
}

async function entriesOf(task: Task | null): Promise<string[]> {
  const path = outputOf(task)
  return path ? listArchive(path) : []
}

async function listFiles(dir: string): Promise<string[]> {
  return readdir(dir).catch(() => [] as string[])
}

/* ------------------------------------------------------------------ 主流程 */

async function main(): Promise<void> {
  console.log('=== 任务编排集成测试 ===')

  await rm(TMP, { recursive: true, force: true })
  await mkdir(TMP, { recursive: true })

  updateSettings({
    outputBesideSource: true,
    outputDir: null,
    onConflict: 'rename',
    maxConcurrent: 4
  })

  const patches: TasksPatchMessage[] = []
  const manager = new TaskManager((message) => patches.push(message))

  /* ---------------------------------------------------------- [1] 加入队列 */

  console.log('\n[1] 加入队列与校验')

  const shortVideo = resolve(TMP, 'clip.mp4')
  check('生成测试视频 clip.mp4', await makeVideo(shortVideo, 4))

  const emptyFile = resolve(TMP, 'empty.mp4')
  await writeFile(emptyFile, '')

  const noExt = resolve(TMP, 'noextension')
  await writeFile(noExt, 'x')

  const weird = resolve(TMP, 'unsupported.xyzzy')
  await writeFile(weird, 'x')

  const result = await manager.addPaths([
    shortVideo,
    resolve(TMP, 'ghost.mp4'),
    emptyFile,
    noExt,
    weird,
    resolve(TMP, 'some-folder')
  ])

  check('只接受合法文件', result.added === 1, `added=${result.added}`)
  check('每个被拒文件都有原因', result.rejected.length === 5, `${result.rejected.length} 条`)
  check(
    '拒绝原因具体而非泛泛',
    result.rejected.every((r) => r.reason.length >= 3)
  )

  const task = manager.list()[0]
  check('任务默认目标格式为 mkv（不与源格式相同）', task.toExt === 'mkv', task.toExt)
  check('任务初始状态为排队', task.status === 'queued', task.status)
  check('输入名解析正确', task.inputName === 'clip.mp4', task.inputName)

  check(
    '临时文件保留扩展名（ffmpeg 靠它推断封装格式）',
    partPathOf('D:\\out\\clip.mkv') === 'D:\\out\\clip.part.mkv',
    partPathOf('D:\\out\\clip.mkv')
  )
  check(
    '目录名里的点不算扩展名',
    partPathOf('D:\\a.b\\noext') === 'D:\\a.b\\noext.part',
    partPathOf('D:\\a.b\\noext')
  )

  /* ---------------------------------------------------------- [2] 真实转换 */

  console.log('\n[2] 真实 ffmpeg 转换')

  manager.start([task.id])
  await settle(manager)

  const done = manager.list()[0]
  check('任务完成', done.status === 'done', `${done.status} ${done.error ?? ''}`)
  check('产物路径已记录', typeof done.outputPath === 'string' && extOf(done.outputPath) === 'mkv')
  check('产物体积非空', (done.sizeBytes ?? 0) > 0, `${done.sizeBytes} 字节`)

  const size = await stat(done.outputPath!)
    .then((s) => s.size)
    .catch(() => 0)
  check('磁盘上确实存在该文件', size > 0, `${size} 字节`)
  check('最终没有留下 .part', !(await listFiles(TMP)).some((f) => f.includes('.part')))

  /* ---------------------------------------------------------- [3] 不覆盖 */

  console.log('\n[3] 同名不覆盖 + 并发占位')

  const again = await manager.addPaths([shortVideo])
  check('同一文件可再次加入', again.added === 1)

  const second = manager.list().find((t) => t.status === 'queued')!
  manager.start([second.id])
  await settle(manager)

  const outputs = manager
    .list()
    .filter((t) => t.status === 'done')
    .map((t) => t.outputPath!)
  const names = outputs.map((p) => p.split(/[\\/]/).pop())
  check('第二个产物自动改名而非覆盖', names.includes('clip (1).mkv'), names.join(', '))
  check('两个产物是不同的文件', new Set(outputs).size === outputs.length)

  /* ---------------------------------------------------------- [4] 并发上限 */

  console.log('\n[4] 并发调度')

  check(
    'ffmpeg 容量是 12 份（小文件快车道；大文件按 3 份计 → 收敛到 4 路）',
    engineLimit('ffmpeg') === 12,
    String(engineLimit('ffmpeg'))
  )
  // 代价分档。这是**常量层面的**判据，行为层面的在下面那一节（峰值断言）。
  // 否证：把 FAST_LANE_MAX_BYTES 改小/HEAVY_COST 改成 1 → 对应那条翻红。
  check(
    '小输入按 1 份计（≤ 1 MiB）',
    taskCost('ffmpeg', 8 * 1024) === 1 && taskCost('ffmpeg', 1024 * 1024) === 1,
    String(taskCost('ffmpeg', 1024 * 1024))
  )
  check(
    '大输入按 3 份计（> 1 MiB）',
    taskCost('ffmpeg', 1024 * 1024 + 1) === 3 && taskCost('ffmpeg', 70 * 1024 * 1024) === 3,
    String(taskCost('ffmpeg', 70 * 1024 * 1024))
  )
  check(
    '量不到体积时按重的算（宁可慢一点，不拿内存去赌）',
    taskCost('ffmpeg', undefined) === 3,
    String(taskCost('ffmpeg', undefined))
  )
  check(
    '非 ffmpeg 引擎不参与分档，一律 1 份',
    taskCost('sharp', 70 * 1024 * 1024) === 1 && taskCost('archive', 70 * 1024 * 1024) === 1
  )
  check('LibreOffice 被限制为单实例', engineLimit('libreoffice') === 1)
  check('pdf 渲染被限制为单实例', engineLimit('pdf') === 1)

  // 上面三条只说明「单个引擎的上限常量是几」，说明不了全局上限 maxConcurrent 有没有真的
  // 生效——而「设了 4 却跑了 5」恰恰是全局上限被忽略才会出现的症状。所以这里真量一次。
  //
  // 素材必须在**转码侧**够慢（12 秒 720p，实测单个约 0.4 秒），否则任务在一两个采样周期内
  // 就跑完，稳态根本不存在。clip.mp4 是 320x240，转码快到一个采样点都抓不到，不能用。
  const slowClip = resolve(TMP, 'slow-720p.mp4')
  check('生成转码较慢的素材 slow-720p.mp4', await makeLongVideo(slowClip, 12))

  // 全局上限刻意设成**低于引擎上限**（ffmpeg 是 4）。两者相等时，「忽略全局上限」和
  // 「尊重全局上限」的观测结果一模一样，那条断言就成了永远通过的装饰。
  updateSettings({
    outputBesideSource: true,
    outputDir: null,
    onConflict: 'rename',
    maxConcurrent: 2
  })
  const tight = await measurePeak(manager, slowClip, 5)
  check('引擎上限 4、全局上限 2 时，同时在跑的确实是 2', tight.peak === 2, `峰值 ${tight.peak}`)
  check('确实出现了背压（有任务在跑的同时还有任务在排队）', tight.sawWaiting)
  check('限流不影响最终结果，5 个任务全部完成', tight.done === 5, `${tight.done}/5`)

  // 上限 4、给 5 个任务：第 5 个必须等着，不能跑出去
  updateSettings({
    outputBesideSource: true,
    outputDir: null,
    onConflict: 'rename',
    maxConcurrent: 4
  })
  const loose = await measurePeak(manager, slowClip, 5)
  check('全局上限 4、5 个任务时，同时在跑的确实是 4', loose.peak === 4, `峰值 ${loose.peak}`)
  check('第 5 个任务确实排队等过', loose.sawWaiting)
  check('5 个任务全部完成', loose.done === 5, `${loose.done}/5`)

  // —— 排队期间改目标格式，队列里那条记录必须跟着换引擎桶。
  //
  // 并发上限是**按引擎分桶**算的（`pump()` 里 `running.get(e.engine) < engineLimit(e.engine)`），
  // 而 `start()` 在入队时就把 engine 快照进了队列条目。只改任务、不改条目的话，一个改用
  // 别的引擎的任务仍然占着旧桶、不占新桶——表现是**它卡在旧引擎的队尾不动**，而它想用的
  // 那个引擎明明空着；反过来，某个桶也能被塞进超过自己上限的个数。
  //
  // 判据选「立刻换桶」而不是「最终能不能转出来」：条目没换的话这个任务会一直等到 pdf 桶
  // 空出来，而 pdf 上限是 1、正被 A 占着。观测点就在 `setTarget` 返回的那一刻——
  // 这中间一次 await 都没有，所以不需要采样，也就没有时序竞态。
  const bucketPng = resolve(TMP, 'bucket.png')
  check('换桶素材 bucket.png', await makeStill(bucketPng))

  const blockerId = await addOne(manager, bucketPng)
  const moverId = await addOne(manager, bucketPng)
  check('换桶用例的两个任务都建起来了', blockerId !== null && moverId !== null)

  for (const bucketId of [blockerId, moverId]) {
    if (bucketId) manager.setTarget(bucketId, 'pdf')
  }
  manager.start([blockerId, moverId].filter((id): id is string => id !== null))

  check(
    '换桶前提：A 占着 pdf 桶（上限 1）在跑',
    manager.stats().perEngine.pdf === 1,
    JSON.stringify(manager.stats())
  )
  check(
    '换桶前提：B 正排在同一桶的队尾等',
    manager.stats().waiting === 1,
    JSON.stringify(manager.stats())
  )

  if (moverId) manager.setTarget(moverId, 'webp')
  const afterFlip = manager.stats()
  check(
    '排队期间改目标格式：队列条目跟着换桶了（不再卡在旧引擎的队尾）',
    afterFlip.perEngine.sharp === 1,
    JSON.stringify(afterFlip)
  )
  check(
    '换桶后旧桶不多不少（pdf 仍是 1）',
    afterFlip.perEngine.pdf === 1,
    JSON.stringify(afterFlip)
  )

  await settle(manager)

  // —— 自适应并发：小文件走快车道、大文件被代价闸门锁在 4 路。
  //
  // 这一节量的是**峰值同时在跑的任务数**（`measurePeak`），不是墙钟——墙钟在开发机
  // 上会随别的活飘（同一批文件同一个上限，实测在 699~1007 ms 之间），拿它当判据
  // 只会得到一条会飘的断言。峰值是离散的，采样窗口 15 ms 足够稳。
  //
  // 两个素材的差别**只在体积**（813 KiB vs 约 2 MiB），因为体积正是这一版的判据。
  // 目标一律钉 **avi**：h264 → mkv 会命中 remux（`-c copy`，一百多毫秒就跑完），
  // 那时峰值会恒为 1——量到的是「有没有并发」，而不是「有没有编码」。
  const heavyClip = resolve(TMP, 'heavy-720p.mp4')
  check('生成「重文件」素材（720p 30 秒，体积过 1 MiB）', await makeLongVideo(heavyClip, 30))
  check(
    '两个素材确实分在两个档上（否则下面三条是同义反复）',
    taskCost('ffmpeg', (await stat(slowClip)).size) === 1 &&
      taskCost('ffmpeg', (await stat(heavyClip)).size) === 3,
    `轻 ${(await stat(slowClip)).size} / 重 ${(await stat(heavyClip)).size} 字节`
  )

  updateSettings({
    outputBesideSource: true,
    outputDir: null,
    onConflict: 'rename',
    maxConcurrent: 12
  })

  const fastLane = await measurePeak(manager, slowClip, 8, 'avi')
  check(
    '上限 12 + 小文件：真的开出了 4 路以上（快车道生效，不是恒 4）',
    fastLane.peak > 4,
    `峰值 ${fastLane.peak}`
  )

  const gated = await measurePeak(manager, heavyClip, 8, 'avi')
  check(
    '上限 12 + 大文件：仍然只跑 4 路（代价闸门生效，内存不跟着上限走）',
    gated.peak === 4,
    `峰值 ${gated.peak}`
  )

  updateSettings({
    outputBesideSource: true,
    outputDir: null,
    onConflict: 'rename',
    maxConcurrent: 4
  })
  const capped = await measurePeak(manager, slowClip, 8, 'avi')
  check(
    '上限压回 4 + 小文件：快车道也跟着收回（设置仍然是上限，不是目标）',
    capped.peak === 4,
    `峰值 ${capped.peak}`
  )

  /* ---------------------------------------------------------- [5] 取消 */

  console.log('\n[5] 取消')

  const longVideo = resolve(TMP, 'long.mp4')
  check('生成较长的测试视频 long.mp4', await makeLongVideo(longVideo, 600))

  const cancelled = await manager.addPaths([longVideo])
  check('长视频已加入', cancelled.added === 1)

  const longTask = manager.list().find((t) => t.inputName === 'long.mp4')!

  // ⚠️ 必须显式钉一个**必然重编码**的目标，不能吃默认值。
  //
  // `targetsFor('mp4')` 会剔掉源格式自己，于是 `preferred.video = 'mp4'` 落空、
  // 退到 `targets[0]` = **mkv**——而 h264+aac → mkv **正好在 remux 白名单里**，
  // `-c copy` 一百多毫秒就把这 600 秒跑完了。表现是取消打在完成之后：
  // `状态变为已取消 ← done`、`取消前确实有 ffmpeg 在跑 ← 0 个`、
  // 百分比从 0 直接跳到 1（`0, 1, 1, 1`，正是 remux 的签名）。
  //
  // webm 只收 vp8/vp9/av1 的视频，h264 进不去，**任何情况下都不会 remux**，
  // 而 vp9 编码这 600 秒远超这里的 1.2 秒等待窗口。这条钉的是「够慢」，
  // 不是「默认值应该是 webm」——别把它读成对默认目标的断言。
  manager.setTarget(longTask.id, 'webm')

  manager.start([longTask.id])

  const started = await waitFor(manager, (tasks) =>
    tasks.some((t) => t.id === longTask.id && t.status === 'running')
  )
  check('任务进入运行中', started)

  // 等 ffmpeg 真正开始产出，确保取消打在转换中途而不是启动阶段
  await delay(1200)
  const stillRunning = manager.list().find((t) => t.id === longTask.id)!.status === 'running'
  check('取消时任务仍在转换中（否则根本测不到取消）', stillRunning)

  // 时长不再单独探测，而是从转换进程自己的 stderr 里捡（省掉一次进程启动，实测约 38% 墙钟）。
  // 这条链路一旦断掉，任务会一直停在「不确定进度」——进度条照样在动，只是永远没有百分比，
  // 光看 UI 完全看不出来，所以必须锁住。
  //
  // 判据是「有没有 determinate 推送」而不是「百分位是多少」：adopt 成功的那一刻会强制推一条
  // percent=0，捡不到时长则一条都不会有。下面再补一条「出现过非 0 的百分比」，确认百分位
  // 真的是算出来的、不是恒定 0。
  const longPercents = patches
    .flatMap((p) => p.updated)
    .filter((u) => u.id === longTask.id && u.progress?.kind === 'determinate')
    .map((u) => (u.progress as { percent: number }).percent)
  check(
    '长视频推送过确定进度（时长确实从转换的 stderr 里读到了）',
    longPercents.length > 0,
    `${longPercents.length} 条`
  )
  check(
    '中途出现过非 0 的百分比（不是恒定 0）',
    longPercents.some((v) => v > 0 && v < 1),
    longPercents.join(', ')
  )

  const beforeCancel = await countOwnProcesses('ffmpeg.exe')
  check('取消前确实有 ffmpeg 在跑', beforeCancel > 0, `${beforeCancel} 个`)

  manager.cancel([longTask.id])
  await waitFor(manager, (tasks) =>
    tasks.some((t) => t.id === longTask.id && t.status === 'canceled')
  )

  const afterCancel = manager.list().find((t) => t.id === longTask.id)!
  check('状态变为已取消', afterCancel.status === 'canceled', afterCancel.status)

  // 进程树的实际退出需要一点时间，给 2 秒（这正是验收标准里写的时限）
  await delay(2000)
  const leftover = await countOwnProcesses('ffmpeg.exe')
  check('2 秒内无本次测试的 ffmpeg 残留', leftover === 0, `${leftover} 个残留`)

  const partsLeft = (await listFiles(TMP)).filter((f) => f.includes('.part'))
  check('取消后 .part 被清理', partsLeft.length === 0, partsLeft.join(', '))

  // —— 退出路径：`shutdown()` 只发取消信号，`drain()` 必须真的等到终态。
  //
  // `main/index.ts` 的 `before-quit` 靠这两件事决定「什么时候才许刷盘」：刷早了，
  // 这批被取消的任务还没落终态、还没进历史，用户关掉应用后在历史页里查无此项。
  // 而 `runningCount()` **不能**用 `tokens.size` 去数：`shutdown()` 当场就把 tokens
  // 清空了，那一刻子进程还活着、终态还没落，数出来永远是 0，退出路径会以为已经收尾完毕。
  // 下面「shutdown 之后仍然 > 0」那条就是钉住这个错误实现的——改成 tokens.size 立刻翻红。
  const drainId = await addOne(manager, longVideo)
  check('退出路径：长视频入队一条', drainId !== null)
  // 同样的理由钉 webm（见上一条的说明）：下面断言的是「任务**还在跑**时 shutdown」，
  // 吃默认目标就会 remux，六百秒一百多毫秒跑完——`waitFor(running)` 到 `shutdown()`
  // 之间那个窗口一旦没赶上，终态会是 `done` 而不是 `canceled`。那是条会飘的断言。
  if (drainId) manager.setTarget(drainId, 'webm')
  manager.start(drainId ? [drainId] : [])
  await waitFor(manager, (tasks) => tasks.some((t) => t.id === drainId && t.status === 'running'))
  check('退出路径：任务确实跑起来了', manager.runningCount() >= 1, String(manager.runningCount()))

  manager.shutdown()
  check(
    '退出路径：shutdown 之后 runningCount 仍 > 0（说明还没收尾）',
    manager.runningCount() > 0,
    String(manager.runningCount())
  )
  const drained = await manager.drain(10_000)
  check('退出路径：drain 等到全部收尾', drained)
  check(
    '退出路径：收尾后 runningCount 归零',
    manager.runningCount() === 0,
    String(manager.runningCount())
  )
  const drainTask = manager.list().find((t) => t.id === drainId)
  check(
    '退出路径：任务已落到终态（历史才可能记上它）',
    drainTask?.status === 'canceled',
    String(drainTask?.status)
  )

  /* ---------------------------------------------------------- [6] 损坏文件 */

  console.log('\n[6] 损坏文件')

  const broken = resolve(TMP, 'broken.mkv')
  await writeFile(broken, 'this is definitely not a matroska file')

  const brokenAdd = await manager.addPaths([broken])
  check('损坏文件能加入队列（类型合法）', brokenAdd.added === 1)

  const brokenTask = manager.list().find((t) => t.inputName === 'broken.mkv')!
  manager.start([brokenTask.id])
  await settle(manager)

  const failedTask = manager.list().find((t) => t.id === brokenTask.id)!
  check('损坏文件进入错误态', failedTask.status === 'error', failedTask.status)
  check('错误摘要非空', (failedTask.error?.length ?? 0) > 0, failedTask.error)
  check(
    '保留了 stderr 尾部供排查',
    (failedTask.logTail?.length ?? 0) > 0,
    `${failedTask.logTail?.length ?? 0} 行`
  )
  check('失败没有留下 .part', !(await listFiles(TMP)).some((f) => f.includes('.part')))

  /* ---------------------------------------------------------- [7] 进度与推送 */

  console.log('\n[7] 进度推送')

  check('产生过增量推送', patches.length > 0, `${patches.length} 条`)
  check(
    '推送按 id 增量而非全量快照',
    patches.every((p) => Array.isArray(p.updated) && Array.isArray(p.removed))
  )

  const finishedPatch = patches
    .flatMap((p) => p.updated)
    .find((u) => u.id === task.id && u.status === 'done')
  check('完成状态被推送过', finishedPatch !== undefined)
  check(
    '完成时进度置为 100%',
    finishedPatch?.progress?.kind === 'determinate' && finishedPatch.progress.percent === 1
  )

  /* ---------------------------------------------------------- [8] 特殊文件名 */

  console.log('\n[8] 特殊字符文件名')

  // 验收标准里写的是「空格/引号/中文/&/emoji」。引号在 Windows 文件名里本来就不合法，
  // 所以换成一组真能落在磁盘上的刁钻字符：空格、中文、&、单引号、括号、#、emoji。
  // 这些字符对 spawn(exe, args[]) 的数组传参是无害的——因为根本不经过 shell 解析——
  // 但这条链路一旦哪天被改成拼字符串就会立刻炸，所以必须锁住。
  const nasty = resolve(TMP, "我的 视频 & test's (第2集) 🎬 #1.mp4")
  check('能创建这样的文件名', await makeVideo(nasty, 3))

  const nastyAdd = await manager.addPaths([nasty])
  check('特殊字符文件名可加入队列', nastyAdd.added === 1, JSON.stringify(nastyAdd.rejected))

  const nastyTask = manager.list().find((t) => t.inputPath === nasty)!
  manager.start([nastyTask.id])
  await settle(manager)

  const nastyDone = manager.list().find((t) => t.id === nastyTask.id)!
  check('转换成功', nastyDone.status === 'done', `${nastyDone.status} ${nastyDone.error ?? ''}`)
  check(
    '产物文件名保留了原始字符',
    (nastyDone.outputPath ?? '').includes("test's (第2集) 🎬 #1"),
    nastyDone.outputPath
  )
  check(
    '产物确实落盘',
    ((await stat(nastyDone.outputPath!).catch(() => ({ size: 0 }))).size ?? 0) > 0
  )

  // 以 - 开头的文件名会被 ffmpeg / pandoc 当成命令行选项，这是比 shell 注入更隐蔽的
  // 参数注入。这里靠「输入输出一律转成绝对路径」来化解：以盘符开头就不可能被当成选项。
  const dashFile = resolve(TMP, '-dash-prefixed.mp4')
  check('能创建以 - 开头的文件名', await makeVideo(dashFile, 3))

  const dashAdd = await manager.addPaths([dashFile])
  check('以 - 开头的文件可加入队列', dashAdd.added === 1, JSON.stringify(dashAdd.rejected))

  const dashTask = manager.list().find((t) => t.inputPath === dashFile)!
  manager.start([dashTask.id])
  await settle(manager)

  const dashDone = manager.list().find((t) => t.id === dashTask.id)!
  check(
    '转换成功且未被当作命令行选项',
    dashDone.status === 'done',
    `${dashDone.status} ${dashDone.error ?? ''}`
  )

  /* ---------------------------------------------------------- [9] 图片引擎 */

  console.log('\n[9] sharp 图片引擎')

  // sharp 从常量 2 提到了「核数 - 1，上限 4」。实测 4032x3024 JPEG → JPEG q90 共 24 张：
  // 并发 2 是 6343 ms、并发 4 是 **3629 ms**（1.75×），并发 6 与 4 持平（平台化）。
  // 判据写成**公式**而不是 `=== 4`：这台 24 核机器上是 4，而 2 核的小机器上就该是 1，
  // 写死 4 会让那条断言在别的机器上变成假的。
  check(
    'sharp 容量跟核数走（留一核给 UI，上限 4）',
    engineLimit('sharp') === Math.min(4, Math.max(1, cpus().length - 1)),
    `${engineLimit('sharp')}（${cpus().length} 核）`
  )

  // 这几个是能力矩阵里的分歧点。engineFor 是 main 与 renderer 共用的同一份判断，
  // 一旦被改错，UI 上显示的引擎和真正执行的引擎就会对不上——而且只有跑到才暴露。
  check(
    'HEIC → jpg 路由给 sharp',
    engineFor('heic', 'jpg') === 'sharp',
    String(engineFor('heic', 'jpg'))
  )
  check(
    'png → bmp 路由给 ffmpeg（sharp 写不出 bmp）',
    engineFor('png', 'bmp') === 'ffmpeg',
    String(engineFor('png', 'bmp'))
  )
  check(
    'png → pdf 路由给 pdf 引擎',
    engineFor('png', 'pdf') === 'pdf',
    String(engineFor('png', 'pdf'))
  )
  check('png 的目标里有 gif', targetsFor('png').includes('gif'), targetsFor('png').join(','))

  // HEIC 的像素只能经 libheif 解出来再交 sharp，而 sharp 写不出 bmp/ico。
  // 这两个目标对 HEIC 是真做不到——列出来只会让用户选了才失败。
  const heicTargets = targetsFor('heic')
  check(
    'HEIC 不列出做不到的目标（bmp / ico）',
    !heicTargets.includes('bmp') && !heicTargets.includes('ico'),
    heicTargets.join(',')
  )

  const pngSrc = resolve(TMP, 'still.png')
  check('生成测试图片 still.png', await makeStill(pngSrc))

  const toJpg = await convertOne(manager, pngSrc, 'jpg')
  check('png → jpg 完成', toJpg?.status === 'done', `${toJpg?.status} ${toJpg?.error ?? ''}`)
  check('png → jpg 走 sharp', toJpg?.engine === 'sharp', String(toJpg?.engine))
  const jpgMeta = await imageMeta(toJpg)
  check('产物确实是 JPEG', jpgMeta?.format === 'jpeg', String(jpgMeta?.format))

  const toWebp = await convertOne(manager, pngSrc, 'webp')
  check('png → webp 完成', toWebp?.status === 'done', `${toWebp?.status} ${toWebp?.error ?? ''}`)

  const toGif = await convertOne(manager, pngSrc, 'gif')
  check(
    'png → gif 完成（gif 是本次新加进能力矩阵的目标）',
    toGif?.status === 'done',
    `${toGif?.status} ${toGif?.error ?? ''}`
  )

  // bmp 是「sharp 做不到、只能甩给 ffmpeg」的那条岔路
  const toBmp = await convertOne(manager, pngSrc, 'bmp')
  check('png → bmp 由 ffmpeg 承接', toBmp?.engine === 'ffmpeg', String(toBmp?.engine))
  check('png → bmp 完成', toBmp?.status === 'done', `${toBmp?.status} ${toBmp?.error ?? ''}`)
  const bmpPath = outputOf(toBmp)
  const bmpHead = bmpPath
    ? (await readFile(bmpPath).catch(() => Buffer.alloc(0))).subarray(0, 2).toString('latin1')
    : ''
  check('产物是真正的 BMP（文件头 BM）', bmpHead === 'BM', bmpHead)

  /* --- HEIC：两个引擎都解不了 HEVC，只能绕 WASM 版 libheif --- */

  const heicSingle = await stageFixture('heic-single.heic')
  const heicJpg = await convertOne(manager, heicSingle, 'jpg')
  check(
    'HEVC 系 HEIC → jpg 完成（sharp 与 ffmpeg 都解不了，走 libheif WASM）',
    heicJpg?.status === 'done',
    `${heicJpg?.status} ${heicJpg?.error ?? ''}`
  )
  check('HEIC → jpg 走 sharp 引擎', heicJpg?.engine === 'sharp', String(heicJpg?.engine))
  const heicMeta = await imageMeta(heicJpg)
  check(
    '尺寸与源一致（1440x960）',
    heicMeta?.width === 1440 && heicMeta?.height === 960,
    `${heicMeta?.width}x${heicMeta?.height}`
  )
  check('产物是 JPEG', heicMeta?.format === 'jpeg', String(heicMeta?.format))

  const heicPng = await convertOne(manager, heicSingle, 'png')
  check('HEIC → png 完成', heicPng?.status === 'done', `${heicPng?.status} ${heicPng?.error ?? ''}`)

  // 多图 HEIC：libheif 按文件顺序返回，缩略图排在主图前面。
  // 直接取 data[0] 会静默转出一张缩略图——不报错，只是画质莫名其妙地差。
  const heicMulti = await stageFixture('heic-multiframe.heic')
  const multiJpg = await convertOne(manager, heicMulti, 'jpg')
  check(
    '多图 HEIC → jpg 完成',
    multiJpg?.status === 'done',
    `${multiJpg?.status} ${multiJpg?.error ?? ''}`
  )
  const multiMeta = await imageMeta(multiJpg)
  check(
    '取到的是主图 1000x680，而不是排在前面的 480x320 缩略图',
    multiMeta?.width === 1000 && multiMeta?.height === 680,
    `${multiMeta?.width}x${multiMeta?.height}`
  )

  // 分流判据 `compression === 'hevc'` 是承重的，两个方向都会砸掉真实文件：
  //   AV1 系走 sharp 原生能读，交给 WASM 反而报 "input buffer is not a HEIC image"
  //   HEVC 系走 sharp 原生报 bad seek，必须交给 WASM
  const heicAv1 = await stageFixture('heic-av1.heic')
  const av1Jpg = await convertOne(manager, heicAv1, 'jpg')
  check(
    'AV1 系 HEIF → jpg 完成（走 sharp 原生而不绕 WASM）',
    av1Jpg?.status === 'done',
    `${av1Jpg?.status} ${av1Jpg?.error ?? ''}`
  )
  const av1Meta = await imageMeta(av1Jpg)
  check(
    'AV1 系尺寸保持 320x200',
    av1Meta?.width === 320 && av1Meta?.height === 200,
    `${av1Meta?.width}x${av1Meta?.height}`
  )

  const brokenImage = resolve(TMP, 'broken.png')
  await writeFile(brokenImage, 'this is definitely not a png')
  const brokenImageTask = await convertOne(manager, brokenImage, 'jpg')
  check('损坏图片进入错误态', brokenImageTask?.status === 'error', String(brokenImageTask?.status))
  check('损坏图片的错误信息可读', (brokenImageTask?.error?.length ?? 0) > 0, brokenImageTask?.error)
  check(
    '损坏图片没有留下 .part',
    !(await listFiles(TMP)).some((f) => f.includes('.part')),
    (await listFiles(TMP)).filter((f) => f.includes('.part')).join(', ')
  )

  /* --- 取消：必须在**编码开始之前**就被看到（审计 §3.9） --- */

  // `sharp.toFile()` 没有中止接口（不像子进程能 killTree），所以「取消」在图片这条路上
  // 只能是**前置检查**：编码开始之前、以及体积搜索的每一轮之前各看一次。
  // 此前只有末尾那一处检查，于是「取消一张大图」的真实行为是：CPU 照跑满、占着 sharp 的
  // 并发槽位、编完之后把结果丢掉再报「已取消」——用户点了取消却看着风扇转了三秒。
  //
  // 判据用一枚**毒药**而不是掐表：那条 resize 的宽度是 0，sharp 在**建管线那一瞬间**
  // 就会抛 `Expected positive integer between 1 and 100000000 for width but received 0`。
  // 于是两条断言把这件事说死：
  //   - 没取消时它抛「转换失败」并且带上 width 那句话 → 毒药真的会响，下面那条不是空转；
  //   - 已经取消时抛「已取消」→ 说明我们**根本没走到建管线**那一步（否则先响的是毒药，
  //     而 runSharp 会把它包成 ConversionFailed）。
  // 写成「耗时 < X 毫秒」也能测，但那要真去编一张大图，而且会随机器负载飘。
  const poison = (cancel: CancelToken): ConvertContext => ({
    input: pngSrc,
    output: resolve(TMP, 'cancel-poison.jpg'),
    fromExt: 'png',
    toExt: 'jpg',
    cancel,
    onProgress: () => undefined,
    options: {
      filters: [{ kind: 'resize', width: 0, height: 0, fit: 'inside', withoutEnlargement: true }]
    }
  })

  const poisonError = await runSharp(poison(new CancelToken())).then(
    () => null,
    (error: unknown) => error
  )
  check(
    '对照组：毒药 filter 在未取消时真的会响（它是下面那条断言的前置条件）',
    poisonError instanceof ConversionFailed && poisonError.logTail.join(' ').includes('width'),
    poisonError instanceof ConversionFailed ? poisonError.logTail.join(' ') : String(poisonError)
  )

  const preCanceled = new CancelToken()
  preCanceled.cancel()
  const canceledError = await runSharp(poison(preCanceled)).then(
    () => null,
    (error: unknown) => error
  )
  check(
    '取消在编码**之前**就被看到：连管线都没建（抛的是「已取消」，不是那句话 width 报错）',
    canceledError instanceof ConversionCanceled,
    canceledError instanceof Error
      ? `${canceledError.name}: ${canceledError.message}`
      : String(canceledError)
  )
  check(
    '被取消的图片任务不留产物、也不留 .part',
    !(await listFiles(TMP)).some((f) => f.startsWith('cancel-poison'))
  )

  // ---- 第二轮：取消**打在体积搜索中间**，剩下的试探必须停下来 ----
  //
  // 上面那条只能证明「一进来就取消」会被看到（拦在第一个 progress 上）。真正需要每轮
  // 都检查的是**体积搜索**：它要按质量反复编同一张图，最多编八遍，用户在这中间点了取消
  // 不该把剩下的七遍编完。判据用**试探轮次**（stage 文案里的「第 N 次试探」）而不是耗时：
  // 轮次是确定的，而耗时随负载飘。
  const noiseSrc = resolve(TMP, 'cancel-noise.png')
  await sharp(randomBytes(1200 * 800 * 3), { raw: { width: 1200, height: 800, channels: 3 } })
    .png()
    .toFile(noiseSrc)

  // 400 KB 的目标体积刻意落在这张图的 q100 与 q20 之间（噪声图在 JPEG 下两头差好几倍），
  // 于是搜索**必然**跑起来，而不是一次试探就命中。
  const searchCap = 400 * 1024
  const searchCtx = (
    cancel: CancelToken,
    onProgress: (p: TaskProgress) => void,
    outputName: string
  ): ConvertContext => ({
    input: noiseSrc,
    output: resolve(TMP, outputName),
    fromExt: 'png',
    toExt: 'jpg',
    cancel,
    onProgress,
    options: { output: { targetBytes: searchCap } }
  })
  /** 从 stage 文案里读「第 N 次试探」，返回见过的最大轮次 */
  const roundsSeen = (stages: string[]): number =>
    stages.reduce((max, stage) => {
      const m = /第 (\d+) 次试探/.exec(stage)
      return m ? Math.max(max, Number(m[1])) : max
    }, 0)

  const controlStages: string[] = []
  await runSharp(
    searchCtx(
      new CancelToken(),
      (p) => {
        if (typeof p.stage === 'string') controlStages.push(p.stage)
      },
      // 对照组用**另一个输出名**：它是一次成功的转换，产物会留在 TMP 里，
      // 与下面那条「取消之后不留产物」的断言撞名（第一版就是这么假红的）
      'search-control.jpg'
    )
  )
  const controlRounds = roundsSeen(controlStages)
  check(
    '对照组：这条体积搜索真的跑了多轮（下面那条断言的前置条件）',
    controlRounds >= 3,
    `controlRounds=${controlRounds} ${controlStages.join(' / ')}`
  )

  const midCancel = new CancelToken()
  const canceledStages: string[] = []
  const midError = await runSharp(
    searchCtx(
      midCancel,
      (p) => {
        if (typeof p.stage === 'string') canceledStages.push(p.stage)
        // 用户在第 1 轮试探的进度上点了取消
        if (typeof p.stage === 'string' && /第 1 次试探/.test(p.stage)) midCancel.cancel()
      },
      'cancel-search.jpg'
    )
  ).then(
    () => null,
    (error: unknown) => error
  )
  const canceledRounds = roundsSeen(canceledStages)
  check(
    '体积搜索中间取消：抛的是「已取消」',
    midError instanceof ConversionCanceled,
    midError instanceof Error ? `${midError.name}` : String(midError)
  )
  check(
    '体积搜索中间取消：剩下的试探没有继续编（轮次明显少于对照组）',
    controlRounds >= 3 && canceledRounds < controlRounds,
    `canceled=${canceledRounds} control=${controlRounds}`
  )
  check(
    '被取消的搜索不留产物、也不留 .part',
    !(await listFiles(TMP)).some((f) => f.startsWith('cancel-search'))
  )

  /* ---------------------------------------------------------- [10] 压缩包 */

  console.log('\n[10] 7-Zip 压缩包')

  check('archive 并发上限为 2', engineLimit('archive') === 2, String(engineLimit('archive')))
  check(
    'zip → 7z 路由给 archive',
    engineFor('zip', '7z') === 'archive',
    String(engineFor('zip', '7z'))
  )
  check(
    '压缩包的目标里不含源格式自身',
    !targetsFor('zip').includes('zip') && !targetsFor('rar').includes('rar'),
    targetsFor('zip').join(',')
  )

  // 素材树刻意放了一个叫 `-y.txt` 的文件：它的名字长得像个 7z 开关
  // （-y = 全部回答 yes）。这类参数注入比 shell 注入隐蔽得多。
  const archSrc = resolve(TMP, 'arch-src')
  await mkdir(resolve(archSrc, 'sub', 'deep'), { recursive: true })
  await mkdir(resolve(archSrc, 'sub', 'empty'), { recursive: true })
  await writeFile(resolve(archSrc, 'a.txt'), 'hello archive')
  await writeFile(resolve(archSrc, '-y.txt'), 'looks like a switch')
  await writeFile(resolve(archSrc, 'sub', 'b.txt'), 'nested')
  await writeFile(resolve(archSrc, 'sub', 'deep', 'c.txt'), 'deeper')

  const srcZip = resolve(TMP, 'plain.zip')
  const zipMade = await run7z(['a', '-tzip', '-mx=5', '--', srcZip, '*'], archSrc)
  check('造出测试 zip', zipMade.code === 0, zipMade.out.slice(-200))

  const srcEntries = await listArchive(srcZip)
  check(
    '源 zip 含 -y.txt 这类「像开关」的文件名',
    srcEntries.includes('-y.txt'),
    srcEntries.join(', ')
  )
  check('源 zip 含空目录', srcEntries.includes('sub/empty'), srcEntries.join(', '))

  const zip2seven = await convertOne(manager, srcZip, '7z')
  check(
    'zip → 7z 完成',
    zip2seven?.status === 'done',
    `${zip2seven?.status} ${zip2seven?.error ?? ''}`
  )
  check('产物扩展名是 7z', extOf(zip2seven?.outputPath ?? '') === '7z', zip2seven?.outputPath)
  // 逐个核对条目，而不是只看「产物存在」——漏掉子目录、多压进一层，产物一样「存在且非空」
  const sevenEntries = await entriesOf(zip2seven)
  check(
    'zip → 7z 条目与源完全一致（含 -y.txt 与空目录）',
    JSON.stringify(sevenEntries) === JSON.stringify(srcEntries),
    `源 ${srcEntries.join(',')} → 产物 ${sevenEntries.join(',')}`
  )

  const zip2tar = await convertOne(manager, srcZip, 'tar')
  check('zip → tar 完成', zip2tar?.status === 'done', `${zip2tar?.status} ${zip2tar?.error ?? ''}`)
  check(
    'zip → tar 条目与源一致',
    JSON.stringify(await entriesOf(zip2tar)) === JSON.stringify(srcEntries)
  )

  const src7z = resolve(TMP, 'plain.7z')
  check('造出测试 7z', (await run7z(['a', '-t7z', '-mx=5', '--', src7z, '*'], archSrc)).code === 0)

  const seven2zip = await convertOne(manager, src7z, 'zip')
  check(
    '7z → zip 完成',
    seven2zip?.status === 'done',
    `${seven2zip?.status} ${seven2zip?.error ?? ''}`
  )
  check(
    '7z → zip 条目与源一致',
    JSON.stringify(await entriesOf(seven2zip)) === JSON.stringify(srcEntries)
  )

  // 递归拆包：`7z x x.tgz` 只解掉 gzip 层，拿到的是 x.tar 而不是内容，
  // 必须再拆一趟。少了这一趟，产物里装的会是一个 .tar 文件。
  const layerTar = resolve(TMP, 'plain.tar')
  check('造出中间层 tar', (await run7z(['a', '-ttar', '--', layerTar, '*'], archSrc)).code === 0)
  check(
    '造出中间层 gzip',
    (await run7z(['a', '-tgzip', '--', 'plain.tar.gz', 'plain.tar'], TMP)).code === 0
  )
  const srcTgz = resolve(TMP, 'plain.tgz')
  await copyFile(resolve(TMP, 'plain.tar.gz'), srcTgz)

  const tgz2zip = await convertOne(manager, srcTgz, 'zip')
  check('tgz → zip 完成', tgz2zip?.status === 'done', `${tgz2zip?.status} ${tgz2zip?.error ?? ''}`)
  const tgzEntries = await entriesOf(tgz2zip)
  check(
    'tgz 递归拆到了底，没有把中间层的 .tar 当成内容',
    // length > 0 是承重的：任务失败时条目为空，而空数组上 .some() 恒为 false，
    // 少了它这条断言会变成永远通过的装饰（反证 2 里实测到了这一点）。
    tgzEntries.length > 0 && !tgzEntries.some((name) => name.endsWith('.tar')),
    tgzEntries.join(', ')
  )
  check(
    'tgz → zip 条目与源一致',
    JSON.stringify(tgzEntries) === JSON.stringify(srcEntries),
    `源 ${srcEntries.join(',')} → 产物 ${tgzEntries.join(',')}`
  )

  // 套娃家族的另一半。`tbz2` / `txz` 曾经只配了 LAYERED_SRC（「要不要拆第二趟」）
  // 而没登记进能力矩阵（「能不能作为源被接受」），于是拖进来的 .tbz2 连压缩包都不算——
  // 那两条拆包规则写在代码里却永远走不到。两处必须同时改，这条断言专门盯这件事。
  check('tbz2 被认作压缩包', categoryOf('tbz2') === 'archive')
  check('tbz2 能转 zip', targetsFor('tbz2').includes('zip'))

  check(
    '造出中间层 bzip2',
    (await run7z(['a', '-tbzip2', '--', 'plain.tar.bz2', 'plain.tar'], TMP)).code === 0
  )
  const srcTbz2 = resolve(TMP, 'plain.tbz2')
  await copyFile(resolve(TMP, 'plain.tar.bz2'), srcTbz2)

  const tbz2zip = await convertOne(manager, srcTbz2, 'zip')
  check('tbz2 → zip 完成', tbz2zip?.status === 'done', `${tbz2zip?.status} ${tbz2zip?.error ?? ''}`)
  const tbz2Entries = await entriesOf(tbz2zip)
  check(
    'tbz2 递归拆到了底，没有把中间层的 .tar 当成内容',
    tbz2Entries.length > 0 && !tbz2Entries.some((name) => name.endsWith('.tar')),
    tbz2Entries.join(', ')
  )
  check(
    'tbz2 → zip 条目与源一致',
    JSON.stringify(tbz2Entries) === JSON.stringify(srcEntries),
    `源 ${srcEntries.join(',')} → 产物 ${tbz2Entries.join(',')}`
  )

  // 进度映射：拆包占 0~45%、打包占 45~100%，中途还有「7z 不吐 100% 得自己补」的收尾。
  // 分段拼接最容易出的错就是回跳或冲出 [0,1]。
  const archPercents = patches
    .flatMap((p) => p.updated)
    .filter((u) => u.id === tgz2zip?.id && u.progress?.kind === 'determinate')
    .map((u) => (u.progress as { percent: number }).percent)
  check('归档转换推送过确定进度', archPercents.length > 0, `${archPercents.length} 条`)
  check(
    '拆包/打包的分段进度全程落在 [0,1]',
    archPercents.every((v) => v >= 0 && v <= 1),
    archPercents.join(', ')
  )
  check(
    '分段拼接后进度不回跳',
    archPercents.every((v, i) => i === 0 || v >= archPercents[i - 1]),
    archPercents.join(', ')
  )

  /* --- RAR：只有完整版 7z.exe + 7z.dll 才解得开，精简版 7za.exe 完全没这能力 --- */

  const rar4 = await stageFixture('rar3-comment-plain.rar')
  const rar4Task = await convertOne(manager, rar4, 'zip')
  check(
    'RAR4 → zip 完成（证明用的是完整版 7z.exe 而非 7za.exe）',
    rar4Task?.status === 'done',
    `${rar4Task?.status} ${rar4Task?.error ?? ''}`
  )
  check('rar 走 archive 引擎', rar4Task?.engine === 'archive', String(rar4Task?.engine))
  const rar4Entries = await entriesOf(rar4Task)
  check(
    'RAR4 的两个空文件都拆出来了',
    rar4Entries.includes('file1.txt') && rar4Entries.includes('file2.txt'),
    rar4Entries.join(', ')
  )

  const rar5 = await stageFixture('rar5-subdirs.rar')
  const rar5Task = await convertOne(manager, rar5, 'zip')
  check(
    'RAR5 → zip 完成',
    rar5Task?.status === 'done',
    `${rar5Task?.status} ${rar5Task?.error ?? ''}`
  )
  const rar5Entries = await entriesOf(rar5Task)
  check('RAR5 嵌套目录保留', rar5Entries.includes('sub/dir1/file1.txt'), rar5Entries.join(', '))
  check(
    'RAR5 含空格的路径保留',
    rar5Entries.includes('sub/with space/long fn.txt'),
    rar5Entries.join(', ')
  )
  check('RAR5 空目录保留', rar5Entries.includes('sub/empty'), rar5Entries.join(', '))

  /* --- 参数注入：源压缩包自己以 - 开头 --- */

  // -y 是 7z 的开关（全部回答 yes）。以 - 开头的路径若原样进 argv 就会被当成开关，
  // 这比 shell 注入隐蔽得多。化解办法是输入一律转绝对路径（以盘符开头就不可能被当选项）。
  const dashZip = resolve(TMP, '-y.zip')
  await copyFile(srcZip, dashZip)
  const dashZipTask = await convertOne(manager, dashZip, '7z')
  check(
    '以 - 开头的压缩包名不会被当成 7z 开关',
    dashZipTask?.status === 'done',
    `${dashZipTask?.status} ${dashZipTask?.error ?? ''}`
  )

  /* --- 空压缩包 --- */

  // 合法的空 zip 就是 22 字节的「中央目录结束记录」，规范如此，不必用 7z 造
  const emptyZip = resolve(TMP, 'empty.zip')
  await writeFile(emptyZip, Buffer.concat([Buffer.from('504b0506', 'hex'), Buffer.alloc(18)]))
  const emptyTask = await convertOne(manager, emptyZip, '7z')
  check('空压缩包进入错误态', emptyTask?.status === 'error', String(emptyTask?.status))
  check(
    '空压缩包给的是人话而不是 7z 的原始报错',
    (emptyTask?.error ?? '').includes('没有任何文件'),
    emptyTask?.error
  )
  check(
    '空压缩包没有留下 .part',
    !(await listFiles(TMP)).some((f) => f.includes('.part')),
    (await listFiles(TMP)).filter((f) => f.includes('.part')).join(', ')
  )

  /* --- 并发输出名占位（约束 9） --- */

  // 两个并发任务在各自写临时文件期间，磁盘上都还没有最终文件。只看「同名文件是否存在」
  // 会让它们解析到同一个名字，后完成的那个静默覆盖先完成的——产物数量对不上才发现得了。
  const concurrent: string[] = []
  for (let i = 0; i < 2; i += 1) {
    const id = await addOne(manager, src7z)
    if (id) concurrent.push(id)
  }
  check('同一个压缩包可并发加入两次', concurrent.length === 2, String(concurrent.length))

  for (const id of concurrent) manager.setTarget(id, 'zip')
  manager.start(concurrent)
  await settle(manager)

  const concurrentTasks = manager.list().filter((t) => concurrent.includes(t.id))
  check(
    '两个并发任务都完成',
    concurrentTasks.every((t) => t.status === 'done'),
    concurrentTasks.map((t) => t.status).join(', ')
  )
  const concurrentOut = concurrentTasks.map((t) => t.outputPath)
  check(
    '并发任务拿到了不同的输出名（占位生效，没有互相覆盖）',
    new Set(concurrentOut).size === 2,
    concurrentOut.join(' | ')
  )

  /* --- 取消：杀掉 7z 进程树 --- */

  // 侧重点和 ffmpeg 那条不同：7z 若没被杀掉，任务可能带着一个截断的压缩包收尾，
  // 那是「产物存在、大小非零、但内容不全」的静默损坏，比直接报错危险得多。
  //
  // 素材必须是**不可压缩**的随机数据：实测 -mx=5 打包 96 MB 随机数据要 6 秒出头，
  // 而同样体积的全零数据只要 0.4 秒——LZMA 的长游程匹配快到飞起，取消会落在完成之后。
  // 体积也不能再往上涨：240 MB 时耗时反而只比 120 MB 多一点点，已经撞到磁盘 I/O 的天花板。
  const bulkSrc = resolve(TMP, 'bulk-src')
  await mkdir(bulkSrc, { recursive: true })
  await writeFile(resolve(bulkSrc, 'blob.bin'), randomBytes(96 * 1024 * 1024))
  const bulkZip = resolve(TMP, 'bulk.zip')
  // -mx=0 存而不压：素材要造得快，把压缩耗时全部留给被测代码（它固定用 -mx=5）
  check(
    '造出大压缩包',
    (await run7z(['a', '-tzip', '-mx=0', '--', bulkZip, 'blob.bin'], bulkSrc)).code === 0
  )

  const bulkId = await addOne(manager, bulkZip)
  check('大压缩包已加入', bulkId !== null)
  manager.setTarget(bulkId!, '7z')
  manager.start([bulkId!])

  const bulkStarted = await waitFor(manager, (tasks) =>
    tasks.some((t) => t.id === bulkId && t.status === 'running')
  )
  check('大压缩包任务进入运行中', bulkStarted)

  // 等它真正开始产出（拆包那趟很快就过去，此时应当在打包），确保取消打在转换中途
  await delay(2500)
  const bulkStillRunning = manager.list().find((t) => t.id === bulkId)!.status === 'running'
  check('取消时任务仍在转换中（否则根本测不到取消）', bulkStillRunning)

  const sevenBeforeCancel = await countOwnProcesses('7z.exe')
  check('取消前确实有 7z.exe 在跑', sevenBeforeCancel > 0, `${sevenBeforeCancel} 个`)

  manager.cancel([bulkId!])
  await waitFor(manager, (tasks) => tasks.some((t) => t.id === bulkId && t.status === 'canceled'))
  const bulkTask = manager.list().find((t) => t.id === bulkId)!
  check('状态变为已取消', bulkTask.status === 'canceled', bulkTask.status)
  check('取消的任务没有产物路径', bulkTask.outputPath === undefined, String(bulkTask.outputPath))

  await delay(2000)
  const leftover7z = await countOwnProcesses('7z.exe')
  check('2 秒内无 7z.exe 残留', leftover7z === 0, `${leftover7z} 个残留`)
  check(
    '取消后 .part 被清理',
    !(await listFiles(TMP)).some((f) => f.includes('.part')),
    (await listFiles(TMP)).filter((f) => f.includes('.part')).join(', ')
  )

  /* ------------------------- [11] 历史记录：再行调律复现「当初」的目标格式 */

  console.log('\n[11] 历史记录：再行调律复现「当初」的目标格式')

  /*
    这一节盯的是 `history:rerun` 的**语义**：它复现的是当初那一次操作，所以目标格式
    取自历史条目自身的 `toExt`，而不是「当前偏好」。

    为什么值得拿一节来锁：偏好是用户随时会改的（设置页的「各类别默认目标格式」）。
    实现一旦滑回「按当前偏好算目标」，行上写着 `→ webp`、点下去产出 jpg，
    界面还报成功——正是本项目最忌讳的那种「静默换个结果」，光看 UI 看不出来。

    素材因此必须让**偏好与条目的 toExt 是两个不同、且都合法的值**，并额外断言
    二者确实不等。少了那一步，两边碰巧相等时下面那条断言恒绿，就成了装饰性断言
    （这个项目已经抓到过四条这类东西）。
  */

  // ⚠️ 先说清下面这个桩是干什么的：`scripts/electron-stub.ts` 里 `ipcMain.handle`
  // 是个**空函数**，直接调 `registerHistoryIpc()` 等于什么都没注册，也拿不到 handler。
  // 所以先把它换成「往表里记一笔」的桩，再调注册函数，然后照常调用拿到的 handler。
  // （那个桩是共享文件，这里**只读不改**；要往里加东西得先跟协调者说。）
  type IpcHandler = (event: unknown, raw: unknown) => unknown
  const ipcHandlers = new Map<string, IpcHandler>()
  const patchable = ipcMain as unknown as { handle: (channel: string, fn: IpcHandler) => void }
  patchable.handle = (channel, fn): void => {
    ipcHandlers.set(channel, fn)
  }
  registerHistoryIpc()

  // 历史与设置都写在 stub 的 userData 下；前面的用例未必碰过盘，这里补一次目录，
  // 免得落盘时因为目录不存在而把这一节整个崩掉。
  await mkdir(resolve('.tmp-test-stub', 'userData'), { recursive: true })

  const rerunSrc = resolve(TMP, 'rerun-src.png')
  await makeStill(rerunSrc)

  appendHistory({
    id: 'hist-rerun-1',
    inputPath: rerunSrc,
    inputName: 'rerun-src.png',
    category: 'image',
    fromExt: 'png',
    toExt: 'webp', // ← 当初那次的目标
    engine: 'sharp',
    status: 'done',
    outputPath: resolve(TMP, 'rerun-src.webp'),
    sizeBytes: 1234,
    createdAt: 1,
    startedAt: 2,
    finishedAt: 3
  })

  // 把偏好改成**另一个**合法目标，与条目上的 webp 不同。
  updateSettings({ defaultTargets: { image: 'jpg' } })

  check('webp 是 png 的合法出口', targetsFor('png').includes('webp'))
  check(
    '偏好算出来的是 jpg，与条目的 webp 不同（否则下面那条断言分不出对错）',
    resolveDefaultTarget('png', getSettings().defaultTargets) === 'jpg',
    String(resolveDefaultTarget('png', getSettings().defaultTargets))
  )

  const rerunHandler = ipcHandlers.get(CH.historyRerun)
  if (rerunHandler === undefined) throw new Error('history:rerun handler 没注册上')

  const rerunResult = (await rerunHandler({}, { ids: ['hist-rerun-1'] })) as AddResult
  check('再行调律：入队成功', rerunResult.added === 1, JSON.stringify(rerunResult))

  // 读的是 `getTaskManager()`：`history:rerun` 往它里面入队，而它与本节外面那个
  // 测试自己 `new` 出来的 `manager` **不是同一个实例**，拿错了就永远读到空。
  const rerunManager = getTaskManager()
  const rerunFresh = rerunManager.list().filter((t) => t.inputPath === rerunSrc)
  check('再行调律：新任务只有一条', rerunFresh.length === 1, String(rerunFresh.length))
  check(
    '再行调律：目标格式取自条目（webp），不是当前偏好（jpg）',
    rerunFresh[0]?.toExt === 'webp',
    String(rerunFresh[0]?.toExt)
  )

  // 反面：条目上的那个出口如今不再受支持 → 必须带理由拒绝，且**不能**入队。
  appendHistory({
    id: 'hist-rerun-2',
    inputPath: rerunSrc,
    inputName: 'rerun-src.png',
    category: 'image',
    fromExt: 'png',
    toExt: 'docx', // png 没有 docx 出口
    engine: 'sharp',
    status: 'done',
    outputPath: resolve(TMP, 'rerun-src.docx'),
    sizeBytes: 1234,
    createdAt: 1,
    startedAt: 2,
    finishedAt: 3
  })

  const rerunBefore = rerunManager.list().length
  const rerunBad = (await rerunHandler({}, { ids: ['hist-rerun-2'] })) as AddResult
  check('再行调律：出口不受支持时不入队', rerunBad.added === 0, JSON.stringify(rerunBad))
  check(
    '再行调律：拒绝理由是人话',
    rerunBad.rejected[0]?.reason === '不再支持转为 docx',
    String(rerunBad.rejected[0]?.reason)
  )
  check(
    '再行调律：校验排在入队之前（队列长度没变）',
    rerunManager.list().length === rerunBefore,
    `${rerunBefore} → ${rerunManager.list().length}`
  )

  // 收尾：等这一次 sharp 转换跑完再拆，别把还在跑的进程留给后面的用例。
  await settle(rerunManager)
  rerunManager.shutdown()

  /* ---------------------- [12] 同名文件：「略过」判在入队期，而不是执行期 */

  console.log('\n[12] 同名文件：「略过」判在入队期，而不是执行期')

  /*
    `onConflict: 'skip'` 的判据在 `TaskManager.addPaths` 里（`existsSync(naturalOutputPath(…))`），
    也就是**入队阶段**。这个位置是有意的，理由值得记住：

    任务的四个终态里没有一个能表达「按你的要求，什么都没做」。收 `error` 是在为一次
    用户主动要求的略过报错；收 `done` 则要在 `logTail` 里解释「其实什么都没做」——
    而 `TaskCard.tsx` 只在 `status === 'error'` 时渲染 `logTail`，那句话根本没人看得见，
    绿色的「已成」就成了假话。**入队时返回的 `rejected` 是唯一看得见的出口。**

    所以这一节只调 `addPaths`、**不调 `start()`**：被验证的判据整个发生在入队阶段，
    开跑反而会把「略过」与「执行期改名」两条不同路径的效果搅在一起。

    两个容易踩空的地方：
      - 源文件必须**非空**。`inspect()` 会把空文件判为「文件为空」而拒绝，那是另一条
        路径，会让人误以为略过判据没生效。
      - 每组之间要复位设置（`onConflict` / `outputBesideSource` / `outputDir`），
        否则上一步的残留会串味——尤其 [5][6] 把输出目录挪走过。
  */

  const skipSrc = resolve(TMP, 'skip', 'src')
  const skipOut = resolve(TMP, 'skip', 'out')
  await mkdir(skipSrc, { recursive: true })
  await mkdir(skipOut, { recursive: true })

  const skipSource = resolve(skipSrc, 'a.mp4')
  await writeFile(skipSource, Buffer.from('not-a-real-mp4-but-nonempty'))

  /** 复位到默认三项再叠加本组的差异。`updateSettings` 是**浅** patch，不显式复位就会串味。 */
  const skipCase = (patch: Partial<Settings>): void => {
    updateSettings({
      outputBesideSource: true,
      outputDir: null,
      onConflict: 'rename',
      // 视频默认目标钉死成 mkv：自然名跟着「内建默认」走的话，这里的期望值就不确定了
      defaultTargets: { video: 'mkv' },
      ...patch
    })
  }

  // 每次都起一个**空的** TaskManager：这一节只关心入队判据，
  // 复用外面那个 `manager` 会把前面用例的残留（`claimed` 集合等）带进来。
  const skipManager = (): TaskManager => new TaskManager((_m: TasksPatchMessage) => {})

  // —— [1] skip + 目标已存在 → 拒绝，且理由说清是「按设置略过」
  await writeFile(resolve(skipSrc, 'a.mkv'), Buffer.from('existing'))
  skipCase({ onConflict: 'skip' })
  let skipResult = await skipManager().addPaths([skipSource])
  check('skip+已存在：不入队', skipResult.added === 0, String(skipResult.added))
  check(
    'skip+已存在：rejected 恰好一条',
    skipResult.rejected.length === 1,
    String(skipResult.rejected.length)
  )
  check(
    'skip+已存在：理由是「按设置略过」',
    skipResult.rejected[0]?.reason === '目标已存在，按设置略过',
    String(skipResult.rejected[0]?.reason)
  )
  check(
    'skip+已存在：拒绝的是源文件本身',
    skipResult.rejected[0]?.path === skipSource,
    String(skipResult.rejected[0]?.path)
  )

  // —— [2] skip + 目标不存在 → 正常收入
  await rm(resolve(skipSrc, 'a.mkv'), { force: true })
  skipCase({ onConflict: 'skip' })
  skipResult = await skipManager().addPaths([skipSource])
  check('skip+不存在：照收', skipResult.added === 1, String(skipResult.added))
  check(
    'skip+不存在：没有拒绝',
    skipResult.rejected.length === 0,
    String(skipResult.rejected.length)
  )

  // —— [3] rename + 目标已存在 → 照收（「略过」不该污染 rename）
  await writeFile(resolve(skipSrc, 'a.mkv'), Buffer.from('existing'))
  skipCase({ onConflict: 'rename' })
  skipResult = await skipManager().addPaths([skipSource])
  check('rename+已存在：照收', skipResult.added === 1, String(skipResult.added))
  check(
    'rename+已存在：没有拒绝',
    skipResult.rejected.length === 0,
    String(skipResult.rejected.length)
  )

  // —— [4] overwrite + 目标已存在 → 照收（overwrite 就是要覆盖）
  skipCase({ onConflict: 'overwrite' })
  skipResult = await skipManager().addPaths([skipSource])
  check('overwrite+已存在：照收', skipResult.added === 1, String(skipResult.added))
  check(
    'overwrite+已存在：没有拒绝',
    skipResult.rejected.length === 0,
    String(skipResult.rejected.length)
  )

  // —— [5][6] 一对有分辨力的断言：判的必须是**输出目录**，不是源文件旁边。
  // 只写其中一半的话，判据错用了源目录也会全绿——那正是本项目反复吃亏的空转断言。
  await rm(resolve(skipSrc, 'a.mkv'), { force: true })
  await writeFile(resolve(skipSrc, 'a.mkv'), Buffer.from('decoy-in-source-dir'))
  skipCase({ onConflict: 'skip', outputBesideSource: false, outputDir: skipOut })
  skipResult = await skipManager().addPaths([skipSource])
  check(
    '输出目录干净、源目录有同名 → 照收（没被源目录的同名文件误拒）',
    skipResult.added === 1,
    String(skipResult.added)
  )

  await rm(resolve(skipSrc, 'a.mkv'), { force: true })
  await writeFile(resolve(skipOut, 'a.mkv'), Buffer.from('existing-in-out-dir'))
  skipResult = await skipManager().addPaths([skipSource])
  check('输出目录有同名 → 拒绝', skipResult.added === 0, String(skipResult.added))
  check(
    '输出目录有同名：理由同样是「按设置略过」',
    skipResult.rejected[0]?.reason === '目标已存在，按设置略过',
    String(skipResult.rejected[0]?.reason)
  )

  // —— [7] 同批两个文件转向同一本名、磁盘上都不存在 → 都放行。
  // 并发撞名走「执行期改名」，用户没有已存在的文件需要保护，不属于「略过」的适用范围。
  await rm(resolve(skipOut, 'a.mkv'), { force: true })
  const skipSource2 = resolve(skipSrc, 'a.mov')
  await writeFile(skipSource2, Buffer.from('not-a-real-mov-but-nonempty'))
  skipCase({ onConflict: 'skip' })
  skipResult = await skipManager().addPaths([skipSource, skipSource2])
  check('同批撞名但磁盘上没有 → 两个都收', skipResult.added === 2, String(skipResult.added))
  check(
    '同批撞名但磁盘上没有：没有拒绝',
    skipResult.rejected.length === 0,
    String(skipResult.rejected.length)
  )

  // —— [8] overwrite + 两个**并发**任务撞同一个本名 → 各写各的临时文件。
  //
  // 「覆盖」指的是盖掉用户磁盘上已有的那个文件，不包括我们自己两个任务抢同一个名字：
  // 临时名是最终名的纯函数（`partPathOf`），一旦两者解析到同一个最终名，两条流水线就会
  // 往**同一个 `.part`** 里写——产物内容取决于时序，而先收工的那条 rename 时会发现源文件
  // 已被另一条 rename 走，报出来的是「磁盘已满？」这种把人引向错方向的错。
  // 上面 [4] 只判到「入队照收」，执行期这一半此前没有断言盯着。
  //
  // 前提两条，缺一条这节就成了空转断言：**两条都指向同一个 webp 本名**（否则不会撞），
  // 以及并发上限 ≥ 2。后者不只是「跑得快一点」：两个任务在同一次 `pump()` 里被挑走，
  // 而占位发生在各自 `execute()` 的同步前缀里（第一个 await 之前），所以「A 先占、B 让开」
  // 是确定发生的，不是竞态里碰运气碰到的。
  const dupDir = resolve(TMP, 'dup', 'src')
  await mkdir(dupDir, { recursive: true })
  const dupPng = resolve(dupDir, 'dup.png')
  const dupJpg = resolve(dupDir, 'dup.jpg')
  check('撞名素材：dup.png', await makeStill(dupPng))
  check('撞名素材：dup.jpg', await makeStill(dupJpg))

  updateSettings({
    outputBesideSource: true,
    outputDir: null,
    onConflict: 'overwrite',
    maxConcurrent: 2,
    defaultTargets: { image: 'webp' }
  })

  const dupManager = new TaskManager((_m: TasksPatchMessage) => {})
  const dupIds: string[] = []
  for (const dupSrc of [dupPng, dupJpg]) {
    const dupId = await addOne(dupManager, dupSrc)
    if (dupId) dupIds.push(dupId)
  }
  check('撞名：两个都入队了', dupIds.length === 2, String(dupIds.length))
  dupManager.start(dupIds)
  await settle(dupManager)

  const dupTasks = dupManager.list().filter((t) => dupIds.includes(t.id))
  const dupOutputs = dupTasks.map((t) => outputOf(t))
  check(
    '撞名前提：两条的目标都是 webp（否则根本不会撞上）',
    dupTasks.length === 2 && dupTasks.every((t) => t.toExt === 'webp'),
    dupTasks.map((t) => t.toExt).join(',')
  )
  // ⚠️ **这条不是判别器，别把它当成「撞名这条已经测住了」的依据。**
  // 反证实测：把 `reserveOutput` 的 `claimed` 避让改掉之后，两条任务**仍然都报 `done`**
  // ——它们各自把同一个 `.part`（`partPathOf` 是最终名的纯函数）写出来、各自 `rename`
  // 成功，后完成的那次静默覆盖先完成的，谁都不报错。所以下面这条在两个世界里都是绿的，
  // 真正抓住那个 bug 的**只有**紧接着的那条「落在两个不同的文件上」。
  // 它留在这里的价值是反向的：证明这个 bug **无声**，用户那边什么都看不出来。
  check(
    'overwrite 撞名：两条都成了（临时文件没有互踩）',
    dupTasks.length === 2 && dupTasks.every((t) => t.status === 'done'),
    dupTasks.map((t) => `${t.status}:${t.error ?? ''}`).join(' | ')
  )
  check(
    'overwrite 撞名：落在两个不同的文件上',
    dupOutputs.every((p) => p !== null) && new Set(dupOutputs).size === 2,
    dupOutputs.join(' | ')
  )
  check(
    'overwrite 撞名：其中一条占的就是本名（覆盖语义没被改成一律加序号）',
    dupOutputs.includes(resolve(dupDir, 'dup.webp')),
    dupOutputs.join(' | ')
  )

  // 复位成内建默认，别把这一节的设置留给后面（`updateSettings` 是浅 patch，
  // 而 `defaultTargets` 是整体替换，不复位会把它整个换掉）。
  updateSettings({
    outputBesideSource: true,
    outputDir: null,
    onConflict: 'rename',
    maxConcurrent: 4,
    defaultTargets: {}
  })

  /* ----------------------------------------------- [13] remux 智能重封装 */

  console.log('\n[13] remux 智能重封装')

  const avcMkv = resolve(TMP, 'remux-avc.mkv')
  check('生成 h264+aac 的 mkv 素材', await makeAv(avcMkv, 'libx264', 'aac'))

  // 源自己的指纹先取出来。下面每条「一致」断言都必须带上 `src !== ''` 这个前置——
  // 两个空串是相等的，素材没造出来时那些断言会集体假绿。本项目在「空集合恒真」上踩过。
  const srcVideo = await streamFingerprint(avcMkv, '0:v:0')
  const srcAudio = await streamFingerprint(avcMkv, '0:a:0')
  check(
    '素材的两条码流指纹都非空',
    srcVideo !== '' && srcAudio !== '',
    `v=${srcVideo || '（空）'} a=${srcAudio || '（空）'}`
  )

  // ---- 兼容方向：码流原样搬过去，一位都不该变 ----
  const remuxTask = await convertOne(manager, await copyOf(avcMkv, 'remux-a.mkv'), 'mp4')
  const remuxOut = outputOf(remuxTask)
  check('兼容组合 h264+aac.mkv → mp4 转换成功', remuxOut !== null, remuxTask?.error ?? '')

  const outVideo = remuxOut ? await streamFingerprint(remuxOut, '0:v:0') : ''
  const outAudio = remuxOut ? await streamFingerprint(remuxOut, '0:a:0') : ''
  check(
    '兼容组合：视频码流与源逐位一致（证明确实是 remux，不是重编码）',
    srcVideo !== '' && outVideo === srcVideo,
    `源=${srcVideo || '（空）'} 产物=${outVideo || '（空）'}`
  )
  check(
    '兼容组合：音频码流也与源逐位一致（音频那一侧同样没被重编码）',
    srcAudio !== '' && outAudio === srcAudio,
    `源=${srcAudio || '（空）'} 产物=${outAudio || '（空）'}`
  )

  // ---- 不兼容方向：必须自动回退重编码，而不是报错 ----
  // h264 进不了 webm——webm 只吃 vp8/vp9/av1 的视频
  const fellBackTask = await convertOne(manager, await copyOf(avcMkv, 'remux-b.mkv'), 'webm')
  const fellBackOut = outputOf(fellBackTask)
  check(
    '不兼容组合 h264+aac → webm 自动回退重编码且成功',
    fellBackOut !== null,
    fellBackTask?.error ?? ''
  )

  const fallbackInfo = fellBackOut ? await probeOf(fellBackOut) : null
  check(
    '回退后确实是重编码的产物（视频流变成了 vp9）',
    fallbackInfo?.videoCodec === 'vp9',
    `实际=${fallbackInfo?.videoCodec ?? '（无产物）'}`
  )

  // ---- 音频那一侧的判据：一对只差音频编码器的对照 ----
  //
  // 两个素材的**视频侧完全相同**（都是 vp9，都装得进 webm），唯一差别是音轨 opus ↔ aac。
  // 实测 aac 进不了 webm：`Only VP8 or VP9 or AV1 video and Vorbis or Opus audio`。
  // 所以判定若只看视频，第二条会一头撞进 remux 然后整个任务失败——这正是它要抓的。
  const vp9OpusMkv = resolve(TMP, 'remux-vp9-opus.mkv')
  const vp9AacMkv = resolve(TMP, 'remux-vp9-aac.mkv')
  check('生成 vp9+opus 的 mkv 素材', await makeAv(vp9OpusMkv, 'libvpx-vp9', 'libopus'))
  check('生成 vp9+aac 的 mkv 素材', await makeAv(vp9AacMkv, 'libvpx-vp9', 'aac'))

  const vp9OpusSrcVideo = await streamFingerprint(vp9OpusMkv, '0:v:0')
  const vp9OpusTask = await convertOne(manager, vp9OpusMkv, 'webm')
  const vp9OpusOut = outputOf(vp9OpusTask)
  check('vp9+opus.mkv → webm 转换成功', vp9OpusOut !== null, vp9OpusTask?.error ?? '')

  const vp9OpusOutVideo = vp9OpusOut ? await streamFingerprint(vp9OpusOut, '0:v:0') : ''
  check(
    '音频兼容时走 remux：vp9 视频流与源逐位一致',
    vp9OpusSrcVideo !== '' && vp9OpusOutVideo === vp9OpusSrcVideo,
    `源=${vp9OpusSrcVideo || '（空）'} 产物=${vp9OpusOutVideo || '（空）'}`
  )

  const vp9AacTask = await convertOne(manager, vp9AacMkv, 'webm')
  const vp9AacOut = outputOf(vp9AacTask)
  check(
    '音频不兼容时自动回退重编码且成功（vp9+aac → webm，aac 进不了 webm）',
    vp9AacOut !== null,
    vp9AacTask?.error ?? ''
  )

  const vp9AacInfo = vp9AacOut ? await probeOf(vp9AacOut) : null
  check(
    '回退后的音频被重编码成 opus（webm 只收 vorbis/opus）',
    vp9AacInfo?.audioCodec === 'opus',
    `实际=${vp9AacInfo?.audioCodec ?? '（无产物）'}`
  )

  /* -------------------------------------------------- [14] GPU 硬件编码（M6） */

  console.log('\n[14] GPU 硬件编码')

  /*
    这一节正好钉住 PLAN §M6 的三条验收判据：

    1. **参数确实换了编码器**（纯函数，不依赖本机有没有卡）；
    2. **默认路径不改变**——不开开关时参数与加 M6 之前**逐字相同**；
    3. **GPU 不可用时自动回退 CPU 且成功**。

    三条里最容易写空的是第三条。天真的写法是「本机有卡就测 GPU 路、没卡就测 CPU 路」，
    但那会变成**按机器分叉**：一台没卡的机器上 GPU 那条路永远走不到，
    对应断言就成了「在空集合上恒真」——绿得毫无意义（本项目在这一点上踩过四次）。
    所以这里的做法是**把探测结果强行压进去**（`setHardwareEncodeProbe`），
    让两条路在任何机器上都被真的执行到：

      - 压 `true`：有卡 → 真走 GPU；没卡 → GPU 那次失败 → 回退 → 成功。
        两种世界里产出的都是一份能解的 h264，断言只认这一点，于是两边都不空转。
      - 压 `false`：走 CPU。

    回退那一条还额外造了一个**必然让 NVENC 失败**的用例（64x64 低于它的尺寸下限，
    实测报 `Frame Dimension less than the minimum supported value`）。
    这样即使在**有卡**的机器上，回退分支也是被真执行到的，而不是靠「这台机器恰好没卡」。

    ⚠️ 素材必须是 **vp8** 的。拿 h264 的 mkv 去转 mp4 会命中 remux（`-c copy`），
    编码器根本没参与——那一节的断言会在「其实一次都没编」的情况下照样全绿。
    这正是约束 18 里记过的时序陷阱，只不过这里是「根本没人编」而不是「编得太快」。
  */

  // ---- 1. 参数层 ----
  const gpuArgs = buildFfmpegArgs('in.mkv', 'out.mp4', 'mkv', 'mp4', { hardware: true })
  const cpuArgs = buildFfmpegArgs('in.mkv', 'out.mp4', 'mkv', 'mp4')

  check(
    '参数层：请求硬件编码时换成了 h264_nvenc',
    gpuArgs.includes('h264_nvenc') && !gpuArgs.includes('libx264'),
    gpuArgs.join(' ')
  )
  check(
    '参数层：质量参数是 -cq 30，不是照抄 -crf 23（实测同号会让体积涨到 2.8 倍）',
    gpuArgs.includes('-cq') &&
      gpuArgs[gpuArgs.indexOf('-cq') + 1] === '30' &&
      !gpuArgs.includes('-crf'),
    gpuArgs.join(' ')
  )
  check(
    '参数层：webm 即使开了硬件编码也走 libvpx-vp9（NVENC 没有 vp9 编码器）',
    (() => {
      const args = buildFfmpegArgs('in.mkv', 'out.webm', 'mkv', 'webm', { hardware: true })
      return args.includes('libvpx-vp9') && !args.some((a) => a.includes('nvenc'))
    })()
  )
  check(
    '参数层：图片转视频不沾 GPU（只有 5 秒静止画面，启动开销比省下的还多）',
    (() => {
      const args = buildFfmpegArgs('in.png', 'out.mp4', 'png', 'mp4', { hardware: true })
      return args.includes('libx264') && !args.some((a) => a.includes('nvenc'))
    })()
  )

  // 默认路径**逐字**不变的证据：把整条参数数组钉死。
  // 钉的是全量而不是「有没有 libx264」——后者在「容器参数被顺手改动了」时照样绿。
  const EXPECTED_DEFAULT_MP4 = JSON.stringify([
    '-hide_banner',
    '-nostdin',
    '-y',
    '-i',
    'in.mkv',
    '-progress',
    'pipe:1',
    '-nostats',
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '23',
    '-c:a',
    'aac',
    '-b:a',
    '192k',
    '-movflags',
    '+faststart',
    'out.mp4'
  ])
  check(
    '参数层：默认（不开硬件编码）的参数与加 M6 之前逐字相同',
    JSON.stringify(cpuArgs) === EXPECTED_DEFAULT_MP4,
    cpuArgs.join(' ')
  )

  // ---- 2. 素材 ----
  const gpuSrc = resolve(TMP, 'gpu-vp8.mkv')
  check(
    '生成 vp8+opus 素材（转 mp4 必然重编码，不会 remux）',
    await makeAv(gpuSrc, 'libvpx', 'libopus')
  )
  const gpuSrcPrint = await streamFingerprint(gpuSrc, '0:v:0')
  check('素材的视频码流指纹非空', gpuSrcPrint !== '', gpuSrcPrint || '（空）')

  // ---- 3. 端到端：压「有卡」 ----
  setHardwareEncodeProbe(Promise.resolve(true))
  updateSettings({ hardwareEncode: true })

  const hwTask = await convertOne(manager, await copyOf(gpuSrc, 'gpu-a.mkv'), 'mp4')
  const hwOut = outputOf(hwTask)
  check(
    '宣称有卡：任务成功（有卡走 GPU，没卡走回退，两条路都算过）',
    hwOut !== null,
    hwTask?.error ?? ''
  )

  const hwInfo = hwOut ? await probeOf(hwOut) : null
  check(
    '宣称有卡：产物是 h264',
    hwInfo?.videoCodec === 'h264',
    `实际=${hwInfo?.videoCodec ?? '（无产物）'}`
  )

  const hwPrint = hwOut ? await streamFingerprint(hwOut, '0:v:0') : ''
  check(
    '宣称有卡：确实重编码了（指纹与源不同，不是 remux 蒙混过关）',
    gpuSrcPrint !== '' && hwPrint !== '' && hwPrint !== gpuSrcPrint,
    `源=${gpuSrcPrint || '（空）'} 产物=${hwPrint || '（空）'}`
  )

  /** 取某个任务推给 UI 的全部分段文案（`kind: 'indeterminate'` 那一路） */
  const stagesOf = (id: string | undefined): string[] =>
    patches
      .flatMap((p) => p.updated)
      .filter((u) => u.id === id)
      .map((u) => (u.progress?.kind === 'indeterminate' ? u.progress.stage : ''))
      .filter(Boolean)

  // 有卡的那台机器上，「真走 GPU」与「静默回退」从产物上分不出来（都是 h264）。
  // 判据只能落在**提示**上：真走 GPU 时一条回退提示都不该有。
  if (await probeHardwareEncode()) {
    const hwStages = stagesOf(hwTask?.id)
    check(
      '真走 GPU：全程没有出现回退提示（说明确实是显卡编的，不是偷偷回退了）',
      !hwStages.some((s) => s.includes('改用 CPU') || s.includes('未找到可用显卡')),
      hwStages.join(' | ') || '（无提示）'
    )
  } else {
    // 这一台没有可用显卡，上面那条无从谈起。**打印而不是 `check(true)`**——
    // 一个恒真的断言只会让人以为查过了（本项目已经抓到过四条这样的装饰）。
    console.log('  · 本机无可用显卡，「真走 GPU」那条无从验证（回退那几条仍然照跑）')
  }

  // ---- 4. 回退：宣称有卡，但这次 GPU 一定编不了 ----
  //
  // 64x64 低于 NVENC 的尺寸下限（实测）。选它而不是「找台没卡的机器」，
  // 是为了让这条在任何机器上都真的走到回退分支。
  const tinySrc = resolve(TMP, 'gpu-tiny.mkv')
  const tinyMade = await runFfmpeg([
    '-hide_banner',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=duration=1:size=64x64:rate=10',
    '-c:v',
    'libvpx',
    '-deadline',
    'realtime',
    '-cpu-used',
    '8',
    '-pix_fmt',
    'yuv420p',
    tinySrc
  ])
  check(
    '生成 64x64 的 vp8 素材（低于 NVENC 尺寸下限）',
    tinyMade.code === 0,
    tinyMade.stderr.slice(-200)
  )

  const fbTask = await convertOne(manager, await copyOf(tinySrc, 'gpu-b.mkv'), 'mp4')
  const fbOut = outputOf(fbTask)
  check('GPU 编不了时自动回退 CPU 且成功', fbOut !== null, fbTask?.error ?? '')

  const fbInfo = fbOut ? await probeOf(fbOut) : null
  check(
    '回退产物同样是能解的 h264',
    fbInfo?.videoCodec === 'h264',
    `实际=${fbInfo?.videoCodec ?? '（无产物）'}`
  )

  // 回退**必须说出来**。静默换一条路走，与静默降质同类：用户开了开关、
  // 看着任务成功，永远不知道那台机器其实一次显卡都没用上。
  check(
    '回退时把「改用 CPU 重试」推给了 UI（不静默回退）',
    stagesOf(fbTask?.id).includes('显卡编码失败，改用 CPU 重试'),
    stagesOf(fbTask?.id).join(' | ') || '（无提示）'
  )

  // ---- 5. 压「没卡」：走 CPU 路径且成功 ----
  setHardwareEncodeProbe(Promise.resolve(false))

  const noGpuTask = await convertOne(manager, await copyOf(gpuSrc, 'gpu-c.mkv'), 'mp4')
  const noGpuOut = outputOf(noGpuTask)
  check('宣称没卡：任务成功', noGpuOut !== null, noGpuTask?.error ?? '')

  const noGpuInfo = noGpuOut ? await probeOf(noGpuOut) : null
  check(
    '宣称没卡：产物是 h264',
    noGpuInfo?.videoCodec === 'h264',
    `实际=${noGpuInfo?.videoCodec ?? '（无产物）'}`
  )

  // 复位：别让这一节的开关注到后面的用例上，也别把探测缓存留在假值上
  updateSettings({ hardwareEncode: false })

  /* -------------------------------------- [15] 外部请求：右键菜单 / 命令行（M8） */

  console.log('\n[15] 外部请求（右键菜单 / --convert）')

  /*
    这一节盯的是 M8 那条链路的后半截：注册表里那条命令行最终会把一个路径交回给我们。

    为什么单独拿一节来锁：用户是**站在资源管理器前面点的右键**，点完之后菜单消失、
    窗口弹出来却什么都没有，是这个功能最坏的形态——而它看起来和「程序启动慢」
    一模一样，无从归因。所以三条断言分别是：收入队列、**当场开跑**、出错时**一定说得出来**。

    用 `getTaskManager()` 而不是上面那个自己 new 的 `manager`：右键菜单这条路上入队的
    正是前者（与 [11] 历史那一节是同一个实例）。
  */

  const external = getTaskManager()
  // 偏好刻意钉成 mkv，而下面有一个用例请求 webm：两者相等时「钉上了没有」和
  // 「吃了默认值」观测结果一模一样，那条断言就成了永远通过的装饰。
  updateSettings({
    outputBesideSource: true,
    outputDir: null,
    onConflict: 'rename',
    maxConcurrent: 4,
    defaultTargets: { video: 'mkv' }
  })

  const extSrc = resolve(TMP, 'external.mp4')
  check('外部请求素材 external.mp4', await makeVideo(extSrc, 3))

  // —— 不指定目标：按类别默认跑，而且**当场开跑**
  const extResult = await enqueueExternalRequest({ paths: [extSrc], to: null })
  check('外部请求：文件被收入队列', extResult.added === 1, JSON.stringify(extResult))

  const extTask = external.list().find((t) => t.inputPath === extSrc)
  check('外部请求：队列里确实多了这一条', extTask !== undefined)
  check(
    '外部请求：自动开跑，没有被丢在排队里干等',
    extTask?.status === 'running' || extTask?.status === 'done',
    String(extTask?.status)
  )
  check('外部请求：不指定目标时走类别默认（mkv）', extTask?.toExt === 'mkv', String(extTask?.toExt))

  await settle(external)
  const extDone = external.list().find((t) => t.id === extTask?.id)
  check('外部请求：跑完且成功', extDone?.status === 'done', String(extDone?.error))

  // —— 指定目标：必须真的钉上去。偏好是 mkv、请求的是 webm，两个世界才分得开
  const extSrcB = await copyOf(extSrc, 'external-b.mp4')
  const pinned = await enqueueExternalRequest({ paths: [extSrcB], to: 'webm' })
  check('外部请求：带 --to 时收入队列', pinned.added === 1, JSON.stringify(pinned))

  const pinnedTask = external.list().find((t) => t.inputPath === extSrcB)
  check(
    '外部请求：--to 指定的目标真的钉上去了（不是悄悄用了默认的 mkv）',
    pinnedTask?.toExt === 'webm',
    String(pinnedTask?.toExt)
  )

  await settle(external)
  const pinnedDone = external.list().find((t) => t.id === pinnedTask?.id)
  check(
    '外部请求：指定的目标确实被转出来了',
    pinnedDone?.status === 'done',
    String(pinnedDone?.error)
  )

  // —— 不受支持的目标：**必须在入队之前就挡掉**。本节最承重的一条。
  //
  // `TaskManager.setTarget()` 对不认识的目标是**静默 return**（它自己会拿 targetsFor() 再验一遍），
  // 所以「先 addPaths 再 setTarget」的写法会让这一单按默认目标跑完、产出一个**用户没要的格式**，
  // 还报成功——一个不报错的错误答案，比直接失败危险得多。
  const extSrcC = await copyOf(extSrc, 'external-c.mp4')
  const beforeBad = external.list().length
  const bad = await enqueueExternalRequest({ paths: [extSrcC], to: 'docx' })
  check('外部请求：不受支持的目标被拒', bad.added === 0, JSON.stringify(bad))
  check(
    '外部请求：拒绝理由点明了两个格式',
    (bad.rejected[0]?.reason ?? '').includes('.docx') &&
      (bad.rejected[0]?.reason ?? '').includes('.mp4'),
    String(bad.rejected[0]?.reason)
  )
  check(
    '外部请求：校验排在入队之前（队列长度没变）',
    external.list().length === beforeBad,
    `${beforeBad} → ${external.list().length}`
  )
  check(
    '外部请求：被拒的文件没有留下任务（否则它会按默认目标悄悄跑一遍）',
    external.list().every((t) => t.inputPath !== extSrcC)
  )

  // —— 说不出口的失败必须弹框。
  //
  // 这条路上**没有任何界面元素能承载错误**：用户是在资源管理器里点的右键，
  // 我们弹出一个窗口、队列里却什么都没有——不弹框的话，他唯一看到的
  // 就是「窗口开了，然后什么都没有」。
  //
  // 桩里的 `dialog` 只有 `showOpenDialog`，这里补一个记账用的 `showMessageBox`。
  // 那个文件（scripts/electron-stub.ts）是共享的，**只读不改**，所以从这一侧打补丁
  // ——[11] 那一节的 `ipcMain.handle` 也是这么处理的。
  const dialogPatched = dialog as unknown as {
    showMessageBox: (...args: unknown[]) => Promise<unknown>
  }
  const shown: Array<{ title: string; detail: string }> = []
  dialogPatched.showMessageBox = async (...args: unknown[]): Promise<unknown> => {
    // 两个重载：`(options)` 与 `(parent, options)`，options 永远是最后一个参数
    const options = args[args.length - 1] as { message: string; detail: string }
    shown.push({ title: options.message, detail: options.detail })
    return { response: 0 }
  }

  await applyCliRequest({ kind: 'none' }, null)
  check('普通启动（没有 --convert）不弹任何框', shown.length === 0, JSON.stringify(shown))

  await applyCliRequest({ kind: 'error', message: '--convert 后面没有跟文件路径' }, null)
  check(
    '认得出 --convert 但参数不对时弹框说出来（绝不静默）',
    shown.length === 1 && shown[0]?.detail === '--convert 后面没有跟文件路径',
    JSON.stringify(shown)
  )

  const beforeMsg = shown.length
  await applyCliRequest({ kind: 'convert', request: { paths: [extSrcC], to: 'docx' } }, null)
  check(
    '目标格式不受支持时也弹框（这条路径上没有别的地方能显示错误）',
    shown.length === beforeMsg + 1 && (shown[beforeMsg]?.detail ?? '').includes('.docx'),
    JSON.stringify(shown[beforeMsg])
  )

  await settle(external)
  external.shutdown()

  /* ---------------------------------------------- [16] 裁剪（任务参数通道，P-1） */

  console.log('\n[16] 裁剪（任务参数通道）')

  /*
    这一节盯的是「任务参数」这条通道的**端到端**效果：参数从 `TaskManager` 一路
    走到 ffmpeg 的命令行，并且真的改变了产物。三组断言各有各的靶心：

    1. **无损裁剪到底重编没重编。** 判据是**逐包指纹**（`packetRows` / `locateCopy`），
       不是「编解码器名对不对」——重编码之后名字照样是 h264，那条断言会在
       「其实重编了」的情况下照样绿。
    2. **起点回退到哪个关键帧。** 素材的 GOP 是**定点造出来的**（每 2 秒一个关键帧），
       再拿三种请求去撞：起点落在关键帧之间（3s）→ 回退到 2s；起点正好在关键帧上（4s）
       → 原地不动；起点落在下一个关键帧之前（5s）→ 回退到 4s 而**不是**后面那个。
       三条一起才证明「对齐到**前一个**关键帧」——只做一条的话，「永远回退一个 GOP」
       与「完全不回退」这两种错误实现也能各蒙对一条。
    3. **参数通道本身**（`setOptions` / IPC 契约 / 打回排队 / 运行中不许改）。

    最后的进度分母那条是顺带的：裁剪任务的百分比必须按**裁剪时长**算，
    否则一条 10 分钟的素材裁 60 秒会在 10% 处直接跳到 100%。
  */

  const trimSrc = resolve(TMP, 'trim-src.mp4')
  check(
    '裁剪素材：640x360 / 30fps / GOP 固定 60 帧（关键帧每 2 秒一个）',
    await makeTrimSource(trimSrc, 10)
  )

  const trimSrcRows = await packetRows(trimSrc)
  check(
    '素材的逐包指纹足够多（下面所有「逐位相同」的断言都以前置为准）',
    trimSrcRows.hashes.length > 200,
    `${trimSrcRows.hashes.length} 包`
  )

  /** 跑一次无损裁剪，回报它覆盖了源的哪一段 */
  const losslessWindow = async (
    start: number,
    end: number,
    name: string
  ): Promise<{ status: string; win: CopyWindow | null; output: string | null }> => {
    // 每次换一个源文件名：产物默认写在源文件旁边，同名任务之间会互相改名、干扰断言
    const id = await addOne(manager, await copyOf(trimSrc, name))
    if (id === null) return { status: 'missing', win: null, output: null }
    manager.setTarget(id, 'mkv')
    manager.setOptions(id, { trim: { start, end, mode: 'lossless' } })
    manager.start([id])
    await settle(manager)

    const task = manager.list().find((t) => t.id === id) ?? null
    const output = outputOf(task)
    const win = output === null ? null : locateCopy(trimSrcRows, await packetRows(output))
    return { status: task?.status ?? 'missing', win, output }
  }

  // ---- 无损：内容一个字不丢，起点回退到**前一个**关键帧 ----

  const w35 = await losslessWindow(3, 5, 'trim-a.mp4')
  check('无损裁剪完成', w35.status === 'done', w35.status)
  check(
    '无损裁剪：产物的**每一个**包都与源逐位相同（= 一次编码都没发生）',
    w35.win !== null && w35.win.total > 0 && w35.win.matched === w35.win.total,
    w35.win === null
      ? '首包在源里找不到（被重编码了）'
      : `连续命中 ${w35.win.matched}/${w35.win.total}`
  )
  check(
    '无损裁剪：起点回退到前一个关键帧（请求 3.0s，实际从 2.0s 起）',
    w35.win !== null && Math.abs(w35.win.startSec - 2) < 0.01,
    `实际 ${w35.win?.startSec}`
  )
  check(
    '无损裁剪：终点是准的（请求到 5.0s，实际不超过 5.2s）',
    w35.win !== null && Math.abs(w35.win.endSec - 5) <= 0.2,
    `实际 ${w35.win?.endSec}`
  )

  // 起点正好落在关键帧上时**不该**回退——这一条与下面那条一起，把判据从
  // 「总是回退一个 GOP」钉成「回退到前一个关键帧」
  const w46 = await losslessWindow(4, 6, 'trim-b.mp4')
  check(
    '无损裁剪：起点正好落在关键帧上时不回退（请求 4.0s → 4.0s）',
    w46.win !== null && Math.abs(w46.win.startSec - 4) < 0.01,
    `实际 ${w46.win?.startSec}`
  )
  // 5s 落在关键帧 4 与 6 之间，回退到 4s；「回退到下一个关键帧」会给出 6s、
  // 「完全不回退」会给出 5s，两种错误都在这条上现形
  const w57 = await losslessWindow(5, 7, 'trim-c.mp4')
  check(
    '无损裁剪：起点落在两个关键帧之间时回退到**前一个**（请求 5.0s → 4.0s）',
    w57.win !== null && Math.abs(w57.win.startSec - 4) < 0.01,
    `实际 ${w57.win?.startSec}`
  )
  check(
    '无损裁剪：上面三条的产物都是 mkv（换容器不影响判据）',
    [w35, w46, w57].every((w) => (w.output ?? '').endsWith('.mkv')),
    [w35, w46, w57].map((w) => w.output).join(' | ')
  )

  // ---- 无损：整条码流指纹（用户点名要看的那条判据） ----
  //
  // 裁剪成一段之后整条流的指纹必然与源不同，所以这条只能用「区间覆盖整段」的裁剪来问：
  // 请求 [0, 100) 而源只有 10 秒 → 内容就是全片，于是整条流逐位可比。
  const wFull = await losslessWindow(0, 100, 'trim-full.mp4')
  const srcPrint = await streamFingerprint(trimSrc, '0:v:0')
  const fullPrint = wFull.output === null ? '' : await streamFingerprint(wFull.output, '0:v:0')
  check(
    '无损裁剪：整个区间上，产物的码流指纹与源**逐位相同**（`-c copy` 的 md5 判据）',
    srcPrint !== '' && fullPrint === srcPrint,
    `源=${srcPrint || '（空）'} 产物=${fullPrint || '（空）'}`
  )
  const srcAudioPrint = await streamFingerprint(trimSrc, '0:a:0')
  const fullAudioPrint = wFull.output === null ? '' : await streamFingerprint(wFull.output, '0:a:0')
  check(
    '无损裁剪：音频那一侧同样逐位相同（不是只搬了视频）',
    srcAudioPrint !== '' && fullAudioPrint === srcAudioPrint,
    `源=${srcAudioPrint || '（空）'} 产物=${fullAudioPrint || '（空）'}`
  )

  // ---- 对照：不裁剪时这个方向本来就走 remux 快车道 ----
  //
  // 少了这条对照，「带裁剪时走的是另一条路」就没有分辨力：
  // 一个恒不 remux 的实现也能让上面几条全绿。
  const plainId = await addOne(manager, await copyOf(trimSrc, 'trim-plain.mp4'))
  check('对照：不裁剪的任务建起来了', plainId !== null)
  if (plainId !== null) {
    manager.setTarget(plainId, 'mkv')
    manager.start([plainId])
    await settle(manager)
    const plainOut = outputOf(manager.list().find((t) => t.id === plainId) ?? null)
    const plainPrint = plainOut === null ? '' : await streamFingerprint(plainOut, '0:v:0')
    check(
      '对照：不裁剪时 mp4(h264+aac) → mkv 走 remux（指纹与源逐位相同）',
      srcPrint !== '' && plainPrint === srcPrint,
      `源=${srcPrint || '（空）'} 产物=${plainPrint || '（空）'}`
    )
  }

  // ---- 精确：确实重编码，而且起点是帧级的 ----

  const exactId = await addOne(manager, await copyOf(trimSrc, 'trim-exact.mp4'))
  check('精确裁剪的任务建起来了', exactId !== null)
  let exactOut: string | null = null
  if (exactId !== null) {
    manager.setTarget(exactId, 'mkv')
    manager.setOptions(exactId, { trim: { start: 3, end: 5, mode: 'exact' } })
    manager.start([exactId])
    await settle(manager)
    const exactTask = manager.list().find((t) => t.id === exactId) ?? null
    exactOut = outputOf(exactTask)
    check('精确裁剪完成', exactTask?.status === 'done', String(exactTask?.error))
  }

  if (exactOut !== null) {
    const exactRows = await packetRows(exactOut)
    const exactWindow = locateCopy(trimSrcRows, exactRows)
    check(
      '精确裁剪：产物被**真的重编**了（首包与源逐位不同）——光看编解码器名分不出来',
      exactWindow === null,
      `首包命中源第 ${exactWindow?.index} 包`
    )
    const exactInfo = await probeOf(exactOut)
    check(
      '精确裁剪：编解码器仍是 h264（所以「名字一样」证明不了没重编）',
      exactInfo.videoCodec === 'h264',
      String(exactInfo.videoCodec)
    )

    // 帧级准确：产物首帧 = 源 t=3s 那一帧，而不是关键帧 t=2s 那一帧。
    // 判据是**两侧都断言**（像 / 不像）：只判一侧的话，「首帧全黑」也能过第一条。
    const fOut = resolve(TMP, 'trim-frame-out.png')
    const f3 = resolve(TMP, 'trim-frame-s3.png')
    const f2 = resolve(TMP, 'trim-frame-s2.png')
    await extractFrame(exactOut, fOut, null)
    await extractFrame(trimSrc, f3, 3)
    await extractFrame(trimSrc, f2, 2)
    const likeWanted = await psnr(fOut, f3)
    const likeKeyframe = await psnr(fOut, f2)
    check(
      '精确裁剪：首帧就是用户要的那一刻（与源 t=3s 那一帧 PSNR 很高）',
      likeWanted > 30,
      `PSNR ${likeWanted}`
    )
    check(
      '精确裁剪：首帧**不是**关键帧那一帧（与源 t=2s 明显不同）',
      Number.isFinite(likeKeyframe) && likeKeyframe < 25,
      `PSNR ${likeKeyframe}`
    )

    // 对照：无损模式的首帧恰恰就是那个关键帧，而且是**逐像素相同**的。
    // 这一条与上面两条合起来，把两种模式的差别钉得死死的。
    if (w35.output !== null) {
      const cOut = resolve(TMP, 'trim-frame-copy.png')
      await extractFrame(w35.output, cOut, null)
      const sameAsKeyframe = await psnr(cOut, f2)
      check(
        '无损裁剪：首帧与源的关键帧**逐像素相同**（PSNR 是 inf，不是「差不多」）',
        sameAsKeyframe === Number.POSITIVE_INFINITY,
        `PSNR ${sameAsKeyframe}`
      )
      const vsWanted = await psnr(cOut, f3)
      check(
        '无损裁剪：首帧与用户要的那一刻（t=3s）明显不同——这正是「可能比你要的早一点」',
        vsWanted < 25,
        `PSNR ${vsWanted}`
      )
    }
  }

  // ---- 无损做不到时必须**报错**，不能静默重编码 ----

  // h264 装不进 webm（webm 只收 vp8/vp9/av1），这个方向的无损裁剪物理上做不到。
  // 静默改成重编码的后果是：用户要的是「别动我的码流」，拿到的却是画质变了的产物，
  // 而任务报「已成」。
  const impossibleId = await addOne(manager, await copyOf(trimSrc, 'trim-webm.mp4'))
  check('无损裁剪：装不下的方向也能建起任务', impossibleId !== null)
  if (impossibleId !== null) {
    manager.setTarget(impossibleId, 'webm')
    manager.setOptions(impossibleId, { trim: { start: 1, end: 3, mode: 'lossless' } })
    manager.start([impossibleId])
    await settle(manager)
    const impossible = manager.list().find((t) => t.id === impossibleId) ?? null
    check(
      '无损裁剪到装不下的容器：任务失败，而不是悄悄改成重编码',
      impossible?.status === 'error',
      `${impossible?.status} ${impossible?.error ?? ''}`
    )
    check(
      '失败原因给出了下一步（改用精确模式）',
      (impossible?.error ?? '').includes('精确模式'),
      String(impossible?.error)
    )
  }

  // ---- 参数通道：改参数把任务打回排队，并清掉上一轮的痕迹 ----

  const doneTask = await convertOne(manager, await copyOf(trimSrc, 'trim-done.mp4'), 'mkv')
  check(
    '前置：先有一条**已成**的任务（它带着产物路径与体积）',
    doneTask?.status === 'done' &&
      (doneTask.outputPath ?? '') !== '' &&
      (doneTask.sizeBytes ?? 0) > 0,
    `${doneTask?.status} ${doneTask?.sizeBytes}`
  )
  if (doneTask !== null) {
    manager.setOptions(doneTask.id, { trim: { start: 1, end: 3, mode: 'exact' } })
    const after = manager.list().find((t) => t.id === doneTask.id) ?? null
    check('改参数：状态被打回「等待中」', after?.status === 'queued', String(after?.status))
    check(
      '改参数：参数确实落到了任务上',
      after?.options?.trim?.end === 3 && after?.options?.trim?.mode === 'exact',
      JSON.stringify(after?.options)
    )
    check(
      '改参数：上一次的产物路径被清掉（留着就是一条指向旧参数的假信息）',
      after?.outputPath === undefined,
      String(after?.outputPath)
    )
    // 体积那一列的标题是「产物体积」，清不掉的话「等待中」的行上会写着一个
    // 当下并不存在的文件大小
    check('改参数：产物体积被清掉', after?.sizeBytes === undefined, String(after?.sizeBytes))
    check(
      '改参数：错误与日志被清掉',
      after?.error === undefined && after?.logTail === undefined,
      `${after?.error} / ${after?.logTail?.length}`
    )
    check(
      '改参数：起止时间戳被清掉',
      after?.startedAt === undefined && after?.finishedAt === undefined,
      `${after?.startedAt} / ${after?.finishedAt}`
    )
    // 推送侧也要清：界面是拿 patch 改镜像的，只清任务不清 patch 的话，
    // 卡片上那一格会一直挂着旧产物的体积。
    //
    // 等一拍再读：`mark()` 只是把 patch 并进缓冲，真正广播发生在 `setImmediate` 里
    //（一次拖入 20 个文件只发一条消息，靠的就是这个合并）。同步地读会读到
    // **上一条**（完成时那条），于是断言看见的是旧值——这正是它第一次跑就红的原因，
    // 而红的是测试的时序，不是实现。
    await delay(50)
    const lastPatch = patches
      .flatMap((p) => p.updated)
      .filter((u) => u.id === doneTask.id)
      .at(-1)
    check(
      '改参数：推给界面的 patch 里这些字段是 null（不是缺省）',
      lastPatch?.outputPath === null &&
        lastPatch?.sizeBytes === null &&
        lastPatch?.status === 'queued',
      JSON.stringify(lastPatch)
    )
  }

  // ---- 运行中改参数：与 setTarget 同一条规矩，直接不办 ----

  const busyId = await addOne(manager, longVideo)
  check('运行中改参数：任务建起来了', busyId !== null)
  if (busyId !== null) {
    // 钉 webm（h264 进不去，必然重编码）：吃默认目标会命中 remux，600 秒的素材
    // 一百多毫秒就跑完，`waitFor(running)` 之后那次 setOptions 会打在**完成之后**，
    // 测的就不是「运行中」了（约束 18 里那个时序陷阱）
    manager.setTarget(busyId, 'webm')
    manager.start([busyId])
    const busyRunning = await waitFor(manager, (tasks) =>
      tasks.some((t) => t.id === busyId && t.status === 'running')
    )
    check('运行中改参数：任务确实在跑', busyRunning)
    manager.setOptions(busyId, { trim: { start: 1, end: 3, mode: 'exact' } })
    const busyTask = manager.list().find((t) => t.id === busyId) ?? null
    check(
      '运行中改参数被忽略（参数早就交给引擎了，改了也不会回头重跑）',
      busyTask?.status === 'running' && busyTask.options === undefined,
      `${busyTask?.status} / ${JSON.stringify(busyTask?.options)}`
    )
    manager.cancel([busyId])
    await settle(manager)
  }

  // ---- 进度分母：按裁剪时长算，不是源时长 ----

  // 600 秒的素材裁 60 秒：分母若是源时长（600），中间那条进度记录只有 7% 上下；
  // 按裁剪时长（60）算则在 76% 上下。阈值 0.3 落在两者之间（实测 0.075 / 0.765）。
  // ⚠️ 这一条依赖「转码时间超过一个进度记录周期（0.5 秒）」，实测这段转码约 1.35 秒，
  // 余量约 2.7 倍。真在极快的机器上飘红，先看墙钟，别急着改阈值。
  const progId = await addOne(manager, longVideo)
  check('进度分母：任务建起来了', progId !== null)
  if (progId !== null) {
    manager.setTarget(progId, 'mkv')
    manager.setOptions(progId, { trim: { start: 0, end: 60, mode: 'exact' } })
    manager.start([progId])
    await settle(manager)
    const percents = patches
      .flatMap((p) => p.updated)
      .filter((u) => u.id === progId && u.progress?.kind === 'determinate')
      .map((u) => (u.progress as { percent: number }).percent)
    // 最后一条是收尾时强制推的 1，它恒为 1，留着会把任何分母都判成「对」
    const mid = percents.slice(0, -1)
    check(
      '裁剪任务的进度按**裁剪时长**算（中途出现过 > 30% 的百分比）',
      mid.some((v) => v > 0.3),
      `序列 [${percents.map((v) => v.toFixed(3)).join(', ')}]`
    )
    check(
      '裁剪任务的百分比仍然单调且在 [0,1] 内',
      percents.every((v, i) => v >= 0 && v <= 1 && (i === 0 || v >= percents[i - 1])),
      percents.map((v) => v.toFixed(3)).join(', ')
    )
  }

  /* ---- 参数通道：IPC 契约与「静默不办」的那几条 ----
   *
   * 直接调 handler——`ipcHandlers` 那张表是 [11] 里把 `ipcMain.handle` 换成记账桩时
   * 建立的，[11] 之后没有人还原它，所以这里注册进来的 handler 一样进那张表。
   *
   * 这一层必须单独测：`TaskManager.setOptions` 对不合法的参数是**静默 return**，
   * 真正拦住坏数据的是 schema；绕过 schema 直接调 manager 的话，下面那些断言
   * 会在「schema 根本没生效」的情况下照样绿。
   */

  const ipcTasks = getTaskManager()
  registerTaskIpc()
  const setOptionsHandler = ipcHandlers.get(CH.tasksSetOptions)
  check('IPC：tasks:setOptions handler 注册上了', setOptionsHandler !== undefined)

  if (setOptionsHandler !== undefined) {
    const call = (id: string, options: unknown): boolean =>
      setOptionsHandler({}, { id, options }) as boolean

    const ipcId = await addOne(ipcTasks, await copyOf(trimSrc, 'trim-ipc.mp4'))
    check('IPC：用例任务建起来了', ipcId !== null)

    if (ipcId !== null) {
      const read = (): Task | null => ipcTasks.list().find((t) => t.id === ipcId) ?? null

      check(
        'IPC：end === start 被拒',
        call(ipcId, { trim: { start: 5, end: 5, mode: 'exact' } }) === false
      )
      check(
        'IPC：end < start 被拒',
        call(ipcId, { trim: { start: 5, end: 1, mode: 'exact' } }) === false
      )
      check('IPC：NaN 被拒', call(ipcId, { trim: { start: NaN, end: 5, mode: 'exact' } }) === false)
      check('IPC：负数被拒', call(ipcId, { trim: { start: -1, end: 5, mode: 'exact' } }) === false)
      check(
        'IPC：未知的 mode 被拒',
        call(ipcId, { trim: { start: 0, end: 5, mode: 'fast' } }) === false
      )
      check(
        'IPC：多给的字段被拒（字段名拼错不能静默忽略）',
        call(ipcId, { trim: { start: 0, end: 5, mode: 'exact', n: 1 } }) === false
      )
      check('IPC：整块形状不对也被拒', call(ipcId, []) === false)
      check(
        'IPC：被拒之后任务上**一个参数都没留下**（静默不办，不能半途写进去）',
        read()?.options === undefined,
        JSON.stringify(read()?.options)
      )

      check(
        'IPC：合法参数被接受',
        call(ipcId, { trim: { start: 1.5, end: 3.25, mode: 'lossless' } }) === true
      )
      check(
        'IPC：数值原样落到任务上（不被取整、不被截断）',
        read()?.options?.trim?.start === 1.5 && read()?.options?.trim?.end === 3.25,
        JSON.stringify(read()?.options)
      )
      check(
        'IPC：options 给 null 能清空',
        call(ipcId, null) === true && read()?.options === undefined
      )
      // 「任务不在」也要回 false：渲染层只有拿到这个布尔才能说一句「没能设上」，
      // 否则「点了应用、什么都没发生」在界面上没有任何线索。
      check(
        'IPC：任务不存在时回 false（不是一个恒真的 true）',
        call('no-such-task-id', { trim: { start: 0, end: 1, mode: 'exact' } }) === false
      )

      // 图片没有时间轴：参数面板不出现，而**这一道**是防别的入口绕过去的
      const imageId = await addOne(ipcTasks, pngSrc)
      check('IPC：图片任务也建得起来（用来试「不该有裁剪」那一类）', imageId !== null)
      if (imageId !== null) {
        check(
          'IPC：图片任务不接受裁剪参数（判据在 TaskManager，不只是界面藏起来了）',
          call(imageId, { trim: { start: 0, end: 1, mode: 'exact' } }) === false
        )
        check(
          'IPC：被拒的图片任务上确实没有参数',
          (ipcTasks.list().find((t) => t.id === imageId) ?? null)?.options === undefined
        )
      }
    }
  }

  /* ---- 历史：参数要被记下，也要能被复现 ---- */

  /*
    `HistoryEntry.options` 是后加的字段，而历史文件是**我们自己上一版写下的**——
    磁盘上完全可能有一份没有这个字段的旧文件，也可能有被手改坏的。
    所以它走的是与 `defaultTargets` 同一套「逐字段宽容」：坏掉的参数只丢参数，
    连这条痕迹一起丢掉是不行的（500 条上限里少一条真的跑过的记录）。

    宽容的方向也必须朝「安全」那一侧：认不出 `mode` 时**不能猜**——
    猜「无损」是照原样搬码流、猜「精确」是重编码，两者产出的东西差着画质与几倍时间。
    退成「没有参数」= 整段转换，产物仍然是对的，只是长一点。
  */
  const historyProbe = parseHistoryFile({
    entries: [
      {
        id: 'hist-opt-ok',
        inputPath: 'D:\\x\\a.mp4',
        fromExt: 'mp4',
        toExt: 'mkv',
        status: 'done',
        finishedAt: 2000,
        options: { trim: { start: 2, end: 4, mode: 'lossless' } }
      },
      {
        id: 'hist-opt-bad',
        inputPath: 'D:\\x\\b.mp4',
        fromExt: 'mp4',
        toExt: 'mkv',
        status: 'done',
        finishedAt: 1000,
        // start 是个字符串：这种坏法最接近「手改过文件」的真实形态
        options: { trim: { start: 'x', end: 4, mode: 'lossless' } }
      },
      {
        id: 'hist-opt-bad-mode',
        inputPath: 'D:\\x\\c.mp4',
        fromExt: 'mp4',
        toExt: 'mkv',
        status: 'done',
        finishedAt: 500,
        // mode 认不出来时**不能猜**：猜「无损」是照原样搬码流、猜「精确」是重编码，
        // 两者差着画质与几倍时间。所以这一条也必须整块丢掉。
        options: { trim: { start: 1, end: 4, mode: 'fast' } }
      }
    ]
  })
  check(
    '历史：坏掉的参数只丢参数，那条痕迹还在（三条都在）',
    historyProbe?.length === 3,
    `${historyProbe?.length} 条`
  )
  check(
    '历史：认不出的 mode 也整块丢掉（不猜，猜错的方向都不安全）',
    historyProbe?.[2]?.options === undefined,
    JSON.stringify(historyProbe?.[2]?.options)
  )

  check(
    '历史：好的参数原样读回来',
    historyProbe?.[0]?.options?.trim?.start === 2 &&
      historyProbe?.[0]?.options?.trim?.end === 4 &&
      historyProbe?.[0]?.options?.trim?.mode === 'lossless',
    JSON.stringify(historyProbe?.[0]?.options)
  )
  check(
    '历史：坏参数那一条退成「没有参数」，而不是编一个出来',
    historyProbe?.[1]?.options === undefined,
    JSON.stringify(historyProbe?.[1]?.options)
  )

  // 「再行调律」的定义是「复现当初那一次操作」，而参数是那次操作的一半。
  // 只还原目标格式不还原参数的话：历史页上写着「裁 3.0s–8.0s」，点下去出来一整段
  // ——正是 core/rerun.ts 文件头第 3 条在防的「静默换个结果」，只不过换的是长度。
  const histSrc = await copyOf(trimSrc, 'trim-hist.mp4')
  appendHistory({
    id: 'hist-trim-1',
    inputPath: histSrc,
    inputName: 'trim-hist.mp4',
    category: 'video',
    fromExt: 'mp4',
    toExt: 'mkv',
    engine: 'ffmpeg',
    status: 'done',
    options: { trim: { start: 2, end: 4, mode: 'lossless' } },
    createdAt: 1,
    startedAt: 2,
    finishedAt: 3
  })

  // 名字与 [11] 那节的不重名：两处都在 `main()` 的同一个块作用域里
  const trimRerunHandler = ipcHandlers.get(CH.historyRerun)
  check('再行调律：handler 在（[11] 那节注册的）', trimRerunHandler !== undefined)
  if (trimRerunHandler !== undefined) {
    const rerunResult = (await trimRerunHandler({}, { ids: ['hist-trim-1'] })) as AddResult
    check('再行调律：入队成功', rerunResult.added === 1, JSON.stringify(rerunResult))

    const rerunTask = ipcTasks.list().find((t) => t.inputPath === histSrc) ?? null
    check(
      '再行调律：复现当初的目标格式（mkv）',
      rerunTask?.toExt === 'mkv',
      String(rerunTask?.toExt)
    )
    check(
      '再行调律：**参数也一起复现**（只还原格式不还原参数 = 静默换个结果）',
      rerunTask?.options?.trim?.start === 2 &&
        rerunTask?.options?.trim?.end === 4 &&
        rerunTask?.options?.trim?.mode === 'lossless',
      JSON.stringify(rerunTask?.options)
    )
  }

  // 收尾：这一节在 `ipcTasks` 上建的任务都是「入队但从不打算开跑」的（参数通道那几条
  // 判据都不需要真转一次），所以直接取消掉再关。
  //
  // **不能改用 `settle` 等它们**：`settle` 把 `queued` 也算作「还在忙」，会一路等满
  // 90 秒超时——而 `falsify:tasks` 要拿这套跑十轮，十轮就是白等十五分钟。
  // 取消是幂等的：已经是终态的任务调它什么都不发生。
  ipcTasks.cancel(ipcTasks.list().map((task) => task.id))
  ipcTasks.shutdown()

  /* ------------------------------- [18] 输出约束：目标体积 / 目标码率（线 A） */

  // ⚠️ 编号 18 而位置在 [17] 之前：**[17] 清理必须是最后一段**（它删目录并 `process.exit`），
  // 所以这一段只能插在它前面；编号按「当前最后一个小节的下一号」顺延，不改已有小节的号。
  console.log('\n[18] 输出约束（目标体积 / 目标码率）')

  /*
    这一节盯的是「输出约束」这条通道：用户填的目标（体积或码率）从 `TaskManager` 一路
    走到 ffmpeg 的命令行，并且真的改变了产物的**体积**。

    判据全部落在**产物的可观测量**上（体积、时长、码流指纹），参数数组只作补充——
    「参数里有 -b:v」在「拼对了但被 -crf 覆盖掉」的实现里照样绿。

    四条最容易写空的，逐条说清它为什么这么写：

      1. **体积目标要同时判「不超标」与「时长没被截断」。** 只判前者的实现可以是 `-fs`
         （实测：目标 300 KB 产出 534 KB 且视频被截在 2.03 秒），只判后者的实现可以什么都
         不做。两条一起，才排掉「用一个坏办法实现了一个好目标」。
      2. **「有体积目标时没走 `-c copy`」必须用码流指纹判。** 这个方向（h264+aac → mkv）
         不带目标时本来就走 remux，而 remux 一个字节都不编、物理上改不了体积——
         「产物更小了」证明不了没走 `-c copy`，`-c copy` 的产物**就是**源。
      3. **两条并发任务各带不同目标**，验 `-passlogfile` 的唯一性：共用统计文件时产物码率
         完全不对而任务报成功，只有「每条都跟自己的目标比」才抓得住。
      4. **进度要判「真走完」而不只是「有推送」。** 两遍编码让 `-progress` 记录跑两轮，
         拼起来喂的实现在第二遍开头回跳（被解析器的单调钳制压成「停在 100%」）。
         口径是**只喂第二遍**（见 `converters/ffmpegRun.ts` 那段说明），所以这里断言
         「确定进度全部出现在第二遍那条提示之后」——这一条正是为了把
         「喂第一遍 / 两遍都喂」这两种实现与它分开。
  */

  /**
   * 失败原因的可读文本 = 卡片上那一行 + 展开后的完整日志。
   *
   * ⚠️ **不能只查 `task.error`**：它是 `core/task.ts` 的 `summarize()` 从日志尾部挑出的
   * **最后一条**有内容的行（那是给卡片用的「下一步怎么办」），而引擎给的 `ConversionFailed`
   * 是多行的，「为什么不行」常常落在前面几行。实测踩到过：查 `error` 拿到的是
   * 「去掉输出目标…」那一句，断言就红了，而**实现是对的**。
   */
  const failureText = (t: Task | null): string =>
    [t?.error ?? '', ...(t?.logTail ?? [])].join(' | ')

  // ---- 参数层：两遍编码与码率模式的实际形状 ----

  const passOneArgs = buildPassOneArgs('in.mp4', 'mkv', { videoKbps: 217.6, passLogFile: 'PLOG' })
  check(
    '参数层：第一遍是 -pass 1 + -passlogfile，产物丢给 null 封装器（不落盘）',
    passOneArgs.includes('-pass') &&
      passOneArgs[passOneArgs.indexOf('-pass') + 1] === '1' &&
      passOneArgs.includes('-passlogfile') &&
      passOneArgs.slice(-2).join(' ') === 'null NUL',
    passOneArgs.join(' ')
  )
  const passTwoArgs = buildFfmpegArgs('in.mp4', 'out.mkv', 'mp4', 'mkv', {
    target: { videoKbps: 217.6, audioKbps: 192, pass: 2, passLogFile: 'PLOG' }
  })
  check(
    '参数层：第二遍是 ABR（-b:v 218k / -pass 2），而且**不带 -crf**——两者同时出现时 x264 会回到质量模式，体积目标形同虚设',
    passTwoArgs.includes('-b:v') &&
      passTwoArgs[passTwoArgs.indexOf('-b:v') + 1] === '218k' &&
      passTwoArgs.includes('-pass') &&
      passTwoArgs[passTwoArgs.indexOf('-pass') + 1] === '2' &&
      passTwoArgs[passTwoArgs.indexOf('-passlogfile') + 1] === 'PLOG' &&
      !passTwoArgs.includes('-crf'),
    passTwoArgs.join(' ')
  )
  const audioRateArgs = buildFfmpegArgs('in.m4a', 'out.mp3', 'm4a', 'mp3', {
    target: { audioKbps: 96 }
  })
  check(
    '参数层：音频走 -b:a 96k，没有 -b:v（音频不需要两遍）',
    audioRateArgs.includes('-b:a') &&
      audioRateArgs[audioRateArgs.indexOf('-b:a') + 1] === '96k' &&
      !audioRateArgs.includes('-b:v'),
    audioRateArgs.join(' ')
  )
  check(
    '参数层：没有码率旋钮的出口被认出来（gif / 无损音频 / 图片出口），有旋钮的照常放行',
    !supportsOutputTarget('gif') &&
      !supportsOutputTarget('wav') &&
      !supportsOutputTarget('flac') &&
      !supportsOutputTarget('bmp') &&
      supportsOutputTarget('mp4') &&
      supportsOutputTarget('mp3'),
    ['gif', 'wav', 'flac', 'bmp', 'mp4', 'mp3']
      .map((e) => `${e}=${supportsOutputTarget(e)}`)
      .join(' ')
  )

  // ---- 素材：沿用 [16] 那份 10 秒 640x360 h264+aac 的 mp4 ----
  //
  // 它有两个承重性质：mp4 → mkv **本来就走 remux**（所以「指纹变了」能证明没走 `-c copy`），
  // 以及它 1.1 MB / 885 kbps 的体积给体积目标留出了真正的压缩空间。
  const outSrc = trimSrc
  const outSrcVideo = await streamFingerprint(outSrc, '0:v:0')
  const outSrcBytes = (await stat(outSrc)).size
  check(
    '输出约束素材：视频指纹非空且体积够大（下面所有「指纹不同」的断言都以前置为准）',
    outSrcVideo !== '' && outSrcBytes > 500 * 1024,
    `指纹=${outSrcVideo || '（空）'} 体积=${outSrcBytes}`
  )

  // ---- 视频：目标体积（两遍 ABR） ----

  const sizeTarget = 512 * 1024
  const sizeId = await addOne(manager, await copyOf(outSrc, 'out-size.mp4'))
  check('体积目标：任务建起来了', sizeId !== null)
  let sizeOut: string | null = null
  if (sizeId !== null) {
    manager.setTarget(sizeId, 'mkv')
    manager.setOptions(sizeId, { output: { targetBytes: sizeTarget } })
    manager.start([sizeId])
    await settle(manager)
    const sizeTask = manager.list().find((t) => t.id === sizeId) ?? null
    sizeOut = outputOf(sizeTask)
    check('体积目标：任务成功', sizeOut !== null, `${sizeTask?.status} ${sizeTask?.error ?? ''}`)
  }

  const sizeBytes = sizeOut === null ? 0 : (await stat(sizeOut)).size
  check(
    '体积目标：产物 ≤ 目标 × 1.15（ABR 有偏差，判据刻意不写成精确小于）',
    sizeBytes > 0 && sizeBytes <= sizeTarget * 1.15,
    `${sizeBytes} / 目标 ${sizeTarget}`
  )
  const sizeInfo = sizeOut === null ? null : await probeOf(sizeOut)
  const sizeDuration = sizeInfo?.durationSec ?? null
  check(
    '体积目标：时长与源一致（挡住 `-fs` 那种「写到这么多就停」而把视频截在 2 秒的实现）',
    sizeDuration !== null && Math.abs(sizeDuration - 10) <= 0.35,
    `时长 ${sizeDuration}`
  )
  const sizeOutVideo = sizeOut === null ? '' : await streamFingerprint(sizeOut, '0:v:0')
  check(
    '体积目标：码流指纹与源不同（= 确实重编码了）——这个方向不带目标时本来走 `-c copy`，而它改不了体积',
    outSrcVideo !== '' && sizeOutVideo !== '' && sizeOutVideo !== outSrcVideo,
    `源=${outSrcVideo || '（空）'} 产物=${sizeOutVideo || '（空）'}`
  )

  // ---- 视频：目标码率（单遍） ----

  const rateKbps = 200
  const rateId = await addOne(manager, await copyOf(outSrc, 'out-rate.mp4'))
  check('码率目标：任务建起来了', rateId !== null)
  let rateOut: string | null = null
  if (rateId !== null) {
    manager.setTarget(rateId, 'mkv')
    manager.setOptions(rateId, { output: { bitrateKbps: rateKbps } })
    manager.start([rateId])
    await settle(manager)
    const rateTask = manager.list().find((t) => t.id === rateId) ?? null
    rateOut = outputOf(rateTask)
    check('码率目标：任务成功', rateOut !== null, `${rateTask?.status} ${rateTask?.error ?? ''}`)
  }

  const rateBytes = rateOut === null ? 0 : (await stat(rateOut)).size
  check(
    '码率目标：产物体积明显小于源（不带目标时这个方向是 remux，产物就是源本身）',
    rateBytes > 0 && rateBytes < outSrcBytes * 0.6,
    `${rateBytes} / 源 ${outSrcBytes}`
  )
  // 音轨那一侧的实测值：这段素材的 aac（-b:a 192k 标称）实际只编出约 121 kbps，
  // 所以总码率的落点在 200 + 121 附近，而不是 200 + 192。上限留到 450 是给 ABR 的偏差，
  // 真正的判别力在「不带目标的实现会给出 885 kbps」那一边。
  const rateActual = rateBytes === 0 ? 0 : (rateBytes * 8) / 10 / 1000
  check(
    '码率目标：实际码率落在目标附近（视频 200k + 音轨实测约 121k）',
    rateActual >= 150 && rateActual <= 450,
    `实际约 ${rateActual.toFixed(1)} kbps`
  )
  const rateOutVideo = rateOut === null ? '' : await streamFingerprint(rateOut, '0:v:0')
  check(
    '码率目标：码流指纹与源不同（单遍码率模式同样是重编码）',
    outSrcVideo !== '' && rateOutVideo !== '' && rateOutVideo !== outSrcVideo,
    `源=${outSrcVideo || '（空）'} 产物=${rateOutVideo || '（空）'}`
  )

  // ---- 两遍编码的残留：统计文件必须在**临时目录**里，且收尾删干净 ----
  //
  // 不指定 `-passlogfile` 时 ffmpeg 会把 `ffmpeg2pass-0.log` 写在**当前工作目录**
  // （开发时就是仓库根）。所以这两条一条查 cwd、一条查系统临时目录。
  //
  // ⚠️ 说明白这两条的**判别力**：查 cwd 那条是**防呆**——实测把第二遍的 `-passlogfile`
  // 整个去掉时，x264 会因为找不到统计文件直接报
  // `Error while opening encoder`、任务失败，而不是留下那个文件（所以它没有对应的变异，
  // 真正守门的是「并发」那条与下面清理那条）。留着它是因为它挡的是**将来**有人把
  // 统计文件写在 cwd 又不清理那种改法。
  const cwdPassLogs = (await listFiles(process.cwd())).filter((n) => n.startsWith('ffmpeg2pass'))
  check(
    '两遍编码：没有把统计文件写在当前工作目录（ffmpeg 的默认位置）',
    cwdPassLogs.length === 0,
    cwdPassLogs.join(', ')
  )
  const tmpPassLogs = (await readdir(tmpdir())).filter((n) =>
    n.startsWith(`arbiter-2pass-${process.pid}-`)
  )
  check(
    '两遍编码：系统临时目录里也没有留下统计文件（-0.log 与 .mbtree 一并删掉）',
    tmpPassLogs.length === 0,
    tmpPassLogs.join(', ')
  )

  // ---- 音频：目标体积与目标码率 ----

  const audSrc = resolve(TMP, 'out-audio.m4a')
  const audMade = await runFfmpeg([
    '-hide_banner',
    '-v',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:duration=20',
    '-c:a',
    'aac',
    '-b:a',
    '128k',
    audSrc
  ])
  check('音频素材：20 秒正弦 m4a', audMade.code === 0, audMade.stderr.slice(-200))

  // 20 秒 × 目标 320000 字节 → 正好 128 kbps（MPEG-1 Layer III 的合法档位，编码器不会取整到别处）
  const audSizeTarget = 320 * 1000
  const audSizeId = await addOne(manager, await copyOf(audSrc, 'out-audio-size.m4a'))
  check('音频体积目标：任务建起来了', audSizeId !== null)
  let audSizeOut: string | null = null
  if (audSizeId !== null) {
    manager.setTarget(audSizeId, 'mp3')
    manager.setOptions(audSizeId, { output: { targetBytes: audSizeTarget } })
    manager.start([audSizeId])
    await settle(manager)
    const audSizeTask = manager.list().find((t) => t.id === audSizeId) ?? null
    audSizeOut = outputOf(audSizeTask)
    check(
      '音频体积目标：任务成功',
      audSizeOut !== null,
      `${audSizeTask?.status} ${audSizeTask?.error ?? ''}`
    )
  }
  const audSizeBytes = audSizeOut === null ? 0 : (await stat(audSizeOut)).size
  check(
    '音频体积目标：产物 ≤ 目标 × 1.15（音频是单遍，直接就是码率）',
    audSizeBytes > 0 && audSizeBytes <= audSizeTarget * 1.15,
    `${audSizeBytes} / 目标 ${audSizeTarget}`
  )
  const audSizeInfo = audSizeOut === null ? null : await probeOf(audSizeOut)
  const audSizeDuration = audSizeInfo?.durationSec ?? null
  check(
    '音频体积目标：时长与源一致（20 秒）',
    audSizeDuration !== null && Math.abs(audSizeDuration - 20) <= 0.4,
    `时长 ${audSizeDuration}`
  )

  const audRateId = await addOne(manager, await copyOf(audSrc, 'out-audio-rate.m4a'))
  check('音频码率目标：任务建起来了', audRateId !== null)
  let audRateOut: string | null = null
  if (audRateId !== null) {
    manager.setTarget(audRateId, 'mp3')
    manager.setOptions(audRateId, { output: { bitrateKbps: 64 } })
    manager.start([audRateId])
    await settle(manager)
    const audRateTask = manager.list().find((t) => t.id === audRateId) ?? null
    audRateOut = outputOf(audRateTask)
    check(
      '音频码率目标：任务成功',
      audRateOut !== null,
      `${audRateTask?.status} ${audRateTask?.error ?? ''}`
    )
  }
  const audRateBytes = audRateOut === null ? 0 : (await stat(audRateOut)).size
  const audKbps = audRateBytes === 0 ? 0 : (audRateBytes * 8) / 20.1 / 1000
  check(
    '音频码率目标：实际码率落在 64 kbps 附近（CBR 的落点很准，实测 64.3）',
    audKbps >= 50 && audKbps <= 85,
    `实际约 ${audKbps.toFixed(1)} kbps`
  )

  // ---- 没有码率旋钮的出口：**报错**，不是静默忽略 ----
  //
  // wav 是无损的：码率由采样率与位深决定，给 `-b:a` 它照样按 1411 kbps 写。
  // 静默忽略的表现是「用户填了 300 KB，拿到 5 MB，任务报成功」。
  const wavId = await addOne(manager, await copyOf(audSrc, 'out-audio-wav.m4a'))
  check('无损出口：任务建起来了', wavId !== null)
  if (wavId !== null) {
    manager.setTarget(wavId, 'wav')
    manager.setOptions(wavId, { output: { targetBytes: audSizeTarget } })
    manager.start([wavId])
    await settle(manager)
    const wavTask = manager.list().find((t) => t.id === wavId) ?? null
    check(
      '无损出口（wav）+ 体积目标：任务失败，而不是产出一个体积与目标毫不相干的文件',
      wavTask?.status === 'error',
      `${wavTask?.status} ${wavTask?.error ?? ''}`
    )
    check(
      '失败原因点明了「没有码率旋钮」，并给出下一步',
      failureText(wavTask).includes('没有码率旋钮') &&
        failureText(wavTask).includes('去掉输出目标'),
      failureText(wavTask)
    )
  }

  // ---- 输出约束 + 无损裁剪：**报错**，不静默二选一 ----
  //
  // 两者物理上矛盾：无损裁剪是 `-c copy`，一个字节都不重编。静默按 `-c copy` 办是
  // 「用户填了 512 KB，拿到 3 MB，任务报成功」；静默按输出目标办则违背了无损裁剪的承诺。
  const clashId = await addOne(manager, await copyOf(outSrc, 'out-clash.mp4'))
  check('互斥用例：任务建起来了', clashId !== null)
  if (clashId !== null) {
    manager.setTarget(clashId, 'mkv')
    manager.setOptions(clashId, {
      trim: { start: 1, end: 3, mode: 'lossless' },
      output: { targetBytes: sizeTarget }
    })
    manager.start([clashId])
    await settle(manager)
    const clashTask = manager.list().find((t) => t.id === clashId) ?? null
    check(
      '输出目标 + 无损裁剪：任务失败，而不是静默二选一',
      clashTask?.status === 'error',
      `${clashTask?.status} ${clashTask?.error ?? ''}`
    )
    check(
      '失败原因说清了是「不能同时要求」，并给出下一步',
      failureText(clashTask).includes('不能同时要求') &&
        failureText(clashTask).includes('精确模式'),
      failureText(clashTask)
    )
  }

  // ---- GPU（NVENC）与 ABR 互斥：用 CPU 并且**说出来**，不静默产出一个 CQ 模式的产物 ----
  //
  // 先钉参数层：`videoArgs` 的码率分支必须在 NVENC 分支**之前**返回。顺序反过来的表现是
  // 产物按 `-cq` 编出来，体积与目标脱钩（`-cq` 与 `-b:v` 同时出现时 `-b:v` 只是上限），
  // 而任务报成功——正是「不报错的错误答案」。
  const gpuAbrArgs = buildFfmpegArgs('in.mkv', 'out.mkv', 'mkv', 'mkv', {
    hardware: true,
    target: { videoKbps: 200 }
  })
  check(
    '参数层：开了硬件编码 + 有输出目标时，参数仍是 ABR（没有 -cq / h264_nvenc）',
    gpuAbrArgs.includes('-b:v') &&
      !gpuAbrArgs.includes('-cq') &&
      !gpuAbrArgs.some((a) => a.includes('nvenc')),
    gpuAbrArgs.join(' ')
  )

  // 再真跑一次：这次转换**不该**去探显卡，而且要把「用 CPU」这件事说出来。
  // 探测结果强行压成 true（抄 [14] 的手法）：不按机器分叉，有卡没卡都走同一条判断。
  setHardwareEncodeProbe(Promise.resolve(true))
  updateSettings({ hardwareEncode: true })
  const gpuCpuId = await addOne(manager, await copyOf(outSrc, 'out-gpu-abr.mp4'))
  check('GPU 互斥：任务建起来了', gpuCpuId !== null)
  if (gpuCpuId !== null) {
    manager.setTarget(gpuCpuId, 'mkv')
    manager.setOptions(gpuCpuId, { output: { targetBytes: sizeTarget } })
    manager.start([gpuCpuId])
    await settle(manager)
    const gpuCpuTask = manager.list().find((t) => t.id === gpuCpuId) ?? null
    check(
      'GPU 互斥：任务成功',
      gpuCpuTask?.status === 'done',
      `${gpuCpuTask?.status} ${gpuCpuTask?.error ?? ''}`
    )
    const gpuCpuStages = patches
      .flatMap((p) => p.updated)
      .filter((u) => u.id === gpuCpuId)
      .map((u) => (u.progress?.kind === 'indeterminate' ? u.progress.stage : ''))
      .filter(Boolean)
    check(
      'GPU 互斥：明确说出「本次用 CPU」，而不是静默换一条路',
      gpuCpuStages.some((s) => s.includes('与显卡编码的 CQ 模式互斥')),
      gpuCpuStages.join(' | ') || '（无提示）'
    )
  }
  // 复位：别把开关注到后面的用例上，也别把探测缓存留在假值上
  updateSettings({ hardwareEncode: false })
  setHardwareEncodeProbe(Promise.resolve(false))

  // ---- 两条并发任务各带不同体积目标：验 `-passlogfile` 的唯一性 ----
  //
  // 共用统计文件时，第二遍读到的可能是**另一条任务**的分析结果，于是产物码率完全不对
  // ——而两条任务都会报成功、产物都存在、都不为空。只有「每条都跟**自己的**目标比」
  // 才能把它抓出来：被污染的那条会明显超出自己的目标。
  const concSmall = 400 * 1024
  const concBig = 1200 * 1024
  const concATarget = concSmall
  const concBTarget = concBig
  const concA = await addOne(manager, await copyOf(outSrc, 'out-conc-a.mp4'))
  const concB = await addOne(manager, await copyOf(outSrc, 'out-conc-b.mp4'))
  check('并发前提：两条任务都建起来了', concA !== null && concB !== null)
  if (concA !== null && concB !== null) {
    manager.setTarget(concA, 'mkv')
    manager.setTarget(concB, 'mkv')
    manager.setOptions(concA, { output: { targetBytes: concATarget } })
    manager.setOptions(concB, { output: { targetBytes: concBTarget } })
    manager.start([concA, concB])

    // 「同时」是承重的：两条串着跑的话，passlog 冲不冲突根本观察不到
    let overlapped = false
    for (let i = 0; i < 300 && !overlapped; i += 1) {
      const mine = manager.list().filter((t) => t.id === concA || t.id === concB)
      if (mine.filter((t) => t.status === 'running').length === 2) overlapped = true
      if (!mine.some((t) => t.status === 'running' || t.status === 'queued')) break
      await delay(20)
    }
    check('并发前提：两条任务确实同时在跑（否则统计文件冲不冲突无从谈起）', overlapped)

    await settle(manager)
    const concTasks = manager.list().filter((t) => t.id === concA || t.id === concB)
    check(
      '并发：两条都成功',
      concTasks.length === 2 && concTasks.every((t) => t.status === 'done'),
      concTasks.map((t) => `${t.status}:${t.error ?? ''}`).join(' | ')
    )
    const concSizes = await Promise.all(
      concTasks.map(async (t) =>
        outputOf(t) === null ? 0 : (await stat(outputOf(t) as string)).size
      )
    )
    check(
      '并发：每条产物都 ≤ 它**自己的**目标 × 1.15（统计文件没被另一条覆盖）',
      concSizes.length === 2 &&
        concSizes.every((s) => s > 0) &&
        concSizes[0] <= concATarget * 1.15 &&
        concSizes[1] <= concBTarget * 1.15,
      `A ${concSizes[0]} ≤ ${concATarget} · B ${concSizes[1]} ≤ ${concBTarget}`
    )
    check(
      '并发：两条落在不同的文件上（没有互相覆盖）',
      new Set(concTasks.map((t) => t.outputPath)).size === 2,
      concTasks.map((t) => t.outputPath).join(' | ')
    )
  }

  // ---- 进度：两遍编码只喂第二遍，而且真的走完 ----
  //
  // ⚠️ **这一节专门换一份更慢的素材**：ffmpeg 每约 0.5 秒才吐一条 `-progress` 记录，
  // 上面那份 10 秒 640x360 的第二遍只跑约 0.6 秒，实测只留下「0」与「1」两条——
  // 「中途出现过中间值」那条断言会在**任何一台更快的机器上**假红，红的是素材而不是实现。
  // 所以照 [16] 的先例换成 60 秒的 720p（它在 1280x720 上要跑一秒多）。
  //
  // 顺带覆盖「精确裁剪 + 体积目标」这个组合：界面上写着两者可以一起用，而它自己
  // 是一条独立的参数通道（`-ss/-t` 与 `-b:v` 同时出现）。素材没有音轨，
  // 也就不必从总预算里扣音频那一份。
  const progTarget = 512 * 1024
  const outProgId = await addOne(manager, await copyOf(longVideo, 'out-prog.mp4'))
  check('两遍编码进度：任务建起来了', outProgId !== null)
  if (outProgId !== null) {
    manager.setTarget(outProgId, 'mkv')
    manager.setOptions(outProgId, {
      trim: { start: 0, end: 60, mode: 'exact' },
      output: { targetBytes: progTarget }
    })
    manager.start([outProgId])
    await settle(manager)
    const progTask = manager.list().find((t) => t.id === outProgId) ?? null
    check(
      '两遍编码进度：精确裁剪 + 体积目标这个组合能用（-ss/-t 与 -b:v 同时出现）',
      progTask?.status === 'done',
      `${progTask?.status} ${progTask?.error ?? ''}`
    )
  }

  const progPushes = patches.flatMap((p) => p.updated).filter((u) => u.id === outProgId)
  const progPercents = progPushes
    .filter((u) => u.progress?.kind === 'determinate')
    .map((u) => (u.progress as { percent: number }).percent)
  check(
    '两遍编码：确定进度的百分比单调不减（两遍都喂的实现在第二遍开头会回跳）',
    progPercents.length > 0 && progPercents.every((v, i) => i === 0 || v >= progPercents[i - 1]),
    progPercents.map((v) => v.toFixed(3)).join(', ')
  )
  check(
    '两遍编码：最终走到 1，而不是停在中间',
    progPercents.at(-1) === 1,
    progPercents.map((v) => v.toFixed(3)).join(', ')
  )
  check(
    '两遍编码：中途出现过 0 与 1 之间的值（不是一步跳到 1）',
    progPercents.some((v) => v > 0 && v < 1),
    progPercents.map((v) => v.toFixed(3)).join(', ')
  )
  // 口径是「只喂第二遍」：第一遍全程不确定进度，第二遍才是那条 0→1。
  // 于是「第一次确定进度」必须出现在「第二遍」那条提示**之后**——
  // 「喂第一遍」的实现会把它推到前面（进度在第一遍就跑满、然后停在 100%），这条专抓它。
  // （该断言依赖两条推送落在**不同**的 patch 批次里，而它们之间隔着一整个进程启动，够远。）
  const stageAt = (needle: string): number =>
    progPushes.findIndex(
      (u) => u.progress?.kind === 'indeterminate' && u.progress.stage.includes(needle)
    )
  const firstDeterminate = progPushes.findIndex((u) => u.progress?.kind === 'determinate')
  check(
    '两遍编码：第一遍推的是不确定进度，确定进度只在「第二遍」之后才开始（口径：只喂第二遍）',
    stageAt('第一遍') >= 0 && stageAt('第二遍') >= 0 && firstDeterminate > stageAt('第二遍'),
    `第一遍@${stageAt('第一遍')} 第二遍@${stageAt('第二遍')} 首次确定进度@${firstDeterminate}`
  )

  /* ------------------------------------------- [19] 空产物不得冒充成功（GUI 路径） */

  console.log('\n[19] 空产物不得冒充成功（GUI 完成路径）')

  /*
    审计报告 §3.1：「产物不得为空即失败」这条规矩在代码里已经有**四份**实现
    （MCP 侧全部引擎、LibreOffice、Calibre、`pdf → txt/md` 的 `textlessReason`），
    而**覆盖面最广的那条通用完成路径——GUI 的——没有**：`stat` 拿到 size 之后直接
    `status = 'done'`，没有 `size === 0` 的分支。后果是**同一次转换在两个界面上
    得到两种判定**：经 MCP 走报 `source_corrupt`，在桌面界面里显示「已成（0 字节）」。

    修法不是在这里补一个分支，而是把判据做成**共用件**（`converters/common.ts` 的
    `isEmptyOutput` / `assertOutputNotEmpty` + `EMPTY_OUTPUT_MESSAGE`），GUI 这条
    完成路径上接一次；MCP 侧接同一个谓词。于是「谁在什么条件下算成功」只剩一份。

    素材就是审计列的第一个触发场景：**正文只有一张图**的 markdown。
    `marked` 把 `![红块](pic.png)` 渲染成 `<p><img …></p>`，`htmlToText` 先后剥掉
    `</p>` 与 `<img>`，`.trim()` 之后只剩空串 → 写一个 **0 字节**文件。
    （不需要真有一张图片文件：这里问的不是渲染，而是「产物 0 字节时界面怎么说」。）
  */

  // ---- 判据本身（共用件，与引擎无关） ----
  //
  // ⚠️ 文案**不在** `ConversionFailed.message` 里：那个 message 恒为「转换失败」，
  // 内容全在 `logTail`（UI 的「展开日志」看的也是同一份）。所以判文案必须读 `logTail`。
  const judge = (size: number | null): unknown => {
    try {
      assertOutputNotEmpty(size, 'D:\\out\\x.txt')
      return null
    } catch (error) {
      return error
    }
  }
  const judgeDetail = (error: unknown): string =>
    error instanceof ConversionFailed ? error.logTail.join(' | ') : String(error)

  const zeroError = judge(0)
  check(
    '共用判据：0 字节 → 抛 ConversionFailed',
    zeroError instanceof ConversionFailed,
    judgeDetail(zeroError)
  )
  // 1 字节必须放行：`xlsx/csv → csv` 在首个工作表为空时会写出一个 UTF-8 BOM（1 字节），
  // 那一档刻意不在判据覆盖范围内（见 `isEmptyOutput` 的说明）。
  check('共用判据：非 0 字节 → 放行（1 字节也放行）', judge(1) === null && judge(1024) === null)
  // `stat` 失败（`null`）**不归这条判据管**：产物已经转出来了，把「读不出大小」改判成
  // 失败才是撒谎。写成「`null` 也当 0 处理」的话，这一格会变成一条假失败。
  check('共用判据：读不到体积（null）→ 放行，不误报成「产物是 0 字节」', judge(null) === null)
  const zeroText = judgeDetail(zeroError)
  check(
    '共用判据用的是与 MCP 侧一字不差的文案',
    zeroText.includes('产物是 0 字节：转换进程正常退出了，但没有写出任何内容'),
    zeroText
  )

  const sizeOf = (path: string): Promise<number> =>
    stat(path)
      .then((s) => s.size)
      .catch(() => -1)

  // ---- GUI 那条真实路径：TaskManager 必须收成 error ----
  const onlyImage = resolve(TMP, 'only-image.md')
  await writeFile(onlyImage, '![红块](pic.png)\n', 'utf8')
  // 名字带 ZeroOut：本套件另有一节（[1] 的空文件校验）已经用了 `zeroOutTask`
  const zeroOutTask = await convertOne(manager, onlyImage, 'txt')

  // 前置条件（承重）：产物**真的**写出过、而且是 0 字节。少了它，「收成 error」在
  // 「引擎自己报错、压根没写出文件」时也会绿——那时红的原因与被测的那条判据无关。
  // 顺带说明：这条 0 字节文件**留在磁盘上**（与 MCP 侧行为一致：两边都只改判定、
  // 不动用户的目录），所以这个断言也是那份行为的记录。
  const emptyBytes = await sizeOf(resolve(TMP, 'only-image.txt'))
  check(
    '前置：转换确实写出过一个 0 字节的产物（它本来会走「已成」那条路）',
    emptyBytes === 0,
    `${emptyBytes} 字节`
  )
  check(
    'GUI：正文只有一张图的 md → txt 收成 error，而不是「已成（0 字节）」',
    zeroOutTask?.status === 'error',
    `${zeroOutTask?.status} ${zeroOutTask?.error ?? ''}`
  )
  const emptyText = [zeroOutTask?.error ?? '', ...(zeroOutTask?.logTail ?? [])].join(' | ')
  check(
    'GUI：诊断说的是「产物是 0 字节」（与 MCP 侧同一句）',
    emptyText.includes('产物是 0 字节'),
    emptyText
  )
  check('GUI：诊断里带上了产物路径', emptyText.includes('only-image.txt'), emptyText)
  // `outputPath` 必须保持为空：填上的话界面会给这条**失败**的任务显示「打开产物」，
  // 指向那个 0 字节文件——正是这条判据要消灭的那种假象。
  check(
    'GUI：失败的任务没有留下 outputPath / sizeBytes',
    zeroOutTask?.outputPath === undefined && zeroOutTask?.sizeBytes === undefined,
    `${zeroOutTask?.outputPath} / ${zeroOutTask?.sizeBytes}`
  )

  // ---- 对照组：同一个出口、正文有实际内容的那一份必须照常成功 ----
  // 少了它，「md → txt 报错」在一条「整个出口都坏掉」的实现上照样绿。
  const plainMd = resolve(TMP, 'plain-text.md')
  await writeFile(plainMd, '# 标题\n\n这是一段有实际内容的中文正文。\n', 'utf8')
  const okTask = await convertOne(manager, plainMd, 'txt')
  check(
    '对照：同一条 md → txt 出口，正文有内容时照常成功（判据不是「md → txt 一律失败」）',
    okTask?.status === 'done',
    `${okTask?.status} ${okTask?.error ?? ''}`
  )
  check(
    '对照：产物体积 > 0 且被记在任务上',
    (okTask?.sizeBytes ?? 0) > 0,
    String(okTask?.sizeBytes)
  )

  /* ------------------------------------ [20] 处理链在 ffmpeg 侧落地（滤镜 / 响度） */

  // ⚠️ 编号 20 而位置在 [17] 之前：**[17] 清理必须是最后一段**（它删目录并 `process.exit`），
  // 所以这一段只能插在它前面；编号按「当前最后一个小节的下一号」顺延，不改已有小节的号。
  console.log('\n[20] 处理链（滤镜 / 响度归一化）')

  /*
    这一节盯的是 `TaskOptions.filters`（**有序**动作数组）在 ffmpeg 这一侧的落地：
    参数从 `TaskManager` 一路走到命令行，并且真的改变了产物。

    三组容易写空的断言，逐条说清为什么这么写：

      1. **「任务成功」不等于「滤镜生效」。** 所以每条滤镜断言都落在**产物的可观测差异**上，
         而且都带一个**对照**：同一素材、同一目标、不加滤镜时这个方向本来走 `-c copy`
         （码流指纹与源逐位相同）。有了那个对照，「指纹与源不同」才能同时证明两件事——
         滤镜真的改了像素，以及**没走 `-c copy`**（`-c copy` 搬的是原始码流，装不下改过
         像素的东西；这正是 `docs/RESEARCH.md` §4.1 说最容易漏的那一处）。
      2. **方向类断言（旋转）必须读到像素。** 只断言宽高互换的话，`transpose=1` 与
         `transpose=2` 都合格，连「180 度」（宽高不变）都区分不出来——那种断言是装饰。
         所以素材是「160x120，左上角一块 80x60 的白块」，产物用 `crop=1:1:x:y` 逐像素读回来，
         白块落在哪个角就是转了多少度。
      3. **顺序是语义**：`[去隔行, 锐化]` 与 `[锐化, 去隔行]` 在同一条素材上产物**不同**。
         这是「数组顺序真的被执行了」唯一的直接证据（参数数组里两条链的滤镜集合一模一样，
         只有次序不同）。

    响度那一节另有两处承重：两遍（线性）与单遍（动态）的区别落在**动态范围**上，
    而「整体响度落在目标附近」**两种实现都满足**（实测：两遍 -13.7、单遍 -12.6 LUFS，
    都在 ±2 LU 内）——所以只写那一条等于什么都没测。真正的判据是**前后两段的响度差**
    （源 30.4 LU：两遍线性保住 30.5，单遍动态被压成 6.9），并且配一个**单遍的对照组**
    证明这条判据确实抓得住动态归一化。
  */

  // 这一节**只追加**，不动文件顶部那份 import 列表（多线并行时那一行最容易撞车）：
  // 需要的东西就地取。类型用 `import(...)` 的形式，编译期解析、运行期不加载。
  const { parseLoudnormStats } = await import('../src/main/engines/ffmpeg')
  type FilterAction = import('../src/shared/types').FilterAction
  type TrimOptions = import('../src/shared/types').TrimOptions

  updateSettings({
    outputBesideSource: true,
    outputDir: null,
    onConflict: 'rename',
    maxConcurrent: 4,
    defaultTargets: {}
  })

  const WHITE = '255,255,255'
  const BLACK = '0,0,0'

  /** 从 ffmpeg 的 stderr 里读视频流的尺寸（`MediaInfo` 里没有宽高，只解析了时长与编解码器） */
  const dimsOf = async (file: string): Promise<string> => {
    const r = await runFfmpeg(['-hide_banner', '-nostdin', '-i', file])
    const m = /Video:.*?, (\d+)x(\d+)/.exec(r.stderr)
    return m ? `${m[1]}x${m[2]}` : '?'
  }

  /**
   * 读一个像素的 RGB。
   *
   * ⚠️ **`format=rgb24` 必须排在 `crop` 之前。** yuv420p 上 `crop=1:1` 的色度平面会变成
   * 0.5x0.5，ffmpeg 报 `Error while filtering: Invalid argument` 并以非 0 退出——
   * 表现是**读回来一个空串**，而空串与「黑色」在比较时都不等于白色，能静默骗过断言
   * （实测踩到：读出来的像素是空的，而断言只是「不是白」）。先过 `format=rgb24`
   * 就没有色度平面这回事了。
   */
  const pixelAt = (file: string, x: number, y: number): Promise<string> =>
    new Promise((done) => {
      const child = spawn(
        FFMPEG,
        [
          '-hide_banner',
          '-v',
          'error',
          '-i',
          file,
          '-vf',
          `format=rgb24,crop=1:1:${x}:${y}`,
          '-frames:v',
          '1',
          '-f',
          'rawvideo',
          '-'
        ],
        { windowsHide: true }
      )
      const chunks: Buffer[] = []
      child.stdout.on('data', (c: Buffer) => chunks.push(c))
      child.on('error', () => done(''))
      child.on('close', () => {
        const bytes = Buffer.concat(chunks)
        done(bytes.length >= 3 ? `${bytes[0]},${bytes[1]},${bytes[2]}` : '')
      })
    })

  /** 加任务 → 设目标 → 设参数（处理链 / 裁剪）→ 跑到终态 */
  const withFilters = async (
    src: string,
    toExt: string,
    filters?: FilterAction[],
    trim?: TrimOptions
  ): Promise<Task | null> => {
    const id = await addOne(manager, src)
    if (id === null) return null
    manager.setTarget(id, toExt)
    if (filters !== undefined || trim !== undefined) {
      // `setOptions` 的返回值是回执（被拒时它是 false）。这里断言它在，否则下面
      // 「产物不对」会被归因成引擎的问题，而真正的原因在参数根本没设上。
      if (!manager.setOptions(id, { ...(trim ? { trim } : {}), ...(filters ? { filters } : {}) })) {
        return null
      }
    }
    manager.start([id])

    // ⚠️ **只等这一条任务，不要用 `settle(manager)`。** `settle` 等的是**整个 manager**，
    // 而前面几节留下一批「入队但从不 start」的任务——它们永远是 `queued`，于是每次调用都会
    // 白等满 90 秒超时。实测：这一节十几条断言因此要多花**十几分钟**的纯等待（套件从 20 分钟
    // 涨到 40 分钟以上），而转换本身每条只要几百毫秒。
    const deadline = Date.now() + 60_000
    for (;;) {
      const current = manager.list().find((t) => t.id === id) ?? null
      if (current === null) return null
      if (current.status !== 'queued' && current.status !== 'running') return current
      if (Date.now() > deadline) return current
      await delay(100)
    }
  }

  /** 某个任务推给 UI 的全部分段文案（`kind: 'indeterminate'` 那一路） */
  const stagesOfTask = (id: string | undefined): string[] =>
    patches
      .flatMap((p) => p.updated)
      .filter((u) => u.id === id)
      .map((u) => (u.progress?.kind === 'indeterminate' ? u.progress.stage : ''))
      .filter(Boolean)

  /**
   * 量一段的响度（LUFS）。
   *
   * ⚠️ **`-ss` 必须在 `-i` 之前**（输入侧定位）。输出侧定位会把定位点之前的内容也喂进
   * 滤镜再丢掉，统计出来的不是那一段——实测踩到过，症状是「前后两段只差 3 dB」，
   * 而真实差 30 dB。这种错误很难看出来：数字是个数，只是它答的不是你问的问题。
   */
  const loudnessOf = async (file: string, ss: number, t: number): Promise<number> => {
    const r = await ffmpegOut([
      '-hide_banner',
      '-nostdin',
      '-ss',
      String(ss),
      '-t',
      String(t),
      '-i',
      file,
      '-af',
      'ebur128=framelog=quiet',
      '-f',
      'null',
      'NUL'
    ])
    const m = /I:\s*(-?[\d.]+) LUFS/.exec(r.err)
    return m ? Number(m[1]) : Number.NaN
  }

  /** 两段之间的响度差（LU）。**这才是线性 vs 动态的判据**，见上面那段说明。 */
  const levelGap = async (file: string): Promise<number> => {
    const loud = await loudnessOf(file, 0, 1)
    const quiet = await loudnessOf(file, 2, 1)
    return loud - quiet
  }

  // ---- 参数层：几条不需要起进程的判据 ----
  //
  // 这几条是整节里最便宜的，但它们盯的正是**最容易静默出错**的一处：
  // 命令行上出现两条 `-vf` 时 ffmpeg **只取最后那个**，另一条链一声不响地消失。

  const gifArgs = (() => {
    const filters: FilterAction[] = [{ kind: 'rotate', degrees: 90 }]
    return buildFfmpegArgs('in.mp4', 'out.gif', 'mp4', 'gif', { filters })
  })()
  check(
    '参数层：gif 目标上只有一条 -vf（两条 -vf 时 ffmpeg 只取最后一条，另一条静默消失）',
    gifArgs.filter((a) => a === '-vf').length === 1,
    gifArgs.join(' ')
  )
  const gifGraph = gifArgs[gifArgs.indexOf('-vf') + 1] ?? ''
  check(
    '参数层：gif 的用户链与调色板链合并进了同一条 -vf（两条都在）',
    gifGraph.startsWith('transpose=1,') &&
      gifGraph.includes('palettegen') &&
      gifGraph.includes('paletteuse'),
    gifGraph
  )

  const audioTargetArgs = (() => {
    const filters: FilterAction[] = [{ kind: 'rotate', degrees: 90 }]
    return buildFfmpegArgs('in.mp4', 'out.mp3', 'mp4', 'mp3', { filters })
  })()
  check(
    '参数层：音频出口上不给 -vf（实测 `-vn` 与 `-vf` 同时出现时 ffmpeg 直接失败：Output file does not contain any stream）',
    !audioTargetArgs.includes('-vf'),
    audioTargetArgs.join(' ')
  )

  const loudOnePass = buildFfmpegArgs('in.mp4', 'out.mkv', 'mp4', 'mkv', {
    filters: [{ kind: 'loudnorm', targetLufs: -14 }]
  })
  const onePassAf = loudOnePass[loudOnePass.indexOf('-af') + 1] ?? ''
  check(
    '参数层：没有实测统计时 loudnorm 是单遍形态（不带 measured_*）',
    loudOnePass.includes('-af') && !onePassAf.includes('measured_I'),
    onePassAf
  )
  const loudTwoPass = buildFfmpegArgs('in.mp4', 'out.mkv', 'mp4', 'mkv', {
    filters: [{ kind: 'loudnorm', targetLufs: -14 }],
    loudnorm: {
      inputI: -22.44,
      inputTp: -17.83,
      inputLra: 3.5,
      inputThresh: -35.58,
      targetOffset: -1.41
    }
  })
  const twoPassAf = loudTwoPass[loudTwoPass.indexOf('-af') + 1] ?? ''
  // ⚠️ 刻意**不**把 `linear=true` 写进判据：实测删掉它产物**逐字节不变**
  // （loudnorm 的默认值就是 true），也就是说它是个显式化参数、**不是承重的**。
  // 把它写进断言只会得到一条永远绿的装饰——这个项目已经因此抓到过四条装饰性断言。
  // 真正决定「线性 vs 动态」的是**带不带 measured_\***（下面那条单遍断言盯的就是它）。
  check(
    '参数层：第二遍带上四个实测值（它们才是「线性 vs 动态」的判据）',
    twoPassAf.includes('measured_I=-22.44') &&
      twoPassAf.includes('measured_TP=-17.83') &&
      twoPassAf.includes('offset=-1.41'),
    twoPassAf
  )
  check(
    '参数层：不传 filters 与传空数组**逐字相同**（没开这条通道的任务一个字符都不变）',
    JSON.stringify(buildFfmpegArgs('in.mkv', 'out.mp4', 'mkv', 'mp4')) ===
      JSON.stringify(buildFfmpegArgs('in.mkv', 'out.mp4', 'mkv', 'mp4', { filters: [] })),
    buildFfmpegArgs('in.mkv', 'out.mp4', 'mkv', 'mp4', { filters: [] }).join(' ')
  )
  const parsed = parseLoudnormStats(
    'x [Parsed_loudnorm_0 @ 0x1]\n{\n\t"input_i" : "-22.44",\n\t"input_tp" : "-17.83",\n' +
      '\t"input_lra" : "3.50",\n\t"input_thresh" : "-35.58",\n\t"target_offset" : "-1.41"\n}\n'
  )
  check(
    '参数层：第一遍的 JSON 能读回来（读到 null 时会静默降级成单遍）',
    parsed !== null &&
      Math.abs(parsed.inputI + 22.44) < 0.001 &&
      Math.abs(parsed.targetOffset + 1.41) < 0.001,
    JSON.stringify(parsed)
  )
  check(
    '参数层：读不出 JSON 时回 null，而不是拿 NaN 去拼命令行',
    parseLoudnormStats('nothing here') === null &&
      parseLoudnormStats('{ "input_i" : "x" }') === null
  )

  // ---- 旋转：白块落在哪个角就是转了多少度 ----

  const rotSrc = resolve(TMP, 'filter-rot.mp4')
  const rotMade = await runFfmpeg([
    '-hide_banner',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'color=c=black:s=160x120:d=1:r=10',
    '-vf',
    'drawbox=x=0:y=0:w=80:h=60:color=white:t=fill',
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-pix_fmt',
    'yuv420p',
    rotSrc
  ])
  check(
    '旋转素材：160x120 / 左上角一块 80x60 的白块',
    rotMade.code === 0,
    rotMade.stderr.slice(-200)
  )
  const rotSrcCorner = await pixelAt(rotSrc, 10, 10)
  check(
    '旋转素材的前提：左上角确实是白的（少了它下面三条方向断言全无分辨力）',
    rotSrcCorner === WHITE,
    `左上=${rotSrcCorner}`
  )

  /** 跑一次旋转，把尺寸与白块的位置一起拿回来 */
  const rotated = async (
    degrees: 90 | 180 | 270
  ): Promise<{ status: string; dims: string; corners: string[] }> => {
    const task = await withFilters(rotSrc, 'mkv', [{ kind: 'rotate', degrees }])
    const out = outputOf(task)
    if (out === null) return { status: task?.status ?? 'missing', dims: '?', corners: [] }
    // 转 90/270 之后画面是 120x160，探针坐标要跟着换，否则探到画面外
    const [maxX, maxY] = degrees === 180 ? [160, 120] : [120, 160]
    return {
      status: task?.status ?? 'missing',
      dims: await dimsOf(out),
      corners: [
        await pixelAt(out, 10, 10),
        await pixelAt(out, maxX - 10, 10),
        await pixelAt(out, 10, maxY - 10),
        await pixelAt(out, maxX - 10, maxY - 10)
      ]
    }
  }

  const r90 = await rotated(90)
  check('rotate 90：任务完成', r90.status === 'done', r90.status)
  check('rotate 90：宽高互换（160x120 → 120x160）', r90.dims === '120x160', r90.dims)
  check(
    'rotate 90：白块落在**右上**（= 顺时针 90°；`transpose=2` 会落到左下，这条把它区分开）',
    r90.corners[1] === WHITE && r90.corners[0] === BLACK && r90.corners[2] === BLACK,
    `左上=${r90.corners[0]} 右上=${r90.corners[1]} 左下=${r90.corners[2]}`
  )

  const r180 = await rotated(180)
  check(
    'rotate 180：尺寸不变（160x120）但白块落到右下（只断言尺寸的话这条根本分不出转没转）',
    r180.dims === '160x120' && r180.corners[3] === WHITE && r180.corners[0] === BLACK,
    `${r180.dims} 左上=${r180.corners[0]} 右下=${r180.corners[3]}`
  )

  const r270 = await rotated(270)
  check('rotate 270：宽高互换（120x160）', r270.dims === '120x160', r270.dims)
  check(
    'rotate 270：白块落在**左下**（= 逆时针 90°，与 90 那一档方向相反）',
    r270.corners[2] === WHITE && r270.corners[1] === BLACK,
    `左下=${r270.corners[2]} 右上=${r270.corners[1]}`
  )

  // ---- 缩放：尺寸映射（`withoutEnlargement` 是承重的那一条） ----

  const resizeTask = await withFilters(rotSrc, 'mkv', [
    { kind: 'resize', width: 80, height: 60, fit: 'inside', withoutEnlargement: true }
  ])
  const resizeOut = outputOf(resizeTask)
  check('resize：任务完成', resizeTask?.status === 'done', resizeTask?.error ?? '')
  check(
    'resize：产物是目标尺寸 80x60',
    resizeOut !== null && (await dimsOf(resizeOut)) === '80x60',
    resizeOut === null ? '（无产物）' : await dimsOf(resizeOut)
  )

  const widthOnly = await withFilters(rotSrc, 'mkv', [
    { kind: 'resize', width: 80, fit: 'inside', withoutEnlargement: true }
  ])
  const widthOnlyOut = outputOf(widthOnly)
  check(
    'resize：只给宽 80 → 80x60（另一维按比例自动，且取偶数）',
    widthOnlyOut !== null && (await dimsOf(widthOnlyOut)) === '80x60',
    widthOnlyOut === null ? '（无产物）' : await dimsOf(widthOnlyOut)
  )

  // ⚠️ 这一对是承重的：`force_original_aspect_ratio=decrease` **会放大**（实测），
  // 「不放大」只能靠 `min(iw,框宽)` 把框先夹住。少了那个表达式，第一条会变成 640x480
  // ——用户填了「不放大」，拿到的是一张被拉大的图，而任务报成功。
  const noEnlarge = await withFilters(rotSrc, 'mkv', [
    { kind: 'resize', width: 640, height: 480, fit: 'inside', withoutEnlargement: true }
  ])
  const noEnlargeOut = outputOf(noEnlarge)
  check(
    'resize：不放大（框 640x480 而源只有 160x120）→ 产物仍是 160x120',
    noEnlargeOut !== null && (await dimsOf(noEnlargeOut)) === '160x120',
    noEnlargeOut === null ? '（无产物）' : await dimsOf(noEnlargeOut)
  )
  const enlarge = await withFilters(rotSrc, 'mkv', [
    { kind: 'resize', width: 640, height: 480, fit: 'inside', withoutEnlargement: false }
  ])
  const enlargeOut = outputOf(enlarge)
  check(
    '对照：同一个框、允许放大时确实放大到 640x480（否则上一条分不出「没放大」与「缩放整个没生效」）',
    enlargeOut !== null && (await dimsOf(enlargeOut)) === '640x480',
    enlargeOut === null ? '（无产物）' : await dimsOf(enlargeOut)
  )

  // ---- 滤镜真的改了像素，而且**没走 `-c copy`** ----

  const filterSrc = resolve(TMP, 'filter-src.mp4')
  const filterMade = await runFfmpeg([
    '-hide_banner',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=duration=2:size=160x120:rate=30',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:duration=2',
    '-vf',
    'tinterlace=1,noise=alls=24:allf=t',
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '18',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    filterSrc
  ])
  check(
    '滤镜素材：交错 + 噪点的 h264+aac mp4（滤镜改得动它，而且这个方向本来能 remux）',
    filterMade.code === 0,
    filterMade.stderr.slice(-200)
  )

  const filterSrcPrint = await streamFingerprint(filterSrc, '0:v:0')
  check(
    '素材的视频码流指纹非空（下面所有「不同」断言都以它为前置）',
    filterSrcPrint !== '',
    filterSrcPrint || '（空）'
  )

  // 对照组：同一素材、同一目标、**不加滤镜**。h264+aac 的 mp4 → mkv 本来就走 remux，
  // 于是它的指纹与源**逐位相同**。少了这条对照，「指纹不同」在一个「反正都会重编码」
  // 的实现上也照样绿。
  const plainMkv = await withFilters(filterSrc, 'mkv')
  const plainMkvOut = outputOf(plainMkv)
  const plainMkvPrint = plainMkvOut === null ? '' : await streamFingerprint(plainMkvOut, '0:v:0')
  check(
    '对照：不加滤镜时 mp4(h264+aac) → mkv 走 remux（指纹与源逐位相同）',
    plainMkvPrint !== '' && plainMkvPrint === filterSrcPrint,
    `源=${filterSrcPrint || '（空）'} 产物=${plainMkvPrint || '（空）'}`
  )

  /** 跑一条链并把产物的视频码流指纹取回来 */
  const chainPrint = async (filters: FilterAction[]): Promise<string> => {
    const task = await withFilters(filterSrc, 'mkv', filters)
    const out = outputOf(task)
    if (out === null) {
      console.log(`    · 这条链没跑成：${task?.status} ${task?.error ?? ''}`)
      return ''
    }
    return streamFingerprint(out, '0:v:0')
  }

  const deintPrint = await chainPrint([{ kind: 'deinterlace', method: 'yadif' }])
  check(
    '去隔行（yadif）：产物指纹与源不同（滤镜真的改了像素，而且**没走 `-c copy`**）',
    deintPrint !== '' && deintPrint !== filterSrcPrint,
    `源=${filterSrcPrint || '（空）'} 产物=${deintPrint || '（空）'}`
  )

  const denoisePrint = await chainPrint([{ kind: 'denoise', strength: 'strong' }])
  check(
    '降噪（hqdn3d 重档）：产物指纹与源不同',
    denoisePrint !== '' && denoisePrint !== filterSrcPrint,
    `源=${filterSrcPrint || '（空）'} 产物=${denoisePrint || '（空）'}`
  )
  check(
    '降噪的档位真的落在参数上（重档与去隔行两条链的产物互不相同）',
    denoisePrint !== '' && deintPrint !== '' && denoisePrint !== deintPrint,
    `去隔行=${deintPrint || '（空）'} 降噪=${denoisePrint || '（空）'}`
  )

  const sharpenPrint = await chainPrint([{ kind: 'sharpen', amount: 3 }])
  check(
    '锐化（unsharp 5:5:3，拉到最大档）：产物指纹与源不同',
    sharpenPrint !== '' && sharpenPrint !== filterSrcPrint,
    `源=${filterSrcPrint || '（空）'} 产物=${sharpenPrint || '（空）'}`
  )

  // ---- 顺序承重：同两条滤镜、只换次序，产物必须不同 ----
  //
  // 两条链的**滤镜集合一模一样**（都是 `yadif` 与 `unsharp=5:5:3`），只有次序不同，
  // 所以「产物不同」只可能来自次序。这是「数组顺序真的被执行了」唯一的直接证据——
  // 一个把链排序/去重的实现（比如按 kind 字典序排一下）会让这一条翻红。
  const orderA = await chainPrint([
    { kind: 'deinterlace', method: 'yadif' },
    { kind: 'sharpen', amount: 3 }
  ])
  const orderB = await chainPrint([
    { kind: 'sharpen', amount: 3 },
    { kind: 'deinterlace', method: 'yadif' }
  ])
  check(
    '顺序承重：去隔行→锐化 与 锐化→去隔行 的产物**不同**（`docs/RESEARCH.md` §4.1：反了会把噪点一起锐化出来）',
    orderA !== '' && orderB !== '' && orderA !== orderB,
    `正序=${orderA || '（空）'} 反序=${orderB || '（空）'}`
  )

  // ---- 处理链与两条 `-c copy` 快车道互斥：报错，不静默二选一 ----

  const clash = await withFilters(filterSrc, 'mkv', [{ kind: 'deinterlace', method: 'yadif' }], {
    start: 0,
    end: 1,
    mode: 'lossless'
  })
  check(
    '无损裁剪 + 处理链：任务收成 error（`-c copy` 装不下改过像素的东西，静默二选一都会产出错误答案）',
    clash?.status === 'error',
    `${clash?.status} ${clash?.error ?? ''}`
  )
  check(
    '无损裁剪 + 处理链：错误里给出下一步（改用精确模式）',
    (clash?.error ?? '').includes('精确模式'),
    clash?.error
  )
  check(
    '无损裁剪 + 处理链：没有留下 .part',
    !(await listFiles(TMP)).some((f) => f.includes('.part')),
    (await listFiles(TMP)).filter((f) => f.includes('.part')).join(', ')
  )

  // 对照：同一条裁剪 + 同一个滤镜，只把模式换成精确 → 必须成功。
  // 少了它，「报错」在一个「带裁剪的任务一律失败」的实现上也照样绿。
  const exactOk = await withFilters(filterSrc, 'mkv', [{ kind: 'deinterlace', method: 'yadif' }], {
    start: 0,
    end: 1,
    mode: 'exact'
  })
  check(
    '对照：同一条链 + 同一次裁剪，改成精确模式就成功（判据是「这两个要求互斥」，不是「带链就失败」）',
    exactOk?.status === 'done',
    `${exactOk?.status} ${exactOk?.error ?? ''}`
  )

  // `remux=force` 与处理链的矛盾只能在引擎那一层测：`remux` 是 `ConvertContext` 上的字段，
  // `TaskManager` 没有对应的旋钮（它是 MCP 的 `convert_file` 显式指定的策略）。
  //
  // ⚠️ 用**动态 import** 而不是在文件顶部加一行：这一节要能整段摘掉/追加而不动文件里
  // 其它任何一行（`tsx` 对这个写法没有额外要求，与顶部静态 import 等价）。
  const { runFfmpeg: runFfmpegEngine } = await import('../src/main/converters/ffmpegRun')
  const forceOutput = resolve(TMP, 'force-with-filters.mkv')
  const forceError = await runFfmpegEngine({
    input: filterSrc,
    output: forceOutput,
    fromExt: 'mp4',
    toExt: 'mkv',
    cancel: new CancelToken(),
    onProgress: () => undefined,
    remux: 'force',
    options: { filters: [{ kind: 'deinterlace', method: 'yadif' }] }
  }).then(
    () => null,
    (error: unknown) => error
  )
  check(
    '处理链 + remux=force：抛 ConversionFailed（要 `-c copy` 又要改像素，是调用方自相矛盾）',
    forceError instanceof ConversionFailed,
    forceError instanceof Error ? `${forceError.name}: ${forceError.message}` : String(forceError)
  )
  check(
    '处理链 + remux=force：错误里说清了「重封装搬的是原始码流」',
    forceError instanceof ConversionFailed && forceError.logTail.join(' ').includes('原始码流'),
    forceError instanceof ConversionFailed ? forceError.logTail.join(' | ') : ''
  )
  check(
    '处理链 + remux=force：没有留下产物与 .part',
    !(await listFiles(TMP)).some((f) => f.startsWith('force-with-filters'))
  )

  // ---- 响度归一化：两遍（线性）而不是单遍（动态） ----
  //
  // 素材是「前 2 秒满幅 + 后 2 秒 -30 dB」的台阶。判据不是「整体响度接近目标」——
  // 那个单遍动态归一化也满足（实测 -12.6 vs 两遍 -13.7，都在 ±2 LU 内）——而是
  // **两段的响度差保住了没有**：线性是整段平移一个增益（差不变），动态是按帧调增益
  // （安静段被提上来，差被压扁）。
  const levelLoud = resolve(TMP, 'level-loud.wav')
  const levelQuiet = resolve(TMP, 'level-quiet.wav')
  check(
    '响度素材：2 秒满幅 + 2 秒 -30 dB 的台阶',
    (
      await runFfmpeg([
        '-hide_banner',
        '-y',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:duration=2',
        levelLoud
      ])
    ).code === 0 &&
      (await runFfmpeg(['-hide_banner', '-y', '-i', levelLoud, '-af', 'volume=0.03', levelQuiet]))
        .code === 0
  )
  const levelList = resolve(TMP, 'level-list.txt')
  await writeFile(
    levelList,
    `file '${levelLoud.replace(/\\/g, '/')}'\nfile '${levelQuiet.replace(/\\/g, '/')}'\n`,
    'utf8'
  )
  const levelSrc = resolve(TMP, 'level-src.m4a')
  const levelMade = await runFfmpeg([
    '-hide_banner',
    '-y',
    '-f',
    'concat',
    '-safe',
    '0',
    '-i',
    levelList,
    '-c:a',
    'aac',
    '-b:a',
    '192k',
    levelSrc
  ])
  check('响度素材：两段拼成一个 m4a', levelMade.code === 0, levelMade.stderr.slice(-200))

  const gapSrc = await levelGap(levelSrc)
  check(
    '素材前提：两段的响度差足够大（下面两条判据全靠它分辨线性与动态）',
    gapSrc > 20,
    `源两段差 ${gapSrc.toFixed(1)} LU`
  )

  const loudTask = await withFilters(levelSrc, 'm4a', [{ kind: 'loudnorm', targetLufs: -14 }])
  const loudOut = outputOf(loudTask)
  check(
    '响度归一化：任务完成',
    loudTask?.status === 'done',
    `${loudTask?.status} ${loudTask?.error ?? ''}`
  )

  const loudStages = stagesOfTask(loudTask?.id)
  check(
    '响度归一化：进度里出现过「第一遍分析（响度归一化）」（两遍编排真的跑了第一遍）',
    loudStages.some((s) => s.includes('第一遍分析（响度归一化）')),
    loudStages.join(' | ') || '（无提示）'
  )

  // 进度口径：第一遍**不喂进度**（两遍是两条独立时间轴，拼成一条会让百分比在第二遍开头回跳，
  // 而解析器的单调钳制会把它压成「停在 100%」的假进度）。判据与 [18] 那节对两遍编码的口径
  // 同构：确定进度必须**全部**出现在「编码（响度归一化）」那一步之后。
  // 去掉响度第一遍那次调用的 `{ quiet: true }` 就会在这里翻红。
  const loudUpdates = patches.flatMap((p) => p.updated).filter((u) => u.id === loudTask?.id)
  const encodeStageAt = loudUpdates.findIndex(
    (u) => u.progress?.kind === 'indeterminate' && u.progress.stage.includes('编码（响度归一化）')
  )
  const percentAt = loudUpdates
    .map((u, index) => (u.progress?.kind === 'determinate' ? index : -1))
    .filter((index) => index >= 0)
  check(
    '响度归一化：确定进度**全部**出现在「编码」那一步之后（第一遍不喂进度，两遍不拼成一条线）',
    encodeStageAt >= 0 && percentAt.length > 0 && percentAt.every((index) => index > encodeStageAt),
    `编码文案下标=${encodeStageAt} 确定进度下标=${percentAt.join(',')}`
  )

  const outLoudness = loudOut === null ? Number.NaN : await loudnessOf(loudOut, 0, 4)
  check(
    '响度归一化：产物整体响度落在目标 ±2 LU 内',
    Number.isFinite(outLoudness) && Math.abs(outLoudness + 14) <= 2,
    `实测 ${Number.isFinite(outLoudness) ? outLoudness.toFixed(1) : '（读不出）'} LUFS，目标 -14`
  )

  const gapOut = loudOut === null ? Number.NaN : await levelGap(loudOut)
  check(
    '响度归一化：产物两段的响度差与源基本一致（= 整段平移一个增益，动态范围没被压扁）',
    Number.isFinite(gapOut) && Math.abs(gapOut - gapSrc) <= 3,
    `源 ${gapSrc.toFixed(1)} LU → 产物 ${gapOut.toFixed(1)} LU`
  )

  // 对照组：同样两遍的**单遍**写法（动态归一化）。它证明上面那条判据是有牙的——
  // 一个偷懒用单遍的实现会在这里露馅（实测段差从 30 LU 掉到 7 LU），而它照样
  // 满足「整体响度接近目标」那一条。
  const singlePassOut = resolve(TMP, 'level-1pass.m4a')
  const singleRun = await runFfmpeg([
    '-hide_banner',
    '-y',
    '-i',
    levelSrc,
    '-vn',
    '-af',
    'loudnorm=I=-14:TP=-1.5:LRA=11',
    '-c:a',
    'aac',
    '-b:a',
    '192k',
    singlePassOut
  ])
  const gapSingle = singleRun.code === 0 ? await levelGap(singlePassOut) : Number.NaN
  check(
    '对照：单遍（动态）归一化会把两段差压扁到远小于源（所以上面那条判据有分辨力）',
    Number.isFinite(gapSingle) && gapSingle < gapSrc - 10,
    `单遍产物 ${Number.isFinite(gapSingle) ? gapSingle.toFixed(1) : '（跑不动）'} LU vs 源 ${gapSrc.toFixed(1)} LU`
  )

  // 同一素材、同一目标跑两次：产物逐字节一致。
  // ⚠️ 这一条**不是**「线性 vs 动态」的判据（单遍动态同样是确定性的，实测两边都一致），
  // 它守的是另一件事：这条链上没有随机的、每次都要重新量一遍的环节（比如把第一遍的
  // 统计当场丢掉、第二遍再随机挑一组参数）。
  const loudAgain = await withFilters(levelSrc, 'm4a', [{ kind: 'loudnorm', targetLufs: -14 }])
  const loudAgainOut = outputOf(loudAgain)
  const firstPrint = loudOut === null ? '' : await streamFingerprint(loudOut, '0:a:0')
  const againPrint = loudAgainOut === null ? '' : await streamFingerprint(loudAgainOut, '0:a:0')
  check(
    '响度归一化是确定性的：同素材同目标跑两次，产物码流逐位相同',
    firstPrint !== '' && firstPrint === againPrint,
    `${firstPrint || '（空）'} vs ${againPrint || '（空）'}`
  )

  // ---- 源里没有音轨：结构判据（不是匹配那句报错文案）----

  const silentLoud = await withFilters(rotSrc, 'mkv', [{ kind: 'loudnorm', targetLufs: -14 }])
  check(
    '无声源 + 响度归一化：任务成功（要归一化的东西本来就不存在，不该让整条任务失败）',
    silentLoud?.status === 'done',
    `${silentLoud?.status} ${silentLoud?.error ?? ''}`
  )
  check(
    '无声源 + 响度归一化：说清了「跳过响度归一化」（不静默）',
    stagesOfTask(silentLoud?.id).some((s) => s.includes('跳过响度归一化')),
    stagesOfTask(silentLoud?.id).join(' | ') || '（无提示）'
  )

  /* ---------------------------------------------------------- [17] 清理 */

  console.log('\n[17] 清理')

  const removed = manager.clearFinished()
  check('清空已结束任务返回计数', removed > 0, String(removed))

  const leftovers = manager.list().filter((t) => t.status === 'done')
  check('已结束任务确实被移除', leftovers.length === 0)

  manager.shutdown()

  await rm(TMP, { recursive: true, force: true }).catch(() => {})
  await rm(resolve('.tmp-test-stub'), { recursive: true, force: true }).catch(() => {})

  console.log(`\n=== 通过 ${passed} / 失败 ${failed} ===`)
  process.exit(failed === 0 ? 0 : 1)
}

void main()
