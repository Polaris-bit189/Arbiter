/**
 * 反证：把 M4「MCP server」的承重逻辑逐处改坏，确认 `scripts/test-mcp-server.ts`
 * 里对应的断言真的会翻红。
 *
 * 用法：
 *   node scripts/falsify-mcp.mjs
 *   npm run falsify:mcp
 *   node scripts/falsify-mcp.mjs --only=闸门    # 只跑名字命中的变异
 *
 * **为什么刻意不进 `npm run falsify` 的聚合**：一轮 `test-mcp-server` 要真起两个
 * MCP 子进程、真造一段 20 秒的 1080p 视频并真转它、还要等两段取消各自落定，
 * 一分钟往上；七个变异就是七八轮。跟 `falsify:tasks` 同一种成本，同样单独跑。
 *
 * ⚠️ **这条线最该被反证盯住的三样东西**，下面的变异就是按它们挑的：
 *   1. `stdout` 是协议的（闸门放行一切 → 客户端「连着连着就断了」，服务端一声不吭）；
 *   2. 闸门是**写根**那一侧（MCP 的对面是一个自主 agent，不是用户的手指）；
 *   3. 「引擎没装好」必须**在排队之前**拒（排到队再失败，agent 已经又发了两轮调用）。
 *
 * ⚠️ 变异改的是**磁盘上的源码**。反证跑着的时候源码就是坏的：这段时间里别提交、
 * 别从测试的绿灯里下任何结论（见 docs/NOTES.md 与记忆里那条「反证残留」）。
 */
import { spawnSync } from 'child_process'
import { createHash } from 'crypto'
import { readFileSync, writeFileSync } from 'fs'
import { resolve } from 'path'

const SERVER = resolve('src/mcp/server.ts')
const STDOUT = resolve('src/mcp/stdout.ts')
const PATHS = resolve('src/mcp/paths.ts')
const JOBS = resolve('src/mcp/jobs.ts')
const PLAN = resolve('src/mcp/plan.ts')
const SETTINGS = resolve('src/main/core/settings.ts')
const THUMBNAIL = resolve('src/mcp/thumbnail.ts')

