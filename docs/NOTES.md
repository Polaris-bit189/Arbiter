# 工程笔记

这个项目的架构、约束与实测结论。**改代码之前先读这一份**：
`docs/ARCHITECTURE.md` 是给外人的概览，这里是给改代码的人看的细节与踩过的坑。

## 项目概述

`D:\project\message` 是一个 **Electron 通用格式转换器**，产品名 **Arbiter**、中文显示名 **调律者转换器**
（视频 / 音频 / 图片 / 文档 / 电子书 / 压缩包）。

- 技术栈：electron-vite 5 + Vite 7 + React 19 + TypeScript 5.9 + Tailwind 4 + Zustand 5
- 已初始化为 git 仓库，仓库级身份 `Polaris <2161893504@qq.com>`。
  ⚠️ **邮箱必须与 GitHub 账号上已验证的那一个一致**（2026-09-16 才改过来，原先写的
  是 `polaris@local`）。不一致时提交**不会**被关联到账号，公开仓库的 Contributors
  里会一个人都没有——而代码明明全是自己提交的，这种「看起来没参与」很难一眼看出原因。
  改邮箱只能影响**之后**的提交；已经推上去的历史要改就得 force push（发布快照是
  单个提交，所以重出一次即可，见 `D:checkmake-clean-copy.mjs`）。
- 定位（2026-09-13 起）：**面向公开发布的开源项目 + AI 原生工具**，MIT，首发仅 Windows 瘦包。
  这条**取代**了原来的「个人自用、不做打包分发、全程 `npm run dev`」——`electron-builder.yml`
  已投入使用，README / LICENSE / CI 都是门面的一部分，MCP 是规划中的核心卖点。
- 工作计划见 `docs/PLAN.md`（里程碑 M1~M8、并行划分、验收判据的唯一真相源）；
  界面设计那一版计划见 `C:\Users\Polaris\.claude\plans\staged-gathering-simon.md`（已落地）。

## 开发命令

```bash
npm run dev          # 启动开发服务器（electron-vite，含 HMR）
npm run typecheck    # 类型检查（node + web + scripts 三套 tsconfig）
npm run test         # 全部自测 2053 条，2026-09-16 实跑（下面二十套串起来；**全程约 3 分钟**）
npm run test:core    # 纯逻辑 241 条：文件名净化 / 时长解析 / -progress 解析 / 任务参数契约与文案
npm run test:doc     # 纯逻辑 77 条：文本编码探测 / HTML↔文本 / markdown 表格 / 样式注入 / 扫描件判空 /
                     #   xlsx 依赖版本（≥ 0.20.2 —— 两条 CVE 的修复线；行为断言分不出 0.18.5）
npm run test:integration # 系统集成（M8）185 条：argv 解析（含多文件）/ 引号拼接 / 真 reg.exe 往返（走临时键）/
                     #   重命名即转换 / 发送到 .lnk / 完成后动作 / 重跑的冲突判定
npm run test:cli     # CLI 86 条：真起 `tsx src/cli/main.ts`，验 stdout 纯净性 / 退出码分档 / 输出编码
npm run test:image-options # 图片参数 30 条：缩放（四档 fit / 只给一维 / 不放大）、体积二分质量，
                     #   以及 PNG 出口的 `effort` 那个旋钮（去掉它体积 ×3，而它此前没有断言）
npm run test:ui      # 处理链面板 76 条：FiltersSection 的解析 / 整链校验 / 规范次序 / 四种链改动，
                     #   外加真渲染下的按钮可用性与元素树接线（esbuild 内存包装原文，**一个字节不改 src**）
npm run test:electron-free # 转换链路脱开 electron 13 条：把 electron 拦掉再真跑一次转换（MCP 场景）
npm run test:install # 引擎安装编排 49 条：下载 → sha256 → 解包 → 落盘（本地假镜像 + 注入的解包器）
npm run test:mcp-view # MCP 静态面 193 条：工具 schema 的三个出口不漂移 / 能力矩阵的对外视图不自己编 /
                     #   工具数量预算（上限 12）
npm run test:mcp-inspect # MCP 侦察 51 条：inspectFile 的字段与代价三件套（读清单、不起进程）
npm run test:mcp     # MCP 端到端 203 条：**真起服务端**、真跑转换，问 tools/list 与各工具
                     #   「说明书接线」那条只有它能抓——test:mcp-view 不 import server.ts
npm run test:tasks   # 编排集成 406 条：真实 TaskManager + 真实 ffmpeg / sharp / 7z 子进程
                     #   （含裁剪、输出体积、处理链六种动作、GPU）
npm run test:downlink # 按需下载 149 条：多镜像回退 / sha256 / Range 续传 / 416 / 取消
npm run test:pandoc  # 文档互转 117 条：真实 pandoc 子进程（txt reader / GBK / --resource-path / rst 出口 /
                     #   跨块解码）
npm run test:pdf     # 端到端 57 条：真起 Electron 打印 PDF（**必须跑在 Electron 里**）
npm run test:i18n    # i18n 闸门 18 条：**目前只有闸门 a 真跑**（中文集中度预算），b/c/d 要等 P1 的
                     #   字典落地才有对象可测——横幅明说「未接线 ≠ 通过」，退出码只由 a 决定
npm run test:audit   # 分发版审计的回归 16 条：CSP 与源一致 / CLI↔MCP 接线（**不构建则部分跳过**）
npm run test:preload-imports # preload 依赖图 9 条（约束 1 的机器化守卫）：`sandbox: true` 的 preload
                     #   里 `require()` 只能解析 electron，任何被 externalize 的 npm 依赖都会让
                     #   **整个 preload 崩掉**（表现为 `window.api` 未定义、拖拽毫无反应）。
                     #   2026-09-16 才接进本地聚合——在那之前它**只在 CI 里跑**，
                     #   而「只在 CI 里跑的检查」等于交 PR 前没人能自己先发现。
npm run test:anchors # 锚点预检（15 个 falsify 脚本 / 178 个锚点，约 5 秒）：只验「变异还找得到目标」，
                     #   **不验断言是否抓得住**——凡是改了被变异覆盖的代码，先跑它再谈别的
npm run falsify      # 反证：把被测代码逐处改坏，确认断言真的会翻红（见下）
npm run falsify:tasks # 单跑 21 个变异（约 22 分钟）——**刻意不在聚合里**，见「测试」一节
npm run bench        # 后端性能基准（不是测试，是量收益用的，见下）
npm run lint         # ESLint（`--cache`；**它漏报过**，见「测试」一节末尾那条）
npm run format       # Prettier

# 出 Windows 安装包（瘦包，实测 140.1 MB；`--publish never` 防与 release action 抢同一个 tag）：
npm run build:win

# 提取完整版 7z.exe + 7z.dll（RAR 支持全靠它，见约束 11）：
node scripts/fetch-bundled-engines.mjs

# 提取原生 pandoc.exe（md/txt/html/rst → docx 全靠它，见约束 14）：
node scripts/fetch-pandoc.mjs

# 从一张源图重新派生整套应用图标（build/icon.ico / icon.icns / icon.png + resources/icon.png）：
node scripts/make-icon.mjs <源图>

# 排查渲染进程问题时，把 console 也输出到终端：
ELECTRON_ENABLE_LOGGING=1 npm run dev
```

`npm run dev` 前先确认没有残留的 electron 进程，否则新实例会因单实例锁静默退出，
而你看到的其实还是上一轮那个跑着旧代码的窗口：

```bash
taskkill //F //IM electron.exe //T
```

国内网络：`.npmrc` 已配 npmmirror 镜像。安装 ffmpeg-static 时必须带环境变量，
它的 `install.js` 读的是 `process.env` 而非 npm config：

```bash
FFMPEG_BINARIES_URL=https://cdn.npmmirror.com/binaries/ffmpeg-static npm i ffmpeg-static
```

## 架构

三进程分离，**主进程是唯一真相源**：任务队列、进度、引擎状态都存在主进程，
渲染进程只是镜像（挂载时拉一次快照，之后只吃增量事件）。

```
src/shared/     main 与 renderer 共用（能力矩阵、类型、IPC 约定）
src/main/       Node 侧：任务调度、引擎调用、文件系统
src/preload/    contextBridge 最小 API，安全边界
src/renderer/   React UI
```

核心文件：

- `src/shared/formats.ts` — **整个应用的中枢**。`(源格式, 目标格式) → 引擎` 的路由表，
  以及每个格式能转成什么。main 和 renderer 共用同一份，避免两边判断分歧。
- `src/shared/channels.ts` — IPC 通道名常量。**单独成文件是因为它零依赖**：
  preload 也需要它，而 preload 跑在 sandbox 里，为了几个字符串常量把 zod 拖进
  依赖图会让整个 preload 崩掉。契约和 zod schema 在 `ipc-contract.ts`。
- `src/main/core/task.ts` — 任务状态机，**主进程侧的唯一真相源**。所有状态迁移都在这里，
  通过增量 patch 推给 UI。含输出名占位逻辑（见约束 8）。
- `src/main/core/queue.ts` — 按引擎分桶的并发调度器。并发上限必须按引擎分而不是全局：
  ffmpeg 是 CPU 密集、LibreOffice 单 profile 只能为 1、printToPDF 每窗口 50-80 MB。
- `src/main/converters/` — 引擎适配层。`index.ts` 是路由分发，不含编码细节；
  错误类型与 `ConvertContext` 统一放在 `common.ts`，避免各引擎与 index 互相 import 成环。
- `src/main/engines/sevenzip.ts` — 7-Zip 路径解析的三档回退（随包完整版 → 系统安装 → 7za 精简版），
  并据此判定 RAR 是否可用。缓存结果，只探测一次。
- `src/main/converters/heic.ts` — HEIC/HEIF 走 WASM 版 libheif 解码（见约束 6）。
- `src/main/engines/chromiumPdf.ts` — 隐藏 `BrowserWindow` + `printToPDF`。窗口每次用完
  必须 `destroy()`，还要接管 `window-all-closed`（见约束 17）。会话被 harden 过：
  http/https 一律 cancel，只放行 `file://`。
- `src/main/converters/htmlSource.ts` — 各格式 → HTML 的纯函数。**零 electron 依赖**，
  所以能脱离窗口直接测（`scripts/test-doc.ts`）。HTML ↔ 文本 / markdown 的互转也在这里。
- `src/main/converters/document.ts` — 文档转换编排，即能力矩阵里 `'pdf'` 那个引擎 key。
  纯 JS + Chromium 能覆盖的都在这儿；只有 `doc/xls/ppt/odt` 和 `→docx` 才要 LibreOffice / pandoc。
- `src/main/core/downlink.ts` — 按需下载：多镜像回退 + sha256 校验 + Range 续传。
  传输层抽象成 `DownloadTransport`，测试里注入本地 http 实现，不必真联网。
- `src/main/window.ts` — 窗口配置 + `nativeTheme` 主题统管。
- `src/main/ipc/` — IPC handler，入口必须校验入参（渲染进程是不可信输入）。
- `src/renderer/src/store/useTasks.ts` — 前端镜像。选择器**必须返回原始值或稳定引用**，
  否则每次进度推送都会重渲染整个列表，`TaskCard` 的 memo 就白做了。
  标题栏的「运行中 N / 上限 M」也是从这份镜像里数出来的（`App.tsx` 的 `countStatus`），
  **不要**改回读设置里的静态上限：那个数字跟实际在跑几个毫无关系，一批小文件两百毫秒转完、
  五张卡片同时变绿时，旁边写着「并发 4」看起来就像限流根本没生效。主进程的 `queue.stats()`
  刻意不往渲染进程透——镜像和卡片渲染的是同一份数据，数出来的才有可能和用户数出来的对上。

## 关键约束（违反会静默出错）

**1. preload 里的 npm 依赖必须内联，不能外部化。**
`sandbox: true` 的 preload 中 `require()` 只能解析 `electron`，任何被 externalize
的 npm 依赖都会在运行时 `module not found`，导致 **preload 整个崩掉** —— 表现为
`window.api` 未定义、拖拽毫无反应这类极难排查的静默失败。
`@electron-toolkit/preload` 就是因此被移除的，不要加回来。

**2. 一律用 `spawn(exe, args[])`，禁止 `exec` / `shell: true` / 拼字符串。**
用户文件名可能含空格、引号、`&`、`$()`、中文、emoji。走数组参数时 shell 根本不参与解析，
这些字符天然无害。另外路径要 `path.resolve()` 转绝对路径——以 `-` 开头的文件名
会被 ffmpeg/pandoc 当成选项（参数注入比 shell 注入更隐蔽）。

**3. 取消任务必须杀进程树**：`taskkill /pid <pid> /T /F`。
`soffice.exe` 会拉起 `soffice.bin`，只杀父进程会留孤儿进程占着 profile 锁，
导致之后所有 LibreOffice 转换静默失败（退出码 0 但没产物）。

**4. ffmpeg 的 `-progress pipe:1` 解析**：

- `out_time_ms` 的单位其实是**微秒**（历史遗留 bug，名字骗人），别用它；解析 `out_time=HH:MM:SS.ffffff`
- 必须缓冲到遇到 `progress=` 行才提交一次，`frame=` 和 `out_time=` 属于同一条记录
- `percent` 强制单调递增，否则进度条会回跳

**5. 时长不单独探测，从转换进程自己的 stderr 里捡。**

两件事，都是踩过的：

- **不装 ffprobe**：`ffprobe-static` 的 unpackedSize 是 351 MB（塞了全平台二进制）。
  我们要的信息 ffmpeg 自己就会打印，即打开输入时那段 `Input #0 … Duration: …`，
  这个输出格式十几年没变过，比引入一个 351 MB 的依赖可靠得多。
- **连 `ffmpeg -i` 那次专门探测也省掉**。以前一个视频任务要开两次进程（先探时长、再转换），
  实测裸启动一次 ffmpeg 约 25 ms、探测约 30 ms，而转换本身才 48 ms——**光探测就占 38% 的墙钟**，
  批量转小文件时这笔账尤其难看。现在直接读转换进程的 stderr，白拿。

实现见 `src/main/converters/ffmpegRun.ts` 的 `tryAdoptDuration`，两个必须记住的点：

- **stdout 上的进度记录在拿到解析器之前必须先攒着**（`pendingStdout`）。
  时长出现在 stderr 开头，而 `-progress pipe:1` 的记录从 stdout 来，两条流没有先后保证；
  直接丢掉这段时间的记录，进度会从中间某个百分比开始。
- **只在 stderr 的前 8 KB 里扫时长**（`DURATION_SCAN_LIMIT`）。时长一定在开头，不加这个上限的话，
  一个满嘴报错的损坏文件会让每个 chunk 都触发一次全量正则扫描，那是 O(n²)。

解析复用 `src/main/core/probe.ts` 的 `parseProbeOutput`（正则和边界早就有测试盯着，别在
ffmpegRun 里再写一份）。这条链路断了的表现是**进度永远停在不确定状态**——进度条照样在动，
只是永远没有百分比，光看 UI 看不出来，所以 `test-tasks.ts` 里锁了两条断言。

**（2026-09-13 补充：M2 remux 之后，上面这条的适用范围收窄了，但结论没被推翻。）**

remux 必须在**启动之前**知道编解码器，而编解码器只能问 ffmpeg——所以 `converters/ffmpegRun.ts`
现在确实会先探一次。**但它只在这个方向「有可能 remux」时才探**（`remuxEligible()` 放行，
见约束 18）；图片源、`→ gif` 一律不探。

上面那句「光探测就占 38% 的墙钟」仍然成立——它描述的是**必然重编码**的场景，那些场景一个字节没变。
而一旦存在 remux 的可能，这笔探测就从「纯开销」变成**决策成本**。

**受控 A/B 实测**（口径：同一个 1920x1080 / 20s / 30fps 的 h264+aac mp4 源、**同一个目标容器 mkv**，
只差两条路；各跑 3 次取**中位数**，不取均值——3 次里只要一次被系统干扰，均值就废了）：

| 路径                                  | 三次实测              | 中位        |
| ------------------------------------- | --------------------- | ----------- |
| remux（`-c copy`）                    | 43 / 45 / 45 ms       | **45 ms**   |
| 重编码（`videoArgs('mkv')` 那份参数） | 1527 / 1524 / 1504 ms | **1524 ms** |
| 倍数                                  |                       | **33.9×**   |

端到端走 `TaskManager`（含启动前那次探测 + 状态机）同一份素材是 **127 ms**（任务自身 113 ms）。

⚠️ **但小文件上这笔探测可能是净亏，别把 remux 说成无条件更快。** `npm run bench` 那个
「1 秒 64x64 mp4 → mkv」的单任务墙钟是 **78 ms**（含冷启动），批量 ×40 的每轮 **57.2 ms**——
在那个尺度上探测与「直接重编码」处于同一量级。**收益随文件变大而放大**，
所以 P3 只在 `remuxEligible()` 放行的方向上付探测这笔钱（图片源、`→ gif` 一律不探）。

⇒ 这两条不矛盾，别把后来的补充读成对约束 5 的否定。

**6. HEIC/HEIF 两个主力引擎都解不了，只能走 WASM 版 libheif。**
这条**推翻了最初的假设**「路由给 ffmpeg 就行」——用真实 iPhone 照片把两个引擎都实测过，都不行：

