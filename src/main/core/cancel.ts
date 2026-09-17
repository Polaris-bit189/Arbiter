export type CancelListener = () => void

/**
 * 取消令牌。
 *
 * 用「注册回调」而不是「轮询标志位」，是因为子进程一旦起来就必须被主动杀掉——
 * 光把标志位置 true，spawn 出来的 ffmpeg 会继续跑到天荒地老。
 *
 * 已经取消之后再注册会立即触发，避免「取消信号发出后才 spawn」的竞态。
 */
export class CancelToken {
  private listeners: CancelListener[] = []
  private _canceled = false

  get canceled(): boolean {
    return this._canceled
  }

  onCancel(fn: CancelListener): void {
    if (this._canceled) {
      fn()
      return
    }
    this.listeners.push(fn)
  }

  cancel(): void {
    if (this._canceled) return
    this._canceled = true

    for (const fn of this.listeners) {
      try {
        fn()
      } catch {
        // 单个监听器出错不能影响其他清理动作
      }
    }
    this.listeners = []
  }
}
