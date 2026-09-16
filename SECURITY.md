# Security Policy

## Reporting a vulnerability

Please **do not open a public issue** for security problems.

Use GitHub's private reporting instead:
**[Security → Report a vulnerability](../../security/advisories/new)**

Include what you can:

- What you did, what happened, and what you expected
- The file (or a minimal sample) that triggers it, if relevant
- Version and Windows build

This is a side project maintained by one person. Best effort: an initial reply
within a week. There is no bug bounty.

## Scope

Arbiter is a local file-processing tool that spawns external programs. The
surfaces that matter:

| Surface                   | Why it matters                                                                                                                                                                                                                             |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Argument construction** | Every engine is spawned with an array of arguments, never through a shell. A regression that reintroduces `shell: true` or string concatenation would allow argument injection via filenames. Treated as a security bug, not a style issue |
| **Path handling**         | Paths are resolved to absolute form. A filename beginning with `-` is otherwise interpreted as a flag by FFmpeg/pandoc/7z                                                                                                                  |
| **Archive extraction**    | Extracting untrusted archives is a classic path-traversal and zip-bomb surface. Reported issues here are in scope                                                                                                                          |
| **Download framework**    | Engines are fetched over the network, with integrity enforced by SHA-256 hashes pinned in `resources/engines.manifest.json`. That only helps if the pinned hash was verified when it was added                                             |
| **MCP server**            | Handing an AI agent filesystem access is an explicit, deliberate risk. The design restricts operations to user-allowed directories, and refusals are loud rather than silent                                                               |
| **Renderer / preload**    | The renderer runs with `sandbox: true` and `contextIsolation` on, and the IPC boundary validates all renderer-supplied input. Renderer compromise should not grant filesystem access beyond what a conversion already does                 |

## Out of scope

- Vulnerabilities in **FFmpeg, LibreOffice, Calibre, pandoc or 7-Zip** themselves.
  These are separate upstream projects; report to them. We track their advisories
  and update when practical.
- Anything requiring an attacker to already have code execution on the machine.
- The installer not being code-signed. It isn't, deliberately. See the README.

## Spreadsheet parsing

This deserves a note of its own, because the dependency situation is unusual.

The npm registry only carries `xlsx` (SheetJS) up to 0.18.5, which has two
published advisories: prototype pollution (CVE-2023-30533, fixed upstream in
0.19.3) and ReDoS (CVE-2024-22363, fixed in 0.20.2). Later versions are only
distributed outside npm.

Arbiter therefore ships **0.20.3**, vendored as a tarball in `vendor/` and
referenced from `package.json` as a `file:` dependency. Both advisories are fixed
by what is installed. The reasoning, and the checksum, are in
[`vendor/README.md`](vendor/README.md); `scripts/test-doc.ts` asserts the version
so that a silent downgrade cannot go unnoticed.

## Supported versions

Only the latest release is supported. This is a pre-1.0 project; fixes land on
`main` and go out in the next release rather than being backported.
