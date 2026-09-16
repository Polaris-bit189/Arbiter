/**
 * 反证：把 `arbiter` CLI 这条链路上**承重的那几行**逐处改坏，确认
 * `scripts/test-cli.ts` 里对应的断言真的会翻红。
 *
 * 用法：
 *   node scripts/falsify-cli.mjs
 *   node scripts/falsify-cli.mjs --only=闸门,hook
 *
 * ## 为什么必须有这个脚本
 *
 * C 线（`arbiter` 独立 CLI + PreToolUse hook）交付时给了一份**「改坏哪一行 → 哪条断言
 * 该红」的对照表共 16 条**，但**一条都没实跑过**——那是这批里唯一没有反证覆盖的功能。
 * 而 docs/NOTES.md 已经把这条教训写死了：**「不跑的测试就是不存在的测试」**
 * （约束 33 最后两条：`falsify:tasks` 长期没跑完，于是期望清单漂移了都没人看见）。
 *
 * ## 覆盖面（四块，共 16 个变异，其中 2 个是诊断性）
 *
 *   - `src/cli/stdio.ts`：编码（与约束 23 第 3 条同源的坑）+ stdout 闸门的两道防线。
 *   - `src/cli/main.ts`：退出码、`log_tail` 提升、`bytes` 与磁盘体积对账、源存在性检查。
 *   - `src/main/core/cli.ts`：未知选项不静默、路径 resolve、`--out` 多源校验。
 *   - `plugins/arbiter/hooks/read-convert.mjs`：**失败必须放行**那六条。
 *
 * 两个 `diagnostic: true` 的变异**不要求翻红**，它们问的是「这条设计到底有没有用」：
 * 实测下来 `console.log = toStderr` 那一行是**冗余**的（闸门已经兜住了），
 * 而 latin1 那个变异暴露的是 `test-cli.ts` 自己的崩溃缺陷。绿灯本身就是结论。
 *
 * ## 一轮很便宜
 *
 * `test:cli` 实测约 7 秒（66 条），17 轮（基线 + 16 个变异）约两分钟——
 * 与 `falsify:tasks` 的一刻钟/变异是两个世界。所以**没有理由不进聚合**
 * （`npm run falsify`），也没有理由为了省时间而少收变异。
 *
 * ## 与 `falsify-tasks.mjs` 的两处刻意的不同
 *
 * 1. **汇总行的解析写法不同。** `test-cli.ts` 结尾打的是 `通过 66，失败 0。`
 *    ——**全角逗号**，与 `falsify-tasks` / `falsify-ui` 用的斜杠格式
 *    （`通过 68 / 失败 0`）不是一个。照抄那条正则会一直拿到 -1，而 -1 不等于 0，
 *    表现是「基线就报不是全绿」，查半天查不出为什么（`falsify-doc.mjs` 用的是同一种）。
 * 2. **多了一道「套件有没有半路崩掉」的闸门**（`failed === -1`）。它不是洁癖：
 *    实测有一个变异会让 `test-cli.ts` 在第 353 行抛 `ENOENT` 崩掉，
 *    而**崩掉之后的 reds 集合是残缺的**——没有这道闸门，脚本会报「有断言没红」，
 *    读起来像「断言抓不住错误」，其实那些断言一条都没跑到。
 */
import { spawnSync } from 'child_process'
import { createHash } from 'crypto'
import { readFileSync, writeFileSync } from 'fs'
import { resolve } from 'path'

const STDIO = resolve('src/cli/stdio.ts')
const MAIN = resolve('src/cli/main.ts')
/** CLI 入口的**纯逻辑**层（`parseCliRequest`）。零 electron、零子进程，所以能直接测 */
const CORE_CLI = resolve('src/main/core/cli.ts')
/** PreToolUse hook。**它的铁律是「失败必须放行」**，见那个文件的文件头 */
const HOOK = resolve('plugins/arbiter/hooks/read-convert.mjs')

