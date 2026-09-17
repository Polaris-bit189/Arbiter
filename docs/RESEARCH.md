# 调研留档（2026-09-13）

> 这份文件的存在理由：那份调研是**三个独立 agent 联网 + 本机实测**做出来的，
> 而它们的报告只活在当时的对话上下文里——**对话一结束就没了**。
> 所以这里把「不是结论、但以后一定还会问」的那部分抄下来：
> **同行怎么做的、为什么某些方案被否掉、每条功能的实测坑位、以及原始出处**。
>
> 可执行的待办在 `docs/PLAN.md` §9；要落进代码的实测数字在 `docs/NOTES.md` 约束 25~29。
> 这份文件只放那两处装不下的东西。
>
> ⚠️ **能复原到什么程度要说清楚**：下面是**结论 + 理由 + 关键出处**，
> 不是那三份报告的全文（原文已随上下文消失）。

## 0. 一条待复核的发现：GitHub 现在**直连是通的**

`docs/NOTES.md` 约束 15 记的是「本机 GitHub 直连不通（HTTP 000）」，那是**更早某次**的实测。
本次调研复测（`curl --ssl-no-revoke`，环境里**没有任何 proxy 变量**）：

| 目标                                               | 结果                                                 |
| -------------------------------------------------- | ---------------------------------------------------- |
| `https://github.com/`                              | **200**                                              |
| `https://api.github.com/repos/HandBrake/HandBrake` | **200**（`rate_limit` 也正常返回）                   |
| `https://raw.githubusercontent.com/...`            | **200**                                              |
| Release 资产（跟随 302）                           | **206**，30 万字节 1.61 s，远端 IP `185.199.110.133` |

**这可能就是约束 15 当时缺的那个 `--ssl-no-revoke`。** 也可能是网络环境变了。
⚠️ **两种可能都得再实测复核一次**，确认之前**不要改约束 15**——换台机器、换个出口都可能翻回去。
（另有 agent 报告 `ghfast.top` 回 **403**，即那个代理现在不可用了。）

## 1. 同行怎么做的（值得抄的是设计，不是功能清单）

| 产品                          | 它的做法                                                                                                                                                                           | 我们能用上的                                                                                                                     |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| **HandBrake**                 | 预设系统（`Fast 1080p30` 这类一键档位）；章节标记保留/生成；**文件夹递归拖入**；去隔行给 `Yadif/Bwdif/Decomb` 三选一；「Foreign Audio Search」自动找出「大部分是外语音轨」的字幕轨 | 「预设」层是「只选目标格式」之上的一大步；章节保留用 `-map_chapters 0` 成本极低。⚠️ 它的 `detelecine` **我们这份 ffmpeg 里没有** |
| **Shutter Encoder**           | **"Cut without re-encoding"**（招牌功能）；Replace audio；Rewrap/Conform（= 我们的 remux）；Merge；Extract；**Analysis 面板的 FrameMD5**；内置字幕编辑器；预设可存成文件分享       | `FrameMD5` **正是本项目做 remux 验收用的码流指纹**——值得做成用户可见的「校验」工具。Merge / Replace audio 都是低成本条目         |
| **XnConvert**                 | **80+ 个可串成链的 action，顺序可调、可存成预设**；watch folder；元数据编辑                                                                                                        | ⚠️ **这条最重要**：`TaskOptions` 该长成**有序的 action 数组**而不是一堆平行开关，否则裁剪/缩放/滤镜/几何会各自长出一套 UI        |
| **LosslessCut**               | **把关键帧画在时间轴上**让用户看见切点会吸附到哪；明确区分「无损切割」与「精确切割」且**默认无损**                                                                                 | 正是「关键帧吸附提示」该做的样子（我们目前只在文案里说了会对齐）                                                                 |
| **Format Factory**            | 面向普通用户的一键设备预设（「iPhone 视频」「PSP 视频」）                                                                                                                          | 印证了「预设」的重要性                                                                                                           |
| **Stirling-PDF**              | 合并/拆分/旋转/压缩/加水印/页码/签名/打码/PDF→图片/OCR/加密，**压缩走 Ghostscript**                                                                                                | §9.3 的 PDF 工具箱就是这一摊                                                                                                     |
| **Apple Compressor**          | **官方自己警告**：「创建额外的 Compressor 实例可能提升处理能力，**也可能实际上降低**」                                                                                             | 拿来反驳「多开一定更快」的直觉                                                                                                   |
| **Adobe Media Encoder**       | 「Parallel Encoding」是**一份源、多个输出**并行，**不是**把一份源切成多段；AE 的 MFR 是帧级并行（1.2–1.4×，最高 3×）                                                               | 与「单文件分段并行」是两回事，别混                                                                                               |
| **FFmpeg Batch AV Converter** | 官方措辞「launching as many simultaneous processes **up to user CPU thread count**」                                                                                               | 唯一把并发数做成显式公式的消费级工具（我们已做，见约束 25）                                                                      |
| **Wondershare UniConverter**  | 并发上限**只有 2**                                                                                                                                                                 | 把并发做对本身就是相对竞品的优势                                                                                                 |

