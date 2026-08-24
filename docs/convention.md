# The agent workspace convention

An **agent workspace** is a git repository that gives coding/assistant
agents a stable operating context. `workspace-kit` validates the structure and
scaffolds an owner-editable skeleton; workspace owners supply operating content
and policy. The convention has four layers, and a workspace declares which of
them it uses in `workspace.json`; absent
sections disable their checks, and unknown files are always tolerated
(harnesses and runtimes add their own state; tooling must not fight them).

## 1. Instructions

One canonical `AGENTS.md` at the repo root. `CLAUDE.md` is a relative
symlink to it so both Codex-style and Claude-style harnesses read the same
file. Harness- or runtime-specific mechanics stay out of the canonical file.
The structural check covers presence and link integrity; prose remains
owner-reviewed.

## 2. Memory (optional)

A workspace may declare one memory strategy in `workspace.json`:

- **`llm-wiki`** keeps the repository-maintained raw-log and compiled-wiki
  lifecycle described below. It requires both `dailyLogs` and `wiki`.
- **`hindsight`** delegates recall and retention to an existing Hindsight
  integration. `integration` names the client contract (`coding-agent` or
  `openclaw`), while `namespace` is the canonical `owner/repository` identity
  used to route that repository's banks. Workspace-kit validates this
  declaration but never installs a plugin, reads machine-global configuration,
  checks credentials, or calls Hindsight.

The strategy is an ownership declaration, not an authorization layer. A
Hindsight client and server remain responsible for bank routing, credentials,
and runtime health. Existing configurations without `memory` retain their
current behavior; `dailyLogs` and `wiki` remain the legacy llm-wiki signal.

### LLM wiki

- **Raw layer**: dated daily logs (`memory/YYYY-MM-DD.md`) and per-context
  logs (`memory/contexts/<slug>/*.md`), each starting with an H1.
- **Compiled layer**: a wiki (`memory/wiki/`) of pages carrying frontmatter
  (`title`, `type`, `status: active|draft|archived`, `updated: YYYY-MM-DD`,
  `tags`, `sources`) and forming a link graph. Wikilinks resolve
  page-relative, then root-relative, then by unique leaf basename;
  ambiguity is an error. Every non-index page needs an inbound link.
  Authored pages need at least one `sources:` entry; generated source and tag
  catalogs may use `sources: []` when the represented set is empty. Listed
  sources must exist (external URLs and `[[links]]` exempt).
  `log.md` records changes with `## [YYYY-MM-DD] slug | summary` headings.
- **Generated catalogs**: `wiki backfill` maintains `sources/` and `tags/`
  indexes from the raw layer (tag pages materialize at two or more sources;
  stale tag pages are purged). `wiki backfill --dry-run` prints the same write
  and deletion plan without applying it and always exits zero;
  `wiki backfill --check` is also non-mutating but exits one when that plan is
  non-empty, making catalog drift enforceable in CI.
- **Staleness**: `wiki stale` reports committed sources whose latest commit
  date is after the page's `updated:` stamp. This legacy-compatible default is
  date-only.
  - Opt-in `wiki.revisionStaleness` compares each source's current
    working-tree state with the state visible in the page's latest commit; a
    different state proves that the page revision did not see the proposed
    source state, including dirty, same-day, backdated, and divergent-branch
    changes.
  - A page edited in the working tree is itself the proposed attestation
    revision, but its `updated:` date must still cover the source's latest
    substantive commit.
  - For sources inside the wiki, changes only to the top-level frontmatter
    `updated:` field are attestation metadata: they neither advance that
    substantive date nor stale dependent pages. Substantive nested edits still
    propagate across their direct source edge; the check does not speculate
    over untouched transitive dependents.
  - Revision mode evaluates staged and unstaged files together as the proposed
    working tree, not the Git index in isolation. A partial commit can
    therefore differ from the state that was checked; rerun the check after
    committing a subset.
  - Findings remain informational and exit zero. Missing or shallow Git
    history is an operational error because a clean result could not be
    proven.

