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

const CONFLICT_OPTIONS: ReadonlyArray<{
  value: Settings['onConflict']
  label: string
  hint: string
}> = [
  { value: 'rename', label: '另起一名', hint: '同名文件保留，新产物自动加序号' },
  { value: 'overwrite', label: '取而代之', hint: '直接覆盖同名文件，旧产物不再保留' },
  { value: 'skip', label: '略过', hint: '同名文件已存在时不再转换' }
]

/** 并发上限的可选范围。16 是 `settingsPatchSchema` 的上界，两处必须一致 */
const CONCURRENCY_CHOICES = Array.from({ length: 16 }, (_, i) => i + 1)

/**
 * 「转换完成之后」。**第一档必须是「什么都不做」，而且默认就是它**——
 * 自动往剪贴板里写会覆盖用户手里的内容，且事后极难归因（见 `DEFAULT_AFTER_CONVERT`）。
 */
const AFTER_OPTIONS: ReadonlyArray<{
  value: Settings['afterConvert']
  label: string
  hint: string
}> = [
  { value: 'none', label: '什么都不做', hint: '默认：不动你的剪贴板' },
  { value: 'copy-path', label: '复制路径', hint: '把产物的完整路径放进剪贴板' },
  {
    value: 'copy-file',
    label: '复制产物本身',
    hint: '把文件放进剪贴板，可以直接粘到别处；产物偏大时会改成复制路径并说明'
  },
  { value: 'open-folder', label: '打开目录', hint: '在资源管理器里打开并选中产物' }
]

/**
 * 快捷键的文案（E-7）。**键位不在这里**——那张表在 `lib/shortcuts.ts` 里，
 * 紧挨着判据放，测试才有办法拿它去喂 `resolveShortcut`（见那边的 `SHORTCUT_TABLE`）。
 *
 * 类型写成 `Record<ShortcutAction, string>`：将来加第四个快捷键而忘了写文案，
 * 是**编译错误**，不是界面上一片空白。
 */
const SHORTCUT_HELP: Record<ShortcutAction, string> = {
  'pick-files': '收入文件（同「收入文件」按钮）',
  start: '开始调律（队列里有待跑的才有用）',
  'cancel-running': '取消正在跑的转换——源文件一个字节都不动，随时可以重跑'
}

