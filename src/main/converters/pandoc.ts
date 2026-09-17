import { mkdtemp } from 'fs/promises'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { partPathOf } from '../core/outputName'
import {
  normalizeEncoding,
  pandocCommonArgs,
  readerFor,
  requirePandocExe,
  runPandocCli
} from './pandocRun'
import { ConversionFailed, finalizeOutput, removeQuietly, type ConvertContext } from './common'
// 整目录清理的包装只有一份，在 archive.ts（那里解释了它为什么必须吞掉异常）
import { removeTempDirQuietly } from './archive'

/**
 * pandoc 适配器：跨标记语言的文档转换（`md/txt/html/rst → docx`）。
 *
 * 为什么是原生 exe 而不是 pandoc-wasm：见 docs/NOTES.md 约束 14——WASM 版会把主进程的
 * 事件循环堵死（79 KiB 输入 4189 ms，期间 10 ms 定时器触发 0 次），那样进度和取消
 * 都成了摆设，而这正是本项目「主进程推增量进度」的前提。
 *
 * 为什么不用 LibreOffice 兜这条线：为了 md → docx 装 357 MB 的 LO，还要独占它的
 * profile 锁，代价与收益完全不成比例。pandoc 只做标记语言这一件事，做得很干净。
 *
 * 子进程细节（编码归一、reader 表、`--resource-path`）都在 `pandocRun.ts`——
 * `document.ts` 拿 pandoc 当 RST 解析器时走的是同一套，那份「必有参数」的清单
 * 只应该存在一处。
 */

/**
 * 跑一次 pandoc，产物直接写进 `output`。
 *
 * pandoc 不吐进度（它没有 `-progress` 那套），所以整段转换只有阶段文案。
 * 这也是它和 ffmpeg / 7z 最大的不同：那两个能把百分比拆得很细，它不能——
 * 硬造一个假进度条不如老实显示不确定态。
 */
export async function runPandoc(context: ConvertContext): Promise<void> {
  const { input, output, fromExt, toExt, cancel, onProgress } = context

  if (toExt !== 'docx') {
    throw new ConversionFailed([`pandoc 引擎目前只接了 docx 出口，收到的是 ${toExt}`])
  }

  const reader = readerFor(fromExt)
  if (!reader) {
    throw new ConversionFailed([`pandoc 不认识这种源格式：${fromExt}`])
  }

  // 先确认 exe 在，再动临时目录：缺引擎时不该留下任何痕迹，也不该先推一条进度出去
  requirePandocExe()

  const tempDir = await mkdtemp(join(tmpdir(), 'msg-pandoc-'))
  const tempOut = partPathOf(output)

  try {
    await removeQuietly(tempOut)
    onProgress({ kind: 'indeterminate', stage: '准备文档…' })

    const srcPath = await normalizeEncoding(input, fromExt, tempDir)

    onProgress({ kind: 'indeterminate', stage: '转换中…' })

    await runPandocCli(
      [srcPath, '-f', reader, '-o', tempOut, ...pandocCommonArgs(dirname(input))],
      cancel
    )
  } catch (error) {
    await removeQuietly(tempOut)
    throw error
  } finally {
    // ⚠️ 清理失败不许顶替掉 pandoc 的原话：这里原本是裸的 `await rm(...)`，
    // 临时目录被占（杀软 / 未释放的句柄）时用户看到的是 `EPERM`，
    // 而 pandoc 真正报的那句（比如 `Unknown input format`）就再也拿不到了。
    await removeTempDirQuietly(tempDir)
  }

  await finalizeOutput(tempOut, output)
  onProgress({ kind: 'determinate', percent: 1 })
}
