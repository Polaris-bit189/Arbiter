# 发布诊断：为什么上线十天没人看到

> 2026-09-26。§1–§2 的数字来自 GitHub API 实测；§4–§7 的 star 数、URL 与门槛由一轮专门调研核实（URL 均实请求验证）。复现命令见 §9。

---

## 0. 结论

**不是名字的问题。**

更准确地说：名字确实不好，但它不是瓶颈。有两件影响更大的事没做——**仓库 topics 是空的**，以及**你发布了但从来没有宣布过**。仓库创建于 2026-09-16，到今天 10 天。

---

## 1. 实测数据

| 项 | 值 |
| --- | --- |
| `created_at` | 2026-09-16 —— **10 天** |
| `pushed_at` | 2026-09-26（今天仍在提交） |
| stars / forks / watchers | **2 / 0 / 1** |
| open issues | 0 |
| **`topics`** | **`[]`（空）** ← |
| **`homepage`** | **`null`** ← |
| `has_discussions` | `false` |
| Releases | 3 个 |
| License / Language | MIT / TypeScript |

Release 下载量：

| tag | 发布日 | 资产数 | 累计下载 |
| --- | --- | --- | --- |
| v0.3.5 | 2026-09-26 | 3 | **0** |
| v0.3.4 | 2026-09-26 | 3 | **0** |
| v0.3.3 | 2026-09-17 | 3 | **6** |

v0.3.3 那 6 次下载是**零推广下的自然量**。这就是基线：9 天 6 次。

---

## 2. 名字：实测不是瓶颈

用 GitHub 搜索 API 实测（`/search/repositories`）：

| 查询 | 总结果数 | Arbiter 排名（best match） | 排名（按 star） |
| --- | --- | --- | --- |
| `file converter` | 23,322 | 未进前 100 | 未进前 100 |
| `local file converter` | 350 | **未进前 100** | 第 51 |
| `convert video audio image document` | 150 | **未进前 100** | — |
| `arbiter converter` | 2 | 第 1 | 第 1 |

坏的半边：对一个总结果只有 150 条、且精准描述你功能的查询，你进不了前 100。这是真的没被搜到。

但**这不能怪名字**：`local file converter` 精确命中了你的 description（`Local file converter for Windows: ...`），命中了却排不上去。缺的是别的排序信号——**topics 空**、star 只有 2。best-match 排序里 topics 是权重很高的字段。

名字确实贡献不了相关性（"Arbiter" 里没有任何查询词），但它只是若干信号之一；承载搜索的字段——description——**你已经写对了**。

更根本的一点：**没人用 GitHub 搜索找工具。** `file converter` 有 23,322 个结果，排第 1 也没多少流量。工具是被**推荐**出来的。

### 名字真实的代价（不在搜索，在两个别处）

1. **召回。** 你在帖子里说"用 Arbiter 转一下"，对方记不住；回头去搜，会落到别的项目上。GitHub 上至少有五个活跃同名项目：
   - `harnesslabs/arbiter` —— 以太坊沙盒（Rust EVM），`cargo install arbiter` 就是它
   - `vishk23/arbiter` —— 论文形式化验证
   - Go 生态的 arbiter —— 游戏引擎 / 锦标赛跑分工具
   - `flashliquidity-arbiter` —— DeFi 套利
   - `0xBakeer/arbiter` —— GPU 上跑决策模型
2. **目录站。** MCP / 插件目录里，名字就是主标签。

所以：**名字值得改，理由是召回和目录，不是搜索。** 时机见 §6.1，成本见 §6.2。

---

## 3. 已经做对的（不要动）

- **README 远高于平均水平。** `Convert anything, locally.` 一句话说清；"Why this exists" 讲的是**失败行为**而不是功能清单；"Why not HandBrake / Format Factory" 直接对着用户脑子里已有的选项说话；"Not planned" 一节把反复被提的东西写下来省得再吵一遍。**不要重写它。**
- description 的关键词密度是对的，package.json 的 `keywords` 也对。
- CI / SECURITY / CONTRIBUTING / ISSUE_TEMPLATE / CHANGELOG 双语——10 天的仓库有这些是少见的。
- **自建 marketplace 已经做完了。** `/plugin marketplace add Polaris-bit189/Arbiter` + `/plugin install arbiter@arbiter` 这条链路是对的——见 §7.2，它恰好是门槛最低的那条渠道。

### 3.1 一处需要收窄的判断

`docs/PLAN.md` §0 把定位从"格式转换器"改成"AI 原生开源工具"，方向对。但**"能做 MCP"本身不是护城河**——调研到的实情是：

```
MaitreyaM/FILE-CONVERTER-MCP     7★
aadilr/changethisfile-mcp        6★   (690+ formats)
ConvertAPI/convertapi-mcp        2★
hushvert/mcp                     1★
Nidhishpajni/file-converter-mcp  1★
vid-factory/convertagent         1★
```

**这个交叉点上已经站着一排人，只是全都 1–7 星。** 正确的读法是：**这个位置没人占住，而不是没人来过。** "又一个文件转换 MCP"不构成理由，也不自带流量。真正的空位在措辞上——见 §4。

---

## 4. 竞品与空位

star 数为 2026-09-26 实时值：

| 项目 | Repo | Star | 定位 |
| --- | --- | --- | --- |
| ConvertX | `C4illin/ConvertX` | **19,061** | **最直接的对手**。自托管在线转换器，1000+ 格式，Docker |
| VERT | `VERT-sh/VERT` | **15,639** | 250+ 格式，纯浏览器本地（WASM）。"fully local, free forever" |
| FileConverter | `Tichau/FileConverter` | **15,254** | Windows 右键菜单集成，2014 年至今 |
| Stirling-PDF | `Stirling-Tools/Stirling-PDF` | 93,026 | **只做 PDF** |
| pandoc | `jgm/pandoc` | 46,410 | **只做标记语言** |
| HandBrake | `HandBrake/HandBrake` | 24,501 | **只做视频** |
| markitdown | `microsoft/markitdown` | 187,080 | Office/PDF → Markdown，**RAG 预处理方向** |

两条对定位有用的读法：

**① 上面 15k+ 的项目里，没有一个以"给 AI agent 当转换层"为第一定位。** markitdown / Docling / MinerU / Marker 是"文档 → LLM 输入"，不是"转换格式"；ConvertX / VERT / FileConverter 是面向人的 GUI，MCP 是外挂。

**② 所以空位是有，但名称要精确。** 不是"又一个转换器 + 一个 MCP 壳"，而是**面向 agent 的原生转换层**——agent 能 inspect、能批量、能取消、能读回文档正文的那一层。你八个工具里的 `inspect_file` / `read_document` / `list_jobs` 正是这个意思，而竞品都没有。

⚠️ 但 §7.0 有一个结构性坏消息，会决定这个定位能不能落地到目录站上。

---

## 5. 按 ROI 排序的行动清单

### P0-a　补 topics（几分钟，今天）

`topics: []` 是实测里**唯一一个明确坏掉、且一改就好的输入**。它是 GitHub 分类浏览的唯一入口，也是 best-match 排序的高权重信号。2026 年 topic 页本身是 Google / LLM 答案的主要落点——冷启动阶段，topic 的选择比 README 的质量更早起作用。

建议（MCP 词吃 MCP 搜索流量；`claude-code` 竞争远小于 `mcp`）：

```
mcp, mcp-server, model-context-protocol, claude-code, claude-code-plugin,
file-conversion, file-converter, document-conversion, conversion,
ffmpeg, pandoc, cli, developer-tools, ai-agents
```

```bash
gh repo edit Polaris-bit189/Arbiter \
  --add-topic mcp --add-topic mcp-server --add-topic model-context-protocol \
  --add-topic claude-code --add-topic file-conversion --add-topic ffmpeg
```

