import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  lstatSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vite-plus/test";
import type { SkillsConfig } from "../src/config.ts";
import {
  SKILLS_CLI_VERSION,
  syncWorkspaceSkills,
  workspaceSkillErrors,
  type SkillsRunner,
} from "../src/skills.ts";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(repositoryRoot, "src", "cli.ts");
const config: SkillsConfig = { manifest: "skills/skills.json" };

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "workspace-skills-"));
}

function writeSkill(
  root: string,
  path: string,
  name: string,
  metadata = `name: ${name}\ndescription: Fixture skill.`,
): void {
  const directory = join(root, path, name);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "SKILL.md"), `---\n${metadata}\n---\n`);
}

function writeManifest(
  root: string,
  skills: ReadonlyArray<{ name: string; source: string }>,
): void {
  mkdirSync(join(root, "skills"), { recursive: true });
  writeFileSync(join(root, "skills", "skills.json"), `${JSON.stringify({ skills }, null, 2)}\n`);
}

function writeDiscovery(root: string): void {
  mkdirSync(join(root, ".agents", "skills"), { recursive: true });
  mkdirSync(join(root, ".claude"), { recursive: true });
  symlinkSync("../.agents/skills", join(root, ".claude", "skills"));
}

function writeLock(root: string, skills: ReadonlyArray<{ name: string; source: string }>): void {
  writeFileSync(
    join(root, "skills-lock.json"),
    `${JSON.stringify(
      {
        version: 1,
        skills: Object.fromEntries(
          skills.map(({ name, source }) => [name, { source, computedHash: "dependency-owned" }]),
        ),
      },
      null,
      2,
    )}\n`,
  );
}

function writeManagedLock(
  root: string,
  skills: ReadonlyArray<{ name: string; source: string }>,
): void {
  mkdirSync(join(root, "skills"), { recursive: true });
  writeFileSync(
    join(root, "skills", "workspace-kit-lock.json"),
    `${JSON.stringify(
      { version: 1, skills: Object.fromEntries(skills.map(({ name, source }) => [name, source])) },
      null,
      2,
    )}\n`,
  );
}

function greenWorkspace(): string {
  const root = scratch();
  writeSkill(root, "skills", "local-skill", 'name: "local-skill" # quoted\ndescription: Local');
  writeManifest(root, [{ name: "remote-skill", source: "fixture/skills" }]);
  writeDiscovery(root);
  symlinkSync("../../skills/local-skill", join(root, ".agents", "skills", "local-skill"));
  writeSkill(root, ".agents/skills", "remote-skill");
  writeLock(root, [{ name: "remote-skill", source: "fixture/skills" }]);
  return root;
}

test("workspace skill check reconciles the declared discovery tree and lock", () => {
  const root = greenWorkspace();
  assert.deepEqual(workspaceSkillErrors(root, config), []);

  writeLock(root, [
    { name: "remote-skill", source: "wrong/source" },
    { name: "retired-skill", source: "fixture/retired" },
  ]);
  assert.deepEqual(workspaceSkillErrors(root, config), [
    "skills-lock.json records remote-skill from wrong/source, expected fixture/skills",
    "skills-lock.json contains undeclared skill retired-skill",
  ]);

  writeManifest(root, []);
  assert.deepEqual(workspaceSkillErrors(root, config), [
    "skills-lock.json contains undeclared skill remote-skill",
    "skills-lock.json contains undeclared skill retired-skill",
  ]);

  writeManifest(root, [{ name: "remote-skill", source: "fixture/skills" }]);
  writeLock(root, []);
  assert.deepEqual(workspaceSkillErrors(root, config), [
    "skills-lock.json is missing remote-skill",
  ]);
  writeFileSync(join(root, "skills-lock.json"), "{");
  assert.match(workspaceSkillErrors(root, config)[0] ?? "", /JSON|Unexpected/);
});