const MUTATIONS = [
  /* ------------------------------------------------ 1~3: stdout 纪律（stdio.ts） */
  {
    // ⚠️ **这条是诊断性的，而且原因不是「断言抓不住」，是 `test-cli.ts` 自己崩了。**
    //
    // 实测（2026-09-14）：变异之后路径变成乱码，[3] 的
    // 「产物路径存在且非空文件」**先红一条**，紧接着下一条断言——
    //
    //     check('**bytes 与磁盘上的体积逐字节吻合**…',
    //       typeof first?.bytes === 'number' && first.bytes === statSync(output).size,
    //       `${String(first?.bytes)} vs ${output === '' ? '-' : statSync(output).size}`)  // ← 353 行
    //
    // 的**细节表达式**里那句 `statSync(output).size` 对着一个不存在的路径抛 `ENOENT`，
    // 异常一路冒出 `testConvert()`、冒出那个 `try`（它只 `finally` 了 cleanup），
    // **整个套件当场结束**：`[4]`~`[9]` 约 40 条断言一条都没跑到，连汇总行都没有。
    //
    // 所以转述表里那句「中文路径的三条该红」**在当前断言写法下无法观测**——
    // 那三条根本没被执行到，它们的「绿」是假的。这与 docs/NOTES.md 测试那节记的
    // 「测试代码自己在失败时抛异常把整个套件崩在半路，盖住后面几十条断言」
    // 是同一个反模式（那里说已经因此抓到过四次）。
    //
    // **修法在 `test-cli.ts` 那一侧**（例如先把 size 算进变量、再拼 detail），不在这个
    // 脚本里。修掉之前，凡是让产物路径不可用的变异，覆盖都是假的——所以这里如实标成
    // 诊断，并靠下面那道 `failed === -1` 闸门把「套件崩了」与「断言没红」区分开。
    name: 'stdout 的字节不再显式构造成 UTF-8（改成 latin1）',
    file: STDIO,
    from: `      write(Buffer.from(text, 'utf8'), () => finish())`,
    to: `      write(Buffer.from(text, 'latin1'), () => finish())`,
    // ⚠️ 这一条**曾经不得不标成 diagnostic**：那时 test-cli.ts 的断言细节表达式
    // statSync(output).size 对乱码路径抛 ENOENT，异常冒出 testConvert() 的 try，
    // **整个套件当场结束**，编码那三条压根没被执行到 —— 于是只能收「崩溃之前
    // 观测到的那一条」。72af454 把那个崩溃点修掉之后，这条变异**真红 17 条**，
    // 编码那三条一字不差地在里面。诊断标记与说明因此一并撤掉。
    expect: [
      '读回的 JSON 里，中文目录名一字不差',
      '读回的 JSON 里，中文文件名一字不差',
      '**产物内容**里的中文也一字不差（端到端，不只是路径）',
      '产物路径存在且非空文件'
    ]
  },
  {
    // 闸门的第一道：`console.*` 改道 stderr。
    //
    // ⚠️ **实测结果是「一条都不红」，而且这不是覆盖缺口，是这行本身冗余。**
    // 机制已经单独验过（2026-09-14，手工变异 + 直接抠 stderr）：
    // `console.log` 最终是**通过 `process.stdout.write` 写出去的**，而那个方法已经被
    // 第二道防线整个换掉了，于是取消改道之后它照样被拦下，stderr 里出现的是
    // `[arbiter] 拦下一段本会污染 stdout 的写入（…）：PROBE_VIA_CONSOLE`。
    // 两条闸门断言**都仍然成立**（它们只要求「进不了 stdout」+「stderr 里能看到」）。
    //
    // ⇒ **物理保证在第二道防线（write 闸门）上，这三行是锦上添花**：
    // 它们的价值是让依赖内部的 `console.log` 显示成一条干净的日志，
    // 而不是一条带「拦下一段」前缀的告警。要精简这块，可以砍这三行；
    // 但**绝不能把 `process.stdout.write` 的替身砍掉**（见下一个变异）。
    name: 'console.log 不再改道 stderr（依赖内部的日志直接污染 stdout）',
    file: STDIO,
    from: `  console.log = toStderr\n`,
    to: `  // 变异：console.log 不再改道\n`,
    diagnostic: true,
    diagnosticNote:
      'console.log 最终也走 process.stdout.write，被第二道闸门拦住了 —— ' +
      '这一行提供的是「干净的日志」而不是「隔离」，砍掉它不会有静默失败。',
    expect: [
      '**闸门有效**：console.log 与直接的 process.stdout.write 都进不了 stdout',
      '两条写入都改道到了 stderr，且原始写入留了「拦下一段」的记录（不是静默丢弃）'
    ]
  },
  {
    // 闸门的第二道：`process.stdout.write` 被整个换掉。变异成「直通」之后，
    // 绕过去的写法（依赖内部最可能用的那种）就漏进 stdout 了。
    //
    // ⚠️ 锚点必须罩住**整个函数体**。只把最后那句 `return true` 换掉是无效变异：
    // 前面那句 `log('拦下一段…')` 照样执行、原始写入照样不发生——
    // 于是断言**合理地**不红，而脚本会报「有断言没红」，读起来像断言抓不住错误。
    // 这一点在 docs/NOTES.md 的「改一半的变异会伪装成断言是装饰」那段里有完整记录。
    name: 'stdout 闸门换成直通（绕过去的写入不再被拦下）',
    file: STDIO,
    from: [
      '  process.stdout.write = ((',
      '    chunk: string | Uint8Array,',
      '    encodingOrCb?: BufferEncoding | ((error?: Error | null) => void),',
      '    cb?: (error?: Error | null) => void',
      '  ): boolean => {',
      "    const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')",
      '    log(`[arbiter] 拦下一段本会污染 stdout 的写入（stdout 是数据通道）：${text.trimEnd()}`)',
      '    // 拦下之后本没有真实写入发生，但调用方可能在等这个回调（流式写入就是这样）。',
      '    // 不回它就永远悬着。',
      "    const callback = typeof encodingOrCb === 'function' ? encodingOrCb : cb",
      '    if (callback) process.nextTick(() => callback(null))',
      '    return true',
      '  }) as typeof process.stdout.write'
    ].join('\n'),
    to: [
      '  process.stdout.write = ((',
      '    chunk: string | Uint8Array,',
      '    encodingOrCb?: BufferEncoding | ((error?: Error | null) => void),',
      '    cb?: (error?: Error | null) => void',
      '  ): boolean => {',
      "    const callback = typeof encodingOrCb === 'function' ? encodingOrCb : cb",
      '    channel()(chunk, callback as never)',
      '    return true',
      '  }) as typeof process.stdout.write'
    ].join('\n'),
    expect: [
      '**闸门有效**：console.log 与直接的 process.stdout.write 都进不了 stdout',
      '两条写入都改道到了 stderr，且原始写入留了「拦下一段」的记录（不是静默丢弃）'
    ]
  },

  /* ------------------------------------------------ 4~9: 退出码与 JSON 契约（main.ts） */
  {
    // `--json` 的契约是「stdout 上**恰好一个** JSON 对象，或者空」。参数错恰恰是
    // 实现最容易只往 stderr 吼一嗓子、stdout 空空如也的一类——而调用方（agent / hook）
    // 拿到的是 `Unexpected end of JSON input`，真正的原因它读不到。
    name: '参数错时不再往 stdout 写那个 JSON（只吼 stderr）',
    file: MAIN,
    from: [
      '    await writeStdout(',
      '      command.json',
      '        ? stringify({',
      '            ok: false,',
      "            command: 'convert',",
      '            results: [],',
      '            error: usageFailure(command.message)',
      '          })',
      "        : ''",
      '    )'
    ].join('\n'),
    to: `    await writeStdout('')`,
    expect: ['未知选项时 stdout 也是合法 JSON']
  },
  {
    // 三条退出码必须互不相同：agent 是拿它决定下一步的。全退 1 的话，调用方唯一的
    // 出路是去读 stderr 里的中文——而那正是约束 23 第 3 条**明令禁止**的判据形态。
    //
    // ⚠️ 锚点用的是 `exitCodeFor()` 里那个 `return EXIT.USAGE`（**6 空格缩进**），
    // 不是 `main()` 里那个（4 空格）。两者都在这个文件里，缩进不同是唯一的区分方式。
    // 改错一个的后果很实在：`main()` 里那个只被「未知选项」用到，改它只会红一条，
    // 而「参数错(2) / 引擎缺失(3) / 转换失败(1) 两两不同」会**照样绿**——
    // 因为那条断言里的 `usage` 走的是 `source_missing`，压根不经过它。
    name: '参数错不再单独给一个退出码（usage 一档并进 CONVERT_FAILED）',
    file: MAIN,
    from: `      return EXIT.USAGE\n`,
    to: `      return EXIT.CONVERT_FAILED\n`,
    expect: ['参数错（源不存在）退出码是 2', '**参数错(2) / 引擎缺失(3) / 转换失败(1) 两两不同**']
  },
  {
    // 同上，另一档：引擎缺失是「要去装（或换目标格式）」，与「转换失败（去看 stderr）」
    // 该做的事完全不同。
    name: '引擎缺失不再单独给一个退出码（并进 CONVERT_FAILED）',
    file: MAIN,
    from: `      return EXIT.ENGINE_MISSING\n`,
    to: `      return EXIT.CONVERT_FAILED\n`,
    expect: ['引擎缺失退出码是 3', '**参数错(2) / 引擎缺失(3) / 转换失败(1) 两两不同**']
  },
  {
    // 产物大小必须是**真的去 stat 出来的那个数**。编一个 0 出来，调用方按体积判断
    // 「产物是不是空的」就会把每一次成功都当成失败——而它读到的 JSON 看起来完好无损。
    name: 'bytes 改成编一个 0（不再与磁盘对账）',
    file: MAIN,
    from: `    bytes: done.sizeBytes ?? null,`,
    to: `    bytes: 0,`,
    expect: ['**bytes 与磁盘上的体积逐字节吻合**（字段能对上产物，不是编的）']
  },
  {
    // 存在性检查放在 submit 之前：`JobRegistry` **不做这件事**（MCP 那条路的存在性由
    // 路径闸门负责，而 CLI 这条没有闸门）。少了这一句，一个拼错的路径会一路走到引擎
    // 那里报一句「转换失败」，真正的原因（这个文件根本不在）一个字都看不见。
    //
    // ⚠️ 变异之后 `statSync` 抛的是**原生 ENOENT**，`failureOf()` 把它归成 `internal`
    // ——于是退出码变成 4（而不是 2），码变成 `internal`（而不是 `source_missing`）。
    // 而「两两不同」那条**照样绿**：1 / 3 / 4 仍然互不相同。
    // 它绿得有道理（三个码确实还不同），所以刻意**不**把它写进 expect
    // ——写了就会变成一条永远失败的假红，而假红会诱人去放宽真正的断言。
    name: '源文件存在性检查删掉（拼错的路径一路走到引擎）',
    file: MAIN,
    from: [
      '  let stat',
      '  try {',
      '    stat = statSync(source)',
      '  } catch {',
      '    throw new McpToolError(',
      '      `找不到源文件：${source}`,',
      "      { source, hint: '路径要写全（相对路径按当前工作目录解析），且文件必须已经存在' },",
      "      { code: 'source_missing' }",
      '    )',
      '  }'
    ].join('\n'),
    to: `  const stat = statSync(source)`,
    expect: ['参数错（源不存在）退出码是 2', '参数错的码是 source_missing']
  },
  {
    // `log_tail` 是**这个项目相对同类最有价值的一件东西**（约束 27）：一段引擎的原始
    // stderr。它在 `convertOne` 里被塞进 `hint`（那是 `McpToolError` 唯一能挂结构化
    // 数据的地方），到了 CLI 的 JSON 里该是**顶层**字段——与 MCP 的 `log_tail` 同名同位，
    // 调用方不必为了读一段 stderr 而先知道 hint 的内部结构。
    name: 'log_tail 不再提升到顶层（埋在 hint 里面）',
    file: MAIN,
    from: [
      '  const hint = fields.hint === undefined ? undefined : { ...fields.hint }',
      '  let logTail: string[] | undefined',
      '  if (hint !== undefined && Array.isArray(hint.log_tail)) {',
      "    logTail = hint.log_tail.filter((line): line is string => typeof line === 'string')",
      '    delete hint.log_tail',
      '  }'
    ].join('\n'),
    to: [
      '  const hint = fields.hint === undefined ? undefined : { ...fields.hint }',
      '  const logTail: string[] | undefined = undefined'
    ].join('\n'),
    expect: ['log_tail 在**顶层**（引擎的原始报错，调用方靠它分辨原因）']
  },

  /* ------------------------------------------------ 10~12: 纯逻辑层（core/cli.ts） */
  {
    // **认不出的 `--xxx` 一律报错，不静默当成文件名。** 一个拼错的选项静默变成路径，
    // 报出来的是「找不到源文件：--too」，与真正的原因（选项名拼错了）看起来毫不相干。
    // （单横线开头的 token 刻意不报——`-foo.mp4` 是合法文件名，而 resolve 之后
    // 它必然以盘符或 `/` 开头，引擎不会把它当成选项。见约束 2。）
    name: '未知的 --选项 静默当成文件名（不再报 error）',
    file: CORE_CLI,
    from: [
      "    if (arg.startsWith('--')) {",
      "      return { kind: 'error', message: `未知的选项：${arg}`, json }",
      '    }'
    ].join('\n'),
    to: [
      "    if (arg.startsWith('--')) {",
      '      paths.push(arg)',
      '      continue',
      '    }'
    ].join('\n'),
    expect: ['未知选项 → error（不静默当成文件名）', '未知选项退出码 2']
  },
  {
    // 每个路径都 resolve 成**绝对**路径：以 `-` 开头的文件名会被 ffmpeg / pandoc / 7z
    // 当成**选项**——参数注入比 shell 注入更隐蔽，因为它看起来只是「文件没转成功」。
    //
    // ⚠️ 转述表只写了「相对路径按 cwd resolve」一条，实测**红的是两条**：紧挨着的
    // 「`-` 开头的文件名也被 resolve 成绝对」同样失守。那两条本来就是同一件事的两个面。
    name: '路径不再 resolve 成绝对（原样交给引擎）',
    file: CORE_CLI,
    // ⚠️ 锚点在 2026-09-16 跟着 R15 更新过：`CliConvertOptions` 多了 `recipePath`，
    //    那个对象字面量因此拆成了多行。**动了 `options:` 那一块就要回来重跑锚点预检**，
    //    它报的是「命中 0 次」，而不是让这条变异悄悄变成空操作。
    from: '      request: { paths: paths.map((item) => resolve(cwd, item)), to },',
    to: '      request: { paths, to },',
    expect: [
      '相对路径按 cwd resolve 成绝对',
      '`-` 开头的文件名也被 resolve 成绝对（约束 2 的参数注入防线）'
    ]
  },
  {
    // 多个源共用同一个产物路径没有意义，而静默地只给第一个用、或者让它们互相覆盖，
    // 都是「少干活还不报错」。
    name: '--out 的多源校验删掉（多文件共用同一个产物路径）',
    file: CORE_CLI,
    from: [
      '  if (out !== null && paths.length > 1) {',
      '    return {',
      "      kind: 'error',",
      '      message: `--out 只能配一个源文件，这次给了 ${paths.length} 个`,',
      '      json',
      '    }',
      '  }'
    ].join('\n'),
    to: '  // 变异：--out 的多源校验删掉',
    expect: ['--out 配多个源 → error']
  },

  /* ------------------------------------------------ 13~16: PreToolUse hook（失败必须放行） */
  //
  // ⚠️ 这一整节盯的是 hook 的**铁律**：它站在**每一次 Read** 的路径上，一旦挡住或报错，
  // 用户正常的读文件就坏了。而 PreToolUse 上**退出码 2 是阻断**（stderr 会被当成拒绝
  // 原因喂给模型）——那是「拦住用户」的意思，与这里要做的正好相反。
  //
  // 所以这几条**都不是**「退出码不对」这种小毛病：第一个会把六条放行路径全变成阻断。
  {
    name: 'pass() 改成 exit(2)（放行变成阻断——PreToolUse 上 2 是拦截）',
    file: HOOK,
    from: ['  if (reason) log(`${reason} —— 放行（不改写这次 Read）`)', '  process.exit(0)'].join(
      '\n'
    ),
    to: ['  if (reason) log(`${reason} —— 放行（不改写这次 Read）`)', '  process.exit(2)'].join(
      '\n'
    ),
    expect: [
      '工具不是 Read → 0 且 stdout 为空',
      '扩展名不在快转表里 → 0 且 stdout 为空',
      'stdin 不是合法 JSON → 0 且 stdout 为空',
      'stdin 是空的 → 0 且 stdout 为空',
      '本机没有可用的 Arbiter → 0 且 stdout 为空',
      '应用在、但没有 CLI 入口（或 CLI 转换失败）→ 0 且 stdout 为空'
    ]
  },
  {
    // ⚠️ **与转述表不符：这条只红一条，不是两条。** 表里写的是「`stdin` 不是合法 JSON」
    // +「`stdin` 是空的」，但**「stdin 是空的」根本不走这个 catch**——它在前一行就被
    // `raw.trim() === ''` 截住、走了 `pass()`。所以那条断言在这个变异下**理应保持绿**
    // （它考的是另一条分支）。把它写进 expect 会换来一条永远失败的假红。
    name: 'JSON.parse 的 catch 改成 exit(1)（坏输入变成阻断）',
    file: HOOK,
    from: `    return pass('stdin 不是合法 JSON')`,
    to: `    process.exit(1)`,
    expect: ['stdin 不是合法 JSON → 0 且 stdout 为空']
  },
  {
    // ⚠️ 同理：这条只红它自己那一条。
    name: 'tool_name !== Read 的分支改成 exit(1)',
    file: HOOK,
    from: `  if (input?.tool_name !== 'Read') return pass(\`工具不是 Read：\${input?.tool_name}\`)`,
    to: `  if (input?.tool_name !== 'Read') process.exit(1)`,
    expect: ['工具不是 Read → 0 且 stdout 为空']
  },
  {
    // 判据是 `usable`，不是 `existsSync(target.entry)`：打包形态下那个路径指向 asar
    // 内部，**普通 Node 的 `existsSync` 恒为 false**（约束 21 那个静默 bug 的修法）。
    name: '找不到应用的分支改成 exit(1)',
    file: HOOK,
    from: `  if (!target || !target.electron) return pass('本机没有找到可用的 Arbiter')`,
    to: `  if (!target || !target.electron) process.exit(1)`,
    expect: ['本机没有可用的 Arbiter → 0 且 stdout 为空']
  },
  /* ------------------------------------------------ 配方文件（R15） */
  {
    // 命令行不再优先：配方里的 target 压过用户这次手敲的 `--to`。
    // 坏起来的样子是「我明明说了 mkv，它转成了 webm」——而配方是**上一次**
    // 存下来的东西，用户早就忘了它还在那儿。极难归因的一类。
    name: '配方压过命令行（`--to` 说了不算）',
    file: MAIN,
    from:
      '  const toExt =\n' +
      '    requestedTo ?? recipe.target ?? resolveDefaultTarget(fromExt, getSettings().defaultTargets)\n',
    to:
      '  const toExt =\n' +
      '    recipe.target ?? requestedTo ?? resolveDefaultTarget(fromExt, getSettings().defaultTargets)\n',
    expect: ['10b `--to` 覆盖配方里的 target（配方说 webm，命令行说 mkv → 产物是 mkv）']
  },
  {
    // 配方里的 `mode` 被丢掉。它**不去**让任何东西崩：转换照常成功，
    // 只是从「只准重封装」悄悄退回 auto（该重编码就重编码）。
    // 用户拿到的是一个「能打开、但不是我要的那种」产物。
    name: '配方里的 mode 不再传给引擎（remux 悄悄退化成 auto）',
    file: MAIN,
    from: '    ...(recipe.mode === undefined ? {} : { mode: recipe.mode }),\n',
    to: '\n',
    expect: ['10e ⭐ `mode: "remux"` 真的传到了引擎（h264+aac 装不进 webm，必然失败）']
  },
  {
    // 一份什么都没认出来的配方不再被拒，而是按默认档默默跑完。
    // 这正是这个功能最想堵的那件事：**用户以为设了、其实一个字段都没生效**，
    // 而报告的是「成功」。
    name: '空配方不拒（按默认档默默跑完还报成功）',
    file: MAIN,
    from:
      '  if (isRecipeEmpty(recipe)) {\n' +
      '    return {\n' +
      '      ok: false,\n' +
      '      message: `这份配方一个字段都没认出来：${path}（只认 target 与 mode，见 --help）`\n' +
      '    }\n' +
      '  }\n',
    to: '\n',
    expect: ['10i 一个字段都没认出来 → 退出码 2（**不是**按默认档默默跑完还报成功）']
  },
  {
    // 认不出的字段不再报到 stderr。转换结果**一点不变**（逐字段宽容那一半还在），
    // 变的只是「用户知道自己拼错了一个键名」。写错键名是这类配置最常见的错，
    // 而它的表现是「配了没反应」——不说出来就永远查不到。
    name: '认不出的字段不再报到 stderr（配了没反应且无从查起）',
    file: MAIN,
    from: '  for (const problem of problems) log(`⚠️ 配方 ${path}：${problem}`)\n',
    to: '\n',
    expect: ['10k 但那个坏字段**一定要报到 stderr**（否则用户永远不知道自己写错了一个键名）']
  }
]