**一条重要的否证**：单机「分段并行编码」有两份独立实测是**负收益**——
Igor Osledko 实测 5m15s（串行）vs 5m22s（6 进程并行）；另一份 NVMe 场景下 **−60%**。
根因是帧几何限制线程上限（1080p 约 4）+ 磁盘 I/O。
**真要做，判据应该是「仅长视频且 I/O 不是瓶颈」，不是「切了就快」。**
（我们自己也测出只有 1.19×，而那 1.19× 正好等于「同时跑 4 个任务」的收益。）

## 2. 明确不推荐做的，以及**为什么**

`docs/PLAN.md` §9.5 列了名单，这里记理由——**没有理由的「不做」下次会被重新提出**。

| 不做                                             | 理由                                                                                                                                                                                                                                    |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 换一份更全的 ffmpeg 构建                         | **对速度无收益**：本机实测的失败都不是缺编解码器造成的。而现状（gyan essentials）**同样是 GPLv3**，换 BtbN 并不更「干净」（BtbN 的 `lgpl` 变体砍掉了 libx264/libx265，对视频转换器等于不可用）。代价是瘦包 140 → 185 MB                 |
| 引入 ImageMagick                                 | 能找到的操作 sharp 都能做，找不到的它也不能做。多一个 30 MB 级二进制 + 一份许可证登记                                                                                                                                                   |
| **全 GPU 管线**（NVDEC + NVENC 零拷贝）          | 实测**只快 1%**（2199 vs 2221 ms）。反而 **GPU 解码比软件解码慢 1.4~2.0×**（24 线程 x264 解码太快）。⚠️ **机器相关**：本机 CPU 属「软件解码极强」的一端，弱 CPU + 强 GPU 可能反转——判据必须是「这台机器上量过」，**不能查 `-decoders`** |
| 分段并行编码                                     | 只有 1.19×，**等于文件级并发的收益**，却要付接缝画质缺陷 + 音频单独处理 + concat 的坑                                                                                                                                                   |
| 给 ffmpeg 传 `-threads`                          | 实测 `-threads 6` 在 conc=1 时把 30649 ms 变成 **55265 ms**（1.8× 更慢）                                                                                                                                                                |
| 用 `-fs` 当目标体积                              | 实测目标 300 KB 产出 534 KB **且视频被截断在 2.03 秒**。这是**错误实现**，不是备选实现                                                                                                                                                  |
| `-f segment -c copy` 做固定时长切段              | 实测请求 5 s 得到 6 s / 4 s 两段（只能落在关键帧边界）                                                                                                                                                                                  |
| in-process / WASM 引擎                           | 约束 14 已实测否掉（`pandoc-wasm` 79 KiB 输入 4189 ms，期间 10 ms 定时器触发 **0 次**）                                                                                                                                                 |
| 云端转换 / 上传                                  | 与「本地不上传」这个卖点直接冲突                                                                                                                                                                                                        |
| 常驻托盘 + 全自动监视目录                        | 证据跨产品且很硬（见下）                                                                                                                                                                                                                |
| COM shell 扩展                                   | 稳定性/签名/卸载残留都不受控；收益的九成已被 HKCU 方案 + SendTo 吃掉                                                                                                                                                                    |
| Tdarr Flow 式步骤编排器                          | 成本曲线陡（条件分支、失败回滚、中间产物），Tdarr 自己「怎么删掉一个步骤」都还是 issue。**§9 的配方是它的最小可用子集**                                                                                                                 |
| 「智能猜测用途」并自动执行                       | 猜测可以，**自动执行不行**——本项目全部价值主张建立在「不静默做用户没要的事」上                                                                                                                                                          |
| 继续增加 MCP 工具数量                            | 生态共识 1~15 是甜点区；有实测显示工具多到一定程度后**词汇不匹配时 Recall@1 只有 0.0769**，26 个工具里 23 个从未进过前五，而且失败是静默的                                                                                              |
| AI 人脸修复 / 上色 / 去背景 / 音轨分离           | 每一项都对应几百 MB 模型 + 一套前后处理。**那些是「AI 应用的功能」，不是转换器的功能**                                                                                                                                                  |
| 集成 Upscayl / video2x / LosslessCut / HandBrake | 前三个 **AGPL-3.0**、HandBrake GPL-2.0，而且都是 GUI 不是 CLI。**只能读设计，不能调用**                                                                                                                                                 |
| 用 `dynaudnorm` 冒充降噪                         | 那是动态压缩，改的是动态范围不是底噪。做出来是「听起来变了但没变干净」，比不做更坏                                                                                                                                                      |
| 默认给所有转码加降噪/锐化                        | 这些滤镜在本来干净的素材上是**纯损失**。必须是显式选项且默认关——与 NVENC「默认关」同一条纪律                                                                                                                                            |
| OCR 后 PDF（把文字层叠回扫描件）                 | 那是 OCR 里最贵的一步（自研合成），没有现成的许可证干净的小工具。**先只做「图 → txt」**                                                                                                                                                 |