test("workspace skill declarations reject malformed ownership boundaries", () => {
  const collision = scratch();
  writeSkill(collision, "skills", "same-skill");
  writeManifest(collision, [{ name: "same-skill", source: "fixture/skills" }]);
  assert.deepEqual(workspaceSkillErrors(collision, config), [
    "skills/skills.json redeclares local skill same-skill",
  ]);

  const traversal = scratch();
  writeManifest(traversal, [{ name: "remote-skill", source: "../private-skills" }]);
  assert.deepEqual(workspaceSkillErrors(traversal, config), [
    "skills/skills.json skills[0].source must be a GitHub owner/repo shorthand",
  ]);

  const malformed = scratch();
  writeSkill(malformed, "skills", "local-skill", "name: local-skill");
  writeManifest(malformed, []);
  assert.deepEqual(workspaceSkillErrors(malformed, config), [
    "skills/local-skill/SKILL.md must declare a non-empty description",
  ]);

  const duplicate = scratch();
  writeManifest(duplicate, [
    { name: "remote-skill", source: "fixture/skills" },
    { name: "remote-skill", source: "fixture/other" },
  ]);
  assert.deepEqual(workspaceSkillErrors(duplicate, config), [
    "skills/skills.json contains duplicate skill remote-skill",
  ]);

  const invalidManifest = scratch();
  mkdirSync(join(invalidManifest, "skills"), { recursive: true });
  writeFileSync(join(invalidManifest, "skills", "skills.json"), '{"skills":{}}\n');
  assert.deepEqual(workspaceSkillErrors(invalidManifest, config), [
    "skills/skills.json must contain a skills array",
  ]);
});

test("workspace skill check rejects legacy and stale managed links", () => {
  const legacy = scratch();
  writeSkill(legacy, "skills", "local-skill");
  writeManifest(legacy, []);
  mkdirSync(join(legacy, ".agents"), { recursive: true });
  symlinkSync("../skills", join(legacy, ".agents", "skills"));
  mkdirSync(join(legacy, ".claude"), { recursive: true });
  symlinkSync("../.agents/skills", join(legacy, ".claude", "skills"));
  assert.deepEqual(workspaceSkillErrors(legacy, config), [".agents/skills must be a directory"]);

  const stale = scratch();
  writeManifest(stale, []);
  writeDiscovery(stale);
  symlinkSync("../../skills/retired-skill", join(stale, ".agents", "skills", "retired-skill"));
  assert.deepEqual(workspaceSkillErrors(stale, config), [
    ".agents/skills/retired-skill links a missing local skill source",
  ]);

  const wrongClaudeLink = scratch();
  writeManifest(wrongClaudeLink, []);
  mkdirSync(join(wrongClaudeLink, ".agents", "skills"), { recursive: true });
  mkdirSync(join(wrongClaudeLink, ".claude"), { recursive: true });
  symlinkSync("../skills", join(wrongClaudeLink, ".claude", "skills"));
  assert.deepEqual(workspaceSkillErrors(wrongClaudeLink, config), [
    ".claude/skills points to ../skills, expected ../.agents/skills",
  ]);

  const brokenCopy = scratch();
  writeManifest(brokenCopy, [{ name: "remote-skill", source: "fixture/skills" }]);
  writeDiscovery(brokenCopy);
  mkdirSync(join(brokenCopy, ".agents", "skills", "remote-skill"));
  writeLock(brokenCopy, [{ name: "remote-skill", source: "fixture/skills" }]);
  assert.deepEqual(workspaceSkillErrors(brokenCopy, config), [
    ".agents/skills/remote-skill/SKILL.md: file is missing",
  ]);
});

