import { spawn } from 'child_process'
import { readFile, writeFile } from 'fs/promises'
import { join } from 'path'
import { pandocEngine } from '../engines/pandoc'
import { killTree } from '../core/kill'
import type { CancelToken } from '../core/cancel'
import { decodeTextFile } from './htmlSource'
import { ConversionCanceled, ConversionFailed, EngineWatchdog, tailLines } from './common'

/**
 * pandoc 调用层。
 *
 * 单独成模块是因为**有两个调用方**：`converters/pandoc.ts`（写文件，管 docx 那类二进制
 * 出口）和 `converters/document.ts`（读 stdout，拿 pandoc 当 RST 解析器用）。两边都要
 * 「归一编码 → spawn → 收 stderr → 取消时杀进程树」这套，抄一份必然会漂。
 *
 * 与 `ffmpegRun.ts` 是同一个路数：把子进程细节关在这里，上头只关心「给我输入、还我输出」。
 */

const STDERR_CAP = 64 * 1024
/** stdout 上限：RST 转 HTML 的片段可能有几百 KB，给足；但总得有个闸，防意外的超大输出吃内存 */
const STDOUT_CAP = 64 * 1024 * 1024

/**
 * 源格式 → pandoc 的 reader 名。
 *
 * `.txt` 映射成 markdown 是**必须**的：pandoc 没有 `txt` reader（也没有 `plain`），
 * 直接喂过去只会得到 `Unknown input format txt`。按 markdown 解析纯文本是安全的——
 * 没有标记的文本就是它自己，而带一点 markdown 习惯写法的 txt 反而能拿到更好的排版。
 */
const READER: Record<string, string> = {
  md: 'markdown',
  markdown: 'markdown',
  txt: 'markdown',
  rst: 'rst',
  html: 'html',
  htm: 'html'
}

/**
 * 查 reader 名，查不到返回 null。
 *
 * 用函数而不是导出那张表：表里有几个 key 是「我们这边的约定」（txt → markdown），
 * 调用方必须走判空、不能想当然。返回 `string | null` 能把这件事交给类型系统，
 * 而不是靠每处调用点自觉。
 */
export function readerFor(fromExt: string): string | null {
  return READER[fromExt] ?? null
}

export interface PandocRunResult {
  stdout: string
  stderr: string
}

/**
 * 取 pandoc 可执行文件，取不到就抛一个能照做的错。
 *
 * 不在各调用点各自判空：那样两处就会有两份措辞不同的提示，而这条提示是要用户
 * 去跑脚本的，措辞必须一致。
 */
export function requirePandocExe(): string {
  const exe = pandocEngine()
  if (!exe) {
    throw new ConversionFailed([
      '找不到 pandoc 可执行文件',
      '运行 node scripts/fetch-pandoc.mjs 提取随包内置的 pandoc.exe 后即可使用'
    ])
  }
  return exe
}

/**
 * 把源文件按探测到的编码解码、再以 UTF-8 另存一份，返回真正喂给 pandoc 的路径。
 *
 * pandoc 遇到非 UTF-8 输入**不会报错**：它只在 stderr 打一行
 * `not UTF-8 encoded: falling back to latin1`，然后把 GBK 的中文全变成乱码，
 * 退出码仍是 0（约束 14）。而 Windows 上记事本 / Excel 存出来的文本大量是 GBK，
 * 所以这一步是必需的，不是保险措施。
 *
 * 本来就是 UTF-8 的文件原样返回，不绕这一趟——这样 pandoc 报错时路径也贴着用户的文件。
 */
export async function normalizeEncoding(
  input: string,
  fromExt: string,
  tempDir: string
): Promise<string> {
  const buffer = await readFile(input)
  const text = decodeTextFile(buffer)
  if (buffer.equals(Buffer.from(text, 'utf8'))) return input

  const target = join(tempDir, `source.${fromExt}`)
  await writeFile(target, text, 'utf8')
  return target
}

