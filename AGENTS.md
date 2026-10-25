# AGENTS.md

Contributor guide for agents working in `uinaf/workspace-kit`.

## What this repo is

The public, config-driven CLI that validates and scaffolds agent workspaces.
This repository owns the portable mechanism and its public documentation;
consumers own their workspace policy, composition, and machine-global state.
[docs/convention.md](docs/convention.md) describes what each command does.

## Hard rules

- **This repo is public.** Code, fixtures, docs, commits, and issues stay
  generic: no consumer workspace, person, brand, employer, hostname, or
  private path. Fixtures are synthetic (`fixture-owner/fixture-workspace`
  style).
- **Zero runtime dependencies, no install lifecycle scripts, no telemetry.**
  Validation and scaffolding run offline. Network access belongs to explicit
  commands: `skills sync` delegates to a pinned `skills` CLI, and
  `registry clone`/`registry pull` delegate to `gh` and `git`.
  devDependencies are for build and test.
- The release contract covers macOS and Linux. Windows-shaped absolute paths
  are untrusted portable input and get rejected.
- The repo stands alone: packages, scripts, CI, and validation depend on
  nothing consumer-specific.
- **Parity is law.** The ported validators reproduce `parity/goldens/`
  byte-for-byte, and new behavior ships config-gated and default-off. Goldens
  change only by regeneration; read [parity/README.md](parity/README.md)
  before touching any check.

## Verify

The repo runs on [Vite+](https://github.com/voidzero-dev/vite-plus); tool
config lives in `vite.config.ts`. Setup and hooks are in
[CONTRIBUTING.md](CONTRIBUTING.md).

- `pnpm exec vp run verify` is the full gate: `vp check`, tests with
  aggregate coverage, `vp pack`, and an installed-tarball CLI smoke.
- Line coverage across in-process and spawned CLI tests stays at or above 90%
  (`scripts/coverage.mjs`).
- `pnpm exec vp check --fix` fixes format and lint.
- Docs-only changes need no runtime proof; the pre-push hook still runs the
  gate.
- Keep `@vitest/coverage-v8` at the Vitest version from
  `pnpm exec vp toolchain vitest`, and update both through Vite+.
- `parity/legacy/` and `parity/fixtures/` are frozen and exempt from lint and
  format.

## Releases

Changes land through pull requests with `verify` required. Every push to
`main` containing `feat:` or `fix:` publishes to npm
([Releasing](CONTRIBUTING.md#releasing)); `docs:`, `chore:`, and `test:`
publish nothing, so choose the prefix deliberately.