### P0-b　补 homepage（一分钟）

现在是 `null`。指向 Releases 页即可。

### P0-c　放截图 / GIF，并加 social preview（一小时）

README 第 15 行现在是一条注释：

```
<!-- TODO: 录一段 10 秒 GIF 替换这一行（拖文件 → 转换 → 完成）。README 里最有说服力的就是它。 -->
```

**你已经知道该做什么了，而这是眼下最大的转化杀手。** 桌面 GUI 应用一张图都没有——没人会下载一个没露过脸的桌面应用。这一段的说服力高于 README 剩下的 300 行。

录法：拖三个**不同族**的文件（`.mkv` + `.docx` + `.rar`）→ 转换 → 完成。十秒，不要配音。

再加一张 **1200×630 的 social preview**，分享出去的链接才有官方感。

### P0-d　按"前 120 字符扛关键词"重写 repo description（十分钟）

```
File conversion for AI agents via MCP — video, audio, image, PDF, ebook and
archive, one tool call in Claude Code. Powered by ffmpeg/Pandoc/LibreOffice,
fully local, no upload.
```

### P1-a　开 Discussions（一分钟）

`has_discussions: false`。开了别人才有地方问，你也才有"有人在用"的公开痕迹。

### P1-b　正式宣布一次（这才是真正缺的那一步）

发布到 GitHub 不是分发，是托管。**你从来没有告诉过任何人它存在。**

关键是叙事，不是功能列表。钩子不是"又一个转换器"，而是：

> 一个 AI agent 能自己调用的本地文件转换器——不用上传。

功能清单没人转，这句话有人转。

### P2　改名（见 §6）

---

## 6. 改名

### 6.1 时机

**现在改是最后一次零成本的机会。** 0 fork、0 外部用户、`open_issues: 0`——没有任何人依赖这个名字。现在改和 10 天前改一样便宜；等有 100 star、有人把它写进脚本以后再改就不是了。

### 6.2 成本盘点

| 位置 | 内容 |
| --- | --- |
| `package.json` | `name` / `productName` / `description` / `homepage` / `repository` |
| 安装目录 | `arbiter.cmd`（README 第 113–114 行：它在 `Arbiter.exe` 旁边） |
| MCP | 工具命名空间（当前 `mcp__plugin_arbiter_arbiter__*`） |
| 插件 | `.claude-plugin/marketplace.json` 的 marketplace 名 + plugin 名 `arbiter@arbiter` |
| 斜杠命令 | `/arbiter:convert`、`/arbiter:formats`、`/arbiter:watch`、`/arbiter:read-document` |
| 文档 | README、docs/NOTES.md（162 KB）、CONTRIBUTING、`docs/` 五份 |
| 打包 | `electron-builder.yml`、`THIRD_PARTY_LICENSES.md` |
| 测试 | 二十个套件 + 一批 falsify 脚本里的名字断言 |

⚠️ 插件生态有一条硬约束（调研原文）：**用户以 `name@marketplace` 记录安装，改名对老用户等于换了插件。** 现在没有老用户，所以这是最便宜的时刻。

### 6.3 判据

新名字里要能一眼看到 `convert`（或格式词）。理由是召回——别人手打出来就能搜到。候选（仅供筛选）：`LocalConvert`、`FormatForge`、`ConvertAnything`。

---

## 7. 渠道清单

### 7.0 先说结构性坏消息

**主流 MCP 目录站要求的是"可打包的服务"，而 Arbiter 的 MCP server 是一个依赖本机 Windows 应用（含 ~2.4 GB 引擎）的启动器。**

- **官方 Registry**（`registry.modelcontextprotocol.io`）只存元数据，**要求你先有一个 npm / PyPI / NuGet / Docker Hub 上的包**。README 第 165–166 行已经写明 "A standalone npm package is not published yet, so there is no `npx arbiter-mcp` to point at." → 这是硬阻塞。
- **Glama** 要求把 Dockerfile 提交到它后台，CMD 必须是不含 URL 的本地 stdio server。
- **Smithery** 要 `.mcpb` bundle 或容器。

`plugins/arbiter/mcp/launch.mjs` 现在做的事是"找到本机已安装的 Arbiter，借用它的 Electron 跑 MCP 入口"——这在**插件**场景下完全正确，但它**进不了容器**。

**所以要么为 MCP server 单独发一个 npm 包（自带引擎发现、缺应用时优雅降级），要么放弃 MCP 目录站、走插件与 awesome-list 这条路。** 这是产品决策不是营销决策，我不替你定。§7.1 与 §7.2 两条路都列了。

### 7.1 如果做 npm 包：MCP 目录站

| 站点 | URL | 门槛 |
| --- | --- | --- |
| **官方 Registry** | registry.modelcontextprotocol.io | `mcp-publisher` CLI，**不接受 PR**。必须先有包，包内回写 `"mcpName": "io.github.<user>/<name>"`（npm）。⚠️ `description` 上限 **100 字符**，超了 HTTP 422 |
| Glama | glama.ai/mcp/servers | 免费，**自动抓取 + 从 Registry 导入**，可能你已经在上面了。要点 Claim（GitHub OAuth）+ 补 Dockerfile。**0–100 分（TDQS），低于 70 会被埋**；扣分项：无 LICENSE **−15**、工具描述含糊 **−10**、无 SECURITY.md **−5**、无 CI **−5** |
| Smithery | smithery.ai/new | `.mcpb` bundle 或容器。`smithery.yaml` 可 `runtime: "typescript"` |
| PulseMCP | pulsemcp.com/submit | **策展制**，规模刻意小（~1,200 条），每周从 Registry 自动拉取 |
| mcp.so | mcp.so/submit | 免费表单；$39 一次性可免审 + dofollow（免费档 nofollow） |
| mcpservers.org | mcpservers.org/submit | 免费表单，队列最长 2 周；$39 Premium 24h |
| mcp.directory | mcp.directory | 免费、全自动，只要 repo URL |
| MCP Server Finder / MCP Market | mcpfinder / mcpmarket.com | 免费 |
| **Cline Marketplace** | github.com/cline/mcp-marketplace | **开 issue**（非 PR）。要 GitHub repo URL + **400×400 PNG logo** + 确认"只给一份 README / `llms-install.md` 能装成功"。**无 star 门槛** |

**关于"哪些真带流量"——说实话：** 没找到任何一家公开 GA 数据。唯一可查的一手复盘（提交 27 个目录后写的）结论是：**第 1 周 27 个 PR 全部 open、0 merged**，并建议**跳过所有 $30–497 的付费目录**。不要靠"铺目录"获客。

### 7.2 更现实的一条路：Claude Code 插件生态

**你已经把自建 marketplace 做完了**，这条路的门槛最低。

| 渠道 | Star | 方式与门槛 |
| --- | --- | --- |
| **claude.ai/directory/manage** | — | Anthropic 官方开发者门户。**需要付费 claude.ai 计划**（Pro/Max 自己的账号即可）。前置：仓库公开 + `claude plugin validate --strict` 通过。**上线后给你按版本的安装量、listing 浏览量和"带来发现的具体搜索词"**——这是唯一能拿到真实转化数据的渠道，值得优先 |
| `punkpeye/awesome-mcp-servers` | **95,533** | 每条 entry **强制带 Glama score badge**，且 owner 必须在 Glama 上 claim。entry 必须用完整 `owner/repo` + 语言/范围 badge，分类内按字母序。💡 **AI agent 快车道**：PR 标题末尾加 `🤖🤖🤖` 可快速合并 |
| `hesreallyhim/awesome-claude-code` | **54,624** | ⚠️ **只收 issue 不收 PR**，且**一次只能推荐一个资源**。硬门槛：**首次 commit 起 ≥14 天**且持续有提交，**或 ≥100 star**。有冷却期（有人两次提交后进 30 天冻结）。维护者原话："If 'getting on the list' is any part of a promotional strategy for your project, you should be prepared to have a backup plan."<br>**→ 仓库 9-16 创建，9-30 满 14 天。这是日历上唯一有时间锁的渠道。** |
| `travisvn/awesome-claude-skills` | 15,182 | PR |
| `yzfly/Awesome-MCP-ZH` | ~6,800 | **中文列表**，接受中文描述 |
| `composio-community/awesome-claude-plugins` | 1,979 | PR |
| `ccplugins/awesome-claude-code-plugins` | 952 | PR。分类里正好有 **Audio & Media** 和 **MCP Servers**，两个都能塞 |
| `subinium/awesome-claude-code` | 117 | PR，几乎无门槛 |
| **`jgvictores/awesome-file-conversion`** | **4** | **性价比最高的一条**：仅 4★、几乎零竞争，定位就是"开源文件格式转换工具策展表"，受众精准 |

