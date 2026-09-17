---
name: arbiter-convert
description: Use when the user wants to convert, transcode, or change the format of a media or document file — video, audio, image, PDF, ebook, office document, or archive (e.g. "把这段视频转成 mp4"、"这张 HEIC 转成 png"、"extract this rar"、"convert these markdown files to docx"). Explains the arbiter MCP tools, which to call in what order, and the engine-download cost to warn about before starting. Covers 视频 / 音频 / 图片 / 文档 / PDF / 电子书 / 压缩包。
---

# Arbiter 格式转换

Arbiter（调律者转换器）把六类格式互转：视频、音频、图片、文档、电子书、压缩包。
本插件提供 **MCP 工具**（`mcp__plugin_arbiter_arbiter__*`）与三个斜杠命令
（`/arbiter:convert`、`/arbiter:formats`、`/arbiter:watch`）。

## 八个工具

| 工具                     | 用途                                                                                                    |
| ------------------------ | ------------------------------------------------------------------------------------------------------- |
| `inspect_file`           | 侦察一个文件：类别、体积、**合法出口**、要不要下引擎；音视频还给出时长/分辨率/编解码器                  |
| `list_supported_formats` | 能力矩阵：每类下有哪些源格式、各自能转成什么                                                            |
| `convert_file`           | 转单个文件，**等它跑完才返回**，过程中报进度                                                            |
| `batch_convert`          | 一批文件共用一个目标格式，**立刻返回一组 job_id**                                                       |
| `get_job_status`         | 查进度与结果                                                                                            |
| `list_jobs`              | **一次查一批**任务的进度/结果（`batch_convert` 之后用它，别循环 `get_job_status`）                      |
| `cancel_job`             | 取消，连整棵进程树一起杀                                                                                |
| `read_document`          | 把 `.docx` / `.xlsx` / `.pptx` / `.epub` 等**转成能直接读的文本**并返回，省掉「转换 + 找产物 + 读」三步 |

另有一个 resource `converter://formats`，是一份 markdown 版的能力矩阵——
想一次看懂全局就读它，不必反复调 `list_supported_formats` 试探。

## 三条必须遵守的顺序

**1. 先 `inspect_file`，再决定 `target_format`。**
合法目标是**从源格式问答出来的，不是猜出来的**：`mkv` 转不了 `mkv`（同格式没意义），
HEIC 源没有 `bmp`/`ico` 出口，`→ gif` 一律重编码。猜错了 `convert_file` 会直接报错，
白跑一趟。`inspect_file` 只读元数据，很便宜。

**2. 多个文件共用目标格式 → `batch_convert`，别循环 `convert_file`。**
循环是串行的，批量是一次入队后由主进程按引擎并发调度。
注意它**立刻返回**，要自己用 `get_job_status` 逐个查。
另外拿到返回值先看一眼 `rejected`——某个源不合法只影响它自己，其余照常入队，
不看就等于静默漏掉一个。

**3. 取消之后不会再有返回值。**
`convert_file` 被客户端取消时（发出 `notifications/cancelled`）**本调用不会再返回任何东西**——
这是 MCP 的约定，不是出错。这时要拿结果只能靠 `get_job_status`。

## 产物落在哪：以返回值里的 `output` 为准

**不要假定产物在源文件旁边。** 不给 `output_path` / `output_dir` 时，落点由
**应用里设的输出目录**决定：设了「输出到指定目录」就去那个目录（`batch_convert` 是整批聚过去），
否则才落在源文件旁边（同名，只换扩展名）。

把返回的 `output` **原样、完整地**报给用户，别只说「转好了」，也别自己拼接一个看起来对的路径。
拿不准就去 `get_job_status` 查。

> 这条是端到端验收时踩出来的：工具描述里原先写死了「落在源文件旁边」，
> 而用户机器上设了输出目录，模型照着那句话报了一个**根本不存在**的路径。

## 什么时候该先警告用户

**「要下载引擎」是唯一值得打断用户的事**，因为它可能要下几百 MB：

| 引擎        | 下载体积                   | 什么时候需要                                                |
| ----------- | -------------------------- | ----------------------------------------------------------- |
| pandoc      | 约 40 MB（解包后 221 MiB） | `md` / `txt` / `html` / `rst` → `docx`，以及 rst 的全部出口 |
| Calibre     | 约 213 MiB                 | `epub` / `mobi` / `azw3` 等电子书互转                       |
| LibreOffice | 约 357 MiB                 | `doc` / `xls` / `ppt` / `odt` 等老格式，以及 `→docx`        |

`inspect_file` 的返回里会说明这次转换要不要下引擎。**看到要下就先说一声再动手**，
别让用户对着一个几分钟没动静的任务猜是不是卡死了。下载本身是多镜像回退 + sha256 校验 + 断点续传，
慢是正常的。

