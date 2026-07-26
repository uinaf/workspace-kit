import { spawnSync } from "node:child_process";
import type { SkillsConfig } from "./config.ts";
import {
  createWorkspaceLink,
  ensureWorkspaceDirectory,
  readWorkspaceDirectory,
  readWorkspaceLink,
  readWorkspaceText,
  workspaceLstat,
} from "./lib/workspaceFs.ts";

export const SKILLS_CLI_VERSION = "1.5.20";

type RemoteSkill = { name: string; source: string };
type WorkspaceSkills = { local: string[]; remote: RemoteSkill[] };
type RunResult = { status: number | null; error?: Error };
const GITHUB_SOURCE =
  /^(?!\.{1,2}\/)(?!.*\/\.{1,2}$)(?!.*\.git$)[A-Za-z0-9](?:[A-Za-z0-9_.-]*[A-Za-z0-9])?\/[A-Za-z0-9](?:[A-Za-z0-9_.-]*[A-Za-z0-9])?$/;

export type SkillsRunner = (
  command: string,
  args: readonly string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    stdio: "inherit";
  },
) => RunResult;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function yamlScalar(raw: string): string | undefined {
  const withoutComment = raw.replace(/\s+#.*$/, "").trim();
  if (!withoutComment) return undefined;
  if (withoutComment.startsWith('"') && withoutComment.endsWith('"')) {
    try {
      const value: unknown = JSON.parse(withoutComment);
      return typeof value === "string" ? value : undefined;
    } catch {
      return undefined;
    }
  }
  if (withoutComment.startsWith("'") && withoutComment.endsWith("'")) {
    return withoutComment.slice(1, -1).replaceAll("''", "'");
  }
  return withoutComment;
}

function skillMetadata(manifest: string): {
  name: string | undefined;
  description: string | undefined;
} {
  const frontmatter = manifest.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
  if (!frontmatter) return { name: undefined, description: undefined };

  const fields = new Map<string, string>();
  for (const line of frontmatter.split(/\r?\n/)) {
    const field = line.match(/^([A-Za-z][A-Za-z0-9_-]*):(?:[ \t]*(.*))?$/);
    if (field?.[1] && field[2] !== undefined) fields.set(field[1], field[2]);
  }
  return {
    name: yamlScalar(fields.get("name") ?? ""),
    description: yamlScalar(fields.get("description") ?? ""),
  };
}

function skillManifestError(
  repoRoot: string,
  manifestPath: string,
  expectedName: string,
): string | undefined {
  const metadata = skillMetadata(readWorkspaceText(repoRoot, manifestPath, "skill manifest"));
  if (metadata.name !== expectedName) {
    return `${manifestPath} declares name ${metadata.name ?? "<missing>"}, expected ${expectedName}`;
  }
  if (!metadata.description) return `${manifestPath} must declare a non-empty description`;
  return undefined;
}

function readRemoteSkills(repoRoot: string, config: SkillsConfig): RemoteSkill[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readWorkspaceText(repoRoot, config.manifest, "skills manifest"));
  } catch (error) {
    throw new Error(errorText(error));
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.skills)) {
    throw new Error(`${config.manifest} must contain a skills array`);
  }

  const seen = new Set<string>();
  return parsed.skills.map((entry, index) => {
    if (!isRecord(entry)) throw new Error(`${config.manifest} skills[${index}] must be an object`);
    if (typeof entry.name !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(entry.name)) {
      throw new Error(`${config.manifest} skills[${index}].name must be lowercase kebab-case`);
    }
    const source = typeof entry.source === "string" ? entry.source : "";
    if (!GITHUB_SOURCE.test(source)) {
      throw new Error(
        `${config.manifest} skills[${index}].source must be a GitHub owner/repo shorthand`,
      );
    }
    if (seen.has(entry.name)) {
      throw new Error(`${config.manifest} contains duplicate skill ${entry.name}`);
    }
    seen.add(entry.name);
    return { name: entry.name, source };
  });
}

