/**
 * 外壳：标题栏、侧栏、Toast、以及窗口标题。
 *
 * ## 字典为什么按区域拆成多个文件
 *
 * 一条硬理由与一条软理由：
 *
 * - **硬**：一张 400 多句的表放在一个文件里，凡是碰它的改动都会互相冲突——
 *   而「迁一个面板的文案」天然是可以并行的活。按区域拆开之后，**每个面板的键
 *   与它自己的组件文件放在一起改**，两个人同时迁两个面板不会撞。
 * - **软**：「这句话归谁管」一眼能看出来。键名用点分区域（`settings.language`），
 *   而区域文件与之一一对应。改一句文案不必改键名——键名一改，英文表少一条就是
 *   编译错误，那个错误会以「你删了一句话」的形式出现，而实际上你只是把中文改通顺了。
 *
 * 每个区域文件的形状是固定的：\`xxxZh\`（\`as const\`）+ \`xxxEn\`（\`Record<keyof xxxZh, string>\`）。
 * 后者那个类型让**漏一条就是编译错误**，而且**只在本区域内**——你不必为了加一句
 * 设置页的文案去翻整个英文表。
 *
 * ⚠️ **中文值必须与迁移前源码里的字面量逐字节相同**：`test-i18n.ts` 的闸门 d 拿
 * 冻结快照逐值比对，改一个字就红。那条闸门保护的是一百多条直接断言中文字面量的
 * 老断言——它们一条都不改，靠的就是「中文没被动过」。
 */

export const shellZh = {
  /* 产品名。窗口标题、侧栏与标题栏的字标、关于页的 h1 都取它——**同一个名字只有一个来源** */
  'app.title': '调律者转换器',

  /* ---- 侧栏 ---- */
  'shell.sidebar.tagline': '令万物归于其应有之格式',
  'shell.sidebar.footer': '秩序归于格式',
  /* ⚠️ 这一条刻意**不在** `shell.nav.` 下：那一族是给 `KeysOf<'shell.nav.'>` 切出来
     当四项导航的键表用的，混进一个带 `{count}` 的进去，`t(item.label)` 那处会变成
     「必须传参数」的假编译错误（见 `types.ts` 里 `KeysOf` 那段说明）。 */
  'shell.sidebar.running': '正在调律 {count} 个',
  'shell.nav.work': '调律工作台',
  'shell.nav.history': '历史记录',
  'shell.nav.settings': '格式设置',
  'shell.nav.about': '关于',

  /* ---- 自绘标题栏的三键（`title` 与 `aria-label` 共用同一句）---- */
  'shell.window.minimize': '最小化',
  'shell.window.maximize': '最大化',
  'shell.window.restore': '向下还原',
  'shell.window.close': '关闭',

  /* ---- 拖拽区 ---- */
  'shell.dropzone.drop': '松手，令其归于此处',
  'shell.dropzone.idle': '将文件拖入此间，令其归于应有之格式',
  'shell.dropzone.kinds': '视频 · 音频 · 图片 · 文档 · 电子书 · 压缩包',
  'shell.dropzone.unavailable': '当前环境无法解析拖入文件的路径',

  /* ---- 目标格式下拉 ---- */
  'shell.target.locked': '调律中，目标格式已锁定',
  'shell.target.highlighted': '上次这类文件转成了 {ext}（已替你预置，可以改）',
  'shell.target.title': '转为 {ext}',

  /* ---- 完成后动作的回执条 ---- */
  /* ⚠️ 四个结局名住在 `shell.after.label.` 这个**单独的子前缀**下，理由同上面那条：
     `KeysOf<'shell.after.label.'>` 要能切成「四项、且都不带参数」的键表。
     与 `shared.ts` 里 `shared.trimMode.` 的处理是同一个形状。 */
  'shell.after.label.none': '什么也没做',
  'shell.after.label.copyPath': '已复制路径',
  'shell.after.label.copyFile': '已复制这个文件',
  'shell.after.label.openFolder': '已在文件夹中显示',
  'shell.after.done': '{label}：{name}',
  'shell.after.failed': '未能完成：{reason}',
  'shell.after.artifact': '产物',
  'shell.after.unknownReason': '原因不明',
  'shell.after.copyAgain': '再复制一次',
  'shell.after.dismiss': '收起',
  'shell.after.clipboardHint': '剪贴板随时可能被别的程序接管。粘出来若不对，点「再复制一次」。'
} as const

export const shellEn: Record<keyof typeof shellZh, string> = {
  'app.title': 'Arbiter',

  'shell.sidebar.tagline': 'All things to their rightful format',
  'shell.sidebar.footer': 'Order restored to format',
  'shell.sidebar.running': '{count} in progress',
  'shell.nav.work': 'Workbench',
  'shell.nav.history': 'History',
  'shell.nav.settings': 'Format settings',
  'shell.nav.about': 'About',

  'shell.window.minimize': 'Minimize',
  'shell.window.maximize': 'Maximize',
  'shell.window.restore': 'Restore',
  'shell.window.close': 'Close',

  'shell.dropzone.drop': 'Release to give it its rightful format',
  'shell.dropzone.idle': 'Drop files here to give them their rightful format',
  'shell.dropzone.kinds': 'Video · Audio · Image · Document · Ebook · Archive',
  'shell.dropzone.unavailable': 'This environment cannot resolve the paths of dropped files',

  'shell.target.locked': 'Converting — the target format is locked',
  'shell.target.highlighted':
    'Last time this kind of file became {ext} (pre-filled, you can change it)',
  'shell.target.title': 'Convert to {ext}',

  'shell.after.label.none': 'Nothing done',
  'shell.after.label.copyPath': 'Path copied',
  'shell.after.label.copyFile': 'File copied',
  'shell.after.label.openFolder': 'Revealed in its folder',
  // 中文那侧是「<结局>：<名字>」整句一个键，为的是英文这里能写半角冒号——
  // 冒号硬编码在调用点的话，英文界面里会长出一个全角「：」。
  'shell.after.done': '{label}: {name}',
  'shell.after.failed': 'Failed: {reason}',
  'shell.after.artifact': 'output file',
  'shell.after.unknownReason': 'reason unknown',
  'shell.after.copyAgain': 'Copy again',
  'shell.after.dismiss': 'Dismiss',
  'shell.after.clipboardHint':
    'Another program can take over the clipboard at any moment. If the paste looks wrong, click “Copy again”.'
}