## `mode` 怎么选（默认 `auto` 就对）

`auto`：能安全重封装（remux，`-c copy`）就重封装，否则重编码。
实测同一份 1080p h264+aac 转 mkv，**remux 45 ms vs 重编码 1524 ms，快 33.9 倍**。

显式传 `remux` 的意思是**「只准重封装」**——目标容器装不下源的编解码器时**直接失败，
不会回退成重编码**。只有已经确认兼容时才用它，否则就留默认的 `auto`。

## 拿不准就先 `dry_run`（不产生任何副作用）

`convert_file` 有一个 `dry_run: true` 开关：它走**同一套校验**、算出**同一个落点**，
然后直接返回计划而不动手——**不建任务、不写文件、连输出名都不占**。
返回里给出：产物会落到哪、实际用到的 `to`、走哪个引擎、要不要下引擎（下多少）、
有没有损、耗时区间（带 `confidence`，**那是区间不是承诺**）。
代价也几乎为零——它不下引擎、不跑转换。

**什么时候值得先来一次**：转换很慢、很可能要下引擎、或者用户其实在问
「这个能不能转 / 转完多大 / 要多久」而**不是**「现在就转」。
直接动手的话，一次几百 MB 的下载已经在路上了，而用户要的可能只是一个答案。

⚠️ 加了 `dry_run` 的 `convert_file` **不会**进 `batch_convert`：批量的落点是按
`output_dir` 算的，预览一条批量的意义有限。

## `verify: true` 的结果是「对账」，不是「评分」

`convert_file` 还有一个 `verify: true`（**默认关**）：开了之后返回值里会多一个 `verification`，
用 `inspect_file` 那**同一套**侦察链路把源与产物各读一遍，逐项对照时长 / 音轨 / 分辨率。
它只报**事实**（「产物没有音轨」「时长 10.02s vs 源 10.00s」），**不做质量评分**。

代价是**多跑一次侦察**（要开进程读产物），所以只在「产物对不对」真的重要时才开。
批量那边对应的入口是 `batch_convert` 的 `verify`，而 `list_jobs` 只给一个
`verification_status`（`consistent` / `differs` / `unknown`）——要看完整清单得去 `get_job_status`。

⚠️ **判据是宽的，别把它读成「转换失败」**：`ts → mp4` 要重新分装、gif 时长本来就会变、
图片根本没有时长。它回答的是「产物是不是那个东西」，不是「产物好不好」。

## 出错时读 stderr 尾部

`get_job_status` 失败时会给出错误摘要**加上引擎的 stderr 尾部**。
那里才是原始原因（ffmpeg 具体是哪个参数不对、pandoc 说了什么），
只看到「转换失败」等于没有信息——**要把 stderr 尾部读出来再向用户解释**。

另外：pandoc / LibreOffice 这类引擎**给不出百分比**，只有阶段文案。
「没有百分比」是正常的，不要据此判定卡死。

## 路径边界

MCP server 对可读可写目录有白名单，**默认是当前工作目录加上应用的配置目录**。
用户报「路径被拒绝」时，是白名单而不是文件权限的问题；
用 `ARBITER_MCP_ROOTS`（读）和 `ARBITER_MCP_WRITE_ROOTS`（写）可以放宽，
改的是 `.mcp.json` 的 `env`。**不要为了绕开它去改用户的配置**——先问清楚为什么要访问那个目录。

## 产物缩略图（默认关）

`convert_file` 默认**只回文字**（路径、体积、格式、尺寸）。设 `ARBITER_MCP_THUMBNAILS=1`
（同样在 `.mcp.json` 的 `env` 里）之后，图片产物的回话里会**多一块 image**——
长边 512px、JPEG q70、不超过 200 KB，够看清「这是不是我要的那张图」。

三点要知道的：

- **文字永远在第一块，而且自足**：格式、体积、尺寸都在文字里。所以**图丢了也不影响你回答**
  ——生态里确实有客户端会**静默丢掉 image block**（不是报错，是那一块根本不渲染）。
- **只有 `convert_file` 给，`get_job_status` 不给**：轮询那条路上每问一次都要重编一张图。
  转完之后那一张是有的，之后想再看就重新转一次。
- **非图片产物（视频 / 音频 / 文档）永远没有缩略图**，这是设计不是故障。

用不上就别开：一张 512px 的图在上下文里不算小，而路径、体积、尺寸那几个数已经够回答
绝大多数问题了。

## 前置条件

插件**不含引擎**，它借用本机已安装的 Arbiter 应用（`mcp/launch.mjs` 负责找到它）。
如果工具报「没有找到安装好的 Arbiter」，就是应用没装，或需要用 `ARBITER_HOME` 指路。
