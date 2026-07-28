import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import {
  parseWorkspaceConfig,
  portablePathIdentity,
  type ConfidentialConfig,
  type WorkspaceConfig,
} from "../config.ts";
import { gitEnvironmentForRepository } from "../lib/gitProcess.ts";

const GIT_CRYPT_HEADER = Buffer.from([0x00, 0x47, 0x49, 0x54, 0x43, 0x52, 0x59, 0x50, 0x54, 0x00]);
const GIT_CRYPT_MINIMUM_BLOB_SIZE = 22;
const MAX_GIT_METADATA_BYTES = 64 * 1024 * 1024;
const CONTROL_FILES = new Set(
  [".gitattributes", ".gitignore", ".gitmodules", "workspace.json"].map(portablePathIdentity),
);

type IndexEntry = {
  mode: string;
  objectId: string;
  stage: number;
  path: string;
};

export type ConfidentialCheckResult = {
  enabled: boolean;
  errors: string[];
};

function gitEnvironment(): NodeJS.ProcessEnv {
  const environment = gitEnvironmentForRepository();
  if (process.env.GIT_INDEX_FILE) {
    environment.GIT_INDEX_FILE = process.env.GIT_INDEX_FILE;
  }
  environment.GIT_ATTR_NOSYSTEM = "1";
  environment.GIT_CONFIG_NOSYSTEM = "1";
  environment.GIT_NO_LAZY_FETCH = "1";
  environment.GIT_NO_REPLACE_OBJECTS = "1";
  return environment;
}

function git(
  repoRoot: string,
  args: string[],
  options: {
    environment?: NodeJS.ProcessEnv;
    input?: string | Buffer;
    maxBuffer?: number;
  } = {},
) {
  return spawnSync("git", args, {
    cwd: repoRoot,
    encoding: null,
    env: options.environment ?? gitEnvironment(),
    input: options.input,
    maxBuffer: options.maxBuffer,
  });
}

function gitPath(repoRoot: string, path: string): string {
  const result = git(repoRoot, ["rev-parse", "--path-format=absolute", "--git-path", path]);
  if (result.status !== 0) {
    throw new Error(gitFailure(result, `could not resolve Git ${path}`));
  }
  const value = result.stdout.toString("utf8").trim();
  return isAbsolute(value) ? value : resolve(repoRoot, value);
}

function gitObjectFormat(repoRoot: string): string {
  const result = git(repoRoot, ["rev-parse", "--show-object-format"]);
  if (result.status !== 0) {
    throw new Error(gitFailure(result, "could not inspect the Git object format"));
  }
  const format = result.stdout.toString("utf8").trim();
  if (format !== "sha1" && format !== "sha256") {
    throw new Error(`unsupported Git object format: ${format || "unknown"}`);
  }
  return format;
}

function copySharedIndexState(repoRoot: string, isolatedGitDir: string): void {
  const result = git(repoRoot, ["rev-parse", "--shared-index-path"]);
  if (result.status !== 0) {
    throw new Error(gitFailure(result, "could not inspect Git split-index state"));
  }
  const sharedIndex = result.stdout.toString("utf8").trim();
  if (!sharedIndex) return;
  const source = isAbsolute(sharedIndex) ? sharedIndex : resolve(repoRoot, sharedIndex);
  try {
    copyFileSync(source, join(isolatedGitDir, basename(source)));
  } catch {
    throw new Error("could not isolate Git split-index state");
  }
}

function gitFailure(result: ReturnType<typeof git>, fallback: string): string {
  const stderr = result.stderr?.toString("utf8").trim();
  return stderr || fallback;
}

function indexEntries(repoRoot: string, pathspecs: readonly string[]): IndexEntry[] {
  const result = git(repoRoot, ["ls-files", "--stage", "-z", "--", ...pathspecs], {
    maxBuffer: MAX_GIT_METADATA_BYTES,
  });
  if (result.status !== 0) {
    if (result.error && "code" in result.error && result.error.code === "ENOBUFS") {
      throw new Error("protected Git index metadata exceeds the 64 MiB validation limit");
    }
    throw new Error(gitFailure(result, "could not inspect the Git index"));
  }
  const records = result.stdout.toString("utf8").split("\0");
  const entries: IndexEntry[] = [];
  for (const record of records) {
    if (!record) continue;
    const separator = record.indexOf("\t");
    const metadata = separator === -1 ? record : record.slice(0, separator);
    const path = separator === -1 ? "" : record.slice(separator + 1);
    const match = /^(\d+) ([0-9a-f]+) ([0-3])$/.exec(metadata);
    if (!match || !path) throw new Error("Git returned an invalid index entry");
    entries.push({
      mode: match[1]!,
      objectId: match[2]!,
      stage: Number.parseInt(match[3]!, 10),
      path,
    });
  }
  return entries;
}

