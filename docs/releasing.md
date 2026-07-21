# Releasing

Releases are **fully automatic**: every push to `main` runs verification and
then semantic-release, which computes the next version from Conventional
Commits (`fix:` → patch, `feat:` → minor, `BREAKING CHANGE:` → major),
publishes to npm, and creates the `v*` tag and GitHub release with notes.
Commits that don't warrant a release (`docs:`, `chore:`, `test:`, …) publish
nothing.

Publishing uses **npm Trusted Publishing (OIDC)**: GitHub Actions proves its
identity to npm per-run and provenance attestations are generated
automatically. No npm token exists in this repository, its secrets, or any
maintainer machine.

## Versioning is tag-only

The `main` ruleset requires signed commits, so there are no bot bump-back
commits: the checked-in `package.json` version is **not authoritative**.
Full source checkouts use the greater of that placeholder and the latest
reachable strict `vX.Y.Z` tag; builds bake that effective version into the CLI.
Shallow clones and source archives fail with a tag-history instruction instead
of silently stamping the placeholder version.
Semantic-release derives the next version, stamps `package.json` before the
prepack gate, and therefore bakes the release version into the published
tarball. Look up the released version with
`npm view @uinaf/workspace-kit version` or the latest tag, not package.json.

## Configuration record (already done)

- Trusted publisher registered on npm for `@uinaf/workspace-kit`:
  repository `uinaf/workspace-kit`, workflow `release.yml`, environment
  `release`, permission `publish`.
- GitHub `release` environment restricted to `main` branch runs.
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

- The release job runs only after the in-workflow verify job passes; PRs are
  verified separately with read-only permissions and no environment access.
- Publish concurrency is non-cancellable (queued, never killed mid-publish).
- `prepack` runs the full verify gate (which rebuilds a clean `dist/`)
  before any tarball is produced. The gate stages the effective version the
  same way semantic-release does, asserts the exact install-lifecycle-free tarball
  contents, installs it offline, and exercises its bin, scaffold, manifest
  version, and validation paths.
- Workflow permissions are per-job and minimal; actions are SHA-pinned;
  `persist-credentials: false` everywhere. The workflows themselves are
  linted by actionlint + zizmor in CI (`actions-lint.yml`).
