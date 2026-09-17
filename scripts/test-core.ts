/**
 * 核心逻辑的自测脚本（不依赖 Electron，直接跑）。
 *
 *   npx tsx scripts/test-core.ts
 *
 * 覆盖几块最容易写错、又最难从 UI 上观察的纯逻辑：
 * 文件名净化、ffmpeg stderr 里的时长解析、`-progress` 记录边界解析，
 * 外加三处「静默出错」的重灾区——能力矩阵的类别视图（shared/formats.ts）、
 * 图标素材的 symbol id 映射（renderer/src/lib/icons.ts）、以及 IPC 契约里
 * 那个被 zod 4 改了语义的 `defaultTargets`（shared/ipc-contract.ts）。
 *
 * 后三块都靠**相对路径** import：`npm run test:core` 没带 `--tsconfig`，
 * `@shared/*` 那个别名在默认的 tsconfig.json（只有一个 references 列表）里不存在，
 * 用别名会直接 Cannot find module。这也是唯一一处 test-core 与别的测试脚本不同之处。
 */
import { spawn } from 'child_process'
import { existsSync, readdirSync, readFileSync } from 'fs'
import { mkdir, rm, stat, writeFile } from 'fs/promises'
import { resolve } from 'path'
import { FfmpegProgressParser } from '../src/main/core/progress'
import { sanitizeBaseName, resolveOutputPath } from '../src/main/core/outputName'
import { parseProbeOutput } from '../src/main/core/probe'
import { isRecipeEmpty, parseRecipe } from '../src/shared/recipe'
import { CATEGORIES, type Category } from '../src/shared/types'
import {
  categoryOf,
  defaultTargetFor,
  engineFor,
  resolveDefaultTarget,
  sourceExtsByCategory,
  targetsFor,
  targetsForCategory
} from '../src/shared/formats'
import { EngineWatchdog } from '../src/main/converters/common'
import {
  filterActionSchema,
  outputSchema,
  qualitySchema,
  resizeActionSchema,
  settingsPatchSchema,
  settingsSchema,
  setOptionsSchema,
  trimSchema
} from '../src/shared/ipc-contract'
import { buildFfmpegArgs, buildTrimCopyArgs } from '../src/main/engines/ffmpeg'
import { canTrim, describeTrim, MAX_TRIM_SEC } from '../src/shared/trim'
import {
  canFilter,
  canOutputSize,
  canUseAction,
  canUseQuality,
  describeAction,
  describeFilters,
  describeOptions,
  describeQuality,
  DEFAULT_CRF,
  DEFAULT_PRESET,
  hasAnyOptions,
  MAX_BITRATE_KBPS,
  MAX_CRF,
  MAX_FILTER_ACTIONS,
  MAX_IMAGE_DIM,
  MAX_TARGET_BYTES,
  MIN_CRF,
  supportsQuality,
  withOption
} from '../src/shared/options'
import {
  ENCODE_PRESETS,
  ENCODE_TUNES,
  IMAGE_FITS,
  TRIM_MODES,
  type FilterAction,
  type QualityOptions
} from '../src/shared/types'
import { spriteIdFor, tileForExt, TILE_EXTS } from '../src/renderer/src/lib/icons'

const FFMPEG = resolve('node_modules/ffmpeg-static/ffmpeg.exe')
const TMP = resolve('.tmp-test')
const ICONS_DIR = resolve('src/renderer/src/assets/icons')
const ICONS_MODULE = resolve('src/renderer/src/lib/icons.ts')

let passed = 0
let failed = 0

function check(label: string, ok: boolean, detail?: string): void {
  if (ok) {
    passed += 1
    console.log(`  \u2713 ${label}`)
  } else {
    failed += 1
    console.log(`  \u2717 ${label}${detail ? `  \u2190 ${detail}` : ''}`)
  }
}

