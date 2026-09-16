/**
 * `turndown-plugin-gfm` 没有自带类型定义，也没有 `@types/` 包（它 2018 年后就没再发版）。
 *
 * 只补我们真正用到的那两个导出的签名，而不是写成 `declare module ... : any`——
 * 后者会让这个模块里所有的类型错误都沉默下来。
 */
declare module 'turndown-plugin-gfm' {
  import type TurndownService from 'turndown'

  type Plugin = (service: TurndownService) => void

  /** 表格、删除线、任务列表三项一起装 */
  export const gfm: Plugin
  /** 只装表格。Word 文档里的表格全靠它，否则整张表会被静默丢掉 */
  export const tables: Plugin
  export const strikethrough: Plugin
  export const taskListItems: Plugin
}
