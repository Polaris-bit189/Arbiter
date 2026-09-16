/**
 * 反证脚本：把 M8 系统集成的代码逐个改坏，确认对应的断言真的会翻红。
 *
 *   node scripts/falsify-integration.mjs
 *
 * 为什么这个模块尤其需要反证：整条链路的失败方式**全都是静默的**。
 * 注册表写歪一处、命令行拼错一个引号、读回时解码用错码页——没有一处会抛异常，
 * 表现统一是「右键点了没反应」或者「菜单在，但转出来的东西不对」。
 * 断言写完不复核一遍，等于没写（这个项目已经因此抓到过四条装饰性断言）。
 *
 * 每个变异跑完立刻还原源码；任一变异「零红」即判定该条断言是装饰品，退出码非零。
 *
 * ⚠️ 这一份会**真的动注册表**（连跑十轮）。所有的删改都发生在被测代码自己算出来的
 * 键上，而它每一步都以「键为空」为前提，所以删错也删不掉有内容的键。见 test-integration.ts
 * 里那段说明。
 */
import { spawnSync } from 'child_process'
import { readFileSync, writeFileSync } from 'fs'

const CLI = 'src/main/core/cli.ts'
const INTEGRATION = 'src/main/core/integration.ts'
const RENAME_WATCH = 'src/main/core/renameWatch.ts'
const RENAME_WATCHER = 'src/main/core/renameWatcher.ts'
const SEND_TO = 'src/main/core/sendTo.ts'
const AFTER_ACTION = 'src/main/core/afterAction.ts'
const RERUN = 'src/main/core/rerun.ts'
const PRESET = 'src/renderer/src/lib/presetTarget.ts'
const FOLDER_SCAN = 'src/main/core/folderScan.ts'

/**
 * 每项：改坏哪个文件的哪一段、期望翻红的断言（只列必须红的）。
 *
 * 锚点一律用 `String.raw` 写：被测代码里全是 `\\Software` 这种双反斜杠，
 * 用普通字符串字面量写要再翻一倍，改一次错一次。
 *
 * 命中次数一定要打印出来。只说「没命中唯一一次」的话，0 次和 2 次根本分不清——
 * 而「锚点命中 2 次」正是上次踩过的坑：6 空格缩进的那一行是 10 空格同款行的子串。
 */
