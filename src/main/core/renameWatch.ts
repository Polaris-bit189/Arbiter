import { join } from 'path'
import { categoryOf, extOf, requiresDownload, targetsFor } from '@shared/formats'
import type { Category } from '@shared/types'

/**
 * 「重命名即转换」的**纯逻辑**：给同一目录的两份快照，算出「哪些文件被改了扩展名」。
 * **零 fs、零 electron**，所以能脱离窗口直接测（`scripts/test-integration.ts`）。
 *
 * 语义：用户把 `a.mkv` 改成 `a.mp4`，磁盘上那个文件的**内容**其实还是 MKV。
 * 本模块只负责认出这件事；调用方（`core/renameWatcher.ts`）负责把它改回 `a.mkv`
 * ——**源文件因此原样留下**，用户随时能改回去——再按正常流程转出真正的 `a.mp4`。
 *
 * ## 判据刻意写窄：宁可漏判，绝不误判
 *
 * `docs/PLAN.md` §M8 论证过这个功能的收益/风险比是差的，代价全在**误判**上：
 * 漏判的表现是「用户改了个名，什么也没发生」（无副作用），误判的表现是
 * **我们动了用户的文件**。所以每一道闸都是「宁可放过」的方向：
 *
 * - 同词干的两侧都**必须只有一个**候选，有歧义就不猜；
 * - 体积必须**完全相等**（改名的定义就是不动内容）；
 * - 只认 video / audio / image 三类，且源和目标都得在能力矩阵里真有这条边。
 */

/** 目录里一条普通文件的快照。目录、符号链接、我们自己的临时文件都不进快照。 */
export interface DirEntry {
  name: string
  size: number
}

/** 一次「用户改了扩展名」的判定结果 */
export interface RenameCandidate {
  /** 改名前那个名字（磁盘上已经不存在了） */
  from: string
  /** 改名后现在的名字（磁盘上存在，**内容仍是 `from` 那个格式**） */
  to: string
  /** `from` 的扩展名，小写无点 */
  fromExt: string
  /** `to` 的扩展名，小写无点 */
  toExt: string
  /** `to` 那个文件的**绝对路径** —— 待改回去的就是它 */
  path: string
}

/**
 * 我们自己的临时名（`clip.part.mkv`，见约束 8 的 `partPathOf`）。
 *
 * 它们与正式文件**同词干**，留在快照里会让每一次转换都自我触发一次改名判定：
 * 产物落盘时 `a.part.mp4` 消失、`a.mp4` 出现，同词干、同在扩展名白名单里。
 */
const PART_NAME = /\.part\.[^.]+$/i

/** 这个名字值不值得进快照。**故意只挡临时名**，其余一律交给判据去筛 */
export function watchableName(name: string): boolean {
  return !PART_NAME.test(name)
}

/** 词干：名字去掉最后一个扩展名，**小写**（Windows 的文件名不区分大小写） */
function stemOf(name: string): string {
  const ext = extOf(name)
  return ext === '' ? name.toLowerCase() : name.slice(0, name.length - ext.length - 1).toLowerCase()
}

/**
 * 允许参与「重命名即转换」的类别。
 *
 * **刻意只有这三类。** document / ebook / archive 一律不参与，理由是它们背后的
 * LibreOffice（357 MB）/ Calibre（213 MB）/ pandoc（221 MB）是**按需下载**的——
 * 在用户只是改了个文件名的时候静默拉几百兆，是这个功能最坏的表现。
 *
 * 下面 `renameConvertible` 里还有一条 `requiresDownload` 判据挡同一件事，两条都要：
 * 这一条是**写死**的（能力矩阵变了它也不变），那一条是**派生**的（矩阵一变它就跟着变）。
 */
const RENAME_CATEGORIES: readonly Category[] = ['video', 'audio', 'image']

/**
 * 这一对扩展名该不该触发转换。
 *
 * **能力矩阵说了算**，这里不再另写一张白名单——另写一张必然与矩阵漂移，
 * 而漂移的表现是「界面上说能转，改个名却什么也不发生」。
 *
 * `png → pdf`（Chromium 打印，不需要下载）这类**被类别判据挡在外面**：
 * 用户把 `a.png` 改成 `a.pdf` 更可能是在标注用途，不是在要求转格式。
 * 这是有意为之的窄，代价只是漏判。
 */
