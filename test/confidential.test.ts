// Fixtures for the opt-in encrypted-content contract: each supported provider
// proves protected content cannot be staged as plaintext. Ciphertext fixtures
// are synthetic provider envelopes (marker bytes); the check is marker-based
// and never decrypts, so tests need no git-crypt/sops/age binaries.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vite-plus/test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(root, "src", "cli.ts");

const GIT_CRYPT_BLOB = "\0GITCRYPT\0synthetic-ciphertext-payload";
const SOPS_ENVELOPE =
  '{"data":"ENC[AES256_GCM,data:c2VjcmV0,iv:aXY,tag:dGFn,type:str]","sops":{"kms":[],"age":[],"lastmodified":"2026-01-01T00:00:00Z","mac":"ENC[AES256_GCM,data:bWFj,iv:aXY,tag:dGFn,type:str]","version":"3.9.0"}}';
// A structurally complete age v1 envelope matching real age output: version
// line, one X25519 stanza (43-char base64 body — stanzas carry no MAC), the
// header-MAC terminator, and a payload (16-byte nonce plus at least one
// AEAD tag, so 32 bytes minimum).
const AGE_BINARY =
  "age-encryption.org/v1\n" +
  "-> X25519 qqFBlhbyT9UaMPzfGJDLvFI9x0Ujlz9kFvWT+etk+R4\n" +
  "Nz2p7fcgMpWj8j7JdcMbTBp2lWi8O5wo+VFUD7fDOJM\n" +
  "--- mMh0K8OVkFDLWfj9YdT2lN5PFdxQ2z1fYC+7TR4y2/4\n" +
  "9Xf4q2m7wJ8r3t6y1u0o5p8s2d4f6g8h0j2k4l6z8x0c2v4b6n8m0";
const AGE_ARMORED = `-----BEGIN AGE ENCRYPTED FILE-----\n${Buffer.from(AGE_BINARY, "latin1")
  .toString("base64")
  .match(/.{1,64}/g)!
  .join("\n")}\n-----END AGE ENCRYPTED FILE-----\n`;

// Hermetic per-user git state: an empty XDG config home keeps the host's
// global git attributes out of every spawn.
const emptyXdg = mkdtempSync(join(tmpdir(), "confidential-xdg-"));

function kit(cwd: string, ...args: string[]) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, XDG_CONFIG_HOME: emptyXdg },
  });
}

function git(dir: string, ...args: string[]): void {
  execFileSync("git", args, { cwd: dir, stdio: "ignore" });
}

function commitAll(dir: string): void {
  git(dir, "add", "-A");
  execFileSync(
    "git",
    ["-c", "user.email=f@example.com", "-c", "user.name=F", "commit", "-qm", "x"],
    {
      cwd: dir,
      stdio: "ignore",
    },
  );
}

function write(dir: string, relative: string, content: string): void {
  mkdirSync(dirname(join(dir, relative)), { recursive: true });
  writeFileSync(join(dir, relative), content);
}

function workspace(provider: string, paths: string[] = ["memory/private/**"]): string {
  const dir = mkdtempSync(join(tmpdir(), `confidential-${provider}-`));
  git(dir, "init", "-q");
  write(dir, "workspace.json", `${JSON.stringify({ confidential: { provider, paths } })}\n`);
  return dir;
}

test("git-crypt green: ciphertext staged, coverage declared, lock state reported", () => {
  const dir = workspace("git-crypt");
  write(dir, ".gitattributes", "memory/private/** filter=git-crypt diff=git-crypt\n");
  write(dir, "memory/private/notes.md", GIT_CRYPT_BLOB);
  commitAll(dir);

  const result = kit(dir, "confidential", "check");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "confidential ok (git-crypt, 1 protected, 1 locked, 0 unlocked)\n");
});

test("git-crypt rejects staged plaintext under a protected path", () => {
  const dir = workspace("git-crypt");
  write(dir, ".gitattributes", "memory/private/** filter=git-crypt diff=git-crypt\n");
  write(dir, "memory/private/notes.md", GIT_CRYPT_BLOB);
  commitAll(dir);

  write(dir, "memory/private/draft.md", "# accidentally committed plaintext\n");
  git(dir, "add", "memory/private/draft.md");

  const result = kit(dir, "confidential", "check");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /plaintext staged in protected path: "memory\/private\/draft\.md/);
});

test("confidential check enforces minVersion from the effective config", () => {
  const dir = workspace("age");
  write(
    dir,
    "workspace.json",
    `${JSON.stringify({
      minVersion: "999.0.0",
      confidential: { provider: "age", paths: ["memory/private/**"] },
    })}\n`,
  );
  commitAll(dir);
  const result = kit(dir, "confidential", "check");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /workspace\.json requires workspace-kit >= 999\.0\.0/);
});

test("diagnostics quote contributor-controlled paths", () => {
  const dir = workspace("git-crypt");
  write(dir, ".gitattributes", "memory/** filter=git-crypt diff=git-crypt\n");
  write(dir, "memory/private/notes.md", GIT_CRYPT_BLOB);
  commitAll(dir);

  // Index paths are contributor-controlled: a newline in a staged filename
  // must not inject extra diagnostic lines into one-error-per-line output.
  const evil = "memory/private/plain\nnot-a-new-error-line.md";
  writeFileSync(join(dir, evil), "plaintext\n");
  git(dir, "add", "--", evil);

  const result = kit(dir, "confidential", "check");
  assert.equal(result.status, 1);
  assert.ok(
    result.stderr.includes(
      'plaintext staged in protected path: "memory/private/plain\\nnot-a-new-error-line.md"',
    ),
    result.stderr,
  );
  assert.ok(!result.stderr.includes("not-a-new-error-line.md\n"), result.stderr);
});

test("git-crypt fails closed when the clean filter never ran on a large staged blob", () => {
  const dir = workspace("git-crypt");
  write(dir, ".gitattributes", "memory/private/** filter=git-crypt diff=git-crypt\n");
  write(dir, "memory/private/big.md", `\0GITCRYPT\0${"x".repeat(60000)}`);
  commitAll(dir);
  assert.equal(kit(dir, "confidential", "check").status, 0);

  write(dir, "memory/private/big.md", `# ${"plain ".repeat(8000)}\n`);
  git(dir, "add", "memory/private/big.md");
  const result = kit(dir, "confidential", "check");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /plaintext staged in protected path: "memory\/private\/big\.md/);
});

test("git-crypt reports unlocked worktree files without failing", () => {
  const dir = workspace("git-crypt");
  write(dir, ".gitattributes", "memory/private/** filter=git-crypt diff=git-crypt\n");
  write(dir, "memory/private/notes.md", GIT_CRYPT_BLOB);
  commitAll(dir);

  // Simulate an unlocked checkout: index keeps the ciphertext blob while the
  // clean filter presents plaintext in the worktree.
  write(dir, "memory/private/notes.md", "# decrypted locally\n");
  const result = kit(dir, "confidential", "check");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "confidential ok (git-crypt, 1 protected, 0 locked, 1 unlocked)\n");
});

