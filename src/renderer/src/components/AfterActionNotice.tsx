import { t, type KeysOf } from '@shared/i18n'
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

/**
 * 存的是**键**：`KeysOf` 让「加了一档却忘了配句子」变成编译错误，取值处再 `t(...)`。
 *
 * ⚠️ 前缀必须是 `shell.after.label.` 这一层**窄**的：写成 `KeysOf<'shell.after.'>`
 * 会把 `shell.after.done`（带 `{label}`/`{name}`）一起收进来，于是 `t(...)` 那处
 * 变成「必须传两个参数」的假编译错误（见 `types.ts` 里 `KeysOf` 那段说明）。
 */
const DONE_LABEL: Record<AfterConvertAction, KeysOf<'shell.after.label.'>> = {
  none: 'shell.after.label.none',
  'copy-path': 'shell.after.label.copyPath',
  'copy-file': 'shell.after.label.copyFile',
  'open-folder': 'shell.after.label.openFolder'
}

export function AfterActionNotice(): React.JSX.Element | null {
  const result = useAfterAction((s) => s.result)
  const lastId = useAfterAction((s) => s.lastId)
  const busy = useAfterAction((s) => s.busy)
  const run = useAfterAction((s) => s.run)
  const dismiss = useAfterAction((s) => s.dismiss)

  if (result === null) return null

  const name = result.name ?? t('shell.after.artifact')
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
            ? t('shell.after.done', { label: t(DONE_LABEL[result.action]), name })
            : t('shell.after.failed', {
                reason: result.error ?? t('shell.after.unknownReason')
              })}
        </span>

        {canRedo && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void run(lastId)}
            className="shrink-0 rounded px-1.5 py-0.5 text-[12px] text-fg-muted transition-colors hover:bg-hover hover:text-gold-pale disabled:opacity-45"
          >
            {t('shell.after.copyAgain')}
          </button>
        )}

        <button
          type="button"
          onClick={dismiss}
          aria-label={t('shell.after.dismiss')}
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
          {t('shell.after.clipboardHint')}
        </p>
      )}
    </div>
  )
}
