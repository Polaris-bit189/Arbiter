/**
 * 反证：把逐处承重逻辑改坏（`core/task.ts` 三处 + remux 判定两侧 + GPU 编码四处），确认
 * `scripts/test-tasks.ts` 里对应的断言真的会翻红。
 *
 * 用法：
 *   node scripts/falsify-tasks.mjs
 *   npm run falsify:tasks
 *
 * **为什么不塞进 `falsify-ui.mjs`**：那个脚本跑的是 `test-core.ts`（纯逻辑，根本不 import
 * `task.ts`）。把这几条变异放进去，锚点照样命中，可断言永远不会红——脚本会报「有断言没红」，
 * 也可能被人误读成「反证通过」。**变异的家必须是「跑得动被测代码的那个套件」。**
 *
 * 代价要说清楚：`test:tasks` 要真起 ffmpeg / sharp / 7zip 子进程，一轮好几分钟，
 * **九个变异就是十轮**（含基线）。所以它**不在 `npm run falsify` 的聚合里**——那条命令
 * 已经够慢了，而这里的变异点只在改过 `core/task.ts` / `core/queue.ts` / 编码参数之后才有意义。
 * 改动那几处之后单独跑这个；迭代单个变异时用 `--only=<子串>`。
 */
import { spawnSync } from 'child_process'
import { createHash } from 'crypto'
import { readFileSync, writeFileSync } from 'fs'
import { resolve } from 'path'

const TASK = resolve('src/main/core/task.ts')
/** remux 的两条变异落在调用点，而不是 `canRemux()` 内部——那里才是决策真正生效的地方 */
const FFMPEG_RUN = resolve('src/main/converters/ffmpegRun.ts')
/** GPU 的参数层（编码器与容器白名单）在引擎侧，回退在调用点——两边各变异各的 */
const FFMPEG = resolve('src/main/engines/ffmpeg.ts')
const QUEUE = resolve('src/main/core/queue.ts')