**监视目录的失败模式（跨产品实证）**：

- Adobe Media Encoder 的 watch folder 会把每个源文件**搬进各自的子文件夹**、结构被改、**没有开关**，用户抱怨横跨多年。
- WaveLab 的用户在监视目录里**录制并编辑**，8/10 个文件失败（文件还没写完就被抓走）；「稳定等待窗口」2 秒太短、5 分钟太长，用户最后只能放弃。
- AutoHotkey 社区的 `WatchFolder()` 例子：文件修改事件**触发两次**，一个 342 字节的文件让记事本开了三次窗口。
- ComicToEPUB 的作者不得不加**持久化 job store**，否则每次启动会重转 500 个已有文件。

⚠️ 而本项目**已经在「重命名即转换」上按同一套理由挡过一轮**（约束 24）。
可接受的形态只有「监视目录**只入队、不自动跑**」——误触发的代价就从「转出一个用户没要的文件」
降到「列表里多一行」。**更好的做法见 §5 的 `E-18`：这个能力宿主已经有，别自己做。**

## 3. 这只 ffmpeg 里到底有什么（实测，不是查文档）

被测对象：`ffmpeg-static` 6.1.1-essentials（gyan.dev）。**下面那张「不可用」的表比「可用」的值钱。**

**实测可用**：`bwdif/yadif/w3fdif/estdif`（去隔行）、`hqdn3d/nlmeans/atadenoise/fftdnoiz/bm3d/removegrain`（降噪）、
`unsharp/cas`（锐化）、`deblock/pp`、`gradfun`（去色带）、`vidstabdetect+vidstabtransform`、`zscale/tonemap/colorspace`、
`minterpolate`（补帧）、`lut3d/eq/curves/colorlevels`、`palettegen/paletteuse`、`subtitles/ass`（libass）、
`drawtext`（libfreetype）、`overlay`、`crop/pad/rotate/transpose`、`trim/select/setpts`、
`cropdetect/blackdetect/scdet/freezedetect`、`libvmaf/ssim/psnr`（客观度量）、
`loudnorm/ebur128/dynaudnorm/volumedetect/silenceremove/atempo/aresample`；
编码器 `libx264`（**含 10-bit `yuv420p10le`**）、`libx265`（10/12-bit）、`libvpx-vp9`、`libaom-av1`、
`nvenc`（h264/hevc/av1）、`qsv`、`amf`、`libmp3lame/aac/libopus/libvorbis/flac/alac/pcm_*`；
字幕编码器 `srt/subrip/ass/ssa/mov_text/webvtt/ttml`。

**实测不可用 / 有坑**：

| 项                                                              | 实测                                                     | 影响                                                                                                                |
| --------------------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `aresample=resampler=soxr`                                      | `Requested resampling engine is unavailable`，**rc=127** | ⚠️ `-h filter=aresample` **照样把 soxr 列在选项里**（编译期没开也列）——照文档写必踩                                 |
| `nnedi`                                                         | `No weights file provided, aborting!`，**rc=127**        | 「有滤镜」≠「能用」，它要外部权重文件                                                                               |
| `zscale` 对**无色彩标签**的源                                   | `code 3074: no path between colorspaces`，**rc=127**     | 输入侧补 `-colorspace/-color_primaries/-color_trc` 后才通（实测 rc=0）                                              |
| `libplacebo`                                                    | 不在滤镜表里                                             | HDR→SDR 只能走 `zscale+tonemap`，不能用更现代的那套                                                                 |
| `ffprobe`                                                       | 不存在（约束 5）                                         | 关键帧列表要自己从 stderr 抠（`-skip_frame nokey -vf showinfo`）                                                    |
| `idet` / `detelecine`                                           | **实测缺**                                               | 去隔行的自动检测做不了，只能让用户自己判断                                                                          |
| `libsvtav1` / `librav1e` / `libdav1d` / `libjxl` / `libfdk-aac` | 缺                                                       | ⚠️ `libfdk-aac` **BtbN 的 Windows 包根本不发 nonfree 变体**，拿不到                                                 |
| `whisper` 滤镜                                                  | 缺                                                       | ⚠️ BtbN 的 `50-whisper.sh` 里**无条件 `return -1`**——**任何 BtbN 构建里都不存在**，别把它算进「换构建能买到的东西」 |

