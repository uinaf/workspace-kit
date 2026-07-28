# Encrypted content in workspaces

Some personal or runtime workspaces need versioned private notes alongside the
public workspace structure. Workspace secret scanning detects _accidental_
credentials; it does not provide confidentiality for content _intentionally_
stored in Git. The opt-in `confidential` contract closes a narrow part of that
gap: selected paths are provably ciphertext in every commit.

## Threat model

The guarantee is narrow: **declared file contents are unreadable in the Git
remote and in clones that do not hold a decryption identity.**

Explicit non-goals:

- protecting content from an already-authorized agent or process after unlock
- preventing plaintext leakage through prompts, logs, editor caches, temp
  files, backups, or screenshots
- hiding filenames, directory shape, commit messages, file sizes, or change
  timing (unless the selected provider separately supports that)
- retroactively fixing plaintext already present in Git history
- treating encrypted Git storage as an appropriate home for live credentials —
  use a secret manager or external private storage for those

## Provider comparison

|                                    | git-crypt                                                                    | SOPS + age                                                  | age directly                                | external storage          |
| ---------------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------- | ------------------------- |
| Working-tree UX                    | transparent plaintext after explicit unlock                                  | ciphertext artifacts; explicit decrypt/edit/encrypt         | ciphertext artifacts; manual lifecycle      | content never in the repo |
| Agent/wiki compatibility           | full: normal paths, links, diffs locally                                     | poor for Markdown: committed file is whole-file ciphertext  | poor: no Git lifecycle conventions          | none; pointers only       |
| Key management                     | symmetric key + optional GPG recipients; revocation does not rewrite history | age, PGP, or cloud KMS recipients; strongest rotation story | recipients only; consumer builds everything | provider-owned            |
| Metadata leakage                   | filenames, sizes, timing visible                                             | same                                                        | same                                        | least: only the pointer   |
| Failure mode the kit check catches | plaintext staged because filters/`.gitattributes` broke                      | non-envelope file staged under a declared path              | same                                        | nothing to check          |