function readBlob(repoRoot: string, objectId: string, maxBuffer: number): Buffer {
  const result = git(repoRoot, ["cat-file", "blob", objectId], { maxBuffer });
  if (result.status !== 0) {
    if (result.error && "code" in result.error && result.error.code === "ENOBUFS") {
      throw new Error(`Git object ${objectId} exceeds the validation limit`);
    }
    throw new Error(gitFailure(result, `could not read Git object ${objectId}`));
  }
  return result.stdout;
}

function stagedConfig(
  repoRoot: string,
  entries: readonly IndexEntry[],
): ConfidentialConfig | undefined {
  const candidates = entries.filter((entry) => entry.path === "workspace.json");
  if (candidates.some((entry) => entry.stage !== 0)) {
    throw new Error("staged workspace.json has unresolved conflicts");
  }
  const entry = candidates.find((candidate) => candidate.stage === 0);
  if (!entry) return undefined;

  let content: Buffer;
  try {
    content = readBlob(repoRoot, entry.objectId, MAX_GIT_METADATA_BYTES);
  } catch (error) {
    throw new Error(
      `staged workspace.json is not usable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(content.toString("utf8"));
  } catch {
    throw new Error("staged workspace.json is not usable: invalid JSON");
  }
  if (
    typeof raw !== "object" ||
    raw === null ||
    Array.isArray(raw) ||
    !Object.hasOwn(raw, "confidential")
  ) {
    return undefined;
  }

  let parsed: WorkspaceConfig;
  try {
    parsed = parseWorkspaceConfig(raw);
  } catch (error) {
    throw new Error(
      `staged workspace.json is not usable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return parsed.confidential;
}

function committedConfigAt(repoRoot: string, revision: string): ConfidentialConfig | undefined {
  const tree = git(repoRoot, ["ls-tree", "-z", revision, "--", "workspace.json"], {
    maxBuffer: MAX_GIT_METADATA_BYTES,
  });
  if (tree.status !== 0) {
    throw new Error(gitFailure(tree, "could not inspect committed workspace.json"));
  }
  const record = tree.stdout.toString("utf8");
  if (!record) return undefined;
  if (!record.endsWith("\0")) {
    throw new Error("Git returned invalid committed workspace.json metadata");
  }
  const match = /^\d+ blob ([0-9a-f]+)\tworkspace\.json$/.exec(record.slice(0, -1));
  if (!match) throw new Error("Git returned invalid committed workspace.json metadata");

  let content: Buffer;
  try {
    content = readBlob(repoRoot, match[1]!, MAX_GIT_METADATA_BYTES);
  } catch (error) {
    throw new Error(
      `committed workspace.json is not usable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(content.toString("utf8"));
  } catch {
    throw new Error("committed workspace.json is not usable: invalid JSON");
  }
  if (
    typeof raw !== "object" ||
    raw === null ||
    Array.isArray(raw) ||
    !Object.hasOwn(raw, "confidential")
  ) {
    return undefined;
  }
  try {
    return parseWorkspaceConfig(raw).confidential;
  } catch (error) {
    throw new Error(
      `committed workspace.json is not usable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function committedConfig(repoRoot: string): ConfidentialConfig | undefined {
  const head = git(repoRoot, ["rev-parse", "--verify", "HEAD^{commit}"]);
  if (head.status !== 0) {
    const symbolicHead = git(repoRoot, ["symbolic-ref", "-q", "HEAD"]);
    if (symbolicHead.status !== 0) {
      throw new Error(gitFailure(head, "could not inspect committed workspace.json history"));
    }
    const reference = symbolicHead.stdout.toString("utf8").trim();
    const branch = git(repoRoot, ["show-ref", "--verify", "--quiet", reference]);
    if (branch.status === 1) return undefined;
    throw new Error(gitFailure(head, "could not inspect committed workspace.json history"));
  }
  return committedConfigAt(repoRoot, "HEAD");
}

function protectedBy(path: string, roots: readonly string[]): boolean {
  const identity = portablePathIdentity(path);
  return roots.some((root) => {
    const rootIdentity = portablePathIdentity(root);
    return identity === rootIdentity || identity.startsWith(`${rootIdentity}/`);
  });
}

function isConfiguredRoot(path: string, roots: readonly string[]): boolean {
  const identity = portablePathIdentity(path);
  return roots.some((root) => identity === portablePathIdentity(root));
}

function ancestorPaths(roots: readonly string[]): string[] {
  const paths = new Set<string>();
  for (const root of roots) {
    const components = root.split("/");
    for (let length = 1; length < components.length; length += 1) {
      paths.add(components.slice(0, length).join("/"));
    }
  }
  return [...paths];
}

function trackedAncestorErrors(repoRoot: string, ancestors: readonly string[]): string[] {
  const errors: string[] = [];
  for (const path of ancestors) {
    let tracked = false;
    for (const stage of [0, 1, 2, 3]) {
      const result = git(repoRoot, ["rev-parse", "--verify", "--quiet", `:${stage}:${path}`]);
      if (result.status === 0) {
        tracked = true;
        break;
      }
      if (result.status !== 1) {
        throw new Error(
          gitFailure(result, `could not inspect staged ancestor ${displayPath(path)}`),
        );
      }
    }
    if (tracked) {
      errors.push(`${displayPath(path)}: confidential roots cannot traverse tracked entries`);
    }
  }
  return errors;
}

function displayPath(path: string): string {
  return JSON.stringify(path);
}

function stagedPolicyErrors(
  repoRoot: string,
  entries: readonly IndexEntry[],
  roots: readonly string[],
): string[] {
  const candidates = entries.filter((entry) => entry.path === ".gitattributes");
  if (candidates.some((entry) => entry.stage !== 0)) {
    return [".gitattributes: staged policy has unresolved index conflicts"];
  }
  const entry = candidates.find((candidate) => candidate.stage === 0);
  if (!entry || (entry.mode !== "100644" && entry.mode !== "100755")) {
    return [".gitattributes: confidential roots require a staged regular policy file"];
  }

  let lines: string[];
  try {
    lines = readBlob(repoRoot, entry.objectId, MAX_GIT_METADATA_BYTES)
      .toString("utf8")
      .split(/\r?\n/);
  } catch (error) {
    return [`.gitattributes: ${error instanceof Error ? error.message : String(error)}`];
  }
  const rules = lines
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => line.split(/\s+/));

  const errors: string[] = [];
  const requiredPatterns = new Set(roots.map((root) => `${root}/**`));
  const finalRules = rules.slice(-requiredPatterns.size);
  const finalPatterns = new Set(
    finalRules
      .filter(
        (tokens) =>
          tokens.length === 3 && tokens[1] === "filter=git-crypt" && tokens[2] === "diff=git-crypt",
      )
      .map((tokens) => tokens[0]!),
  );
  if (
    finalPatterns.size !== requiredPatterns.size ||
    [...requiredPatterns].some((pattern) => !finalPatterns.has(pattern))
  ) {
    errors.push(".gitattributes: canonical confidential root rules must be the final rules");
  }
  for (const root of roots) {
    const pattern = `${root}/**`;
    const covered = rules.some(
      (tokens) =>
        tokens.length === 3 &&
        tokens[0] === pattern &&
        tokens[1] === "filter=git-crypt" &&
        tokens[2] === "diff=git-crypt",
    );
    if (!covered) {
      errors.push(`.gitattributes: missing staged rule ${pattern} filter=git-crypt diff=git-crypt`);
    }
  }
  return errors;
}

function cachedAttributes(
  repoRoot: string,
  paths: readonly string[],
): Map<string, Map<string, string>> {
  if (paths.length === 0) return new Map();
  const isolatedGitDir = mkdtempSync(join(tmpdir(), "workspace-kit-attributes-"));
  try {
    const initialize = git(repoRoot, [
      "init",
      "--bare",
      "-q",
      `--object-format=${gitObjectFormat(repoRoot)}`,
      isolatedGitDir,
    ]);
    if (initialize.status !== 0) {
      throw new Error(gitFailure(initialize, "could not create isolated Git attribute state"));
    }
    copySharedIndexState(repoRoot, isolatedGitDir);
    mkdirSync(join(isolatedGitDir, "info"), { recursive: true });
    const environment = gitEnvironmentForRepository();
    environment.GIT_ATTR_NOSYSTEM = "1";
    environment.GIT_CONFIG_GLOBAL = "/dev/null";
    environment.GIT_CONFIG_NOSYSTEM = "1";
    environment.GIT_DIR = isolatedGitDir;
    environment.GIT_INDEX_FILE ??= gitPath(repoRoot, "index");
    environment.GIT_NO_REPLACE_OBJECTS = "1";
    environment.GIT_OBJECT_DIRECTORY = gitPath(repoRoot, "objects");
    environment.GIT_WORK_TREE = resolve(repoRoot);

    const result = git(
      repoRoot,
      [
        "-c",
        "core.attributesFile=/dev/null",
        "check-attr",
        "--cached",
        "-z",
        "--stdin",
        "filter",
        "diff",
      ],
      {
        environment,
        input: `${paths.join("\0")}\0`,
        maxBuffer: MAX_GIT_METADATA_BYTES,
      },
    );
    if (result.status !== 0) {
      if (result.error && "code" in result.error && result.error.code === "ENOBUFS") {
        throw new Error("protected Git attribute metadata exceeds the 64 MiB validation limit");
      }
      throw new Error(gitFailure(result, "could not inspect staged Git attributes"));
    }

    const fields = result.stdout.toString("utf8").split("\0");
    if (fields.at(-1) === "") fields.pop();
    if (fields.length !== paths.length * 6) {
      throw new Error("Git returned invalid staged attribute data");
    }
    const attributes = new Map<string, Map<string, string>>();
    for (let index = 0; index < fields.length; index += 3) {
      const path = fields[index]!;
      const attribute = fields[index + 1]!;
      const value = fields[index + 2]!;
      const values = attributes.get(path) ?? new Map<string, string>();
      values.set(attribute, value);
      attributes.set(path, values);
    }
    return attributes;
  } finally {
    rmSync(isolatedGitDir, { recursive: true, force: true });
  }
}

function blobHasGitCryptHeader(repoRoot: string, entry: IndexEntry): boolean {
  const size = git(repoRoot, ["cat-file", "-s", entry.objectId]);
  if (size.status !== 0) {
    throw new Error(gitFailure(size, `could not inspect Git object ${entry.objectId}`));
  }
  const parsedSize = Number.parseInt(size.stdout.toString("utf8").trim(), 10);
  if (!Number.isSafeInteger(parsedSize) || parsedSize < GIT_CRYPT_MINIMUM_BLOB_SIZE) {
    return false;
  }

  // A deliberately tiny maxBuffer makes Git stop after the first output chunk,
  // bounding memory even for large encrypted artifacts. ENOBUFS is expected.
  const result = git(repoRoot, ["cat-file", "blob", entry.objectId], {
    maxBuffer: GIT_CRYPT_HEADER.length,
  });
  if (
    result.status !== 0 &&
    !(result.error && "code" in result.error && result.error.code === "ENOBUFS")
  ) {
    throw new Error(gitFailure(result, `could not read Git object ${entry.objectId}`));
  }
  return result.stdout.subarray(0, GIT_CRYPT_HEADER.length).equals(GIT_CRYPT_HEADER);
}

export function confidentialCheck(
  repoRoot: string,
  current: WorkspaceConfig,
): ConfidentialCheckResult {
  if (!current.confidential) {
    const prefix = git(repoRoot, ["rev-parse", "--show-prefix"]);
    if (prefix.status !== 0) {
      if (!existsSync(join(repoRoot, ".git"))) return { enabled: false, errors: [] };
      return {
        enabled: true,
        errors: [gitFailure(prefix, "could not inspect the Git repository")],
      };
    }
    if (prefix.stdout.toString("utf8").trim()) {
      return { enabled: false, errors: [] };
    }
  }

  let configEntries: IndexEntry[];
  try {
    configEntries = indexEntries(repoRoot, ["workspace.json"]);
  } catch (error) {
    return {
      enabled: true,
      errors: [error instanceof Error ? error.message : String(error)],
    };
  }

  let proposed: ConfidentialConfig | undefined;
  let committed: ConfidentialConfig | undefined;
  try {
    proposed = stagedConfig(repoRoot, configEntries);
    committed = committedConfig(repoRoot);
  } catch (error) {
    return {
      enabled: true,
      errors: [error instanceof Error ? error.message : String(error)],
    };
  }

  const roots = [
    ...new Set([
      ...(current.confidential?.roots ?? []),
      ...(proposed?.roots ?? []),
      ...(committed?.roots ?? []),
    ]),
  ];
  if (roots.length === 0) return { enabled: false, errors: [] };

  let entries: IndexEntry[];
  const ancestors = ancestorPaths(roots);
  const ancestorAttributes = ancestors.map((path) => `${path}/.gitattributes`);
  try {
    entries = indexEntries(repoRoot, [
      ".gitattributes",
      ...ancestorAttributes.map((path) => `:(icase,literal)${path}`),
      ...roots.map((root) => `:(icase,literal)${root}`),
    ]);
  } catch (error) {
    return {
      enabled: true,
      errors: [error instanceof Error ? error.message : String(error)],
    };
  }

  let errors: string[];
  try {
    errors = [
      ...stagedPolicyErrors(repoRoot, entries, roots),
      ...trackedAncestorErrors(repoRoot, ancestors),
    ];
  } catch (error) {
    return {
      enabled: true,
      errors: [error instanceof Error ? error.message : String(error)],
    };
  }
  const ancestorIdentities = new Set(ancestorAttributes.map(portablePathIdentity));
  for (const entry of entries) {
    if (ancestorIdentities.has(portablePathIdentity(entry.path))) {
      errors.push(
        `${displayPath(entry.path)}: attribute files above confidential roots are not supported`,
      );
    }
  }
  const protectedEntries = entries.filter((entry) => protectedBy(entry.path, roots));
  const conflictedPaths = new Set(
    protectedEntries.filter((entry) => entry.stage !== 0).map((entry) => entry.path),
  );
  for (const path of [...conflictedPaths].sort()) {
    errors.push(`${displayPath(path)}: protected path has unresolved index conflicts`);
  }

  const candidates = protectedEntries.filter((entry) => entry.stage === 0);
  const regular = candidates.filter(
    (entry) =>
      !isConfiguredRoot(entry.path, roots) && (entry.mode === "100644" || entry.mode === "100755"),
  );
  for (const entry of candidates) {
    const basename = entry.path.slice(entry.path.lastIndexOf("/") + 1);
    if (isConfiguredRoot(entry.path, roots)) {
      errors.push(`${displayPath(entry.path)}: confidential roots must be directories`);
    } else if (
      CONTROL_FILES.has(portablePathIdentity(basename)) ||
      portablePathIdentity(entry.path).startsWith(".GIT-CRYPT/")
    ) {
      errors.push(`${displayPath(entry.path)}: repository control files cannot be protected`);
    } else if (entry.mode !== "100644" && entry.mode !== "100755") {
      errors.push(`${displayPath(entry.path)}: protected paths must be regular files`);
    }
  }

  const policyProbes = roots.map((root) => `${root}/.workspace-kit-policy-probe`);
  let attributes: Map<string, Map<string, string>>;
  try {
    attributes = cachedAttributes(repoRoot, [
      ...new Set([...regular.map((entry) => entry.path), ...policyProbes]),
    ]);
  } catch (error) {
    return {
      enabled: true,
      errors: [...errors, error instanceof Error ? error.message : String(error)],
    };
  }

  for (let index = 0; index < roots.length; index += 1) {
    const root = roots[index]!;
    const values = attributes.get(policyProbes[index]!);
    const filter = values?.get("filter") ?? "unspecified";
    const diff = values?.get("diff") ?? "unspecified";
    if (filter !== "git-crypt" || diff !== "git-crypt") {
      errors.push(
        `${displayPath(root)}: staged root policy is not effectively filter=git-crypt diff=git-crypt`,
      );
    }
  }

  for (const entry of regular) {
    const values = attributes.get(entry.path);
    const filter = values?.get("filter") ?? "unspecified";
    const diff = values?.get("diff") ?? "unspecified";
    if (filter !== "git-crypt") {
      errors.push(`${displayPath(entry.path)}: staged filter attribute must be git-crypt`);
    }
    if (diff !== "git-crypt") {
      errors.push(`${displayPath(entry.path)}: staged diff attribute must be git-crypt`);
    }
    try {
      if (!blobHasGitCryptHeader(repoRoot, entry)) {
        errors.push(`${displayPath(entry.path)}: staged content is not git-crypt ciphertext`);
      }
    } catch (error) {
      errors.push(
        `${displayPath(entry.path)}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return { enabled: true, errors };
}