const MUTATIONS = [
  {
    // ⚠️ 锚点带上 `cost: this.costOf(task)` 是承重的：α 线把「任务个数」改成
    // 「份数容量」时给队列条目加了 cost，这条锚点当场跟丢（命中 0 次），而
    // `falsify:tasks` 当时没跑完，于是直到下一次真跑它才现形。
    // **脚本报「变异没生效」不是通过**——改被反证覆盖的代码之后必须重跑。
    name: 'setTarget 只改任务、不改队列条目里的 engine',
    file: TASK,
    from: '    if (this.queue.remove(id)) this.queue.push({ id, engine: task.engine, cost: this.costOf(task) })\n',
    to: '    // 变异：队列条目原样不动\n',
    expect: ['排队期间改目标格式：队列条目跟着换桶了（不再卡在旧引擎的队尾）']
  },
  {
    name: 'runningCount 用 tokens.size 数（shutdown 之后会数成 0）',
    file: TASK,
    from: '    return this.inFlight.size',
    to: '    return this.tokens.size',
    expect: ['退出路径：shutdown 之后 runningCount 仍 > 0（说明还没收尾）']
  },
  {
    name: 'overwrite 分支不再避让已被占用的本名（回到「两个任务共写一个 .part」）',
    file: TASK,
    from: [
      '      if (!this.claimed.has(key)) {',
      '        this.claimed.add(key)',
      '        return path',
      '      }',
      '    }'
    ].join('\n'),
    to: ['      this.claimed.add(key)', '      return path', '    }'].join('\n'),
    // **只列「落在两个不同的文件上」**，别把「两条都成了」也写进来。
    // 实测第一次跑就是栽在这里：变异之后两条任务**仍然都报 `done`** —— 它们各自把
    // 同一个 `.part`（`partPathOf` 是最终名的纯函数）写出来、各自 `rename` 成功，
    // 后完成的那次**静默覆盖**先完成的，谁都不报错。
    // 「两条都成了」因此在「改坏」和「没改坏」两个世界里都是绿的，它不是判别器；
    // 而正因为它是绿的，用户当时根本察觉不到这个 bug——这才是它值得修的理由。
    expect: ['overwrite 撞名：落在两个不同的文件上']
  },

  // ------------------------------------------------------------------
  // remux 判定：**两侧都要变异**。
  //
  // 只变异一侧是抓不住问题的：恒真的世界里「码流逐位一致」照样绿（它本来就是 remux），
  // 恒假的世界里「不兼容自动回退」照样绿（它本来就在重编码）。两个方向各钉一组断言，
  // 合起来才说明「判据确实在区分这两种情况」，而不是某一边碰巧成立。
  // ------------------------------------------------------------------
  {
    name: 'remux 判定恒真（不看编解码器一律 -c copy）',
    file: FFMPEG_RUN,
    from: '      remux = canRemux(toExt, parseProbeOutput(probeErr))\n',
    to: '      remux = true\n',
    // 两条都是「视频侧或音频侧不兼容，必须回退」的场景。恒真时它们会一头撞进 remux 报错。
    // 注意**不要求**「兼容组合的码流一致」翻红——那个场景下 remux=true 本来就是对的，
    // 它在两个世界里都该是绿的，写进 expect 反而会让反证永远失败。
    expect: [
      '不兼容组合 h264+aac → webm 自动回退重编码且成功',
      '音频不兼容时自动回退重编码且成功（vp9+aac → webm，aac 进不了 webm）'
    ]
  },
  {
    name: 'remux 判定恒假（一律重编码，判据形同虚设）',
    file: FFMPEG_RUN,
    from: '      remux = canRemux(toExt, parseProbeOutput(probeErr))\n',
    to: '      remux = false\n',
    // 恒假时两条「码流逐位一致」必须红——它们是整个 remux 唯一的**存在性**证据。
    // 少了它们，一个「永远重编码」的实现会把所有兼容场景的断言都绿着通过，
    // 用户那边只是白白慢 18 倍（实测 1080p/20s：86ms vs 1616ms），光看 UI 看不出来。
    expect: [
      '兼容组合：视频码流与源逐位一致（证明确实是 remux，不是重编码）',
      '兼容组合：音频码流也与源逐位一致（音频那一侧同样没被重编码）',
      '音频兼容时走 remux：vp9 视频流与源逐位一致'
    ]
  },

  // ------------------------------------------------------------------
  // GPU 硬件编码（M6）：四个变异分别打**四个不同的承重点**——
  // 参数层换没换编码器、容器白名单有没有把关、以及失败时回没回退。
  //
  // 第三条（回退）刻意**不依赖本机有没有卡**：那一节的用例是「64x64 必然让 NVENC 失败」，
  // 所以无论有没有 GPU，砍掉回退分支它都会红。
  // ------------------------------------------------------------------
  {
    name: 'GPU 开关形同虚设（请求了硬件编码也照样用 libx264）',
    file: FFMPEG,
    from: '  const hardware = options.hardware === true && !IMAGE_TARGETS.has(from)\n',
    to: '  const hardware = false\n',
    expect: ['参数层：请求硬件编码时换成了 h264_nvenc']
  },
  {
    name: '写错质量参数：把 nvenc 的 -cq 当成 x264 的 -crf（同号不同质）',
    file: FFMPEG,
    from: "const NVENC_VIDEO = ['-c:v', 'h264_nvenc', '-preset', 'p4', '-cq', '30']\n",
    to: "const NVENC_VIDEO = ['-c:v', 'h264_nvenc', '-preset', 'p4', '-crf', '23']\n",
    // 这一条是 M6 最容易犯的错：看着「23」就照抄。实测同号会让体积涨到 2.8 倍，
    // 而产物照样能播——用户只会觉得「文件怎么这么大」。
    expect: ['参数层：质量参数是 -cq 30，不是照抄 -crf 23（实测同号会让体积涨到 2.8 倍）']
  },
  {
    name: '容器白名单不管了（webm 也塞给 nvenc，而 NVENC 没有 vp9 编码器）',
    file: FFMPEG,
    from: '  if (hardware && NVENC_TARGETS.has(target)) {\n',
    to: '  if (hardware) {\n',
    expect: ['参数层：webm 即使开了硬件编码也走 libvpx-vp9（NVENC 没有 vp9 编码器）']
  },
  {
    name: 'GPU 失败后不回退（一次失败 = 整个任务失败）',
    file: FFMPEG_RUN,
    from: '  if (result.code !== 0 && useHardware && !cancel.canceled) {\n',
    to: '  if (false) {\n',
    expect: ['GPU 编不了时自动回退 CPU 且成功']
  },
  /* ------------------------------------------- 并发容量（α 线的五处） */
  // ⚠️ 这一节全在 `queue.ts` 上，而它是枢纽文件。变异跑的时候它被改坏，
  // 别在这段时间里跑别的套件——那正是「反证期间源码就是坏的」那条纪律。
  {
    name: 'sharp 容量退回硬编码 2（不看核数）',
    file: QUEUE,
    from: `const SHARP_LIMIT = Math.min(4, Math.max(1, cpus().length - 1))`,
    to: `const SHARP_LIMIT = 2`,
    expect: ['sharp 容量跟核数走（留一核给 UI，上限 4）']
  },
  {
    name: 'ffmpeg 容量退回 4 份（小文件快车道整条失效）',
    file: QUEUE,
    from: `const FFMPEG_SLOTS = 12`,
    to: `const FFMPEG_SLOTS = 4`,
    expect: [
      'ffmpeg 容量是 12 份（小文件快车道；大文件按 3 份计 → 收敛到 4 路）',
      '上限 12 + 小文件：真的开出了 4 路以上（快车道生效，不是恒 4）'
    ]
  },
  {
    name: '大输入不再按重算（一条 1080p 只占 1 份 → 并发翻三倍）',
    file: QUEUE,
    from: `const HEAVY_COST = 3`,
    to: `const HEAVY_COST = 1`,
    expect: [
      '大输入按 3 份计（> 1 MiB）',
      '两个素材确实分在两个档上（否则下面三条是同义反复）',
      '上限 12 + 大文件：仍然只跑 4 路（代价闸门生效，内存不跟着上限走）'
    ]
  },
  {
    name: '快车道阈值改成 0（所有 ffmpeg 任务都按重算）',
    file: QUEUE,
    from: `const FAST_LANE_MAX_BYTES = 1024 * 1024`,
    to: `const FAST_LANE_MAX_BYTES = 0`,
    expect: ['小输入按 1 份计（≤ 1 MiB）', '两个素材确实分在两个档上（否则下面三条是同义反复）']
  },
  {
    name: '量不到体积时按轻的算（把「宁保守勿乐观」反过来）',
    file: QUEUE,
    from: `  if (inputBytes === undefined || inputBytes > FAST_LANE_MAX_BYTES) return HEAVY_COST`,
    to: `  if (inputBytes !== undefined && inputBytes > FAST_LANE_MAX_BYTES) return HEAVY_COST`,
    // ⚠️ `undefined` 走轻档。真实入队路径拿不到体积时就是这个分支——
    // 一段 813 KiB 的 720p 恰好落在轻档，所以这里的保守方向是**有意义**的。
    expect: ['量不到体积时按重的算（宁可慢一点，不拿内存去赌）']
  },

  /* ------------------------------------------- 输出约束（E-1 之外的那条线，2026-09-13） */
  // ⚠️ 这一节全在 `ffmpeg.ts` / `ffmpegRun.ts` 上，而 `test:tasks` 现在因为两遍 ABR
  // 的用例涨到了一刻钟以上（原来约 7 分钟）。**迭代时务必用 `--only=`**，
  // 否则一轮就是好几个小时。
  {
    // 有输出目标时 remux 必须失效：`-c copy` 一个字节都不编，
    // **物理上不可能**把产物压到目标体积以内。
    name: '有输出目标时照旧走 remux（体积目标形同虚设）',
    file: FFMPEG_RUN,
    from: `    outputTarget === undefined &&`,
    to: `    true &&`,
    expect: [
      '体积目标：产物 ≤ 目标 × 1.15（ABR 有偏差，判据刻意不写成精确小于）',
      '体积目标：码流指纹与源不同（= 确实重编码了）——这个方向不带目标时本来走 `-c copy`，而它改不了体积'
    ]
  },
  {
    // `output` + 无损裁剪是调用方自相矛盾（要一段 + 要一个体积），必须报错而不是静默二选一。
    name: '输出目标与无损裁剪同时出现时不再报错（静默二选一）',
    file: FFMPEG_RUN,
    from: `  if (outputTarget && clip && trim && trim.mode === 'lossless') {`,
    to: `  if (false) {`,
    expect: [
      '输出目标 + 无损裁剪：任务失败，而不是静默二选一',
      '失败原因说清了是「不能同时要求」，并给出下一步'
    ]
  },
  {
    // ⚠️ 这条是**最要紧的一条**：两遍编码的统计文件默认落在当前目录、
    // 文件名固定，两条并发任务会互相覆盖 —— 症状是**产物码率完全不对，而任务报成功**。
    // 这是约束 9「并发任务的输出名要额外占位」的同类问题。
    name: '两遍编码的 passlogfile 用固定名（并发任务互相覆盖统计文件）',
    file: FFMPEG_RUN,
    // ⚠️ 这两行**故意用双引号普通字符串**：锚点里有 `${process.pid}`，
    // 而模板字面量会把 `${…}` 当插值求值（`String.raw` 也一样——
    // 替换发生在标签函数之前）。双引号串没有这个陷阱。
    from: '        passLogPrefix = join(tmpdir(), `arbiter-2pass-${process.pid}-${randomUUID()}`)',
    to: "        passLogPrefix = join(tmpdir(), 'arbiter-2pass-fixed')",
    // ⚠️ **这条变异是竞态相关的，所以标成诊断性而不是要求它翻红。**
    // 实测（2026-09-14）连跑两轮：第一轮红 3 条，第二轮**一条都没红**——
    // 因为两条并发任务只有在时间上真的重叠时才会撞到同一个统计文件，
    // 串行跑完的话「用固定名」与「用唯一名」在结果上没有区别。
    //
    // 这不是「断言没用」：并发那两条断言确实会因为它一起崩（第一轮就是），
    // 只是**能不能触发取决于时序**。把不稳定的红写进 expect 只会换来一轮假红，
    // 而假红会诱人去放宽真正的断言——那比不收更坏。
    //
    // 要一条**确定性**守卫，得让 passlog 前缀可被断言读到（它现在只在
    // `runFfmpeg` 内部算出来）。那属于「给概率性缺陷补结构性判据」的同一类工作，
    // 已在 docs/NOTES.md 约束 33 里记下这个模式，这里如实标注为覆盖缺口。
    diagnostic: true,
    diagnosticNote:
      '两条并发任务没在时间上重叠时，「固定名」与「唯一名」结果相同——这条变异的可观测性依赖时序。',
    expect: [
      '并发：两条都成功',
      '并发：每条产物都 ≤ 它**自己的**目标 × 1.15（统计文件没被另一条覆盖）',
      '并发：两条落在不同的文件上（没有互相覆盖）'
    ]
  },
  {
    // 第一遍是「分析」，它不该产出确定进度：两遍是两条独立的时间轴，
    // 喂第一遍会让 UI 先看到 100% 再回跳。
    name: '第一遍也喂给进度解析器（百分比先冲到 100% 再回跳）',
    file: FFMPEG_RUN,
    // 锚点是第一遍那次调用**实参上的那个选项**——`quiet: true` 全文只此一处
    // （第二遍与单遍那条路都不带 quiet，默认 false）。
    from: `        { quiet: true }`,
    to: `        { quiet: false }`,
    expect: [
      '两遍编码：确定进度的百分比单调不减（两遍都喂的实现在第二遍开头会回跳）',
      '两遍编码：第一遍推的是不确定进度，确定进度只在「第二遍」之后才开始（口径：只喂第二遍）'
    ]
  },
  {
    // 两遍 ABR 与 GPU 的 CQ 模式互斥（`-cq` 不是码率控制，装不进两遍的模型）。
    name: '第二遍的 ABR 参数里混进 -crf（把 CQ 模式塞进两遍编码）',
    file: FFMPEG,
    from: `    return [...codec, '-b:v', rate, ...audio, ...passArgs(enc)]`,
    to: `    return [...codec, '-crf', '23', '-b:v', rate, ...audio, ...passArgs(enc)]`,
    expect: [
      '参数层：第二遍是 ABR（-b:v 218k / -pass 2），而且**不带 -crf**——两者同时出现时 x264 会回到质量模式，体积目标形同虚设'
    ]
  },
  {
    // 没有码率旋钮的出口（图片类那些）必须被认出来并给一句人话，
    // 而不是把一个 `-b:v` 塞给一个不认识的编码器。
    name: '没有码率旋钮的出口也放行（参数塞给认不出它的编码器）',
    file: FFMPEG,
    // 动**函数体**而不是签名：变异之后仍然是合法 TS，而且它测的正是
    // 「这三条挡板到底有没有生效」。
    from: `  if (to === 'gif') return false
  if (IMAGE_TARGETS.has(to)) return false
  if (LOSSLESS_AUDIO_TARGETS.has(to)) return false
  return true`,
    to: `  void to
  return true`,
    expect: [
      '参数层：没有码率旋钮的出口被认出来（gif / 无损音频 / 图片出口），有旋钮的照常放行',
      '失败原因点明了「没有码率旋钮」，并给出下一步'
    ]
  },
  {
    // 统计文件是临时产物，收尾必须清掉——留在系统临时目录里会一直累积。
    name: '两遍编码跑完不清理 passlog 文件',
    file: FFMPEG_RUN,
    from: `    if (passLogPrefix !== null) await cleanupPassLog(passLogPrefix)`,
    to: `    if (false) await cleanupPassLog(passLogPrefix)`,
    expect: ['两遍编码：系统临时目录里也没有留下统计文件（-0.log 与 .mbtree 一并删掉）']
  }
]

