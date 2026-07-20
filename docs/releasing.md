# Releasing

Publishing uses **npm Trusted Publishing (OIDC)**: GitHub Actions proves its
identity to npm per-run, npm mints a short-lived credential, and provenance
attestations are generated automatically. No npm token exists in this
repository, its secrets, or any maintainer machine's dotfiles.

## One-time setup (owner, manual — requires npm account access)

1. **Scope**: ensure the `uinaf` organization exists on npmjs.com (or the
   `@uinaf` scope is otherwise controlled by the owner account). Enable 2FA
   on the account.
2. **Register the trusted publisher** with the npm CLI (`npm trust` needs
   npm >= 11.10.0 — any current npm qualifies; on an older machine, prefix
   with `npx -y npm@latest`):

   ```
   npm login
   npm trust github @uinaf/workspace-kit \
     --repo uinaf/workspace-kit --file release.yml --env release --yes
   ```

3. **If `npm trust` refuses because the package has never been published**,
   do one manual first publish, then rerun step 2:

   ```
   git clone git@github.com:uinaf/workspace-kit.git /tmp/wk && cd /tmp/wk
   npm ci && npm publish
   ```

   `prepack` runs the full verify gate and a clean dist build;
   `publishConfig.access: public` is already set. Publish with 2FA/web
   login — do not create a long-lived automation token.
4. **Tighten the package** on npmjs.com package settings: prefer
   **trusted-publisher-only** publishing once available for the package, so
   a leaked account session cannot publish manually.
5. Optionally add protection rules (required reviewers) to the GitHub
   `release` environment — the workflow already gates on it, and its
   deployment policy only admits `v*` tag runs.

## Every release after that

```
npm version patch|minor|major   # bumps package.json + creates the v* tag
git push origin main --follow-tags
```

The tag push triggers `release.yml`, which verifies the tag matches
`package.json`, runs the verify gate, builds a clean `dist/`, and publishes
with provenance. Nothing else to do.

## Guard rails already in place

- `release.yml` refuses a tag that disagrees with `package.json`.
- `prepack` (not `prepublishOnly`) so any tarball-producing flow — publish,
  `npm pack`, git installs — always builds from a clean `dist/`.
- Verify CI audits `npm pack --dry-run` contents on every push.
- Workflow permissions are minimal (`contents: read`, `id-token: write`),
  actions are SHA-pinned, `persist-credentials: false`.
