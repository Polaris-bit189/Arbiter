/**
 * 图片处理链（`filters` 里的 `resize`）与「压到多少字节」（`output.targetBytes`）
 * 的自测脚本（**不依赖 Electron**，直接跑）。
 *
 *   npx tsx --tsconfig tsconfig.test.json scripts/test-image-options.ts
 *
 * 盯的是「转换会成功、但结果不是你要求的那个」这一类毛病——它们不出现在任何错误日志里：
 *
 * - **小图被放大**（sharp 的 `withoutEnlargement` 默认是 `false`）。用户说「长边 1920」、
 *   源图只有 800px，拿到的却是一张被拉大到 1920 的糊图，体积还涨了——而任务报成功。
 *   这是这批最承重的一条，见 [2]。
 * - **`cover` / `fill` 静默退化成 `inside`**：三个档位长得一样，只有宽高对不上才看得出来。
 * - **体积目标被静默忽略**：PNG 没有质量旋钮，若不明确拒掉，用户会拿到一个
 *   体积完全没变、却报「成功」的产物。
 * - **二分的产物画质崩掉**：体积优先的搜索会一路往下压质量，没有下限的话
 *   它能交出一个「达标」的马赛克。
 *
 * 素材：
 * - 几何与体积那几节用的是**现场生成的噪声图**——被测的是宽高与体积搜索，不是编解码器
 *   本身，所以这里不存在「自己验自己」。刻意用**噪声**而不是纯色：纯色图在 JPEG 下
 *   几百字节就装下了，体积二分根本不会有任何张力（一测就通过，什么都验不出来）。
 * - 动图那一节用 `ffmpeg-static` 现造一个三帧 GIF（sharp 自己写不出多帧，实测
 *   `.gif({ pageHeight })` 产出的仍是单帧）。
 * - HEIC 那一节用 `scripts/fixtures/` 里那份**真实 iPhone 拍摄**的 HEVC 系样本，
 *   经 `stageFixture()` 拷到临时目录——它验的是 libheif 那条原始像素分支。
 */
import { copyFile, mkdir, readdir, rm, stat } from 'fs/promises'
import { dirname, extname, resolve } from 'path'
import { spawn } from 'child_process'
import { randomBytes } from 'crypto'
import sharp from 'sharp'

/**
 * ⚠️ **关掉 libvips 的运算缓存。** 不关的话本套件会在仓库根留下
 * `.tmp-test-image-options/out/static-webp.webp`——`rm` 报 `EBUSY`，而**重试没用**：
 * 实测等 0/100/200/…/400 ms 各删一次，五次全失败；但**同一个目录在进程退出之后**
 * 第一次尝试就删掉了。也就是说握着句柄的是**本进程自己**（libvips 把「读过/写过那个
 * 路径」这件事缓存住了），进程一没它自然就开了。
 *
 * 定位过程值得记：先怀疑是「短暂的句柄」（不是，重试五次都不行），
 * 再怀疑是 Node 的 `rm` `maxRetries` 写法（那个更早就试过，会让套件挂死），
 * 最后才是「关掉 sharp 的缓存」——**一次就干净了**。
 *
 * 残留本身不致命（`.tmp-*` 已被 `electron-builder.yml` 的 `files` 排除，约束 30），
 * 但「跑一次测试就往仓库根扔一个目录」会让打包前那道 `ls -d .tmp-*` 守卫失去信号：
 * 真正的异常残留会混在一片常态残留里看不出来。
 *
 * 只关这一个脚本的缓存：它跑的是几十次独立编码，缓存本来也帮不上什么忙。
 */
sharp.cache(false)
import { runSharp, targetSizeRefusal } from '../src/main/converters/image'
import { CancelToken } from '../src/main/core/cancel'
import { MIN_TARGET_BYTES } from '../src/shared/options'
import type { FilterAction, TaskOptions } from '../src/shared/types'

const TMP = resolve('.tmp-test-image-options')
const FIXTURES = resolve('scripts/fixtures')
const OUT = resolve(TMP, 'out')

