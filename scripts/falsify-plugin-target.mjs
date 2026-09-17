/**
 * 反证：把插件「找应用」那几步逐处改坏，确认 `scripts/test-plugin-target.mjs` 的断言
 * 真的会翻红。
 *
 *   node scripts/falsify-plugin-target.mjs
 *   npm run falsify:plugin-target
 *   node scripts/falsify-plugin-target.mjs --only=次序      # 只跑名字命中的变异
 *
 * 被测的只有 `plugins/arbiter/mcp/target.mjs` 一个文件，判据是纯逻辑 + 一次临时键往返，
 * 一轮下来是秒级的——进 `npm run falsify` 的聚合没有任何负担。
 *
 * ## 这个清单是被**审计**逼出来的（2026-09-17）
 *
 * 第一版只有 6 个变异，审计用 16 个变异扫了一遍，点出 7 个「改了它、一个都不会红」的
 * 支柱，其中一条是**能让这次修复原样复活而套件全绿**的：
 *
 * - **`/s`（递归子键）**：测试注入的键形状与生产不一致（叶子键 vs 父键），所以那个开关
 *   拿掉都看不见。修法是让测试注入**父键 + `{GUID}` 子键**（生产形态），下面的变异
 *   「`/s` 拿掉」就是它的守卫。**注入形状再退回叶子键，这条变异会立刻变成装饰。**
 * - `DisplayIcon` / `UninstallString` 的**优先级**、`.exe` 结尾判据、`probe()` 的
 *   `usable === false`、三个**标准安装位置**、`decodeRegOutput` 的**严格 UTF-8** 那一步、
 *   `ARBITER_HOME` 的短路——同样都没有任何东西盯着。
 *
 * ⚠️ 两个机制上的坑（审计实测出来的，已修）：
 *
 * - **`expect: []` 会被静默放行。** `missed = expect.filter(...)` 在空清单上恒空，
 *   于是「任何断言都没红」被报成「期望的都在」。现在空清单必须显式写 `diagnostic: true`。
 * - **套件崩了会被报成「有断言没红」**，方向正好指反（真相是它抓住了这个变异——直接崩），
 *   会诱人去放宽断言。现在 `failed < 0`（没解析到汇总行）单独报「套件崩了」。
 */
import { spawnSync } from 'child_process'
import { readFileSync, writeFileSync } from 'fs'
import { resolve } from 'path'

const TARGET = resolve('plugins/arbiter/mcp/target.mjs')

