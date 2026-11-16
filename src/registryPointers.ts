import { posix } from "node:path";
import { portablePathIdentity, type RegistryConfig } from "./config.ts";
import {
  readWorkspaceDirectory,
  readWorkspaceText,
  unlinkWorkspaceFile,
  workspaceLstat,
  writeWorkspaceText,
} from "./lib/workspaceFs.ts";

export type PointersResult = { planned: string[] };

const SAFE_CATEGORY = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function marker(file: string): string {
  return `Generated from \`${file}\` by \`workspace-kit registry pointers\`; edit the registry, then rerun it.`;
}

function inline(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function entryLine(entry: Record<string, unknown>): string {
  const name = String(entry.name);
  const owns = typeof entry.owns === "string" ? `: ${inline(entry.owns)}` : "";
  const details = [`\`${String(entry.path)}\``, `\`${String(entry.repo)}\``, String(entry.mode)];
  if (typeof entry.branch === "string") details.push(`branch \`${entry.branch}\``);
  return `- **${name}**${owns} (${details.join(", ")})`;
}

function plannedFiles(file: string, registry: unknown): Map<string, string> {
  if (!isRecord(registry)) throw new Error(`${file} should be an object of category arrays`);
  const files = new Map<string, string>();
  const index: string[] = [];
  const identities = new Set([portablePathIdentity("README.md")]);
  for (const [category, value] of Object.entries(registry)) {
    const identity = portablePathIdentity(`${category}.md`);
    if (!SAFE_CATEGORY.test(category) || identities.has(identity)) {
      throw new Error(`${file} category ${category} cannot name a pointer file`);
    }
    identities.add(identity);
    const entries = Array.isArray(value) ? value.filter(isRecord) : [];
    const names = entries.map((entry) => String(entry.name));
    index.push(`- [${category}](${category}.md): ${names.join(", ") || "no projects"}`);
    files.set(
      `${category}.md`,
      `# ${category}\n\n${marker(file)}\n\n${entries.map(entryLine).join("\n") || "No projects."}\n`,
    );
  }
  files.set(
    "README.md",
    `# Projects\n\n${marker(file)}\n\n${index.join("\n") || "No registered projects."}\n`,
  );
  return files;
}

export function registryPointers(
  repoRoot: string,
  registry: RegistryConfig,
  options: { check: boolean },
): PointersResult {
  if (!registry.pointers) throw new Error("registry pointers requires a registry.pointers section");
  const dir = registry.pointers.dir;
  const files = plannedFiles(registry.file, JSON.parse(readWorkspaceText(repoRoot, registry.file)));

  const writes: Array<{ path: string; content: string }> = [];
  for (const [name, content] of files) {
    const path = posix.join(dir, name);
    const current = workspaceLstat(repoRoot, path) ? readWorkspaceText(repoRoot, path) : undefined;
    if (current !== content) writes.push({ path, content });
  }
  const deletes: string[] = [];
  for (const entry of readWorkspaceDirectory(repoRoot, dir, "empty")) {
    if (!entry.isFile() || !entry.name.endsWith(".md") || files.has(entry.name)) continue;
    const path = posix.join(dir, entry.name);
    if (readWorkspaceText(repoRoot, path).includes(marker(registry.file))) deletes.push(path);
  }

  const planned = [
    ...writes.map(({ path }) => `would write ${path}`),
    ...deletes.map((path) => `would delete ${path}`),
  ];
  if (!options.check) {
    for (const { path, content } of writes) writeWorkspaceText(repoRoot, path, content);
    for (const path of deletes) unlinkWorkspaceFile(repoRoot, path);
  }
  return { planned };
}