function run(args: string[]): Promise<{ code: number; stderr: string }> {
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

// ---------------------------------------------------------------- 文件名净化

function testSanitize(): void {
  console.log('\n[1] 文件名净化')

  check('去除非法字符', sanitizeBaseName('a<b>c:d"e/f\\g|h?i*j') === 'a_b_c_d_e_f_g_h_i_j')
  check('保留中文与空格', sanitizeBaseName('我的 视频') === '我的 视频')
  check('保留连字符', sanitizeBaseName('my-video-final') === 'my-video-final')
  check('去掉结尾的点', sanitizeBaseName('name.') === 'name')
  check('去掉结尾空格', sanitizeBaseName('name   ') === 'name')
  check('空名兜底', sanitizeBaseName('   ') === 'output')
  check('保留设备名兜底', sanitizeBaseName('CON') === '_CON')
  check('小写保留名也拦', sanitizeBaseName('nul') === '_nul')
  check('普通名字不受影响', sanitizeBaseName('COM10') === 'COM10')

  // emoji 不能被切成半个代理对
  const emoji = '\u{1F3AC}'.repeat(200)
  const cut = sanitizeBaseName(emoji)
  check(
    'emoji 按码点截断不劈开代理对',
    Array.from(cut).length === 120,
    `len=${Array.from(cut).length}`
  )

  const p1 = resolveOutputPath({
    inputPath: 'D:\\x\\movie.mkv',
    outputDir: resolve(TMP, 'out'),
    targetExt: '.MP4',
    onConflict: 'rename'
  })
  check('输出扩展名统一小写', p1.endsWith('movie.mp4'), p1)

  // 以 - 开头的文件名会被 ffmpeg/pandoc 当成选项，这是一类比 shell 注入更隐蔽的
  // 参数注入。净化本身不处理它（改名会破坏用户预期），靠调用方转绝对路径解决。
  const p2 = resolveOutputPath({
    inputPath: '-rf.mkv',
    outputDir: resolve(TMP, 'out'),
    targetExt: 'mp4',
    onConflict: 'rename'
  })
  check('以 - 开头的名字仍产出绝对路径', resolve(p2) === p2, p2)
}

// -------------------------------------------------------- 时长解析（stderr）

function testProbeParsing(): void {
  console.log('\n[2] 时长解析（从转换进程的 stderr）')

  const sample = `
  Duration: 00:02:03.45, start: 0.000000, bitrate: 1234 kb/s
  Stream #0:0: Video: h264 (High), yuv420p, 1920x1080
  Stream #0:1: Audio: aac (LC), 48000 Hz, stereo
  `
  const info = parseProbeOutput(sample)
  check(
    '时长解析正确',
    info.durationSec !== null && Math.abs(info.durationSec - 123.45) < 0.01,
    String(info.durationSec)
  )
  check('识别视频轨', info.hasVideo === true)
  check('识别音频轨', info.hasAudio === true)

  const audioOnly = `
  Duration: 00:00:30.00, start: 0.000000, bitrate: 128 kb/s
  Stream #0:0: Audio: mp3, 44100 Hz, stereo
  `
  const a = parseProbeOutput(audioOnly)
  check('纯音频：无视频轨', a.hasVideo === false && a.hasAudio === true)

  check(
    'Duration: N/A 归一为 null',
    parseProbeOutput('Duration: N/A, start: 0.000000, bitrate: N/A').durationSec === null
  )
}

// ---------------------------------------------------------------- 合成进度流

/**
 * 真实转换太快时 ffmpeg 根本来不及吐中间记录，所以进度逻辑必须用合成流验证。
 * 这样也顺带覆盖了「记录跨 chunk 边界」这个最容易写错的地方。
 */
function testProgressParser(): void {
  console.log('\n[3] 进度解析（合成流）')

  const record = (outTime: string, speed: string): string =>
    `frame=100\nfps=30\nbitrate=1000kbits/s\ntotal_size=1000\n` +
    `out_time_us=0\nout_time_ms=0\nout_time=${outTime}\n` +
    `dup_frames=0\ndrop_frames=0\nspeed=${speed}\nprogress=continue\n`

  const p = new FfmpegProgressParser(10) // 总时长 10 秒

  const u1 = p.push(record('00:00:02.000000', '1.0x'))!
  check('percent 计算正确 (2s/10s)', Math.abs(u1.percent - 0.2) < 1e-6, String(u1.percent))
  check('speed 解析正确', u1.speed === 1, String(u1.speed))
  check('eta = (10-2)/1.0 = 8s', Math.abs((u1.etaSec ?? -1) - 8) < 1e-6, String(u1.etaSec))

  // 一次塞两条记录，只应返回最后一条的状态
  const u2 = p.push(record('00:00:05.000000', '2.0x') + record('00:00:08.000000', '1.0x'))!
  check('一次多条记录取最新', Math.abs(u2.percent - 0.8) < 1e-6, String(u2.percent))
  check('2x 倍速下 eta = 2s', Math.abs((u2.etaSec ?? -1) - 2) < 1e-6, String(u2.etaSec))

  // 回退的时间戳必须被钳住，否则进度条会往回跳
  const u3 = p.push(record('00:00:03.000000', '1.0x'))!
  check('回退的时间戳被钳为不倒退', Math.abs(u3.percent - 0.8) < 1e-6, String(u3.percent))

  // 记录被切碎成多个 chunk，跨边界也要能拼回来
  const p2 = new FfmpegProgressParser(20)
  const whole = record('00:00:10.000000', '1.0x')
  p2.push(whole.slice(0, 12))
  p2.push(whole.slice(12, 30))
  const u4 = p2.push(whole.slice(30))
  check(
    '跨 chunk 边界拼接正确',
    u4 !== null && Math.abs(u4.percent - 0.5) < 1e-6,
    String(u4?.percent)
  )

  // 半条记录不应产生进度
  const p3 = new FfmpegProgressParser(10)
  check('缺少 progress= 终止符时不提交', p3.push('frame=1\nout_time=00:00:05.000000\n') === null)

  // progress=end 封顶
  const p4 = new FfmpegProgressParser(10)
  check('progress=end 封顶到 1', p4.push('out_time=00:00:09.000000\nprogress=end\n')!.percent === 1)
}

// ---------------------------------------------------------------- 真实 ffmpeg

async function testRealConversion(): Promise<void> {
  console.log('\n[4] 真实 ffmpeg 转换')

  await mkdir(TMP, { recursive: true })
  const input = resolve(TMP, 'input.mp4')
  const output = resolve(TMP, 'output.mkv')

  const gen = await run([
    '-hide_banner',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'testsrc=duration=10:size=320x240:rate=30',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:duration=10',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-c:a',
    'aac',
    '-shortest',
    input
  ])
  if (gen.code !== 0) {
    check('生成测试视频', false, gen.stderr.slice(-300))
    return
  }
  check('生成测试视频', true)

  // 时长不再单独探测，所以这里也没有「探测」这一步可断言。
  // 真正锁住「从转换进程 stderr 里读时长」那条链路的是 test-tasks.ts 的
  // 「长视频推送过确定进度」——那条跑的是完整的 TaskManager，才有意义。
  const info = parseProbeOutput('') // 空输入必须安全返回，不能抛
  check('空 stderr 不炸且时长为 null', info.durationSec === null)

  const parser = new FfmpegProgressParser(10) // 源素材是 duration=10
  const percents: number[] = []

  await new Promise<void>((done) => {
    const child = spawn(
      FFMPEG,
      [
        '-hide_banner',
        '-nostdin',
        '-y',
        '-i',
        input,
        '-progress',
        'pipe:1',
        '-nostats',
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-c:a',
        'copy',
        output
      ],
      { windowsHide: true }
    )
    child.stdout.on('data', (c: Buffer) => {
      const u = parser.push(c.toString('utf8'))
      if (u) percents.push(u.percent)
    })
    child.on('close', () => done())
  })

  check('收到进度更新', percents.length > 0, `${percents.length} 次`)
  check(
    '进度单调不减',
    percents.every((p, i) => i === 0 || p >= percents[i - 1]),
    JSON.stringify(percents.slice(0, 20))
  )
  check(
    '最终进度到 1',
    (percents[percents.length - 1] ?? 0) === 1,
    String(percents[percents.length - 1])
  )
  check(
    '进度始终在 [0,1]',
    percents.every((p) => p >= 0 && p <= 1)
  )

  const out = await stat(output)
    .then((s) => s.size)
    .catch(() => 0)
  check('产物已生成且非空', out > 0, `${out} 字节`)
}

// ------------------------------------------------------ 能力矩阵与类别视图

/**
 * 六个类别各自登记过的源格式条数，**写下来当"下界"用**。
 *
 * 为什么需要一组写死的数字：源格式总数（关于页要显示的那个）在整个规划期
 * 被手算错过两次（62 vs 72），所以它必须由代码算出。但"算出"这件事本身
 * 抓不住任何错误——`sum(六个数组长度)` 是对称的，删掉一整段
 * `register('ebook', …)` 之后它照样自洽。**下界是唯一能从外部证伪"这张表少了一半"
 * 的东西**：某个类别掉到 0（或掉到别的类别之下）就立刻翻红。
 *
 * 这些数字只会因为**故意增删格式**而失效，那时随手同步一下即可；它不会
 * 因为登记表自然增长而误报（下界是 `<=` 不是 `===`）。
 */
const EXT_COUNT_FLOOR: Record<Category, number> = {
  video: 13,
  audio: 10,
  image: 13,
  document: 17,
  ebook: 7,
  archive: 12
}

function testCapabilityMatrix(): void {
  console.log('\n[5] 能力矩阵与类别视图')

  const byCat = sourceExtsByCategory()

  const missingKeys = CATEGORIES.filter((c) => !Array.isArray(byCat[c]))
  check('sourceExtsByCategory 六个类别键齐全', missingKeys.length === 0, missingKeys.join(','))

  // 承重：少调一次 register，某个类别就静默变成空数组——关于页的分组会少一块、
  // 设置页会少一行下拉，**零报错**。这条是唯一能从 UI 之外发现它的手段。
  const empty = CATEGORIES.filter((c) => byCat[c].length === 0)
  check(
    '六个类别一个都不能空',
    empty.length === 0,
    `${empty.join(',')} 是空的（有人删掉了一次 register 调用？）`
  )

  const under = CATEGORIES.filter((c) => byCat[c].length < EXT_COUNT_FLOOR[c]).map(
    (c) => `${c}=${byCat[c].length}<${EXT_COUNT_FLOOR[c]}`
  )
  check('各类别源格式数不低于登记下界', under.length === 0, under.join(' '))

  // 两个数组由同一个 register() 循环填，任何一处绕过它就地改数组，这里当场分家。
  const misrouted = CATEGORIES.flatMap((c) =>
    byCat[c]
      .filter((e) => categoryOf(e) !== c)
      .map((e) => `${e}∈${c} 但 categoryOf=${categoryOf(e)}`)
  )
  check(
    '每个已登记的源格式都能被 categoryOf 反查回同一类别',
    misrouted.length === 0,
    misrouted.join(' / ')
  )

  // 总数由登记表算出：三个角度互相印证（六类之和 / 去重条数 / 反查得到的条数）。
  // 去重那条抓的是「同一个扩展名被登记进两个类别」——register 会让 EXT_TO_CATEGORY
  // 记后一次，于是两张表对同一个扩展名给出不同答案。
  const flat = CATEGORIES.flatMap((c) => byCat[c])
  const distinct = new Set(flat)
  const viaLookup = flat.filter((e) => categoryOf(e) !== null).length
  const sum = CATEGORIES.reduce((n, c) => n + byCat[c].length, 0)
  check(
    '源格式总数由登记表算出（六类之和 = 去重条数 = categoryOf 反查条数）',
    flat.length === sum && distinct.size === flat.length && viaLookup === flat.length && sum > 0,
    `sum=${sum} distinct=${distinct.size} viaLookup=${viaLookup}`
  )

  // 返回的必须是副本：交出去引用，调用方一次 push 就能让两张表分家。
  const leaked = sourceExtsByCategory()
  leaked.video.push('__probe__')
  check(
    'sourceExtsByCategory 返回副本（改它不影响内部表）',
    !sourceExtsByCategory().video.includes('__probe__') && categoryOf('__probe__') === null
  )

  // 登记了却没人认账的源格式：拖进来自标灰、选了目标再报「不支持」。
  const noTargets: string[] = []
  const noEngine: string[] = []
  for (const c of CATEGORIES) {
    for (const e of byCat[c]) {
      const targets = targetsFor(e)
      if (targets.length === 0) noTargets.push(`${c}/${e}`)
      for (const t of targets) if (engineFor(e, t) === null) noEngine.push(`${e}→${t}`)
    }
  }
  check('每个已登记的源格式都至少有一个合法目标', noTargets.length === 0, noTargets.join(','))
  check('每个合法组合都真的能路由到引擎', noEngine.length === 0, noEngine.join(','))

  // `targetsFor` 处处 `.filter(t => t !== from)`，去掉任何一处都会造出 fromExt === toExt。
  const selfTargets = CATEGORIES.flatMap((c) => byCat[c].filter((e) => targetsFor(e).includes(e)))
  check('没有任何源格式的合法目标包含它自己', selfTargets.length === 0, selfTargets.join(','))

  // 并集必须来自 targetsFor()，而不是谁手写一张「类别级默认目标」表。
  // 注意：并集里**出现别的源格式是正常的**（image 的 png→jpg 合法），
  // 所以这里断的不是「并集不含本类别的源格式」——那条对 image/video/archive
  // 全都是假的。真正承重的是下面那条 orphan 判据。
  const unionGap = CATEGORIES.map((c) => {
    const expect: string[] = []
    for (const e of byCat[c]) {
      for (const t of targetsFor(e)) if (!expect.includes(t)) expect.push(t)
    }
    const got = targetsForCategory(c)
    const same = got.length === expect.length && got.every((t, i) => t === expect[i])
    return same ? '' : `${c}: 得到 [${got}] 期望 [${expect}]`
  }).filter((s) => s.length > 0)
  check('类别目标并集恰为逐源 targetsFor 的保序去重', unionGap.length === 0, unionGap.join(' '))

  // 并集里每个目标都必须对**某个别的**源格式合法。混进一个谁都转不成的目标，
  // 设置页那行下拉就会给出一个对当前文件非法的默认值。
  const orphan = CATEGORIES.flatMap((c) =>
    targetsForCategory(c)
      .filter((t) => !byCat[c].some((e) => e !== t && targetsFor(e).includes(t)))
      .map((t) => `${c}/${t}`)
  )
  check('类别并集里每个目标都对某个别的源格式合法', orphan.length === 0, orphan.join(','))

  // ---- resolveDefaultTarget：override 必须被 targetsFor 复核一遍 ----
  //
  // 承重场景：用户把「视频默认转 mkv」之后拖进一个 .mkv。
  // 信任 override 就会造出 fromExt === toExt 的任务——队列老老实实跑一次
  // 毫无意义的重编码，退出码还是 0，用户只会觉得"转了个寂寞"。
  const mkv = resolveDefaultTarget('mkv', { video: 'mkv' })
  check(
    'override 指向源格式自身时回落到 targets[0]（mkv 不能转 mkv）',
    mkv !== null && mkv !== 'mkv',
    String(mkv)
  )
  check(
    '回落目标确实取的是 targetsFor 的第一项',
    mkv === targetsFor('mkv')[0],
    `${mkv} vs ${targetsFor('mkv')[0]}`
  )
  const pdf = resolveDefaultTarget('pdf', { document: 'pdf' })
  check(
    'override 指向源格式自身时回落到 targets[0]（pdf 不能转 pdf）',
    pdf !== null && pdf !== 'pdf',
    String(pdf)
  )
  check(
    '合法 override 被采纳（zip + archive:tar）',
    resolveDefaultTarget('zip', { archive: 'tar' }) === 'tar'
  )
  check(
    '合法 override 被采纳（md + document:docx）',
    resolveDefaultTarget('md', { document: 'docx' }) === 'docx'
  )
  check(
    'override 指向不存在的格式时回落',
    resolveDefaultTarget('mp4', { video: '__nope__' }) === targetsFor('mp4')[0]
  )

  // 穷举：每个源格式 × 该类别所有合法目标 ∪ 该类别所有源格式 ∪ 一个炮灰。
  // 这一条把上面那些单点场景一次性铺满，覆盖掉"换一个类别就漏了"的可能。
  const absurd: string[] = []
  for (const c of CATEGORIES) {
    const candidates = [...targetsForCategory(c), ...byCat[c], '__nope__']
    for (const e of byCat[c]) {
      const targets = targetsFor(e)
      for (const t of candidates) {
        const override = { [c]: t } as Partial<Record<Category, string>>
        const got = resolveDefaultTarget(e, override)
        if (got === null || !targets.includes(got) || got === e) {
          absurd.push(`${e}+${c}=${t}→${got}`)
        }
      }
    }
  }
  check(
    '穷举扫描：任何 override 都不会造出自身转换或非法目标',
    absurd.length === 0,
    `${absurd.length} 处：${absurd.slice(0, 5).join(' ')}`
  )

  // overrides 为空（设置页没配过）时必须与旧的 defaultTargetFor 完全一致——
  // 逐类别抽查是不够的，这里把全部 72 个源格式都过一遍。
  const drift = flat.filter((e) => resolveDefaultTarget(e, {}) !== defaultTargetFor(e))
  check(
    'overrides 为空时与 defaultTargetFor 完全一致（全量源格式）',
    drift.length === 0,
    drift.join(',')
  )

  check(
    '不认识的扩展名返回 null',
    resolveDefaultTarget('zzz', {}) === null &&
      resolveDefaultTarget('zzz', { video: 'mp4' }) === null &&
      resolveDefaultTarget('', {}) === null
  )
}

// -------------------------------------------------------------- 图标素材 id

/** 图标素材相对路径（正斜杠），按名字排序，保证输出稳定。 */
function listIconFiles(): string[] {
  return (readdirSync(ICONS_DIR, { recursive: true }) as string[])
    .map((f) => f.replace(/\\/g, '/'))
    .filter((f) => f.endsWith('.svg'))
    .sort()
}

function testIconIds(): void {
  console.log('\n[6] 图标素材与 symbol id')

  let files: string[]
  try {
    files = listIconFiles()
  } catch (e) {
    check('能列出图标素材目录', false, String(e))
    return
  }
  check('能列出图标素材目录', true)

  // 递归列出失效（比如少了 recursive）时只剩根下的 logo.svg，后面所有 id 断言
  // 都会在小集合上恒真——先钉住"三个子目录都在、且条数不至于塌掉"。
  const dirs = ['formats/', 'ui/', 'ornaments/']
  const reached = dirs.filter((d) => files.some((f) => f.startsWith(d)))
  check(
    '素材清单覆盖 formats/ui/ornaments 三个目录且条数合理',
    reached.length === dirs.length && files.length >= 40,
    `reached=${reached.join(',')} files=${files.length}`
  )

  const ids = files.map((f) => spriteIdFor(f))
  const nameless = files.filter((f) => spriteIdFor(f) === '')
  check('每个素材文件都能算出非空 id', nameless.length === 0, nameless.join(','))

  // 承重：两个文件映射到同一个 id，合成 sprite 时后者被前者顶掉，
  // 而 `<use href>` 照样解析得到——**错的是图，不是空白**，比渲染空白更难发现。
  const dup = ids.filter((id, i) => ids.indexOf(id) !== i)
  check(
    'sprite id 两两不同（无一被顶掉）',
    dup.length === 0,
    `重复：${[...new Set(dup)].join(',')}`
  )

  const spriteIds = new Set(ids)

  // 交叉验证：`tileForExt` 与 `spriteIdFor('formats/format-<ext>.svg')` 必须给同一个 id。
  // 各拼一次迟早漂移，而 `<use href="#不存在的id">` 是**静默失败**（渲染成空白，
  // 控制台最多一条 warning）——这条断言是唯一能发现它的手段。
  const cross = TILE_EXTS.filter((e) => tileForExt(e) !== spriteIdFor(`formats/format-${e}.svg`))
  check('TILE_EXTS 每个 ext 与 spriteIdFor 算出的 id 一致', cross.length === 0, cross.join(','))

  const missingTile = TILE_EXTS.filter((e) => !files.includes(`formats/format-${e}.svg`))
  check('TILE_EXTS 每个 ext 都有对应的素材文件', missingTile.length === 0, missingTile.join(','))

  const dangling = TILE_EXTS.filter((e) => !spriteIds.has(tileForExt(e)))
  check('每个专属砖解析到的 id 都对应真实素材', dangling.length === 0, dangling.join(','))

  // 别名：只做「同一格式的不同写法」的归一。
  check('别名 jpeg → jpg 砖', tileForExt('jpeg') === 'f-jpg', tileForExt('jpeg'))
  check('别名 tif → tiff 砖', tileForExt('tif') === 'f-tiff', tileForExt('tif'))
  check('别名 markdown → md 砖', tileForExt('markdown') === 'f-md', tileForExt('markdown'))
  check(
    '大小写与前后点号被容忍',
    tileForExt('.JPG') === 'f-jpg' && tileForExt(' JPG ') === 'f-jpg',
    `${tileForExt('.JPG')} / ${tileForExt(' JPG ')}`
  )

  // 兜底砖的 id 从**素材本身**算出来，而不是写死 'f-file'。
  const genericId = spriteIdFor('formats/format-file.svg')
  const fallbackId = tileForExt('__definitely_not_a_format__')
  check(
    '未知扩展名落到通用兜底砖 format-file.svg',
    fallbackId === genericId &&
      ['m4a', 'zzz', 'heic', ''].every((e) => tileForExt(e) === genericId),
    `${fallbackId} vs ${genericId}`
  )
  check(
    '兜底返回的 id 对应的素材真实存在',
    spriteIds.has(fallbackId),
    `${fallbackId} 在素材清单里找不到`
  )

  // 跨模块扫描：能力矩阵里认得的**每一个**源格式，喂给 tileForExt 之后都必须
  // 落在一个真实存在的砖上（专属砖或兜底砖）。素材被改名/删掉时这里最先翻红。
  const byCat = sourceExtsByCategory()
  const allExts = [...new Set(CATEGORIES.flatMap((c) => byCat[c]).concat([...TILE_EXTS]))]
  const badTile = allExts.filter((e) => !spriteIds.has(tileForExt(e)))
  check('所有已登记源格式的格式砖都指向真实素材', badTile.length === 0, badTile.join(','))

  // 这个模块必须保持零依赖：一旦引入 React 或 `import.meta.glob` / `?raw` 这类
  // Vite 专有语法，tsx 就加载不了它——那会让上面所有断言连同 npm run falsify
  // **整体失效**（而不是变红），是唯一能让整套输出纪律失效的点。
  let src = ''
  try {
    src = readFileSync(ICONS_MODULE, 'utf8')
  } catch (e) {
    check('icons.ts 仍能被读出来做零依赖检查', false, String(e))
    return
  }
  // 先摘掉注释：文件头那段注释里正躺着「不许 import React」「不许用 import.meta.glob」
  // 两句话，直接扫源码会把自己的说明文字当违规抓出来（这条断言第一次跑就是这么翻红的）。
  const codeOnly = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const dirtyLines = codeOnly
    .split(/\r?\n/)
    .filter((l) => /^\s*import\b/.test(l) || l.includes('import.meta'))
  check(
    'icons.ts 仍然零依赖（无 import / import.meta）',
    dirtyLines.length === 0,
    dirtyLines.join(' | ')
  )
}

// ------------------------------------------------------------ 设置契约（zod）

/**
 * `defaultTargets` 必须用 `z.partialRecord`，**绝不能用 `z.record`**。
 *
 * 这是 Phase 0 **真实踩过**的一个坑，不是假想：zod 4 把
 * `z.record(keySchema, valueSchema)` 的语义改成了「**键必须全给**」，
 * 照着 zod 3 的写法抄就会写成 `z.record(z.enum(CATEGORIES), extSchema)`，
 * 于是六个类别一个都不能缺。**两个方向都是静默的**：
 *
 *   - **读盘**（`settingsSchema`）：该字段挂着 `.catch(undefined)`，解析失败被吞 →
 *     静默退回 `{}`，用户改过的类别偏好一重启就没了，没有任何提示；
 *   - **收 patch**（`settingsPatchSchema`）：`.strict()` 把**整份** patch 拒掉，
 *     连一起送来的 `maxConcurrent` 都跟着丢，现象只是「改了没生效」。
 *
 * 所以这一组里最要紧的是两条：**partial 到底能不能过**（正中靶心），
 * 以及**一个字段坏掉会不会把别的字段一起拖下水**（连坐）。
 * 另外还得有一批反向断言，防的是「为了修这个 bug 把校验整个放松」。
 *
 * 后来**读盘侧**又往前走了一步：字段级 `.catch(undefined)` 换成逐键筛
 * （`lenientTargets`，见 `ipc-contract.ts`）。理由是 `.catch` 的宽容粒度是**整个字段**，
 * 一个键坏掉六类偏好一起没；最真实的通路是将来删掉或改名一个类别，用户
 * `settings.json` 里的旧键成了未知键，于是偏好一起清零。**patch 侧一个字没改**
 * （渲染进程送来的输入该严），两边的信任级别差异在这里体现得最清楚。
 */
function testSettingsContract(): void {
  console.log('\n[7] 设置契约（settings patch / 读盘 schema）')

  // ---- 正中靶心：只给部分类别必须被接受 ----
  const rejectedPartial = CATEGORIES.filter(
    (c) => !settingsPatchSchema.safeParse({ defaultTargets: { [c]: 'mp4' } }).success
  )
  check(
    'patch schema 接受「只给部分类别」（六类别逐个试）',
    rejectedPartial.length === 0,
    `被拒：${rejectedPartial.join(',')}`
  )

  const emptyMap = settingsPatchSchema.safeParse({ defaultTargets: {} })
  check(
    'patch schema 接受 defaultTargets: {}（用户把偏好全撤掉）',
    emptyMap.success,
    emptyMap.success ? '' : String(emptyMap.error).slice(0, 200)
  )

  // 修完之后「全给」当然还得过，且必须原样保留——每个类别给一个不同的值，
  // 顺带证明 partialRecord 没有把值张冠李戴。
  const perCat: Record<Category, string> = {
    video: 'mp4',
    audio: 'mp3',
    image: 'jpg',
    document: 'pdf',
    ebook: 'epub',
    archive: 'zip'
  }
  check(
    '六类别样本覆盖了全部类别（防这条断言悄悄退化成子集测试）',
    CATEGORIES.length === Object.keys(perCat).length && CATEGORIES.every((c) => c in perCat)
  )
  const full = settingsPatchSchema.safeParse({ defaultTargets: perCat })
  check(
    'patch schema 接受六类别全给且原样保留',
    full.success && CATEGORIES.every((c) => full.data?.defaultTargets?.[c] === perCat[c]),
    full.success ? JSON.stringify(full.data) : String(full.error).slice(0, 200)
  )

  // ---- 承重：不能连坐 ----
  // 坏就坏在「defaultTargets 被整份拒绝」时会把同一份 patch 里的别的字段一起带走。
  const both = settingsPatchSchema.safeParse({
    maxConcurrent: 3,
    defaultTargets: { video: 'mkv' }
  })
  check(
    '承重：defaultTargets 与 maxConcurrent 同时送来时两者都要在（不能连坐）',
    both.success && both.data?.maxConcurrent === 3 && both.data?.defaultTargets?.video === 'mkv',
    both.success ? JSON.stringify(both.data) : String(both.error).slice(0, 200)
  )
  check(
    'patch schema 只给 maxConcurrent 也通过',
    settingsPatchSchema.safeParse({ maxConcurrent: 3 }).success
  )

  // ---- 反向：别为了修 bug 把校验整个放松 ----
  check(
    '大写扩展名仍被拒（extSchema 没被放松）',
    !settingsPatchSchema.safeParse({ defaultTargets: { video: 'MP4' } }).success
  )
  check(
    '带点扩展名仍被拒',
    !settingsPatchSchema.safeParse({ defaultTargets: { video: '.mp4' } }).success
  )
  check(
    '未知类别仍被拒（partialRecord 只是让键可选，不是让键随便写）',
    !settingsPatchSchema.safeParse({ defaultTargets: { zzz: 'mp4' } }).success
  )
  check(
    '未知顶层字段 theme 仍被 .strict() 拒（旧渲染层发来的 patch 该拒就拒）',
    !settingsPatchSchema.safeParse({ theme: 'dark' }).success
  )
  check(
    'maxConcurrent 越界仍被拒',
    !settingsPatchSchema.safeParse({ maxConcurrent: 0 }).success &&
      !settingsPatchSchema.safeParse({ maxConcurrent: 99 }).success
  )
  // 渲染进程送来的一切都当不可信输入：patch 侧某个值非法时**必须整份拒绝**。
  // 上面第一条断言修的是「合法的部分值被误拒」，这条钉的是「非法的值不能被静默丢掉」，
  // 两条一起才能把「该拒的拒、该收的收」夹住。
  check(
    'patch 侧某个值非法时仍然整份拒绝（不静默丢字段）',
    !settingsPatchSchema.safeParse({ maxConcurrent: 3, defaultTargets: { video: 'MP4' } }).success
  )

  // ---- 读盘 schema：信任级别不同，要的是「尽量读出来」 ----
  const legacy = settingsSchema.safeParse({ theme: 'dark', maxConcurrent: 3 })
  check(
    '读盘：残留的 theme 不致命、被剥掉，其余字段照读',
    legacy.success &&
      legacy.data?.maxConcurrent === 3 &&
      !Object.prototype.hasOwnProperty.call(legacy.data, 'theme'),
    legacy.success ? JSON.stringify(legacy.data) : String(legacy.error).slice(0, 200)
  )

  const diskPartial = settingsSchema.safeParse({ defaultTargets: { video: 'mkv' } })
  check(
    '读盘：defaultTargets 的部分类别读得回来（不再静默退回 {}）',
    diskPartial.success && diskPartial.data?.defaultTargets?.video === 'mkv',
    diskPartial.success ? JSON.stringify(diskPartial.data) : String(diskPartial.error).slice(0, 200)
  )

  // ⚠️ 这条**不能只断 `success`**：读盘 schema 上挂着 `.catch(undefined)`，
  // 字段被整块吞掉时 `success` 照样是 true——只断 success 的写法在 bug 下也是绿的，
  // 是一条伪装成断言的装饰品。必须断「空对象真的留下来了」。
  const diskEmptyMap = settingsSchema.safeParse({ defaultTargets: {} })
  check(
    '读盘：defaultTargets: {} 被接受（空对象留下来了，不是被 catch 吞成 undefined）',
    diskEmptyMap.success &&
      diskEmptyMap.data?.defaultTargets !== undefined &&
      Object.keys(diskEmptyMap.data.defaultTargets).length === 0,
    diskEmptyMap.success
      ? JSON.stringify(diskEmptyMap.data)
      : String(diskEmptyMap.error).slice(0, 200)
  )
  check('读盘：六类别全给也通过', settingsSchema.safeParse({ defaultTargets: perCat }).success)
  check(
    '读盘：空对象不炸（首次启动还没有设置文件时就是这个形状）',
    settingsSchema.safeParse({}).success
  )

  // `.catch(undefined)` 是第二道保险：zod 默认「一个字段坏掉 → 整个对象解析失败」，
  // 挂上 catch 之后坏字段自己退回 undefined，由 core/settings.ts 的默认值接住，
  // 其余六项不受牵连。
  const badField = settingsSchema.safeParse({ onConflict: 'bogus', maxConcurrent: 3 })
  check(
    '读盘：坏字段退回 undefined 而不连坐（onConflict 坏掉不影响 maxConcurrent）',
    badField.success &&
      badField.data?.onConflict === undefined &&
      badField.data?.maxConcurrent === 3,
    badField.success ? JSON.stringify(badField.data) : String(badField.error).slice(0, 200)
  )
  // ---- 读盘侧 defaultTargets 的**逐键筛** ----
  //
  // 这里此前是「字段级 `.catch(undefined)`」，宽容粒度是**整个字段**：一个键坏掉
  // （值非法，或键根本不是已知类别），六类偏好一起退回内建默认。最窄但最真实的一条
  // 通路是**将来删掉或改名一个类别**——用户 settings.json 里那个旧键成了未知键，
  // 于是六类偏好一起清零，而上面那段注释防的正是「设置全丢而没有提示」。
  //
  // 现在读盘走的是逐键筛（`lenientTargets`）：认得的键 + 合法的值留下，其余静默剔除。
  // 所以下面断的是**逐键**结果，而不是「整块丢 / 整块留」。这三条都是这次改动
  // 新来的承重点，别把它们退回成「只断 success」——`.catch` 让顶层 success 永远为 true，
  // 只断 success 的写法在两种坏法下都是绿的。
  const sameMap = (got: unknown, want: Record<string, string>): boolean => {
    if (typeof got !== 'object' || got === null) return false
    const g = got as Record<string, unknown>
    const gk = Object.keys(g).sort()
    const wk = Object.keys(want).sort()
    return gk.length === wk.length && gk.every((k, i) => k === wk[i] && g[k] === want[k])
  }
  const show = (r: { success: boolean; data?: unknown; error?: unknown }): string =>
    r.success ? JSON.stringify(r.data) : String(r.error).slice(0, 200)

  const strayKey = settingsSchema.safeParse({ defaultTargets: { video: 'mkv', nope: 'mkv' } })
  check(
    '读盘：未知类别被剥掉，认得的键留下（逐键筛）',
    strayKey.success && sameMap(strayKey.data?.defaultTargets, { video: 'mkv' }),
    show(strayKey)
  )

  // 这次改动的全部理由就是这条：坏值只剔自己，不许把同一份 map 里好的键一起带走。
  const badValue = settingsSchema.safeParse({ defaultTargets: { video: 'mkv', audio: 42 } })
  const badUpper = settingsSchema.safeParse({ defaultTargets: { video: 'mkv', image: 'MKV' } })
  check(
    '读盘：坏值不带走好值（audio:42、image:"MKV" 都只剔掉自己）',
    badValue.success &&
      sameMap(badValue.data?.defaultTargets, { video: 'mkv' }) &&
      badUpper.success &&
      sameMap(badUpper.data?.defaultTargets, { video: 'mkv' }),
    `${show(badValue)} / ${show(badUpper)}`
  )

  const strayCat = settingsSchema.safeParse({
    defaultTargets: { nope: 'mkv' },
    maxConcurrent: 3
  })
  check(
    '读盘：未知类别不连坐（defaultTargets 仍是对象，maxConcurrent 照常留下）',
    strayCat.success &&
      typeof strayCat.data?.defaultTargets === 'object' &&
      strayCat.data?.defaultTargets !== null &&
      strayCat.data?.maxConcurrent === 3,
    show(strayCat)
  )

  // 非对象输入走的是另一条路：`z.record(z.string(), z.unknown())` 那一层先把它挡下来，
  // 外层 `.catch(undefined)` 接手。两者缺一，一份被手改坏的 settings.json 就能让
  // 整份设置回到默认值——这正是读盘 schema 不 strict 要避免的事。
  const nonObjects = [Array<string>(), 'x', null, 7].map((v) =>
    settingsSchema.safeParse({ defaultTargets: v, maxConcurrent: 3 })
  )
  check(
    '读盘：defaultTargets 是非对象（数组/字符串/null/数字）时整块退回 undefined，不炸整份设置',
    nonObjects.every(
      (r) => r.success && r.data?.defaultTargets === undefined && r.data?.maxConcurrent === 3
    ),
    nonObjects.map(show).join(' / ')
  )
}

// ------------------------------------------------- office 族出口（同族约束）

/**
 * LibreOffice 那条线的能力矩阵。
 *
 * 实测（2026-09-12，LO 26.8.0.3）：`--convert-to` 只在**同一个应用内**成立，
 * 跨族一律 `Error: no export filter for … found, aborting.` + 退出码 1。
 * 分界线是 Writer / Calc / Impress 三家，与源是 ODF 还是 OOXML 无关
 * （`doc→pptx` 与 `odt→pptx` 同结论）。
 *
 * 这张表原先对 7 个源一律宣称 `pdf/docx/xlsx/pptx/txt`，其中 **19 个组合是假的**
 * （对 `xls` 只有 2/5 为真）。**收窄是最容易被后人无意撤销的一类改动**：谁顺手
 * 往族表里加一个目标格式，界面就重新宣称一个跑不通的组合，用户选完、等进度条
 * 跑完三秒才看到失败——而没有任何东西会红。所以这里逐行钉死。
 */
const OFFICE_FAMILY_EXPECT: Record<string, string[]> = {
  doc: ['docx', 'pdf', 'txt'],
  odt: ['docx', 'pdf', 'txt'],
  xls: ['pdf', 'xlsx'],
  ods: ['pdf', 'xlsx'],
  ppt: ['pdf', 'pptx'],
  pptx: ['pdf'], // 族里本来也写着 pptx，被既有的「滤掉源格式自身」约定去掉了
  odp: ['pdf', 'pptx']
}

/** 旧表宣称过、LO 实测跑不通的 19 个跨族组合。 */
const CROSS_FAMILY: [string, string][] = [
  ['doc', 'xlsx'],
  ['doc', 'pptx'],
  ['odt', 'xlsx'],
  ['odt', 'pptx'],
  ['xls', 'docx'],
  ['xls', 'pptx'],
  ['xls', 'txt'],
  ['ods', 'docx'],
  ['ods', 'pptx'],
  ['ods', 'txt'],
  ['ppt', 'docx'],
  ['ppt', 'xlsx'],
  ['ppt', 'txt'],
  ['pptx', 'docx'],
  ['pptx', 'xlsx'],
  ['pptx', 'txt'],
  ['odp', 'docx'],
  ['odp', 'xlsx'],
  ['odp', 'txt']
]

/* ------------------------------------------------------------ 裁剪参数 */

/**
 * 裁剪（P-1 任务参数通道）的**纯逻辑**那一半：参数构造、契约校验、文案。
 *
 * 真实的裁剪行为（无损模式到底有没有重编码、精确到哪一帧）在
 * `scripts/test-tasks.ts` 的 [16] 里跑真 ffmpeg 验，这里只钉那些不起进程就能判定的事。
 *
 * 三组断言各自的靶心：
 *
 * 1. **`-ss` 的位置。** 它决定产物拿到的是哪一段——在 `-i` 之前是「回退到前一个关键帧」，
 *    在之后是「跳到下一个关键帧」。后者会**永久丢掉**用户要的那一段，而退出码是 0。
 *    位置错了只有真跑一遍才看得出来，所以这里先把顺序钉死。
 * 2. **精确模式相对不裁剪只多两个参数。** 裁剪不该顺手改掉编码器、质量、容器参数——
 *    它是「换一组时间参数」，不是「另一条流水线」。判据是**整条数组**逐字比对：
 *    只断言「有没有 libx264」抓不住「容器参数被改动了」。
 * 3. **契约的拒收面。** 每一个数都会变成 ffmpeg 的命令行参数，而 `NaN` 这种值
 *    在命令行里是个**字面量**，ffmpeg 会拿它当文件名去解析，报一句与裁剪毫无关系的错。
 */
function testTrimContract(): void {
  console.log('\n[9] 裁剪参数与参数构造')

  const inFile = 'D:\\in\\clip.mp4'
  const outFile = 'D:\\out\\clip.mkv'
  const clip = { start: 3, duration: 2 }

  /* ---- 无损：`-c copy` + 输入侧定位 ---- */

  const copy = buildTrimCopyArgs(inFile, outFile, 'mkv', clip)
  const ss = copy.indexOf('-ss')
  const iAt = copy.indexOf('-i')
  check(
    '无损裁剪：-ss 排在 -i 之前（在之后会永久丢掉一段内容、而退出码仍是 0）',
    ss >= 0 && ss < iAt,
    copy.join(' ')
  )
  check(
    '无损裁剪：确实一个字节都不编（-c copy）',
    copy.includes('-c') && copy[copy.indexOf('-c') + 1] === 'copy',
    copy.join(' ')
  )
  check(
    '无损裁剪：带上 -avoid_negative_ts make_zero（漏掉它，头那一段的 pts 是负的、容器报不出长度）',
    copy.includes('-avoid_negative_ts') &&
      copy[copy.indexOf('-avoid_negative_ts') + 1] === 'make_zero',
    copy.join(' ')
  )
  check(
    '无损裁剪：-t 给的是时长（end − start），不是绝对终点',
    copy[copy.indexOf('-t') + 1] === '2.000',
    String(copy[copy.indexOf('-t') + 1])
  )
  check(
    '无损裁剪：-map 口径与 remux 一致（第一条视频 + 第一条音频，缺了不致命）',
    copy.filter((a) => a === '-map').length === 2 &&
      copy.includes('0:v:0?') &&
      copy.includes('0:a:0?'),
    copy.join(' ')
  )
  check(
    '无损裁剪到 mp4：-movflags +faststart 不能丢（丢了就不能边下边播）',
    buildTrimCopyArgs(inFile, 'D:\\out\\clip.mp4', 'mp4', clip).includes('+faststart')
  )
  check(
    '无损裁剪到 mkv：不塞 movflags（那是 mp4 家族的参数）',
    !buildTrimCopyArgs(inFile, outFile, 'mkv', clip).some((a) => a.includes('faststart'))
  )

  /* ---- 精确：与不裁剪只差 `-ss` / `-t` ---- */

  const plain = buildFfmpegArgs(inFile, outFile, 'mp4', 'mkv')
  const trimmed = buildFfmpegArgs(inFile, outFile, 'mp4', 'mkv', { trim: clip })

  // 把注入的四个元素（`-ss x` / `-t y`）抠掉之后，剩下的应当与不裁剪时**逐字相同**
  const a = trimmed.indexOf('-ss')
  const b = trimmed.indexOf('-t')
  const stripped = [...trimmed.slice(0, a), ...trimmed.slice(a + 2, b), ...trimmed.slice(b + 2)]
  check(
    '精确裁剪：整条参数只多了 -ss/-t 四个元素，编码器与容器参数逐字未变',
    a >= 0 && b > a && JSON.stringify(stripped) === JSON.stringify(plain),
    stripped.join(' ')
  )
  check(
    '精确裁剪：-ss 同样在 -i 之前（重编码下这正是**帧级准确**的那种写法）',
    a >= 0 && a < trimmed.indexOf('-i'),
    trimmed.join(' ')
  )
  check(
    '精确裁剪：-t 排在编码参数与容器参数之后（图片源自带的 -t 5 不会赢过用户的要求）',
    b > trimmed.indexOf('-crf') && b < trimmed.indexOf(outFile),
    trimmed.join(' ')
  )
  check(
    '精确裁剪：走的是重编码（libx264 + aac），不会顺手退成 -c copy',
    trimmed.includes('libx264') && trimmed.includes('aac') && !trimmed.includes('copy'),
    trimmed.join(' ')
  )

  /* ---- 契约：合法的进来，坏的必须被拒 ---- */

  const ok = trimSchema.safeParse({ start: 0, end: 10, mode: 'exact' })
  check('契约：合法参数通过', ok.success, ok.success ? '' : String(ok.error).slice(0, 160))

  check(
    '契约：end === start 被拒（零长度不是一次裁剪）',
    !trimSchema.safeParse({ start: 5, end: 5, mode: 'exact' }).success
  )
  check(
    '契约：end < start 被拒',
    !trimSchema.safeParse({ start: 5, end: 4, mode: 'exact' }).success
  )
  // NaN / Infinity 是**承重**的：它们进了命令行是字面量，ffmpeg 会拿它当文件名
  check('契约：NaN 被拒', !trimSchema.safeParse({ start: NaN, end: 10, mode: 'exact' }).success)
  check(
    '契约：Infinity 被拒',
    !trimSchema.safeParse({ start: 0, end: Infinity, mode: 'exact' }).success
  )
  check('契约：负数被拒', !trimSchema.safeParse({ start: -1, end: 10, mode: 'exact' }).success)
  check(
    '契约：超过上限被拒',
    !trimSchema.safeParse({ start: 0, end: MAX_TRIM_SEC + 1, mode: 'exact' }).success
  )
  check(
    '契约：上限本身通过（边界不能一并拒掉）',
    trimSchema.safeParse({ start: 0, end: MAX_TRIM_SEC, mode: 'exact' }).success
  )
  check(
    '契约：未知的 mode 被拒',
    !trimSchema.safeParse({ start: 0, end: 10, mode: 'fast' }).success
  )
  check(
    '契约：TRIM_MODES 里每一档都真的能被 schema 收下（两个常量不许漂移）',
    TRIM_MODES.every((m) => trimSchema.safeParse({ start: 0, end: 10, mode: m }).success),
    TRIM_MODES.join(',')
  )
  check(
    '契约：多给一个字段被拒（字段名拼错时不能静默忽略）',
    !trimSchema.safeParse({ start: 0, end: 10, mode: 'exact', extra: 1 }).success
  )

  const setId = 'task-1'
  check(
    '契约：setOptions 载荷收 { id, options: { trim } }',
    setOptionsSchema.safeParse({
      id: setId,
      options: { trim: { start: 1, end: 2, mode: 'lossless' } }
    }).success
  )
  check(
    '契约：options 给 null 表示清空，必须通过',
    setOptionsSchema.safeParse({ id: setId, options: null }).success
  )
  check(
    '契约：options 给 {} 也通过（与清空等价）',
    setOptionsSchema.safeParse({ id: setId, options: {} }).success
  )
  check('契约：缺 id 被拒', !setOptionsSchema.safeParse({ options: null }).success)
  check(
    '契约：嵌套的坏 trim 同样被拒（不是只有顶层严）',
    !setOptionsSchema.safeParse({
      id: setId,
      options: { trim: { start: 5, end: 1, mode: 'exact' } }
    }).success
  )

  /* ---- 判据与文案 ---- */

  const trimmable = CATEGORIES.filter(canTrim)
  check(
    '判据：只有视频与音频能裁剪（逐类遍历，不写成一条条 !canTrim(...)）',
    trimmable.join(',') === 'video,audio',
    trimmable.join(',')
  )

  // **整句钉死**：「无损（起点对齐关键帧）」那个括注是功能行为的一部分，
  // 不是文案装饰。谁把它删掉，这条就红。
  check(
    '摘要：无损那一档必须写明「起点对齐关键帧」',
    describeTrim({ start: 3, end: 8, mode: 'lossless' }) ===
      '裁 3.0s–8.0s · 无损（起点对齐关键帧）',
    describeTrim({ start: 3, end: 8, mode: 'lossless' })
  )
  check(
    '摘要：精确那一档不带那句括注',
    describeTrim({ start: 3, end: 8, mode: 'exact' }) === '裁 3.0s–8.0s · 精确',
    describeTrim({ start: 3, end: 8, mode: 'exact' })
  )
  check(
    '摘要：小数原样显示（面板允许填 1.55，卡片上写 1.5s 就不是同一个数了）',
    describeTrim({ start: 1.55, end: 3.25, mode: 'exact' }) === '裁 1.55s–3.25s · 精确',
    describeTrim({ start: 1.55, end: 3.25, mode: 'exact' })
  )
  check(
    '摘要：没有参数时给 null 而不是空串（空串会渲染成一行空白）',
    describeOptions(undefined) === null && describeOptions({}) === null
  )
  /* ---- 输出约束（P0-2 的契约面）---- */

  check(
    '契约：输出约束收整数 targetBytes',
    outputSchema.safeParse({ targetBytes: 10 * 1024 * 1024 }).success
  )
  check('契约：输出约束收整数 bitrateKbps', outputSchema.safeParse({ bitrateKbps: 8000 }).success)
  check(
    '契约：体积与码率必须二选一——两个都给被拒',
    !outputSchema.safeParse({ targetBytes: 1024 * 1024, bitrateKbps: 8000 }).success
  )
  check('契约：体积与码率必须二选一——一个都不给也被拒', !outputSchema.safeParse({}).success)
  check(
    '契约：小数被拒（会变成 -b:v 的分子，四舍五入而不是报错）',
    !outputSchema.safeParse({ targetBytes: 1024.5 }).success
  )
  check(
    '契约：NaN 被拒（它进了命令行是字面量 NaN，ffmpeg 会拿它当文件名）',
    !outputSchema.safeParse({ targetBytes: Number.NaN }).success
  )
  check(
    '契约：Infinity 被拒',
    !outputSchema.safeParse({ bitrateKbps: Number.POSITIVE_INFINITY }).success
  )
  check(
    '契约：上限本身通过（边界不能一并拒掉）',
    outputSchema.safeParse({ targetBytes: MAX_TARGET_BYTES }).success &&
      outputSchema.safeParse({ bitrateKbps: MAX_BITRATE_KBPS }).success
  )
  check(
    '契约：超过上限被拒',
    !outputSchema.safeParse({ targetBytes: MAX_TARGET_BYTES + 1 }).success
  )
  check(
    '契约：多给一个字段被拒（字段名拼错时不能静默忽略）',
    !outputSchema.safeParse({ targetBytes: 1024 * 1024, extra: 1 }).success
  )

  /* ---- 编码质量档（P0-10 的契约面）---- */

  check(
    '契约：质量档三个字段各自可省、都能单独收下',
    qualitySchema.safeParse({ crf: 18 }).success &&
      qualitySchema.safeParse({ preset: 'slow' }).success &&
      qualitySchema.safeParse({ tune: 'film' }).success
  )
  check(
    '契约：质量档三项全给也通过',
    qualitySchema.safeParse({ crf: 18, preset: 'slow', tune: 'grain' }).success
  )
  // 空对象与「没有质量档」在引擎那一侧行为相同，但它在 TaskOptions 里**占着一个键**：
  // 卡片上会多一句「编码档（未指定）」、历史页会把这条记成「用过编码档」。
  check('契约：空对象被拒（它会让同一条任务有两种表示）', !qualitySchema.safeParse({}).success)
  check(
    '契约：CRF 边界本身通过（0 = 无损、51 = 最差，两端都是合法值）',
    qualitySchema.safeParse({ crf: MIN_CRF }).success &&
      qualitySchema.safeParse({ crf: MAX_CRF }).success
  )
  check(
    '契约：CRF 越界被拒',
    !qualitySchema.safeParse({ crf: MIN_CRF - 1 }).success &&
      !qualitySchema.safeParse({ crf: MAX_CRF + 1 }).success
  )
  // 小数会原样进 `-crf`，ffmpeg 四舍五入——用户填的与他得到的对不上，而没有任何地方报错。
  check('契约：小数 CRF 被拒', !qualitySchema.safeParse({ crf: 18.5 }).success)
  check(
    '契约：NaN / Infinity 的 CRF 被拒（进了命令行是字面量，ffmpeg 会当文件名解析）',
    !qualitySchema.safeParse({ crf: Number.NaN }).success &&
      !qualitySchema.safeParse({ crf: Number.POSITIVE_INFINITY }).success
  )
  check(
    '契约：未知的 preset / tune 被拒（枚举是从常量数组派生的，不该有漏网值）',
    !qualitySchema.safeParse({ preset: 'insane' }).success &&
      !qualitySchema.safeParse({ tune: 'psnr' }).success
  )
  check(
    '契约：ENCODE_PRESETS / ENCODE_TUNES 里每一档都真的被 schema 收下（两个常量不许漂移）',
    ENCODE_PRESETS.every((p) => qualitySchema.safeParse({ preset: p }).success) &&
      ENCODE_TUNES.every((t) => qualitySchema.safeParse({ tune: t }).success),
    `${ENCODE_PRESETS.length} 档预设 / ${ENCODE_TUNES.length} 档调优`
  )
  check('契约：质量档多给一个字段被拒', !qualitySchema.safeParse({ crf: 18, extra: 1 }).success)
  check(
    '契约：setOptions 载荷收 { id, options: { quality } }',
    setOptionsSchema.safeParse({ id: setId, options: { quality: { crf: 18 } } }).success
  )
  // ⚠️ 这一条是这批参数里最承重的一条：`-crf` 与 `-b:v` 同时给时 x264 会回到质量模式、
  // 把体积目标变成一句空话，**而任务报成功**。两个界面都靠这条拒。
  check(
    '契约：质量档与输出约束互斥——同时给被拒',
    !setOptionsSchema.safeParse({
      id: setId,
      options: { quality: { crf: 18 }, output: { targetBytes: 10 * 1024 * 1024 } }
    }).success
  )
  check(
    '契约：质量档与输出约束各自单独给仍然通过（互斥不等于一律拒）',
    setOptionsSchema.safeParse({
      id: setId,
      options: { quality: { crf: 18 }, trim: { start: 1, end: 2, mode: 'exact' } }
    }).success
  )

  /* ---- 出口判据：哪些出口认这套旋钮 ---- */

  check(
    '判据：走 libx264 的视频出口都认（含 m4v——它不在能力矩阵里，但在视频格式表里）',
    ['mp4', 'mkv', 'mov', 'm4v', 'avi'].every((t) => supportsQuality(t))
  )
  check(
    '判据：webm / gif 不认（前者走 VP9 的 CRF 是另一条尺子，后者走调色板滤镜）',
    !supportsQuality('webm') && !supportsQuality('gif')
  )
  check(
    '判据：大小写不敏感（界面上的扩展名统一小写，但别赌这件事）',
    supportsQuality('MP4') && !supportsQuality('WEBM')
  )
  check(
    '判据：非视频类别一律不认',
    !supportsQuality('mp3') && !supportsQuality('png') && !supportsQuality('pdf')
  )
  // ⚠️ 漂移守卫：能力矩阵里 `mp4 → xxx` 能选到的每一个视频出口，要么认质量档、
  // 要么在下面这份**显式**的豁免名单里。将来往矩阵里加一个新视频出口时，
  // 忘了改 `supportsQuality` 的话这条会红——否则那种缺失没人会想到去查。
  const qualityExempt = new Set(['webm', 'gif'])
  const videoExits = targetsFor('mp4').filter((t) => categoryOf(t) === 'video')
  check(
    '判据：能力矩阵里的视频出口与 supportsQuality 不漂移',
    videoExits.length > 0 && videoExits.every((t) => qualityExempt.has(t) || supportsQuality(t)),
    videoExits.join(',')
  )

  /* ---- 文案 ---- */

  check(
    '摘要：质量档三种组合各自的写法',
    describeQuality({ crf: 18 }) === 'CRF 18' &&
      describeQuality({ preset: 'slow' }) === '预设 slow' &&
      describeQuality({ tune: 'grain' }) === '调优 grain',
    describeQuality({ crf: 18, preset: 'slow', tune: 'grain' })
  )
  check(
    '摘要：三项一起时按 crf → preset → tune 拼（与 TaskOptions 的声明顺序一致）',
    describeQuality({ crf: 18, preset: 'slow', tune: 'grain' }) ===
      'CRF 18 · 预设 slow · 调优 grain'
  )
  check(
    '摘要：质量档排在输出约束之后（describeOptions 的顺序是字段声明顺序）',
    describeOptions({
      trim: { start: 1, end: 3, mode: 'exact' },
      quality: { crf: 18 },
      filters: []
    }) === '裁 1.0s–3.0s · 精确 · CRF 18',
    describeOptions({ trim: { start: 1, end: 3, mode: 'exact' }, quality: { crf: 18 } }) ?? ''
  )
  check(
    '判据：canUseQuality 只对视频为真，且 hasAnyOptions 认它',
    canUseQuality('video') &&
      !canUseQuality('audio') &&
      !canUseQuality('image') &&
      hasAnyOptions('video')
  )

  /* ---- 处理链：判别式联合与逐动作校验 ---- */

  const goodResize = {
    kind: 'resize' as const,
    width: 1920,
    height: 1080,
    fit: 'inside' as const,
    withoutEnlargement: true
  }
  check('契约：resize 动作收一份完整的', resizeActionSchema.safeParse(goodResize).success)
  check(
    '契约：IMAGE_FITS 里每一档都真的能被 schema 收下（两个常量不许漂移）',
    IMAGE_FITS.every((f) => resizeActionSchema.safeParse({ ...goodResize, fit: f }).success),
    IMAGE_FITS.join(',')
  )
  check(
    '契约：未知的 fit 被拒',
    !resizeActionSchema.safeParse({ ...goodResize, fit: 'stretch' }).success
  )
  // ⚠️ 这一条是这批参数里最承重的一条：sharp 自己的默认是「放大」，而
  // 「长边 1920 把 800px 的图拉大成 1920」是用户要的反面，且不报错。
  // 所以 `withoutEnlargement` 是**必填**——省略它必须是一个 schema 错误，
  // 而不是一个静默的错误结果。
  check(
    '契约：withoutEnlargement 必填（省略即取错默认值那条路要堵死）',
    !resizeActionSchema.safeParse({ kind: 'resize', width: 1920, height: 1080, fit: 'inside' })
      .success
  )
  check('契约：fit 必填', !resizeActionSchema.safeParse({ ...goodResize, fit: undefined }).success)
  // ⚠️ 判别键必须是**字面量**。写成 `z.string()` 的话「这一步到底是不是 resize」就答不上来，
  // 校验会退化成「看它有没有 width」——而那种判据对拼错的字段名是静默的。
  check(
    '契约：kind 不是 resize 的动作被拒（判别键是字面量，不是任意字符串）',
    !resizeActionSchema.safeParse({ ...goodResize, kind: 'denoise' }).success
  )
  check(
    '契约：宽高一个都不给被拒（那是一条什么都不做的空转步骤）',
    !resizeActionSchema.safeParse({ kind: 'resize', fit: 'inside', withoutEnlargement: true })
      .success
  )
  check(
    '契约：只给一个维度合法',
    resizeActionSchema.safeParse({
      kind: 'resize',
      width: 1920,
      fit: 'inside',
      withoutEnlargement: true
    }).success
  )
  check(
    '契约：尺寸上限本身通过、超过被拒',
    resizeActionSchema.safeParse({ ...goodResize, width: MAX_IMAGE_DIM }).success &&
      !resizeActionSchema.safeParse({ ...goodResize, width: MAX_IMAGE_DIM + 1 }).success
  )
  check(
    '契约：多给一个字段被拒',
    !resizeActionSchema.safeParse({ ...goodResize, extra: 1 }).success
  )
  check(
    '契约：联合只认已登记的动作——把一个没实现的动作塞进去会被拒',
    !filterActionSchema.safeParse({ kind: 'upscale', scale: 2 }).success
  )

  /* ---- setOptions 载荷：三块并存 ---- */

  const fullOptions = {
    trim: { start: 1, end: 2, mode: 'lossless' as const },
    output: { targetBytes: 10 * 1024 * 1024 },
    filters: [goodResize]
  }
  check(
    '契约：三块参数可以同时出现在一份载荷里',
    setOptionsSchema.safeParse({ id: setId, options: fullOptions }).success
  )
  check(
    '契约：嵌套的坏 output 被拒（不是只有顶层严）',
    !setOptionsSchema.safeParse({
      id: setId,
      options: { output: { targetBytes: 1024 * 1024, bitrateKbps: 8000 } }
    }).success
  )
  check(
    '契约：嵌套的坏动作被拒',
    !setOptionsSchema.safeParse({
      id: setId,
      options: { filters: [{ kind: 'resize', fit: 'inside', withoutEnlargement: true }] }
    }).success
  )
  check(
    '契约：处理链长度上限本身通过（边界不能一并拒掉）',
    setOptionsSchema.safeParse({
      id: setId,
      options: { filters: Array(MAX_FILTER_ACTIONS).fill(goodResize) }
    }).success
  )
  check(
    '契约：处理链超过上限被拒',
    !setOptionsSchema.safeParse({
      id: setId,
      options: { filters: Array(MAX_FILTER_ACTIONS + 1).fill(goodResize) }
    }).success
  )
  check(
    '契约：setOptions 载荷不认识的参数项被拒（.strict() 挡住了拼错的键名）',
    !setOptionsSchema.safeParse({ id: setId, options: { size: { targetBytes: 1024 } } }).success
  )

  /* ---- 新参数的判据（逐类遍历，与主进程读的是同一份）---- */

  const sizable = CATEGORIES.filter(canOutputSize)
  check(
    '判据：视频 / 音频 / 图片能设输出约束（逐类遍历）',
    sizable.join(',') === 'video,audio,image',
    sizable.join(',')
  )
  const filterable = CATEGORIES.filter(canFilter)
  check(
    '判据：视频 / 音频 / 图片能带处理链（文档、电子书、压缩包没有「像素」也没有「音轨」）',
    filterable.join(',') === 'video,audio,image',
    filterable.join(',')
  )

  // ⚠️ canFilter 只说「这一类有没有链」，**每一项动作还有自己的适用范围**。
  // 两张表分开测：合成一张的话，将来放宽判据时会把「哪一步放得下」一起放宽。
  const acts: readonly FilterAction[] = [
    { kind: 'resize', width: 100, fit: 'inside', withoutEnlargement: true },
    { kind: 'deinterlace', method: 'yadif' },
    { kind: 'denoise', strength: 'medium' },
    { kind: 'sharpen', amount: 1 },
    { kind: 'loudnorm', targetLufs: -14 },
    { kind: 'rotate', degrees: 90 }
  ]
  const allowedFor = (category: Category): string =>
    acts
      .filter((action) => canUseAction(action, category))
      .map((action) => action.kind)
      .join(',')
  check(
    '判据：视频能吃下全部六种动作',
    allowedFor('video') === 'resize,deinterlace,denoise,sharpen,loudnorm,rotate',
    allowedFor('video')
  )
  check(
    '判据：图片只吃 resize 与 rotate（隔行 / 降噪 / 锐化 / 响度在静图上没有意义）',
    allowedFor('image') === 'resize,rotate',
    allowedFor('image')
  )
  check('判据：音频只吃响度（它没有像素）', allowedFor('audio') === 'loudnorm', allowedFor('audio'))
  check(
    '判据：文档 / 电子书 / 压缩包一个动作都不吃',
    (['document', 'ebook', 'archive'] as Category[]).every((c) => allowedFor(c) === '')
  )

  // 摘要那一行在队列卡与历史页上共用；新增动作没补分支时 default 的 never 会编译报错。
  check(
    '摘要：五个新动作各有一句可读文案',
    describeAction({ kind: 'deinterlace', method: 'bwdif' }) === '去隔行（bwdif）' &&
      describeAction({ kind: 'denoise', strength: 'strong' }) === '降噪（重）' &&
      describeAction({ kind: 'sharpen', amount: 1.5 }) === '锐化 1.5' &&
      describeAction({ kind: 'loudnorm', targetLufs: -14 }) === '响度 -14 LUFS' &&
      describeAction({ kind: 'rotate', degrees: 90 }) === '旋转 90°'
  )
  // 顺序承重的那一组（RESEARCH §4.1：去隔行 → 降噪 → 锐化，反了会把噪点一起锐化出来）。
  // 判据**不强制顺序**（用户可能有自己的理由），但**念出来的必须与执行顺序一致**，
  // 否则界面上没法核对自己设了什么。
  check(
    '摘要：去隔行 → 降噪 → 锐化 照数组顺序念，步间用 → 分隔',
    describeFilters([
      { kind: 'deinterlace', method: 'yadif' },
      { kind: 'denoise', strength: 'medium' },
      { kind: 'sharpen', amount: 1 }
    ]) === '去隔行（yadif） → 降噪（中） → 锐化 1'
  )
  const withOptions = CATEGORIES.filter(hasAnyOptions)
  check(
    '判据：「参数」按钮只对视频 / 音频 / 图片出现（文档、电子书、压缩包没有参数）',
    withOptions.join(',') === 'video,audio,image',
    withOptions.join(',')
  )

  /* ---- withOption：三块面板各交各的那一份会互相抹掉 ---- */

  const base = { trim: { start: 1, end: 2, mode: 'exact' as const } }
  const mergedOutput = withOption(base, { output: { targetBytes: 1024 * 1024 } })
  check(
    '组装：加一项参数不会碰其他项（这是三块面板能并存的前提）',
    mergedOutput?.trim?.start === 1 && mergedOutput?.output?.targetBytes === 1024 * 1024,
    JSON.stringify(mergedOutput)
  )
  check(
    '组装：删一项参数不会碰其他项',
    withOption(mergedOutput, { trim: undefined })?.output?.targetBytes === 1024 * 1024 &&
      withOption(mergedOutput, { trim: undefined })?.trim === undefined
  )
  check(
    '组装：删光之后回 undefined 而不是 {}（「没有参数」只有一种表示）',
    withOption(base, { trim: undefined }) === undefined
  )
  check(
    '组装：没有参数时加一项也能用',
    withOption(undefined, { output: { bitrateKbps: 8000 } })?.output?.bitrateKbps === 8000
  )
  check(
    '组装：不改动传进来的那一份（面板拿的是 store 里的 task.options）',
    base.trim.start === 1 && Object.keys(base).length === 1,
    JSON.stringify(base)
  )
  // 处理链是**数组**，而 `withOption` 是浅拷贝——整条链换掉是替换，不是合并。
  // 这条钉住的是「面板交出一整条新链」这个约定：交半条会静默丢掉剩下的步骤。
  check(
    '组装：处理链整体替换（不是追加、也不是合并）',
    (() => {
      const withChain = withOption(base, { filters: [goodResize] })
      const replaced = withOption(withChain, {
        filters: [{ kind: 'resize', width: 800, fit: 'inside', withoutEnlargement: true }]
      })
      const first = replaced?.filters?.[0]
      return replaced?.filters?.length === 1 && first?.kind === 'resize' && first.width === 800
    })()
  )

  /* ---- 摘要把三块拼成同一句话 ---- */

  check(
    '摘要：只设了目标体积（整句钉死，见 describeOutput）',
    describeOptions({ output: { targetBytes: 10 * 1024 * 1024 } }) === '目标体积 10.0 MB',
    describeOptions({ output: { targetBytes: 10 * 1024 * 1024 } }) ?? 'null'
  )
  check(
    '摘要：码率带 kbps 单位（单位混掉的表现是产物大一千倍而「转换成功」）',
    describeOptions({ output: { bitrateKbps: 8000 } }) === '码率 8000kbps',
    describeOptions({ output: { bitrateKbps: 8000 } }) ?? 'null'
  )
  check(
    '摘要：缩放（inside 不带方位词，只写尺寸）',
    describeOptions({ filters: [goodResize] }) === '缩到 1920×1080 · 不放大',
    describeOptions({ filters: [goodResize] }) ?? 'null'
  )
  check(
    '摘要：cover 要写明会裁切',
    describeOptions({ filters: [{ ...goodResize, fit: 'cover' }] }) ===
      '缩到 1920×1080 · 裁切填满 · 不放大',
    describeOptions({ filters: [{ ...goodResize, fit: 'cover' }] }) ?? 'null'
  )
  check(
    '摘要：不放大关掉时不提它（那句话在用户没要它的时候是噪音）',
    describeOptions({ filters: [{ ...goodResize, withoutEnlargement: false }] }) ===
      '缩到 1920×1080',
    describeOptions({ filters: [{ ...goodResize, withoutEnlargement: false }] }) ?? 'null'
  )
  check(
    '摘要：只给一个维度时说清是哪个，且「不放大」照旧要提（它与维度个数无关）',
    describeOptions({
      filters: [{ kind: 'resize', width: 1920, fit: 'inside', withoutEnlargement: true }]
    }) === '缩到宽 1920 · 不放大' &&
      describeOptions({
        filters: [{ kind: 'resize', height: 1080, fit: 'inside', withoutEnlargement: true }]
      }) === '缩到高 1080 · 不放大'
  )
  // 没填高度时 sharp 把 cover/fill 都当 inside，摘要却写「裁切填满」的话，
  // 用户会去找一个根本不会发生的裁切。
  check(
    '摘要：只给一个维度时不提「裁切填满 / 拉伸」（那两个词只对「框」有意义）',
    describeOptions({
      filters: [{ kind: 'resize', width: 1920, fit: 'cover', withoutEnlargement: true }]
    }) === '缩到宽 1920 · 不放大' &&
      describeOptions({
        filters: [{ kind: 'resize', height: 1080, fit: 'fill', withoutEnlargement: true }]
      }) === '缩到高 1080 · 不放大'
  )
  // 处理链的摘要按**数组顺序**念，用 ` → ` 而不是 ` · `——那一串讲的是先后。
  check(
    '摘要：处理链按数组顺序念，步与步之间用 → 而不是 ·',
    describeOptions({
      filters: [goodResize, { kind: 'resize', width: 800, fit: 'inside', withoutEnlargement: true }]
    }) === '缩到 1920×1080 · 不放大 → 缩到宽 800 · 不放大',
    describeOptions({
      filters: [goodResize, { kind: 'resize', width: 800, fit: 'inside', withoutEnlargement: true }]
    }) ?? 'null'
  )
  check(
    '摘要：三块拼成一句（顺序固定：裁剪 → 处理链 → 输出约束）',
    describeOptions(fullOptions) ===
      '裁 1.0s–2.0s · 无损（起点对齐关键帧） · 缩到 1920×1080 · 不放大 · 目标体积 10.0 MB',
    describeOptions(fullOptions) ?? 'null'
  )
}

function testOfficeFamilies(): void {
  console.log('\n[8] office 族出口（LibreOffice 同族约束）')

  const sortedEq = (got: readonly string[], want: readonly string[]): boolean => {
    const a = [...got].sort()
    const b = [...want].sort()
    return a.length === b.length && a.every((v, i) => v === b[i])
  }

  // ---- 逐行钉死族表（排序后比较，不依赖顺序）----
  for (const [ext, want] of Object.entries(OFFICE_FAMILY_EXPECT)) {
    const got = targetsFor(ext)
    check(
      `${ext} 的出口恰好是 [${want.join(', ')}]`,
      sortedEq(got, want),
      `得到 [${got.join(', ')}]`
    )
  }

  // ---- 旧表宣称过的 19 个跨族组合，一个都不能回来 ----
  // ⚠️ 「不应包含 X」型断言必须带前置条件：`targetsFor` 返回空数组时
  // `!includes(…)` 恒为真，那条断言会同时告诉我们「一切正常」和「什么都没有」。
  for (const [from, to] of CROSS_FAMILY) {
    const got = targetsFor(from)
    check(
      `跨族 ${from} → ${to} 不该被宣称`,
      got.length > 0 && !got.includes(to),
      got.length === 0 ? `${from} 现在一个目标都没有了` : `得到 [${got.join(', ')}]`
    )
  }

  // ---- 族表与 OFFICE_BINARY_SRC 不漂移 ----
  // 后者现在是从 `Object.keys(OFFICE_FAMILIES)` 派生的，所以这条恒真；
  // 它盯的是**将来有人把 Set 改回字面量**——那时改族表却漏改 Set 就会红。
  // 这正是 docs/NOTES.md 约束 11 记的那次「套娃格式要改两处，只改一处等于没改」。
  const drifted: string[] = []
  for (const ext of Object.keys(OFFICE_FAMILY_EXPECT)) {
    for (const to of targetsFor(ext)) {
      const engine = engineFor(ext, to)
      if (engine !== 'libreoffice') drifted.push(`${ext}→${to}=${engine}`)
    }
  }
  check(
    '每个 office 源的每个出口都由 libreoffice 路由（族表与 Set 不漂移）',
    drifted.length === 0,
    drifted.join(',')
  )

  // ---- txt 是 Writer 专属出口 ----
  // 单独一钉：它是那张假表里最像真的一个（`txt` 看着"什么都能转"），
  // 而实测 `xls/ods → txt` 同样是 no export filter。
  const calc = ['xls', 'ods']
  const leaked = calc.filter((e) => targetsFor(e).includes('txt'))
  check(
    'txt 是 Writer 专属出口（xls/ods 都不含 txt）',
    calc.every((e) => targetsFor(e).length > 0) && leaked.length === 0,
    leaked.length > 0 ? `仍在宣称：${leaked.join(',')}` : ''
  )
}

// ---------------------------------------------------- 配置文件读不动（审计 §3.10）

/**
 * `jsonStore` 的「留档 + 不覆盖」行为。
 *
 * 为什么值得单列一节：这条链路的失败**在界面上完全看不出来**。原实现是
 * 「解析失败 → 返回默认值 → `dirty = false`」，于是那份坏文件躺在那儿等着被
 * 下一次 `set()` 覆盖——审计实测：截断的 `settings.json` 让 12 项设置静默变默认，
 * 而用户改任意一个开关就把原始数据**永久**抹掉了。
 *
 * ⚠️ **fsync 是用「替换 `fs.fsyncSync`」观测的**，不是「读源码确认写了 fsync」：
 * fsync 本身没有可观测的副作用（那正是它的用途），所以只能看它有没有被调用。
 * 这一步只在本节内生效，出函数立刻还原。
 * （`(await import('fs')).default` 就是 `require('fs')` 那个对象本身，
 * 与 `jsonStore` 内部用的是同一个——`import { fsyncSync } from 'fs'` 那种命名导入
 * 是只读的，往它上面赋值会直接抛。）
 */
async function testConfigFileCorruption(): Promise<void> {
  console.log('\n[9] 配置文件读不动：留档 + 不被覆盖（审计 §3.10）')

  const fsSync = await import('fs')
  const fsp = await import('fs/promises')
  const os = await import('os')
  const path = await import('path')

  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'arbiter-corrupt-'))

  // 先装 fsync 的观测点，再 import 被测模块：esbuild 把 `import { fsyncSync }`
  // 编成属性访问，所以两种落法（调用时取属性 / 导入时解构）都在这一句之后。
  const realFs = fsSync.default
  const originalFsync = realFs.fsyncSync
  let fsyncCalls = 0
  realFs.fsyncSync = ((...args: unknown[]) => {
    fsyncCalls += 1
    return (originalFsync as (...a: unknown[]) => unknown)(...args)
  }) as unknown as typeof realFs.fsyncSync

  try {
    const { createJsonStore } = await import('../src/main/core/jsonStore')

    interface Fake {
      maxConcurrent?: number
    }
    const makeStore = (file: string): ReturnType<typeof createJsonStore<Fake>> =>
      createJsonStore<Fake>({
        file,
        // 与 core/settings.ts 同一形状：认不出形状返回 null（「这份数据整体不可用」）
        parse: (raw) =>
          raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Fake) : null,
        serialize: (value) => ({ version: 1, ...value }),
        initial: () => ({ maxConcurrent: 4 })
      })

    const backupsOf = (dir: string, prefix: string): string[] =>
      fsSync.readdirSync(dir).filter((n) => n.startsWith(prefix))

    // ---- 场景 1：半截 JSON（硬关机 / 掉电留下的那种）----
    const file = path.join(root, 'settings.json')
    const original = '{"maxConcurrent": 2, "onConf'
    fsSync.writeFileSync(file, original, 'utf8')

    const store = makeStore(file)
    check('损坏的文件不吃掉启动：退回默认值', store.loadSync().maxConcurrent === 4)

    const backups = backupsOf(root, 'settings.json.corrupt-')
    check(
      '原文件被改名留档（settings.json.corrupt-<时间戳>）',
      backups.length === 1 && !fsSync.existsSync(file),
      `目录里是 [${fsSync.readdirSync(root).join(', ')}]`
    )
    check(
      '留档那一份与原文**逐字节相同**（留档不许顺手格式化一遍）',
      backups.length === 1 && fsSync.readFileSync(path.join(root, backups[0]), 'utf8') === original
    )
    const notice = store.lastCorruption()
    check(
      '留档信息问得出来：路径 + 原因（界面要显示的就是它）',
      notice !== null &&
        notice.quarantinePath === path.join(root, backups[0] ?? '') &&
        notice.reason.length > 0,
      JSON.stringify(notice)
    )

    // 审计里最狠的那一条：坏文件之后用户改一个设置，整份旧数据就永久没了。
    store.set({ maxConcurrent: 8 })
    store.flushSync()
    check(
      '后续写盘**不会**覆盖留档，也不会留下 .tmp（这正是修复点）',
      backupsOf(root, 'settings.json.corrupt-').length === 1 &&
        fsSync.existsSync(path.join(root, backups[0])) &&
        !fsSync.existsSync(`${file}.tmp`)
    )
    const rewritten = JSON.parse(fsSync.readFileSync(file, 'utf8')) as { maxConcurrent: number }
    check('写盘本身仍然是对的（新文件是合法 JSON，值也对）', rewritten.maxConcurrent === 8)

    // ---- 场景 2：合法 JSON、但形状不认识 ----
    // 只按「JSON.parse 抛没抛」判损坏是不够的：手改成 `[1,2,3]` 或 `null` 同样让
    // 设置全回到默认，而那种文件在语法上完全合法。
    const file2 = path.join(root, 'history.json')
    fsSync.writeFileSync(file2, '[1,2,3]', 'utf8')
    const store2 = makeStore(file2)
    store2.loadSync()
    check(
      '形状不认识也走留档（不只是语法错才算坏）',
      backupsOf(root, 'history.json.corrupt-').length === 1 && !fsSync.existsSync(file2)
    )

    // ---- 场景 3 / 4：别误伤 ----
    const file3 = path.join(root, 'ok.json')
    fsSync.writeFileSync(file3, '{"maxConcurrent": 2}', 'utf8')
    const store3 = makeStore(file3)
    check(
      '好文件照常读出来，且不留档、不报损坏',
      store3.loadSync().maxConcurrent === 2 &&
        store3.lastCorruption() === null &&
        backupsOf(root, 'ok.json.corrupt-').length === 0
    )

    const store4 = makeStore(path.join(root, 'missing.json'))
    store4.loadSync()
    check('文件不存在 ≠ 损坏（不该凭空报一条留档）', store4.lastCorruption() === null)

    // ---- 场景 5：写盘之前 fsync ----
    const file5 = path.join(root, 'fsync.json')
    fsyncCalls = 0
    const store5 = makeStore(file5)
    store5.loadSync()
    store5.set({ maxConcurrent: 3 })
    store5.flushSync()
    check(
      '写 .tmp 之后、rename 之前对那个 fd fsync（掉电才不至于留下半截 JSON）',
      fsyncCalls >= 1,
      `fsync 调用 ${fsyncCalls} 次`
    )
  } finally {
    realFs.fsyncSync = originalFsync
    await fsp.rm(root, { recursive: true, force: true }).catch(() => undefined)
  }
}

