# 格式转换器 → AI 原生开源工具：实施计划

> **状态：计划，未开工。** 本文件是这条线的唯一真相源，实施时以它为准。
> 最后更新：2026-09-13。
> 本文件不含任何代码改动；所有已确立的实测结论见 `docs/NOTES.md` 约束 1~17，本文件只写
> **尚未发生**的事，不重复那些已经踩过的坑。

---

## 0. 背景：定位变更

`docs/NOTES.md` 里「个人自用、不做打包分发、全程 `npm run dev` 运行」这条定位**作废**。
新定位是：**面向公开发布的开源项目 + AI 原生工具**。

这会连带推翻几条既定决策，实施时不要被旧的 `docs/NOTES.md` 措辞带偏：

| 旧决策                   | 新状态                                            |
| ------------------------ | ------------------------------------------------- |
| 不做打包分发             | **作废**，`electron-builder.yml` 要清理并投入使用 |
| `README.md` 是脚手架模板 | 重写，它是门面                                    |
| 没有 LICENSE             | 必须加（且**有真实的法律坑**，见 §5.1）           |
| 引擎只服务本机           | 要服务陌生人的机器（首次运行下载、国际镜像）      |
| MCP / AI 接入            | 从「不存在」变成**核心卖点**                      |

**唯一不变的一条**：这个项目的质量标准（断言 + `npm run falsify` 反证 + 每个数字有出处）
不因为要赶发布而放松。这是它相对同类项目的真正护城河。

---

## 1. 目标与非目标

### 目标

1. 一个能公开的仓库：好 README、明确 License、CI 绿灯、无脚手架残留。
2. **AI 原生**：MCP Server 是核心卖点，不是附属品。
3. 性能上有**自己实测出来的**数字（重封装、以及可能有的 GPU）。
4. 陌生人能装上、能用上，包括重型引擎的获取。

### 非目标

- 重写内核（cgo/原生绑定那条路已否决，理由见 §5.4）。
- 云端转换 / 上传。本地跑不上传是卖点之一。
- 移动端、Web 版。

---

## 2. 现状盘点（先说已经有什么）

| 资产                                          | 位置                                              | 对这条线的价值                                                             |
| --------------------------------------------- | ------------------------------------------------- | -------------------------------------------------------------------------- |
| 六类格式统一路由 + 能力矩阵                   | `src/shared/formats.ts`                           | **最大差异化**，市面 MCP 工具多是单引擎                                    |
| 引擎探测与三档回退                            | `src/main/engines/registry.ts`、`status.ts`       | 打包/系统/dev 三种路径已收口                                               |
| 按需下载：多镜像 + sha256 + Range 续传 + 取消 | `src/main/core/downlink.ts`                       | 瘦包策略的关键件，**已完工，73 条测试**                                    |
| 可脱离 Electron 跑的核心                      | `scripts/electron-stub.ts`                        | **MCP Server 的可行性证据**：`test-tasks.ts` 已用真实子进程跑了 176 条断言 |
| 打包骨架                                      | `electron-builder.yml`                            | 瘦包排除与 appId 已于 2026-09-13 修正；`publish` 仍是脚手架值              |
| 引擎不入库                                    | `.gitignore` 的 `resources/engines/`              | ✓ 已处理，避免把 2 GiB 提交进 git                                          |
| 断言 + 反证体系                               | 六套测试 400+ 断言、5 个 falsify 脚本、`bench.ts` | 这是质量护城河，新功能必须落进来                                           |

**结论**：离「能发」比想象中近。真正的缺口是**发布工程**和 **AI 接入**，不是内核。

---

## 3. 工作分解

每条含：**改动点 / 验收判据 / 反证点**。判据全部要落成断言，不接受「看着对」。

### M1 — 发布工程

**改动点**

| 文件                      | 现状                                                                                                                                                       | 动作                                              |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| `package.json`            | `name: format-converter`、`homepage: https://electron-vite.org`                                                                                            | 改名、补 `repository`/`license`/`bugs`/`keywords` |
| `electron-builder.yml`    | `appId: com.electron.app`、`productName: msg-scaffold`、`publish.url: https://example.com/auto-updates`、mac 的 `NSCameraUsageDescription`（用不到的权限） | 全面改写；`publish` 改 GitHub provider 或先删     |
| `README.md`               | 「An Electron application with React and TypeScript」                                                                                                      | 重写，见下                                        |
| `LICENSE`                 | **不存在**                                                                                                                                                 | 加（**先做 §7 决策 1**）                          |
| `THIRD_PARTY_LICENSES.md` | 不存在                                                                                                                                                     | 加，逐个引擎列许可 + 官方源码链接（GPL 硬性要求） |
| `.github/workflows/`      | **不存在**                                                                                                                                                 | 建，见下                                          |

**README 结构**（GitHub 门面三件套）

1. 一句话说明 + **一段 GIF**（拖文件 → 转换 → 完成）。GIF 比任何性能数字都管用。
2. **AI 接入用法置顶**：`claude mcp add ...` 一行 + plugin 安装两行。这是差异化卖点，不该埋在底下。
3. **「为什么不用 HandBrake / Format Factory」**——最重要的一个 section。答案是：命令行/批量/AI agent 可调用 + 六类格式一个入口 + 本地不上传。
4. 自己实测出来的数字（M2 产出），不引用别人的。

**CI 分流**（一把梭会天天红）

| 套件                                                              | CI             | 说明                                           |
| ----------------------------------------------------------------- | -------------- | ---------------------------------------------- |
| `typecheck` / `lint` / `test:core` / `test:doc` / `test:downlink` | ✅ `push`+`PR` | 快、必绿                                       |
| `falsify`（4 套）                                                 | ✅ `PR`        | 纯脚本，且能挡住「断言变装饰」                 |
| `test:tasks` / `test:pandoc`                                      | ⚠️ nightly     | 需真实 ffmpeg/sharp/7z/pandoc 子进程，下载量大 |
| `test:pdf`                                                        | ⚠️ nightly     | 真起 Electron，Linux runner 要 xvfb            |

> **不要为了让 CI 全绿而砍测试。** 这套测试是项目最大的质量资产；慢的放 nightly，不是删掉。

**验收判据**

- `npm run build:win` 产出的安装包能在一台**没装过 node_modules** 的机器上启动（至少要在干净用户目录下验一次）。
- CI 的 `push` 流水线在 **`windows-latest`** 上全绿（首发仅 Windows）。
  ⚠️ **不要加 Linux/macOS 矩阵**：重型引擎靠 `msiexec /a` 解包，那是 Windows 独有的（约束 16）；
  而且 `test:core` / `test:doc` 里有一批依赖 **Windows 路径语义**的断言，**能否在 ubuntu 上跑通尚未实测**。
  在这一点验清楚之前加矩阵，只会得到一条常年红的流水线，而那条线很快会被所有人忽略。
- 仓库里搜不到 `msg-scaffold`、`com.electron.app`、`example.com`、`NSCameraUsageDescription`。

**反证点**

- 把 `files` 里的某条排除规则删掉，确认打包体积**确实变大**——否则那条规则是装饰。
- 在 CI 里临时改坏一条断言，确认它会翻红（证明 CI 真的在跑测试，不是空转）。

---

### M2 — 智能重封装（remux）

**为什么第一优先**：单文件落点、收益可量化、与现有架构同构、且在 MCP 里能变成一个有意义的参数。

**改动点**

- `src/main/engines/ffmpeg.ts` — 拆 `buildFfmpegArgs()`：
  - **容器侧参数** / **编码侧参数** 分两层。现在 `videoArgs(target)` 把两者混在一起。
  - remux 时整段替换编码侧、**保留** `-movflags +faststart`（它只重写索引，`-c copy` 下照样有效）。
  - 新增 `buildRemuxArgs()` 或一个 `mode` 参数。
- `src/main/converters/ffmpegRun.ts` — 决策点在**启动前**，见下面的「矛盾」。
- `src/main/core/probe.ts` — 可能需要从 `Stream #0:0 … Video: h264` 里多解析一行编解码器。
- `src/main/core/queue.ts` — ⚠️ **枢纽文件**，若能不动就不动。
- `scripts/test-tasks.ts` — 加断言。
- `scripts/falsify-tasks.mjs` — 加变异，或在 `falsify` 聚合里另开一套。

**真值场景**（按本项目的格式矩阵）

| 转换              | remux | 条件                               |
| ----------------- | ----- | ---------------------------------- |
| `mkv ↔ mp4 ↔ mov` | ✅    | 视频 h264/h265，音频 aac/mp3       |
| `ts / m2ts → mp4` | ✅    | 经典场景                           |
| `→ m4a` / 抽音轨  | ✅    | `-vn -c:a copy`                    |
| `→ webm`          | ⚠️    | 仅当源是 vp8/vp9/av1 + vorbis/opus |
| `→ avi`           | ⚠️    | h264 可以，aac 进 avi 不标准       |
| `→ gif`           | ❌    | 必须滤镜重编码                     |

**必须解决的矛盾（这是本里程碑的核心难点）**

remux 决策必须在**启动 ffmpeg 之前**做，而编解码器信息现在是从运行**之后**的 stderr 里拿的
（约束 5）。两条路：

- **A（推荐）**：为 remux 判定单独探一次（`ffmpeg -i`，~30 ms），结果缓存。
- **B**：直接试 `-c copy`，失败再回退重编码。零额外探测，但失败要重跑一遍。

**选 A 并不意味着走回头路，这一点必须写进 `docs/NOTES.md`**：约束 5 那条「不单独探测」的优化，
是针对「**必然重编码**」的场景成立的。一旦引入 remux，探测从「纯开销」变成
「可能省下几秒的决策成本」——**约束 5 的结论要重新表述，不是被推翻**。别让后来者以为这里矛盾。

**验收判据**

- `mkv(h264/aac) → mp4` 的产物与源**码流一致**（比对 `ffmpeg -i` 打印的 codec 与码率），且耗时显著低于重编码。**数字要自己用 `bench.ts` 量出来**，不引用别人。
- 不兼容组合（如 `vp9 → mp4`）**自动回退重编码**且成功，不是报错。
- 产物仍是 `.part` → rename 的路径（约束 8/9 不破）。
- 进度条仍有百分比（`-c copy` 下 `-progress` 照样吐记录）。

**反证点**

- 把「容器兼容性判定」改成恒真（永远 remux），确认**不兼容组合那条断言翻红**。
- 把判定改成恒假（永远重编码），确认**「码流一致」那条翻红**。
- 两侧都要翻红，否则说明只测了一边。

> ⚠️ **反证脚本的锚点坑**（本项目已踩过）：重构会让锚点静默失效，而失效的变异是「假通过」。
> 凡是改了被变异覆盖的代码，**必须重跑 `npm run falsify`**，且要打印锚点命中次数
> （0 次和 2 次必须能分清）。

---

#### M2 落地状态与交接（2026-09-13）

> 本节是本文件里唯一的「已发生」段落，存在的理由是**交接**：P3 的实现散在 5 个文件里，
> 而它推翻/修正了上面几处计划假设。**接手时先读本节，再读上面的计划原文**——
> 计划原文保留不动，下面逐条标注哪些成立、哪些被实测推翻。

**落地在哪**（5 个文件，未提交）

| 文件                               | 增删 | 内容                                                                                                                                  |
| ---------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `src/main/core/probe.ts`           | +26  | `MediaInfo` 加 `videoCodec` / `audioCodec`                                                                                            |
| `src/main/engines/ffmpeg.ts`       | +170 | 拆 `containerArgs()`；`REMUX_VIDEO` / `REMUX_AUDIO` 白名单；`remuxEligible()` / `canRemux()`；`buildProbeArgs()` / `buildRemuxArgs()` |
| `src/main/converters/ffmpegRun.ts` | +105 | 启动前探测与决策；取消监听器收敛成一个                                                                                                |
| `scripts/test-tasks.ts`            | +174 | 新的 `[13]`（13 条断言）；`[5] 取消` 与退出路径两处钉死目标                                                                           |
| `scripts/falsify-tasks.mjs`        | +41  | remux 判定**两侧**各一条变异                                                                                                          |

**已验证**

- `npm run typecheck` 三套（node / web / scripts）exit 0。
- `npm run test:tasks` **通过 189 / 失败 0**，exit 0。
- `npm run falsify:tasks` **反证通过，exit 0**（5 个变异：基线 189/0；每个变异锚点命中 1 次、
  期望的断言都翻红、源码已还原）。两条新变异的判别力很干净：
  - **恒真**翻红 8 条——两个「回退」场景 + 第 3 组「码流逐位一致」（即 `vp9+opus → webm`），
    外加 `[5] 取消` 那 4 条顺带红（恒真时 `h264 → webm` 的 `-c copy` 直接失败，
    任务不再「跑得够久」，取消自然测不到）。
  - **恒假**翻红 **恰好 3 条**，全是「码流逐位一致」那组——这正是它要抓的：
    一个「永远重编码」的实现会把兼容场景的断言全部绿着通过，用户那边只是白白慢 18 倍。
- 还原后独立复算哈希，与脚本打印一致：`task.ts` = `87faa39d…`（**与上一轮 bug 排查记录里
  那个值逐字节相同**，顺带证明那一轮的文件没被动过）、`ffmpegRun.ts` = `63866443…`。

**上面那条「必须解决的矛盾」选了 A**，但加了一层过滤：**只在 `remuxEligible()` 放行的方向上才付探测这笔钱**
（图片源、`→ gif` 一律不探）。约束 5 那句「探测占小文件墙钟 38%」仍然成立，它描述的是**必然重编码**的场景。

**三处被实测推翻/修正的计划假设**（⚠️ 接手时最容易踩的三个）

1. **「`→ m4a` / 抽音轨 ✅」这个场景在本项目里不存在。** `targetsFor()` 的 13 个视频源
   （`mkv mp4 avi mov wmv flv webm m4v ts mpg mpeg 3gp m2ts`）**没有一个**能选到 m4a——
   m4a 只出现在 9 个音频源的出口里。而且 `setTarget` 对不在 `targetsFor` 里的目标**静默 `return`**，
   任务会退回默认目标（mp4）继续跑。**所以这条没有实现**，`remuxEligible()` 上方写明了原因，
   **不埋半截代码**。要接它必须先改 `formats.ts`——P3 的禁改文件。
