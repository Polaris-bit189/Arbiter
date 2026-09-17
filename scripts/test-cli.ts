import { spawnSync } from 'child_process'
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'fs'
import { join, resolve } from 'path'
import ffmpegPath from 'ffmpeg-static'
import { parseCliRequest, parseConvertRequest } from '../src/main/core/cli'

/**
 * `arbiter` CLI（`src/cli/main.ts`）的自测。
 *
 *   npx tsx --tsconfig tsconfig.test.json scripts/test-cli.ts
 *
 * ## 为什么必须真起进程
 *
 * 被测对象是**一个独立进程的契约**：退出码、stdout 上有什么、stderr 上有什么。
 * 在进程内 import `src/cli/main.ts` 是做不到的——它在模块体里就 `process.exit()`
 * （见那个文件的引导段），import 即启动。所以下面全部用 `spawnSync` 真跑。
 *
 * ## 三条承重断言（都不是「看着对」能替代的）
 *
 * 1. **stdout 是数据通道，永远是「合法 JSON 或空」。**
 *    `--json` 时它必须是**恰好一个** JSON 对象——成功、失败、参数错，任何一条路径上
 *    漏进一行日志，调用方（Claude Code 的 hook、任何跑 bash 的 agent）拿到的就是
 *    `Unexpected end of JSON input`，而真正的原因在 stderr 上、它读不到。
 *    这里连**依赖内部的 `console.log`** 都验：用 NODE_OPTIONS 注入一段定时器往
 *    stdout 写，断言它被闸门拦下、且 stdout 仍然是那一个干净的 JSON。
 *
 * 2. **退出码是给 agent 用的分类信号。** 「参数错」「引擎缺失」「转换失败」三者必须
 *    互不相同——全退 1 的话，调用方唯一的出路是去读 stderr 里的中文，
 *    而按文案分类正是 docs/NOTES.md 约束 23 第 3 条禁止的事。
 *
 * 3. **重定向到文件时的编码。** Windows 上 stdout 变成文件之后按什么码页读，
 *    是那种「开发机上永远现形不了」的坑（同约束 23 第 3 条的 `reg.exe` 吐 GBK）。
 *    所以下面**每一次** spawn 都把 stdout 接到文件上，再按 UTF-8 读回来——
 *    中文路径、中文内容都在断言里走一遍往返。
 *
 * ## 环境隔离
 *
 * `ARBITER_USER_DATA` 指到临时目录：不设的话 CLI 会读**用户真实的那份设置**
 * （这台机器上 `outputDir` 是 `D:\wjzcq`、`outputBesideSource` 是 false），
 * 产物就跑到用户目录里去了。设了之后走 `defaults()`：落在源文件旁边。
 *
 * ⚠️ 临时目录用 `.tmp-` 前缀（`.gitignore` 挡着），跑完必删——**残留会被
 * electron-builder 打进 asar**（docs/NOTES.md 约束 30）。
 */

// 所有 npm script 都从仓库根跑，子进程的 cwd 也钉在这里。刻意不用 `__dirname` /
// `import.meta.url`：这个文件在 tsx 下究竟走 CJS 还是 ESM 由 tsx 判定，
// 那两种写法各有一半概率是 undefined。
const ROOT = process.cwd()
const CLI_MAIN = join(ROOT, 'src', 'cli', 'main.ts')
const HOOK = join(ROOT, 'plugins', 'arbiter', 'hooks', 'read-convert.mjs')

const TMP_ROOT = join(ROOT, '.tmp-test-cli')
const WORK = join(TMP_ROOT, 'work')
/** 带空格与中文的目录名。编码坑最爱在这种地方现形，而纯 ASCII 路径永远测不出来 */
const CJK_DIR = join(WORK, '中文 目录')
const USER_DATA = join(TMP_ROOT, 'userdata')
const DOWNLOADS = join(TMP_ROOT, 'downloads')
const EMPTY_APP = join(TMP_ROOT, 'empty-app')

const SOURCE_HTML = join(CJK_DIR, '报告.html')
const BROKEN_PNG = join(CJK_DIR, '坏掉的.png')
const MISSING = join(CJK_DIR, '根本不存在.png')
const FAKE_EPUB = join(CJK_DIR, '书.epub')
/** 扩展名是 `.docx`、内容却不是 zip（审计 2026-09-15 §3.3 的原始素材形状） */
const BROKEN_DOCX = join(CJK_DIR, '坏掉的.docx')
/** 包装器的**成功**路径对照组：合法 CSV 走的是同一个被包装的调用点 */
const GOOD_CSV = join(CJK_DIR, '成绩.csv')
/** 配方那一节要一段**真视频**：`mode` 只对视频有意义（约束 18） */
const SOURCE_MP4 = join(CJK_DIR, '短片.mp4')

const HTML_BODY =
  '<html><body><h1>调律者 报告</h1><p>这是一段中文内容，用于验证编码往返。</p></body></html>'
/** 产物里应当出现的那几个字。用**字面量**断言，不用「非空」——非空说明不了编码对不对 */
const CJK_MARK = '这是一段中文内容，用于验证编码往返'

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

/* ------------------------------------------------------------------ 装配 */

