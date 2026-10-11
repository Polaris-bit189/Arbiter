/**
 * 关于页的文案。
 *
 * ⚠️ 中文值必须与迁移前源码里的字面量**逐字节相同**——闸门 d 会拿冻结快照逐值比对。
 * 迁移的时候是「把字面量搬进来、原样不动」，不是「顺手把哪句读着别扭的话改通顺」。
 *
 * ⚠️ 页面标题那行（产品名）**刻意不在这里再开一个键**，它取的是 `app.title`
 * （见 `parts/shell.ts`）。侧栏、标题栏、关于页 h1 三处显示的是**同一个产品名**，
 * 各开一个键的话，改名时漏掉一处不会有任何症状——只会在某个角落留着一个旧名字。
 *
 * ⚠️ 「格式支持」那段话被拆成了**三段**（`supports` / `groupedInto` / `groupedTail`），
 * 这不是偷懒：句子中间夹着两个被 `.font-mono text-gold-bright` / `text-fg-faint`
 * 单独上了色的数字，合成一句就必须把那个 `<span>` 拆掉（改样式），
 * 而闸门 d 只认「迁移前源码里那三段各自的样子」。三段英文也照三步读通顺来写。
 */

export const aboutZh = {
  /* ---- 页面骨架 ---- */
  'about.loading': '读取中…',
  'about.dismiss': '关闭',

  /* ---- 引擎状态 ---- */
  'about.engines': '引擎状态',
  'about.engines.hint':
    '版本号要起一个子进程去问（LibreOffice 约 3～5 秒），所以不随页面自动探测。',
  'about.engine.ready': '已就绪',
  'about.engine.missing': '未就绪',
  'about.engine.unpacking': '正在解包…',
  'about.engine.downloading': '下载中…',
  'about.engine.download': '下载（{size}）',
  'about.engine.probing': '探测中…',
  'about.engine.probe': '探测版本',
  'about.engine.installFailed': '{label} 下载失败：{error}',

  /* ---- 格式支持（三段合起来是一句话，理由见文件头）---- */
  'about.formats': '格式支持',
  'about.formats.supports': '共支持',
  'about.formats.groupedInto': '种源格式，归为',
  'about.formats.groupedTail': '个大类；砖上写着扩展名的那种有专属图标，其余落在通用砖上。'
} as const

export const aboutEn: Record<keyof typeof aboutZh, string> = {
  'about.loading': 'Loading…',
  'about.dismiss': 'Dismiss',

  'about.engines': 'Engine status',
  'about.engines.hint':
    'Reading a version means asking a child process (LibreOffice takes about 3–5 seconds), so nothing is probed when the page opens.',
  'about.engine.ready': 'Ready',
  'about.engine.missing': 'Not ready',
  'about.engine.unpacking': 'Extracting…',
  'about.engine.downloading': 'Downloading…',
  'about.engine.download': 'Download ({size})',
  'about.engine.probing': 'Probing…',
  'about.engine.probe': 'Probe version',
  'about.engine.installFailed': 'Could not download {label}: {error}',

  // 三段合起来是：Supports 62 source formats across 6 categories; …
  // 数字由调用方插在两段之间，所以每一段都要能接上前一段、也要能被下一段接上。
  'about.formats': 'Format support',
  'about.formats.supports': 'Supports',
  'about.formats.groupedInto': 'source formats across',
  'about.formats.groupedTail':
    'categories; extensions that have their own icon get a dedicated tile, the rest land on a generic one.'
}