// ---------------------------------------------- 清理失败不顶替原因（审计 §3.11）

/**
 * `removeTempDirQuietly`：临时目录清理失败时**不抛出**。
 *
 * 被它救的是「用户看到的是哪句话」：`finally` 里的裸 `rm` 一旦抛，7-Zip / pandoc
 * 的原话就被 `EPERM: operation not permitted, rmdir '…'` 顶掉了，而那时候
 * 「转换为什么失败」已经查不回来。
 *
 * ## 场景怎么造的
 *
 * 「临时目录被占着」在 Windows 上有一种**可靠且不需要起子进程**的造法：
 * 让这个目录成为某个进程的当前目录——`RemoveDirectory` 会以 EBUSY 拒绝。
 * 于是本进程 `chdir` 进去就够了。
 *
 * ⚠️ 下面第 1 条断言是**前提**，不是装饰：它证明「这个目录真的删不掉」。
 * 少了它，第 2 条在「目录其实删得掉」的环境里会恒真——本项目已经因此抓到过
 * 四条装饰性断言。第 4 条反过来钉住「锁只来自 cwd」：恢复 cwd 之后它必须能删掉。
 */
async function testTempDirCleanup(): Promise<void> {
  console.log('\n[10] 临时目录清理失败：不顶替真正的失败原因（审计 §3.11）')

  const fsSync = await import('fs')
  const fsp = await import('fs/promises')
  const os = await import('os')
  const path = await import('path')

  // ⚠️ 本文件头那段注释讲的正是这件事：`npm run test:core` 没带 `--tsconfig`，
  // 所以 `@shared/*` 在默认 tsconfig.json（只有 references）里不存在，而
  // `converters/archive.ts` 会 import 它。补一个解析钩子，只影响本节的动态 import。
  // 基准目录先算成绝对路径，别留到 `chdir` 之后再解析。
  const sharedDir = resolve('src/shared')
  const { registerHooks } = await import('node:module')
  registerHooks({
    resolve(specifier, context, next) {
      if (!specifier.startsWith('@shared/')) return next(specifier, context)
      return next(path.resolve(sharedDir, `${specifier.slice('@shared/'.length)}.ts`), context)
    }
  })

  const { removeTempDirQuietly } = await import('../src/main/converters/archive')

  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'arbiter-locked-'))
  const before = process.cwd()
  fsSync.writeFileSync(path.join(dir, 'a.txt'), 'x', 'utf8')
  process.chdir(dir)
  try {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined)
    check(
      '前提：这个目录真的删不掉（删得掉的话下面两条就是空转）',
      fsSync.existsSync(dir),
      'cwd 竟然可以被删掉？本节场景没造出来'
    )

    let thrown: unknown = null
    try {
      await removeTempDirQuietly(dir)
    } catch (error) {
      thrown = error
    }
    check(
      '清理失败时包装不抛（EPERM 顶替不掉 7-Zip / pandoc 的原话）',
      thrown === null,
      String(thrown)
    )
    check(
      '而它也没假装删掉了：目录还在原地（「静默成功」同样是要防的那类错）',
      fsSync.existsSync(dir)
    )
  } finally {
    process.chdir(before)
  }

  await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined)
  check('收尾：cwd 恢复之后同一个目录能删掉（证明锁只来自 cwd）', !fsSync.existsSync(dir))
}

