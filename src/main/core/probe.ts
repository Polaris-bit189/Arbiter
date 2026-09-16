export interface MediaInfo {
  /** null 表示拿不到时长：图片、流式媒体、或 `Duration: N/A` */
  durationSec: number | null
  hasVideo: boolean
  hasAudio: boolean
  /**
   * ffmpeg 打印的编解码器名，即 `Video: h264 (High) (avc1 / 0x31637661)` 里的 `h264`。
   *
   * 取的是**第一个 token**，不是括号里的 FourCC：同一个编解码器在不同容器里的
   * FourCC 会变（h264 在 mp4 里是 avc1、在 mkv 里是 V_MPEG4/ISO/AVC），
   * 而第一个 token 跨容器稳定，正好是 remux 判据需要的粒度。
   */
  videoCodec: string | null
  audioCodec: string | null
}

/**
 * 从 ffmpeg 的 stderr 里解析流信息。
 *
 * 不装 ffprobe：`ffprobe-static` 的 unpackedSize 是 351 MB（把全平台二进制塞进了一个
 * tarball），而我们要的信息 ffmpeg 自己就会打印——打开输入时那段
 * `Input #0 … Duration: …`。这个输出格式十几年没变过，比引入一个 351 MB 的依赖可靠得多。
 *
 * 喂进来的 stderr 来自**转换进程自己**（见 converters/ffmpegRun.ts），不是专门探测来的。
 * 以前是先用 `ffmpeg -i` 探一次时长、再开转换进程，同一个任务两次进程启动；
 * 实测那次探测约 30ms、而转换本身才 48ms，**光是探测就占了 38% 的墙钟时间**。
 * 现在转换进程本来就会打印这段信息，白拿。
 */
const DURATION_RE = /Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/
const VIDEO_RE = /Stream #\d+:\d+.*?: Video:/
const AUDIO_RE = /Stream #\d+:\d+.*?: Audio:/

/**
 * 编解码器名是流描述里紧跟在 `Video:` / `Audio:` 之后的第一个 token。
 *
 * 字符类写全 `[a-z0-9_]` 而不是 `\w`：ffmpeg 的编解码器名一律小写，
 * 而**下划线是承重的**——`pcm_s16le` / `pcm_u8` 这类名字带下划线，
 * 漏掉的话会解析成 `pcm`，不在任何容器的白名单里，表现为「明明能 remux 却总是重编码」：
 * 不报错，只是白白慢几倍，光看 UI 看不出来。
 *
 * 抓的是**第一条**同类型流，与 `-map 0:v:0` / `-map 0:a:0` 的选择口径一致。
 */
const VIDEO_CODEC_RE = /Stream #\d+:\d+.*?: Video: ([a-z0-9_]+)/
const AUDIO_CODEC_RE = /Stream #\d+:\d+.*?: Audio: ([a-z0-9_]+)/

export function parseProbeOutput(stderr: string): MediaInfo {
  const m = DURATION_RE.exec(stderr)
  let durationSec: number | null = null

  if (m) {
    const total = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])
    if (Number.isFinite(total) && total > 0) durationSec = total
  }

  return {
    durationSec,
    hasVideo: VIDEO_RE.test(stderr),
    hasAudio: AUDIO_RE.test(stderr),
    videoCodec: VIDEO_CODEC_RE.exec(stderr)?.[1] ?? null,
    audioCodec: AUDIO_CODEC_RE.exec(stderr)?.[1] ?? null
  }
}
