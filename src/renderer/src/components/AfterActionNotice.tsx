import type { AfterConvertAction } from '@shared/types'
import { Icon } from './Icon'
import { useAfterAction } from '../store/useAfterAction'

/**
 * 「转换完成之后的动作」的回执条。
 *
 * ## 为什么不是一条两秒的 toast
 *
 * 因为它回答的正是 toast 答不了的那两个问题：「我刚才复制的是什么」与
 * **「再复制一次」**。剪贴板随时会被别的程序接管（用户点完复制、切到微信去粘贴，
 * 中间任何一个程序都可能把剪贴板换掉），那一刻他需要一个**还在那儿**的东西。
 *
 * 所以它不自动消失，由用户自己收起（或者下一次动作把它顶掉）。
 *
 * ## 三种结局都要说话
 *
 *  - 复制成功：说清是**哪一个文件**的**路径**还是**文件本身**
 *  - 降级（产物太大）：连原因一起说，否则用户看到的是「选了复制产物、拿到的却是路径」
 *  - 失败（产物已不在原处 / 没注入出口）：说清是什么没成
 */

const DONE_LABEL: Record<AfterConvertAction, string> = {
  none: '什么也没做',
  'copy-path': '已复制路径',
  'copy-file': '已复制这个文件',
  'open-folder': '已在文件夹中显示'
}

export function AfterActionNotice(): React.JSX.Element | null {
  const result = useAfterAction((s) => s.result)
  const lastId = useAfterAction((s) => s.lastId)
  const busy = useAfterAction((s) => s.busy)
  const run = useAfterAction((s) => s.run)
  const dismiss = useAfterAction((s) => s.dismiss)

  if (result === null) return null

  const name = result.name ?? '产物'
  // 「再复制一次」只对写剪贴板的那两档有意义：打开目录是幂等的，重来一次没有意义
  const canRedo =
    lastId !== null && (result.action === 'copy-path' || result.action === 'copy-file')

  return (
    <div className="mt-3 shrink-0 rounded-card border border-line-2 bg-raised px-3 py-2">
      <div className="flex items-center gap-2">
        <Icon
          name={result.ok ? 'check' : 'error'}
          size={14}
          className={result.ok ? 'shrink-0 text-gold' : 'shrink-0 text-bad'}
        />
        <span className="min-w-0 flex-1 truncate text-xs text-gold-pale" title={result.path ?? ''}>
          {result.ok
            ? `${DONE_LABEL[result.action]}：${name}`
            : `未能完成：${result.error ?? '原因不明'}`}
        </span>

        {canRedo && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void run(lastId)}
            className="shrink-0 rounded px-1.5 py-0.5 text-[12px] text-fg-muted transition-colors hover:bg-hover hover:text-gold-pale disabled:opacity-45"
          >
            再复制一次
          </button>
        )}

        <button
          type="button"
          onClick={dismiss}
          aria-label="收起"
          className="shrink-0 rounded p-0.5 text-fg-faint transition-colors hover:bg-hover hover:text-fg"
        >
          <Icon name="close" size={13} />
        </button>
      </div>

      {result.degradeReason !== null && (
        <p className="mt-1 text-[11px] leading-relaxed text-amber-400">{result.degradeReason}</p>
      )}

      {result.ok && result.action !== 'open-folder' && (
        // 这一句是**预防性**的：粘贴出问题时，用户第一反应是「复制功能坏了」，
        // 而真正的原因通常是剪贴板被别的程序接管了——把这句话摆在这儿，
        // 归因成本就从「查不出原因」降到「再点一次」。
        <p className="mt-1 text-[11px] leading-relaxed text-fg-muted">
          剪贴板随时可能被别的程序接管。粘出来若不对，点「再复制一次」。
        </p>
      )}
    </div>
  )
}