**sharp 侧**：`resize` 支持 8 个内核（`nearest/linear/cubic/mitchell/lanczos2/lanczos3/mks2013/mks2021`，
后两个是 Netflix 那套现代内核，锐度/振铃取舍比 lanczos3 更可控）；`png({palette:true})` 可用（内置 imagequant）；
JPEG 走 mozjpeg。**sharp 没有任何超分能力，也没有目标体积接口**（要自己二分）。
`sharp.concurrency()` 本机实测 = 核数（24）。

## 4. 每条功能的**实测坑位**（最值钱的一节：这些是踩出来的，不是查出来的）

### 4.1 视频

| 功能                                | 坑（都是实测）                                                                                                                                                                                                                                                                                                                                                  |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **无损裁剪**                        | `-ss` 放 `-i` **前** = 回退到前一个关键帧；放**后** = 前进到下一个，**`[3,4)` 永久丢失且不报错**。`-avoid_negative_ts make_zero` **是承重的**：少了它首包 pts 是负的，而 mp4 表达不了，容器只报 2.07 s（⚠️ 症状像「尾部少 1 秒」，**根因在头部**）。**整条流 md5 在裁剪上用不了**（产物是源子集，指纹必然不同），要 `-f framemd5` **逐包**比对。已做，见约束 31 |
| **目标体积 / 码率**                 | ⚠️ `-fs` 不是目标体积（会截断）。走两遍 ABR，`-passlogfile` 要给**绝对路径**且用完清。时长 < 10 s 的短片实际体积会明显偏离目标，要么二次修正要么显示「估算」。⚠️ GPU 开关（M6）与两遍 ABR 的交互未定义——`-cq` 那套是 CQ 模式，**不能**用在两遍 ABR 上                                                                                                           |
| **滤镜组**（去隔行/降噪/锐化/去块） | **顺序承重：去隔行 → 降噪 → 锐化**（反了会把噪点一起锐化出来）。⚠️ **带滤镜必须让 `remuxEligible()` 失效**——这是最容易漏的一处。`nlmeans` 很慢（1080p 上远慢于实时），默认不该勾。`nnedi` 不可用                                                                                                                                                                |
| **HDR → SDR**                       | 那串 zscale+tonemap 对**无色彩标签的源直接 rc=127**，必须先补标签。**源的色彩信息就在 ffmpeg 打开输入那段 stderr 里**（`Stream #0:0 … yuv420p10le(tv, bt2020nc/bt2020/smpte2084)`），可以白拿，不必新开进程。`tonemap=hable/mobius/reinhard` 观感差别很大，要实测选默认                                                                                         |
| **10-bit / 4:4:4**                  | libx264 支持 `yuv420p10le`（这个假设原先错了）。但要定位成「**给二次处理用的中间格式**」——8-bit 源转 10-bit **不会增加信息量**，且产物很多老播放器解不了，同 crf 下体积还涨 10-30%                                                                                                                                                                              |
| **防抖（vidstab 两遍）**            | 中间文件 `.trf` **必须放临时目录且并发时名字唯一**（约束 9 那个「并发输出名占位」问题的另一个实例）。`zoom` 会裁掉画面边缘，要暴露给用户。第一遍与第二遍的进度百分比含义完全不同，UI 上要能区分                                                                                                                                                                 |
| **几何**（裁剪/旋转/去黑边）        | ⚠️ **旋转元数据与实际旋转是两件事**：手机视频的 rotation 在容器 side data 里，`-c copy` 会**原样搬运**，有的播放器转有的不转。要物理转正必须重编码。`cropdetect` 能自动找黑边但**需要扫一段才收敛**（`-t 10 -vf cropdetect=limit=24:round=2 -f null -` 从 stderr 读结果）                                                                                       |
| **字幕**                            | ⚠️ **编码与容器的组合有硬约束**：`mov_text` 只进 mp4/mov，`webvtt` 只进 webm/mkv，`ass/srt` 进 mkv 但**不能进 mp4**。烧录必须重编码（与 remux 互斥），且 **`force_style` 的字体是承重的**——与 PDF 那个中文字体坑同源，**失败方式是「成功但一片方框」，必须先实测**。中文 srt 的编码探测要复用约束 13 那套                                                       |
| **元数据**                          | 换容器的元数据兼容性**不是自动的**（mp4 时间基准 / mkv `<Tag>` / mp3 ID3 互不通用），要用「转完读回来验一遍」而不是假设。⚠️ 图片的 **GPS 与 orientation 是同一条链路**，剥 GPS 会让照片躺倒                                                                                                                                                                     |
| **GIF 参数化**                      | 现在 `fps=12` 与 `scale=480` 是**写死的**。`stats_mode=diff` 对局部变化的 GIF 更好。⚠️ GIF 只有 256 色，画质已是下限——要体积就引导用户转 WebP 动图                                                                                                                                                                                                              |
| **静音/黑场/场景检测**              | 这些是**分析滤镜**，产出的是时间戳列表不是文件，需要「预览 + 确认 + 再执行」的两段式 UI。`scdet` 的 threshold 默认值基本不可用                                                                                                                                                                                                                                  |

