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

## 2. Wiki (optional)

`"wiki": {}` adopts a Markdown wiki that agents maintain: one page per topic,
an index, and an optional log. `root` sets its directory (default `docs`).

- Every `.md` page under the root is linked from `<root>/index.md`, except
  `index.md` and `log.md`.
- Relative links and `[[wikilinks]]` in every page resolve. A wikilink
  resolves page-relative, then root-relative, with `.md` appended when it has
  no extension. Code spans and fenced blocks are ignored.
- When `<root>/log.md` exists, each `## ` heading reads
  `## [YYYY-MM-DD] summary` and dates never go backwards.
- The `registry.pointers.dir` tree is skipped; it carries its own index.

Without `wiki`, the kit runs no memory checks. A runtime that keeps its own
memory files (for example OpenClaw's `memory/YYYY-MM-DD.md` logs and
`MEMORY.md`) omits `wiki`; those files stay ordinary authored content.

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
2. Pin `packageManager` in `package.json` to an exact `pnpm@` version and add
   a `verify` script that runs `workspace-kit verify`.
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
  - `registry.pointers.dir` enables `registry pointers`: it writes a
    `README.md` index and one `<category>.md` per registry category, one line
    per entry. Link the index from `AGENTS.md` so agents load only the
    category they need. Category names must be safe file names. A rerun
    deletes stale category files that carry the generated marker and keeps
    every other file.
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
    "pointers": { "dir": "docs/projects" }, // needs registry.project
  },
  "wiki": { "root": "docs" },
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
- Every list is workspace policy; the kit ships no consumer defaults.
- `allowedOwners` matches the first segment of each repository path. Each
  `mustContain` pair requires exactly one entry with that repository and
  mode. `maxEntries` counts entries across all categories; zero means an
  intentionally empty registry.

## Output contract

- Errors print one per line to stderr and exit 1 (one parity-locked
  exception: a green handoff prints the eligible paths as a list); success
  prints a terse
  `<check> ok`; usage errors exit 2.
- `doctor --json` and `verify --json` each emit exactly one newline-terminated
  `{"status","failed","warnings","checks","errors"}` object on stdout and keep
  stderr empty, including configuration and operational failures. The object
  never includes file-content excerpts.
- Checks are deterministic, offline, and credential-free.
- `contract peer` reads history and needs a full clone (`fetch-depth: 0` in
  CI).
- `verify` validates `workspace.json`, runs the configured `doctor` checks,
  `registry validate` when `registry.project` exists,
  `registry pointers --check` when `registry.pointers` exists and the
  registry is valid.
- `registry pointers --check` prints each pending `would write` or
  `would delete` to stderr and exits 1 when any exist.
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
- A re-run keeps the existing wiki choice. `--wiki` against a config without
  `wiki`, or an unreadable config, fails before scaffolding.

- `work`: a launch-directory home repo with no personal files. AGENTS.md +
  CLAUDE.md symlink + package.json + docs/README.md + workspace.json, an empty
  `projects.json` with no owner allowlist, its lifecycle scripts, and
  generated pointers in `docs/projects/`.
- `personal`: work + README, `.env.example`, handoff policy, hook installer,
  and a `verify` pre-commit hook.
- `runtime`: personal + HEARTBEAT.md and IDENTITY.md placeholders for
  always-on runtime identities.

No profile declares a wiki by default. `--wiki` replaces `docs/README.md`
with `docs/index.md` and `docs/log.md`, sets `"wiki": { "root": "docs" }`, and
adds a Knowledge section to `AGENTS.md` on how agents maintain the wiki.

A fresh scaffold passes `verify`. Configure the ownership contract once an
origin remote and a peer exist.

Replace the `AGENTS.md` TODOs before using the workspace. The runtime profile
also creates an empty `skills/skills.json`, `.agents/skills/`, and the
`.claude/skills` link; declare and sync the runtime's skills there.

## Exact check semantics

The executable specification is the repository's
[`parity/`](https://github.com/uinaf/workspace-kit/tree/main/parity) goldens,
which the contract and handoff checks reproduce byte-for-byte. Deliberate
quirks are pinned in `test/unit.test.ts`.