2. **验收判据换成码流指纹。** 计划写的「比对 `ffmpeg -i` 的 codec 与码率」**区分不了** remux 与重编码
   （两者都是 h264）。实际用的是 `ffmpeg -i <f> -map <m> -c copy -f md5 -`：容器无关
   （mp4/mkv/mov 三边结果相同），重编码后必变。
   ⚠️ **唯一例外是 TS**：`ts / m2ts → mp4` 确实能 remux，但它要**重新分装**，
   所以指纹会变。**照搬 `[13]` 的判据去测 ts 会得到一条假红**——那条路只能用「耗时显著低于重编码」来判。
3. **`→ avi` 整条放弃**（计划里的「⚠️ h264 可以」不够用）。同一份 h264，从 mkv 转 avi 要 Annex-B、
   从 mp4 转 avi 又不用（ffmpeg 两条解复用路径给出的包格式不同），而补 Annex-B 要按编解码器挑
   `-bsf:v h264_mp4toannexb` / `hevc_mp4toannexb`，挑错报 `Codec 'xxx' is not supported`。
   **avi 因此不进白名单表**，一律重编码。白名单刻意保守：**漏判只慢一点，误判产出坏文件**。

**另外两条实测补充**（计划里没写到的）

- **`vp9 + opus → mp4` 是可行的**——计划按规范推定不行，实测可以（两者都有 ISOBMFF 绑定）。
  但 **`vp9 → mov` 不行**（`vp9 only supported in MP4`），所以 mov 那一行比 mp4 少一个 vp9。
- **音频那一侧的判据是承重的**：同一份 vp9 视频流，`opus → webm` 能 `-c copy`，
  换成 `aac` 就报 `Only VP8 or VP9 or AV1 video and Vorbis or Opus audio`。
  只判视频的话 `vp9+aac → webm` 会被判成可 remux，然后**整个任务失败**。
  但**无音轨的源照样要能 remux**，所以判据是 `info.audioCodec !== null && !includes(...)`，
  **不能**写成 `!info.hasAudio || ...`。

**⚠️ 本次改动打出来的一个连带效应：`[5] 取消` 那 4 条断言曾经翻红。**

不是实现 bug，是**素材不再够慢**：`[5]` 那段只 `addPaths` + `start`、没调 `setTarget`，
于是走 `defaultTargetFor()` → video 偏好 `mp4` 落空（`targetsFor` 会剔掉源格式自己）→ 退到
`targets[0] = mkv`，而 **h264+aac → mkv 正好在 remux 白名单里**：600 秒的素材 `-c copy`
一百多毫秒就跑完，取消打在完成之后（百分比 `0, 1, 1, 1`，从 0 直跳 1，正是 remux 的签名）。

修法是**给这两处钉一个必然重编码的目标**（`setTarget(..., 'webm')`，h264 进不了 webm，
而 vp9 编码这 600 秒远超 1.2 秒等待窗口），**不是放宽断言**——放宽了取消路径就彻底失去覆盖。

> **给后来者的通用教训**：这个仓库里凡是**拿转换耗时当时序假设**的断言，只要素材落在 remux
> 能加速的方向上，都要重新审一遍。docs/NOTES.md 约束里那句「素材必须在慢的那一侧够慢」现在多了一种
> 失效方式——不是素材变小了，是**路径变快了**。同一条隐患在「退出路径」那段也有（断言终态是
> `canceled`，靠的是「任务还在跑时 `shutdown()`」，而那个窗口被 remux 从约六秒压到一百多毫秒），
> 已一并钉住；那次它是**侥幸绿的**。

**剩余步骤（按顺序）**

1. ~~`npm run falsify:tasks`~~ **已完成，反证通过**（见上）。新加两条变异的锚点打在
   `converters/ffmpegRun.ts` 的 `      remux = canRemux(toExt, parseProbeOutput(probeErr))`
   （6 空格缩进，命中唯一）。恒真那条**只把两个「回退」场景列进期望清单**——兼容场景在恒真世界里
   本来就该绿，写进 `expect` 会让反证永远失败。
2. **`docs/NOTES.md` 两处**：
   - 约束 5 **重述而不是推翻**（理由见计划原文那句「别让后来者以为这里矛盾」）。
   - **补约束 18**：`engines/ffmpeg.ts` 的注释里已经引用了「对照表见 `docs/NOTES.md` 约束 18」，
     **这条引用目前是悬空的**——不加就是一处指向不存在章节的注释。
3. **数字已量（2026-09-13）。** 受控 A/B，口径 = 同一个 `1920x1080 / 20s / 30fps`
   的 h264+aac mp4 源、**同一个目标容器 mkv**、只差两条路、各 3 次取**中位数**：

   | 路径                                  | 三次实测              | 中位        |
   | ------------------------------------- | --------------------- | ----------- |
   | remux（`-c copy`）                    | 43 / 45 / 45 ms       | **45 ms**   |
   | 重编码（`videoArgs('mkv')` 那份参数） | 1527 / 1524 / 1504 ms | **1524 ms** |
   | **倍数**                              |                       | **33.9×**   |

   端到端走 `TaskManager`（含探测 + 状态机）是 **127 ms**（任务自身 113 ms）。

   ⚠️ **`bench.ts` 量不了这个对照**，原因写在它自己的文件头：它是拿**极小文件**跑批量，
   刻意让转换耗时趋近 0、好把「与文件大小无关的固定开销」孤立出来。M2 的收益恰恰在转换耗时的
   **差值**上，两者口径相反。跑 `npm run bench` 得到的是**另一侧**的结论，而且很重要：
   那个「1 秒 64x64 mp4 → mkv」的单任务墙钟 **78 ms**、批量 ×40 每轮 **57.2 ms**——
   **在小文件上，探测的代价与「直接重编码」同量级**，remux 未必划算。
   ⇒ 写进 README 时**必须带上素材规格**，只说「快 34 倍」会误导（`crf 51` 的源只有 2.37 MiB，
   remux 那 45 ms 基本是 I/O）。这条也是「收益随文件变大而放大」的证据。

4. **提交**（commit message 走 `type(scope): summary` ≤50 字符）。
   ⚠️ **绝不用 `git add -A`**：这个仓库有并行写入者，`git add` 与 `git commit` 之间
   **必须再 `git diff --cached` 看一眼**（已有一次两个提交混进别人成果的先例）。
5. 可选：`ts → mp4` 的 remux 单独加一条**按耗时**（不是指纹）判定的断言。

---

### M3 — 引擎按需加载（MCP 的前置）

**为什么做**（三重收益，不是为了好看）

1. MCP 版不能加载 `document.ts`（它链到 `engines/chromiumPdf.ts` → 碰 `electron`）。
2. Electron 主进程启动变快。
3. 加新引擎不再需要改那个 switch。

**改动点**

- `src/main/converters/index.ts` — ⚠️ **枢纽文件，必须单线独占**。把静态 import 改成按需
  `await import()`，每个引擎一个 chunk。
- ⚠️ **连带障碍**：`src/main/engines/registry.ts:3` 静态 `import { app } from 'electron'`
  并在 `ffmpegPath()` 里读 `app.isPackaged`。**MCP 版一 import 就炸**。解法二选一：
  - **注入**：把 `isPackaged` / `resourcesPath` 作为参数或初始化项传入，registry 不再直接依赖 electron。
  - **隔离**：MCP 版自带一份路径解析。
    推荐**注入**——`engines/registry.ts` 已经因为「dev 与打包路径完全不同」而收口在一处，
    在别处再写一份必然分家（这个仓库已经有过一次 `calibreExe()` 与 `calibrePath()` 分家的先例）。

**验收判据**

- 打包后每个引擎确实是一个独立 chunk（看 `out/` 产物）。
- 在**不 import electron** 的环境里能成功 `convert()` 一次 ffmpeg 转换。
- 现有 `test:tasks` 176 条断言仍全绿。

**反证点**

- 临时把某个 converter 改回静态 import，确认「不加载 electron」那条断言翻红。
- ⚠️ **动态 import 与构建的交互要先验**：`externalizeDepsPlugin()` 对动态 import 的处理、
  `out/` 目录结构变化、以及 `tsconfig.test.json` 的 paths 映射是否对 `import()` 仍然生效
  （tsx 下应该生效，但**要实测**，不要假设）。这类问题**只在 `npm run dev` / 打包时才现形**，
  测试全走 esbuild，看不出来。

---

### M4 — MCP Server（核心交付物）

**复用边界**（全方案最关键的一张表）

| 引擎                        | MCP v1     | 原因                                |
| --------------------------- | ---------- | ----------------------------------- |
| ffmpeg                      | ✅         | 纯子进程，`ffmpeg-static` 走 npm    |
| sharp                       | ✅         | 有 win/mac/linux 预编译包           |
| 7-Zip                       | ✅         | `7zip-bin` 走 npm；完整版可首运下载 |
| pdfjs（pdf→txt/md/png/jpg） | ✅         | `@napi-rs/canvas` 有预编译包        |
| pandoc                      | ⚠️ 可选    | 221 MiB，作为可选引擎按需下载       |
| Chromium printToPDF         | ❌ v1 不做 | 依赖 Electron 运行时                |
| LibreOffice / Calibre       | ❌ v1 不做 | 1.49 GiB + 658 MB                   |

**工具设计**（zod 定义 → JSON Schema；项目已有 zod）

```jsonc
"convert_file":            // source, target_format, output_path?, mode(auto|remux|reencode)
"list_supported_formats":  // category?  —— 直接读 formats.ts 的 sourceExtsByCategory / targetsForCategory
"inspect_file":            // path      —— 转换前侦察：格式/编解码器/时长/分辨率/体积
"batch_convert":           // sources[], target_format, output_dir?
"get_job_status":          // job_id
"cancel_job":              // job_id
"list_jobs":               // status?, limit?, since?  —— M9 加的，见下
```

> **`quality` 曾经是个死参数**（2026-09-13 发现）：schema 里声明、工具描述里在讲，
> 而执行路径**从没读过**——agent 传了会拿到 `status: done` 且没有任何提示说它被忽略。
> 已删除。**接通它 = 开「任务参数通道」**，而 `Task` 只有 `inputPath/fromExt/toExt`，
> 那条通道会牵动 `core/task.ts` 与 `core/queue.ts` 两个枢纽文件，是独立决策
> （见 §9.0 的 P-1）。**别为了让 `quality` 回来而顺手开那条通道。**
>
> `list_jobs` 是 M9 加的：在这之前 `batch_convert` 返回一批 `job_id` 之后**没有任何批量
> 查询手段**，转 30 个文件要发 30 次 `get_job_status`。列表刻意不给 `log_tail`。

**四个必须做对的地方**

1. **`stdout` 是协议的，不是日志的。** MCP stdio 传输下，往 `process.stdout` 写一个字节就破坏协议帧。
   本项目 `-progress pipe:1` 是**子进程**的 stdout，不受影响——但主进程自己的日志必须全部走 stderr。
   这是最典型的「本地跑得好好的、装进 Claude Code 就断连」。**要在 CI 里加断言**：
   启动 server，断言 stdout 上只有合法 JSON-RPC。
2. **路径是 AI 给的，就是不可信输入。** MCP server 等于把「任意文件读写」交给一个可能被提示注入的
   agent。必须有 allowlist（默认 cwd + 用户配置目录），拒绝时给明确错误而不是静默。
   **这不是洁癖**：MCP 工具和「读网页内容」这类工具共享同一个 agent 上下文。
3. **进度与取消要真接上。** `TaskManager` 的增量 patch ↔ MCP `notifications/progress`（请求带 `progressToken`）；
   `core/cancel.ts` 的进程树杀灭 ↔ MCP `notifications/cancelled`。**现有实现能直接对接，不用新写。**
4. **错误要能读懂。** `ConversionFailed` 带 stderr 尾部（`tailLines`），直接透传——agent 拿到
   「ffmpeg 报了什么」比拿到「转换失败」有用得多。

**加分项（成本近零）**

- 把能力矩阵做成 MCP resource（`converter://formats`），返回一张 markdown 表。
  agent 读一次就知道全局，不必用 `list_supported_formats` 试探十几次。
- 从同一份 zod 定义**导出一份 OpenAI 风格 function calling schema** → 覆盖 ChatGPT 等。
  边际成本近零，覆盖面翻倍。

**验收判据**

- 在真实 Claude Code 里完成一次「转成 mp4」，且进度条能动。
- stdout 协议纯净性断言在 CI 绿。
- 越权路径被拒绝，且错误可读。
- 取消确实杀掉进程树（判据沿用本项目既有做法：**取消耗时 < 完整转换耗时的一半**，
  只断言「抛异常/无产物」在取消落到完成之后照样会绿）。

---

### M5 — Claude Code Plugin

同一 repo 内提供 plugin 清单，用户：

```
/plugin marketplace add <owner>/<repo>
/plugin install <name>@<marketplace>
```

**三件事**

- **内置 MCP server 定义** → 装 plugin 即装 MCP。
- **一个 skill**（`SKILL.md`）：写清「用户说『把这个转成 mp4』时怎么调」——包括
  **先 `inspect_file` 再决定**、批量走 `batch_convert`、什么时候提示
  「这个转换要下载 340 MB 引擎，要吗」。**skill 的触发描述写得好不好，直接决定它会不会被用起来。**
- **一两个斜杠命令**：`/convert`、`/formats`。

> ⚠️ plugin 的目录结构与字段名（`marketplace.json` / `plugin.json` / `.mcp.json`）**落地前
> 对一遍官方文档**，本计划未逐字段确认过。

**验收判据**

- 在一台**干净机器**（没有本仓库的 checkout）上 `/plugin install` 后能直接用。
- 卸载干净，不留残留配置。

**已完工（2026-09-13）** —— `3ad267c`（插件本体）+ `369ae69`（打包分支的修复）。

落地件：仓库根 `.claude-plugin/marketplace.json`；`plugins/arbiter/` 下的
`.claude-plugin/plugin.json`、`.mcp.json`、`mcp/launch.mjs`、`mcp/asar.mjs`、
三个技能（`arbiter-convert` 给模型、`convert` / `formats` 给斜杠命令）、`README.md`。

**插件借宿主**：插件装在 `~/.claude/plugins/cache/` 下，那里既没有 `node_modules`
也没有引擎，所以 `launch.mjs` 找本机一份可用的 Arbiter，用它的 Electron 以
`ELECTRON_RUN_AS_NODE=1` 跑 `resources/app.asar/out/main/mcp.js`。为此
`electron.vite.config.ts` 加了第二个 main 入口（`5d97e58`），并实测确认该入口在产物里
（`app.asar` 内的 `out/main/mcp.js`，43,995 字节）。

