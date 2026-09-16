import { engineFor } from '@shared/formats'
import { ConversionFailed, type ConvertContext } from './common'

// 错误类型与上下文统一从 common 出去，调用方（core/task.ts）只需认识这一个模块
export * from './common'

/**
 * 路由表：由共享的能力矩阵决定走哪个引擎。**每个引擎按需加载**（M3）。
 *
 * 为什么是 `await import()` 而不是上面那组静态 import：
 *
 *   1. **MCP 那条线要跑它，而那个进程里没有 electron。** 七个引擎里有四个链到 electron
 *      （`document` → `engines/chromiumPdf` 的 `BrowserWindow`；`pandoc` / `libreoffice` /
 *      `calibre` → 引擎路径解析），静态 import 会在最外层就把它们拉进依赖图，
 *      于是「只用 ffmpeg 转一次」也做不到。
 *   2. Electron 主进程启动时不必再解析这些模块——sharp 的 `.node`、pdfjs 的 wasm 都在里面。
 *   3. 加一个引擎只改这个文件里的一行，不再牵动整个依赖图。
 *
 * 代价也要说清楚：**模块加载时机的判断不再由 import 语句替我们做**。以前
 * 「A 引擎的模块坏了」会在启动时就炸；现在它只在那条分支被走到时才炸。这是刻意的交换——
 * 换来的是「不用 ffmpeg 的人永远不必为 pdfjs 付费」。
 *
 * ⚠️ `engineFor` 与 `./common` 必须留在静态 import 里：前者是路由判据本身，
 * 后者导出 `ConversionFailed` / `ConvertContext`，是**同步**要用的
 * （`core/task.ts` 直接 import 它们来判错，连 `convert()` 都没调）。
 *
 * ⚠️ **这里只认 `(fromExt, toExt) → 引擎`，别在这里读 `context.options`。**
 * `ConvertContext` 是原样传给引擎的（含 `remux` 与 `options`），路由层一旦开始
 * 解释参数的语义，同一件事就有了两个裁决者：一边是这里「视频才裁剪」，
 * 一边是各处入口自己的校验，两边迟早对不上，而表现是「某个方向裁了但没生效」。
 */
export async function convert(context: ConvertContext): Promise<void> {
  const engine = engineFor(context.fromExt, context.toExt)

  switch (engine) {
    case 'ffmpeg': {
      const { runFfmpeg } = await import('./ffmpegRun')
      return runFfmpeg(context)
    }

    case 'sharp': {
      const { runSharp } = await import('./image')
      return runSharp(context)
    }

    case 'archive': {
      const { runArchive } = await import('./archive')
      return runArchive(context)
    }

    case 'pdf': {
      const { runDocument } = await import('./document')
      return runDocument(context)
    }

    case 'pandoc': {
      const { runPandoc } = await import('./pandoc')
      return runPandoc(context)
    }

    case 'calibre': {
      const { runCalibre } = await import('./calibre')
      return runCalibre(context)
    }

    case 'libreoffice': {
      const { runLibreOffice } = await import('./libreoffice')
      return runLibreOffice(context)
    }

    case null:
      throw new ConversionFailed([`不支持的转换：${context.fromExt} → ${context.toExt}`])

    default: {
      // `ENGINE_KEYS` 里加一个引擎、却忘了在上面接一条时，这里是**编译错误**
      // （`never` 收不下新值）。没有这个 default 的话，同一个遗漏是个静默无操作：
      // convert() 正常返回、任务被标成成功，产物却根本没生成。
      const unchecked: never = engine
      throw new ConversionFailed([`引擎 ${String(unchecked)} 尚未接入转换实现`])
    }
  }
}