// ------------------------------------------- 图片目标的两处豁免（审计 §3.4）

/**
 * 图片目标里**做不到**的那两格（`bmp` / `ico`）。
 *
 * 这两格只有 ffmpeg 那条路能兑现（sharp 写不出来，见 `SHARP_IMAGE_TARGETS`），
 * 所以只要一个源的像素进不了 ffmpeg，它们就是空的。三个源符合这个条件，
 * 而原因**完全不同**（别当成同一件事）：
 *   - `heic` / `heif`：HEVC 系 HEIC 的容器 ffmpeg 解不开（报 `moov atom not found`），
 *     像素只有 WASM 版 libheif 拿得到；
 *   - `svg`：ffmpeg 的输入侧**根本没有 svg 解码器**——这条正是审计 §3.4 那个洞。
 *
 * 判据分三层：能力矩阵不列它、`engineFor` 对它返回 null、以及**实测**（本节末尾
 * 真跑一遍随包的 ffmpeg）。中间那一层是必须的，不是重复：只把目标从列表里拿掉的话，
 * 从 MCP 的 `convert_file` / `--to` 那条路进来的请求仍会路由给 ffmpeg，
 * 然后在用户那边以一句 `no decoder found for: svg` 失败——**而且没有任何提示说
 * 「这个组合本来就不支持」**（ffmpeg 是自带引擎，`requiresDownload()` 返回 null）。
 */
