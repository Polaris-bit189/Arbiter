/**
 * M4 `inspect_file` 的断言。跑法：
 *
 *   npx tsx --tsconfig tsconfig.test.json scripts/test-mcp-inspect.ts
 *
 * 素材全部**现场造**（`.tmp-test-mcp-inspect/`，跑完删掉），而且**造素材的那次
 * ffmpeg / 7z 调用一律绕开被测代码**：mp4 用 `ffmpeg-static` 的原始路径直接起，
 * zip 用 `7zip-bin` 那个 standalone 的 `7za.exe` 打（与被测代码最终列包用的
 * 完整版 `7z.exe` 是两个二进制）。理由见 docs/NOTES.md 的测试一节：
 * 用被测代码造素材、再用被测代码解读它，是「自己验自己」。
 *
 * 整个套件跑在 **electron 被封锁**的进程里（见下面那段钩子），因为 M4 的
 * MCP Server 就活在那样一个进程里。钩子的自证放在第一条——它不生效的话，
 * 后面每一条都成了恒真的装饰（这个仓库已经因此栽过四次）。
 */
import Module from 'module'
import { spawn } from 'child_process'
import { copyFile, mkdir, readFile, rm, writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import { join, resolve } from 'path'
import ffmpegStatic from 'ffmpeg-static'
import { path7za } from '7zip-bin'
import type { InspectResult } from '../src/mcp/inspect'

const TMP = resolve('.tmp-test-mcp-inspect')

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

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/* ------------------------------------------------------ electron 封锁 */

interface Loader {
  _load(request: string, parent: unknown, isMain: boolean): unknown
  _cache: Record<string, unknown>
}

const loader = Module as unknown as Loader
const originalLoad = loader._load

/**
 * 台账：每一次被拦下的 electron 请求记一条，附带调用方模块的文件名。
 *
 * 光看「模块缓存里有没有 electron」是不够的——**加载失败的模块不会进缓存**，
 * 所以一个一加载就抛错的中间层会让「没碰 electron」这条断言在空集合上恒真。
 * 台账问的是另一个方向：「有没有人**试图**碰」，那个方向抓得住。
 */
const blocked: string[] = []

// 三个形参写明、用 call 转发（不用 `...rest` 再 apply）：`Module._load` 的签名是三元的，
// 展开成 `[request, ...unknown[]]` 会被 tsc 判成元组长度不确定（TS2345）。
loader._load = function (request: string, parent: unknown, isMain: boolean): unknown {
  if (request === 'electron') {
    const caller = (parent as { filename?: string } | undefined)?.filename ?? '(未知调用方)'
    blocked.push(caller)
    throw new Error('electron 在本套件里被刻意封锁（模拟没有 Electron 运行时的 MCP 进程）')
  }
  return originalLoad.call(loader, request, parent, isMain)
}

/* -------------------------------------------------------------- 助手 */

/**
 * 起一个子进程收 stdout/stderr。
 *
 * `spawn('')` 在 Node 上是**同步抛**的，抛在 Promise 的 executor 里会让整个套件
 * 崩在半路、后面几十条断言一条都不跑（反证时看到的是一堆堆栈而不是「哪条红了」）。
 * 所以空路径直接给失败结果，不进 spawn。
 */
function runTool(
  exe: string,
  args: string[]
): Promise<{ code: number; stdout: string; stderr: string }> {
  if (!exe) return Promise.resolve({ code: -1, stdout: '', stderr: '没有可用的可执行文件路径' })
  return new Promise((done) => {
    const child = spawn(exe, args, { windowsHide: true })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.on('error', (error) => done({ code: -1, stdout: '', stderr: messageOf(error) }))
    child.on('close', (code) => done({ code: code ?? -1, stdout, stderr }))
  })
}

/** 造一个**已知**素材：1 秒 / 160x120 / 15fps / h264+aac 的 mp4 */
function makeVideoArgs(output: string): string[] {
  return [
    '-hide_banner',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=duration=1:size=160x120:rate=15',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:duration=1',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-shortest',
    output
  ]
}

/**
 * 侦察一次，并把「抛异常」本身也收成一条可断言的失败。
 *
 * **不让异常逃出去**：逃出去会崩掉整个套件，于是反证时看到的是堆栈而不是「哪条红了」。
 * 这正是本仓库踩过的那次「用 `task!.outputPath!` 把套件崩在半路」的坑。
 */
async function inspectSafely(
  inspectFile: (path: string) => Promise<InspectResult>,
  path: string
): Promise<{ result: InspectResult | null; thrown: string }> {
  try {
    return { result: await inspectFile(path), thrown: '' }
  } catch (error) {
    return { result: null, thrown: messageOf(error) }
  }
}

/* -------------------------------------------------------------- 主流程 */

async function main(): Promise<void> {
  await rm(TMP, { recursive: true, force: true }).catch(() => {})
  await mkdir(TMP, { recursive: true })

  // 1. 钩子自证。**必须是第一条**：它不成立的话，后面每一条都不算数。
  //    借 `electron-import-probe.ts` 那个尚未被加载过的模块去碰 electron——
  //    直接在这里 `await import('electron')` 是测不出来的（原因写在那个文件里）。
  let hookWorks = false
  let hookDetail = '没有抛错——说明它没拦住，整条「无 electron」的结论都是空转'
  try {
    await import('./electron-import-probe')
  } catch (error) {
    hookWorks = true
    hookDetail = messageOf(error).split('\n')[0]
  }
  check('electron 封锁钩子确实生效（自证，防空转断言）', hookWorks, hookDetail)
  check(
    '拦截台账记下了自检那一次（防空转：台账是活的）',
    blocked.length >= 1,
    `记到 ${blocked.length} 条`
  )
  blocked.length = 0 // 自检那次是我们故意触发的，不作数

  // 2. 路径环境。**刻意不走 `scripts/install-test-paths.ts`**：它 import electron
  //    （经 tsconfig 映射到桩），而本套件的前提就是「这个进程里根本没有 electron 可用」。
  //    MCP 入口本来就是自己调一次 `setAppPaths()`，这里照做。
  const { setAppPaths } = await import('../src/main/core/appPaths')
  setAppPaths({
    isPackaged: false,
    resourcesPath: '',
    appPath: resolve('.'),
    userData: TMP,
    downloads: TMP
  })

  // 3. 封锁装上之后再加载被测依赖图。
  let inspectFile: ((path: string) => Promise<InspectResult>) | null = null
  let loadError = ''
  try {
    const mod = await import('../src/mcp/inspect')
    inspectFile = mod.inspectFile
  } catch (error) {
    loadError = messageOf(error).split('\n')[0]
  }
  check(
    'inspect 依赖图能在封锁 electron 的情况下加载（静态 import 一个引擎就会红）',
    inspectFile !== null,
    loadError
  )
  if (!inspectFile) {
    console.log('  ⊘ 依赖图没加载起来，后面的断言无从谈起——不装作通过，也不静默略过')
    report()
    return
  }

  /* ------------------------------------------------- A：已知素材（音视频） */

  const video = join(TMP, 'src.mp4')
  const made = await runTool(ffmpegStatic ?? '', makeVideoArgs(video))
  check('素材生成成功（裸 ffmpeg，不经被测代码）', made.code === 0, made.stderr.slice(-300))

  // 原始真值：单独跑一次 `ffmpeg -i` 把 Duration / Stream 那几行打出来。
  // 下面那些「逐字相等」的断言，对着的就是这几行，而不是对着我们自己的解析结果。
  const raw = await runTool(ffmpegStatic ?? '', ['-hide_banner', '-nostdin', '-i', video])
  const rawLines = raw.stderr
    .split(/\r?\n/)
    .filter((line) => line.includes('Duration:') || line.includes('Stream #'))
  for (const line of rawLines) console.log(`    · 原始: ${line.trim()}`)
  check(
    '原始 stderr 里确实有 `160x120`（防空转：素材本身得对，逐字断言才有意义）',
    rawLines.some((line) => line.includes('160x120')),
    rawLines.join(' | ').slice(0, 200)
  )

  const mp4 = await inspectSafely(inspectFile, video)
  check('mp4 侦察没有抛异常', mp4.thrown === '' && mp4.result !== null, mp4.thrown)

  const m = mp4.result
  // 防空转前提：probe 为 null 的话，后面每一条都会变成 `p !== null && …` 的假通过。
  check('mp4 侦察拿到了 probe（后面几条的防空转前提）', m?.probe != null, m?.note ?? '')
  console.log(`    · mp4 probe: ${JSON.stringify(m?.probe)}`)

  const p = m?.probe ?? null
  check(
    'mp4 时长在 1 秒附近的合理区间',
    p?.durationSec != null && p.durationSec > 0.5 && p.durationSec < 2,
    `durationSec=${p?.durationSec}`
  )
  check(
    'mp4 分辨率逐字等于 160x120',
    p != null && `${p.width}x${p.height}` === '160x120',
    `${p?.width}x${p?.height}`
  )
  check(
    'mp4 视频编解码器含 h264',
    p?.videoCodec != null && p.videoCodec.includes('h264'),
    `videoCodec=${p?.videoCodec}`
  )
  check(
    'mp4 音频编解码器含 aac',
    p?.audioCodec != null && p.audioCodec.includes('aac'),
    `audioCodec=${p?.audioCodec}`
  )
  check('mp4 认得出有视频轨也有音频轨', p?.hasVideo === true && p?.hasAudio === true)
  check('mp4 容器名里有 mp4', p?.format != null && p.format.includes('mp4'), `format=${p?.format}`)

  // 能力矩阵那半边：inspect 必须与 UI / TaskManager 读同一份表（shared/formats.ts）
  const targets = m?.targets ?? []
  check('mp4 的大类是 video', m?.category === 'video', String(m?.category))
  check(
    'mp4 的出口里有 mkv、且没有它自己',
    targets.length > 0 && targets.includes('mkv') && !targets.includes('mp4'),
    JSON.stringify(targets)
  )
  check('mp4 的首选引擎是 ffmpeg', m?.engine === 'ffmpeg', String(m?.engine))
  check('mp4 不需要额外下载引擎', m?.requiresDownload === null, String(m?.requiresDownload))
  check(
    'mp4 存在、有非零体积、扩展名是 mp4',
    m?.exists === true && (m?.size ?? 0) > 0 && m?.ext === 'mp4'
  )
  check('mp4 的 path 是绝对路径', m?.path === video, m?.path)
  check('mp4 没有多余的 note（note 只在有话说时出现）', m?.note === null, String(m?.note))

  /* ------------------------------------------------- B：损坏文件（不许抛） */

  const broken = join(TMP, 'broken.mp4')
  await copyFile(video, broken)
  // 抹掉前 4 个字节：文件类型 box 的长度字段没了，ffmpeg 会报 `moov atom not found`
  const bytes = await readFile(broken)
  await writeFile(broken, bytes.subarray(4))
  check(
    '损坏素材确实造出来了（防空转：上一步真的改到了文件）',
    existsSync(broken) && bytes.length > 4
  )

  const bad = await inspectSafely(inspectFile, broken)
  check('损坏文件不抛异常（返回结构化结果）', bad.thrown === '' && bad.result !== null, bad.thrown)
  // 防空转：文件必须**存在**、扩展名也**认得**。否则 probe:null 只是「文件不存在」的
  // 顺带结果，跟「探了但探不出来」是两回事。
  check(
    '损坏文件确实存在且被认作 video（否则下面 probe:null 是空转）',
    bad.result?.exists === true && bad.result?.category === 'video',
    `exists=${bad.result?.exists} category=${bad.result?.category}`
  )
  check('损坏文件的 probe 为 null（拿不到就是 null，不编）', bad.result?.probe === null)
  check(
    '损坏文件带一句可读的 note，且提到 ffmpeg 报了什么',
    (bad.result?.note ?? '').includes('ffmpeg'),
    String(bad.result?.note)
  )
  console.log(`    · 损坏文件 note: ${bad.result?.note}`)

  /* ------------------------------------------------- C：压缩包（真打一个） */

  const zip = join(TMP, 'two.zip')
  const f1 = join(TMP, 'one.txt')
  const f2 = join(TMP, 'two.txt')
  await writeFile(f1, 'one')
  await writeFile(f2, 'two')
  // 用 7zip-bin 那个 standalone 的 7za.exe 打包——被测代码列包用的是 engines/sevenzip.ts
  // 解析出来的完整版 7z.exe，两者不是同一个二进制，免得「自己验自己」
  const packed = await runTool(path7za ?? '', ['a', '-tzip', '-y', zip, f1, f2])
  check(
    '压缩包素材生成成功（7za.exe，与被测代码列包用的不是同一个二进制）',
    packed.code === 0,
    packed.stderr.slice(-300)
  )
  check('压缩包素材确实是存在的文件（防空转）', existsSync(zip))

  const arch = await inspectSafely(inspectFile, zip)
  check('zip 侦察没有抛异常', arch.thrown === '' && arch.result !== null, arch.thrown)
  console.log(`    · zip probe: ${JSON.stringify(arch.result?.probe)}`)
  check(
    'zip 被认作 archive 并拿到了 probe（防空转前提）',
    arch.result?.category === 'archive' && arch.result?.probe != null,
    String(arch.result?.note)
  )
  check(
    'zip 的条目数为 2',
    arch.result?.probe?.entries === 2,
    `entries=${arch.result?.probe?.entries}`
  )
  check(
    'zip 侦察顺带暴露了「RAR 能不能解」',
    typeof arch.result?.probe?.rarSupported === 'boolean',
    String(arch.result?.probe?.rarSupported)
  )

  /* ------------------------------------------------- D：不认识的扩展名 */

  const weird = join(TMP, 'thing.xyz')
  await writeFile(weird, 'x')
  const unk = await inspectSafely(inspectFile, weird)
  check('不认识的扩展名不抛异常', unk.thrown === '' && unk.result !== null, unk.thrown)
  // 防空转：文件必须存在。否则「category 为 null」在「文件不存在」那条路上也成立。
  check('未知扩展名的文件确实存在（防空转）', unk.result?.exists === true)
  check(
    '未知扩展名的 category 为 null',
    unk.result?.category === null,
    String(unk.result?.category)
  )
  check(
    '未知扩展名的 targets 是空数组',
    Array.isArray(unk.result?.targets) && unk.result?.targets.length === 0,
    JSON.stringify(unk.result?.targets)
  )
  check(
    '未知扩展名带一句可读的 note，且点出了扩展名',
    (unk.result?.note ?? '').includes('xyz'),
    String(unk.result?.note)
  )
  console.log(`    · 未知扩展名 note: ${unk.result?.note}`)

  /* ------------------------------------------------- E：文件不存在 */

  const missing = join(TMP, 'nope.mp4')
  const gone = await inspectSafely(inspectFile, missing)
  check('文件不存在时不抛异常', gone.thrown === '' && gone.result !== null, gone.thrown)
  // 防空转：扩展名是认得的（mp4）。不认得的扩展名在「文件不存在」时也会 category:null，
  // 那样就分不清走的是哪条路。
  check(
    '不存在的 mp4 仍然是 video 大类（防空转：证明走的是「文件不存在」这条分支）',
    gone.result?.category === 'video',
    String(gone.result?.category)
  )
  check(
    '文件不存在时 exists:false / size:null / probe:null',
    gone.result?.exists === false && gone.result?.size === null && gone.result?.probe === null
  )
  check(
    '文件不存在时 note 里说清了「不存在」',
    (gone.result?.note ?? '').includes('不存在'),
    String(gone.result?.note)
  )

  /* ------------------------------------------------- F：目录 / 文档 */

  const dir = await inspectSafely(inspectFile, TMP)
  check(
    '路径是目录时明确说出来，而不是当成 0 字节的文件',
    dir.thrown === '' && dir.result?.exists === true && (dir.result?.note ?? '').includes('目录'),
    String(dir.result?.note)
  )

  const txtPath = join(TMP, 'note.txt')
  await writeFile(txtPath, '你好')
  const doc = await inspectSafely(inspectFile, txtPath)
  check(
    '文档类不做子进程侦察，但能力矩阵那半边照常给（防空转：targets 非空）',
    doc.thrown === '' &&
      doc.result?.category === 'document' &&
      (doc.result?.targets.length ?? 0) > 0 &&
      doc.result?.probe === null &&
      (doc.result?.note ?? '').length > 0,
    `category=${doc.result?.category} targets=${JSON.stringify(doc.result?.targets)} note=${doc.result?.note}`
  )

  // 上面那些 `requiresDownload === null` 是「不该要的时候没要」，还缺「该要的时候要了」——
  // 只有前者的话，一个恒返回 null 的实现照样全绿。doc 走 LibreOffice，正是该要的那一侧。
  const docPath = join(TMP, 'legacy.doc')
  await writeFile(docPath, '这里不需要真的是一份 doc')
  const office = await inspectSafely(inspectFile, docPath)
  check(
    'doc 的首选引擎是 libreoffice 且被标成「要先下载引擎」（防空转：requiresDownload 不是恒 null）',
    office.result?.engine === 'libreoffice' && office.result?.requiresDownload === 'libreoffice',
    `engine=${office.result?.engine} requiresDownload=${office.result?.requiresDownload}`
  )

  /* ------------------------------------------------- H：图片（sharp 那条路） */

  const pngPath = join(TMP, 'pic.png')
  // 素材用 **ffmpeg** 造，读元数据的却是 sharp——两个实现，免得「自己验自己」。
  // `-update 1` 是为了别让 image2 复用器唠叨「用 %03d 命名序列」。
  const pngMade = await runTool(ffmpegStatic ?? '', [
    '-hide_banner',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'testsrc=size=64x48:rate=1',
    '-frames:v',
    '1',
    '-update',
    '1',
    pngPath
  ])
  check(
    '图片素材生成成功（ffmpeg 造、sharp 读，两边不是同一个实现）',
    pngMade.code === 0,
    pngMade.stderr.slice(-300)
  )

  const img = await inspectSafely(inspectFile, pngPath)
  check('图片侦察没有抛异常', img.thrown === '' && img.result !== null, img.thrown)
  const ip = img.result?.probe ?? null
  console.log(`    · png probe: ${JSON.stringify(ip)}`)
  check(
    '图片被认作 image 并拿到了 probe（防空转前提）',
    img.result?.category === 'image' && ip != null,
    String(img.result?.note)
  )
  check(
    '图片尺寸逐字等于 64x48',
    ip != null && `${ip.width}x${ip.height}` === '64x48',
    `${ip?.width}x${ip?.height}`
  )
  check('图片的 format 是 sharp 自述的 png', ip?.format === 'png', String(ip?.format))
  check(
    '图片没有时长、也没有编解码器（拿不到就是 null，不编）',
    ip != null && ip.durationSec === null && ip.videoCodec === null && ip.audioCodec === null
  )

  /* ------------------------------------- G：封锁 electron 下真的跑通了一次 */

  const again = await inspectSafely(inspectFile, video)
  check(
    '封锁 electron 之后仍能完成一次真实侦察（整条链路没碰 Electron 运行时）',
    again.result?.probe?.videoCodec?.includes('h264') === true,
    again.thrown || String(again.result?.note)
  )
  // 上面那条只看结果，下面这条看**有没有人试图加载 electron**——包括加载失败的。
  check(
    '整轮侦察里没有任何模块试图加载 electron（台账为空）',
    blocked.length === 0,
    `${blocked.length} 处试图加载，调用方：${blocked.join(' , ')}`
  )

  await rm(TMP, { recursive: true, force: true }).catch(() => {})
  report()
}

function report(): void {
  console.log(`\n=== 通过 ${passed} / 失败 ${failed} ===`)
  process.exit(failed === 0 ? 0 : 1)
}

// 套件自己崩掉要**显式报出来**：静默崩在中间的话，反证脚本只会看到「后面几条断言没红」，
// 而那与「断言确实抓不住错误」在输出上一模一样。
main().catch((error) => {
  failed += 1
  console.error('\n套件自身抛异常（这是基础设施失败，不是断言红）：', error)
  report()
})
