// The opt-in confidential-content contract. Default OFF — golden parity proves
// that. Fixtures are synthetic: git-crypt's on-disk framing is reproduced
// directly so the checks stay offline and need no provider installed.
import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { confidentialReport } from "../src/checks/confidential.ts";
import { parseWorkspaceConfig, type ConfidentialConfig } from "../src/config.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(root, "src", "cli.ts");

const CONFIG: ConfidentialConfig = { provider: "git-crypt", paths: ["memory/private/**"] };

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });
}

function put(dir: string, path: string, content: string | Buffer): void {
  mkdirSync(join(dir, dirname(path)), { recursive: true });
  writeFileSync(join(dir, path), content);
}

// git-crypt ciphertext: the file magic plus a 12-byte nonce and a payload.
function ciphertext(payload = "opaque"): Buffer {
  return Buffer.concat([
    Buffer.from("\0GITCRYPT\0", "latin1"),
    Buffer.alloc(12, 7),
    Buffer.from(payload),
  ]);
}

function keyMaterial(): Buffer {
  return Buffer.concat([Buffer.from("\0GITCRYPTKEY", "latin1"), Buffer.alloc(136, 3)]);
}

function workspace(options: { attributes?: string; config?: unknown } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "confidential-"));
  git(dir, "init", "-q");
  writeFileSync(
    join(dir, "workspace.json"),
    JSON.stringify({ confidential: options.config ?? CONFIG }),
  );
  writeFileSync(
    join(dir, ".gitattributes"),
    options.attributes ?? "memory/private/** filter=git-crypt diff=git-crypt\n",
  );
  put(dir, "memory/private/notes.md", ciphertext());
  git(dir, "add", "-A");
  return dir;
}

function errors(dir: string): string[] {
  return confidentialReport(CONFIG, dir).errors;
}

function kit(cwd: string, ...args: string[]) {
  return spawnSync(process.execPath, [cli, ...args], { cwd, encoding: "utf8" });
}

test("a covered, encrypted protected path passes and reports its scope", () => {
  const dir = workspace();
  const report = confidentialReport(CONFIG, dir);
  assert.deepEqual(report.errors, []);
  assert.equal(report.protectedPaths, 1);

  const result = kit(dir, "confidential", "check");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "confidential ok (git-crypt, 1 protected path)\n");
});

// The acceptance fixture: protected content cannot be staged as plaintext.
test("protected content staged as plaintext fails closed", () => {
  const dir = workspace();
  put(dir, "memory/private/leak.md", "the actual secret sentence\n");
  git(dir, "add", "memory/private/leak.md");

  assert.deepEqual(errors(dir), ["protected path is staged as plaintext: memory/private/leak.md"]);

  const result = kit(dir, "confidential", "check");
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  // The check reports paths, never content.
  assert.ok(!result.stderr.includes("actual secret"), result.stderr);
});

test("a pre-commit gate blocks `git commit -a` on its temporary index", () => {
  const dir = workspace();
  git(dir, "-c", "user.email=f@example.com", "-c", "user.name=F", "commit", "-qm", "seed");
  // A locked clone holds ciphertext; overwriting it with plaintext and using
  // `commit -a` stages the plaintext through a temporary index that the
  // repository's default index never sees.
  put(dir, "memory/private/notes.md", "plaintext overwrite of an encrypted note\n");
  const hook = join(dir, ".git", "hooks", "pre-commit");
  writeFileSync(hook, `#!/bin/sh\nexec ${process.execPath} ${cli} confidential check\n`);
  chmodSync(hook, 0o755);

  const result = spawnSync(
    "git",
    ["-c", "user.email=f@example.com", "-c", "user.name=F", "commit", "-aqm", "second"],
    { cwd: dir, encoding: "utf8" },
  );
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /staged as plaintext: memory\/private\/notes\.md/);
  assert.equal(git(dir, "rev-list", "--count", "HEAD").trim(), "1");
});

test("an index outside this repository is refused rather than trusted", () => {
  const dir = workspace();
  const foreign = mkdtempSync(join(tmpdir(), "confidential-foreign-"));
  const result = spawnSync(process.execPath, [cli, "confidential", "check"], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, GIT_INDEX_FILE: join(foreign, "index") },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /GIT_INDEX_FILE points outside this repository/);
});

