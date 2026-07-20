# Contributing

## Setup

Node >= 24.18 (see `.node-version`) and git. Then:

```
npm ci
```

This also configures the repo's git hooks (`core.hooksPath .githooks`).

## Validation

```
npm run verify   # typecheck + tests + build + CLI smoke (plain node, no bun)
```

The pre-commit hook runs the same gate, and CI adds only `npm pack --dry-run`
on top — a local green is a real CI mirror.

Checks are parity-locked to golden outputs; read the
[parity oracle](parity/README.md) before touching any check's behavior, and
never edit a golden by hand.

## Pull requests

Branch from `main`, keep PRs scoped, use Conventional Commits, and fill the
PR template. CI must be green; `main` requires signed commits.

Releases are automatic on push to main (semantic-release, tokenless) — see
[docs/releasing.md](docs/releasing.md).