/* ------------------------------------------------------- 锚点自检
 * `--anchors-only` 时**只**数锚点命中次数：不跑基线、不跑任何测试、不改任何源码、
 * 不做任何还原、也不碰 git。全过 exit 0，有锚点命不中 exit 1（逐条打印
 * 「脚本 / 变异名 / 命中次数 / 期望次数」）。
 *
 * 存在的理由：原先「命中次数对不对」这道检查排在基线之后，于是锚点被一次重构弄丢时，
 * 脚本报出来的是「有断言没红」——**看着像断言失效，其实是锚点过期**，还白等一整轮。
 * 见 scripts/lib/anchors.mjs 的文件头。
 */
if (process.argv.slice(2).includes('--anchors-only')) {
  const { anchorsOnlyGuard } = await import('./lib/anchors.mjs')
  // 与脚本正文一致：它读盘后过了 `toLf`（见下面的 `originals` / 循环）
  anchorsOnlyGuard(MUTATIONS, { normalizeLf: true })
}

/**
 * `--only=<名字子串>` 只跑命中的那几个变异。**基线照样跑**（它是对照组，
 * 去掉它这一轮结论就没有意义）。
 *
 * ⚠️ 这段**必须放在 `MUTATIONS` 之后**：`const` 有暂时性死区，放前面会直接
 * `ReferenceError: Cannot access 'MUTATIONS' before initialization`。
 * 支持逗号分隔的多个子串（`--only=闸门,hook`）。
 */
