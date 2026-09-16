import { useEffect, useState } from 'react'
import { CATEGORIES, type EngineKey, type EngineProgress, type EngineStatus } from '@shared/types'
import { sourceExtsByCategory } from '@shared/formats'
import type { AppInfo } from '@shared/ipc-contract'
import { CATEGORY_LABEL } from '../lib/labels'
import { Icon } from '../components/Icon'
import { FormatTile } from '../components/FormatTile'
import { ProgressBar } from '../components/ProgressBar'
import { useEngines } from '../store/useEngines'

/**
 * 关于页。
 *
 * 三块：应用与运行环境版本 / 引擎状态 / 格式支持列表。
 *
 * **刻意没有「检查更新」**（设计文档 §5.2 的表格里原本有这一项）：应用里没有接
 * electron-updater，做不出来一个真的能用的检查更新；留一个点了没反应的按钮比少一个
 * 按钮糟得多，所以宁可不放。
 *
 * ⚠️ 这里原本还有一句页脚小字：「本工具是自用工具，不做打包分发、也没有发行渠道，
 * 因此不提供检查更新」。那句话连同它的理由**已于 2026-09-14 整句删去**——「个人自用、
 * 不做打包分发」这条定位 2026-09-13 就作废了（见 `docs/NOTES.md` 项目概述），
 * 现在是面向公开发布的开源项目，留着那句话是**主动说错**。
 * 删掉不等于「更新检查」这件事变了：它今天仍然没有，理由就是上面那条。
 */

/**
 * 源格式登记表 + 总数。
 *
 * **在模块顶层算一次**：`register()` 全在模块加载期跑完，这张表此后是静态的。
 * 更重要的是那个「共支持 N 种格式」的数字**必须由代码算出来**——规划阶段手算错过
 * 两次（62 与 72），而写死的数字在有人加一个格式之后会静默变成谎言。
 */
const EXTS_BY_CATEGORY = sourceExtsByCategory()
const TOTAL_EXTS = Object.values(EXTS_BY_CATEGORY).reduce((sum, list) => sum + list.length, 0)

/**
 * 有可执行文件、因而**可以**探测版本的那几个引擎。
 *
 * sharp 是 npm 原生模块、pdf 是 Electron 自带的 Chromium，两者都没有独立进程，
 * 也就没有 `--version` 可跑。给它们摆一个点了只会报错的按钮是无意义的噪音，
 * 所以这里显式列出来，而不是「凡有 path 的都给按钮」。
 */
const PROBEABLE: ReadonlySet<EngineKey> = new Set<EngineKey>([
  'ffmpeg',
  'pandoc',
  'libreoffice',
  'calibre',
  'archive'
])

function VersionChip({ label, value }: { label: string; value?: string }): React.JSX.Element {
  return (
    <span className="flex items-baseline gap-1.5">
      <span className="text-fg-faint">{label}</span>
      <span className="text-gold-pale">{value ?? '—'}</span>
    </span>
  )
}

/** 分节标题：宋体字距 + 一条发丝线把剩下的宽度吃掉 */
function SectionTitle({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="mb-3 flex items-center gap-3">
      <h2 className="shrink-0 font-display text-base tracking-[0.2em] text-gold">{children}</h2>
      <div className="hairline flex-1" />
    </div>
  )
}

/**
 * 一行引擎状态。
 *
 * 行内的按钮刻意**不用 `.btn-secondary`**：那个类固定 38px 高、13px 字，塞进这一行里
 * 会把行撑高；而 `theme.css` 是未分层（unlayered）的普通 CSS，优先级高于 Tailwind 的
 * `@layer utilities`，用 `h-7` 这类工具类压不过它。所以这里直接按「次按钮」的规格
 * （透明底 + 金深描边 + 金字）写一遍小尺寸版本。
 */
/** 「次按钮」的小尺寸版（理由见上面那段注释）。两处按钮共用，所以抽出来 */
const SMALL_BUTTON =
  'ml-1 shrink-0 rounded-card border border-line-2 px-2.5 py-1 text-xs text-gold ' +
  'transition-colors hover:border-gold-dim hover:text-gold-bright ' +
  'disabled:cursor-not-allowed disabled:text-fg-faint disabled:hover:border-line-2'