验收判据一（干净机器）**一开始是不成立的**，抓到并修掉了：启动器判「打包好的应用有没有
MCP 入口」用的是 `existsSync`，而**普通 Node 看不进 asar**，那条判据恒为 false。
开发机上永远不会现形——`candidateRoots()` 里有仓库根，走的是普通文件系统那条路，
我第一次端到端跑通走的正是它。按判据模拟干净机器（`ARBITER_HOME` 指向 `build:unpack`
的产物 + cwd 不在仓库里）才撞上，报的还是「这个安装包可能早于 0.2.0」这种方向反了的提示。
守卫：`npm run test:plugin` + `npm run falsify:plugin-launch`（4 个变异，已通过）。
细节见 `docs/NOTES.md` 约束 21。
⚠️ **2026-09-17 补了同一族的第三个实例**：`candidateRoots()` 只认三个**默认**安装位置，
安装时改了目录（如 `D:\tools\Arbiter`）就等于「没装」——`resolveTarget()` 返回 null、
插件整个起不来。修法是去注册表卸载表里问一句；守卫是 `npm run test:plugin-target`
（**30 条**，纯逻辑 + 一次临时注册表键往返）+ `npm run falsify:plugin-target`
（**14 个变异**，单轮 9.9 秒）。同样**只在用户机器上现形**，同样被仓库根那条候选长期掩盖。

⚠️ 第一版的覆盖是**假的**：测试注入的是**叶子键**而生产注入的是**父键**
（条目在 `…\Uninstall` 的 `{GUID}` 子键下），于是 `reg query` 的 `/s`（递归子键）
**拿掉都不会红**——而生产形态下少了它就是查不到、整条修复静默失效。三路对抗审计
另点出 7 个「改了它、一个都不会红」的支柱，都补了断言与变异。
**判据：测试的注入形状必须与生产一致，否则变异覆盖是假的**（与约束 30 同源）。
⚠️ **这里当时只看见了症状的一半**：`existsSync` 是「看不见 asar」，而真正致命的是
**加载**——Node 读不进 asar，所以入口在 asar 里就必然起不来。2026-09-14 才发现并修掉，
见 §9.8 的 D8。

验收证据（都在 2026-09-13 实跑）：

- 真实 Claude Code 会话里按住插件（工具名 `mcp__plugin_arbiter_arbiter__*`）、
  `ARBITER_HOME` 指向打包产物，`note.md → html` 转换成功，模型**照返回值报的路径**
  （`D:\wjzcq\note (2).html`，本机 settings 里设了输出目录，产物不在源文件旁边）。
- `claude plugin validate ./plugins/arbiter --strict` 与 `validate . --strict` 均通过。
- 默认设置那一支也验过：干净 userData 下产物落在源文件旁边。

判据二（卸载干净）：**配置是干净的**——`installed_plugins.json` 回到 `{plugins:{}}`、
`known_marketplaces.json` 只剩官方、`settings.json` 的 `enabledPlugins` /
`extraKnownMarketplaces` 都成 `{}`。但**缓存不会自动删**：
`plugins/cache/arbiter/` 只被打一个 `.orphaned_at` 标记等 CLI 择期回收
（`plugins/data/` 下同名目录同理）。实测删掉再重装没有影响。这条写进了插件 README。

> ⚠️ 顺带一个只影响开发者的坑：`claude --plugin-dir <path>` **只注册技能，不暴露 MCP 工具**
> （`claude mcp list --plugin-dir` 却显示 server ✔ Connected）。要真调工具必须
> `marketplace add` + `install`。别拿 `/mcp` 里绿着当工具可用的证据。

---

### M6 — GPU 硬件加速

**已实测（本会话，只读）**

```
ffmpeg 6.1.1-essentials_build-www.gyan.dev     ← "essentials" 是 gyan 的构建名
--enable-nvenc --enable-nvdec --enable-cuvid --enable-amf --enable-d3d11va --enable-libvpl
encoders: h264_nvenc / hevc_nvenc / av1_nvenc / *_qsv / *_amf
hwaccels: cuda dxva2 qsv d3d11va
本机：RTX 5070 Ti Laptop + Intel 核显，驱动 610.88
```

**这推翻了「essentials 精简版没有硬件编码器」这个直觉**，值得记进 `docs/NOTES.md`。

**两步走**

1. **第一步：一条实测（几秒，写系统临时目录）** —— 验证 NVENC 在本机真的能编。
   ffmpeg 6.1.1（2023-11）编 nvenc 时的 nv-codec-headers 可能不认识 Blackwell（5070 Ti 是 2025 架构）。
   **这条不通过，整个 M6 就不用做了。**
2. **第二步：只在通过后才实施。**

**两个必须考虑的后果**

- ⚠️ **`core/queue.ts` 的 `ENGINE_LIMITS` 会被牵动**。它建立在「ffmpeg 是 CPU 密集」这个前提上；
  走 NVENC 后变成 GPU/IO 密集，合理并发数会变。而 `queue.ts` 是**四个枢纽文件之一，必须单线。**
- ⚠️ **消费级驱动对 NVENC 并发 session 有上限**（历史上 2~8 路），超了**直接报错**。
  这个上限会**反过来约束**队列配置——是设计约束，不是可以忽略的细节。

**参数语义差异**：NVENC 的质量参数是 `-cq` 而不是 `-crf`，低码率下画质/码率比通常不如 libx264。
所以**默认不该切 NVENC**，应该是「用户显式选择的速度优先模式」，否则会静默降质——
那正是这个项目最反感的一类错误。

**验收判据**

- 有实测数字（同素材、同参数、NVENC vs libx264 的耗时与体积）。
- 默认路径**不改变**（不切 NVENC 时产物与现在一致）。
- GPU 不可用（无卡/驱动旧）时自动回退 CPU 且成功。

**已完工（2026-09-13）**

第一步实测通过：NVENC 在本机（RTX 5070 Ti Laptop / 驱动 610.88 / ffmpeg-static 6.1.1-essentials）
真的能编，退出码 0。**第二步也做完了**，但形状与最初的设想不同——实测数据不支持
「GPU = 无脑更快」，所以最后做成了**默认关的显式开关**，而不是默认路径的一部分。

**六轮实测，口径：中位数（3 次），同一素材同一目标容器，机器空闲。**

先纠正一条最要命的：**`-cq` 与 `-crf` 同号不代表同质。**

| 素材（1080p60 / 20s） | libx264 veryfast crf23 | nvenc p4 cq23          |
| --------------------- | ---------------------- | ---------------------- |
| 平滑（testsrc2）      | 1.77 s / 15.00 MiB     | 2.19 s / **46.02 MiB** |
| 高熵（+时域噪声）     | 3.89 s / 22.33 MiB     | 2.91 s / **62.39 MiB** |

同号的 `cq 23` 产出是 `crf 23` 的 **2.8 倍大**。照抄「23」会让用户在「质量 23」的
预期下拿到体积暴涨的产物。扫 cq 之后，**`-cq 30` 才与 `-crf 23` 体积相当**：

| 素材（1080p60 / 20s） | libx264 veryfast crf23               | nvenc p4 cq30                        | 结论                             |
| --------------------- | ------------------------------------ | ------------------------------------ | -------------------------------- |
| 平滑                  | **1.77 s** / 15.00 MiB / SSIM 0.9908 | 2.16 s / 21.46 MiB / SSIM 0.9931     | 慢 1.22×，大 43%                 |
| 高熵                  | 3.89 s / 22.33 MiB / SSIM 0.8090     | **2.89 s** / 22.22 MiB / SSIM 0.8136 | **快 1.35×**，体积持平、画质略好 |

也就是说：**NVENC 只在难编的素材上是净赚，好编的素材上反而更慢**——不是「无条件的加速」。
其余几条定参数的实测：

- **`-preset p4`** 是甜点。`p1` 在平滑素材上更快（1.48 s vs 2.18 s）但产物大 26%；
  `p7` 比 CPU 还慢（3.96 s vs 3.89 s）。
- **`-tune hq -rc-lookahead 20 -spatial_aq 1 -temporal_aq 1` 那一套别加**：只换来 +0.01 SSIM，
  却让产物再涨四成、耗时也多一截。
- **4K（3840x2160@30 / 10s）上 nvenc 仍然慢于 libx264 veryfast**（2.34 s vs 2.19 s）。
  拆开量才看明白：**瓶颈不在编码那一段**。1080p60 高熵素材上纯解码就要 2.69 s
  （nvenc 全程 2.93 s）。ffmpeg-static 只有软件解码，GPU 只加速了编码那一小段。
- **`-hwaccel cuda`（硬件解码）一律更慢**：1080p60 高熵 2.93 s → 3.75 s，
  4K 2.35 s → 2.40 s。**不要开**。
- **并发 session 上限**：本机驱动实测 **8 路并发全部成功**（PLAN 原先照抄的「历史 2~~8 路」
  在本机不成立）。但别的机器仍可能低到 2~~5 路，所以回退逻辑按「任何一次 GPU 失败都
  退回 CPU」写，队列的 `ENGINE_LIMITS` **不动**——`queue.ts` 是枢纽文件，
  而实测并没有「必须改它」的证据。
- 探测编码器可用性**必须真的编一帧**，不能查 `ffmpeg -encoders`：那份构建**任何**机器上
  都能列出 `h264_nvenc`。且探测分辨率不能小（64x64 会被编码器顶回来，
  报 `Frame Dimension less than the minimum supported value`，会被误读成「没有 GPU」）。
  失败时**退出码是 127 而不是 1**。

**落地**：`engines/nvenc.ts`（探测 + 缓存）、`engines/ffmpeg.ts` 的 `NVENC_VIDEO` /
`NVENC_TARGETS`、`converters/ffmpegRun.ts` 的探测与回退、设置项 `hardwareEncode`（默认 `false`）、
设置页开关。验收见 `test-tasks.ts` 的 `[14] GPU 硬件编码` 与 `falsify-tasks.mjs`。

⚠️ 那条「自动回退」的断言**刻意不按机器分叉**：用 `setHardwareEncodeProbe` 把探测结果
强行压进去，再额外造一个 64x64 的用例（必然让 NVENC 失败），这样**在任何机器上**
回退分支都是被真执行到的，而不是「这台机器恰好没卡」式的空转。

⚠️ 这一节的素材必须是 **vp8**：h264 的 mkv 转 mp4 会命中 remux（`-c copy`），
一次都没编，断言会集体假绿。

---

### M7 — 首次运行引擎下载（国际镜像）

**背景**：LibreOffice **1.49 GiB** + Calibre **658 MB** + pandoc **221 MiB**。全塞进安装包不现实。

**方案**：瘦包 + 首次运行按需下载。`downlink.ts` 已经为此设计完毕（多镜像、sha256、续传、取消）。
**sha256 硬编码在 `resources/engines.manifest.json` 的做法保持不变**——这是整个下载设计里最值钱的一环，
等价于签名校验。

⚠️ **必须重做的部分**：现在的镜像列表是为「国内下 GitHub Release」设计的。发到 GitHub 之后用户群变了，
需要**同时覆盖国际与国内**：

| 引擎        | 国际源                                  | 国内源（已实测可达）                                         |
| ----------- | --------------------------------------- | ------------------------------------------------------------ |
| LibreOffice | 官方 CDN                                | 清华 TUNA（`Win_x86-64` **下划线**，写 `Win-x86-64` 是 404） |
| Calibre     | `download.calibre-ebook.com`            | 同左（实测直连可达）                                         |
| pandoc      | 官方 GitHub release（**本机直连不通**） | 清华 TUNA PyPI 的 `pypandoc-binary` wheel                    |

**验收判据**

- 在「无引擎」的干净状态下，每个引擎都能下载、校验、解包、转换成功。
- 镜像列表里**每一个** URL 都实测可达（不要抄一份没验过的列表——本项目已有 `Win_x86-64` 这类教训）。
- sha256 不匹配时**必须同时删掉 `.part`**（`downlink.ts` 已处理，别改坏：只删最终文件的话，
  下一个镜像会把坏文件当断点续传，sha 永远对不上）。

---

### M8 — 系统集成（右键菜单 + 重命名即转换）

> 这两条与「npx/安装包」形态有张力，排在最后，且**必须按下面这个谨慎形态做**，否则会变成
> 用户投诉的来源。

**右键菜单**

- Windows：注册表 `HKCU\Software\Classes\*\shell\...`（**HKCU，不是 HKLM——免管理员**）。
- 传参形如 `<exe> --convert "%1" --to mp4`。
- ⚠️ **参数注入**：本项目的约束 2 要求路径 `path.resolve()` 转绝对路径，因为以 `-` 开头的文件名
  会被当成选项。右键菜单把用户可控的路径交给程序，这条约束在这里**同样承重**。
- ⚠️ 必须提供**卸载**路径，且安装包卸载时要清理注册表。

**重命名即转换**

创意好，但风险 / 收益比差，原因具体：

- 改名后**源文件没了**，而转换需要源。只能「先转换再删源」或「产物放别处」，这与用户
  「我以为只是改名」的预期不符。
- **误触发代价大**：`recpie.mp4 → recipe.mp4` 是改错别字，不是格式转换；`a.mkv → a.mp4` 才可能是。
- 监听整个磁盘不现实，只能监听白名单目录 → 用户要先配置，**摩擦没降反升**。

**要做的话，必须是这个形态**：显式开关（默认关）+ 白名单目录 + 扩展名白名单 +
可撤销（保留源文件直到用户确认）+ 明确的系统通知。

**验收判据**

- 从「安装」到「右键转换」到「卸载」全流程可走通，卸载后注册表无残留。
- 重命名功能在**默认关闭**状态下零副作用（这是最重要的判据）。

---

#### M8 落地状态（2026-09-13）

**两半都做了。**「重命名即转换」按本节自己规定的谨慎形态落地：显式开关（**默认关**）+
白名单目录 + 扩展名白名单 + **保留源文件直到用户确认**（可撤销）+ 明确的系统通知。
本节上面论证的三条风险逐条对着挡：源文件不删（只改名回原扩展名并保留）、误触发靠
「同词干 + 扩展名变化 + 双方都在扩展名白名单内」三重判据挡掉、摩擦靠「默认关」挡掉。
唯一的验收判据「默认关闭状态下零副作用」仍然成立——不点开关就**不装任何监听器**。

**落地件**

