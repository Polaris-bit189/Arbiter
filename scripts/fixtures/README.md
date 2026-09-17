# 测试素材

这些文件是 `scripts/test-tasks.ts` 的输入。**全部是第三方或真实世界的样本**——
刻意不用自己生成的文件，因为「自己能造出来的东西，多半也能验自己」，测不出真实的解码器行为。

## HEIC / HEIF

三个样本覆盖了 `runSharp` 里那个 `meta.compression === 'hevc'` 判据的**两个方向**。
这个判据两个方向都承重，任一侧判反都会砸掉真实文件（实测结论见下）：

| 文件                   | compression | 尺寸     | sharp 原生   | libheif WASM                         |
| ---------------------- | ----------- | -------- | ------------ | ------------------------------------ |
| `heic-single.heic`     | `hevc`      | 1440x960 | ✗ `bad seek` | ✓                                    |
| `heic-multiframe.heic` | `hevc`      | 1000x680 | ✗ `bad seek` | ✓                                    |
| `heic-av1.heic`        | `av1`       | 320x200  | ✓            | ✗ `input buffer is not a HEIC image` |

- `heic-single.heic` — 真实 iPhone 拍摄的 HEVC 系 HEIC，单图。就是它推翻了
  「HEIC 交给 ffmpeg 就行」这个最初的假设（ffmpeg-static 连 heif 解复用器都没有）。
- `heic-multiframe.heic` — 同源的多图 HEIC，**5 张图里前 4 张都是 480x320 的缩略图、
  主图 1000x680 排在最后**。libheif 是按文件顺序返回的，所以取 `data[0]` 会静默转出
  一张缩略图：不报错，只是画质莫名其妙地差。这份素材专门用来锁住 `pickPrimary`。
- `heic-av1.heic` — AV1 系 HEIF，由 sharp 的 `heif({ compression: 'av1' })` 产出。
  它证明分流判据不能按扩展名一刀切：同样是 `.heic`，AV1 系走 sharp 原生、
  HEVC 系必须绕 WASM，而 WASM 版 libheif 反而解不了 AV1。

## RAR

7-Zip 的精简版 `7za.exe` 一个 RAR 编解码器都没有，所以这两个样本是 RAR 支持的
唯一凭据——没有它们，RAR 路径就只能靠「跑一下看看」来验证。

- `rar3-comment-plain.rar` — RAR4（`52 61 72 21 1a 07 00`），含 `file1.txt` / `file2.txt`，
  两个都是**空文件**，刚好顺带覆盖「拆出来是 0 字节」这条边。
- `rar5-subdirs.rar` — RAR5，含嵌套目录（`sub/dir1/`、`sub/dir2/`）、
  **含空格的路径**（`sub/with space/long fn.txt`）、**非 ASCII 目录名**，
  以及一个**空目录**（`sub/empty`）——空目录能否在重新打包后存活，只能靠它来验。

来源：这两个文件取自 [`markokr/rarfile`](https://github.com/markokr/rarfile) 的
`test/files/`（MIT），经 `ghfast.top` 代理下载。国内直连 `raw.githubusercontent.com`
不通，jsDelivr 又只代理已进缓存的文件。按原样保留，未做任何改动。

## 加密音乐容器（scripts/fixtures/encmusic/）

**全是合成数据，不含任何版权内容。** 这一行与其余素材不同：它们不是「第三方或真实世界的样本」，
而是**自造的**——因为真实样本就是这一类的敏感点，生态里的同类项目也都不提交（`HRuiCcc/music-geshizhuanhuan`
的 README 明写「测试样本全部为自建合成数据（正弦波），不含任何版权内容」）。

- `sample.ncm` —— 一个 .ncm 容器，里面装的是 0.05 秒 440 Hz 正弦波的 WAV。
  由**固定密钥**的合成写入器产出（不是随机的），所以每次生成都得到同一个文件。
- `sample.expected.wav` —— 它**必须**解出来的那份字节。

⚠️ **这两个文件的价值不在于「它们是我们造的」，而在于「另一个独立实现也解出同一份」。**
实测（2026-09-17）：装 `pycryptodome` + `mutagen` 之后跑

```
python -c "from ncmdump.core import dump; dump('sample.ncm', 'out.bin')"
```

产物与 `sample.expected.wav` **逐字节相同**。这一步**不在 CI 里**（要 Python 依赖），
所以它是一次性取证——「验到了哪一层」的完整说明见 `docs/NOTES.md` 的约束 42。

