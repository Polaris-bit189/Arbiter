import { existsSync } from 'fs'
import { basename, extname, join, resolve, sep } from 'path'

/** Windows 文件名里不允许出现的字符 */
const ILLEGAL_CHARS = /[\\/:*?"<>|]/g

/** Windows 保留设备名，即使带扩展名也不能用 */
const RESERVED_NAMES = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i

const MAX_BASE_CODEPOINTS = 120
/** 留出余量给目录、扩展名和 " (12)" 后缀，避开 MAX_PATH 260 这条隐形红线 */
const MAX_FULL_PATH = 240

/**
 * 去掉 C0 控制字符与 DEL。
 * 用码点判断而不是正则字符类——控制字符在正则里要写成转义序列，
 * 很容易在编辑/传输过程中被解码成真实字符，把一个字符类悄悄变成完全不同的东西。
 */
function stripControlChars(input: string): string {
  let out = ''
  for (const ch of input) {
    const code = ch.codePointAt(0) ?? 0
    if (code < 0x20 || code === 0x7f) continue
    out += ch
  }
  return out
}

export function sanitizeBaseName(raw: string): string {
  let name = stripControlChars(raw).replace(ILLEGAL_CHARS, '_')

  // 结尾的点和空格会被 Windows 静默吃掉，导致「明明转换成功了却找不到文件」
  name = name.replace(/[. ]+$/, '').trim()

  if (name === '') name = 'output'
  if (RESERVED_NAMES.test(name)) name = `_${name}`

  // 按码点截断，避免把 emoji 的代理对切成两半产生乱码
  const codepoints = Array.from(name)
  if (codepoints.length > MAX_BASE_CODEPOINTS) {
    name = codepoints.slice(0, MAX_BASE_CODEPOINTS).join('')
  }

  return name
}

/** 输入文件名去掉原扩展名后的基础名 */
export function baseNameOf(filePath: string): string {
  const base = basename(filePath)
  const ext = extname(base)
  return ext ? base.slice(0, -ext.length) : base
}

export interface OutputPathOptions {
  inputPath: string
  outputDir: string
  targetExt: string
  onConflict: 'rename' | 'overwrite'
}

/** 目录、基础名、目标扩展名——两个出口共用的那一段准备 */
interface StemContext {
  dir: string
  stem: string
  ext: string
}

/**
 * 目录解析 + 基础名净化 + 长路径截断。
 *
 * 抽出来是为了让 `resolveOutputPath` 与 `naturalOutputPath` **共用同一套**净化与
 * 截断规则。两份复制迟早会分叉，而分叉的表现是「略过模式下算出来的本名，
 * 跟正常模式下会写出来的名字不是同一个」——判断「已存在」的那个名字和真正会写下的
 * 名字对不上，略过就会静默失灵。
 */
function stemContext(inputPath: string, outputDir: string, targetExt: string): StemContext {
  const dir = resolve(outputDir)
  const ext = targetExt.replace(/^\./, '').toLowerCase()
  let stem = sanitizeBaseName(baseNameOf(inputPath))

  // 长路径防御：总长超限就继续压缩基础名
  const suffixRoom = ext.length + 8
  const room = MAX_FULL_PATH - dir.length - 1 - suffixRoom
  const codepoints = Array.from(stem)
  if (room > 10 && codepoints.length > room) {
    stem = codepoints.slice(0, room).join('')
  }

  return { dir, stem, ext }
}

/** n === 0 是本名，n > 0 是加序号冲突名 */
function candidateName(ctx: StemContext, n: number): string {
  return join(ctx.dir, n === 0 ? `${ctx.stem}.${ctx.ext}` : `${ctx.stem} (${n}).${ctx.ext}`)
}

/**
 * 本名：`movie.mkv`，**不带** ` (1)` 这类冲突序号，也不看磁盘上有没有。
 *
 * 给「同名文件 → 略过」用。那个模式要问的问题是「**本名**被人占了吗」——
 * 拿 `resolveOutputPath` 问不出来，因为它见到文件已存在就直接跳去下一个序号，
 * 永远返回一个空闲名字。所以略过判断必须另有一个「不加序号是什么样」的入口。
 *
 * 只做字符串处理，不碰磁盘，也不创建文件。
 */
export function naturalOutputPath(opts: {
  inputPath: string
  outputDir: string
  targetExt: string
}): string {
  return candidateName(stemContext(opts.inputPath, opts.outputDir, opts.targetExt), 0)
}

/**
 * 生成输出路径。已存在时按 `名字 (1).ext`、`名字 (2).ext` 递增。
 * 只做字符串与存在性判断，不创建任何文件。
 *
 * ⚠️ `onConflict` **刻意只有 `'rename' | 'overwrite'` 两态**，不含 `Settings` 里那个
 * `'skip'`——略过不是「换一个名字写出去」，而是在**入队之前**就该被拒绝的一种结果。
 * 把那三态塞进来，只会让人误以为这里会处理它，而实际落进 rename 分支静默改名。
 * 略过模式读的是 `naturalOutputPath`，判断在 `core/task.ts` 的 `reserveOutput` 里。
 */
export function resolveOutputPath(opts: OutputPathOptions): string {
  const ctx = stemContext(opts.inputPath, opts.outputDir, opts.targetExt)

  if (opts.onConflict === 'overwrite') return candidateName(ctx, 0)

  let path = candidateName(ctx, 0)
  let n = 1
  while (existsSync(path) && n < 10_000) {
    path = candidateName(ctx, n)
    n += 1
  }
  return path
}

/** 转换期间先写这个临时文件，成功后再 rename 成正式文件 */
export function partPathOf(finalPath: string): string {
  // 标记插在扩展名之前，而不是缀在末尾。
  // ffmpeg 完全依赖输出文件的扩展名推断封装格式与编码器，`clip.mkv.part` 会让它
  // 认不出目标格式，直接报 "Error opening output files: Invalid argument" 而无法开始写。
  // 保留扩展名后，这个临时文件名对所有引擎（ffmpeg / sharp / pandoc / 7z）都能用，
  // 不必再维护一张「扩展名 → 封装格式」的映射表。
  const dot = finalPath.lastIndexOf('.')
  const slash = Math.max(finalPath.lastIndexOf('/'), finalPath.lastIndexOf('\\'))
  // 点在目录名里（如 D:\a.b\file）时不算扩展名
  if (dot <= slash + 1) return `${finalPath}.part`
  return `${finalPath.slice(0, dot)}.part${finalPath.slice(dot)}`
}

/** 校验输出路径确实落在允许的目录内，防 `..` 逃逸 */
export function isInsideDir(child: string, parentDir: string): boolean {
  const parent = resolve(parentDir)
  const target = resolve(child)
  return target === parent || target.startsWith(parent.endsWith(sep) ? parent : parent + sep)
}
