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
gate. The gate asserts the exact release tarball contents, installs that
version-stamped tarball offline without suppressing lifecycle behavior, and
exercises the installed CLI.

Checks are parity-locked to golden outputs. Read the
[parity oracle](parity/README.md) before touching any check's behavior;
goldens change only by regeneration.

## Pull requests

Branch from `main`, keep PRs scoped, use Conventional Commits, and fill the
PR template. CI must be green; `main` requires signed commits.

## Releasing

Releases are automatic and tokenless: every push to `main` runs verification
and then the shared
[uinaf release workflow](https://github.com/uinaf/.github/blob/main/.github/workflows/release-npm.yml),
pinned in `.github/workflows/release.yml`, which runs semantic-release. The
caller passes the App private key by name; the shared job binds the `release`
Environment, so GitHub injects that Environment's secret value into it.

- semantic-release computes the next version from Conventional Commits
  (`fix:` → patch, `feat:` → minor, `BREAKING CHANGE:` → major), commits the
  released `package.json` through GitHub's signed App commit API, then creates
  the `v*` tag, publishes to npm, and creates the immutable GitHub Release.
- `docs:`, `chore:`, `test:`, and other non-release commits publish nothing.
- Release version commits include `[skip ci]` so they do not re-enter
  verify/release.

Publishing uses **npm Trusted Publishing (OIDC)**: GitHub Actions proves its
identity to npm per run, and npm generates provenance attestations. No npm token exists in this repository, its secrets, or any
maintainer machine.

GitHub Releases and version commits are authored by `uinaf-ci[bot]` with a
short-lived App installation token minted in the `release` Environment.

### Versioning

- During semantic-release prepare, an `@semantic-release/exec` step commits
  the released `package.json` through GitHub's API as the authenticated App.
  GitHub signs the commit. Its sole parent is the commit `verify` passed on
  (`github.sha`), and it changes nothing but `package.json`. The step then
  fast-forwards `main` to it and switches the ephemeral checkout to it, so
  semantic-release tags that commit and publishes its `package.json`.
- A release publishes only the verified commit. It stops before preparing if
  `main` has moved past that commit. If a push lands after that check, GitHub
  rejects the fast-forward: the run fails before tagging or publishing and
  leaves `main` untouched, and a later release picks up the push.
- Full source checkouts still resolve the greater of the checked-in manifest
  and the latest reachable strict `vX.Y.Z` tag (see `src/version.ts`); builds
  bake that effective version into the CLI.
- Shallow clones and source archives fail with a tag-history instruction
  instead of silently stamping a stale placeholder.
- Look up the released version with `npm view @uinaf/workspace-kit version` or
  the latest tag when in doubt.

### Configuration

- Trusted publisher registered on npm for `@uinaf/workspace-kit`:
  repository `uinaf/workspace-kit`, workflow `release.yml`, environment
  `release`, permission `publish`.
- GitHub `release` environment restricted to `main` branch runs.
- `release` Environment holds `UINAF_CI_APP_CLIENT_ID` (variable) and
  `UINAF_CI_APP_PRIVATE_KEY` (secret) for git/GitHub writeback.
- Organization rulesets on this repository:
  - `default-branch-baseline` requires verified signatures on `main` and
    blocks its deletion and force pushes. Nobody bypasses it.
  - `default-branch-checks-release` requires status checks on `main`.
    Repository admins and `uinaf-ci` bypass it, which lets the `[skip ci]`
    version commit land.
  - `protect-release-tags` requires verified signatures on `v*` tags and
    blocks updating or deleting them. `uinaf-ci` bypasses it.
- `v0.1.0` was the one-time manual bootstrap publish (trusted publishing
  requires an existing package); it carries no provenance. Every CI-published
  version does.
- To re-register or adjust the trusted publisher (owner, requires npm login):

  ```
  npm trust github @uinaf/workspace-kit \
    --repo uinaf/workspace-kit --file release.yml --env release \
    --allow-publish --yes
  ```

- Recommended npm-side tightening: package settings → require trusted
  publisher, disabling manual publishes now that bootstrap is done.

### Guard rails

- The release job runs only after `verify` passes; on push its last step scans
  the pushed range. PRs run the same gate, unscanned, with read-only
  permissions and no environment access.
- All workflows use standard GitHub-hosted `ubuntu-26.04` runners; npm trusted
  publishing accepts cloud-hosted runners only.
- Publish concurrency is non-cancellable (queued, never killed mid-publish).
- `prepack` runs the full verify gate (which rebuilds a clean `dist/`)
  before any tarball is produced. The gate stages the effective version the
  same way semantic-release does, asserts the exact install-lifecycle-free tarball
  contents, installs it offline, and exercises its bin, scaffold, manifest
  version, and validation paths.
- Workflow permissions are per-job and minimal; actions are SHA-pinned;
  `persist-credentials: false` everywhere. The push-time scan lints changed
  workflows with actionlint and zizmor.