const MUTATIONS = [
  {
    // `/f` 是子串匹配，`Arbiter Beta`、`Arbiter 插件` 这类邻居条目会一起被捞出来，
    // 然后我们就会去 probe 一个**别人的**目录。
    name: 'DisplayName 的过滤拿掉（别人家的条目也认）',
    from: "    if (displayName === 'Arbiter') {\n",
    to: '    if (true) {\n',
    expect: ['DisplayName 是「Arbiter Beta」时不认（`/f` 是子串匹配）', '没有 DisplayName 时不认']
  },
  {
    // 卸载命令是「带引号的路径 + 参数」，而路径里可能有空格（`C:\Program Files\`）。
    // 不先剥引号的话，取到的东西前面挂着半个引号，`existsSync` 永远为假。
    name: '不剥引号（带空格的安装路径会带着半个引号）',
    from: '  const quoted = /^"([^"]+)"/.exec(value)\n  const raw = quoted ? quoted[1] : value\n',
    to: '  const raw = value\n',
    expect: [
      '没有 DisplayIcon 时退到 UninstallString（带引号 + 参数 + 空格路径）',
      'DisplayIcon 带引号且逗号在引号外（`"…\\Arbiter.exe",0`）',
      'DisplayIcon 指向 `.ico`（且与卸载器不同目录）时退到 UninstallString'
    ]
  },
  {
    // 判据是「取到最后一个 `.exe` 为止」。退成「按空格切」之后，无引号且带空格的
    // DisplayIcon（`C:\Program Files\Arbiter\Arbiter.exe,0`）会在第一个空格处断掉。
    name: '不按 `.exe` 截、退回按空格切（无引号且带空格的路径断在半路）',
    from: "  const exe = /^(.*\\.exe)/i.exec(raw)\n  const path = exe ? exe[1] : raw.split(' ')[0]\n",
    to: "  const path = raw.split(' ')[0]\n",
    expect: ['DisplayIcon（无引号、路径带空格、带 `,0` 图标序号）']
  },
  {
    // 取「第一个 `.exe`」而不是最后一个：目录名里自己带 `.exe` 时会在那儿断开，
    // 反推出一个根本不存在的 `D:\`（审计 F7 实测量到过）。
    name: '`.exe` 截取退成非贪婪（目录名里含 `.exe` 时截错）',
    from: '  const exe = /^(.*\\.exe)/i.exec(raw)',
    to: '  const exe = /^(.*?\\.exe)/i.exec(raw)',
    expect: ['目录名里含 `.exe` 时按**最后**一个 `.exe` 截']
  },
  {
    // `.ico` / `.dll` 这类值反推出的目录是哪个都不好说，必须让它退到 UninstallString。
    name: '`.exe` 结尾这条判据拿掉（`.ico` 的目录会被当真）',
    from: '  if (!/\\.exe$/i.test(path)) return null\n',
    to: '\n',
    expect: ['DisplayIcon 指向 `.ico`（且与卸载器不同目录）时退到 UninstallString']
  },
  {
    // `DisplayIcon` 更直接（它就是主程序），卸载器只是兜底。对调之后两者指向不同目录时
    // 会挑错——而「两者指向不同目录」这个用例正是为它造的。
    name: 'DisplayIcon / UninstallString 的优先级对调',
    from:
      '      const fromIcon = dirOfExecutable(icon)\n' +
      '      const dir = fromIcon ?? dirOfExecutable(uninstall)\n',
    to:
      '      const fromIcon = dirOfExecutable(uninstall)\n' +
      '      const dir = fromIcon ?? dirOfExecutable(icon)\n',
    expect: ['DisplayIcon 与 UninstallString 指向不同目录时，DisplayIcon 赢']
  },
  {
    // ★ 这一条就是修复前的行为：只认那三个固定位置，不去注册表问。
    // 应用装在别处（安装向导里改了目录）的用户，插件会整个起不来。
    name: '★ registryRoots 恒返回空（= 修复前的行为）',
    from: "  if (process.platform !== 'win32') return []\n",
    to: '  if (true) return []\n',
    expect: [
      '父键里的安装目录被逐字读回来（含中文路径 → 走的是 GB18030 那条兜底）',
      '自定义目录进了候选表'
    ]
  },
  {
    // ★ 这一条**最隐蔽**：生产的条目挂在 `…\Uninstall` 的 `{GUID}` 子键下，
    // 少了 `/s` 就查不到任何东西 ⇒ 整条修复静默失效。第一版测试注入的是叶子键，
    // 所以这个变异当年全绿（审计抓到的就是这个）。
    name: '★ `reg query` 的 `/s` 拿掉（子键里的条目再也查不到）',
    from: "['query', key, '/s', '/f', 'Arbiter', '/d']",
    to: "['query', key, '/f', 'Arbiter', '/d']",
    expect: ['父键里的安装目录被逐字读回来（含中文路径 → 走的是 GB18030 那条兜底）']
  },
  {
    // `reg.exe` 往管道里写的是系统 OEM 码页（这里是 GBK），按 UTF-8 硬解会得到一屏
    // 乱码**且不报错**——只是那个目录再也 `existsSync` 不到，表现为「装了却说没装」。
    name: 'GB18030 兜底拿掉（中文安装路径变成乱码，且不报错）',
    from: "    try {\n      return new TextDecoder('gb18030').decode(buffer)\n    } catch {\n      return buffer.toString('utf8')\n    }\n",
    to: "    return buffer.toString('utf8')\n",
    expect: [
      '父键里的安装目录被逐字读回来（含中文路径 → 走的是 GB18030 那条兜底）',
      '不是 UTF-8 时退到 GB18030'
    ]
  },
  {
    // 反方向：只认 GB18030。中文系统上永远看不出问题（GB18030 兼容 ASCII，而 reg.exe
    // 每次都会打一行中文提示，所以实际生效的**总是** GB18030 那条）——但系统开了
    // 「使用 Unicode 为 UTF-8」之后 reg.exe 吐的是 UTF-8，那时中文路径会解成乱码。
    name: '严格 UTF-8 那一步拿掉（UTF-8 码页的机器上中文路径变乱码）',
    from: "  try {\n    return new TextDecoder('utf-8', { fatal: true }).decode(buffer)\n  } catch {\n    try {\n      return new TextDecoder('gb18030').decode(buffer)\n    } catch {\n      return buffer.toString('utf8')\n    }\n  }\n",
    to: "  try {\n    return new TextDecoder('gb18030').decode(buffer)\n  } catch {\n    return buffer.toString('utf8')\n  }\n",
    expect: ['UTF-8 字节按 UTF-8 解（开了「使用 Unicode 为 UTF-8」的机器靠这条）']
  },
  {
    // `resolveTarget` 靠 `find((t) => t.usable)` 跳过「存在但不可用」的候选
    // （比如一份没有 `out/main/cli.js` 的旧安装）。恒 true 会让它去启动一个半截安装。
    name: '`probe()` 的 `usable` 恒 true（半截安装也会被选中）',
    from: '      usable: Boolean(script)\n',
    to: '      usable: true\n',
    expect: ['probe 对「有 exe 但没有入口」的目录判 usable = false（resolveTarget 靠它跳过）']
  },
  {
    // 三个标准位置是**多数用户**走的那条路，第一版一条断言都没有（审计实测：拿掉任何
    // 一条都不会红）。这里拿掉中间那条（全机安装）。
    name: '标准安装位置少一条（全机安装的用户找不到应用）',
    from: "    if (process.env.ProgramFiles) roots.push(join(process.env.ProgramFiles, 'Arbiter'))\n",
    to: '\n',
    expect: ['三个标准安装位置都在候选表里（默认安装的用户走的就是这条）']
  },
  {
    // `ARBITER_HOME` 是**面向用户的指路口**，也是唯一一个能跳过全部探测的开关。
    // 少了它，用户按 README 写的 `ARBITER_HOME` 会**静默失效**（探测照跑，只是不再认它）。
    name: 'ARBITER_HOME 的短路拿掉（用户给的指路静默失效）',
    from: '  if (process.env.ARBITER_HOME) return [process.env.ARBITER_HOME]\n',
    to: '\n',
    expect: ['设了 ARBITER_HOME 就只认它一个（不做任何探测，注册表也不查）']
  },
  {
    // 次序是承重的：注册表那条必须排在「开发形态」（仓库根 / cwd）**之前**。
    // 反过来的话，用户机器上只要恰好 clone 过一个仓库，装好的应用就被顶掉了。
    name: '次序颠倒（注册表那条排到开发形态之后）',
    from:
      '  roots.push(...registryRoots(uninstallKeys))\n\n' +
      '  // 开发形态：插件所在的仓库，以及当前工作目录（Claude Code 起进程时 cwd 就是项目目录）。\n' +
      '  // 放在安装位置**之后**——装了应用的用户不该被一个恰好 clone 过的仓库抢走。\n' +
      '  roots.push(REPO_ROOT, process.cwd())\n',
    to: '  roots.push(REPO_ROOT, process.cwd())\n  roots.push(...registryRoots(uninstallKeys))\n',
    // 期望清单照**实跑观测到**的文案抄，别凭印象写：第一版漏了「注册表那条」五个字，
    // 于是脚本报「有断言没红」——读起来像断言失效，其实是期望过期（约束 33 记过这次事故）。
    expect: [
      '注册表那条排在开发形态（仓库根）之前 —— 用户机器上没有仓库时，这条就是唯一的依靠',
      '排在 cwd 之前（cwd 只是「开发形态」的兜底，不该压过装好的应用）',
      '★ 注入临时键后，resolveTarget 真的挑中自定义目录里那份应用（这次修复的全部意义）'
    ]
  }
]