- **sharp**：预编译的 libvips 因 HEVC 专利剔除了 libde265。最有迷惑性的是它能读出元数据
  （`metadata()` 正常返回 `format:'heif'` 和正确尺寸），一取像素才报
  `bad seek to <文件末尾之后的偏移>`——而那个偏移量在原文件里根本不存在
  （用 box 解析器逐层核对过，文件结构严丝合缝），所以很容易误判成「文件被截断」。
- **ffmpeg-static 6.1.1-essentials**：连 heif 解复用器都没有，把 `.heic` 当 MP4 解，
  报 `moov atom not found`。

现在走 `heic-decode`（libheif 编成了 WASM），解出 RGBA 再交给 sharp 编码成任意目标格式。
两个必须记住的点：

- **分流判据是 `meta.compression === 'hevc'`，不是扩展名。这个判据两个方向都承重**：
  AV1 系 HEIF 走 sharp 原生能读、交给 WASM 反而报 `input buffer is not a HEIC image`；
  HEVC 系则正好反过来。按扩展名一刀切必然砸掉一边。
- **不能取 `data[0]`**：libheif 按文件顺序返回图像，很多 HEIC 把缩略图排在主图前面
  （实测一份 iPhone 实拍里 5 张图，前 4 张都是 480x320 缩略图）。取 `data[0]` 不报错，
  只是静默转出一张缩略图——画质莫名其妙地差，极难归因。现在按 sharp 读出的尺寸精确匹配
  主图，匹配不上再退到「面积最大」。

另外两点：libheif 解码时会应用容器的 `irot`/`imir` 变换，而 Apple 正是用 `irot` 记录旋转的
（这些实拍样本的 EXIF orientation 全是空的），所以**不要再额外旋转**；HEIC 转出会丢 EXIF/ICC，
因为原始像素里没有可保留的元数据。

见 `src/main/converters/heic.ts`；实测结论与素材说明见 `scripts/fixtures/README.md`。

**7. 版本陷阱**：npm 上 `vite@latest` 已是 8.x、`typescript@latest` 已是 7.x（Go 重写版），
electron-vite 5 都不兼容。升级依赖时保持 `vite@^7` / `typescript@~5.9`。

**8. 临时文件名必须保留扩展名**（`clip.mkv` → `clip.part.mkv`，不是 `clip.mkv.part`）。
ffmpeg 完全依赖输出文件的扩展名推断封装格式与编码器，`clip.mkv.part` 会让它直接报
`Error opening output files: Invalid argument` 而无法开写。把标记插在扩展名之前，
就不必维护一张「扩展名 → 封装格式/编码器」的映射表，而且这条规则对 sharp / pandoc / 7z 同样适用。
见 `src/main/core/outputName.ts` 的 `partPathOf`。

**9. 并发任务的输出名要额外占位。** `resolveOutputPath` 只看磁盘上有没有同名文件，
而两个并发任务在各自写临时文件期间，磁盘上都还不存在最终文件，于是会解析到同一个名字，
后完成的那个会静默覆盖先完成的。`TaskManager.claimed` 集合就是补这个洞的。

**10. 7-Zip 的进度输出用 `\r` 分隔，而且不吐 100%。**
按 `\n` 切行会一条都匹配不上——原始输出长这样：
`"  0M Scan D:\out\\\r          \r  0%\r    \r 36% 48 + blob.bin\r"`。
要按 `[\r\n]` 一起切再匹配 `^\s*(\d{1,3})%`，并且收尾得自己补一次 100%，
否则进度条永远差一截。开头那条 `0M Scan <路径>` 不含 `%`，天然不会误匹配。
见 `src/main/converters/archive.ts` 的 `runSevenZip`。

**11. 压缩包互转 = 全拆开 + 重新打包，中间必然落一次临时目录。**

- 归档格式之间没有「流式转换」这回事：zip 和 7z 的字典、条目索引、压缩算法完全不同。
- **`.tgz` 这类套娃必须拆两趟**：`7z x x.tgz` 只解掉 gzip 层，拿到的是 `x.tar` 而不是内容。
  少了这一趟，产物里装的会是一个 `.tar` 文件。见 `LAYERED_SRC` 与 `MAX_UNWRAP_DEPTH`。
- **RAR 需要完整版 `7z.exe` + `7z.dll`，且两个文件必须同目录**。npm 上 `7zip-bin` 发的是
  standalone 精简版 `7za.exe`，**一个 RAR 编解码器都没有**，遇 `.rar` 只报
  `Cannot open the file as archive`（看不出缺什么）。跑
  `node scripts/fetch-bundled-engines.mjs` 从 npm 镜像提取完整版。
- 打包时 `--` 之后一律当文件名。用户压缩包里可能有个叫 `-y.txt` 的文件
  （`-y` 是 7z 的「全部回答 yes」开关），少了这个分隔符就会被当成选项。
- **套娃格式要改两处，只改一处等于没改**：`LAYERED_SRC`（`converters/archive.ts`）决定
  「要不要拆第二趟」，`register('archive', …)`（`shared/formats.ts`）决定「能不能作为源被接受」。
  这里就出过一次：`tbz2` / `txz` 配了前者没配后者，拆包规则写在代码里却永远走不到——
  用户拖进来的 `.tbz2` 连压缩包都不算，`targetsFor` 返回空数组，界面上连目标格式都选不出来。
  反证时这个洞很难看见：任务压根没被建起来，所以「产物条目与源一致」这类断言只会拿到空集合。

**12. 文档 / PDF 引擎（`converters/document.ts`）的四条实测结论。**

- **`<base href>` 是相对路径插图的唯一依靠。** 临时 HTML 写在系统临时目录，源文件在别处，
  markdown 里的 `![](pic.png)` 全靠 `wrapHtml` 注入的 `<base href="file:///<源文件目录>/">`
  才解析得到。去掉它**不报任何错**——Chromium 画一个破图占位，PDF 照常生成、页数照常对。
- **中文字体栈是承重的，不是锦上添花。** 把 `BASE_CSS` 里那句 `"Microsoft YaHei", …`
  换成 `serif` 之后，实测 PDF 里**连 `/Type0` 复合字体都没有了**——中文根本没进 PDF，
  而转换照样「成功」。别指望 Chromium 自己会兜底 CJK 字体回退。
- **不是所有图片 Chromium 都认得。** TIFF / HEIC 它解不了，失败方式同样是渲染成破图。
  `CHROMIUM_IMG` 白名单之外的一律先经 sharp（HEIC 则经 libheif）转 PNG 再交给它。
  SVG 刻意留在白名单里，是为了保住矢量。
- **`printToPDF` 一旦开始就无法从中间打断**，取消只能在落盘前确认一次状态
  （与 `converters/image.ts` 同一策略）。
- **`pdf → txt/md/png/jpg` 四个出口现已全部接通**（2026-09-12。此前四个都宣称可用而实际
  没接：`txt/md` 会落到 default 的「当纯文本读」，把 PDF 二进制解成一屏乱码而**报告成功**，
  与 rst 那个洞同源但更隐蔽——rst 至少产物是源码，能看出不对）。文本抽取出
  `converters/pdfText.ts`（pdfjs 抽文本行），页转图出 `converters/pdfPages.ts`。四条实测：
  - **页转图不需要渲染进程**，这推翻了原先「要走渲染进程 canvas」的假设：pdfjs 的 `isNodeJS`
    判据里，Electron **主进程**的 `process.type === 'browser'`，于是它走 `NodeCanvasFactory`，
    `page.render({ canvas })` 直接收 canvas。实测 A4 三页 / 150 DPI：模块加载 194 ms、单页 35 ms、
    产物 1241x1754。
  - **`@napi-rs/canvas` 必须提为直接依赖**，别指望它只是 pdfjs-dist 的 optionalDependency：
    `externalizeDepsPlugin()` 只认 `dependencies`，不提的话 dev 时 Vite 会去打包 `.node` 原生模块
    （而测试全走 esbuild / tsx 的 `packages: 'external'`，所以这个坑**只在 `npm run dev` 时现形**）。
    改走 `pdf.canvasFactory` 也省不掉它——`pdf.mjs:16142` 自己就 `require("@napi-rs/canvas")`。
  - **静态资源那三个 URL 必须以正斜杠结尾**（`getFactoryUrlProp` 断言 `endsWith('/')`，给反斜杠
    直接抛 `Invalid factory url`），且传的是**文件系统路径而不是 `file://`**（Node 侧走
    `fs.readFile`）。`wasmUrl` 不是装饰：扫描件的 JBIG2 / JPEG2000 全靠它——`pdfText.ts` 一个都
    没设也跑得好，是因为它只抽文本、从不解码图像，别被那个先例误导。
    **JBIG2 / JPX 的解码路径没有真跑过**（造不出合法流），是已知的验证缺口。
  - **多页口径**：第 1 页落在 `output` 上（`TaskManager` 完成时要 `stat()` 它拿体积），第 k≥2 页
    落在同目录的 `<stem>-<k>.<toExt>` 上、从 k=2 起探占用整体顺延。所有页先渲染进 `.part`、
    最后才逐个 finalize——中途任何一页失败都不留半份产物，代价是**转完之前目标目录里什么都
    不会出现**。兄弟名不进 `claimed`，留了一个已知窄缝，见 `pdfPages.ts` 里那段说明。

**13. 文档引擎的输入编码：CSV 必须探测 GBK；导出 CSV 必须写 BOM。**
Windows 上 Excel 导出的 CSV 默认是 **GBK / GB18030**，按 UTF-8 读会得到满屏乱码**且不报错**。
`decodeTextFile` 的顺序是：BOM → 严格 UTF-8（`TextDecoder(…, { fatal: true })` 抛错即判据）
→ GB18030 兜底。反方向：导出 `.csv` 时要**主动加 UTF-8 BOM**，否则 Excel 那侧按系统 ANSI
码页解，中文变乱码——而错误发生在 Excel 那边，用户只会认为是我们的问题。

**14. pandoc 用随包内置的原生 exe，不要用 `pandoc-wasm`。**（实测，2026-09-12）

- **`pandoc-wasm` 会阻塞事件循环**：79 KiB 输入转一次 4189 ms，期间 10 ms 定时器触发
  **0 次**（预期约 418 次）。在 Electron 主进程里这等于整个应用卡死、推不了进度、取不了消，
  直接违反「主进程推增量进度」这个前提。它还只有 ESM 入口 + top-level await，
  与主进程的 CJS 对不上，`require()` 报 `ERR_REQUIRE_ASYNC_MODULE`；
  而且实测**图片不嵌入**（`word/media` 数量为 0）。
- **原生 pandoc 是单个自包含 exe**（221 MiB，不需要任何 DLL，连默认 `reference.docx`
  和语法高亮定义都在 exe 内部），冷启动 330 ms / 热 56~66 ms，能被既有的
  `taskkill /T /F` 杀掉——完全贴合本项目的子进程模式。
- **三个必须带的调用参数**，每一个都是踩出来的：
  - `.txt` 要映射成 `-f markdown`。pandoc 没有 `txt` reader，直接报
    `Unknown input format txt`（也没有 `plain` reader）。
  - `--resource-path <源文件目录>`。pandoc 按 **cwd** 而非源文件目录解析相对路径，
    少了它图片被**静默丢弃**、退出码仍是 0。
  - `--syntax-highlighting none`。带语言标注的代码围栏会触发 skylighting 初始化，
    实测 73 ms → 343 ms。注意 `--no-highlight` 在 3.9 已废弃，会打 WARNING。
- 另外：**GBK 输入会被静默转成乱码**（stderr 只有一行 `not UTF-8 encoded: falling back
to latin1`，退出码 0）。入参要先过一遍约束 13 那套编码探测。

**已接入**（阶段 4c，2026-09-12）：`engines/pandoc.ts` + `converters/pandoc.ts`，
`md/markdown/txt/html/htm/rst → docx` 走这条线。补三条实测：

- **提取方式**：`scripts/fetch-pandoc.mjs` 从清华 TUNA PyPI 的 `pypandoc-binary` wheel
  （1.17，40,891,661 字节，sha256 `76fae066…`）里抽 `pypandoc/files/pandoc.exe`
  （231,717,128 字节，sha256 `ddf6bd05…`）。wheel 是 zip，但**中央目录里记的压缩长度
  未必等于 local header 的**，取数据必须以 local header 的 name/extra 长度为准。
- **「静默丢弃」要说得更准**：pandoc 其实会往 stderr 打
  `[WARNING] Could not fetch resource pic.png: replacing image with description`，
  只是**退出码仍是 0**，而 stderr 只在我们判定失败时才展示——所以对用户仍然是静默的。
  实测对照：不给这条参数，产物里 `word/media/` 一个条目都没有。
- **GBK 的落地形态**：不是「探测出编码再告诉 pandoc」，而是先解码成 UTF-8 另存到临时目录
  再喂给它（本来就是 UTF-8 的原样直通，连临时文件都不建）。测试里用的仍是**手写 GBK 字节**，
  断言是「GBK 版产物与 UTF-8 版产物一字不差」——比「读回来含中文」硬得多。

**又接入 rst 的文本出口**（同日，顺手补掉一个洞）：`document.ts` 的 `htmlFragmentOf` 里，
rst 不再降级成纯文本，改调 pandoc 转 HTML 片段（`-f rst -t html`），
于是 `rst → html/md/txt/pdf` 四个出口一次性全对——此前它们全都输出一坨 RST 源码，
而能力矩阵照样宣称可用。子进程逻辑抽到了 `converters/pandocRun.ts`（对照 `ffmpegRun.ts` 的先例），
两个调用方共用同一张 reader 表、同一份「必有参数」清单。补两条实测：

- **RST 的 inline markup 有硬性空白规则**：开标记前必须是行首或空白，闭标记后必须是空白或 ASCII 标点。
  写成 `含**粗体**和` 这种嵌在中文里的（前后都是汉字），pandoc 按规矩**不解析**、原样吐出来。
  写测试素材时踩到了——`<strong>` 那条断言翻红，红的其实是**素材自己不合规范**，不是实现有问题。
- **两个调用点都要编码归一。** GBK 的 rst 会被当 latin1 解、中文全乱码而退出码仍是 0，
  只在 `pandoc.ts` 那条路上做是不够的。反证里为此单列了一条变异，专门盯 `document.ts` 这一侧。

**15. 这台机器上 GitHub 直连不通（HTTP 000）**，凡「官方发行只放 GitHub」的引擎都要绕道。
实测可达的源（别再重新试一遍）：

| 引擎               | 源                                                                                                                        | 实测                                                                                                                                                            |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| pandoc 3.9 win-x64 | 清华 TUNA PyPI 的 `pypandoc-binary` wheel                                                                                 | 40,891,661 字节可达；内含 `pandoc.exe` 231,717,128 字节，单文件自包含                                                                                           |
| pandoc 3.9 win-x64 | GitHub 代理 `ghfast.top`                                                                                                  | 40,860,638 字节 / 9.3 秒（约 4.4 MB/s，第三方代理，仅作备选）                                                                                                   |
| LibreOffice 26.8.0 | `https://mirrors.tuna.tsinghua.edu.cn/libreoffice/libreoffice/stable/26.8.0/win/x86_64/LibreOffice_26.8.0_Win_x86-64.msi` | 374,906,880 字节（357.5 MiB）。**注意文件名是 `Win_x86-64`（下划线）**，写成 `Win-x86-64` 是 404                                                                |
| Calibre 9.14.0     | `https://download.calibre-ebook.com/9.14.0/calibre-64bit-9.14.0.msi`                                                      | 223,559,680 字节（213.2 MiB）。**不存在 10.x**——`10.html` 返回 200 但页面上没有任何 release 链接（nginx 对任意 `N.html` 都回同一模板），`/10.0.0/` 直接回根目录 |

**16. 重型引擎一律用 `msiexec /a` 解包，别用 `7z x`。**（实测，2026-09-12）

`msiexec /a "<pkg.msi>" /qn TARGETDIR="<dir>"`（administrative install，**免管理员**）
是**唯一**能拿到可运行目录树的解包方式：

| 引擎               | `msiexec /a`                                   | 启动哪个 exe                          |
| ------------------ | ---------------------------------------------- | ------------------------------------- |
| LibreOffice 26.8.0 | 退出码 0 / 29 秒 / 1.49 GiB / 19,457 文件      | `program\soffice.exe`（全树唯一一个） |
| Calibre 9.14.0     | 退出码 0 / 5 秒 / 658,600,649 字节 / 1346 文件 | `PFiles64\Calibre2\ebook-convert.exe` |

两边都实测过真实转换（LO 的 docx→pdf、Calibre 的 html→epub 都退出码 0 且产物合法），
且**改名 / 整体搬迁后重跑照样成功**。三个必须记住的点：