test("workspace skill sync owns links and delegates remote installation to skills.sh", () => {
  const root = scratch();
  writeSkill(root, "skills", "local-skill");
  writeManifest(root, [{ name: "remote-skill", source: "fixture/skills" }]);
  const calls: Array<{ command: string; args: readonly string[]; env: NodeJS.ProcessEnv }> = [];
  const runner: SkillsRunner = (command, args, options) => {
    calls.push({ command, args, env: options.env });
    writeSkill(root, ".agents/skills", "remote-skill");
    writeLock(root, [{ name: "remote-skill", source: "fixture/skills" }]);
    return { status: 0 };
  };

  assert.deepEqual(syncWorkspaceSkills(root, config, runner, {}), []);
  assert.equal(
    readlinkSync(join(root, ".agents", "skills", "local-skill")),
    "../../skills/local-skill",
  );
  assert.equal(readlinkSync(join(root, ".claude", "skills")), "../.agents/skills");
  assert.deepEqual(calls, [
    {
      command: "npx",
      args: [
        "--yes",
        `skills@${SKILLS_CLI_VERSION}`,
        "add",
        "fixture/skills",
        "--skill",
        "remote-skill",
        "--agent",
        "universal",
        "--copy",
        "--yes",
      ],
      env: { DISABLE_TELEMETRY: "1", DO_NOT_TRACK: "1" },
    },
  ]);
  assert.deepEqual(JSON.parse(readFileSync(join(root, "skills/workspace-kit-lock.json"), "utf8")), {
    version: 1,
    skills: { "remote-skill": "fixture/skills" },
  });
});

test("workspace skill sync removes only retired skills recorded in its lock", () => {
  const root = scratch();
  writeManifest(root, [{ name: "current-skill", source: "fixture/current" }]);
  writeDiscovery(root);
  writeSkill(root, ".agents/skills", "older-skill");
  writeSkill(root, ".agents/skills", "retired-skill");
  writeSkill(root, ".agents/skills", "untracked-skill");
  writeLock(root, [
    { name: "retired-skill", source: "fixture/retired" },
    { name: "older-skill", source: "fixture/older" },
  ]);
  writeManagedLock(root, [
    { name: "retired-skill", source: "fixture/retired" },
    { name: "older-skill", source: "fixture/older" },
  ]);
  const calls: string[][] = [];
  const runner: SkillsRunner = (_command, args) => {
    calls.push([...args]);
    if (args[2] === "remove") {
      const removed = args[3];
      writeLock(
        root,
        [
          { name: "older-skill", source: "fixture/older" },
          { name: "retired-skill", source: "fixture/retired" },
        ].filter(({ name }) => name !== removed),
      );
    } else {
      writeSkill(root, ".agents/skills", "current-skill");
      writeLock(root, [{ name: "current-skill", source: "fixture/current" }]);
    }
    return { status: 0 };
  };

  assert.deepEqual(syncWorkspaceSkills(root, config, runner), []);
  assert.deepEqual(calls, [
    [
      "--yes",
      `skills@${SKILLS_CLI_VERSION}`,
      "remove",
      "older-skill",
      "--agent",
      "universal",
      "--yes",
    ],
    [
      "--yes",
      `skills@${SKILLS_CLI_VERSION}`,
      "remove",
      "retired-skill",
      "--agent",
      "universal",
      "--yes",
    ],
    [
      "--yes",
      `skills@${SKILLS_CLI_VERSION}`,
      "add",
      "fixture/current",
      "--skill",
      "current-skill",
      "--agent",
      "universal",
      "--copy",
      "--yes",
    ],
  ]);
  assert.equal(workspaceLstatForTest(root, ".agents/skills/older-skill"), false);
  assert.equal(workspaceLstatForTest(root, ".agents/skills/retired-skill"), false);
  assert.ok(workspaceLstatForTest(root, ".agents/skills/untracked-skill"));
});

test("workspace skill sync replaces a retired remote copy with local source", () => {
  const root = scratch();
  writeSkill(root, "skills", "same-skill");
  writeDiscovery(root);
  writeSkill(root, ".agents/skills", "same-skill");
  writeManifest(root, []);
  writeLock(root, [{ name: "same-skill", source: "fixture/retired" }]);
  writeManagedLock(root, [{ name: "same-skill", source: "fixture/retired" }]);
  const runner: SkillsRunner = () => {
    writeLock(root, []);
    return { status: 0 };
  };

  assert.deepEqual(syncWorkspaceSkills(root, config, runner), []);
  assert.equal(readlinkSync(join(root, ".agents/skills/same-skill")), "../../skills/same-skill");
});