- **llm-wiki enforcement (opt-in)**: for workspaces adopting the full
  LLM-maintained-wiki discipline: `wiki.indexCoverage` requires every
  non-exempt page to be cataloged directly in `index.md` (the index is a
  content catalog, not just a landing page); `wiki.logChronology` requires
  `log.md` entry dates to never decrease (append-only proxy);
  `wiki.requiredFields` lets a workspace extend the frontmatter atom (e.g.
  add `created`); top-level `limits` enforces the convention's soft size
  limits as warnings that never fail a run; the audit flags, the human
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
pnpm exec workspace-kit skills sync
```

- Sync links every locally authored skill into `.agents/skills`, ensures the
  Claude discovery link, then delegates each remote entry to a pinned `skills`
  CLI with telemetry disabled, project scope, and copy mode.
- The dependency owns source retrieval, security assessment, copying, and
  content hashes.
- After each successful install, workspace-kit verifies the copied directory
  and the dependency lock, then records that name and source in
  `skills/workspace-kit-lock.json`.
- When an entry leaves the manifest, sync removes it only when the manager
  lock and current dependency lock still record the same source. Generic
  `skills-lock.json` entries alone remain dependency metadata.

Commit both generated lock files with the copied remote skills. Use `skills
check` for an offline check of workspace declarations, runtime links/copies,
and declared-versus-locked provenance. `doctor` includes the same check whenever
the `skills` section exists.

Consumers own shared machine-global skill selection and installation.

## Adopting an existing workspace

1. Enable Corepack if needed, then install `@uinaf/workspace-kit` as an
   exact development dependency with
   `pnpm add --save-dev --save-exact @uinaf/workspace-kit`.
2. Pin `"packageManager": "pnpm@11.23.0"` in `package.json` and add a
   project-local `verify` script for `workspace-kit verify`; add direct
   check shortcuts only when people use them independently.
3. Describe the workspace's selected sections in `workspace.json`.
4. Put authored skills in `skills/<name>/`, declare remote workspace skills in
   `skills/skills.json`, and run `skills sync`.
5. Run `pnpm verify` and the repository's CI before deploying the checkout
   to a runtime.

Existing npm-based agent workspaces migrate by enabling Corepack, rewriting
scripts and docs to `pnpm …`, running `pnpm import` or a fresh `pnpm install`,
and deleting `package-lock.json`. Leave `packageManager.enforce` off until
that cutover is done; set it true once the pin and lockfile match.

## 4. Operations (optional)

- **Registry**: a JSON file mapping project categories to entries
  (`{name, repo, path, owns, mode, …}`); the entry shape is config-declared.
  - `registry.project` enables `registry validate` and declares allowed modes,
    checkout prefix, Git origin hosts (`["github.com"]` by default),
    repository owners, required entries, and an optional entry limit.
    Repository paths may include nested groups.
  - Existing checkouts must match both the path and an allowed host using
    HTTPS, SCP-style SSH, or `ssh://`; credentials and unsafe URL/path syntax
    are rejected. Portable path aliases, duplicate checkout roots, and unsafe
    catalogs also fail. Missing checkouts are valid.
  - `verify` includes this gate whenever `registry.project` is configured.
  - `registry clone`, `registry status`, and `registry pull` validate the same
    contract before operating on checkouts. Clone and pull are restricted to
    `managed` entries; pull uses `--ff-only` and enforces a configured branch.
  - `registry path <category/name> [--mode <mode>]` prints one validated
    absolute checkout path so consumers can compose owner-specific commands
    without copying registry parsing into local scripts.
- **Ownership contract**: for peered workspaces descended from one
  historical ancestor: `workspace.contract.json` names the repository, its
  peer, the shared ancestor commit, and required/forbidden owner paths.
  `contract check` validates the local side; `contract peer` additionally
  proves reciprocity and that no post-split commit id appears in both
  histories (cherry-picks get new ids and are deliberately not detected;
  cross-workspace movement stays a human-reviewed patch).
- **Handoff gate**: `contract handoff <paths…>` screens proposed
  cross-workspace paths against a configured denylist. Absolute paths,
  `..` traversal, Windows drive/UNC paths, and `.env*` basenames are always
  blocked; configured directory roots and their descendants are protected
  with platform-independent path semantics. Passing means "eligible for human
  review", never approval.
- **Documentation links**: when enabled, `docs links` validates relative
  destinations in tracked Markdown inline links, images, and reference
  definitions. It supports angle-bracket destinations, balanced parentheses,
  optional titles, and Markdown escapes; code spans/fences and external or
  fragment-only destinations are ignored. Checked Markdown filenames must use
  portable `/` separators; literal backslashes are reported as non-portable.
  Targets must be tracked, so a gitignored-but-present file does not pass.