const MUTATIONS = [
  {
    // 闸门退化成「什么都放行」。它不会报错、也不会崩，只是每一行非协议输出都
    // 原样写进 stdout——客户端表现为会话莫名其妙地断，而服务端什么错都不打。
    name: 'stdout 闸门放行一切（协议纯净性失效）',
    file: STDOUT,
    edits: [
      {
        // ⚠️ 锚点必须罩住**整个函数体**。第一版只把最后那句 `return` 改成 `return true`，
        // 结果 `JSON.parse` 对裸文本照样抛、照样走 catch 返回 false——裸文本仍然被拦，
        // 于是第 3、6 条**合理地**没红，脚本报「有断言没红」。那不是断言抓不住错误，
        // 是变异只改了一半：**改一半的变异会伪装成「断言是装饰」**，比不变异还费时间。
        from: [
          '  const trimmed = line.trim()',
          "  if (trimmed === '') return true // 空行不是帧，但也不破坏协议",
          '  try {',
          '    const parsed: unknown = JSON.parse(trimmed)',
          "    return typeof parsed === 'object' && parsed !== null && 'jsonrpc' in parsed",
          '  } catch {',
          '    return false',
          '  }',
          '}'
        ].join('\n'),
        to: '  void line\n  return true\n}'
      }
    ],
    expect: [
      '2  合法 JSON 但没有 jsonrpc 字段 → 拦下',
      '3  裸文本 → 拦下',
      '6  裸文本被拦下 + stderr 有拦截记录（自证：闸门是活的）'
    ]
  },
  {
    // 数组那侧不再给 structuredContent。MCP 要求它是 object，于是**整个消失**——
    // 客户端只能去 parse text，而「工具返回了什么」不该取决于调用方会不会解析字符串。
    // （这正是本套件第一次跑就抓到的那个形状：文本还在、结构化那一侧没了。）
    name: 'ok() 不把数组包成 {results}（结构化那一侧消失）',
    file: SERVER,
    edits: [
      {
        // 改成「分支还在、但结构化那一侧不给」——正是这套件第一次跑时抓到的那个形状。
        // ⚠️ 锚点在 2026-09-16 跟着 R20 更新过：`ok()` 现在多接一个 `extra`（产物缩略图
        //    那一块），数组分支那一行因此长了。**动了 `ok()` 就要回来重跑锚点预检**，
        //    它报的是「命中 0 次」，而不是让这条变异悄悄变成空操作。
        from:
          "      content: [{ type: 'text', text }, ...extra],\n" +
          '      structuredContent: { results: payload }',
        to: "      content: [{ type: 'text', text }]"
      }
    ],
    expect: ['7  不带 category 返回全部六类，且结构化那一侧也在（数组被包成了 {results}）']
  },
  {
    // 最像「顺手抄错一行」的那种回归：写路径拿起读根去判。
    // 测试里仓库根**是**合法读根、又刻意不在写根里，所以这个错会被逮住。
    name: 'resolveWritePath 拿读根当写根判（抄错一行）',
    file: PATHS,
    edits: [
      {
        from: '  if (!insideAny(real, gate.writeRoots)) {\n',
        to: '  if (!insideAny(real, gate.roots)) {\n'
      }
    ],
    expect: ['15 写到写根之外被拒（读根不等于写根）']
  },
  {
    // 「别提前拒，让引擎自己报错」——听上去更简单，代价是 agent 要等排到队才知道，
    // 而那时它多半已经又发了两轮调用。
    name: '引擎未就绪的预检退化成永远放行',
    file: JOBS,
    edits: [
      {
        from: '  if (needed === null || engineReady(needed)) return\n',
        to: '  if (true) return\n'
      }
    ],
    expect: ['2  需要 pandoc 的转换在**排队之前**就被拒，理由点名是哪个引擎']
  },
  {
    // 不进度的样子和「引擎很慢」一模一样，光看 UI 分辨不出来。
    name: 'convert_file 不转发 progressToken（进度通知发不出去）',
    file: SERVER,
    edits: [
      {
        from: '        const token = extra._meta?.progressToken\n',
        to: '        const token: string | number | undefined = undefined\n'
      }
    ],
    expect: ['26 convert_file 期间推过 notifications/progress，且带的是客户端给的那个 token']
  },
  {
    // mode 丢在工具层：参数进了 jobs.ts 就没了，remux 会悄悄退化成重编码——
    // 用户要的是「秒完、无损」，拿到的是「等两分钟」，而且不报任何错。
    name: 'mode 没有传到引擎（remux 悄悄退化成重编码）',
    file: JOBS,
    edits: [
      {
        // ⚠️ 锚点跟着代码搬了家：E-5 把 submit() 拆成 preview() + RouteSpec，
        // 这一行现在是 preview() 返回的那个对象字面量里的一个字段（缩进 4 格 → 6 格）。
        // 它**就这样静默失效过一次**（命中 0 次 → 脚本报「结论无效」，
        // 而那句很容易被读成通过）——「改了被反证覆盖的代码必须重跑」的又一个实例。
        from: "      mode: spec.mode ?? 'auto'\n",
        to: "      mode: 'auto'\n"
      }
    ],
    expect: ['17 mode=remux 遇到装不下的容器被明确拒绝（说明 mode 传到了 ffmpegRun 的判据）']
  },
  {
    // agent 拿到的 job_id 记错一位时，两句失败文案的**可修复性**完全不同：
    // 带上清单它会自己改对，不带就只能干瞪眼。所以清单本身是承重的。
    name: '未知 job_id 不带出已登记的清单（agent 无法自查）',
    file: SERVER,
    edits: [
      {
        // ⚠️ 加了错误码之后这个锚点长了一行（`{ code: 'unknown_job' }`）。
        // 锚点跟丢的表现是「命中 0 次，变异没生效，结论无效」——那**不是**通过，
        // 所以凡是改了被反证覆盖的代码，都必须回来重跑一次 `npm run falsify`。
        from: [
          '        // 带上还活着的 job 列表：agent 拿到的 job_id 记错一位时，',
          '        // 它能立刻看出「我用错 id 了」而不是「任务丢了」。',
          '        return fail(',
          '          new McpToolError(',
          '            `没有这个 job：${args.job_id}`,',
          '            { known_job_ids: deps.registry.list().map((j) => j.id) },',
          "            { code: 'unknown_job' }",
          '          )',
          '        )'
        ].join('\n'),
        to: '        return fail(new McpToolError(`没有这个 job：${args.job_id}`))'
      }
    ],
    expect: [
      '18 未知 job_id 被拒，且带出已经登记过的 id 清单',
      // 第 28 条靠 known_job_ids 的**差集**找出被取消的那个 job（取消之后连回话都没有），
      // 这条提示一没，它也跟着红——顺带说明「差集」这条查法确实只依赖这一个出口。
      '28 那条 job 确实落定了 canceled（取消是真生效的，不只是没回话）'
    ]
  },
  {
    // 「不给 output_path 时落在源文件旁边」是**有条件的**：用户在应用里设了输出目录时，
    // 产物会去那个目录（`jobs.ts` 刻意复用主进程的 `outputDirFor()`，与 GUI 同一套规则）。
    // 这一支原先**一条断言都没有**——第 2 节的 14 号跑的是「默认设置」那一支，
    // 于是「设了输出目录」这一支既没被覆盖、也没人发现工具描述写错了。第 4 节就是补它。
    //
    // 把判据翻个方向，正是「顺手把标志位写反」那种最像真实回归的改法。
    name: 'outputDirFor 忽略「输出到指定目录」的设置（落点退回源文件旁边）',
    file: SETTINGS,
    edits: [
      {
        from: '  if (current.outputDir && !current.outputBesideSource) return current.outputDir\n',
        to: '  if (current.outputDir && current.outputBesideSource) return current.outputDir\n'
      }
    ],
    expect: [
      '2  设了输出目录时，产物落在**设置的那个目录**',
      '4  返回值里的 output 就是实际落点（agent 照它报路径就不会错）'
    ]
  },
  {
    // ★ 打的是 2026-09-13 修掉的那个**真 bug**：`convert_file` 注册时取的描述是
    //   `TOOL_DESCRIPTIONS.read_document`——最常用的那个工具，客户端读到的说明书是别人的。
    //
    // ⚠️ 这条变异**只打包装函数内部**：`server.ts` 现在把「注册用的工具名」与
    //   「取说明书的键」收成了同一个 `name`（见 `registerArbiterTool` 的注释），
    //   调用点根本写不出 description。把 `[name]` 换成写死的 `read_document`
    //   正是当年那个错误的形状——**它现在必须在打包函数里才复现得出来**，
    //   这本身就是那层包装有效的证据。
    //
    // ⚠️ 这条也是那个 bug 唯一抓得住的判据所在：`test-mcp-view.ts` **看不到它**
    //   （它只断言描述表里有中文，且不 import `server.ts`——一 import 就会触发它自己
    //   那条「src/mcp 的依赖图里没有 src/main」）。必须**真起服务端问 `tools/list`**
    //   才拿得到接线后的结果，所以断言在 `test-mcp-server.ts` 第 6 节。
    name: '★ 说明书接线退回写死的键（convert_file 说 read_document 的话）',
    file: SERVER,
    edits: [
      {
        from: '  server.registerTool(name, { ...config, description: TOOL_DESCRIPTIONS[name] }, handler)\n',
        to: '  server.registerTool(\n    name,\n    { ...config, description: TOOL_DESCRIPTIONS.read_document },\n    handler\n  )\n'
      }
    ],
    expect: [
      '2  tools/list 里**每个**工具的 description 逐字等于 TOOL_DESCRIPTIONS[该工具名]',
      '4  每段 description 互不相同（说明书撞车 = 至少有一个工具在说别人的话）',
      '5  convert_file 的说明书是**它自己的**（有「转换单个文件」、没有「直接读出文档的正文」）'
    ]
  },
  {
    // ★ E-5 的第一条规矩：**预览绝不占产物名**（`jobs.ts` 的 `preview()` 注释里
    //   点名的那个「最容易踩」）。这一脚是最难自查的一类：预览一个字节都没写、
    //   磁盘上什么都没多，唯一的痕迹在内存里的 `claimed` 集合里。
    //   它一旦被预览写进去，随后的真实任务就会被 `resolveOutput` 避让成 `x (1).jpg`
    //   （约束 9 那套避让）——**不报错、不显形**，用户拿到的名字和要的不是一个。
    //
    //   判据是 9i：连着做两次 dry run，两次落点必须逐字相同；第二次被第一次挤走就红。
    name: '★ dry_run 占用了产物名（只读的预览污染了真实落点）',
    file: JOBS,
    edits: [
      {
        // 锚点罩住 preview() 的整个 return——只改 `output:` 那一行的话，
        // 加进去的 `claimed.add` 没有落脚点（`to` 必须是一段自洽的代码）。
        from: [
          '    return {',
          '      source: spec.source,',
          '      fromExt,',
          '      toExt,',
          '      engine,',
          '      output: this.resolveOutput(spec.source, toExt, spec.outputPath, spec.outputComputed === true),',
          "      mode: spec.mode ?? 'auto'",
          '    }'
        ].join('\n'),
        to: [
          '    const previewed = this.resolveOutput(',
          '      spec.source,',
          '      toExt,',
          '      spec.outputPath,',
          '      spec.outputComputed === true',
          '    )',
          '    this.claimed.add(previewed)',
          '    return {',
          '      source: spec.source,',
          '      fromExt,',
          '      toExt,',
          '      engine,',
          '      output: previewed,',
          "      mode: spec.mode ?? 'auto'",
          '    }'
        ].join('\n')
      }
    ],
    expect: ['9i 连做两次 dry run：两次落点**逐字相同**（预览不会被自己上一次的结论影响）']
  },
  {
    // ★ E-5 的第二条规矩：**「会被拒」与「真跑被拒」是同一份回话**（`plan.ts` 注释里
    //   的第 2 条）。给错误加一层「预览失败：」听上去更友好，代价是把结构化判据抹掉：
    //   agent 拿到的不再是 `code=engine_missing` 那套可程序化处理的东西，而是一句中文。
    //   而这件事在这条线上本是**结构上的保证**——包装这一层正是把它降级成「对齐文案」。
    name: 'dry_run 把校验错误包了一层（预览与真跑不再是同一份回话）',
    file: PLAN,
    edits: [
      {
        from: '  const route = registry.preview(spec)\n',
        to: [
          '  let route',
          '  try {',
          '    route = registry.preview(spec)',
          '  } catch (error) {',
          '    throw new Error(`预览失败：${(error as Error).message}`)',
          '  }\n'
        ].join('\n')
      }
    ],
    expect: [
      '7  dry_run 在「引擎没装」这条路上与真跑报**同一个错**（逐字相同、code=engine_missing）'
    ]
  },
  {
    // R20：缩略图是**默认关**的。少了这一句，「开了会给图」那一串照样全绿，
    // 而 agent 会在每一次 convert_file 上都白拿一张几百 KB 的图——那是**悄悄地**
    // 把每次调用的上下文撑大，没有任何地方会报错。
    // 后半句断言只可能被这一条打红：只有它跑的是「不设开关」的那个会话。
    name: '缩略图不看开关（默认也开）',
    file: SERVER,
    edits: [
      {
        from: "  if (process.env.ARBITER_MCP_THUMBNAILS !== '1') return null\n",
        to: '\n'
      }
    ],
    expect: ['10c ⭐ 默认关：回话里一块 image 都没有']
  },
  {
    // R20 唯一一句**结构**上的承诺：文字块必须排在图**前面**。
    // 反过来在客户端看得见图时毫无区别，而图被静默丢掉时 agent 就两手空空——
    // 那正是生态里真实存在的失效模式，也是这个功能做成「补充」的全部理由。
    name: '缩略图的图块排到了文字块前面（客户端丢图时 agent 两手空空）',
    file: SERVER,
    edits: [
      {
        // 锚点必须带上**下一行**：三个返回分支现在都长这样，只写 content 那一行
        // 会命中 2 次；而且 convert_file 走的是**对象分支**，打错分支这条变异根本不生效
        // （脚本会报「有断言没红」，看起来像断言失效）。
        from: "      content: [{ type: 'text', text }, ...extra],\n      structuredContent: payload as Record<string, unknown>",
        to: "      content: [...extra, { type: 'text', text }],\n      structuredContent: payload as Record<string, unknown>"
      }
    ],
    expect: ['10h ⭐ 文字块在**第一块**（客户端丢图时 agent 照样答得出来）']
  },
  {
    // 少了 resize，回给 agent 的就是**原图**：1200×800 的 JPEG，几十上百 KB。
    // 「缩略图」这三个字要办的事正好相反（同一个坑见约束里图片参数那一节）。
    name: '缩略图不缩（回给 agent 的是原图）',
    file: THUMBNAIL,
    edits: [
      {
        from: [
          "      const pipeline = sharp(outputPath, { failOn: 'none' }).rotate().resize({",
          '        width: THUMBNAIL_MAX_EDGE,',
          '        height: THUMBNAIL_MAX_EDGE,',
          "        fit: 'inside',",
          '        // **不放大**：一张 64×64 的图标不该被拉成 512×512——那只会变大变糊，',
          '        // 与「缩略图」这三个字要办的事正好相反（同一个坑见约束里图片参数那一节）',
          '        withoutEnlargement: true',
          '      })',
          ''
        ].join('\n'),
        to: "      const pipeline = sharp(outputPath, { failOn: 'none' })\n"
      }
    ],
    expect: ['10l ⭐ 缩略图被缩到了长边 512（1200×800 → 512×341）']
  },
  {
    // R16：调度规则本身。把「在放得下的里面挑优先级最高的」退回纯 FIFO——
    // 这正是**没做优先级时**的行为，也就是说这条变异把功能整个拿掉了。
    // 从外面看：`priority: 9` 传进去、任务照样排在别人后面，
    // 而返回值里 `priority: 9` 还在（回显是真的），所以**没有它看起来像功能坏了**。
    name: 'pickNextIndex 退回纯 FIFO（优先级被整个丢掉）',
    file: JOBS,
    edits: [
      {
        from: '    if (best < 0 || item.priority > queue[best].priority) best = i\n',
        to: '    if (best < 0) best = i\n'
      }
    ],
    expect: ['11b ⭐ 挑的是**优先级最高的那个**，不是队首那个']
  },
  {
    // 把 `>` 写成 `>=`：并列时挑**最后**一个。优先级逻辑看着还在（11b 照样绿），
    // 坏的是 FIFO 这条默认约定——而它坏起来的样子是「我什么都没设，怎么顺序乱了」。
    name: '同优先级时挑最后一个（FIFO 这条默认约定被改掉）',
    file: JOBS,
    edits: [
      {
        from: '    if (best < 0 || item.priority > queue[best].priority) best = i\n',
        to: '    if (best < 0 || item.priority >= queue[best].priority) best = i\n'
      }
    ],
    expect: ['11c 同优先级保持入队顺序（FIFO 是默认行为，优先级只该「插队」不该把它也改掉）']
  },
  {
    // 准入那一跳被拿掉：优先级插队于是**可以越过容量**——一个高优先级任务会
    // 硬挤进已经占满的引擎。那是约束 25 防的那件事（按份数记账），
    // 而它坏起来是「明明限了 1 个并发，怎么同时跑起来三个」。
    name: '插队越过容量准入（高优先级能挤进已经占满的引擎）',
    file: JOBS,
    edits: [
      {
        from: '    if (!hasSlot(item.engine, item.cost)) continue\n',
        to: '\n'
      }
    ],
    expect: [
      '11e ⭐ 最高的那条**放不下**时，退而挑放得下的（插队不能把队列冻住）',
      '11f 一个都放不下时回 -1（调用方据此 return，不是挑一个硬跑）'
    ]
  },
  {
    // 夹取丢掉上界。schema 那道闸还在（agent 传 101 仍会被 zod 拒），
    // 但 `submit()` 的**另一个调用方**（CLI 那条路不经过 zod）会把 9999 原样带进队列，
    // 于是它永远排在所有任务前面——一次「我只是想插个队」变成「我霸占了整张队列」。
    name: 'clampPriority 丢掉上界（非 zod 的调用方能把队列整个霸占）',
    file: JOBS,
    edits: [
      {
        from: '  return Math.max(MIN_PRIORITY, Math.min(MAX_PRIORITY, Math.trunc(value)))\n',
        to: '  return Math.max(MIN_PRIORITY, Math.trunc(value))\n'
      }
    ],
    expect: ['11h clampPriority：越界夹到 ±100，并且取整']
  }
]