const MUTATIONS = [
  {
    file: CLI,
    name: '路径不 resolve 成绝对路径（约束 2 的入口）',
    // 锚点是**整条 return**：M9 之后它成了 `paths.map(...)` 的形状，
    // 只锚 `resolve(cwd, path as string)` 会命中 0 次（脚本会报「变异没生效」，
    // 但那要人多花一整轮去查）。
    // ⚠️ 尾部那个 ` }` 是 E-1 加上去的：`src/cli/main.ts` 的 `parseCliRequest()`
    // 里有**一模一样**的一行（它同样要 resolve），少锚这一层就会命中 2 次。
    // 两处的差别只在收尾——这边是 `to } }`（request 与对象一起收），
    // 那边是 `to }, json, out }`。
    from: String.raw`{ paths: paths.map((item) => resolve(cwd, item)), to } }`,
    to: String.raw`{ paths: paths.slice(), to } }`,
    expect: [
      '相对路径按 cwd 展开成绝对路径',
      '`-` 开头的文件名被 resolve 成绝对路径（否则会被引擎当成命令行选项）',
      '多条相对路径**逐条**按 cwd 展开（只 resolve 第一条是静默的半截修复）'
    ]
  },
  {
    // ★ M9「发送到」那条链路的命门：**多选时资源管理器会把所有选中项都追加到
    // 命令行末尾**。只收第一个的表现是「框选 10 个只转了 1 个，而且没有任何提示」——
    // 与约束 23 第 5 条（右键菜单的 %1 只认第一个）是同一件事的两个方向。
    file: CLI,
    name: '★ 多文件只收第一个（「发送到」框选 10 个只会转 1 个）',
    from: String.raw`      while (i + 1 < argv.length && !isFlag(argv[i + 1] as string)) {`,
    to: String.raw`      while (i + 1 < argv.length && !isFlag(argv[i + 1] as string) && took === 0) {`,
    expect: [
      '★ 多文件：--convert 后面的一串路径全部收下（「发送到」多选的落点）',
      '多文件 + 带空格 / 中文的路径原样收下（不经过 shell，不涉及引号解析）',
      '★ 文件串在下一个标志前收手（否则 `--to` 会被当成一个文件路径）',
      '多条相对路径**逐条**按 cwd 展开（只 resolve 第一条是静默的半截修复）'
    ]
  },
  {
    file: CLI,
    name: '引号前的连续反斜杠不翻倍',
    from: String.raw`backslashes * 2) + '"'`,
    to: String.raw`backslashes) + '"'`,
    expect: ['结尾反斜杠翻倍（不然会吃掉闭合引号）']
  },
  {
    file: CLI,
    name: '--to 的形状校验拿掉',
    // ⚠️ 这里**故意不用 `String.raw`**：下面那行返回值里有 `${value}`，
    // 而在模板字符串里那是**插值**，会被当成 JS 表达式求值（ReferenceError）。
    // 双引号普通字符串没有这个陷阱，代价只是把 `'` 转义一下。
    // ⚠️ 必须带上返回值那一行：`cli.ts` 里现在有**两处**同样的 `EXT_SHAPE` 判断
    // （`parseConvertRequest` 与 E-1 的 `parseCliRequest`），只锚 `if` 那一行会命中 2 次。
    // 两处的差别就在返回值：这边到 `}` 结束，那边多了 `, json }`。
    from: "      if (!EXT_SHAPE.test(ext)) {\n        return { kind: 'error', message: `目标格式不像个扩展名：${value}` }\n",
    to: "      if (false && !EXT_SHAPE.test(ext)) {\n        return { kind: 'error', message: `目标格式不像个扩展名：${value}` }\n",
    expect: ['--to 形状非法（含引号）→ error：它会被拼进注册表命令行']
  },
  {
    file: CLI,
    name: '打包/开发两种形态的判据反了',
    // ⚠️ 锚点必须带上上面那一行 `const parts = [quoteWindowsArg(options.exe)]`：
    // `cli.ts` 里现在**有两处**同样的 `if (!options.isPackaged) parts.push(...)`
    // （右键菜单那条 + δ 新增的发送到那条），只锚一行会命中 2 次，
    // 而脚本把「命中 2 次」报成「变异没生效，结论无效」——那不是通过。
    from: String.raw`  const parts = [quoteWindowsArg(options.exe)]
  if (!options.isPackaged) parts.push(quoteWindowsArg(options.appPath))`,
    to: String.raw`  const parts = [quoteWindowsArg(options.exe)]
  if (options.isPackaged) parts.push(quoteWindowsArg(options.appPath))`,
    expect: ['dev 形态补上仓库根（否则 electron 不知道要跑哪个应用）']
  },
  {
    // 这条复现的正是首跑翻车的那一版：假定「查默认值时值名那一列是空的」。
    // 中文系统上它叫 `(默认)`，于是所有 /ve 读回都是 null——菜单装上了、读不出命令行，
    // 自愈对比永远不成立。
    file: INTEGRATION,
    name: 'parseRegDefault 回到「值名必须为空」的写法',
    from: String.raw`    if (match) return match[2]`,
    to: String.raw`    if (match && match[1] === '') return match[2]`,
    expect: [
      '★ /ve 的值名是本地化的 `(默认)`，按类型标记取而不是按名字取',
      '★ command 键与 expectedCommand() 逐字一致（这条就是 Windows 将来要执行的那串）',
      '重复安装幂等，并把过期的 command 重写回 expected（自愈的那条路）'
    ]
  },
  {
    file: INTEGRATION,
    name: 'reg.exe 输出按 UTF-8 硬解（去掉 GB18030 兜底）',
    from: String.raw`      return new TextDecoder('gb18030').decode(buffer)`,
    to: String.raw`      return buffer.toString('utf8')`,
    expect: ['★ 中文 command 值经模块解码后一字不差（UTF-8 硬解会在这里变成乱码）']
  },
  {
    // 「点一下只转 10 个里选中的那个」的防线。没了它，多选时 %1 只替换出第一个路径，
    // 用户框选十个文件、得到一份产物，而且没有任何提示。
    file: INTEGRATION,
    name: '不写 MultiSelectModel（多选时不再隐藏本项）',
    from: String.raw`    ['add', root, '/v', 'MultiSelectModel', '/d', 'Single', '/f'],`,
    to: String.raw`    ['add', root, '/v', 'MultiSelectModelX', '/d', 'Single', '/f'],`,
    expect: ['MultiSelectModel=Single：多选时不显示本项（%1 只会给一个文件，否则会静默少干活）']
  },
  {
    // 把「键不存在」重新当成真错误。首跑就是栽在这儿：当时拿 stderr 里的本地化文案
    // 去认，而那段文本正是 GBK 解出来的乱码，于是「重复卸载」这条幂等路径整条失效。
    file: INTEGRATION,
    name: 'readContextMenu 把「键不存在」当错误',
    from: String.raw`    const error = query.code === -1 ? query.stderr || 'reg.exe 不可用' : null`,
    to: String.raw`    const error = query.code !== 0 ? query.stderr || 'reg.exe 不可用' : null`,
    expect: [
      '前置：起点确实是未注册（装了的话下面「装上了」那条断言就是空转）',
      '卸载没有报错',
      '重复卸载幂等（键不存在不算失败，也不该报错）',
      'syncContextMenu(false) 落到「未注册」'
    ]
  },
  {
    // ★★ D5（审计，2026-09-14）：`*\shell` 是多家软件共用的落脚处，`*` 下面是
    //    `OpenWithProgids` / `shellex`——**空也不该由我们删**。这个变异把上界放宽一格，
    //    于是 `*\shell` 进了候选列表。
    //
    //    ⚠️ 它**删不掉**任何东西：开发机上 `*\shell` 实测躺着迅雷的 `ThunderShell`，
    //    而「键为空才删」那道兜底会拦住。所以这条变异不会造成破坏——它只让**候选列表**
    //    变长。要挡的正是这个：那道兜底**自己也会坏**（下面 `≤ 1` 那条变异就是它坏掉的样子），
    //    两层同时坏就是 2026-09-13 真删掉别人菜单项的那次。
    file: INTEGRATION,
    name: '★★ 清理边界放宽一格，`*\\shell` 进了候选列表（D5）',
    from: String.raw`  const STOP = 'HKCU\\Software\\Classes\\*\\shell'`,
    to: String.raw`  const STOP = 'HKCU\\Software\\Classes\\*'`,
    expect: ['★★ 生产根键 → 清理列表是**空的**（`*\\shell` 与 `*` 一个都不动）']
  },
  {
    // ★ 这条是**真误删过别人菜单项**的那个 off-by-one，2026-09-13。
    // 原判据 `<= 1` 的理由是「空键会打出键名那一行」——实测**不会**：真正空的键只输出
    // 一个空行（0 个非空行），而「1 个非空行」恰恰是**恰好一个子键**的签名。
    // 代价：卸载我们自己的键之后，只剩下迅雷 `ThunderShell` 的 `*\shell` 被判成空、删掉。
    //
    // 承重的其实是 [3] 里那条纯函数断言（它不依赖这台机器上有什么）；下面三条是对着
    // **真实注册表**的连带证据，它们能红的前提是 `*\shell` 里除邻居之外**没有别人**——
    // 开发机上现在确实如此，但这层前提本身就不该被依赖，所以第一条才是主判据。
    file: INTEGRATION,
    name: '空键判据从「非空行数为 0」放宽成「≤ 1」',
    from: String.raw`  return stdout.split(/\r?\n/).filter((line) => line.trim() !== '').length === 0`,
    to: String.raw`  return stdout.split(/\r?\n/).filter((line) => line.trim() !== '').length <= 1`,
    expect: [
      '★ 恰好 1 个子键：同样只有 1 个非空行，但**绝不能**判成空（`≤ 1` 就是在这里翻的车）',
      // ⚠️ 只收**确定会红**的那几条。原来的三条「`*\shell` 里的邻居没被误伤」
      // 是**环境相关**的：它们只有在 `*\shell` 里除邻居之外**没有别人的条目**时才红
      // ——有的话逐层清理的判据压根不触发、断言就不红。2026-09-14 实测到过一次
      // 偶发失败（聚合里红、单跑绿），白烧一整轮还诱导人去放宽真正的断言。
      //
      // 「非空层必须收手」现在由 test-integration 里那条 ★★ 断言**确定地**守着：
      // 它验的是**我们自己控制的树**——`ArbiterM8SelfTest` 那一层里放了个守门键，
      // 删掉 `verb` 与中间的空层之后，清理必须停在那儿。
      '★★ 清理在非空的层前收手：我们自己那一层里的守门键原封不动'
    ]
  },

  /* ------------------------------------------ 重命名即转换（M8 的另一半） */

  {
    file: RENAME_WATCH,
    name: '体积判据拿掉（改名与「删一个、又下一个」不再区分）',
    from: String.raw`    if (from.size !== to.size) continue`,
    to: String.raw`    if (false) continue`,
    expect: ['★ 体积不等就不算改名 —— 挡的是「删掉 a.mkv、又从别处弄来个不相干的 a.mp4」']
  },
  {
    file: RENAME_WATCH,
    name: '同词干有歧义时不再放弃，随手取第一个',
    from: String.raw`    if (froms.length !== 1 || tos === undefined || tos.length !== 1) continue`,
    to: String.raw`    if (froms.length === 0 || tos === undefined) continue`,
    expect: [
      '★ 出现的那一侧有两个候选就不猜（a.mkv → a.mp4 与 a.webm 同时出现）',
      '★ 消失的那一侧有两个候选也不猜（a.mkv 与 a.avi 同时消失）'
    ]
  },
  {
    file: RENAME_WATCH,
    name: '类别白名单拿掉（文档 / 电子书 / 压缩包也参与重命名）',
    from: String.raw`  if (!RENAME_CATEGORIES.includes(from) || !RENAME_CATEGORIES.includes(to)) return false`,
    to: String.raw`  if (from === null || to === null) return false`,
    expect: [
      '★ 图片 → PDF 也不做（矩阵放行、不用下载，只有类别判据挡得住）',
      '★ 压缩包不在三类里（zip → 7z）',
      '★ 压缩包改扩展名（zip → 7z）在 diff 这一层就被挡掉（类别判据不是只挡 renameConvertible）'
    ]
  },
  {
    file: RENAME_WATCH,
    name: '`.part` 临时名不再从快照里剔掉',
    from: String.raw`  return !PART_NAME.test(name)`,
    to: String.raw`  return true`,
    expect: ['我们自己写出的 `.part.<ext>` 不进快照（否则每次转换都会自我触发）']
  },
  {
    // ★ 这条打的是整个功能最容易出的那个 bug：处理完自己那一次改名之后不刷新基线，
    //   于是「改回原名」在下一轮里看起来正好是一次反向改名，来回震荡。
    file: RENAME_WATCHER,
    name: '★ 自己改完名字之后不重建基线（反向自我触发）',
    from: String.raw`    await this.refreshBaseline(dir)

    let outcome: EnqueueOutcome`,
    to: String.raw`    let outcome: EnqueueOutcome`,
    expect: ['★ 处理完之后立刻再扫一遍：不会自我触发（基线吸收了那次改回来）']
  },
  {
    file: RENAME_WATCHER,
    name: '入队被拒时不回滚文件名（改了人家的名字还什么都不换）',
    from: String.raw`    if (!outcome.ok) {`,
    to: String.raw`    if (false && !outcome.ok) {`,
    expect: [
      '★ 被拒时把文件名还给用户（不能一边不给转换、一边改了他的名字）',
      '★ 被拒时原名不再占着（还回去了就别留半个）',
      '被拒时告警，且带着拒收的理由（用户得知道名字为什么变回来了）',
      '被拒不算成功，不发成功通知'
    ]
  },

  /* ------------------------------------- 「发送到」（M9）：快捷方式的自愈 */

  {
    // 自愈的判据是「读回来的 target/args 与当前 exe 算出来的那份一致吗」。
    // 恒真 = 换了安装目录 / 被清理工具改过之后**再也不修**，而留下的那个 .lnk
    // 指向一个已经不存在的 exe：菜单项还在、点了什么都不发生（与注册表那边同类）。
    file: SEND_TO,
    name: '★ 快捷方式的自愈比对恒真（指向旧 exe 的 .lnk 永远不修）',
    from: String.raw`  if (a === null) return false
  return a.target === b.target && normalizeArgs(a.args) === normalizeArgs(b.args)`,
    to: String.raw`  return true`,
    expect: ['★ 自愈把指向旧 exe 的快捷方式重写成当前 exe（不修的话点了会拉起一个不存在的程序）']
  },

  /* ------------------------- 转换完成之后的动作（M9）：默认档必须一次 IO 都不做 */

  {
    // 默认档（什么都不做）的那一次提前返回，是整个功能唯一的「零副作用」保证。
    // 拿掉它，`runAfterAction` 会继续往下走到 sizeOf / 剪贴板那一层——
    // 用户没开过这个功能，剪贴板却被动了，而且没有任何提示。
    file: AFTER_ACTION,
    name: '★ 「什么都不做」那一档不再提前返回（默认设置下也开始动剪贴板）',
    from: String.raw`  if (requested === 'none') {`,
    to: String.raw`  if (false) {`,
    expect: ['★ 默认档：整条链路一次 IO 都没做（连 stat 都没有）']
  },

  /* ------------------------------- 重跑（M9）：有同名产物时必须先问一次 */

  {
    // 这是全项目唯一会覆盖用户已有产物的入口。预检没了，重跑会直接入队，
    // 而「覆盖还是另存」就由**设置的全局那一档**默默决定了——
    // 用户点的是「重跑」，磁盘上少的可能是他另一个文件。
    file: RERUN,
    name: '★ 重跑不再预检同名产物（唯一会覆盖用户产物的入口失守）',
    from: String.raw`    if (options.conflict === null) {`,
    to: String.raw`    if (false) {`,
    expect: ['★ 有同名产物且用户还没选时：**一条都不入队**，把冲突交回去']
  },

  /* ------------------------- 「上次这类文件转成了什么」（M9）：预置不是乱来 */

  {
    // 预置是「替用户填一个默认值」，它**必须**过能力矩阵：历史里那条 `mp4 → mkv`
    // 对现在拖进来的 `.mkv` 是非法的（不能转成自己），照抄会造出一个不可能成功的任务。
    file: PRESET,
    name: '★ 预置不过能力矩阵（把不支持的格式替用户填进去）',
    from: String.raw`  if (!targetsFor(input.fromExt).includes(recent.toExt)) {`,
    to: String.raw`  if (false) {`,
    expect: ['★ 历史里那一档对这个源格式不合法时回落到默认（mkv 不能转 mkv）']
  },

  /* ----------------------------- 文件夹递归（E-4）：异步、可取消、有上限 */

  {
    // ★ 这条复现的正是 `docs/PLAN.md` §9.1 说的那个原始形态：**同步遍历**。
    // 一行 `readdirSync` 就能把递归写完，而它把整棵树压进**一个 macrotask**——
    // 期间定时器一次都不触发（实测这一棵要 80 ms）、用户点的取消排不上队，
    // 主进程是唯一真相源，它一卡整个应用连取消都点不动。
    //
    // 用 `require('node:fs')` 而不是加一行 import：变异只有一次替换的机会，
    // 而 tsx 在这个仓库（CJS）下 require 是可用的（实测）。
    //
    // ⚠️ **锚点必须同时罩住 I/O 与那个显式让出函数。这是实跑踩出来的**：
    // 第一版只把 `listDir` 改成同步，两条断言都没红——`realpath` 还是异步的，
    // 每个目录一次真 I/O；第二版把两个 I/O 都改同步，**仍然**没红——每 128 个条目
    // 一次 `setImmediate` 还在让出。这两条防线是**冗余**的，只坏一条界面照样响应，
    // 断言不红是**正确**的；要复现「整棵树压进一个 macrotask」必须两条一起废掉。
    // （`docs/NOTES.md` 那条「改一半的变异会伪装成断言是装饰」的原样重演。）
    file: FOLDER_SCAN,
    name: '★ I/O 与显式让出全改同步（整棵树压进一个 macrotask）',
    from: String.raw`  listDir: (dir) => readdir(dir, { withFileTypes: true }),
  realpath: (path) => realpath(path)
}

/** 回到 macrotask 队列一次。为什么用 setImmediate 而不是 setTimeout(…, 0)：见文件头。 */
function yieldToLoop(): Promise<void> {
  return new Promise<void>((done) => setImmediate(done))
}`,
    // ⚠️ 同步版要**包一层 `Promise.resolve`**，不能直接返回数组/字符串：
    // 调用点有一句 `io.realpath(dir).catch(…)`，直接返回字符串会在那里抛
    // 「.catch is not a function」，整条套件半路崩掉（不打汇总行），
    // 反证脚本看到的是「一条都没红」——**假红与假绿一样能骗掉一轮**。
    // 包成已 resolve 的 promise 之后 `await` 只排一个微任务，仍然不回到
    // macrotask 队列，这才是「压进一个 macrotask」的准确复现。
    to: String.raw`  listDir: (dir) => Promise.resolve(require('node:fs').readdirSync(dir, { withFileTypes: true })),
  realpath: (path) => Promise.resolve(require('node:fs').realpathSync(path))
}

/** 回到 macrotask 队列一次。为什么用 setImmediate 而不是 setTimeout(…, 0)：见文件头。 */
function yieldToLoop(): Promise<void> {
  return Promise.resolve()
}`,
    expect: [
      '★ 扫描期间事件循环没被堵：10ms 定时器与 setImmediate 都在转',
      '★ 扫到一半取消：取消真的落在了扫描中间，且不留半个状态'
    ]
  },
  {
    // 成环：junction 指回祖先时，判据是「这个 realpath 已经进过」。去掉它，
    // 扫描会顺着环一层层走下去（撞上路径长度上限或条数上限才停），
    // 同一批文件被收进来一遍又一遍——不报错，只是一份重复的清单。
    file: FOLDER_SCAN,
    name: '★ 符号链接成环的判据拿掉',
    from: String.raw`    if (seen.has(real)) {`,
    to: String.raw`    if (false) {`,
    expect: ['★ 符号链接成环被自己挡下：不重复扫、也不无限递归（文件数仍是 5 且无重复）']
  },
  {
    // 上限拿掉：本来是「到顶就停、并把 truncated 一路带回界面上」，
    // 现在会一路扫完（这里只有 5 个文件，所以断言看的正是条数与那句「还有没扫到的」）。
    file: FOLDER_SCAN,
    name: '★ 条数上限失效（报告里不再说「还有没扫到的」）',
    from: String.raw`        if (files.length >= limit) {`,
    to: String.raw`        if (false) {`,
    expect: ['★ 超过条数上限时明说还有没扫到的（不是静默截断）']
  },
  {
    // 排除清单里最要紧的那一条（node_modules）。它坏了的表现是「用户选了一个
    // 装着项目的目录，界面卡住几十秒，然后收进来几千张依赖里的图片」。
    file: FOLDER_SCAN,
    name: '★ 名字排除清单失效（node_modules 照样往下扫）',
    from: String.raw`  if (rules.names.some((item) => item.toLowerCase() === lower)) {`,
    to: String.raw`  if (false) {`,
    expect: [
      '★ node_modules 按名字命中排除清单，未扫描',
      '递归收下嵌套层的文件（顶层 2 + 嵌套 3 = 5），认不出的扩展名不进结果',
      '只读了 3 个目录：排除项、成环的那条、读不了的都没有被走下去'
    ]
  },
  {
    // 取消钩子被忽略 = 「点了取消，扫描照样跑完，而且把文件都收进来」。
    // 这条路上没有第二个观测点：取消是唯一能打断一次长扫描的东西。
    file: FOLDER_SCAN,
    name: '★ 取消钩子被忽略（点了取消也照样扫完）',
    from: String.raw`  const shouldCancel = options.shouldCancel ?? ((): boolean => false)`,
    to: String.raw`  const shouldCancel = ((): boolean => false)`,
    expect: [
      '★ 扫到一半取消：取消真的落在了扫描中间，且不留半个状态',
      '取消掉的报告不可能被入队（确认与入队都拿不到清单）'
    ]
  }
]