const NO_BMP_ICO_SRC = ['heic', 'heif', 'svg']

/**
 * 实测**能**出 bmp / ico 的图片源，用来钉住「豁免不是一把大伞」。
 *
 * 这份名单是量出来的，不是抄的：同一份 64×48 的源、随包的 `ffmpeg-static` +
 * `buildFfmpegArgs` 的真实参数，这些源 → `bmp` / `ico` 两个目标**全都成功**
 * （`png → bmp` 12342 字节、`png → ico` 12776 字节，其余同量级）。
 *
 * ⚠️ 这里没有 `bmp`：`targetsFor` 会滤掉 `to === from`（`bmp → bmp` 没有意义），
 * 那是另一条断言（「没有任何源格式的合法目标包含它自己」）在管的事。
 */
const BMP_ICO_OK_SRC = ['png', 'jpg', 'webp', 'gif', 'ico', 'tiff', 'avif']

async function testImageTargetExclusions(): Promise<void> {
  console.log('\n[11] 图片目标的两处豁免：svg / HEIF 的 bmp / ico（审计 §3.4）')

  for (const src of NO_BMP_ICO_SRC) {
    const targets = targetsFor(src)
    // ⚠️ 下面两条是「不包含 X」型断言：`targetsFor` 返回空数组时它们恒为真。
    // 所以每一条都带一个非空前置条件——本仓已经因此抓到过空集合上恒真的装饰性断言。
    check(`${src} 至少还有一个目标（下面那条的前置条件）`, targets.length > 0, targets.join(','))
    check(
      `${src} 不列出必然失败的 bmp / ico`,
      targets.length > 0 && !targets.includes('bmp') && !targets.includes('ico'),
      targets.join(',')
    )
  }

  // 豁免的**另一头**：把这三个源的目标砍空也能让上面两条变绿，所以逐条钉住其余出口。
  const svg = targetsFor('svg')
  const svgWant = ['png', 'jpg', 'webp', 'avif', 'tiff', 'gif', 'pdf']
  check(
    'svg 的其余出口一个不少（六个 sharp 目标 + pdf）',
    svgWant.every((t) => svg.includes(t)),
    svg.join(',')
  )
  check(
    'svg → jpg 仍路由给 sharp，svg → pdf 仍路由给 pdf 引擎',
    engineFor('svg', 'jpg') === 'sharp' && engineFor('svg', 'pdf') === 'pdf',
    `${engineFor('svg', 'jpg')} / ${engineFor('svg', 'pdf')}`
  )

  // 路由层也要挡住：目标列表只管 UI 那一侧的下拉，MCP 那条路不读它。
  check(
    'svg → bmp / svg → ico 的路由是 null（而不是 ffmpeg——那会在用户选完之后才失败）',
    engineFor('svg', 'bmp') === null && engineFor('svg', 'ico') === null,
    `${engineFor('svg', 'bmp')} / ${engineFor('svg', 'ico')}`
  )

  // 反向：豁免只该罩住那三个源，顺手放宽是错的（那些组合真的能跑）。
  const wronglyExempt = BMP_ICO_OK_SRC.filter((s) => !targetsFor(s).includes('bmp'))
  check(
    '其余图片源仍然列着 bmp（豁免没有顺手收紧/放宽）',
    wronglyExempt.length === 0,
    wronglyExempt.join(',')
  )

  // ---- 实测：随包的那个 ffmpeg 到底解不解 svg ----
  //
  // 上面那些是**结构判据**（矩阵是怎么写的），这一段回答「事实是什么」：
  // 哪天换了 ffmpeg-static 的版本，这条会先告诉你能不能把豁免撤掉。
  await mkdir(TMP, { recursive: true })
  const svgPath = resolve(TMP, 'probe.svg')
  const bmpFromSvg = resolve(TMP, 'probe-from-svg.bmp')
  const bmpFromPng = resolve(TMP, 'probe-from-png.bmp')
  const pngPath = resolve(TMP, 'probe.png')

  await writeFile(
    svgPath,
    '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="48">' +
      '<rect width="64" height="48" fill="#c81e3c"/></svg>',
    'utf8'
  )
  const madePng = await run([
    '-hide_banner',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'color=c=red:s=64x48',
    '-frames:v',
    '1',
    pngPath
  ])
  check('生成对照组 png（64×48）', madePng.code === 0, madePng.stderr.slice(-200))

  // 两个方向都用**应用自己的参数**（`buildFfmpegArgs`），不手写命令行：
  // 判据要落在「矩阵里这条路真的会失败」上，而不是「ffmpeg 大概不行」上。
  const svgRun = await run(buildFfmpegArgs(svgPath, bmpFromSvg, 'svg', 'bmp'))
  check(
    '随包的 ffmpeg 解不了 svg（实测：非零退出，且不产出文件）',
    svgRun.code !== 0 && !existsSync(bmpFromSvg),
    `code=${svgRun.code} ${svgRun.stderr.slice(-160)}`
  )
  check(
    '失败原因是「没有 svg 解码器」，而不是别的（换版本时这一条会说话）',
    /decoder/i.test(svgRun.stderr) && /svg/i.test(svgRun.stderr),
    svgRun.stderr.slice(-160)
  )
  const pngRun = await run(buildFfmpegArgs(pngPath, bmpFromPng, 'png', 'bmp'))
  check(
    '对照组：同一条命令 png → bmp 成功（所以红的是 svg，不是参数）',
    pngRun.code === 0 && existsSync(bmpFromPng),
    `code=${pngRun.code}`
  )
}

