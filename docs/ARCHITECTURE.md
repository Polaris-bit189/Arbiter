# 架构

这份文档面向要改代码的人。读完你应该能回答两个问题：**「一个文件从拖进来到落盘，
中间经过了谁」**，以及**「我要加一个格式 / 一个引擎，该改哪几个地方」**。

关于「为什么这么设计」——那些结论大多来自实测踩坑，逐条记在仓库根目录的
[docs/NOTES.md](NOTES.md) 里（17 条约束）。**改代码之前请先读那一份**，
它会告诉你哪几行看着多余、其实是承重的。

---

## 一、三个进程，一个真相源

```
┌─────────────────────────────────────────────────────────────┐
│  main（Node）                                               │
│  任务队列 · 状态机 · 进度 · 引擎进程 · 文件系统              │
│  ★ 唯一真相源                                               │
└─────────────────────────────────────────────────────────────┘
        ▲                                        │
        │ 增量事件（进度 patch / 状态迁移）        │ IPC
        │                                        ▼
┌──────────────────────┐   contextBridge  ┌──────────────────────┐
│  preload             │ ───────────────► │  renderer（React）   │
│  最小 API · sandbox  │   window.api     │  ★ 只是镜像          │
└──────────────────────┘                  └──────────────────────┘
```

**渲染进程不持有任何权威状态。** 它在挂载时拉一次快照，之后只吃主进程推来的增量。
这不是洁癖，是为了让「关掉窗口再打开，任务还在跑」这件事自然成立——
状态本来就不在窗口里。

### 为什么 `channels.ts` 要单独成文件

`src/shared/channels.ts` 里只有几个字符串常量，**零依赖**。

而 preload 跑在 `sandbox: true` 里，它 `require()` 只能解析 `electron`。
为了几个字符串常量把 zod（以及它的整个依赖树）拖进 preload 的依赖图，
后果是 **preload 整个崩掉**——表现为 `window.api` 未定义、拖拽毫无反应，
排查起来极其费劲。

所以：**通道名（零依赖）在 `channels.ts`，契约与 zod schema 在 `ipc-contract.ts`。**
别把它们合并。

---

## 二、一个文件的完整路径

以「拖入 `clip.mkv`，转 `mp4`」为例：

```
 renderer  拖拽 → window.api.xxx()
    │
    ▼
 ipc/        入参校验（渲染进程是不可信输入）
    │
    ▼
 core/task.ts       ← 唯一真相源。所有状态迁移都在这儿
    │  · 能力矩阵问一句：mkv → mp4 合法吗？谁来做？   → shared/formats.ts
    │  · 裁决输出路径（含「重名避让」，见下）
    │  · 入队
    ▼
 core/queue.ts      ← 按**引擎**分桶的并发调度器
    │
    ▼
 converters/index.ts   ← 路由分发，不含编码细节
    │
    ▼
 converters/ffmpegRun.ts  ← 起子进程、解析进度、杀进程树
    │
    ▼
 engines/ffmpeg.ts     ← 拼参数（可单独测的纯函数）
```

三条贯穿全链路的规矩：

1. **一律 `spawn(exe, args[])`。** 没有 `exec`，没有 `shell: true`，没有拼字符串。
   用户的文件名里可能有空格、引号、`&`、`$()`、中文、emoji——走数组参数时
   shell 根本不参与解析，这些字符天然无害。路径一律 `path.resolve()` 成绝对路径：
   以 `-` 开头的文件名会被 ffmpeg / pandoc 当成选项。

2. **进度是主进程推的，且必须单调。** 解析器强制百分比不回退，否则进度条会跳。
   `ffmpeg` 的 `-progress pipe:1` 记录还会缓冲到遇见 `progress=` 行才提交一次
   （`frame=` 和 `out_time=` 属于同一条记录）。

3. **取消 = 杀进程树**（`taskkill /pid <pid> /T /F`）。
   只杀父进程会留孤儿：`soffice.exe` 会拉起 `soffice.bin`，
   留下来的进程占着 LibreOffice 的 profile 锁，之后**所有** LibreOffice 转换
   都会静默失败——退出码 0，但没有产物。

