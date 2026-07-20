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
- Parity is law until 0.1.0: ported validators must reproduce
  `parity/goldens/` byte-for-byte. Do not change a golden without changing
  the legacy script that generates it — and legacy scripts are frozen except
  for the two recorded fixes (missing `log.md` crash; hardcoded `bun`
  spawn).

## Layout

- `parity/legacy/` — frozen validator scripts (bun) captured from the
  originating workspaces; provenance in `parity/README.md`.
- `parity/fixtures/` — synthetic fixture workspaces (green and seeded-error).
- `parity/goldens/` — captured legacy outputs; regenerate only via
  `parity/capture.ts` (requires bun locally; CI never runs legacy scripts).
- `src/` — the ported TypeScript (erasableSyntaxOnly; compiled to `dist/`).
- `docs/convention.md` — the public workspace convention and check
  contracts.

## Verify

`npm run verify` — typecheck + node --test. Run it before any commit.
Conventional Commits (`feat:`, `fix:`, `docs:`, `test:`, `chore:`).

## Compatibility

`CLAUDE.md` is a symlink to this file. Codex reads `AGENTS.md` natively.