test("git-crypt requires filter coverage for every protected file", () => {
  const dir = workspace("git-crypt");
  write(dir, ".gitattributes", "*.md filter=git-crypt diff=git-crypt\n");
  write(dir, "memory/private/notes.md", GIT_CRYPT_BLOB);
  write(dir, "memory/private/payload.bin", GIT_CRYPT_BLOB);
  commitAll(dir);

  const result = kit(dir, "confidential", "check");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /missing git-crypt filter attribute: "memory\/private\/payload\.bin/);
  assert.doesNotMatch(result.stderr, /notes\.md/);
});

test("git-crypt resolves coverage from the staged attribute policy", () => {
  const dir = workspace("git-crypt");
  write(dir, ".gitattributes", "memory/private/** filter=git-crypt diff=git-crypt\n");
  write(dir, "memory/private/notes.md", GIT_CRYPT_BLOB);
  commitAll(dir);

  // Policy staged for removal but kept untracked in the worktree: the commit
  // would carry no rule even though the worktree still resolves one.
  git(dir, "rm", "-q", "--cached", ".gitattributes");
  let result = kit(dir, "confidential", "check");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /missing git-crypt filter attribute: "memory\/private\/notes\.md/);

  // An unstaged edit does not change what the commit carries: the staged
  // version still covers, so the run stays green.
  git(dir, "reset", "-q");
  git(dir, "checkout", "--", ".gitattributes");
  write(dir, ".gitattributes", "# coverage removed locally\n");
  assert.equal(kit(dir, "confidential", "check").status, 0);

  // Staging that removal flips the prospective commit's policy to uncovered.
  git(dir, "add", ".gitattributes");
  result = kit(dir, "confidential", "check");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /missing git-crypt filter attribute/);
});

test("git-crypt ignores worktree and alternate-tree attribute injections", () => {
  const dir = workspace("git-crypt");
  write(dir, ".gitattributes", "# no rules versioned\n");
  write(dir, "memory/private/notes.md", GIT_CRYPT_BLOB);
  commitAll(dir);

  // skip-worktree hides the local rule edit from status, but not from the
  // index-pinned evaluation: the prospective commit still has no rule.
  git(dir, "update-index", "--skip-worktree", ".gitattributes");
  write(dir, ".gitattributes", "memory/private/** filter=git-crypt diff=git-crypt\n");
  let result = kit(dir, "confidential", "check");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /missing git-crypt filter attribute/);
  git(dir, "update-index", "--no-skip-worktree", ".gitattributes");
  git(dir, "checkout", "--", ".gitattributes");

  // attr.tree pointing at a tree that has the rule must not redirect the
  // index-pinned evaluation either.
  write(dir, ".gitattributes", "memory/private/** filter=git-crypt diff=git-crypt\n");
  write(dir, "memory/public.txt", "marker\n");
  git(dir, "add", "-A");
  execFileSync(
    "git",
    ["-c", "user.email=f@example.com", "-c", "user.name=F", "commit", "-qm", "with-rule"],
    { cwd: dir, stdio: "ignore" },
  );
  git(dir, "rm", "-q", "--cached", ".gitattributes");
  git(dir, "config", "attr.tree", "HEAD");
  result = kit(dir, "confidential", "check");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /missing git-crypt filter attribute/);
});

test("git-crypt rejects malformed named-key filter values", () => {
  const dir = workspace("git-crypt");
  write(dir, ".gitattributes", "memory/private/** filter=git-crypt- diff=git-crypt-\n");
  write(dir, "memory/private/notes.md", GIT_CRYPT_BLOB);
  commitAll(dir);

  const result = kit(dir, "confidential", "check");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /missing git-crypt filter attribute/);
});

test("git-crypt rejects a symlinked .gitattributes in the protected chain", () => {
  const dir = workspace("git-crypt");
  write(dir, "memory/private/notes.md", GIT_CRYPT_BLOB);
  symlinkSync("attrs-target", join(dir, ".gitattributes"));
  commitAll(dir);

  // The index blob of a symlink is its target name, which carries no rules.
  const result = kit(dir, "confidential", "check");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /missing git-crypt filter attribute/);
});

test("git-crypt rejects coverage supplied by local-only attribute sources", () => {
  const dir = workspace("git-crypt");
  write(dir, ".gitattributes", "# tracked, but no git-crypt rules\n");
  write(dir, "memory/private/notes.md", GIT_CRYPT_BLOB);
  commitAll(dir);

  // check-attr resolves the rule locally, yet nothing versioned covers the
  // path — the exact false-success class from review.
  writeFileSync(
    join(dir, ".git", "info", "attributes"),
    "memory/private/** filter=git-crypt diff=git-crypt\n",
  );
  const result = kit(dir, "confidential", "check");
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /local-only git attributes assign git-crypt filters: \.git\/info\/attributes/,
  );
});

test("git-crypt accepts named-key filter spellings in versioned policy", () => {
  const dir = workspace("git-crypt");
  write(dir, ".gitattributes", "memory/private/** filter=git-crypt-shared diff=git-crypt-shared\n");
  write(dir, "memory/private/notes.md", GIT_CRYPT_BLOB);
  commitAll(dir);

  const result = kit(dir, "confidential", "check");
  assert.equal(result.status, 0, result.stderr);
});

test("git-crypt audits local-only policy even with no matching protected files", () => {
  const dir = workspace("git-crypt");
  commitAll(dir);
  writeFileSync(join(dir, ".git", "info", "attributes"), "anything filter=git-crypt\n");
  const result = kit(dir, "confidential", "check");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /local-only git attributes assign git-crypt filters/);
  assert.match(result.stderr, /\.git\/info\/attributes/);
});

test("git-crypt tolerates unrelated local attribute rules and scans core.attributesFile", () => {
  const dir = workspace("git-crypt");
  write(dir, ".gitattributes", "memory/private/** filter=git-crypt diff=git-crypt\n");
  write(dir, "memory/private/notes.md", GIT_CRYPT_BLOB);
  commitAll(dir);

  writeFileSync(join(dir, ".git", "info", "attributes"), "*.bin -diff\n");
  const unrelated = kit(dir, "confidential", "check");
  assert.equal(unrelated.status, 0, unrelated.stderr);

  const global = join(dir, "global-attributes");
  writeFileSync(global, "*.md filter=git-crypt-custom\n");
  git(dir, "config", "core.attributesFile", global);
  const result = kit(dir, "confidential", "check");
  assert.equal(result.status, 1);
  // Diagnostics name the source by a stable label, never the resolved
  // absolute path — CI logs must not disclose local roots.
  assert.match(
    result.stderr,
    /local-only git attributes assign git-crypt filters: configured core\.attributesFile/,
  );
  assert.ok(!result.stderr.includes(global), result.stderr);
  git(dir, "config", "--unset", "core.attributesFile");
  assert.equal(kit(dir, "confidential", "check").status, 0);

  // Filenames with meaningful whitespace are read byte-exactly, like git
  // reads them: a trailing-space attributes file still cannot hide
  // local-only git-crypt policy.
  const spaced = join(dir, "global-attributes ");
  writeFileSync(spaced, "*.md filter=git-crypt-custom\n");
  git(dir, "config", "core.attributesFile", spaced);
  const whitespace = kit(dir, "confidential", "check");
  assert.equal(whitespace.status, 1);
  assert.match(
    whitespace.stderr,
    /local-only git attributes assign git-crypt filters: configured core\.attributesFile/,
  );
  git(dir, "config", "--unset", "core.attributesFile");

  // Local attribute sources are bounded like every other full-content read:
  // an oversized one fails loudly instead of exhausting memory.
  writeFileSync(join(dir, ".git", "info", "attributes"), Buffer.alloc(4 * 1024 * 1024 + 1, 0x23));
  const oversized = kit(dir, "confidential", "check");
  assert.equal(oversized.status, 1);
  assert.match(oversized.stderr, /local git attribute source exceeds the 4 MiB bound/);
});

