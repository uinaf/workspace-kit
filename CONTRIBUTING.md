# Contributing

## Setup

Needs git on PATH; [`package.json`](package.json) pins Node and pnpm. The repo
runs on the
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

The pre-commit hook runs `pnpm exec vp staged`; the pre-push hook runs the
gate.

Checks are parity-locked to golden outputs. Read the
[parity oracle](parity/README.md) before touching any check's behavior;
goldens change only by regeneration.

## Pull requests

Branch from `main`, keep PRs scoped, use Conventional Commits, and fill the
PR template. CI must be green; `main` requires signed commits.

## Releasing

Every push to `main` releases from its Conventional Commits
([`release.yml`](.github/workflows/release.yml)). Never move or delete a `v*`
tag.