/* ------------------------------------------------------- 锚点自检
 * `--anchors-only` 时**只**数锚点命中次数：不跑基线、不跑任何测试、不改任何源码、
 * 不做任何还原、也不碰 git。全过 exit 0，有锚点命不中 exit 1（逐条打印
 * 「脚本 / 变异名 / 命中次数 / 期望次数」）。
 *
 * 存在的理由尤其硬：这一支一轮 22 分钟，而锚点过期时它报的是「有断言没红」——
 * **看着像断言失效，其实是锚点过期**，白等一轮是这里最贵的一种浪费。
 * 见 scripts/lib/anchors.mjs 的文件头。
 */
if (process.argv.slice(2).includes('--anchors-only')) {
  const { anchorsOnlyGuard } = await import('./lib/anchors.mjs')
  // 与脚本正文一致：它读盘后过了 `toLf`（见下面的 `originals` / 循环）
  anchorsOnlyGuard(MUTATIONS, { normalizeLf: true })
}

/**
 * `--only=<名字子串>` 只跑命中的那几个变异。
 *
 * 存在的理由只有一个：一轮 `test:tasks` 要好几分钟，三个变异就是十几分钟，
 * 而实际迭代时往往只改了某一个变异的期望清单或锚点。**基线照样跑**（它是对照组，
 * 去掉它这一轮结论就没有意义），只是不做其余的变异。
 *
 * 用了它就在结尾显著地说明「这次只跑了 N / M 个变异」——不能让一次只跑一个变异的
 * 绿灯看起来像整轮通过。
 *
 * ⚠️ 这段**必须放在 `MUTATIONS` 之后**：`const` 有暂时性死区，放前面会直接
 * `ReferenceError: Cannot access 'MUTATIONS' before initialization`。
 *
 * ⚠️ **2026-09-13 起支持逗号分隔的多个子串**（`--only=两遍,passlog`）。
 * 原因是这一轮的 `test:tasks` 从约 7 分钟涨到了**一刻钟以上**（输出约束那条线加进来的
 * 两遍 ABR 用例），而基线每轮都要跑一遍——一次只挑一个变异的话，光是基线就占掉大半。
 * 分批挑是唯一还跑得动的用法。
 */