test("an explicitly empty core.attributesFile disables the per-user file", () => {
  const dir = workspace("git-crypt");
  write(dir, ".gitattributes", "memory/private/** filter=git-crypt diff=git-crypt\n");
  write(dir, "memory/private/notes.md", GIT_CRYPT_BLOB);
  commitAll(dir);

  const xdg = mkdtempSync(join(tmpdir(), "confidential-user-xdg-"));
  mkdirSync(join(xdg, "git"), { recursive: true });
  writeFileSync(join(xdg, "git", "attributes"), "memory/** filter=git-crypt\n");
  const run = () =>
    spawnSync(process.execPath, [cli, "confidential", "check"], {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, XDG_CONFIG_HOME: xdg },
    });

  // Git keeps an explicitly empty core.attributesFile and does not fall back
  // to the default per-user file; the gate mirrors that rather than
  // rejecting versioned coverage over an unused global file.
  git(dir, "config", "core.attributesFile", "");
  const disabled = run();
  assert.equal(disabled.status, 0, disabled.stderr);

  git(dir, "config", "--unset", "core.attributesFile");
  assert.equal(run().status, 1);
});

test("git-crypt rejects local-only applications of versioned git-crypt macros", () => {
  const dir = workspace("git-crypt");
  // The macro definition is versioned, but applying it locally is still
  // local-only policy: the commit would not bind protected paths to it.
  write(dir, ".gitattributes", "[attr]confidential filter=git-crypt diff=git-crypt\n");
  write(dir, "memory/private/notes.md", GIT_CRYPT_BLOB);
  commitAll(dir);

  // Definition alone covers nothing, so the baseline fails on coverage.
  const baseline = kit(dir, "confidential", "check");
  assert.equal(baseline.status, 1);
  assert.match(baseline.stderr, /missing git-crypt filter attribute/);

  // A local-only application makes check-attr resolve the filter without any
  // versioned rule — the macro-aware scan must still refuse it.
  writeFileSync(join(dir, ".git", "info", "attributes"), "memory/** confidential\n");
  const result = kit(dir, "confidential", "check");
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /local-only git attributes assign git-crypt filters: \.git\/info\/attributes/,
  );
  assert.doesNotMatch(result.stderr, /missing git-crypt filter attribute/);

  // Applying an unrelated macro locally is not provider policy; the run fails
  // only because coverage is genuinely unspecified.
  write(
    dir,
    ".gitattributes",
    "[attr]confidential filter=git-crypt diff=git-crypt\n[attr]generated -diff\n",
  );
  git(dir, "add", ".gitattributes");
  writeFileSync(join(dir, ".git", "info", "attributes"), "memory/** generated\n");
  const unrelated = kit(dir, "confidential", "check");
  assert.equal(unrelated.status, 1);
  assert.match(unrelated.stderr, /missing git-crypt filter attribute/);
  assert.doesNotMatch(unrelated.stderr, /local-only git attributes/);
});

test("git-crypt rejects local-only macro definitions that complete versioned coverage", () => {
  const dir = workspace("git-crypt");
  // The versioned policy applies a macro it never defines; only a local-only
  // definition can complete the chain to filter=git-crypt, so coverage would
  // exist on this machine but not in fresh clones.
  write(
    dir,
    ".gitattributes",
    "[attr]encrypted filter=git-crypt diff=git-crypt\nmemory/private/** local\n",
  );
  write(dir, "memory/private/notes.md", GIT_CRYPT_BLOB);
  commitAll(dir);

  // With the name undefined, coverage honestly fails.
  const baseline = kit(dir, "confidential", "check");
  assert.equal(baseline.status, 1);
  assert.match(baseline.stderr, /missing git-crypt filter attribute/);

  // Defining the macro locally resolves coverage on this machine, but the
  // commit still carries no binding — the definition itself must be refused.
  writeFileSync(join(dir, ".git", "info", "attributes"), "[attr]local encrypted\n");
  const result = kit(dir, "confidential", "check");
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /local-only git attributes assign git-crypt filters: \.git\/info\/attributes/,
  );
});

test("git-crypt scans the default per-user global attributes file", () => {
  const dir = workspace("git-crypt");
  write(dir, ".gitattributes", "# tracked, but no git-crypt rules\n");
  write(dir, "memory/private/notes.md", GIT_CRYPT_BLOB);
  commitAll(dir);

  const xdg = mkdtempSync(join(tmpdir(), "confidential-user-xdg-"));
  mkdirSync(join(xdg, "git"), { recursive: true });
  writeFileSync(join(xdg, "git", "attributes"), "memory/** filter=git-crypt\n");
  const result = spawnSync(process.execPath, [cli, "confidential", "check"], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, XDG_CONFIG_HOME: xdg },
  });
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /local-only git attributes assign git-crypt filters: per-user global git attributes/,
  );
});

test("git-crypt rejects raw key material but allows committed GPG recipient files", () => {
  const dir = workspace("git-crypt");
  write(dir, ".gitattributes", "memory/private/** filter=git-crypt diff=git-crypt\n");
  write(dir, "memory/private/notes.md", GIT_CRYPT_BLOB);
  // The add-gpg-user workflow commits GPG-encrypted key copies by design.
  mkdirSync(join(dir, ".git-crypt", "keys", "default", "0"), { recursive: true });
  writeFileSync(
    join(dir, ".git-crypt", "keys", "default", "0", "ABCDEF0123456789.gpg"),
    Buffer.from([0x85, 0x03, ...Buffer.from("synthetic-gpg-packet", "latin1")]),
  );
  commitAll(dir);
  assert.equal(kit(dir, "confidential", "check").status, 0);

  // A raw exported symmetric key is never legitimate repository content.
  write(dir, ".git-crypt/keys/default/raw.key", "\0GITCRYPTKEYsynthetic");
  git(dir, "add", ".git-crypt/keys/default/raw.key");
  const result = kit(dir, "confidential", "check");
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /secret key material is tracked: "\.git-crypt\/keys\/default\/raw\.key"/,
  );
});

