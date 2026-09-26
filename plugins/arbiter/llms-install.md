# Installing the Arbiter MCP server

> Agent-facing setup notes. Cline's MCP Marketplace asks that a server be
> installable from `README.md` and/or `llms-install.md` alone; this file is that
> second one, because this setup is **not** a one-liner.
> 中文版在文件后半段，两份各自完整。 / A Chinese version follows; both are complete.

---

## English

### Read this first

Arbiter is a **local** file converter for Windows — video, audio, image, document,
ebook and archive — exposing eight MCP tools (`convert_file`, `inspect_file`,
`read_document`, `list_supported_formats`, `batch_convert`, `list_jobs`,
`get_job_status`, `cancel_job`).

⚠️ **The MCP server ships inside the Windows desktop application.** This repository
holds the launcher, the Claude Code plugin and the skills — it does **not** hold the
engine. The launcher starts the app's own entry point (`out/main/mcp.js`) using the
app's Electron binary.

Two consequences, and neither is negotiable:

- There is **no `npx` package** and there never will be a container-friendly one
  (the engine is a ~2.4 GB on-demand download). See the README's "MCP server" section.
- **The app must already be installed on this machine**, and it is **Windows-only**
  today (macOS and Linux are on the roadmap, not shipped).

### Step 1 — Is the app already installed?

Look for `Arbiter.exe` in any of these, in order:

1. `%LOCALAPPDATA%\Programs\Arbiter`
2. `%ProgramFiles%\Arbiter`
3. `%ProgramFiles(x86)%\Arbiter`
4. Any directory recorded in the registry under
   `HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall` or the `HKLM`
   equivalent, where `DisplayName` is exactly `Arbiter` — derive the directory from
   `DisplayIcon` or `UninstallString`. **Users who changed the install directory
   during setup live only here.**

The launcher does all four of these itself, plus a couple of dev-mode fallbacks. If
one of them hits, go straight to step 3.

### Step 2 — If it is not installed, ask the user to install it

**Do not attempt a silent install.** The installer is not code-signed (a certificate
costs money; this is a side project), so Windows SmartScreen will warn the first time.
That warning is a decision for the human in front of the machine, not something to
work around.

Tell the user:

1. Download the latest `Arbiter-*-setup.exe` from
   <https://github.com/Polaris-bit189/Arbiter/releases/latest>
2. Run it. When SmartScreen appears: **More info → Run anyway**.
3. The installer is ~140 MB. It bundles FFmpeg, sharp and 7-Zip but **not**
   LibreOffice, Calibre or pandoc — those download on first use, from their official
   sources, with SHA-256 verification.

Then resume at step 3.

### Step 3 — Register the MCP server

Add this to the client's MCP settings (`cline_mcp_settings.json` for Cline, or the
equivalent), replacing the path with the absolute path to **this repository**:

```json
{
  "mcpServers": {
    "arbiter": {
      "command": "node",
      "args": ["<absolute path to this repo>/plugins/arbiter/mcp/launch.mjs"]
    }
  }
}
```

`node` must be on `PATH` (Node.js 22+).

If the app is installed somewhere the four locations in step 1 do not cover, say so
explicitly rather than guessing:

```json
"env": { "ARBITER_HOME": "D:\\tools\\Arbiter" }
```

`ARBITER_HOME` may point at either the install root **or** a repo checkout; it skips
all automatic detection. Set `"ARBITER_MCP_DEBUG": "1"` to have the launcher print
the path it chose to stderr — useful when the tools connect but report no engine.

### Step 4 — Verify without converting anything

Call **`list_supported_formats`**. It reads the shared capability matrix, starts no
engine and downloads nothing, so it is the cheapest possible proof that the server is
wired up. A successful response lists six categories (video, audio, image, document,
ebook, archive).

If the tools connect but every call fails with "no installed Arbiter was found on
this machine", the app is missing or lives somewhere step 1 does not cover — fix that
with step 2 or `ARBITER_HOME`, do not start converting.

### Notes worth knowing before you drive it

- **File access is restricted by default.** Reads and writes are confined to allowed
  roots; widen them with `ARBITER_MCP_ROOTS` (read) and `ARBITER_MCP_WRITE_ROOTS`
  (write, narrows only). An MCP tool hands an agent filesystem access, and this
  project treats that as something to gate rather than assume.
- **`convert_file` blocks** until the conversion finishes, and reports progress while
  it runs. For a batch, use `batch_convert` once (it returns a job id per file) and
  poll with `list_jobs` — not one `get_job_status` per file.
- **Heavy formats cost a download.** `doc` / `xls` / `ppt` / `odt` need LibreOffice
  (357 MiB), `epub` / `mobi` / `azw3` need Calibre (213 MiB), and some document
  conversions need pandoc (221 MiB). Confirm with the user before triggering one.
  `read_document` refuses those formats outright rather than pulling hundreds of
  megabytes unasked.
- **No OCR.** A scanned, image-only PDF has no text layer; `read_document` reports
  that as a distinct error rather than returning an empty string.