function prepare(): void {
  // 跑之前先清一次：上一次崩在半路会留下现场，而残留会被打包塞进 asar（约束 30）。
  rmSync(TMP_ROOT, { recursive: true, force: true })
  mkdirSync(CJK_DIR, { recursive: true })
  mkdirSync(USER_DATA, { recursive: true })
  mkdirSync(DOWNLOADS, { recursive: true })
  mkdirSync(EMPTY_APP, { recursive: true })

  writeFileSync(SOURCE_HTML, HTML_BODY, 'utf8')
  // 200 个 'A'：PNG 的签名对不上，sharp 必然报 unsupported image format。
  // 刻意用固定字节而不是随机数——不确定的输入会产生不确定的失败信息。
  writeFileSync(BROKEN_PNG, Buffer.alloc(200, 0x41))
  writeFileSync(FAKE_EPUB, 'x')
  // 同样刻意用固定字节：JSZip / SheetJS 的报错文案随版本变，而我们要断言的是
  // **归类**（source_corrupt / retryable:false / 中文 message），不是那句原文。
  writeFileSync(
    BROKEN_DOCX,
    Buffer.from('这不是一个 zip，只是一个改了扩展名的文本文件。'.repeat(8), 'utf8')
  )
  writeFileSync(GOOD_CSV, '姓名,分数\n甲,90\n乙,85\n', 'utf8')

  // 一段 1 秒的 h264 + aac。**参数是拣着选的**：h264 + aac 装得进 mp4 / mkv，
  // 而**装不进 webm**（那边只收 VP8/VP9/AV1 + Vorbis/Opus，见约束 18）——
  // 配方那一节的 10e/10f 靠的正是这个组合。
  // 用 ffmpeg-static 现造而不放一个二进制进 fixtures：几 KB 的东西没必要入库，
  // 而现造能保证它是**这台机器上这份 ffmpeg** 真写得出来的。
  // `ffmpeg-static` 的类型是 `string | null`（它可能装不上）。这里**显式判一次**：
  // 拿 null 去 spawn 报的是 `The "file" argument must be of type string`，
  // 与真正的原因（没装上）看起来毫不相干，而这正是本仓库反复记的那类误导。
  if (ffmpegPath === null) throw new Error('ffmpeg-static 没装上，跑 `npm ci` 重来')
  const built = spawnSync(
    ffmpegPath,
    [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc=size=160x120:rate=15',
      '-t',
      '1',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      SOURCE_MP4
    ],
    { encoding: 'utf8' }
  )
  if (built.status !== 0) {
    // 造不出素材就**当场抛**：让套件崩在半路，而不是让下面那一节在「源文件不存在」
    // 上以一堆看不懂的红收场（本仓库为「失败盖住后续断言」踩过）。
    throw new Error(`造 mp4 素材失败：${String(built.stderr).slice(-400)}`)
  }
}

function cleanup(): void {
  rmSync(TMP_ROOT, { recursive: true, force: true })
}

/** 基础环境：路径全部隔离，不碰用户真实的那份设置与输出目录。 */
function baseEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    TSX_TSCONFIG_PATH: 'tsconfig.test.json',
    ARBITER_USER_DATA: USER_DATA,
    ARBITER_DOWNLOADS: DOWNLOADS
  }
}

/**
 * 一个**不带任何 `ARBITER_*`** 的环境，再加 `extra` 里点名要的那几条。
 *
 * 这是 `tsx src/cli/main.ts` 那个开发形态的真实形状（五个路径全靠猜），
 * 也是 `[11]` 那节唯一能验「哪些值没给」的方式：`baseEnv()` 里的
 * `ARBITER_USER_DATA` / `ARBITER_DOWNLOADS` 会把那个形状**抹平**——两条都不再是「猜的」。
 * `TSX_TSCONFIG_PATH` 得留着，`@shared/*` 别名靠它。
 *
 * ⚠️ 先铺 `baseEnv()` 再删 `ARBITER_*`（而不是只铺 `extra`）：开发机的 `process.env`
 * 里可能本来就躺着一条，那种情况下「不带的那个形态」根本测不出来。
 */
function bareEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...baseEnv() }
  for (const key of Object.keys(env)) {
    if (key.startsWith('ARBITER_')) delete env[key]
  }
  return { ...env, ...extra }
}

interface RunResult {
  code: number | null
  /** **按 UTF-8 从重定向文件里读回来的** stdout，不是管道里的字符串 */
  stdout: string
  stderr: string
}

let spawnSeq = 0
/**
 * 真跑一次 CLI。stdout **一律接到文件上**——这样「重定向到文件时的编码」这条
 * 在每一次调用上都被检验一遍，而不是只在某一个专门的用例里。
 *
 * `replaceEnv` 时 env 是**整份替换**（不叠 `baseEnv()`），理由见 `bareEnv()`。
 */
function runCli(
  args: string[],
  env?: NodeJS.ProcessEnv,
  options?: { replaceEnv?: boolean }
): RunResult {
  spawnSeq += 1
  const stdoutFile = join(TMP_ROOT, `stdout-${spawnSeq}.txt`)
  const fd = openSync(stdoutFile, 'w')
  const childEnv = options?.replaceEnv === true ? (env ?? {}) : { ...baseEnv(), ...(env ?? {}) }
  try {
    const result = spawnSync(process.execPath, ['--import', 'tsx', CLI_MAIN, ...args], {
      cwd: ROOT,
      env: childEnv,
      stdio: ['ignore', fd, 'pipe'],
      encoding: 'utf8',
      windowsHide: true,
      timeout: 120_000
    })
    return {
      code: result.status,
      stdout: readFileSync(stdoutFile, 'utf8'),
      stderr: result.stderr ?? ''
    }
  } finally {
    closeSync(fd)
  }
}

/** 解析 stdout 上的那一个 JSON。解不开就返回 null（调用方据此报红）。 */
function jsonOf(run: RunResult): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(run.stdout)
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

/** `JSON.parse` 成功的**唯一**判据：不许有前后缀、不许有第二段。 */
function isExactlyOneJson(text: string): boolean {
  if (text.trim() === '') return false
  try {
    JSON.parse(text)
    return true
  } catch {
    return false
  }
}

/** 从一次 `--json` 的返回值里取出第一条结果。 */
function firstResult(run: RunResult): Record<string, unknown> | undefined {
  const payload = jsonOf(run)
  const results = payload?.results as Array<Record<string, unknown>> | undefined
  return results?.[0]
}

/* ------------------------------------------------------------------ [1] 纯逻辑 */

