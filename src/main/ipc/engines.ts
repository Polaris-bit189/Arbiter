import { BrowserWindow, ipcMain } from 'electron'
import { CH, engineInstallSchema, engineProbeSchema } from '@shared/ipc-contract'
import type { EngineKey, EngineProgress, EngineStatus } from '@shared/types'
import { engineStatus, probeEngineVersions } from '../engines/status'
import { installEngine, loadEngineManifest } from '../core/engineInstall'

/**
 * 引擎状态的 IPC handler。
 *
 * 通道：`engines:status` / `engines:probe`（见 `channels.ts`）。
 *
 * **两条通道的代价差着三个数量级，不能混用**：
 *   - `status` 只做 `existsSync`（引擎路径解析在 `main/engines/*.ts` 里已缓存），
 *     页面渲染走这条
 *   - `probe` 真起 `spawn(exe, ['--version'])` 子进程——LibreOffice 3～5 秒、
 *     Calibre 还要拉起 Python。只有用户显式点「探测版本」才走
 *
 * `probe` 有超时，超时后 kill 父进程**还要 `taskkill /pid <pid> /T /F`**：
 * `soffice.exe` 只是个瘦壳启动器，真身是它拉起的 `soffice.bin`，
 * 只杀父进程会留下孤儿进程占着 profile 锁（约束 3）。
 *
 * 两层各自的实现都在 `main/engines/status.ts`，这里只做入参校验与并发兜底。
 */

/**
 * 同一时刻只允许一次探测会话。
 *
 * 渲染层在探测期间会把按钮禁掉，但**渲染进程是不可信输入**：一个连点五下的按钮、
 * 或者将来某条线加的「全部探测」入口，就是七个子进程 × N，其中还包括两个会去抢
 * 同一把 LibreOffice profile 锁的实例——那个组合是真的会挂住的。
 *
 * 并发请求直接复用同一次会话的 promise：探测返回的本来就是完整列表，后到的那个
 * 拿到的仍然是**正确**（只是可能不含它点名那一项）的快照，比拒绝或再起一轮都好。
 */
let probing: Promise<EngineStatus[]> | null = null

function probeOnce(key?: EngineKey): Promise<EngineStatus[]> {
  if (probing !== null) return probing

  probing = probeEngineVersions(key).finally(() => {
    probing = null
  })
  return probing
}

/**
 * 给「未就绪」的那几个补上**按需下载体积**。
 *
 * 清单是唯一的真相源，但它住在 `core/downlink.ts`（那份模块 `import { net } from 'electron'`），
 * 而 `engines/status.ts` 要保持能被 MCP 那条没有 Electron 的链路加载——所以这层
 * 合并刻意放在 ipc（Electron 专有）这一侧，而不是塞进 `engineStatus()` 里。
 *
 * 读不到清单**不算错**：`downloadBytes` 只是「约 340 MB」那句提示，缺了它
 * 状态列表照样是完整可用的。所以这里吞掉异常，不把关于页拖成一个错误页。
 */
async function withDownloadSizes(statuses: EngineStatus[]): Promise<EngineStatus[]> {
  try {
    const manifest = await loadEngineManifest()
    return statuses.map((status) => {
      if (status.state !== 'missing') return status
      const entry = manifest.engines.find((engine) => engine.key === status.key)
      return entry === undefined ? status : { ...status, downloadBytes: entry.sizeBytes }
    })
  } catch {
    return statuses
  }
}

export function registerEngineIpc(): void {
  ipcMain.handle(CH.enginesStatus, (): Promise<EngineStatus[]> => withDownloadSizes(engineStatus()))

  ipcMain.handle(CH.enginesProbe, async (_event, raw): Promise<EngineStatus[]> => {
    const parsed = engineProbeSchema.safeParse(raw)
    // 参数不合法就退回廉价快照，而不是让它 reject：这里没有任何东西值得为一次拼错的
    // 参数把 invoke 变成失败——渲染层收到 reject 只能显示一句没有信息量的提示，
    // 而一份真实的状态列表至少还能用。
    if (!parsed.success) return withDownloadSizes(engineStatus())
    return withDownloadSizes(await probeOnce(parsed.data.key))
  })

  /**
   * 就地下载并解包一个引擎，把进度推给所有窗口。
   *
   * **不设「正在装」的单飞表**：`installEngine()` 自己就是单飞的（同一个引擎并发
   * 只跑一次，后到的拿到同一个 promise）。在这里再挡一道只会让「另一个窗口也想装」
   * 拿到一个假的 rejected。
   *
   * 失败**不吞**：渲染层要能把原因显示出来（最常见的两条是「所有镜像都不可达」
   * 与「sha256 对不上」，前者多半是网络，后者意味着下载源换了文件）。
   */
  ipcMain.handle(CH.enginesInstall, async (_event, raw): Promise<EngineStatus[]> => {
    const parsed = engineInstallSchema.safeParse(raw)
    if (!parsed.success) return withDownloadSizes(engineStatus())

    const key = parsed.data.key
    await installEngine(key, {
      onProgress: (progress) => {
        const payload: EngineProgress = {
          key,
          // `verify` 这一档目前不单独报：sha256 是在下载的最后一步流的，
          // 单独拆出来只会多一次 UI 抖动（那一瞬间的进度是 100%，看起来像卡住）
          phase: progress.phase,
          receivedBytes: progress.receivedBytes,
          totalBytes: progress.totalBytes,
          percent: progress.percent ?? 0
        }
        for (const window of BrowserWindow.getAllWindows()) {
          if (!window.isDestroyed()) window.webContents.send(CH.enginesProgress, payload)
        }
      }
    })

    // 装完重新探一轮：状态列表要反映**刚刚落盘的那份**，而不是装之前那一次缓存
    //（解析器的缓存虽然被 installEngine 清了，但 engineStatus 自己也要重算一遍）
    return withDownloadSizes(engineStatus())
  })
}
