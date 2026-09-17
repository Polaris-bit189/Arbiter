# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.4] - 2026-09-17

### Added

- **Quality and speed controls for video encoding**, in the shape HandBrake uses:
  a constant-quality value (CRF), an encoder preset, and a tune. They apply to the
  containers that use libx264 (mp4, mkv, mov, m4v, avi); webm uses VP9, whose CRF
  is a different scale and whose speed knob is not `-preset`, and gif has no
  quality knob at all.

  Every default is measured rather than guessed, and one of the measurements
  contradicts the obvious expectation: **at a fixed CRF a slower preset does not
  produce a smaller file.** `veryfast` came out smallest *and* worst by SSIM,
  because the faster presets drop the psychovisual optimisations and code for
  PSNR alone. So the two knobs are not convertible into each other, and the UI
  does not claim otherwise. Moving from `veryfast` to `veryslow` costs 5.6–6.6×
  the time while quality stops improving past `fast`, and the slow presets use up
  to 2.3× the memory — which the concurrency budget now accounts for.

  They are mutually exclusive with a size/bitrate target, with lossless trimming,
  and with hardware encoding (a quality value is not portable between `-crf` and
  `-cq`). Every one of those collisions reports an error instead of silently
  picking a side.

### Fixed

- **The Claude Code plugin could not find an installation that was not in a
  default directory.** The installer lets you pick a directory; when you did, the
  plugin reported that Arbiter was not installed at all, while the app itself was
  fine. It now also reads the uninstall entries in the registry. The first version
  of the tests for this injected registry keys in a different shape than
  production, which made the coverage look real when it was not — an adversarial
  audit caught it, and the coverage was rebuilt.

## [0.3.3] - 2026-09-16

Four additions, none of which change what an existing conversion produces.

### Added

- **Global shortcuts in the workbench**: `Ctrl+O` opens the file picker, `Enter`
  starts the queue, `Esc` cancels whatever is running. `Enter` is ignored while
  an input method is composing, so picking a Pinyin candidate does not start a
  batch.
- **`arbiter convert --recipe <file>`**. A recipe is a small JSON file holding
  the options you keep reusing, such as `{"target": "mp4", "mode": "remux"}`.
  Keys that are not recognized are reported on stderr, and a recipe that
  resolves to nothing at all is refused instead of quietly doing nothing.
- **Queue priority** on `convert_file` and `batch_convert`, as an integer where
  higher runs sooner. It only affects jobs still queued: a conversion that is
  already running is never preempted.
- **`ARBITER_MCP_THUMBNAILS=1`** makes `convert_file` return a 512px JPEG preview
  alongside an image output. Off by default, and the text block always carries
  the size and format regardless.

### Fixed

- `CONTRIBUTING.md` said Node.js 20+, while `engines` and CI both require 22.
- `SECURITY.md` listed an `xlsx` advisory that no longer applies (the project
  vendors 0.20.3, which fixes both CVEs), and marked the MCP server as planned.
- Two test suites could leave their temporary directories in the repo root.
- The release workflow never fetched the bundled 7-Zip, so a tagged build would
  have failed before producing an installer.

## [0.3.2] - 2026-09-14

Mostly a fix release. An external audit of the 0.3.0 package, run on a real
machine, found seven defects; two of them meant **a new user could not use the
app at all**. Every number below was measured, not estimated.

### Added

- `convert_file` takes `dry_run`. With `dry_run: true` it answers "what would
  happen" and changes nothing: no job, no file, and (the part that is easy to get
  wrong) **no output name claimed**, so a preview can never push the real
  conversion onto `report (1).pdf`. It validates through the same function the
  real run uses, so when a combination is not allowed the preview returns the
  _same_ error object (same `code`, same `next_steps`, same text) rather than a
  sentence of its own. It reports the resolved output path, the format actually
  used, the engine, what would need downloading, whether the conversion is lossy,
  and a time estimate with a `confidence` field. Useful before a call that would
  otherwise wait minutes or pull hundreds of megabytes.
  _(A new parameter on an existing tool, not a new tool. The tool-count budget in
  `test-mcp-view.ts` is unchanged.)_

### Fixed

- **`msiexec` was handed a malformed `TARGETDIR`, so every engine install hung
  forever.** The value was wrapped in quotes, and `TARGETDIR="C:\…"` is not the
  shape `msiexec` accepts: it starts, does no I/O, prints nothing, and never
  exits. Controlled A/B on the real LibreOffice MSI, same machine, only those
  quotes differing. Without them: 23.2 s, exit 0, 14 top-level entries. With
  them: still hanging at 45 s, 0 entries. Everything that needs LibreOffice,
  Calibre or pandoc failed on every machine. Verified end to end afterwards:
  25.5 s, `soffice.exe` in place.
  _(Two things kept it alive: the test suite asserted the broken form as
  correct, and the falsification mutation flipped in that same direction, so
  the defect was pinned from both sides. Both were reversed.)_