/**
 * 体积目标的上限（2 MiB）。
 *
 * 这个数是**量出来的**，不是拍的：2400×1600 的噪声图在 JPEG 下
 * q100 是 5303 KB、q20 还有 649 KB，所以 2 MiB 正好落在两头之间——
 * 搜索真的会跑起来（最高质量装不下、最低质量装得下），而不是一测就过或直接失败。
 * 做成「不可达」（比如 64 KiB）就只能验到失败那条路，二分本身一点都没被覆盖。
 */
const CAP = 2 * 1024 * 1024

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

/* ------------------------------------------------------------------ 素材 */

/**
 * 现场造一张**有噪声**的源图。噪声是承重的：纯色图在 JPEG 下会压到几百字节，
 * 于是「压到 2 MiB」这类断言在一测就过的同时也什么都没验到。
 *
 * 噪声用固定种子的 LCG 生成，所以**同一张图每次跑出来的字节数完全一致**——
 * 体积断言的余量才是稳定的，不会今天绿明天红。
 */
async function makeSource(name: string, width: number, height: number): Promise<string> {
  const path = resolve(TMP, 'src', name)
  await mkdir(dirname(path), { recursive: true })

  const raw = Buffer.alloc(width * height * 3)
  let seed = 123456789
  for (let i = 0; i < raw.length; i += 1) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    raw[i] = (seed >>> 16) & 0xff
  }
  await sharp(raw, { raw: { width, height, channels: 3 } })
    .png({ compressionLevel: 1 })
    .toFile(path)
  return path
}

function run(exe: string, args: string[]): Promise<void> {
  return new Promise((res, rej) => {
    const child = spawn(exe, args)
    let err = ''
    child.stderr.on('data', (d) => (err += String(d)))
    child.on('error', rej)
    child.on('close', (code) => (code === 0 ? res() : rej(new Error(err.slice(-400)))))
  })
}

/** 三帧动图。sharp 写不出多帧（`.gif({ pageHeight })` 实测仍是单帧），所以借 ffmpeg 现造。 */
async function makeAnimatedGif(): Promise<string> {
  const path = resolve(TMP, 'src', 'anim.gif')
  await mkdir(dirname(path), { recursive: true })
  const mod = (await import('ffmpeg-static')) as unknown as { default: string }
  await run(mod.default, [
    '-hide_banner',
    '-f',
    'lavfi',
    '-i',
    'testsrc=size=160x120:rate=1:duration=3',
    '-loop',
    '0',
    '-y',
    path
  ])
  return path
}

async function stageFixture(name: string): Promise<string> {
  const dest = resolve(TMP, 'fixtures', name)
  await mkdir(dirname(dest), { recursive: true })
  await copyFile(resolve(FIXTURES, name), dest)
  return dest
}

/* ------------------------------------------------------------------ 驱动 */

interface Shot {
  bytes: number
  width: number
  height: number
}

/** 真跑一次 `runSharp`（就是引擎入口本身，没有被裁掉任何一层） */
async function convert(
  input: string,
  toExt: string,
  options?: TaskOptions,
  name = 'out'
): Promise<Shot> {
  const output = resolve(OUT, `${name}.${toExt}`)
  await mkdir(dirname(output), { recursive: true })
  await runSharp({
    input,
    output,
    fromExt: extname(input).slice(1).toLowerCase(),
    toExt,
    cancel: new CancelToken(),
    onProgress: () => undefined,
    options
  })
  const meta = await sharp(output).metadata()
  return { bytes: (await stat(output)).size, width: meta.width ?? 0, height: meta.height ?? 0 }
}

/** 同上，但要求它**失败**，返回拼起来的错误文案；没失败则返回空串。 */
async function convertError(input: string, toExt: string, options?: TaskOptions): Promise<string> {
  try {
    await convert(input, toExt, options, 'err')
    return ''
  } catch (error) {
    const e = error as { logTail?: string[]; message?: string }
    return [...(e.logTail ?? []), e.message ?? ''].join('\n')
  }
}

const wantBytes = (targetBytes: number): TaskOptions => ({ output: { targetBytes } })

type ResizeDraft = Omit<Extract<FilterAction, { kind: 'resize' }>, 'kind'>

const resize = (action: ResizeDraft): TaskOptions => ({
  filters: [{ kind: 'resize', ...action }]
})