- **`7z x` 一个 MSI 会「成功」地毁掉它。** 实测：退出码 0、`Everything is Ok`、
  19,427 个文件一个不少，但**子目录数为 0（100% 扁平）**。MSI 的 Directory 表负责把 CAB
  条目映射进 `program\` / `System64\` / `share\`，7z 丢掉了这张表，于是
  `vcruntime140.dll` 这个名字在扁平树里压根不存在（只剩 `_amd64` / `_x86` / `_arm64` 三个变体）。
  跑起来报 `api-ms-win-core-path-l1-1-0.dll: cannot open shared object file`，
  Windows 侧是 `0xC0000135` (STATUS_DLL_NOT_FOUND)。
  **对照证据**：两棵树里的 `soffice.exe` md5 完全相同（`b21829f006ec0d8460b43cf2625760c1`），
  所以失败原因是**布局**，不是二进制本身。网上「7z 能解 MSI」的说法只对了一半。
- **Calibre 的 portable installer 不是自解压包。** 它是 PE，载荷是单个资源
  `.rsrc\EXTRA\EXTRA`（202 MB 未压缩），头 6 字节 `4C 5A 49 50 00 17` 是 **`LZIP`**（lzip），
  `7z l` 直接 `Cannot open the file as archive`（7z 不支持 lzip）。绕过去要自己实现 lzip 解码
  （Python `lzma.FORMAT_RAW` + `FILTER_LZMA1(dict_size=1<<23, lc=3, lp=0, pb=2)` 跳过 6 字节头），
  而 **Node 标准库没有 LZMA、7z 也帮不上**——所以**不要走这条路**，直接下 MSI 走 `msiexec /a`。
- **LibreOffice 的输出必须用 `soffice.com` 捕获。** `soffice.exe --version` 退出码 0 但
  **输出 0 字节**（重定向到文件也是 0，等 8 秒仍是 0，不是竞态）；`soffice.com` 才吐
  `LibreOffice 26.8.0.3 …`。转换本身用哪个都行。

另外：Git Bash 里跑 `msiexec` **必须开 `MSYS_NO_PATHCONV=1`**，否则 `/a` `/qn` `/l*v`
被改写成 `C:/Program Files/Git/a`；但开了它之后 `cmd //c` 又会进交互模式。
`msiexec /l*v` 写出来的日志有 32 MB，别开在日常路径上。

**17. Electron 默认「最后一个窗口关闭就退出应用」。**
隐藏的 PDF 窗口每次打印完都 `destroy()`，于是**用完即退**——在测试脚本里表现为
「第一个场景跑完进程就没了，后面的场景一条都不跑、也不报错」，终端上只剩一个提前结束的
`[1]`。必须显式接管 `app.on('window-all-closed')`。生产环境里 `window.ts` 同样要注意：
用户关掉主窗口之后，还挂着的 PDF 窗口会让应用的退出时机变得很怪。

**18. M2 remux（智能重封装）：判据是白名单，表里每一项都是实测出来的。**

`engines/ffmpeg.ts` 的 `REMUX_VIDEO` / `REMUX_AUDIO` 是「目标容器 → 能直接 `-c copy` 装进去的
编解码器」。判据要回答的只有一句：**`-c copy` 会不会报错**。四个必须记住的点：

- **白名单刻意保守**。漏判的代价只是「慢一点」，误判的代价是「产出坏文件或直接报错」，
  所以未列出的组合一律重编码。要放宽某一条，**先补实测**。
- **音频那一侧是承重的**。同一份 vp9 视频流，`opus → webm` 能 `-c copy`，换成 `aac` 就报
  `Only VP8 or VP9 or AV1 video and Vorbis or Opus audio`。只判视频的话 `vp9+aac → webm`
  会被判成可 remux、然后**整个任务失败**。但**无音轨的源照样要能 remux**，所以判据是
  `info.audioCodec !== null && !audio.includes(...)`——**不能**写成 `!info.hasAudio || ...`，
  那样纯视频源会被判成不兼容而白白重编码。
- **avi 干脆不进表**。同一份 h264，从 mkv 转 avi 要 Annex-B、从 mp4 转 avi **又不用**
  （ffmpeg 两条解复用路径给出的包格式不同），而补 Annex-B 要按编解码器挑
  `-bsf:v h264_mp4toannexb` / `hevc_mp4toannexb`，挑错报 `Codec 'xxx' is not supported`。
  为一个冷门目标维护这张对应关系不划算，所以 avi 一律重编码。
- **编解码器名取 `Stream #0:0 … Video: h264` 里的第一个 token，不是括号里的 FourCC**。
  FourCC 随容器变（h264 在 mp4 里是 `avc1`、mkv 里是 `V_MPEG4/ISO/AVC`），第一个 token 跨容器稳定。
  而名字里的**下划线是承重的**（`pcm_s16le`），字符类要写 `[a-z0-9_]` 而不是 `\w`——
  漏掉的表现是「明明能 remux 却总是重编码」，不报错、只是白白慢几倍。

两条反直觉的实测：**`vp9 + opus → mp4` 是可行的**（原先按规范推定不行，两者都有 ISOBMFF 绑定）；
**`vp9 → mov` 不行**（`vp9 only supported in MP4`），所以 mov 那一行比 mp4 少一个 vp9。

**验收判据是码流指纹，不是「codec 名对不对」**（后者区分不了 remux 与重编码——两者都是 h264）：
`ffmpeg -i <f> -map <m> -c copy -f md5 -` 的输出**容器无关**（mp4/mkv/mov 三边逐位相同）、
重编码后必变。**唯一例外是 TS**：`ts/m2ts → mp4` 确实是 remux，但 TS 要**重新分装**，
所以指纹会变——那条路只能用「耗时显著低于重编码」来判，照搬指纹会得到一条假红。

⚠️ **还有一条时序陷阱：remux 把「原本慢的转换」变快了十几倍，于是凡是拿转换耗时当时序假设的
测试都会开始飘。** 已经踩到过一次：`test-tasks.ts` 的 `[5] 取消` 那段只 `addPaths` + `start`、
没钉目标，默认落到 mkv 而 h264+aac→mkv 正好能 remux——600 秒的素材一百多毫秒跑完，
取消打在完成之后（百分比 `0, 1, 1, 1`，正是 remux 的签名）。修法是给这类用例**钉一个必然重编码的
目标**（`webm`），**不是放宽断言**——放宽了取消路径就彻底失去覆盖。

**19. MCP 版跑在一个**没有 Electron** 的普通 Node 进程里，所以 `src/main/` 里那条链路
的依赖图不许碰 `electron`。**

`src/mcp/main.ts` 是独立入口（`node --import tsx src/mcp/main.ts`），它 import 的是
`converters/index.ts` → 各引擎适配器。两处承重的改造：

- **`converters/index.ts` 的引擎一律按需 `await import()`**：`document.ts` 会链到
  `engines/chromiumPdf.ts` → `import { app } from 'electron'`，静态 import 它等于让整个
  MCP 进程一启动就炸。改成按需之后「转一个 mp4」不会把 chromiumPdf 拖进依赖图（顺带
  让 Electron 主进程启动变快）。**加新引擎时别退回静态 import。**
- **`engines/registry.ts` 不再直接读 `app`**，路径由 `src/main/core/appPaths.ts` 注入
  （`setAppPaths()`；**没装就抛，刻意不做「兜底去问 electron 要」**——那种兜底会让
  「谁忘了装」永远不被发现）。MCP 入口从 `ARBITER_APP_PATH` / `ARBITER_RESOURCES_PATH` /
  `ARBITER_USER_DATA` / `ARBITER_DOWNLOADS` 读，猜出来的值全部报到 stderr（猜错的表现是
  「引擎明明装好了，MCP 却说没有」）。

这套东西**别的测试全抓不住**：`test:tasks` 走 `electron` 的桩、`test:pdf` 真起 Electron，
在那里把 electron 换回真的、把动态 import 换回静态，**两边都照样全绿**。所以
`scripts/test-electron-free.ts`（+ `npm run falsify:electron-free`）是唯一的观测点。
⚠️ 变异 import 时要**同时改调用点**，否则 esbuild 的 import elision 会把没用上的 import
整条删掉——变异成空操作，伪装成「断言抓不住错误」。

**20. MCP server 的进程边界上有四条实测约定（`src/mcp/`）。**

- **`stdout` 是协议的**。往它写一个非 JSON-RPC 的字节就破帧，客户端表现为「连着连着就断了」
  而服务端一声不吭。闸门在 `src/mcp/stdout.ts`：`console.*` 全部改道 stderr，`process.stdout.write`
  按行校验（**必须按行缓冲**：SDK 写大消息时会分两次 `write`），拦下的那一行会往 stderr 报一句。
- **路径是 agent 给的 = 不可信输入**。闸门是根白名单（`src/mcp/paths.ts`），读根与写根可以分开
  （`ARBITER_MCP_WRITE_ROOTS` 只**收窄**不追加）。判据走 `core/outputName.ts` 的 `isInsideDir()`，
  别另写一份前缀比较——`C:\data` 不该放行 `C:\database\x` 那件事在那里已经踩过。
  **别拿「文件不存在」当拒绝的证明**：测试要用一个**确实存在**的越界文件去撞。
- **客户端取消之后，服务端不会再为那个请求回话。** 实测：`convert_file` 挂在那儿时发
  `notifications/cancelled`，job 确实落 `canceled`、进程树被杀干净、没有孤儿也没有 `.part`，
  但**回话永远不来**（SDK 把那一帧压掉了）。所以测试**不能 `await` 它的返回值**——那个 promise
  永不 resolve，表现是「套件挂在半路且一条失败信息都没有」。要查结果只能靠 `get_job_status`
  （`convert_file` 的 job_id 这时也拿不到，公开接口里只剩 `get_job_status` 报错时带出的
  `known_job_ids` 可以取差集）。
- **「引擎没装好」必须在排队之前拒**（`jobs.ts` 的 `assertEngineReady`）。排到队再失败，
  agent 那时已经又发了两轮调用，然后拿到三条「转换失败」。

**21. 普通 Node 的 `existsSync` 看不进 asar——插件的打包分支就栽在这上面。**（实测，2026-09-13）

asar 支持是 **Electron 运行时**给 `fs` 打的补丁。而 `plugins/arbiter/mcp/launch.mjs` 是被
`.mcp.json` 里的 `command: "node"` 起的**普通 Node**，于是

```js
existsSync('<...>/resources/app.asar/out/main/mcp.js') // 恒为 false
```

三个必须记住的点：

- **后果是「判断错 + 提示方向也反」**：打包分支把「装着刚 `build:unpack` 出来的包」
  判成「没有 MCP 入口」，还打印「这个安装包可能早于 0.2.0」，让人去重装一个没问题的包。
- **它只在干净机器上现形**，也就是**只在用户那里炸**。开发机上 `candidateRoots()` 里有仓库根，
  那条路走普通文件系统，一切正常——我就是这么被骗过去的：插件端到端跑通了，走的是仓库分支。
- **修法是自己读 asar 头**（`plugins/arbiter/mcp/asar.mjs`）：偏移 12 处是 JSON 索引的字节数，
  紧跟着就是那段 JSON，`files` 一层层下去就是目录树。只读头部，不碰载荷。
  **判据要用 `usable`，不能写成 `existsSync(target.mcpJs)`**——`probe()` 改对了、
  后面那道闸门又复核一遍，照样白搭（反证里为此单列了一个变异）。

守卫是 `scripts/test-plugin-launch.mjs` + `scripts/falsify-plugin-launch.mjs`（两者都要先
`npm run build:unpack`，所以**不进聚合**——聚合得能在干净 clone 上跑）。断言里有一条
**专门把坑本身钉住**：`existsSync(join(asar, 'out/main/mcp.js')) === false`。

**⚠️ 适用范围的更正（2026-09-14 实测）——这一条差点被过度泛化成一条假 bug。**
「Node 读不进 asar」只对**起 `launch.mjs` 的那个普通 Node**（`.mcp.json` 里的
`command: "node"`）成立。进程一旦是 `ELECTRON_RUN_AS_NODE=1` 起的 **Electron**，asar 补丁
就生效、`readFileSync` 读 asar 内部**正常返回**；而 `launch.mjs` 拉起 MCP 走的正是这条路
（`launch.mjs:87/95`：`spawn(target.electron, [target.entry], { env: { ...process.env,
ELECTRON_RUN_AS_NODE: '1' } })`）。⇒ **打包形态下 `src/mcp/main.ts` 的 `resolveVersion()`
是准的**：实测真起一次 `launch.mjs`、往 stdin 发一帧 `initialize`，回帧里是
`serverInfo.version = "0.3.2"`，不是 `0.0.0`。

当初的推理链断在哪儿：普通 Node `readFileSync('...\app.asar\package.json')` 抛 `ENOENT`
（这条**是**实测的）⇒「所以打包后版本号恒为 `0.0.0`」。**两头都验了，中间换人的那一跳没验**
——量的是「我这个探测进程」，结论却要落到「`launch.mjs` 起的那个进程」上。
**判断 asar 读不读得进去，第一个问题是「谁在读」，不是「路径长什么样」。**

### 21b. **一条没能复现的观测差点变成假约束**：曾经判定「Node 读不进 asar」，据此把打包改成松散目录——同日撤回。（2026-09-14）

这是本仓库**自己骗自己**的一次，值得整条记下来，因为它的危害不是代码错，而是**文档错**：
那条结论已经写进 README、这里、`docs/PLAN.md` 的 D8 与 `electron-builder.yml`。

- **当时的观测**：打包形态下 `out/main/{cli,mcp}.js` 报
  `Error: Invalid package config …\resources\app.asar\package.json`（`getNearestParentPackageJSON`），
  推论是「Node 的 package.json 查找走 C++ binding，绕开 Electron 的 asar 补丁」。**这个推论是错的。**
- **推翻它的受控 A/B**（同一份 `electron-builder` 配置重建，同一个二进制）：四种组合全过——
  asar 里的 `cli.js` → `--version` exit 0、**真做一次转换也 exit 0 且产出合法 JPEG**（sharp 的原生模块
  经 `app.asar.unpacked` 解析）；asar 里的 `mcp.js` → exit 0、`已就绪`；插件启动器 →
  `形态 = packaged`、`已就绪`（连改动**之前**那份插件代码在 asar 上也是好的）。
- **最可能的真相**：当时盘上那份 `app.asar` 已被**我自己的手工探测覆盖过**，量的是自己弄脏的现场。
  同一天里还有两次同源的假象：Git Bash 把 `/d/project/...` 解释成 `\d\project\...`、
  `node -e` 里那层字符串转义把 `\r`、`\a` 吃成回车与响铃——**报出来的都是「路径不对」，
  看起来都像真错误**。
- **真正与 asar 有关、且实测成立的一条**：**别用 `@electron/asar` 手工 repack 覆盖掉这个 asar**。
  实测那样做之后 `sharp` 会 `Could not load the "sharp" module`——因为 electron-builder 的
  smartUnpack 会把 `.node` 落到 `app.asar.unpacked/` 并在索引里打标记，手工包没有。

**判据（这一条的落点）**：`scripts/test-plugin-launch.mjs` 第 3b 条是**正向控制**——
从**刚构建的真实产物**里以 Node 模式跑一次 CLI 入口、断言它打印出版本号。
原先那条「require asar 内部模块必抛 `ERR_INVALID_PACKAGE_CONFIG`」**复现不了，已删掉**：
复现不了的断言只会变成装饰（红了分不清是环境还是代码）。

**两条教训**：① 判据必须落在**刚构建出来的产物**上，别落在你探测过的那份上；
② 一条只观测到一次、且拒绝复现的结论，**不配写进约束**——先做受控 A/B。

**顺带一条同类的一般化（2026-09-14）：等价路径不是那条路径。** 同一轮里发现，
D2 那个 P0（「装好的应用里没有命令行」）的**全部交付物**是 `arbiter.cmd` 这一个文件，
而那时所有检查跑的都是
「用 `electron.exe` 的 Node 模式执行同一个入口」——它们之间隔着 cmd.exe 的整套解析
（`%~dp0` 展开、`%*` 传参、`exit /b %ERRORLEVEL%` 回传退出码），
**那个 `.cmd` 一次都没被执行过**。补的 3c/3d 走真文件（见下面 `test-plugin-launch.mjs` 那条）。

> 判据：**凡「交付物本身是个可执行的东西」的改动，检查必须真的去跑那个东西**，
> 而不是跑一条「按理说等价」的路径。等价是**推理**，而推理正是这里出错的那一环
> ——「`--version` 打印出正确内容」与「用户双击时那件事成立」之间没有任何东西自动保证。

**22. GPU 硬件编码（NVENC）默认关，而且它根本不是「无条件的加速」。**（实测，2026-09-13）

六轮实测（1080p60 / 20s，同素材同容器，3 次取中位）推翻了一堆直觉：

- **`-cq` 与 `-crf` 同号不代表同质。** 同素材上 `-cq 23` 的产物是 `-crf 23` 的
  **2.8 倍大**（62.39 MiB vs 22.33 MiB）。扫下来**只有 `-cq 30` 与 `-crf 23` 体积相当**
  （22.22 vs 22.33 MiB，而 SSIM 0.8136 vs 0.8090）。所以 `engines/ffmpeg.ts` 里
  那个 `30` 是量出来的，不是拍脑袋的。
- **它只在难编的素材上是净赚**：高熵素材 3.89 s → **2.89 s**（快 1.35×，体积持平）；
  同一规格的**平滑素材反而更慢**（1.77 s → 2.16 s，体积还大 43%）。所以默认必须关，
  它是个**取舍**而不是加速。`-preset p4` 是甜点（`p1` 在平滑素材上快但产物大 26%，
  `p7` 比 CPU 还慢）；`-tune hq` 那一套只换来 +0.01 SSIM，别加。
- **瓶颈常常不在编码那一段。** 4K 上 nvenc 仍然慢于 `libx264 veryfast`（2.34 s vs 2.19 s）。
  拆开量才明白：1080p60 高熵素材**纯解码就要 2.69 s**，而 nvenc 全程 2.93 s——
  ffmpeg-static 只有软件解码，GPU 只加速了其中很小一段。
  **`-hwaccel cuda` 一律更慢**（2.93 s → 3.75 s），别开。