/* ------------------------------------------------------- 锚点自检
 * `--anchors-only` 时**只**数锚点命中次数：不跑基线、不跑任何测试、不改任何源码、
 * 不做任何还原、也不碰 git。全过 exit 0，有锚点命不中 exit 1（逐条打印
 * 「脚本 / 变异名 / 命中次数 / 期望次数」）。
 *
 * 存在的理由：这一支一轮 141 秒，而文件末尾那段注释抱怨的正是同一件事——
 * 「有断言没红」读起来像断言失效，其实是锚点过期。见 scripts/lib/anchors.mjs 的文件头。
 */
if (process.argv.slice(2).includes('--anchors-only')) {
  const { anchorsOnlyGuard } = await import('./lib/anchors.mjs')
  // 与脚本正文一致：它读盘后过了 `toLf`（见下面的 `originals` / 循环）
  anchorsOnlyGuard(MUTATIONS, { normalizeLf: true })
}

/** `--only=<名字子串>` 只跑命中的变异。基线照样跑（它是对照组，去掉它这轮结论没有意义）。 */
const ONLY = (process.argv.slice(2).find((a) => a.startsWith('--only=')) ?? '').slice(
  '--only='.length
)
const selected = ONLY ? MUTATIONS.filter((m) => m.name.includes(ONLY)) : MUTATIONS
if (ONLY && selected.length === 0) {
  console.error(`--only=${ONLY} 一个变异都没匹配上`)
  process.exit(1)
}