function testParsing(): void {
  console.log('\n[1] argv 解析（parseCliRequest，纯函数）')

  const two = parseCliRequest(['convert', 'a.mkv', 'b.mkv'], 'C:\\work')
  check(
    '多个文件：全部收下，to/json/out 都是默认值',
    two.kind === 'convert' &&
      two.options.request.paths.length === 2 &&
      two.options.request.to === null &&
      two.options.json === false &&
      two.options.out === null,
    JSON.stringify(two)
  )

  const rel = parseCliRequest(['convert', 'sub\\a.mkv'], 'C:\\work')
  check(
    '相对路径按 cwd resolve 成绝对',
    rel.kind === 'convert' && rel.options.request.paths[0] === resolve('C:\\work', 'sub\\a.mkv'),
    JSON.stringify(rel)
  )

  const dash = parseCliRequest(['convert', '-dash.mp4'], 'C:\\work')
  check(
    '`-` 开头的文件名也被 resolve 成绝对（约束 2 的参数注入防线）',
    dash.kind === 'convert' &&
      dash.options.request.paths[0] !== '-dash.mp4' &&
      !(dash.options.request.paths[0] ?? '').startsWith('-'),
    JSON.stringify(dash)
  )

  const upper = parseCliRequest(['convert', 'a.png', '--to', '.PNG'], 'C:\\work')
  check(
    '--to 去点 + 转小写',
    upper.kind === 'convert' && upper.options.request.to === 'png',
    JSON.stringify(upper)
  )

  const eq = parseCliRequest(['convert', 'a.png', '--to=jpg'], 'C:\\work')
  check(
    '--to=x 这种写法也认',
    eq.kind === 'convert' && eq.options.request.to === 'jpg',
    JSON.stringify(eq)
  )

  const badShape = parseCliRequest(['convert', 'a.png', '--to', 'a b'], 'C:\\work')
  check(
    '--to 形状不对 → error（不是静默丢掉）',
    badShape.kind === 'error',
    JSON.stringify(badShape)
  )

  check(
    '--to= 空值 → error',
    parseCliRequest(['convert', 'a.png', '--to='], 'C:\\work').kind === 'error'
  )

  const unknown = parseCliRequest(['convert', 'a.png', '--too', 'jpg'], 'C:\\work')
  check(
    '未知选项 → error（不静默当成文件名）',
    unknown.kind === 'error' && unknown.message.includes('--too'),
    JSON.stringify(unknown)
  )

  check('convert 后面没有文件 → error', parseCliRequest(['convert'], 'C:\\work').kind === 'error')

  const jsonErr = parseCliRequest(['convert', '--json'], 'C:\\work')
  check(
    '用法错的返回值也带 json 标记（这样 stdout 上还能给出合法 JSON）',
    jsonErr.kind === 'error' && jsonErr.json === true,
    JSON.stringify(jsonErr)
  )

  check(
    '--out 配多个源 → error',
    parseCliRequest(['convert', 'a.png', 'b.png', '--out', 'x.png'], 'C:\\work').kind === 'error'
  )

  const outOne = parseCliRequest(['convert', 'a.png', '--out', 'sub\\x.png'], 'C:\\work')
  check(
    '--out 也 resolve 成绝对',
    outOne.kind === 'convert' && outOne.options.out === resolve('C:\\work', 'sub\\x.png'),
    JSON.stringify(outOne)
  )

  check('裸 help → help', parseCliRequest(['help'], 'C:\\work').kind === 'help')
  check(
    '-h 在子命令之后也生效',
    parseCliRequest(['convert', 'a.png', '-h'], 'C:\\work').kind === 'help'
  )
  check('--version → version', parseCliRequest(['--version'], 'C:\\work').kind === 'version')

  const unknownSub = parseCliRequest(['frobnicate'], 'C:\\work')
  check('未知子命令 → error', unknownSub.kind === 'error', JSON.stringify(unknownSub))
  check('没有参数 → error', parseCliRequest([], 'C:\\work').kind === 'error')

  // 回归锚点：M8 那条路（右键菜单 / 发送到）一个字都没被这里的改动碰到。
  const m8 = parseConvertRequest(['C:\\app\\Arbiter.exe', '--convert', 'C:\\video\\a.mkv'], 'C:\\')
  check(
    'parseConvertRequest（M8 那条路）仍然照旧',
    m8.kind === 'convert' && m8.request.paths[0] === 'C:\\video\\a.mkv' && m8.request.to === null,
    JSON.stringify(m8)
  )
}

/* ------------------------------------------------------------------ [2] 帮助与版本 */

function testHelpAndVersion(): void {
  console.log('\n[2] --help / --version')

  const help = runCli(['--help'])
  check('--help 退出码 0', help.code === 0, `实际 ${help.code}`)
  check(
    '--help 的用法文本在 stdout 上',
    help.stdout.includes('arbiter convert'),
    help.stdout.slice(0, 120)
  )
  check('--help 输出的不是 JSON（这是给人看的）', !isExactlyOneJson(help.stdout))

  const version = runCli(['--version'])
  check('--version 退出码 0', version.code === 0, `实际 ${version.code}`)
  check(
    '--version 打出来的是个版本号',
    /^\d+\.\d+\.\d+/.test(version.stdout.trim()),
    version.stdout.trim()
  )
}

/* ------------------------------------------------------------------ [3] 真转换 */

function testConvert(): void {
  console.log('\n[3] 真转换（html → md，纯 JS、不下载引擎）')

  const json = runCli(['convert', SOURCE_HTML, '--to', 'md', '--json'])
  check('成功时退出码 0', json.code === 0, `实际 ${json.code}\n${json.stderr.slice(-500)}`)
  check(
    '成功时 stdout 是**恰好一个**合法 JSON',
    isExactlyOneJson(json.stdout),
    json.stdout.slice(0, 200)
  )

  const payload = jsonOf(json)
  const results = payload?.results as Array<Record<string, unknown>> | undefined
  const first = results?.[0]
  check(
    'ok 为 true 且 results 恰好一条',
    payload?.ok === true && results?.length === 1,
    json.stdout.slice(0, 300)
  )
  check('from / to 对得上', first?.from === 'html' && first?.to === 'md', JSON.stringify(first))
  check(
    'engine 是文档引擎（pdf 这个 key），没被路由错',
    first?.engine === 'pdf',
    String(first?.engine)
  )

  const output = typeof first?.output === 'string' ? first.output : ''
  /**
   * 产物在磁盘上的体积。**读不到就是 `null`。**
   *
   * ⚠️ 这一段是**被反证逼出来的**：原来两条断言与一条 detail 各自就地调
   * `statSync(output).size`，而「路径不存在」正是它们要报的那个失败——
   * 于是**在报告失败的路上先抛 `ENOENT`**，异常冒出 `testConvert()` 的 try
   * （那里只 finally 了 cleanup），**整个套件当场结束**：后面约 40 条断言一条都跑不到、
   * 连汇总行都没有。表现是「半路没了」而不是「有断言红了」，极难归因。
   *
   * 这是 `docs/NOTES.md` 测试那节记过的同一个反模式（「测试代码自己在失败时抛异常把整个
   * 套件崩在半路、盖住后面几十条断言」）。**断言可以红，但不许抛。**
   */
  const diskSize = output === '' || !existsSync(output) ? null : statSync(output).size
  check('产物路径存在且非空文件', output !== '' && diskSize !== null && diskSize > 0, output)
  check(
    '**bytes 与磁盘上的体积逐字节吻合**（字段能对上产物，不是编的）',
    typeof first?.bytes === 'number' && diskSize !== null && first.bytes === diskSize,
    `${String(first?.bytes)} vs ${diskSize ?? '（读不到）'}`
  )
  check(
    'duration_ms 是个非负数字',
    typeof first?.duration_ms === 'number' && (first.duration_ms as number) >= 0,
    String(first?.duration_ms)
  )
  check(
    'source 是绝对路径且等于传入的那个文件',
    first?.source === SOURCE_HTML,
    String(first?.source)
  )

  console.log('\n[4] 不带 --json：stdout 只有产物路径')
  // 这一跑刻意用 --out 钉住落点：上一条已经在源文件旁边写下了 `报告.md`，
  // 默认落点会撞名避让成 `报告 (1).md`——那正是约束 9 的行为，但拿它当断言
  // 只会把「输出名冲突」这件事混进来。
  const plainPath = join(CJK_DIR, '纯文本模式产物.md')
  const plain = runCli(['convert', SOURCE_HTML, '--to', 'md', '--out', plainPath])
  check('退出码 0', plain.code === 0, `实际 ${plain.code}`)
  check(
    'stdout 恰好一行、就是产物路径（没有别的字）',
    plain.stdout.split('\n').filter((l) => l !== '').length === 1 &&
      plain.stdout.trim() === plainPath,
    JSON.stringify(plain.stdout)
  )

  console.log('\n[5] --out：产物落到指定路径')
  const wantPath = join(CJK_DIR, '指定的产物.md')
  const withOut = runCli(['convert', SOURCE_HTML, '--to', 'md', '--out', wantPath, '--json'])
  check('退出码 0', withOut.code === 0, `实际 ${withOut.code}`)
  check(
    '--out 被采纳（产物的 output 就是那个路径）',
    firstResult(withOut)?.output === wantPath,
    JSON.stringify(firstResult(withOut))
  )
  check('那个文件真的在磁盘上', existsSync(wantPath))
}