- **消费级驱动的并发 session 上限，本机实测 8 路全过**（PLAN 里照抄的「历史 2~~8 路」不成立），
  但别的机器仍可能低到 2~~5 路。所以回退写成「**任何一次 GPU 失败都退回 CPU**」，
  队列的 `ENGINE_LIMITS` **当时一个字没动**——`queue.ts` 是枢纽文件，而 GPU 这件事本身没有
  「必须改它」的证据。（**后来因为并发的实测把它改成了 `ENGINE_CAPACITY`，见约束 25；
  改的理由是吞吐，与 GPU 无关。**）

三个必须记住的点：

- **探测能力不能查 `ffmpeg -encoders`**：这份 ffmpeg-static 6.1.1-essentials **任何**机器上
  都能列出 `h264_nvenc`（连 `av1_nvenc` / `*_qsv` 都有），它只回答「这份构建编得出来吗」。
  唯一可靠的判据是**真的编一帧**（`engines/nvenc.ts`，约 200ms，结果缓存）。
  反面证据也实测过：`-gpu 9` 指到不存在的设备上报 `No capable devices found` 并以
  **127**（不是 1）退出。
- **探测分辨率不能小**：64x64 会被编码器顶回来，报
  `Frame Dimension less than the minimum supported value`——那是**尺寸下限**，不是「没有 GPU」，
  误读的后果是有卡的机器永远走 CPU 且不报错。用 256x256。
- **回退不是降级**：`-cq 30` 那套参数本来就与 CPU 那套体积相当，所以回退后的产物正是
  不开这个开关时会得到的那个，代价只有「慢」。反过来，两次都失败时**必须把 GPU 那次的
  原因一起报出来**，否则用户开了开关只看到 CPU 的报错，会以为开关没生效。

验收在 `test-tasks.ts` 的 `[14] GPU 硬件编码`。⚠️ **那一节的断言刻意不按机器分叉**：
用 `setHardwareEncodeProbe` 把探测结果**强行压进去**，再额外造一个 64x64 的用例
（必然让 NVENC 失败），这样在任何机器上「回退」分支都被真执行到——
写成「有卡测这条、没卡测那条」的话，没卡的机器上那条断言就是**空集合恒真**，
本项目已经因此抓到过四条装饰性断言。另外那一节的素材**必须是 vp8**：
h264 的 mkv 转 mp4 会命中 remux（`-c copy`），一次都没编，断言会集体假绿。

**23. M8 右键菜单写 `HKCU`（免管理员），而 `reg.exe` 有四个坑，每一个都静默出错。**（实测，2026-09-13）

整条链路是「我们拼一条命令行 → 写进注册表 → Windows 读它 → 按那条命令行拉起我们 → 我们解析 argv」。
中间隔着两层别人的解析器，所以**任何一处出错都不抛异常**，表现统一是「右键点了没反应」。

- **写 `HKCU\Software\Classes\*\shell\Arbiter`，不写 `HKLM`。** 后者要 UAC，一个转换器为了
  一个右键菜单弹提权框是不可接受的；代价是只对当前用户生效，对个人工具正合适。
- **`reg query <键> /ve` 会把值名打出来**，而中文系统上它叫 **`(默认)`**（不是 `(Default)`）。
  原实现按「查默认值时名字那一列是空的」写，正则要求行首就是 `REG_`，于是**所有 `/ve` 读回
  全是 null**——装是装上了，却读不出命令行，自愈比对永远不成立。
  修法：**不认名字、只认类型标记**（`/ve` 至多一个值，「第一条」就是「那一条」）。
- **`reg.exe` 往管道里写的是系统 OEM 码页（这里是 GBK），不是 UTF-8。** 实测 `od -c` 抓到的是
  `B4 AC C8 CF`（`(默认)`）与 `D3 C3 B5 F7 …`（`用调律者转换`）。按 UTF-8 硬解得到一屏乱码
  **且不报错**。判据与约束 13 同一套：严格 UTF-8 → GB18030 兜底（`decodeRegOutput`）。
  stdout/stderr 要**攒成 Buffer 再解**，逐 chunk `toString()` 会把多字节字符切坏。
- **判「键不存在」只看退出码，绝不匹配 stderr 里的文案。** 那段文案正是乱码，写成
  `/find|找到|cannot find/` 的结果是「重复卸载」这条幂等路径整条失效。`reg delete` 的
  退出码 1 = 没找到 = 正常；只有 `-1`（reg.exe 压根没起来）才是真错误。
- **逐层清理必须判空**（`DeleteRegKey /ifempty` / `keyIsEmpty()`）。注册表没有回收站，
  一句不带条件的删除会静默删掉别人家的菜单项：`HKCU\Software\Classes\*` 在开发机上
  **本来就非空**（有 `OpenWithProgids` 与 `shellex`），而 `*\shell` 正是各家经典右键
  动词的落脚处——开发机上那里实测躺着迅雷的 `ThunderShell`，别的软件随时会往里加。
  清理列表由**键推导**（`pruneTargetsFor`）而不是写死，这样临时键在测试里也够得着；
  上界钉死在 `HKCU\Software\Classes\*`，再往上（`Classes` / `Software`）绝不能碰。
- ⚠️ **`reg query <键>` 对「恰好 1 个子键」的键也只打一行**，所以「非空行数 ≤ 1 ⇒ 空键」
  是错的——真正空的键输出**一个空行（0 个非空行）**，连键名都不打。写成 `≤ 1` 的后果
  是实际发生过的：卸载我们的键之后，只剩迅雷那一项的 `*\shell` 被判成空 → **删掉了
  别人的菜单项**。判据必须是「非空行数为 0」（`isEmptyQueryOutput`）。当时测试**是绿的**
  ——测试自己造的邻居键让它凑够了 2 行。**「恰好剩一项」这种边界要专门造一个出来测。**
- **Windows 11 的新版右键菜单默认不显示 `*\shell` 动词**，要 `Shift+F10` 或「显示更多选项」。
  这是系统行为，不是没注册上——但用户的第一反应是「这功能是坏的」，所以设置页把那句话写在明面上。
- **`MultiSelectModel=Single`**：`%1` 只替换成第一个选中文件的路径。不设它，用户框选 10 个文件
  点一下只会转一个，而且没有任何提示。
- **`second-instance` 事件带的是新 argv**，读 `process.argv` 会把第一个文件再转一遍。
- **卸载清理写在 `build/installer.nsh`（`customUnInstall`）里，而且那个文件必须带 UTF-8 BOM**
  （或显式 `/INPUTCHARSET UTF8`）：makensis 只在这两种情况下才按 UTF-8 读脚本，否则按系统 ANSI
  码页（中文机器上是 GBK）解，注释与文案一起静默写坏。只靠应用内那个开关是不够的——用户点
  「卸载」时不会先回去把开关关掉，而留下的那个键指向一个**已经被删掉的 exe**，菜单项还在、
  点了什么都不发生。

