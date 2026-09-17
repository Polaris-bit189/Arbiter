import { CATEGORIES, type Category, type EngineKey } from './types'

/**
 * 能力矩阵：扩展名 → 大类。
 * main 与 renderer 共用这一份，避免两边的「这格式能不能转」判断产生分歧。
 *
 * **刻意不导出**：交出去就是一张可变的内部表，迟早有人就地改它。
 * 外部要看有哪些源格式，走 `sourceExtsByCategory()`——返回的是副本。
 */
const EXT_TO_CATEGORY: Record<string, Category> = {}

/**
 * 类别 → 按**登记顺序**排列的源格式。关于页的分组、设置页的下拉都从这里来。
 *
 * 六个键写死在字面量里而不是运行时攒：将来往 `CATEGORIES` 里加一类却忘了在这里
 * 补一行，会直接是**编译错误**而不是一个静默的空分组。
 */
const BY_CATEGORY: Record<Category, string[]> = {
  video: [],
  audio: [],
  image: [],
  document: [],
  ebook: [],
  archive: []
}

function register(category: Category, exts: string[]): void {
  for (const e of exts) {
    EXT_TO_CATEGORY[e] = category
    BY_CATEGORY[category].push(e)
  }
}

register('video', [
  'mkv',
  'mp4',
  'avi',
  'mov',
  'wmv',
  'flv',
  'webm',
  'm4v',
  'ts',
  'mpg',
  'mpeg',
  '3gp',
  'm2ts'
])
/**
 * 加密音乐容器。
 *
 * 它们**是音频源**（登记在 audio 类里，目标格式与默认目标都照音频走），但
 * 「把壳打开」那一步是另一件事，所以 `engineFor` 把它们路由到 `encmusic`。
 *
 * ⚠️ **这份名单必须与 `converters/encmusic/containers.ts` 里真正实现的那几个容器
 * 一一对应。** 登记一个还没实现的扩展名，表现是「界面上能选、拖进去报一句莫名其妙的错」；
 * 反过来实现了一个没登记的，则是「这个文件根本不被认作可转换的源」。
 * 两头都是静默的，所以名单只此一份，两边都从这里读（容器那边自己不做判断）。
 *
 * ⚠️ **`.kgm` / `.kgma`（酷狗）刻意还没登记**：它的逐字节掩码表我们没能从可达的源
 * 里取到（GitHub 直连不通，npm 上那个包是 WASM、表在二进制里）。与其登记一个必然失败的
 * 扩展名，不如让它**不被认出来**——后者用户一眼就知道「这个格式还不支持」。
 */
export const ENC_MUSIC_SRC = new Set([
  'ncm',
  'qmc0',
  'qmc2',
  'qmc3',
  'qmcflac',
  'qmcogg',
  'mflac',
  'mflac0',
  'mgg',
  'mgg1',
  'mggl',
  'kwm',
  'xm'
])

register('audio', [
  'mp3',
  'wav',
  'flac',
  'aac',
  'm4a',
  'ogg',
  'opus',
  'wma',
  'aiff',
  'aif',
  // —— 各家音乐 App 的加密容器（见 ENC_MUSIC_SRC）——
  //
  // 它们登记在**音频类**里，所以目标格式列表、默认目标、界面分组全部照音频那一套走
  // ——这是对的：容器里装的就是音频。
  ...ENC_MUSIC_SRC
])
register('image', [
  'png',
  'jpg',
  'jpeg',
  'webp',
  'gif',
  'bmp',
  'tiff',
  'tif',
  'avif',
  'svg',
  'ico',
  'heic',
  'heif'
])
register('document', [
  'md',
  'markdown',
  'txt',
  'html',
  'htm',
  'rst',
  'docx',
  'doc',
  'xlsx',
  'xls',
  'pptx',
  'ppt',
  'odt',
  'ods',
  'odp',
  'pdf',
  'csv'
])
register('ebook', ['epub', 'mobi', 'azw3', 'azw', 'fb2', 'lit', 'pdb'])
/**
 * 归档类源格式。
 *
 * `tgz` / `tbz` / `tbz2` / `txz` 都是「压缩层 + tar 容器」的套娃，拆包时必须走两趟
 * （见 converters/archive.ts 的 LAYERED_SRC 与约束 11）。这三个曾经只配了 LAYERED_SRC
 * 而没登记在这里，于是拖进来的 `.tbz2` 根本不被认作压缩包——配置写了却没人走得到。
 * 两处必须同时改：这里的集合决定「能不能作为源被接受」，那里的集合决定「要不要拆第二趟」。
 */
