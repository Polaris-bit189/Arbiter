import { LOCALES, t, type KeysOf, type LocaleSetting } from '@shared/i18n'
import { CATEGORIES, type Category, type Settings } from '@shared/types'
import { targetsForCategory } from '@shared/formats'
import { Icon } from '../components/Icon'
import { spriteIdFor } from '../lib/icons'
import { CATEGORY_LABEL } from '../lib/labels'
import { cn } from '../lib/cn'
import { SHORTCUT_TABLE, type ShortcutAction } from '../lib/shortcuts'
import { useSettings } from '../store/useSettings'
import { useIntegration } from '../store/useIntegration'

/** 「没有偏好」那一档的值。**不能是空扩展名**——见 `setCategoryTarget` 的注释 */
const INHERIT = ''

// ⚠️ `KeysOf<'settings.conflict.'>` 而不是整个 `MsgKey`：后者会把 `eta.seconds` 那种
// **带占位符**的键也收进来，于是 `t(label)` 报「Expected 2 arguments」——一个与本表
// 毫无关系的假错误（见 `types.ts` 里 `KeysOf` 的说明）。
const CONFLICT_OPTIONS: ReadonlyArray<{
  value: Settings['onConflict']
  label: KeysOf<'settings.conflict.'>
  hint: KeysOf<'settings.conflict.'>
}> = [
  { value: 'rename', label: 'settings.conflict.rename', hint: 'settings.conflict.rename.hint' },
  {
    value: 'overwrite',
    label: 'settings.conflict.overwrite',
    hint: 'settings.conflict.overwrite.hint'
  },
  { value: 'skip', label: 'settings.conflict.skip', hint: 'settings.conflict.skip.hint' }
]

/** 并发上限的可选范围。16 是 `settingsPatchSchema` 的上界，两处必须一致 */
const CONCURRENCY_CHOICES = Array.from({ length: 16 }, (_, i) => i + 1)

/**
 * 「转换完成之后」。**第一档必须是「什么都不做」，而且默认就是它**——
 * 自动往剪贴板里写会覆盖用户手里的内容，且事后极难归因（见 `DEFAULT_AFTER_CONVERT`）。
 */
const AFTER_OPTIONS: ReadonlyArray<{
  value: Settings['afterConvert']
  label: KeysOf<'settings.after.'>
  hint: KeysOf<'settings.after.'>
}> = [
  { value: 'none', label: 'settings.after.none', hint: 'settings.after.none.hint' },
  { value: 'copy-path', label: 'settings.after.copyPath', hint: 'settings.after.copyPath.hint' },
  {
    value: 'copy-file',
    label: 'settings.after.copyFile',
    hint: 'settings.after.copyFile.hint'
  },
  {
    value: 'open-folder',
    label: 'settings.after.openFolder',
    hint: 'settings.after.openFolder.hint'
  }
]

/**
 * 快捷键的文案（E-7）。**键位不在这里**——那张表在 `lib/shortcuts.ts` 里，
 * 紧挨着判据放，测试才有办法拿它去喂 `resolveShortcut`（见那边的 `SHORTCUT_TABLE`）。
 *
 * 类型写成 `Record<ShortcutAction, KeysOf<'settings.shortcuts.'>>`：将来加第四个快捷键
 * 而忘了写文案，是**编译错误**，不是界面上一片空白。
 *
 * ⚠️ 存的是**键**而不是字符串：模块级常量不会随语言重算，直接取词会「切了英文这一节
 * 还是中文」——`App.tsx` 的 `key={locale}` 重挂的是组件树，不是模块。
 */
const SHORTCUT_HELP: Record<ShortcutAction, KeysOf<'settings.shortcuts.'>> = {
  'pick-files': 'settings.shortcuts.pickFiles',
  start: 'settings.shortcuts.start',
  'cancel-running': 'settings.shortcuts.cancelRunning'
}

/* ------------------------------------------------------------------ 零件 */