function readLocalSkills(repoRoot: string): string[] {
  const local: string[] = [];
  for (const entry of readWorkspaceDirectory(repoRoot, "skills")) {
    if (entry.name === "skills.json" || entry.name === ".gitkeep") continue;
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      throw new Error(`skills/${entry.name}: expected a workspace-owned skill directory`);
    }
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(entry.name)) {
      throw new Error(`skills/${entry.name}: directory name must be lowercase kebab-case`);
    }
    const manifestPath = `skills/${entry.name}/SKILL.md`;
    const error = skillManifestError(repoRoot, manifestPath, entry.name);
    if (error) throw new Error(error);
    local.push(entry.name);
  }
  return local.sort();
}

function readWorkspaceSkills(repoRoot: string, config: SkillsConfig): WorkspaceSkills {
  const local = readLocalSkills(repoRoot);
  const remote = readRemoteSkills(repoRoot, config);
  const localNames = new Set(local);
  for (const { name } of remote) {
    if (localNames.has(name)) throw new Error(`${config.manifest} redeclares local skill ${name}`);
  }
  return { local, remote };
}

function discoveryRootError(repoRoot: string): string | undefined {
  const stat = workspaceLstat(repoRoot, ".agents/skills", "runtime skill root");
  if (!stat) return "missing .agents/skills";
  if (stat.isSymbolicLink() || !stat.isDirectory()) return ".agents/skills must be a directory";
  return undefined;
}

function claudeLinkError(repoRoot: string): string | undefined {
  const stat = workspaceLstat(repoRoot, ".claude/skills", "Claude skill discovery link");
  if (!stat) return "missing .claude/skills";
  if (!stat.isSymbolicLink()) return ".claude/skills should link to ../.agents/skills";
  const target = readWorkspaceLink(repoRoot, ".claude/skills");
  return target === "../.agents/skills"
    ? undefined
    : `.claude/skills points to ${target}, expected ../.agents/skills`;
}

function runtimeSkillError(
  repoRoot: string,
  name: string,
  kind: "local" | "remote",
): string | undefined {
  const runtimePath = `.agents/skills/${name}`;
  const stat = workspaceLstat(repoRoot, runtimePath, "runtime skill");
  if (!stat) return `missing ${runtimePath}`;

  if (kind === "local") {
    const expected = `../../skills/${name}`;
    if (!stat.isSymbolicLink()) return `${runtimePath} should link to ${expected}`;
    const target = readWorkspaceLink(repoRoot, runtimePath);
    return target === expected
      ? undefined
      : `${runtimePath} points to ${target}, expected ${expected}`;
  }

  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    return `${runtimePath} must be a copied directory`;
  }
  return skillManifestError(repoRoot, `${runtimePath}/SKILL.md`, name);
}

function staleLocalLinkErrors(repoRoot: string, local: readonly string[]): string[] {
  const localNames = new Set(local);
  const errors: string[] = [];
  for (const entry of readWorkspaceDirectory(repoRoot, ".agents/skills")) {
    if (!entry.isSymbolicLink() || localNames.has(entry.name)) continue;
    const runtimePath = `.agents/skills/${entry.name}`;
    if (readWorkspaceLink(repoRoot, runtimePath) === `../../skills/${entry.name}`) {
      errors.push(`${runtimePath} links a missing local skill source`);
    }
  }
  return errors;
}

function lockErrors(repoRoot: string, remote: readonly RemoteSkill[]): string[] {
  const lock = workspaceLstat(repoRoot, "skills-lock.json", "skills lock");
  if (!lock) return remote.length === 0 ? [] : ["skills-lock.json: file is missing"];

  let parsed: unknown;
  try {
    parsed = JSON.parse(readWorkspaceText(repoRoot, "skills-lock.json", "skills lock"));
  } catch (error) {
    return [errorText(error)];
  }
  if (!isRecord(parsed) || parsed.version !== 1 || !isRecord(parsed.skills)) {
    return ["skills-lock.json must contain version 1 and a skills object"];
  }

  const expected = new Map(remote.map(({ name, source }) => [name, source] as const));
  const errors: string[] = [];
  for (const [name, source] of expected) {
    const entry = parsed.skills[name];
    if (!isRecord(entry)) {
      errors.push(`skills-lock.json is missing ${name}`);
    } else if (entry.source !== source) {
      errors.push(
        `skills-lock.json records ${name} from ${String(entry.source)}, expected ${source}`,
      );
    }
  }
  for (const name of Object.keys(parsed.skills).sort()) {
    if (!expected.has(name)) errors.push(`skills-lock.json contains undeclared skill ${name}`);
  }
  return errors;
}

