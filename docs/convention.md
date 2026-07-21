# The agent workspace convention

An **agent workspace** is a git repository that gives coding/assistant
agents a stable operating context. `workspace-kit` validates the structure;
the content is always owner-authored. The convention has three layers, and a
workspace declares which of them it uses in `workspace.json` — absent
sections disable their checks, and unknown files are always tolerated
(harnesses and runtimes add their own state; tooling must not fight them).

## 1. Instructions

One canonical `AGENTS.md` at the repo root. `CLAUDE.md` is a relative
symlink to it so both Codex-style and Claude-style harnesses read the same
file. Harness- or runtime-specific mechanics stay out of the canonical file.
The kit checks presence and link integrity only — never prose.

## 2. Memory (optional)

- **Raw layer** — dated daily logs (`memory/YYYY-MM-DD.md`) and per-context
  logs (`memory/contexts/<slug>/*.md`), each starting with an H1.
- **Compiled layer** — a wiki (`memory/wiki/`) of pages carrying frontmatter
  (`title`, `type`, `status: active|draft|archived`, `updated: YYYY-MM-DD`,
  `tags`, `sources`) and forming a link graph. Wikilinks resolve
  page-relative, then root-relative, then by unique leaf basename;
  ambiguity is an error. Every non-index page needs an inbound link.
  `sources:` entries must exist (external URLs and `[[links]]` exempt).
  `log.md` records changes with `## [YYYY-MM-DD] slug | summary` headings.
- **Generated catalogs** — `wiki backfill` maintains `sources/` and `tags/`
  indexes from the raw layer (tag pages materialize at two or more sources;
  stale tag pages are purged). `wiki backfill --dry-run` prints the same write
  and deletion plan without applying it and always exits zero;
  `wiki backfill --check` is also non-mutating but exits one when that plan is
  non-empty, making catalog drift enforceable in CI.
- **Staleness** — `wiki stale` reports committed sources whose latest commit
  date is after the page's `updated:` stamp. This legacy-compatible default is
  date-only. Opt-in `wiki.revisionStaleness` also compares the source blob at
  `HEAD` with the blob visible in the page's latest commit; a different blob
  proves that the page revision did not see the current source state,
  including same-day and divergent-branch changes, and is reported with a
  `newer commit` marker. Findings remain informational and exit zero. In this
  stricter mode, missing or shallow Git history is an operational error
  because a clean result could not be proven.
- **llm-wiki enforcement (opt-in)** — for workspaces adopting the full
  LLM-maintained-wiki discipline: `wiki.indexCoverage` requires every
  non-exempt page to be cataloged directly in `index.md` (the index is a
  content catalog, not just a landing page); `wiki.logChronology` requires
  `log.md` entry dates to never decrease (append-only proxy);
  `wiki.requiredFields` lets a workspace extend the frontmatter atom (e.g.
  add `created`); top-level `limits` enforces the convention's soft size
  limits as warnings that never fail a run — the audit flags, the human
  decides. Contradiction and duplicate detection remain agentic maintenance
  work by design: a deterministic linter cannot judge semantics.

## 3. Operations (optional)

- **Registry** — a JSON file mapping project categories to entries
  (`{name, repo, path, owns, mode, …}`); the entry shape is config-declared.
  An explicit `registry.project` policy enables `registry validate`: the
  consumer declares the allowed modes and home-relative checkout prefix, while
  `repo` follows the portable GitHub `owner/repo` contract. Every entry is
  parsed before local checkout inspection, so malformed optional fields fail
  without running partial validation. Existing checkouts must be repository
  roots with the declared GitHub origin; portable case/Unicode path aliases and
  different paths resolving to the same canonical checkout are rejected. The optional catalog policy declares its
  field and allowed modes; catalog values must name regular, repository-relative
  files without symlink traversal. Missing checkouts are valid. This command is
  opt-in and is not part of parity-locked `doctor` output.
- **Ownership contract** — for peered workspaces descended from one
  historical ancestor: `workspace.contract.json` names the repository, its
  peer, the shared ancestor commit, and required/forbidden owner paths.
  `contract check` validates the local side; `contract peer` additionally
  proves reciprocity and that no post-split commit id appears in both
  histories (cherry-picks get new ids and are deliberately not detected —
  cross-workspace movement stays a human-reviewed patch).
- **Handoff gate** — `contract handoff <paths…>` screens proposed
  cross-workspace paths against a configured denylist. Absolute paths,
  `..` traversal, Windows drive/UNC paths, and `.env*` basenames are always
  blocked; configured directory roots and their descendants are protected
  with platform-independent path semantics. Passing means "eligible for human
  review", never approval.
- **Documentation links** — when enabled, `docs links` validates relative
  destinations in tracked Markdown inline links, images, and reference
  definitions. It supports angle-bracket destinations, balanced parentheses,
  optional titles, and Markdown escapes; code spans/fences and external or
  fragment-only destinations are ignored. Checked Markdown filenames must use
  portable `/` separators; literal backslashes are reported as non-portable.
  Targets must be tracked, so a gitignored-but-present file does not pass.