test("git-crypt rejects non-regular protected entries", () => {
  const dir = workspace("git-crypt");
  write(dir, ".gitattributes", "memory/private/** filter=git-crypt diff=git-crypt\n");
  write(dir, "memory/private/notes.md", GIT_CRYPT_BLOB);
  symlinkSync("notes.md", join(dir, "memory", "private", "alias.md"));
  commitAll(dir);

  const result = kit(dir, "confidential", "check");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /protected path is not a regular file: "memory\/private\/alias\.md/);
});

test("sops green: whole-file envelope staged; plaintext fails", () => {
  const dir = workspace("sops");
  write(dir, "memory/private/notes.md", SOPS_ENVELOPE);
  commitAll(dir);

  const green = kit(dir, "confidential", "check");
  assert.equal(green.status, 0, green.stderr);
  assert.equal(green.stdout, "confidential ok (sops, 1 protected)\n");

  write(dir, "memory/private/plain.md", "# decrypted notes\n");
  git(dir, "add", "memory/private/plain.md");
  const result = kit(dir, "confidential", "check");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /plaintext staged in protected path: "memory\/private\/plain\.md/);
});

test("sops accepts only the whole-file envelope, not lookalikes", () => {
  const dir = workspace("sops");
  write(dir, "memory/private/notes.md", SOPS_ENVELOPE);
  commitAll(dir);

  // Structured sops document: `visible` stays readable, so this is not a
  // whole-file envelope even though `data` is encrypted.
  write(
    dir,
    "memory/private/structured.json",
    '{"data":"ENC[AES256_GCM,data:eA,iv:aXY,tag:dGFn,type:str]","visible":"plaintext","sops":{"mac":"ENC[AES256_GCM,data:bWE,iv:aXY,tag:dGFn,type:str]"}}\n',
  );
  git(dir, "add", "memory/private/structured.json");
  let result = kit(dir, "confidential", "check");
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /plaintext staged in protected path: "memory\/private\/structured\.json/,
  );
  git(dir, "reset", "-q");

  // Plaintext embedding an envelope-shaped snippet must not satisfy the check.
  write(dir, "memory/private/embedded.md", '# notes\n{"data":"ENC[x","sops":{"mac":"ENC[y"}}\n');
  git(dir, "add", "memory/private/embedded.md");
  result = kit(dir, "confidential", "check");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /plaintext staged in protected path: "memory\/private\/embedded\.md/);
  git(dir, "reset", "-q");

  // An envelope without the encrypted mac is not a complete sops artifact.
  write(dir, "memory/private/nomac.md", '{"data":"ENC[x","sops":{}}\n');
  git(dir, "add", "memory/private/nomac.md");
  result = kit(dir, "confidential", "check");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /plaintext staged in protected path: "memory\/private\/nomac\.md/);
  git(dir, "reset", "-q");

  // Duplicate keys collapse in JSON.parse, so a plaintext first `data` could
  // hide behind a well-formed second one — at the top level, nested, or via
  // an escape-aliased key name.
  write(
    dir,
    "memory/private/duplicated.json",
    '{"data":"readable secret","data":"ENC[AES256_GCM,data:QQ,iv:aXY,tag:dGFn,type:str]","sops":{"mac":"ENC[AES256_GCM,data:bWE,iv:aXY,tag:dGFn,type:str]"}}\n',
  );
  write(
    dir,
    "memory/private/duplicated-nested.json",
    '{"data":"ENC[AES256_GCM,data:QQ,iv:aXY,tag:dGFn,type:str]","sops":{"comment":"readable secret","mac":"ENC[AES256_GCM,data:bWE,iv:aXY,tag:dGFn,type:str]","comment":"still readable"}}\n',
  );
  write(
    dir,
    "memory/private/duplicated-escaped.json",
    '{"\\u0064ata":"readable secret","data":"ENC[AES256_GCM,data:QQ,iv:aXY,tag:dGFn,type:str]","sops":{"mac":"ENC[AES256_GCM,data:bWE,iv:aXY,tag:dGFn,type:str]"}}\n',
  );
  git(dir, "add", "memory/private");
  result = kit(dir, "confidential", "check");
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /plaintext staged in protected path: "memory\/private\/duplicated\.json/,
  );
  assert.match(
    result.stderr,
    /plaintext staged in protected path: "memory\/private\/duplicated-nested\.json/,
  );
  assert.match(
    result.stderr,
    /plaintext staged in protected path: "memory\/private\/duplicated-escaped\.json/,
  );
  git(dir, "reset", "-q");

  // Well-formed shape but fabricated ENC[...] values are not sops output.
  write(
    dir,
    "memory/private/forged.md",
    '{"data":"ENC[not-encrypted]","sops":{"mac":"ENC[also-not]"}}\n',
  );
  git(dir, "add", "memory/private/forged.md");
  result = kit(dir, "confidential", "check");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /plaintext staged in protected path: "memory\/private\/forged\.md/);
});

test("age green: binary and armored artifacts staged; plaintext fails", () => {
  const dir = workspace("age");
  write(dir, "memory/private/notes.md.age", AGE_BINARY);
  write(dir, "memory/private/armored.md.asc", AGE_ARMORED);
  // The v1 spec exempts whitespace around the PEM block from non-canonical
  // armor rejection — including whitespace beyond the detection prefix.
  write(dir, "memory/private/whitespace.md.asc", `${" ".repeat(300)}\n  ${AGE_ARMORED}\n\n`);
  commitAll(dir);

  const green = kit(dir, "confidential", "check");
  assert.equal(green.status, 0, green.stderr);
  assert.equal(green.stdout, "confidential ok (age, 3 protected)\n");

  write(dir, "memory/private/plain.md.age", "not encrypted at all\n");
  git(dir, "add", "memory/private/plain.md.age");
  const result = kit(dir, "confidential", "check");
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /plaintext staged in protected path: "memory\/private\/plain\.md\.age/,
  );
});

test("age rejects a bare version line without a recipient stanza", () => {
  const dir = workspace("age");
  write(dir, "memory/private/fake.md.age", "age-encryption.org/v1\n\nnot really encrypted\n");
  commitAll(dir);
  const result = kit(dir, "confidential", "check");
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /plaintext staged in protected path: "memory\/private\/fake\.md\.age/,
  );
});

test("age accepts stanza bodies wrapped at 64 columns", () => {
  const dir = workspace("age");
  // A body longer than 48 bytes wraps: full 64-column lines, then a final
  // sub-64 line — here 96 bytes encode as 64 + 64, and per the ABNF the
  // stanza ends with a mandatory (here empty) final line.
  const body96 = "Y".repeat(128);
  write(
    dir,
    "memory/private/wrapped.md.age",
    "age-encryption.org/v1\n" +
      "-> X25519 qqFBlhbyT9UaMPzfGJDLvFI9x0Ujlz9kFvWT+etk+R4\n" +
      `${body96.slice(0, 64)}\n` +
      `${body96.slice(64)}\n` +
      "\n" +
      "--- mMh0K8OVkFDLWfj9YdT2lN5PFdxQ2z1fYC+7TR4y2/4\n" +
      "9Xf4q2m7wJ8r3t6y1u0o5p8s2d4f6g8h0j2k4l6z8x0c2v4b6n8m0",
  );
  commitAll(dir);

  const result = kit(dir, "confidential", "check");
  assert.equal(result.status, 0, result.stderr);
});

