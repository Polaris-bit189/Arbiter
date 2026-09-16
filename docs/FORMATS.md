# 能力矩阵

> **本文件由代码生成，不要手改。** 改完 `src/shared/formats.ts` 后跑：
>
> ```bash
> npx tsx scripts/gen-formats-doc.mjs
> ```

矩阵的真身是 `src/shared/formats.ts` 里的 `targetsFor()` 与 `engineFor()`，
main 与 renderer 共用同一份。**这里和代码不一致时，以代码为准。**

两条贯穿全表的规则：

- **同格式出口不存在**。`mkv → mkv` 这种任务在矩阵里就没有，界面上也不会出现——
  队列老老实实跑一次毫无意义的重编码、退出码还是 0，是最糟的失败方式。
- **没列出来的组合，多半是实测过做不到，不是忘了加**。
  例如 PDF → Word（LibreOffice Draw 的导入质量很差），
  HEIC → BMP / ICO（sharp 写不出这两个格式，而 HEIC 的像素又只能经 libheif 进 sharp）。

---

### 视频

| 源格式 | 可以转成 | 引擎 |
| --- | --- | --- |
| mkv | mp4、webm、mov、avi、gif | FFmpeg |
| mp4 | mkv、webm、mov、avi、gif | FFmpeg |
| avi | mp4、mkv、webm、mov、gif | FFmpeg |
| mov | mp4、mkv、webm、avi、gif | FFmpeg |
| wmv / flv / m4v / ts / mpg / mpeg / 3gp / m2ts | mp4、mkv、webm、mov、avi、gif | FFmpeg |
| webm | mp4、mkv、mov、avi、gif | FFmpeg |

### 音频

| 源格式 | 可以转成 | 引擎 |
| --- | --- | --- |
| mp3 | wav、flac、aac、m4a、ogg、opus | FFmpeg |
| wav | mp3、flac、aac、m4a、ogg、opus | FFmpeg |
| flac | mp3、wav、aac、m4a、ogg、opus | FFmpeg |
| aac | mp3、wav、flac、m4a、ogg、opus | FFmpeg |
| m4a | mp3、wav、flac、aac、ogg、opus | FFmpeg |
| ogg | mp3、wav、flac、aac、m4a、opus | FFmpeg |
| opus | mp3、wav、flac、aac、m4a、ogg | FFmpeg |
| wma / aiff / aif | mp3、wav、flac、aac、m4a、ogg、opus | FFmpeg |

### 图片

| 源格式 | 可以转成 | 引擎 |
| --- | --- | --- |
| png | jpg、webp、avif、tiff、gif、bmp、ico、pdf | jpg → sharp；webp → sharp；avif → sharp；tiff → sharp；gif → sharp；bmp → FFmpeg；ico → FFmpeg；pdf → 内置文档引擎 |
| jpg | png、webp、avif、tiff、gif、bmp、ico、pdf | png → sharp；webp → sharp；avif → sharp；tiff → sharp；gif → sharp；bmp → FFmpeg；ico → FFmpeg；pdf → 内置文档引擎 |
| jpeg / tif | png、jpg、webp、avif、tiff、gif、bmp、ico、pdf | png → sharp；jpg → sharp；webp → sharp；avif → sharp；tiff → sharp；gif → sharp；bmp → FFmpeg；ico → FFmpeg；pdf → 内置文档引擎 |
| webp | png、jpg、avif、tiff、gif、bmp、ico、pdf | png → sharp；jpg → sharp；avif → sharp；tiff → sharp；gif → sharp；bmp → FFmpeg；ico → FFmpeg；pdf → 内置文档引擎 |
| gif | png、jpg、webp、avif、tiff、bmp、ico、pdf | png → sharp；jpg → sharp；webp → sharp；avif → sharp；tiff → sharp；bmp → FFmpeg；ico → FFmpeg；pdf → 内置文档引擎 |
| bmp | png、jpg、webp、avif、tiff、gif、ico、pdf | png → sharp；jpg → sharp；webp → sharp；avif → sharp；tiff → sharp；gif → sharp；ico → FFmpeg；pdf → 内置文档引擎 |
| tiff | png、jpg、webp、avif、gif、bmp、ico、pdf | png → sharp；jpg → sharp；webp → sharp；avif → sharp；gif → sharp；bmp → FFmpeg；ico → FFmpeg；pdf → 内置文档引擎 |
| avif | png、jpg、webp、tiff、gif、bmp、ico、pdf | png → sharp；jpg → sharp；webp → sharp；tiff → sharp；gif → sharp；bmp → FFmpeg；ico → FFmpeg；pdf → 内置文档引擎 |
| svg / heic / heif | png、jpg、webp、avif、tiff、gif、pdf | png → sharp；jpg → sharp；webp → sharp；avif → sharp；tiff → sharp；gif → sharp；pdf → 内置文档引擎 |
| ico | png、jpg、webp、avif、tiff、gif、bmp、pdf | png → sharp；jpg → sharp；webp → sharp；avif → sharp；tiff → sharp；gif → sharp；bmp → FFmpeg；pdf → 内置文档引擎 |