/* ------------------------------------------------------------------ [6] 编码往返 */

function testEncoding(): void {
  console.log('\n[6] 重定向到文件时的编码（中文路径 + 中文内容往返）')

  const run = runCli(['convert', SOURCE_HTML, '--to', 'md', '--json'])
  const output =
    typeof firstResult(run)?.output === 'string' ? (firstResult(run)?.output as string) : ''

  // 每一次 spawn 的 stdout 都是**从文件里按 UTF-8 读回来的**，所以下面三条
  // 同时在验「写出去的字节是 UTF-8」与「读回来的解码方式对得上」。
  check('读回的 JSON 里，中文目录名一字不差', output.includes('中文 目录'), JSON.stringify(output))
  check('读回的 JSON 里，中文文件名一字不差', output.includes('报告'), JSON.stringify(output))
  // ⚠️ 这一条**先判存在再读**。原来的写法是
  //   `output !== '' && readFileSync(output, 'utf8').includes(CJK_MARK)`
  // 加上一条同样直读的 detail —— 而「产物没写出来」正是它要报的那个失败，
  // 于是**在报告失败的路上先抛 `ENOENT`**，异常冒出 `testConvert()` 的 try，
  // 整个套件当场结束，后面几十条断言一条都跑不到、连汇总行都没有。
  // **断言可以红，但不许抛。**
  const body = output === '' || !existsSync(output) ? null : readFileSync(output, 'utf8')
  check(
    '**产物内容**里的中文也一字不差（端到端，不只是路径）',
    body !== null && body.includes(CJK_MARK),
    body === null ? '(没有产物)' : body.slice(0, 120)
  )
}

/* ------------------------------------------------------------------ [7] stdout 纯净性 */

function testStdoutPurity(): void {
  console.log('\n[7] stdout 纯净性（**最重要的一组**）')

  const failedRun = runCli(['convert', BROKEN_PNG, '--to', 'jpg', '--json'])
  check('转换失败的退出码是 1', failedRun.code === 1, `实际 ${failedRun.code}`)
  check(
    '**转换失败时 stdout 仍然是恰好一个合法 JSON**',
    isExactlyOneJson(failedRun.stdout),
    JSON.stringify(failedRun.stdout.slice(0, 200))
  )

  const failPayload = jsonOf(failedRun)
  const failError = failPayload?.error as Record<string, unknown> | undefined
  check(
    'ok 为 false 且带一个 error 对象',
    failPayload?.ok === false && typeof failError === 'object',
    failedRun.stdout.slice(0, 200)
  )
  check(
    '失败原因码是 source_corrupt',
    failError?.code === 'source_corrupt',
    JSON.stringify(failError?.code)
  )
  check(
    'log_tail 在**顶层**（引擎的原始报错，调用方靠它分辨原因）',
    Array.isArray(failError?.log_tail) && (failError.log_tail as unknown[]).length > 0,
    JSON.stringify(failError)
  )
  check(
    'stdout 里没有混进诊断日志',
    !failedRun.stdout.includes('失败：') && !failedRun.stdout.includes('[arbiter]'),
    JSON.stringify(failedRun.stdout.slice(0, 200))
  )

  const failedPlain = runCli(['convert', BROKEN_PNG, '--to', 'jpg'])
  check('转换失败（不带 --json）退出码仍是 1', failedPlain.code === 1, `实际 ${failedPlain.code}`)
  check(
    '失败且没有 --json 时 stdout 一个字节都没有',
    failedPlain.stdout === '',
    JSON.stringify(failedPlain.stdout.slice(0, 200))
  )
  check(
    '诊断确实在 stderr 上（不是被吞了）',
    failedPlain.stderr.includes('失败：'),
    failedPlain.stderr.slice(-200)
  )

  const usage = runCli(['convert', MISSING, '--to', 'jpg', '--json'])
  check('参数错（源不存在）退出码是 2', usage.code === 2, `实际 ${usage.code}`)
  check('参数错时 stdout 也是合法 JSON', isExactlyOneJson(usage.stdout), usage.stdout.slice(0, 200))
  const usageError = jsonOf(usage)?.error as Record<string, unknown> | undefined
  check(
    '参数错的码是 source_missing',
    usageError?.code === 'source_missing',
    JSON.stringify(usageError?.code)
  )

  const unknown = runCli(['convert', SOURCE_HTML, '--too', 'md', '--json'])
  check('未知选项退出码 2', unknown.code === 2, `实际 ${unknown.code}`)
  check(
    '未知选项时 stdout 也是合法 JSON',
    isExactlyOneJson(unknown.stdout),
    unknown.stdout.slice(0, 200)
  )

  // 闸门本身：注入一个「依赖内部」的 console.log，看它会不会漏进 stdout。
  const probe = join(TMP_ROOT, 'probe.cjs')
  // 两条来路都要试：console.log 走的是「改道 stderr」那道防线，
  // 直接的 process.stdout.write 走的是「逐帧拦下」那道。只测一条会漏掉另一条——
  // 而漏掉的那条恰恰是依赖内部最可能用的写法。
  writeFileSync(
    probe,
    'setTimeout(() => {\n' +
      "  console.log('PROBE_VIA_CONSOLE')\n" +
      "  process.stdout.write('PROBE_VIA_RAW_WRITE\\n')\n" +
      '}, 100)\n'
  )
  const gated = runCli(['convert', SOURCE_HTML, '--to', 'md', '--json'], {
    NODE_OPTIONS: `--require ${probe}`
  })
  check(
    '**闸门有效**：console.log 与直接的 process.stdout.write 都进不了 stdout',
    gated.code === 0 &&
      isExactlyOneJson(gated.stdout) &&
      !gated.stdout.includes('PROBE_VIA_CONSOLE') &&
      !gated.stdout.includes('PROBE_VIA_RAW_WRITE'),
    JSON.stringify(gated.stdout.slice(0, 200))
  )
  check(
    '两条写入都改道到了 stderr，且原始写入留了「拦下一段」的记录（不是静默丢弃）',
    gated.stderr.includes('PROBE_VIA_CONSOLE') &&
      gated.stderr.includes('PROBE_VIA_RAW_WRITE') &&
      gated.stderr.includes('拦下一段'),
    gated.stderr.slice(-400)
  )
}