/* ------------------------------------------------------- 锚点自检
 * `--anchors-only` 时**只**数锚点命中次数：不跑基线、不跑任何测试、不改任何源码、
 * 不做任何还原、也不碰 git。全过 exit 0，有锚点命不中 exit 1。
 * 见 scripts/lib/anchors.mjs 的文件头。
 */
if (process.argv.slice(2).includes('--anchors-only')) {
  const { anchorsOnlyGuard } = await import('./lib/anchors.mjs')
  anchorsOnlyGuard(MUTATIONS, { defaultFile: TARGET })
}

/** `--only=<名字子串>` 只跑命中的变异。基线照样跑（它是对照组，去掉它这轮结论没有意义） */
const ONLY = (process.argv.slice(2).find((a) => a.startsWith('--only=')) ?? '').slice(
  '--only='.length
)
const selected = ONLY === '' ? MUTATIONS : MUTATIONS.filter((m) => m.name.includes(ONLY))
if (selected.length === 0) {
  console.error(`--only=${ONLY} 没命中任何变异`)
  process.exit(1)
}

// 空 `expect` 必须显式声明是 diagnostic——否则一条「谁都没盯住」的变异会被静默盖章通过
// （`filter` 在空清单上恒空）。诊断型变异的要求与 `falsify-tasks.mjs` 一致：**不要求翻红**。
for (const m of MUTATIONS) {
  if (m.expect.length === 0 && m.diagnostic !== true) {
    console.error(`变异「${m.name}」的 expect 是空的，又没有 diagnostic: true —— 拒跑。`)
    process.exit(1)
  }
}