/* --------------------------------------------------------------- 断言各节 */

async function testGeometry(small: string, big: string): Promise<void> {
  console.log('\n[1] 缩放几何')

  // inside 是「装进这个框」，**两侧都要满足**：2400×1600 被框的**高**卡住（1080/1600），
  // 缩到 1620×1080，而不是拿宽去顶 1920。
  const inside = await convert(
    big,
    'png',
    resize({ width: 1920, height: 1080, fit: 'inside', withoutEnlargement: true }),
    'inside'
  )
  check(
    'inside 1920×1080（2400×1600 被高卡住）→ 1620×1080',
    inside.width === 1620 && inside.height === 1080,
    `${inside.width}×${inside.height}`
  )
  check(
    '比例与源一致',
    Math.abs(inside.width / inside.height - 2400 / 1600) < 0.01,
    String(inside.width / inside.height)
  )

  // 只给一个维度：另一侧按比例算。这是「缩到宽 1920」最常见的心智模型，不是残缺用法。
  const onlyWidth = await convert(
    small,
    'png',
    resize({ width: 400, fit: 'inside', withoutEnlargement: true }),
    'only-width'
  )
  check(
    '只给宽 400（源 800×600）→ 400×300',
    onlyWidth.width === 400 && onlyWidth.height === 300,
    `${onlyWidth.width}×${onlyWidth.height}`
  )
  const onlyHeight = await convert(
    small,
    'png',
    resize({ height: 300, fit: 'inside', withoutEnlargement: true }),
    'only-height'
  )
  check(
    '只给高 300（源 800×600）→ 400×300',
    onlyHeight.width === 400 && onlyHeight.height === 300,
    `${onlyHeight.width}×${onlyHeight.height}`
  )

  // cover 真的裁了：同一个 800×800 的框，inside 得到 800×533，cover 得到 800×800。
  // 两者高度不同，才说明 cover 没有静默退化成 inside。
  const cover = await convert(
    big,
    'png',
    resize({ width: 800, height: 800, fit: 'cover', withoutEnlargement: true }),
    'cover'
  )
  const boxInside = await convert(
    big,
    'png',
    resize({ width: 800, height: 800, fit: 'inside', withoutEnlargement: true }),
    'box-inside'
  )
  check(
    'cover 填满 800×800，而同一个框的 inside 只有 800×533（说明 cover 真的裁了）',
    cover.width === 800 &&
      cover.height === 800 &&
      boxInside.width === 800 &&
      Math.abs(boxInside.height - 533) <= 1,
    `cover ${cover.width}×${cover.height} / inside ${boxInside.width}×${boxInside.height}`
  )

  const fill = await convert(
    big,
    'png',
    resize({ width: 400, height: 100, fit: 'fill', withoutEnlargement: true }),
    'fill'
  )
  check(
    'fill 拉伸到正好 400×100（inside 会得到 150×100）',
    fill.width === 400 && fill.height === 100,
    `${fill.width}×${fill.height}`
  )

  // 空链 / 不传参数：行为必须与没有这一块参数时逐字相同
  const none = await convert(big, 'png', undefined, 'none')
  const empty = await convert(big, 'png', { filters: [] }, 'empty-chain')
  check(
    '空链与不传 filters 都等于原样输出',
    none.width === 2400 && empty.width === 2400 && none.height === empty.height,
    `${none.width}×${none.height} / ${empty.width}×${empty.height}`
  )
}

/**
 * **这批最承重的一节。**
 *
 * sharp 自己的 `withoutEnlargement` 默认是 `false`，也就是「长边 1920」会把一张 800px
 * 的图**放大**成 1920——体积涨、画质平白劣化一次，而且不报错。契约把它钉成**必填**字段
 * （`ResizeAction`），就是为了堵死「省略即取错默认值」这条路。
 *
 * 所以这里两个方向都断：开着时不许放大，**关着时必须放大**。只断前者的话，
 * 一个「永远不放大」的实现也能通过，而那会把用户明确要求的放大一起吞掉。
 */