/* ------------------------------------------------------------------ [8] 退出码 */

function testExitCodes(): void {
  console.log('\n[8] 三种退出码必须互不相同')

  // 引擎缺失：把**全部**候选路径都掐掉——
  //   bundledEnginePath 看 ARBITER_APP_PATH、下载那份看 userData/engines、
  //   系统安装看 ProgramFiles。三个都指到临时目录，判据就成了确定性的，
  //   不依赖这台机器上碰巧装了什么（否则那条断言在别人机器上会变成假红）。
  const isolatedApp = join(TMP_ROOT, 'isolated-app')
  const isolatedPF = join(TMP_ROOT, 'isolated-pf')
  mkdirSync(isolatedApp, { recursive: true })
  mkdirSync(isolatedPF, { recursive: true })

  const missing = runCli(['convert', FAKE_EPUB, '--to', 'txt', '--json'], {
    ARBITER_APP_PATH: isolatedApp,
    ARBITER_USER_DATA: join(TMP_ROOT, 'isolated-userdata'),
    ProgramFiles: isolatedPF,
    'ProgramFiles(x86)': isolatedPF
  })
  check(
    '引擎缺失退出码是 3',
    missing.code === 3,
    `实际 ${missing.code}\n${missing.stderr.slice(-400)}`
  )
  check(
    '引擎缺失时 stdout 也是合法 JSON',
    isExactlyOneJson(missing.stdout),
    missing.stdout.slice(0, 200)
  )
  check(
    '引擎缺失的码是 engine_missing',
    (jsonOf(missing)?.error as Record<string, unknown> | undefined)?.code === 'engine_missing',
    JSON.stringify(jsonOf(missing)?.error)
  )

  const usage = runCli(['convert', MISSING, '--to', 'jpg', '--json'])
  const broken = runCli(['convert', BROKEN_PNG, '--to', 'jpg', '--json'])

  check(
    '**参数错(2) / 引擎缺失(3) / 转换失败(1) 两两不同**',
    usage.code !== missing.code && usage.code !== broken.code && missing.code !== broken.code,
    `参数错=${usage.code} 引擎缺失=${missing.code} 转换失败=${broken.code}`
  )
}

/* ------------------------------------------------------------------ [9] hook */

function testHook(): void {
  console.log('\n[9] PreToolUse hook：**失败必须放行**')

  const payloadFor = (toolName: string, filePath: string): string =>
    JSON.stringify({
      session_id: 's',
      hook_event_name: 'PreToolUse',
      tool_name: toolName,
      tool_input: { file_path: filePath },
      cwd: ROOT
    })

  const runHook = (
    input: string,
    env?: NodeJS.ProcessEnv
  ): { code: number | null; stdout: string } => {
    const result = spawnSync(process.execPath, [HOOK], {
      input,
      encoding: 'utf8',
      env: { ...baseEnv(), ...(env ?? {}) },
      windowsHide: true,
      timeout: 60_000
    })
    return { code: result.status, stdout: result.stdout ?? '' }
  }

  // ⚠️ 这一节只覆盖**放行**的那几条路。正路（真转出临时 md 并 `updatedInput` 改写）
  // 需要一个构建过的应用（`out/main/cli.js`），不能进这份「干净 clone 上就该跑通」的套件。
  // 判据全部是「退出码 0 且 stdout 一个字节都没有」——**空 stdout + 0 = 没有裁决**，
  // 这是「放行」唯一可靠的写法。**退出码 2 在 PreToolUse 上是阻断**，绝不能出现。

  const notRead = runHook(payloadFor('Bash', SOURCE_HTML))
  check(
    '工具不是 Read → 0 且 stdout 为空',
    notRead.code === 0 && notRead.stdout === '',
    `code=${notRead.code} stdout=${JSON.stringify(notRead.stdout.slice(0, 120))}`
  )

  const notDoc = runHook(payloadFor('Read', join(CJK_DIR, 'note.md')))
  check(
    '扩展名不在快转表里 → 0 且 stdout 为空',
    notDoc.code === 0 && notDoc.stdout === '',
    `code=${notDoc.code} stdout=${JSON.stringify(notDoc.stdout.slice(0, 120))}`
  )

  const badJson = runHook('这不是 JSON')
  check(
    'stdin 不是合法 JSON → 0 且 stdout 为空',
    badJson.code === 0 && badJson.stdout === '',
    `code=${badJson.code} stdout=${JSON.stringify(badJson.stdout.slice(0, 120))}`
  )

  const emptyStdin = runHook('')
  check('stdin 是空的 → 0 且 stdout 为空', emptyStdin.code === 0 && emptyStdin.stdout === '')

  // 找不到应用：ARBITER_HOME 指到一个空目录，全部候选都被跳过。
  const noApp = runHook(payloadFor('Read', join(CJK_DIR, '报告.docx')), { ARBITER_HOME: EMPTY_APP })
  check(
    '本机没有可用的 Arbiter → 0 且 stdout 为空',
    noApp.code === 0 && noApp.stdout === '',
    `code=${noApp.code} stdout=${JSON.stringify(noApp.stdout.slice(0, 120))}`
  )

  // 找得到应用（仓库形态）、但源文件不存在。这条**刻意不随构建状态分叉**：
  // 有 `out/main/cli.js` 时 CLI 以 source_missing(2) 退出，没有时 hook 自己在
  // 入口判据上放行——两种结局都必须是「放行」。
  const noEntry = runHook(payloadFor('Read', join(CJK_DIR, '并不存在.docx')), {
    ARBITER_HOME: ROOT
  })
  check(
    '应用在、但没有 CLI 入口（或 CLI 转换失败）→ 0 且 stdout 为空',
    noEntry.code === 0 && noEntry.stdout === '',
    `code=${noEntry.code} stdout=${JSON.stringify(noEntry.stdout.slice(0, 200))}`
  )
}