---

## 三、文件职责

| 路径                                 | 职责                                                                  | 关键点                                                               |
| ------------------------------------ | --------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `src/shared/formats.ts`              | **整个应用的中枢**：`(源, 目标) → 引擎` 的路由表 + 每个格式能转成什么 | main 与 renderer **共用同一份**，避免两边判断分歧                    |
| `src/shared/channels.ts`             | IPC 通道名                                                            | 零依赖，见上                                                         |
| `src/shared/types.ts`                | `Category` / `EngineKey` 等基础类型                                   |                                                                      |
| `src/main/core/task.ts`              | 任务状态机                                                            | 输出名占位、`claimed` 集合                                           |
| `src/main/core/queue.ts`             | 按引擎分桶的调度器                                                    | 并发上限按**引擎**分，不是全局                                       |
| `src/main/core/history.ts`           | 历史记录                                                              |                                                                      |
| `src/main/core/outputName.ts`        | 输出名解析与占位                                                      | `partPathOf` 见下                                                    |
| `src/main/core/probe.ts`             | 从引擎输出里解析信息（时长等）                                        | 正则与边界有测试盯着，别在别处再写一份                               |
| `src/main/core/downlink.ts`          | 按需下载：多镜像 + sha256 + Range 续传                                | 传输层抽象成接口，测试注入本地 http                                  |
| `src/main/converters/`               | 引擎适配层                                                            | `index.ts` 只做路由分发；`common.ts` 放错误类型                      |
| `src/main/engines/`                  | 引擎**定位**与参数拼装                                                | `status.ts` 两层探测：便宜的 `existsSync` 与昂贵的 `spawn --version` |
| `src/main/ipc/`                      | IPC handler                                                           | 入口必须校验入参                                                     |
| `src/preload/`                       | `contextBridge` 最小 API                                              | 安全边界，见约束 1                                                   |
| `src/renderer/src/store/useTasks.ts` | 前端镜像                                                              | 选择器**必须**返回原始值或稳定引用                                   |

### 两条容易改错的规矩

**临时文件名必须保留扩展名**：`clip.mkv` → `clip.part.mkv`，**不是** `clip.mkv.part`。
ffmpeg 完全靠输出文件的扩展名推断封装格式与编码器，`clip.mkv.part` 会让它直接报
`Error opening output files: Invalid argument`。把标记插在扩展名之前，
就不必维护一张「扩展名 → 封装格式」的映射表。这条对 sharp / pandoc / 7z 同样适用。

**并发任务要额外占位**。`resolveOutputPath` 只看磁盘上有没有同名文件，
而两个并发任务在写各自临时文件期间，磁盘上都还不存在最终文件，于是会解析到同一个名字，
后完成的那个会**静默覆盖**先完成的。`TaskManager` 里的 `claimed` 集合就是补这个洞的。

> ⚠️ `claimed` 只在**进程内**有效。如果将来出现「GUI 与另一个进程同时跑转换」
> （比如 MCP Server 与 GUI 并存），这个洞会重新张开。见 `docs/PLAN.md`。

### 渲染进程侧

`useTasks.ts` 的选择器**必须返回原始值或稳定引用**，否则每次进度推送都会重渲染整个列表，
`TaskCard` 的 `memo` 就白做了。

标题栏那个「运行中 N / 上限 M」也是从这份镜像里**数出来**的，
不是读设置里的静态上限——那个数字跟实际在跑几个毫无关系。
一批小文件两百毫秒转完、五张卡片同时变绿时，旁边写着「并发 4」看起来就像限流根本没生效。

---

## 四、引擎边界

引擎全是**外部可执行文件或原生模块**，Arbiter 不自己实现任何编解码。
每个引擎有一个定位器（`engines/*.ts`）负责「找到它、判断它能不能用」，
和一个适配器（`converters/*.ts`）负责「怎么调它、怎么读它的输出」。