const ONLY = (process.argv.slice(2).find((a) => a.startsWith('--only=')) ?? '').slice(
  '--only='.length
)
/** 逗号分隔的多个子串，命中任意一个即选中。空串 = 全选 */
const ONLY_PARTS = ONLY
  ? ONLY.split(',')
      .map((part) => part.trim())
      .filter((part) => part !== '')
  : []
const selected = ONLY_PARTS.length
  ? MUTATIONS.filter((m) => ONLY_PARTS.some((part) => m.name.includes(part)))
  : MUTATIONS
if (ONLY_PARTS.length && selected.length === 0) {
  console.error(`--only=${ONLY} 一个变异都没匹配上`)
  process.exit(1)
}

/**
 * 跑被测套件并抠出翻红的断言标签。
 *
 * 分隔符与 `falsify-ui.mjs` 一致（`通过 68 / 失败 0`，斜杠），与 falsify-doc 用的全角逗号
 * 不是一个——照抄正则会一直拿到 -1，而 -1 不等于 0，表现是「基线就报不是全绿」。
 */
function runTests() {
  const out = spawnSync(
    'npx',
    ['tsx', '--tsconfig', 'tsconfig.test.json', 'scripts/test-tasks.ts'],
    {
      encoding: 'utf8',
      shell: true,
      maxBuffer: 32 * 1024 * 1024
    }
  )
  const text = out.stdout + out.stderr
  const reds = text
    .split(/\r?\n/)
    .filter((line) => line.includes('✗'))
    .map((line) =>
      line
        .replace(/.*✗\s*/, '')
        .replace(/\s+←.*$/, '')
        .trim()
    )
  const total = /通过 (\d+) \/ 失败 (\d+)/.exec(text)
  return {
    reds,
    passed: total ? Number(total[1]) : -1,
    failed: total ? Number(total[2]) : -1,
    text
  }
}