/* ----------------------------------------------- [10] 损坏源文件的归因 */

/**
 * 审计 2026-09-15 §3.3：一个内容不是 zip 的 `.docx` 曾经把 JSZip 的英文异常
 * **未经包装**地抛到顶层，于是 CLI 报 `internal` / exit 4 / `retryable: true`，
 * `message` 是 `Can't find end of central directory …` 外加一个 stuk.github.io 的链接。
 *
 * 三处都不对，而**最贵的是那句 `retryable: true`**：CLI 的既定消费者是 agent，
 * 它照着 `code` 与 `next_steps` 决定下一步，而 exit 4 的语义正是「我们没预料到，
 * 值得原样重试一次」——于是它去重试一个**确定性失败**。
 *
 * 两条出口各测一次是有意的：`docx → txt` 走 `extractRawText` 那条直通车，
 * `docx → html` 走 `htmlFragmentOf`，它们在 `document.ts` 里**各自接了一次包装器**。
 * 只测一条等于只测一个调用点——这正是「测了一条转换 ≠ 测了每一条转换路」。
 */
function testBrokenSources(): void {
  console.log('\n[10] 损坏的源文件：归因必须是「源的问题」，不是「我们没预料到」')

  for (const to of ['txt', 'html']) {
    const run = runCli(['convert', BROKEN_DOCX, '--to', to, '--json'])
    const error = jsonOf(run)?.error as Record<string, unknown> | undefined
    const seen = JSON.stringify(error)

    check(
      `坏 .docx → ${to} 退出码是 1（**不是** 4「我们没预料到的异常」）`,
      run.code === 1,
      `实际 ${run.code}`
    )
    check(
      `坏 .docx → ${to} 的 code 是 source_corrupt，不是 internal`,
      error?.code === 'source_corrupt',
      seen
    )
    check(
      `坏 .docx → ${to} 的 retryable 是 false（同样的输入重试必然一样）`,
      error?.retryable === false,
      seen
    )
  }

  const broken = runCli(['convert', BROKEN_DOCX, '--to', 'txt', '--json'])
  const brokenError = jsonOf(broken)?.error as Record<string, unknown> | undefined
  const message = String(brokenError?.message ?? '')
  check(
    '**对外那句 message 是中文**（不是 JSZip 的英文原文 + 第三方文档链接）',
    /[一-鿿]/.test(message) && !message.includes('stuk.github.io'),
    message
  )
  check(
    '原始英文报错仍然留在 log_tail 里（改的是**归类**，不是销毁证据）',
    ((brokenError?.log_tail as string[] | undefined) ?? []).some((line) =>
      line.includes('原始报错：')
    ),
    JSON.stringify(brokenError?.log_tail)
  )

  // 对照组：包装器只吃异常，不该碰成功路径。CSV 与 xlsx 共用 `htmlFragmentOf` 里
  // 那个 `case 'xlsx': case 'csv':` 分支，所以它是同一个调用点的**成功**那一半。
  const good = runCli(['convert', GOOD_CSV, '--to', 'html', '--json'])
  check(
    '对照组：合法的 .csv → html 仍然成功（包装器没有误伤正常路径）',
    good.code === 0,
    `实际 ${good.code}\n${good.stderr.slice(-300)}`
  )
}

/* ------------------------------------------ [11] 路径装配的告警范围 */

/**
 * 源文件里的那条告警（`src/cli/main.ts` 的 `resolvePaths()`）**只在结构性判据
 * 证明装配与实际不符时**才该出现。改之前它的判据是「凡是没给环境变量的值都报」，
 * 于是三种正常形态全会响，而报出来的三条值**全是对的**——纯噪音。
 *
 * ⚠️ **正反两类断言共用这一个字面量**（这里没法 import：`src/cli/main.ts` 在模块体里就
 * `process.exit()`，import 即启动）。所以文案一改，**正的那两条会红**——不会留下一条
 * 「不该出现 X」的断言在文案漂移之后**恒真**地绿着。
 */
const PATH_WARN = '[arbiter] 路径装配与实际不符'

/**
 * 一份**假的安装目录**，形状照着 `dist/win-unpacked` 来：
 *
 * ```
 * fake-install/
 *   resources/            ← 真正的 resources（引擎在这儿）
 *     app.asar/           ← 打包形态的 appPath 就指到这一层
 *     engines/
 * ```
 *
 * 判据一（打包形态下 `resourcesPath` 必须存在）在这份 fixture 上**是有区分度的**：
 * 漏给 `ARBITER_RESOURCES_PATH` 时它被派生成 `join(appPath,'resources')`，
 * 也就是 `fake-install/resources/app.asar/resources`——**在 asar 内部，必然不存在**。
 */