test("age rejects forged envelopes: stanza marker over plaintext, missing payload", () => {
  const dir = workspace("age");
  // A version line and stanza marker over readable content is a forgery,
  // not an envelope: no stanza body, MAC, terminator, or payload.
  write(dir, "memory/private/shallow.md.age", "age-encryption.org/v1\n-> X\nsecret plaintext\n");
  // A complete header proves nothing without the payload behind it.
  write(
    dir,
    "memory/private/bodiless.md.age",
    AGE_BINARY.split("\n").slice(0, 4).join("\n") + "\n",
  );
  // Armor whose decoded content is only the version line is not an envelope.
  write(
    dir,
    "memory/private/armor-fake.md.asc",
    "-----BEGIN AGE ENCRYPTED FILE-----\nYWdlLWVuY3J5cHRpb24ub3JnL3Yx\n-----END AGE ENCRYPTED FILE-----\n",
  );
  // A stanza must end with its mandatory final line, even when the body
  // wraps exactly at 64 columns — the terminator cannot follow a full body
  // line directly.
  write(
    dir,
    "memory/private/boundary.md.age",
    "age-encryption.org/v1\n" +
      "-> X25519 qqFBlhbyT9UaMPzfGJDLvFI9x0Ujlz9kFvWT+etk+R4\n" +
      `${"Y".repeat(64)}\n` +
      "--- mMh0K8OVkFDLWfj9YdT2lN5PFdxQ2z1fYC+7TR4y2/4\n" +
      "9Xf4q2m7wJ8r3t6y1u0o5p8s2d4f6g8h0j2k4l6z8x0c2v4b6n8m0",
  );
  // Armor base64 padding is canonical: stripping the required trailing `=`
  // makes the PEM non-canonical even though the payload decodes the same.
  write(
    dir,
    "memory/private/unpadded.md.asc",
    AGE_ARMORED.replace(
      /=+\n-----END AGE ENCRYPTED FILE-----/,
      "\n-----END AGE ENCRYPTED FILE-----",
    ),
  );
  // Stanza bodies are canonical raw base64: a one-character final line is an
  // impossible length, and a 3-mod-4 final line must zero its unused bits.
  write(
    dir,
    "memory/private/onechar.md.age",
    "age-encryption.org/v1\n" +
      "-> X25519 qqFBlhbyT9UaMPzfGJDLvFI9x0Ujlz9kFvWT+etk+R4\n" +
      "A\n" +
      "--- mMh0K8OVkFDLWfj9YdT2lN5PFdxQ2z1fYC+7TR4y2/4\n" +
      "9Xf4q2m7wJ8r3t6y1u0o5p8s2d4f6g8h0j2k4l6z8x0c2v4b6n8m0",
  );
  write(
    dir,
    "memory/private/noncanonical.md.age",
    "age-encryption.org/v1\n" +
      "-> X25519 qqFBlhbyT9UaMPzfGJDLvFI9x0Ujlz9kFvWT+etk+R4\n" +
      "Nz2p7fcgMpWj8j7JdcMbTBp2lWi8O5wo+VFUD7fDOJN\n" +
      "--- mMh0K8OVkFDLWfj9YdT2lN5PFdxQ2z1fYC+7TR4y2/4\n" +
      "9Xf4q2m7wJ8r3t6y1u0o5p8s2d4f6g8h0j2k4l6z8x0c2v4b6n8m0",
  );
  commitAll(dir);

  const result = kit(dir, "confidential", "check");
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /plaintext staged in protected path: "memory\/private\/shallow\.md\.age/,
  );
  assert.match(
    result.stderr,
    /plaintext staged in protected path: "memory\/private\/bodiless\.md\.age/,
  );
  assert.match(
    result.stderr,
    /plaintext staged in protected path: "memory\/private\/armor-fake\.md\.asc/,
  );
  assert.match(
    result.stderr,
    /plaintext staged in protected path: "memory\/private\/boundary\.md\.age/,
  );
  assert.match(
    result.stderr,
    /plaintext staged in protected path: "memory\/private\/unpadded\.md\.asc/,
  );
  assert.match(
    result.stderr,
    /plaintext staged in protected path: "memory\/private\/onechar\.md\.age/,
  );
  assert.match(
    result.stderr,
    /plaintext staged in protected path: "memory\/private\/noncanonical\.md\.age/,
  );
});

test("age rejects truncated or prose-filled armor lookalikes", () => {
  const dir = workspace("age");
  write(
    dir,
    "memory/private/truncated.md.asc",
    "-----BEGIN AGE ENCRYPTED FILE-----\nYWdlLWVuY3J5cHRpb24ub3JnL3Yx\n",
  );
  write(
    dir,
    "memory/private/prose.md.asc",
    "-----BEGIN AGE ENCRYPTED FILE-----\nthis is just readable prose\n-----END AGE ENCRYPTED FILE-----\n",
  );
  commitAll(dir);

  const result = kit(dir, "confidential", "check");
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /plaintext staged in protected path: "memory\/private\/truncated\.md\.asc/,
  );
  assert.match(
    result.stderr,
    /plaintext staged in protected path: "memory\/private\/prose\.md\.asc/,
  );
});

test("secret key material in conventional locations fails; public material passes", () => {
  const dir = workspace("age");
  write(dir, "memory/private/notes.md.age", AGE_BINARY);
  write(dir, "recipients.txt", "age1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq\n");
  write(dir, "tls.pem", "-----BEGIN CERTIFICATE-----\nc3ludGhldGlj\n-----END CERTIFICATE-----\n");
  commitAll(dir);
  assert.equal(kit(dir, "confidential", "check").status, 0);

  write(dir, "backup.agekey", "# created: 2026-01-01\nAGE-SECRET-KEY-1QQQQQQQQQQ\n");
  git(dir, "add", "backup.agekey");
  const result = kit(dir, "confidential", "check");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /secret key material is tracked: "backup\.agekey"/);
});

test("the age-keygen default identity filename is screened", () => {
  const dir = workspace("age");
  write(dir, "memory/private/notes.md.age", AGE_BINARY);
  write(dir, "key.txt", "# created: 2026-01-01\nAGE-SECRET-KEY-1QQQQQQQQQQ\n");
  commitAll(dir);

  const result = kit(dir, "confidential", "check");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /secret key material is tracked: "key\.txt"/);
});

test("declared paths match index entries across case aliases", () => {
  const dir = workspace("git-crypt");
  write(dir, ".gitattributes", "memory/** filter=git-crypt diff=git-crypt\n");
  write(dir, "Memory/PRIVATE/Note.md", "# plaintext through an alias spelling\n");
  commitAll(dir);

  const result = kit(dir, "confidential", "check");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /plaintext staged in protected path: "Memory\/PRIVATE\/Note\.md"/);
});

