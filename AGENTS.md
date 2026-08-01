# AGENTS.md

Contributor guide for agents working in `uinaf/workspace-kit`.

## What this repo is

The public, config-driven CLI that validates and scaffolds agent workspaces.
This repository owns the portable mechanism and its public documentation;
consumers own their workspace policy and composition.

## Hard rules

- **This repo is public.** Never reference any consumer workspace, person,
  brand, employer, hostname, or private path — in code, fixtures, docs,
  comments, commit messages, or issues. All fixtures are synthetic
  (`fixture-owner/fixture-workspace` style).
- **Zero runtime dependencies. No postinstall scripts or telemetry.**
  Validation and scaffolding stay offline. Network access happens only through
  explicitly invoked operations: `skills sync` delegates to a pinned `skills`
  CLI, while `registry clone` and `registry pull` delegate to `gh` and `git`.
  devDependencies are allowed for build/test only.
- Supported execution environments are macOS and Linux. Windows runtime
  compatibility is outside the release contract. Continue rejecting
  Windows-shaped absolute paths as untrusted portable input.
- Keep this repository standalone. Do not add package, script, CI, checkout, or
  validation dependencies on `uinaf/agents` or `uinaf/dotfiles`. Optional
  documentation links are fine; composition belongs to the consumer.
- The scaffolder writes an owner-editable instruction skeleton and kit-owned
  validation commands. Machine-global state (`~/.claude/`, `~/.codex/`,
  `~/.agents/skills`) remains consumer-owned.
- Skill sync links local skills under `skills/`, copies declared remote skills,
  and records its remote ownership in `skills/workspace-kit-lock.json`. It
  removes retired copies only from that manager-owned record. Consumers own
  skill selection, global installation, and untracked workspace content.
- **Parity is law.** The ported validators must reproduce `parity/goldens/`
  byte-for-byte; new behavior ships config-gated and default-off. Never edit
  a golden by hand — see [parity/README.md](parity/README.md) before
  touching any check.

## Verify

The repo runs on the [Vite+](https://github.com/voidzero-dev/vite-plus)
toolchain; all tool config lives in `vite.config.ts`.

`pnpm exec vp run verify` runs `vp check` (format, lint, type check), the full
test suite with aggregate coverage across `src/`, `vp pack`, and an installed-tarball CLI
smoke. Executable source-line coverage across in-process and spawned CLI tests
stays at or above 90%. After `pnpm install`, run
`pnpm exec vp config --no-agent` to install the pre-commit hook; it runs the
repository-local `vp staged` plus the full gate. Fix issues with
`pnpm exec vp check --fix`; `parity/legacy/` and
`parity/fixtures/` are exempt from lint/format — they are frozen.

## Releases

Conventional Commits drive publishing: every push to `main` with `feat:` or
`fix:` commits auto-releases to npm (see
[docs/releasing.md](docs/releasing.md)). Choose prefixes accordingly —
`docs:`/`chore:`/`test:` publish nothing.

## Compatibility

`CLAUDE.md` is a symlink to this file. Codex reads `AGENTS.md` natively.
