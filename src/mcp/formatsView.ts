/**
 * 能力矩阵的**对外视图**（MCP 的 `list_supported_formats` 工具 + `converter://formats` resource）。
 *
 * 这里一个扩展名都不写死，全部从 `@shared/formats` 派生。理由不是洁癖：
 * `src/shared/formats.ts` 是 main 与 renderer 共用的唯一真相源，一旦 MCP 这侧再抄一份，
 * 「界面说能转、MCP 说不能转」这种分歧就不会有任何测试能发现——两边各自都是自洽的。
 * 派生之后这种分歧根本不可能出现，因为**只有一份**。
 *
 * 同理，「哪些转换要先下载引擎」一律走 `requiresDownload(from, to)`，不在这里另写引擎名单。
 * 那份名单（libreoffice / calibre / pandoc，随着缺口补齐还在长）归 `formats.ts` 管，
 * 它一改这里的视图就跟着变——这正是调用它而不是抄一份的收益。
 * 落地当天就吃到了：写这份文件时那份名单还只认 libreoffice / calibre，
 * 跑测试时另一条线把 pandoc 补上了，markdown 里的「要下载的出口」列**自己**多出了 pandoc 那几行。
 *
 * `src/mcp/` 下不许出现 electron，见 `schema.ts` 的文件头。
 */
import {
  requiresDownload,
  sourceExtsByCategory,
  targetsFor,
  targetsForCategory
} from '@shared/formats'
import { CATEGORIES, type Category, type EngineKey } from '@shared/types'

/** `converter://formats` 这个 resource 的 URI。放这里是为了与 `formatsMarkdown()` 挨着。 */
export const FORMATS_RESOURCE_URI = 'converter://formats'

/**
 * 类别 → 中文名。
 *
 * ⚠️ **这是仓库里的第三份**（另两份在 `src/main/ipc/tasks.ts` 与 `src/renderer/src/lib/labels.ts`），
 * 复用不了：`src/mcp/` 只许依赖 zod 与 `@shared/*`，而两份都在 `@shared` 之外。
 * **应该有人把它提到 `@shared/types.ts` 里去**，三份各自维护迟早出事。
 * 在没提之前，测试里锁了一条「六个类别一个不少」，至少让漏一行变成红而不是静默少一段表。
 */
export const CATEGORY_LABELS: Record<Category, string> = {
  video: '视频',
  audio: '音频',
  image: '图片',
  document: '文档',
  ebook: '电子书',
  archive: '压缩包'
}

/** 一个源格式的对外视图。 */
export interface SourceFormatView {
  /** 源扩展名，小写不带点 */
  ext: string
  /** 该源能转成的目标格式，保序，与 `targetsFor()` 逐字一致 */
  targets: string[]
  /**
   * 「这个出口要先下载引擎」的目标 → 引擎名。空对象 = 这个源的每个出口都不用额外下载。
   *
   * 刻意按 **(源, 目标)** 逐个问，而不是「这个源要哪个引擎」一把算完：
   * 同一个源的两个出口是可以分家的——`md → docx` 要 pandoc，
   * 而 `md → pdf` 走本地 Chromium、什么都不用下。按源去归纳会把这些出口一起说成「要下载」，
   * 那是错的，而且错得很隐蔽：这种摘要看起来完全合理。
   */
  downloadFor: Record<string, EngineKey>
}

/** 一个类别的对外视图。 */
export interface CategoryFormatView {
  category: Category
  label: string
  /** 该类别所有源格式的合法目标之并集，与 `targetsForCategory()` 同源 */
  targets: string[]
  sources: SourceFormatView[]
}

/**
 * 按类别给出源格式与各自的合法目标格式。
 *
 * 不传 `category` 时返回全部六类，顺序即 `CATEGORIES` 的登记顺序。
 */