test("empty protected set is green and reported", () => {
  const dir = workspace("sops");
  write(dir, "README.md", "# public\n");
  commitAll(dir);
  const result = kit(dir, "confidential", "check");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "confidential ok (sops, 0 protected)\n");
});

test("confidential check requires the section and a git repository", () => {
  const dir = mkdtempSync(join(tmpdir(), "confidential-bare-"));
  write(dir, "workspace.json", "{}\n");
  const missing = kit(dir, "confidential", "check");
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /workspace\.json has no confidential section/);

  write(dir, "workspace.json", '{"confidential":{"provider":"age","paths":["x/**"]}}\n');
  const notGit = kit(dir, "confidential", "check");
  assert.equal(notGit.status, 1);
  assert.match(notGit.stderr, /could not list tracked files/);

  const repo = mkdtempSync(join(tmpdir(), "confidential-sectionless-"));
  git(repo, "init", "-q");
  write(repo, "workspace.json", "{}\n");
  const sectionless = kit(repo, "confidential", "check");
  assert.equal(sectionless.status, 1);
  assert.match(sectionless.stderr, /workspace\.json has no confidential section/);

  // A committed sectionless config is the steady state, not a staged
  // stand-down: nothing is in flight, so the command reports the missing
  // contract instead of succeeding.
  commitAll(repo);
  const steady = kit(repo, "confidential", "check");
  assert.equal(steady.status, 1);
  assert.match(steady.stderr, /workspace\.json has no confidential section/);

  // Staging an unrelated edit to that sectionless config is not a section
  // drop either — nothing confidential was ever declared, so the stand-down
  // is not authorized.
  write(repo, "workspace.json", '{"unrelated": true}\n');
  git(repo, "add", "workspace.json");
  const unrelated = kit(repo, "confidential", "check");
  assert.equal(unrelated.status, 1);
  assert.match(unrelated.stderr, /workspace\.json has no confidential section/);

  // An unstaged adoption edit is not a declaration: the prospective commit
  // still carries no section, so the command must never report success
  // without having checked anything.
  git(repo, "reset", "-q");
  write(repo, "workspace.json", '{"confidential":{"provider":"age","paths":["x/**"]}}\n');
  const unstagedAdoption = kit(repo, "confidential", "check");
  assert.equal(unstagedAdoption.status, 1);
  assert.match(unstagedAdoption.stderr, /workspace\.json has no confidential section/);

  const usage = kit(dir, "confidential", "unlock");
  assert.equal(usage.status, 2);
});

test("the gate evaluates the declaration staged for the prospective commit", () => {
  const dir = workspace("age");
  write(dir, "memory/private/notes.md.age", AGE_BINARY);
  commitAll(dir);

  // Partial staging: the staged config declares the section while the
  // worktree edit drops it. The commit would carry the declaration, so the
  // gate must still run against it.
  write(dir, "memory/private/plain.md.age", "not encrypted\n");
  git(dir, "add", "memory/private/plain.md.age");
  write(dir, "workspace.json", "{}\n");
  const staged = kit(dir, "confidential", "check");
  assert.equal(staged.status, 1);
  assert.match(
    staged.stderr,
    /plaintext staged in protected path: "memory\/private\/plain\.md\.age/,
  );

  // The reverse: the staged config drops the section while the worktree keeps
  // it, so the prospective commit honestly declares nothing and the gate
  // stands down.
  git(dir, "checkout", "--", "workspace.json");
  git(dir, "rm", "-q", "--cached", "memory/private/plain.md.age");
  write(dir, "workspace.json", "{}\n");
  git(dir, "add", "workspace.json");
  write(
    dir,
    "workspace.json",
    '{"confidential":{"provider":"age","paths":["memory/private/**"]}}\n',
  );
  const inactive = kit(dir, "confidential", "check");
  assert.equal(inactive.status, 0, inactive.stderr);
  assert.match(
    inactive.stdout,
    /confidential ok \(no confidential section in staged workspace\.json\)/,
  );

  // A broken staged config fails the run instead of silently standing down,
  // even when the worktree copy is valid.
  write(dir, "workspace.json", "{ not json\n");
  git(dir, "add", "workspace.json");
  write(
    dir,
    "workspace.json",
    '{"confidential":{"provider":"age","paths":["memory/private/**"]}}\n',
  );
  const broken = kit(dir, "confidential", "check");
  assert.equal(broken.status, 1);
  assert.match(broken.stderr, /staged workspace\.json is not a valid workspace config/);
});

test("an untracked config falls back to the worktree section during adoption", () => {
  const dir = mkdtempSync(join(tmpdir(), "confidential-adopt-"));
  git(dir, "init", "-q");
  write(dir, "workspace.json", '{"confidential":{"provider":"age","paths":["memory/**"]}}\n');
  write(dir, "memory/notes.md.age", "not encrypted\n");
  git(dir, "add", "memory/notes.md.age");

  const result = kit(dir, "confidential", "check");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /plaintext staged in protected path: "memory\/notes\.md\.age"/);
});

test("a config staged for deletion stands the gate down for de-adoption", () => {
  const dir = workspace("age");
  write(dir, "memory/private/notes.md.age", AGE_BINARY);
  commitAll(dir);

  // The prospective commit carries no declaration at all: the gate must not
  // enforce the worktree copy it is removing, even against staged plaintext.
  git(dir, "rm", "-q", "--cached", "workspace.json");
  write(dir, "memory/private/plain.md.age", "plaintext\n");
  git(dir, "add", "memory/private/plain.md.age");
  const result = kit(dir, "confidential", "check");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "confidential ok (workspace.json staged for deletion)\n");

  // Committing the deletion returns the command to the plain no-config
  // state: no staged entry, no HEAD copy, no worktree fallback.
  rmSync(join(dir, "workspace.json"));
  commitAll(dir);
  const after = kit(dir, "confidential", "check");
  assert.equal(after.status, 1);
  assert.match(after.stderr, /missing workspace\.json/);
});

test("declared paths must not cover the configuration file itself", () => {
  const dir = workspace("git-crypt", ["*.json", "memory/private/**"]);
  write(dir, ".gitattributes", "** filter=git-crypt diff=git-crypt\n");
  write(dir, "memory/private/notes.md", GIT_CRYPT_BLOB);
  commitAll(dir);

  const result = kit(dir, "confidential", "check");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /confidential paths must not cover workspace\.json/);
});

test("non-ASCII declared paths survive the staged config read", () => {
  // The staged workspace.json is a JSON blob: decoding it as bytes instead of
  // UTF-8 would mangle literal non-ASCII patterns and silently skip their
  // index paths.
  const dir = workspace("age", ["memory/özel/**"]);
  write(dir, "memory/özel/secret.md.age", AGE_BINARY);
  commitAll(dir);

  write(dir, "memory/özel/note.md", "plaintext\n");
  git(dir, "add", "memory/özel/note.md");
  const result = kit(dir, "confidential", "check");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /plaintext staged in protected path: "memory\/özel\/note\.md"/);
});