register('archive', [
  'zip',
  '7z',
  'tar',
  'gz',
  'bz2',
  'xz',
  'tgz',
  'tbz',
  'tbz2',
  'txz',
  'rar',
  'iso'
])

/**
 * HEIC/HEIF 的像素靠 WASM 版 libheif 解出来，再交给 sharp 编码
 * （见 `src/main/converters/heic.ts`）。这个 Set 标记的是「必须先过一道
 * libheif 解码」的源格式，而不是「路由给哪个引擎」。
 *
 * 这里原本写的是「HEIC 交给 ffmpeg，它的静态构建自带 HEVC 解码器」——
 * 实测证明两条都不成立，两个引擎都解不了 HEVC 系 HEIC：
 *   - ffmpeg-static 6.1.1-essentials 根本没有 heif 解复用器（只有 avif 复用器，
 *     且仅用于编码）。它把 .heic 当 MP4 解，报 "moov atom not found"。
 *   - sharp 的预编译 libvips 出于 HEVC 专利剔除了 libde265，能读出元数据
 *     （所以 metadata() 看着是好的，很有迷惑性），一取像素就报
 *     "bad seek to <文件末尾之后>"，而那个偏移量并不存在的问题。
 * 用真实 iPhone 照片（compression=hevc）验证过，两个引擎都是这个结果。
 */
const HEIF_SRC = new Set(['heic', 'heif'])

/**
 * 随包的 ffmpeg **解不了**的图片源。
 *
 * `bmp` / `ico` 两个目标 sharp 写不出来（见 `SHARP_IMAGE_TARGETS`），所以
 * `engineFor` 会把它们兜底给 ffmpeg——而这条路对 svg 是**必然失败**的：
 * 这份 ffmpeg 是 gyan.dev essentials 构建，**输入侧压根没有 svg 解码器**。
 *
 * 实测（2026-09-14，用 `node_modules/ffmpeg-static/ffmpeg.exe`、应用的真实参数
 * `buildFfmpegArgs` 那一组，八个图片目标逐个跑）：
 *   - `svg → bmp` / `svg → ico`：退出码 **−22**，stderr
 *     `Decoding requested, but no decoder found for: svg`，**不产出文件**；
 *   - 同一个 svg 换 `png / jpg / gif / webp / tiff / avif` 目标**也全是 −22**——
 *     所以这不是「某个编码器缺失」，是**输入侧没有 svg 解码器**，一个出口都不会成；
 *   - 对照组 `png → bmp` / `png → ico` 成功（12342 / 12776 字节），
 *     `bmp` / `ico` / `tiff` / `avif` / `gif` / `webp` 这些源→`bmp`/`ico` 也都成功。
 * 而 svg 的其余六个目标走 sharp，实测**全通**（预编译 libvips 带 librsvg，
 * `sharp.format.svg.input.file === true`）。
 *
 * 后果比「转换失败」更糟：ffmpeg 是自带引擎，`requiresDownload()` 返回 `null`，
 * 用户**得不到任何「需要下载引擎」的提示**，只看到一句 ffmpeg 的原始抱怨。
 *
 * 所以这里照 HEIF 那个模式办——**把做不到的组合从能力矩阵里剔掉**，而不是等用户
 * 选完目标再失败。两份集合的后果相同（`bmp` / `ico` 做不到），但**原因完全不同，
 * 别当成同一件事**：HEIF 是「像素只有 libheif 解得出」，svg 是「像素 sharp 解得出，
 * 但另一个引擎解不了它」。`engineFor` 对两者的处理恰好都是
 * 「只认 `SHARP_IMAGE_TARGETS`，其余返回 null」。
 */
const FFMPEG_UNREADABLE_SRC = new Set(['svg'])

/**
 * `bmp` / `ico` 这两个目标对哪些源**真的做不到**。
 *
 * 它们是唯一两个「sharp 写不出、只能靠 ffmpeg 解出来」的图片目标，所以只要一个源
 * 的像素进不了 ffmpeg（HEIF：容器解不开；svg：没有解码器），这两格就是空的。
 * 从两份名单派生而不是再写一份字面量：加一个源格式时只改一处，
 * 否则「改一处等于没改」——能力矩阵宣称能用、`engineFor` 却路由不到（约束 11 的教训）。
 */
const NO_BMP_ICO_SRC = new Set([...HEIF_SRC, ...FFMPEG_UNREADABLE_SRC])