async function testNoEnlargement(small: string): Promise<void> {
  console.log('\n[2] 不放大（sharp 默认值的反面）')

  const kept = await convert(
    small,
    'png',
    resize({ width: 1920, fit: 'inside', withoutEnlargement: true }),
    'no-enlarge'
  )
  check(
    '源 800×600 要求长边 1920 → 产物仍是 800×600',
    kept.width === 800 && kept.height === 600,
    `${kept.width}×${kept.height}`
  )

  const grown = await convert(
    small,
    'png',
    resize({ width: 1920, fit: 'inside', withoutEnlargement: false }),
    'enlarge'
  )
  check(
    '同一条链把 withoutEnlargement 关掉 → 确实放大到 1920×1440（证明开关真的在起作用）',
    grown.width === 1920 && grown.height === 1440,
    `${grown.width}×${grown.height}`
  )
}

async function testTargetBytes(big: string, small: string, anim: string): Promise<void> {
  console.log('\n[3] 压到多少字节')

  const capped = await convert(big, 'jpg', wantBytes(CAP), 'capped')
  check('产物不超过上限', capped.bytes <= CAP, `${capped.bytes} > ${CAP}`)
  // **质量没有被荒谬地压低**：二分找的是「装得下的**最大**质量」，所以产物应当贴着上限
  // （实测落在 95% 上下），而不是下限。这里断「至少用到一半」——
  // 一个「一路压到最低档」的实现会掉到 CAP 的 1/3 附近，当场翻红。
  check(
    '质量没有被荒谬地压低（产物至少用到上限的一半）',
    capped.bytes >= CAP / 2,
    `${capped.bytes} vs ${CAP}`
  )
  check(
    '体积目标不动像素：尺寸仍是 2400×1600',
    capped.width === 2400 && capped.height === 1600,
    `${capped.width}×${capped.height}`
  )

  // 「做不到」这条路：下限 64 KiB 对一张 2400×1600 的噪声图必然达不到（q20 还有 649 KB）。
  const refused = await convertError(big, 'jpg', wantBytes(MIN_TARGET_BYTES))
  check(
    '体积做不到时明说「做不到」，而不是交出一个画质崩掉的「达标」产物',
    refused.includes('做不到'),
    JSON.stringify(refused.slice(0, 120))
  )

  // PNG 没有质量旋钮 → **明确拒掉**，并说清该改转什么
  const png = await convertError(small, 'png', wantBytes(CAP))
  check('PNG + 体积目标 → 报错', png !== '', '居然成功了')
  check(
    '错误文案点明 PNG 没有质量旋钮',
    png.includes('PNG') && png.includes('质量'),
    png.slice(0, 120)
  )
  check(
    '错误文案给出出路（WebP / JPEG）',
    png.includes('WebP') && png.includes('JPEG'),
    png.slice(0, 160)
  )

  // 动图：成本随帧数线性增长，明确拒绝
  const animated = await convertError(anim, 'webp', wantBytes(CAP))
  check('动图 + 体积目标 → 报错', animated !== '', '居然成功了')
  check(
    '文案点明「动图」与帧数这件事',
    animated.includes('动图') && animated.includes('帧'),
    animated.slice(0, 160)
  )

  // 但**不能一刀切**：静态图的 WebP 体积目标是能做的
  const staticShot = await convert(small, 'webp', wantBytes(CAP), 'static-webp')
  check(
    '静态图 → WebP 的体积目标照常能做（不是一刀切拒绝）',
    staticShot.bytes <= CAP && staticShot.width === 800,
    `${staticShot.bytes} / ${staticShot.width}×${staticShot.height}`
  )

  // 处理链 + 体积目标一起用：尺寸是缩放后的，体积仍然达标
  const both = await convert(
    big,
    'jpg',
    {
      filters: [
        { kind: 'resize', width: 1200, height: 800, fit: 'inside', withoutEnlargement: true }
      ],
      output: { targetBytes: CAP }
    },
    'both'
  )
  check(
    '缩放与体积目标能一起用（1200×800 且 ≤ 2 MiB）',
    both.width === 1200 && both.height === 800 && both.bytes <= CAP,
    `${both.width}×${both.height} / ${both.bytes}`
  )

  // 试探产物必须收干净：它是 `.part.jpg.probeN.jpg` 这种名字，留在用户目录里就是垃圾。
  //
  // ⚠️ **必须带一个非空前置**：「目录里没有 .probe 文件」在**空目录**上恒真——
  // 上一次转换要是没产出任何东西，这条断言会绿着告诉你「一切正常」，
  // 而它其实只是「什么都没有」。这个仓库因为这类空集合恒真抓到过装饰性断言
  // （`!entries.some(...)` 在 `entries` 为空时恒真），所以规矩是
  // **「不应包含 X」型断言一律先钉住「集合里确实有东西」**。
  const all = await readdir(OUT)
  const leftovers = all.filter((n) => n.includes('.probe'))
  check(
    '前置：输出目录里确实有产物（否则下面那条在空集合上恒真）',
    all.length > 0,
    String(all.length)
  )
  check('试探产物一个都没留在输出目录里', leftovers.length === 0, leftovers.join(', '))
}

