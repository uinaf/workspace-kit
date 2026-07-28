# The agent workspace convention

An **agent workspace** is a git repository that gives coding/assistant
agents a stable operating context. `workspace-kit` validates the structure and
scaffolds an owner-editable skeleton; workspace owners supply operating content
and policy. The convention has four layers, and a workspace declares which of
them it uses in `workspace.json` — absent
sections disable their checks, and unknown files are always tolerated
(harnesses and runtimes add their own state; tooling must not fight them).

## 1. Instructions

One canonical `AGENTS.md` at the repo root. `CLAUDE.md` is a relative
symlink to it so both Codex-style and Claude-style harnesses read the same
file. Harness- or runtime-specific mechanics stay out of the canonical file.
The structural check covers presence and link integrity; prose remains
owner-reviewed.

## 2. Memory (optional)

- **Raw layer** — dated daily logs (`memory/YYYY-MM-DD.md`) and per-context
  logs (`memory/contexts/<slug>/*.md`), each starting with an H1.
- **Compiled layer** — a wiki (`memory/wiki/`) of pages carrying frontmatter
  (`title`, `type`, `status: active|draft|archived`, `updated: YYYY-MM-DD`,
  `tags`, `sources`) and forming a link graph. Wikilinks resolve
  page-relative, then root-relative, then by unique leaf basename;
  ambiguity is an error. Every non-index page needs an inbound link.
  Authored pages need at least one `sources:` entry; generated source and tag
  catalogs may use `sources: []` when the represented set is empty. Listed
  sources must exist (external URLs and `[[links]]` exempt).
  `log.md` records changes with `## [YYYY-MM-DD] slug | summary` headings.
- **Generated catalogs** — `wiki backfill` maintains `sources/` and `tags/`
  indexes from the raw layer (tag pages materialize at two or more sources;
  stale tag pages are purged). `wiki backfill --dry-run` prints the same write
  and deletion plan without applying it and always exits zero;
  `wiki backfill --check` is also non-mutating but exits one when that plan is
  non-empty, making catalog drift enforceable in CI.
- **Staleness** — `wiki stale` reports committed sources whose latest commit
  date is after the page's `updated:` stamp. This legacy-compatible default is
  date-only. Opt-in `wiki.revisionStaleness` compares each source's current
  working-tree state with the state visible in the page's latest commit; a
  different state proves that the page revision did not see the proposed
  source state, including dirty, same-day, backdated, and divergent-branch
  changes. A page edited in the working tree is itself the proposed attestation
  revision, but its `updated:` date must still cover the source's latest
  substantive commit. For sources inside the wiki, changes only to the
  top-level frontmatter `updated:` field are attestation metadata: they neither
  advance that substantive date nor stale dependent pages. Substantive nested
  edits still propagate across their direct source edge; the check does not
  speculate over untouched transitive dependents.

  Revision mode evaluates staged and unstaged files together as the proposed
  working tree, not the Git index in isolation. A partial commit can therefore
  differ from the state that was checked; rerun the check after committing a
  subset. Findings remain informational and exit zero. Missing or shallow Git
  history is an operational error because a clean result could not be proven.

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

## 3. Skills (optional)

Locally authored skills live in `skills/<name>/SKILL.md`. Remote GitHub skills
are declared in `skills/skills.json` with an explicit name and `owner/repo`
source:

```json
{
  "skills": [{ "name": "workspace-helper", "source": "example/skill-library" }]
}
```

`workspace-kit skills sync` keeps authored source and generated discovery
separate:

```text
skills/howdy/                         authored source
skills/skills.json                    remote manifest
skills/workspace-kit-lock.json        generated workspace-kit ownership
.agents/skills/howdy                  link to ../../skills/howdy
.agents/skills/workspace-helper/      copied remote skill
.claude/skills                        link to ../.agents/skills
```