### 4.2 图片

| 功能                     | 坑                                                                                                                                                                                                                                                                                           |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **缩放到指定尺寸**       | ⚠️ `withoutEnlargement` 默认是 `false`——不加它「长边 1920」会把 800px 的图**放大**成 1920（体积涨、画质降、用户没要求）。`fit` 的五个值语义要选一个写死在 UI 文案里（`fill` 会拉伸变形）。⚠️ HEIC 那条分支走 raw 像素，resize 要加在 `encoderFor` **之前**，两处都得改。动图要确认帧序列一致 |
| **目标体积（二分质量）** | ⚠️ AVIF 每轮都很贵——先降 effort 搜索、命中后再用高 effort 出一遍。**PNG 没有质量旋钮**（得换调色板量化，或引导转 WebP）。动图要把整叠帧都编一遍，成本乘帧数，建议直接禁用。二分搜索是**体积优先**，可能压到很难看，要设下限并明说「这个体积做不到」                                          |
| **`bmp` / `ico` 作为源** | ⚠️ `sharp.format` 里**根本没有**这两项（连 `magick` 也是 `input:false`）。已修：ffmpeg 先解成 PNG。见约束 28                                                                                                                                                                                 |

### 4.3 文档 / 电子书 / 压缩包

| 功能                       | 坑                                                                                                                                                                                                                                                                                                                                                  |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **扫描件 PDF → txt/md**    | 产物是 **1 个字节**（一个换行）而任务报成功。已修，见约束 28                                                                                                                                                                                                                                                                                        |
| **`pdf → png/jpg` 兄弟名** | 同目录有 `a.pdf` 与 `a-2.pdf` 时会撞。已修（快照避让），**残余窄缝**：源在别的目录时看不到                                                                                                                                                                                                                                                          |
| **xlsx → csv**             | 多工作表只导第一张，**静默**。CSV 没有第二张表的概念，是有意为之，但值得在 UI 上说                                                                                                                                                                                                                                                                  |
| **OCR**                    | `tesseract-ocr` **Apache-2.0**；Windows 二进制的事实标准是 UB Mannheim 的构建（约 50 MB，**需实测**）。语言包 `tessdata_fast`：`chi_sim` 2,469,156 B / `eng` 4,113,088 B（Apache-2.0）。⚠️ **中文扫描件准确率远不如英文**，产品文案不能承诺；版面分析（多栏、表格）很差。⚠️ **不要走 `ocrmypdf`——它依赖 Ghostscript（AGPL），会把许可证面扩大一倍** |
| **whisper 字幕**           | `ggml-org/whisper.cpp` **MIT**；模型从 `hf-mirror.com` 取（**实测可达**，`ggml-base.bin` 返回 206）。⚠️ CPU 上很慢（`base` 对 10 分钟音频要几分钟），要有诚实的时间预估；模型体积与准确率强相关要按需下载                                                                                                                                           |

### 4.4 新引擎的许可 / 体积（决定「能不能随包发」）

