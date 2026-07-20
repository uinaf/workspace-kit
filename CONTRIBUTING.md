# Contributing

## Setup

Node >= 24.18 (see `.node-version`) and git. Then:

```
npm ci
```

## Validation

```
npm run verify   # typecheck + full test suite (runs on plain node, no bun)
```

Checks are parity-locked to golden outputs; read the
[parity oracle](parity/README.md) before touching any check's behavior, and
never edit a golden by hand.

## Pull requests

Branch from `main`, keep PRs scoped, use Conventional Commits, and fill the
PR template. CI must be green; `main` requires signed commits.

Releases are automatic on push to main (semantic-release, tokenless) — see
[docs/releasing.md](docs/releasing.md).