/**
 * 三档语言的名字**都在字典里**，这里只是一张映射。
 *
 * 写成 `Record<LocaleSetting, MsgKey>` 而不是三个字面量分支：漏一档是**编译错误**，
 * 而分支写法漏一档只是那个选项不出现——一个没人会发现的静默缺失。
 */
const LANGUAGE_LABEL: Record<LocaleSetting, KeysOf<'settings.language.'>> = {
  system: 'settings.language.system',
  zh: 'settings.language.zh',
  en: 'settings.language.en'
}

function Section({
  title,
  hint,
  children
}: {
  title: string
  hint?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <section className="mt-6">
      <h2 className="mb-1 font-display text-[16px] tracking-[3px] text-gold-pale">{title}</h2>
      {children}
      {/* 说明文字放在**整组**下面而不是逐条重复：这几行遵循的是同一条规则，
          同一句话写几遍只会把页面变成噪音（设计 7.4「克制」）。 */}
      {hint !== undefined && (
        <p className="mt-2 text-[11px] tracking-[0.5px] text-fg-faint">{hint}</p>
      )}
    </section>
  )
}

function Row({
  label,
  children
}: {
  // `ReactNode` 而不是 `string`：快捷键那一节要在左栏摆一个 `<kbd>`。
  // 其余各处照旧传字符串，宽窄由左栏那 96px 定死，排版不受影响。
  label: React.ReactNode
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex items-start gap-4 border-b border-line py-3 last:border-b-0">
      <div className="w-[96px] shrink-0 pt-1.5 text-[13px] text-fg-muted">{label}</div>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  )
}

/**
 * 分段选择。三态以下用它比下拉少一次点击，选项也不会被折叠起来。
 *
 * 激活态用一层淡金底色，而不是主按钮那套满金渐变：同一屏里有两处分段
 * （输出目录、同名文件），都用满金就违反了「金色不超过可视区域 10%」。
 * 底色走行内样式，与 `Sidebar.tsx` 的导航激活态同一处理——它是一段带透明度的
 * 多段渐变，拼成工具类又长又难核对，而底纹本来也不该跟着主题漂。
 */
function Segmented<T extends string>({
  value,
  options,
  onChange
}: {
  value: T
  options: ReadonlyArray<{ value: T; label: string; hint?: string }>
  onChange: (next: T) => void
}): React.JSX.Element {
  return (
    <div className="inline-flex gap-0.5 rounded-card border border-line-2 bg-raised p-0.5">
      {options.map((opt) => {
        const active = opt.value === value
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => onChange(opt.value)}
            title={opt.hint}
            aria-pressed={active}
            className={cn(
              'h-7 rounded-[4px] px-3 text-[12px] transition-colors',
              active ? 'font-semibold text-gold-pale' : 'text-fg-muted hover:bg-hover hover:text-fg'
            )}
            style={active ? { background: 'rgba(201,162,39,.14)' } : undefined}
          >
            {opt.label}
          </button>
        )
      })}
    </div>
  )
}

/**
 * 该类别下拉里要列出的档位。
 *
 * 主体是 `targetsForCategory()` 的并集——**不能只列 `defaultTargetFor()` 那一档**：
 * 合法目标随源格式而变（`mkv` 转不了 `mkv`），根本不存在对所有源都合法的类别级默认值。
 * 真正生效的那个由主进程的 `resolveDefaultTarget()` 在入队时逐条裁决，
 * 下面那行小字就是在把这条无法避免的限制解释给用户听。
 *
 * 例外是磁盘上留着一个**现在已经不合法**的值（能力矩阵改动之后可能发生）：这时把它
 * 自己也列成一档。`<select>` 的 `value` 匹配不到任何 option 时渲染成空白，用户看到的
 * 是「这一行坏了」，无从知道该改选哪个——多列一档远好过一个空白下拉。
 */
function optionsFor(category: Category, current: string): string[] {
  const targets = targetsForCategory(category)
  return current.length > 0 && !targets.includes(current) ? [current, ...targets] : targets
}

