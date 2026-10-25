# Contributing

## Setup

Needs git; [`package.json`](package.json) pins Node and pnpm. The toolchain is
[Vite+](https://github.com/voidzero-dev/vite-plus) (`vp`).

```
pnpm install --frozen-lockfile
pnpm exec vp config --no-agent   # installs the git hooks from .vite-hooks
```

Keep the hook install explicit: the published package has no install
lifecycle.

## Verify

```
pnpm exec vp run verify    # full gate; the pre-push hook runs it too
pnpm exec vp check --fix   # format and lint
```

Checks are parity-locked: read [parity/README.md](parity/README.md) before
changing a check's behavior.

## Pull requests

Use Conventional Commits; the prefix decides the release
([Releases](AGENTS.md#releases)). `main` requires green CI and signed commits.