## Configuration reference (`workspace.json`)

```jsonc
{
  "minVersion": "0.1.0", // kit refuses to run if older
  "required": ["AGENTS.md", "CLAUDE.md"], // files that must exist
  "forbidden": [".env"], // files that must not exist
  "links": [{ "path": "CLAUDE.md", "target": "AGENTS.md" }],
  "registry": {
    "file": "projects.json",
    "entry": {
      "required": ["name", "repo", "path", "owns", "mode"],
      "optional": ["branch", "catalog"],
    },
    "project": {
      "pathPrefix": "~/projects/",
      "modes": ["managed", "route-only"],
      "catalog": { "field": "catalog", "modes": ["managed"] },
    },
  },
  "dailyLogs": { "root": "memory", "contexts": "memory/contexts" },
  "wiki": {
    "root": "memory/wiki",
    "requiredFields": ["title", "type", "status", "updated", "tags", "sources"],
    "indexCoverage": false, // every page cataloged in index.md
    "logChronology": false, // log.md dates never decrease (append-only proxy)
    "revisionStaleness": false, // compare source blobs at HEAD and page revision
  },
  "limits": [
    // soft limits: warnings, never failures
    { "pattern": "MEMORY.md", "maxLines": 200 },
    { "pattern": "memory/????-??-??.md", "maxLines": 80 },
  ],
  "contract": { "file": "workspace.contract.json" },
  "handoff": { "paths": ["AGENTS.md"], "prefixes": ["memory/"] },
  "docsLinks": { "enabled": false, "exclude": [] },
}
```

Strict JSON, no comments in the real file; every section optional; unknown
keys at every supported nesting level are ignored at runtime (additive schema
evolution across staggered kit versions) and reported with their full paths as
warnings by `config validate`. Configured filesystem paths are normalized as
portable repository-relative paths and must stay inside the workspace;
components ending in an ASCII space or period are rejected because other
platforms may reinterpret them. Symlinked scan/output directories are rejected
rather than followed. Link targets may use `..` only when they still resolve
inside the workspace, and link output paths must be unique ignoring case. The kit
ships **no defaults that encode any consumer's specifics** — every list above
is policy and lives with the workspace. One deliberate exception: `wiki
backfill` scans a fixed raw-source layout (`memory/intake`, `memory/notes`,
`docs/`, `user/`, `memory/contexts`, dated `memory/*.md` logs, and the root
convention files when present) — that layout _is_ the convention, and the
generated catalogs land under the configured `wiki.root`.

## Output contract

Errors print one per line to stderr and exit 1 (two parity-locked
exceptions: the daily-log check prints one `missing H1:` block, and a green
handoff prints the eligible paths as a list); success prints a terse
`<check> ok`; usage errors exit 2. `doctor --json` emits exactly one
newline-terminated `{"status","failed","warnings","checks","errors"}` object
on stdout and keeps stderr empty, including configuration and operational
failures. It never includes file-content excerpts. Checks are deterministic,
offline, and credential-free. History-dependent checks (`contract`, `wiki
stale`) need a full clone (`fetch-depth: 0` in CI). With
`wiki.revisionStaleness` enabled, `wiki stale` exits 1 with an explicit error
in a shallow clone instead of printing `wiki-stale ok`; the default mode keeps
the parity-locked legacy fallback and output.

`wiki backfill --check` prints every pending `would write` or `would delete`
operation and exits 1 when any are present; a clean generated catalog exits 0.
`--dry-run` prints the same plan but exits 0 whether or not work is pending.

`registry validate` also exits 1 for malformed entries or unsafe local checkout
state and prints `registry ok` on success. It reads Git metadata only; it never
clones, fetches, pulls, or changes a checkout.

## Profiles (`init`)

`init` scaffolds structural skeletons with TODO markers — it never writes
behavioral instruction content, and never overwrites existing files.

- `work` — AGENTS.md + CLAUDE.md symlink + docs/README.md + workspace.json.
- `personal` — work + README, `.env.example`, project-registry stub,
  memory/wiki skeleton (lint-green), pre-commit hook wiring for both `doctor`
  and `registry validate`.
- `runtime` — personal + HEARTBEAT.md and IDENTITY.md placeholders for
  always-on runtime identities.

A fresh scaffold is doctor-green immediately, and personal/runtime scaffolds
are also registry-green. The ownership contract stays unconfigured until an
origin remote and a peer actually exist.

## Exact check semantics

The executable specification lives in the repository's `parity/` directory:
frozen predecessor scripts, a synthetic fixture workspace, and golden
outputs that the shipped implementation reproduces byte-for-byte
(`test/golden-parity.test.ts`). Where behavior is quirky on purpose (the
frontmatter dialect, non-string `updated:` skipping validation), unit tests
in `test/unit.test.ts` pin the kept quirks.
