# The agent workspace convention

An **agent workspace** is a git repository that gives coding agents a stable
operating context. `workspace-kit` validates its structure and scaffolds an
owner-editable skeleton; the owner supplies content and policy. A workspace
declares the layers it uses in `workspace.json`. An absent section disables
its checks, and unknown files are always tolerated.

## 1. Instructions

One canonical `AGENTS.md` at the repo root, with `CLAUDE.md` as a relative
symlink to it. Harness- and runtime-specific mechanics stay out of it. The
check covers presence and the link; the owner reviews the prose.

## 2. Memory (optional)

`"memory": { "strategy": "llm-wiki" }` adopts the repository-maintained
raw-log and compiled-wiki lifecycle below, and requires `dailyLogs` and
`wiki`. Without `memory`, `dailyLogs` and `wiki` alone still enable it. The
strategy does not claim paths from a runtime: list paths the workspace must
reject in `forbidden`.

A workspace whose runtime keeps its own file memory (for example OpenClaw's
`memory/YYYY-MM-DD.md` logs and `MEMORY.md`) omits `memory`, `dailyLogs`, and
`wiki`. Its memory files are then ordinary authored content.

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
  indexes from the raw layer. A tag page appears at two or more sources;
  stale tag pages are purged.
- **Staleness**: `wiki stale` reports committed sources whose latest commit
  date is after the page's `updated:` date.
  - Opt-in `wiki.revisionStaleness` instead compares each source's
    working-tree state with the state in the page's latest commit, so dirty,
    same-day, backdated, and divergent-branch changes count.
  - A page edited in the working tree attests the proposed state, but its
    `updated:` date must still cover the source's latest substantive commit.
  - For sources inside the wiki, an edit to only the top-level `updated:`
    field is metadata: it does not stale dependent pages. Substantive edits
    stale direct dependents only.
  - Revision mode reads staged and unstaged files together, not the index
    alone. After a partial commit, rerun the check.
  - Revision-mode findings exit zero; missing or shallow history is an error.
- **Opt-in enforcement**: `wiki.indexCoverage` requires every non-exempt page
  to be listed directly in `index.md`. `wiki.logChronology` requires `log.md`
  dates to never decrease. `wiki.requiredFields` extends the frontmatter
  fields. Top-level `limits` reports soft size limits as warnings that never
  fail a run. Unreadable files produce warnings; other files are still
  checked.

## 3. Skills (optional)

Locally authored skills live in `skills/<name>/SKILL.md`. Remote GitHub skills
are declared in `skills/skills.json` with an explicit name and `owner/repo`
source:

```json
{
  "skills": [{ "name": "workspace-helper", "source": "example/skill-library" }]
}
```

`workspace-kit skills sync` produces this layout:

```text
skills/howdy/                         authored source
skills/skills.json                    remote manifest
skills/workspace-kit-lock.json        generated workspace-kit ownership
.agents/skills/howdy                  link to ../../skills/howdy
.agents/skills/workspace-helper/      copied remote skill
.claude/skills                        link to ../.agents/skills
```

Enable it with `"skills": {}` in `workspace.json`, then run
`pnpm exec workspace-kit skills sync`.

- Sync validates every destination first and stops at the first conflict.
  Unmanaged directories, symlinks, and mismatched provenance need the owner
  to resolve them.
- Remote entries install through a pinned `skills` CLI (project scope, copy
  mode, telemetry off), which owns retrieval, security assessment, and
  hashes.
- Sync removes a copy that left the manifest only when
  `skills/workspace-kit-lock.json` and `skills-lock.json` still record the
  same source.

Commit both lock files with the copied remote skills. `skills check` verifies
declarations, links, copies, and provenance offline; `doctor` runs it when
`skills` exists. Machine-global skills stay consumer-owned.

## Adopting an existing workspace

1. `pnpm add --save-dev --save-exact @uinaf/workspace-kit`
2. Pin `"packageManager": "pnpm@12.0.0"` in `package.json` and add a `verify`
   script that runs `workspace-kit verify`.
3. Declare the workspace's sections in `workspace.json`.
4. Put authored skills in `skills/<name>/`, declare remote ones in
   `skills/skills.json`, and run `skills sync`.
5. Run `pnpm verify` and the repository's CI before deploying the checkout
   to a runtime.

An npm workspace moves its scripts and docs to `pnpm`, runs `pnpm import` or
`pnpm install`, and deletes `package-lock.json`. Set `packageManager.enforce`
to true only after the pin and lockfile match.

## 4. Operations (optional)

- **Registry**: a JSON file that maps project categories to entries
  (`{name, repo, path, owns, mode, …}`); config declares the entry shape.
  - `registry.project` enables `registry validate`: allowed modes, checkout
    prefix, origin hosts (default `["github.com"]`), repository owners,
    required entries, and an entry limit.
  - A present checkout must match its path and an allowed host over HTTPS,
    SCP-style SSH, or `ssh://`. Credentials in URLs, unsafe paths, portable
    path aliases, duplicate roots, and unsafe catalogs fail. Missing checkouts
    pass.
  - `registry clone`, `status`, and `pull` validate first. Clone and pull act
    only on `managed` entries; pull is `--ff-only` and enforces a configured
    branch.
  - `registry path <category/name> [--mode <mode>]` prints one validated
    absolute checkout path for consumer scripts.
