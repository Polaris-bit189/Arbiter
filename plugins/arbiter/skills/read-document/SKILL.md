---
name: read-document
description: Use when the user wants to read, summarize, quote, search, or extract data from a document file whose format cannot be read directly — .docx/.doc, .xlsx/.xls, .pptx/.ppt, .odt/.ods, .epub/.mobi/.azw3 (e.g. "这个 docx 里写了什么"、"帮我看看这个 Excel"、"这份 PPT 讲了什么"、"读一下这个 epub"、"从这份 Word 里把表格抠出来"). Converts it to Markdown/CSV/text with the arbiter MCP tools first, then reads that. Do NOT use for formats Claude Code already reads natively (.md/.txt/.csv/.json/code, and text-based .pdf) — and do NOT use it expecting OCR: scanned/image-only PDFs and photos of documents are out of scope.
---

# 用 Arbiter 先把文档转成能读的格式

Claude Code 自带的 Read 能读纯文本、代码、**文本型 PDF**。它读不了
`.docx` / `.xlsx` / `.pptx` / `.odt` / `.epub` 这类**压缩容器格式**——直接 Read
会得到二进制乱码。Arbiter 的 MCP 工具负责把它们转成 Markdown / CSV / 纯文本。

## 先看清楚要付的代价

**这一步很重要，别跳过。** 有些转换**要下载几百兆的引擎**，用户不会希望你悄悄
开始下。先看这张表，落在「要下载」那一栏的，**先告诉用户体积，等他确认再动手**。

| 用户手上的文件                    | 转到什么                           | 代价                                  |
| --------------------------------- | ---------------------------------- | ------------------------------------- |
| `.docx`                           | `md`（保留标题/列表/表格）或 `txt` | **不用下载**，纯 JS                   |
| `.xlsx`                           | `csv`（数据）或 `html`（保留样式） | **不用下载**，纯 JS                   |
| `.pdf`（文本型）                  | 其实**直接 Read 就行**，不必走这里 | —                                     |
| `.pptx` / `.ppt`                  | **只有 `pdf` 这一个出口**          | ⚠️ 要下 **LibreOffice（约 357 MiB）** |
| `.doc` / `.xls` / `.odt` / `.ods` | `txt` / `pdf` / `docx` / `csv`     | ⚠️ 同上，要 LibreOffice               |
| `.epub` / `.mobi` / `.azw3`       | `txt`                              | ⚠️ 要下 **Calibre（约 213 MiB）**     |

⚠️ **扫描件 / 拍的照片读不了。** 本项目**没有 OCR**：图片型 PDF 抽出来是空的，
`.jpg` 里的文字也抽不出来。遇到这种直接告诉用户，不要反复尝试。

⚠️ **`.pptx` 没有 `txt` 出口。** 想看 PPT 的内容只能 `pptx → pdf`，然后 Read 那个
PDF（Read 能读 PDF）。这意味着要下 357 MiB——**先问用户**。

## 工具怎么调（**照这里的签名抄，别自己编**）

```
inspect_file({ path: "C:\\path\\to\\file.docx" })
    → 类别、源格式、体积、有哪些合法出口、每个出口要不要下载引擎

convert_file({ source: "C:\\path\\to\\file.docx", target_format: "md" })
    → job_id、status、output（产物路径）、size_bytes、engine、mode

batch_convert({ sources: ["a.docx", "b.xlsx"], target_format: "txt" })
    → 一批共用一个目标格式
```

参数名是 `source` / `target_format`（**不是** `path` / `to`），扩展名**不带点**。

**`convert_file` 是阻塞的：它跑完才返回，返回时已经有 `output` 了。**
不要紧接着去轮询 `get_job_status`——那是给「转视频要几分钟、用户中途想看看」用的。
你可以传 `output_path`（**完整文件路径，含文件名**，不是目录）指定落点。

## 产物读得到吗

**默认落点由应用设置决定，可能在你的读白名单之外**（默认读根是 cwd 与 userData）。
两个办法：

1. 传 `output_path` 把产物放到当前工作目录下——**最省事，推荐**；
2. 或直接用返回里的 `output` 去 Read，读不到再把路径告诉用户。

产物用完之后可以问一句要不要删——**不要自己删**，那是用户的磁盘。

## 什么时候不该用它

- 文件本来就是 `.md` / `.txt` / `.csv` / `.json` / 代码 —— **直接 Read**。
- 文本型 PDF —— **直接 Read**（Read 支持 `pages` 参数，长文档分页读）。
- 用户只是想**换格式**、并不是要读 —— 那是另一个场景，走 `arbiter-convert`。
- 用户要的是**编辑**这个文档 —— Arbiter 是转换器不是编辑器，转出去再转回来会丢东西。
