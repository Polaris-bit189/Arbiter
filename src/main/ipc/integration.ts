import { rmSync } from 'node:fs'
import { dirname } from 'node:path'
import { ipcMain, shell } from 'electron'
import { CH, integrationSetSchema, type IntegrationState } from '@shared/ipc-contract'
import { readContextMenu, syncContextMenu, type ContextMenuState } from '../core/integration'
import {
  readSendTo,
  setSendToIo,
  syncSendTo,
  type SendToIo,
  type SendToState
} from '../core/sendTo'
import { getSettings, updateSettings } from '../core/settings'

/**
 * 「系统集成」（M8 / M9）的 IPC：两个入口——资源管理器的**右键菜单**与**发送到**。
 *
 * ## 开关的语义：**先动系统，成功了才改设置**
 *
 * 两边都可能失败（`reg.exe` 被拦、权限、键被别的东西占着；快捷方式目录不可写），
 * 而设置里那一项是**意图**。先把意图翻过去、再看实际成败的话，失败后的状态是
 * 「开关显示已打开、右键却没有菜单」——用户唯一的反应是再点一次，而点了还是这样。
 * 所以顺序反着来：系统那边真改成了才落设置，没改成就不改设置、并把 `error` 一起
 * 返回，界面照着显示。
 *
 * 这也是为什么返回的是 `IntegrationState` 而不是一个新的 `Settings`：
 * 渲染层要同时看到「意图」与「实际」两个值，只回一个布尔必然丢掉一个。
 *
 * ## 两个开关共用一个通道
 *
 * 它们本该被一起读（设置页那一段要一次拿到两个入口的实际状态），而且下面是两套
 * 完全独立的实现（注册表 / 快捷方式），互不影响：其中一个失败不该把另一个也拖回去。
 * 载荷里两个字段都可选，所以「只翻其中一个」在契约上是明确的。
 */

/**
 * 「发送到」快捷方式的真实读写。
 *
 * 用 Electron 自带的 `shell.writeShortcutLink` / `readShortcutLink`，**不起子进程**：
 * 走 PowerShell 的 COM（`WScript.Shell.CreateShortcut`）也能做，但那是几百毫秒的
 * 进程启动开销，而且会被脚本执行策略影响——这两个 API 是同步的、零外部依赖。
 *
 * ⚠️ `operation` 用 `'create'` 而不是 `'replace'`。**实测**（2026-09-13，Windows 11 +
 * 本机 Electron，见 `scripts/test-integration.ts` 文件头那段说明）：
 *
 * ```
 * create(文件已存在)  → true，并且把 args 真的覆盖掉
 * replace(文件不存在) → **false**（不抛异常，只是返回 false）
 * readShortcutLink(不存在) → 抛 `Failed to read shortcut link`
 * ```
 *
 * 我们要的两个场景（首次安装、启动自愈时重写）里都可能有「文件缺失」这一种，
 * 所以只能用 `create`（它自带「必要时覆盖」）。写反了的表现是
 * 「第一次点开关永远装不上」——而且 `write` 会把 false 如实报成一句错误。
 *
 * `readShortcutLink` 对不存在的路径**抛异常**，所以下面那一圈 try/catch 是必须的：
 * 让异常穿出去的话，自愈的第一句就炸，用户看到的是启动时一条看不懂的报错。
 */
