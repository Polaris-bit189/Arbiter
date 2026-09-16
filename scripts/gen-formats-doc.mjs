// 生成 docs/FORMATS.md。
//
// **为什么是生成而不是手写**：能力矩阵的真身在 `src/shared/formats.ts`。
// 手写一份表出来，就等于同一个事实有了两个副本——加了格式忘了改文档，
// 对外承诺的就是一件做不到的事。这个项目对「两张表分开维护」过敏
// （见 formats.ts 里 `OFFICE_BINARY_SRC` 从 `OFFICE_FAMILIES` 派生那段注释），
// 文档也该守同一条规矩。
//
// 用法（仓库根目录）：
//   npx tsx scripts/gen-formats-doc.mjs
//
// 改了 `formats.ts` 之后重跑一次，别手改产物。
//
// 搬运期说明：`ARBITER_SRC` 可以指向别处的 formats.ts，
// 用于在源码还没搬进本仓库时先出一版文档。搬完之后不需要它。

import { readFileSync, writeFileSync } from 'node:fs'

const SRC = process.env.ARBITER_SRC ?? new URL('../src/shared/formats.ts', import.meta.url).href
const OUT = new URL('../docs/FORMATS.md', import.meta.url)

const f = await import(SRC)

const ENGINE_LABEL = {
  ffmpeg: 'FFmpeg',
  sharp: 'sharp',
  pdf: '内置文档引擎',
  archive: '7-Zip',
  calibre: 'Calibre',
  libreoffice: 'LibreOffice',
  pandoc: 'pandoc'
}

const CATEGORY_LABEL = {
  video: '视频',
  audio: '音频',
  image: '图片',
  document: '文档',
  ebook: '电子书',
  archive: '压缩包'
}

const label = (k) => ENGINE_LABEL[k] ?? (k === null ? '**（路由不到引擎）**' : String(k))

/** 把一个源格式的整行压成一行 markdown。目标多且引擎不统一时，写成 `目标→引擎`。 */
function cellsOf(from) {
  const targets = f.targetsFor(from)
  if (targets.length === 0) return null
  const engines = targets.map((t) => f.engineFor(from, t))
  const uniq = new Set(engines)
  const engineCell =
    uniq.size === 1
      ? label(engines[0])
      : targets.map((t, i) => `${t} → ${label(engines[i])}`).join('；')
  return { targets: targets.join('、'), engine: engineCell }
}

/** 目标与引擎完全相同的源格式合成一行，读起来清爽得多，也不容易看漏。 */
function rowsOf(category) {
  const buckets = new Map()
  for (const from of f.sourceExtsByCategory()[category]) {
    const cells = cellsOf(from)
    if (!cells) continue
    const sig = `${cells.targets}\u0000${cells.engine}`
    if (!buckets.has(sig)) buckets.set(sig, [])
    buckets.get(sig).push(from)
  }
  return [...buckets.values()].map((group) => {
    const cells = cellsOf(group[0])
    return `| ${group.join(' / ')} | ${cells.targets} | ${cells.engine} |`
  })
}

const tables = Object.keys(CATEGORY_LABEL)
  .map((category) => {
    const rows = rowsOf(category)
    const head = [
      `### ${CATEGORY_LABEL[category]}`,
      '',
      '| 源格式 | 可以转成 | 引擎 |',
      '| --- | --- | --- |',
      ...rows,
      ''
    ]
    return head.join('\n')
  })
  .join('\n')

// —— 缺口统计 ——
//
// 「这条转换会不会拉起一个不在瘦包里的引擎」有两份判据，这里要让它们对表：
//   A. 矩阵：`engineFor()` 路由到的引擎（`BUNDLED` 之外的就是要下载的）
//   B. 清单：`resources/engines.manifest.json` 每个引擎的 `routes`（[源,目标] 二元组）
//
// ⚠️ **判据必须走 `requiresDownload()`，不能只看 `engineFor()`。** 这一条踩过：
// 原来的写法是 `notBundled.has(engineFor(...)) && requiresDownload(...) === null`，
// 而 rst 的四个非 docx 出口（→ pdf / html / md / txt）在矩阵里路由到的是**内置文档引擎**
// （`'pdf'`），只内部才拉起 pandoc。于是这四条对生成器**永远不可见**——
// 万一只有它们坏着，文档会宣称「当前没有缺口」，比漏报一条更糟。
//
// 所以 B 这一路是承重的：清单的 `routes` 与 `requiresDownload()` 是同一份真相源的两侧，
// `scripts/test-downlink.ts` 的 `[11]` 节也从测试那一侧钉着同一件事。
const BUNDLED = new Set(['ffmpeg', 'sharp', 'pdf', 'archive'])

