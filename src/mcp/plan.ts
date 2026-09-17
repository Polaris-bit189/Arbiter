/**
 * E-5 的 `dry_run`：**动手之前，一次把「会发生什么」说清**。
 *
 * agent 在这之前只有两条路：直接转（转完才知道落点、体积、有没有损），或者先用
 * `inspect_file` 侦察一遍——而 `inspect_file` 回答的是「这个文件是什么、它的**默认目标**
 * 那条路要下多大」，不回答「我这次想做的这一条转换会落到哪、多久、会不会被拒」。
 * 于是「先问一句再做」这件事得发两三次调用、而且还得自己把两边的结论拼起来。
 *
 * 本模块把这几个问题合成一次调用，而**它一个字都不是新算的**：
 *   - 落点与路由 → `JobRegistry.preview()`（`submit()` 的前半段，同一份校验）；
 *   - 侦察 → `inspect.ts` 的 `probeFile()`（`inspect_file` 与产物自检走的是同一个入口）；
 *   - 代价三件套 → `inspectCost.ts` 的 `costFor` / `lossyFor` / `estimateFor`（E-3 那三个字段
 *     的实现，不是「照着它们再写一遍」）。
 *
 * ## 三条定死的规矩（每一条都对应一个具体的坏结果）
 *
 * 1. **绝不建 job、绝不写文件、绝不占产物名。** 前两条容易做到，第三条是本模块最容易
 *    踩的：占名发生在 `jobs.ts` 的 `claimed` 里，而它**不可见**——dry run 要是走了
 *    `submit()`，紧随其后的真实任务就会被挤成 `x (1).jpg`，一个字节都不报错。
 *    所以这里只调 `preview()`（它只读 `claimed` 来避让并发，从不写）。
 * 2. **「会被拒」与「真跑被拒」是同一份回话。** 校验抛出来的错**原样往上抛**、
 *    一个字都不包装：MCP 那层用同一个 `fail()` 把它交出去，于是预览与真跑给出的是
 *    **字节相同的**那段文本与同一套 `code` / `retryable` / `next_steps`。
 *    「同一个错误」因此是结构上的，不靠人去对齐两段中文（这个项目已经因为
 *    「同一条规矩在两个入口各写各的」吃过好几次亏）。
 * 3. **拿不到就不编。** 侦察失败时 `estimate` 照旧给宽频带（那是 `estimateFor` 的既定口径，
 *    它明确不返回 null），但**探针那句话要带出来**（`probeFile` 的 `note`）——
 *    否则 agent 看到「8 秒到 2 分钟」会以为我们量过什么，而其实一个数都没量到。
 *
 * ⚠️ 本模块在 `src/mcp/` 下，**不许碰 electron**（server 跑在普通 Node 进程里）。
 * 它 import 的 `probeFile` 那条链路（`inspect.ts` → `engines/{ffmpeg,registry,sevenzip}`、
 * `core/{probe,kill,engineInstall}`）本来就是 electron-free 的，这正是 `inspect_file`
 * 能在同一个进程里跑的原因——别在这里新引入任何 `src/main/**` 里碰 electron 的模块。
 */
import type { EngineKey } from '@shared/types'
import { canRemux, remuxEligible } from '../main/engines/ffmpeg'
import { engineLabel } from '../main/engines/status'
import {
  costFor,
  estimateFor,
  lossyFor,
  mediaInfoOf,
  type CostEstimate,
  type EngineCost,
  type ProbedFacts
} from './inspectCost'
import { probeFile } from './inspect'
import type { JobRegistry, RemuxMode, RouteSpec } from './jobs'

/**
 * 预览的返回值：**「这一次转换会发生什么」的一次性回答**。
 *
 * 字段名刻意与 `convert_file` / `batch_convert` 的返回值对齐（`source` / `output` /
 * `from` / `to` / `engine`），与 `inspect_file` 的代价三件套同名（`cost` / `lossy` /
 * `estimate`）——agent 在两个工具之间来回看时不该需要翻译。
 */
export interface DryRunPlan {
  /**
   * 恒为 `true`。**不是装饰**：agent 拿到的是一份「将要发生」的东西，
   * 没有这个标记的话它只能从「没有 job_id」去反推，而「缺一个键」与
   * 「这个键是 false」在 JSON 里长得不一样、在模型眼里却一样。
   */
  dry_run: true
  source: string
  /** 产物**将要**落在哪。⚠️ 此刻磁盘上还没有它，也没有被 `claimed` 占住 */
  output: string
  from: string
  /** 实际会用到的目标格式（`target_format: "auto"` 时这是**算出来的**那个） */
  to: string
  /** 执行引擎 */
  engine: EngineKey
  /** 请求用的 mode（`auto` / `remux` / `reencode`） */
  mode: RemuxMode
  /**
   * 要准备的引擎与体积。判据与字段含义见 `inspectCost.ts` 的 `EngineCost`。
   *
   * ⚠️ 能拿到这份预览本身，就说明**该引擎已经就绪**（`preview()` 里的
   * `assertEngineReady` 会先把「没装」拒掉），所以 `network_required` 说的是
   * 「这条路结构上依赖一个按需引擎」，**不是**「这次要联网下载」。
   */
  cost: EngineCost
  /** 这一步会不会丢信息。`true` = 一定有损、`false` = 存在无损通路、`null` = 判不了 */
  lossy: boolean | null
  /** 耗时**区间** + 置信度（不是一个数）。判不了时 null */
  estimate: CostEstimate | null
  /** 一句人话，说清「这次预览的边界在哪」。**恒非空**（至少要说明它什么都没写） */
  note: string
}