// ------------------------------------------------ 引擎看门狗（审计 §3.6）

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms))
}

/** 轮询等到条件成立或超时，返回最终是否成立 */
async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await sleep(50)
  }
  return predicate()
}

function processAlive(pid: number): boolean {
  try {
    // 信号 0 = 只做存在性检查：进程活着直接返回，进程没了抛 ESRCH（Windows 上实测同样成立）
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** 往 `node -e` 的脚本里嵌字符串：路径里有反斜杠，拼接会被吃坏 */
function scriptLiteral(value: string): string {
  return JSON.stringify(value)
}

/**
 * 引擎看门狗：到点必须**杀掉整棵进程树**，并给出一句能照着排查的原因。
 *
 * 为什么用人造的两层进程树当素材：真正的引擎没法在测试里「卡住」——pandoc 对任何
 * 输入都会退出，LibreOffice / Calibre 那两棵树要先装 1.5 GiB / 658 MB 的引擎。
 * 而看门狗与被测引擎之间只隔着一个 pid，所以这里造一棵同构的树（父进程 → 孙进程），
 * 用**孙进程还活着吗**来判 `taskkill /T` 有没有生效：只杀父进程的实现会让孙进程活下来
 * （那正是约束 3 说的孤儿进程，`soffice.bin` / `calibre-parallel.exe` 那个形状）。
 *
 * 时序是刻意的：**先确认树起来了，再 `arm()`**。生产代码里 `arm()` 紧跟着 `spawn()`，
 * 而这里要断言的是「表到点之后做了什么」；如果不等前置条件，`!processAlive(孙)` 会
 * 因为孙进程压根没起来而恒真——那正是本仓抓到过四次的空转断言。
 */
async function testEngineWatchdog(): Promise<void> {
  console.log('\n[12] 引擎看门狗：到点杀整棵进程树（审计 §3.6）')

  const dir = resolve(TMP, 'watchdog')
  await mkdir(dir, { recursive: true })
  const parentStarted = resolve(dir, 'parent-started.txt')
  const grandStarted = resolve(dir, 'grand-started.txt')
  const grandPidFile = resolve(dir, 'grand.pid')

  const grandScript = [
    `require('fs').writeFileSync(${scriptLiteral(grandStarted)}, 'started')`,
    `require('fs').writeFileSync(${scriptLiteral(grandPidFile)}, String(process.pid))`,
    // 万一没被杀掉，10 秒后自己走掉：测试不留孤儿（这 10 秒正是「还活着」那条
    // 判据的窗口，够 processAlive 读好几遍）
    'setTimeout(() => process.exit(0), 10000)',
    'setInterval(() => {}, 1000)'
  ].join(';')

  const parentScript = [
    `const { spawn } = require('child_process')`,
    `require('fs').writeFileSync(${scriptLiteral(parentStarted)}, 'started')`,
    `spawn(process.execPath, ['-e', ${scriptLiteral(grandScript)}], { stdio: 'ignore' })`,
    'setInterval(() => {}, 1000)'
  ].join(';')

  const parent = spawn(process.execPath, ['-e', parentScript], {
    windowsHide: true,
    stdio: 'ignore'
  })
  let parentClosed = false
  parent.on('close', () => {
    parentClosed = true
  })

  const treeUp = await waitUntil(() => existsSync(parentStarted) && existsSync(grandPidFile), 5000)
  const grandPid = treeUp ? Number(readFileSync(grandPidFile, 'utf8')) : 0
  check(
    '前置条件：两层进程树都起来了（父进程的 started + 孙进程的 pid）',
    treeUp && grandPid > 0,
    `treeUp=${treeUp} grandPid=${grandPid}`
  )
  check(
    '前置条件：孙进程此刻是活的（否则「它后来死了」这条恒真）',
    grandPid > 0 && processAlive(grandPid),
    String(grandPid)
  )

  // 300 ms：只够证明「表会响」，不必等真引擎那 5 分钟
  const watchdog = new EngineWatchdog({ label: '测试引擎', timeoutMs: 300 })
  watchdog.arm(parent.pid)

  const fired = await waitUntil(() => watchdog.expired, 5000)
  check('到点会翻 expired', fired)
  check(
    '原因可读：含引擎名与「引擎超时」，且不是一句退出码',
    watchdog.reason().every((line) => typeof line === 'string' && line.length > 0) &&
      watchdog.reason()[0].includes('测试引擎') &&
      watchdog.reason()[0].includes('引擎超时'),
    watchdog.reason()[0]
  )
  check(
    '原因说清了「与转换失败不同」与排查方向（不止一行）',
    watchdog.reason().length >= 3,
    String(watchdog.reason().length)
  )

  const parentGone = await waitUntil(() => parentClosed, 5000)
  check('父进程被真的杀掉（close 到了）', parentGone)
  const grandGone = await waitUntil(() => !processAlive(grandPid), 5000)
  check(
    '孙进程跟着一起死（taskkill /T 生效，不是只杀父进程）',
    grandPid > 0 && grandGone,
    grandGone ? '' : `孙进程 ${grandPid} 还活着`
  )

  // stop() 之后表必须不再走：否则一次早就结束的转换会在 5 分钟后凭空多杀一次 pid，
  // 而那个 pid 可能已经被系统回收给了别的进程。
  const noFire = new EngineWatchdog({ label: '测试引擎', timeoutMs: 200 })
  noFire.arm(parent.pid)
  noFire.stop()
  await sleep(400)
  check('stop() 之后表不会再走（expired 保持 false）', !noFire.expired)

  // ---- 接线守卫：三个 CLI runner + Chromium 渲染真的用上了看门狗 ----
  //
  // 这一条是**读源码**而不是跑行为，理由必须说清楚：真引擎没法在测试里卡住
  // （pandoc 对任何输入都会退出；LibreOffice / Calibre 要先装 1.5 GiB / 658 MB 的引擎，
  // 而且它们也不会因为我们希望就死循环），而 chromiumPdf 那条路只有在 Electron 里才跑得起来
  // （test:pdf）。上面那一节钉住的是**看门狗自己的行为**（到点杀树、给原因、stop 生效），
  // 这一节钉的是**三个 runner 有没有接上它**——没接上的话上一节照样全绿。
  // 它抓得住「把 arm / expired / stop 删掉」，抓不住「写错顺序」，那部分靠类型与评审。
  const wiring: Array<[string, string[]]> = [
    ['src/main/converters/pandocRun.ts', ['.arm(', '.expired', 'watchdog.reason()', '.stop()']],
    ['src/main/converters/libreoffice.ts', ['.arm(', '.expired', 'watchdog.reason()', '.stop()']],
    ['src/main/converters/calibre.ts', ['.arm(', '.expired', 'watchdog.reason()', '.stop()']],
    // chromiumPdf 没有子进程（卡死的是渲染），两条超时是：等槽位 + 渲染本身。
    // `waiting.splice` 是那个「等超时的人必须把自己从队列里摘掉」的承重细节。
    [
      'src/main/engines/chromiumPdf.ts',
      [
        'SLOT_WAIT_TIMEOUT_MS',
        'RENDER_TIMEOUT_MS',
        'Promise.race(',
        'clearTimeout(timer)',
        'waiting.splice'
      ]
    ]
  ]
  for (const [file, needles] of wiring) {
    const source = readFileSync(resolve(file), 'utf8')
    const missing = needles.filter((needle) => !source.includes(needle))
    check(
      `${file} 接上了看门狗 / 超时（要求出现 ${needles.join(' / ')}）`,
      missing.length === 0,
      missing.join(',')
    )
  }
}

// ---------------------------------------------------------------- 主流程

/**
 * 配方文件（R15）的**纯解析**。
 *
 * 这一节盯的全部是「配方是**不可信输入**」那一句话：它可能来自版本控制、
 * 可能来自别人分享的 Gist，可能手抖写错一个键名。三件事必须成立——
 * **不整份拒**（一个字段写错不该让另外那个能用的一起作废）、
 * **但一定要报**（默默用默认值顶上就是「以为设了其实没设」）、
 * **一个字段都没认出来时必须拒**（那种配方一定是错的）。
 */
function testRecipe(): void {
  console.log('\n[13] 配方文件（R15）')

  // ---- 正常路径 ----
  const full = parseRecipe({ target: 'mp4', mode: 'remux' })
  check(
    '两个字段都认得出，且一条问题都没有',
    full.recipe.target === 'mp4' && full.recipe.mode === 'remux' && full.problems.length === 0,
    JSON.stringify(full)
  )

  // 归一：三种写法都收成同一个（与 `core/cli.ts` 的 `normalizeExt` 同一套口径）
  check(
    'target 归一：`.MP4` / `MP4` / `.mp4` 都成 mp4',
    [' .MP4 ', 'MP4', '.mp4'].every((v) => parseRecipe({ target: v }).recipe.target === 'mp4')
  )

  check(
    'mode 三档都收',
    ['auto', 'remux', 'reencode'].every((m) => parseRecipe({ mode: m }).recipe.mode === m)
  )

  // ---- 逐字段宽容：这是整份模块的主旨 ----
  const partial = parseRecipe({ target: 'mp4', nope: 1, mode: 'bogus' })
  check(
    '⭐ 坏字段被报出来，**但好字段照样生效**（逐字段宽容，不是整份拒）',
    partial.recipe.target === 'mp4' &&
      partial.recipe.mode === undefined &&
      partial.problems.length === 2,
    JSON.stringify(partial)
  )
  check(
    '认不出的键名被点名（最常见的一种错，而它的表现是「配了没反应」）',
    partial.problems.some((p) => p.includes('nope')),
    partial.problems.join(' | ')
  )

  // ---- 各种坏输入 ----
  for (const [label, value] of [
    ['数组', []],
    ['字符串', 'mp4'],
    ['null', null],
    ['数字', 7]
  ] as const) {
    const parsed = parseRecipe(value)
    check(
      `顶层是${label} → 报出来，且不炸`,
      parsed.problems.length === 1 && isRecipeEmpty(parsed.recipe),
      JSON.stringify(parsed)
    )
  }

  check('target 不是字符串 → 报出来，不抛', parseRecipe({ target: 42 }).problems.length === 1)
  check(
    'target 形状不像扩展名（`a b` / `!!` / 空串）→ 报出来',
    ['a b', '!!', '', '  '].every((v) => parseRecipe({ target: v }).problems.length === 1)
  )
  check(
    'mode 不在闭集里（比如引擎内部那个 `force`）→ 报出来',
    parseRecipe({ mode: 'force' }).problems.length === 1
  )

  // ---- isRecipeEmpty 的两个方向 ----
  check(
    '空对象 → 没有 problems，但确实是空的（调用方据此拒）',
    (() => {
      const parsed = parseRecipe({})
      return parsed.problems.length === 0 && isRecipeEmpty(parsed.recipe)
    })()
  )
  check('反向：认出一个字段就不算空', !isRecipeEmpty(parseRecipe({ mode: 'auto' }).recipe))

  // ---- 一个反直觉但必须挡住的东西 ----
  // `JSON.parse('{"__proto__":{...}}')` 造出来的是**自有属性**而不是原型，
  // 但一个手写的解析器很容易在这里栽跟头（`for...in` 会把原型链上的东西也捞出来）。
  // 这里断的是：它被当成一个「认不出的字段」报出来，**且没有污染 Object.prototype**。
  const proto = parseRecipe(JSON.parse('{"__proto__":{"polluted":true},"target":"mp4"}'))
  check(
    '⭐ `__proto__` 只被当成一个认不出的字段，不污染原型',
    proto.recipe.target === 'mp4' &&
      proto.problems.length === 1 &&
      ({} as Record<string, unknown>).polluted === undefined,
    JSON.stringify(proto.recipe)
  )
}

/**
 * 编码质量档落成 ffmpeg 参数的样子。
 *
 * 这一节**不跑引擎**，判的是数组本身——`.part` 与并发那些行为在 `test-tasks.ts` 里。
 * 拆开的理由是这一层有一条最贵的回归：**省略质量档时必须与加这个参数之前逐字相同**。
 * 那是「没设过质量档的用户，产物一个字节都不该变」的全部保证，而它一旦破了，
 * 症状是**所有人的产物悄悄变了**——没有任何断言会自己发现这件事。
 */
function testQualityArgs(): void {
  console.log('\n[10] 编码质量档的参数构造')

  const build = (to: string, quality?: QualityOptions): string[] =>
    buildFfmpegArgs('D:\\in\\clip.mp4', `D:\\out\\clip.${to}`, 'mp4', to, { quality })

  /** 某个选项后面跟着的值；选项不存在时返回 `null`（而不是空串——空串分不出「没有」） */
  const valueOf = (args: string[], flag: string): string | null => {
    const at = args.indexOf(flag)
    return at < 0 ? null : (args[at + 1] ?? null)
  }

  // ★ **两份默认值不许漂**。`engines/ffmpeg.ts` 里那两个字面量与 `@shared/options`
  // 的同名常量是同一个事实的两份副本（前者不能 import 后者：本套件跑的是不带
  // `--tsconfig` 的裸 tsx，解析不了 `@shared/*`，理由写在引擎那一侧）。
  // 这一条就是那份「两份必须同时改」的守卫——没有它，改了一边没人会知道。
  // ★ 回归守卫：省略质量档 = 加这个参数之前的行为。
  // 否证：把 `x264Args` 里的 `DEFAULT_CRF` 改个数 / 把 `-preset` 去掉 → 这一条翻红。
  const plain = build('mp4')
  check(
    '省略质量档时参数与加这个参数之前逐字相同（-c:v libx264 -preset veryfast -crf 23）',
    valueOf(plain, '-c:v') === 'libx264' &&
      valueOf(plain, '-preset') === 'veryfast' &&
      valueOf(plain, '-crf') === '23' &&
      !plain.includes('-tune'),
    plain.join(' ')
  )
  // ★ **两份默认值不许漂**。`engines/ffmpeg.ts` 里那两个字面量与 `@shared/options`
  // 的同名常量是同一个事实的两份副本（前者不能 import 后者：本套件跑的是不带
  // `--tsconfig` 的裸 tsx，解析不了 `@shared/*`，理由写在引擎那一侧）。
  // 这一条就是那份「两份必须同时改」的守卫——没有它，改了一边没人会知道。
  check(
    '⭐ 引擎里的默认值 = @shared/options 的 DEFAULT_CRF / DEFAULT_PRESET',
    valueOf(plain, '-crf') === String(DEFAULT_CRF) && valueOf(plain, '-preset') === DEFAULT_PRESET,
    `引擎 ${valueOf(plain, '-preset')}/${valueOf(plain, '-crf')} · shared ${DEFAULT_PRESET}/${DEFAULT_CRF}`
  )

  const crfOnly = build('mp4', { crf: 18 })
  check(
    '只给 CRF：只有 -crf 变，预设仍是默认',
    valueOf(crfOnly, '-crf') === '18' && valueOf(crfOnly, '-preset') === 'veryfast'
  )
  check(
    '只给 CRF：CRF 为 0 时也要真的写在命令行上（别被 `?? 默认值` 当成缺省吃掉）',
    valueOf(build('mp4', { crf: 0 }), '-crf') === '0'
  )

  const presetOnly = build('mp4', { preset: 'slow' })
  check(
    '只给预设：只有 -preset 变',
    valueOf(presetOnly, '-preset') === 'slow' && valueOf(presetOnly, '-crf') === '23'
  )
  check(
    '调优：给了才出现 -tune，没给时那一对参数一个都不在',
    valueOf(build('mp4', { tune: 'film' }), '-tune') === 'film' && !plain.includes('-tune')
  )
  check(
    '三项一起给时都落在命令行上',
    (() => {
      const a = build('mp4', { crf: 20, preset: 'medium', tune: 'grain' })
      return (
        valueOf(a, '-crf') === '20' &&
        valueOf(a, '-preset') === 'medium' &&
        valueOf(a, '-tune') === 'grain'
      )
    })()
  )
  // ⚠️ 这条是「每个出口都接上了」的守卫，不是废话：`x264Args` 只挂在 `videoArgs` 的
  // default 与 avi 两格上，而视频出口有四个。少接一格的表现是那个出口静默忽略质量档。
  check(
    '每一个认质量档的视频出口都真的把三项写进了参数',
    ['mp4', 'mkv', 'mov', 'm4v', 'avi'].every((to) => {
      const a = build(to, { crf: 20, preset: 'medium', tune: 'grain' })
      return valueOf(a, '-crf') === '20' && valueOf(a, '-preset') === 'medium'
    })
  )
  // 反方向：webm 那一格**故意**看不见 quality（vp9 的 CRF 是另一条尺子）。
  // 拦它的是上游的 `supportsQuality()`，这里断的是「这一格确实没接」——
  // 接了才是错的：`-tune film` 会被 libvpx 静默忽略、`-preset` 根本没有这个选项。
  check(
    'webm 那一格刻意不接质量档（拦它的是 supportsQuality，不是这一层）',
    valueOf(build('webm', { crf: 18, preset: 'slow' }), '-crf') === '32'
  )
  // ---- 接线：`costOf` 必须把 task.options 传下去 ----
  //
  // 这是**结构性**判据（读源码），与 [12] 那几条「引擎接上了看门狗」同一种东西。
  // 为什么不做成行为判据：那要真排一批 veryslow 的大文件、量并发峰值，几十秒起步，
  // 而这里问的只是一句「那一行有没有写」。
  //
  // ⚠️ 少了它，`costOf` 忘记传 `task.options` 时**没有任何症状**：整本并发账按快档记，
  // 队列只是悄悄多放几条重编码进去，内存那堵墙迟早撞上，但没有任何地方会报错。
  const taskSrc = readFileSync(resolve('src/main/core/task.ts'), 'utf8')
  check(
    '接线：TaskManager.costOf 把 task.options 传给了 taskCost（漏了它整本账按快档记）',
    /taskCost\(\s*task\.engine\s*,\s*this\.inputBytes\.get\(task\.id\)\s*,\s*task\.options\s*\)/.test(
      taskSrc
    )
  )
  // 同理：`setOptions` 改完参数要换掉队列条目。慢预设改变了「占几份」，
  // 少了这一步那条排队中的任务在**别的任务眼里**还是轻的。
  //
  // 判据写成「那一句**恰好出现两次**」而不是「出现过」：`setTarget` 里本来就有一句
  // 一模一样的（换引擎桶），所以「出现过」在 `setOptions` 漏掉时照样绿。
  // 两份的措辞与缩进逐字相同，所以直接数出现次数是最稳的写法。
  const queueSwap = taskSrc.match(
    /if \(this\.queue\.remove\(id\)\) this\.queue\.push\(\{ id, engine: task\.engine, cost: this\.costOf\(task\) \}\)/g
  )
  check(
    '接线：队列条目在 setTarget **与** setOptions 两处都换掉（慢预设改变占几份）',
    queueSwap?.length === 2,
    `出现 ${queueSwap?.length ?? 0} 次`
  )

  // 质量档与码率目标互斥：上游已经拦过，这里再抛一次。静默挑一个的后果是
  // 「x264 回到质量模式、把 -b:v 只当上限」——产物体积与目标脱钩而任务报成功。
  check(
    '⭐ 质量档与码率目标同时给时抛错（不静默挑一个）',
    (() => {
      try {
        buildFfmpegArgs('D:\\in\\clip.mp4', 'D:\\out\\clip.mp4', 'mp4', 'mp4', {
          quality: { crf: 18 },
          target: { videoKbps: 2000 }
        })
        return false
      } catch {
        return true
      }
    })()
  )
}

async function main(): Promise<void> {
  console.log('=== 核心逻辑自测 ===')
  testSanitize()
  testProbeParsing()
  testProgressParser()
  testCapabilityMatrix()
  testIconIds()
  testSettingsContract()
  testOfficeFamilies()
  testTrimContract()
  testQualityArgs()
  await testRealConversion()
  await testImageTargetExclusions()
  await testEngineWatchdog()
  await testConfigFileCorruption()
  await testTempDirCleanup()
  testRecipe()

  await rm(TMP, { recursive: true, force: true }).catch(() => {})

  console.log(`\n=== 通过 ${passed} / 失败 ${failed} ===`)
  process.exit(failed === 0 ? 0 : 1)
}

void main()
