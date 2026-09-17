import type { TaskProgress, TaskStatus } from '@shared/types'

interface Props {
  progress: TaskProgress | null
  status: TaskStatus
}

/**
 * 进度条。高 3px，轨道走 `.pbar`，填充是交付物里那条金色渐变 + 微弱辉光。
 *
 * 填充宽度一律用**行内 style** 而不是 Tailwind 的 `w-[62%]`：`w-[62%]` 是一个新的
 * 原子类，每个百分比都会让 Tailwind 生成一条新规则（内容集是扫源码得来的，
 * 而运行时算出来的百分比根本不在源码里），v4 下只会得到一条「类名没生成、
 * 元素没样式、零报错」。宽度本来就是运行时数据，行内 style 才是它的正确载体。
 *
 * 颜色反过来走工具类：那几个色值是固定的，属于主题该管的东西。
 *
 * `TaskProgress` 是三态联合，三种要给到不同的东西：
 *  - `determinate` → 精确百分比
 *  - `batch` → 已完成 n / N，折算成百分比
 *  - `indeterminate` → 什么都没有，只能表示「在动」
 */
export function ProgressBar({ progress, status }: Props): React.JSX.Element {
  const percent = ((): number | null => {
    if (progress === null) return null
    if (progress.kind === 'determinate') return progress.percent
    if (progress.kind === 'batch') {
      return progress.total > 0 ? progress.done / progress.total : null
    }
    return null
  })()

  if (percent !== null) {
    return (
      <div className="pbar">
        <i style={{ width: `${Math.min(100, Math.max(0, Math.round(percent * 100)))}%` }} />
      </div>
    )
  }

  // 失败行给一条满格的暖红。`bg-bad` / `shadow-none` 能盖掉 `.pbar > i` 自带的
  // 金色渐变与辉光，靠的是 theme.css 把组件类整体放进了 `@layer components`
  // （utilities 层声明在它之后，正常声明下**层的顺序先于选择器特异性**，
  //  所以不需要去比 `.pbar > i` 那点特异性）。
  if (status === 'error') {
    return (
      <div className="pbar">
        <i className="w-full bg-bad shadow-none" />
      </div>
    )
  }

  // 拿不到百分比的引擎（pandoc / LibreOffice / 7z 的收尾）用滑动条表示
  // 「在动，但不知道还有多久」。宽度固定 33%，动画靠 translateX 平移。
  if (status === 'running' || status === 'waiting_engine') {
    return (
      <div className="pbar">
        <i className="indeterminate-bar" style={{ width: '33%' }} />
      </div>
    )
  }

  return <div className="pbar" />
}