命令行拼接在 `core/cli.ts`（纯函数）：`%1` **不走** `quoteWindowsArg`（它是要被 Windows 替换的
占位符，转义了替换就失效）；反斜杠紧邻闭合引号时必须翻倍，否则 `D:\我的 工具\` 这种安装目录
会把闭合引号吃掉。**不覆盖的判据是「先校验再加」**：`TaskManager.setTarget()` 对不认识的目标
**静默 return**，所以 `enqueueExternalRequest` 在 `addPaths` **之前**就拿 `targetsFor()` 验一遍——
否则「`--to` 写错了」的后果是按默认目标跑完、产出一个用户没要的格式，还报成功。

验收在 `scripts/test-integration.ts`（真 `reg.exe` 往返，走**临时键**，全程不碰真实键）与
`scripts/falsify-integration.mjs`；`test-tasks.ts` 的 `[15]` 盯的是后半截（收入队列 / 当场开跑 /
出错必弹框）。

**24. 「重命名即转换」（M8 的另一半）默认关，而且它全部的代价都在「误判」那一侧。**（实测，2026-09-13）

语义只有一句话：用户把 `a.mkv` 改名成 `a.mp4`，**文件内容其实还是 MKV**。
于是我们把它改回 `a.mkv`，再按正常流程转出真正的 `a.mp4`。
**源文件以原来的名字原样保留，一个字节都没删——这就是「可撤销」的全部含义**，
用户反悔只需要把名字改回去。

`docs/PLAN.md` §M8 论证过这个功能的收益/风险比是差的，代价全在误判上：
漏判的表现是「改了个名，什么也没发生」（无副作用），误判的表现是**我们动了用户的文件**。
所以每一道闸都朝「宁可放过」的方向写，四个必须记住的点：

- **判据刻意写窄**（`core/renameWatch.ts` 的 `diffRename`，纯逻辑、零 fs 零 electron）：
  同词干两侧都必须**只有一个候选**（有歧义就整组放弃）；**体积必须完全相等**——改名不动内容，
  这是挡「删掉 `a.mkv`、又从别处弄来个不相干的 `a.mp4`」的**唯一一道闸**，
  刻意**不比 mtime**（多一条判据就多一种「用户那边不成立」的可能）；只认 video / audio / image 三类，
  且源与目标都得在 `targetsFor()` 里真有那条边——**不另写一张扩展名白名单**，
  另写一张必然与能力矩阵漂移，而漂移的表现是「界面上说能转，改个名却什么也不发生」。
- **`fs.watch` 只当唤醒信号，重扫结果才是唯一真相**（事件会重复、会带着过期的名字、会溢出丢失），
  所以事件只负责「过一会儿重扫一遍」。**我们自己的每一次改名之后都要立刻重建基线**
  （`handle()` 里那句 `refreshBaseline`）：少了它，「把 `a.mp4` 改回 `a.mkv`」在下一轮里
  看起来正好是一次**反向改名**，于是来回震荡。入队被拒时那次**回滚**同理。
- **零副作用是承重的**：开关关着、或目录白名单为空时，**一个 `fs.watch` 都不建**
  （`ipc/rename.ts` 的 `syncRenameWatch` 直接把目录列表算成空数组），
  而且 `setDirs` 在目录没变时**幂等返回**——设置页每存一次都会调到这里，重建一遍会白白丢掉
  已经建好的基线，于是刚重启那一瞬间「本来就存在的文件」会被当成刚出现。
- **入队被拒必须把文件名还回去**，而且**只能由 `renameWatcher.handle()` 一个人说**。
  告警写在调用方的 `enqueue` 里的话，同一件事会被说两遍，而且那一条说不出
  「文件名已经改回『x』」——失败时把用户的文件名留在半路上，比什么都不做还坏。
  通知走 `Notification`（`isSupported()` 为假时降级成 `console.warn`），
  **不弹模态框**：用户只是改了个文件名。

⚠️ `renameConvertible` 里那句 `requiresDownload(fromExt, toExt) === null` **今天完全是冗余的，
而且反证覆盖不到它**：三类里目前没有任何一条边要现下引擎（LibreOffice 357 MB / Calibre 213 MB /
pandoc 221 MB 全在 document / ebook 下），把那一行删掉测试一条都不会红。留着是因为它挡的是
**另一件事**——矩阵将来若给这三类加一条要下载的边，有它在就不会有人在毫无预期的时候被拉几百兆。
这一条**在源码里也如实写明了**，别当成「有断言盯着」。

验收在 `scripts/test-integration.ts` 的 `[5]`（判定，纯逻辑）与 `[6]`（装配：真临时目录 + 真 `fs`，
含一条真 `fs.watch` 事件）；反证是 `falsify-integration.mjs` 里那 6 个变异，其中两个各打过一次真事：
「自己改完名字不重建基线」（反向自我触发）与「入队被拒不回滚」（改了人家的名字还什么都不换）。

**25. 并发上限不是「任务个数」，是「份数」——而且 `maxConcurrent` 是上限不是目标。**（实测，2026-09-13）

`queue.ts` 的 `ENGINE_LIMITS` 已改名 **`ENGINE_CAPACITY`**，语义从「这个引擎同时跑几条」变成
「同时占几份」。`taskCost()` 给 ffmpeg 任务算份数：**输入 ≤ 1 MiB 记 1 份，否则记 3 份**
（量不到体积按重的算）。四个必须记住的点：

- **这个改动顺带暴露了一个真 bug**：改之前 `ENGINE_LIMITS` 是硬编码的（ffmpeg 4 / sharp 2），
  而设置页的「并发上限」下拉给了 1~16 —— **用户从 4 拉到 16，一个任务也不会多跑**。
  现在四个闸门取最小值：全局 `maxConcurrent` × 引擎容量 × 代价分摊。**下拉是上限，不是承诺**。
- **实测收益**（本机 24 核）：sharp 容量 2 → 4 是 **1.84×**（4032×3024 实拍 24 张：1362 → 743 ms）；
  放宽到 6 只再快 3.5%，**平台在 4**。ffmpeg 小文件 4 → 12 是 **1.75×**（40 个 64×64：399 → 228 ms），
  而 16 个 1080p60 在 4 与 12 之间**持平（±2%）**——所以大文件那一档必须继续按 3 份计，别一起放宽。
- ⚠️ **内存才是墙**：单个 1080p60 `libx264 veryfast` 进程**峰值 RSS ≈ 925 MiB**，
  12 路 ≈ 11 GiB。轻/重分档用的是**输入体积**，那只是个代理指标——真正的开销由**分辨率**决定
  （720p 峰值 345 MiB），而入队期拿不到分辨率。已知的、方向保守的欠估：
  一段 `-crf 51` 的 720p/12 秒只有 813 KiB，恰好落在「轻」那一侧。
- ⚠️ **绝对不要给 ffmpeg 传 `-threads`**：实测 `-threads 6` 在 conc=1 时把 30649 ms 变成
  **55265 ms**（1.8× 更慢）。x264 自己的「核数 ×1.5、1080p 封顶 34 线程」比手调更优。

**测量口径**：绝对耗时**随负载漂 20%+**（同一份代码相隔三小时差 27%，因为另一条线在跑），
所以判据一律写成**同进程内的比值**（`bench.ts` 的 `[5]` 节就是这么做的），
且不同上限之间要**交替**跑取中位——不交替时同一批文件能在 699~1007 ms 之间飘。

**26. M7 的按需下载：解包必须解到 `.installing` 再整体改名，而且必须有超时。**（实测，2026-09-13）

`core/engineInstall.ts` 是「下载 → sha256 → 解包 → 落 `engineDir`」这条链的唯一实现。
在这之前，`core/downlink.ts` 的消费侧写完了、149 条断言全绿，但 **`src/` 里没有任何调用者**
——干净机器上 `md → docx` 直接失败、一个字节都没下，还让用户去跑仓库里的构建脚本。

四个必须记住的点：

- **解到 `<target>.installing`，成功后再 `rename` 过去**。直接往最终目录里解的话，
  中断会留下一棵**半截但看起来完整**的树（`soffice.exe` 在、`soffice.bin` 不在），
  之后每次转换都报一个看不懂的错。整体改名是原子的：磁盘上要么没有，要么完整。
- **装完必须重置那三个解析器的缓存**（`resetHeavyCache()` / `resetPandocCache()`）。
  漏了这一步的表现是「**下载成功了，但永远显示未就绪**」——磁盘上一切正常，只能重启应用。
  这是本模块最容易写漏的一句，反证里有一个变异专打它。
- ⚠️ **解包必须有超时（现为 5 分钟）**。实测：这台机器上 `msiserver`（Windows Installer 服务）
  处于 STOPPED，`msiexec.exe` 起来后**一直等那个服务**——手工跑同一条命令也挂足 150 秒，
  `/L*v` 的日志文件**压根没被创建**（说明连命令行都没解析到）。没有超时的话，
  用户看到的是「正在安装…」永远转下去，不报错、不失败、只能手动取消。
  正常的 LibreOffice 解包实测 29 秒、Calibre 5 秒、7z 抽单文件不到 1 秒，5 分钟不会误伤。
- **同一个引擎必须单飞**（`inFlight` 表）。没有它，一批文档会同时发现「没有 LibreOffice」，
  然后并发下同一个 375 MB、并发解同一棵树——两个 `msiexec` 往同一个 `TARGETDIR` 里写字。

**实测**：打包形态下 `md → docx`（全新用户目录）**8.4 秒**完成下载+校验+解包+转换，
`pandoc.exe` 落地 231,717,128 字节，与清单的 `expectedEntrySizeBytes` 逐字节吻合。
⚠️ **MSI 那条解包路尚未在「服务正常」的机器上端到端跑过**——本机 msiserver 起不来。

**27. MCP 面的五处（`src/mcp/`）。**（实测，2026-09-13）

- **`convert_file` 的 `quality` 曾经是个死参数**：schema 里声明、工具描述里在讲，
  而执行路径**从没读过**（`submit()` 签名里没有、`ConvertContext` 里也没有）。
  后果是 agent 传 `quality: 18` 拿到 `status: done`、**没有任何提示说它被忽略了**。
  **已删除**——接通它意味着「任务参数通道」的开端，而 `Task` 只有 `inputPath/fromExt/toExt`，
  那条通道会牵动 `core/task.ts` 与 `core/queue.ts` 两个枢纽文件，是独立决策。
- **`list_jobs`（第 7 个工具；`read_document` 是第 8 个，见下面那条）**：在这之前，`batch_convert` 返回一批 `job_id` 之后
  **没有任何批量查询手段**——转 30 个文件要发 30 次 `get_job_status`，现在 **30 → 1**。
  ⚠️ 列表里**刻意不给 `log_tail`**（30 条 stderr 尾部能吃掉几千 token），`limit` 默认 20。
- **错误对象加了 `code` / `retryable` / `next_steps`**（10 个闭集值）。
  ⚠️ **`log_tail` 一个字没少**——那是本项目相对同类最有价值的一件东西，码是加在它上面的一层。
  ⚠️ `retryable` **不是常量**（`source_corrupt` 恒 false）。`disk_full` **刻意没进码表**：
  写盘失败被统一包成 `ConversionFailed`，这一层拿不到 errno，而按文案分码正是约束 23 第 3 条禁止的。
- **`target_format: "auto"`**：混合目录从「分批 N 次」降到 1 次。⚠️ 每条 job 必须**回显实际用到的 `to`**，
  否则用户会以为整批转成了同一个格式。**不做「智能猜用途」**——`auto` 的语义只能是用户的既有偏好。
- **`read_document`（第 8 个工具）**：读一个 `.docx` 从 `inspect_file` → `convert_file` → 宿主 Read
  的 **3 次调用降到 1 次**，顺带消掉两个真实风险：产物可能落在**读白名单之外**（默认读根是 cwd
  与 userData），或者被并发任务占了名变成 `x (1).md`——agent 拿到的 `output` 未必读得到。
  四条承重设计：
  - **落系统临时目录，绝不写用户的输出目录。** 否则用户每问一次「这文件写了啥」，
    他的输出目录里就多一个 `.md`。
  - **截断显式且可续读**（默认 2 万字符 + `offset`），否则一份 300 页 PDF 一次就能把上下文塞爆。
  - **扫描件给 `no_text_content` 而不是一个空串**——「空字符串」与「文档确实是空的」
    在 agent 眼里一模一样。判据复用 `converters/pdfText.ts` 的 `textlessReason`（**import，没有重写**）。
  - **缺引擎时给 `engine_missing`，不降级成「把源码当正文」**——那正是约束 28 在堵的那个静默洞。
    ⚠️ **PDF 那条路刻意不走 `convert()`**：`ConversionFailed` 是笼统的，而「不按文案分类」是硬规定，
    两者合起来**分不出「扫描件」与「坏文件」**，只有 `textlessReason` 能给出结构化判据。
    ⚠️ **重型路径先拒**：`doc/xls/ppt/odt`（要 LibreOffice 357 MiB）与 `epub/mobi/azw3`
    （要 Calibre 213 MiB）一律拒并说清代价——**epub 那条「用随包 7z 解包省掉 213 MiB」的想法没做**。

顺手修掉两个真 bug：`output_path` 给成一个**已存在的目录**会被静默改名成 `目录名 (1).jpg`
写到上一级（退出码 0、`status: done`）；以及 `test-mcp-server.ts` 的辅助函数把整帧交给
`toToolResult`，而 `content` 在 `frame.result` 里，于是 `isError` **恒 false**、文本恒空。

**28. 文档引擎的三个「静默的错」，判据要落在结构上。**（实测，2026-09-13）

- **扫描件 / 图片型 PDF → `txt`/`md` 会产出空文件而报成功**。造假样本实测：产物 **1 个字节**
  （一个换行）、任务成功、没有任何地方说得出「这份 PDF 没有文本层」。
  修法是按**字符数**（不是行数——空白行也会产出 `text=''` 的行）判空，报错时把两种可能
  （扫描件 / 真空文档）都摆出来并明说**本项目不含 OCR**。**刻意不猜「是不是扫描件」**：
  空白页与扫描页在这一层完全同形。
- **`pdf → png/jpg` 的兄弟名会撞**：同目录里同时有 `a.pdf` 与 `a-2.pdf`（拆页导出的常见命名）时，
  `a.pdf` 的第 2 页会占 `a-2.png`，而 `a-2.pdf` 转 png 的**本名**正是它 ——
  两条任务各自解析到同一个名字，后写的静默盖掉先写的。修法是转换开始时对输出目录做一次快照，
  存在 `<stem>-<k>.*` 就不占那个号。**残余窄缝**：源在别的目录而输出目录相同时看不到兄弟源，
  要彻底堵得动 `core/task.ts` 的 `claimed`。
- **`bmp` / `ico` 作为源，矩阵登记的 8 个出口第一格都走不到**：`sharp.format` 里**根本没有**这两项
  （连 `magick` 也是 `input:false`），喂真文件报 `unsupported image format`。
  **修法不是改路由**（实测 ffmpeg 自己写不出 gif，改路由是用六个坏格换七个坏格），
  而是给 sharp 补一步解码：ffmpeg 先解成 PNG。

**能力矩阵抽查**：6 个 category 全部源 × 目标 = **368 格，没有一格路由为空**；文档类 31 格逐格真跑，
外加 8 项**结构判据**（不看「非空」，看「是不是那个解析器写的」——例如 `htm → html` 里
不得出现被转义的 `&lt;h1`，那说明走了「当纯文本塞进去」的降级路径）。

**29. 界面与系统集成那四处的取舍。**（实测，2026-09-13）

- **「发送到」比右键菜单更适合多选**：往 `%APPDATA%\…\SendTo\` 放一个 `.lnk`，
  **完全不写注册表**，而且**一级菜单**（Win11 把 `*\shell` 藏进了「显示更多选项」，见约束 23）。
  ⚠️ **参数里没有 `%1`，这与右键菜单刻意相反**：快捷方式不做占位符替换，
  资源管理器是把选中文件**追加**到命令行末尾的。写成 `--convert "%1"` 会让 `%1` 作为字面量留下，
  表现是「每次转换都多报一个找不到的文件」。**这也正是它比右键菜单更适合多选的原因。**
- **完成后动作默认 `none`，而且默认档一次 IPC 都不发（含 `stat`）**。
  ⚠️ 实测：**`clipboard.writeText` 与 `writeBuffer` 互相清空**，两种格式无法共存——
  所以「复制产物」只写 `FileNameW` 文件引用，不补文本。
- **历史「重跑失败项」的冲突选择是靠改全局 `onConflict` 实现的**（给 `task.ts` 加 per-task 旋钮要动枢纽文件）。
  界面里明说了「同时把你的设置改成了刚选的那一档」。**这是全局副作用，是已知取舍。**
- **预置上次选择而不是自动执行**：只看**成功过**的同类最近一条，没历史时静默回落到
  `resolveDefaultTarget()`，绝不出现空选中（空选中会让「开始」变灰而用户不知道为什么）。

**两条 flaky 断言（截至 2026-09-13 未修）**：`test-tasks.ts` 里「2 秒内没有残留 ffmpeg.exe」
与「取消后没有孤儿进程」数的是**全机**进程数，任何并行的 ffmpeg 都会让它们假红；
`.tmp-test-tasks` 是**共享目录**，两个套件同时跑会互相删文件。
**根因同一类：判据用了全局资源而不是本次转换的私有资源。**

**30. `.gitignore` 对 electron-builder 的 `files` 完全无效——测试残留会被静默打进 asar。**（实测，2026-09-13）

两条独立机制，很容易误以为是一回事。`.tmp-*` 在 `.gitignore` 里（第 13 行），
而 `electron-builder.yml` 的 `files` **不看 .gitignore**。于是只要有任何一次测试
**崩溃或被 kill** 留下临时目录（`scripts/test-tasks.ts` 的 `[16] 清理` 就走不到），
下一次打包就会把它整个塞进 asar。

**实测代价**：一次被中途 kill 的 `falsify:tasks` 留下 `.tmp-test-tasks-52984/`
（`bulk.zip` 96 MB + `blob.bin` 96 MB + `long.mp4` 39 MB + 一堆 `heavy-720p*.avi`），
加上 `.tmp-test-pdf/out`（9.9 MB），**瘦包从 140.9 MB 涨到 445.6 MB**。
⚠️ **构建全程零报错、零警告**——不查体积根本发现不了。

修法是 `files` 里补四条（`.tmp-*` 与 `.scratch-*`，根目录与嵌套各一条）。
⚠️ **但那四条只挡得住目录，挡不住文件**（2026-09-14 实测）：`!.scratch-*/**` 里的 `**`
是「目录**里面**」，一个名叫 `.scratch-build.txt` 的**文件**照样进包——0.3.2 那次构建里
真的进了两条（代理自己留在仓库根的日志）。**目录与文件要各来一条**
（`!.scratch-*` / `!**/.scratch-*`），这与审计点出的「排除了文件却漏了同级目录」
正好是同一个错的两个方向。
但**根因是「残留会被打包」这件事本身没有守卫**：

- 打包之前先看 `ls -d .tmp-*`，有就先删；`du -sh` 一下成品，141 MB 上下才对。
  ✅ **这条守卫已经落成断言了**：`scripts/test-plugin-launch.mjs` 的第 14/15 条会枚举安装目录
  的全部条目、断言里面没有 `.tmp-*` / `.scratch-*`。实测反证过：把 `files` 里那两条排除
  注释掉、再造一个 `.tmp-guard-test/`，重打包后第 15 条**立刻翻红**（通过 14，失败 1），
  而第 14 条那条非空前置保持绿。
  枚举按**布局**分两支：asar 走 `listPackage()`（只读索引、不碰载荷，与 `asar.mjs` 同源），
  松散目录走 `readdirSync(..., {recursive:true})`。⚠️ 曾经写过「0.3.2 起安装目录不再是 asar、
  所以统一改成 `readdirSync`」——那是在 D8 **被撤回之前**写的：打包一直是 asar（约束 21b），
  真按那句话改，asar 那一支就再也枚举不出条目，而第 15 条会在**空集合上恒真**地变绿。
  这正是本项目抓过四次的那类装饰性断言，第 14 条那条非空前置就是为它准备的。

  ⚠️ **这条守卫的边界要认清：它只保证「做包那一刻」。** 2026-09-14 实测：同一轮收尾时
  仓库根又出现了 3 个 `.tmp-*`（40 MB），而第 15 条**照样是绿的**——它们是做完包之后
  才产生的。已核对当次发出的包是干净的（4538 个条目里 `.tmp-*` / `.scratch-*` 为 0），
  但**下次改打包流程时它保护不了你**：守卫的位置是「打包前查一次」，不是持续保证。
  另外 `files` 里的排除必须**目录与文件各来一条**：`!.tmp-*/**` 只匹配目录**里面**的东西，
  一个名叫 `.scratch-build.txt` 的**文件**照样进包（实测进过两条）。

⚠️ **同一形状的第三个实例（2026-09-15）：`files` 是黑名单，新加进来的目录会被静默打包。**
`files:` 下面**全是 `!` 排除项**，隐含 `**/*` 全包含——所以 `vendor/`（放 `file:` 依赖的
源 tarball，见 `vendor/README.md`）一进来就会带着 2.4 MB 的 `.tgz` 进 asar，而 npm 早就把它
解成 `node_modules/xlsx` 了，那一份纯属冗余。已补 `!vendor` / `!vendor/**`。两条要记住的：
① 上面本来就有的 `!*.7z` / `!*.zip` / `!*.tar.gz` **挡不住 `.tgz`**（不是同一个扩展名）——
别以为「反正有通用规则」；② `files` 只决定**什么进 asar**，与 `npm ci` 读不读得到 `vendor/`
**毫无关系**（npm 那一步在打包**之前**、读的是工作树）。这两件事很容易被当成一件。

⚠️ **顺带记一条同类的**：中途 kill `falsify-*.mjs` 会留下一处**没有标记的变异**。
脚本是「改坏 → 跑一轮 → 还原」，**还原发生在下一轮开始之前**，所以杀掉它时盘上留的
就是那一轮的坏代码，而脚本结尾那段「源码已还原」的自检**根本不会跑**。
实例：`falsify-tasks.mjs` 的「remux 判定恒真」把
`remux = canRemux(toExt, parseProbeOutput(probeErr))` 换成 `remux = true`——
**`grep MUTATION` 查不出来**（那条变异的替换内容就是裸代码，没有注释标记），
是 `git status` 发现的。**没查就打包，包里就是「不看编解码器一律 `-c copy`」。**
判据只能靠 `git status` 逐个变异目标文件核对，不能靠 grep 标记。

**31. 无损裁剪：`-ss` 的位置决定丢哪一头，而「时长变短」的根因可能在另一头。**（实测，2026-09-13）

参数通道落地时顺带做的第一件功能。`TaskOptions.trim` 的形状是 `{ start, end, mode }`，
**区间语义写死成 `[start, end)`、`end > start`**（注释里写死了，别改语义）。

**三条实测（素材 640×360 / 30fps / 10s / `-g 60 -keyint_min 60 -sc_threshold 0`，
关键帧落在 0,2,4,6,8；请求 `[3,5)`，判据是 `-f framemd5` 逐包比对）**：

| 命令                                                    | 实际覆盖源                                  | 容器报的时长 |
| ------------------------------------------------------- | ------------------------------------------- | ------------ |
| `-ss 3 -i in -t 2 -c copy -avoid_negative_ts make_zero` | `[2, 5]`                                    | 3.14 s       |
| 同上**去掉** `make_zero`                                | `[2, 5]`（内容逐包相同）**首包 pts = −1.0** | 2.07 s       |
| `-i in -ss 3 -t 2 -c copy`                              | `[4, 5]`，**`[3,4)` 永久丢失**              | 2.05 s       |
| `-ss 3 -i in -c copy -to 5`                             | `[2, 8.1]`，多出 6 秒                       | 5.13 s       |

三个必须记住的点：

- **`-ss` 放 `-i` 前 = 回退到前一个关键帧；放 `-i` 后 = 前进到下一个关键帧。**
  两者都不是帧级准确，而**后者会静默吃掉 `[3,4)`**——用户要的内容直接没了，且不报错。
  无损模式必须用「放前面 + 明确告诉用户起点会对齐到最近的关键帧」。
- **`-avoid_negative_ts make_zero` 是承重的，不是顺手加的。** 少了它，头部那一秒的 pts 是**负的**，
  而 mp4 表达不了负时间戳，于是**容器只报 2.07 s**。⚠️ 注意症状的误导性：
  看起来像「尾部少了 1 秒」，**根因其实在头部**——所以排查时别只盯着尾巴。
- **整条流 md5 在裁剪上用不了**：产物只是源的一个子集，指纹**必然不同**，哪怕一个字节都没重编。
  能用的是 **`-f framemd5` 逐包比对**（判据写成「产物的每个包在源里是连续且逐位相同的一段」，
  它同时给出覆盖区间）；整条流 md5 只在**覆盖整段**的裁剪（`[0,100)` 对 10 秒源）上才能做交叉验证。

**关键帧对齐要三组一起测**（`[3,5)→[2,5]`、`[4,6)→[4,6.13]`、`[5,7)→[4,7]`）：
只测一组排除不了「总是回退一个 GOP」；`[4,6]` 那组（4s 本身是关键帧、不回落）才是反例。

**另外两条设计取舍**：

- **`→ gif` 仍然显示裁剪按钮**，因为判据是按**源类别**（video/audio）而不是目标格式——
  `video → gif` 的**精确模式真能用**（`-ss/-t` 加调色板滤镜），拦掉等于砍掉一个能工作的功能。
  而「按 `toExt` 拦」还会与 `setTarget` 打架（先设裁剪再改目标格式，要么静默丢掉用户的裁剪，
  要么留下一个 UI 本不允许的状态）。无损模式在 `→ gif` 上必然失败，**失败信息里明确写了「改用精确模式」**，不静默降级。
- **`TaskManager.setOptions` 回布尔，而 `setTarget` 是 void**——这处不对齐是**有意的**：
  这条链路上有四种「静默不办」（任务不存在、运行中、类别不支持、参数没变），
  界面上的痕迹一模一样，面板靠这个布尔才能说「没能设上」。（`setTarget` 不必回：
  被拒的目标格式会让下拉弹回原值，那本身就是回执。）

**32. 处理链是一个**有序数组**，不是一堆平行开关——而顺序是承重的。**（实测，2026-09-14）

`TaskOptions` 的三块各司其职：`trim`（选一段）/ `output`（编码目标：体积 · 码率）/
`filters`（**有序**的像素处理链）。**前两者刻意不进链**——它们不是「改变像素的步骤」，
进了链「这条链能不能重排」就没有答案了。

七个必须记住的点：

- **顺序真的会改变结果。** `docs/RESEARCH.md` §4.1：去隔行 → 降噪 → 锐化，
  **反了会把隔行留下的一半行当成细节、把噪点一起锐化出来**。
  界面上「添加」按规范次序插入（去隔行 < 降噪 < 锐化 < 旋转 < 缩放 < 响度），
  但**不禁止手动调序**——可调序正是这个数组存在的理由。
  ⚠️ **旋转排在缩放之前**（与直觉相反）：`rotate()` 会换掉宽高，
  之后 resize 的宽高才对应屏幕上看到的方向（`image.ts` 里早就立过这条规矩）。
- **两张表，别合成一张。** `canFilter(category)` 管「这一类有没有链」，
  `canUseAction(action, category)` 管「这一步放不放得下」。合成一张的话，
  将来放宽前者会把后者一起放宽。**界面与 `TaskManager.setOptions` 读的是同一份。**
- **`-vf` 只能有一条。** ffmpeg 对多个 `-vf` **只取最后一个**——gif 那条路本来就有
  一条写死的 `-vf`（palettegen/paletteuse），用户链必须与它**合并成一条**，
  否则链会**静默失效**而任务报成功。
- **有滤镜时 remux 与无损裁剪必须失效。** `-c copy` 搬的是原始码流，滤镜改了像素就装不进去。
  这一条以前只是**隐含**成立（`filters` 只对图片开放，而图片不走 remux），
  视频链一开放它才变成真的承重。两者同时出现是**调用方自相矛盾**，照 `-c copy` 那条先例**报错**。
- **加动作时的两处编译期守卫**（都验过：漏一处就编译不过）：
  `shared/options.ts` 的 `describeAction` 有一个 `never` 兜底；
  `converters/image.ts` 的 `FILTER_BUILDERS` 是按 `kind` 索引的映射，
  新增成员必须补一行（图片不适用的那几个显式 `throw`，**不能从映射里省掉**——
  省掉就退回「静默少一步」）。
- **两遍 loudnorm**：单遍是**动态**归一化（改动态范围、音质会变），两遍才是「整段平移一个增益」。
  判据是「产物两段的响度差与源基本一致」，单遍会把那个差压扁（实测 30.6 → 6.9 LU）。
  ⚠️ **`linear=true` 不是判据**：实测去掉它产物逐字节不变（默认值就是 true），
  把它写进断言只会得到一条装饰。
- **无声源 + 响度归一化**：没有音轨时第一遍会以「一条输出流都不剩」失败，
  所以先用**结构判据**（源里有没有音频流）判，跳过并说清楚，而不是让整条任务失败。

**33. 一次外部分发版审计带出来的实测结论。**（2026-09-14）

审计对象是 0.2.0 分发版（`out/main/*.js`）。它最重的四条发现是**同一个形状**：
「一个地方立了规矩，另一个同类地方忘了执行」。以下是修复过程中**量出来的**东西：

- **`chunk.toString('utf8')` 的损坏是时序性的，不是「文件大了必坏」。**
  同素材同机器量 11 次：只有读块顶到 64 KiB 上限、恰切在一次写的中间时才丢字符
  （每次丢 3 个）。命中率：1.15 MB 素材约 **1/6**、9.7 MB 约 **2/5**；
  多数运行里读块正好与 pandoc 的写块（约 5 KB）对齐，**一个字符都不丢**。
  ⇒ **这一行跑绿了不证明它是对的**，所以除行为断言外还必须有一条
  **结构性判据**（五个子进程适配器都把跨块解码交给 `setEncoding`）。
  这是「静默失败」最典型的成因：概率性触发 + 失败不可见。
- **`test:tasks` 曾把 40 多分钟花在纯等待上。** 根因不是那些慢用例，而是
  `settle()` 等的是整个 manager，而前面几节留了一批「入队但从不 start」的任务
  （永远停在 `queued`）——于是此后**每一次** settle 都白等满 90 秒超时，
  29 处调用乘以 90 秒。**修法是结构性的**：一个 `queued` 任务要变 `running` 只有两条路
  （测试自己同步调 `start()`，或某个正在跑的任务结束时队列自己 pump），
  而「一个 running 都没有 + 排队集合连着几轮不变」时两条路都不可能发生。
  修完 **45 分钟 → 57 秒**。⚠️ 这条顺带解锁了 `falsify:tasks`
  （21 个变异从「约 7 小时」降到 **22 分钟**）。
- **随包的 ffmpeg 根本解不了 `svg`**：八个图片目标**全部**失败、退出码 **−22**、
  `Decoding requested, but no decoder found for: svg`。对照组 `png → bmp/ico` 成功。
  又因为 ffmpeg 是自带引擎，`requiresDownload()` 返回 `null`——**用户得不到任何提示**。
  修法与 HEIF 同形：一张 `FFMPEG_UNREADABLE_SRC` 表，从目标集里剔掉 bmp/ico。
- **反证的期望清单会与断言文案漂移，而它报的是「有断言没红」。**
  `reds.includes(label)` 是**精确匹配**：断言文案后来被人加了括注、期望清单没跟上，
  于是变异明明被抓住了、脚本却报「抓不住」——**读起来像断言失效，其实是期望过期**。
  实测一次 `falsify:tasks` 报了 7 处，**7 处全是这个**。
  ⇒ 期望清单只能收**实跑观测到**的文案，不能照别人的转述抄。
  （`falsify:tasks` 长期没跑完过，所以这处漂移一直没人看见——「不跑的测试就是不存在的测试」。）
- **引擎超时值 5 分钟的出处**：Calibre 533 KB epub → pdf 实测跑了 **147.8 秒**才崩，
  LibreOffice 2.16 MB docx → pdf **35~36 秒**。两分钟级的超时会误杀真实转换。
- **`output_path` 指向一个已存在的文件**曾是静默改道（写成 `x (1).jpg` 并报 `done`）——
  而 agent 随后去读那个路径，读到的是**上周的旧内容**。产出与请求不符而不报错，比拒绝危险得多。
  ⚠️ 但 `batch_convert` 的落点是我们算出来的（不是用户点名），那一档**照旧改名**——
  否则「同一批再跑一次」会整批被拒，而 agent 无法逐条改名。
- **审计自身的方法学教训**（值得记）：那份报告最重的结论**被它自己的实测推翻过一次**——
  三个独立分析会话各只看到半个系统，真正的检查在更上一层。
  **「这个函数没有做 X」不等于「这个系统没有做 X」**：断言全局缺失之前，
  要么 grep 那句可能的文案，要么真的跑一次。

**34. CLI / MCP 要生成 PDF，只能起一个**真的 Electron**子进程——而「这里有没有 Electron」有三种形态，中间那种专门骗人。**（实测，2026-09-15）

`docx / html / md / xlsx → pdf` 在 CLI 上是**该通**的一条路：`requiresDownload()` 刻意让它
不必拖 357 MiB 的 LibreOffice，前置检查（能力矩阵 / 引擎就绪）全部放行。它坏起来是**静默**的，
报出来的是 `code=source_corrupt`「你的源文件坏了」——一次把因果指反的归因。

**病根是 `engines/chromiumPdf.ts` 顶层的值 import**（`import { BrowserWindow, type Session } from 'electron'`）：
它那个 chunk 在**加载期**就 `require("electron")`，而它是 pdf 出口必经的一环。
打包形态下 asar 里没有 `node_modules/electron`，于是 CLI（`ELECTRON_RUN_AS_NODE=1`）
走到 pdf 出口就抛 `Cannot find module 'electron'`。

三个必须记住的点：

- **`require('electron')` 的三种形态**（本机实测，`ELECTRON_RUN_AS_NODE=1 electron.exe -e …`）：

  | 进程                                               | 结果                                         |
  | -------------------------------------------------- | -------------------------------------------- |
  | 真的 Electron 主进程                               | 模块对象，`BrowserWindow` 是个类             |
  | **`ELECTRON_RUN_AS_NODE`**（CLI / MCP 的真实处境） | **不抛**，返回 electron.exe 的路径**字符串** |
  | 普通 Node / 打包 asar                              | 抛 `Cannot find module 'electron'`           |

  ⚠️ **中间那一行是承重的**：「加载不抛就算拿到了运行时」是错的。所以 `loadElectron()`
  有**两道**判据（加载不抛 + `typeof BrowserWindow === 'function'`），且**只认
  「找不到的正是 electron」这一个原因**——凡是 `MODULE_NOT_FOUND` 就当成「这里没有 Electron」，
  会把一个**装坏了的** Electron 悄悄引到子进程那条路上。

- **这个坑在 dev 形态下永远不现形**：`tsconfig.test.json` 把 `electron` 指向
  `scripts/electron-stub.ts`，桩里的 `BrowserWindow` 让那道判据答「有」。**只有打包产物能复现。**
- **子进程的协议走文件，不走 stdout**：父进程的 stdout 是协议通道（约束 20）。子进程是
  一个真 Electron 主进程，会往两条流上打一大堆启动噪音，所以两条流一律 `pipe` 到自己手里
  只当诊断用。`ELECTRON_RUN_AS_NODE` **必须从子进程环境里删掉**（否则子进程又是 Node，
  又走委托分支，**一层层递归 fork**；`ARBITER_PDF_WORKER_DEPTH` 是第二道闸）。
  父进程退出时用 `process.on('exit')` 把还活着的子进程带走（只能同步 `child.kill()`——
  `printToPDF` 一旦开始就打断不了，所以取消信号根本传不到那一层，**这是刻意的降级**）。

**判据是两条，一结构一行为**（`scripts/test-plugin-launch.mjs`，**必须先 `npm run build:unpack`**）：

- **结构（第 16/17/18 条）**：从 `cli.js` / `mcp.js` 出发走**所有** require 边（惰性与加载期都跟），
  断言闭包里没有人在**加载期** `require('electron')`。例外清单只有 `chunks/downlink-*`
  一条，而且是**如实记的已知缺口**（见下）。第 16 条是**判据自证**（必须认得出 `index.js`）、
  第 17 条**防空转**（闭包里必须真的有 `chromiumPdf` 分块）——少了这两条，第 18 条在
  「分类器永不命中」或「遍历没穿惰性边」时**照样绿**。
- **行为（第 19/20 条）**：真跑 `arbiter.cmd convert x.md --to pdf --json`，判据取
  **PDF 魔数 `%PDF-`**，不取「退出码 0」（后者在产物 0 字节时照样绿）。

**反证实测（2026-09-15）**：把那句值 import 放回去、**并让调用点真的用上它**，
第 18 条立刻翻红、19/20 一起红（stderr 正是 `Cannot find module 'electron'`），
通过 21 / 失败 3；还原后 24 / 0。⚠️ **只改 import 不改调用点是空操作**——
`BrowserWindow` 在当时只出现在**类型位置**，rollup 会把整条 import 抹掉，
变异伪装成「断言抓不住」（约束 19 那条也记过同一个坑）。

⚠️ **同一天撤掉一条错误归因，值得单独记**：这里原先写着「**凡是静态进了 `index.js` 的模块，
任何别处对它的动态 import 都会被降级成 `require("../index.js")`**」，并把它当成这个 P0 的机制。
**它复现不出来**：当天做了三组受控变异（`index.ts` 静态拉 `pdfWorkerHost` / 静态拉 `chromiumPdf` /
宿主里加一句值 import），**三种都不产生那条边**，rollup 一律把目标留成自己的 chunk。
按「一条只观测到一次、又拒绝复现的结论不配写进约束」的规矩（与 21b 同源）撤掉，
`index.ts` 那句动态 import 相应**降为防御性约定**。真正的病根是上面那句值 import。
**教训**：写约束时的因果链必须是**测出来的**，不是从「产物里看到了什么」推出来的——
那次是先在产物里看见一句 require 栈，再把机制**编**圆了。

**顺带一条同源的（2026-09-15）**：`npm run test` 是一条 `&&` 链，**前面一套崩掉之后，
排在它后面每一套的失败全部隐形**——而崩溃点与失败点可以毫无关系。实际发生：
`test:mcp` 在造 xlsx 素材时抛异常（就是下面 35 那条），于是排在它后面的
`test:tasks` / `downlink` / `pandoc` / `pdf` / `i18n` / `audit` **一套都没跑**；
而 §3.3 那次改动留下的**一条过期断言**（`test-mcp-server.ts` 的 `[5] 33` 仍断言
`code === 'internal'`）恰好也在这个套件里、排在崩溃点**之后**——两处互相掩护，一起消失。
更坏的是我当时那条命令末尾挂了句 `; echo`，把聚合的真实退出码吃掉了，
**harness 报了 exit 0 而测试其实崩了**。⇒ 跑聚合必须**显式把退出码打出来**
（`npm run test > log 2>&1; echo "EXIT=$?"`），而且**看见「有一套红了」不等于只有那一套红**：
崩在半路时后面的套件需要单独补跑。

**35. 同一个包的两条入口可能落在两个不同的文件上——tsx 下 `await import()` 走的那个，未必是打包后 `require()` 走的那个。**（实测，2026-09-15）

判据是包有没有 **`exports` 字段**（`npm view <pkg>@<ver> exports main module`）：

- **没有 `exports`**（`xlsx@0.18.5`：只有 `main: xlsx.js` / `module: xlsx.mjs`）→
  `import` 与 `require` **都**落 `main`（Node 不看 `module`），两边是**同一个文件**。
- **有 `exports`**（`xlsx@0.20.3`：`{".":{"import":"./xlsx.mjs","require":"./xlsx.js"}}`）→
  两边**各落一个构建产物，而且是两个独立实例，可以有完全不同的行为**。

实测（同一进程、**真 `.mjs`**，`xlsx@0.20.3`）：

| 取法                   | 落到                   | `XLSX.writeFile`            |
| ---------------------- | ---------------------- | --------------------------- |
| `import 'xlsx'`        | `xlsx.mjs`             | ✗ `cannot save file <路径>` |
| `await import('xlsx')` | 同一个 `xlsx.mjs` 实例 | ✗ 同上                      |
| `require('xlsx')`      | `xlsx.js`              | ✓                           |

现象**看起来像路径问题**（报错里就带着一个完全合法的路径），实际是 `_fs` 没接上：
两份文件的 `_fs` 都靠 `set_fs()` 注入，**只有 CJS 那一份在末尾自己接好了**
（`xlsx.mjs` 里没有 `require`，接不了）。`read` / `utils.*` 一概正常，所以**只有「写」会炸**。

四个必须记住的点：

- **生产走的是 `require` 那一支**：`electron-vite` 把 main / mcp 打成 CJS，所以这次升级
  对生产是安全的——而且 `htmlSource.ts` 用的是 `XLSX.read(buffer, {type})`，**从不碰
  `readFile` / `writeFile`**，压根不经过 `_fs`。踩到的是 **tsx 跑的测试脚本**：
  `test-mcp-server.ts` 那句 `await import('xlsx')` 在 tsx 下**保留为真 ESM import**，
  而同一个文件顶部的**静态** `import`（被 tsx 编成 `require`）与它**是两个实例**。
  这是本项目里「测试与生产走不同路径」第一处**真有实测后果**的分歧。
- **别拿「另一个探针脚本」去证明这件事。** 第一版探针写成 `.ts`、里面写
  `import * as ESM from 'xlsx'`，而 tsx 把它编成了 CJS——于是那个「ESM 组」**跑的其实是
  `xlsx.js`、写得好好的**，我差点据此推翻正确的结论。判 ESM 解析要么用**真 `.mjs`**，
  要么直接读 `package.json` 的 `exports`。与 21b「等价路径不是那条路径」同源：
  **探针自己也会走错路，而且错得没有声音。**
- **修法要让「解析到哪个入口」变得无关**，而不是去补那句 `set_fs()`：素材生成改成
  `writeFileSync(路径, XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }))`——
  `write` 在内存里出字节，两个入口都能用，落盘交给 node 自己。
- ⚠️ **升级到 0.20.3 的全部理由是两条 CVE**（CVE-2023-30533 修在 0.19.3、
  CVE-2024-22363 修在 0.20.2），而在本项目用到的那几个 API 上两版**行为逐字节相同**——
  所以 `test-doc.ts` 的 `[10]` 只能断言**版本号**，行为那一侧无论怎么测都分不出这两版。
  怎么装进来的见 `vendor/README.md`（vendor tarball，npm 上没有 0.20.x）。

**36. 全局快捷键（E-7）：三条判据全是静默的，而且有一条专门为中文用户而设。**（实测，2026-09-16）

判据在 `src/renderer/src/lib/shortcuts.ts`（**零 React、零 DOM**），绑定在
`src/renderer/src/hooks/useShortcuts.ts`。分这一刀不是为了好看：这个模块里每一条判据
出错的表现都是「按了没反应」或者更糟的「不该动的时候动了」，**没有一条会崩、会报错、
会进日志**——只有把「当时焦点在哪、队列什么样」喂进一个纯函数，它们才测得到。

| 键             | 动作                           |
| -------------- | ------------------------------ |
| `Ctrl/Cmd + O` | 收入文件（同「收入文件」按钮） |
| `Enter`        | 开始调律（仅当队列里有待跑的） |
| `Esc`          | 取消**正在跑**的转换           |

四个必须记住的点：

- **输入法组字中一律不接管**（`ctx.composing`，判据里的第一条）。中文用户敲 Enter
  十有八九是在**上屏候选词**，而这时焦点往往在画布（body）上——后面每一条判据都会放行它。
  少了这一条，用拼音打字时每选一次词就往队列里塞一次「开始」，而队列里恰好有东西可跑时
  它**真的会跑起来**。这是本项目里第一条专门为中文输入场景写的判据。
- **Enter 的归属要按焦点判两次**：焦点在 `INPUT` / `TEXTAREA` / `SELECT` / `contenteditable`
  上时归它自己；在 `BUTTON` / `A` 上时也归它自己（浏览器本来就会把 Enter 派给那个元素
  = 点一下）。少了后者就是「按一下干两件事」——焦点落在「清空」上时，一次 Enter
  既清空了已完成、又启动了队列。
  ⚠️ **`Ctrl+O` 刻意不走这两条**：绝大多数应用里它在输入框里也照常打开文件，
  而且它带修饰键，不会跟「在输入框里打字」撞车。这个不对称是有意的，有断言钉着。
- **只在工作台生效**（`page !== 'work'` 一律回 `null`）。其余三页各有一整套表单，
  接管 Enter 只会添乱。绑定挂在**工作台组件**里而不是 `App.tsx`：工作台是用 `hidden`
  保活的，切页也始终挂载，所以监听器不会掉；而挂到 `App.tsx` 就拿不到 `collect()`
  那套「三种结果分三种说法」的回执，只能复制一份（两处措辞必然漂）或者搬进 store
  （而 store 的接口上明确写着「提示怎么说不该由 store 决定」）。
- ⚠️ **`Esc` 是取舍，不是无风险**。它确实能一下掐掉一个跑了两小时的转码。之所以这么定：
  源文件一个字节都没动（转换从不改源），取消只丢中间产物，重跑就是再敲一次 Enter；
  反过来批量任务里「停下来」没有快捷键的话，只能一个个去点。代价用**一条 toast 回执**
  兜住——误触是**看得见**的，不是静默发生。

**键位表放在判据旁边，不放在设置页的 JSX 里**（`SHORTCUT_TABLE`）。设置页那张表是给人看的，
而「给人看的」与「判据认的」是两份东西，漂了不会有任何反应——用户照着按，什么也不发生。
放一起之后 `scripts/test-shortcuts.ts` 就能拿每一行**真的喂进 `resolveShortcut`**。
设置页只提供文案（`SHORTCUT_HELP`，类型是 `Record<ShortcutAction, string>`：
加第四个快捷键而忘了写文案是**编译错误**）。

验收：`scripts/test-shortcuts.ts` 38 条（每一组判据都**两个方向都断**——说「输入框里的 Enter
不算」之后紧接着断「同一个 Enter 放在 body 上就算」，否则一个恒返回 `null` 的实现能让
「回 null」那一半全绿）；反证 `falsify-shortcuts.mjs` 7 个变异，其中一条专打
「键位表与判据脱节」。

---

**37. PNG 出口的 `effort` 扛着 3~4× 的体积——而 E-9（oxipng）量完之后**不做**。**（实测，2026-09-16）

### 先量出来的那件事：`effort` 是承重的

1440×960 实拍 HEIC 源，`compressionLevel` 固定 9：

| 设置                             | 体积      | 耗时    |
| -------------------------------- | --------- | ------- |
| 只给 `compressionLevel: 9`       | 1929.4 KB | 84 ms   |
| 加上 `effort: 7`（= 现在这一档） | 466.3 KB  | 677 ms  |
| `effort: 10`                     | 464.3 KB  | 1070 ms |

**一个旋钮扛着 4.1×**。它此前**一条断言都没有**——`effort` 看起来像个可有可无的调优参数，
谁顺手删掉它，用户拿到的就是一张大了四倍的 PNG，而**不会有任何地方报错**
（PNG 是无损格式，「体积变大」不触发任何检查）。现在由 `test-image-options.ts` 的 `[6]`
钉着，反证是 `falsify-image-options.mjs`。

⚠️ **判据写成同机同版本同一份输入上的比值，不是绝对字节。** 写成「产物 = 466.3 KB」的话，
下一次升级 libvips 就会红，而那时它红得毫无意义、只会被人删掉。

⚠️ **素材用真随机，不用那个 LCG「噪声」**。三种素材实测的倍数：
**实拍 HEIC 4.14× / 真随机 3.00× / `makeSource` 那个 LCG 2.17×**。
`makeSource` 的 LCG（只取 `seed >>> 16 & 0xff`）造出来的字节其实**很耐压**——
2400×1600 的 11.5 MB 原始数据只压出 92 KB，余量薄到贴着门槛跑，
那会变成一条时红时绿的断言。真随机素材还顺带不依赖 fixtures。

### 再量 E-9：oxipng 值不值得

`oxipng@1.0.1`（npm 包，2.3 MB，**自带三平台二进制、没有 install 脚本、不碰 GitHub**，
绕开约束 15）实测：

| 素材                                        | 体积收益 | 耗时增加 |
| ------------------------------------------- | -------- | -------- |
| **真实照片**（iPhone HEIC，我们自己的链路） | **0.1%** | **+40%** |
| 真随机 / 截图 / 纯色                        | 0.0~0.1% | —        |
| 纹理 / 背景图这类低色数图像                 | 14~71%   | —        |

机器上 37 张真实 PNG（>8 KB 且 >0.2 MP）的分布：**平均 4.50%，中位约 0.1%，
只有 5/37 达到 ≥5%**。省得最多的那几个（71% / 42% / 24%）全是纹理、背景图那一类。

⇒ 按 §9.1 给 E-9 **预先写下的判据**（「收益 <5% 而耗时翻倍就不值得默认开」），
**判定不做**：照片是我们 PNG 出口的主战场，而它在那里收益是 0.1%、代价是 +40% 墙钟。
`oxipng` 唯一真正发光的是低色数图形，为它多养一个引擎（注册表、设置项、UI、
MCP schema、断言、反证）不划算。

⚠️ **一条方法论**：我合成的那个「photo」素材一开始报了 **14.1%** 的收益，
而换成真实照片之后是 **0.1%**——**素材造出来的假象**。
判「这个引擎值不值得引」之前，素材必须是真实世界的那一份（与「自己能造出来的东西
多半也能验自己」同源）。

---

**38. 产物缩略图（R20）：它是**补充**，而文字必须自足——因为**有客户端会静默丢掉 image block**。**（实测，2026-09-16）

`src/mcp/thumbnail.ts` 把图片产物按 `≤512px` / `q70` / `≤200 KB` 回一张 JPEG，
**默认关**，`ARBITER_MCP_THUMBNAILS=1` 打开。四个必须记住的点：

- **文字块一定是第一块，而且必须自足。** 生态里**有客户端会静默丢掉 image block**
  （不是报错，是那一块根本不渲染、也不转发给模型）。把「转出来多大」只放在图里，
  等于把「agent 能不能回答」押在客户端的渲染实现上。所以开了之后 `convert_file` 的
  文字块里**补上 `output_pixels`**（格式 = `to`、体积 = `size_bytes` 本来就有）。
  有一条断言专钉块序（`blockTypes[0] === 'text'`）——只数 `images.length` 是断不出顺序的。
- **只在 `convert_file` 里取，`get_job_status` 不取。** 轮询那条路上每问一次就要重编一张，
  而 agent 常常连着问十几次。这条也是**设计**，有断言钉着。
- **白名单是「sharp 读得开」而不是「它是个图片格式」**：`bmp` / `ico` 也是图片，
  但 `sharp.format` 里根本没有这两项（约束 28）。写进去的表现是这两类产物
  **每次都白跑一遍 sharp 再失败**——不报错、只是白花时间。
- **失败一律当作「没有缩略图」**（`makeThumbnail` 吞掉一切异常回 `null`）。
  为了锦上添花的东西让一次成功的转换回一个错误，是把主次颠倒了。

⚠️ **开关走环境变量而不是设置项**：它是 MCP 面的行为，而 MCP 就是在 `.mcp.json` 里配的
（同一个文件里还有 `ARBITER_MCP_WRITE_ROOTS`）。取值形状照 `ARBITER_IS_PACKAGED` 的先例：
**只有 `'1'` 才算开**。

验收：`test-mcp-server.ts` 第 10 节 16 条（**起两个会话**——「默认关」那半边只能另起一个
进程才测得到，环境变量是启动时读的）；反证 `falsify-mcp.mjs` 里三条（不看开关 / 图块排到
文字前面 / 不缩）。

---

**39. 任务优先级（R16）：它**只影响还在排队的**，而且准入永远排在优先级前面。**（实测，2026-09-16）

`convert_file` / `batch_convert` 收一个 `priority`（整数，**−100 ~ 100**，默认 0，越大越先跑）。
⚠️ 只做了 **MCP 侧**——`core/queue.ts` 是枢纽文件，改它要动 GUI 那条线，那是另一次决策
（`JobRegistry` 是 MCP 自己的队列，改它不碰枢纽文件）。四个必须记住的点：

- **不能抢占。**已经在跑的任务永远不被打断——转换没有「暂停」这回事，而一个
  「插队把别人挤下去」的队列在 agent 眼里与「任务莫名其妙消失了」是同一种。
  `pump()` 只在**有空位时**选下一个，这条是结构自带的，不是额外判断。
- **准入排在优先级前面。**`pickNextIndex` 先用 `hasSlot` 过一遍，再在放得下的里面挑最高的。
  反过来的话，一条卡在 LibreOffice 上的高优先级任务会把整张队列冻住——
  那正是约束 25 那条「按份数记账」在防的事。有变异专打这一条。
- **并列时保持入队顺序**（判据里写 `>` 而不是 `>=`，取下标最小的）。FIFO 是所有人对队列的
  默认预期，优先级只该**插队**，不该顺手把默认行为也改掉。写成 `>=` 的表现是
  「我什么都没设，怎么顺序乱了」。
- **两处夹取分工不同**：schema 的 `.min/.max` 面向 agent（越界是它的**参数错**，该明说、该拒）；
  `clampPriority` 面向**不经过 zod 的调用方**（CLI 那条路），那里夹住比拒掉合适。
  少了后者的话，一次「我只是想插个队」会变成「我用 9999 霸占了整张队列」。

⚠️ **整批一个优先级，不做逐条**：批量的用途就是「这一批是一件事」，逐条给等于让调用方
在参数里重新排一遍队，那不如直接分两次 batch。

验收：`test-mcp-server.ts` 第 11 节 12 条（**重心在纯逻辑上**——`pickNextIndex` 是导出的
纯函数，直接喂队列问它挑谁。从外面观测「谁先跑」是抢时序的测试，机器一忙就飘，
而飘出来的样子恰好是「功能坏了」）；`test-mcp-view.ts` 那条「properties 恰好是这几个键」
从六个改成七个（**它又一次正好在起作用**：加参数那一步它会红，逼着人回来写说明）；
反证 `falsify-mcp.mjs` 里四条。

---

**40. 配方文件（R15）：只做两个字段，而解析它的口径是「逐字段宽容 + 把坏字段报出来」。**（实测，2026-09-16）

`arbiter convert <文件> --recipe <配方.json>`。配方长这样：`{"target": "mp4", "mode": "remux"}`。
判据在 `src/shared/recipe.ts`（**零 I/O、零依赖**，收一个已经 `JSON.parse` 过的 `unknown`），
接线的 I/O 在 `src/cli/main.ts` 的 `loadRecipe()`。四个必须记住的点：

- ⚠️ **只做 `target` 与 `mode`，而且这两个今天都真的生效**。`mode` 尤其是——
  **CLI 原本没有 `--mode`**，配方是它唯一的来源。`docs/PLAN.md` 那句「绝不先摆没接通的字段」
  是有前车之鉴的：`convert_file` 曾经有个声明了、描述了、却从头到尾没被读过的 `quality`
  （见 `src/mcp/schema.ts` 里那段注释）。**想加字段，先让它接通**。
- **逐字段宽容，但一定要报**：一个键名写错不该让另外那个能用的字段一起作废，
  可**默默用默认值顶上**就是「用户以为设了、其实没设」——本项目最忌讳的那类静默失败，
  而它伪装成成功。所以认不出的键逐条进 `problems`，CLI 打到 **stderr**
  （stdout 在 `--json` 时只有一个 JSON，那是承重契约）。
- **一个字段都没认出来时必须拒**（`isRecipeEmpty`），而且**一个源文件都不转**。
  一份什么都没设的配方一定是个错误（顶层键名写错了、或者拿到一份别的工具的配置）。
  这条与上一条合起来才是完整的口径：**部分坏 → 用好的；全坏 → 拒**。
- **`--to` 排在配方前面**。命令行上写出来的那个更具体也更近。反过来的话，一份随手存下来的
  配方会压过用户这次手敲的目标，而那种「我明明说了 mkv，它转成了 webm」极难归因——
  配方是**上一次**存下来的东西，用户早忘了它还在那儿。

⚠️ **别把它做成「配方能跑任意命令」**：那等于在这个项目里开一个任意代码执行的口子，
而配方的全部价值只是「记住几个选项」。两个字段都是**闭集**，认不出的值一律进 `problems`，
永远不参与执行。

⚠️ **R15 的另一半（GUI 侧的「预置」下拉）没做**，如实记在这里：这一版只接了 CLI。
桌面端要的是「把当前这套设置存下来、下次一键套用」，那是渲染层 + IPC + 设置页那一摊，
是另一次决策；核心的那个解析器已经在这儿了，谁做那一半都该复用它。

验收：`test-core.ts` 的 `[13]` 15 条（纯解析，含 `__proto__` 那条——手写解析器
很容易在原型链上栽跟头）；`test-cli.ts` 的 `[12]` 12 条（真起子进程）。
其中最承重的一对是 **10e/10f**：`{"target":"webm","mode":"remux"}` 对 h264+aac 必然失败
（webm 装不下，约束 18），而**同一份源不带配方就成功**——一红一绿放在一起才说明白
「红的那个是 mode 造成的」，而不是源坏了或者路径错了。反证 `falsify-cli.mjs` 里四条。

## 测试

`scripts/` 下的脚本**绝大多数**是纯 Node 跑的，不需要启动 Electron。
唯一例外是 `test-pdf.ts`——它要真起一个隐藏窗口调 `printToPDF`，必须跑在 Electron 里，
所以配了个 `run-pdf-test.mjs`：先用 esbuild 打成一个 CJS 包（`packages: 'external'`，
sharp 带 `.node` 原生模块不能打进去），再让 `electron.exe` 去执行它。

> 顺带一个坑：**不要用 `spawn('npx.cmd', …)` 去起 electron**。Node 24 上这会直接
> `EINVAL`——`.cmd` 是批处理，必须经 shell 才能执行，而新版为防注入已经不允许不带
> `shell` 去 spawn 它。正确做法是 `require('electron')` 拿到 `electron.exe` 的绝对路径。

- `test-core.ts` — 纯函数：文件名净化、时长解析、`-progress` 解析状态机。
- `test-tasks.ts` — **编排集成测试**：真实的 `TaskManager` + 真实的 ffmpeg / sharp / 7z 子进程，
  只有 `electron` 模块被换成桩（`scripts/electron-stub.ts`），靠 `tsconfig.test.json`
  里的 `paths` 映射生效，不影响真正的构建。
- `test-doc.ts` — 文档层纯逻辑：编码探测（含手写 GBK 字节）、HTML ↔ 文本 / markdown、
  markdown 表格、样式注入位置。它只 import `htmlSource.ts`——那个模块**零 electron 依赖**
  正是为了这件事。测试里的 GBK 样本是**手写字节**（`Buffer` 里直接写 `0xd0, 0xd5, …`）
  而不是用库现编的：用库编码会变成「编码器和解码器互相验证」，测不出真实字节。
- `test-pandoc.ts` — 真实 pandoc 子进程（`md/txt/html/rst → docx`，外加 rst 的 html/md/txt 出口：
  那三条走的是 `document.ts`，但解析同样靠 pandoc）。素材现场造，但**验证用的是
  mammoth**——读写两侧不是同一个实现，所以不存在「自己验自己」。三条承重断言：`.txt` 映射成
  markdown（映射错了直接 `Unknown input format txt`）、GBK 版与 UTF-8 版产物一字不差、
  `--resource-path` 的插图差分。
  rst 那节的判据同样是**差分**：素材里同时摆了「只有真解析才会出现」的（`<h1>` / `<strong>` /
  `<a href>`）和「只有降级才会出现」的（标题下划线的 `====`）两类特征，两侧都断言才分得清跑的是哪条路。
  **取消那条只信最后一句**：「抛 `ConversionCanceled` / 无产物 / 无 `.part`」在取消落到完成
  之后**照样会绿**，真正证明杀掉进程的是「取消耗时 < 完整转换耗时的一半」。
- `test-integration.ts` — **系统集成（M8）**：前半是纯函数（argv 解析、Windows 引号拼接、
  `reg query` 输出解析、逐层清理的键序列），后半是**真 `reg.exe` 往返**。
  它不走 `install-test-paths` 之外任何东西、也不需要 ffmpeg，所以进了 `test` 聚合。
  三个必须记住的点：
  - **一律对着临时键做，绝不碰用户真实那个键**（`setContextMenuRootForTest`）。临时键刻意挂在
    真实键的**同一层**下面，于是一起测到了逐层清理：它会先删掉自己那一层，再往上撞见非空的
    `*\shell` 并**停在那儿**。旁边专门造了一个「别人家的动词」当对手，断言它原封不动。
  - **重命名即转换**那两节（`[5]` 判定 / `[6]` 装配）用**真临时目录 + 真 `fs`**，
    而判定那一半仍是纯函数（`core/renameWatch.ts` 零 fs）。`[6]` 里那条真 `fs.watch` 事件
    要靠 `setInterval` 保活——`persistent: false` 的 watcher 撑不住进程，不保活的话
    进程会在事件到达之前就退出，表现是「一条失败信息都没有、套件半路没了」。
  - **测试自己的 `reg()` 辅助函数要和被测的 `decodeRegOutput` 分开写**（各自一份
    严格 UTF-8 → GB18030）。共用就变成「自己验自己」——解码器的兜底分支坏掉时两边一起坏、
    断言照样绿。真正的分界断言是中文字面量往返：`command` 写一个中文值进去，
    `readContextMenu()` 读回来必须**一字不差**（UTF-8 硬解在这个位置一定变成乱码）。
- `test-pdf.ts` + `run-pdf-test.mjs` — **端到端**：真起 Chromium 打印 PDF，
  再用 `pdf-lib` 读页数与页面尺寸、翻原始字节找字体 / 位图标记。
  覆盖的正是「离开真 Chromium 就没法知道」的那几件事（见约束 12）。
- `test-plugin-launch.mjs` — **插件启动器的验收**（`npm run test:plugin`）。24 条断言，
  盯的是打包分支：普通 Node 看不进 asar（约束 21）、`asarHasEntry` 的判据、
  以及真拉起一次打包后的 Electron 确认 MCP server 起得来且 **stdout 一个字节都没有**
  （那是协议通道）。
  ⚠️ **第 3c / 3d 条（2026-09-14 补）走的是用户真敲的那个 `arbiter.cmd`**，不是
  「等价地跑 electron + 入口」——两者之间隔着 cmd.exe 一整套解析（`%~dp0` 展开、
  `%*` 传参、`exit /b %ERRORLEVEL%` 回传退出码），而 `arbiter.cmd` 恰恰是 D2 那个 P0 的
  **全部交付物**。判据是「`--version` 的 stdout **恰好**一个版本号」与「带空格/中文、
  带 `&` 与括号的**已加引号**路径经 `%*` 之后**逐字不变**」——`%*` 少一层引号的表现是
  在空格处切一刀，而错误信息里那一截路径**看着还挺像那么回事**。
  ⚠️ 这两条是**正向控制、没有配套变异**（要变异得改构建产物里的 `.cmd`，那要每个变异
  重跑一次 `build:unpack`）。探测它们时踩过两次**探针自己的错**，都记在源码注释里：
  `spawnSync('cmd.exe', ['/c', 行])` 会把行内 `"` 转义成 `\"`（cmd 里那不是转义序列），
  而 `spawnSync(字符串)` 不带 `shell: true` **根本起不来**（status=null）。
  **先 `npm run build:unpack`**，没构建就直接红而不是跳过——
  一个会跳过的测试看起来和通过一模一样。与 `falsify:tasks` 同理：**刻意不进聚合**，
  因为它要一个 62 MB 的构建产物，而聚合得能在干净 clone 上跑。
- `test-cli.ts` — **真起 `tsx src/cli/main.ts` 子进程**（86 条，实测 9.4 秒）：
  stdout 纯净性（`--json` 时恰好一个 JSON 对象）、退出码分档、以及**重定向到文件时的
  输出编码**。最后那条是「开发机上永远看不出问题」的那一类——终端里码页恰好对，
  与约束 23 第 3 条（`reg.exe` 经管道吐 GBK）同构。
- `test-ui.ts` — **渲染层第一支 React 回归网**（76 条），盯的是处理链面板
  `components/options/FiltersSection.tsx`。这一块此前只能靠肉眼，而它每一条判据出错的表现
  都是「点了没反应」或「顺手改了别的东西」。基建上的取舍写在文件头：
  **用 esbuild 在内存里把源码包一层、只在末尾追加一行 `export { … }`**，盘上源码一个字节不改
  （`src/**` 不许动，抄一份副本又等于测自己写的东西）。那行 export 本身还是一道锚点——
  谁把 `parse` 改了名，ESM 链接期直接抛错，而不是让套件悄悄退化成「一条都不跑还全绿」。
- `test-image-options.ts` — 图片参数 30 条：缩放（四档 fit / 只给一维 / 不放大）、体积二分质量，
  外加 PNG 出口 `effort` 旋钮那一条（E-9 顺带量出来的，见约束 36）。
- `falsify-doc.mjs` / `falsify-pandoc.mjs` / `falsify-pdf.mjs` / `falsify-ui.mjs` /
  `falsify-electron-free.mjs` / `falsify-downlink.mjs` / `falsify-mcp.mjs` /
  `falsify-integration.mjs` / `falsify-engine-install.mjs` / `falsify-cli.mjs` /
  `falsify-ui-panel.mjs` / `falsify-image-options.mjs` / `falsify-shortcuts.mjs` — **进 `npm run falsify` 聚合的那十二支**
  （顺序与 `package.json` 一致，全部串行）。
  另有 `falsify-plugin-launch.mjs`（**单独跑**，同样要先 `npm run build:unpack`）：4 个变异，
  其中两个专打约束 21 那件事的两半——`probe()` 的判据与后面那道闸门。
  ⚠️ 脚本名是 `npm run falsify:plugin-launch`（**不是** `falsify:plugin`，那样跑不存在）。
  「进不进聚合」的判据是**实测耗时**，不是印象：2026-09-13 逐支量过——
  `falsify:electron-free` 8.6 秒、`falsify:downlink` 7.9 秒（`test:downlink` 单轮仅 988 ms / 149 条，
  7 轮加进程启动就是这么多）、`falsify:mcp` 141 秒（8 个变异，2026-09-13 复量，此前 7 个时是 114 秒；
  2026-09-16 加到 14 个变异——其中三条是 R20 的产物缩略图）。
  都在可接受范围，故**全部并入**；
  早先 `falsify:mcp` / `falsify:electron-free` 没进聚合只是没人回来补，不是有人判定过它们太重。
  `falsify:downlink` 出过一版判据错误：它的变异 6「镜像只试第一个」会**让两个测试节在半路抛异常**，
  节内更细的断言（`回退到第二个镜像` 等）根本没被执行，于是不在红名单里——那是必然，
  不是断言没抓住（实际翻红 14 条）。**期望清单要收那两节节级的「整段跑完（未抛异常）」**，
  而不是收节内那些够不着的细断言。写 `expect` 时先问一句：这条断言在那个变异下**到底跑得到吗**。
- `falsify-integration.mjs` — **反证 M8 那三条链路**（`npm run falsify:integration`，16 个变异，
  **进聚合**）：`core/cli.ts` 的 argv 解析 / 引号拼接 / `--to` 形状校验 /
  dev 形态补仓库根，以及 `core/integration.ts` 的 `/ve` 解析、GB18030 兜底、`MultiSelectModel`、
  「键不存在不算错误」、逐层清理的边界，以及 `core/renameWatch.ts` / `core/renameWatcher.ts` 的
  六处（体积判据 / 同词干歧义 / 类别白名单 / `.part` 过滤 / 基线重建 / 入队被拒的回滚）。
  ⚠️ 它会**真动注册表**（含基线共十七轮），
  但每一步删改都以「键为空」为前提，所以连它自己都不会删掉有内容的键。
- `falsify-tasks.mjs` — **单独一条**（`npm run falsify:tasks`）：反证 `core/task.ts` 的三处承重逻辑
  （队列条目换引擎桶 / `runningCount` 不能数 `tokens` / overwrite 撞名要避让 `claimed`）、
  remux 判定两侧，以及 GPU 硬件编码的四处（换没换编码器 / `-cq` 有没有被写成 `-crf` /
  webm 有没有被放进白名单 / 失败后回没回退）。
  **刻意不进 `falsify` 聚合**：被测的 `test-tasks.ts` 要真起 ffmpeg / sharp / 7zip 子进程，
  一轮好几分钟，**九个变异就是十轮**。改过 `core/task.ts`、`core/queue.ts` 或编码参数之后单独跑它；
  迭代单个变异用 `--only=<子串>`（基线照样跑，收尾会显著说明「只跑了 N / M 个」）。
  变异清单写在脚本内的 `MUTATIONS` 数组，每跑一个就改坏源码一次、跑测试、立刻还原，
  最后还校验源码确实还原干净了。带 `diagnostic: true` 的变异**不要求翻红**——
  它问的是「这条设计到底有没有用」，绿灯本身就是结论（中文那条字体栈就是这么验出来的）。
- `bench.ts` — **性能基准，不是测试**（`npm run bench`，可带参数改规模：
  `npx tsx --tsconfig tsconfig.test.json scripts/bench.ts 200`）。拿极小文件跑批量，
  让转换耗时趋近于 0，剩下的就是**与文件大小无关的部分**（进程启动、输出名解析、状态机与 IPC）——
  那才是「一次拖 200 个小文件」的瓶颈。「每轮 = 墙钟 / 轮数」是唯一值得横向对比的数字。
  **别拿单任务墙钟去做差算「固定开销」**：单任务那次含一次性的冷启动（模块加载、libvips 初始化），
  必然偏高，减出来会出现负数。
- `tsconfig.scripts.json` — 给这些脚本做类型检查。**单独成一份是因为前两份配置都覆盖不到
  `scripts/`**：`tsconfig.node.json` 没 include 它，而 `tsconfig.test.json` 把 `electron`
  映射到了那个只实现了一小部分 API 的桩，一碰 `ipc/`、`window/` 就大面积报错。
  两头都不管的结果是 tsx 只剥类型不做检查，脚本里的类型错误永远不会被发现。
  另：跑这些脚本必须带 `--tsconfig tsconfig.test.json`（`@shared/*` 别名靠它），
  否则报 `Cannot find module '@shared/formats'`。

这套桩让主进程逻辑可以脱离窗口测试，覆盖的全是「光看 UI 看不出来、出错又很难查」的路径：
并发上限、输出名占位、取消是否真杀掉了进程树、损坏文件的错误回传、特殊字符文件名、
HEIC 的多图取主图、压缩包的递归拆包与 RAR 支持。

**素材放在 `scripts/fixtures/`，来源与用途见那里的 README。** 一律用第三方或真实世界的样本，
不用自己生成的文件——「自己能造出来的东西多半也能验自己」，测不出真实的解码器行为。
用素材时先 `stageFixture()` 复制到临时目录：转换默认把产物写在源文件旁边，
直接拿 fixtures 里的文件起任务会把受版本控制的内容写脏。

**写这类测试要当心素材成本**（这里踩过两次）：

- `testsrc` 编码极快，一段 120 秒的视频用 `veryfast` 也能在一秒内转完——想测「转换中途取消」
  必须用高分高时长的素材，否则取消落在完成之后，测的其实不是取消。
- 7z 那边同理，但坑更深：**「大」不等于「慢」，得是不可压缩的随机数据**。
  实测 `-mx=5` 打包 96 MB 随机数据要 6 秒出头，而同样体积的全零数据只要 0.4 秒
  （LZMA 的长游程匹配快到飞起）；体积再往上也不划算，240 MB 只比 120 MB 多一点点，
  已经撞到磁盘 I/O 的天花板。

同理，进度解析要用合成流而不是真实转换，因为真实转换根本来不及吐中间记录。

**测并发上限时，全局上限必须压得比引擎上限低。** `maxConcurrent`（全局）和引擎容量
（`queue.ts` 里现在叫 `ENGINE_CAPACITY`，见约束 25）相等时，「忽略全局上限」和「尊重全局上限」的观测结果一模一样，那条断言就成了
永远通过的装饰。同理，素材必须**在慢的那一侧**够慢——转码一个 320x240 的片段快到一个采样点都
抓不到，稳态根本不存在（`measurePeak` 用 15ms 采样，比 UI 的 10Hz 推送快得多，才抓得到瞬时越界）。
另外「同时」二字是承重的：只观察到有任务在排队说明不了背压，必须要求有任务在跑的同时还有在排队的。

**断言写完后要做一次反证**：临时把被测的那行改坏，确认断言真的会翻红——否则很容易写出一条
永远通过的装饰。这件事已经脚本化成 `npm run falsify`，别再用肉眼验。
这个项目里已经因此抓到过**四**条装饰性断言：一条改成 `list[0]` 仍不报错的「主图挑选」
（补丁插错了分支，没碰到真正生效的代码路径）、测试代码自己用 `task!.outputPath!`
在失败时抛异常把整个套件崩在半路盖住后面几十条断言、在空集合上恒真的 `!entries.some(…)`、
以及「GBK 行数与源一致」——去掉 GB18030 兜底后解出来是乱码，可**乱码里换行符一个不少**，
所以它照样绿。

变异脚本自己也有个坑：**锚点要防「子串命中」**。6 空格缩进的 `      : wrapHtml(…)`
是 10 空格缩进同款行的子串，于是「期望命中 1 次」变成了 2 次。所以命中次数一定要打印出来，
只说「没命中唯一一次」的话，0 次和 2 次根本分不清，要多花一整轮才查得出来。

**改一半的变异会伪装成「断言是装饰」。** 反证 MCP 的 stdout 闸门时，第一版变异只把函数最后
那句 `return typeof parsed === 'object' && …` 换成 `return true`——可前面那句 `JSON.parse(trimmed)`
对裸文本照样抛、照样走 `catch { return false }`，裸文本仍然被拦。于是第 3、6 条**合理地**没红，
脚本报「有断言没红」，看上去像断言抓不住错误，**其实是变异写弱了**。锚点必须罩住
**整个函数体**（或整个表达式），能顺手把中间那层拦路的分支一起废掉。
代价很实在：一轮十几分钟，误判一次就白等一轮，还会诱使人去「放宽断言」。

**失败的断言会留下产物，把后面每一轮都毒掉。** 同一轮里第 15 条（写到写根之外被拒）在**后面
四个变异里全部「顺带」翻红**，看上去像那条断言四处都敏感——根因是写闸门那个变异**真的把
`scripts/escape.jpg` 写出来了**，而断言是 `!existsSync(escapePath)`，于是从那一刻起它永远红。
所以：凡是「不应存在 X」的断言，**跑之前就先清一次**，别只赌没人会留下它；
看到某条断言在**多个不相干变异里都红**，第一反应该是「现场脏了」，不是「这条断言很灵」。

**被测对象能篡改测试自己的输出通道时，「抠日志行」判翻红就不成立。** MCP 那套的第 1 节测的
正是 stdout 闸门，它为了断言「拦没拦住」把 `process.stdout.write` / `process.stderr.write` 换成
自己的捕获器，而 `protectStdout()` 又把 `console.log` 改道到 `stderr.write`——于是**第 5/6/7 条
断言自己打的 `✓`/`✗` 会被那个捕获器吃掉**（实测那一轮 stdout 只剩 141 字节，全跑 stderr 去了）。
后果很隐蔽：闸门一坏，第 6、7 条的 `✗` 凭空消失，而套件末尾的汇总照样记着它们失败，
反证脚本于是报一条**假的**「有断言没红」，白等一轮还诱使人去放宽断言。
修法是抠末尾 `失败：` 之后那段 `  - <标签>` 列表（它在捕获器拆掉之后才打），`✗` 行只作兜底：
**测 stdout 的工具不能靠 stdout 说话。**

**`npm run lint` 带 `--cache`，而那份缓存实测漏报过一次（机制未查明）。**
2026-09-16 推送前体检时撞到的：同一棵工作树，带缓存时报「59 warnings / 0 errors / exit 0」，
`rm -f .eslintcache` 之后报「88 problems（**1 error**）/ exit 1」——那个 error 是真的
（`test-mcp-server.ts` 第 11 节一个箭头函数缺返回类型注解），而 **CI 上一定会红**
（那边没有缓存文件）。⚠️ 事后它自愈了（连跑三次都是 87），**所以机制没查明，别把上面这段
读成「缓存必然不可信」**；能说的只有一条判据：
**打包 / 交 PR 前用 `rm -f .eslintcache && npm run lint` 复核一次**，几秒钟的事。
同一轮里还有一条同源的：`.eslintcache` 与 `.tmp-*` 一样在 `.gitignore` 里，
所以**干净 clone 上的 lint 才是权威**——这与「干净 clone 里跑一遍 CI」是同一个动作。

**重构会让锚点静默失效，而锚点失效的变异是「假通过」。** 把 pandoc 的子进程逻辑抽到
`pandocRun.ts` 之后，4 条变异的锚点命中数全成了 0——脚本按设计报了「变异没生效，结论无效」
而没有当成通过，但这件事要人去处理：**凡是改了被变异覆盖的代码，必须重跑 `npm run falsify`**。
只跑一遍测试看它全绿，说明不了任何事：测试全绿和「断言其实抓不住错误」长得一模一样。
反过来也管用：反证时如果**只有**你预期的那些断言翻红、其余保持绿，说明这批断言定位是准的
（比如把 `queue.ts` 的全局上限改成 `999`，只有「上限 2」那条红而「上限 4」那条仍绿）。

**判断「产物里到底有没有 X」时，别用子串去猜。** 实测踩过：想验 PDF 里有没有嵌图片，
拿 `/Image` 去搜——结果**每一份** Chromium 产出的 PDF 都命中，因为每页都会写
`/ProcSet [/PDF /Text /ImageB /ImageC /ImageI]`，那个 `/Image` 是 `/ImageB` 的前缀。
正确做法是读**位图对象自己的尺寸**（`/Subtype /Image /Width 400 /Height 300`），
还能顺便断言「嵌进去的确实是源文件那张图」。
同理，别拿「产物更大」当「图片进去了」的代理指标：实测带图的 9748 字节、不带图的对照组
15559 字节——**纯色图压得极小，反而比对照组那份 CJK 字体子集还小**。

还有一类空转断言值得单独记：**在空集合上做的「不应包含 X」断言恒为真**。
`!entries.some((n) => n.endsWith('.tar'))` 在上一步失败、`entries` 为空时照样通过——
它同时告诉你「一切正常」和「什么都没有」。所以凡是「不应包含 X」型断言都要带上
`entries.length > 0` 这类前置条件。这条也是反证时才发现的：摘掉 `tbz2` 的能力矩阵注册后，
同一轮里另外 4 条都红了，唯独它绿着。