function runTests() {
  const out = spawnSync(process.execPath, ['scripts/test-plugin-target.mjs'], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024
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
  const total = /通过 (\d+)，失败 (\d+)/.exec(text)
  return {
    reds,
    passed: total ? Number(total[1]) : -1,
    failed: total ? Number(total[2]) : -1,
    crashed: !total,
    text
  }
}

const original = readFileSync(TARGET, 'utf8')

console.log(
  ONLY
    ? `只跑 ${selected.length} / ${MUTATIONS.length} 个变异（--only=${ONLY}），基线照样跑一轮…`
    : `${MUTATIONS.length} 个变异，基线跑一轮，每个变异再各跑一轮…`
)
const baseline = runTests()
console.log(`基线：通过 ${baseline.passed}，失败 ${baseline.failed}`)
if (baseline.failed !== 0) {
  console.error('基线不是全绿，先修好再来反证。')
  if (baseline.crashed) console.error('（连「通过 N，失败 M」都没解析到——套件自己崩了）')
  console.error(baseline.text.slice(-2000))
  process.exit(1)
}

let problems = 0

for (const m of selected) {
  // 锚点一定要查命中次数并**把数字打出来**：只说「没命中唯一一次」的话，
  // 0 次（锚点过期）与 2 次（锚点被同款行网住）分不清，两种修法完全不同。
  const hits = original.split(m.from).length - 1
  console.log(
    `[${m.name}] 锚点命中 ${hits} 次（期望 1 次）：${JSON.stringify(m.from.slice(0, 40))}`
  )
  if (hits !== 1) {
    console.error('  期望 1 次 —— 变异没生效，结论无效（多半是源码重构过，锚点过期了）')
    problems += 1
    continue
  }

  writeFileSync(TARGET, original.replace(m.from, m.to), 'utf8')
  const result = runTests()
  writeFileSync(TARGET, original, 'utf8')

  // 套件**崩了**是「抓住了」，不是「抓不住」——它只是不以 ✗ 的形式出现。
  // 混在一起报会把方向指反（本项目在 falsify-downlink 上踩过这条），诱人去放宽断言。
  if (result.crashed) {
    console.log('  套件崩在半路（跑不完、没有汇总行）—— 这一样是「抓住了」，按通过记')
    console.log('  尾部：' + JSON.stringify(result.text.slice(-200)))
    continue
  }

  const missed = m.expect.filter((label) => !result.reds.includes(label))
  const extra = result.reds.filter((label) => !m.expect.includes(label))

  if (missed.length === 0) {
    console.log(`  翻红 ${result.reds.length} 条，期望的都在`)
    for (const label of result.reds) {
      console.log(`    - ${label}${extra.includes(label) ? '   (顺带)' : ''}`)
    }
  } else {
    problems += 1
    console.log('  有断言没红 —— 它们抓不住这个错误：')
    for (const label of missed) console.log(`    ! ${label}`)
    console.log(`  实际翻红：${result.reds.join(' | ') || '（一条都没红）'}`)
    console.log('  套件输出末尾：' + JSON.stringify(result.text.slice(-400)))
  }
}

// 收尾再确认源码确实还原了。**这一步不能省**：反证中途被打断（Ctrl-C、崩溃）
// 会留下一份改坏的源码，而它跑起来的样子和「改回来过」一模一样。
if (readFileSync(TARGET, 'utf8') !== original) {
  console.error('\n源码没还原干净：' + TARGET)
  process.exit(1)
}

const scope = ONLY ? `（**只跑了 ${selected.length} / ${MUTATIONS.length} 个变异**）` : ''
console.log(
  problems === 0
    ? `\n反证通过：每个变异都被对应的断言抓住了，且源码已还原。${scope}`
    : `\n反证不通过：${problems} 处有问题。${scope}`
)
process.exit(problems === 0 ? 0 : 1)
