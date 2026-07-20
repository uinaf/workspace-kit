# Contributing

## Setup

Node >= 24.18 (see `.node-version`) and git. The repo runs on the
[Vite+](https://github.com/voidzero-dev/vite-plus) toolchain (`vp`). Then:

```
pnpm install
```

This also installs the repo's git hooks (`vp config` → `.vite-hooks`).

## Validation

```
vp run verify    # vp check + vp test + vp pack + CLI smoke
vp check --fix   # fix lint/format issues
```

The pre-commit hook runs `vp staged` plus the same gate, and CI adds only
`npm pack --dry-run` on top — a local green is a real CI mirror.

Checks are parity-locked to golden outputs; read the
[parity oracle](parity/README.md) before touching any check's behavior, and
never edit a golden by hand.

## Pull requests

Branch from `main`, keep PRs scoped, use Conventional Commits, and fill the
PR template. CI must be green; `main` requires signed commits.

Releases are automatic on push to main (semantic-release, tokenless) — see
[docs/releasing.md](docs/releasing.md).