| 引擎                      | 形态                          | 随包？                             |
| ------------------------- | ----------------------------- | ---------------------------------- |
| FFmpeg                    | 静态 exe                      | ✅                                 |
| sharp                     | 原生模块（libvips）           | ✅                                 |
| 7-Zip 完整版              | exe + dll                     | ✅（仅 2.4 MB，但 RAR 支持全靠它） |
| Chromium printToPDF       | Electron 自带                 | ✅                                 |
| pdfjs + `@napi-rs/canvas` | 原生模块                      | ✅                                 |
| libheif                   | WASM（`heic-decode`）         | ✅                                 |
| LibreOffice               | MSI 解包目录树（约 1.49 GiB） | ❌ 首次运行时下载                  |
| Calibre                   | MSI 解包目录树（约 658 MB）   | ❌ 首次运行时下载                  |
| pandoc                    | 单文件自包含 exe（221 MiB）   | ❌ 首次运行时下载                  |

**为什么重型引擎要按需下载**：三个加起来约 2.4 GiB。全打进去，安装包就没法看了。
所以发布的是**瘦包**，用户第一次用到某个格式时才提示下载，带 SHA-256 校验与断点续传。

**为什么随包的引擎不能改成按需下载**：FFmpeg / sharp / 7-Zip 覆盖的是
视频、音频、图片、压缩包——也就是绝大多数日常转换。让这些也需要下载，
等于把一个「装完就能用」的工具变成一个「装完还得等」的工具。

### 三个引擎各有一条「必须这么写」的规矩

- **LibreOffice**：解包只能用 `msiexec /a`。用 `7z x` 解 MSI 会「成功」地毁掉它——
  退出码 0、`Everything is Ok`、文件一个不少，但目录树是 **100% 扁平**的
  （MSI 的 Directory 表丢了），跑起来报 `STATUS_DLL_NOT_FOUND (0xC0000135)`。
  另外 `--convert-to` 只在**同一个 LibreOffice 应用内**成立：Writer / Calc / Impress
  跨族一律 `no export filter`，所以能力矩阵必须按族分组。
- **Calibre**：它的 portable installer **不是**自解压包，载荷是 lzip（7z 打不开）。
  直接下 MSI 走 `msiexec /a`。
- **pandoc**：`.txt` 要映射成 `-f markdown`（pandoc 没有 `txt` reader）；
  必须带 `--resource-path <源文件目录>`（pandoc 按 **cwd** 解析相对路径，
  少了它图片被**静默丢弃**而退出码仍是 0）；必须带 `--syntax-highlighting none`
  （实测 73 ms → 343 ms）。

---

## 五、测试

`scripts/` 下绝大多数脚本是**纯 Node** 跑的，不需要 Electron：

- `test-core.ts` — 纯函数（文件名净化、时长解析、`-progress` 状态机）
- `test-tasks.ts` — 编排集成，**真实的** `TaskManager` + 真实 ffmpeg / sharp / 7z 子进程，
  只有 `electron` 模块被换成桩
- `test-doc.ts` — 文档层纯逻辑（编码探测、HTML ↔ 文本/markdown）
- `test-pandoc.ts` — 真实 pandoc 子进程
- `test-downlink.ts` — 按需下载（多镜像回退、sha256、Range 续传、416、取消）
- `test-pdf.ts` — **唯一必须跑在 Electron 里**的，真起隐藏窗口调 `printToPDF`

能这样拆开，是因为**关键模块刻意不依赖 Electron**：
`converters/htmlSource.ts` 零 electron 依赖，就是为了能脱离窗口直接测。

### 反证（falsify）

`npm run falsify` 会把被测代码**逐处改坏**，确认断言真的会翻红。

**写完断言必须反证一次。** 否则很容易写出一条永远通过的装饰性断言——
测试全绿和「断言其实抓不住错误」长得一模一样。这个项目已经因此抓到四条。

同样：**改了被变异覆盖的代码，必须重跑 `npm run falsify`。**
重构会让变异脚本的锚点静默失效，而锚点失效的变异是「假通过」
（脚本会报「变异没生效」，那**不是**通过）。

CI 已经把反证挂在每个 PR 上（`.github/workflows/ci.yml`）。