test("SSH private keys are screened as age-decryption identities", () => {
  const dir = workspace("age");
  write(dir, "memory/private/notes.md.age", AGE_BINARY);
  // Public halves and non-identity names stay out of the tripwire.
  write(dir, "id_ed25519.pub", "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5 synthetic\n");
  commitAll(dir);
  assert.equal(kit(dir, "confidential", "check").status, 0);

  // age accepts ssh-ed25519/ssh-rsa private keys as decryption identities, so
  // a committed one is decryption-capable key material.
  write(
    dir,
    "id_ed25519",
    "-----BEGIN OPENSSH PRIVATE KEY-----\nsynthetic\n-----END OPENSSH PRIVATE KEY-----\n",
  );
  git(dir, "add", "id_ed25519");
  const ssh = kit(dir, "confidential", "check");
  assert.equal(ssh.status, 1);
  assert.match(ssh.stderr, /secret key material is tracked: "id_ed25519"/);
  git(dir, "rm", "-q", "--cached", "id_ed25519");

  // PEM-armored RSA/EC/PKCS#8 forms trip at conventional key filenames.
  write(
    dir,
    "backup.key",
    "-----BEGIN RSA PRIVATE KEY-----\nsynthetic\n-----END RSA PRIVATE KEY-----\n",
  );
  git(dir, "add", "backup.key");
  const pem = kit(dir, "confidential", "check");
  assert.equal(pem.status, 1);
  assert.match(pem.stderr, /secret key material is tracked: "backup\.key"/);
});

test("declared globstar paths protect zero-segment matches", () => {
  // `**/secret.md.age` declares protection at any depth, including the
  // repository root: a globstar that demanded a directory would leave
  // root-level plaintext outside the gate.
  const dir = workspace("age", ["**/secret.md.age"]);
  write(dir, "memory/private/ok.md.age", AGE_BINARY);
  commitAll(dir);

  write(dir, "secret.md.age", "plaintext\n");
  git(dir, "add", "secret.md.age");
  const result = kit(dir, "confidential", "check");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /plaintext staged in protected path: "secret\.md\.age"/);
});

test("armored PGP private keys fail even after leading text", () => {
  const dir = workspace("age");
  write(dir, "memory/private/notes.md.age", AGE_BINARY);
  commitAll(dir);

  // A BOM, blank line, or comment must not hide the armor marker — the
  // bounded content scan is unanchored like the PEM and age checks.
  write(
    dir,
    "backup.asc",
    "\uFEFFexported with gpg --export-secret-keys\n\n-----BEGIN PGP PRIVATE KEY BLOCK-----\nsynthetic\n",
  );
  git(dir, "add", "backup.asc");
  const result = kit(dir, "confidential", "check");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /secret key material is tracked: "backup\.asc"/);
});

test("age identity files are scanned past the detection prefix", () => {
  const dir = workspace("age");
  write(dir, "memory/private/notes.md.age", AGE_BINARY);
  commitAll(dir);

  // Identity files permit comment lines; a secret past the prefix bound must
  // still fail — the file was already named like key material.
  write(dir, "key.txt", `${"# comment\n".repeat(40)}AGE-SECRET-KEY-1SYNTHETIC\n`);
  git(dir, "add", "key.txt");
  const result = kit(dir, "confidential", "check");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /secret key material is tracked: "key\.txt"/);
});

test("post-quantum age identities are screened like classical ones", () => {
  const dir = workspace("age");
  write(dir, "memory/private/notes.md.age", AGE_BINARY);
  // Public PQ recipients (age1pq1…) are not key material.
  write(dir, "recipient.txt", `age1pq1${"synthetic".repeat(20)}\n`);
  commitAll(dir);
  assert.equal(kit(dir, "confidential", "check").status, 0);

  // age-keygen -pq (age v1.3+) emits AGE-SECRET-KEY-PQ-1 identities, and its
  // conventional output name is key.txt — decryption-capable material.
  write(
    dir,
    "key.txt",
    "# created: 2026-01-01T00:00:00Z\n# public key: age1pq1synthetic\nAGE-SECRET-KEY-PQ-1SYNTHETIC\n",
  );
  git(dir, "add", "key.txt");
  const result = kit(dir, "confidential", "check");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /secret key material is tracked: "key\.txt"/);
});

test("a valid staged config governs over a missing or broken worktree copy", () => {
  const dir = workspace("age");
  write(dir, "memory/private/notes.md.age", AGE_BINARY);
  commitAll(dir);

  // Unstaged broken edits do not mask the staged declaration.
  write(dir, "workspace.json", "{ not json\n");
  assert.equal(kit(dir, "confidential", "check").status, 0);

  // Neither does deleting the worktree copy while it stays staged.
  rmSync(join(dir, "workspace.json"));
  assert.equal(kit(dir, "confidential", "check").status, 0);

  // The staged gate still fails closed on staged plaintext.
  write(dir, "memory/private/plain.md.age", "plaintext\n");
  git(dir, "add", "memory/private/plain.md.age");
  const failing = kit(dir, "confidential", "check");
  assert.equal(failing.status, 1);
  assert.match(failing.stderr, /plaintext staged in protected path/);

  // With nothing staged, a broken worktree config is the adoption fallback
  // and surfaces its own error rather than a section complaint.
  const fresh = mkdtempSync(join(tmpdir(), "confidential-broken-"));
  git(fresh, "init", "-q");
  write(fresh, "workspace.json", "{ not json\n");
  const broken = kit(fresh, "confidential", "check");
  assert.equal(broken.status, 1);
  assert.match(broken.stderr, /workspace\.json is not valid JSON/);
});

test("unrecognized keys in the staged config warn without failing", () => {
  const dir = workspace("age");
  write(dir, "memory/private/notes.md.age", AGE_BINARY);
  commitAll(dir);

  // A typoed section name in the staged copy honestly declares nothing, but
  // the stand-down must be loud: additive schema evolution tolerates unknown
  // keys, so they warn instead of failing.
  write(
    dir,
    "workspace.json",
    '{"confidentail":{"provider":"age","paths":["memory/private/**"]}}\n',
  );
  git(dir, "add", "workspace.json");
  const typo = kit(dir, "confidential", "check");
  assert.equal(typo.status, 0, typo.stderr);
  assert.equal(typo.stdout, "confidential ok (no confidential section in staged workspace.json)\n");
  assert.match(
    typo.stderr,
    /warning: staged workspace\.json has unrecognized key "confidentail" \(ignored by this kit version\)/,
  );
  const doctor = JSON.parse(kit(dir, "doctor", "--json").stdout);
  assert.equal(doctor.warnings, 1);

  // Config keys are contributor-controlled: a newline in a staged key must
  // not inject forged diagnostic lines (same inert encoding as index paths).
  write(
    dir,
    "workspace.json",
    '{"confidential":{"provider":"age","paths":["memory/private/**"]},"bad\\nkey":true}\n',
  );
  git(dir, "add", "workspace.json");
  const injected = kit(dir, "confidential", "check");
  assert.ok(injected.stderr.includes('has unrecognized key "bad\\nkey"'), injected.stderr);
  assert.ok(!injected.stderr.includes("bad\nkey"), injected.stderr);

  // Unknown sibling keys next to a real section keep the gate active.
  write(
    dir,
    "workspace.json",
    '{"confidential":{"provider":"age","paths":["memory/private/**"]},"future":true}\n',
  );
  git(dir, "add", "workspace.json");
  write(dir, "memory/private/plain.md.age", "plaintext\n");
  git(dir, "add", "memory/private/plain.md.age");
  const active = kit(dir, "confidential", "check");
  assert.equal(active.status, 1);
  assert.match(active.stderr, /plaintext staged in protected path/);
  assert.match(active.stderr, /warning: staged workspace\.json has unrecognized key "future"/);
});