⚠️ `anthropics/claude-plugins-community`（4,412★）是**只读镜像**，由 Anthropic 内部流水线每晚同步——**直接开 PR 会被自动关闭**。

### 7.3 不要做的

- **别靠铺目录获客**：一手数据是 27 个 PR、0 个合并。
- **别买付费目录**（$30–497）：0 收入阶段 ROI 不成立。
- **`awesome-selfhosted` 大概率不符合**：它收的是"可自托管的网络服务 / Web 应用"，除非你提供一个 Docker 化的自托管 HTTP 形态。

### 7.4 建议的执行顺序

1. **今天**：topics + homepage + description + GIF → 开 Discussions
2. **同步**：按 §3.1 把对外措辞统一到"面向 agent 的原生转换层"
3. **本周**：`jgvictores/awesome-file-conversion`（4★，几乎零竞争）+ `ccplugins/awesome-claude-code-plugins`
4. **9-30 起**：`hesreallyhim/awesome-claude-code`（满 14 天）
5. **有付费 claude.ai 计划的话**：走 claude.ai/directory/manage，拿真实安装量数据
6. **决定 §7.0 那个产品问题**：发不发 npm 包
7. **最后**：改名

---

## 8. 一句话

你在"失败时的行为"上花了几个星期——探针、`.part` 重命名、杀进程树、falsify 变异测试——这些让工具**值得用**。

但"别人怎么知道它存在"，你还一分钟都没花。这两件事不互相替代。

---

## 9. 复现命令

```bash
# 仓库元数据
python C:/Users/Polaris/.claude/toolkit/fetch.py \
  "https://api.github.com/repos/Polaris-bit189/Arbiter" --json

# 下载量
python C:/Users/Polaris/.claude/toolkit/fetch.py \
  "https://api.github.com/repos/Polaris-bit189/Arbiter/releases" --json

# 搜索排名：注意 sort 口径（best match 测相关性，stars 测热度）
python C:/Users/Polaris/.claude/toolkit/fetch.py \
  "https://api.github.com/search/repositories?q=local+file+converter&per_page=100" --json
```

---

## 10. 行动清单（2026-09-26 定稿）

### 10.1 三条 §1–§9 没写、用 API 实量的结论

**① 对外说英文，发出去的产品是纯中文的。这是排第一的问题，而它推翻了 §5 的顺序。**

| 检查 | 结果 |
| --- | --- |
| `v0.3.5` tag 解引用 | → 提交 `ed5fe67` |
| `contents/src/shared/i18n?ref=ed5fe67` | **404** |
| `contents/package.json?ref=ed5fe67` | 读到了，`version = 0.3.5` |

同一条路能读到文件，所以那个 404 的含义是**目录真的不存在**，不是「提交找不到」。
当前公开仓 `main`（`3726103`）里 `src/shared/i18n` **存在**。

⇒ **P1（语言开关）和 P2~P6（全部英文）一次都没进过任何 release。** 今天全世界能下载到的
最新安装包，装完是一个没有语言选项的中文界面。

插件那半边同源且更隐蔽：`plugins/arbiter/mcp/launch.mjs:6` 自己写着「MCP server 的代码在
Arbiter 应用里（`out/main/mcp.js`），**不在这个插件里**」——所以 agent 今天拿到的八个工具
描述也是中文的。

好消息是这一条**不需要额外设计**：默认档就是 `language: 'system'`（`src/main/core/settings.ts:26`），
`app.getLocale()` 由 GUI 入口注入（`src/main/core/locale.ts:47`），`resolveLocale` 把它解成实际语言
（`src/shared/i18n/index.ts:69`）。**英文系统的用户首次打开自动就是英文。**

⇒ **出 0.3.6 是整条链的闸门，排在 topics 之前。§5 的 P0-b（正式宣布）必须等它**——
否则英文渠道来的第一批人（正是会把项目推荐出去的那一批）下载完看到的是中文。

**② 公开仓的提交日期每次快照都被重置。**

`D:\check\make-clean-copy.mjs` 每次 `git init` + 一个新提交，**不设日期**。今天公开仓 `main`
的 tip `3726103` 提交日期 = `2026-09-26T04:37:21Z`（今天），而仓库 `created_at` = `2026-09-16`。

⇒ §7.2 三条里唯一有时间锁的那条（`hesreallyhim/awesome-claude-code`，「首次 commit 起 ≥14 天」）
**若按提交日期判，每出一次快照就从头再数 14 天**——那条渠道永远差一天。
修法零代价：给那个提交钉 `GIT_AUTHOR_DATE` / `GIT_COMMITTER_DATE`。

**③ 插件门面三处全是中文**，而 §7.2 正是门槛最低、受众最准的渠道：

- `.claude-plugin/marketplace.json` 的 `description`
- `plugins/arbiter/.claude-plugin/plugin.json` 的 `description`
- `plugins/arbiter/README.md` 整篇

**④ 顺带两条可用的事实**

- **钩子换一个说法**：§3.1 实测「转换器 + MCP」这个交叉点已经站了一排 1~7★ 的项目。
  但「**Claude Code 读不了你的 .docx / .xlsx**」是一个具体、被大量人踩过、能搜到的痛点，
  而那个交叉点一个人都没有。刀已经在手上：`read-document` skill + `PreToolUse(Read)` hook
  + `read_document` 工具。
- **GIF 能全自动录，不用人拖**：`src/main/ipc/tasks.ts:111` 决定命令行进来的一批文件是
  **当场开跑**的，不只是入队。所以
  `ffmpeg -f gdigrab 录窗口 → Arbiter.exe a.mkv b.docx c.rar → 转完 → 停录 → palettegen/paletteuse`
  零人工、可重录。**代价是要占可见桌面约 30 秒、窗口会抢焦点。**

### 10.2 已定的决策

| 项 | 决定 | 直接后果 |
| --- | --- | --- |
| 名字 | **保留 `Arbiter`，只改「标签位」** | 仓库名 / 安装目录 / `arbiter.cmd` / MCP 命名空间 / 二十套测试的名字断言**零改动**；只改 5 处文案（GitHub description、marketplace.json、plugin.json、README 首屏、social preview） |
| npm 包（§7.0） | **先不发** | 放弃 MCP 目录站那一条链，走插件 + awesome-list。§7.1 的一手复盘（27 个 PR / 0 merged）本来也说明目录站不带量 |
| 门面语言 | **双语并列，不分主次** | 英文渠道（§7.2 七条）与中文渠道（`yzfly/Awesome-MCP-ZH`）复用同一份文案 |

⚠️ 保留名字意味着 §6 整节（改名的时机 / 成本 / 判据）**作废**。§2 那张表里
「`arbiter converter` 已排第 1」说明搜索那一侧本来就不欠——真正欠的是**目录站/列表里的标签位**，
而那里一个孤零零的 "Arbiter" 不自解释。

