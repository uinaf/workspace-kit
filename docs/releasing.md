# Releasing

Publishing uses **npm Trusted Publishing (OIDC)**: GitHub Actions proves its
identity to npm per-run, npm mints a short-lived credential, and provenance
attestations are generated automatically. No npm token exists in this
repository, its secrets, or any maintainer machine's dotfiles.

## One-time setup (owner, manual — requires npm account access)

1. **Scope**: ensure the `uinaf` organization exists on npmjs.com (or the
   `@uinaf` scope is otherwise controlled by the owner account). Enable 2FA
   on the account.
2. **First publish** (trusted publishing configuration lives on a package's
   settings page, so the package must exist once):

   ```
   git clone git@github.com:uinaf/workspace-kit.git /tmp/wk && cd /tmp/wk
   npm ci && npm publish
   ```

   `prepack` runs the full verify gate and a clean dist build;
   `publishConfig.access: public` is already set. Publish with 2FA/web
   login — do not create a long-lived automation token.
3. **Configure the trusted publisher** on
   npmjs.com → package `@uinaf/workspace-kit` → Settings → Trusted
   publisher → GitHub Actions:
   - Organization: `uinaf`
   - Repository: `workspace-kit`
   - Workflow filename: `release.yml`
   - Environment: `release`
4. **Tighten the package**: in the same settings, set publishing access to
   "Require two-factor authentication or an automation or granular access
   token" → prefer **"Trusted publisher only"** once available for the
   package, so a leaked account session cannot publish manually.
5. Optionally add protection rules (required reviewers) to the GitHub
   `release` environment — the workflow already gates on it.

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