export function workspaceSkillErrors(repoRoot: string, config: SkillsConfig): string[] {
  let skills: WorkspaceSkills;
  try {
    skills = readWorkspaceSkills(repoRoot, config);
  } catch (error) {
    return [errorText(error)];
  }

  const errors: string[] = [];
  const rootError = discoveryRootError(repoRoot);
  if (rootError) {
    errors.push(rootError);
  } else {
    for (const [name, kind] of [
      ...skills.local.map((name) => [name, "local"] as const),
      ...skills.remote.map(({ name }) => [name, "remote"] as const),
    ]) {
      try {
        const error = runtimeSkillError(repoRoot, name, kind);
        if (error) errors.push(error);
      } catch (error) {
        errors.push(errorText(error));
      }
    }
    errors.push(...staleLocalLinkErrors(repoRoot, skills.local));
  }
  try {
    const error = claudeLinkError(repoRoot);
    if (error) errors.push(error);
  } catch (error) {
    errors.push(errorText(error));
  }
  errors.push(...lockErrors(repoRoot, skills.remote));
  return errors;
}

export function syncWorkspaceSkills(
  repoRoot: string,
  config: SkillsConfig,
  run: SkillsRunner = spawnSync,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string[] {
  let skills: WorkspaceSkills;
  try {
    skills = readWorkspaceSkills(repoRoot, config);

    const root = workspaceLstat(repoRoot, ".agents/skills", "runtime skill root");
    if (root && (root.isSymbolicLink() || !root.isDirectory())) {
      return [".agents/skills must be a directory"];
    }
    const claude = workspaceLstat(repoRoot, ".claude/skills", "Claude skill discovery link");
    if (claude) {
      const error = claudeLinkError(repoRoot);
      if (error) return [error];
    }
    for (const name of skills.local) {
      const runtimePath = `.agents/skills/${name}`;
      const stat = workspaceLstat(repoRoot, runtimePath, "runtime skill");
      const expected = `../../skills/${name}`;
      if (
        stat &&
        (!stat.isSymbolicLink() || readWorkspaceLink(repoRoot, runtimePath) !== expected)
      ) {
        return [`${runtimePath} exists and is not a managed link to ${expected}`];
      }
    }

    ensureWorkspaceDirectory(repoRoot, ".agents/skills");
    if (!claude) createWorkspaceLink(repoRoot, ".claude/skills", "../.agents/skills");
    for (const name of skills.local) {
      const runtimePath = `.agents/skills/${name}`;
      if (!workspaceLstat(repoRoot, runtimePath, "runtime skill")) {
        createWorkspaceLink(repoRoot, runtimePath, `../../skills/${name}`);
      }
    }
  } catch (error) {
    return [errorText(error)];
  }

  const failures: string[] = [];
  for (const skill of skills.remote) {
    const result = run(
      platform === "win32" ? "npx.cmd" : "npx",
      [
        "--yes",
        `skills@${SKILLS_CLI_VERSION}`,
        "add",
        skill.source,
        "--skill",
        skill.name,
        "--agent",
        "universal",
        "--copy",
        "--yes",
      ],
      {
        cwd: repoRoot,
        env: { ...env, DISABLE_TELEMETRY: "1", DO_NOT_TRACK: "1" },
        stdio: "inherit",
      },
    );
    if (result.status !== 0) {
      const detail = result.error?.message ? `: ${result.error.message}` : "";
      failures.push(
        `${skill.name} (${skill.source}) failed with exit ${result.status ?? 127}${detail}`,
      );
    }
  }

  failures.push(...workspaceSkillErrors(repoRoot, config));
  return failures;
}