const missing = [] // 要下载、但 requiresDownload() 不认领 → 界面不会预告，用户直接看到失败
const downloads = [] // 要下载且认领正常
for (const category of Object.keys(CATEGORY_LABEL)) {
  for (const from of f.sourceExtsByCategory()[category]) {
    for (const to of f.targetsFor(from)) {
      const engine = f.engineFor(from, to)
      if (!BUNDLED.has(engine)) {
        const key = f.requiresDownload(from, to)
        if (key === null) missing.push(`${from} → ${to}（${label(engine)}）`)
        else downloads.push(`${from} → ${to}（${label(key)}）`)
      }
    }
  }
}

// 反向：清单声明「这条要拉起我」，但 requiresDownload() 没这么说。
// 这正是 rst 那四条的形态——engineFor 看不出问题，只有清单知道。
const manifest = JSON.parse(
  readFileSync(new URL('../resources/engines.manifest.json', import.meta.url), 'utf8')
)
let declaredRoutes = 0
for (const engine of manifest.engines ?? []) {
  for (const pair of engine.routes ?? []) {
    declaredRoutes += 1
    const [from, to] = pair
    const key = f.requiresDownload(from, to)
    if (key !== engine.key) {
      missing.push(
        `${from} → ${to}：清单说是 ${label(engine.key)}，` +
          `requiresDownload() 说是 ${key === null ? '**不用下载**' : label(key)}`
      )
    }
  }
}

const zeroTargets = []
for (const category of Object.keys(CATEGORY_LABEL)) {
  for (const from of f.sourceExtsByCategory()[category]) {
    if (f.targetsFor(from).length === 0) zeroTargets.push(`${from}（${CATEGORY_LABEL[category]}）`)
  }
}

// —— 下面两段是**手写**的：这些事实代码里读不出来 ——
// 改动 HEIC / RST 相关代码时，记得回来核对这两段。
const HEIC_CAVEAT = [
  '',
  '> ⚠️ 表里的 **sharp** 对 HEIC/HEIF 要看得更细：这两个格式的像素**先经 WASM 版 libheif',
  '> （heic-decode）解成 RGBA，再交给 sharp 编码**。两个主力引擎都解不开 HEVC 系 HEIC——',
  '> ffmpeg-static 根本没有 heif 解复用器，sharp 的 libvips 则因专利剔除了 libde265',
  '> （它能正常读出元数据、format 也报 heif，一取像素才报错，很有迷惑性）。',
  '> 原始像素里没有可保留的元数据，所以 HEIC 转出会丢 EXIF / ICC。',
  '>',
  '> HEIC 的 BMP / ICO 出口是被**刻意去掉**的：sharp 写不出这两个格式，而 HEIC 的像素',
  '> 又只能进 sharp，所以对 HEIC 源是真做不到，索性不列出来，免得用户选了才失败。'
]

const RST_CAVEAT = [
  '',
  '### 矩阵表体看不出来的依赖：rst',
  '',
  '上面矩阵里 rst 那一行写的是「内置文档引擎」，但那只是**对外负责**的引擎。',
  'rst 的四个非 docx 出口（→ pdf / html / md / txt）解析 RST 语法时**内部要调 pandoc**',
  '（src/main/converters/document.ts 里的 rstToHtmlFragment）——RST 不是它能直接读的标记语言。',
  '所以 rst 的**全部五个出口**都要求 pandoc 在位，上面那张「需要按需下载」的表里也列全了。',
  '',
  '> 这属于「已实测做不到」之外的另一种情况：矩阵本身没错，但它描述的是',
  '> **哪个引擎对外负责**，而不是**这次转换会启动哪些进程**。',
  '> 凡是要判断「这次转换会不会拉起某个引擎」，别只看矩阵表体，看 `requiresDownload()`。'
]