/**
 * 从套件输出里抠出翻红的断言标签。
 *
 * **只认末尾的汇总块，不能靠 `✗` 行。** 第 1 节测的正是 stdout 闸门，它为了断言
 * 「拦没拦住」把 `process.stdout.write` / `process.stderr.write` 换成了自己的捕获器，
 * 而 `protectStdout()` 又把 `console.log` 改道到 `stderr.write`——于是**第 5/6/7 条
 * 断言自己打印的 `✓`/`✗` 会被那个捕获器吃掉**。闸门一坏，第 6、7 条的 `✗` 凭空消失，
 * 而汇总里照样记着它们失败，脚本就会报一条假的「有断言没红」（实测踩到过一整轮）。
 * 一句话：**测 stdout 的工具不能靠 stdout 说话**，只能信汇总（它在捕获器拆掉之后才打）。
 */
function parseReds(text) {
  const lines = text.split(/\r?\n/)
  const start = lines.lastIndexOf('失败：')
  const summary = []
  if (start >= 0) {
    for (const line of lines.slice(start + 1)) {
      const m = /^\s*-\s*(.+?)\s*$/.exec(line)
      if (!m) break
      summary.push(m[1])
    }
  }
  if (summary.length > 0) return summary
  // 兜底：汇总块没解析到（比如套件自己崩在半路）时，退回 `✗` 行——它至少比空集多。
  return lines
    .filter((line) => line.includes('✗'))
    .map((line) =>
      line
        .replace(/.*✗\s*/, '')
        .replace(/\s+←.*$/, '')
        .trim()
    )
}