[OpenClaw](https://docs.openclaw.ai/skills) discovers both `skills/` and
`.agents/skills`; the authored `skills/` root has higher precedence. Codex and
other project-agent harnesses use `.agents/skills`, while the Claude link
exposes that generated tree without another copy. A local link therefore makes
one authored skill available across harnesses, and a remote copy remains
workspace-local.

Enable workspace skill management with `"skills": {}` in `workspace.json`,
then run:

```bash
npm exec -- workspace-kit skills sync
```

Sync links every locally authored skill into `.agents/skills`, ensures the
Claude discovery link, then delegates each remote entry to a pinned `skills`
CLI with telemetry disabled, project scope, and copy mode. The dependency owns
source retrieval, security assessment, copying, and content hashes.
After each successful install, workspace-kit verifies the copied directory and
the dependency lock, then records that name and source in
`skills/workspace-kit-lock.json`. When an entry leaves the manifest, sync
removes it only when the manager lock and current dependency lock still record
the same source. Generic `skills-lock.json` entries alone remain dependency
metadata.

Commit both generated lock files with the copied remote skills. Use `skills
check` for an offline check of workspace declarations, runtime links/copies,
and declared-versus-locked provenance. `doctor` includes the same check whenever
the `skills` section exists.

Consumers own shared machine-global skill selection and installation.

## Adopting an existing workspace

1. Install `@uinaf/workspace-kit` as an exact development dependency.
2. Add a project-local `verify` script for `workspace-kit verify`; add direct
   check shortcuts only when people use them independently.
3. Describe the workspace's selected sections in `workspace.json`.
4. Put authored skills in `skills/<name>/`, declare remote workspace skills in
   `skills/skills.json`, and run `skills sync`.
5. Run the local `verify` script and the repository's CI before deploying
   the checkout to a runtime.

## 4. Operations (optional)

- **Registry** — a JSON file mapping project categories to entries
  (`{name, repo, path, owns, mode, …}`); the entry shape is config-declared.
  `registry.project` enables `registry validate` and declares allowed modes,
  checkout prefix, Git origin hosts (`["github.com"]` by default), repository
  owners, required entries, and an optional entry limit. Repository paths may
  include nested groups. Existing checkouts must match both the path and an
  allowed host using HTTPS, SCP-style SSH, or `ssh://`; credentials and unsafe
  URL/path syntax are rejected. Portable path aliases, duplicate checkout roots,
  and unsafe catalogs also fail. Missing checkouts are valid. `verify` includes
  this gate whenever `registry.project` is configured.
  `registry clone`, `registry status`, and `registry pull` validate the same
  contract before operating on checkouts. Clone and pull are restricted to
  `managed` entries; pull uses `--ff-only` and enforces a configured branch.
  `registry path <category/name> [--mode <mode>]` prints one validated absolute
  checkout path so consumers can compose owner-specific commands without
  copying registry parsing into local scripts.
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
- **Confidential content** — when a `confidential` section exists,
  `confidential check` verifies that content the workspace declares
  confidential is recorded in Git as provider ciphertext. `git-crypt` is the
  only supported provider. Git is the oracle for path policy: attributes are
  resolved from the index with `git check-attr --cached`, so `[attr]` macros,
  negation, per-directory `.gitattributes`, and `core.ignorecase` all behave as
  Git behaves. Declared patterns are matched ignoring case and Unicode spelling,
  so a path that differs from a declared pattern only in spelling is still
  treated as protected. The check fails when a protected index entry is not
  git-crypt ciphertext, when a declared pattern is outside the provider's
  policy, when a declared pattern matches nothing, when git-crypt covers a path
  the workspace never declared, when a protected entry is a symlink, submodule,
  or unmerged, when a declared pattern would encrypt Git or workspace policy
  files, when the indexed `workspace.json` declares a different confidential
  policy than the one being checked, and when git-crypt key material is tracked
  anywhere in the index. The policy the commit carries is binding, so the check
  also runs when only the indexed `workspace.json` declares one — retiring the
  section takes a staged edit, not an unstaged one — and `workspace.json` itself
  must be tracked at that exact path, with no case alias beside it.
  Key-material findings verify the provider's key header, so prose that merely
  names it is not flagged; that also bounds them to git-crypt's headered key
  format, since a pre-0.4 key is raw bytes and cannot be told apart from any
  other small binary blob offline. Findings name paths only: the check keeps
  provider headers rather than content, though finding key candidates does scan
  indexed content inside Git and object reads are buffered whole up to an
  internal limit. Nothing is emitted, stored, or decrypted, and no state changes.
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
      "originHosts": ["github.com"],
      "allowedOwners": ["fixture-owner"],
      "mustContain": [{ "repo": "fixture-owner/workspace", "mode": "managed" }],
      "maxEntries": 25,
      "catalog": { "field": "catalog", "modes": ["managed"] },
    },
  },
  "dailyLogs": { "root": "memory", "contexts": "memory/contexts" },
  "wiki": {
    "root": "memory/wiki",
    "requiredFields": ["title", "type", "status", "updated", "tags", "sources"],
    "indexCoverage": false, // every page cataloged in index.md
    "logChronology": false, // log.md dates never decrease (append-only proxy)
    "revisionStaleness": false, // compare proposed source and page revisions
  },
  "limits": [
    // soft limits: warnings, never failures
    { "pattern": "MEMORY.md", "maxLines": 200 },
    { "pattern": "memory/????-??-??.md", "maxLines": 80 },
  ],
  "contract": { "file": "workspace.contract.json" },
  "handoff": { "paths": ["AGENTS.md"], "prefixes": ["memory/"] },
  "docsLinks": { "enabled": false, "exclude": [] },
  "skills": {},
  "confidential": {
    // opt-in; absent disables the check entirely
    "provider": "git-crypt",
    "paths": ["memory/private/**"],
  },
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