export function listSupportedFormats(category?: Category): CategoryFormatView[] {
  // 传进来的可能是 agent 拼的字符串（zod 那侧已经限过一次，这里是第二道闸）。
  // **不静默返回空数组**：那会让调用方以为「这个类别没有格式」，而不是「你写错了类别名」。
  if (category !== undefined && !CATEGORIES.includes(category)) {
    throw new Error(`未知类别 ${String(category)}；可用的是：${CATEGORIES.join(' / ')}`)
  }
  const wanted: readonly Category[] = category === undefined ? CATEGORIES : [category]
  const sources = sourceExtsByCategory()

  return wanted.map((cat) => ({
    category: cat,
    label: CATEGORY_LABELS[cat],
    targets: targetsForCategory(cat),
    sources: sources[cat].map((ext) => {
      const targets = targetsFor(ext)
      const downloadFor: Record<string, EngineKey> = {}
      for (const target of targets) {
        const engine = requiresDownload(ext, target)
        if (engine) downloadFor[target] = engine
      }
      return { ext, targets, downloadFor }
    })
  }))
}

/** 把一串格式名写成 markdown 里的形式：`` `mp4`、`mkv` ``。空列表给 `—`。 */
function inlineFormats(list: string[]): string {
  return list.length > 0 ? list.map((item) => `\`${item}\``).join('、') : '—'
}

/**
 * 「要下载的出口」那一格：按引擎把目标分组建出来，如 `` `docx` → `pandoc` ``。
 *
 * **刻意不做成「这个源要哪个引擎」一列**——理由见 `SourceFormatView.downloadFor`：
 * 一个源的两个出口可以走不同引擎，只写引擎名会让人以为整个源都要下载。
 * 写下具体的目标格式，一个都不含糊。
 */
function downloadCell(downloadFor: Record<string, EngineKey>): string {
  const byEngine = new Map<EngineKey, string[]>()
  for (const [target, engine] of Object.entries(downloadFor)) {
    const group = byEngine.get(engine)
    if (group) group.push(target)
    else byEngine.set(engine, [target])
  }
  if (byEngine.size === 0) return '—'
  return [...byEngine.entries()]
    .map(([engine, targets]) => `${inlineFormats(targets)} → \`${engine}\``)
    .join('；')
}

/**
 * `converter://formats` 的内容：一张能让 agent **一次读懂全局**的 markdown 表。
 *
 * 存在的意义就是省掉试探：没有它，agent 想知道「这个文件能不能转成那样」只能拿着
 * `list_supported_formats` 反复问好几次，每一轮都是一次工具调用与一段上下文。
 * 有了它，一次 resource 读取就够——这也是 PLAN 把它列为「边际成本近零」的原因。
 *
 * 内容全部由 `listSupportedFormats()` 渲染，不另取数据源。要改表就改那份视图，
 * 手工往表里补一行，`scripts/test-mcp-view.ts` 会当场翻红。
 */
export function formatsMarkdown(): string {
  const lines: string[] = [
    '# Arbiter 能力矩阵：源格式 → 目标格式',
    '',
    '> 本表由 `src/shared/formats.ts` **派生**，不要手改——矩阵改了这张表就跟着变，',
    '> 对不上时 `scripts/test-mcp-view.ts` 会翻红。',
    '',
    '读法：',
    '',
    '- 格式一律是小写、不带点的扩展名，源与目标都是这个口径（不要写成 .mp4 或 MP4）。',
    '- 「要下载的出口」列写成 `docx` → `pandoc` 这种形式，意思是**只有这几个出口**要先装好该引擎；',
    '  没装时这些任务会失败或一直排队等下载。没列出来的出口不需要额外下载。',
    '- `—` 表示没有内容（该源没有合法出口，或该出口不需要额外下载），不要拿它去拼 target_format。',
    '- 同一类别内不同源格式的出口可以不一样，所以「某类别能转成 X」不等于该类别下每个源都能转成 X。',
    ''
  ]

  for (const view of listSupportedFormats()) {
    lines.push(`## ${view.category} — ${view.label}`, '')
    lines.push(`目标格式并集：${inlineFormats(view.targets)}`, '')
    lines.push('| 源格式 | 可转为 | 要下载的出口 |', '| --- | --- | --- |')
    for (const source of view.sources) {
      lines.push(
        `| \`${source.ext}\` | ${inlineFormats(source.targets)} | ${downloadCell(source.downloadFor)} |`
      )
    }
    lines.push('')
  }

  return lines.join('\n')
}