/** MB 取整就够：这些数字只用来让用户有个「要下多久」的概念，不是精确值 */
function formatMb(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`
}

function EngineRow({
  status,
  probing,
  disabled,
  progress,
  onProbe,
  onInstall
}: {
  status: EngineStatus
  probing: boolean
  disabled: boolean
  /** 这个引擎正在下载/解包的进度；`null` 表示没在装它 */
  progress: EngineProgress | null
  onProbe: () => void
  onInstall: () => void
}): React.JSX.Element {
  const ready = status.state !== 'missing'
  const installing = progress !== null
  // **只有「缺」且清单里有它才算可下载**：`downloadBytes` 是主进程从引擎清单里
  // 补上的，清单里没有的引擎（ffmpeg / sharp / pdf）拿到的是 undefined。
  // 用「能不能下」当判据，而不是硬编码三个引擎名——硬编码那张名单与清单是两个真相源。
  const downloadable = !ready && status.downloadBytes !== undefined

  return (
    <li className="flex items-center gap-3 border-b border-line px-4 py-3 last:border-b-0">
      <Icon name="gear" size={20} className="shrink-0 text-gold-dim" />

      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="text-sm text-fg">{status.label}</span>
          {status.version !== undefined && (
            <span className="font-mono text-xs text-gold-bright">{status.version}</span>
          )}
        </div>
        {/* 路径挂 title 而不是显示出来：它是排查用的信息，不该占一行的宽度 */}
        <p className="mt-0.5 truncate text-xs text-fg-faint" title={status.path}>
          {status.error ?? status.detail ?? '—'}
        </p>

        {/* 进度条只在这一行在装的时候出现。**解包那一段没有百分比**（msiexec 的
            `-qn` 不吐进度），所以那时画的是不确定态的长条，而不是一个停在 100% 的假条。 */}
        {installing && (
          <div className="mt-1.5 flex items-center gap-2">
            {/* 复用任务卡那条进度条，而不是自己拼一套：`.pbar > i` 的金色渐变与辉光
                是主题的一部分，另写一份必然漂。宽度由外面那层 `w-40` 给——
                `.pbar` 自己是不定宽的。

                `percent > 0` 当作「有没有真实进度」的判据：解包那一段主进程报的是
                null（msiexec 的 `-qn` 不吐百分比），落成 0；而下载一开始也报 0。
                这两种都该显示不定态的长条，而不是一个停在 0% 的假条。 */}
            <div className="w-40">
              <ProgressBar
                progress={
                  progress.percent > 0 ? { kind: 'determinate', percent: progress.percent } : null
                }
                status="running"
              />
            </div>
            <span className="font-mono text-[11px] text-fg-faint">
              {progress.percent > 0
                ? `${Math.round(progress.percent * 100)}% · ${formatMb(progress.totalBytes)}`
                : '正在解包…'}
            </span>
          </div>
        )}
      </div>

      <span className={`badge ${ready ? 'done' : 'error'}`}>
        <Icon name={ready ? 'check' : 'error'} size={16} />
        {ready ? '已就绪' : '未就绪'}
      </span>

      {downloadable && (
        <button type="button" onClick={onInstall} disabled={disabled} className={SMALL_BUTTON}>
          {installing ? '下载中…' : `下载（${formatMb(status.downloadBytes ?? 0)}）`}
        </button>
      )}

      {PROBEABLE.has(status.key) && (
        <button type="button" onClick={onProbe} disabled={disabled} className={SMALL_BUTTON}>
          {probing ? '探测中…' : '探测版本'}
        </button>
      )}
    </li>
  )
}

export function AboutPage(): React.JSX.Element {
  // 选择器返回的都是原始值或稳定引用（statuses 只在 set 时换新数组），
  // 所以探测期间的状态变化不会带着整页重渲染。
  const statuses = useEngines((s) => s.statuses)
  const loading = useEngines((s) => s.loading)
  const probing = useEngines((s) => s.probing)
  const installing = useEngines((s) => s.installing)
  const installProgress = useEngines((s) => s.installProgress)
  const probe = useEngines((s) => s.probe)

  /** 下载失败的提示。**不弹模态框**——下载是用户主动点的，一句可关闭的行内提示就够 */
  const [error, setError] = useState<string | null>(null)

  const [info, setInfo] = useState<AppInfo | null>(null)

  useEffect(() => {
    // 用 getState() 取动作，与 App.tsx 一致（避免把函数放进依赖数组后反复重建）
    void useEngines.getState().init()

    let alive = true
    void window.api.getAppInfo().then((value) => {
      if (alive) setInfo(value)
    })
    return () => {
      alive = false
    }
  }, [])

  return (
    // 滚动容器在 App 的页面区那一层（`scroll-dark min-h-0 flex-1 overflow-y-auto`），
    // 这里刻意**不**再套一个 h-full + overflow-y-auto：两个等高的滚动容器先是互相抵消
    // （外层的滚动条永远不出现），等哪天往页面区加 sticky 表头时才会发现滚的不是同一个
    // 元素。`relative` 要留着——右上角那个刻度环是绝对定位的。
    <div className="relative px-8 py-7">
      {/* 刻度环：设计文档 §7.2 把 ring-ticks 定为关于页的装饰纹样。
          纯背景层（§7.4：不透明度 ≤16%、不压住任何交互），所以是 pointer-events-none
          的绝对定位元素，不参与排版。 */}
      <svg
        viewBox="0 0 120 120"
        width={220}
        height={220}
        aria-hidden="true"
        className="pointer-events-none absolute -top-12 right-0"
        style={{ opacity: 0.08 }}
      >
        <use href="#o-ring-ticks" />
      </svg>

      {/* ── 应用与运行环境 ─────────────────────────────────────── */}
      <header className="relative flex items-center gap-4">
        {/* logo 走 sprite：它内部有 <linearGradient id="gGold">，全文档只能有一份，
            所以这里绝不能内联第二份 logo.svg */}
        <svg viewBox="0 0 64 64" width={64} height={64} aria-hidden="true" className="shrink-0">
          <use href="#logo" />
        </svg>
        <div className="min-w-0">
          <h1 className="grad-gold-text font-display text-2xl tracking-[0.3em]">调律者转换器</h1>
          {/* 拉丁名不写死在这里：它来自 productName（dev 下 app.getName() 读 package.json，
              打包后读 electron-builder.yml），写死就等于同一个名字有两个来源 */}
          <p className="mt-1 font-mono text-xs text-fg-muted">
            {info === null ? '读取中…' : `${info.name} · v${info.version}`}
          </p>
        </div>
      </header>

      <div className="mt-4 flex flex-wrap gap-x-5 gap-y-1 font-mono text-[11px]">
        <VersionChip label="Electron" value={info?.electron} />
        <VersionChip label="Chromium" value={info?.chrome} />
        <VersionChip label="Node" value={info?.node} />
      </div>

      {/* ── 引擎状态 ───────────────────────────────────────────── */}
      <section className="relative mt-8">
        <SectionTitle>引擎状态</SectionTitle>

        <p className="mb-3 text-xs text-fg-faint">
          版本号要起一个子进程去问（LibreOffice 约 3～5 秒），所以不随页面自动探测。
        </p>

        {loading && statuses.length === 0 ? (
          <p className="py-6 text-center text-xs text-fg-faint">读取中…</p>
        ) : (
          // 三元的一个分支只能是**一个**表达式，所以这里必须有 Fragment：
          // 直接写 `{error && …}` 是「JSX 子节点」而不是表达式，语法就不对。
          <>
            {error !== null && (
              <p className="mb-3 flex items-start gap-2 rounded-card border border-bad px-3 py-2 text-xs text-fg-muted">
                <span className="flex-1 break-all">{error}</span>
                <button
                  type="button"
                  onClick={() => setError(null)}
                  className="shrink-0 text-fg-faint hover:text-fg"
                >
                  关闭
                </button>
              </p>
            )}

            <ul className="overflow-hidden rounded-card border border-line bg-panel">
              {statuses.map((status) => (
                <EngineRow
                  key={status.key}
                  status={status}
                  probing={probing === status.key}
                  // 一次只跑一场探测：两个 LibreOffice 实例会去抢同一把 profile 锁，
                  // 那正是「装了引擎却静默失败」的成因（约束 3）。主进程侧还有一道闸。
                  // 下载则**不设**这个限制：`installEngine()` 自己是单飞的，而且下载与
                  // LibreOffice 的 profile 锁毫无关系。
                  disabled={probing !== null || installing !== null}
                  progress={installing === status.key ? installProgress : null}
                  onProbe={() => void probe(status.key)}
                  onInstall={() => {
                    setError(null)
                    void useEngines
                      .getState()
                      .install(status.key)
                      .catch((err: unknown) => {
                        setError(
                          `${status.label} 下载失败：${err instanceof Error ? err.message : String(err)}`
                        )
                      })
                  }}
                />
              ))}
            </ul>
          </>
        )}
      </section>

      {/* ── 格式支持 ───────────────────────────────────────────── */}
      <section className="relative mt-8">
        <SectionTitle>格式支持</SectionTitle>

        <p className="mb-4 text-xs text-fg-muted">
          共支持 <span className="font-mono text-gold-bright">{TOTAL_EXTS}</span> 种源格式，归为{' '}
          {CATEGORIES.length} 个大类；砖上写着扩展名的那种有专属图标，其余落在通用砖上。
        </p>

        {CATEGORIES.map((category) => {
          const exts = EXTS_BY_CATEGORY[category]
          return (
            <div key={category} className="mb-4">
              <div className="mb-2 flex items-baseline gap-2">
                <span className="text-xs text-fg-muted">{CATEGORY_LABEL[category]}</span>
                <span className="font-mono text-[11px] text-fg-faint">{exts.length}</span>
              </div>
              <div className="flex flex-wrap gap-2">
                {exts.map((ext) => (
                  <div
                    key={ext}
                    className="flex w-14 flex-col items-center gap-1 rounded-tile bg-raised px-1 py-1.5"
                  >
                    <FormatTile ext={ext} size={24} />
                    <span className="font-mono text-[11px] leading-none text-gold-pale">{ext}</span>
                  </div>
                ))}
              </div>
            </div>
          )
        })}
      </section>
    </div>
  )
}