- **The CLI did not exist in the packaged app.** `out/main/cli.js` was built but
  never wired to an entry point. A thin `arbiter.cmd` is now installed next to
  `Arbiter.exe`; it runs the asar entry point under `ELECTRON_RUN_AS_NODE=1`
  rather than re-launching the app, because the app holds a single-instance lock
  and would otherwise hand its arguments to a running window and exit. See the
  README's _Command line_ section.
- **Uninstalling deleted registry keys shared with other programs.** Cleanup
  walked up to `HKCU\Software\Classes\*\shell` and `…\*` and deleted them when
  they looked empty. Both are shared: `*` holds `OpenWithProgids` and `shellex`,
  and `*\shell` is where every classic shell verb lives. Deleting an empty
  shared key gains nothing and can race with a program that just created it.
  Both the in-app path and the NSIS uninstaller now stop at our own subtree.
- **A failed engine install left its staging directory behind.** The cleanup on
  the failure path is not always enough: on timeout we `taskkill /T /F` first,
  and `msiexec` can hold the directory longer than the 450 ms of retries; and
  if the process is killed outright, the handler never runs at all. Any install
  now sweeps stale `.installing` trees (and their `/*.log` siblings) for every
  engine, **skipping anything currently installing**, since single-flight is
  per engine and a sweep that deleted a concurrent unpack would leave exactly
  the half-built tree this staging scheme exists to prevent. It says what it
  removed on stderr rather than deleting gigabytes quietly.
- The engine-install timeout message blamed the Windows Installer service. On
  the machine that produced it the service was healthy; the cause was our own
  malformed argument. The message now leads with "the process is wedged" and
  puts environment causes second.

### Changed

- The build's exclusion globs listed `.scratch-*/**`, which matches a directory's
  _contents_ and not the directory, and never a plain file. Two `.scratch-*.txt`
  build logs sitting in the repo root went into the shipped asar because of it.
  The file form is now excluded too (`scripts/test-plugin-launch.mjs` reads the
  asar index and fails on any `.tmp-*` / `.scratch-*` entry).
- The preload capability probe (`[diag] preload capabilities = …`) is now
  development-only. It wrote to **stdout**, which is a data channel; in a
  packaged build it was putting a log line into whatever the caller parsed.

## [0.3.1] - 2026-09-14

### Added

- **Folder recursion.** Picking a folder now walks it, in batches, cancellable,
  with an item cap and a default exclusion list. It asks "N files will be added"
  before enqueueing anything. Measured: 2400 files across 601 directories in
  72–82 ms, with a 10 ms timer still firing 7–9 times throughout.
- **Output verification** for MCP clients (opt-in at submit time; off by
  default). It reports facts (resolution, whether an audio track survived,
  duration on both sides) and never a score.

### Fixed

- The CLI test suite could crash part-way through and hide roughly forty of its
  own assertions behind a stack trace instead of reporting failures.

## [0.3.0] - 2026-09-14

Two themes: **the task-options channel grew into a proper pipeline**, and **an
external audit of the 0.2.0 package was worked through**.

### Added

- **Conversion options, per task.** A trim range, an output target (a size in
  bytes _or_ a bitrate), and an ordered filter chain.
- **Output size / bitrate targets.** Video uses two-pass ABR, audio a single
  pass. The output is measured against the requested target rather than
  truncated (`-fs` was tried first and rejected: it truncates the video).
- **Image resize and "compress to at most N bytes"** (binary search over
  quality). "Don't enlarge" is on by default; sharp's own default would blow a
  800 px photo up to 1920.
- **Filter chain:** deinterlace (yadif/bwdif), denoise (hqdn3d, three levels),
  sharpen (unsharp), loudness normalisation (EBU R128, two-pass), rotation, and
  scaling for video. **The order is the execution order.** Deinterlace before
  denoise before sharpen, because reversing it sharpens the interlacing and the
  noise instead.
- **`arbiter` CLI** (`--json`), which opens the tool up to any caller that can
  run a command, and unlocks a Claude Code `PreToolUse` hook that rewrites
  `Read(report.docx)` into a read of a converted temporary Markdown file.
- **`inspect_file` now reports cost, lossiness and a time estimate**, so an
  agent can say "this will download 357 MiB" before doing it.