const electronSendToIo: SendToIo = {
  write(linkPath, spec) {
    try {
      const ok = shell.writeShortcutLink(linkPath, 'create', {
        target: spec.target,
        args: spec.args,
        description: spec.description,
        // 不显式给 cwd 的话，快捷方式会记下**创建时**我们进程的工作目录。
        // 给成 exe 所在目录，行为与用户手建的快捷方式一致。
        cwd: dirname(spec.target)
      })
      return ok ? null : '写入快捷方式失败（shell.writeShortcutLink 返回 false）'
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
  },

  read(linkPath) {
    try {
      const link = shell.readShortcutLink(linkPath)
      // Electron 这两个字段是**可选**的：一个只写了 TargetPath 的 .lnk 读回来没有 args。
      // 落成空串而不是 undefined，比对与展示两边都少一个特例。
      return {
        target: link.target,
        args: link.args ?? '',
        description: link.description ?? ''
      }
    } catch {
      // 文件不存在、或者那不是个合法的 .lnk —— 两种都当作「没有」。
      // 这里**不能**把异常抛出去：`read` 是自愈判据的第一步，抛了就等于每次启动都
      // 报一个用户看不懂的错。真正的写失败由 `write` 那一侧报。
      return null
    }
  },

  remove(linkPath) {
    try {
      // force: 文件不存在也算成功——「重复卸载」是正常路径，不是错误
      rmSync(linkPath, { force: true })
      return null
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
  }
}

/** 当前状态：两个入口各自的「意图 + 实际」。**只读**，随时可调 */
export async function integrationState(): Promise<IntegrationState> {
  const current = getSettings()
  return compose(current.contextMenu, await readContextMenu(), current.sendTo, readSendTo())
}

function compose(
  enabled: boolean,
  contextMenu: ContextMenuState,
  sendToEnabled: boolean,
  sendTo: SendToState
): IntegrationState {
  return {
    enabled,
    installed: contextMenu.installed,
    command: contextMenu.command,
    expected: contextMenu.expected,
    error: contextMenu.error,

    sendToEnabled,
    sendToInstalled: sendTo.installed,
    sendToPath: sendTo.path,
    sendToError: sendTo.error
  }
}

/** 右键菜单那一侧：写注册表 → 成了才落设置。返回一句要显示给用户的错，或 null */
async function applyContextMenu(wanted: boolean): Promise<string | null> {
  const { state } = await syncContextMenu(wanted)
  if (state.error === null && state.installed === wanted) {
    updateSettings({ contextMenu: wanted })
    return null
  }
  // `state.error` 可能是 null（比如要求装、结果读回来没装上）。那种情况也得给
  // 用户一句人话，否则界面上只有一个纹丝不动的开关。
  return state.error ?? '注册表没有落到预期状态'
}

/** 「发送到」那一侧：写/删快捷方式 → 成了才落设置 */
function applySendTo(wanted: boolean): string | null {
  const { state } = syncSendTo(wanted)
  if (state.error === null && state.installed === wanted) {
    updateSettings({ sendTo: wanted })
    return null
  }
  return state.error ?? '快捷方式没有落到预期状态'
}

export function registerIntegrationIpc(): void {
  // 注入点在这一层：`core/sendTo.ts` 自己不 import electron（约束 19 的同一套理由，
  // 那样它才能在普通 Node 里被完整驱动一遍）。忘了这一行不会崩，只会让开关显示
  // 「快捷方式读写未注入」——刻意如此，不做任何兜底。
  setSendToIo(electronSendToIo)

  ipcMain.handle(CH.integrationGet, () => integrationState())

  ipcMain.handle(CH.integrationSet, async (_event, raw): Promise<IntegrationState> => {
    const parsed = integrationSetSchema.safeParse(raw)
    if (!parsed.success) {
      // 与 settings:set 同一个口径：被拒比被静默忽略好，但被拒的痕迹必须留在终端上，
      // 否则渲染层看到的只是「点了没反应」，两端都查不出原因。
      console.warn('[integration] 拒绝了一份不合规的载荷：', parsed.error.issues)
      return integrationState()
    }

    // 两个开关互不牵连：一个失败不影响另一个照常落地
    const contextError =
      parsed.data.enabled === undefined ? null : await applyContextMenu(parsed.data.enabled)
    const sendToError = parsed.data.sendTo === undefined ? null : applySendTo(parsed.data.sendTo)

    // 回的是**重新读一遍的**实际状态，不是我们自以为做过的事
    const state = await integrationState()
    return {
      ...state,
      error: contextError ?? state.error,
      sendToError: sendToError ?? state.sendToError
    }
  })
}