test("workspace skill retirement fails closed and preserves the previous copy", () => {
  const root = scratch();
  writeManifest(root, []);
  writeDiscovery(root);
  writeSkill(root, ".agents/skills", "retired-skill");
  writeLock(root, [{ name: "retired-skill", source: "fixture/retired" }]);
  writeManagedLock(root, [{ name: "retired-skill", source: "fixture/retired" }]);

  assert.deepEqual(
    syncWorkspaceSkills(root, config, () => ({ status: 9, error: new Error("offline") })),
    [
      "retired-skill (fixture/retired) removal failed with exit 9: offline",
      "skills-lock.json contains undeclared skill retired-skill",
      "skills/workspace-kit-lock.json contains retired managed skill retired-skill",
    ],
  );
  assert.ok(workspaceLstatForTest(root, ".agents/skills/retired-skill"));

  writeFileSync(join(root, "skills-lock.json"), "{");
  let called = false;
  assert.match(
    syncWorkspaceSkills(root, config, () => {
      called = true;
      return { status: 0 };
    })[0] ?? "",
    /JSON|Unexpected/,
  );
  assert.equal(called, false);
});

test("workspace skill retirement rejects unsafe lock provenance", () => {
  const invalidName = scratch();
  writeManifest(invalidName, []);
  writeDiscovery(invalidName);
  writeManagedLock(invalidName, [{ name: "Invalid", source: "fixture/retired" }]);
  assert.deepEqual(syncWorkspaceSkills(invalidName, config), [
    "skills/workspace-kit-lock.json contains an invalid managed skill entry Invalid",
  ]);

  const invalidSource = scratch();
  writeManifest(invalidSource, []);
  writeDiscovery(invalidSource);
  writeManagedLock(invalidSource, [{ name: "retired-skill", source: "../private" }]);
  assert.deepEqual(syncWorkspaceSkills(invalidSource, config), [
    "skills/workspace-kit-lock.json records retired-skill with an invalid managed source",
  ]);

  const linkedCopy = scratch();
  writeManifest(linkedCopy, []);
  writeDiscovery(linkedCopy);
  writeLock(linkedCopy, [{ name: "retired-skill", source: "fixture/retired" }]);
  writeManagedLock(linkedCopy, [{ name: "retired-skill", source: "fixture/retired" }]);
  symlinkSync("../../skills/retired-skill", join(linkedCopy, ".agents/skills/retired-skill"));
  assert.deepEqual(syncWorkspaceSkills(linkedCopy, config), [
    ".agents/skills/retired-skill is not a managed copied directory",
  ]);
});

test("workspace skill sync clears a retired lock entry when its copy is already absent", () => {
  const root = scratch();
  writeManifest(root, []);
  writeDiscovery(root);
  writeLock(root, [{ name: "retired-skill", source: "fixture/retired" }]);
  writeManagedLock(root, [{ name: "retired-skill", source: "fixture/retired" }]);
  const runner: SkillsRunner = () => {
    writeLock(root, []);
    return { status: 0 };
  };

  assert.deepEqual(syncWorkspaceSkills(root, config, runner), []);
});

test("workspace skill sync preserves generic lock entries it did not manage", () => {
  const root = scratch();
  writeManifest(root, []);
  writeDiscovery(root);
  writeSkill(root, ".agents/skills", "external-skill");
  writeLock(root, [{ name: "external-skill", source: "fixture/external" }]);
  let called = false;

  assert.deepEqual(
    syncWorkspaceSkills(root, config, () => {
      called = true;
      return { status: 0 };
    }),
    ["skills-lock.json contains undeclared skill external-skill"],
  );
  assert.equal(called, false);
  assert.ok(workspaceLstatForTest(root, ".agents/skills/external-skill"));
});