### 10.3 分阶段

**A. 现在就能做（不碰公开仓、与并行的插件线零冲突）**

1. 修 `D:\check\make-clean-copy.mjs`：给快照提交钉 `GIT_AUTHOR_DATE` / `GIT_COMMITTER_DATE`
2. 写 `plugins/arbiter/llms-install.md`（Cline marketplace 明确要求「只给一份 README / `llms-install.md` 能装成功」）
3. 从 `build/icon.png` 派生 400×400 PNG logo（同一条要求）

**B. 等并行的插件线跑完**（`plugins/arbiter/mcp/{update,updatePlan,asar,i18n}.mjs` 此刻仍在写）

4. 收口：`git status` 逐一核对 → `rm -f .eslintcache && npm run lint` → 全套件全绿 → 提交
5. **出 0.3.6**：快照 → push → tag → CI → 发包 → 发布 release ← **整条链的闸门**
6. 录 GIF + 截图 → 替掉 `README.md:15` 那个 TODO
7. 5 处标签位文案（双语并列）+ topics + homepage + repo description + 开 Discussions
8. social preview 1200×630（**没有任何公开 API**，得在网页上手动上传）

**C. 宣布**（渠道与文案等 B 落地再定稿）

**D. 不做**：npm 包、`falsify` 相关的一切改动（已全绿，别动）、§6 的改名。

---

## 11. 官方目录那一层（2026-09-26 调研，一手来源核过）

来源：`code.claude.com/docs/en/plugins/publish`、`claude.com/docs/plugins/platform-support`、
`claude.com/docs/connectors/building/review-criteria`、`claude.com/docs/directory/publish`。

### 11.1 门槛与现状

- 提交的是**插件**（不是 marketplace），走开发者门户 `claude.ai/directory/manage`；
  **需要付费 claude.ai 计划**（Pro/Max 用自己的账号就能提交）。
- 前置校验 `claude plugin validate --strict` —— **我们两边都已通过**（实测：
  `claude plugin validate ./plugins/arbiter --strict` 与 `claude plugin validate . --strict`
  都是 `✔ Validation passed`）。
- 官方 marketplace `claude-plugins-official` **不收**门户提交。
- 提交材料：公开 GitHub 仓（✓ MIT）、公开文档（README ✓）、测试凭据（本项目无鉴权，N/A）。

### 11.2 ⚠️ 但组件支持表说明这个 listing 在 chat 上是残的

`claude.com/docs/plugins/platform-support` 原文（一手）：

| 组件 | Chat | Cowork | Claude Code |
| --- | --- | --- | --- |
| Skills | Loads | Loads | Loads |
| Hooks | **Ignored** | Loads | Loads |
| **本地 MCP server**（应用自己启动的命令） | **Ignored** | 仅当 Cowork 会话跑在你本机 | Loads |
| `bin/` 里的可执行文件 | **Can't be installed**（整个插件被拒） | 同上 | Loads |

我们的插件 = 本地 MCP server + `PreToolUse` hook + 5 skills + 4 commands。⇒ **在 claude.ai
网页上，八个工具一个都不加载**，只剩 skills/commands；Cowork 上还要那台机器装着应用，
而应用**只有 Windows**。

✅ 已核实：插件里**没有顶层 `bin/`**（有的话 chat/Cowork 会拒装整个插件）。

⇒ 结论：目录 listing 对我们的价值主要是**给 Claude Code 用户看的一张门牌**，
不是「一次触达 claude.ai 全体用户」。别把它当成 §7.2 里的头号渠道。

### 11.3 🔴 那个理由的落点：`displayName` 就是「标签位」

官方原文：*"Set `displayName` in plugin.json for the label users see."*
而 §10.2 定的「保留 `Arbiter`、只改标签位」，在插件这一侧**最精准的落点就是 `displayName`**
（现在的 `plugin.json` **没有这个字段**）。

顺带两条官方的硬约束**佐证了那个决策**：

- *"Users install, enable, and configure your plugin by `name@marketplace`, so a **renamed
  plugin is a different plugin to every existing install**."*
- *"**Never change a published plugin's name.**"*（要改只能靠 marketplace 的 `renames` 映射）

### 11.4 ⚠️ `plugin.json` 的 `version` 是一根会静默失效的线

官方原文：

> If you set `version` in plugin.json and later push commits without changing it,
> `claude plugin update` prints `<name> is already at the latest version (1.0.0).`
> and **users keep the old copy**. Either increment `version` on every release,
> or omit it in a git-hosted marketplace so Claude Code uses the commit SHA instead.

我们**设了** `version: 0.3.5`，而 marketplace 是 git 托管的仓库。
⇒ **B5 出 0.3.6 时必须同步改 `plugins/arbiter/.claude-plugin/plugin.json` 的 version**，
否则已有插件用户**永远拿不到 P6 的英文工具描述**——他们停在旧副本上，而没有任何报错。

⚠️ 这一条与并行的那条线正在做的**自动更新功能直接相关**，交接时必须说。

### 11.5 🔴 调研中抓到一个真 bug：`convert_file` 的 annotation 标错了

`src/mcp/server.ts:268`：

```ts
registerArbiterTool(server, 'convert_file', {
  title: t('mcp.server.title.convertFile'),
  // 注释里写清楚为什么：这个工具会长时间占用（转视频可能几分钟），
  // 客户端据此才知道可以发取消。
  annotations: { readOnlyHint: true, idempotentHint: true }   // ← 说它是只读
}, async (args, extra) => {
    const outputPath = args.output_path === undefined ? undefined
      : resolveWritePath(deps.gate, args.output_path, deps.cwd)  // ← 同一个函数里走的是写闸门
```

八个工具里**只有它一个标错**（对照：`batch_convert` = `{readOnlyHint:false,
destructiveHint:false}`，`cancel_job` = `{readOnlyHint:false, destructiveHint:true}`），
而它恰恰是唯一会往用户盘上落产物、也是最重要的那个。

**后果（官方原文）**：

> Every tool must include a `title` and the applicable hint … **These determine
> auto-permissions in Claude.** Read-only tools can run **without per-call
> confirmation**, and destructive tools always prompt.

⇒ 一个 agent 可以在允许的根之内往用户盘上写文件而**不弹确认**。这与本项目路径闸门的立意
正相反（README 原话：*an MCP tool hands an agent filesystem access, and that deserves
better than an assumption of good faith*）。

**为什么它活到今天**：`grep readOnlyHint scripts/` → **零命中**。这三个 hint 在整套测试里
**没有任何断言**，所以标错了不会有任何地方红。这是「调研顺带挖出代码缺陷」的一次，
也说明这一族元数据需要补断言 + 反证。

**修法建议**：`{ readOnlyHint: false, destructiveHint: false }`，与 `batch_convert` 同类
——两者都是**增量写入、不删不覆盖**（`convert_file` 对已存在的 `output_path` 是**拒**
而不是覆盖，见 `docs/NOTES.md` 约束 33）。
⚠️ 另一条路是标 `destructiveHint: true` 让它**每次都弹确认**，但那样批量转换会很烦人。
这是取舍，需要拍板。

### 11.5b ✅ 已修（2026-09-26）——而且做成了**结构上写不出来**

改的不是那一行（改那一行下一个人还会标错），是**那一层**：

- `schema.ts` 新增 `TOOL_ACCESS: Record<ToolName, ToolAccess>`（`read` / `add` / `destroy`）
  与唯一的映射 `ACCESS_HINTS`。**调用点不再写 `annotations:`**——`registerArbiterTool`
  按 `name` 取，和 `TOOL_DESCRIPTIONS` 完全同形。三种等级的 hint 组合只有三种写法，
  写不出「只读 + destructive」这种自相矛盾的东西。