### 文档

| 源格式 | 可以转成 | 引擎 |
| --- | --- | --- |
| md | pdf、docx、html、txt | pdf → 内置文档引擎；docx → pandoc；html → 内置文档引擎；txt → 内置文档引擎 |
| markdown / htm / rst | pdf、docx、html、md、txt | pdf → 内置文档引擎；docx → pandoc；html → 内置文档引擎；md → 内置文档引擎；txt → 内置文档引擎 |
| txt | pdf、docx、html、md | pdf → 内置文档引擎；docx → pandoc；html → 内置文档引擎；md → 内置文档引擎 |
| html | pdf、docx、md、txt | pdf → 内置文档引擎；docx → pandoc；md → 内置文档引擎；txt → 内置文档引擎 |
| docx | pdf、md、html、txt | 内置文档引擎 |
| doc / odt | pdf、docx、txt | LibreOffice |
| xlsx | pdf、html、csv | 内置文档引擎 |
| xls / ods | pdf、xlsx | LibreOffice |
| pptx | pdf | LibreOffice |
| ppt / odp | pdf、pptx | LibreOffice |
| pdf | png、jpg、txt、md | 内置文档引擎 |
| csv | pdf、html | 内置文档引擎 |

### 电子书

| 源格式 | 可以转成 | 引擎 |
| --- | --- | --- |
| epub | mobi、azw3、pdf、docx、txt | Calibre |
| mobi | epub、azw3、pdf、docx、txt | Calibre |
| azw3 | epub、mobi、pdf、docx、txt | Calibre |
| azw / fb2 / lit / pdb | epub、mobi、azw3、pdf、docx、txt | Calibre |

### 压缩包

| 源格式 | 可以转成 | 引擎 |
| --- | --- | --- |
| zip | 7z、tar | 7-Zip |
| 7z | zip、tar | 7-Zip |
| tar | zip、7z | 7-Zip |
| gz / bz2 / xz / tgz / tbz / tbz2 / txz / rar / iso | zip、7z、tar | 7-Zip |

---

## 引擎对照

| 表里的名字 | `EngineKey` | 实际是什么 | 在瘦包里？ |
| --- | --- | --- | --- |
| FFmpeg | `ffmpeg` | ffmpeg-static 静态构建 | ✅ |
| sharp | `sharp` | libvips 原生模块 | ✅ |
| 内置文档引擎 | `pdf` | 纯 JS（mammoth / SheetJS）+ Chromium 排版 + pdfjs | ✅ |
| 7-Zip | `archive` | 完整的 7z.exe + 7z.dll | ✅ |
| Calibre | `calibre` | MSI 解包目录树，约 658 MB | ❌ 首次使用时下载 |
| LibreOffice | `libreoffice` | MSI 解包目录树，约 1.49 GiB | ❌ 首次使用时下载 |
| pandoc | `pandoc` | 单文件自包含 exe，221 MiB | ❌ 首次使用时下载 |

> 「内置文档引擎」这个 `EngineKey` 的字面量就是 `'pdf'`，它管的不只是 PDF——
> 文档类里凡是**不需要** LibreOffice 和 pandoc 的转换都走它。名字是历史遗留，
> 容易误解，看代码时留意。

> ⚠️ 表里的 **sharp** 对 HEIC/HEIF 要看得更细：这两个格式的像素**先经 WASM 版 libheif
> （heic-decode）解成 RGBA，再交给 sharp 编码**。两个主力引擎都解不开 HEVC 系 HEIC——
> ffmpeg-static 根本没有 heif 解复用器，sharp 的 libvips 则因专利剔除了 libde265
> （它能正常读出元数据、format 也报 heif，一取像素才报错，很有迷惑性）。
> 原始像素里没有可保留的元数据，所以 HEIC 转出会丢 EXIF / ICC。
>
> HEIC 的 BMP / ICO 出口是被**刻意去掉**的：sharp 写不出这两个格式，而 HEIC 的像素
> 又只能进 sharp，所以对 HEIC 源是真做不到，索性不列出来，免得用户选了才失败。

