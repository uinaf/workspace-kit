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
  Validation and scaffolding stay offline. The explicitly invoked `skills sync`
  command is the only networked path and delegates to a pinned `skills` CLI.
  devDependencies are allowed for build/test only.
- Keep this repository standalone. Do not add package, script, CI, checkout, or
  validation dependencies on `uinaf/agents` or `uinaf/dotfiles`. Optional
  documentation links are fine; composition belongs to the consumer.
- The scaffolder writes an owner-editable instruction skeleton and kit-owned
  validation commands. Machine-global state (`~/.claude/`, `~/.codex/`,
  `~/.agents/skills`) remains consumer-owned.
- Skill sync may link only local skills under `skills/` and copy only remote
  skills explicitly declared in `skills/skills.json`. It must never choose
  skills, install them globally, or remove undeclared workspace content.
- **Parity is law.** The ported validators must reproduce `parity/goldens/`
  byte-for-byte; new behavior ships config-gated and default-off. Never edit
  a golden by hand — see [parity/README.md](parity/README.md) before
  touching any check.

## Verify

The repo runs on the [Vite+](https://github.com/voidzero-dev/vite-plus)
toolchain; all tool config lives in `vite.config.ts`.

`vp run verify` runs `vp check` (format, lint, type check), the full test suite
with focused workspace-skill coverage, `vp pack`, and an installed-tarball CLI
smoke. Skill statements, functions, and lines stay at or above 90%; branch
coverage stays pragmatic at 75%. After `pnpm install`, run
`vp config --no-agent` to install the pre-commit hook; it runs `vp staged` plus
the full gate. Fix issues with `vp check --fix`; `parity/legacy/` and
`parity/fixtures/` are exempt from lint/format — they are frozen.

## Releases

Conventional Commits drive publishing: every push to `main` with `feat:` or
`fix:` commits auto-releases to npm (see
[docs/releasing.md](docs/releasing.md)). Choose prefixes accordingly —
`docs:`/`chore:`/`test:` publish nothing.

## Compatibility

`CLAUDE.md` is a symlink to this file. Codex reads `AGENTS.md` natively.
