# Third-Party Licenses

Arbiter 自身以 **MIT** 发布（见 `LICENSE`）。它**不包含**任何第三方引擎的源码，
而是通过子进程调用独立可执行文件或原生模块。这些第三方组件的许可见下。

> ⚠️ **本文件的每一行在发布前都应核对一次官方 LICENSE 文件。**
> 下面的信息是基于各项目公开许可整理的工程判断，不是法律意见。
> 尤其注意 **FFmpeg、pandoc、Calibre 是 GPL** —— 它们的合规后果见文末「分发范围」。

---

## 1. 随安装包分发（瘦包内含）

这些组件会被打进 Windows 安装包，**分发方需要承担对应义务**。

| 组件                                       | 许可                               | 说明                                                                                                                                                                                                        |
| ------------------------------------------ | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **FFmpeg** (`ffmpeg-static`)               | **GPL-3.0-or-later**               | 随包的是 `gyan.dev` 的 `essentials` 构建，配置含 `--enable-gpl`。通过独立进程调用（不使用链接），源码见 <https://ffmpeg.org/download.html>                                                                  |
| **7-Zip** (`resources/engines/7zip-full/`) | **LGPL-2.1-or-later** + unRAR 限制 | 完整版 `7z.exe` + `7z.dll`，来自 npm 包 `7zip-bin-full`（即官方原版二进制）。含 unRAR 代码，其许可**禁止用于开发 RAR 压缩器**；本项目只用它**解压**，符合限制。源码见 <https://www.7-zip.org/download.html> |
| **sharp** (libvips)                        | Apache-2.0                         | 原生模块，预编译二进制随 npm 分发。见 <https://github.com/lovell/sharp>                                                                                                                                     |
| **Electron**                               | MIT                                |                                                                                                                                                                                                             |
| **React** / **React DOM**                  | MIT                                |                                                                                                                                                                                                             |
| **Zustand**                                | MIT                                |                                                                                                                                                                                                             |
| **zod**                                    | MIT                                |                                                                                                                                                                                                             |
| **clsx** / **tailwind-merge**              | MIT                                |                                                                                                                                                                                                             |
| **Tailwind CSS**                           | MIT                                |                                                                                                                                                                                                             |

## 2. 随安装包分发（文档类依赖，纯 JS）

| 组件                                  | 许可                                  | 用途                                         |
| ------------------------------------- | ------------------------------------- | -------------------------------------------- |
| **PDF.js** (`pdfjs-dist`)             | Apache-2.0                            | PDF → 文本/图片                              |
| **pdf-lib**                           | MIT                                   | 读 PDF 页数与尺寸（测试用）                  |
| **@napi-rs/canvas**                   | MIT                                   | pdfjs 渲染 PDF 页所需的 canvas 实现          |
| **mammoth**                           | BSD-2-Clause                          | docx → HTML                                  |
| **SheetJS** (`xlsx`)                  | Apache-2.0                            | xlsx / csv 解析                              |
| **marked**                            | MIT                                   | markdown → HTML                              |
| **turndown** + `turndown-plugin-gfm`  | MIT                                   | HTML → markdown                              |
| **heic-decode** (`libheif` WASM 构建) | MIT（封装）/ LGPL-3.0（libheif 本体） | HEIC/HEIF 解码；libheif 为 WASM 动态链接形态 |

## 3. **不**随安装包分发（首次运行按需下载）

这几个引擎体积过大（合计约 2.4 GiB），**不在 GitHub Release 的安装包里**，
由用户首次使用时从**官方源**自行下载（`src/main/core/downlink.ts`，多镜像 + sha256 校验）。

它们在**本仓库的源码树里也不存在**（`.gitignore` 挡住了 `resources/engines/`）。

| 组件                   | 许可             | 官方源                                  |
| ---------------------- | ---------------- | --------------------------------------- |
| **LibreOffice** 26.8.0 | MPL-2.0          | <https://www.libreoffice.org/download/> |
| **Calibre** 9.14.0     | GPL-3.0          | <https://calibre-ebook.com/download>    |
| **pandoc** 3.9         | GPL-2.0-or-later | <https://pandoc.org/installing.html>    |

> **为什么这个区分重要**：把 GPL 二进制做进安装包再分发，与自己下载来用，是两种不同的合规处境。
> 瘦包策略同时解决了两件事——安装包小到能接受，以及分发面更干净。

---

## 4. 分发范围（请读一遍）

- **源码仓库**：只含 MIT 许可的本项目代码与上述纯 JS 依赖的声明。
  `resources/engines/` 下的第三方二进制**从未入库**，仓库里不存在 GPL 二进制。
- **GitHub Release 的安装包**：含 FFmpeg（GPL-3.0）与 7-Zip（LGPL-2.1）的二进制。
  这两个在安装包里是**独立可执行文件**，通过 `spawn` 以独立进程调用，不与本项目代码链接。
- **GPL 要求**：分发含 GPL 二进制时，需随附许可证全文并提供对应源码的获取途径。
  上面每个 GPL 组件的「官方源」一栏即源码入口。

如果你打算把项目用在**需要法务审核**的场景（公司内部、商业分发），
请让法务确认 FFmpeg 的 GPL 边界后再发布。本文件不能替代那个确认。

---

## 5. 致谢

这个项目站在一串优秀的开源工具肩上。如果你觉得 Arbiter 有用，
请优先考虑支持上面这些引擎的作者——**真正干活的是他们**。
