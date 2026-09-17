import { spawn } from 'child_process'

/**
 * 杀掉整个进程树。
 *
 * 必须用 /T：LibreOffice 的 soffice.exe 会拉起 soffice.bin，只杀父进程会留下
 * 孤儿进程占着 profile 锁，导致之后所有 LibreOffice 转换**静默失败**
 * （退出码 0 但没有任何产物），非常难排查。
 *
 * 永远不等待失败：即使 taskkill 报错也照常 resolve，否则调用方会卡死。
 */
export function killTree(pid: number | undefined): Promise<void> {
  if (!pid || pid <= 0) return Promise.resolve()

  return new Promise((resolve) => {
    let settled = false
    const done = (): void => {
      if (settled) return
      settled = true
      resolve()
    }

    try {
      // 数组参数，不经 shell；windowsHide 避免在 Windows 上闪黑框
      const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
        windowsHide: true
      })
      killer.on('exit', done)
      killer.on('error', done)
    } catch {
      done()
      return
    }

    // 兜底：5 秒内没退干净就放弃等待
    const timer = setTimeout(done, 5000)
    timer.unref?.()
  })
}
