# AGENTS.md

Contributor guide for agents working in `uinaf/workspace-kit`.

## What this repo is

The public, config-driven CLI that validates and scaffolds agent workspaces.
The design spec and consumer decisions live outside this repo; this repo owns
the mechanism and its public documentation only.

## Hard rules

- **This repo is public.** Never reference any consumer workspace, person,
  brand, employer, hostname, or private path — in code, fixtures, docs,
  comments, commit messages, or issues. All fixtures are synthetic
  (`fixture-owner/fixture-workspace` style).
- **Zero runtime dependencies. No postinstall scripts. No network calls, no
  telemetry.** devDependencies are allowed for build/test only.
- The kit never authors instruction content and never touches machine-global
  state (`~/.claude/`, `~/.codex/`, `~/.agents/skills`).
- **Parity is law.** The ported validators must reproduce `parity/goldens/`
  byte-for-byte; new behavior ships config-gated and default-off. Never edit
  a golden by hand — see [parity/README.md](parity/README.md) before
  touching any check.

## Verify

The repo runs on the [Vite+](https://github.com/voidzero-dev/vite-plus)
toolchain; all tool config lives in `vite.config.ts`.

`vp run verify` runs `vp check` (format, lint, type check), `vp test run`,
`vp pack`, and a CLI smoke. The pre-commit hook (installed by `vp config`
on `pnpm install`) runs `vp staged` plus the full gate. Fix issues with
`vp check --fix`; `parity/legacy/` and `parity/fixtures/` are exempt from
lint/format — they are frozen.

## Releases

Conventional Commits drive publishing: every push to `main` with `feat:` or
`fix:` commits auto-releases to npm (see
[docs/releasing.md](docs/releasing.md)). Choose prefixes accordingly —
`docs:`/`chore:`/`test:` publish nothing.

## Compatibility

`CLAUDE.md` is a symlink to this file. Codex reads `AGENTS.md` natively.