/**
 * 判据面那一层（纯函数）。
 *
 * 单列出来是因为「哪些组合被拒」是**对外承诺**，而它体现在两个分支的顺序里：
 * 动图那条比「没有质量旋钮」更具体，所以必须先判——反过来的话，用户拿到的是一句
 * 「GIF 没有质量旋钮」，而他转的其实是 WebP 动图。
 */
function testRefusal(): void {
  console.log('\n[4] 体积目标的判据面')

  check(
    'jpg / jpeg / webp / avif 放行',
    ['jpg', 'jpeg', 'webp', 'avif'].every((t) => targetSizeRefusal(t, 1) === null)
  )
  check(
    'png / tiff / gif 拒掉',
    ['png', 'tiff', 'gif'].every((t) => targetSizeRefusal(t, 1) !== null)
  )
  const multi = targetSizeRefusal('webp', 3)
  check('动图优先报「动图」而不是「质量旋钮」', (multi ?? '').includes('动图'), multi ?? 'null')
  check('单帧的 webp 不受动图那条影响', targetSizeRefusal('webp', 1) === null)
}

async function testHeic(): Promise<void> {
  console.log('\n[5] HEIC 走原始像素那条分支也能缩')

  const heic = await stageFixture('heic-single.heic')
  if (!(await stat(heic).catch(() => null))) {
    console.log('  （fixtures 里没有 heic-single.heic，跳过这一节——不伪造素材）')
    return
  }

  const meta = await sharp(heic, { failOn: 'none' }).metadata()
  const srcW = meta.width ?? 0
  const srcH = meta.height ?? 0

  const out = await convert(
    heic,
    'jpg',
    resize({ width: 400, fit: 'inside', withoutEnlargement: true }),
    'heic-400'
  )
  check(
    `真实 HEIC（${srcW}×${srcH}）缩到宽 400 → 宽 400 且比例不变`,
    out.width === 400 && Math.abs(out.height - (srcH * 400) / srcW) <= 1,
    `${out.width}×${out.height}（期望高 ${((srcH * 400) / srcW).toFixed(1)}）`
  )

  const kept = await convert(
    heic,
    'jpg',
    resize({ width: 1920, fit: 'inside', withoutEnlargement: true }),
    'heic-noenlarge'
  )
  check(
    'HEIC 那条分支同样遵守「不放大」',
    kept.width === srcW && kept.height === srcH,
    `${kept.width}×${kept.height}（源 ${srcW}×${srcH}）`
  )
}