| 引擎                              | 许可                                  | 体积                                                      | 备注                                                                                                    |
| --------------------------------- | ------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| **`nihui/waifu2x-ncnn-vulkan`**   | **MIT**                               | **35,497,352 B（含模型）**                                | 单 exe，**首选**——自包含意味着只有一个下载源                                                            |
| `xinntao/Real-ESRGAN-ncnn-vulkan` | GitHub 报 NOASSERTION，**需人工核对** | 2,159,606 B（**不含模型**）                               | 还要再找一个模型源 → 多一个 sha256、多一个失败点                                                        |
| `Tencent/ncnn`（运行时）          | 实为 BSD-3-Clause，**需人工核对**     | 已打包在上面两个里                                        |                                                                                                         |
| `oxipng`                          | **MIT**                               | 小（几 MB）                                               | 纯无损，无画质取舍                                                                                      |
| `libjxl`                          | **BSD-3-Clause**                      | `jxl-x64-windows.7z` 4,813,917 / `-static.zip` 40,492,043 | **需实测哪个自带依赖**                                                                                  |
| `kornelski/pngquant`              | **GPL-3.0**（有商业双轨）             | —                                                         | 有损减色，按需下载可以但要登记                                                                          |
| `qpdf` v12.4.1                    | **Apache-2.0**                        | 28,165,367 B                                              | 许可证最友好，理论上可随包（对瘦包偏大，建议仍走按需）                                                  |
| Ghostscript 10.08.0               | **AGPL-3.0**                          | 65,093,120 B                                              | **只能按需下载**并登记。⚠️ 本地子进程用法不触发 AGPL 的网络条款，但**分发**（哪怕我们下载再转发）会触发 |
| `upscayl` / `video2x`             | **AGPL-3.0**                          | —                                                         | **只作参考，不集成**                                                                                    |

⚠️ **超分需要 Vulkan**——老机器 / 虚拟机 / 远程桌面会直接失败。判据必须是「**真的跑一次**」
而不是查 `-h`（与 NVENC 那条同构，见约束 22）。

## 5. 效率侧：还没做的那几条的**字段级设计**

（已做完的：`list_jobs` / 错误码 / `target_format: auto` / 删 `quality` / `read_document` /
SendTo / 完成后动作 / 历史重跑 / 预置选择 —— 见 `docs/PLAN.md` §9 与 `docs/NOTES.md` 约束 27、29。）

- **`E-1` CLI**（`arbiter convert|read|inspect|formats`，`--json` / `--stdout`）：
  ⚠️ Electron 应用有**单实例锁**，CLI 不能「再起一个 app 实例」——插件 `launch.mjs` 已给出正确形状
  （`ELECTRON_RUN_AS_NODE=1` 跑 `resources/app.asar/out/main/cli.js`）。
  ⚠️ 没有 electron 就没有 Chromium 打印 PDF，`converters/index.ts` 的按需 `import()` 已经处理，
  **别退回静态 import**（约束 19）。⚠️ **Windows 的 stdout 编码**——与约束 23 第 3 条同构，
  输出重定向到文件时按什么码页读要有断言，否则它在开发机上永远不现形。
  ⚠️ hook 默认超时 **60 秒** → hook 里只能做「已就绪引擎的快转」，且**失败必须放行**（exit 0、不改写）。
- **`E-3` `inspect_file` 补代价**：建议字段 `cost: { engine, download_bytes, unpacked_bytes, network_required }`、
  `lossy: boolean`、`estimate: { seconds: [lo,hi], confidence }`。
  ⚠️ `cost` 的来源必须是**运行时读 `resources/engines.manifest.json`**，不是手抄（技能里那张手写的表**已经在漂**：
  写 375 MB 而清单是 357.5 MiB，单位口径都不一样）。
  ⚠️ `lossy` 复用现成的 `remuxEligible()` / `canRemux()`，**不另写白名单**；而且**要按方向判**。
  ⚠️ `confidence` 是承重的：没有它，agent 会把区间当承诺报给用户。
  ⚠️ `formats.ts` 是枢纽文件且**按设计零 fs 依赖**——不许它去读清单，这一层放 MCP 侧（`inspect.ts`）。
- **`E-4` 文件夹递归**：⚠️ **现阶段的「不递归」是刻意的**（递归扫五万文件会卡死主进程，而主进程是唯一真相源，
  它一卡整个应用连取消都点不动）。递归要走**另一条路**：`fs/promises` 分批 yield、随时可取消、
  条数上限（如 5000），且**先给「将加入 N 个文件」的确认**。符号链接成环要自己挡。
- **`E-5` `dry_run`**：二选一——`convert_file({..., dry_run: true})`（推荐，同一条代码路径）或独立 `plan_convert` 工具。
  ⚠️ **绝对不能写 `claimed`**：`reserveOutput` 会登记占位，dry run 走了那条路会让**真实任务被迫改名成 `(1)`**。
  ⚠️ 预览与执行**必须共用校验函数**，否则「预览说能转、跑起来报不支持」。