- **[git-crypt](https://github.com/AGWA/git-crypt)** encrypts through Git
  clean/smudge filters. It is intended for a few confidential files, not most
  of a repository; recipient access cannot be meaningfully revoked from
  existing history; encrypted files lose delta compression and normal patch
  workflows; repository integrity and correct `.gitattributes` rules remain
  critical. It is the right default for workspace _notes_ because agents and
  wiki tooling keep working on ordinary files after an explicit human unlock.
- **[SOPS](https://github.com/getsops/sops) + [age](https://github.com/FiloSottile/age)**
  gives authenticated encrypted files and explicit operations with better
  recipient management. For Markdown and other arbitrary files, SOPS uses its
  binary store: the committed file is a whole-file JSON envelope, so links,
  diffs, and agents need a decrypted view outside Git. The kit contract
  accepts only whole-file envelopes — the blob parses as JSON with exactly two
  top-level keys, `data` (an `ENC[…]` value) and `sops` (metadata carrying an
  encrypted `mac`). Structured SOPS YAML/JSON, where keys and document shape
  remain visible, fails like plaintext.
- **age directly** is a fine primitive for explicit encrypted artifacts
  (a binary `age-encryption.org/v1` envelope with recipient stanzas, or
  PEM-armored output) but defines no safe Git editing lifecycle by itself;
  consumers own plaintext locations, re-encryption, and atomic replacement.
- **External private storage** (commit only sanitized pointers) remains the
  strongest default for credentials and high-risk secrets, at the cost of the
  offline, versioned, repository-native experience.

## What workspace-kit owns — and what it never does

Workspace-kit owns **validation and documentation**. It does not scaffold
encryption, orchestrate providers, manage keys or recipients, implement
cryptography, unlock, decrypt, or rewrite history. Provider choice,
identities, recipients, rotation, and recovery are consumer-owned; the kit
check never performs network access and never mutates the repository.

The check answers one question: _would the next commit store declared
protected paths as ciphertext, and is the provider policy actually wired to
guarantee that?_ It cannot prove end-to-end confidentiality — a correctly
encrypted file whose key is leaked is still compromised. Key material handling
below is a tripwire for conventional mistakes, not a substitute for the
workspace's full-history secret-scanning CI.

## The `confidential` section

```json
{
  "confidential": {
    "provider": "git-crypt",
    "paths": ["memory/private/**"]
  }
}
```

- `provider` — one of `git-crypt`, `sops`, `age`.
- `paths` — non-empty glob patterns over repository-relative paths
  (`*` within a segment, `**` across segments, `?` one character). Patterns
  match index entries case-insensitively and Unicode-normalized, so a file
  committed through a case-aliased spelling (`Memory/PRIVATE/x.md`) cannot
  dodge a declared rule on a case-sensitive host.

Absent section: no checks run (default-off). `confidential check` runs the
gate directly; `doctor` and `verify` include it whenever the section exists,
including in the scaffolded pre-commit hook.

The gate evaluates the **prospective commit's** declaration: when
`workspace.json` is staged, the staged `confidential` section selects the
checked paths and provider, so partial staging cannot talk the gate into
skipping a commit that still declares protection, and a commit that drops
the section honestly declares nothing. So does a config staged for deletion:
`git rm --cached workspace.json` stands the gate down for that commit, so
de-adoption is never blocked by the copy being removed. Unstaged config
edits take effect once staged; an untracked `workspace.json` (adoption in
progress) falls back to the worktree section. The stand-down is authorized
only when the declaration itself is being removed — a config staged for
deletion, or a staged drop of a section HEAD still carries. A sectionless
config that is merely committed or edited is the ordinary unconfigured
state, so the standalone command keeps reporting the missing contract
there. The standalone `confidential check` resolves the
staged declaration even when the worktree copy is missing or carries
unstaged broken edits — with nothing staged, a broken worktree config
surfaces its own parse error (`doctor` still requires a loadable worktree
config, like every other check). A staged config that does not parse fails
the run; unrecognized keys in it warn (additive schema evolution tolerates
them) so a typoed section name cannot quietly stand the gate down. Declared
paths must never cover `workspace.json` itself — an encrypted config file
would leave fresh clones unable to load any configuration. Declared paths
follow standard globstar semantics: `**` crosses zero or more full segments,
so `**/secret.md.age` protects a root-level `secret.md.age` too.

## What `confidential check` verifies

For every entry in the Git index whose path matches a declared pattern:

1. **Not plaintext.** The staged blob must carry the provider's ciphertext
   envelope, validated as far as each format allows offline: `\0GITCRYPT\0`
   magic for git-crypt; a parsed age v1 envelope for age — version line,
   recipient stanzas (`->` argument line, canonical raw base64 body per
   RFC 4648 §3.5 wrapped at 64 columns with its mandatory final line), the
   header-MAC terminator, and a payload
   of at least one AEAD block (16-byte nonce plus tag) — in either binary
   form (header parsed from a bounded prefix, payload proven from the blob
   size so large files are never read in full) or
   `-----BEGIN/END AGE ENCRYPTED FILE-----` armor (strict PEM whose
   canonical padded base64 body must decode to the same grammar), so a bare
   version line over readable text is
   a forgery, not ciphertext; a parsed whole-file
   `{"data":"ENC[…]","sops":{…"mac":"ENC[…]"}}` envelope for sops, with no
   other top-level keys, no duplicate members anywhere in the document
   (JSON.parse would collapse them and shadow a readable first value), and
   both values matching the full
   `ENC[AES256_GCM,data:…,iv:…,tag:…,type:str]` grammar. Full envelopes beyond
   a bounded 4 MiB read fail closed. A plaintext staged blob fails the run —
   this is the fail-closed core: it fires exactly when the consumer's tooling
   (filters, `.gitattributes`, provider setup) silently stopped encrypting.
   Inspecting the index covers both the pre-commit question ("what would be
   committed now") and the CI question ("what is committed"), because the
   index reflects HEAD plus staged changes.
2. **Provider policy coverage, versioned (git-crypt only).** Every protected
   file must resolve a git-crypt filter (`filter=git-crypt`, or a named-key
   `filter=git-crypt-<key>`) through git's own attribute engine, evaluated
   from the **index** (`git check-attr --cached`) — the policy the
   prospective commit actually carries. Worktree-only edits, untracked
   attribute files, and `skip-worktree` copies cannot leak into the
   evaluation, `attr.tree`/`GIT_ATTR_SOURCE` cannot redirect it, and the
   machine-wide system attributes file is excluded from the proof outright
   (`GIT_ATTR_NOSYSTEM`). The remaining resolution sources are local-only, so
   a `filter=git-crypt` rule in any of them — `.git/info/attributes`, the
   configured `core.attributesFile`, or its per-user default
   (`$XDG_CONFIG_HOME/git/attributes`) — fails outright: provider policy must
   never be local-only, because the resulting commit would not carry it.
   Diagnostics name the configured file only as `configured
core.attributesFile`, never its resolved absolute path. Attribute macros
   are resolved too, in both directions: a versioned `[attr]name
filter=git-crypt` definition does not launder a local-only application of
   `name`, and a versioned application of `name` does not launder a
   local-only definition completing the chain — definitions and applications
   are screened against the transitive macro closure. With local sources
   screened, an accepted coverage assignment provably comes from a staged
   `.gitattributes` file. SOPS and age have no filter layer; the artifact
   itself is the policy.
3. **Regular files only.** Symlinks and submodule gitlinks under declared
   paths fail — a link cannot be ciphertext and its target leaks metadata.
4. **No raw provider key material in the repository.** Staged blobs under
   `.git-crypt/` and at conventional key/identity filenames (`key.txt`,
   `keys.txt`, SSH identity names such as `id_ed25519`/`id_rsa`, `*.key`,
   `*.agekey`, `*.pem`, `*.asc`, `*.pgp`, `*.gpg`, `*.keyfile`) have their
   complete bounded contents screened for raw git-crypt key magic
   (`\0GITCRYPTKEY`), the `AGE-SECRET-KEY-` family — classical
   `AGE-SECRET-KEY-1` and post-quantum `AGE-SECRET-KEY-PQ-1` identities
   (age identity files permit comment lines, so detection is not
   prefix-bound), PGP private-key armor, binary OpenPGP secret-key packets
   anywhere in the packet stream (leading packets such as Markers cannot
   hide a later secret key), and PEM/OpenSSH private-key armor — age accepts SSH private keys as
   decryption identities, so a committed one is decryption-capable
   material. git-crypt's own committed artifacts pass by
   design: the `add-gpg-user` workflow stores GPG-_encrypted_ key copies
   under `.git-crypt/keys/`, which open with session-key packets, never
   secret-key packets. Public recipient files and certificates pass
   everywhere. This screen is deliberately bounded to conventional locations;
   whole-history secret detection remains the dedicated CI workflow's job.

For git-crypt, the ok line also reports the observed lock state without
changing it — `confidential ok (git-crypt, 3 protected, 2 locked, 1
unlocked)`. Locked means the worktree file itself is ciphertext (fresh clone
without the key); unlocked means the index holds ciphertext while the
worktree shows plaintext (normal state after an explicit human unlock). Both
are healthy. SOPS and age artifacts are always ciphertext on disk, so no lock
state exists.

The check reads git metadata only — blob bytes (fixed-size detection
prefixes for the git-crypt marker; a bounded envelope window, 4 MiB at
most, from which age headers parse and armor validates, with binary age
payloads proven from the blob size instead of a complete read; complete
bounded contents, 4 MiB at most, for sops envelopes, the staged config,
key-candidate scans, and attribute sources) plus index and attribute
listings. It never decrypts, never
touches live key material or keyrings, prints no file contents, and follows
the standard output contract (errors one per line on stderr, exit 1). Index
paths are contributor-controlled, so every diagnostic
quotes them (JSON string form) — a filename cannot inject extra lines or
terminal control sequences. Repository listings are bounded at 64 MiB
(roughly a million tracked paths); beyond that the gate fails with an
explicit listing error rather than evaluating a truncated protected set.
Full-content reads (config, envelopes, key scans, attribute definitions)
are bounded at 4 MiB and likewise fail closed when a blob exceeds the
bound; only fixed-size detection prefixes accept truncation.

## Limits of the evidence

- Envelope validation proves "not plaintext", not "correctly encrypted for
  the right recipients". Recipient and rotation audits belong to the
  provider's own tooling (`git-crypt status`, `sops` metadata inspection).
- Offline detection cannot distinguish real ciphertext from a _forged_
  envelope wrapped around readable content. sops and age armor are
  shape-checked end to end, but anyone can hand-write a well-formed
  `ENC[…]` string or armor frame; git-crypt offers no structure to check at
  all — after the magic, the nonce and ciphertext are indistinguishable from
  random bytes without the key. Deliberate forgery is an already-authorized
  writer problem and stays outside the threat model; the gate exists to
  catch tooling that silently stopped encrypting, not adversarial content.
- Attribute coverage is pinned to the staged tree; note the contract thereby
  approves the commit's policy, not the next `git add`'s behavior — an
  unstaged `.gitattributes` edit affects future adds, but the staged blob
  gate still fails closed on any plaintext those adds produce. The
  system-wide `etc/gitattributes` file is excluded from coverage resolution
  (`GIT_ATTR_NOSYSTEM`) rather than audited — admin-managed machine state
  stays consumer-owned, and it can no longer supply false coverage either.
- History is out of scope: the gate protects the next commit. Plaintext
  committed before adoption requires a history rewrite (see below), and
  revocation after key exposure requires rewriting history _and_ rotating the
  key — git-crypt cannot revoke readers from existing history.

## Migration and history rewrite

If content intended for protection was ever committed as plaintext, adding
the contract does not make existing history confidential. The consumer must:

1. Move the content behind the provider (for git-crypt: declare
   `.gitattributes` rules, `git-crypt init`, add recipients, then
   `git add --renormalize` so the clean filter re-stages the files as
   ciphertext).
2. Rewrite history (`git filter-repo`, or BFG) to remove the plaintext blobs,
   and force-push every remote and clone that carried them.
3. Treat the exposed content as compromised: rotate any secret it contained.

Those steps are destructive history operations and stay consumer-owned; the
kit only documents them.

## Relationship to secret scanning

The two surfaces are complementary and deliberately separate:

- **Secret scanning** (dedicated CI workflow, full history) finds _accidental_
  secrets _anywhere_ in the repository, past or present.
- **`confidential check`** (local + CI gate, config-gated) proves _intentional_
  confidential paths are ciphertext _in the next commit_, and trips on
  conventional key-material mistakes before they land.

Encrypted Git storage is for versioned private notes, not live credentials;
credentials belong in a secret manager or external private storage.