`registry.project.allowedOwners` matches the first segment of every repository
path. Each `mustContain` pair requires exactly one entry with that repository
and mode. `maxEntries` counts entries across every top-level registry category;
zero defines an intentionally empty registry.

## Output contract

Errors print one per line to stderr and exit 1 (two parity-locked
exceptions: the daily-log check prints one `missing H1:` block, and a green
handoff prints the eligible paths as a list); success prints a terse
`<check> ok`; usage errors exit 2. `doctor --json` and `verify --json` each emit exactly one
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

`verify` loads and validates `workspace.json` once, runs the configured
`doctor` checks, includes `registry validate` when `registry.project` exists,
and runs `wiki backfill --check` when `wiki` exists. It does not run `wiki
stale`, which is a separate history-based operation.

`confidential check` prints one error per line and exits 1, or prints
`confidential ok (<provider>, <n> protected paths)` and exits 0. Findings name
paths only: no file content, byte counts, or excerpts ever reach stdout, stderr,
or the JSON reports. `doctor` includes it whenever the `confidential` section
exists.

`registry validate` exits 1 for malformed entries, ownership-policy failures,
or unsafe local checkout state and prints `registry ok` on success. It reads
Git metadata only; it never clones, fetches, pulls, or changes a checkout.
`registry status` is read-only. `registry clone` invokes `gh repo clone` for
missing managed entries, while `registry pull` invokes `git pull --ff-only` for
present managed entries. `hooks install` sets `core.hooksPath` to `.githooks`
and makes the tracked pre-commit hook executable.

## Repository security composition

Workspace repositories run full-history secret detection in a dedicated CI
workflow on pull requests and default-branch pushes, with scheduled and manual
runs for recurring coverage. The consumer may add the workflow path to
`workspace.json.required` so `doctor` verifies that the repository keeps the
workflow as part of its structure.

Local workspace validation stays focused on deterministic structure, wiki,
registry, documentation, skill, and confidential-content contracts. Host
configuration audits and repository-history security scans remain independently
operated surfaces.

### Confidential content: threat model

Secret scanning detects credentials that were committed by accident.
`confidential` addresses the different problem of content a workspace stores in
Git _on purpose_ and does not want readable in the remote. The two are separate
surfaces and neither replaces the other.

The guarantee is deliberately narrow: **the selected file contents are
unreadable in the Git remote and in clones without a decryption identity, and no
commit created through the gate carries those paths as plaintext.** Everything
else is out of scope.

