import { useEffect, useState } from 'react'
import type { Task, TaskStatus } from '@shared/types'
import { Icon } from './Icon'
import { useNav, type NavPage } from '../store/useNav'
import { useTasks } from '../store/useTasks'
import { spriteIdFor } from '../lib/icons'
import { cn } from '../lib/cn'

/** 导航项。顺序即设计稿里的顺序，图标名对应 `assets/icons/ui/icon-<name>.svg`。 */
const NAV: ReadonlyArray<{ page: NavPage; icon: string; label: string }> = [
  { page: 'work', icon: 'convert', label: '调律工作台' },
  { page: 'history', icon: 'history', label: '历史记录' },
  { page: 'settings', icon: 'gear', label: '格式设置' },
  { page: 'about', icon: 'info', label: '关于' }
]

/**
 * 数出处于某个状态的任务有几个。
 *
 * 与工作台底栏用的是同一条规则：**从任务镜像里数**，而不是读设置里的静态上限。
 * 一批小文件两百毫秒转完、五张卡片同时变绿时，旁边写着「并发 4」看起来就像
 * 限流根本没生效——这个数字只有从镜像里数，才有可能和用户数出来的对上。
 */
function countStatus(byId: Record<string, Task>, order: string[], status: TaskStatus): number {
  let count = 0
  for (const id of order) if (byId[id]?.status === status) count += 1
  return count
}

/**
 * 侧栏：徽记 + 四项导航 + 底部蜂窝纹样。
 *
 * 宽度 224px 是设计稿定的，**主区最小宽度（`main/window.ts` 的 `minWidth: 980`）
 * 是按它反推的**——两个数要一起看才有意义。
 */
export function Sidebar(): React.JSX.Element {
  const page = useNav((s) => s.page)
  const setPage = useNav((s) => s.setPage)

  // 选择器必须返回 **number**（原始值）。返回对象的话，每秒几十次的进度推送
  // 会因为每次都比不出相等而把整个侧栏一起重渲染——而这个数字真正会变的时机
  // 只有「运行中 0 → 1」和「1 → 0」。镜像本身的更新频率是拦不住的，
  // 能拦的只有「下游谁跟着重渲染」。
  const running = useTasks((s) => countStatus(s.byId, s.order, 'running'))

  const [version, setVersion] = useState('')
  useEffect(() => {
    // app:info 是纯内存查询（app.getName / getVersion），不像引擎探测那样要起子进程
    void window.api.getAppInfo().then((info) => setVersion(info.version))
  }, [])

  // 宽度写 224px 字面量而不是 w-56：这个数与 main/window.ts 的 minWidth 是一对，
  // 写成字面量才 grep 得到，改一个时另一个不会被忘掉。
  return (
    <aside className="flex w-[224px] shrink-0 flex-col border-r border-line bg-panel px-3 pt-[18px] pb-3">
      {/*
        logo 走 sprite 的 <use>，**绝不能在这里再内联一份 logo.svg**：
        它内部有 <linearGradient id="gGold">，同 id 出现两次时 Chromium 按先出现的
        那一份解析，渐变直接错乱。id 一律由 spriteIdFor() 生成，手写迟早漂移。
      */}
      <div className="border-b border-line px-1.5 pb-3.5">
        <div className="flex items-center gap-2.5">
          <svg width={36} height={36} className="shrink-0" aria-hidden="true">
            <use href={`#${spriteIdFor('logo.svg')}`} />
          </svg>
          <span className="grad-gold-text font-display text-[15px] font-semibold tracking-[5px]">
            调律者转换器
          </span>
        </div>
        <div className="mt-2 text-[10px] tracking-[1px] text-fg-faint">令万物归于其应有之格式</div>
      </div>

      <nav className="mt-3.5 flex flex-col gap-0.5">
        {NAV.map((item) => {
          const active = page === item.page
          return (
            <button
              key={item.page}
              type="button"
              onClick={() => setPage(item.page)}
              aria-current={active ? 'page' : undefined}
              className={cn(
                'relative flex h-[38px] items-center gap-2.5 rounded-card px-3 text-[13px]',
                'text-gold-dim transition-colors',
                active ? '' : 'hover:bg-hover'
              )}
              // 激活态那层淡金渐变换成行内：它是一段带透明度的多段渐变，
              // 用工具类拼出来又长又难核对，而底色本来也不该跟着主题漂。
              style={
                active
                  ? {
                      background:
                        'linear-gradient(90deg, rgba(201,162,39,.13), rgba(201,162,39,.02))'
                    }
                  : undefined
              }
            >
              {active && (
                <span
                  aria-hidden="true"
                  className="absolute top-1/2 left-0 h-[18px] w-[3px] -translate-y-1/2 rounded-[2px]"
                  style={{ background: 'var(--grad-gold)' }}
                />
              )}

              <Icon name={item.icon} size={17} className="shrink-0" />
              <span className={active ? 'text-gold-pale' : 'text-fg-muted'}>{item.label}</span>

              {item.page === 'work' && running > 0 && (
                <span
                  className="ml-auto flex items-center gap-1.5"
                  title={`正在调律 ${running} 个`}
                >
                  <span aria-hidden="true" className="size-1.5 rounded-full bg-gold" />
                  <span className="font-mono text-[11px] text-gold-bright tabular-nums">
                    {running}
                  </span>
                </span>
              )}
            </button>
          )
        })}
      </nav>

      {/*
        蜂窝底纹直接拿 `--pattern-honeycomb` 铺一层，而**不用 `.honeycomb` 那个类**：
        它在 theme.css 里把 `position: relative` 写成了元素自身的样式，而 theme.css
        是未分层（unlayered）的，优先级压过 Tailwind 的 utilities——和这里的
        `absolute` 撞上时会静默变成 relative，纹样铺满整栏而不是只占页脚。
        用变量自己铺既能拿到同一个图样，又能明确控制 10% 这个不透明度。
      */}
      <footer className="relative mt-auto border-t border-line px-1.5 pt-3.5 pb-0.5 text-center text-[11px] tracking-[1px] text-fg-faint">
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 opacity-10"
          style={{ backgroundImage: 'var(--pattern-honeycomb)' }}
        />
        <span className="relative">{version.length > 0 && `v${version} · `}秩序归于格式</span>
      </footer>
    </aside>
  )
}