test("policy drift is reported from the index, not from a literal rule scan", () => {
  // A nested override that turns the filter off is invisible to a root-level
  // string scan but resolves correctly through git's own attribute engine.
  const dir = workspace();
  put(dir, "memory/private/.gitattributes", "notes.md !filter !diff\n");
  put(dir, "memory/private/notes.md", "no longer encrypted\n");
  git(dir, "add", "-A");
  assert.deepEqual(errors(dir), [
    "protected path must not cover Git or workspace policy: memory/private/.gitattributes",
    "protected path is not covered by git-crypt policy: memory/private/notes.md",
  ]);
});

test("an [attr] macro and a quoted pattern still count as coverage", () => {
  const dir = workspace({
    attributes: '[attr]crypt filter=git-crypt diff=git-crypt\n"memory/private/**" crypt\n',
  });
  assert.deepEqual(errors(dir), []);
});

test("a pattern matching no tracked content fails instead of passing quietly", () => {
  const dir = mkdtempSync(join(tmpdir(), "confidential-empty-"));
  git(dir, "init", "-q");
  writeFileSync(join(dir, ".gitattributes"), "memory/private/** filter=git-crypt\n");
  git(dir, "add", "-A");
  assert.deepEqual(errors(dir), ["no tracked content matches protected path: memory/private/**"]);
});

test("uncommitted policy is reported even when the content looks encrypted", () => {
  const dir = mkdtempSync(join(tmpdir(), "confidential-untracked-"));
  git(dir, "init", "-q");
  writeFileSync(join(dir, ".gitattributes"), "memory/private/** filter=git-crypt\n");
  put(dir, "memory/private/notes.md", ciphertext());
  git(dir, "add", "memory/private/notes.md");
  // Index-resolved attributes are the trust boundary: a rule that is only in
  // the working tree protects nothing in a clone.
  assert.deepEqual(errors(dir), [
    "git-crypt policy is not committed: no tracked .gitattributes",
    "protected path is not covered by git-crypt policy: memory/private/notes.md",
  ]);
});

test("tracked git-crypt key material is rejected wherever it sits", () => {
  const dir = workspace();
  put(dir, "backup/exported.key", keyMaterial());
  put(dir, "docs/notes.md", "The header GITCRYPTKEY appears in prose here.\n");
  git(dir, "add", "-A");
  // The prose mention is a grep candidate whose header disproves it.
  assert.deepEqual(errors(dir), ["git-crypt key material is tracked: backup/exported.key"]);
});

test("a key committed inside a protected path is named as key material", () => {
  const dir = workspace();
  put(dir, "memory/private/default.key", keyMaterial());
  git(dir, "add", "-A");
  assert.deepEqual(errors(dir), ["git-crypt key material is tracked: memory/private/default.key"]);
});

test("git-crypt coverage outside the declared set is reported", () => {
  const dir = workspace({
    attributes: "memory/private/** filter=git-crypt\nnotes/** filter=git-crypt\n",
  });
  put(dir, "notes/stray.md", ciphertext());
  git(dir, "add", "-A");
  assert.deepEqual(errors(dir), ["git-crypt covers an undeclared path: notes/stray.md"]);
});

test("a case variant of a declared path is treated as protected", () => {
  // On a case-insensitive host git folds the spelling and its own matcher keeps
  // the file covered; on a case-sensitive host the kit must catch it, because
  // the same commit would otherwise be plaintext for a collaborator.
  const dir = workspace();
  const oid = execFileSync("git", ["-C", dir, "hash-object", "-w", "--stdin"], {
    encoding: "utf8",
    input: "case-variant plaintext",
  }).trim();
  git(dir, "update-index", "--add", "--cacheinfo", "100644", oid, "memory/Private/notes.md");
  // Where git folds case it reports uncovered content as plaintext; where it
  // does not, the same commit is simply outside the policy. Either way it fails.
  assert.deepEqual(errors(dir).length, 1, errors(dir).join("; "));
  assert.match(
    errors(dir)[0]!,
    /^protected path is (staged as plaintext|not covered by git-crypt policy): memory\/Private\/notes\.md$/,
  );
});