function testPathWarnings(): void {
  console.log('\n[11] 路径装配：正常形态一声不吭，装配与实际不符才报')

  const install = join(TMP_ROOT, 'fake-install')
  const installResources = join(install, 'resources')
  const installAsar = join(installResources, 'app.asar')
  mkdirSync(installAsar, { recursive: true })
  mkdirSync(join(installResources, 'engines'), { recursive: true })
  /** 漏给 `ARBITER_RESOURCES_PATH` 时被派生出来的那条 */
  const derivedResources = join(installAsar, 'resources')

  // 形态一：**仓库里直接跑**（`tsx src/cli/main.ts`）。`npm run test:cli` 每一次 spawn
  // 以前都是这个形状，而它每一次都会打三行告警：appPath=仓库根、userData 与 downloads
  // 都在标准位置——**三条都对**。这三行现在必须一个字都没有。
  const repoForm = runCli(['--version'], bareEnv(), { replaceEnv: true })
  check(
    '仓库形态真跑通了（不是半路挂掉——那样 stderr 当然也「没有告警」）',
    repoForm.code === 0 && /^\d+\.\d+\.\d+$/.test(repoForm.stdout.trim()),
    `code=${repoForm.code} stdout=${JSON.stringify(repoForm.stdout)} stderr=${repoForm.stderr}`
  )
  check(
    '**仓库形态没有路径告警**（五条路径里三条靠猜，但三条都是对的）',
    !repoForm.stderr.includes(PATH_WARN),
    JSON.stringify(repoForm.stderr)
  )
  check(
    '整个 stderr 都是干净的（这一跑本来就不该有任何诊断）',
    repoForm.stderr.trim() === '',
    JSON.stringify(repoForm.stderr)
  )

  // 形态二：**装好的应用走 `arbiter.cmd`** 的形状——shim 只给三件
  // （`APP_PATH` / `RESOURCES_PATH` / `IS_PACKAGED`），`userData` 与 `downloads` 仍然靠猜。
  // 真机实测（2026-09-15）：`dist/win-unpacked/arbiter.cmd --version` 退出码 0、版本 0.3.2，
  // 而 stderr 上正好报了这两条**对的**值。所以这个形状也必须一声不吭。
  const shimForm = runCli(
    ['--version'],
    bareEnv({
      ARBITER_IS_PACKAGED: '1',
      ARBITER_APP_PATH: installAsar,
      ARBITER_RESOURCES_PATH: installResources
    }),
    { replaceEnv: true }
  )
  check(
    '打包形态（shim 形状）真跑通了',
    shimForm.code === 0 && /^\d+\.\d+\.\d+$/.test(shimForm.stdout.trim()),
    `code=${shimForm.code} stdout=${JSON.stringify(shimForm.stdout)}`
  )
  check(
    '**打包形态（shim 形状）没有路径告警**',
    !shimForm.stderr.includes(PATH_WARN),
    JSON.stringify(shimForm.stderr)
  )
  check(
    '判据一在这份 fixture 上不是空转：正确的 resources 真的在、派生那条真的不在',
    existsSync(installResources) && !existsSync(derivedResources),
    `resources=${existsSync(installResources)} derived=${existsSync(derivedResources)}`
  )

  // 反例一：**打包形态漏给 `ARBITER_RESOURCES_PATH`**。这是这份告警真正要抓的那件事，
  // 而改之前它一个字都没说（实测：只报了 userData 与 downloads 这两条对的）。
  const noResources = runCli(
    ['--version'],
    bareEnv({ ARBITER_IS_PACKAGED: '1', ARBITER_APP_PATH: installAsar }),
    { replaceEnv: true }
  )
  check(
    '**真异常**：打包形态漏了 ARBITER_RESOURCES_PATH → 报',
    noResources.stderr.includes(PATH_WARN),
    JSON.stringify(noResources.stderr.slice(0, 300))
  )
  check(
    '而且指名道姓是 resourcesPath 那一条（判据落在结构上：那条派生路径确实不存在）',
    noResources.stderr.includes(`resourcesPath=${derivedResources}`) &&
      !existsSync(derivedResources),
    JSON.stringify(noResources.stderr.slice(0, 300))
  )
  check(
    '告警只走 stderr，stdout 仍然是那个干净的版本号（约束 20：stdout 是数据通道）',
    !noResources.stdout.includes(PATH_WARN) && /^\d+\.\d+\.\d+$/.test(noResources.stdout.trim()),
    JSON.stringify(noResources.stdout)
  )

  // 反例二：**`appPath` 指着 asar，但 `ARBITER_IS_PACKAGED` 不是 1**。
  // 这是 `arbiter.cmd` 注释里记着的那次事故的另一半——它一开始只设了
  // `ELECTRON_RUN_AS_NODE`，于是引擎解析走 dev 分支、随包引擎全落空（RAR 悄悄不支持）。
  const noFlag = runCli(
    ['--version'],
    bareEnv({ ARBITER_APP_PATH: installAsar, ARBITER_RESOURCES_PATH: installResources }),
    { replaceEnv: true }
  )
  check(
    '**真异常**：appPath 指向 asar 而 ARBITER_IS_PACKAGED 不是 1 → 报',
    noFlag.stderr.includes(PATH_WARN),
    JSON.stringify(noFlag.stderr.slice(0, 300))
  )
  check(
    '而且指名道姓是 ARBITER_IS_PACKAGED 那一条',
    noFlag.stderr.includes('ARBITER_IS_PACKAGED'),
    JSON.stringify(noFlag.stderr.slice(0, 300))
  )
}

/* ------------------------------------------------------------------ [10] 配方 */

/**
 * 配方文件 `--recipe`（R15）的端到端。
 *
 * 纯解析那一半在 `test-core.ts` 的 `[13]`，这里只验**接线**：文件真的读进来了、
 * 真的参与了转换、错的时候真的给出了那档退出码。
 *
 * ⚠️ 最承重的是 `10e/10f` 那一对：**`mode` 真的传到了引擎**。
 * `mp4(h264+aac) → webm` 是「装不进去」的经典组合（webm 只收 VP8/VP9/AV1 + Vorbis/Opus，
 * 见约束 18），所以 `mode: "remux"` 必然失败；而同一份源**不带配方**时走 auto、
 * 老老实实重编码，成功。一红一绿放在一起，才说明白「红的那个是 mode 造成的」——
 * 只断「它失败了」的话，一个把配方整个忽略掉的实现也能让它红（源文件坏了、路径错了……）。
 */
