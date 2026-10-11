import type { Category } from '../types'
import type { KeysOf } from './types'

/**
 * 跨进程共用的**键表**：一个值是一组字典键的映射，主进程与渲染层读同一份。
 *
 * ## 它为什么必须住在这里
 *
 * `CATEGORY_LABEL` 原先有**三份副本**（渲染层的 `lib/labels.ts`、主进程的
 * `main/ipc/tasks.ts`、以及 MCP 的 `formatsView.ts`）。三份都在讲同一件事——
 * 「video 这一类叫什么名字」——而它们服务的是三个进程，谁也 import 不到谁。
 * 三份一起漂的表现是**同一个类别在界面、在系统文件对话框、在 agent 的返回值里
 * 叫三个名字**，而没有任何地方会报错。
 *
 * `src/shared` 是唯一能被三方同时 import 的落点，所以表放这里。
 * 这与 `src/shared/format.ts` 里 `formatBytes` 的理由是同一条（那句话在队列卡片与
 * 历史页上必须是同一串字）。
 *
 * ## ⚠️ 值必须是**窄联合**，不能是 `MsgKey`
 *
 * 写成 `Record<Category, MsgKey>` 会让 `t(CATEGORY_LABEL[x])` 报一个毫不相干的
 * `Expected 2 arguments, but got 1`——因为整个 `MsgKey` 里包含 `eta.seconds`
 * 这类带占位符的键。`KeysOf<'category.'>` 切出来的那六个一个参数都不要。
 * 这个坑在 P2 里被四个并行线各踩了一次。
 */

/** 类别 → 中文名 / 英文名。队列行副标题、目标格式下拉的分组、系统文件对话框的过滤器都读它 */
export const CATEGORY_LABEL: Record<Category, KeysOf<'category.'>> = {
  video: 'category.video',
  audio: 'category.audio',
  image: 'category.image',
  document: 'category.document',
  ebook: 'category.ebook',
  archive: 'category.archive'
}