const ONLY = (process.argv.slice(2).find((a) => a.startsWith('--only=')) ?? '').slice(
  '--only='.length
)
const ONLY_PARTS = ONLY
  ? ONLY.split(',')
      .map((part) => part.trim())
      .filter((part) => part !== '')
  : []
const selected = ONLY_PARTS.length
  ? MUTATIONS.filter((m) => ONLY_PARTS.some((part) => m.name.includes(part)))
  : MUTATIONS
if (ONLY_PARTS.length && selected.length === 0) {
  console.error(`--only=${ONLY} 一个变异都没匹配上`)
  process.exit(1)
}

/**
 * 跑被测套件并抠出翻红的断言标签。
 *
 * ⚠️ 汇总行是 **`通过 66，失败 0。`（全角逗号）**，与 `falsify-tasks.mjs` 用的斜杠
 * 格式不是一个。照抄那条正则会一直拿到 -1，而 -1 不等于 0，表现是「基线就报不是全绿」。
 */
function runTests() {
  const out = spawnSync('npx', ['tsx', '--tsconfig', 'tsconfig.test.json', 'scripts/test-cli.ts'], {
    encoding: 'utf8',
    shell: true,
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
    text
  }
}

/** 锚点一律在 LF 文本上匹配：混进 CRLF 的话跨行锚点会一声不响地命中 0 次 */
const toLf = (s) => s.replace(/\r\n/g, '\n')

const originals = Object.fromEntries(
  [...new Set(MUTATIONS.map((m) => m.file))].map((f) => [f, readFileSync(f, 'utf8')])
)

console.log(
  ONLY
    ? `只跑 ${selected.length} / ${MUTATIONS.length} 个变异（--only=${ONLY}），基线照样跑一轮…`
    : `${MUTATIONS.length} 个变异，基线跑一轮（约 7 秒；后面每个变异还要各跑一轮）…`
)
const baseline = runTests()
console.log(`基线：通过 ${baseline.passed}，失败 ${baseline.failed}`)
if (baseline.failed !== 0) {
  console.error('基线不是全绿，先修好再来反证。')
  console.error(baseline.text.slice(-2000))
  process.exit(1)
}

let problems = 0

for (const m of selected) {
  const original = toLf(originals[m.file])
  const hits = original.split(m.from).length - 1

  // 命中次数一定要打出来：只说「没命中唯一一次」的话，0 次和 2 次根本分不清。
  console.log(`\n[${m.name}] 锚点命中 ${hits} 次（期望 1 次）`)
  if (hits !== 1) {
    console.error('  期望 1 次 —— 变异没生效，结论无效（多半是源码重构过，锚点过期了）')
    problems += 1
    continue
  }

  writeFileSync(m.file, original.replace(m.from, m.to), 'utf8')
  const result = runTests()
  writeFileSync(m.file, originals[m.file], 'utf8')

  // ⚠️ 没有汇总行 = 套件在半路抛异常崩了。**此时 `reds` 是残缺的**，拿它去比对
  // 期望清单毫无意义——它会报「有断言没红」，而真相是那些断言一条都没跑到。
  // 这道闸门就是为了不把「测试自己崩了」误读成「断言抓不住错误」。
  if (result.failed === -1) {
    console.log(
      '  !! 套件在半路崩了（没有等到结尾的汇总行）—— 后面的断言一条都没跑到，这次比对无效'
    )
    if (result.reds.length > 0) console.log(`  崩溃前翻红：${result.reds.join(' | ')}`)
    const tail = result.text
      .split(/\r?\n/)
      .filter((l) => /^\s+at |Error:/.test(l))
      .slice(0, 4)
    for (const line of tail) console.log(`    ${line.trim()}`)
    if (m.diagnostic) {
      console.log(`  [诊断] ${m.diagnosticNote ?? '已知会在半路崩掉。'}`)
    } else {
      problems += 1
      console.log('  ⇒ 这不是断言的问题：先修 test-cli.ts，再回来看这个变异。')
    }
    continue
  }

  if (m.diagnostic) {
    console.log(`\n[诊断] ${m.name} → 通过 ${result.passed}，失败 ${result.failed}`)
    console.log(
      result.reds.length > 0
        ? `    翻红：${result.reds.join(' | ')}\n    ⇒ 这条设计是承重的，留着。`
        : `    ⇒ ${m.diagnosticNote ?? '一条都没红：这条设计在当前实现下不是承重约束。'}`
    )
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
  }
}

// 收尾再确认源码确实还原了
const dirty = Object.keys(originals).filter((f) => readFileSync(f, 'utf8') !== originals[f])
if (dirty.length > 0) {
  console.error('\n源码没还原干净：' + dirty.join(', '))
  process.exit(1)
}

// 把跑完之后每个文件的 sha256 打出来：这条「已还原」的结论不该只有脚本自己说了算。
for (const f of Object.keys(originals)) {
  console.log(`  ${createHash('sha256').update(readFileSync(f)).digest('hex')}  ${f}`)
}

const scope = ONLY ? `（**只跑了 ${selected.length} / ${MUTATIONS.length} 个变异**）` : ''
console.log(
  problems === 0
    ? `\n反证通过：每个变异都被对应的断言抓住了，且源码已还原。${scope}`
    : `\n反证不通过：${problems} 处有问题。${scope}`
)
process.exit(problems === 0 ? 0 : 1)