function testRecipe(): void {
  console.log('\n[12] 配方文件（--recipe）')

  const dir = join(TMP_ROOT, 'recipe')
  mkdirSync(dir, { recursive: true })
  const recipePath = join(dir, 'r.json')
  const writeRecipe = (text: string): string => {
    writeFileSync(recipePath, text, 'utf8')
    return recipePath
  }

  /* ---- ① 配方给目标格式 ---- */
  const ok = writeRecipe('{"target":"mkv"}')
  const converted = runCli(['convert', SOURCE_MP4, '--recipe', ok, '--json'])
  const first = (jsonOf(converted)?.results as Array<Record<string, unknown>> | undefined)?.[0]
  check(
    '10a 配方里的 target 生效（mp4 → mkv，命令行一个格式都没给）',
    converted.code === 0 && first?.to === 'mkv',
    `code=${converted.code} to=${String(first?.to)} ${converted.stderr.slice(-300)}`
  )

  /* ---- ② 命令行优先 ---- */
  // 两个目标都选**合法**的：配方说 webm、命令行说 mkv。
  // ⚠️ 一开始写的是「配方 mkv / 命令行 mp4」，结果两边都是退出码 2——
  // `mp4 → mp4` 本来就不在能力矩阵里。那是**测试自己选错了素材**，不是实现的问题；
  // 而它红出来的样子（「--to 没覆盖成功」）与真的没覆盖一模一样，值得记一笔。
  const preferCli = writeRecipe('{"target":"webm"}')
  const overridden = runCli(['convert', SOURCE_MP4, '--to', 'mkv', '--recipe', preferCli, '--json'])
  const second = (jsonOf(overridden)?.results as Array<Record<string, unknown>> | undefined)?.[0]
  check(
    '10b `--to` 覆盖配方里的 target（配方说 webm，命令行说 mkv → 产物是 mkv）',
    overridden.code === 0 && second?.to === 'mkv',
    `code=${overridden.code} to=${String(second?.to)}`
  )
  // **正向对照**：同一份配方不给 `--to` 时确实产出 webm。
  // 没有它，10b 在一个「配方压根没被读」的实现下也照样绿——那边恒为 mkv，一断就中。
  const recipeOnly = runCli(['convert', SOURCE_MP4, '--recipe', preferCli, '--json'])
  const third = (jsonOf(recipeOnly)?.results as Array<Record<string, unknown>> | undefined)?.[0]
  check(
    '10c 对照：同一份配方不给 --to 时产出 webm（所以 10b 里赢的确实是命令行）',
    recipeOnly.code === 0 && third?.to === 'webm',
    `code=${recipeOnly.code} to=${String(third?.to)}`
  )

  /* ---- ③ mode 真的到了引擎 ---- */
  const forced = writeRecipe('{"target":"webm","mode":"remux"}')
  const failed = runCli(['convert', SOURCE_MP4, '--recipe', forced, '--json'])
  check(
    '10e ⭐ `mode: "remux"` 真的传到了引擎（h264+aac 装不进 webm，必然失败）',
    failed.code === 1,
    `code=${failed.code} ${failed.stdout.slice(0, 200)}`
  )
  // 对照组：**同一份源、同一次环境**，只把配方去掉
  const auto = runCli(['convert', SOURCE_MP4, '--to', 'webm', '--json'])
  check(
    '10f ⭐ 对照：同一份源不带配方就成功（所以 10e 红的不是源，是 mode）',
    auto.code === 0,
    `code=${auto.code} ${auto.stderr.slice(-300)}`
  )

  /* ---- ④ 坏输入 ---- */
  const broken = writeRecipe('{ 这不是 JSON')
  const brokenRun = runCli(['convert', SOURCE_MP4, '--recipe', broken, '--json'])
  check(
    '10g 配方不是合法 JSON → 退出码 2（参数错）',
    brokenRun.code === 2,
    `实际 ${brokenRun.code}`
  )
  check(
    '10h 而且 stdout 上仍然是**恰好一个**合法 JSON（--json 的契约不因参数错而破）',
    isExactlyOneJson(brokenRun.stdout),
    brokenRun.stdout.slice(0, 200)
  )

  const empty = writeRecipe('{"无关的键":1}')
  const emptyRun = runCli(['convert', SOURCE_MP4, '--recipe', empty, '--json'])
  check(
    '10i 一个字段都没认出来 → 退出码 2（**不是**按默认档默默跑完还报成功）',
    emptyRun.code === 2,
    `实际 ${emptyRun.code} ${emptyRun.stdout.slice(0, 200)}`
  )

  /* ---- ⑤ 逐字段宽容 ---- */
  const partial = writeRecipe('{"target":"mkv","nope":1}')
  const partialRun = runCli(['convert', SOURCE_MP4, '--recipe', partial, '--json'])
  check(
    '10j 一个字段认不出时**照常用能用的那个**（逐字段宽容，不是整份拒）',
    partialRun.code === 0 &&
      (jsonOf(partialRun)?.results as Array<Record<string, unknown>> | undefined)?.[0]?.to ===
        'mkv',
    `code=${partialRun.code}`
  )
  check(
    '10k 但那个坏字段**一定要报到 stderr**（否则用户永远不知道自己写错了一个键名）',
    partialRun.stderr.includes('nope'),
    partialRun.stderr.slice(-300)
  )
  check(
    '10l 报出来的话不进 stdout：`--json` 时 stdout 仍然只有一个 JSON',
    isExactlyOneJson(partialRun.stdout),
    partialRun.stdout.slice(0, 200)
  )

  /* ---- ⑥ 文件读不了 ---- */
  const missing = runCli([
    'convert',
    SOURCE_MP4,
    '--recipe',
    join(dir, '根本不存在.json'),
    '--json'
  ])
  check('10m 配方文件不存在 → 退出码 2', missing.code === 2, `实际 ${missing.code}`)
}

/* ------------------------------------------------------------------ 收尾 */

console.log('arbiter CLI 自测\n')
prepare()
try {
  testParsing()
  testHelpAndVersion()
  testConvert()
  testEncoding()
  testStdoutPurity()
  testExitCodes()
  testHook()
  testBrokenSources()
  testPathWarnings()
  testRecipe()
} finally {
  // 无论成败都清干净。要留下现场也该由人来决定，而不是让 `.tmp-*` 静默地被打进
  // 下一个安装包（约束 30：一次残留让瘦包从 140.9 MB 涨到 445.6 MB）。
  cleanup()
}

console.log(`\n通过 ${passed}，失败 ${failed}。`)
if (failed > 0) process.exit(1)

if (existsSync(TMP_ROOT)) {
  console.log(`\n\u2717 临时目录没清干净：${TMP_ROOT}`)
  process.exit(1)
}
