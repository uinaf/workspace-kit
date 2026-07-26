import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs";
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
});

test("workspace skill sync preserves conflicts, failures, and Windows delegation", () => {
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

  const windows = scratch();
  writeManifest(windows, [{ name: "remote-skill", source: "fixture/skills" }]);
  const commands: string[] = [];
  const windowsRunner: SkillsRunner = (command) => {
    commands.push(command);
    writeSkill(windows, ".agents/skills", "remote-skill");
    writeLock(windows, [{ name: "remote-skill", source: "fixture/skills" }]);
    return { status: 0 };
  };
  assert.deepEqual(syncWorkspaceSkills(windows, config, windowsRunner, {}, "win32"), []);
  assert.deepEqual(commands, ["npx.cmd"]);
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
