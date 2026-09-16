<div align="center">

# Arbiter

**Convert anything, locally.**

Six file families in one app: video, audio, image, document, ebook, archive.
Nothing is uploaded, and there is an MCP server so an agent can drive it.

[![CI](https://github.com/Polaris-bit189/Arbiter/actions/workflows/ci.yml/badge.svg)](https://github.com/Polaris-bit189/Arbiter/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
![Platform](https://img.shields.io/badge/platform-Windows-blue)
![Status](https://img.shields.io/badge/status-early-orange)

<!-- TODO: 录一段 10 秒 GIF 替换这一行（拖文件 → 转换 → 完成）。README 里最有说服力的就是它。 -->

</div>

---

## Table of contents

- [Why this exists](#why-this-exists)
- [What it converts](#what-it-converts)
- [Install](#install) (including the [command line](#command-line))
- [AI integration](#ai-integration): MCP server & Claude Code plugin
- [How the engines work](#how-the-engines-work)
- [Development](#development)
- [Roadmap](#roadmap)
- [License](#license)

---

## Why this exists

Most converters make you pick one of two bad options: a heavyweight suite that
wants to reorganize your files, or a command-line tool whose flags you have to
look up again every three months.

Arbiter takes whatever you drop on it. A `.mkv` and a `.docx` in the same batch
is fine: it works out what each one can become and routes it to the right
engine. No mode switch, no separate tool per format.

Nothing is uploaded. No account, no queue on someone else's server. Files are
read from disk and written back to disk.

Most of the work in this project goes into failure, because that is the part
other converters go quiet about. One that silently produces a broken image, an
empty PDF or a mojibake text file is worse than one that fails loudly: you don't
find out for days. So every engine is probed before it is used, every output goes
to a temporary file and is renamed only on success, and an error shows the
engine's own message rather than a generic one.

---

## What it converts

<!-- TODO: 实现后补上每类的具体格式数；从 src/shared/formats.ts 核对，别手抄 -->

| Family       | Examples                                        | Engine                          |
| ------------ | ----------------------------------------------- | ------------------------------- |
| **Video**    | `mkv` `mp4` `avi` `mov` `webm` `ts` `m2ts` …    | FFmpeg                          |
| **Audio**    | `mp3` `wav` `flac` `aac` `m4a` `ogg` `opus` …   | FFmpeg                          |
| **Image**    | `png` `jpg` `webp` `avif` `tiff` `heic` `svg` … | sharp / libheif                 |
| **Document** | `pdf` `docx` `md` `html` `rst` `csv` `xlsx` …   | Chromium / pandoc / LibreOffice |
| **Ebook**    | `epub` `mobi` `azw3` `fb2` …                    | Calibre                         |
| **Archive**  | `zip` `7z` `tar` `tgz` `rar` `iso` …            | 7-Zip                           |

Not every pair is possible. The app only offers targets that actually work for
the file you dropped, so you never pick a format and then watch it fail three
seconds later. The full matrix is in [`docs/FORMATS.md`](docs/FORMATS.md).

---

## Install

### Windows

Download the latest installer from [Releases](../../releases).

> The installer is **not code-signed** (a signing certificate costs money and this
> is a side project). Windows SmartScreen will warn you the first time:
> click **More info → Run anyway**. Verify the SHA-256 in the release notes if you
> want to be sure.

The installer is slim: FFmpeg, sharp and 7-Zip are bundled, about 100 MB in
total. LibreOffice, Calibre and pandoc are not, because together they come to
roughly 2.4 GB. The app downloads those from their official sources the first
time you convert something that needs one, with SHA-256 verification and resume
support. You can decline the download; everything else keeps working.

### From source

```bash
git clone https://github.com/Polaris-bit189/Arbiter.git
cd Arbiter
npm install
npm run dev
```

Requires **Node.js 22+**.

### Command line

The installed app can convert without the window:

```
arbiter convert clip.mkv --to mp4
arbiter convert a.txt b.txt --to md --json
arbiter convert *.mkv --recipe remux-only.json
```

It lives next to `Arbiter.exe` in the install directory, as `arbiter.cmd`. Add
that directory to `PATH`, or call it by its full path.

A recipe is a small JSON file holding the options you keep reusing, such as
`{"target": "mp4", "mode": "remux"}`. A `--to` on the command line still wins
over it. Keys that aren't recognized are reported on stderr instead of being
silently ignored, and a recipe that resolves to nothing at all is refused: the
failure this project cares about most is a setting you believe you made and did
not.

`arbiter.cmd` is a shim rather than a copy of the app. It sets
`ELECTRON_RUN_AS_NODE=1` and runs `resources\app.asar\out\main\cli.js` instead of
re-launching `Arbiter.exe`. The app takes a single-instance lock, so invoking the
`.exe` from a terminal while the GUI is open would hand your arguments to the
already-running window and exit immediately. The shell would get nothing back,
not even an error. Going through the shim always starts a fresh headless Node
process, whether or not the GUI is open.

That entry lives inside `app.asar`, which is fine: a plain Node process (what
`ELECTRON_RUN_AS_NODE=1` gives you) loads modules out of an asar archive
normally, native ones included, with sharp resolving through
`app.asar.unpacked`. Measured rather than assumed, against a packed build:
`arbiter convert` runs end to end, and `scripts/test-plugin-launch.mjs` asserts
exactly that.

`stdout` is a data channel, not a log. With `--json` it carries exactly one JSON
object; otherwise it carries output paths, one per line. Diagnostics and progress
go to `stderr`. Exit codes are distinct, so a caller can tell the cases apart
without reading prose:

| code  | meaning                                                            |
| ----- | ------------------------------------------------------------------ |
| `0`   | done                                                               |
| `1`   | the engine ran and failed                                          |
| `2`   | bad usage (missing file, unsupported pair, output path taken)      |
| `3`   | this conversion needs an on-demand engine that isn't installed yet |
| `4`   | unexpected internal error, worth retrying verbatim                 |
| `130` | interrupted (Ctrl-C)                                               |

Run `arbiter --help` for the full option list.

---

## AI integration

The engine layer is decoupled from the UI and already runs headless, which is why
wiring an agent up is a config step rather than a rewrite.

### MCP server

The server ships inside the app, running in a plain Node process with no Electron
(`src/mcp/`). The Claude Code plugin below is the supported way to wire it up. A
standalone npm package is not published yet, so there is no `npx arbiter-mcp` to
point at.

For any other MCP-capable client (Cursor, Windsurf, Cline, or your own agent),
point it at the plugin's launcher, which finds the installed app and starts its
MCP entry:

```
node <repo>/plugins/arbiter/mcp/launch.mjs
```

It exposes eight tools:

| Tool                            | What it does                                                                                                                             |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `convert_file`                  | The main one. Source path, target format, optional mode and queue priority. **Blocking**: it returns when the conversion is done         |
| `inspect_file`                  | Format, codecs, duration, resolution, size, so the agent can decide _before_ acting                                                      |
| `read_document`                 | Reads a document's text in one call (no temp file lands in your output folder; long results are truncated, with an `offset` to continue) |
| `list_supported_formats`        | What can become what, straight from the shared capability matrix                                                                         |
| `batch_convert`                 | Many files, one call                                                                                                                     |
| `list_jobs`                     | Every job at once, with counts. One call instead of N                                                                                    |
| `get_job_status` / `cancel_job` | Progress and cancellation for long conversions                                                                                           |

Errors carry a machine-readable `code`, a `retryable` flag and `next_steps`
alongside the engine's own words, so an agent can branch on them rather than
parsing prose. `convert_file` and `batch_convert` also take a priority, so a
batch can jump the queue; it never preempts anything already running.

Set `ARBITER_MCP_THUMBNAILS=1` and an image conversion also comes back with a
512px JPEG preview. That is off by default, and the text block carries the size
and format regardless, because some clients drop image blocks without saying so.

The server runs on the same orchestration layer as the desktop app, so progress
reporting, cancellation (including killing the engine's whole process tree) and
output-name collision avoidance behave identically in both.

The server only reads and writes inside directories you allow. An MCP tool hands
an agent filesystem access, and that deserves better than an assumption of good
faith.

### Claude Code plugin

```
/plugin marketplace add Polaris-bit189/Arbiter
/plugin install arbiter@arbiter
```

The plugin wires up the MCP server, five skills and a `PreToolUse` hook. One of
the skills teaches the agent when to reach for which tool; `/arbiter:convert`,
`/arbiter:formats` and `/arbiter:watch` are the explicit entry points. The hook
converts a document on the fly when the agent Reads one. `.docx` becomes
Markdown; `.xlsx` becomes CSV, and `.doc` / `.odt` / `.epub` / `.mobi` /
`.azw3` become plain text. The ones that need LibreOffice or Calibre are
skipped rather than triggering a 357 MB download behind your back. One
install, no config files.

The plugin lives in this repository at `plugins/arbiter/`, and the marketplace
command above fetches it from there. It is deliberately not shipped inside the
installer.

---

## How the engines work

Arbiter doesn't reimplement codecs. It orchestrates good ones, and puts real
effort into the seams between them:

- **Anything that can block the main thread runs as a subprocess.** FFmpeg,
  7-Zip, pandoc, LibreOffice and Calibre are all spawned. sharp (a native
  libvips binding) and PDF.js do run in-process, because they yield: a blocked
  main process means no progress bar, no cancel button, and an app that looks
  hung, so an engine that can't yield is an engine that doesn't ship.
- **Cancellation kills the whole process tree.** `soffice.exe` spawns
  `soffice.bin`; killing only the parent leaves an orphan holding a profile lock,
  after which every subsequent document conversion fails silently.
- **Output is written to `<name>.part.<ext>` and renamed on success.** Interrupt a
  conversion and you get no file, rather than a half-written one that looks fine.
- **Temporary files keep their extension.** FFmpeg infers its muxer from the
  output extension, and `clip.mkv.part` fails with `Invalid argument`.
- **Engines are probed, never assumed.** Path resolution falls back through
  bundled, then downloaded, then system-installed, and the About screen reports
  what it actually found, including whether your 7-Zip build supports RAR at all.

Details: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

---

## Why not HandBrake / Format Factory?

Because they're better than Arbiter at video, and worse at everything else.

HandBrake is an excellent video transcoder. It does not convert your `.epub`,
your `.docx` or your `.rar`. FFmpeg on the command line does all of it, if you
remember the flags. Format Factory covers many formats but asks you to trust it
with a lot, and is awkward to automate.

Arbiter sits in the middle: the breadth of FFmpeg with the ergonomics of a
desktop app, plus one thing neither of them has: a programmatic interface an
agent can call.

---

## Development

```bash
npm run dev          # dev server with HMR
npm run typecheck    # node + web + scripts
npm test             # all suites
npm run falsify      # mutation testing (see below)
npm run bench        # performance baseline
npm run lint
npm run format
```

### Testing, and why this project does it unusually

There are twenty test suites, which `npm test` runs, plus a set of
falsification scripts. The suites are ordinary. The falsification step is not:
after writing an assertion, deliberately break the code it tests and confirm the
assertion actually goes red.

That practice has caught four assertions which passed no matter what: an
`Array.prototype.some()` on an empty array, which is vacuously true; a patch
applied to the wrong branch; a test that threw and masked the forty assertions
after it; and a "line count matches" check that held even when the decoder
produced mojibake, because mojibake has just as many newlines.

A green test suite tells you nothing on its own. `npm run falsify` is what makes
it mean something. Contributions are held to this bar.

See [`CONTRIBUTING.md`](CONTRIBUTING.md).

---

## Roadmap

### Shipped

- [x] Smart remuxing. When the source codecs already fit the target container,
      the streams are copied instead of re-encoded: 33.9× faster on a 1080p
      h264+aac sample
- [x] GPU acceleration (NVENC). Opt-in, with CPU fallback. It wins on
      hard-to-encode material and loses on easy material, which is why it is not
      on by default
- [x] Video trimming without re-encoding. Lossless mode copies the stream, and
      the start snaps to the nearest keyframe; the app says so rather than
      silently shifting the cut
- [x] Per-task options: a trim range, a target size or bitrate, and an ordered
      filter chain (deinterlace, denoise, sharpen, rotate, scale, loudness)
- [x] MCP server and Claude Code plugin
- [x] Folder recursion, previews that write nothing, and output verification

### Planned

No dates, and the order below is a guess rather than a promise.

**Documents**

- [ ] PDF toolbox: merge, split, rotate, encrypt, compress
- [ ] Subtitles: mux into a video, extract, or burn in
- [ ] Metadata: keep, strip, or edit

**Video**

- [ ] Crop, rotate, and automatic black-bar removal
- [ ] HDR → SDR tone mapping, and 10-bit / 4:4:4 intermediates for second-pass
      work
- [ ] Quality and speed controls for video encoding, in the shape HandBrake
      uses: a constant-quality value, an encoder preset, and a tune. Today all
      three are fixed (`-crf 23`, `-preset veryfast`); only a size or bitrate
      target is exposed
- [ ] Stabilisation

**On-device AI.** Every engine in this group runs on your machine: nothing is
uploaded, and no API is called. That constraint is also why each of them is
expensive to add, and why they come last.

- [ ] Image upscaling
- [ ] OCR, so a scanned PDF becomes searchable instead of being reported as
      having no text layer
- [ ] Speech to subtitles

**Platform**

- [ ] macOS and Linux builds. The heavy engines are unpacked with
      `msiexec /a`, which is Windows-only

### Not planned

Several of these have been decided against more than once, so they are written
down rather than left to be proposed again: a different FFmpeg build, a full
GPU decode pipeline (measured slower than software decoding), segmented
parallel encoding, pinning `-threads` on FFmpeg (measured 1.8× slower), cloud
conversion, a resident tray watcher, and generative image editing (face
restoration, colorization, background removal, stem separation). The last group
is the one people ask for most often; it is a different product, and saying so
here is cheaper than saying it in an issue.

---

## License

[MIT](LICENSE). Arbiter itself is MIT; the third-party engines it orchestrates
carry their own licenses, including GPL for FFmpeg, pandoc and Calibre. See
[`THIRD_PARTY_LICENSES.md`](THIRD_PARTY_LICENSES.md) before redistributing anything.

Arbiter is not affiliated with FFmpeg, LibreOffice, Calibre, pandoc or 7-Zip.
