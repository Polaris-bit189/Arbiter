/**
 * 引擎状态（engines/status.ts）：引擎显示名、来源说明、探测错误。
 *
 * ⚠️ 这一类与渲染层那几块有一个**关键差别**：它们的文字**由主进程产出**，
 * 而其中一部分由 OS 去画（原生对话框、系统通知、注册表菜单、快捷方式描述）——
 * 渲染进程根本不在场。所以取词必须走 `@shared/i18n` 那份**模块级全局**
 * （见 `core/locale.ts`），不能「把语言传进来」：那些调用点拿不到「这是哪个界面」。
 *
 * ⚠️ 中文值必须与迁移前逐字节相同——闸门 d 逐值比对冻结快照。
 *
 * ## 两族前缀各自成一段，是为了 `KeysOf` 能切准
 *
 * `engines.label.` 会被 `KeysOf<'engines.label.'>` 切成**恰好那八个引擎名**，
 * 而它们的共同点是「一个参数都不要」（见 `types.ts` 里 `KeysOf` 那段说明）。
 * 探测器那几条错误文案带 `{message}` / `{seconds}`，所以它们在 `engines.probe.` 下
 * ——混进 `engines.label.` 那一族会让 `t()` 报「必须传参数」的假编译错误。
 */

export const enginesZh = {
  /* ---- 引擎显示名 ---- */
  /* ⚠️ 七个引擎名里只有 `pdf` 中英不同形，其余是产品名。
     产品名照样**在两边各写一遍**——靠代码分支去决定「这个名字翻不翻」正是
     「漏一个就静默」的形态：加第八个引擎时那个分支不会报错，只会让它在一侧失踪。 */
  'engines.label.ffmpeg': 'FFmpeg',
  'engines.label.sharp': 'Sharp',
  'engines.label.pdf': 'Chromium 排版',
  'engines.label.pandoc': 'Pandoc',
  'engines.label.libreoffice': 'LibreOffice',
  'engines.label.calibre': 'Calibre',
  'engines.label.archive': '7-Zip',
  'engines.label.encmusic': '加密音乐容器',

  /* ---- 引擎来源（徽章上那三个词）---- */
  'engines.origin.bundled': '随包内置',
  'engines.origin.installed': '按需下载',
  'engines.origin.system': '系统安装',

  /* ---- 能力说明 ---- */
  'engines.detail.rarFull': '完整版，支持 RAR',
  'engines.detail.rarLight': '精简版，不支持 RAR',
  'engines.detail.encmusic': '内置（纯 JS）',
  'engines.detail.sharp': '原生模块（libvips）',
  'engines.detail.pdf': 'Chromium 内置',

  /* ---- 版本探测失败的原因 ---- */
  'engines.probe.spawnFailed': '无法启动进程：{message}',
  'engines.probe.timeout': '探测超时（{seconds} 秒）',
  'engines.probe.exitCode': '退出码 {code}',
  'engines.probe.exitCodeWithMessage': '退出码 {code}：{message}',
  'engines.probe.noVersion': '输出里没有版本号',
  'engines.probe.noSofficeCom': '同目录下没有 soffice.com，捕获不到版本输出'
} as const

export const enginesEn: Record<keyof typeof enginesZh, string> = {
  'engines.label.ffmpeg': 'FFmpeg',
  'engines.label.sharp': 'Sharp',
  'engines.label.pdf': 'Chromium typesetting',
  'engines.label.pandoc': 'Pandoc',
  'engines.label.libreoffice': 'LibreOffice',
  'engines.label.calibre': 'Calibre',
  'engines.label.archive': '7-Zip',
  'engines.label.encmusic': 'Encrypted music container',

  'engines.origin.bundled': 'Bundled with the app',
  'engines.origin.installed': 'Downloaded on demand',
  'engines.origin.system': 'System install',

  'engines.detail.rarFull': 'Full build, RAR supported',
  'engines.detail.rarLight': 'Reduced build, no RAR support',
  'engines.detail.encmusic': 'Built in (pure JS)',
  'engines.detail.sharp': 'Native module (libvips)',
  'engines.detail.pdf': 'Built into Chromium',

  'engines.probe.spawnFailed': 'Could not start the process: {message}',
  'engines.probe.timeout': 'Probe timed out ({seconds}s)',
  'engines.probe.exitCode': 'Exit code {code}',
  'engines.probe.exitCodeWithMessage': 'Exit code {code}: {message}',
  'engines.probe.noVersion': 'No version number in the output',
  'engines.probe.noSofficeCom':
    'No soffice.com beside the engine, so its version output cannot be captured'
}
