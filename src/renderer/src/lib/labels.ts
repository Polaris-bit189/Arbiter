/**
 * 类别名的**转出口**。
 *
 * 表的实体住在 `@shared/i18n/keys`——因为 `CATEGORY_LABEL` 原先有三份副本
 * （这里、主进程的 `main/ipc/tasks.ts`、MCP 的 `formatsView.ts`），而它们服务的是
 * 三个进程，谁也 import 不到谁。三份一起漂的表现是**同一个类别在界面、在系统文件
 * 对话框、在 agent 的返回值里叫三个名字**，而没有任何地方会报错。
 *
 * `src/shared` 是唯一能被三方同时 import 的落点（与 `formatBytes` 同一个理由）。
 * 这个文件留着是为了让渲染层的六个调用点**一个字都不用改**。
 *
 * ⚠️ **值现在是 `KeysOf<'category.'>` 而不是字符串**，所以取词的地方要写
 * `t(CATEGORY_LABEL[x])`——那一步改变的是类型，而类型让「有一条忘了包 `t()`」
 * 变成编译错误。
 */
export { CATEGORY_LABEL } from '@shared/i18n/keys'