/**
 * sharp 的编码器白名单（**输出侧**）。
 *
 * 这份列表是实测出来的（`sharp.format` 的 output 能力 + 逐个 toFormat 试写），
 * 不是照抄文档：bmp 和 ico 两个格式 sharp 根本写不出来，只能走 ffmpeg。
 * 若哪天升级 sharp 后它支持了新格式，改这里一处即可，路由会自动跟上。
 *
 * **输入侧另有一份反名单**（sharp 读不了 bmp / ico），在 `converters/image.ts` 的
 * `SHARP_UNREADABLE_SRC` 里：那不是路由问题（`engineFor` 给这两个源的 sharp 出口
 * 仍然是对的引擎），而是 `runSharp` 要先让 ffmpeg 解一步，所以它归引擎管。
 * 两份合起来才是 sharp 的完整能力边界——只看输出侧那一份，会以为
 * `bmp → png` 这条路是通的（它曾经六格全不通）。
 */
const SHARP_IMAGE_TARGETS = new Set(['png', 'jpg', 'jpeg', 'webp', 'avif', 'tiff', 'gif'])

/** 图片类目标格式。sharp 负责图像互转，→pdf 交给 Chromium 排版。 */
const IMAGE_TARGETS = ['png', 'jpg', 'webp', 'avif', 'tiff', 'gif', 'bmp', 'ico', 'pdf']

/**
 * 需要 LibreOffice 才能处理的「二进制办公格式」，按 **LibreOffice 的应用族**分组。
 *
 * ⚠️ **必须按族分，不能开成一张大表。** 实测（2026-09-12，LO 26.8.0.3）：
 * `--convert-to` 只在**同一个应用内**成立，跨族一律
 * `Error: no export filter for … found, aborting.` + 退出码 1 + 零残留。
 * 族与「源是 ODF 还是 OOXML」无关——`doc→pptx` 与 `odt→pptx` 同结论，
 * `doc→docx` 与 `odt→docx` 同结论。分界线是 Writer / Calc / Impress 三家。
 *
 * 这里原先是一张对七个源都宣称 `pdf/docx/xlsx/pptx/txt` 的大表，其中**多数是假的**
 * （对 `xls` 只有 2/5 为真）。那种错法不会静默产出垃圾（LO 失败得很干脆），
 * 但用户要先选好目标格式、等进度条跑完三秒才看到失败——比提前不给选糟得多。
 *
 * `txt` 是 Writer 专属出口，`xls/ods → txt` 实测同样 `no export filter`。
 */
const OFFICE_FAMILIES: Record<string, readonly string[]> = {
  doc: ['pdf', 'docx', 'txt'], // Writer
  odt: ['pdf', 'docx', 'txt'],
  xls: ['pdf', 'xlsx'], // Calc
  ods: ['pdf', 'xlsx'],
  ppt: ['pdf', 'pptx'], // Impress
  pptx: ['pdf', 'pptx'],
  odp: ['pdf', 'pptx']
}

/**
 * 「这个源要惊动 LibreOffice」的判据。
 *
 * **从 `OFFICE_FAMILIES` 的键派生，不另写一份字面量。** 两张表分开维护的话，
 * 加一个族或改一个键就变成「改一处等于没改」——能力矩阵宣称能用、`engineFor`
 * 却路由不到引擎（或反过来），而两边都不报错。派生之后它们不可能漂移。
 */
const OFFICE_BINARY_SRC = new Set(Object.keys(OFFICE_FAMILIES))

/** 纯文本类文档，pandoc 与 Chromium 都能覆盖，无需下载重型引擎。 */
const TEXT_DOC_SRC = new Set(['md', 'markdown', 'rst', 'txt', 'html', 'htm'])

export function extOf(filePath: string): string {
  const base = filePath.replace(/\\/g, '/').split('/').pop() ?? ''
  const dot = base.lastIndexOf('.')
  if (dot <= 0) return ''
  return base.slice(dot + 1).toLowerCase()
}

export function baseNameOf(filePath: string): string {
  return filePath.replace(/\\/g, '/').split('/').pop() ?? filePath
}

export function categoryOf(ext: string): Category | null {
  return EXT_TO_CATEGORY[ext.toLowerCase()] ?? null
}

