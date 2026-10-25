# AGENTS.md

`uinaf/workspace-kit` is the public, config-driven CLI that validates and
scaffolds agent workspaces. It owns the portable mechanism and its docs;
consumers own workspace policy, composition, and machine-global state.
[docs/convention.md](docs/convention.md) is the user contract; it ships in
the npm package and `init` points users at it.

## Hard rules

- **This repo is public.** Code, fixtures, docs, commits, and issues stay
  generic: no consumer workspace, person, brand, employer, hostname, or
  private path. Fixtures are synthetic (`fixture-owner/fixture-workspace`).
  Packages, scripts, CI, and validation depend on nothing consumer-specific.
- **Zero runtime dependencies, no install lifecycle scripts, no telemetry.**
  Validation and scaffolding run offline. Only explicit commands touch the
  network: `skills sync` through a pinned `skills` CLI, `registry clone` and
  `registry pull` through `gh` and `git`.
- macOS and Linux only. Reject Windows-shaped absolute paths as untrusted
  input.
- **Parity is law.** The checks reproduce `parity/goldens/` byte-for-byte,
  and new behavior ships config-gated and default-off. `parity/legacy/` and
  `parity/fixtures/` are frozen; goldens change only by regeneration. Read
  [parity/README.md](parity/README.md) before touching any check.

## Verify

Setup is in [CONTRIBUTING.md](CONTRIBUTING.md#setup).

```
pnpm exec vp run verify    # full gate
pnpm exec vp check --fix   # format and lint
```

- Docs-only changes need no runtime proof.
- Keep `@vitest/coverage-v8` at the Vitest version
  `pnpm exec vp toolchain vitest` prints; update both through Vite+.

## Releases

Every push to `main` with a `feat:`, `fix:`, `perf:`, or breaking commit
publishes to npm; `docs:`, `chore:`, and `test:` publish nothing. Never move
or delete a `v*` tag.
