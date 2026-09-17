import { randomUUID } from 'crypto'
import { readFile, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { partPathOf } from '../../core/outputName'
import {
  ConversionCanceled,
  ConversionFailed,
  finalizeOutput,
  removeQuietly,
  type ConvertContext
} from '../common'
// 路 2 要交给它。**这是本仓唯一一处「引擎调引擎」**：encmusic 在转码那一步
// 直接复用 ffmpeg 的适配器，而不是自己去拼命令行——参数拼接（裁剪 / 处理链 /
// 目标体积 / 显卡回退）全部只有那一份实现。
import { runFfmpeg } from '../ffmpegRun'
import { UnknownInnerFormat, decryptNcm, decryptKwm, decryptQmc, decryptXm } from './containers'

/**
 * 「加密音乐容器」这个引擎的适配层：**解开容器**，然后按需要交给 ffmpeg。
 *
 * ## 为什么是一个独立的引擎，而不是塞进 ffmpeg 那条路
 *
 * 因为这一步**不是解码**。ffmpeg 拿到 `.ncm` 只会说「这不是我认识的容器」，而
 * 我们做的事是先把外壳剥掉、拿到里面那个真正的 mp3 / flac。剥完之后**下一步走谁
 * 是另一回事**：目标是 mp3 而里面本来就是 mp3，那就直接落盘、一个字节都不用转；
 * 目标是别的格式，才交给 `runFfmpeg`。把这两件事塞进一个引擎里，会让
 * 「ffmpeg 参数怎么拼」与「容器怎么解」互相污染。
 *
 * ## 两条路
 *
 * | 情况 | 做什么 |
 * | --- | --- |
 * | 解出来的扩展名 **就是**目标格式，且没有任务参数 | 直接落盘（不转码，一个字节都不动） |
 * | 其余（要换格式，或带了裁剪 / 处理链 / 目标体积） | 解到临时文件，交给 `runFfmpeg` |
 *
 * ⚠️ **有参数时必须走 ffmpeg**：裁剪、滤镜、目标体积都是**编码参数**，而「直接落盘」
 * 那条路一个字节都不编——静默忽略它们等于「用户填了参数、产物没变、任务报成功」。
 * 判据写在这里而不是让界面去拦，是因为别的入口（MCP、右键菜单）绕得过去。
 *
 * ## ⚠️ 一处已知的取舍：解密是**同步**的
 *
 * XOR 那一层在事件循环上跑（没有拆成分片 yield）。实测量级：64 MB 的输入约 100 ms。
 * 与之对照，本项目拒掉 `pandoc-wasm` 是因为它 79 KiB 就要 4189 ms（约束 14）——
 * 这里差着三个数量级，所以不值得为它引一套分片调度。**但这一条是量出来的、不是默认的**：
 * 谁要是接了 GB 级的容器格式，得回来重新量。
 */
export async function runEncMusic(context: ConvertContext): Promise<void> {
  const { input, output, fromExt, toExt, cancel, onProgress } = context

  onProgress({ kind: 'indeterminate', stage: '解开加密容器…' })

  let raw: Buffer
  try {
    raw = await readFile(input)
  } catch {
    throw new ConversionFailed([`读不了源文件：${input}`])
  }

  let audio: Uint8Array
  let innerExt: string
  try {
    const result = decryptOf(fromExt.toLowerCase(), raw)
    audio = result.audio
    innerExt = result.ext
  } catch (error) {
    if (error instanceof UnknownInnerFormat) {
      throw new ConversionFailed([
        `容器解开了，但里面的东西不是认识的音频格式（头 8 字节：${error.head}）`,
        '常见原因：文件下载不完整、或者这个容器用了我们还没支持的加密方式',
        '把源文件换成一个能正常播放的，或者删掉扩展名之后用别的工具试试'
      ])
    }
    // 解密失败是**用户的文件或我们的算法**哪一边不对，都是一句人话能说清的。
    // 把原始信息带上：`ConversionFailed` 的 logTail 会进卡片，展开就看得到。
    throw new ConversionFailed([
      `解不开这个 ${fromExt} 容器：${error instanceof Error ? error.message : String(error)}`,
      '这一类格式的加密方式随 App 版本变过好几代；这一份可能不在已支持的范围内'
    ])
  }

  if (cancel.canceled) throw new ConversionCanceled()

  // ---- 路 1：解出来就是目标格式，而且没有参数 —— 直接落盘 ----
  //
  // 「有没有参数」问的是 `context.options` 有没有**任何**一项：一条空链、一个没设过的
  // `output` 都已经是 `undefined`（见 `TaskOptions` 的注释），所以这里只判 `undefined`。
  if (innerExt === toExt.toLowerCase() && context.options === undefined) {
    const part = partPathOf(output)
    await writeFile(part, audio)
    if (cancel.canceled) {
      await removeQuietly(part)
      throw new ConversionCanceled()
    }
    await finalizeOutput(part, output)
    onProgress({ kind: 'determinate', percent: 1 })
    return
  }

  // ---- 路 2：交给人 ffmpeg ----
  const temp = join(tmpdir(), `arbiter-encmusic-${process.pid}-${randomUUID()}.${innerExt}`)
  try {
    await writeFile(temp, audio)
    if (cancel.canceled) throw new ConversionCanceled()
    onProgress({ kind: 'indeterminate', stage: '转换中…' })
    await runFfmpeg({ ...context, input: temp, fromExt: innerExt })
  } finally {
    // 临时文件是**我们自己造出来的垃圾**，删不掉不该让一次成功的转换变成失败
    await removeQuietly(temp)
  }
}

/** 按源扩展名分派。认不出的一律抛——路由层保证到不了这里，但真到了要说得出话。 */
function decryptOf(fromExt: string, raw: Uint8Array): { audio: Uint8Array; ext: string } {
  if (fromExt === 'ncm') return decryptNcm(raw)
  if (fromExt === 'kwm') return decryptKwm(raw)
  if (fromExt === 'xm') return decryptXm(raw)
  return decryptQmc(raw, fromExt)
}