/** 该源格式可以转成哪些目标格式。返回空数组表示不支持。 */
export function targetsFor(fromExt: string): string[] {
  const category = categoryOf(fromExt)
  if (!category) return []
  const from = fromExt.toLowerCase()

  switch (category) {
    case 'video':
      return ['mp4', 'mkv', 'webm', 'mov', 'avi', 'gif'].filter((t) => t !== from)
    case 'audio':
      return ['mp3', 'wav', 'flac', 'aac', 'm4a', 'ogg', 'opus'].filter((t) => t !== from)
    case 'image': {
      // HEIC 的像素只能经 libheif-js 解出来再交给 sharp，而 sharp 写不出 bmp/ico；
      // svg 的像素 sharp 解得出、但 ffmpeg（bmp/ico 的唯一出口）解不了它。
      // 两个源格式在这两个目标上是真做不到，索性不列出来，免得用户选了才失败。
      const usable = NO_BMP_ICO_SRC.has(from)
        ? IMAGE_TARGETS.filter((t) => SHARP_IMAGE_TARGETS.has(t) || t === 'pdf')
        : IMAGE_TARGETS
      return usable.filter((t) => t !== from)
    }
    case 'ebook':
      return ['epub', 'mobi', 'azw3', 'pdf', 'docx', 'txt'].filter((t) => t !== from)
    case 'archive':
      return ['zip', '7z', 'tar'].filter((t) => t !== from)
    case 'document':
      return documentTargets(from)
  }
}

function documentTargets(from: string): string[] {
  if (from === 'pdf') {
    // PDF → Word 是唯一真正的难点，LibreOffice Draw 导入质量很差，v1 明确不做。
    return ['png', 'jpg', 'txt', 'md']
  }
  const family = OFFICE_FAMILIES[from]
  if (family) {
    // filter 掉 from 自己：`pptx → pptx` 这种同格式出口没有意义
    return family.filter((t) => t !== from)
  }
  if (from === 'xlsx' || from === 'csv') {
    return ['pdf', 'html', 'csv'].filter((t) => t !== from)
  }
  if (from === 'docx') {
    return ['pdf', 'md', 'html', 'txt']
  }
  if (TEXT_DOC_SRC.has(from)) {
    return ['pdf', 'docx', 'html', 'md', 'txt'].filter((t) => t !== from)
  }
  return []
}

/** 该转换由哪个引擎执行。返回 null 表示这个组合不支持。 */
export function engineFor(fromExt: string, toExt: string): EngineKey | null {
  const from = fromExt.toLowerCase()
  const to = toExt.toLowerCase()
  const category = categoryOf(from)
  if (!category) return null

  switch (category) {
    case 'video':
      return 'ffmpeg'

    case 'audio':
      // 加密容器要先开壳再谈转码，所以那一步不走 ffmpeg。**别把这一条并回上面**：
      // 并回去的表现是 ffmpeg 拿到一个它不认识的容器，报一句与用户无关的错。
      return ENC_MUSIC_SRC.has(from) ? 'encmusic' : 'ffmpeg'

    case 'image': {
      // sharp 写不出 PDF，交给 Chromium 把图片排版成页面
      if (to === 'pdf') return 'pdf'
      // HEIC 的像素要先由 libheif-js 解成 RGBA 再进 sharp 管线（见 converters/heic.ts）。
      // 这里不能像别的图片源那样甩给 ffmpeg 兜底——ffmpeg 解不开 HEIF 容器。
      // svg 同理，但原因在另一头：ffmpeg 没有 svg 解码器（见 FFMPEG_UNREADABLE_SRC）。
      // 两者共同的后果是 bmp / ico 那两个目标真做不到，所以返回 null 而不是 'ffmpeg'——
      // 返回 'ffmpeg' 的话，用户在界面上看到的是「选了才失败」，而失败信息还是一句
      // 与用户无关的 ffmpeg 报错。
      if (NO_BMP_ICO_SRC.has(from)) return SHARP_IMAGE_TARGETS.has(to) ? 'sharp' : null
      // sharp 的编码器只有 jpeg/png/webp/tiff/gif/avif 这几种（已实测），
      // 写不出 bmp 和 ico，这两个交给 ffmpeg。
      return SHARP_IMAGE_TARGETS.has(to) ? 'sharp' : 'ffmpeg'
    }

    case 'ebook':
      return 'calibre'

    case 'archive':
      return 'archive'

    case 'document': {
      if (from === 'pdf') return 'pdf'
      if (OFFICE_BINARY_SRC.has(from)) return 'libreoffice'
      // docx/xlsx/csv 的解析有纯 JS 方案（mammoth / SheetJS），不必惊动 LibreOffice
      if (from === 'docx' || from === 'xlsx' || from === 'csv') return 'pdf'
      if (TEXT_DOC_SRC.has(from)) {
        // markdown ↔ docx 这类跨标记语言的转换只有 pandoc 能做
        return to === 'docx' ? 'pandoc' : 'pdf'
      }
      return null
    }
  }
}

