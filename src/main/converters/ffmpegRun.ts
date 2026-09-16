import { spawn } from 'child_process'
import { randomUUID } from 'crypto'
import { readdir } from 'fs/promises'
import { tmpdir } from 'os'
import { basename, dirname, join } from 'path'
import { ffmpegPath } from '../engines/registry'
import {
  buildFfmpegArgs,
  buildLoudnormProbeArgs,
  buildPassOneArgs,
  buildProbeArgs,
  buildRemuxArgs,
  buildTrimCopyArgs,
  canRemux,
  defaultAudioKbps,
  isAudioTarget,
  isImageTarget,
  parseLoudnormStats,
  remuxEligible,
  supportsOutputTarget,
  STILL_DURATION_SEC,
  type Clip,
  type EncodeTarget,
  type LoudnormStats
} from '../engines/ffmpeg'
import { hardwareEncodeAvailable } from '../engines/nvenc'
import { getSettings } from '../core/settings'
import { parseProbeOutput } from '../core/probe'
import { FfmpegProgressParser } from '../core/progress'
import { partPathOf } from '../core/outputName'
import { killTree } from '../core/kill'
import { MIN_BITRATE_KBPS } from '@shared/options'
import type { FilterAction, LoudnormAction, TaskProgress } from '@shared/types'
import {
  ConversionCanceled,
  ConversionFailed,
  finalizeOutput,
  removeQuietly,
  tailLines,
  type ConvertContext
} from './common'

export { ConversionCanceled, ConversionFailed } from './common'

/** 进度上报上限：8 个任务并发时不节流会把渲染进程的 IPC 淹掉 */
const PROGRESS_THROTTLE_MS = 100

/**
 * stderr 的缓冲上限。
 *
 * 正常情况下 ffmpeg 的 stderr 几乎为空（`-nostats` 已经关掉了状态行），
 * 但遇到损坏文件时它可能吐出巨量信息，所以加个上限防止内存无节制增长。
 * 超限时丢的是**头部**——出错排查时最有用的信息在尾部。
 */
const STDERR_CAP = 256 * 1024

/**
 * 只在 stderr 的前几 KB 里找 Duration。
 *
 * 时长一定出现在 ffmpeg 打开输入时打印的 `Input #0 … Duration: …` 里，也就是 stderr 的最开头。
 * 加这个上限是为了别让一个满嘴报错的损坏文件把每个 chunk 都变成一次全量正则扫描（那是 O(n²)）。
 */
const DURATION_SCAN_LIMIT = 8 * 1024

/**
 * 探测进程 stderr 的缓冲上限。
 *
 * 流信息（`Input #0` 那几行）正常只有一两 KB，但损坏文件在 `-i` 阶段就能刷出大量报错，
 * 所以给个上限防止内存无节制增长。截断丢的是尾部，而流信息在**开头**——
 * 这正是我们要读的部分，所以截断不影响判定。
 */
const PROBE_STDERR_CAP = 64 * 1024

/**
 * 攒一个子进程的 stderr，直到它退出。
 *
 * 退出码刻意**不看**：`ffmpeg -i <file>` 不带输出文件时必定以非 0 退出，
 * 而那正是本函数的用法（见 buildProbeArgs）。流信息全在 stderr 上。
 *
 * 也不碰取消令牌——杀进程的事由调用方那**唯一一个**监听器统一管（见 runFfmpeg 里的说明）。
 */
function collectStderr(child: ReturnType<typeof spawn>): Promise<string> {
  return new Promise((done) => {
    let text = ''
    // 逐块 `.toString('utf8')` 会把跨管道边界（64 KiB）的多字节序列拆成两个替换符，
    // 而这里的 stderr 里有**用户的中文路径**（`Input #0, from 'D:\我的 视频\a.mp4'`、
    // 打不开文件时那一屏报错）。setEncoding 走 Node 的 StringDecoder，跨块残字节缓存到
    // 下一块；chunk 随之变成 string，而 `.length` 本来就是按字符串算的，语义不变。
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      if (text.length >= PROBE_STDERR_CAP) return
      text += chunk
    })
    child.on('error', () => done(''))
    child.on('close', () => done(text))
  })
}

/**
 * 删掉两遍编码留下的统计文件。
 *
 * 按**前缀**扫目录而不是写死 `-0.log` 两个名字：不同编码器产出的后缀不一样
 * （libx264 只有 `-0.log`，libvpx 还会多一个 `-0.log.mbtree`），写死的话换一个编码器
 * 就会在系统临时目录里一直堆着，而且没人会想到去那里找。
 *
 * 删失败不报错（`removeQuietly`）：统计文件是**我们自己造出来的垃圾**，
 * 它删不掉不该让一次成功的转换变成失败。
 */