- `convert_file` → `add`（**这是那个修复本身**），`batch_convert` → `add`，
  `cancel_job` → `destroy`，其余五个 → `read`。
- `read_document` 定为 `read` 是**有意的取舍**：它在系统临时目录落中间产物，
  但从不写用户的输出目录。判据取「会不会动用户的文件」，不是「有没有碰过磁盘」。
- ⚠️ 另一种做法（把 `access` 写在调用点）**当场被我否掉了**：那就等于在 `TOOL_ACCESS`
  之外又造一份真相，正是这个仓库最忌讳的漂移形状。

**断言（原来一处都没有）**：

| 在哪 | 钉什么 |
| --- | --- |
| `test-mcp-view.ts` A2 节（新增 5 条） | 表本身：键集与工具名一致；**非只读工具恰好是那两个 + convert_file**（双向都比，加新工具忘了归类会红）；`convert_file` 是 `add`；三种映射；没有自相矛盾的组合 |
| `test-mcp-server.ts` 3b/3c（新增 2 条） | **接线**：真起服务端问 `tools/list`，看**发出去的**是什么。3b 管「会写盘的不自称只读」，3c 管「只读的都自称只读」（少了 3c，把 `annotations` 整个删掉也会绿） |

**反证（新增 3 条变异，全部实跑命中）**：

- `convert_file` 等级改回 `read` → 翻红 2 条（A2 的那两条）✓
- **`server.ts` 不按表派生、改回手写 readOnly** → 翻红 1 条（3b）✓ ——
  这一条是配套的关键：分类表没被动过，所以只钉表的断言**照样全绿**，
  只有真问一次 `tools/list` 才抓得住。
- 顺带修好了原有那条「说明书接线退回写死的键」的锚点（我重写 `registerArbiterTool`
  时它**命中 0 次**）——`npm run test:anchors` 五秒就报出来了。

⚠️ **另一处缺口顺手补上**：`falsify-mcp.mjs` 原先**只跑 `test-mcp-server.ts`**，
于是 `test-mcp-view.ts` 那 190 多条断言**一次反证都没被跑过**。现在两支一起跑
（并要求**两支都打出汇总行**，否则「某一支整个崩了」会伪装成干净的全绿）。

验收：`test:mcp-view` 198/0（+5）· `test:mcp` 221/0（+2）· 锚点 217/217 ·
typecheck 0 · 我改的 5 个文件 lint 0 error 0 warning。

### 11.8 ⚠️ 执行 P0-d 时踩到的坑：改 description 会**静默丢掉搜索命中**

`§5 P0-d` 提议把 repo description 换成
`File conversion for AI agents via MCP — video, audio, …`。
照抄之后实测（同一套 §2 的查询，改前/改后）：

| 查询 | 文档基线 | 照 P0-d 改完 | 修正后 |
| --- | --- | --- | --- |
| `arbiter converter` | 2 条 / **第 1** | **1 条 / 我们不在里面** | 2 条 / 第 1 ✓ |
| `local file converter` | 350 / 按 star **第 51** | 349 / **未进前 100** | 350 / 第 51 ✓ |

根因：GitHub 按**词**匹配，而新句子里是 `conversion`，**没有 `converter`**——
我们整个掉出了这两个结果集。**§5 那一版建议本身就带着这个 bug。**

（顺便，§2 说「description 你已经写对了」是对的——它是有 `converter` 的。）

现用的版本：开头就是 `Local file converter for Windows with an MCP server`，
把 §2 实测过的关键词放在最前面。

⚠️ **没被证实的一条**：改完 topics（15 个）之后，`local file converter` 的
best-match **仍然未进前 100**，与改前一样。所以 §2 那句「topics 是 best-match 的高权重
信号」**这次没有观测到**（可能索引未跟上，也可能不成立）——它现在只是一条未验证的说法。

### 11.6 GIF / 截图的可行性（本机实测）

- `ffmpeg-static` 自带 `gdigrab`：`ffmpeg -devices` 里有 `D gdigrab GDI API Windows frame grabber`。
- **全屏抓**：实测成功，2560×1600 PNG。
- **按窗口标题抓**：实测成功 —— `-i title="Program Manager"` 抓到 16416 字节的 PNG。
  ⇒ 录 GIF **可以只录应用窗口**，不必录整个桌面。
- 命令形状：`ffmpeg -f gdigrab -framerate 10 -i title="<窗口标题>" -t <秒> -y rec.mp4`
  → `palettegen` / `paletteuse` 出 GIF。
- **未验**：应用窗口的确切标题（要起了应用才知道）。
- ⚠️ 仍要用户点头：录的时候窗口会抢焦点、占屏幕约 30 秒。

### 11.7 两条「将来可能被判不适合」的风险（现在没事）

- **`Unsupported use cases`**：*"Generate images, video, or audio through AI models"* 不被接受。
  我们是**转换**不是生成，且一个模型都不调 ⇒ 现在没问题。
  但 README 的 Roadmap 里「On-device AI」那三项（超分 / OCR / 语音转字幕）**将来可能被
  审核模式匹配**成「AI 生成媒体」。真要动那三项时，先想清楚措辞与提交策略。
- **`API ownership`**：*"Your server must call your own first-party APIs … The MCP server
  domain should match your service."* 我们**不调任何远程 API**（纯本地二进制），这条不适用；
  但审核员会问「它到底调了谁的 API」——README 现在答得出来：ffmpeg / pandoc / LibreOffice /
  Calibre / 7-Zip，全在本机、按需从官方源下载。

---

## 12. §7.2 那份渠道名单的实测复核（2026-09-26，逐仓用 API 核过）

⚠️ **§7.2 有五条判断是错的或过期的**，下面按「还能不能投」重排。

### 12.1 四处更正（§7.2 与实测不符）

| 渠道 | §7.2 的说法 | 实测 |
| --- | --- | --- |
| `jgvictores/awesome-file-conversion` | **「性价比最高的一条」** | ❌ **死仓库**：4★、`pushed_at` **2018-01-06**、无 CONTRIBUTING、无 LICENSE、唯一的 PR 是 closed 未合并。投了等于留一条无主 PR |
| `subinium/awesome-claude-code` | 「PR，几乎无门槛」 | ❌ README 首屏写着 **`Only repositories with 1,000+ stars are listed`**；建仓至今**合并 0 个 PR**、5 个月无提交 |
| `travisvn/awesome-claude-skills` | 「PR」 | ❌ **已停收**：5 个月无提交、建仓至今只合过 1 个 PR、840 条积压。门槛里还有一条 `if your skill hasn't acquired a basic 10 stars, it will be closed`，以及**明文禁止 AI 代提** |
| `punkpeye/awesome-mcp-servers` | 「entry 强制带 Glama badge」 | ⚠️ **CONTRIBUTING 里一个字都没提 Glama**（所以从文档看是假的），但**机器人在硬卡**：标签 `has-glama`(6268) / `missing-glama`(5727)，带 `missing-glama` 的 PR **全在挂着没合**。⇒ 事实上的强制项，只是没写进文档 |

### 12.2 两条被证实的

- **`hesreallyhim/awesome-claude-code`「只收 issue 不收 PR」+「一次只能推荐一个」** —— 确认，
  且原文更重：*"ALL RECOMMENDATIONS MUST BE MADE USING THE WEB UI ISSUE FORM TEMPLATE, OR YOU
  RISK BEING RESTRICTED FROM INTERACTING WITH THIS REPOSITORY TEMPORARILY."*
  还有一句：**`gh` CLI 提交不了**，必须走网页表单。
- **`anthropics/claude-plugins-community` 是只读镜像** —— 确认。官方投稿口是
  **`https://clau.de/plugin-directory-submission`**（走 Anthropic 内部审核流水线，无 star / 天数门槛）。

