# Releasing

Releases are **fully automatic**: every push to `main` runs verification and
then semantic-release, which computes the next version from Conventional
Commits (`fix:` → patch, `feat:` → minor, `BREAKING CHANGE:` → major),
commits the released `package.json` through GitHub's signed App commit API,
then creates the `v*` tag, publishes to npm, and creates the immutable GitHub
Release. Commits that don't warrant a
release (`docs:`, `chore:`, `test:`, …) publish nothing. Release version commits
include `[skip ci]` so they do not re-enter verify/release.

Publishing uses **npm Trusted Publishing (OIDC)**: GitHub Actions proves its
identity to npm per-run and provenance attestations are generated
automatically. No npm token exists in this repository, its secrets, or any
maintainer machine.

GitHub Release and version push-back commits are authored by
`uinaf-releaser[bot]` via a short-lived App installation token minted in the
`release` Environment (`UINAF_RELEASE_APP_CLIENT_ID` /
`UINAF_RELEASE_APP_PRIVATE_KEY`). The `protect-main` and
`protect-release-tags` rulesets require verified signatures. The release App
can create protected release tags but cannot bypass the default-branch rule.

## Versioning

During semantic-release prepare, the workflow commits the released
`package.json` through GitHub's API as the authenticated App. GitHub signs the
commit, and semantic-release creates the tag from that commit before publishing.
Full source checkouts still resolve the greater of the checked-in manifest and
the latest reachable strict `vX.Y.Z` tag (see `src/version.ts`); builds bake
that effective version into the CLI. Shallow clones and source archives fail
with a tag-history instruction instead of silently stamping a stale
placeholder. Look up the released version with
`npm view @uinaf/workspace-kit version` or the latest tag when in doubt.

## Configuration record (already done)

- Trusted publisher registered on npm for `@uinaf/workspace-kit`:
  repository `uinaf/workspace-kit`, workflow `release.yml`, environment
  `release`, permission `publish`.
- GitHub `release` environment restricted to `main` branch runs.
- `release` Environment holds `UINAF_RELEASE_APP_CLIENT_ID` (variable) and
  `UINAF_RELEASE_APP_PRIVATE_KEY` (secret) for git/GitHub writeback.
- The release-tag ruleset allows `uinaf-releaser` to create tags; the
  default-branch ruleset has no bypass actors.
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

## Guard rails

- The release job runs only after verification and secret scanning pass. PRs
  run the same gates with read-only permissions and no environment access.
- Publish concurrency is non-cancellable (queued, never killed mid-publish).
- `prepack` runs the full verify gate (which rebuilds a clean `dist/`)
  before any tarball is produced. The gate stages the effective version the
  same way semantic-release does, asserts the exact install-lifecycle-free tarball
  contents, installs it offline, and exercises its bin, scaffold, manifest
  version, and validation paths.
- Workflow permissions are per-job and minimal; actions are SHA-pinned;
  `persist-credentials: false` everywhere. The workflows themselves are
  linted by actionlint + zizmor in CI (`actions-lint.yml`).
