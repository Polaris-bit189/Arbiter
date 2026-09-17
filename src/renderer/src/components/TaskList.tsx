import { spriteIdFor } from '../lib/icons'
import { useTasks } from '../store/useTasks'
import { TaskCard } from './TaskCard'

/**
 * 队列表体。
 *
 * **只订阅 `order`。** 它是数组，只在增删任务时换新引用，进度推送碰不到它——
 * 所以整列表不会跟着每次 tick 重渲染，真正重渲染的只有被改动的那一行
 * （那一层由 `TaskCard` 上的 `memo` + 按 id 订阅兜着）。
 *
 * 表头与底栏不在这里：它们属于页面框架，见 `WorkbenchPage`。
 * 这样滚动的只有行本身，表头在长列表里始终可见（设计 4.1）。
 */
export function TaskList(): React.JSX.Element {
  const order = useTasks((s) => s.order)

  return (
    <div className="scroll-dark min-h-0 flex-1 overflow-y-auto">
      {order.length === 0 ? (
        <EmptyQueue />
      ) : (
        <ul>
          {order.map((id) => (
            <TaskCard key={id} id={id} />
          ))}
        </ul>
      )}
    </div>
  )
}

/**
 * 空队列。
 *
 * 纹样放在文字**后面**（绝对定位 + 55% 不透明度）：设计 6.5 要求它当背景装饰，
 * 压到 55% 之后即便文字压在刻度环上，纸面观感也还是「先读到字」。
 * 导引文案用宋体（`.font-display`）——设计 3 允许宋体出现在装饰性文字上，
 * 而空状态正是全页唯一一处「不是正文」的文字。
 */
function EmptyQueue(): React.JSX.Element {
  return (
    <div className="relative grid h-full min-h-[220px] place-items-center">
      <svg
        width={150}
        height={150}
        aria-hidden="true"
        // `inset-0 m-auto` 而不是只写 `absolute`：只有四个 inset 都是 0 且 margin 为 auto 时，
        // 这个绝对定位的方块才必然居中。只写 `absolute` 的话它落在**静态位置**上
        // （grid 项是它所在的格子），居中与否取决于对齐属性怎么解析——能用但不保证。
        className="pointer-events-none absolute inset-0 m-auto"
        style={{ opacity: 0.55 }}
      >
        <use href={`#${spriteIdFor('ornaments/seal.svg')}`} />
      </svg>

      <div className="relative px-6 text-center">
        <p className="font-display text-[15px] tracking-[0.2em] text-gold-dim">
          此处尚空，静候文件入列
        </p>
        <p className="mt-2 text-[11px] tracking-[0.5px] text-fg-faint">
          拖入文件，或点上方「收入文件」
        </p>
      </div>
    </div>
  )
}