test("a symbolic link at a protected path fails closed", () => {
  const dir = workspace();
  const target = execFileSync("git", ["-C", dir, "hash-object", "-w", "--stdin"], {
    encoding: "utf8",
    input: "../elsewhere",
  }).trim();
  git(dir, "update-index", "--add", "--cacheinfo", "120000", target, "memory/private/link.md");
  assert.deepEqual(errors(dir), ["protected path is not a regular file: memory/private/link.md"]);
});

test("a submodule at a protected root is reported", () => {
  const dir = workspace();
  // The gitlink replaces the directory, so the protected content now lives in
  // another repository's history where this contract does not reach.
  git(dir, "rm", "-q", "-r", "--cached", "memory/private");
  git(dir, "update-index", "--add", "--cacheinfo", "160000", "1".repeat(40), "memory/private");
  assert.ok(
    errors(dir).includes("protected content is inside a tracked submodule: memory/private"),
    errors(dir).join("; "),
  );
});

test("large protected blobs are verified from their header alone", () => {
  const dir = workspace();
  // Past the batch limit, so this exercises the bounded single-object read.
  put(dir, "memory/private/archive.bin", ciphertext("x".repeat(3_000_000)));
  put(dir, "memory/private/leak.bin", "p".repeat(3_000_000));
  git(dir, "add", "-A");
  assert.deepEqual(errors(dir), ["protected path is staged as plaintext: memory/private/leak.bin"]);
});

test("policy from an untracked info/attributes is not accepted as coverage", () => {
  const dir = workspace();
  // A tracked `[attr]` macro lets this file grant coverage without ever naming
  // the provider, so any effective line is rejected rather than interpreted.
  put(
    dir,
    ".gitattributes",
    "[attr]crypt filter=git-crypt diff=git-crypt\nmemory/private/** crypt\n",
  );
  put(dir, ".git/info/attributes", "# comment\n\nmemory/other/** crypt\n");
  git(dir, "add", "-A");
  assert.deepEqual(errors(dir), [
    "attribute policy comes from an untracked source: info/attributes",
  ]);

  put(dir, ".git/info/attributes", "# only comments and blank lines\n\n");
  assert.deepEqual(errors(dir), []);
});

test("policy from the user's global attributes file is not accepted as coverage", () => {
  const dir = workspace({ attributes: "unrelated.txt text\n" });
  const globalAttributes = join(dir, "global-attributes");
  writeFileSync(globalAttributes, "memory/private/** filter=git-crypt\n");
  git(dir, "config", "core.attributesFile", globalAttributes);
  assert.deepEqual(errors(dir), [
    "protected path is not covered by git-crypt policy: memory/private/notes.md",
  ]);
});

test("a named git-crypt key counts as coverage", () => {
  const dir = workspace({
    attributes: "memory/private/** filter=git-crypt-personal diff=git-crypt-personal\n",
  });
  assert.deepEqual(errors(dir), []);
});

test("a submodule under a wildcard protected route is reported", () => {
  const dir = mkdtempSync(join(tmpdir(), "confidential-wildcard-"));
  git(dir, "init", "-q");
  writeFileSync(join(dir, ".gitattributes"), "teams/*/private/** filter=git-crypt\n");
  put(dir, "teams/beta/private/notes.md", ciphertext());
  git(dir, "add", "-A");
  git(dir, "update-index", "--add", "--cacheinfo", "160000", "1".repeat(40), "teams/acme");

  const config: ConfidentialConfig = { provider: "git-crypt", paths: ["teams/*/private/**"] };
  assert.deepEqual(confidentialReport(config, dir).errors, [
    "protected content is inside a tracked submodule: teams/acme",
  ]);
});

test("the check runs from a subdirectory without narrowing its scope", () => {
  const dir = workspace();
  put(dir, "memory/private/leak.md", "plaintext\n");
  git(dir, "add", "-A");
  mkdirSync(join(dir, "docs"), { recursive: true });
  // Both the check itself and the CLI resolve the top level: git would
  // otherwise evaluate pathspecs and attributes relative to the subdirectory.
  assert.deepEqual(confidentialReport(CONFIG, join(dir, "docs")).errors, [
    "protected path is staged as plaintext: memory/private/leak.md",
  ]);
  const result = kit(join(dir, "docs"), "confidential", "check");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /staged as plaintext: memory\/private\/leak\.md/);
});

