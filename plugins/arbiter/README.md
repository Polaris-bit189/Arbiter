# Arbiter 插件

给 Claude Code 用的格式转换插件。让 Claude 直接调用 Arbiter 转换
**视频 / 音频 / 图片 / 文档 / PDF / 电子书 / 压缩包**，不用你手动开应用、拖文件。

## 安装

```
/plugin marketplace add Polaris-bit189/Arbiter
/plugin install arbiter@arbiter
```

**插件本身不含转换引擎**——它借用本机已经装好的 Arbiter 应用。
还没装应用的话先从 Releases 下载安装（Windows 是 `Arbiter-*-setup.exe`，
名字来自 `electron-builder.yml` 的 `artifactName`）。

## 用起来是什么样

直接跟 Claude 说人话就行：

> 把 `D:\素材\录屏.mkv` 转成 mp4

> 这个文件夹里的 HEIC 全转成 jpg

> `report.pdf` 里的文字提出来给我

也可以显式用命令：

```
/arbiter:convert D:\素材\录屏.mkv mp4
/arbiter:formats 视频
/arbiter:watch                    # 定时盯住一个目录（见下）
```

还有一处**不用你说就生效**的便利：装了插件之后，Read 一个 `.docx` / `.xlsx` /
`.doc` / `.odt` / `.epub`，会有个 PreToolUse hook 自动先把它转成临时 Markdown
再读——「我有个 Word 想说清楚写了什么」从「先转格式再读」变成**一次 Read**。
它**只改写、从不拦截**：找不到应用、引擎没装、转换失败、超时，一律原样放行。

## 八个工具

| 工具                     | 用途                                                                                       |
| ------------------------ | ------------------------------------------------------------------------------------------ |
| `inspect_file`           | 侦察文件：类别、体积、合法出口、要不要下引擎                                               |
| `list_supported_formats` | 能力矩阵                                                                                   |
| `convert_file`           | 转单个文件（等它跑完，期间报进度）                                                         |
| `batch_convert`          | 批量转，立刻返回 job_id                                                                    |
| `read_document`          | 一次读出文档正文（落系统临时目录，不往你的输出目录里写东西；超长会截断并给 `offset` 续读） |
| `list_jobs`              | 一次看完整批（转完一批时用它，别逐个 `get_job_status`）                                    |
| `get_job_status`         | 查进度与结果                                                                               |
| `cancel_job`             | 取消（连整棵进程树一起杀）                                                                 |

外加 resource `converter://formats`：一份 markdown 版的全量能力矩阵。

### `convert_file` 上的两个开关