test("workspace skill retirement preserves a same-name consumer replacement", () => {
  const root = scratch();
  writeManifest(root, []);
  writeDiscovery(root);
  writeSkill(root, ".agents/skills", "shared-skill");
  writeLock(root, [{ name: "shared-skill", source: "fixture/replacement" }]);
  writeManagedLock(root, [{ name: "shared-skill", source: "fixture/original" }]);
  let called = false;

  assert.deepEqual(
    syncWorkspaceSkills(root, config, () => {
      called = true;
      return { status: 0 };
    }),
    ["shared-skill retirement provenance does not match skills-lock.json"],
  );
  assert.equal(called, false);
  assert.ok(workspaceLstatForTest(root, ".agents/skills/shared-skill"));
});

test("workspace skill sync records each successful install before a later failure", () => {
  const root = scratch();
  writeManifest(root, [
    { name: "first-skill", source: "fixture/first" },
    { name: "second-skill", source: "fixture/second" },
  ]);
  const runner: SkillsRunner = (_command, args) => {
    const name = args[5];
    if (name === "first-skill") {
      writeSkill(root, ".agents/skills", name);
      writeLock(root, [{ name, source: "fixture/first" }]);
      return { status: 0 };
    }
    return { status: 9, error: new Error("offline") };
  };

  assert.deepEqual(syncWorkspaceSkills(root, config, runner), [
    "second-skill (fixture/second) failed with exit 9: offline",
    "missing .agents/skills/second-skill",
    "skills-lock.json is missing second-skill",
  ]);
  assert.deepEqual(JSON.parse(readFileSync(join(root, "skills/workspace-kit-lock.json"), "utf8")), {
    version: 1,
    skills: { "first-skill": "fixture/first" },
  });
});

function workspaceLstatForTest(root: string, path: string): boolean {
  try {
    return lstatSync(join(root, path)).isDirectory();
  } catch {
    return false;
  }
}

test("workspace skill sync preserves conflicts and failures", () => {
  const conflict = scratch();
  writeSkill(conflict, "skills", "local-skill");
  writeManifest(conflict, []);
  writeSkill(conflict, ".agents/skills", "local-skill");
  let called = false;
  assert.deepEqual(
    syncWorkspaceSkills(conflict, config, () => {
      called = true;
      return { status: 0 };
    }),
    [".agents/skills/local-skill exists and is not a managed link to ../../skills/local-skill"],
  );
  assert.equal(called, false);

  const legacy = scratch();
  writeManifest(legacy, []);
  mkdirSync(join(legacy, ".agents"), { recursive: true });
  symlinkSync("../skills", join(legacy, ".agents", "skills"));
  assert.deepEqual(syncWorkspaceSkills(legacy, config), [".agents/skills must be a directory"]);

  const wrongClaudeLink = scratch();
  writeManifest(wrongClaudeLink, []);
  mkdirSync(join(wrongClaudeLink, ".agents", "skills"), { recursive: true });
  mkdirSync(join(wrongClaudeLink, ".claude"), { recursive: true });
  symlinkSync("../skills", join(wrongClaudeLink, ".claude", "skills"));
  assert.deepEqual(syncWorkspaceSkills(wrongClaudeLink, config), [
    ".claude/skills points to ../skills, expected ../.agents/skills",
  ]);

  const malformed = scratch();
  mkdirSync(join(malformed, "skills"), { recursive: true });
  writeFileSync(join(malformed, "skills", "skills.json"), "{");
  assert.match(syncWorkspaceSkills(malformed, config)[0] ?? "", /JSON|Unexpected/);

  const failed = scratch();
  writeManifest(failed, [{ name: "remote-skill", source: "fixture/skills" }]);
  assert.deepEqual(
    syncWorkspaceSkills(failed, config, () => ({ status: 9, error: new Error("offline") })),
    [
      "remote-skill (fixture/skills) failed with exit 9: offline",
      "missing .agents/skills/remote-skill",
      "skills-lock.json: file is missing",
    ],
  );
});