export function renameConvertible(fromExt: string, toExt: string): boolean {
  if (fromExt === '' || toExt === '' || fromExt === toExt) return false

  const from = categoryOf(fromExt)
  const to = categoryOf(toExt)
  if (from === null || to === null) return false
  if (!RENAME_CATEGORIES.includes(from) || !RENAME_CATEGORIES.includes(to)) return false

  if (!targetsFor(fromExt).includes(toExt)) return false

  // 兜底：任何需要现下引擎的组合一概不做。
  //
  // ⚠️ **这一条今天完全是冗余的，而且反证覆盖不到它**：video / audio / image 三类里
  // 目前没有任何一条边要现下引擎（那三个重型引擎全在 document / ebook 下），
  // 所以把这一行拿掉，测试一条都不会红——上面那条类别判据已经全挡住了。
  // 留着是因为它挡的是**另一件事**：矩阵将来若给这三类加一条要下载的边
  // （比如某天 HEVC 解码器也改成按需下载），有这一行就不会有人在毫无预期的时候
  // 被拉几百兆。那一天不需要有人记得回来补这行代码。
  return requiresDownload(fromExt, toExt) === null
}

/** 按词干分组。**只在「恰好一个」时才用**，见 `diffRename` */
function groupByStem(entries: readonly DirEntry[]): Map<string, DirEntry[]> {
  const map = new Map<string, DirEntry[]>()
  for (const entry of entries) {
    const stem = stemOf(entry.name)
    const bucket = map.get(stem)
    if (bucket === undefined) map.set(stem, [entry])
    else bucket.push(entry)
  }
  return map
}

/**
 * 两份快照的差分：哪些文件像是「只改了扩展名」。
 *
 * 判据四条，缺一不可：
 *
 * 1. **只出现在 before** 的名字（`gone`）与**只出现在 after** 的名字（`appeared`）配对，
 *    两边词干相同、扩展名不同。
 * 2. **一侧多于一个候选就整组放弃。** `a.mkv` 与 `a.mp4` 同时消失、`a.avi` 与 `a.webm`
 *    同时出现时，配错的代价是把用户的文件改成别的名字——比什么都不做坏得多。
 * 3. **扩展名必须能转**（`renameConvertible`）。
 * 4. **体积必须完全相等。** 这条是防「删掉 `a.mkv`、又从别处弄来一个不相干的 `a.mp4`」
 *    的唯一一道闸：改名**不动内容**，而两个内容不同的文件字节数恰好相同的概率低到可以忽略。
 *    刻意**不**比 mtime：改名确实也保留 mtime，但多一条判据就多一种「用户那边不成立」的可能，
 *    而体积已经挡住了真正危险的那一类。
 *
 * `before` 为空数组时必然返回空数组（`gone` 为空），这一点是承重的：
 * 调用方用「第一次扫只建基线」来避免把本来就存在的文件当成刚出现。
 */
export function diffRename(
  dir: string,
  before: readonly DirEntry[],
  after: readonly DirEntry[]
): RenameCandidate[] {
  const beforeNames = new Set(before.map((e) => e.name.toLowerCase()))
  const afterNames = new Set(after.map((e) => e.name.toLowerCase()))

  const gone = before.filter((e) => !afterNames.has(e.name.toLowerCase()))
  const appeared = after.filter((e) => !beforeNames.has(e.name.toLowerCase()))
  if (gone.length === 0 || appeared.length === 0) return []

  const goneByStem = groupByStem(gone)
  const appearedByStem = groupByStem(appeared)

  const out: RenameCandidate[] = []
  for (const [stem, froms] of goneByStem) {
    const tos = appearedByStem.get(stem)
    if (froms.length !== 1 || tos === undefined || tos.length !== 1) continue

    const from = froms[0] as DirEntry
    const to = tos[0] as DirEntry
    const fromExt = extOf(from.name)
    const toExt = extOf(to.name)

    if (!renameConvertible(fromExt, toExt)) continue
    if (from.size !== to.size) continue

    out.push({ from: from.name, to: to.name, fromExt, toExt, path: join(dir, to.name) })
  }
  return out
}
