import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "vite-plus/test";
import { confidentialCheck } from "../src/checks/confidential.ts";
import { CONFIDENTIAL_MIN_VERSION, parseWorkspaceConfig } from "../src/config.ts";
import { gitEnvironmentForRepository } from "../src/lib/gitProcess.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(root, "src", "cli.ts");
const gitCryptHeader = Buffer.from([0x00, 0x47, 0x49, 0x54, 0x43, 0x52, 0x59, 0x50, 0x54, 0x00]);

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: gitEnvironmentForRepository(),
  }).trim();
}

function kit(cwd: string, ...args: string[]) {
  return spawnSync(process.execPath, [cli, ...args], { cwd, encoding: "utf8" });
}

function config(confidential = true): Record<string, unknown> {
  return confidential
    ? {
        minVersion: CONFIDENTIAL_MIN_VERSION,
        confidential: { provider: "git-crypt", roots: ["private"] },
      }
    : { minVersion: "0.1.0" };
}

function encrypted(content = "ciphertext"): Buffer {
  return Buffer.concat([gitCryptHeader, Buffer.alloc(12, 0x42), Buffer.from(content)]);
}

function fixture(
  content: string | Buffer = encrypted(),
  objectFormat: "sha1" | "sha256" = "sha1",
): string {
  const dir = mkdtempSync(join(tmpdir(), "workspace-confidential-"));
  git(dir, "init", "-q", `--object-format=${objectFormat}`);
  git(dir, "config", "user.name", "Workspace Test");
  git(dir, "config", "user.email", "workspace-test@example.invalid");
  git(dir, "config", "commit.gpgsign", "false");
  mkdirSync(join(dir, "private"));
  writeFileSync(join(dir, "workspace.json"), `${JSON.stringify(config(), null, 2)}\n`);
  writeFileSync(join(dir, ".gitattributes"), "private/** filter=git-crypt diff=git-crypt\n");
  writeFileSync(join(dir, "private", "note.md"), content);
  git(dir, "add", "-A");
  return dir;
}

function check(dir: string) {
  const current = parseWorkspaceConfig(
    JSON.parse(readFileSync(join(dir, "workspace.json"), "utf8")),
  );
  return confidentialCheck(dir, current);
}

test("confidential config requires its supporting version and literal directory roots", () => {
  assert.deepEqual(parseWorkspaceConfig(config()).confidential, {
    provider: "git-crypt",
    roots: ["private"],
  });
  for (const minVersion of [undefined, "0.11.1"]) {
    assert.throws(
      () =>
        parseWorkspaceConfig({
          ...(minVersion ? { minVersion } : {}),
          confidential: { provider: "git-crypt", roots: ["private"] },
        }),
      /confidential requires minVersion >= 0\.12\.0/,
    );
  }
  assert.throws(
    () =>
      parseWorkspaceConfig({
        minVersion: CONFIDENTIAL_MIN_VERSION,
        confidential: { provider: "age", roots: ["private"] },
      }),
    /confidential\.provider must be "git-crypt"/,
  );
  assert.throws(
    () =>
      parseWorkspaceConfig({
        minVersion: CONFIDENTIAL_MIN_VERSION,
        confidential: { provider: "git-crypt", roots: [] },
      }),
    /confidential\.roots must not be empty/,
  );
  assert.throws(
    () =>
      parseWorkspaceConfig({
        minVersion: CONFIDENTIAL_MIN_VERSION,
        confidential: { provider: "git-crypt", roots: ["private/**"] },
      }),
    /literal paths, not glob patterns/,
  );
  assert.throws(
    () =>
      parseWorkspaceConfig({
        minVersion: CONFIDENTIAL_MIN_VERSION,
        confidential: {
          provider: "git-crypt",
          roots: ["Private", "private/notes"],
        },
      }),
    /confidential\.roots\[1\] overlaps confidential\.roots\[0\]/,
  );
  assert.throws(
    () =>
      parseWorkspaceConfig({
        minVersion: CONFIDENTIAL_MIN_VERSION,
        confidential: { provider: "git-crypt", roots: ["private notes"] },
      }),
    /confidential\.roots must not contain whitespace/,
  );
  assert.throws(
    () =>
      parseWorkspaceConfig({
        minVersion: CONFIDENTIAL_MIN_VERSION,
        confidential: { provider: "git-crypt", roots: [".GITHOOKS/pre-commit"] },
      }),
    /must not contain Git or hook control directories/,
  );
  assert.throws(
    () =>
      parseWorkspaceConfig({
        minVersion: CONFIDENTIAL_MIN_VERSION,
        confidential: { provider: "git-crypt", roots: ["#private"] },
      }),
    /must not start with "#" or "!"/,
  );
});

