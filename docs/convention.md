# The agent workspace convention

> Status: skeleton — the full convention and per-check contracts land with
> the ported validators, before 0.1.0.

An **agent workspace** is a git repository that gives agents a stable
operating context. The convention has three layers:

1. **Instructions** — one canonical `AGENTS.md` at the repo root;
   `CLAUDE.md` is a relative symlink to it. Harness-specific runtime detail
   stays out of the canonical file.
2. **Memory (optional)** — raw daily logs (`memory/YYYY-MM-DD.md`,
   `memory/contexts/<slug>/`), consolidated notes, and a compiled wiki
   (`memory/wiki/`) whose pages carry frontmatter and form a link graph.
3. **Operations** — a project registry (JSON), operational docs, and, for
   peered workspaces, an ownership contract (`workspace.contract.json`) with
   a handoff privacy gate.

`workspace-kit` validates whichever layers a workspace declares in its
`workspace.json`. Absent sections disable their checks; unknown files are
always tolerated — harnesses and runtimes add their own state and the
tooling must not fight them.

## Check contracts

To be documented per check as the ports land (doctor, wiki lint/stale/
backfill, contract check/peer/handoff, links, docs links, init, config
validate). Until then, `parity/` in the repository holds the executable
truth: frozen legacy scripts, fixtures, and golden outputs.