### 12.3 ⚠️ 两条结构性的（比「投哪家」更该先解决）

**① Glama 是一道我们过不去的闸 —— 而它卡着 95,534★ 那个列表。**

`punkpeye` 的机器人要求先「在 Glama 上线并通过全部检查」（要提交 Dockerfile），
而 Glama 用 **Linux/Debian 容器**构建 + introspection。

我们的启动器在找不到应用时是 **`process.exit(1)`**（`plugins/arbiter/mcp/launch.mjs:65 / 71 / 85`，
三处都是）——它在容器里**一句话都不说就退出**，introspection 必然失败。

⇒ **§7.0 那条结构性阻塞比文档写的更宽**：不只是官方 Registry，最大的 MCP 列表也一起卡住。

> ⚠️ **区分事实与推断**：机器人要求、徽章格式、`missing-glama` 卡合并 —— 实测。
> 「Arbiter 过不了 Glama 构建」是**推断**（旁证：Glama 用 Linux 容器；未实测）。
> **先花 10 分钟去 glama.ai 提交一次看构建结果，再决定这个 PR 值不值得写。**

**一条便宜的中间路线**（比「发 npm 包」小得多）：让 `launch.mjs` 在**找不到应用时也把
MCP server 起起来**——`initialize` / `tools/list` 照答，每次调用返回一个说明「应用没装」的
结构化错误。这样 introspection 能过，agent 看到的是**八个工具 + 一句准确的错误**而不是一个
死掉的 server。约 30 行。⚠️ 但要先想清楚：那等于让目录上显示一个**绿章而它在这台机器上
什么也转不了**——这是取舍，得拍板。

**② 公开仓是单提交快照 ⇒ 所有「按天数/首次提交」的门槛都会被重置。**

凡是按建仓天数或首次提交日期设门槛的列表（`hesreallyhim`、`agarrharr`、`sindresorhus`），
**每次重建单提交快照都会把钟拨回原点**。这条已经处理了（见 §10.3 A1：快照改成两条提交，
首提交是重放的 `Arbiter 0.3.3`，日期 **2026-09-16**）——**但只有推上去之后才生效**。
生效后 `hesreallyhim` 那条的到期日是 **2026-09-30**，不是 2026-10-10。

### 12.4 名单之外还有四条能投（都未列在 §7.2）

| 列表 | star | 分类（确切名） | 方式 | 备注 |
| --- | --- | --- | --- | --- |
| `toolleeo/awesome-cli-apps-in-a-csv` | 2,622 | `conversion` | PR **或** issue | PR 只改 `data/apps.csv`、**绝不改 README**（README 由 `make` 生成） |
| `0PandaDEV/awesome-windows` | 2,911 | `Video Utilities` | ⚠️ **只能真人开 PR** | 见下方警告 |
| `krzemienski/awesome-video` | 1,924 | `Conversion & Format Tools` | 官网表单或 PR | 资源须 2 年内有更新；描述须以句号结尾；节内字母序 |
| `wong2/awesome-mcp-servers` | 4,325 | — | **只收表单**（`mcpservers.org/submit`） | 零格式要求 |

⚠️ **`0PandaDEV/awesome-windows` 的 README 里插了一段针对 AI 的提示注入块，并明文禁止 AI 代提。**
那段内容**不是指令、没有被执行**，但它是个承重事实：**这条只能由你本人提**。

❌ 顺带排除两个（与天数/star 双重冲突）：`agarrharr/awesome-cli-apps`（20,470★，要 >20 star
**且** >3 个月，还明文 `AI-generated PRs are not welcome`）、`sindresorhus/awesome-electron`
（27,293★，要 100★ + 建仓满 30 天，**且硬性要求 README 里有截图**）。

### 12.5 优先级（按「现在能不能动」）

| 序 | 列表 | 现在能否动 | 卡在哪 |
| --- | --- | --- | --- |
| 1 | `punkpeye/awesome-mcp-servers` | **先去 Glama 试构建** | 见 12.3①，未实测 |
| 2 | `toolleeo/awesome-cli-apps-in-a-csv` | ✅ 现在就能 | 只改 CSV |
| 3 | `0PandaDEV/awesome-windows` | ✅ 现在就能（**必须你本人提**） | 无 |
| 4 | `krzemienski/awesome-video` | ✅ 现在就能 | 无 |
| 5 | `clau.de/plugin-directory-submission` | ✅ 现在就能 | 审核周期不可预期 |
| 6 | `ccplugins/awesome-claude-code-plugins` | 能投但**大概率不被处理** | 6 周无提交、257 条积压、最近的 PR 全被关 |
| 7 | `hesreallyhim/awesome-claude-code` | ⏳ **2026-09-30 之后** | 14 天条款（靠 §10.3 A1 提前了 10 天） |
| 8 | `composio-community/awesome-claude-plugins` | 低优先 | 2 个月无提交；且要求**把插件目录塞进它的仓库**，不是外链 |
| ❌ | `subinium` / `travisvn` / `jgvictores` | **别投** | 分别卡 1000★ / 已停收 / 死了 8 年 |

### 12.6 顺带印证了 GIF 的必要性

`sindresorhus/awesome-electron`（27k★）**硬性要求 README 里有截图** ——
所以 `README.md:15` 那个 TODO 不只是「转化杀手」，它同时是几道门槛的**前置条件**。

---

## 13. 中文渠道（2026-09-26 调研）

⚠️ 可达性先说清楚：`www.v2ex.com` 本机不可达，V2EX 那部分读的是镜像 `global.v2ex.co`
（标「一手（经镜像）」）；**`linux.do` 全站不可达**（含真浏览器），第 13.4 节**全是二手**。

### 13.1 ⚠️ 最重要的一条：两条独立的调研线都撞上同一堵墙

- **awesome-list 那条线**（§12）：`hesreallyhim` 要 14 天或 100★；`subinium` 要 1000★；
  `agarrharr` 要 >20★ 且 >3 个月；`sindresorhus/awesome-electron` 要 100★ + 30 天。
- **中文这条线**：`yzfly/Awesome-MCP-ZH` 2026-09-20 批量关闭 20 多条 PR，**拒收理由逐条写着**：

  > PR #583：**「仓库创建于提交 PR 前一天、0 star、仅 1 次提交」** …
  > PR #555：「仓库目前 **2 star、无第三方验证**」「属于夸大宣传」

  我们公开仓的现状：**2026-09-16 建仓、2 star、0 fork**——**逐条吻合。**

⇒ **这从另一个方向证明了整个计划的顺序是对的**：先宣布、先攒使用沉淀，列表才打得开。
**`yzfly` 现在别投**，投了大概率被拒还留一条记录。等有 issue / star / 用户反馈之后再提，
提的时候把「**从哪装、装完敲什么命令验证**」写进 PR 正文（它的收录标准明确接受
「可执行命令」这条路，别让对方去猜）。

### 13.2 只做两个的话：**先 LINUX DO「开源推广」，再 V2EX「分享创造」**

**LINUX DO** —— 中文圈 Claude Code / MCP **浓度最高**的地方（有 `#mcp` 标签页）。
它的「开源推广」只有两条门槛，而**两条我们现在就满足**：

1. 完整开源、无未开源部分（MIT ✓）
2. **在项目里链接认可 LINUX DO**（README 加一条友链即可）

⚠️ 但有一条硬规矩：**商业推广帖明确禁止 AIGC 内容；用了 AI 就必须截图披露。**
发帖模板里有一项必勾：*「我帖子内的项目介绍，AI 生成、润色内容部分已截图发出」*。
⇒ **这条渠道的文案必须人手写**，或者老老实实披露。

**V2EX「分享创造」** —— 文化契合度最高（官方节点页原文：*「非常欢迎独立开发者把他们的新作
发布到这里……可以为你获得第一批用户」*；现况 37,036 主题 / 6,204 收藏，首页大量开源自荐帖）。