/** 锚点一律在 LF 文本上匹配：混进 CRLF 的话跨行锚点会一声不响地命中 0 次 */
const toLf = (s) => s.replace(/\r\n/g, '\n')

const originals = Object.fromEntries(
  [...new Set(MUTATIONS.map((m) => m.file))].map((f) => [f, readFileSync(f, 'utf8')])
)

console.log(
  ONLY
    ? `只跑 ${selected.length} / ${MUTATIONS.length} 个变异（--only=${ONLY}），基线照样跑一轮…`
    : `${MUTATIONS.length} 个变异，基线跑一轮（要几分钟，后面每个变异还要各跑一轮）…`
)
const baseline = runTests()
console.log(`基线：通过 ${baseline.passed}，失败 ${baseline.failed}`)
if (baseline.failed !== 0) {
  console.error('基线不是全绿，先修好再来反证。')
  console.error(baseline.text.slice(-2000))
  process.exit(1)
}

let problems = 0

for (const m of selected) {
  const original = toLf(originals[m.file])
  const hits = original.split(m.from).length - 1

  // 命中次数一定要打出来：只说「没命中唯一一次」的话，0 次和 2 次根本分不清。
  console.log(`\n[${m.name}] 锚点命中 ${hits} 次（期望 1 次）`)
  if (hits !== 1) {
    console.error('  期望 1 次 —— 变异没生效，结论无效（多半是源码重构过，锚点过期了）')
    problems += 1
    continue
  }

  writeFileSync(m.file, original.replace(m.from, m.to), 'utf8')
  const result = runTests()
  writeFileSync(m.file, originals[m.file], 'utf8')

  if (m.diagnostic) {
    console.log(`\n[诊断] ${m.name} → 通过 ${result.passed}，失败 ${result.failed}`)
    console.log(
      result.reds.length > 0
        ? `    翻红：${result.reds.join(' | ')}\n    ⇒ 这条设计是承重的，留着。`
        : `    ⇒ ${m.diagnosticNote ?? '一条都没红：这条设计在当前环境下不是承重约束。'}`
    )
    continue
  }

  const missed = m.expect.filter((label) => !result.reds.includes(label))
  const extra = result.reds.filter((label) => !m.expect.includes(label))

  if (missed.length === 0) {
    console.log(`  翻红 ${result.reds.length} 条，期望的都在`)
    for (const label of result.reds) {
      console.log(`    - ${label}${extra.includes(label) ? '   (顺带)' : ''}`)
    }
  } else {
    problems += 1
    console.log('  有断言没红 —— 它们抓不住这个错误：')
    for (const label of missed) console.log(`    ! ${label}`)
    console.log(`  实际翻红：${result.reds.join(' | ') || '（一条都没红）'}`)
  }
}

// 收尾再确认源码确实还原了
const dirty = Object.keys(originals).filter((f) => readFileSync(f, 'utf8') !== originals[f])
if (dirty.length > 0) {
  console.error('\n源码没还原干净：' + dirty.join(', '))
  process.exit(1)
}

// 把跑完之后每个文件的 sha256 打出来：这条「已还原」的结论不该只有脚本自己说了算。
for (const f of Object.keys(originals)) {
  console.log(`  ${createHash('sha256').update(readFileSync(f)).digest('hex')}  ${f}`)
}

const scope = ONLY ? `（**只跑了 ${selected.length} / ${MUTATIONS.length} 个变异**）` : ''
console.log(
  problems === 0
    ? `\n反证通过：每个变异都被对应的断言抓住了，且源码已还原。${scope}`
    : `\n反证不通过：${problems} 处有问题。${scope}`
)
process.exit(problems === 0 ? 0 : 1)