/* ------------------------------------------------------------------ 页面 */

export function SettingsPage(): React.JSX.Element {
  const settings = useSettings((s) => s.settings)
  const update = useSettings((s) => s.update)
  const setCategoryTarget = useSettings((s) => s.setCategoryTarget)
  const pickOutputDir = useSettings((s) => s.pickOutputDir)
  const pickRenameDir = useSettings((s) => s.pickRenameDir)
  const removeRenameDir = useSettings((s) => s.removeRenameDir)
  const corruption = useSettings((s) => s.corruption)

  // 系统集成那一份。**不复用设置里那个 `contextMenu` 字段**：这里是「注册表里实际
  // 躺着什么」，那一个是「用户选了要什么」，两者会分叉，而开关必须以实际为准——
  // 绑设置的话，「写入失败」那种状态下开关会显示成已打开、而右键菜单根本不在。
  const integration = useIntegration((s) => s.state)
  const integrationBusy = useIntegration((s) => s.busy)
  const setIntegrationEnabled = useIntegration((s) => s.setEnabled)
  const setSendToEnabled = useIntegration((s) => s.setSendTo)

  // `App.tsx` 挂载时就调了 init()，正常路径上这里不会为空。兜底一是为了类型收窄，
  // 二是万一将来这一页被单独挂到别处，也不要当场崩。
  if (settings === null) {
    return <div className="px-6 py-5 text-[13px] text-fg-muted">{t('settings.loading')}</div>
  }

  // 生效模式由**两个字段一起**决定，判据必须与主进程的 `outputDirFor()` 一致：
  // 目录没设过时（outputDir 为 null），即使 outputBesideSource 是 false 也仍然写在
  // 源文件旁边。只看 outputBesideSource 的话，界面会显示「指定目录」却怎么也看不到路径。
  const outputDir = settings.outputDir
  const besideSource = settings.outputBesideSource || outputDir === null

  return (
    <div className="px-6 pt-5 pb-8">
      <header className="flex items-center gap-2.5">
        <Icon name="diamond" size={14} className="shrink-0 text-gold" />
        <h1 className="grad-gold-text font-display text-[23px] font-semibold tracking-[6px]">
          {t('settings.title')}
        </h1>
      </header>

      {/* 设置文件读不动时的告警。**放在最顶上、而不是塞进某一组下面**：
          它是「你上次改的那 12 项全没了」的解释，用户第一眼就得看到。
          ⚠️ 没有这一块的话，数据其实**是留档了的**（`.corrupt-<时间戳>`），
          但主进程只能 `console.error`，而打包后的 GUI 里那是没有出口的——
          审计把这条叫「数据那一半修好、界面那一半缺位」。 */}
      {corruption !== null && (
        <div className="mt-4 rounded-card border border-line-2 bg-abyss p-3">
          <p className="text-[12px] tracking-[0.5px] text-bad">{t('settings.corruption.title')}</p>
          <p className="mt-1 text-[11px] leading-relaxed text-fg-muted">
            {t('settings.corruption.file')}
            <span className="font-mono text-fg-faint">{corruption.file}</span>
            <br />
            {t('settings.corruption.reason')}
            {corruption.reason}
          </p>
          <p className="mt-1 text-[11px] leading-relaxed text-fg-faint">
            {corruption.quarantinePath === null
              ? t('settings.corruption.kept')
              : t('settings.corruption.quarantined', { path: corruption.quarantinePath })}
          </p>
        </div>
      )}

      {/*
        菱形节点分隔线（设计 7.3）。这里**照搬原型**的做法：外层 svg 只给
        `width:100% / height:12px`、不写 viewBox，由素材自带的 240×16 viewBox 去缩放。
        不加 `preserveAspectRatio="none"` —— 那会把中间那个菱形横向拉扁，而原型是
        设计师验收过的样子。id 一律由 `spriteIdFor()` 生成：手写 `#o-divider`
        一旦拼错就是渲染成空白，一声不响（见 `lib/icons.ts` 的说明）。
      */}
      <svg className="mt-2 h-3 w-full opacity-85" aria-hidden="true">
        <use href={`#${spriteIdFor('ornaments/divider.svg')}`} />
      </svg>

      {/* ------------------------------------------------------ 各类别默认目标 */}

      {/*
        ⚠️ 这是**唯一**能改语言的地方，放在最上面：它是这一页里唯一一个「值不同则整棵
        界面都不同」的设置项，埋在底下会让人以为这软件没有英文。
      */}
      <Section title={t('settings.language')} hint={t('settings.language.hint')}>
        <div>
          <Row label={t('settings.language')}>
            <select
              className="select-dark"
              value={settings.language}
              onChange={(e) => void update({ language: e.target.value as LocaleSetting })}
            >
              {LOCALES.map((one) => (
                <option key={one} value={one}>
                  {t(LANGUAGE_LABEL[one])}
                </option>
              ))}
            </select>
          </Row>
        </div>
      </Section>

      <Section title={t('settings.category.title')} hint={t('settings.category.hint')}>
        <div>
          {CATEGORIES.map((category) => {
            const current = settings.defaultTargets[category] ?? INHERIT
            return (
              <Row key={category} label={t(CATEGORY_LABEL[category])}>
                <select
                  className="select-dark"
                  value={current}
                  onChange={(e) => {
                    // 展开旧值那一步在 `setCategoryTarget` 里做，见那里的注释：
                    // 直接送 `{ defaultTargets: { video: 'mkv' } }` 会把其余五类抹掉。
                    const next = e.target.value
                    void setCategoryTarget(category, next === INHERIT ? null : next)
                  }}
                >
                  {/* 空值那一档表示「没有偏好」，不是「偏好是空」——提交时会把键删掉，
                      于是这个类别又回到 `defaultTargetFor()` 的内建偏好。 */}
                  <option value={INHERIT}>{t('settings.category.inherit')}</option>
                  {optionsFor(category, current).map((ext) => (
                    <option key={ext} value={ext}>
                      {ext}
                    </option>
                  ))}
                </select>
              </Row>
            )
          })}
        </div>
      </Section>

      {/* ---------------------------------------------------------- 输出目录 */}

      <Section title={t('settings.output.title')}>
        <div>
          <Row label={t('settings.output.where')}>
            <Segmented
              value={besideSource ? 'beside' : 'custom'}
              options={[
                { value: 'beside', label: t('settings.output.beside') },
                {
                  value: 'custom',
                  label: t('settings.output.custom'),
                  hint: outputDir ?? t('settings.output.unset')
                }
              ]}
              onChange={(next) => {
                if (next === 'beside') {
                  void update({ outputBesideSource: true })
                  return
                }
                if (outputDir === null) {
                  // 还没指定过目录时**必须弹框**，不能只把 outputBesideSource 置 false：
                  // `outputDirFor()` 拿不到目录时照样写回源文件旁边，界面看起来像没反应。
                  void pickOutputDir()
                  return
                }
                void update({ outputBesideSource: false })
              }}
            />
          </Row>

          {!besideSource && outputDir !== null && (
            <Row label={t('settings.output.dir')}>
              <div className="flex items-center gap-3">
                <span
                  className="min-w-0 truncate font-mono text-[12px] text-fg-muted"
                  title={outputDir}
                >
                  {outputDir}
                </span>
                <button
                  type="button"
                  className="btn-secondary shrink-0"
                  onClick={() => void pickOutputDir()}
                >
                  {t('settings.output.change')}
                </button>
              </div>
            </Row>
          )}
        </div>
      </Section>

      {/* ---------------------------------------------------------- 同名文件 */}

      <Section title={t('settings.conflict.title')}>
        <div>
          <Row label={t('settings.conflict.label')}>
            <Segmented
              value={settings.onConflict}
              options={CONFLICT_OPTIONS.map((opt) => ({
                value: opt.value,
                label: t(opt.label),
                hint: t(opt.hint)
              }))}
              onChange={(next) => void update({ onConflict: next })}
            />
          </Row>
        </div>
      </Section>

      {/* ---------------------------------------------------------- 并发上限 */}

      <Section title={t('settings.concurrency.title')} hint={t('settings.concurrency.hint')}>
        <div>
          <Row label={t('settings.concurrency.label')}>
            <select
              className="select-dark"
              value={String(settings.maxConcurrent)}
              onChange={(e) => void update({ maxConcurrent: Number(e.target.value) })}
            >
              {CONCURRENCY_CHOICES.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </Row>
        </div>
      </Section>

      {/* ------------------------------------------------------ 引擎未备时跳过 */}

      <Section title={t('settings.skip.title')} hint={t('settings.skip.hint')}>
        <div>
          <Row label={t('settings.skip.label')}>
            <label className="flex items-center gap-2.5 text-[13px] text-fg">
              <input
                type="checkbox"
                checked={settings.skipTasksNeedingDownload}
                onChange={(e) => void update({ skipTasksNeedingDownload: e.target.checked })}
                className="size-4 shrink-0"
                // 原生 checkbox 靠 accent-color 取金色。写成行内变量而不是
                // `accent-gold`：颜色的真相源是 theme.css 的 `--c-*`，不经过
                // Tailwind 桥接就少一处可能对不上的地方。
                style={{ accentColor: 'var(--c-gold)' }}
              />
              {t('settings.skip.checkbox')}
            </label>
          </Row>
        </div>
      </Section>

      {/* -------------------------------------------------------- GPU 硬件编码 */}

      <Section title={t('settings.gpu.title')} hint={t('settings.gpu.hint')}>
        <div>
          <Row label={t('settings.gpu.label')}>
            <label className="flex items-center gap-2.5 text-[13px] text-fg">
              <input
                type="checkbox"
                checked={settings.hardwareEncode}
                onChange={(e) => void update({ hardwareEncode: e.target.checked })}
                className="size-4 shrink-0"
                style={{ accentColor: 'var(--c-gold)' }}
              />
              {t('settings.gpu.checkbox')}
            </label>
          </Row>
        </div>
      </Section>

      {/* -------------------------------------------------- 转换完成之后做什么 */}

      <Section
        title={t('settings.after.title')}
        hint={
          // ⚠️ 四段分开取词后拼接，与迁移前那句字符串表达式**逐字节相同**——
          // 字典里也刻意分成四条键，理由见 `parts/settings.ts` 的文件头。
          t('settings.after.hint1') +
          t('settings.after.hint2') +
          t('settings.after.hint3') +
          t('settings.after.hint4')
        }
      >
        <div>
          <Row label={t('settings.after.label')}>
            <Segmented
              value={settings.afterConvert}
              options={AFTER_OPTIONS.map((opt) => ({
                value: opt.value,
                label: t(opt.label),
                hint: t(opt.hint)
              }))}
              onChange={(next) => void update({ afterConvert: next })}
            />
          </Row>
        </div>
      </Section>

      {/* -------------------------------------------------------- 系统集成（M8） */}

      {/* 只在 Windows 上出现：整个功能就是往 `HKCU\Software\Classes` 写一个动词，
          别的平台上连 reg.exe 都不存在，显示一个必定失败的开关只会制造困惑。 */}
      {window.api.platform === 'win32' && (
        <Section
          title={t('settings.integration.title')}
          hint={t('settings.integration.hint1') + t('settings.integration.hint2')}
        >
          <div>
            <Row label={t('settings.integration.menu')}>
              <label className="flex items-center gap-2.5 text-[13px] text-fg">
                <input
                  type="checkbox"
                  checked={integration?.enabled ?? false}
                  // 还没拉到状态、或正在写注册表时都不许点：前者会拿一个假值去写，
                  // 后者会发出两个 reg.exe 写同一个键，结果取决于谁先返回。
                  disabled={integration === null || integrationBusy}
                  onChange={(e) => void setIntegrationEnabled(e.target.checked)}
                  className="size-4 shrink-0"
                  style={{ accentColor: 'var(--c-gold)' }}
                />
                {t('settings.integration.menu.checkbox')}
              </label>

              {/* 这句话**必须留着**：用户看不到菜单时的第一反应是「这个功能是坏的」，
                  而这其实是 Windows 11 的行为——新版右键菜单默认不显示 `*\shell` 动词。
                  就为了绕开它，才有了下面那个「发送到」入口（一级菜单，不用按 Shift+F10）。 */}
              <p className="mt-2 text-[11px] leading-relaxed text-fg-muted">
                {t('settings.integration.menu.win11')}
              </p>

              {integration?.error != null && (
                <p className="mt-2 text-[11px] leading-relaxed text-red-400">
                  {t('settings.integration.error', { msg: integration.error })}
                </p>
              )}

              {/* 「设置里开着、注册表里没有」与「注册表里留着、设置已关」都必须说出来。
                  前者是「开关是开的，右键却没有菜单」（重装到别的目录、或被清理工具删过），
                  后者是卸载残留。两种状态在只显示一个布尔的界面上都表达不出来。 */}
              {integration?.error == null &&
                integration?.enabled === true &&
                !integration.installed && (
                  <p className="mt-2 text-[11px] leading-relaxed text-amber-400">
                    {t('settings.integration.mismatchOn')}
                  </p>
                )}
              {integration?.error == null &&
                integration?.enabled === false &&
                integration.installed && (
                  <p className="mt-2 text-[11px] leading-relaxed text-amber-400">
                    {t('settings.integration.mismatchOff')}
                  </p>
                )}

              {integration?.installed === true && integration.command !== null && (
                <p className="mt-2 break-all font-mono text-[10px] leading-relaxed text-fg-faint">
                  {integration.command}
                </p>
              )}
            </Row>

            <Row label={t('settings.sendTo.label')}>
              <label className="flex items-center gap-2.5 text-[13px] text-fg">
                <input
                  type="checkbox"
                  checked={integration?.sendToEnabled ?? false}
                  disabled={integration === null || integrationBusy}
                  onChange={(e) => void setSendToEnabled(e.target.checked)}
                  className="size-4 shrink-0"
                  style={{ accentColor: 'var(--c-gold)' }}
                />
                {t('settings.sendTo.checkbox')}
              </label>

              <p className="mt-2 text-[11px] leading-relaxed text-fg-muted">
                {t('settings.sendTo.note')}
              </p>

              {integration?.sendToError != null && (
                <p className="mt-2 text-[11px] leading-relaxed text-red-400">
                  {t('settings.sendTo.error', { msg: integration.sendToError })}
                </p>
              )}

              {/* 与右键菜单那两条同样的口径：意图与实际分叉时必须说出来 */}
              {integration?.sendToError == null &&
                integration?.sendToEnabled === true &&
                !integration.sendToInstalled && (
                  <p className="mt-2 text-[11px] leading-relaxed text-amber-400">
                    {t('settings.sendTo.mismatchOn')}
                  </p>
                )}
              {integration?.sendToError == null &&
                integration?.sendToEnabled === false &&
                integration?.sendToInstalled === true && (
                  <p className="mt-2 text-[11px] leading-relaxed text-amber-400">
                    {t('settings.sendTo.mismatchOff')}
                  </p>
                )}

              {integration != null && (
                <p className="mt-2 break-all font-mono text-[10px] leading-relaxed text-fg-faint">
                  {integration.sendToPath}
                </p>
              )}
            </Row>
          </div>
        </Section>
      )}

      {/* ------------------------------------------------ 重命名即转换（M8） */}

      {/* 与右键菜单不同，**这一段在哪个平台都显示**：它不写注册表、不依赖任何
          平台专有的东西（`fs.watch` 三边都有）。把它藏起来只会让换平台的人
          以为这个功能没了。 */}
      <Section
        title={t('settings.rename.title')}
        hint={
          // ⚠️ 与「转换完成之后」那一节同一条口径：四段分开取词后拼接，逐字节相同。
          t('settings.rename.hint1') +
          t('settings.rename.hint2') +
          t('settings.rename.hint3') +
          t('settings.rename.hint4')
        }
      >
        <div>
          <Row label={t('settings.rename.label')}>
            <label className="flex items-center gap-2.5 text-[13px] text-fg">
              <input
                type="checkbox"
                checked={settings?.renameConvert ?? false}
                disabled={settings === null}
                onChange={(e) => void update({ renameConvert: e.target.checked })}
                className="size-4 shrink-0"
                style={{ accentColor: 'var(--c-gold)' }}
              />
              {t('settings.rename.checkbox')}
            </label>
            <p className="mt-2 text-[11px] leading-relaxed text-fg-muted">
              {t('settings.rename.note')}
            </p>
            {/* 开关开着、目录却是空的，是一个看起来「已经开了」但什么都不发生的状态。
                这跟右键菜单那两条警告是同一类问题：意图与实际分叉了，界面必须说出来。 */}
            {settings?.renameConvert === true && settings.renameConvertDirs.length === 0 && (
              <p className="mt-2 text-[11px] leading-relaxed text-amber-400">
                {t('settings.rename.noDirs')}
              </p>
            )}
          </Row>

          <Row label={t('settings.rename.dirs')}>
            {settings === null ? null : settings.renameConvertDirs.length === 0 ? (
              <p className="text-[13px] text-fg-muted">{t('settings.rename.dirs.empty')}</p>
            ) : (
              <ul className="space-y-1.5">
                {/* key 用路径本身：同一个目录不会出现两次（主进程那边已经去重） */}
                {settings.renameConvertDirs.map((dir) => (
                  <li key={dir} className="flex items-center gap-3">
                    <span className="min-w-0 flex-1 break-all font-mono text-[11px] text-fg-muted">
                      {dir}
                    </span>
                    <button
                      type="button"
                      onClick={() => void removeRenameDir(dir)}
                      className="btn-secondary shrink-0"
                    >
                      {t('settings.rename.remove')}
                    </button>
                  </li>
                ))}
              </ul>
            )}

            <button
              type="button"
              disabled={settings === null}
              onClick={() => void pickRenameDir()}
              className="btn-secondary mt-3 disabled:opacity-50"
            >
              {t('settings.rename.addDir')}
            </button>
            <p className="mt-2 text-[11px] leading-relaxed text-fg-muted">
              {t('settings.rename.watchNote')}
            </p>
          </Row>
        </div>
      </Section>

      {/* 快捷键（E-7）。**不是配置项，是把判据摆出来给人看**——没有这一段，
          快捷键就只存在于「碰巧按到过」的人的脑子里。放在设置页而不是工作台页脚：
          页脚那一行已经有「一切转换，尽在本机之中」与「运行中 N / 上限 M」，
          再塞三条会把它挤成一团，而且工作台上真正需要的是**按钮上的 title**，
          那个已经加了。 */}
      <Section title={t('settings.shortcuts.title')} hint={t('settings.shortcuts.hint')}>
        <div className="rounded border border-line">
          {SHORTCUT_TABLE.map((item) => (
            <Row
              key={item.keys}
              label={
                <kbd className="rounded border border-line bg-canvas px-1.5 py-0.5 font-mono text-[11px] text-gold">
                  {item.keys}
                </kbd>
              }
            >
              <span className="text-[13px] text-fg-muted">{t(SHORTCUT_HELP[item.action])}</span>
            </Row>
          ))}
        </div>
      </Section>
    </div>
  )
}