### Fixed

- **Document corruption on multi-byte output.** Child-process stdout was decoded
  per chunk, so a UTF-8 sequence split across a pipe boundary became `U+FFFD`.
  This silently damaged pandoc's output, which is to say the document text
  itself. It only happened when a read happened to split a write, roughly one
  run in six.
- **The "an empty output is a failure" rule now lives in one place**, so the GUI
  and the MCP server can no longer disagree about the same file.
- **The MCP job scheduler now honours the per-engine capacity table** (LibreOffice
  and Calibre are single-instance; a second process silently hands its arguments
  to the first and produces nothing).
- **`svg` sources no longer advertise `bmp`/`ico` targets.** The bundled ffmpeg
  has no SVG decoder, so those combinations could only fail.
- **Document engines and Chromium rendering now have watchdogs** (5 minutes,
  measured against the slowest real conversion seen: 147.8 s).
- **An explicit `output_path` that already exists is now refused** instead of
  being silently renamed: an agent that asked for `/out/report.pdf` and then
  read it would have read last week's file.
- **Corrupt settings/history files are quarantined** rather than silently
  reset, and the settings screen says so.
- **Packaging:** three development files (`.claude/`, `.nezha/`, `*.tsbuildinfo`)
  and the plugin sources no longer ship inside the app archive.

## [0.2.0] - 2026-09-13

First release.

### Added

- **Windows installer (NSIS)**, slim package (~141 MB): FFmpeg, sharp and 7-Zip
  are bundled; the heavy engines are not.
- **On-demand engine download.** LibreOffice, Calibre and pandoc are fetched the
  first time a conversion needs them, with multi-mirror fallback, `Range`
  resume, SHA-256 pinning, cancellation, and extraction into the app's engine
  directory. A conversion that needs a missing engine downloads it in place and
  then runs; the About screen also has an explicit download button with
  progress.
- **Capability matrix** covering video, audio, image, document, ebook and
  archive, with a documented "every offered target actually works" guarantee
  enforced in CI (`docs/FORMATS.md` is generated from the same source of truth).
- **Smart re-mux.** When the source codecs fit the target container, the file is
  re-muxed with `-c copy` instead of re-encoded. Measured **33.9× faster** on a
  1080p h264+aac sample.
- **Optional hardware encoding (NVENC).** Off by default, because it is a
  trade-off rather than a free speedup: it wins on hard-to-encode material and
  loses on easy material.
- **HEIC/HEIF decoding** via WASM libheif, including correct main-image
  selection (many HEIC files store thumbnails before the primary image).
- **PDF → text/markdown** (PDF.js text extraction) and **PDF → PNG/JPG**
  (per-page rasterisation, no rendering window required).
- **Markdown/RST/text/HTML ↔ DOCX** via a bundled native pandoc.
- **Right-click menu** (per-user `HKCU`, no admin prompt) and a **Send to**
  entry (plain shortcut, no registry writes). Both accept multiple selected
  files; the menu entry hides itself on multi-select, where Windows would only
  pass the first path.
- **Rename to convert.** Rename `a.mkv` to `a.mp4` and the file is converted.
  The original is kept under its original name, so the operation is fully
  reversible. Opt-in, restricted to directories you whitelist.
- **Claude Code plugin and MCP server**: seven tools (`inspect_file`,
  `convert_file`, `batch_convert`, `get_job_status`, `cancel_job`,
  `list_supported_formats`, `list_jobs`), one resource exposing the capability
  matrix, and two slash commands.
- **Post-conversion actions** (copy path / copy file / open containing folder),
  and **re-run from history** including "re-run only the ones that failed".

### Notes

- **Windows only** for now. The heavy-engine extraction path depends on
  `msiexec /a`, which is Windows-specific.
- The UI is currently **Chinese only**.
- The installer is unsigned; SmartScreen will warn on first run.
- Scanned / image-only PDFs are **not** supported: there is no OCR, and the
  conversion reports that explicitly rather than producing an empty file.

[0.2.0]: https://github.com/Polaris-bit189/Arbiter/releases/tag/v0.2.0
[0.3.0]: https://github.com/Polaris-bit189/Arbiter/releases/tag/v0.3.0
[0.3.1]: https://github.com/Polaris-bit189/Arbiter/releases/tag/v0.3.1
[0.3.2]: https://github.com/Polaris-bit189/Arbiter/releases/tag/v0.3.2
[0.3.3]: https://github.com/Polaris-bit189/Arbiter/releases/tag/v0.3.3
[0.3.4]: https://github.com/Polaris-bit189/Arbiter/releases/tag/v0.3.4