test("an unmerged protected path is unverifiable rather than green", () => {
  const dir = workspace();
  const oid = execFileSync("git", ["-C", dir, "hash-object", "-w", "--stdin"], {
    encoding: "utf8",
    input: "conflicting plaintext",
  }).trim();
  git(dir, "rm", "-q", "--cached", "memory/private/notes.md");
  const info = ["100644 ", oid, " 1\tmemory/private/notes.md"].join("");
  execFileSync("git", ["-C", dir, "update-index", "--index-info"], { input: `${info}\n` });
  assert.deepEqual(errors(dir), [
    "protected path is unmerged and cannot be verified: memory/private/notes.md",
  ]);
});

test("doctor and verify include the check only when the section exists", () => {
  const dir = workspace();
  writeFileSync(
    join(dir, "workspace.json"),
    JSON.stringify({ required: ["workspace.json"], confidential: CONFIG }),
  );
  git(dir, "add", "-A");

  const green = kit(dir, "doctor", "--json");
  assert.equal(green.status, 0, green.stderr);
  assert.equal(JSON.parse(green.stdout).checks.confidential, "ok");

  put(dir, "memory/private/leak.md", "plaintext\n");
  git(dir, "add", "-A");
  const failed = kit(dir, "verify", "--json");
  assert.equal(failed.status, 1);
  const parsed = JSON.parse(failed.stdout);
  assert.equal(parsed.checks.confidential, "fail");
  assert.equal(parsed.status, "fail");
  assert.ok(
    parsed.errors.includes("protected path is staged as plaintext: memory/private/leak.md"),
    failed.stdout,
  );
  assert.equal(failed.stderr, "");

  writeFileSync(join(dir, "workspace.json"), JSON.stringify({ required: ["workspace.json"] }));
  const without = kit(dir, "doctor", "--json");
  assert.equal(without.status, 0, without.stderr);
  assert.ok(!("confidential" in JSON.parse(without.stdout).checks));
});

test("an absent section makes the explicit command a configuration error", () => {
  const dir = workspace();
  writeFileSync(join(dir, "workspace.json"), JSON.stringify({}));
  const result = kit(dir, "confidential", "check");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /workspace\.json has no confidential section/);
  assert.equal(kit(dir, "confidential").status, 2);
  assert.equal(kit(dir, "confidential", "check", "--json").status, 2);
});

test("config parsing rejects unsupported providers and unusable path lists", () => {
  assert.deepEqual(parseWorkspaceConfig({ confidential: CONFIG }).confidential, {
    provider: "git-crypt",
    paths: ["memory/private/**"],
  });
  assert.deepEqual(
    parseWorkspaceConfig({
      confidential: { provider: "git-crypt", paths: ["./memory\\private/**"] },
    }).confidential?.paths,
    ["memory/private/**"],
  );

  const rejected: Array<[unknown, RegExp]> = [
    [[], /confidential must be an object/],
    [{ paths: ["a"] }, /confidential\.provider must be a non-empty string/],
    [{ provider: "sops", paths: ["a"] }, /confidential\.provider must be git-crypt/],
    [{ provider: "git-crypt" }, /confidential\.paths must be an array of strings/],
    [{ provider: "git-crypt", paths: [] }, /confidential\.paths must be a non-empty array/],
    [{ provider: "git-crypt", paths: ["a", "a"] }, /confidential\.paths must not contain dup/],
    [{ provider: "git-crypt", paths: ["a", "A"] }, /must not contain duplicates ignoring case/],
    [{ provider: "git-crypt", paths: ["memory/private/"] }, /must not end in a path separator/],
    [{ provider: "git-crypt", paths: ["../escape"] }, /must stay inside the workspace/],
    [{ provider: "git-crypt", paths: ["/etc/passwd"] }, /must stay inside the workspace/],
  ];
  for (const [confidential, expected] of rejected) {
    assert.throws(
      () => parseWorkspaceConfig({ confidential }),
      expected,
      JSON.stringify(confidential),
    );
  }
});
