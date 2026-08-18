# Contributing

## Setup

Node >= 24.18 (see `.node-version`) with Corepack enabled, and git. The repo runs on the
[Vite+](https://github.com/voidzero-dev/vite-plus) toolchain (`vp`). Then:

```
pnpm install --frozen-lockfile
pnpm exec vp config --no-agent
```

The second command installs the repo's git hooks from `.vite-hooks`. It stays
explicit so the published package has no consumer install lifecycle.

## Validation

```
pnpm exec vp run verify    # checks + tests + pack + installed-tarball CLI smoke
pnpm exec vp check --fix   # fix lint/format issues
```

The pre-commit hook runs `pnpm exec vp staged` plus the same gate. The gate asserts the
exact release tarball contents, installs that version-stamped tarball offline
without suppressing lifecycle behavior, and exercises the installed CLI.

Checks are parity-locked to golden outputs; read the
[parity oracle](parity/README.md) before touching any check's behavior, and
never edit a golden by hand.

## Pull requests

Branch from `main`, keep PRs scoped, use Conventional Commits, and fill the
PR template. CI must be green; `main` requires signed commits.

Releases are automatic on push to main (semantic-release, tokenless); see
[docs/releasing.md](docs/releasing.md).