async function cleanupPassLog(prefix: string): Promise<void> {
  const dir = dirname(prefix)
  const base = basename(prefix)
  const names = await readdir(dir).catch(() => [] as string[])
  for (const name of names) {
    if (name.startsWith(base)) await removeQuietly(join(dir, name))
  }
}

/**
 * 跑一次 ffmpeg 转换。
 *
 * 产物先写 `<name>.part.<ext>`，成功后才 rename 成正式文件名——这样中途取消或崩溃时，
 * 输出目录里不会留下一个看起来正常、实际半截的坏文件。
 *
 * 时长**不**单独探测，直接从转换进程自己的 stderr 里读，见 tryAdoptDuration。
 * 但**编解码器**必须事前探一次：remux 与否要在起转换进程之前定下来（见下面的决策块）。
 * 而**有输出体积目标时**时长也必须在事前拿到（目标字节要除以它才是码率），
 * 那种情况下会复用同一个 `probeStderr()`，不额外起进程。
 */
export async function runFfmpeg(options: ConvertContext): Promise<void> {
  const {
    input,
    output,
    fromExt,
    toExt,
    cancel,
    onProgress,
    remux: remuxMode = 'auto',
    options: taskOptions
  } = options

  const trim = taskOptions?.trim

  /**
   * 输出约束（体积 / 码率）。**二选一由 schema 裁决**（`outputSchema` 的 `.refine`），
   * 引擎这一层不再判——它只管把给定那一项翻成参数。
   */
  const outputTarget = taskOptions?.output

  /**
   * 处理链（有序）。哪一类任务装得下哪一步由 `@shared/options.ts` 的 `canUseAction`
   * 裁决（`TaskManager.setOptions` 用的是同一份函数），所以到这里一定是合法的。
   *
   * ⚠️ **有链就必须让两条 `-c copy` 快车道都失效**：重封装搬的是**原始码流**，
   * 而链上的每一步改的都是像素（或音轨）——装不进去。这一条在 `filters` 只对图片
   * 开放时是隐含成立的（图片不走 remux），一旦对视频开放就变成真的承重
   * （`docs/RESEARCH.md` §4.1：「带滤镜必须让 `remuxEligible()` 失效」）。
   */
  const filters: readonly FilterAction[] = taskOptions?.filters ?? []
  const hasFilters = filters.length > 0
  /** 链上的响度归一化（若有）。两遍编排整块都围着它转，见下面那段。 */
  const loudnormAction: LoudnormAction | null =
    filters.find((action): action is LoudnormAction => action.kind === 'loudnorm') ?? null

  // 一次裁剪在**参数层**的形状。`end − start` 在这里算**唯一一次**：`-t` 要的是时长、
  // 进度分母要的也是时长，两处各算一遍的分叉表现是「进度条跑满时产物还剩一截」
  // （或者反过来），而那种偏差没人会归因到这一行。
  const clip: Clip | undefined = trim
    ? { start: trim.start, duration: trim.end - trim.start }
    : undefined

  const executable = ffmpegPath()
  const tempPath = partPathOf(output)

  let lastEmit = 0
  const emit = (progress: TaskProgress, force = false): void => {
    const now = Date.now()
    if (!force && now - lastEmit < PROGRESS_THROTTLE_MS) return
    lastEmit = now
    onProgress(progress)
  }

  // 时长还没到手，百分比无从谈起，先给不确定进度。图片、无时长信息的流会一直停在这里。
  onProgress({ kind: 'indeterminate', stage: '转换中…' })

  let parser: FfmpegProgressParser | null = null
  /** 时长到手之前 stdout 上的进度记录先攒着，拿到解析器后一次性喂进去，一条都不丢 */
  let pendingStdout = ''
  let stderrText = ''

  const pushStdout = (text: string): void => {
    if (!parser) {
      pendingStdout += text
      return
    }
    const update = parser.push(text)
    if (!update) return
    emit({
      kind: 'determinate',
      percent: update.percent,
      etaSec: update.etaSec,
      speed: update.speed
    })
  }

  /**
   * 从转换进程的 stderr 里捡时长。
   *
   * 以前是先用 `ffmpeg -i` 单独探一次时长、再开转换进程——同一个任务两次进程启动。
   * 实测（scripts 里的实测脚本）：裸启动一次 ffmpeg 约 25ms，探测约 30ms，而转换本身才 48ms，
   * **光探测就占了 38% 的墙钟时间**，批量转小文件时这笔账尤其难看。
   *
   * 而 ffmpeg 打开输入时本来就会把 `Input #0 … Duration: …` 打到 stderr 上，白拿。
   * 解析复用 probe.ts 的 parseProbeOutput——它的正则和边界（`Duration: N/A` 归一为 null）
   * 早就有测试盯着，没必要在这儿再写一份。
   */
  const tryAdoptDuration = (): void => {
    if (parser) return
    const info = parseProbeOutput(stderrText)
    if (!info.durationSec) return

    // 进度分母：带裁剪时是**裁剪时长**，不是源时长。
    //
    // stderr 里那段 `Duration:` 报的是**源文件**的长度（10 分钟），而裁剪任务的
    // `out_time` 只从 0 走到裁剪时长（几秒）——用源时长当分母的话，进度条会
    // 爬到 3% 就跳到 100%，看着像「卡住了，然后突然完成」。分母与 `-t` 用的是同一个
    // `clip.duration`，所以「进度条跑满」与「产物写完」是同一件事。
    //
    // 无损模式会稍微超前一点（内容比 `end - start` 长，多出一段头），
    // 而解析器本来就 `Math.min(1, …)` 并把百分比钉成单调不减，不会回跳。
    const total = clip ? clip.duration : info.durationSec
    parser = new FfmpegProgressParser(total)
    emit({ kind: 'determinate', percent: 0 }, true)

    const buffered = pendingStdout
    pendingStdout = ''
    if (buffered) pushStdout(buffered)
  }

  /**
   * 当前在跑的子进程——探测与转换**共用这一个槽位**。
   *
   * 取消监听器只能注册一次：CancelToken 的监听器只增不减（要等 cancel() 才清空），
   * 若探测和转换各注册一次，取消时两个回调都会跑，而那时探测进程早已退出、
   * 它的 pid 很可能已被系统分配给了别的进程——`taskkill /T /F` 就会杀掉一个无关进程。
   * 只留一个回调、让它去读「现在该杀谁」，就没有这个问题。
   */
  let child: ReturnType<typeof spawn> | null = null
  cancel.onCancel(() => {
    if (child?.pid) void killTree(child.pid)
  })

  // ---- 裁剪与 remux 快车道**互斥**：这一条要排在所有探测之前 ----
  //
  // 两者不是同一个问题的两个答案，共用一份容器白名单而已——完整的辨析见
  // `engines/ffmpeg.ts` 的 `buildTrimCopyArgs`。这里只说结论：
  // **带裁剪时 remux 那个布尔恒为 false**，裁剪自己决定用不用 `-c copy`。
  //
  // `force` 与裁剪同时出现是**调用方自相矛盾**：force 的语义是「整段码流一位都不许动」，
  // 而裁剪要的是其中一段——它满足不了 force，而按 force 办（不裁）又不是用户要的。
  // 报错比沉默地二选一都好，因为两种沉默都会产出一个「不报错的错误答案」。
  if (clip && remuxMode === 'force') {
    throw new ConversionFailed([
      '裁剪与「必须重封装」不能同时要求：前者只要其中一段，后者要整段码流一位都不动',
      '去掉 remux=force；或改用精确模式，它本来就重新编码，与 force 无关'
    ])
  }

  // ---- 处理链与两条 `-c copy` 快车道**互斥** ----
  //
  // 同一类「调用方自相矛盾」，判据也一样：**报错，不静默二选一**。
  //
  // `-c copy` 搬的是**原始码流**，而处理链改的就是像素（视频动作）或音轨（loudnorm）——
  // 物理上装不进去。两种沉默都是「不报错的错误答案」：
  //   - 静默按 `-c copy` 办 → 用户填的滤镜一个都没生效，产物与源一模一样；
  //   - 静默改走重编码 → 既违背 `remux=force` 的承诺（要的就是「别动我的码流」），
  //     也违背「无损裁剪一个字节都不重编」那句对用户的承诺。
  //
  // ⚠️ 这一条在 `filters` 只对图片开放时是**隐含成立**的（图片源根本走不到这两条快车道），
  // 对视频开放之后它才变成真的承重——`docs/RESEARCH.md` §4.1 把「带滤镜必须让
  // `remuxEligible()` 失效」列为最容易漏的一处。
  if (hasFilters && clip && trim && trim.mode === 'lossless') {
    throw new ConversionFailed([
      '处理链与无损裁剪不能同时要求：无损裁剪一个字节都不重编，而处理链改的就是像素',
      '把裁剪改成精确模式（它本来就重新编码，两者可以一起用）；或去掉处理链'
    ])
  }
  if (hasFilters && remuxMode === 'force') {
    throw new ConversionFailed([
      '处理链与「必须重封装」不能同时要求：重封装搬的是原始码流，装不下改过像素的东西',
      '去掉 remux=force；或去掉处理链'
    ])
  }

  // ---- 输出约束（体积 / 码率）与两条 `-c copy` 快车道**互斥** ----
  //
  // 这是同一类「调用方自相矛盾」，判据也一样：**报错，不静默二选一**。
  // remux 与无损裁剪都是 `-c copy`，一个字节都不编——**物理上改不了产物体积**。
  // 静默按 `-c copy` 办的表现是「用户填了 5 MB，拿到 90 MB，任务报成功」；
  // 静默改走重编码则违背了 `remux=force` 的承诺（它要的就是「别动我的码流」）。
  //
  // 无损裁剪 + `output` 还有一层：体积目标要除以**时长**，而裁剪要的是其中一段，
  // 两者对「产物是什么」的描述本来就不一致。要裁又要压，唯一的自洽组合是精确模式。
  if (outputTarget && remuxMode === 'force') {
    throw new ConversionFailed([
      '输出体积/码率目标与「必须重封装」不能同时要求：重封装一个字节都不编，改不了产物体积',
      '去掉 remux=force；或去掉输出目标'
    ])
  }
  if (outputTarget && clip && trim && trim.mode === 'lossless') {
    throw new ConversionFailed([
      '输出体积/码率目标与无损裁剪不能同时要求：无损裁剪一个字节都不重编，改不了产物体积',
      '去掉输出目标；或改用精确模式（它本来就重新编码，两者可以一起用）'
    ])
  }

  // ---- remux 决策：必须在启动转换进程**之前**做完 ----
  //
  // 编解码器只能起个进程问 ffmpeg 才知道，所以这里单独探一次。这笔开销在「必然重编码」的
  // 场景下是纯亏（约束 5 算过：约 30ms，占小文件转换墙钟的 38%），但一旦存在 remux 的可能，
  // 它就从开销变成了决策成本——实测 1080p/20s 的 h264 源：remux 86ms，重编码 1616ms。
  // 所以只在 remuxEligible() 放行的方向上付这笔钱；图片与 gif 一律不探。
  //
  // `remuxMode` 是调用方（MCP 的 convert_file）显式指定的策略，省略即 'auto'——
  // 那时整段行为与加这个参数之前**逐字一致**。两处 force 的失败是刻意的：
  // 把「做不到」从**静默降级**改成了**报错**，因为在 agent 那一侧静默降级看起来是成功，
  // 代价是画质与几倍的时间，而它没有任何办法察觉。
  if (remuxMode === 'force' && !remuxEligible(fromExt, toExt)) {
    throw new ConversionFailed([
      `.${fromExt} → .${toExt} 这个方向不支持直接重封装（不在容器白名单里）`,
      '改用 mode=auto 让引擎自己决定，或 mode=reencode 明确要求重新编码'
    ])
  }

  /**
   * 起一个探测进程，回它 stderr 上的全文（**起不来时回 `null`**）。
   *
   * 抽成函数是因为现在有**两个**判定要问同一件事：remux 能不能做、以及无损裁剪能不能做。
   * 两处各写一遍 `spawn` 的话，`child` 那个取消槽位、`cancel.canceled` 的确认、
   * 以及「探测起不来就放它过去」的兜底都会各有一份（见下面 `child` 的注释）。
   *
   * 带缓存：两个判定其实是互斥的（remux 那条要求 `clip === undefined`），
   * 所以正常路径上只会真起一次；缓存是为了让「多问一次」在将来也不会变成多一个进程。
   * 回的是**原始 stderr** 而不是解析好的 `MediaInfo`——解析只有一处调用点，
   * 把它留在这里会让 `parseProbeOutput` 的边界（正则、`Duration: N/A` 归一）再多一层包装。
   */
  let probedStderr: string | null | undefined
  const probeStderr = async (): Promise<string | null> => {
    if (probedStderr !== undefined) return probedStderr
    probedStderr = null

    let probe: ReturnType<typeof spawn> | null = null
    try {
      probe = spawn(executable, buildProbeArgs(input), {
        windowsHide: true,
        // stdout 直接丢弃：探测不产出，也不该因为它没被读取而反压住子进程
        stdio: ['ignore', 'ignore', 'pipe']
      })
    } catch {
      // 探测起不来就先当作「问不出结果」，让后面真正的转换进程去报错——
      // 否则这里会把一个本该由转换过程给出的错误信息吞掉
      return probedStderr
    }

    child = probe
    probedStderr = await collectStderr(probe)
    child = null

    if (cancel.canceled) throw new ConversionCanceled()
    return probedStderr
  }

  // 带裁剪、**带处理链**、或**带输出约束**时整个跳过 remux 快车道（理由见上面那两段互斥说明）。
  //
  // ⚠️ `hasFilters` 这一条是**承重**的：少了它，一条「mkv(h264) → mp4 + 去隔行」的任务会走
  // `-c copy`，把源码流原样搬过去——滤镜一个都没生效、不报任何错，而任务报成功。
  let remux = false
  if (
    clip === undefined &&
    !hasFilters &&
    outputTarget === undefined &&
    remuxMode !== 'off' &&
    remuxEligible(fromExt, toExt)
  ) {
    const probeErr = await probeStderr()
    if (probeErr !== null) {
      remux = canRemux(toExt, parseProbeOutput(probeErr))
      if (remuxMode === 'force' && !remux) {
        throw new ConversionFailed([
          '源里的编解码器装不进目标容器，无法直接重封装（`-c copy` 会失败）',
          '改用 mode=auto 让引擎自动回退到重新编码'
        ])
      }
    }
  }

  // ---- 无损裁剪：能不能原样搬走，用的是**同一张容器白名单** ----
  //
  // 判据与 remux 逐字相同（`canRemux`），但**失败方式相反**：remux 做不到就静默重编码，
  // 那只是慢一点；裁剪做不到却静默重编码，用户拿到的是**画质变了的产物**，
  // 而他要的是「不动我的码流」。所以这里报错，并在错误里给出明确的下一步。
  //
  // 探测是必须付的钱：`-c copy` 能不能进目标容器只有编解码器知道，
  // 而用户是**显式**选了无损——不给个准话就只剩「猜」。
  let trimCopy = false
  if (clip && trim && trim.mode === 'lossless') {
    if (!remuxEligible(fromExt, toExt)) {
      throw new ConversionFailed([
        `.${fromExt} → .${toExt} 这个方向不可能无损裁剪（不在容器白名单里）`,
        '改用精确模式：它会重新编码，任何方向都能裁'
      ])
    }

    const probeErr = await probeStderr()
    if (probeErr === null || !canRemux(toExt, parseProbeOutput(probeErr))) {
      throw new ConversionFailed([
        '源里的编解码器装不进目标容器，无损裁剪（`-c copy`）会失败',
        '改用精确模式：它会重新编码，任何方向都能裁'
      ])
    }

    trimCopy = true
  }

  // ---- 输出约束：把「目标体积 / 目标码率」翻成编码参数 ----
  //
  // 这一步**必须在启动转换进程之前**做完，而且必须**事前**拿到时长：
  //   码率 = 目标字节 × 8 ÷ 时长秒，再减去音轨那一份。
  // 时长本来是从转换进程自己的 stderr 里捡的（`tryAdoptDuration`），那对两遍编码太晚了
  // ——第一遍就需要码率。所以这里复用旁边的 `probeStderr()`（**已带缓存、已接好取消槽位**），
  // 不另起一个 spawn。约束 5 那句「不单独探测」讲的是「必然重编码且没有体积目标」的场景。
  //
  // `targetBytes` 只能两遍 ABR，`-fs` 不行（实测：目标 300 KB 产出 534 KB **且视频被截断在
  // 2.03 秒**——它是「写到这么多就停」，不是「压到这么多」）；`bitrateKbps` 是用户直接给的
  // 码率，单遍即可。
  let encode: EncodeTarget | undefined
  /** 非 null 即表示这次要走两遍——它同时是 `-passlogfile` 的前缀 */
  let passLogPrefix: string | null = null

  if (outputTarget) {
    if (!supportsOutputTarget(toExt)) {
      throw new ConversionFailed([
        `.${toExt} 没有码率旋钮，兑现不了体积 / 码率目标（gif 走调色板滤镜，图片出口是质量模式，wav/flac 是无损）`,
        // ⚠️ 这一句是**卡片上真正显示的那一行**（`core/task.ts` 的 summarize 取最后一条有内容的），
        // 所以「下一步怎么办」必须写在这里，第一行只是解释。
        '去掉输出目标，或换一个能设码率的出口（视频容器 / mp3、m4a、ogg、opus）'
      ])
    }

    const probeErr = await probeStderr()
    const info = probeErr === null ? null : parseProbeOutput(probeErr)
    const hasAudio = info?.audioCodec != null

    if (outputTarget.bitrateKbps !== undefined) {
      encode = isAudioTarget(toExt)
        ? { audioKbps: outputTarget.bitrateKbps }
        : { videoKbps: outputTarget.bitrateKbps }
    } else {
      const bytes = outputTarget.targetBytes as number
      // 时长的三个来源，按「用户真正会拿到多长」取：裁剪取裁剪时长、图片源取补的那段静止画面、
      // 其余取源自己的时长。用源时长去算裁剪任务的码率会让目标体积整体偏小（分母是错的）。
      const durationSec = clip
        ? clip.duration
        : isImageTarget(fromExt)
          ? STILL_DURATION_SEC
          : (info?.durationSec ?? null)

      if (durationSec === null || durationSec <= 0) {
        throw new ConversionFailed([
          '读不出源文件的时长，无法由目标体积反推码率',
          '改用「目标码率」：它不需要时长；或换一个时长信息完整的源文件'
        ])
      }

      const totalKbps = (bytes * 8) / durationSec / 1000
      if (isAudioTarget(toExt)) {
        if (totalKbps < MIN_BITRATE_KBPS) {
          throw new ConversionFailed([
            `目标体积太小：${durationSec.toFixed(1)} 秒的素材按它算出来只有 ${totalKbps.toFixed(1)} kbps，`,
            `低于 ${MIN_BITRATE_KBPS} kbps 这个下限。把目标体积调大，或改用「目标码率」`
          ])
        }
        encode = { audioKbps: totalKbps }
      } else {
        // 音轨那一份是从总预算里**先扣掉**的（见 defaultAudioKbps 的警告：这是标称值，
        // 实测 aac 编正弦远低于标称，于是产物偏小而不是超标——这个方向是安全的）。
        const audioKbps = hasAudio ? defaultAudioKbps(toExt) : 0
        const videoKbps = totalKbps - audioKbps
        if (videoKbps < MIN_BITRATE_KBPS) {
          throw new ConversionFailed([
            `目标体积太小：${durationSec.toFixed(1)} 秒的素材按它算出来一共只有 ${totalKbps.toFixed(1)} kbps，`,
            `扣掉音轨（${audioKbps} kbps）后不够编一条视频轨。把目标体积调大，或改用「目标码率」`
          ])
        }
        encode = { videoKbps, audioKbps: hasAudio ? audioKbps : undefined }
        // 唯一名 + 系统临时目录：不指定的话 ffmpeg 会把统计文件写在**当前工作目录**，
        // 两条并发任务互相覆盖，症状是产物码率完全不对而任务报成功。
        passLogPrefix = join(tmpdir(), `arbiter-2pass-${process.pid}-${randomUUID()}`)
      }
    }
  }

  // ---- GPU 决策：也要在启动转换进程**之前**做完 ----
  //
  // remux 是 `-c copy`，一个字节都不编，所以那条路上根本谈不上用哪个编码器。
  // 无损裁剪同理：它也是 `-c copy`，去探一张卡只会白花 200ms。
  // 而「这个方向能不能 remux」上面已经定了，这里只用 `remux` 这一个变量。
  //
  // ⚠️ **有输出约束时不探显卡**：那套参数是 ABR（`-b:v`），而 NVENC 走的是 CQ 模式
  // （`-cq`），两者互斥——`-cq` 与 `-b:v` 同时出现时码率目标形同虚设，产出一个不达标的
  // 体积而任务报成功。这里**明确退回 CPU 并说出来**，不静默。
  //
  // 探测本身有缓存（见 engines/nvenc.ts），一个进程只真起一次子进程。
  let useHardware = false
  /**
   * 「有输出目标时明确退回 CPU」那句话，两条路共用同一份文案。
   *
   * ⚠️ **两遍编码那条路必须把它并进「第一遍」那条提示里**：两条 `emit` 之间一个 `await`
   * 都没有，它们会落进同一批 patch、合并时后一条胜出——单独发出去的那条用户根本看不见，
   * 而它防的正是「静默换了一条路」。所以下面两处都要出现（单遍时用独立那条，
   * 两遍时并进第一遍，用户在整个第一遍里都能看到它）。
   */
  const abrCpuNote = '输出目标走 ABR，与显卡编码的 CQ 模式互斥：本次用 CPU 编码'

  if (!remux && !trimCopy && encode === undefined && getSettings().hardwareEncode) {
    useHardware = await hardwareEncodeAvailable()
    // 让用户看得见「你开了 GPU，但这次没用上」——静默走 CPU 与静默降质同类，
    // 而这条恰恰是用户显式选过的东西，更要说清楚。
    if (!useHardware) {
      emit({ kind: 'indeterminate', stage: '未找到可用显卡，本次用 CPU 编码' }, true)
    }
  } else if (encode !== undefined && getSettings().hardwareEncode) {
    emit({ kind: 'indeterminate', stage: abrCpuNote }, true)
  }

  /**
   * 真正交给 `-vf` / `-af` 的动作。
   *
   * 与 `filters` 只差一处：**源里没有音轨时 loudnorm 会被摘掉**（见下面响度那一段）。
   * 用 `let` 是因为那件事发生在探测之后，而 `argsFor` 是个闭包——它每次调用时读的都是
   * 这个绑定当下的值，所以摘掉之后重建的参数里就没有 `-af` 了。
   */
  let activeFilters: readonly FilterAction[] = filters

  /**
   * 响度归一化的实测统计（第一遍的产物）。非 null 时链上的 `loudnorm` 才走**线性**归一化。
   * 同样必须在 `argsFor` 之前声明，理由同上。
   */
  let loudnormStats: LoudnormStats | null = null

  const argsFor = (hardware: boolean): string[] => {
    // 第二遍才带 `-pass 2`；第一遍由 `buildPassOneArgs` 单独组装（它没有输出文件）
    const target: EncodeTarget | undefined = encode && {
      ...encode,
      pass: passLogPrefix ? 2 : undefined,
      passLogFile: passLogPrefix ?? undefined
    }
    if (clip) {
      return trimCopy
        ? buildTrimCopyArgs(input, tempPath, toExt, clip)
        : buildFfmpegArgs(input, tempPath, fromExt, toExt, {
            hardware,
            trim: clip,
            target,
            filters: activeFilters,
            loudnorm: loudnormStats
          })
    }
    return remux
      ? buildRemuxArgs(input, tempPath, toExt)
      : buildFfmpegArgs(input, tempPath, fromExt, toExt, {
          hardware,
          target,
          filters: activeFilters,
          loudnorm: loudnormStats
        })
  }

  /**
   * 跑一次 ffmpeg。
   *
   * 每次调用都从**干净的状态**开始（进度解析器、攒着的 stdout、stderr）——
   * 回退那一次若接着 GPU 那次的半截状态往下算，百分比会从中间某个数跳一下，
   * 而两次之间还夹着一次从头开始的解码。
   */
  const attempt = async (
    args: string[],
    /** `quiet: true` = 这一次**不喂进度**（两遍编码的第一遍），见下面的口径说明 */
    { quiet = false }: { quiet?: boolean } = {}
  ): Promise<{ code: number | null; stderr: string }> => {
    parser = null
    pendingStdout = ''
    stderrText = ''

    const code = await new Promise<number | null>((done) => {
      let proc: ReturnType<typeof spawn>
      try {
        proc = spawn(executable, args, { windowsHide: true })
      } catch {
        done(-1)
        return
      }
      child = proc

      // ⚠️ **两个流都要 setEncoding，`chunk` 因此变成 `string`。**
      //
      // 逐块 `.toString('utf8')` 是对每个 chunk 独立解码，跨管道边界（64 KiB）的多字节
      // 序列会被拆成两个替换符。而这两条流的内容都会给用户看：stderr 是报错原文与
      // **用户的中文路径**（`D:\我的 视频\a.mp4: Invalid data found`，出错时
      // `tailLines(stderr)` 原样进卡片），stdout 是 `-progress pipe:1` 的记录。
      //
      // 逐处核对过、语义**不变**的两点：
      //   - `stderrText.length` 与那两道上限本来就是按**字符串长度**算的（它一直是个
      //     string），不是字节数，所以 `DURATION_SCAN_LIMIT` 那 8 KB 的扫描闸门、
      //     以及 `STDERR_CAP` 的截断位置，口径都与改之前逐字相同；
      //   - `-progress` 的记录全是 ASCII（`out_time=00:00:01.234000`），
      //     `pushStdout` 收到的仍是同样的一段文本。
      proc.stdout?.setEncoding('utf8')
      proc.stderr?.setEncoding('utf8')

      proc.stdout?.on('data', (chunk: string) => {
        if (quiet) return
        pushStdout(chunk)
      })

      proc.stderr?.on('data', (chunk: string) => {
        stderrText += chunk
        if (stderrText.length > STDERR_CAP) stderrText = stderrText.slice(-STDERR_CAP / 2)
        if (quiet) return
        // 时长在 stderr 开头；拿到解析器之后就不用再扫了
        if (!parser && stderrText.length <= DURATION_SCAN_LIMIT) tryAdoptDuration()
      })

      proc.on('error', () => done(-1))
      proc.on('close', (code) => done(code))
    })

    return { code, stderr: stderrText }
  }

  /** 两遍编码留下的统计文件必须删掉——**无论成功、失败还是取消** */
  try {
    // ---- 第一遍（只有体积目标才走这条）----
    //
    // **进度口径：两遍只喂第二遍。** 第一遍全程是「不确定进度」，第二遍才是 0→1 的确定进度。
    //
    // 为什么不把两遍拼起来算：两遍各自都是从 0 走到 1 的**独立时间轴**（第二遍还要重新
    // 解码一遍），拼成一条线只能靠「各算半程」那种编造的分母——而第一遍跑到 50% 与
    // 「整个任务完成一半」根本不是同一件事。拼起来的直接后果是百分比在第二遍开头回跳
    // （100% → 0%），而解析器的单调钳制又会把它压成一个「永远停在 100%」的假进度。
    // 所以：第一遍说清楚「在分析」，第二遍的百分比就是**真正要计时的那一遍**。
    // ---- 响度归一化的第一遍：只分析，把 measured_* 拿回来给第二遍做线性归一化 ----
    //
    // 单遍的 loudnorm 是**动态**归一化：它按帧调增益，安静段被提上来，动态范围被压扁
    // （同一素材实测：两遍线性 30.5 LU 的两段差，单遍动态只剩 6.9 LU）。而用户要的是
    // 「整段平移一个增益」，所以走两遍：第一遍 `-f null` 把统计打到 stderr，解析出来
    // 喂给第二遍的 `measured_*` + `linear=true`。
    //
    // 进度口径与两遍编码**逐字相同**：第一遍不喂进度（它是另一条独立时间轴，两遍拼成
    // 一条线会让百分比在第二遍开头回跳），第二遍才是那条 0→1 的线。见 `attempt` 的 quiet。
    if (loudnormAction !== null) {
      // 先判「源里到底有没有音轨」——**结构判据，不是匹配那句报错文案**（约束 23 第 4 条）。
      // 没有音轨时第一遍会以「一条输出流都不剩」失败（实测 rc 非 0），而那种失败不该把
      // 整条任务打成错误：用户要归一化的东西本来就不存在。
      const probeErr = await probeStderr()
      const info = probeErr === null ? null : parseProbeOutput(probeErr)

      if (info !== null && info.audioCodec === null) {
        emit({ kind: 'indeterminate', stage: '源里没有音轨，跳过响度归一化' }, true)
        activeFilters = filters.filter((action) => action.kind !== 'loudnorm')
      } else {
        emit({ kind: 'indeterminate', stage: '第一遍分析（响度归一化）' }, true)
        const pass = await attempt(buildLoudnormProbeArgs(input, loudnormAction, clip), {
          quiet: true
        })
        if (cancel.canceled) {
          await removeQuietly(tempPath)
          throw new ConversionCanceled()
        }
        if (pass.code !== 0) {
          await removeQuietly(tempPath)
          throw new ConversionFailed([
            '响度归一化的第一遍（分析）就失败了：',
            ...tailLines(pass.stderr)
          ])
        }
        loudnormStats = parseLoudnormStats(pass.stderr)
        // ⚠️ 只有一条 emit：读不出统计时的提示必须并进这一条里。两条 emit 之间一个 await
        // 都没有，它们会落进同一批 patch、合并时后一条胜出——单独发出去的那条用户看不见，
        // 而它防的正是「静默降级成单遍」。
        emit(
          {
            kind: 'indeterminate',
            stage:
              loudnormStats === null
                ? '读不出响度统计，本步按单遍处理 · 编码中'
                : '编码（响度归一化）'
          },
          true
        )
      }
    }

    if (passLogPrefix !== null && encode?.videoKbps !== undefined) {
      emit(
        {
          kind: 'indeterminate',
          stage: getSettings().hardwareEncode
            ? `${abrCpuNote} · 第一遍分析（两遍编码）`
            : '第一遍分析（两遍编码）'
        },
        true
      )
      const pass1 = await attempt(
        buildPassOneArgs(input, toExt, {
          videoKbps: encode.videoKbps,
          passLogFile: passLogPrefix,
          trim: clip,
          // 第一遍与第二遍的**视频链必须一模一样**：统计文件记的是「这帧该分多少比特」，
          // 而滤镜恰恰改变了每帧复杂度。两边不一致时分配出来的比特是错位的。
          filters: activeFilters
        }),
        { quiet: true }
      )

      if (cancel.canceled) {
        await removeQuietly(tempPath)
        throw new ConversionCanceled()
      }
      if (pass1.code !== 0) {
        await removeQuietly(tempPath)
        throw new ConversionFailed([
          '两遍编码的第一遍（分析）就失败了：',
          ...tailLines(pass1.stderr)
        ])
      }
      emit({ kind: 'indeterminate', stage: '第二遍编码（两遍编码）' }, true)
    }

    let result = await attempt(argsFor(useHardware))

    // ---- 自动回退 ----
    //
    // 走到这里说明探测说「有卡」，但**探测成功不保证每次都成功**：消费级驱动对
    // NVENC 并发 session 有上限（本机实测 8 路没问题，但别的机器历史上是 2~5 路），
    // 一批任务同时在跑时后面的会打不开编码器。显存不够、分辨率或像素格式不被支持同理。
    //
    // 回退**不是降级**：用户要的是「把这个文件转出来」，`-cq 30` 那套参数本来就与
    // CPU 那套体积相当（见 engines/ffmpeg.ts 的实测注释），所以回退后的产物正是
    // 不开这个开关时会得到的那个。唯一的代价是慢——而失败重来一遍比报错强。
    let hardwareNote: string[] = []
    if (result.code !== 0 && useHardware && !cancel.canceled) {
      emit({ kind: 'indeterminate', stage: '显卡编码失败，改用 CPU 重试' }, true)
      hardwareNote = tailLines(result.stderr)
      useHardware = false
      result = await attempt(argsFor(false))
    }

    if (cancel.canceled) {
      await removeQuietly(tempPath)
      throw new ConversionCanceled()
    }

    if (result.code !== 0) {
      await removeQuietly(tempPath)
      throw new ConversionFailed(
        // 两次都失败时把 GPU 那次的原因也带上：用户开了硬件编码，只看到 CPU
        // 那次的报错会以为开关没生效，而真正的原因（比如驱动太旧）被吞掉了。
        hardwareNote
          ? [
              'GPU 编码失败：',
              ...hardwareNote,
              '',
              '改用 CPU 后仍然失败：',
              ...tailLines(result.stderr)
            ]
          : tailLines(result.stderr)
      )
    }

    await finalizeOutput(tempPath, output)
    emit({ kind: 'determinate', percent: 1 }, true)
  } finally {
    if (passLogPrefix !== null) await cleanupPassLog(passLogPrefix)
  }
}
