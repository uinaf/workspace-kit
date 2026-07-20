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

Pre-release. The `parity/` directory holds the migration oracle: frozen
legacy validator scripts, synthetic fixture workspaces, and golden outputs
that the ported implementation must reproduce byte-for-byte before 0.1.0.

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
