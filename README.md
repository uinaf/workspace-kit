# workspace-kit

Config-driven **agent workspace** validation and scaffolding. Not related to
npm/yarn/pnpm workspaces or monorepo tooling.

An agent workspace is a git repository that gives coding/assistant agents a
stable operating context: a canonical instruction file, optional memory and
wiki layers, a project registry, and ownership contracts between peer
workspaces. `workspace-kit` validates that structure deterministically and
scaffolds new workspaces — it never authors instruction content and never
touches machine-global state.

```
workspace-kit doctor [--json]        # run all configured checks
workspace-kit wiki lint | stale | backfill [--dry-run]
workspace-kit contract check | peer <path> | handoff <path...>
workspace-kit links check | fix
workspace-kit docs links
workspace-kit init [--profile personal|runtime|work]
workspace-kit config validate
```

Everything is driven by a `workspace.json` at the repo root; absent sections
disable their checks, unknown files are always tolerated. See
[docs/convention.md](docs/convention.md) for the workspace convention and
every check's exact contract.

## Status

0.1.0, pre-npm-publish. All checks are implemented in `src/` and reproduce
the migration oracle byte-for-byte: `parity/` holds frozen predecessor
scripts, a synthetic fixture workspace, and golden outputs;
`test/golden-parity.test.ts` drives the kit CLI through every scenario and
diffs against the goldens. `init` profiles scaffold doctor-green workspaces
out of the box.

## Principles

- **Kit = mechanism, workspace = policy.** No defaults that encode any
  consumer's specifics; all lists live in per-workspace config.
- **Zero runtime dependencies, no postinstall, no network, no telemetry.**
  This runs inside pre-commit hooks of private repositories.
- **Tolerant by default.** Required-list plus forbidden-list; everything
  unknown is allowed. Runtimes and harnesses add their own files.
- **Extract, don't extend.** Checks are ports of proven validators; new
  checks ship off by default.

## Requirements

Node >= 24.18. Works under `npx` and `bunx`. Consumers should pin exact
versions.

## License

MIT