const lines = [
  '# 能力矩阵',
  '',
  '> **本文件由代码生成，不要手改。** 改完 `src/shared/formats.ts` 后跑：',
  '>',
  '> ```bash',
  '> npx tsx scripts/gen-formats-doc.mjs',
  '> ```',
  '',
  '矩阵的真身是 `src/shared/formats.ts` 里的 `targetsFor()` 与 `engineFor()`，',
  'main 与 renderer 共用同一份。**这里和代码不一致时，以代码为准。**',
  '',
  '两条贯穿全表的规则：',
  '',
  '- **同格式出口不存在**。`mkv → mkv` 这种任务在矩阵里就没有，界面上也不会出现——',
  '  队列老老实实跑一次毫无意义的重编码、退出码还是 0，是最糟的失败方式。',
  '- **没列出来的组合，多半是实测过做不到，不是忘了加**。',
  '  例如 PDF → Word（LibreOffice Draw 的导入质量很差），',
  '  HEIC → BMP / ICO（sharp 写不出这两个格式，而 HEIC 的像素又只能经 libheif 进 sharp）。',
  '',
  '---',
  '',
  tables,
  '---',
  '',
  '## 引擎对照',
  '',
  '| 表里的名字 | `EngineKey` | 实际是什么 | 在瘦包里？ |',
  '| --- | --- | --- | --- |',
  '| FFmpeg | `ffmpeg` | ffmpeg-static 静态构建 | ✅ |',
  '| sharp | `sharp` | libvips 原生模块 | ✅ |',
  '| 内置文档引擎 | `pdf` | 纯 JS（mammoth / SheetJS）+ Chromium 排版 + pdfjs | ✅ |',
  '| 7-Zip | `archive` | 完整的 7z.exe + 7z.dll | ✅ |',
  '| Calibre | `calibre` | MSI 解包目录树，约 658 MB | ❌ 首次使用时下载 |',
  '| LibreOffice | `libreoffice` | MSI 解包目录树，约 1.49 GiB | ❌ 首次使用时下载 |',
  '| pandoc | `pandoc` | 单文件自包含 exe，221 MiB | ❌ 首次使用时下载 |',
  '',
  "> 「内置文档引擎」这个 `EngineKey` 的字面量就是 `'pdf'`，它管的不只是 PDF——",
  '> 文档类里凡是**不需要** LibreOffice 和 pandoc 的转换都走它。名字是历史遗留，',
  '> 容易误解，看代码时留意。',
  ...HEIC_CAVEAT,
  '',
  '---',
  '',
  '## 需要按需下载的转换',
  '',
  '安装包**不含** LibreOffice / Calibre / pandoc（合计约 2.4 GiB），它们按需下载。',
  '「要不要在卡片上提示先下载」与「引擎未就绪时要不要按设置跳过」这两件事，',
  '由 `requiresDownload()` 一句话决定。它认领的转换就是下面这些',
  '（共 ' + downloads.length + ' 条）：',
  '',
  ...(downloads.length ? downloads.map((d) => `- ${d}`) : ['（一条都没有——那说明判据坏了。）']),
  '',
  '> 这张表**不等于**「矩阵里引擎列写了 pandoc / LibreOffice / Calibre 的那些行」。',
  '> rst 的四个非 docx 出口在矩阵里记的是「内置文档引擎」，但那四条同样会拉起 pandoc',
  '> ——矩阵描述的是**哪个引擎对外负责**，不是**这次转换会启动哪些进程**。',
  ''
]

lines.push(
  '---',
  '',
  '## ⚠️ 瘦包下的已知缺口',
  '',
  '「矩阵 / 引擎清单 `resources/engines.manifest.json` / `requiresDownload()`」三处',
  '说的是同一件事，下面按它对表。这里空着，就说明界面的预告与实际行为一致。',
  ''
)

if (missing.length) {
  lines.push(
    '**对不上的是这些**——它们会用到不在包里的引擎，而 `requiresDownload()` 不认账，',
    '于是界面上不会给出任何预告，用户会直接看到转换失败：',
    '',
    ...missing.map((g) => `- ${g}`),
    '',
    '修复方向：`src/shared/formats.ts` 的 `requiresDownload()`，以及',
    '`src/main/core/task.ts` 的 `unavailableEngineReason()`（后者现在走',
    '`engines/status.ts` 的 `engineReady()`，是逐值判的，不会静默放行）。',
    ''
  )
} else {
  lines.push('（当前没有缺口：三处对得上。）', '')
}

lines.push(...RST_CAVEAT)

if (zeroTargets.length) {
  lines.push(
    '## 登记了但没有任何出口的源格式',
    '',
    '这些格式被 `register()` 登记为大类成员（因而能被拖进来、能在分类里查到），',
    '但 `targetsFor()` 返回空数组，**界面上连目标格式都选不出来**。',
    '这通常是个洞——要么补上出口，要么就别登记：',
    '',
    ...zeroTargets.map((z) => `- ${z}`),
    ''
  )
}

writeFileSync(OUT, lines.join('\n'), 'utf8')
console.log(`已写出 ${OUT.pathname}`)
console.log(`  表格分组：${Object.keys(CATEGORY_LABEL).length} 个大类`)
console.log(`  按需下载：${downloads.length} 条（清单声明了 ${declaredRoutes} 条 routes）`)
console.log(`  瘦包缺口：${missing.length} 条`)
console.log(`  无出口源格式：${zeroTargets.length} 个`)