---

## 需要按需下载的转换

安装包**不含** LibreOffice / Calibre / pandoc（合计约 2.4 GiB），它们按需下载。
「要不要在卡片上提示先下载」与「引擎未就绪时要不要按设置跳过」这两件事，
由 `requiresDownload()` 一句话决定。它认领的转换就是下面这些
（共 60 条）：

- md → docx（pandoc）
- markdown → docx（pandoc）
- txt → docx（pandoc）
- html → docx（pandoc）
- htm → docx（pandoc）
- rst → docx（pandoc）
- doc → pdf（LibreOffice）
- doc → docx（LibreOffice）
- doc → txt（LibreOffice）
- xls → pdf（LibreOffice）
- xls → xlsx（LibreOffice）
- pptx → pdf（LibreOffice）
- ppt → pdf（LibreOffice）
- ppt → pptx（LibreOffice）
- odt → pdf（LibreOffice）
- odt → docx（LibreOffice）
- odt → txt（LibreOffice）
- ods → pdf（LibreOffice）
- ods → xlsx（LibreOffice）
- odp → pdf（LibreOffice）
- odp → pptx（LibreOffice）
- epub → mobi（Calibre）
- epub → azw3（Calibre）
- epub → pdf（Calibre）
- epub → docx（Calibre）
- epub → txt（Calibre）
- mobi → epub（Calibre）
- mobi → azw3（Calibre）
- mobi → pdf（Calibre）
- mobi → docx（Calibre）
- mobi → txt（Calibre）
- azw3 → epub（Calibre）
- azw3 → mobi（Calibre）
- azw3 → pdf（Calibre）
- azw3 → docx（Calibre）
- azw3 → txt（Calibre）
- azw → epub（Calibre）
- azw → mobi（Calibre）
- azw → azw3（Calibre）
- azw → pdf（Calibre）
- azw → docx（Calibre）
- azw → txt（Calibre）
- fb2 → epub（Calibre）
- fb2 → mobi（Calibre）
- fb2 → azw3（Calibre）
- fb2 → pdf（Calibre）
- fb2 → docx（Calibre）
- fb2 → txt（Calibre）
- lit → epub（Calibre）
- lit → mobi（Calibre）
- lit → azw3（Calibre）
- lit → pdf（Calibre）
- lit → docx（Calibre）
- lit → txt（Calibre）
- pdb → epub（Calibre）
- pdb → mobi（Calibre）
- pdb → azw3（Calibre）
- pdb → pdf（Calibre）
- pdb → docx（Calibre）
- pdb → txt（Calibre）

> 这张表**不等于**「矩阵里引擎列写了 pandoc / LibreOffice / Calibre 的那些行」。
> rst 的四个非 docx 出口在矩阵里记的是「内置文档引擎」，但那四条同样会拉起 pandoc
> ——矩阵描述的是**哪个引擎对外负责**，不是**这次转换会启动哪些进程**。

---

## ⚠️ 瘦包下的已知缺口

「矩阵 / 引擎清单 `resources/engines.manifest.json` / `requiresDownload()`」三处
说的是同一件事，下面按它对表。这里空着，就说明界面的预告与实际行为一致。

（当前没有缺口：三处对得上。）


### 矩阵表体看不出来的依赖：rst

上面矩阵里 rst 那一行写的是「内置文档引擎」，但那只是**对外负责**的引擎。
rst 的四个非 docx 出口（→ pdf / html / md / txt）解析 RST 语法时**内部要调 pandoc**
（src/main/converters/document.ts 里的 rstToHtmlFragment）——RST 不是它能直接读的标记语言。
所以 rst 的**全部五个出口**都要求 pandoc 在位，上面那张「需要按需下载」的表里也列全了。

> 这属于「已实测做不到」之外的另一种情况：矩阵本身没错，但它描述的是
> **哪个引擎对外负责**，而不是**这次转换会启动哪些进程**。
> 凡是要判断「这次转换会不会拉起某个引擎」，别只看矩阵表体，看 `requiresDownload()`。