⚠️ **但它有一个前置条件必须先确认：账号。**

- 2024-05 之后**通过 Google 注册的新账号，需要用邀请码激活**
- 邀请码 = **1 金币 = 10,000 铜币**，而新号初始只有 **100 铜币**
  ⇒ **新用户自己换不出邀请码**，只能找已有会员生成
- 「分享创造需注册满 30 天」这条**没找到官方原文**，只有用户实测报告（二手、但证据一致）
- 铜币成本：发主题 ≥20、回复 ≥5（**回复的铜币转移给主题作者**，所以有人回帖是在回血）

⇒ **没有 ≥30 天的 V2EX 老账号的话，这条通道现在打不开。**

### 13.3 ⭐ 一条不在任何名单里、但证据最强的渠道

**阮一峰《科技爱好者周刊》** —— 三个**互相独立**的一手复盘（BOSS 抓取工具 / Catime /
PocketMocker）都点名它。其中 BOSS 那篇给了 GitHub Traffic 后台截图：

| 渠道 | 访问 / 独立访客 |
| --- | --- |
| **阮一峰周刊** | **1,192 / 896**（单日 +278 star） |
| Linux.do | 468 / 306 |
| 知乎 | 123 / 50 |

**在所渠道里最高**，且明显高于另外两个。**如果只加一个中文渠道，加它。**

### 13.4 其余中文平台的结论

| 平台 | 结论 | 依据 |
| --- | --- | --- |
| **少数派** | ✅ **官方明文欢迎自荐**：*「我们允许独立产品的创作者借助少数派的平台自我宣传，并愿意为其中有潜力的产品提供进一步的帮助和支持。」* 代价：要写 **2000~4000 字的数字生活视角**文章（手册明说**不登载高度专业化技术内容**），编辑部尽力 3 个工作日内答复 | 一手（《少数派创作手册》，2026-09-18 更新） |
| **B站** | ⚠️ 天花板最高（推荐流不看粉丝量，实测 552 粉 → 6.4 万播放），且当下最烫的品类正是 Claude Code / MCP（单条教程 190 万播放）。**但直接竞品「飞鼠格式」（6,000+ star、本地转换器、简介直贴 GitHub）两天只有 93 播放** ⇒ **纯功能演示型出局，必须做成「我为什么做它」的创作者叙事**。列第二轮 | 一手（view + card API） |
| **掘金** | ⚠️ GitHub 链接合规（会被包成 `link.juejin.cn` 中间页），但**量级只有三位数**：实测 5 篇「我开源了个工具」类文章阅读数 112 / 151 / 710 / 2711 / 0。要掘力值 ≥5000 才自动进推荐 | 一手 |
| **知乎** | ⚠️ 流量来自搜索推荐而非关注流；合规导流只有三条（知+ 卡片 / 专业号 / 付费咨询）**全要企业资质或钱**，个人开源作者一条都用不上 | 二手 |
| **即刻** | ❌ **直接跳过**：2024 年推荐榜 1716 条里**零个开发者工具**；新号不挂圈子实测 0 赞 0 评 0 转 | 一手 |
| **LobeHub MCP 市场** | ⭐ 中文 MCP 受众覆盖面最大的**单一**目录：「探索 **102,259 个 MCP Servers**」，中文界面。比任何 git 列表都大，**但需要它自己抓取 / 收录** | 一手（页面原文） |
| `MCPStar/Awesome-Official-MCP-Servers` | ❌ 搜索引擎排位很前，**实际 2 star、停更一年**，别投 | 一手 |
| `superpowers-zh` 配套 QQ 群 | ❌ 只收「AI 编程工作流方法论」类 skill，格式转换器不符合定位 | 一手（README 原文） |

### 13.5 中文没有官方 Claude Code 社群

查不到 Anthropic 的中文社群（中文站不存在）。民间最接近的三个都**拿不到一手成员数**
（未登录抓不到群人数）——**凡是看到的「XX 群有 N 人」基本都是转述，别当真。**

### 13.6 需要你回答的一个问题

**V2EX 账号**：你有注册满 30 天的 V2EX 老账号吗？没有的话第 13.2 条那条路现在打不开，
第二发要换成**少数派**（但那要你写一篇 2000~4000 字的文章）。

### 13.7 ⚠️ 三条没核实到的，如实记下

- `linux.do` 全站不可达 ⇒ 13.2 里 LINUX DO 的规则**全部是二手**（官方运营帖的搜索摘要 +
  DeepWiki 汇总），**发布前必须自己去它的规则页核一遍**。
- V2EX「分享创造需注册满 30 天」**没有官方原文**（帮助页 / FAQ / 节点指南里都没有）。
- 知乎《垃圾广告信息细则》逐字原文抓不到（403），现为二手转录。

---

## 14. 约束代入后的渠道重排（2026-09-26 定）

### 14.1 两条约束

用户已答（2026-09-26）：

1. **没有 V2EX 账号**（或不记得 / 新号）⇒ §13.2 那条通道**打不开**（邀请码 = 10,000 铜币，
   新号只有 100 铜币）。
2. **只做零人工的渠道** ⇒ **少数派**（要 2000~4000 字长文）、**B站**（要视频）、
   **LINUX DO 开源推广**（明文禁 AIGC，文案得人手写）**全部出局**。

⇒ §5 的 **P1-b「正式宣布」在很大程度上作废了**，而 §0 的结论恰恰是「你发布了但从来没有
宣布过」。**这个取舍的代价要说清楚，但不必因此改变计划**——因为证据最强的那条中文渠道
（§13.3 阮一峰周刊）**恰好是零人工的**，而且下面还新挖出两条。

### 14.2 ⭐ 阮一峰周刊 —— 零人工可达，且证据最强

- 仓库：`ruanyf/weekly`，**104,717★**、`has_issues: true`、`pushed_at` 2026-09-19。
- **投稿方式 = 提交 issue**（README 第 5 行原文：*「欢迎投稿文章/软件/资源，请[提交 issue]」*）。
  没有 issue 模板，自由格式 ⇒ **一个 agent 就能投**。
- ⚠️ **一个差点误判的坑**：第 412 期标题是「禁止 issue，只用 PR」——**那不是周刊的政策**，
  是它转载的一篇文章讲的 **Laravel** 的新规定。那篇正文里自己就写着「本杂志开源，欢迎投稿
  （链到 issues）」。**README 与第 412 期正文双重确认。**
- ⚠️ 但它是**选登制**，且开着 **9,228 条** issue。投一次很便宜，别指望必中。

### 14.3 ⭐ LobeHub MCP 市场 —— 近乎零人工，但有两下必须人点

- 规模：`lobehub.com/zh/mcp` 页面原文「探索 **102,259 个 MCP Servers**」，中文界面。
  **中文 MCP 受众覆盖面最大的单一目录。**
- **它是 agent 原生发布**：页面直接写「把这段提示词发给你的 Agent……`Read
  https://lobehub.com/publish-mcp/skill.md`」。
- ⚠️ 但 skill.md 里三条硬约束：
  1. **`lhm login` 与 `lhm github connect` 必须人在浏览器里点**（原文：*"Never try to
     automate or bypass them"*）——**两下点击，不是内容创作**。
  2. `lhm plugin init --stdio "…"` **要起一个真的 MCP server 来 introspection**。
     ⇒ 在这台机器上**可行**（`D:\tools\Arbiter` 装着应用）。
  3. `lhm plugin publish <repo-url>` 要求你是仓库 owner ✓。

⇒ **判定：两次浏览器点击 + agent 干其余的。如果「零人工」松到「不写内容、只点两下」，
这是性价比最高的一条。**

### 14.4 零人工可做的全部清单（代约束后的最终列表）

