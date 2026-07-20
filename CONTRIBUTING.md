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

The ported validators are parity-locked: `test/golden-parity.test.ts` must
reproduce every golden in `parity/goldens/` byte-for-byte. Do not change a
golden by hand — goldens only regenerate from the frozen legacy scripts via
`bun parity/capture.ts` (local-only), and legacy scripts are frozen. See
[parity/README.md](parity/README.md) before touching any check's behavior.

## Pull requests

Branch from `main`, keep PRs scoped, use Conventional Commits, and fill the
PR template. CI must be green; `main` requires signed commits.

Releases are maintainer-driven and tokenless — see
[docs/releasing.md](docs/releasing.md).