/** 卡片上默认选中的目标格式。 */
export function defaultTargetFor(fromExt: string): string | null {
  const from = fromExt.toLowerCase()
  const category = categoryOf(from)
  if (!category) return null

  const targets = targetsFor(from)
  if (targets.length === 0) return null

  const preferred: Partial<Record<Category, string>> = {
    video: 'mp4',
    audio: 'mp3',
    image: 'jpg',
    ebook: 'epub',
    archive: 'zip',
    document: 'pdf'
  }
  const want = preferred[category]
  return want && targets.includes(want) ? want : targets[0]
}

// ---------------------------------------------------------------- 类别级视图

/**
 * 每个类别登记过的源格式，按登记顺序。
 *
 * **返回的是副本**：内部那张表是活到进程结束的，把引用交出去等于给了调用方
 * 一个「就地 push 一个格式进去」的机会，而那样改不会经过 `register()`，
 * `BY_CATEGORY` 与 `EXT_TO_CATEGORY` 会当场分家。
 */
export function sourceExtsByCategory(): Record<Category, string[]> {
  const out = {} as Record<Category, string[]>
  for (const category of CATEGORIES) out[category] = [...BY_CATEGORY[category]]
  return out
}

/**
 * 某个类别下**所有源格式**的合法目标格式之并集（保序去重）。
 *
 * 设置页那个「各类别默认目标」的下拉只能列这个并集：合法目标随源格式而变
 * （`mkv` 转不了 `mkv`），所以**不存在对所有源都合法的类别级默认值**。
 * 实际生效的那一个由 `resolveDefaultTarget()` 逐条裁决，下拉下面那行小字
 * 就是在把这条无法避免的限制解释给用户听。
 */
export function targetsForCategory(category: Category): string[] {
  const out: string[] = []
  for (const ext of BY_CATEGORY[category]) {
    for (const t of targetsFor(ext)) {
      if (!out.includes(t)) out.push(t)
    }
  }
  return out
}

/**
 * 入队时真正裁决「这条任务默认转成什么」。
 *
 * `overrides` 是用户在格式设置页配的类别偏好。**它必须被 `targetsFor` 再校验一遍**，
 * 这一点是承重的：用户把「视频默认转 mkv」之后，拖进来的完全可能是一个 `.mkv`，
 * 而 `targetsFor('mkv')` 里没有 `mkv`。信任 override 就会造出 `fromExt === toExt`
 * 的任务——队列老老实实跑一次毫无意义的重编码，退出码还是 0。
 *
 * `core/task.ts` 里那句 `targetsFor(ext)` 校验是第二道闸，两边都要在。
 */
export function resolveDefaultTarget(
  fromExt: string,
  overrides: Partial<Record<Category, string>>
): string | null {
  const category = categoryOf(fromExt)
  const targets = targetsFor(fromExt)
  if (!category || targets.length === 0) return null

  const want = overrides[category] ?? defaultTargetFor(fromExt)
  return want && targets.includes(want) ? want : targets[0]
}

/**
 * `document` 引擎（key 是 `'pdf'`）内部同样会拉起 pandoc 的四条 rst 出口：
 * `rst → html / md / txt / pdf` 走的是 `converters/document.ts` 的 `htmlFragmentOf`
 * → `converters/pandocRun.ts`。它们的 `engineFor()` 结果是 `'pdf'`，
 * **光看引擎 key 认不出这里还藏着一个外部引擎**。
 *
 * 判据不能退化成「按 `covers` 那种源格式投影」：`covers` 里的 `html` 既包含
 * `html → docx`（真需要 pandoc）也包含 `html → txt`（纯原生），
 * 按源格式一刀切会把后者误判成缺口，让它在 pandoc 缺席时被静默跳过。
 * 所以这里认的是 `[源, 目标]` 二元组。
 *
 * 这份清单与 `resources/engines.manifest.json` 里 pandoc 的 `routes` 是**同一份真相源**，
 * 由 `scripts/test-downlink.ts` 的 `[11]` 节逐条钉住——改这里必须同步改那里。
 */
const PANDOC_INSIDE_DOCUMENT = new Set(['rst>html', 'rst>md', 'rst>txt', 'rst>pdf'])

/** 该转换是否需要用户先下载额外引擎（用于卡片上的提示）。 */
export function requiresDownload(fromExt: string, toExt: string): EngineKey | null {
  const engine = engineFor(fromExt, toExt)
  if (engine === 'libreoffice' || engine === 'calibre' || engine === 'pandoc') return engine
  return PANDOC_INSIDE_DOCUMENT.has(`${fromExt.toLowerCase()}>${toExt.toLowerCase()}`)
    ? 'pandoc'
    : null
}