- **Errors are structured.** They carry a machine-readable `code`, a `retryable`
  flag and `next_steps`, alongside the engine's own words. Branch on those instead of
  parsing the prose.

---

## 中文

### 先读这一段

Arbiter 是一个 **Windows 上的本地**格式转换器（视频 / 音频 / 图片 / 文档 / 电子书 /
压缩包），对外提供八个 MCP 工具：`convert_file`、`inspect_file`、`read_document`、
`list_supported_formats`、`batch_convert`、`list_jobs`、`get_job_status`、`cancel_job`。

⚠️ **MCP server 的代码在 Windows 桌面应用里。** 这个仓库装的是启动器、Claude Code
插件和技能，**不含引擎**。启动器做的事是：拿应用的 Electron 二进制，以
`ELECTRON_RUN_AS_NODE=1` 跑应用内部的入口 `out/main/mcp.js`。

由此有两条硬约束，都不是能绕的：

- **没有 `npx` 包**，也不会有容器友好的那一种（引擎是按需下载的约 2.4 GB）。
- **本机必须已经装了那个应用**，而它**今天只有 Windows**（macOS / Linux 在路线图上，未发布）。

### 第 1 步 — 应用装了吗

按顺序在这些位置找 `Arbiter.exe`：

1. `%LOCALAPPDATA%\Programs\Arbiter`
2. `%ProgramFiles%\Arbiter`
3. `%ProgramFiles(x86)%\Arbiter`
4. 注册表 `HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall`（及其 `HKLM`
   对应键）里 `DisplayName` **恰好**是 `Arbiter` 的那一条——目录从 `DisplayIcon`
   或 `UninstallString` 反推。**安装向导里改过目录的用户只在这里。**

启动器自己会把上面四条连同两个开发形态的候选一起走一遍。命中就直接跳到第 3 步。

### 第 2 步 — 没装的话，请用户自己装

**不要尝试静默安装。** 安装包**没有代码签名**（证书要钱，这是个人项目），
所以首次运行 Windows SmartScreen 会拦一下。那一下是给人做的决定，不是绕过去的。

告诉用户：

1. 从 <https://github.com/Polaris-bit189/Arbiter/releases/latest> 下载最新的
   `Arbiter-*-setup.exe`
2. 运行它。SmartScreen 弹出来时选 **更多信息 → 仍要运行**。
3. 安装包约 140 MB，自带 FFmpeg、sharp、7-Zip，但**不含** LibreOffice / Calibre /
   pandoc——那三个第一次用到时从官方源按需下载，带 SHA-256 校验。

然后回到第 3 步。

### 第 3 步 — 注册 MCP server

把下面这段加进客户端的 MCP 配置（Cline 是 `cline_mcp_settings.json`），
路径换成**本仓库**的绝对路径：

```json
{
  "mcpServers": {
    "arbiter": {
      "command": "node",
      "args": ["<本仓库的绝对路径>/plugins/arbiter/mcp/launch.mjs"]
    }
  }
}
```

`node` 要在 `PATH` 上（Node.js 22+）。

应用装在别的目录时，**显式说出来**，别猜：

```json
"env": { "ARBITER_HOME": "D:\\tools\\Arbiter" }
```

`ARBITER_HOME` 既可以指安装根、也可以指仓库检出目录，指了就跳过全部自动探测。
设 `"ARBITER_MCP_DEBUG": "1"` 会让启动器把它选中的路径打到 stderr，
用来排查「连上了但说引擎没装」。

### 第 4 步 — 用一个不转换的调用验活

调 **`list_supported_formats`**。它只读共享的能力矩阵，不起任何引擎、不下载任何东西，
是证明接线成功最便宜的一招。成功时返回六个类别（视频 / 音频 / 图片 / 文档 / 电子书 / 压缩包）。

如果工具连上了、但每次调用都报「没有在本机找到可用的 Arbiter」，那就是应用没装、
或者装在第一步那四条覆盖不到的地方——用第 2 步或 `ARBITER_HOME` 修它，**别开始转换**。

### 动手之前值得知道的几条

- **文件访问默认是收窄的。** 读写在允许的根之内；用 `ARBITER_MCP_ROOTS`（读）和
  `ARBITER_MCP_WRITE_ROOTS`（写，只收窄不追加）放宽。
- **`convert_file` 是阻塞的**，转完才返回，过程中持续报进度。一批文件用一次
  `batch_convert`（每条回一个 job id），再用 `list_jobs` 轮询——不要逐个 `get_job_status`。
- **重型格式要下载。** `doc` / `xls` / `ppt` / `odt` 要 LibreOffice（357 MiB），
  `epub` / `mobi` / `azw3` 要 Calibre（213 MiB），部分文档转换要 pandoc（221 MiB）。
  触发之前先跟用户确认。`read_document` 对这几种**直接拒**并说明代价，不会悄悄拉几百兆。
- **没有 OCR。** 图片型 / 扫描件 PDF 没有文本层，`read_document` 会把这件事报成一个
  独立的错误，而不是回一个空字符串。
- **错误是结构化的**：除引擎原话之外还带机器可读的 `code`、`retryable` 与 `next_steps`。
  按它们分支，别去解析散文。