/* ------------------------------------------------------------------ 零件 */

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
    return <div className="px-6 py-5 text-[13px] text-fg-muted">正在读取设置…</div>
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
          格式设置
        </h1>
      </header>

      {/* 设置文件读不动时的告警。**放在最顶上、而不是塞进某一组下面**：
          它是「你上次改的那 12 项全没了」的解释，用户第一眼就得看到。
          ⚠️ 没有这一块的话，数据其实**是留档了的**（`.corrupt-<时间戳>`），
          但主进程只能 `console.error`，而打包后的 GUI 里那是没有出口的——
          审计把这条叫「数据那一半修好、界面那一半缺位」。 */}
      {corruption !== null && (
        <div className="mt-4 rounded-card border border-line-2 bg-abyss p-3">
          <p className="text-[12px] tracking-[0.5px] text-bad">设置文件读不动，已重置为默认值</p>
          <p className="mt-1 text-[11px] leading-relaxed text-fg-muted">
            出错的文件：<span className="font-mono text-fg-faint">{corruption.file}</span>
            <br />
            原因：{corruption.reason}
          </p>
          <p className="mt-1 text-[11px] leading-relaxed text-fg-faint">
            {corruption.quarantinePath === null
              ? '原文件仍在原地（改名留档失败了），但内容没有被覆盖——先把它拷出来再改设置，否则下一次写盘会覆盖它。'
              : `原文件已留档到 ${corruption.quarantinePath}，内容一个字节都没被动过。`}
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

      <Section title="各类别默认目标" hint="源格式不支持时会自动改用该格式的默认目标">
        <div>
          {CATEGORIES.map((category) => {
            const current = settings.defaultTargets[category] ?? INHERIT
            return (
              <Row key={category} label={CATEGORY_LABEL[category]}>
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
                  <option value={INHERIT}>随源格式而定</option>
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

      <Section title="输出目录">
        <div>
          <Row label="写入何处">
            <Segmented
              value={besideSource ? 'beside' : 'custom'}
              options={[
                { value: 'beside', label: '源文件所在目录' },
                { value: 'custom', label: '指定目录', hint: outputDir ?? '尚未指定' }
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
            <Row label="目录">
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
                  更改
                </button>
              </div>
            </Row>
          )}
        </div>
      </Section>

      {/* ---------------------------------------------------------- 同名文件 */}

      <Section title="同名文件">
        <div>
          <Row label="已存在时">
            <Segmented
              value={settings.onConflict}
              options={CONFLICT_OPTIONS}
              onChange={(next) => void update({ onConflict: next })}
            />
          </Row>
        </div>
      </Section>

      {/* ---------------------------------------------------------- 并发上限 */}

      <Section title="并发上限" hint="同时最多调律几个任务。越大越吃 CPU，界面也越容易卡。">
        <div>
          <Row label="同时最多">
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

      <Section
        title="引擎未备时跳过"
        hint="引擎尚未备妥的文件不会先排进队列干等，直接略过——之后补好引擎再拖一次即可。"
      >
        <div>
          <Row label="引擎未备">
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
              引擎未备时跳过
            </label>
          </Row>
        </div>
      </Section>

      {/* -------------------------------------------------------- GPU 硬件编码 */}

      <Section
        title="GPU 硬件编码"
        hint="用 NVIDIA 显卡编码视频，速度优先。只在难编的素材上是净赚（实测同规格下 3.89s → 2.89s），好编的素材反而更慢（1.77s → 2.16s），所以默认不开。没卡或驱动不支持时会自动改用 CPU。"
      >
        <div>
          <Row label="硬件编码">
            <label className="flex items-center gap-2.5 text-[13px] text-fg">
              <input
                type="checkbox"
                checked={settings.hardwareEncode}
                onChange={(e) => void update({ hardwareEncode: e.target.checked })}
                className="size-4 shrink-0"
                style={{ accentColor: 'var(--c-gold)' }}
              />
              速度优先（GPU）
            </label>
          </Row>
        </div>
      </Section>

      {/* -------------------------------------------------- 转换完成之后做什么 */}

      <Section
        title="转换完成之后"
        hint={
          '省掉「去文件夹里找」那一步：转换完成后直接把它送到手边。' +
          '⚠️ 只有 1 个文件转完时才会自动做这件事——一次转几十个的时候剪贴板只有一个格子，' +
          '我们无从知道你要的是哪一个，那种情况下请用卡片上的按钮逐个点。' +
          '⚠️ 剪贴板随时会被别的程序接管，所以复制之后会留一条回执，写着复制的是什么，并给你一次「再复制一次」。'
        }
      >
        <div>
          <Row label="完成后">
            <Segmented
              value={settings.afterConvert}
              options={AFTER_OPTIONS}
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
          title="系统集成"
          hint={
            '两个入口都是「把文件交给转换器，不用先打开应用」，做的是同一件事，可以各开各的。' +
            '两者都只在当前用户下生效，都不需要管理员。'
          }
        >
          <div>
            <Row label="右键菜单">
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
                在资源管理器里加一项「用调律者转换」
              </label>

              {/* 这句话**必须留着**：用户看不到菜单时的第一反应是「这个功能是坏的」，
                  而这其实是 Windows 11 的行为——新版右键菜单默认不显示 `*\shell` 动词。
                  就为了绕开它，才有了下面那个「发送到」入口（一级菜单，不用按 Shift+F10）。 */}
              <p className="mt-2 text-[11px] leading-relaxed text-fg-muted">
                ⚠️ Windows 11 的新版右键菜单默认不显示这一类菜单项，要按 Shift+F10
                或点「显示更多选项」才看得到——这是系统行为，不是没装成功。
              </p>

              {integration?.error != null && (
                <p className="mt-2 text-[11px] leading-relaxed text-red-400">
                  注册表操作失败：{integration.error}
                </p>
              )}

              {/* 「设置里开着、注册表里没有」与「注册表里留着、设置已关」都必须说出来。
                  前者是「开关是开的，右键却没有菜单」（重装到别的目录、或被清理工具删过），
                  后者是卸载残留。两种状态在只显示一个布尔的界面上都表达不出来。 */}
              {integration?.error == null &&
                integration?.enabled === true &&
                !integration.installed && (
                  <p className="mt-2 text-[11px] leading-relaxed text-amber-400">
                    设置里开着，但注册表里没有这一项。重新开关一次即可补上。
                  </p>
                )}
              {integration?.error == null &&
                integration?.enabled === false &&
                integration.installed && (
                  <p className="mt-2 text-[11px] leading-relaxed text-amber-400">
                    注册表里还留着这一项（设置里已是关闭）。重新开关一次即可清掉。
                  </p>
                )}

              {integration?.installed === true && integration.command !== null && (
                <p className="mt-2 break-all font-mono text-[10px] leading-relaxed text-fg-faint">
                  {integration.command}
                </p>
              )}
            </Row>

            <Row label="发送到">
              <label className="flex items-center gap-2.5 text-[13px] text-fg">
                <input
                  type="checkbox"
                  checked={integration?.sendToEnabled ?? false}
                  disabled={integration === null || integrationBusy}
                  onChange={(e) => void setSendToEnabled(e.target.checked)}
                  className="size-4 shrink-0"
                  style={{ accentColor: 'var(--c-gold)' }}
                />
                在「发送到」菜单里加一项
              </label>

              <p className="mt-2 text-[11px] leading-relaxed text-fg-muted">
                右键 →「发送到」是一级菜单，比上面那一项少两步，也不用教用户按 Shift+F10。
                它不写注册表，只在你的「发送到」文件夹里放一个快捷方式，关掉开关或卸载时删掉。
                多选时会一次把它们全部收进队列，而右键菜单那一项只认得第一个文件。
              </p>

              {integration?.sendToError != null && (
                <p className="mt-2 text-[11px] leading-relaxed text-red-400">
                  快捷方式操作失败：{integration.sendToError}
                </p>
              )}

              {/* 与右键菜单那两条同样的口径：意图与实际分叉时必须说出来 */}
              {integration?.sendToError == null &&
                integration?.sendToEnabled === true &&
                !integration.sendToInstalled && (
                  <p className="mt-2 text-[11px] leading-relaxed text-amber-400">
                    设置里开着，但那个快捷方式不在。重新开关一次即可补上。
                  </p>
                )}
              {integration?.sendToError == null &&
                integration?.sendToEnabled === false &&
                integration?.sendToInstalled === true && (
                  <p className="mt-2 text-[11px] leading-relaxed text-amber-400">
                    「发送到」里还留着那个快捷方式（设置里已是关闭）。重新开关一次即可清掉。
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
        title="重命名即转换"
        hint={
          '在下面这些文件夹里，把 a.mkv 改名成 a.mp4，就自动按 mp4 重转一遍——' +
          '相当于用改名表达「我要这个格式」。只认视频 / 音频 / 图片三类，' +
          '且源与目标都必须是能力矩阵里真有的组合。' +
          '⚠️ 源文件不会被删：它会被改回原来的名字原样留着，你随时能反悔。'
        }
      >
        <div>
          <Row label="开关">
            <label className="flex items-center gap-2.5 text-[13px] text-fg">
              <input
                type="checkbox"
                checked={settings?.renameConvert ?? false}
                disabled={settings === null}
                onChange={(e) => void update({ renameConvert: e.target.checked })}
                className="size-4 shrink-0"
                style={{ accentColor: 'var(--c-gold)' }}
              />
              在下面的文件夹里，改扩展名就等于要求转换
            </label>
            <p className="mt-2 text-[11px] leading-relaxed text-fg-muted">
              默认关闭。关着的时候我们不装任何目录监听，对你的磁盘完全无感。
            </p>
            {/* 开关开着、目录却是空的，是一个看起来「已经开了」但什么都不发生的状态。
                这跟右键菜单那两条警告是同一类问题：意图与实际分叉了，界面必须说出来。 */}
            {settings?.renameConvert === true && settings.renameConvertDirs.length === 0 && (
              <p className="mt-2 text-[11px] leading-relaxed text-amber-400">
                开关是打开的，但一个文件夹都没选——现在还什么都不会发生。请在下面加一个。
              </p>
            )}
          </Row>

          <Row label="文件夹">
            {settings === null ? null : settings.renameConvertDirs.length === 0 ? (
              <p className="text-[13px] text-fg-muted">还没有选择文件夹</p>
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
                      移除
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
              添加文件夹…
            </button>
            <p className="mt-2 text-[11px] leading-relaxed text-fg-muted">
              只监听这一层，不递归子文件夹。删除一个文件夹条目只是不再监听它，
              不会碰里面的任何文件。
            </p>
          </Row>
        </div>
      </Section>

      {/* 快捷键（E-7）。**不是配置项，是把判据摆出来给人看**——没有这一段，
          快捷键就只存在于「碰巧按到过」的人的脑子里。放在设置页而不是工作台页脚：
          页脚那一行已经有「一切转换，尽在本机之中」与「运行中 N / 上限 M」，
          再塞三条会把它挤成一团，而且工作台上真正需要的是**按钮上的 title**，
          那个已经加了。 */}
      <Section
        title="快捷键"
        hint="只在工作台生效。焦点在输入框里时 Enter 归输入框——用拼音选词的那一下回车不会启动队列。"
      >
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
              <span className="text-[13px] text-fg-muted">{SHORTCUT_HELP[item.action]}</span>
            </Row>
          ))}
        </div>
      </Section>
    </div>
  )
}