| 文件                                               | 内容                                                                                                                                                                                             |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/main/core/integration.ts`                     | 注册表读写：`readContextMenu` / `installContextMenu` / `uninstallContextMenu` / `syncContextMenu` / `ensureContextMenu`。**不 import electron**，只用 `process.execPath` 与注入式的 `appPaths()` |
| `src/main/core/cli.ts`                             | `--convert <文件> [--to <格式>]` 的解析，以及注册表里那条命令行的 Windows 引号拼装（`buildContextMenuCommand`）                                                                                  |
| `src/main/index.ts`                                | 启动时认 `--convert`；`second-instance` 读**新的** argv（读 `process.argv` 会把第一个文件重转一遍）；启动自愈一次 `ensureContextMenu()`                                                          |
| `src/main/ipc/tasks.ts`                            | `enqueueExternalRequest`：入队 + 自动开跑；拒收时**弹框说出来**，不静默                                                                                                                          |
| `src/main/core/settings.ts`、`src/shared/types.ts` | `contextMenu` 设置项，**默认 `false`**（不点开关就不写注册表）                                                                                                                                   |
| `build/installer.nsh`                              | 卸载时删我们那一个键，再**确认为空**才逐层收中间层（`DeleteRegKey /ifempty`）                                                                                                                    |
| `scripts/test-integration.ts`                      | 97 条断言；`[7]` 是真 `reg.exe` 往返，但走**临时键**，不碰用户的真实键                                                                                                                           |
| `scripts/falsify-integration.mjs`                  | 16 个变异，覆盖 cli / integration 两侧与重命名那两条                                                                                                                                             |

**「重命名即转换」的落地件**（同样在上面那张表之外单列，因为它是另一条链路）

| 文件                                      | 内容                                                                                                                                                                       |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/main/core/renameWatch.ts`            | **纯逻辑**（零 fs、零 electron）：两份目录快照的差分，认出「只改了扩展名」的文件。判据刻意写窄——同词干两侧都只能有一个候选、**体积必须完全相等**、只认 video/audio/image   |
| `src/main/core/renameWatcher.ts`          | 驱动：`fs.watch` 只当唤醒信号（重扫结果才是唯一真相）、改回原名、叫队列开跑、被拒时**回滚文件名**。副作用（入队/通知/告警）由 `RenameEffects` 注入，所以能脱离 electron 测 |
| `src/main/ipc/rename.ts`                  | electron 侧接线：`syncRenameWatch()` / `stopRenameWatch()` / 设置页的「添加目录」「移除目录」两个 IPC。`Notification.isSupported()` 为假时降级成 `console.warn`            |
| `src/shared/types.ts` 等                  | `renameConvert`（**默认 `false`**）与 `renameConvertDirs`（默认空数组 = 不开工）。schema 里目录用 lenient 解析：**坏条目丢掉、不让整份设置作废**                           |
| `src/renderer/src/pages/SettingsPage.tsx` | 设置页那一段（平台无关，与右键菜单那段的 win32 守卫不同）：开关 + 目录列表 + 「开关开着但目录为空」的显式提醒                                                              |

**验收判据已达成**：`npm run test` 全量 **876 / 0**（其中 `test:integration` **97 / 0**）；
`npm run falsify:integration` 16 个变异全部被抓且源码逐字还原；`npm run typecheck` 三套 exit 0；
`npm run lint` 0 errors；`npm run build:win` exit 0（`dist\Arbiter-0.1.0-setup.exe`）。

**五条实测结论**（完整版在 `docs/NOTES.md` 约束 23，这里只留索引）

1. `reg query KEY /ve` **会**把值名打出来，而中文系统上它叫 `(默认)`。正则锚在行首的 `REG_`
   会让**所有** `/ve` 读回成 null——表现是「装是装上了，但读不出命令行」。
2. `reg.exe` 经管道吐出的是**系统 OEM 码页**（GBK），不是 UTF-8。先按严格 UTF-8 解、抛错再退 GB18030。
3. **绝不匹配 stderr 里的本地化文案**（`/find|找到|cannot find/` 会撞上 GBK 乱码）。
   `reg delete` 的退出码 1 = 未找到 = 正常，只有 `-1`（reg.exe 没起来）才是真错误。
4. **`reg query <键>` 对「恰好 1 个子键」的键也只打一行**，所以「非空行数 ≤ 1 ⇒ 空键」是错的。
5. `MultiSelectModel=Single` 让本项在多选时**隐藏**。`%1` 只替换成第一个选中文件，
   不设它，用户框选 10 个文件只会转 1 个、而且没有任何提示——静默少干活。

**⚠️ 第 4 条不是纸上推演：它真的删掉了这台机器上别人的菜单项。**

开发机上 `HKCU\Software\Classes\*\shell` 里躺着迅雷的 `ThunderShell`（这个位置就是各家经典右键
动词**共用**的落脚处）。按 `≤ 1` 那个判据，卸载我们的键之后 `ThunderShell` 成了那一层**唯一**的
子键 → 1 个非空行 → 被判成空键 → **删掉了**。而**当时的测试是绿的**——测试自己造的邻居键让那一层
凑够了 2 行，绿灯是碰巧，不是保证。

判据已改成「非空行数为 0」，并补了**直接喂真实输出**的纯函数断言（不依赖这台机器上有什么），
外加一条专打这个 off-by-one 的变异。丢掉的 `ThunderShell` 项**没有伪造补回**：那是迅雷的东西，
它的命令行字符串我没有，也不该凭猜写进用户的注册表。

> 顺带一条方法论：这一轮我一度以为「ThunderShell 在 `*\shell` 里」是自己写错的，因为后来去查
> 只查到 `PackagedCom\Package\ThunderShell_...`。**那个推断是反的**——查不到正是因为
> **我自己的卸载逻辑把它删了**。**「现在查不到」不等于「以前没有」**，尤其是在手里刚握着
> 一个删除路径的时候。

**反证点**（已全跑）：把 `isEmptyQueryOutput` 改回 `≤ 1` → 「恰好 1 个子键」那条翻红；
把 `STOP` 放宽到 `HKCU\Software\Classes` → 边界那条翻红；
把路径的 `path.resolve()` 摘掉 → 两条翻红（约束 2 在这里同样承重）。

**Windows 11 的现实**：新版右键菜单**默认不显示** `*\shell` 动词，它落在「显示更多选项」
（`Shift+F10`）里。这是**系统行为，不是注册失败**——设置页必须把这句话写在明面上，
否则用户看不到菜单时的第一反应是「这个功能是坏的」。

---

#### 四线并行落地（2026-09-13，M9）

M1~M8 收口之后，把三份调研（画质 / 速度 / 效率）里**能立刻做**的部分切成四条线并行跑。
切法的唯一依据是**文件所有权不重叠**（四个枢纽文件同一时刻只能有一条线碰）：

| 线               | 独占文件                                                                         | 做了什么                                                                                                                | 验收                                                                     |
| ---------------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| **α 并发与速度** | `core/queue.ts`（枢纽）、`core/task.ts`、`engines/ffmpeg.ts`、`scripts/bench.ts` | `ENGINE_LIMITS` → `ENGINE_CAPACITY`（份数语义）；sharp 容量 2→4；ffmpeg 小文件快车道（1 份）/ 大文件 3 份               | bench 比值：sharp **0.57~0.62**、ffmpeg 小文件 **0.61~0.67**、大文件持平 |
| **β MCP 面**     | `src/mcp/**`                                                                     | 删掉 `quality` 死参数；新增 `list_jobs`（第 7 个工具）；错误码 `code`/`retryable`/`next_steps`；`target_format: "auto"` | `test:mcp-view` 112 → **128**；`test-mcp-server` 48 → **70**             |
| **γ 文档引擎**   | `converters/**`、`shared/formats.ts`（枢纽）                                     | 扫描件 PDF 静默出空文件 → 报错；`pdf → png/jpg` 兄弟名撞名；`bmp`/`ico` 源 8 个出口全不通                               | `test:doc` 58 → **74**；`test:pandoc` 50 → **106**；17 个变异实跑全红    |
| **δ 界面与集成** | `renderer/**`、`ipc/**`、`core/integration.ts`、`core/cli.ts`                    | SendTo 集成（不写注册表，且支持多选）；完成后动作；历史「重跑失败项」；预置上次选择                                     | `test:integration` 97 → **164**                                          |

**共守规矩**（值得沿用）：四条线都**不许 `git commit`**、**不许跑 `falsify*`**（反证会改坏同一份
工作树，并发跑必然互相破坏）——反证由主线**串行**补跑。四条线各自在报告里逐条写
「改坏哪一行 → 哪条断言该红」，主线据此落成脚本再跑。

**并行暴露出来的两类问题**（都不是业务 bug，是**测试**的问题）：

1. **锚点会静默跟丢**。β 加错误码让 `falsify-mcp.mjs` 的一个锚点长了一行；γ 在 pdf 直通车里
   插了两行注释让 `falsify-pdf.mjs` 两个锚点归零。脚本能报「命中 0 次，结论无效」——
   但**那是很容易被读成通过的**。教训：**锚点越短越稳**，锚一行条件而不是整段分支。
2. **两条断言用的是全局资源**：`test-tasks.ts` 数的是**全机** `ffmpeg.exe` 个数，
   `.tmp-test-tasks` 是**共享目录**。四条线并行跑时它们反复假红（一轮里红 2 次）。
   根因是「判据用了全局资源而不是本次转换的私有资源」。**待修**。

**还发现并处理了一件环境残留**：开发机上 `HKCU\Software\Classes\*\shell\Arbiter` 躺着一个
指向 `dist\win-unpacked\Arbiter.exe` 的键（开发期测试留下的）。它让 `falsify:integration`
里三条「邻居键没被误伤」的断言**失去区分力**（`*\shell` 里有别的动词时就不会触发误删）。
清掉之后该支立刻通过。**这三条断言本质上是环境相关的**——脚本里已有注释承认这点，
但「环境相关」在反证里是个隐患：它会静默地变成装饰。

---

## 4. 并行划分

### 4.1 依赖图

```
M1 发布工程 ──────────────────────┐
                                 │
M2 重封装 ───────────────────────┤（互相独立，可并行）
                                 │
M7 引擎下载 / 国际镜像 ───────────┘

M3 引擎按需加载 ──→ M4 MCP Server ──→ M5 Plugin   （严格串行，主线）

M6 GPU：第一步实测可与任何东西并行；第二步必须等 M2 完成（同文件）
M8 系统集成：必须等 M4 完成（要复用 MCP 的参数解析与引擎调用）
```

### 4.2 可行的并行切法

按本仓库的实际约束（枢纽文件的独占性），**最多切四条线**（线 C 已关闭，现在实际是三条，
见下面的 4.2.1）：

| 线       | 内容           | 独占文件                                                                                          | 说明                                       |
| -------- | -------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| **主线** | M3 → M4 → M5   | `src/main/converters/index.ts`、`src/main/engines/registry.ts`、`src/mcp/**`、`.claude-plugin/**` | **必须单线**，M4 依赖 M3，M5 依赖 M4       |
| **线 B** | M2 重封装      | `src/main/engines/ffmpeg.ts`、`src/main/converters/ffmpegRun.ts`、`src/main/core/probe.ts`        | 与主线不冲突                               |
| **线 C** | M1 发布工程    | `README.md`、`LICENSE`、`THIRD_PARTY_LICENSES.md`、`.github/**`、`electron-builder.yml`           | 除 `package.json` 外全部是新文件或独占文件 |
| **线 D** | M7 + M6 第一步 | `resources/engines.manifest.json`；M6 第一步是**只读实测**，放 scratch 目录                       | 只读侦察可随时跑                           |

**派出去的 agent 必须在提示里写死禁改清单**（见 4.3）。本仓库有过一次教训：worktree 里的 agent
回来后，分支停在原 commit、文件根本没提交——**agent 回来后要在主仓库复跑一遍它的测试再采信**。

### 4.2.1 当前线况（2026-09-13）