| 开关            | 默认 | 它做什么                                                                                                                                                                                                                                                    |
| --------------- | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dry_run: true` | 关   | **只算不做**：走同一套校验、算同一个落点，然后直接返回计划（落到哪 / 实际用的 `to` / 哪个引擎 / 要不要下引擎、下多少 / 有没有损 / 耗时区间带 `confidence`）。**不建任务、不写文件、连输出名都不占**，也不下引擎。agent 拿不准时先来一次，比直接动手便宜得多 |
| `verify: true`  | 关   | 转完之后再侦察一次产物，逐项对照源的时长 / 音轨 / 分辨率，结果放在返回值的 `verification` 里。只报**事实**、不做评分；代价是多跑一次侦察。批量走 `batch_convert` 的 `verify`；`list_jobs` 只给一个 `verification_status`                                    |

## 它怎么找到应用

`mcp/launch.mjs` 按顺序找：

1. 环境变量 `ARBITER_HOME` 指定的目录（**找不到应用时用这个指路**）
2. Windows：`%LOCALAPPDATA%\Programs\Arbiter`
3. Windows：`%ProgramFiles%\Arbiter`、`%ProgramFiles(x86)%\Arbiter`
4. macOS：`/Applications/Arbiter.app`
5. Linux：`/opt/Arbiter`、`~/.local/share/Arbiter`
6. 插件所在仓库根、当前工作目录（开发形态；**排在安装位置之后**，
   装了应用的用户不会被一个顺手 clone 的仓库抢走）

在前五条都不存在时，第 6 条至少能让「clone 了仓库 + `npm run build`」的开发机跑起来；
仓库没构建时它让位给已安装的应用（判据是 `usable`，不是「目录存在」）。

找到之后，用它的 Electron 二进制以 `ELECTRON_RUN_AS_NODE=1` 跑应用内部的
`resources/app.asar/out/main/mcp.js`。所以**插件不占额外体积**，也永远是和应用同版本的一套逻辑。

> ⚠️ 那个路径在 **asar 里面**，而启动器是普通 Node——**`existsSync` 看不进 asar**，
> 恒返回 false。所以判据走 `mcp/asar.mjs` 自己读归档头。这条踩过：报出来的是
> 「这个安装包可能早于 0.2.0」，让人去重装一个没问题的包。守卫在
> `scripts/test-plugin-launch.mjs`（`npm run test:plugin`）。

排查不通常用：

```jsonc
// .mcp.json
{
  "arbiter": {
    "command": "node",
    "args": ["${CLAUDE_PLUGIN_ROOT}/mcp/launch.mjs"],
    "env": {
      "ARBITER_HOME": "C:\\Users\\<你>\\AppData\\Local\\Programs\\Arbiter",
      "ARBITER_MCP_DEBUG": "1"
    }
  }
}
```

`ARBITER_MCP_DEBUG=1` 会把选中的路径打到 stderr，在 `claude --debug` 里能看到。
**不改 `.mcp.json` 也行**：`ARBITER_HOME` 从外层环境继承（实测），
临时验证时直接在命令行前面加一句就够了。

## 命令行 `arbiter`

插件自带的那条 hook 走的是应用里的一个独立入口 `out/main/cli.js`——
和 MCP 一样「借宿主」跑（拿应用的 Electron 二进制 + `ELECTRON_RUN_AS_NODE=1`），
因为 Electron 应用有单实例锁，**再起一个应用实例是做不到的**。

```bash
arbiter convert <文件...> [--to <扩展名>] [--out <路径>] [--json]
arbiter --version
```

| 退出码 | 含义                                               |
| ------ | -------------------------------------------------- |
| 0      | 成功                                               |
| 1      | 转换失败（引擎跑了但没成功）                       |
| 2      | 参数错（用法 / 源文件不存在 / 这个格式组合不支持） |
| 3      | 引擎缺失（需要按需下载的引擎，本机还没装）         |
| 4      | 内部错误                                           |

**stdout 是数据通道**：`--json` 时是恰好一个 JSON 对象，否则是产物路径（一行一个）；
诊断、进度、警告一律走 stderr。三种失败各有各的退出码，是因为**调用方要拿它做决策**，
而不是去读 stderr 里的中文——按文案分类是 docs/NOTES.md 约束 23 第 3 条明令禁止的事。

> ⚠️ **要 Chromium 的转换（`→ pdf`）在 CLI 里做不到**：那个进程里没有 Electron 运行时
> （`printToPDF` 要 `BrowserWindow`）。这条限制与 MCP 那条线完全一样。
> CLI 入口是 0.3.0 加的，早于它的安装包里没有 `out/main/cli.js`，hook 会直接放行。

## 让它自己盯着一个目录

```
/arbiter:watch
```

它用 Claude Code 自己的调度原语（`Monitor` / `CronCreate` / `ScheduleWakeup`），
**不在应用里建常驻监视**。代价与边界见 [`docs/automation.md`](docs/automation.md)，
其中一条必须先说：**关掉 Claude Code 它就停了**——它不是后台服务。
⚠️ 另外，**别把「重命名即转换」（应用设置里那个开关）和它开在同一个目录上**。

## 要求

- **Node.js**：启动器本身是个 Node 脚本（`.mcp.json` 里用 `node` 起）。
- **已安装的 Arbiter 应用**：0.2.0 或更新（MCP 入口是 0.2.0 加的）。
- 首次用到某些格式时会**按需下载引擎**（pandoc 约 40 MB、Calibre 约 213 MiB、
  LibreOffice 约 357 MiB），下载源是多镜像回退 + sha256 校验 + 断点续传。
  转换前 `inspect_file` 会告诉你这次要不要下。

## 卸载

```
/plugin uninstall arbiter@arbiter
/plugin marketplace remove arbiter
```

实测（2026-09-13）这两条跑完之后，**配置里是干净的**：
`~/.claude/plugins/installed_plugins.json` 回到 `{"version":2,"plugins":{}}`、
`known_marketplaces.json` 只剩官方那个、`~/.claude/settings.json` 的
`enabledPlugins` 与 `extraKnownMarketplaces` 都成了 `{}`——这几个文件里搜不到 `arbiter`。

**但它不删缓存目录**：`~/.claude/plugins/cache/arbiter/` 会留着（约 43 KB），
只被打上一个 `.orphaned_at` 标记，等 CLI 自己择期回收；`plugins/data/` 下的同名目录同理。
想立刻清干净就自己删掉那两个目录——实测删完再重装没有任何影响（缓存会重建，也不会带回旧标记）。
另外 `~/.claude.json` 里会留下 `skillUsage` / `pluginUsage` 两处**使用计数**，
那只是给「这个插件很久没用过了」的提示用的，不影响任何行为。

## 版本

`plugin.json` 里的 `version` **不能省**：`claude plugin validate --strict` 会把
「没写 version」当**错误**（实测 2026-09-13，非 strict 下只是条警告），所以省了校验过不去。
发布时与仓库根 `package.json` 的版本号一起升。

## 开发

```bash
# 校验清单（--strict 把警告当失败，适合当 CI 门禁）
claude plugin validate ./plugins/arbiter --strict
claude plugin validate . --strict          # 校验仓库根的 marketplace

# 真装一遍（见下方警告：工具只有这条路才会暴露）
claude plugin marketplace add D:/project/message
claude plugin install arbiter@arbiter

# 打包分支的验收（要先 npm run build:unpack）
npm run test:plugin
npm run falsify:plugin-launch
```

⚠️ **`claude --plugin-dir <path>` 只注册技能，不会暴露插件的 MCP 工具。**（实测 2026-09-13：
三个技能 `arbiter:arbiter-convert` / `arbiter:convert` / `arbiter:formats` 都注册上了，
但工具列表里一个 `arbiter` 函数都没有；而 `claude mcp list --plugin-dir` 却显示
`plugin:arbiter:arbiter … ✔ Connected`——**server 连上了，工具就是不上架**。
所以别拿「`/mcp` 里绿着」当作工具可用的证据。）
要真调工具必须走 `marketplace add` + `install`，之后工具名是 `mcp__plugin_arbiter_arbiter__*`。
只想单独验工具本身的话，用 `--mcp-config` 直接挂 `mcp/launch.mjs`，
那时工具名是 `mcp__arbiter__*`。

改动 MCP 工具本身的话，记得 `npm run build` —— 插件跑的是**构建产物**，不是 TS 源码。