/**
 * PNG 出口那个 `effort` 旋钮（E-9 顺带量出来的）。
 *
 * 2026-09-16 实测（`compressionLevel` 固定 9，1440×960 实拍 HEIC 源）：
 * 去掉 `effort` 之后产物 **1929.4 KB**，加上 `effort: 7` 是 **466.3 KB**——
 * 一个旋钮扛着 **4.1×**。而它此前**一条断言都没有**：谁顺手把 `effort` 删掉
 * （它看起来像个可有可无的调优参数），测试一条都不会红，用户拿到的是一张大了四倍的
 * PNG，而且**不会有任何地方报错**——PNG 是无损格式，「体积变大」不触发任何检查。
 *
 * ## 为什么用真随机素材，而不用上面那张 LCG「噪声」
 *
 * 三种素材实测的倍数：**实拍 HEIC 4.14× / 真随机 3.00× / LCG 噪声 2.17×**。
 * 效应在三种上都真实存在，但 `makeSource` 那个 LCG（只取 `seed >>> 16 & 0xff`）
 * 造出来的字节其实**很耐压**——2400×1600 的 11.5 MB 原始数据只压出 92 KB，
 * 余量薄到 2.17×，贴着门槛跑就会变成一条时红时绿的断言。
 *
 * 真随机素材的另一个好处是**不依赖 fixtures**：`[5]` 那一节要 `heic-single.heic`，
 * 素材不在时只能跳过——而「跳过的测试看起来和通过一模一样」，那是这个仓库抓过的问题。
 *
 * ## 判据为什么是比值而不是绝对字节
 *
 * 绝对字节数会随 sharp / libvips 版本漂。写成「产物 = 466.3 KB」的话，
 * 下一次升级 libvips 它就会红，而那时它红得毫无意义、只会被人删掉。
 * 同机同版本同一份输入上的**比值**不带这个问题。
 */
async function testPngEffort(): Promise<void> {
  console.log('\n[6] PNG 出口：`effort` 那一个旋钮扛着 3×')

  // 真随机，不可压。800×600×3 = 1.44 MB 原始数据，两次编码都在百毫秒级
  const src = resolve(TMP, 'src', 'uncompressible.png')
  await mkdir(dirname(src), { recursive: true })
  await sharp(randomBytes(800 * 600 * 3), { raw: { width: 800, height: 600, channels: 3 } })
    .png({ compressionLevel: 1 })
    .toFile(src)

  // 我们的实现（走 `encoderFor` → `png({ compressionLevel: 9, effort: 7 })`）
  const ours = await convert(src, 'png', undefined, 'effort-ours')

  // 对照组：只给 compressionLevel，把 effort 拿掉——**就是「顺手删掉那个参数」的后果**
  const weakPath = resolve(OUT, 'effort-weak.png')
  await sharp(src).png({ compressionLevel: 9 }).toFile(weakPath)
  const weak = (await stat(weakPath)).size

  // 防空转：源图要是平坦得没什么可压，两边都几百字节，比值就没有意义了。
  // 这一条同时挡住「素材被换掉了」导致的假绿。
  check('前置：对照组本身就是个大文件（素材确实不可压）', weak > 100 * 1024, `${weak} 字节`)

  check(
    '我们的 PNG 产物至少比「只给 compressionLevel 9」小一半（effort 还在）',
    ours.bytes * 2 <= weak,
    `我们 ${ours.bytes} 字节 / 去掉 effort ${weak} 字节`
  )
}

/* -------------------------------------------------------------------- main */

async function main(): Promise<void> {
  await rm(TMP, { recursive: true, force: true })
  try {
    const small = await makeSource('small800.png', 800, 600)
    const big = await makeSource('big2400.png', 2400, 1600)
    const anim = await makeAnimatedGif()

    await testGeometry(small, big)
    await testNoEnlargement(small)
    await testTargetBytes(big, small, anim)
    testRefusal()
    await testHeic()
    await testPngEffort()
  } finally {
    // ⚠️ 这里**不吞错误**。实测（2026-09-15）：本套件全绿，仓库根却留着那一份
    //    `.tmp-test-image-options/out/static-webp.webp` —— `rm` 抛了，而原先那句
    //    `.catch(() => undefined)` 把失败整个吞了。残留会被 electron-builder 静默
    //    打进 asar（约束 30），所以至少要让它在终端上出一声。
    //    真正让它不掉队的是文件头那句 `sharp.cache(false)`——这里只是**保底**：
    //    哪天真删不掉，得有人说出来，而不是安静地留一个目录在仓库根。
    await rm(TMP, { recursive: true, force: true }).catch((error: NodeJS.ErrnoException) =>
      console.warn(
        `⚠️ 临时目录没删干净（${TMP}）：${error?.code ?? error?.message ?? String(error)}`
      )
    )
  }

  console.log(`\n通过 ${passed}，失败 ${failed}`)
  if (failed > 0) process.exitCode = 1
}

void main()
