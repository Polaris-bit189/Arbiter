import { settingsZh } from './parts/settings'
import { shellZh } from './parts/shell'
import { filtersZh } from './parts/filters'
import { historyZh } from './parts/history'
import { workbenchZh } from './parts/workbench'
import { optionsZh } from './parts/options'
import { aboutZh } from './parts/about'
import { libsZh } from './parts/libs'
import { folderScanZh } from './parts/folderScan'
import { ipcZh } from './parts/ipc'
import { enginesZh } from './parts/engines'
import { integrationZh } from './parts/integration'
import { stageZh } from './parts/stage'
import { sharedZh } from './parts/shared'
// —— P6：MCP / CLI（agent 侧入口，每个区域一片，理由见各片文件头）——
import { mcpToolsZh } from './parts/mcpTools'
import { mcpErrorsZh } from './parts/mcpErrors'
import { mcpInspectZh } from './parts/mcpInspect'
import { mcpJobsZh } from './parts/mcpJobs'
import { mcpMainZh } from './parts/mcpMain'
import { cliZh } from './parts/cli'
import { errorsZh } from './parts/errors'

/**
 * 中文字典 —— **全仓唯一允许出现中文字面量的源码**（含它旁边 `parts/` 下的那些）。
 *
 * ## 为什么值得这么严
 *
 * 界面文案散在 40 多个文件里时，「英文版」永远做不完整——漏掉的那几句不会有任何症状，
 * 只会让英文用户看到一句中文。这条规矩由 `scripts/test-i18n.ts` 的**闸门 a**
 * 机器化保证：它逐文件统计含 CJK 的字符串字面量，与一张预算表比对，多一条就红。
 * **注释不算**——这个项目的注释是中文的，那是给人读的设计说明，不参与翻译。
 *
 * ## 这个文件只做装配
 *
 * 句子按区域住在 `./parts/*.ts` 里（每个区域文件同时带 zh 与 en，理由见那里的文件头）。
 * 这里把它们拼成一张表；`MsgKey` 与 `en.ts` 都从拼出来的形状派生。
 *
 * ⚠️ **中文值必须与迁移前源码里的字面量逐字节相同。** 闸门 d 拿冻结快照逐值比对，
 * 改一个字就红——那条闸门保护的是一百多条**直接断言中文字面量**的老断言，
 * 它们一条都不用改，靠的就是「中文没被动过」。要改文案就同提交改断言，
 * 别把闸门 d 当成碍事的东西。
 *
 * ## 占位符
 *
 * 写 `{name}`，不写 `${name}`（避开模板字面量），也不写 `%s`（三个以上没人读得懂）。
 * 参数名会被 `ParamNames` 从模板里抠出来，于是**该传的参数忘了传是编译错误**。
 */
export const zh = {
  ...shellZh,
  ...settingsZh,
  ...filtersZh,
  ...historyZh,
  ...workbenchZh,
  ...optionsZh,
  ...aboutZh,
  ...libsZh,
  ...sharedZh,
  ...folderScanZh,
  ...ipcZh,
  ...enginesZh,
  ...integrationZh,
  ...stageZh,
  // —— P6 ——
  ...mcpToolsZh,
  ...mcpErrorsZh,
  ...mcpInspectZh,
  ...mcpJobsZh,
  ...mcpMainZh,
  ...cliZh,
  ...errorsZh
} as const satisfies Record<string, string>

/** 给 `MsgKey` 用的类型；单独导出是因为 `types.ts` 要从这里 import。 */
export type ZhTable = typeof zh
