import { spawn } from 'child_process'
import { ffmpegPath } from './registry'

/**
 * 「这台机器现在能不能用 NVENC」——**实测出来的，不是查出来的**。
 *
 * 三个都不够的判据，按「看起来够用 → 真的够用」排：
 *
 * 1. **看 `ffmpeg -encoders` 里有没有 `h264_nvenc`**。ffmpeg-static 6.1.1-essentials
 *    这份构建**确实带着** `--enable-nvenc`（连 `av1_nvenc` / `*_qsv` / `*_amf` 都有），
 *    所以它在**任何**机器上都是 true——包括没有 NVIDIA 卡的那些。它只能回答
 *    「这份 ffmpeg 编得出来吗」，回答不了「这台机器编得动吗」。
 * 2. **看 `nvidia-smi` / 注册表 / `wmic`**。要么依赖外部程序存在，要么把平台绑死，
 *    而且都答不出**驱动版本是否够新**——老驱动上 nvenc 初始化会直接失败。
 * 3. **真的编一帧**（本模块）。三种失败（没卡 / 没驱动 / 驱动太旧）都会让编码器
 *    打不开，于是**退出码非 0**，一个判据全覆盖。代价是一次约 200ms 的子进程，
 *    所以结果缓存，一个进程只探一次。
 *
 * ⚠️ **分辨率不能太小。** 第一版用 64x64，实测被 NVENC 顶了回来：
 * `Frame Dimension less than the minimum supported value`。**那是编码器尺寸下限的问题，
 * 不是显卡的问题**——把它当成「没有 GPU」会让有卡的机器永远走 CPU，而且不报错。
 * 256x256 实测可过（`color` 源，5 帧，约 200ms）。
 *
 * 反面证据也实测过：把 `-gpu 9` 指到一个不存在的设备上，报
 * `No capable devices found` 并**以 127 退出**。注意是 127 而不是 1——
 * 所以判据只能是「退出码是不是 0」，不能去猜具体是哪个非零值。
 */
export function probeHardwareEncode(): Promise<boolean> {
  return new Promise((done) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(
        ffmpegPath(),
        [
          '-hide_banner',
          '-loglevel',
          'error',
          // 探测也是子进程，一样有抢 stdin 挂死的风险（见 engines/ffmpeg.ts 的说明）
          '-nostdin',
          '-f',
          'lavfi',
          '-i',
          'color=c=black:s=256x256:d=0.1:r=5',
          '-c:v',
          'h264_nvenc',
          '-f',
          'null',
          '-'
        ],
        // stdout 直接丢弃：探测不产出，也不该因为它没被读取而反压住子进程。
        // stderr 也丢——失败原因（没卡 / 驱动旧）对用户没有可操作性，
        // 而这里唯一要的就是那个退出码。
        { windowsHide: true, stdio: ['ignore', 'ignore', 'ignore'] }
      )
    } catch {
      // ffmpeg 根本起不来（比如引擎没下载）。这在 M7 之后是可能的，
      // 而「起不来」与「没有 GPU」对调用方是同一件事：别用硬件编码。
      done(false)
      return
    }

    child.on('error', () => done(false))
    child.on('close', (code) => done(code === 0))
  })
}

/**
 * 缓存的那一份。存的是 **Promise 而不是结果**：两个任务同时入队时，
 * 第二个会复用第一个那次探测，而不是再起一个子进程。
 */
let cached: Promise<boolean> | null = null

export function hardwareEncodeAvailable(): Promise<boolean> {
  return (cached ??= probeHardwareEncode())
}

/**
 * 只给测试用：把缓存清掉，让下一次调用重新真探一遍。
 *
 * 存在的理由是 `scripts/test-tasks.ts` 里那条「没卡时自动回退 CPU」的断言——
 * 它必须能让缓存里的 `true` 失效，才能在一台**有卡**的机器上验证回退那一条路。
 */
export function resetHardwareEncodeProbe(): void {
  cached = null
}

/** 测试用：直接压一个已知的探测结果进去，跳过真起进程 */
export function setHardwareEncodeProbe(value: Promise<boolean>): void {
  cached = value
}
