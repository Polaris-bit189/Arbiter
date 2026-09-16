# Contributing to Arbiter

Thanks for considering it. This document is short on ceremony and long on the one
thing that actually matters here: how to make sure your change is real.

---

## Getting set up

```bash
git clone https://github.com/Polaris-bit189/Arbiter.git
cd Arbiter
npm install
npm run dev
```

Requires **Node.js 22+**. Development happens on Windows; other platforms are
welcome but expect rough edges (see the roadmap).

### About `.npmrc`

The repo ships an `.npmrc` pointing at `registry.npmmirror.com`, which is fast in
China and slow elsewhere. If you're outside China, either delete it locally or
override the registry:

```bash
npm config set registry https://registry.npmjs.org/
```

In China, `ffmpeg-static` needs one more thing, because its install script reads
`process.env` rather than npm config:

```bash
FFMPEG_BINARIES_URL=https://cdn.npmmirror.com/binaries/ffmpeg-static npm install
```

---

## The one rule

**Every assertion you write must be falsified before you call it done.**

Temporarily break the code the assertion is supposed to catch, run the suite,
confirm the assertion goes **red**, then revert.

That is not pedantry. This project has caught four assertions that passed
unconditionally:

| The assertion                      | Why it always passed                                         |
| ---------------------------------- | ------------------------------------------------------------ |
| "no entry ends with `.tar`"        | `[].some()` is `false` — vacuously true on an empty list     |
| "picks the main image from a HEIC" | the patch was applied to the wrong branch and never ran      |
| "line count matches the source"    | mojibake has just as many newlines as the original           |
| an assertion in a test file        | the test threw earlier and masked the 40 assertions after it |

A green suite and a suite that can't fail look identical. The scripts in
`scripts/falsify-*.mjs` are the model: each one mutates the source, runs the
suite, checks that the expected assertions flipped, and restores the files. If
you add something worth asserting, consider adding a mutation for it.

When reviewing a PR, ask: if I broke this code, would this test notice?

---

## Adding a format or an engine

Read this before touching `src/shared/formats.ts`. It's the hub of the whole app
(shared by the main process, the renderer and the tests), and it has a trap:
**some changes have to be made in two places, and changing only one silently does
nothing.**

Nested archive formats (`tar.gz`, `tar.bz2`, …) need an entry in both
`LAYERED_SRC`, which decides "unwrap twice", and the `register('archive', …)`
list, which decides "accepted as a source at all". That bug shipped once: the
unwrapping rule was written but unreachable, because the format wasn't registered
as a source, so dragging in a `.tbz2` produced no targets at all.

The general shape of adding support:

1. **Capability matrix** — `src/shared/formats.ts`. Register the source extension
   and/or add the target to the relevant list.
2. **Routing** — `engineFor()` in the same file. If an existing engine handles it,
   you're done here.
3. **Engine adapter** — `src/main/converters/`. Spawn with **array arguments**
   (`spawn(exe, args)`), never a shell string and never `shell: true`. User
   filenames contain spaces, quotes, `&`, `$()` and emoji, and none of those are
   special when no shell parses them.
4. **Tests** — assertions in the relevant suite, plus a falsification.

### Engine rules that are not negotiable

- **Absolute paths.** Resolve paths with `path.resolve()`. A file named `-y.mp4`
  gets eaten as a flag otherwise. Argument injection is sneakier than shell
  injection.
- **Temporary outputs keep their extension**: `clip.mkv` → `clip.part.mkv`, not
  `clip.mkv.part`. FFmpeg infers its muxer from the extension and fails with
  `Invalid argument` otherwise.
- **Cancel by killing the process tree** (`taskkill /pid <pid> /T /F`). Engines
  spawn children; orphans hold locks and cause silent failures afterwards.
- **Never block the event loop.** No WASM engines, no in-process decoding. If it
  can't yield, run it as a subprocess. See `docs/ARCHITECTURE.md` for the
  measurements that settled this.

---

## Tests

```bash
npm run test:core      # pure logic: filename sanitising, duration parsing
npm run test:doc       # encoding detection, HTML ↔ text/markdown
npm run test:cli       # really spawns the CLI and checks stdout purity, exit codes
npm run test:mcp       # really starts the MCP server and converts through it
npm run test:tasks     # orchestration, with real ffmpeg / sharp / 7z subprocesses
npm run test:downlink  # the download framework, against a local HTTP server
npm run test:pandoc    # real pandoc subprocesses
npm run test:pdf       # end-to-end, really launches Electron and prints a PDF
npm test               # all eighteen (that is the list above plus ten more)
```

Slow suites (`test:tasks`, `test:pandoc`, `test:pdf`) run nightly in CI rather
than on every push; they download real engines and take minutes. Run them locally
before opening a PR that touches an engine. Don't delete a slow test to make CI
green.

### Test fixtures

Put samples in `scripts/fixtures/` (see the README there). Use **third-party or
real-world files**, not files you generated yourself: a file you create can only
exercise the decoder behaviour you already imagined.

Always copy a fixture to a temp directory with `stageFixture()` before using it.
Conversions write output next to the source by default, which would dirty a
version-controlled file.

---

## Commit messages

```
type(scope): summary
```

`type` is one of `feat` `fix` `docs` `style` `refactor` `test` `chore`. Keep the
summary under 50 characters. Add a body only when it earns its place, and when
you do, write down the measurement or the failure you observed rather than
restating the diff.

Good: `fix(pdf): 页转图后未释放 pdfjs 持有的整份字节`

---

## Pull requests

Before you open one:

- [ ] `npm run typecheck` passes
- [ ] `npm run lint` passes
- [ ] The relevant test suites pass
- [ ] **New/changed assertions have been falsified** — say so in the PR
      description, including what you broke and which assertions went red
- [ ] No scaffolding leftovers or debugging output
- [ ] If you touched the capability matrix, you checked both places (see above)

Small PRs are much easier to review than large ones. If a change is large, an
issue describing the approach first will save you a rewrite.