/* ------------------------------------------------------- 锚点自检
 * `--anchors-only` 时**只**数锚点命中次数：不跑基线、不跑任何测试、不改任何源码、
 * 不做任何还原、也不碰 git。全过 exit 0，有锚点命不中 exit 1（逐条打印
 * 「脚本 / 变异名 / 命中次数 / 期望次数」）。
 *
 * 这一支尤其需要：它跑一轮会**真动注册表**（连跑十轮），而锚点过期时白等的代价
 * 不止时间。见 scripts/lib/anchors.mjs 的文件头。
 */
if (process.argv.slice(2).includes('--anchors-only')) {
  const { anchorsOnlyGuard } = await import('./lib/anchors.mjs')
  // 这一支没有 `--only`、也没有 `toLf`，锚点一律在原文上数（与正文逐字一致）
  anchorsOnlyGuard(MUTATIONS)
}

const TS = 'tsconfig.test.json'

function runTests() {
  const out = spawnSync('npx', ['tsx', '--tsconfig', TS, 'scripts/test-integration.ts'], {
    encoding: 'utf8',
    shell: true
  })
  const text = out.stdout + out.stderr
  const reds = text
    .split(/\r?\n/)
    .filter((line) => line.includes('✗'))
    .map((line) =>
      line
        .replace(/.*✗\s*/, '')
        .replace(/\s+←.*$/, '')
        .trim()
    )
  const counts = /通过 (\d+) \/ 失败 (\d+) \/ 跳过 (\d+)/.exec(text)
  return {
    reds,
    passed: counts ? Number(counts[1]) : -1,
    failed: counts ? Number(counts[2]) : -1,
    skipped: counts ? Number(counts[3]) : -1
  }
}