- **Package manager (opt-in)**: convention workspaces use pnpm.
  `init` writes a Corepack `packageManager` pin, pnpm scripts, and
  `"packageManager": { "enforce": true }`. Existing configs without the
  section stay unchecked. When `packageManager.enforce` is true, `doctor`
  and `verify` require `package.json#packageManager` to be a `pnpm@` pin
  and reject `package-lock.json` / `yarn.lock`. Set
  `allowForeignLockfiles` only as a time-boxed escape hatch while a
  lockfile is being replaced.

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
  "memory": { "strategy": "llm-wiki" },
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
  "packageManager": { "enforce": false, "allowForeignLockfiles": false },
}
```

A repository using the coding-agent Hindsight integration instead declares:

```jsonc
{
  "memory": {
    "strategy": "hindsight",
    "integration": "coding-agent",
    "namespace": "fixture-owner/fixture-workspace",
  },
}
```

Do not combine the Hindsight strategy with `dailyLogs` or `wiki`; source
documents may still live elsewhere in the repository as ordinary authored
content.

- Strict JSON, no comments in the real file; every section optional.
- Unknown keys at every supported nesting level are ignored at runtime
  (additive schema evolution across staggered kit versions) and reported with
  their full paths as warnings by `config validate`.
- Configured filesystem paths are normalized as portable repository-relative
  paths and must stay inside the workspace; components ending in an ASCII
  space or period are rejected because other platforms may reinterpret them.
- Symlinked scan/output directories are rejected rather than followed.
- Link targets may use `..` only when they still resolve inside the workspace,
  and link output paths must be unique ignoring case.
- The kit ships **no defaults that encode any consumer's specifics**; every
  list above is policy and lives with the workspace. One deliberate exception:
  `wiki backfill` scans a fixed raw-source layout (`memory/intake`,
  `memory/notes`, `docs/`, `user/`, `memory/contexts`, dated `memory/*.md`
  logs, and the root convention files when present); that layout _is_ the
  convention, and the generated catalogs land under the configured
  `wiki.root`.

`registry.project.allowedOwners` matches the first segment of every repository
path. Each `mustContain` pair requires exactly one entry with that repository
and mode. `maxEntries` counts entries across every top-level registry category;
zero defines an intentionally empty registry.

## Output contract

- Errors print one per line to stderr and exit 1 (two parity-locked
  exceptions: the daily-log check prints one `missing H1:` block, and a green
  handoff prints the eligible paths as a list); success prints a terse
  `<check> ok`; usage errors exit 2.
- `doctor --json` and `verify --json` each emit exactly one newline-terminated
  `{"status","failed","warnings","checks","errors"}` object on stdout and keep
  stderr empty, including configuration and operational failures. The object
  never includes file-content excerpts.
- Checks are deterministic, offline, and credential-free.
- History-dependent checks (`contract`, `wiki stale`) need a full clone
  (`fetch-depth: 0` in CI). With `wiki.revisionStaleness` enabled,
  `wiki stale` exits 1 with an explicit error in a shallow clone instead of
  printing `wiki-stale ok`; the default mode keeps the parity-locked legacy
  fallback and output.

`wiki backfill --check` prints every pending `would write` or `would delete`
operation and exits 1 when any are present; a clean generated catalog exits 0.
`--dry-run` prints the same plan but exits 0 whether or not work is pending.

- `verify` loads and validates `workspace.json` once, runs the configured
  `doctor` checks, includes `registry validate` when `registry.project`
  exists, and runs `wiki backfill --check` when `wiki` exists.
- `verify` does not run `wiki stale`, which is a separate history-based
  operation. The package-manager check runs only when `packageManager.enforce`
  is true.
- `registry validate` exits 1 for malformed entries, ownership-policy
  failures, or unsafe local checkout state and prints `registry ok` on
  success. It reads Git metadata only; it never clones, fetches, pulls, or
  changes a checkout.
- `registry status` is read-only. `registry clone` invokes `gh repo clone` for
  missing managed entries, while `registry pull` invokes `git pull --ff-only`
  for present managed entries.
- `hooks install` sets `core.hooksPath` to `.githooks` and makes the tracked
  pre-commit hook executable.

## Repository security composition

Workspace repositories run full-history secret detection in a dedicated CI
workflow on pull requests and default-branch pushes, with scheduled and manual
runs for recurring coverage. The consumer may add the workflow path to
`workspace.json.required` so `doctor` verifies that the repository keeps the
workflow as part of its structure.

Local workspace validation stays focused on deterministic structure, wiki,
registry, documentation, and skill contracts. Host configuration audits and
repository-history security scans remain independently operated surfaces.

## Profiles (`init`)

- In an empty directory, `init` scaffolds an owner-editable instruction
  skeleton with TODO markers, an exact local `@uinaf/workspace-kit`
  development dependency, package scripts, and the selected profile's
  structural files.
- Run `pnpm install` once, then use `pnpm verify`; generated hooks use the
  same local package and stay offline.
- Existing files remain unchanged. A re-run accepts a compatible
  `package.json`; an existing repository follows the adoption steps above, and
  init stops before writing when its package contract is incompatible.

- `work`: AGENTS.md + CLAUDE.md symlink + package.json + docs/README.md + workspace.json.
- `personal`: work + README, `.env.example`, project-registry stub and
  lifecycle scripts, hook installer, memory/wiki skeleton and generated
  catalogs, and a `verify` pre-commit hook.
- `runtime`: personal + HEARTBEAT.md and IDENTITY.md placeholders for
  always-on runtime identities.

Personal and runtime profiles default to `llm-wiki`. Pass `--memory
hindsight`, `--integration coding-agent|openclaw`, and `--namespace
owner/repository` together to scaffold Hindsight instructions without raw-log
or wiki artifacts. The `work` profile still defaults to no memory strategy.

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