workspace-kit owns documentation and validation only. It implements no
cryptography, manages no keys, installs nothing, and scaffolds nothing. It never
unlocks, decrypts, encrypts, or otherwise changes state — the provider,
recipients, identities, distribution, and recovery are consumer-owned. A green
check is evidence that the declared contract has not drifted; it is not proof of
confidentiality.

Explicit non-goals:

- The kit cannot confirm that ciphertext decrypts, or that it names the intended
  recipients. Without a key, only the provider's framing is verifiable.
- It inspects the index — which equals `HEAD` in a clean checkout — and never
  audits older commits. Plaintext already in history stays in history; removing
  it requires a history rewrite and a rotation of anything it exposed, and both
  are outside this contract.
- `git merge`, `cherry-pick`, `rebase`, `revert`, `am`, and `--no-verify` do not
  run `pre-commit`. A local hook is convenience; `verify` in CI is the
  authority, and a workflow that merges without squashing must check the whole
  proposed range, not only its tip.
- Filenames, directory shape, file sizes, commit messages, and change timing
  stay visible unless the provider hides them; git-crypt does not.
- Access cannot be revoked from history. Anyone who has cloned and unlocked
  keeps that content permanently, so a recipient change is not a revocation.
- Nothing here protects content from an already-authorized agent or process
  after unlock, or from leakage through prompts, logs, editor caches, temporary
  files, backups, or screenshots.
- Encrypted Git storage is the wrong home for live credentials. Keep those in a
  secret manager and commit only sanitized references.

Two operational notes are worth planning around rather than discovering. Only
committed policy counts: attributes are resolved from the index, and the
working-tree, user-global, and system-wide attribute sources are all excluded.
Git offers no way to ignore the repository-local `.git/info/attributes`, so any
effective line there fails the check outright — a tracked `[attr]` macro lets
that file grant coverage without naming the provider, which makes its effect
impossible to judge by reading it. Move such rules into a tracked
`.gitattributes`. Second, place protected paths clear of the trees that content checks scan — in a
locked clone those files are ciphertext, so a wiki or daily-log check reading
them as Markdown produces noise. The kit does not reject the overlap, because
the useful arrangement (`memory/private/**` beside a `memory` daily-log root)
does not actually collide.

## Profiles (`init`)

In an empty directory, `init` scaffolds an owner-editable instruction skeleton with TODO markers, an
exact local `@uinaf/workspace-kit` development dependency, package scripts,
and the selected profile's structural files. Run `npm install` once, then use
`npm run verify`; generated hooks use the same local package and stay offline.
Existing files remain unchanged. A re-run accepts a compatible `package.json`;
an existing repository follows the adoption steps above, and init stops before
writing when its package contract is incompatible.

- `work` — AGENTS.md + CLAUDE.md symlink + package.json + docs/README.md + workspace.json.
- `personal` — work + README, `.env.example`, project-registry stub and
  lifecycle scripts, hook installer, memory/wiki skeleton and generated
  catalogs, and a `verify` pre-commit hook.
- `runtime` — personal + HEARTBEAT.md and IDENTITY.md placeholders for
  always-on runtime identities.

A fresh scaffold is verify-green immediately. The ownership contract stays
unconfigured until an origin remote and a peer actually exist.

After scaffolding, the workspace owner replaces the `AGENTS.md` TODOs before
treating the repository as operational. The runtime profile creates an empty
`skills/skills.json` remote manifest, a `.agents/skills/` discovery directory,
and the `.claude/skills` compatibility link; the owner then declares and syncs
the skills that runtime uses.

## Exact check semantics

The executable specification lives in the repository's `parity/` directory:
frozen predecessor scripts, a synthetic fixture workspace, and golden
outputs that the shipped implementation reproduces byte-for-byte
(`test/golden-parity.test.ts`). Where behavior is quirky on purpose (the
frontmatter dialect, non-string `updated:` skipping validation), unit tests
in `test/unit.test.ts` pin the kept quirks.