- **`E-6` 产物自检 `verification`**：复用 `inspect_file` 的侦察链路，别新写探测。
  ⚠️ 判据要宽（`ts → mp4` 会重新分装、gif 时长会变、图片没有时长）。
  ⚠️ **只报事实**（「产物没有音轨」）**不做评分**（PSNR 32dB 是判断，超出敢负责的范围）。
  ⚠️ 批量 200 个文件时会累积一次 ffmpeg 子进程 → 必须能关。
- **`E-8` 工具数量预算**：现在是 8 个。建议在 `test-mcp-view.ts` 里加一条**上限断言**（如 12），
  并把「每个新工具必须在描述里写清它替代了几次什么调用」作为纪律。
- **`E-18` 自动看目录——用宿主的原语，别自己做**：Claude Code 2.1.241 有三个内置调度原语
  （`Monitor` 把命令 stdout 每行当事件、`CronCreate`、`ScheduleWakeup`）。
  **零代码**，写一份文档 + 一条斜杠命令即可。⚠️ 要写清「用户关了 Claude Code 就停了」，
  且**别和 M8 的 `renameWatcher` 互相触发**。
- **`R15` 配方文件**：参照 HandBrake 的 preset JSON（`%APPDATA%\HandBrake\presets.json`，GUI 与 CLI 都能导入导出）。
  ⚠️ **第一步只做 `target` + `mode`**——那两项今天就能真的生效；**绝不先摆 `options`/`crf` 字段**，
  否则就是第二份「看着有、其实被忽略」的配置。
  ⚠️ 配方是**不可信输入**，解析要走逐字段宽容 + **把坏字段报出来**。
  ⚠️ **别做成「配方能跑任意命令」**——那是任意代码执行，会把这个项目的信任模型整个搞坏。
- **`R16` 优先级/插队**：⚠️ `core/queue.ts` 是枢纽文件，**先只做 MCP 侧**
  （`JobRegistry` 是 MCP 自己的队列，改它不碰枢纽文件）。
- **`R20` 产物缩略图**：⚠️ **生态里有客户端会静默丢掉 image block**
  （有实现按 `hasattr(block, "text")` 判断，图直接没了连提示都没有）。
  所以图片只能是补充：**文字事实（尺寸、体积、格式）必须在 text 里**。
  缩放到 ≤ 512px、质量 70、**控制在 200 KB 以内**，且默认关。

## 6. Claude Code / MCP 侧的两条结构性发现

- **hooks 只能跑命令，不能调 MCP 工具。** 所以「让 AI 一句话读完一个 docx」这件事，
  MCP 工具做得到，但**要少一次往返得靠 CLI + hook**（`PreToolUse(Read)` 用
  `hookSpecificOutput.updatedInput` 把 `Read(报告.docx)` 改写成 `Read(临时.md)`）。
  这正是 §9.1 的 `E-1` 的存在理由。生态里已有人这么干（MarkItDown）。
  ⚠️ 已知的坑：`@` 引用文件的路径**不走** `PreToolUse`（有 issue 记录），所以 hook 方案不是万能的。
- **错误是 agent prompt 的一部分，要「可执行」不是「诊断」**——措辞要像
  「Invalid date format. Use YYYY-MM-DD and retry.」而不是「400 Bad Request」。
  本项目其实早有正确的直觉（`assertConvertible` 把合法目标整份塞进 hint，
  注释里写着「这是 MCP 里最值钱的一句错误文案」），后来的错误码是把它**推广到每条出口**。

## 7. 外部来源（当时核过的，附一句可不可信）

**MCP / 工具设计**

