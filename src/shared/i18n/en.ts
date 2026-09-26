import { settingsEn } from './parts/settings'
import { shellEn } from './parts/shell'
import { filtersEn } from './parts/filters'
import { historyEn } from './parts/history'
import { workbenchEn } from './parts/workbench'
import { optionsEn } from './parts/options'
import { aboutEn } from './parts/about'
import { libsEn } from './parts/libs'
import { folderScanEn } from './parts/folderScan'
import { ipcEn } from './parts/ipc'
import { enginesEn } from './parts/engines'
import { integrationEn } from './parts/integration'
import { stageEn } from './parts/stage'
import { sharedEn } from './parts/shared'
// —— P6：MCP / CLI（与 `zh.ts` 同一批，顺序也保持一致）——
import { mcpToolsEn } from './parts/mcpTools'
import { mcpErrorsEn } from './parts/mcpErrors'
import { mcpInspectEn } from './parts/mcpInspect'
import { mcpJobsEn } from './parts/mcpJobs'
import { mcpMainEn } from './parts/mcpMain'
import { cliEn } from './parts/cli'
import { errorsEn } from './parts/errors'
import type { MsgKey } from './types'

/**
 * 英文字典。与 `zh.ts` 一样，**只做装配**——句子住在 `./parts/*.ts` 里。
 *
 * 类型是 `Record<MsgKey, string>`：漏一条就是编译错误，而不是界面上冒出一个
 * `settings.language`。这条比「写个脚本对一遍」可靠——脚本要有人去跑，编译错误不用。
 * 而**每个区域文件自己那一份 `Record<keyof typeof xxxZh, string>`** 让这个错误
 * 落在一个小得多的范围里：加一句设置页的文案，报错只会在那份设置页的表里。
 *
 * ## 两条纪律
 *
 * - **不是机翻。** 这些句子是给一个用英文的人读的，不是给一个对照中文的人读的。
 *   该重写就重写（MCP 工具的 description 那批尤其——它们是给模型读的 API 说明书）。
 * - **占位符必须与中文里的一模一样**（`{name}` 这些名字不要改）。闸门 c 比对两边的
 *   占位符集合，少写一个是红；而名字改了是**两边都对不上**，同样红。
 */
export const en: Record<MsgKey, string> = {
  ...shellEn,
  ...settingsEn,
  ...filtersEn,
  ...historyEn,
  ...workbenchEn,
  ...optionsEn,
  ...aboutEn,
  ...libsEn,
  ...sharedEn,
  ...folderScanEn,
  ...ipcEn,
  ...enginesEn,
  ...integrationEn,
  ...stageEn,
  // —— P6 ——
  ...mcpToolsEn,
  ...mcpErrorsEn,
  ...mcpInspectEn,
  ...mcpJobsEn,
  ...mcpMainEn,
  ...cliEn,
  ...errorsEn
}