test("key-material scans fail closed when the candidate exceeds the read bound", () => {
  const dir = workspace("age");
  write(dir, "memory/private/notes.md.age", AGE_BINARY);
  commitAll(dir);

  // A candidate larger than the bounded read cannot be fully screened, so
  // the gate must fail loudly instead of evaluating a truncated prefix.
  write(dir, "keys.txt", `${"# padding\n".repeat(500_000)}AGE-SECRET-KEY-1SYNTHETIC\n`);
  git(dir, "add", "keys.txt");
  const result = kit(dir, "confidential", "check");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /could not inspect staged blob/);
});

test("binary OpenPGP secret key exports are rejected; recipient packets pass", () => {
  const dir = workspace("git-crypt");
  write(dir, ".gitattributes", "memory/private/** filter=git-crypt diff=git-crypt\n");
  write(dir, "memory/private/notes.md", GIT_CRYPT_BLOB);
  // The add-gpg-user workflow commits session-packet ciphertext by design
  // (raw bytes: an old-format tag-1 packet header, 0x85, with a 25-byte body).
  mkdirSync(join(dir, ".git-crypt", "keys", "default", "0"), { recursive: true });
  writeFileSync(
    join(dir, ".git-crypt", "keys", "default", "0", "ABCDEF0123456789.gpg"),
    Buffer.from([0x85, 0x00, 0x19, ...Buffer.from("synthetic-session-packets", "latin1")]),
  );
  commitAll(dir);
  assert.equal(kit(dir, "confidential", "check").status, 0);

  // A raw binary secret-key export leads with a secret-key packet (0x95,
  // old format, 16-byte body).
  writeFileSync(join(dir, "backup.gpg"), Buffer.from([0x95, 0x00, 0x10, ...Buffer.alloc(16)]));
  git(dir, "add", "backup.gpg");
  const result = kit(dir, "confidential", "check");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /secret key material is tracked: "backup\.gpg"/);
  git(dir, "rm", "-q", "--cached", "backup.gpg");

  // Leading packets cannot hide a later secret-key packet: the packet stream
  // is parsed, not prefix-sniffed. Here an old-format Marker packet (tag 10)
  // precedes the secret-key packet.
  writeFileSync(
    join(dir, "marker.gpg"),
    Buffer.from([
      0xa8,
      0x03,
      ...Buffer.from("PGP", "latin1"),
      0x95,
      0x00,
      0x10,
      ...Buffer.alloc(16),
    ]),
  );
  git(dir, "add", "marker.gpg");
  const prefixed = kit(dir, "confidential", "check");
  assert.equal(prefixed.status, 1);
  assert.match(prefixed.stderr, /secret key material is tracked: "marker\.gpg"/);
  git(dir, "rm", "-q", "--cached", "marker.gpg");

  // A bare tag byte or a truncated packet is malformed, not key material:
  // the packet body must be complete before classification. A well-formed
  // new-format secret packet (0xc5, one-octet length) still fails.
  writeFileSync(join(dir, "bare.gpg"), Buffer.from([0xc5]));
  writeFileSync(join(dir, "truncated.gpg"), Buffer.from([0x95, 0x00, 0x10, ...Buffer.alloc(4)]));
  git(dir, "add", "bare.gpg", "truncated.gpg");
  const malformed = kit(dir, "confidential", "check");
  assert.equal(malformed.status, 0, malformed.stderr);
  git(dir, "rm", "-q", "--cached", "bare.gpg", "truncated.gpg");

  writeFileSync(join(dir, "newformat.gpg"), Buffer.from([0xc5, 0x0e, ...Buffer.alloc(14)]));
  git(dir, "add", "newformat.gpg");
  const newFormat = kit(dir, "confidential", "check");
  assert.equal(newFormat.status, 1);
  assert.match(newFormat.stderr, /secret key material is tracked: "newformat\.gpg"/);
  git(dir, "rm", "-q", "--cached", "newformat.gpg");

  // A partial-body run must terminate in a final definite chunk: a secret
  // packet abandoned after one partial chunk is malformed, not key
  // material; the completed sequence still fails.
  writeFileSync(join(dir, "abandoned.gpg"), Buffer.from([0xc5, 0xe0, 0x00]));
  git(dir, "add", "abandoned.gpg");
  const abandoned = kit(dir, "confidential", "check");
  assert.equal(abandoned.status, 0, abandoned.stderr);
  git(dir, "rm", "-q", "--cached", "abandoned.gpg");

  writeFileSync(join(dir, "partial.gpg"), Buffer.from([0xc5, 0xe0, 0xaa, 0x02, 0xbb, 0xcc]));
  git(dir, "add", "partial.gpg");
  const partial = kit(dir, "confidential", "check");
  assert.equal(partial.status, 1);
  assert.match(partial.stderr, /secret key material is tracked: "partial\.gpg"/);
});

test("doctor and verify include the confidential gate only when configured", () => {
  const dir = workspace("git-crypt");
  write(dir, ".gitattributes", "memory/private/** filter=git-crypt diff=git-crypt\n");
  write(dir, "memory/private/notes.md", GIT_CRYPT_BLOB);
  commitAll(dir);

  const doctor = kit(dir, "doctor", "--json");
  assert.equal(doctor.status, 0, doctor.stderr);
  const report = JSON.parse(doctor.stdout);
  assert.equal(report.checks.confidential, "ok");

  write(dir, "memory/private/draft.md", "plaintext\n");
  git(dir, "add", "memory/private/draft.md");
  const failing = kit(dir, "verify", "--json");
  assert.equal(failing.status, 1);
  assert.equal(failing.stderr, "");
  const failed = JSON.parse(failing.stdout);
  assert.equal(failed.checks.confidential, "fail");
  assert.ok(
    failed.errors.some((line: string) =>
      line.includes('plaintext staged in protected path: "memory/private/draft.md"'),
    ),
  );

  const plain = mkdtempSync(join(tmpdir(), "confidential-off-"));
  git(plain, "init", "-q");
  write(plain, "workspace.json", "{}\n");
  const off = JSON.parse(kit(plain, "doctor", "--json").stdout);
  assert.equal(off.checks.confidential, undefined);
});