/**
 * 跑一次 pandoc，返回它的 stdout / stderr。
 *
 * pandoc 的 WARNING 一律走 stderr，**退出码 0 时也会有输出**（比如找不到插图的
 * `Could not fetch resource`），所以 stderr 只在失败时才拿来报错，成功时丢掉。
 *
 * 不设 stdin：所有输入都从命令行给（我们的输入是文件路径，不走管道）。
 *
 * **看门狗**：卡死的 pandoc 会一直占着这个引擎（容量 1）的槽位，之后所有转换一起堵住，
 * 而用户看到的只是「正在转换…」永远转下去。到点杀进程树并报「引擎超时」，
 * 见 `common.ts` 的 `EngineWatchdog`（含 5 分钟这个值的实测出处）。
 */
export function runPandocCli(args: string[], cancel: CancelToken): Promise<PandocRunResult> {
  const exe = requirePandocExe()

  return new Promise<PandocRunResult>((done, fail) => {
    let stdout = ''
    let stderr = ''

    let child: ReturnType<typeof spawn>
    try {
      child = spawn(exe, args, { windowsHide: true })
    } catch {
      fail(new ConversionFailed([`无法启动 pandoc：${exe}`]))
      return
    }

    const watchdog = new EngineWatchdog({ label: 'pandoc' })
    watchdog.arm(child.pid)

    cancel.onCancel(() => {
      void killTree(child.pid)
    })

    // ⚠️ **必须先 setEncoding，不能在 data 回调里 `chunk.toString('utf8')`。**
    //
    // 逐块 `.toString('utf8')` 是**对每个 chunk 独立解码**：一个 UTF-8 多字节序列只要
    // 跨了管道边界（Node 按 64 KiB 读）就被拆成两个 `�`，而这段 stdout
    // **就是文档正文**（`document.ts` 的 `rstToHtmlFragment` 直接把它交给
    // htmlToText / htmlToMarkdown / wrapHtml / PDF）。表现是产物里零星几个字符
    // 静默变成替换符、任务照样报 done——**唯一会静默损坏用户文档正文的缺陷**。
    //
    // `setEncoding('utf8')` 走 Node 的 StringDecoder：它会把跨块的残字节缓存到下一块，
    // 于是 chunk 的类型变成 `string`、`.length` 的语义也随之变成「UTF-16 码元数」
    // （下面几个上限本来就是按字符串算的，语义逐字不变）。
    // 这个写法与 `engines/status.ts` 的版本探测一致——**同一条代码库里两处写法不一致，
    // 就是「本可避免」**。
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')

    child.stdout?.on('data', (chunk: string) => {
      if (stdout.length >= STDOUT_CAP) return
      stdout += chunk
    })

    child.stderr?.on('data', (chunk: string) => {
      if (stderr.length >= STDERR_CAP) return
      stderr += chunk
      if (stderr.length > STDERR_CAP) stderr = stderr.slice(-STDERR_CAP / 2)
    })

    child.on('error', (error) => {
      watchdog.stop()
      fail(new ConversionFailed([`无法启动 pandoc：${error.message}`]))
    })

    child.on('close', (code) => {
      watchdog.stop()
      // 超时判在取消与退出码之前：超时是我们主动杀的树，据此报出来的
      // 「退出码 X」或引擎自己的半截报错都与用户真正遇到的事无关
      if (watchdog.expired) {
        fail(new ConversionFailed(watchdog.reason()))
        return
      }
      if (cancel.canceled) {
        fail(new ConversionCanceled())
        return
      }
      if (code !== 0) {
        const tail = tailLines(stderr)
        fail(
          new ConversionFailed(
            tail.length > 0 ? tail : [`pandoc 退出码 ${code}，且没有输出错误信息`]
          )
        )
        return
      }
      done({ stdout, stderr })
    })
  })
}

/**
 * pandoc 的参数尾巴，两处调用都要带。
 *
 * - `--resource-path <源文件目录>`：pandoc 按 **cwd** 而非源文件目录解析相对路径
 *   （`![](pic.png)`、`.. image:: pic.png` 都算）。少了它，图被**静默丢弃**、
 *   退出码仍是 0——文档转出来了，图没了（约束 14）。
 *   给的是**源文件**目录而不是临时目录：图片在用户那边，不在我们这边。
 * - `--syntax-highlighting none`：带语言标注的代码围栏会触发 skylighting 初始化，
 *   实测 73 ms → 343 ms。（`--no-highlight` 在 3.9 已废弃，写了会打 WARNING）
 */
export function pandocCommonArgs(sourceDir: string): string[] {
  return ['--resource-path', sourceDir, '--syntax-highlighting', 'none']
}