**线 C 已合入仓库，那一行关闭。** 21 个准备件已从 `D:\change\` 搬进 `D:\project\message`，
并跑通验收线：`npm run build:win` 产出 **140.1 MB**（上限是「显著小于 300 MB」；
若三条瘦包排除规则失效，会是 2.4 GB 左右）。实测确认包内**不含** libreoffice / calibre / pandoc，
但**含** `7zip-full/7z.exe` + `7z.dll`（RAR 支持承重，见约束 11）。

搬运时对三个已存在的文件是**逐段合并**，不是覆盖——它们在搬运前都已被另一个写入者改过。
过程中查出两件事，都记进了文件本身：

- **另一个写入者删掉了 `publish` 块，但理由写错了**（「这个项目不做打包分发」——那条定位
  已作废）。删对了，理由不对：真正的风险是 electron-builder 与 `softprops/action-gh-release`
  抢同一个 tag。现在防在 `build:win` 的 `--publish never` 上。
  **2026-09-15 更正（审计 O2）**：上面这段原先还写着「`repository` 字段会让 electron-builder
  反推出 GitHub 发布源，于是 `app-update.yml` / `latest.yml` 照样生成」——生成是真的，
  但那句话把两件事说成了一件：`--publish never` 只管「**这次构建推不推上去**」，
  管不到「**生不生成更新清单**」，后者要 `electron-builder.yml` 里的 `publish: null`
  （机制与受控 A/B 写在那个文件末尾）。两者的产物同一个判据、拆不开：加了 `publish: null`
  之后 `latest.yml` 与 `resources/app-update.yml` **一起消失**。连带
  `.github/workflows/release.yml` 的 `files:` 里去掉了 `dist/latest.yml`——
  留着它，发版时 action 只会报一句 unmatched pattern（`fail_on_unmatched_files`
  默认 false，不报错，静默少列一个文件）。
- **图标已经换过了**（`build/icon.*` 不再是脚手架的 35,949 字节，且有 `scripts/make-icon.mjs`
  负责派生），所以 `D:\change\00-搬运说明.md` §2「需要你亲自处理」里的图标一条已完成。

所以**当前实际能开的是三条线**：

| 线       | 内容                    | 独占文件                                                                                          | 状态                                                                       |
| -------- | ----------------------- | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| **主线** | M3 → M4 → M5            | `src/main/converters/index.ts`、`src/main/engines/registry.ts`、`src/mcp/**`、`.claude-plugin/**` | **可以开了**——线 C 已落盘，`package.json` 归主线独占                       |
| **线 B** | M2 智能重封装           | `src/main/engines/ffmpeg.ts`、`src/main/converters/ffmpegRun.ts`、`src/main/core/probe.ts`        | **P3 已实现，验收待跑**（详见 §M2 末尾的「落地状态与交接」）               |
| **线 D** | M7 下载链路 + M6 第一步 | `resources/engines.manifest.json`；M6 第一步只读实测，放 scratch 目录                             | manifest 已入库且 **sha256 三条全部实测填好**；M7 的消费代码仍未实现（P4） |

⚠️ **开线之前 `git status` 看一眼。** 搬运当天 `package.json` / `electron-builder.yml` /
`.gitignore` 在几分钟内被连续改过——**另一个写入者仍在动仓库**。别在两个会话里同时改
`package.json`：这个仓库的分歧是**静默的**（两边各自 typecheck 都过）。

### 4.2.2 可派发的工作包

派 agent 时按这个粒度切，并把「禁改」那一列**原样写进提示词**：

| 工作包                    | 线      | 允许改                                                                     | **禁改**                                                          | 验收                                                           |
| ------------------------- | ------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------- | -------------------------------------------------------------- |
| **P1** 剥离 electron 依赖 | 主线 M3 | `src/main/engines/registry.ts`、`src/main/converters/index.ts`             | `src/shared/formats.ts`、`package.json`、`src/main/core/queue.ts` | `npm run test:tasks` + 新增「不 import electron 也能转换」断言 |
| **P2** MCP 骨架           | 主线 M4 | `src/mcp/**`                                                               | 同上                                                              | stdout 协议纯净性断言（CI 绿）                                 |
| **P3** remux              | 线 B M2 | `engines/ffmpeg.ts`、`converters/ffmpegRun.ts`、`core/probe.ts`            | `formats.ts`、`core/queue.ts`、`package.json`                     | `npm run test:tasks` + `npm run falsify:tasks`                 |
| **P4** 下载链路接通       | 线 D M7 | `resources/engines.manifest.json`、`core/downlink.ts` 的消费侧             | `formats.ts`、`package.json`                                      | `npm run test:downlink`                                        |
| **P5** GPU 第一步实测     | 线 D M6 | **只在 scratch 目录**（如 `D:\project\.recon-lab\gpu\`），**禁止写主仓库** | 整个仓库                                                          | 人工看结论，没有断言                                           |

- **P1 与 P3 的文件不重叠，可以同时开**；**P1 与 P2 是同一条线，必须串行**。
- **P5 是唯一可以无限制并行的**——它只读、只写 scratch 目录，几秒钟出结论，而且结论决定 M6 做不做。

**还有一条不能派出去的活**：修 `docs/FORMATS.md` 算出来的那 **6 条 pandoc 缺口**
（`md` / `markdown` / `txt` / `html` / `htm` → `docx`，以及 `rst` → `docx`：
这些转换会用到不在瘦包里的 pandoc，但 `requiresDownload()` 不认它，界面上**一点提示都没有**）。
它要改 `src/shared/formats.ts`——**枢纽文件**，只能归主线，而且必须和 P4 一起设计：
判据补上了但下载链路没接通，用户看到的只是从「静默失败」变成「提示下载然后失败」。

> 这 6 条是 `scripts/gen-formats-doc.mjs` **自己算出来的**，不是人眼找的。

**⚠️ 2026-09-13 核实：实际是 10 条，不是 6 条。** 生成器只认 `engineFor()` 返回的 engine key，
而 rst 的另外四个出口（`rst → html/md/txt/pdf`）落的是 `document`，**真正的 pandoc 依赖藏在
`document.ts` 的 `rstToHtmlFragment()` 内部**（`document.ts:121` 自己写着「这给 rst 的四个出口
引入了对 pandoc.exe 的**硬依赖**」）。`gen-formats-doc.mjs:128-131` 把这件事写进了 FORMATS.md
的散文里，但**散文不是断言，也不在派活的验收清单里**——按 6 条派活、按 6 条验收会漏掉那 4 条。
这是约束 11 那句「套娃格式要改两处，只改一处等于没改」的同构版。

三条**已核实**的落地事实（不是推测，派活时可直接采信）：

- **`resources/engines.manifest.json` 里 pandoc 那一条是齐的**：`key: pandoc`、
  `sha256: 76fae066…`（与约束 14 的 wheel 哈希一致）、两条 `verified: true` 的镜像（cn / intl 各一）、
  `extract.method: zip-entry`、`covers: [md, markdown, txt, rst, html, htm]`、`optional: true`。
  所以**判据补上之后下载链路是可直接跑的**，不是指向一个空实现。
- **`covers` 正是那份该被钉住的清单**：它和 `requiresDownload()` 要认的源格式集合是同一个。
  但 `formats.ts` 是 shared 层、按设计零 fs 依赖，**不能去读 manifest**——判据只能在 `formats.ts`
  里手写，**再用一条断言把两边钉在一起**（`test-core.ts` 是 Node 脚本，读得到那个 JSON）。
  照 §8 第 1 条，这条断言必须做反证：摘掉 rst 那一支，确认那 4 条翻红。
- **跳过判据是第二处消费**：`core/task.ts:125` 的 `skipTasksNeedingDownload` 走的就是
  `requiresDownload()`（`:630`）。判据漏 pandoc，等于那个设置项对这 10 条**完全无效**，
  而设置页的开关照样能勾——这就是 §5.1 第 11 条。

### 4.3 枢纽文件与禁改清单

**四个枢纽文件，任何情况下都只能单线独占**（它们被 main、renderer、测试和所有引擎适配器依赖，
两线同时改必然出分歧，而且分歧是**静默的**——两边各自 typecheck 都过）：

1. `src/shared/formats.ts` — 整个应用的中枢，路由表 + 能力矩阵
2. `src/main/converters/index.ts` — 路由分发（**本计划里归主线 M3**）
3. `src/main/core/queue.ts` — 并发调度（**本计划里归 M6 第二步**）
4. `package.json` — 依赖与脚本（改名、MCP 依赖都碰它）

**`package.json` 的处理纪律**：改名、加 MCP 依赖、加脚本这三件事由**主线统一做**，
其余线**不许碰**。谁需要新依赖就先记在计划里，合并时由主线一次性加。

**其他易冲突文件**（不是枢纽，但会被多条线碰）：

- `scripts/test-tasks.ts`（M2 加 remux 断言；M6 加 GPU 断言）→ **串行**，M6 排在 M2 之后
- `scripts/falsify-tasks.mjs`（M2、M6 都可能加变异）→ 同上
- `docs/NOTES.md`（每个里程碑都会加实测结论）→ **合并时统一改**，别并行改

### 4.4 合并纪律

1. 每条线独立分支；合回主线前，**在主仓库复跑它对应的全套测试**。
2. 合回后跑一次 `npm run falsify`（四套聚合）——重构会让变异锚点静默失效。
3. **改了 `core/task.ts` / `core/queue.ts` 的，单独跑 `npm run falsify:tasks`**（它刻意不进聚合，
   一轮好几分钟）。
4. `docs/NOTES.md` 的更新放在合并时统一做，避免四条线各改一版。

---

## 5. 可能出的问题

按「会不会静默」排序——**静默的比会炸的严重得多**，因为这个项目的所有痛点都在这一类。

### 5.1 会静默出错的（最高优先级）

| #   | 问题                              | 表现                                                                                                                                                                                                                   | 预防                                                               |
| --- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| 1   | **MCP `stdout` 被日志污染**       | 本地跑得好好的，装进 Claude Code 直接断连                                                                                                                                                                              | CI 断言 stdout 只有合法 JSON-RPC                                   |
| 2   | **License 选错**                  | 发出去才发现分发了 GPL 二进制；源码仓库本身不含 GPL 二进制（`.gitignore` 已挡住 `resources/engines/`），**风险点在 GitHub Releases 里的安装包含 ffmpeg/LO/Calibre/pandoc**                                             | 先做 §7 决策 1                                                     |
| 3   | **NVENC 静默降质**                | 默认切了 NVENC，画质下降但没人发现                                                                                                                                                                                     | 默认路径不变，NVENC 必须是显式选择                                 |
| 4   | **remux 判定恒真**                | 不兼容组合产出坏文件或报错                                                                                                                                                                                             | 「不兼容自动回退」有断言 + 反证（两侧都变异）                      |
| 5   | **跨进程输出名冲突**              | ⚠️ **本计划新发现**：约束 9 的 `claimed` 集合是**进程内**的。MCP server 和 GUI **同时跑**时，两个进程各自解析输出名，完全可能撞到同一个文件，后完成的静默覆盖先完成的——而约束 9 修的就是这个洞，只是它只在单进程内成立 | 跨进程需要文件锁（或 rename 前的 `wx` 独占创建）                   |
| 6   | **`electron` 依赖泄漏进 MCP**     | `engines/registry.ts:3` 静态 `import { app } from 'electron'`，MCP 版一 import 就炸；且**测试全走 stub，看不出来**（这正是约束 12 里 `@napi-rs/canvas` 那个坑的同构版本）                                              | 注入 `isPackaged`/`resourcesPath`，并把「不加载 electron」落成断言 |
| 7   | **动态 import 与打包的交互**      | `externalizeDepsPlugin` 对 `import()` 的处理、`out/` 结构变化——只在 `npm run dev`/打包时现形                                                                                                                           | M3 单独实测一次，别假设                                            |
| 8   | **CI 空转**                       | 流水线写着绿，其实测试因为路径/依赖问题一条都没跑                                                                                                                                                                      | 在 CI 里临时改坏一条断言，确认它会红                               |
| 9   | **反证锚点静默失效**              | 重构后变异命中 0 次，脚本报「结论无效」而不是通过（本仓库已踩过）                                                                                                                                                      | 改了被覆盖的代码就重跑 `falsify`，且打印命中次数                   |
| 10  | **M6 影响 `queue.ts` 的并发语义** | NVENC session 上限与 `ENGINE_LIMITS` 冲突，超限直接报错                                                                                                                                                                | 第二步必须与 `queue.ts` 一起设计，单线做                           |

| 11 | **pandoc 缺口让「引擎未备时跳过」失效** | ⚠️ **2026-09-13 核实**：`requiresDownload()`（`formats.ts:358`）只认 libreoffice / calibre，于是 pandoc 那 **10 条**转换（5 条 `→ docx` + rst 的**五个**出口）既不给下载提示，**也不进 `task.ts:125` 的跳过分支**——用户在设置里勾了「引擎未备时跳过」，这些任务照样入队、然后在运行时失败。而 `docs/FORMATS.md` 的缺口清单只数出 6 条（生成器只认 engine key，rst 的另外四条落的是 `document`） | 见 §4.2.2；**判据与验收都按 10 条**，不是 6 条 |

### 5.2 会当场炸的（好排查）

- 打包后引擎路径找不到（`app.isPackaged` 分支）。
- 首次运行下载的镜像 URL 404（**每一个都要实测**，本项目已有 `Win_x86-64` 这类教训）。
- Linux runner 上 `test:pdf` 没 xvfb 起不来。
- 跨平台断言：`test:core` / `test:doc` 里有依赖 **Windows 路径语义**的断言，
  在 Linux runner 上可能失败。⚠️ **本会话没验**（本机是 Windows），CI 第一次跑之前先验一遍。
- `xlsx@0.18.5` 的两个 CVE（原型污染 + ReDoS）会在公开仓库上触发 Dependabot 报警。

### 5.3 需要决策才知道怎么做的问题

**已全部答完**，见 §7 决策定稿。开工不再有前置疑问。

### 5.4 已否决的方向（别重新考虑）

- **cgo / API 级改造**：那是给 **Go 项目**的建议（`ffmpeg-go` 的反射开销、42%/52fps/67% 那组数字）。
  本项目是 Node/Electron，这些数字不适用。且约束 14 已用同类论证（`pandoc-wasm` 阻塞事件循环、
  10 ms 定时器触发 0 次）否掉了 in-process 引擎；约束 3 的进程树取消在 in-process 下**没有对应物**。
- **AI 超分 / 去噪 / BMF**：BMF 是 C++ 框架、Node 无绑定。**唯一的例外是图片超分**——ONNX 路线
  已经被实测通（`realesr-general-x4v3` 4.7 MB 动态尺寸 / `real-esrgan-x4plus-128` 65 MB 需分块羽化，
  CPU 1.3 秒/块），可以做成独立的「图片放大」转换路径，但**必须跑在子进程里**（同样会阻塞事件循环）。
- **插件式原生模块（DLL 按需加载）**：这个仓库反复在原生模块上踩坑（约束 1 的 preload、
  约束 12 的 `@napi-rs/canvas`），引入原生插件会把「只在 `npm run dev` 时现形」这类 bug 放大到用户机。
  「插件化」在本项目里的正确形态是 **M3 的动态 import**，不是加载原生模块。

---

## 6. 关键实测结论（实施前必读，别重新发现）

这些是本项目已经用真实素材验证过的，实施时**直接采信**，不要重新试：

- **`docs/NOTES.md` 约束 1~17** —— 全部。
- **本轮新增（只读实测，2026-09-12）**：
  - 随包 ffmpeg 是 `6.1.1-essentials_build-www.gyan.dev`，**带** NVENC/QSV/AMF/D3D11VA。
  - 本机是 RTX 5070 Ti Laptop + Intel 核显，驱动 610.88。
  - `resources/engines/` 下已有解包好的 LibreOffice + Calibre（44590 个文件），**已被 `.gitignore` 挡住**。
  - ~~`README.md`、`electron-builder.yml` 是**脚手架模板原样**；**没有 LICENSE、没有 `.github/`**。~~
    **2026-09-13 更新**：线 C 的产出已全部就绪，且**已提交进仓库**——`8d12fdf chore(release):
搬运开源发布准备件进仓库`（`.github/` 八件、`LICENSE` / `THIRD_PARTY_LICENSES` /
    `CONTRIBUTING` / `SECURITY` / `CHANGELOG`、`docs/ARCHITECTURE.md` / `docs/FORMATS.md`、
    `resources/engines.manifest.json`、`scripts/gen-formats-doc.mjs`）。
    `README.md` 与 `D:\change\` 那份同为 9111 字节；`electron-builder.yml` 已是瘦包版
    （三条 `resources/engines/**` 排除是承重的）。`D:\change\` 作为原始准备件目录保留。
    **仓库里唯一仍未跟踪的是 `docs/PLAN.md` 自己。**
- **引擎下载源**：见 `docs/NOTES.md` 约束 15 的表（哪些通了、哪些没通，别重试）。
- **解包方式**：一律 `msiexec /a`，**绝不用 `7z x`**（约束 16）。

---

## 7. 决策定稿（2026-09-13，全部封口）

上一版这里是「待决策点，**开工前必须回答**」。**现在都答完了**，开工不再有前置疑问：

| #   | 问题                | **决定**                                                                       | 落地状态                                                                               |
| --- | ------------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| 1   | **项目名**          | **Arbiter**，中文显示名「调律者转换器」。`appId = io.github.polaris.arbiter`   | ✅ 已落地                                                                              |
| 2   | **License**         | **MIT**，且 GitHub Release **只发瘦包**（不含 LibreOffice / Calibre / pandoc） | ✅ 已落地                                                                              |
| 3   | **首发平台**        | **仅 Windows**（重型引擎靠 `msiexec /a` 解包，Windows 独有，约束 16）          | ✅ 已落地                                                                              |
| 4   | **MCP v1 范围**     | 四个轻量引擎（ffmpeg / sharp / 7zip / pdfjs）；pandoc 作**可选**引擎按需下载   | 计划已定，M4 实施                                                                      |
| 5   | **文档/PDF 出口**   | v1 不做（依赖 Electron 运行时）                                                | 计划已定                                                                               |
| 6   | **M6 是否值得做**   | **先做第一步实测再定**（几秒钟的事，别先争论）                                 | 未开始                                                                                 |
| 7   | **M8 是否真的要做** | 排最后，等有用户呼声                                                           | ✅ **两半都已落地**（2026-09-13）。「重命名即转换」按 §M8 那个谨慎形态做了：开关默认关 |

**顺带修掉的两处不一致（2026-09-13）**：

1. `electron-builder.yml` 的 `appId` 与 `src/main/index.ts` 的 `setAppUserModelId()` **原本互不相同**
   ——两边都是脚手架残留。两者必须**逐字一致**，否则 Windows 会把应用和它的快捷方式当成两个东西
   （任务栏固定失效、通知归错组、装了新版本看起来像装了个新程序），而且**不报任何错**。
   已统一为 `io.github.polaris.arbiter`。
2. `electron-builder.yml` 的 `files` **缺三条 `resources/engines/**` 排除**，而磁盘上那个目录是
   **2.4 GB**（libreoffice 1.6G + calibre 631M + pandoc 221M）。关键点：electron-builder 打的是
   `files` 规则，**不看 `.gitignore`**——「git status 干净」完全不代表「安装包小」。已补，并附承重注释。

**仍未修（有意留到最后）**：`package.json` 的 `homepage` 还是脚手架值 `https://electron-vite.org`。

<details>
<summary>历史记录：原来的待决策表（已作废，仅备查）</summary>

| #   | 问题                | 选项                                   | 建议                                                                                                                                  |
| --- | ------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **项目名**          | —                                      | 影响 appId、npm 包名、MCP 包名、README 标题。现在叫 `msg-scaffold`（脚手架残留），与 `package.json` 的 `format-converter` 也对不上    |
| 2   | **License**         | MIT + Releases 只发瘦包 / 整包 GPL-3.0 | **建议前者**：源码仓库不含 GPL 二进制（已 gitignore），MIT 站得住；安装包不含重型引擎二进制，分发责任清晰，且正好与 M7 的体积策略一致 |
| 3   | **MCP v1 范围**     | 四个轻量引擎 / 加 pandoc               | 建议先四个，pandoc 作为可选引擎                                                                                                       |
| 4   | **文档/PDF 出口**   | 是否为它起 headless Electron           | 建议 v1 不做                                                                                                                          |
| 5   | **M6 是否值得做**   | 先做第一步实测再定                     | 实测几秒钟，别先争论                                                                                                                  |
| 6   | **M8 是否真的要做** | 做 / 不做                              | 与「npx/安装包」形态有张力，可能要等有用户呼声                                                                                        |

</details>

> 我（Claude）不是律师。第 2 条是基于各项目公开许可的**工程判断**，
> 真要发布前建议对一遍 ffmpeg 的 GPL 合规说明。

---

## 8. 「做到较好」的验收标准

这个项目已经有一套明确的质量文化，本计划的所有产出都要满足：

1. **每个功能都有断言，每条断言都做过反证**（临时改坏被测代码，确认它真的翻红）。
   本仓库已经因此抓到过**四条**装饰性断言。
2. **每个性能数字都是自己量的**，带素材、带口径、带对照——不引用别人的数字。
3. **「不应包含 X」型断言必须带前置条件**（`entries.length > 0`），
   否则在空集合上恒为真，同时告诉你「一切正常」和「什么都没有」。
4. **不用子串去猜产物内容**（PDF 里搜 `/Image` 每一份都会命中 `/ProcSet` 里的 `/ImageB` 前缀）。
5. **静默失败优先于崩溃**被当成 bug——这是本项目与其他工具最大的区别，也是它值得开源的原因。

---

---

## 9. 待办清单（三份调研的沉淀，2026-09-13）

> 可执行的待办在本节；**同行怎么做的、为什么某些方案被否掉、以及原始出处**在 [`docs/RESEARCH.md`](RESEARCH.md)——那份文件的存在理由是「agent 的报告只活在对话上下文里，会话一结束就没了」，2026-09-13 靠人想起来问才补的，别再弄丢第二次。

来源是三份各自做过本机实测或联网核实的调研：**画质/功能借鉴**、**速度与并行**、**效率与 AI 集成**。
每一条都过了一次筛：**能在本项目的约束下做、且收益可计数**。没进这张表的在每份报告末尾的
「明确不推荐做」里，那张表同样是结论，别重新考虑。

分层依据是 **前置依赖 > 收益 ÷ 成本**，不是收益大小——有几条收益最高的反而卡在最下面。

### 9.0 前置（不解决这些，下面一大半做不了）

| 编号                                                    | 事项                                     | 说明                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| ~~**P-1**~~ ✅ **已完成**（`ea75a9a`）                  | **任务参数通道**                         | `Task` 现在只有 `inputPath / fromExt / toExt`，`ConvertContext` 只有 `remux`。**§6.2 里标了「需通道」的十几条全部卡在这里**。要一起解决三件事：`Task.options`、输出名不再撞（`clip.mkv → clip.mp4` 加了「裁 10 秒」之后两条任务同名）、卡片与历史要能显示「这条用了什么参数」否则两条看起来一模一样。⚠️ 动 `core/task.ts` 与 `core/queue.ts` 两个枢纽文件，必须单线做。**已落地**：`TaskOptions.trim` + `Task.options` + `HistoryEntry.options`、`ConvertContext.options`、IPC `tasks:setOptions`、卡片/历史的摘要行、`requeue()` 抽出来给 `setTarget` 与 `setOptions` 共用。⚠️ **输出名那条没做**（仍走既有的 `(1)` 冲突避让）——「同一源带不同参数」目前会得到 `a.mp4` 与 `a (1).mp4`，够用但不是最优，记在这里免得被当成漏做 |
| ~~**P-2**~~ ✅ **已完成**（`482d203` + `6c7bc87`）      | **两条 flaky 断言**                      | `test-tasks.ts` 的「2 秒内无 ffmpeg.exe 残留」与「取消后无孤儿」数的是**全机**进程；`.tmp-test-tasks` 是**共享目录**。根因同一类：**判据用了全局资源而不是本次转换的私有资源**。修法：用 PowerShell CIM 拿命令行、按本次临时目录过滤。⚠️ 不修的话，以后任何并行验证都会踩到假红（本次四线并行时一轮里红 2 次）                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **P-3**                                                 | **MSI 解包分支的端到端实测**             | pandoc 那条（`7z e` 抽单文件）已在打包形态实测通过。`msiexec /a` 那条**没在「服务正常」的机器上跑过**——本机 `msiserver` 是 STOPPED（约束 26）。要么换台机器，要么先把服务修好                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ~~**P-4**~~ ✅ **已完成**（`ea75a9a`，即 §9.2 的 P0-1） | 参数通道的第一个消费者应该是最简单的那个 | 建议就是 §6.2 的 **视频无损裁剪**：它只需要两个数字（起点、时长），能把通道的每一环（契约、校验、输出名、卡片、历史）都走一遍，又不像滤镜组那样一次要七八个参数                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

### 9.1 不需要参数通道的（成本低、收益可计数）

| 编号                                                                           | 事项                                            | 可计数收益                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------ | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ~~**E-1**~~ ✅ **已完成**（`adb145f`）⚠️ **`--stdout` 那半边没做**（见本节末） | **`arbiter` CLI（`--json` / `--stdout`）**      | 打开**所有非 MCP 的调用方**（Cursor / Aider / Codex / 任何会跑 bash 的 agent）。更关键的是**解锁 Claude Code 的 hook**——hooks 只能跑命令、不能调 MCP 工具，有了它一个 `PreToolUse(Read)` hook 就能把 `Read(报告.docx)` 改写成 `Read(临时.md)`，「我有个 docx 想看看写了什么」变成**一次工具调用**。⚠️ hook 默认超时 60 秒，所以 hook 里只能做**已就绪引擎的快转**，且必须**失败即放行**                                                                                                                                                           |
| ~~**E-2**~~ ✅ **已完成**（`8916a66`）                                         | **`read_document` MCP 工具**                    | 读一个 docx 从 `inspect_file` → `convert_file` → 宿主 Read（**3 次调用**）降到 **1 次**。docx/xlsx/pdf 都靠已有依赖（mammoth / SheetJS / pdfjs），**epub 用随包 7z 解包 + 剥 HTML，省掉 213 MiB 的 Calibre 下载**。⚠️ 必须带 `max_chars` + 截断元数据（一份 300 页 PDF 能一次塞爆上下文），⚠️ 产物落临时目录不落用户输出目录，⚠️ 重型路径（要 LibreOffice 的）一律先拒。**已落地**，但 **epub 那条没做**——实现里 epub/mobi/azw3 与 office 族一样是「先拒并说清代价」，所以那 213 MiB 的 Calibre 下载**没有省掉**；要省得另做「7z 解包 + 剥 HTML」 |
| ~~**E-3**~~ ✅ **已完成**（`1c4b84b`）                                         | `inspect_file` 补 `cost` / `lossy` / `estimate` | 让 agent 的「先告诉用户体积」从**查技能里手写的表**变成**读返回值**。那张手写的表已经在漂（技能写 375 MB，清单是 357.5 MiB，单位口径都不一样）。⚠️ 体积必须**从清单读**不能手抄；`lossy` 复用已有的 `remuxEligible()` 不另写；⚠️ `estimate` 给区间并标 `confidence`，**别把预估做成承诺**                                                                                                                                                                                                                                                         |
| ~~**E-4**~~ ✅ **已完成**（`02dbd85`）                                         | 文件夹递归（异步、可取消、有上限）              | 整目录工作流从「手动分批」到一次配置。⚠️ **现阶段的「不递归」是刻意的**（递归扫五万文件会卡死主进程，而主进程是唯一真相源），别推翻那个判断——递归要走**另一条路**：分批 yield、可取消、条数上限，且**先给「将加入 N 个文件」的确认**                                                                                                                                                                                                                                                                                                              |
| ~~**E-5**~~ ✅ **已完成**（`f74fa5e`）                                         | `dry_run` / `plan_convert`                      | 动手前一次给出「写到哪、下多少、有没有损、多久」。⚠️ **绝对不能写 `claimed`**（`reserveOutput` 会登记占位，dry run 走了那条路会让真实任务被迫改名成 `(1)`）；⚠️ 预览与执行**必须共用校验函数**，否则「预览说能转、跑起来报不支持」                                                                                                                                                                                                                                                                                                                |
| ~~**E-6**~~ ✅ **已完成**（`5cbc556`）                                         | 产物自检 `verification`                         | agent 从「退出码 0」升级到「时长/音轨/分辨率对得上源」。复用 `inspect_file` 的侦察链路，别新写探测。⚠️ 判据要宽（`ts → mp4` 会重新分装、gif 时长会变、图片没有时长）；⚠️ 只报**事实**（「产物没有音轨」）不做**评分**（评分属于画质那一摊，超出敢负责的范围）                                                                                                                                                                                                                                                                                     |
| ~~**E-7**~~ ✅ **已完成**（2026-09-16）                                        | 全局快捷键（`Enter` / `Esc` / `Ctrl+O`）        | 高频用户全程不碰鼠标。**只做快捷键那一半，不做检索面板**——UI 只有中文，面板检索要处理拼音，成本被低估的典型。 **已落地**：判据零 DOM（`src/renderer/src/lib/shortcuts.ts`），绑定挂在工作台组件里 （它在 `App.tsx` 里用 `hidden` 保活，切页也在挂载状态）。 ⚠️ **「输入法组字中一律不接管」是专门为中文输入写的一条判据**——拼音选词的那一下回车 不该启动队列，而那时焦点往往在画布上，后面每条判据都会放行它。 键位表与判据同处一文件，漂了有断言会红。见 `docs/NOTES.md` 约束 36                                                                     |
| ~~**E-8**~~ ✅ **已完成**（`1c4b84b`）                                         | MCP 工具数量上限断言                            | 现在是 7 个,生态共识是 1~15 是可用的甜点区。加一条断言把「工具数量的预算」钉住，并把 `schema.ts`「一份定义三个出口」的纪律延伸到「每个新工具必须在描述里写清它替代了几次什么调用」                                                                                                                                                                                                                                                                                                                                                                |
| ~~**E-9**~~ ❌ **已实测，判定不做**（2026-09-16）                              | oxipng 作为 PNG 的自动收尾                      | MIT、Rust 单 exe、**纯无损**（没有画质取舍）。⚠️ 本行**预先写下**的就是那条判据（收益 <5% 而耗时翻倍就不值得默认开）， 实测结果是：**真实照片收益 0.1%、耗时 +40%**；机器上 37 张真实 PNG 平均 4.50%、**中位约 0.1%**， 只有低色数纹理 / 背景图那一类拿到 14~71%。照片是我们 PNG 出口的主战场， 所以为它多养一个引擎（注册表 / 设置项 / UI / MCP schema / 断言 / 反证）不划算 ⇒ **不做**。 顺带量出一件更值钱的事：**我们的 `effort: 7` 扛着 3~4× 的体积，而它此前一条断言都没有**，已补。 全部数据与判据写法见 `docs/NOTES.md` 约束 37               |

> **§9.1 的剩余**：E-7 已完成；E-9 实测之后**判定不做**（理由与数据见该行）。
> E-1 做了 CLI 本体与 hook，**`--stdout` 那半边没做**——它要把产物内容直接吐到 stdout，
> 而 Windows 上 stdout 重定向到文件时的编码、以及「stdout 是数据通道」这条纪律
> 都得单独落断言（与约束 23 第 3 条同构），不是顺手加一个开关。

### 9.2 需要参数通道的（收益最高的一条也在里面）

| 编号                                    | 事项                                     | 关键坑（都是实测出来的）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| --------------------------------------- | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ~~**P0-1**~~ ✅ **已完成**（`ea75a9a`） | ~~视频无损裁剪~~（掐头去尾）             | `-ss` 放 `-i` **前**回退到前一个关键帧、放**后**前进到下一个关键帧、`-avoid_negative_ts make_zero` 会同时改掉 `-t` 的参照点（最反直觉）。**已落地**（无损 + 精确两种模式）。实测纠正了原来的说法：**「时长变短」的根因在头部不在尾部**——去掉 `-avoid_negative_ts make_zero` 时内容逐包相同、但首包 pts 是负的，而 mp4 表达不了，于是容器只报 2.07 s。⚠️ **「关键帧吸附」的显式提示还没做**：文案里说了会对齐，但没有把实际吸附到的时间显示出来（那需要一个关键帧列表探测）。见 `docs/NOTES.md` 约束 31                                                                                                                                                        |
| **P0-2**                                | 视频目标体积 / 目标码率                  | ⚠️ **`-fs` 不是目标体积**（实测目标 300 KB 产出 534 KB **且视频被截断在 2.03 秒**）。走两遍 ABR；短素材（<10 s）偏差大，要给二次修正或显示「估算」而不是承诺                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| **P0-3**                                | 图片缩放到指定尺寸 + 内核可选            | `withoutEnlargement` 默认 `false`——不加它「长边 1920」会把 800px 的图**放大**成 1920。HEIC 那条分支走 raw 像素，resize 要加在 `encoderFor` **之前**，两处都得改                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **P0-4**                                | 图片目标体积（二分搜索质量）             | ⚠️ AVIF 每轮都很贵，先降 effort 搜索、命中后用高 effort 出一遍；PNG 没有质量旋钮，得换调色板量化或引导用户转 WebP；动图建议直接禁用                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **P0-5**                                | 音频响度归一化（EBU R128）               | 两遍；**要读 `normalization_type`**——`dynamic` 意味着它会改动态范围（音质会变），这个字段要在 UI 上说。⚠️ **别用 `dynaudnorm` 冒充降噪**，那是动态压缩                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **P0-6**                                | 画质修复滤镜组（去隔行/降噪/锐化/去块）  | 顺序承重：**去隔行 → 降噪 → 锐化**（反了会把噪点一起锐化出来）。⚠️ 带滤镜**必须让 `remuxEligible()` 失效**——这是最容易漏的一处。`nnedi` 缺权重文件（rc=127），别写进方案                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **P0-7**                                | 元数据保留 / 剥离 / 编辑                 | 换容器的元数据兼容性**不是自动的**，要用「转完读回来验一遍」而不是假设。⚠️ 图片的 GPS 与 orientation 是**同一条链路**，剥 GPS 会让照片躺倒                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| **P0-8**                                | 字幕：封装 / 抽取 / 烧录                 | 烧录必须重编码（与 remux 互斥）；⚠️ **中文 libass 字体回退要先实测**——和 PDF 里那个中文字体坑同源，失败方式是「成功但一片方框」。中文 srt 的编码探测要复用约束 13 那套                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **P0-9**                                | 几何：裁剪 / 旋转 / 自动去黑边           | ⚠️ 旋转元数据与实际旋转是两件事（手机视频的 rotation 在容器 side data 里，`-c copy` 会原样搬运，有的播放器转有的不转）。「自动去黑边」值得单独一个按钮——`cropdetect` 可用，但用户很难自己算                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **P1-10**                               | HDR → SDR 色调映射                       | 实测通过的那串 zscale+tonemap 对**无色彩标签的源直接 rc=127**，必须先补标签。源的色彩信息就在 ffmpeg 打开输入那段 stderr 里，**可以白拿**（约束 5 那条链路已经解析到那里了）                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| **P1-11**                               | 10-bit / 4:4:4 中间格式                  | libx264 支持 `yuv420p10le`（这个假设原先错了）。但要定位成「给二次处理用的中间格式」——8-bit 源转 10-bit **不会增加信息量**，且产物很多老播放器解不了                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **P1-12**                               | 视频防抖（vidstab 两遍）                 | 中间文件 `.trf` **必须放临时目录且并发时名字唯一**（约束 9 那个「并发输出名占位」问题的另一个实例）；`zoom` 会裁掉画面边缘，要暴露给用户                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ~~**P0-10**~~ ✅ **已完成**（2026-09-17）                    | **编码质量与速度档（HandBrake 那一套）** | **已落地**：`TaskOptions.quality = { crf?, preset?, tune? }`，走完整条参数通道（契约 / `setOptions` / 卡片摘要 / 历史 / UI 面板）。**范围**：只对走 libx264 的视频出口开放（`supportsQuality()`：mp4 / mkv / mov / m4v / avi）——webm 走 vp9，它的 CRF 是 0~63 的**另一条尺子**、速度档也不是 `-preset`；gif 走调色板滤镜，根本没有质量旋钮。**三项实测把三件事定了下来**（数据与口径见 `docs/NOTES.md` 约束 41）：① **同一个 CRF 在不同预设下不是同一个画质**——`veryfast` 在同 CRF 下体积最小而 SSIM 最差，所以界面文案**不能**写「越慢越小」；② `preset` 的时间跨度是 5.6~6.6×（`veryfast → veryslow`），而画质从 `fast` 往后基本不再涨；③ **慢预设更吃内存**（1080p 峰值 RSS：veryfast 1544 MiB → veryslow 2525 → placebo 3556），所以 `taskCost()` 多了一个输入——预设倍率，`placebo` 那种大文件只开出 1 路。⚠️ **与输出约束互斥**（`-crf` 与 `-b:v` 打架时 x264 会回到质量模式、把体积目标变成一句空话），与无损裁剪和 `remux=force` 也互斥，三处都是**报错**不是静默二选一。⚠️ **与显卡编码互斥**：`-crf` 与 `-cq` 同号不同质、预设也不是同一个词汇表，所以设了质量档就**退回 CPU 并说出来**。⚠️ **MCP 侧没接**（`convert_file` 的参数面），与 `mode` / `priority` 那两次一样是独立决策。 |
| **P1-15**                               | GIF / 动图的参数化                       | 现在 `fps=12` 与 `scale=480` 是**写死的**。但 GIF 只有 256 色，画质已是下限——真要体积就引导用户转 WebP 动图                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

### 9.2b 加密音乐容器（用户 2026-09-17 追加，已落地）

**已做**：`.ncm` / `.qmc*` / `.mflac` / `.mgg*` / `.kwm` / `.xm` 六类，
走新引擎 `encmusic`（先开壳，再按需要交给 ffmpeg）。**刻意没做**：酷狗 `.kgm`/`.kgma`
——它的逐字节掩码表没能从可达的源里取到（GitHub 直连不通，npm 上那个包是 WASM、
表在二进制数据段里）。**没有登记它们**而不是登记一个必然失败的扩展名。

⚠️ **验证只到「与独立实现一致」这一层**，没有真实样本：随仓库提交的
`scripts/fixtures/encmusic/sample.ncm` 是合成正弦波容器，但它解出来的字节与
**Python 的 `ncmdump` 逐字节相同**——那是唯一有跨实现证据的一条。缺口如实记在
`docs/NOTES.md`（约束 42）。谁拿到真实样本，放进 fixtures 补一条断言即可。

⚠️ **这一类有一个「一键回退」**：`node D:\check\make-clean-copy.mjs --no-encmusic`
能导出一份剥掉它的版本，规则在 `scripts/encmusic-strip.json`，剥完还会**复核整棵树**
里搜不到特征串。理由：同类项目在别处有过下架记录，这条路必须能在几分钟内走完。

### 9.3 需要新引擎（按需下载，走 M7 那套）

| 编号    | 事项                                       | 许可 / 体积 / 关键坑                                                                                                                                                                                                                                                                                                                      |
| ------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **N-1** | **图片超分（两个模型，用户选）**           | **`waifu2x-ncnn-vulkan`：MIT，35 MB 的 zip 自带模型，单 exe** —— 比 onnxruntime 那条路干净得多（不需要原生模块、不需要 asarUnpack 那套）。另一个候选 `Real-ESRGAN-ncnn-vulkan` 的 2 MB zip **不含模型**，还要再找一个源。⚠️ **需要 Vulkan**，老机器/虚拟机/远程桌面会直接失败，判据必须是「真的跑一次」而不是查 `-h`（与 NVENC 那条同构） |
| **N-2** | **PDF 工具箱**（合并/拆分/旋转/加密/压缩） | `qpdf` **Apache-2.0**，28 MB；Ghostscript **AGPL-3.0**（压缩靠它，只能按需下载并登记）。⚠️ 输入 N 个输出 N 个，**`Task` 的单进单出装不下**，得做成独立工具页                                                                                                                                                                              |
| **N-3** | OCR（Tesseract）                           | Apache-2.0；⚠️ **中文扫描件准确率远不如英文**，产品文案不能承诺；⚠️ 「OCR 后的可搜索 PDF」要把文字层叠回原图，**那一步没有现成的干净小工具**——先只做「图 → txt」                                                                                                                                                                          |
| **N-4** | 语音转字幕（whisper.cpp）                  | MIT；模型从 `hf-mirror.com` 取（可达）。⚠️ CPU 上很慢（`base` 对 10 分钟音频要几分钟），要有诚实的时间预估；模型体积与准确率强相关，要设计成按需下载模型而不是只在安装时问一次                                                                                                                                                            |
| **N-5** | JPEG XL                                    | BSD-3-Clause；⚠️ 浏览器/系统支持仍有限，只能定位成「存档格式」                                                                                                                                                                                                                                                                            |

### 9.4 独立工具页（不是「拖进来选目标格式」那个模型）

**P1-13 静音/黑场/场景切换检测**、**P1-14 SSIM/PSNR/VMAF 对比** —— 它们是「先分析、再决策、再执行」的流程，
或者根本不产生产物文件（`Task` 完成时要 `stat()` 产物，模型装不下）。
先只做最窄的一个场景（「去除录屏里的静音」），**这一节最可能被做出来但没人用**。

### 9.5 明确不做的（三份报告的结论汇合，别重新考虑）

换一份「更全的」ffmpeg 构建（对速度无收益，还会破坏「引擎唯一」）、引入 ImageMagick（sharp 都能做）、
**全 GPU 管线**（实测比软件解码 + NVENC 只快 1%，而 GPU 解码本身比软件解码**慢 1.4~2.0×**）、
**分段并行编码**（只有 1.19×，而那 1.19× 正好等于「同时跑 4 个任务」，成本却高得多）、
给 ffmpeg 钉 `-threads`（实测 1.8× 更慢）、in-process / WASM 形态的引擎（约束 14）、
云端转换、常驻托盘 + 全自动监视目录、COM shell 扩展、Tdarr Flow 式步骤编排器、
「智能猜测用途」并自动执行、继续增加 MCP 工具数量、AI 人脸修复/上色/去背景/音轨分离。

---

### 9.6 并入自 `docs/RESEARCH.md` §5 的条目（2026-09-13）

> 这几条原本只活在 `RESEARCH.md` 里，而那个文件**自称不是待办真相源**。不并进来两边就会分家：
> 「可执行的待办」在 PLAN、新提出来的建议在另一份文件里，下一个会话照着 PLAN 干活就永远看不到它们。

| 编号                                                                                           | 事项                                    | 关键约束（来自 RESEARCH §5，都是实测或取证得来的）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ---------------------------------------------------------------------------------------------- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ~~**E-18**~~ ✅ **已完成**（`adb145f`：`plugins/arbiter/docs/automation.md` + `skills/watch`） | **自动看目录——用宿主的原语，别自己做**  | Claude Code 有 `Monitor` / `CronCreate` / `ScheduleWakeup` 三个内置调度原语，**零代码**：一份文档 + 一条斜杠命令即可。⚠️ 要写明「用户关了 Claude Code 就停了」，且**别与 M8 的 `renameWatcher` 互相触发**                                                                                                                                                                                                                                                                                                                                       |
| ~~**R15**~~ ✅ **已完成（CLI 侧）**（2026-09-16）                                              | **配方文件**（HandBrake preset 那一类） | ⚠️ **第一步只做 `target` + `mode`**——那两项今天就能真的生效（`mode` 甚至是 CLI 的唯一来源）；**绝不先摆没接通的字段**，否则就是第二份「看着有、其实被忽略」的配置。⚠️ 配方是**不可信输入**：逐字段宽容 + **把坏字段报出来**。⚠️ **别做成「配方能跑任意命令」**（那是任意代码执行，会把这个项目的信任模型整个搞坏）。**已落地**：`shared/recipe.ts`（零 I/O）+ `arbiter convert --recipe <路径>`。⚠️ **GUI 侧的「预置」下拉没做**——那是渲染层 + IPC + 设置页那一摊，另一次决策；解析器已经在那儿了，谁做那一半都该复用它。见 `docs/NOTES.md` 约束 40 |
| ~~**R16**~~ ✅ **已完成**（2026-09-16）                                                        | **优先级 / 插队**                       | ⚠️ `core/queue.ts` 是枢纽文件，**先只做 MCP 侧**（`JobRegistry` 是 MCP 自己的队列，改它不碰枢纽文件）。**已落地**：`convert_file` / `batch_convert` 的 `priority`（−100 ~ 100，默认 0，整批一个值）。⚠️ **不能抢占**——已经在跑的永远不被打断；⚠️ **准入排在优先级前面**，否则一条放不下的高优先级任务会把队列冻住（约束 25 那条）；⚠️ 并列时保持 FIFO。调度规则抽成了纯函数 `pickNextIndex`，所以测的是规则本身而不是时序。见 `docs/NOTES.md` 约束 39                                                                                               |
| ~~**R20**~~ ✅ **已完成**（2026-09-16）                                                        | **产物缩略图**                          | ⚠️ 生态里**有客户端会静默丢掉 image block**，所以图片只能是补充：**文字事实（尺寸、体积、格式）必须在 text 里**。缩放到 ≤ 512px、质量 70、控制在 200 KB 以内，且默认关。**已落地**：`src/mcp/thumbnail.ts`，开关是 `ARBITER_MCP_THUMBNAILS=1`（默认关；放环境变量而不是设置项，因为它只影响 MCP 面，而 MCP 就是在 `.mcp.json` 里配的）。⚠️ **只在 `convert_file` 上给，`get_job_status` 不给**——轮询那条路上每问一次都要重编一张图。⚠️ 白名单取「sharp 读得开」（`bmp` / `ico` 进不去，约束 28）。见 `docs/NOTES.md` 约束 38                        |

### 9.7 外部分发版审计（2026-09-14）的记账项

外部对 **0.2.0 分发版**（= main tip `1eb4ab4`）的审计报告列了 11 条缺陷 + 4 条分发面问题。
**已修的见下**；这里只记**决定记账、不本轮做**的那些——**没有理由的「不做」下次会被重新提出**。

**本轮已修**：§3.1 空产物判据下沉到共用层（MCP 与 GUI 两侧同源）、
§3.2 五处 `chunk.toString('utf8')` → `setEncoding('utf8')`（pandoc 那条损坏的是**文档正文**）、
§3.3 MCP 的 `JobRegistry` 复用 `ENGINE_CAPACITY`、§3.4 `svg` 剔掉 bmp/ico、
§3.6 三个 CLI runner + chromiumPdf 的看门狗、§3.7 `output_path` 已存在时抛 `output_conflict`、
§3.9 图片取消透传到编码前、§3.10 配置损坏留档 + fsync + **设置页可见**、
§3.11 `finally` 里的 `rm` 加 `.catch`、§4.1 打包排除三个洞、§4.2 README 过期陈述。

**记账（未做）**

| 编号  | 事项                                                        | 为什么现在不做 / 关键约束                                                                                                                                                                            |
| ----- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| §3.5  | **HTML → PDF 静默产出空白或缺图**                           | 安全策略（`hardenSession` 取消所有外联）**是对的**，错的是它没留下任何痕迹。修法是渲染后统计「被拦掉的请求数 + 可见文本长度」，非零就写进任务日志。⚠️ 判据要宽（纯色页也是合法产物）                 |
| §3.8  | **`finalizeOutput` 非原子 + rename 不重试**                 | 删文件重试 3 次而 rename 重试 0 次，方向是反的：Windows 上 Defender / 同步客户端持有刚写入文件的句柄是**常见瞬时故障**。⚠️ 同类：`pdfPages` 的逐页 finalize 在循环内部失败时会清掉已 finalize 的文件 |
| §3.11 | **下载层 `runAttempt` 无超时**                              | 镜像「连上但不发数据」时**多镜像回退永远不会触发**——恰好在它存在的意义场景里失效。建议加空闲超时。用户仍可取消                                                                                       |
| §3.11 | **`pendingStdout` 无上限增长**（约 2 MB/小时）              | 读码可疑，未构造出真实触发场景                                                                                                                                                                       |
| §3.11 | **`onConflict: 'skip'` 在排队期间才出现的同名文件不被跳过** | 会改名成 `name (1).ext`；源码注释只论证了「并发撞名该改名」，未覆盖这条路径                                                                                                                          |
| §3.3  | **跨进程没堵住**                                            | MCP 进程与 Electron 主进程各有各的队列与账本，所以「GUI 正在跑 LibreOffice 时 MCP 又起一个」仍然可能。真要堵得跨进程协调（锁文件 / 命名互斥体），那是独立决策                                        |
| §3.9  | **sharp 的真正中止**                                        | 要换流式 API（`Pipeline.read()` 逐块 + 自管落盘），收益只体现在「取消一张要编几秒的大图」。**TODO 已写进 `image.ts` 源码**                                                                           |
| —     | **`xlsx/csv → csv` 首个工作表为空时是 1 字节 BOM**          | 审计四个「空产物」场景里**唯一不经 `isEmptyOutput` 的一格**（判据按字节数，而 BOM 是 1 字节）。理由写在那个函数的注释里                                                                              |
| —     | **`libreoffice.ts` 的暂存名只由输出路径推导**               | `<stem>.part.<fromExt>`，复制的输入落在用户输出目录下。限流之后「两条作业共用同一个暂存文件」的后果消掉了，但推导本身仍然脆弱                                                                        |
| —     | **三个 CLI runner 与 chromiumPdf 的超时只有「读源码」守卫** | 真引擎无法在测试里卡住（pandoc 对任何输入都会退出；LO / Calibre 要先装 1.5 GiB / 658 MB），chromiumPdf 只在 Electron 里跑得起来                                                                      |

#### 一条方法学留档（审计自己写的，值得记）

那份报告最重的结论**被它自己的实测推翻过一次**：三个独立分析会话里，A 断言「0 字节产物被报成成功」
（读码，看到的是引擎层的 `writeText`），B 断言「文件类引擎没有假成功路径」（读码，看到的是
`finalizeOutput`）。**两者都只看到了半个系统**——真正的检查在更上一层的 MCP 任务收尾里。

教训：**「这个函数没有做 X」不等于「这个系统没有做 X」。** 断言全局缺失之前，
要么 grep 那句可能的文案，要么真的跑一次。

#### 外部对本机实测的审计（2026-09-14，对 0.3.0 分发版）

另一位审计者按「需要其它人员完成的事项」在本机装了包、逐条实测。
报告在 `D:\check\审计报告-Arbiter-0.3.0（本机实测）.md`。**7 个缺陷，其中 2 个是 P0。**
⚠️ **这一节是唯一记着它们的地方**——别丢。

| 编号   | 优先级 | 缺陷                                                                                                                                        | 位置 / 证据                                                                                                    | 处置（2026-09-14 夜）                                                                                                                                                                                                                                                                           |
| ------ | ------ | ------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **D1** | **P0** | **`msiexec` 的 `TARGETDIR` 引号畸形 → 解包静默挂死。** 手工带标准引号 25.4 s 成功；按我们的写法复刻 >70 s 挂死、零 I/O                      | 引擎安装的解包调用（`core/engineInstall.ts` 的 `msiexec-a` 分支）。**所有需要 MSI 引擎的转换在所有机器上失败** | ✅ **已修**。`TARGETDIR=${staging}`（值里不带内层引号）。受控 A/B 复测：不带引号 23.2 s 成功、带引号 >45 s 挂死；再走一遍 `installEngine` 端到端 **25.5 s**，`soffice.exe` 就位。断言与变异**方向都翻了过来**（原来那条断言把 bug 写成了特性）                                                  |
| **D2** | **P0** | **`out/main/cli.js` 没接进主入口 → `--cli` 在打包产物里不存在。** 测试说明第 4 节承诺的全部 CLI 契约都达不成                                | `out/main/index.js` 无 `--cli` 分派；`out/main/cli.js` 是死代码                                                | ✅ **已修**。新增 `build/arbiter.cmd`（ASCII-only、`extraFiles` 落到 `<安装目录>\arbiter.cmd`），以 `ELECTRON_RUN_AS_NODE=1` 跑 asar 里的 `out/main/cli.js`。已在 `dist/win-unpacked` 实测 `-h` 与一次真转换（`--json` 退出码 0、产物 46314 字节）                                              |
| D3     | P1     | `msiexec` 超时文案指向错误原因（说「Windows Installer 服务没运行」，而本机服务正常）                                                        | 同上那条超时分支                                                                                               | ✅ **已修**。第一句改成「零 I/O 地挂住」，环境原因降到「其次」                                                                                                                                                                                                                                  |
| D4     | P1     | **`[diag] preload capabilities = …` 污染 stdout**（绕过了 `cli.js` 的 `protectStdout()`）→ 即使 D2 修好，`--json` 的 stdout 仍不是合法 JSON | preload 脚本                                                                                                   | ✅ **已修，但实测与原判不符**（记下来）。走 shim 之后 stdout **本来就是干净的**（实测 `--help`：stdout 959 字节纯帮助文本，无 `[diag]`）——那一行在 **GUI 入口**里，`cli.js` 根本不加载它。仍然按注释自己的说法收窄成 `if (!app.isPackaged)`：挡的是**另一条路**（有人重定向 GUI 进程的 stdout） |
| D5     | P2     | **卸载会把 `HKCU\Software\Classes\*\shell` 这个共用键本身删掉**（当前无害——删时它是空的——但那个位置是多家软件共用的）                       | `core/integration.ts` 的逐层清理                                                                               | ✅ **已修，两处**。清理梯子的上界收成**开区间**：`*\shell` 与 `*` 一个都不删。`pruneTargetsFor` + `build/installer.nsh` 里那两行 `DeleteRegKey /ifempty`（**生产的卸载真正跑的是后者**）                                                                                                        |
| D6     | P2     | 引擎安装失败后留 `libreoffice.installing\` 空目录，且无自动修复 / 重试入口                                                                  | `core/engineInstall.ts`                                                                                        | ✅ **已修**。装之前扫掉**所有**引擎的 `.installing` 残骸（连 `.log` 一起），**跳过正在装的那些**。测试 49 条（新增一节 11 条），反证 2 个变异                                                                                                                                                   |
| D7     | 环境   | 历史残留的卸载项会把新安装劫持到 `%TEMP%`                                                                                                   | 仅影响从旧版升级/重装的机器                                                                                    | ⚠️ **刻意不修，只记录**——理由见下                                                                                                                                                                                                                                                               |
| ~~D8~~ | —      | ~~打包形态下 MCP server 与 CLI 都起不来（Node 读不进 asar）~~ **撤回：这条结论是错的，没能复现**                                            | —                                                                                                              | ❌ **撤回（2026-09-14）**。受控 A/B 四种组合全过，打包改回 asar。见下                                                                                                                                                                                                                           |

**D8 是复核 D2 时顺带撞出来的，但它站不住——同日撤回。** 记下来是因为它的危害不在代码
而在**文档**：那条结论当时已经写进 README、`docs/NOTES.md` 约束 21b、`electron-builder.yml` 与本节。

- **当时的观测**：打包形态下 `out/main/{cli,mcp}.js` 报
  `Error: Invalid package config …\resources\app.asar\package.json`
  （`getNearestParentPackageJSON`），推论是「Node 的 package.json 查找走 C++ binding，
  绕开 Electron 的 asar 补丁」→ 处置是 `asar: false`。
- **推翻它的受控 A/B**（同日，同一份 electron-builder 配置重建，同一个二进制，只差布局）：
  ① asar 里的 `cli.js` → `--version` exit 0；② **真做一次转换**（`convert src.png --to jpg`）
  → exit 0、产出 1209 字节合法 JPEG（sharp 的原生模块经 `app.asar.unpacked` 解析）；
  ③ asar 里的 `mcp.js` → exit 0、`已就绪`；④ 插件启动器 → `形态 = packaged`、`已就绪`，
  **连改动之前那份插件代码在 asar 上也是好的**（所以「改之前第 8/12 条是红的」同样没能复现）。
- **最可能的真相**：当时盘上那份 `app.asar` 已被**自己的手工探测覆盖过**，量的是弄脏的现场。
  同一天里还有两次同源的假象都报「路径不对」：Git Bash 把 `/d/project/...` 解释成
  `\d\project\...`；`node -e` 里那层转义把 `\r`、`\a` 吃成回车与响铃。
- **处置**：打包改回 asar（`asarUnpack: resources/**`），`build/arbiter.cmd` 指回
  `resources\app.asar\out\main\cli.js`，插件的 `probe()`/`expectedEntryPath` 两种布局都认。
  `test-plugin-launch.mjs` 的第 3b 条从「asar 里的模块 require 不进来」换成**正向控制**：
  从刚构建的真实产物里跑一次 CLI 入口、断言打印出版本号（**复现不了的断言已删**——
  它红了分不清是环境还是代码，绿了也证明不了什么）。
- **真正与 asar 有关、且实测成立的一条**：**别用 `@electron/asar` 手工 repack 覆盖这个 asar**。
  那样做之后 `sharp` 会 `Could not load the "sharp" module`——electron-builder 的 smartUnpack
  会把 `.node` 落到 `app.asar.unpacked/` 并在索引里打标记，手工包没有。
- ⚠️ **教训**：判据要落在**刚构建出来的产物**上，别落在你探测过的那份上；
  一条只观测到一次、又拒绝复现的结论，**不配写进约束**——先做受控 A/B。

（D8 同样是那一档的，它是复核 D2 时发现的——**修完一条要回去真跑一遍**，别只看断言。）
D5 与那条「反证偶发」是同一个键上的两个面（见约束 23 的注释）——
判据改成「非空行数为 0」只保证**不误删非空键**，剩下的问题是**我们该不该删那个空键本身**；
答案是**不该**：收益为零（空键不占体积、不影响行为），风险不为零（别的软件可能刚建好它）。

> ⚠️ **D7 值得单独记**：它解释了本会话开头那个「图标消失」的根因（
> 冒烟安装把 `InstallLocation` 留在 `%TEMP%`，后续安装被劫持过去，临时目录一清就成死链）。
>
> **为什么不修**：能改的只有 `customInit` 里加一段「判断历史 `InstallLocation` 是不是指向
> 临时目录」的 NSIS 字符串逻辑。而 NSIS 脚本**不能用 LogicLib 之外的惯用法写前缀比较**
> （`StrCmp` 只能整串比、`StrStr` 不在基础集里），写错的后果是**每一次安装都落到错地方**——
> 比它要修的缺陷严重得多。而受影响的人群是「装过那个冒烟包的机器」，实际约等于本机一台。
> 更要紧的是**它在安装时是可见的**：`oneClick: false` + `allowToChangeInstallationDirectory: true`，
> 目录页会把 `%TEMP%` 原样显示出来。
>
> ⇒ 处置写成**一句话的升级提示**（进 `D:\check` 的测试说明），而不是一段没人验过的 NSIS。

## 附：里程碑优先级

如果时间有限，按这个顺序砍：

1. **M1 发布工程** —— 空仓库挂一个好 README，也比满是脚手架残留的仓库强，而且能早点拿反馈。
2. **M2 重封装** —— 一个能被转发的性能数字。
3. **M4 MCP Server**（含 M3）—— 差异化卖点。
4. **M5 Plugin** —— 把安装摩擦降到最低。
5. **M7 引擎下载** —— 陌生人能不能用上。
6. **M6 GPU** —— 先实测再决定。
7. **M8 系统集成** —— 最后。
