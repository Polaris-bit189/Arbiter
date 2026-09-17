import type { Category } from '@shared/types'

/**
 * 类别 → 中文名。队列行副标题（「MP4 · 视频」）与目标格式下拉的分组标签都读它。
 *
 * **单独成一个文件，而不是挂在某个组件里导出。** 挂在组件文件里会同时踩两件事：
 * 一是 `react-refresh/only-export-components`（组件文件导出非组件会红），
 * 二是循环引用——`TaskCard` 要用它、`TargetFormatSelect` 也要用它，
 * 而 `TaskCard` 又 import 了 `TargetFormatSelect`。
 *
 * 写成 `Record<Category, string>`：将来往 `CATEGORIES` 里加一类却忘了补这里，
 * 直接是编译错误，而不是界面上冒出一个没有名字的分组。
 *
 * 主进程另有一份同名映射（`main/ipc/tasks.ts`），那是给系统文件对话框的过滤器当
 * 标签用的。两边服务的是两个进程，共享不了；两边都写成 `Record<Category, string>`，
 * 所以任何一边漏了类别都会在编译期被抓住。
 */
export const CATEGORY_LABEL: Record<Category, string> = {
  video: '视频',
  audio: '音频',
  image: '图片',
  document: '文档',
  ebook: '电子书',
  archive: '压缩包'
}