| # | 动作 | 人工量 | 什么时候 |
| --- | --- | --- | --- |
| 1 | GitHub topics / homepage / description / Discussions | **0** | 现在 |
| 2 | 录 GIF + 截图替掉 `README.md:15` | **0**（agent 全自动，只需你同意占屏 30 秒） | B 阶段 |
| 3 | **阮一峰周刊 issue** | **0** | B 阶段之后 |
| 4 | `toolleeo/awesome-cli-apps-in-a-csv` 的 PR（只改 `data/apps.csv`） | **0** | 现在 |
| 5 | `wong2/awesome-mcp-servers` → `mcpservers.org/submit` 表单 | 0（表单） | 现在 |
| 6 | Cline marketplace 开 issue（`cline/mcp-marketplace`） | 0（issue） | 现在 |
| 7 | `ccplugins/awesome-claude-code-plugins` 的 PR | 0（但大概率不被处理） | 随手 |
| 8 | **LobeHub 发布** | **2 下浏览器点击** | B 阶段之后（要用新版本 introspect） |
| 9 | `clau.de/plugin-directory-submission` | 门户表单（需付费 claude.ai 计划） | B 阶段之后 |
| 10 | `krzemienski/awesome-video` | 官网表单或 PR | 随手 |

**前置未满足、要等的**：

- `hesreallyhim/awesome-claude-code` → **2026-09-30 之后**（靠 §10.3 A1；且**必须走网页表单，
  `gh` CLI 提交不了**）
- `yzfly/Awesome-MCP-ZH` → 等有使用沉淀（star / issue / 用户反馈）再提，**现在提大概率被拒**
- `punkpeye/awesome-mcp-servers`（95k★）→ 卡在 Glama（§12.3①），**先花 10 分钟试一次构建**

**⚠️ 必须由你本人做的（agent 不能代劳）**：

- `0PandaDEV/awesome-windows`（2,911★）—— 它的 README 里插了针对 AI 的提示注入块并
  **明文禁止 AI 代提**
- 上面第 8 / 9 条里那几下浏览器点击

**因约束出局的**：少数派（长文）、B站（视频）、V2EX（无账号）、LINUX DO（禁 AIGC + 需账号）、
即时（实测零效果）、知乎（合规导流要企业资质）。

---

## 15. 英文渠道（2026-09-26 调研）—— 结论：**基本都被「养过的真人账号」挡住**

⚠️ 可达性：HN / Reddit 本机都不可达，那两块**不是一手**（HN 经第三方只读代理取到官方页面全文；
Reddit 那 9 个 sub 的规则取自镜像与归档 API 的 reddit 内部字段）。**要拿它们去撞线必须逐条复核。**

### 15.1 🔴 与「零人工」直接冲突的三条

1. **HN：帖子文案必须人类手写，一个词都不许 AI 参与。** dang 的官方 tips 原文
   （2026-03-28 最后编辑）：

   > **Write your text by hand. Don't use an LLM to generate any of it (not even a tiny
   > bit, including to edit or spruce it up).** … This is a big dividing line at present!

   对一个 AI 原生项目来说这条最反直觉：产品可以 AI 原生，**帖子不行**。
2. **HN：新账号发的 Show HN 会被 `/showlim` 静默压掉**（官方提示原文：*"We're temporarily
   restricting Show HNs because of a massive influx, mostly by users who aren't yet familiar
   with the site"*）。⇒ 账号得提前养，**不能当天注册当天发**。
3. **Reddit：`r/ClaudeAI` 有一条 `Posts on the feed now require OP karma > 100`**；
   `r/software` 有一套**保密 karma 阈值**；`r/selfhosted` 有 AI 合规机器人（不回复就删帖）。

⇒ **这三条加起来，英文社区这条路的头一公里全在「人」身上**，与 §14.1 那条约束冲突。

### 15.2 ⭐ 但有一条**真正的零人工**高杠杆渠道：官方 MCP Registry

`registry.modelcontextprotocol.io`（状态 preview）。**审核极宽**（moderation policy 原文：
*"The MCP Registry is quite permissive! We only remove illegal content, malware, spam, and
completely broken servers."*），而且它是**上游**——PulseMCP 的暂停公告逐字写着
*"publish it to the Official MCP Registry … **and we will pick it up automatically**"*。

⚠️ **挡路的是校验不是审核**：Registry 只存元数据，要求安装方式**公开可得**——
npm / PyPI / NuGet / Cargo / Docker-OCI / **MCPB**，或一个公网可达的 remote URL。
我们的 server 藏在 Electron 应用里 ⇒ **按现状登记不进去**。三条路：

| 路 | 代价 | 备注 |
| --- | --- | --- |
| **(a) 发一个薄 npm 包** | 中 | 把 `launch.mjs` 那套「找到应用 → `ELECTRON_RUN_AS_NODE` 拉起入口」包一层，加一行 `"mcpName": "io.github.Polaris-bit189/arbiter"`。**这正是 §7.0 的那个产品决策** |
| **(b) 打一个 `.mcpb` 挂到 GitHub Releases** | 小 | MCPB = zip + manifest；要求 URL 里含 "mcp" 且带 `fileSha256`。**绕开发 npm 包** |
| (c) 将来的远程版 | — | 走 `remotes` |

⇒ **用户先前否掉的是 (a)「发 npm 包」。 (b) 是同一目的的更便宜版本，值得重新摆上桌。**

### 15.3 两条被一手文档证实的（与 §11 一致）

- **`claude.ai/directory` 的 connector 那条门对本地 server 是关的**，官方原文：
  *"desktop extension listings in the directory are deprecated, and the directory no longer
  accepts local servers packaged as MCP Bundles (MCPB). To distribute a local server through
  the directory, **include it in a plugin**."* ⇒ 插件那条路是唯一的 ✓
- **`punkpeye/awesome-mcp-servers` 是活的**：95,534★、近 60 天 closed PR 1,221 / merged 1,011
  （**~83% merge 率**），且 CONTRIBUTING 明文欢迎 agent PR（`🤖🤖🤖`）。
  但 Glama 徽章由机器人硬卡（见 §12.1），而 Glama 会在容器里**跑你的 stdio 命令**做
  introspection —— 与 §12.3① 是同一道闸。

### 15.4 一条调研顺带产出、对**所有**渠道都成立的事实

**标题写哪一面，预期量级差两个数量级。** 按措辞抽样 Show HN 的高分样本：

| 措辞 | 抽样到的头部 |
| --- | --- |
| `mcp server` | 298 / 256 / 229 / 213 分 |
| `claude code` | 616 / 524 / 397 / 337 分 |
| `ffmpeg` | 420 / 342 / 179 / 88 分 |
| **`file converter`** | **6 / 4 / 3 / 2 分** |

⚠️ 这是**按 relevance 取的前几条，不是随机样本**，只能作定性对照。
但方向与 §3.1 一致：**「文件转换器」这个词在 HN 上是死的，「agent 能驱动」那一面是活的。**
⇒ §4 定的钩子（「Claude Code 读不了你的 .docx」）方向是对的，**别在任何渠道上用
「file converter」当第一句**。

### 15.5 明确别去的

`r/DataHoarder`（版主公告点名的正是「又一个 **FFMPEG wrapper**」，形状完全对上）·
`r/opensource`（规则说允许，但 `Promotional` 直链存活 **~9%**）· `r/LocalLLaMA`（按它的规则
格式转换器就是 off-topic）· `r/selfhosted` 的独立发帖（<3 个月只能进 megathread）·
Hashnode（1,695 posts / **14 followers**）· MCP 官方 Discord（官方明令禁产品推广）·
Hugging Face（Space 装不下 140 MB 桌面应用）· Lobsters（**邀请制 + 新号 70 天内不能打
`show` 标签**，是文化税不是发布通道）。