/**
 * 算一份预览。
 *
 * 三步的顺序是承重的：**先校验**（会被拒就在这里抛，后面的侦察一次都不发生）、
 * 再侦察、最后算账。反过来的话，一个「矩阵里没有这个组合」的调用会先去起一次
 * ffmpeg 子进程，然后才报一句参数错——白等，而且失败原因被延迟到了进程之后。
 *
 * ⚠️ **绝不 await 任何写操作**：这个函数里除了「读文件属性 / 起一次只读的探针 /
 * 读引擎清单」之外什么都没有。
 */
export async function planConversion(registry: JobRegistry, spec: RouteSpec): Promise<DryRunPlan> {
  // ① 校验 + 路由 + 落点。**这一句就会抛**（与真跑同一个函数、同一个顺序、同一个错）。
  const route = registry.preview(spec)

  // ② 侦察。与 `inspect_file` 走的是同一个入口（`probeFile`），所以「预览报的分辨率」
  //    与「inspect_file 报的分辨率」不可能是两个答案——那是结构上的保证。
  const side = await probeFile(route.source)
  // `SideProbe` 比 `ProbedFacts` 少一个 `entries`（归档的条目数）。这里补 `null` 而不是
  // 改成 `null` 以外的东西：`estimateFor` 的归档那一支**不读条目数**（实测决定耗时的是
  // 不可压缩数据的体积，见那里的注释），所以补 null 是如实，不是丢信息。
  const probe: ProbedFacts | null = side.probe === null ? null : { ...side.probe, entries: null }

  // ③ 代价三件套。**方向是这次请求的那个 `to`**，不是默认目标——这正是它与
  //    `inspect_file` 那三个字段的区别所在（那三个按默认目标算）。
  const cost = await costFor(route.fromExt, route.toExt)
  const lossy = lossyFor(route.fromExt, route.toExt)
  const estimate = estimateFor({
    fromExt: route.fromExt,
    toExt: route.toExt,
    probe,
    sizeBytes: side.size_bytes
  })

  return {
    dry_run: true,
    source: route.source,
    output: route.output,
    from: route.fromExt,
    to: route.toExt,
    engine: route.engine,
    mode: route.mode,
    cost,
    lossy,
    estimate,
    note: noteOf(route, cost, probe, side.note)
  }
}

/**
 * 组装那句人话。
 *
 * **只有「这一份预览没说清楚、而 agent 据此会做错决定」的事才配进这里**——
 * 每条都对应一个具体的误判，不是泛泛的免责声明：
 *
 *  1. 没有建任务 / 没有写文件 / **没有占产物名**：不写的话，一个转完就去 `output`
 *     上找文件的 agent 会以为「怎么还没有」，而它其实该拿着这个路径去发真正的转换。
 *     顺带这也是 `claimed` 那条规矩的对外说法。
 *  2. 落点是**此刻**算的：从预览到真跑之间磁盘会变。不说的话，agent 会把
 *     「预览的落点」当成承诺——而它只是一个快照（约束 9 那套避让本来就会改名）。
 *  3. 要按需引擎时**点名 + 给出「已就绪」**：这是 agent 向用户交代「要不要先下 357 MB」
 *     的唯一依据，而 `network_required: true` 很容易被读成「这次会下载」。
 *  4. `mode` 与 `estimate` 的口径不一致：估算是按 `auto` 那条路（能 remux 就 remux）
 *     算的，而 `remux` / `reencode` 两个显式 mode 各自会把路走成别的样子——
 *     `remux` 甚至可能**直接失败**。不点名的话，「预览说 0.5 秒」会被当成本次承诺。
 */
function noteOf(
  route: { fromExt: string; toExt: string; mode: RemuxMode },
  cost: EngineCost,
  probe: ProbedFacts | null,
  scoutNote: string | null
): string {
  const lines = [
    '只预览：没有建任务、没有写任何文件、也没有占用产物名（不会把真实任务的落点挤成 `(1)`）。',
    '落点是按**此刻**的磁盘与占用情况算的；从这次预览到真跑之间若出现了同名文件，真跑会顺势避让成 `(1)`。'
  ]

  if (cost.engine !== null) {
    const size =
      cost.download_bytes === null
        ? '安装包体积未知（引擎清单读不到）'
        : `安装包 ${cost.download_bytes} 字节`
    lines.push(
      `这条路要用按需引擎 ${engineLabel(cost.engine)}（${size}）：` +
        '它**现在已就绪**（没装的话这一步就会被拒，不会给你预览），所以本次不会触发下载。'
    )
  }

  if (route.mode === 'remux' && probe !== null) {
    const fits =
      remuxEligible(route.fromExt, route.toExt) && canRemux(route.toExt, mediaInfoOf(probe))
    if (!fits) {
      lines.push(
        `⚠️ mode 给的是 remux，但 .${route.fromExt} → .${route.toExt} 走不通重封装` +
          '（方向或编解码器不在白名单里）：真跑会**直接失败**，不会自动回退成重编码。' +
          '要它成功就去掉 mode（用 auto），或者换一个装得下的目标容器。'
      )
    }
  } else if (route.mode === 'reencode') {
    lines.push(
      'mode 给的是 reencode：这一步**不会走重封装**，estimate 里那条 high 置信度的重封装区间' +
        '（秒级）不适用于本次，按重编码那一档看。'
    )
  }

  if (scoutNote !== null) {
    // 侦察那句原话**必须带出来**：估算在探针失败时会退成一条很宽的频带，
    // 而「8 秒到 2 分钟」看上去像是量过了什么。不加这句，agent 会把它当测量值报给用户。
    lines.push(`侦察没拿到全部信息（estimate 因此只是个宽频带）：${scoutNote}`)
  }

  return lines.join('')
}
