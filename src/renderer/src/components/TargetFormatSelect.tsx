import { categoryOf } from '@shared/formats'
import { CATEGORIES, type Category } from '@shared/types'
import { cn } from '../lib/cn'
import { CATEGORY_LABEL } from '../lib/labels'

/** 一条 `<optgroup>`：类别本身、它的中文标签、以及归到这里的那些目标格式 */
interface TargetGroup {
  category: Category
  label: string
  items: string[]
}

interface Props {
  fromExt: string
  toExt: string
  targets: string[]
  disabled: boolean
  /**
   * 这一档是**照历史预置的**（不是设置里的类别默认值）。
   *
   * 只描个金边、不改文案：这里是「提醒你上次选的是这个」，用户完全可以不理它。
   * 那句「上次这类文件转成了 X」由调用方（`TaskCard`）写在状态列——下拉框里放不下。
   */
  highlighted?: boolean
  onChange: (next: string) => void
}

/**
 * 按类别给目标格式分组，**源格式自己那一类置顶**。
 *
 * 分组不是装饰：`targetsFor('mp4')` 里有一个 `gif`，而 `categoryOf('gif')` 是
 * **图片**。平铺成一列时，「这一项转出来其实是一张图」这条信息就丢了。
 *
 * 「源格式那一类置顶」在文档类里最有用：`md` 的目标里 pdf / html / txt 与 docx
 * 分属两类，用户九成是在 pdf 和 docx 之间做选择，把它们搁在一起比按字母排更好按。
 */
function groupByCategory(fromExt: string, targets: string[]): TargetGroup[] {
  const own = categoryOf(fromExt)
  const buckets = new Map<Category, string[]>()

  for (const target of targets) {
    const category = categoryOf(target) ?? own
    if (category === null) continue
    const bucket = buckets.get(category)
    if (bucket) bucket.push(target)
    else buckets.set(category, [target])
  }

  // 顺序由 `CATEGORIES` 定，不由 `targets` 的排列定：目标列表来自引擎能力表，
  // 顺序一变分组就会跳，而下拉里分组跳来跳去比排得不够优更让人恼火。
  const ordered = CATEGORIES.filter((category) => buckets.has(category))
  if (own !== null && buckets.has(own)) {
    ordered.splice(ordered.indexOf(own), 1)
    ordered.unshift(own)
  }

  return ordered.map((category) => ({
    category,
    label: CATEGORY_LABEL[category],
    items: buckets.get(category) as string[]
  }))
}

/**
 * 目标格式选择。
 *
 * **继续用原生 `<select>`**，不自绘下拉：`main.css` 里 `:root { color-scheme: dark }`
 * 已经让它的下拉面板跟着变深色，键盘操作与无障碍也是白送的。外观交给交付物的
 * `.select-dark`（自绘金色箭头）。
 *
 * `.select-dark` 只负责外观，外面叠加 `w-full` 与 disabled 态。工具类能盖住组件类，
 * 是因为 theme.css 把组件类整体放进了 `@layer components`（utilities 层排在后面）。
 * ⚠️ `cn()` 的 twMerge 只认 Tailwind 类名：它**不会**把 `select-dark` 与 `w-full`
 * 当成一对冲突去重，两者会同时留在 class 里——真正裁决的是上面那条层顺序。
 */
export function TargetFormatSelect({
  fromExt,
  toExt,
  targets,
  disabled,
  highlighted = false,
  onChange
}: Props): React.JSX.Element {
  const groups = groupByCategory(fromExt, targets)

  return (
    <select
      value={toExt}
      disabled={disabled || targets.length === 0}
      onChange={(e) => onChange(e.target.value)}
      title={
        disabled
          ? '调律中，目标格式已锁定'
          : highlighted
            ? `上次这类文件转成了 ${toExt.toUpperCase()}（已替你预置，可以改）`
            : `转为 ${toExt.toUpperCase()}`
      }
      // `border-gold` 是工具类、`.select-dark` 的描边在 components 层，
      // 层序决定了工具类压得住它（见 theme.css 顶部那段说明）。
      className={cn(
        'select-dark w-full truncate disabled:cursor-not-allowed disabled:opacity-45',
        highlighted && 'border-gold'
      )}
    >
      {groups.map((group) => (
        <optgroup key={group.category} label={group.label}>
          {group.items.map((item) => (
            <option key={item} value={item}>
              {item.toUpperCase()}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  )
}