const baseline = runTests()
console.log(`基线：通过 ${baseline.passed} / 失败 ${baseline.failed} / 跳过 ${baseline.skipped}`)
if (baseline.passed < 0) {
  console.error('没读到测试的汇总行，测试本身可能崩了。先单独跑一次看输出。')
  process.exit(1)
}
if (baseline.failed !== 0) {
  console.error('基线就不是全绿，先修好再来反证。')
  process.exit(1)
}

/** 原文件内容，按路径缓存。跑完据此逐字还原并核对 */
const originals = new Map()
for (const file of new Set(MUTATIONS.map((m) => m.file))) {
  originals.set(file, readFileSync(file, 'utf8'))
}

let problems = 0

for (const m of MUTATIONS) {
  const original = originals.get(m.file)
  const hits = original.split(m.from).length - 1
  if (hits !== 1) {
    console.error(`\n[${m.name}] 锚点命中 ${hits} 次，期望 1 次 —— 变异没生效，结论无效`)
    problems += 1
    continue
  }

  writeFileSync(m.file, original.replace(m.from, m.to), 'utf8')
  const result = runTests()
  writeFileSync(m.file, original, 'utf8')

  const missed = m.expect.filter((label) => !result.reds.includes(label))
  const extra = result.reds.filter((label) => !m.expect.includes(label))

  if (missed.length === 0) {
    console.log(`\n[${m.name}] 翻红 ${result.reds.length} 条，期望的都在`)
    for (const label of result.reds) {
      console.log(`    - ${label}${extra.includes(label) ? '   (顺带)' : ''}`)
    }
  } else {
    problems += 1
    console.log(`\n[${m.name}] 有断言没红 —— 它们抓不住这个错误：`)
    for (const label of missed) console.log(`    ! ${label}`)
    console.log(`  实际翻红：${result.reds.join(' | ') || '（一条都没红）'}`)
  }
}

// 收尾再确认源码确实还原了。**这一步不能省**：反证跑着的时候磁盘上的源码就是坏的，
// 这个窗口期内任何测试结论都不作数，而「还原失败」会静默地把一个坏文件留在工作区里。
for (const [file, original] of originals) {
  if (readFileSync(file, 'utf8') !== original) {
    console.error('\n源码没还原干净，请检查 ' + file)
    process.exit(1)
  }
}

console.log(
  problems === 0
    ? '\n反证通过：每个变异都被对应的断言抓住了，且源码已还原。'
    : `\n反证不通过：${problems} 处有问题。`
)
process.exit(problems === 0 ? 0 : 1)
