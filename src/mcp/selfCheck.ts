import { extOf } from '@shared/formats'
import { describeError } from './errors'
import { probeFile } from './inspect'
import { compareConversion, type Verification, type VerifySide } from './verify'

/**
 * E-6 产物自检的**入口**：把源与产物各侦察一遍，交给 `verify.ts` 的判据。
 *
 * 这里只有「侦察」与「兜底」两件事，没有一行判据——判据在 `verify.ts` 里，
 * 那份是纯的（零运行时 import），所以「判据宽不宽」能被逐条钉住。分开也是为了
 * **复用侦察链路**：`probeFile()` 走的还是 `inspect.ts` 里那套按类别分派的探针
 * （ffmpeg / sharp / 7-Zip），`inspect_file` 工具与这里读的是**同一份实现**——
 * 「自检说分辨率 1920x1080、inspect_file 说 1280x720」这种分家在结构上写不出来。
 *
 * 三条必须记住的：
 *
 * 1. **绝不抛。** 自检是**转换成功之后**才跑的加料，任何异常都不该冒到调度器那一层
 *    ——那里收到异常会把 `done` 改成 `failed`，等于「自检把一个好产物判成了失败」，
 *    是本末倒置里最坏的一种（用户拿到的是一个本来好端端的文件）。所以下面那个
 *    catch 是承重的，不是防守性编程。
 * 2. **两条探针并发跑。** 一次自检就是**两个**子进程（源一个、产物一个），串行会让
 *    每个 job 的收尾多花一倍的墙钟。并发那点开销（两个 ffmpeg 各读一个文件头，
 *    实测 30ms 量级）远小于收益。
 * 3. **`note` 说清「为什么没查成」。** 探针失败不是异常路径而是**正常出口**
 *    （文档没有时长、压缩包没有流、文件在转换后被移走了），所以它走 `VerifySide.note`
 *    和 `Verification.notes`，不走错误码——agent 要能分辨「查过了，没问题」与
 *    「根本没查成」，这两件事长得一模一样是最危险的。
 */
export async function selfCheck(sourcePath: string, outputPath: string): Promise<Verification> {
  try {
    const [source, output] = await Promise.all([probeFile(sourcePath), probeFile(outputPath)])
    return compareConversion(source, output)
  } catch (error) {
    // 走到这里说明 `probeFile` / `compareConversion` 里出了它们自己没想到的错
    // （两个函数都刻意写成了 total）。兜底成「没查成」而不是把异常扔上去：
    // 产物已经在那儿了，这一次自检失败与它没有任何关系。
    const reason = `自检自身出错，这一次没查成：${describeError(error)}`
    return compareConversion(blindSide(sourcePath, reason), blindSide(outputPath, reason))
  }
}

/**
 * 一条**什么都没量到**的一侧，用于兜底。
 *
 * `category` 为 null 是承重的：它让「音轨 / 视频流」那两项判成「没查」
 * （见 `verify.ts` 里 `hasStreams()` 的用法），而不是「量过了，没有」。
 * 类别要从路径猜也行，但那是**编**——自检这一层最不该做的就是这个。
 */
function blindSide(path: string, note: string): VerifySide {
  return {
    path,
    ext: extOf(path),
    category: null,
    size_bytes: null,
    probe: null,
    note
  }
}