- [Anthropic 官方插件的 MCP tool-design 参考](https://github.com/anthropics/claude-plugins-official/blob/main/plugins/mcp-server-dev/skills/build-mcp-server/references/tool-design.md)
- [Writing Effective MCP Tool Definitions](https://docs.unique.ai/administrators/mcp/the-mcp-hub/writing-effective-mcp-tool-definitions)
- 渐进披露与工具数量：[Progressive tool loading](https://usewire.io/blog/progressive-tool-loading-mcp-context-pattern/) · [Cold-Start Tool Blindness](https://huggingface.co/datasets/thaki-AI/daily-paper-2026-08-03-deferred-tool-schema-discovery-cost/blob/main/main.tex)（**Recall@1 0.0769 那个数字出自这里**）
- 异步任务与预算化轮询：[MCP Gets Tasks (SEP-1686)](https://dev.to/gregory_dickson_6dd6e2b55/mcp-gets-tasks-a-game-changer-for-long-running-ai-operations-2kel) · [Arcade: Async Job pattern](https://www.arcade.dev/patterns/async-job)
- 预检 / dry-run：[Add Hard Budgets to MCP Tools](https://runcycles.io/blog/mcp-tool-budgets-before-execution) · [davinci-resolve-mcp #187](https://github.com/samuelgursky/davinci-resolve-mcp/pull/187)（`risk_level` / `confirmation_required` 的形态）
- 大文件分块读：[filesystem-mcp-rs](https://docs.rs/crate/filesystem-mcp-rs/0.1.7) · [官方 filesystem server 工具参考](https://deepwiki.com/modelcontextprotocol/servers/2.2.2-transport-implementations)
- 多模态返回的边界：[MCP tool results materialization boundary](https://openclawai.io/blog/mcp-tool-results-materialization-boundary/) · [image block 被静默丢弃的实例](https://github.com/NousResearch/hermes-agent/issues/10759)

**Claude Code 侧**

- [Hooks reference](https://code.claude.com/docs/en/hooks) · [`updatedInput` 结构不一致 issue #19124](https://github.com/anthropics/claude-code/issues/19124) · [`@` 引用绕过 PreToolUse issue #34699](https://github.com/anthropics/claude-code/issues/34699) · [SKILL.md frontmatter 参考](https://tonsofskills.com/docs/reference/skill-frontmatter/)
- [markitdown 的 PreToolUse(Read) hook 实践](https://zenn.dev/tuzuminami/articles/e487adfd650289)

**同行 / 技术**

- HandBrake：[自定义预设](https://handbrake.fr/docs/en/1.9.0/advanced/custom-presets.html) · [preset JSON 结构](https://deepwiki.com/HandBrake/HandBrake/2.6-preset-system-and-json-management)
- 监视目录的失败模式：[AME watch folder](https://community.adobe.com/t5/adobe-media-encoder-ideas/media-encoder-quot-watch-folder-quot-moves-source-files-into-singular-folders/idc-p/14548153) · [WaveLab](https://forums.steinberg.net/t/watch-folder-issues/982609/7) · [ComicToEPUB](https://www.indie4tune.com/blog/ComicToEPUB-watch-folders)
- 批量重试/续跑：[FFmpeg batch pipeline: temporary names and resumability](https://www.ahosting.net/faq/ffmpeg-hosting/how-to-build-a-batch-video-processing-pipeline.html)
- Electron：[Windows Taskbar（JumpList / recent documents）](https://www.electronjs.org/de/docs/latest/tutorial/windows-taskbar) · [SendTo 机制](https://windowsforum.com/threads/master-windows-send-to-a-tiny-file-routing-trick-windows-11.400331/)
- x264 线程模型：[`doc/threads.txt`](https://code.videolan.org/videolan/x264/-/raw/master/doc/threads.txt)（1080p 封顶 34 线程的来源）
- 7-Zip `-mmt`：[SourceForge bug #2459](https://sourceforge.net/p/sevenzip/bugs/2459/)（作者本人确认「4 线程以上会切块」→ 产物会变）
- LibreOffice `--convert-to` 多文件：[start_parameters](https://help.libreoffice.org/latest/en-US/text/shared/guide/start_parameters.html) · [Bugs #120676](https://bugs.documentfoundation.org/show_bug.cgi?id=120676)（同一 `UserInstallation` 下第二个进程**静默转交参数**，退出码 0 —— 所以 `ENGINE_CAPACITY.libreoffice` 必须是 1）

⚠️ **有几处是「搜索索引级」而非一手核对**，当时明确标注过：Adobe 的 `helpx.adobe.com` 对本机是
Akamai 403（连 Googlebot UA 也 403）；Telestream / Bitmovin / SourceForge 部分页面 Cloudflare 403 或 502；
Netflix 官方博客返回 307 且 0 字节（「1 小时剧集 = 20 个 3 分钟 chunk」那句是用专利
`US11539966` 的 PDF 原文补的）。**引用这些数字之前先自己复核一遍。**

## 8. 这份留档本身的教训

**agent 的报告只活在对话上下文里，会话一结束就没了。** 这次是靠人想起来问才补的。
以后凡是有「调研 / N 个 agent 并行」的产出，**当场落一份文件**，别等收尾——
`docs/PLAN.md` 只装得下「可执行的待办」，同行怎么做、为什么不做、实测坑位、出处是哪儿，它都装不下。

同一条纪律的另一面（已经写进 `docs/NOTES.md` 约束 30）：**并行 agent 的成果如果不落盘、不提交，
就只活在它自己的上下文里**——那份上下文同样会在会话结束时消失。