/** 跑被测套件。通过/失败的分隔符是 `通过 44 / 失败 0`（斜杠）。 */
function runTests() {
  const out = spawnSync(
    'npx',
    ['tsx', '--tsconfig', 'tsconfig.test.json', 'scripts/test-mcp-server.ts'],
    { encoding: 'utf8', shell: true, maxBuffer: 32 * 1024 * 1024 }
  )
  const text = out.stdout + out.stderr
  const reds = parseReds(text)
  const total = /通过 (\d+) \/ 失败 (\d+)/.exec(text)
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
    : `${MUTATIONS.length} 个变异，基线跑一轮，每个变异再各跑一轮（每轮一分钟往上，整轮十几分钟）…`
)
const baseline = runTests()
console.log(`基线：通过 ${baseline.passed}，失败 ${baseline.failed}`)
if (baseline.failed !== 0) {
  console.error('基线不是全绿，先修好再来反证。')
  if (baseline.failed < 0) {
    console.error('（连「通过 N / 失败 M」那行都没解析到——多半是套件自己崩了）')
  }
  console.error(baseline.text.slice(-2000))
  process.exit(1)
}

let problems = 0

for (const m of selected) {
  let mutated = toLf(originals[m.file])

  // 逐条 edit 各自查命中次数。**命中次数一定要打出来**：只说「没命中唯一一次」的话，
  // 0 次和 2 次根本分不清（6 空格缩进的锚点是 10 空格缩进同款行的子串，踩过）。
  let bad = ''
  for (const edit of m.edits) {
    const hits = mutated.split(edit.from).length - 1
    console.log(
      `[${m.name}] 锚点命中 ${hits} 次（期望 1 次）：${JSON.stringify(edit.from.slice(0, 40))}`
    )
    if (hits !== 1) {
      bad = '期望 1 次 —— 变异没生效，结论无效（多半是源码重构过，锚点过期了）'
      break
    }
    mutated = mutated.replace(edit.from, edit.to)
  }
  if (bad) {
    console.error(`  ${bad}`)
    problems += 1
    continue
  }

  writeFileSync(m.file, mutated, 'utf8')
  const result = runTests()
  writeFileSync(m.file, originals[m.file], 'utf8')

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
    // 把原始输出尾巴贴出来：光看「一条都没红」分不清「变异是空操作」还是
    // 「套件崩在半路」，而这两种情况的修法完全不同（前者改变异，后者修套件）。
    console.log('  套件输出末尾：' + JSON.stringify(result.text.slice(-400)))
  }
}

// 收尾再确认源码确实还原了。**这一步不能省**：反证中途被打断（Ctrl-C、崩溃）
// 会留下一份改坏的源码，而它跑起来的样子和「改回来过」一模一样。
const dirty = Object.keys(originals).filter((f) => readFileSync(f, 'utf8') !== originals[f])
if (dirty.length > 0) {
  console.error('\n源码没还原干净：' + dirty.join(', '))
  process.exit(1)
}

// 把每个文件的 sha256 打出来：这条「已还原」的结论不该只有脚本自己说了算
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