- **Ownership contract**: for peered workspaces split from one ancestor,
  `workspace.contract.json` names the repository, its peer, the shared
  ancestor commit, and required and forbidden owner paths. `contract check`
  validates the local side. `contract peer` also proves reciprocity and that
  no post-split commit id appears in both histories; cherry-picks get new ids
  and pass, so cross-workspace moves stay human-reviewed patches.
- **Handoff gate**: `contract handoff <paths…>` screens proposed
  cross-workspace paths against the configured denylist. Absolute paths,
  `..` traversal, Windows drive and UNC paths, and `.env*` basenames are
  always blocked. Passing means "eligible for human review", never approval.
- **Documentation links**: `docs links` checks relative destinations in
  tracked Markdown links, images, and reference definitions; code, external,
  and fragment-only links are skipped. Targets must be tracked: an ignored
  file fails, and an untracked one is reported as untracked. Backslashes in
  checked paths are reported as non-portable.
- **Package manager (opt-in)**: with `packageManager.enforce`, `doctor` and
  `verify` require a `pnpm@` pin in `package.json#packageManager` and reject
  `package-lock.json` and `yarn.lock`. `init` turns it on. Use
  `allowForeignLockfiles` only while replacing a lockfile.

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

- The real file is strict JSON without comments; every section is optional.
- Runtime ignores unknown keys; `config validate` warns with their full paths.
- Configured paths are repository-relative and stay inside the workspace.
  Components ending in a space or period are rejected; symlinked scan and
  output directories are rejected. Link targets may use `..` only when they
  resolve inside the workspace, and link paths must be unique ignoring case.
- Every list is workspace policy; the kit ships no consumer defaults. The
  exception is the raw-source layout `wiki backfill` scans: `memory/intake`,
  `memory/notes`, `docs/`, `user/`, `memory/contexts`, dated `memory/*.md`
  logs, and the root convention files.
- `allowedOwners` matches the first segment of each repository path. Each
  `mustContain` pair requires exactly one entry with that repository and
  mode. `maxEntries` counts entries across all categories; zero means an
  intentionally empty registry.

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
  (`fetch-depth: 0` in CI). In a shallow clone, `wiki stale` with
  `wiki.revisionStaleness` exits 1; the default mode prints `wiki-stale ok`.
- `wiki backfill --check` prints each pending `would write` or `would delete`
  and exits 1 when any exist. `--dry-run` prints the same plan and exits 0.
- `verify` validates `workspace.json`, runs the configured `doctor` checks,
  `registry validate` when `registry.project` exists, and
  `wiki backfill --check` when `wiki` exists. It never runs `wiki stale`.
- `registry validate` and `registry status` only read Git metadata.
  `registry clone` runs `gh repo clone`; `registry pull` runs
  `git pull --ff-only`.
- `hooks install` sets `core.hooksPath` to `.githooks`.

## Repository security composition

Secret detection runs in the workspace's own CI, not in `workspace-kit`.
Add that workflow's path to `required` so `doctor` keeps it present.

## Profiles (`init`)

- In an empty directory, `init` scaffolds an instruction skeleton with TODO
  markers, an exact local `@uinaf/workspace-kit` dev dependency, package
  scripts, and the profile's files. Run `pnpm install`, then `pnpm verify`.
- `init` never overwrites files. A re-run accepts a compatible
  `package.json` and stops before writing on an incompatible one; adopt
  those repositories with the steps above.
- A re-run keeps the existing memory configuration. Conflicting memory
  options or an unreadable config fail before scaffolding.

- `work`: AGENTS.md + CLAUDE.md symlink + package.json + docs/README.md + workspace.json.
- `personal`: work + README, `.env.example`, project-registry stub and
  lifecycle scripts, hook installer, memory/wiki skeleton and generated
  catalogs, and a `verify` pre-commit hook.
- `runtime`: personal + HEARTBEAT.md and IDENTITY.md placeholders for
  always-on runtime identities.

Personal and runtime profiles default to `llm-wiki`. The `work` profile
declares no memory strategy.

A fresh scaffold passes `verify`. Configure the ownership contract once an
origin remote and a peer exist.

Replace the `AGENTS.md` TODOs before using the workspace. The runtime profile
also creates an empty `skills/skills.json`, `.agents/skills/`, and the
`.claude/skills` link; declare and sync the runtime's skills there.

## Exact check semantics

The executable specification is the repository's
[`parity/`](https://github.com/uinaf/workspace-kit/tree/main/parity) goldens,
which the checks reproduce byte-for-byte. Deliberate quirks, such as the
frontmatter dialect, are pinned in `test/unit.test.ts`.