test("confidential check accepts only encrypted index content with staged git-crypt policy", () => {
  const dir = fixture();
  try {
    assert.deepEqual(check(dir), { enabled: true, errors: [] });

    writeFileSync(join(dir, "private", "note.md"), "plaintext working tree\n");
    assert.deepEqual(check(dir), { enabled: true, errors: [] });

    git(dir, "add", "private/note.md");
    const errors = check(dir).errors.join("\n");
    assert.match(errors, /staged content is not git-crypt ciphertext/);
    assert.doesNotMatch(errors, /plaintext working tree/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("confidential check accepts staged attribute metadata above 1 MiB", () => {
  const dir = fixture();
  try {
    writeFileSync(
      join(dir, ".gitattributes"),
      `${"#".repeat(1024 * 1024 + 1)}\nprivate/** filter=git-crypt diff=git-crypt\n`,
    );
    git(dir, "add", ".gitattributes");

    assert.deepEqual(check(dir), { enabled: true, errors: [] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("confidential check reads raw objects without replacement refs", () => {
  const dir = fixture("plaintext\n");
  try {
    const replacement = join(dir, "replacement.enc");
    writeFileSync(replacement, encrypted());
    const plaintextObject = git(dir, "rev-parse", ":private/note.md");
    const encryptedObject = git(dir, "hash-object", "-w", replacement);
    git(dir, "replace", plaintextObject, encryptedObject);

    assert.match(check(dir).errors.join("\n"), /staged content is not git-crypt ciphertext/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("confidential check preserves SHA-256 repository object format", () => {
  const dir = fixture(encrypted(), "sha256");
  try {
    assert.deepEqual(check(dir), { enabled: true, errors: [] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("confidential check preserves split-index state", () => {
  const dir = fixture();
  try {
    git(dir, "update-index", "--split-index");
    assert.match(git(dir, "rev-parse", "--shared-index-path"), /sharedindex\./);
    assert.deepEqual(check(dir), { enabled: true, errors: [] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("confidential check preserves an explicitly selected index", () => {
  const dir = fixture();
  const previousIndex = process.env.GIT_INDEX_FILE;
  try {
    git(dir, "commit", "-qm", "protected baseline");
    const alternateIndex = join(dir, "alternate-index");
    execFileSync("git", ["read-tree", "HEAD"], {
      cwd: dir,
      env: { ...gitEnvironmentForRepository(), GIT_INDEX_FILE: alternateIndex },
    });
    writeFileSync(join(dir, ".gitattributes"), "private/** -filter -diff\n");
    git(dir, "add", ".gitattributes");

    process.env.GIT_INDEX_FILE = alternateIndex;
    assert.deepEqual(check(dir), { enabled: true, errors: [] });
  } finally {
    if (previousIndex === undefined) delete process.env.GIT_INDEX_FILE;
    else process.env.GIT_INDEX_FILE = previousIndex;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("confidential check accepts encrypted empty files", () => {
  const dir = fixture(encrypted(""));
  try {
    assert.deepEqual(check(dir), { enabled: true, errors: [] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("confidential check uses only staged distributable attributes", () => {
  const dir = fixture();
  try {
    writeFileSync(join(dir, ".gitattributes"), "private/** filter=LEAK-ME diff=LEAK-DIFF\n");
    assert.deepEqual(check(dir), { enabled: true, errors: [] }, "worktree policy is ignored");

    git(dir, "add", ".gitattributes");
    writeFileSync(join(dir, ".gitattributes"), "private/** filter=git-crypt diff=git-crypt\n");
    const stagedErrors = check(dir).errors.join("\n");
    assert.match(stagedErrors, /staged filter attribute must be git-crypt/);
    assert.match(stagedErrors, /staged diff attribute must be git-crypt/);
    assert.doesNotMatch(stagedErrors, /LEAK-ME|LEAK-DIFF/);

    writeFileSync(
      join(dir, ".git", "info", "attributes"),
      "private/note.md filter=git-crypt diff=git-crypt\n",
    );
    const isolatedErrors = check(dir).errors.join("\n");
    assert.match(isolatedErrors, /staged filter attribute must be git-crypt/);
    assert.match(isolatedErrors, /staged diff attribute must be git-crypt/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("confidential check requires a staged root policy even before content exists", () => {
  const dir = fixture();
  try {
    rmSync(join(dir, "private", "note.md"));
    writeFileSync(join(dir, ".gitattributes"), "# no confidential policy\n");
    git(dir, "add", "-A");

    assert.match(
      check(dir).errors.join("\n"),
      /missing staged rule private\/\*\* filter=git-crypt diff=git-crypt/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("confidential check rejects later policy overrides for an empty descendant", () => {
  const dir = fixture();
  try {
    rmSync(join(dir, "private", "note.md"));
    writeFileSync(
      join(dir, ".gitattributes"),
      ["private/** filter=git-crypt diff=git-crypt", "private/sub/** -filter -diff", ""].join("\n"),
    );
    git(dir, "add", "-A");

    assert.match(
      check(dir).errors.join("\n"),
      /canonical confidential root rules must be the final rules/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("confidential check rejects attribute files above nested roots", () => {
  const dir = fixture();
  try {
    rmSync(join(dir, "private"), { recursive: true, force: true });
    mkdirSync(join(dir, "memory", "private"), { recursive: true });
    writeFileSync(join(dir, "memory", "private", "note.md"), encrypted());
    writeFileSync(
      join(dir, "workspace.json"),
      `${JSON.stringify(
        {
          minVersion: CONFIDENTIAL_MIN_VERSION,
          confidential: { provider: "git-crypt", roots: ["memory/private"] },
        },
        null,
        2,
      )}\n`,
    );
    writeFileSync(
      join(dir, ".gitattributes"),
      "memory/private/** filter=git-crypt diff=git-crypt\n",
    );
    writeFileSync(join(dir, "memory", ".gitattributes"), "private/sub/** -filter -diff\n");
    git(dir, "add", "-A");

    assert.match(
      check(dir).errors.join("\n"),
      /"memory\/\.gitattributes": attribute files above confidential roots are not supported/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("confidential check rejects roots that traverse submodule entries", () => {
  const dir = fixture();
  try {
    git(dir, "commit", "-qm", "baseline");
    rmSync(join(dir, "private"), { recursive: true, force: true });
    writeFileSync(
      join(dir, "workspace.json"),
      `${JSON.stringify(
        {
          minVersion: CONFIDENTIAL_MIN_VERSION,
          confidential: { provider: "git-crypt", roots: ["vendor/module/private"] },
        },
        null,
        2,
      )}\n`,
    );
    writeFileSync(
      join(dir, ".gitattributes"),
      "vendor/module/private/** filter=git-crypt diff=git-crypt\n",
    );
    git(dir, "add", "-A");
    git(
      dir,
      "update-index",
      "--add",
      "--cacheinfo",
      `160000,${git(dir, "rev-parse", "HEAD")},vendor/module`,
    );

    assert.match(
      check(dir).errors.join("\n"),
      /"vendor\/module": confidential roots cannot traverse tracked entries/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("confidential check accepts an executable regular root policy", () => {
  const dir = fixture();
  try {
    chmodSync(join(dir, ".gitattributes"), 0o755);
    git(dir, "add", ".gitattributes");
    assert.deepEqual(check(dir), { enabled: true, errors: [] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("confidential roots are directories and protected entries are regular files", () => {
  const dir = fixture();
  try {
    const fileRoot = {
      minVersion: CONFIDENTIAL_MIN_VERSION,
      confidential: { provider: "git-crypt", roots: ["private/note.md"] },
    };
    writeFileSync(join(dir, "workspace.json"), `${JSON.stringify(fileRoot, null, 2)}\n`);
    writeFileSync(
      join(dir, ".gitattributes"),
      "private/note.md/** filter=git-crypt diff=git-crypt\n",
    );
    git(dir, "add", "workspace.json", ".gitattributes");
    assert.match(
      check(dir).errors.join("\n"),
      /"private\/note\.md": confidential roots must be directories/,
    );

    writeFileSync(join(dir, "workspace.json"), `${JSON.stringify(config(), null, 2)}\n`);
    writeFileSync(join(dir, ".gitattributes"), "private/** filter=git-crypt diff=git-crypt\n");
    symlinkSync("../workspace.json", join(dir, "private", "link"));
    writeFileSync(join(dir, "private", "line\nbreak.md"), "plaintext\n");
    git(dir, "add", "workspace.json", ".gitattributes", "private/link", "private/line\nbreak.md");

    const errors = check(dir).errors.join("\n");
    assert.match(errors, /"private\/link": protected paths must be regular files/);
    assert.match(errors, /"private\/line\\nbreak\.md": staged content is not git-crypt/);
    assert.equal(errors.includes("private/line\nbreak.md"), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("confidential check evaluates the union of staged and worktree policy", () => {
  const stagedEnabled = fixture("plaintext\n");
  try {
    writeFileSync(
      join(stagedEnabled, "workspace.json"),
      `${JSON.stringify(config(false), null, 2)}\n`,
    );
    assert.match(check(stagedEnabled).errors.join("\n"), /staged content is not git-crypt/);
  } finally {
    rmSync(stagedEnabled, { recursive: true, force: true });
  }

  const worktreeEnabled = fixture("plaintext\n");
  try {
    writeFileSync(
      join(worktreeEnabled, "workspace.json"),
      `${JSON.stringify(config(false), null, 2)}\n`,
    );
    git(worktreeEnabled, "add", "workspace.json");
    writeFileSync(
      join(worktreeEnabled, "workspace.json"),
      `${JSON.stringify(config(), null, 2)}\n`,
    );
    assert.match(check(worktreeEnabled).errors.join("\n"), /staged content is not git-crypt/);
  } finally {
    rmSync(worktreeEnabled, { recursive: true, force: true });
  }
});

test("confidential check deduplicates portable root aliases across config states", () => {
  const dir = fixture();
  try {
    writeFileSync(
      join(dir, "workspace.json"),
      `${JSON.stringify(
        {
          minVersion: CONFIDENTIAL_MIN_VERSION,
          confidential: { provider: "git-crypt", roots: ["Private"] },
        },
        null,
        2,
      )}\n`,
    );
    writeFileSync(join(dir, ".gitattributes"), "Private/** filter=git-crypt diff=git-crypt\n");
    git(dir, "add", "workspace.json", ".gitattributes");
    git(dir, "commit", "-qm", "uppercase root spelling");

    writeFileSync(join(dir, "workspace.json"), `${JSON.stringify(config(), null, 2)}\n`);
    writeFileSync(join(dir, ".gitattributes"), "private/** filter=git-crypt diff=git-crypt\n");
    git(dir, "add", "workspace.json", ".gitattributes");

    assert.deepEqual(check(dir), { enabled: true, errors: [] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("confidential check fails closed when staged config is unusable", () => {
  const dir = fixture();
  try {
    writeFileSync(join(dir, "workspace.json"), '{"confidential":"LEAK-ME",\n');
    git(dir, "add", "workspace.json");
    writeFileSync(join(dir, "workspace.json"), `${JSON.stringify(config(false), null, 2)}\n`);

    const result = check(dir);
    assert.equal(result.enabled, true);
    assert.match(result.errors.join("\n"), /staged workspace\.json is not usable/);
    assert.doesNotMatch(result.errors.join("\n"), /LEAK-ME/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("confidential check sanitizes malformed committed config diagnostics", () => {
  const dir = fixture();
  try {
    git(dir, "commit", "-qm", "protected baseline");
    writeFileSync(join(dir, "workspace.json"), '{"confidential":"LEAK-ME",\n');
    git(dir, "add", "workspace.json");
    git(dir, "commit", "-qm", "malformed config");
    writeFileSync(join(dir, "workspace.json"), `${JSON.stringify(config(false), null, 2)}\n`);
    git(dir, "add", "workspace.json");

    const result = check(dir);
    assert.equal(result.enabled, true);
    assert.match(result.errors.join("\n"), /committed workspace\.json is not usable/);
    assert.doesNotMatch(result.errors.join("\n"), /LEAK-ME/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("confidential check fails closed when the index is unreadable during opt-out", () => {
  const dir = fixture();
  try {
    git(dir, "commit", "-qm", "protected baseline");
    writeFileSync(join(dir, "workspace.json"), `${JSON.stringify(config(false), null, 2)}\n`);
    writeFileSync(join(dir, ".git", "index"), "not a Git index\n");

    const result = check(dir);
    assert.equal(result.enabled, true);
    assert.match(result.errors.join("\n"), /index|signature|Git/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("confidential check fails closed when HEAD is broken", () => {
  const dir = fixture();
  try {
    git(dir, "commit", "-qm", "protected baseline");
    writeFileSync(join(dir, "workspace.json"), `${JSON.stringify(config(false), null, 2)}\n`);
    git(dir, "add", "workspace.json");
    writeFileSync(join(dir, ".git", "HEAD"), `${"0".repeat(40)}\n`);

    const result = check(dir);
    assert.equal(result.enabled, true);
    assert.match(result.errors.join("\n"), /HEAD|revision|committed|history/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("confidential check preserves committed roots during opt-out", () => {
  const dir = fixture();
  try {
    git(dir, "commit", "-qm", "protected baseline");
    writeFileSync(join(dir, "workspace.json"), `${JSON.stringify(config(false), null, 2)}\n`);
    writeFileSync(join(dir, ".gitattributes"), "# policy removed\n");
    writeFileSync(join(dir, "private", "note.md"), "plaintext\n");
    git(dir, "add", "-A");

    const errors = check(dir).errors.join("\n");
    assert.match(errors, /missing staged rule private\/\*\*/);
    assert.match(errors, /staged content is not git-crypt ciphertext/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("confidential check is default-off in a clean post-commit opt-out", () => {
  const dir = fixture();
  try {
    git(dir, "commit", "-qm", "protected baseline");
    writeFileSync(join(dir, "workspace.json"), `${JSON.stringify(config(false), null, 2)}\n`);
    writeFileSync(join(dir, ".gitattributes"), "# policy removed\n");
    writeFileSync(join(dir, "private", "note.md"), "plaintext\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "unsafe single-commit opt-out");

    assert.deepEqual(check(dir), { enabled: false, errors: [] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("confidential check remains default-off in a shallow clean checkout", () => {
  const dir = fixture();
  const cloneParent = mkdtempSync(join(tmpdir(), "workspace-confidential-shallow-"));
  try {
    git(dir, "commit", "-qm", "protected baseline");
    writeFileSync(join(dir, "workspace.json"), `${JSON.stringify(config(false), null, 2)}\n`);
    writeFileSync(join(dir, ".gitattributes"), "# policy removed\n");
    writeFileSync(join(dir, "private", "note.md"), "plaintext\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "unsafe single-commit opt-out");

    const clone = join(cloneParent, "clone");
    git(cloneParent, "clone", "-q", "--depth=1", pathToFileURL(dir).href, clone);

    assert.deepEqual(check(clone), { enabled: false, errors: [] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(cloneParent, { recursive: true, force: true });
  }
});

test("confidential check does not lazy-fetch missing partial-clone blobs", () => {
  const dir = fixture();
  const cloneParent = mkdtempSync(join(tmpdir(), "workspace-confidential-partial-"));
  try {
    git(dir, "commit", "-qm", "protected baseline");
    git(dir, "config", "uploadpack.allowFilter", "true");
    const clone = join(cloneParent, "clone");
    git(
      cloneParent,
      "clone",
      "-q",
      "--filter=blob:none",
      "--no-checkout",
      pathToFileURL(dir).href,
      clone,
    );
    git(clone, "read-tree", "HEAD");
    writeFileSync(join(clone, "workspace.json"), `${JSON.stringify(config(), null, 2)}\n`);

    const objectId = git(clone, "rev-parse", "HEAD:workspace.json");
    const missingBefore = spawnSync("git", ["cat-file", "-e", objectId], {
      cwd: clone,
      env: { ...gitEnvironmentForRepository(), GIT_NO_LAZY_FETCH: "1" },
    });
    assert.notEqual(missingBefore.status, 0);

    const result = check(clone);
    assert.equal(result.enabled, true);
    assert.match(result.errors.join("\n"), /could not read Git object|not usable/i);

    const missingAfter = spawnSync("git", ["cat-file", "-e", objectId], {
      cwd: clone,
      env: { ...gitEnvironmentForRepository(), GIT_NO_LAZY_FETCH: "1" },
    });
    assert.notEqual(missingAfter.status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(cloneParent, { recursive: true, force: true });
  }
});

test("confidential check permits a completed two-commit opt-out", () => {
  const dir = fixture();
  try {
    git(dir, "commit", "-qm", "protected baseline");
    writeFileSync(join(dir, "workspace.json"), `${JSON.stringify(config(false), null, 2)}\n`);
    git(dir, "add", "workspace.json");
    git(dir, "commit", "-qm", "disable confidential contract");

    writeFileSync(join(dir, ".gitattributes"), "# policy removed\n");
    writeFileSync(join(dir, "private", "note.md"), "plaintext\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "migrate protected files");

    assert.deepEqual(check(dir), { enabled: false, errors: [] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("confidential behavior remains default-off", () => {
  const dir = fixture("plaintext\n");
  try {
    writeFileSync(join(dir, "workspace.json"), `${JSON.stringify(config(false), null, 2)}\n`);
    git(dir, "add", "workspace.json");

    assert.deepEqual(check(dir), { enabled: false, errors: [] });
    const verify = kit(dir, "verify", "--json");
    assert.equal(verify.status, 0, verify.stderr);
    assert.equal(JSON.parse(verify.stdout).checks.confidential, undefined);

    const explicit = kit(dir, "confidential", "check");
    assert.equal(explicit.status, 1);
    assert.match(explicit.stderr, /workspace\.json has no confidential section/);
    assert.equal(existsSync(join(dir, ".git", "index.lock")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
