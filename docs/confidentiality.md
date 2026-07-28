# Confidential Git content

`workspace-kit` can opt a workspace into a narrow confidentiality check for
selected Git paths. The first supported provider is
[git-crypt](https://github.com/AGWA/git-crypt). The kit validates the proposed
Git index; it never installs, initializes, unlocks, locks, encrypts, decrypts,
or manages keys for the provider.

## Guarantee

With this config:

```json
{
  "minVersion": "0.12.0",
  "confidential": {
    "provider": "git-crypt",
    "roots": ["memory/private"]
  }
}
```

and this staged root `.gitattributes` rule:

```gitattributes
memory/private/** filter=git-crypt diff=git-crypt
```

`confidential check`, `doctor`, and `verify` fail unless every tracked index
entry below the `memory/private` directory:

- is a regular file with no unresolved index conflict;
- has effective cached `filter=git-crypt` and `diff=git-crypt` attributes; and
- starts with git-crypt's ciphertext envelope.

The roots are literal, portable, repository-relative directory paths, not glob
patterns. They must be non-empty, non-overlapping, and free of whitespace. A
root cannot start with `#` or `!`, which are `.gitattributes` syntax. A
tracked file or symbolic link at the root path is invalid; protected entries
live below it. Each root must also have the exact
`<root>/** filter=git-crypt diff=git-crypt` policy in the staged root
`.gitattributes`, even before it contains tracked files. Put the complete block
of canonical confidential root rules after every other attribute rule, so
later patterns cannot override protected descendants. Nested roots cannot have
tracked `.gitattributes` files in directories between the repository root and
the confidential root; deeper attribute precedence would make an all-future-
descendants guarantee impossible to prove offline.
Roots also cannot traverse a tracked file, symbolic link, or submodule entry;
every ancestor component must be a repository directory.

The check reads raw index objects and cached attributes through Git. It does
not run a clean/smudge filter, text conversion, or a provider command. It
evaluates the union of worktree, staged, and committed
`confidential.roots`, so staging a config addition or removal cannot bypass the
current check. Errors include escaped filenames but never file content.
Protected index or attribute metadata above 64 MiB fails closed with an
explicit validation-limit error.

This is accidental-plaintext and policy-drift evidence, not cryptographic
attestation. The envelope test is the same marker used by
[git-crypt's own status implementation](https://github.com/AGWA/git-crypt/blob/master/commands.cpp);
it does not authenticate ciphertext, prove that a recipient can decrypt it, or
inspect older commits.

## Threat model

The supported guarantee is that selected file contents are unreadable in the
Git remote and in clones without a decryption identity, provided the provider
was configured correctly and the repository and its attributes are trusted.

The contract does not:

- protect content from an authorized agent or process after unlock;
- prevent plaintext leakage through prompts, logs, editors, temporary files,
  caches, backups, screenshots, or other local tooling;
- hide filenames, directory shape, commit messages, file size, equality, or
  change timing;
- remove plaintext already committed to Git history;
- provide repository integrity or protect against an attacker who can change
  the config, attributes, hooks, or protected branch;
- make encrypted Git storage suitable for live credentials, private keys, or
  high-risk secrets.

Keep credentials in the workspace's external secret provider. Keep
full-history secret detection enabled as a separate control.

## Adoption

1. Audit the complete repository history. If protected content was previously
   committed as plaintext, rewrite and re-audit history before relying on this
   contract.
2. Install and initialize git-crypt using the consumer's own provider
   procedure. Select recipients, identities, recovery copies, and any required
   repository-integrity policy outside workspace-kit.
3. Add and stage the root `.gitattributes` rules before adding confidential
   content. Do not encrypt `.gitattributes`, `workspace.json`, `.gitignore`,
   `.gitmodules`, hooks, or `.git-crypt/` metadata.
4. Add `confidential` to `workspace.json` and set `minVersion` to the first
   published workspace-kit release that supports the contract.
5. Stage the proposed content and policy, then run:

   ```bash
   npm exec -- workspace-kit confidential check
   npm run verify
   ```

6. Run `verify` in CI and require that check before merge. Personal and runtime
   scaffolds already run `verify` from their generated pre-commit hook; adopted
   workspaces must wire their own hook to the same local package command.

Opting out is intentionally a two-commit migration. First remove the
`confidential` section while keeping the staged provider policy and ciphertext;
the committed config still protects those roots during that transition. After
that commit, a second commit may remove the policy and migrate the files.

This is a staged-index guard, not an immutable repository policy. A clean
post-commit checkout where the section is already absent is default-off and
does not reconstruct retired policy from history. Protect changes to
`workspace.json`, `.gitattributes`, and the verification workflow with normal
review and branch rules; CI validates snapshots where the contract remains
declared.

The check works in locked CI clones without git-crypt or a decryption identity.
An unlocked checkout can continue to expose ordinary plaintext files to agents
and editors while Git stages ciphertext.

Do not put protected Markdown under configured wiki, documentation-link, or
backfill source roots unless those checks deliberately run only while the
workspace is unlocked. The confidentiality check is locked-safe; plaintext
content validators are not.

## Ownership

workspace-kit owns the config parser, staged-policy and index-envelope checks,
CLI integration, sanitized diagnostics, and this public contract.

The consumer owns the provider installation and version, initialization,
`.gitattributes`, protected-root selection, recipients, identities, unlocking,
locking, recovery, history migration, CI enforcement, repository integrity,
and incident response. The kit never mutates any of those surfaces.

## Alternatives

| Approach                                           | Decision                                                                                                                                                                                                                                                                                                                                |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| git-crypt                                          | Supported first because an explicitly unlocked checkout preserves ordinary paths and Markdown workflows. Its [documented limitations](https://github.com/AGWA/git-crypt#limitations) include visible metadata, poor fit for most of a repository, difficult revocation, lost delta compression, and unreliable third-party Git clients. |
| [SOPS with age](https://github.com/getsops/sops)   | Deferred. SOPS has stronger recipient and key-management options, but arbitrary Markdown uses its binary-file representation and needs an explicit decrypted view or edit workflow.                                                                                                                                                     |
| [age directly](https://github.com/FiloSottile/age) | Deferred. age is a good explicit encryption primitive, but it does not define the repository's plaintext location, edit, re-encryption, and atomic replacement lifecycle.                                                                                                                                                               |
| External private storage                           | Preferred for credentials and high-risk material. Pointer or metadata validation would be a different contract from encrypted Git content.                                                                                                                                                                                              |

Future providers should extend the discriminated `provider` contract only when
workspace-kit can define an equally narrow, offline, non-destructive check
without taking ownership of keys or decryption.