test("skills check and doctor expose the offline contract", () => {
  const root = greenWorkspace();
  writeFileSync(join(root, "workspace.json"), '{\n  "skills": {}\n}\n');

  const check = spawnSync(process.execPath, [cli, "skills", "check"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(check.status, 0, check.stderr);
  assert.equal(check.stdout, "skills ok\n");

  const doctor = spawnSync(process.execPath, [cli, "doctor", "--json"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(doctor.status, 0, doctor.stderr);
  assert.deepEqual(JSON.parse(doctor.stdout), {
    status: "pass",
    failed: 0,
    warnings: 0,
    checks: { structure: "ok", skills: "ok" },
    errors: [],
  });
});

test("remote installation preflights all destinations before any mutation", () => {
  for (const ownership of ["none", "dependency-only", "manager-only", "mismatch"]) {
    const root = scratch();
    const remote = { name: "remote-skill", source: "fixture/remote" };
    const retired = { name: "retired-skill", source: "fixture/retired" };
    writeManifest(root, [remote]);
    writeDiscovery(root);
    writeSkill(root, ".agents/skills", remote.name);
    writeSkill(root, ".agents/skills", retired.name);
    const note = join(root, ".agents/skills", remote.name, "owner-note.txt");
    writeFileSync(note, "keep owner content");
    writeLock(root, [
      retired,
      ...(ownership === "dependency-only"
        ? [remote]
        : ownership === "mismatch"
          ? [{ ...remote, source: "fixture/replacement" }]
          : []),
    ]);
    writeManagedLock(root, [
      retired,
      ...(ownership === "manager-only" || ownership === "mismatch" ? [remote] : []),
    ]);
    const lockBefore = readFileSync(join(root, "skills/workspace-kit-lock.json"));
    let calls = 0;
    const errors = syncWorkspaceSkills(root, config, () => {
      calls++;
      return { status: 0 };
    });
    assert.match(errors[0] ?? "", /without matching.*ownership/);
    assert.equal(calls, 0);
    assert.equal(readFileSync(note, "utf8"), "keep owner content");
    assert.ok(workspaceLstatForTest(root, ".agents/skills/retired-skill"));
    assert.deepEqual(readFileSync(join(root, "skills/workspace-kit-lock.json")), lockBefore);
  }
});

test("remote installation rejects occupied files and symlinks even with matching locks", () => {
  for (const shape of ["file", "symlink"]) {
    const root = scratch();
    const remote = { name: "remote-skill", source: "fixture/remote" };
    writeManifest(root, [remote]);
    writeDiscovery(root);
    writeLock(root, [remote]);
    writeManagedLock(root, [remote]);
    const path = join(root, ".agents/skills/remote-skill");
    if (shape === "file") writeFileSync(path, "keep");
    else symlinkSync("../../skills/remote-skill", path);
    let called = false;
    assert.match(
      syncWorkspaceSkills(root, config, () => {
        called = true;
        return { status: 0 };
      })[0] ?? "",
      /not a managed copied directory/,
    );
    assert.equal(called, false);
    if (shape === "file") assert.equal(readFileSync(path, "utf8"), "keep");
    else assert.equal(readlinkSync(path), "../../skills/remote-skill");
  }
});

test("remote installation updates proven managed copies including declared source changes", () => {
  for (const source of ["fixture/original", "fixture/replacement"]) {
    const root = scratch();
    const original = { name: "remote-skill", source: "fixture/original" };
    const requested = { ...original, source };
    writeManifest(root, [requested]);
    writeDiscovery(root);
    writeSkill(root, ".agents/skills", original.name);
    writeLock(root, [original]);
    writeManagedLock(root, [original]);
    let calls = 0;
    assert.deepEqual(
      syncWorkspaceSkills(root, config, (_command, args) => {
        calls++;
        assert.equal(args[3], source);
        writeLock(root, [requested]);
        return { status: 0 };
      }),
      [],
    );
    assert.equal(calls, 1);
    assert.equal(
      JSON.parse(readFileSync(join(root, "skills/workspace-kit-lock.json"), "utf8")).skills[
        original.name
      ],
      source,
    );
  }
});
