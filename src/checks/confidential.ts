// Opt-in confidential-content contract. The kit implements no cryptography and
// manages no keys: it verifies, offline and non-destructively, that content a
// workspace declares confidential is recorded in Git as provider ciphertext,
// that the provider's own path policy still covers it, and that no decryption
// identity is tracked. Git itself is the oracle for path policy (`check-attr
// --cached` honours macros, negation, per-directory files, and core.ignorecase)
// because re-deriving `.gitattributes` precedence here would be wrong.
//
// A green result is drift evidence, never proof of confidentiality: without a
// key the kit cannot confirm the ciphertext decrypts or names the intended
// recipients, and it inspects the index only, never older commits.
import { spawnSync } from "node:child_process";
import { resolve, sep } from "node:path";
import { portablePathIdentity, type ConfidentialConfig } from "../config.ts";
import { gitEnvironmentForRepository } from "../lib/gitProcess.ts";
import { globToRegExp } from "./limits.ts";

// git-crypt writes `\0GITCRYPT\0` plus a 12-byte nonce ahead of the ciphertext,
// and `\0GITCRYPTKEY` ahead of a key file. Byte 9 separates the two forms.
const FILE_MAGIC = Buffer.from("\0GITCRYPT\0", "latin1");
const KEY_MAGIC = Buffer.from("\0GITCRYPTKEY", "latin1");
const HEADER_BYTES = KEY_MAGIC.length;
// `cat-file --batch` buffers whole objects, so group requests under a byte
// budget instead of reading the entire protected set in one pass.
const BATCH_BUDGET = 32 * 1024 * 1024;
// Encrypting the files that define policy silently disables that policy.
const POLICY_BASENAMES = new Set([".gitattributes", ".gitignore", ".gitmodules", "workspace.json"]);

export type ConfidentialReport = { errors: string[]; protectedPaths: number };

type IndexEntry = { mode: string; oid: string; stage: string; path: string };

function basename(path: string): string {
  return path.split("/").at(-1) ?? path;
}

function gitText(
  repoRoot: string,
  env: NodeJS.ProcessEnv,
  args: string[],
  input?: string,
): { status: number; stdout: string } {
  const result = spawnSync("git", ["-C", repoRoot, ...args], {
    encoding: "utf8",
    env,
    maxBuffer: BATCH_BUDGET,
    ...(input === undefined ? {} : { input }),
  });
  return { status: result.status ?? 1, stdout: result.stdout ?? "" };
}

// `git commit -a` and `git commit <path>` hand hooks a temporary index through
// GIT_INDEX_FILE; reading the repository's default index instead would inspect
// stale content and pass plaintext that is about to be committed. Honour the
// inherited index only when it belongs to this repository.
function indexEnvironment(repoRoot: string): NodeJS.ProcessEnv {
  const env = gitEnvironmentForRepository();
  const inherited = process.env.GIT_INDEX_FILE;
  if (!inherited) return env;
  const gitDir = gitText(repoRoot, env, ["rev-parse", "--absolute-git-dir"]);
  if (gitDir.status !== 0) throw new Error("could not resolve the Git directory");
  const root = resolve(gitDir.stdout.trim());
  const indexFile = resolve(inherited);
  if (indexFile !== root && !indexFile.startsWith(`${root}${sep}`)) {
    throw new Error("GIT_INDEX_FILE points outside this repository");
  }
  env.GIT_INDEX_FILE = indexFile;
  return env;
}

function indexEntries(repoRoot: string, env: NodeJS.ProcessEnv): IndexEntry[] {
  // `-- :/` is required: without it a run from a subdirectory lists only that
  // subtree, and every protected path outside it would go unchecked.
  const result = gitText(repoRoot, env, ["ls-files", "-s", "-z", "--full-name", "--", ":/"]);
  if (result.status !== 0) throw new Error("could not read the Git index");
  return result.stdout
    .split("\0")
    .filter(Boolean)
    .map((record) => {
      const tab = record.indexOf("\t");
      const [mode = "", oid = "", stage = ""] = record.slice(0, tab).split(" ");
      return { mode, oid, stage, path: record.slice(tab + 1) };
    });
}

function filterAttributes(
  repoRoot: string,
  env: NodeJS.ProcessEnv,
  paths: string[],
): Map<string, string> {
  const out = new Map<string, string>();
  if (paths.length === 0) return out;
  const result = gitText(
    repoRoot,
    env,
    ["check-attr", "--cached", "--stdin", "-z", "filter"],
    `${paths.join("\0")}\0`,
  );
  if (result.status !== 0) throw new Error("could not resolve Git attributes");
  // `-z` output is a flat `path NUL attribute NUL value NUL` stream.
  const fields = result.stdout.split("\0");
  for (let i = 0; i + 2 < fields.length; i += 3) out.set(fields[i]!, fields[i + 2]!);
  return out;
}

function objectSizes(
  repoRoot: string,
  env: NodeJS.ProcessEnv,
  oids: string[],
): Map<string, number> {
  const sizes = new Map<string, number>();
  if (oids.length === 0) return sizes;
  const result = gitText(repoRoot, env, ["cat-file", "--batch-check"], `${oids.join("\n")}\n`);
  if (result.status !== 0) throw new Error("could not inspect indexed content");
  for (const line of result.stdout.split("\n")) {
    const [oid, type, size] = line.split(" ");
    if (!oid || type !== "blob" || size === undefined) continue;
    const bytes = Number.parseInt(size, 10);
    if (Number.isInteger(bytes) && bytes >= 0) sizes.set(oid, bytes);
  }
  return sizes;
}

function parseBatch(stdout: Buffer, headers: Map<string, Buffer>): void {
  let cursor = 0;
  while (cursor < stdout.length) {
    const newline = stdout.indexOf(0x0a, cursor);
    if (newline < 0) return;
    const [oid, type, size] = stdout.subarray(cursor, newline).toString("latin1").split(" ");
    if (!oid) return;
    if (type !== "blob" || size === undefined) {
      cursor = newline + 1; // A `<oid> missing` record carries no payload.
      continue;
    }
    const length = Number.parseInt(size, 10);
    if (!Number.isInteger(length) || length < 0) return;
    const start = newline + 1;
    headers.set(oid, stdout.subarray(start, start + Math.min(length, HEADER_BYTES)));
    cursor = start + length + 1;
  }
}

// Reads the leading bytes of indexed blobs. Only headers are retained; content
// never leaves this function and is never reported.
function objectHeaders(
  repoRoot: string,
  env: NodeJS.ProcessEnv,
  oids: string[],
): Map<string, Buffer> {
  const headers = new Map<string, Buffer>();
  const unique = [...new Set(oids)];
  const sizes = objectSizes(repoRoot, env, unique);
  let batch: string[] = [];
  let bytes = 0;

  const flush = (): void => {
    if (batch.length === 0) return;
    const result = spawnSync("git", ["-C", repoRoot, "cat-file", "--batch"], {
      env,
      input: `${batch.join("\n")}\n`,
      maxBuffer: bytes + 1024,
    });
    if (result.status === 0 && result.stdout) parseBatch(result.stdout, headers);
    batch = [];
    bytes = 0;
  };

  for (const oid of unique) {
    const size = sizes.get(oid);
    if (size === undefined) continue; // Missing or non-blob: reported as unverifiable.
    const cost = size + 64; // Each record adds an oid, a type, a size, and two newlines.
    if (batch.length > 0 && bytes + cost > BATCH_BUDGET) flush();
    batch.push(oid);
    bytes += cost;
  }
  flush();
  return headers;
}

// Candidate discovery for tracked git-crypt key material. `git grep` scans the
// index in one pass; every candidate's header is verified before it is
// reported, so a document that merely mentions the marker is not flagged.
function keyMaterialCandidates(repoRoot: string, env: NodeJS.ProcessEnv): Set<string> {
  const result = gitText(repoRoot, env, [
    "grep",
    "--cached",
    "-l",
    "--text",
    "-z",
    "-F",
    "-e",
    "GITCRYPTKEY",
    "--",
    ":/",
  ]);
  // Exit 1 means no candidates; anything worse is an inspection failure.
  if (result.status > 1) throw new Error("could not search indexed content");
  return new Set(result.stdout.split("\0").filter(Boolean));
}

// The literal directory prefix a pattern can never escape, used to spot a
// submodule mounted at or above a protected root.
function literalPrefix(pattern: string): string {
  const segments: string[] = [];
  for (const segment of pattern.split("/")) {
    if (/[*?]/.test(segment)) break;
    segments.push(segment);
  }
  return segments.join("/");
}

function report(config: ConfidentialConfig, repoRoot: string): ConfidentialReport {
  const env = indexEnvironment(repoRoot);
  const entries = indexEntries(repoRoot, env);
  const errors: string[] = [];

  // Case- and Unicode-folded matching deliberately over-selects: a path that
  // differs from a declared pattern only by spelling is treated as protected,
  // so a case-insensitive author and a case-sensitive collaborator cannot
  // disagree about what is covered.
  const patterns = config.paths.map((path) => ({
    path,
    regex: globToRegExp(portablePathIdentity(path)),
    prefix: portablePathIdentity(literalPrefix(path)),
  }));
  const declares = (path: string): boolean => {
    const identity = portablePathIdentity(path);
    return patterns.some((pattern) => pattern.regex.test(identity));
  };

  const tracked = entries.filter((entry) => entry.stage === "0");
  const unmerged = [...new Set(entries.filter((e) => e.stage !== "0").map((e) => e.path))].sort();
  const protectedEntries = tracked
    .filter((entry) => declares(entry.path))
    .sort((a, b) => a.path.localeCompare(b.path));
  const protectedPaths = new Set(protectedEntries.map((entry) => entry.path));

  if (!tracked.some((entry) => basename(entry.path) === ".gitattributes")) {
    errors.push("git-crypt policy is not committed: no tracked .gitattributes");
  }

  // A pattern that covers nothing is the failure mode that makes a green run
  // meaningless, so it fails rather than passing quietly.
  for (const pattern of patterns) {
    const covered = [...protectedPaths, ...unmerged].some((path) =>
      pattern.regex.test(portablePathIdentity(path)),
    );
    if (!covered) errors.push(`no tracked content matches protected path: ${pattern.path}`);
  }

  // A gitlink at or above a protected root keeps the content in another
  // repository's history, where this contract does not reach.
  for (const entry of tracked) {
    if (entry.mode !== "160000") continue;
    const identity = portablePathIdentity(entry.path);
    const covers = patterns.some(
      (pattern) => pattern.prefix === identity || pattern.prefix.startsWith(`${identity}/`),
    );
    if (covers) errors.push(`protected content is inside a tracked submodule: ${entry.path}`);
  }

  const attributes = filterAttributes(
    repoRoot,
    env,
    tracked.map((entry) => entry.path),
  );
  const candidates = keyMaterialCandidates(repoRoot, env);
  const inspected = [
    ...protectedEntries,
    ...tracked.filter((entry) => candidates.has(entry.path) && !protectedPaths.has(entry.path)),
  ].filter((entry) => entry.mode.startsWith("100"));
  const headers = objectHeaders(
    repoRoot,
    env,
    inspected.map((entry) => entry.oid),
  );
  const isKeyMaterial = (entry: IndexEntry): boolean =>
    headers.get(entry.oid)?.equals(KEY_MAGIC) === true;

  // One finding per protected path, most specific first: an unverifiable entry
  // must not also be reported as plaintext.
  for (const entry of protectedEntries) {
    if (unmerged.includes(entry.path)) continue; // Reported with the unmerged paths.
    const header = headers.get(entry.oid);
    if (POLICY_BASENAMES.has(basename(entry.path))) {
      errors.push(`protected path must not cover Git or workspace policy: ${entry.path}`);
    } else if (!entry.mode.startsWith("100")) {
      errors.push(`protected path is not a regular file: ${entry.path}`);
    } else if (isKeyMaterial(entry)) {
      errors.push(`git-crypt key material is tracked: ${entry.path}`);
    } else if (attributes.get(entry.path) !== "git-crypt") {
      errors.push(`protected path is not covered by git-crypt policy: ${entry.path}`);
    } else if (header === undefined) {
      errors.push(`protected path could not be verified: ${entry.path}`);
    } else if (!header.subarray(0, FILE_MAGIC.length).equals(FILE_MAGIC)) {
      errors.push(`protected path is staged as plaintext: ${entry.path}`);
    }
  }

  for (const path of unmerged) {
    if (declares(path)) {
      errors.push(`protected path is unmerged and cannot be verified: ${path}`);
    }
  }

  // Inverse coverage: content the provider encrypts that the workspace never
  // declared. This is how a spelling variant or a stale pattern surfaces.
  for (const entry of tracked) {
    if (attributes.get(entry.path) === "git-crypt" && !protectedPaths.has(entry.path)) {
      errors.push(`git-crypt covers an undeclared path: ${entry.path}`);
    }
  }

  for (const entry of inspected) {
    if (!protectedPaths.has(entry.path) && isKeyMaterial(entry)) {
      errors.push(`git-crypt key material is tracked: ${entry.path}`);
    }
  }

  // git-crypt's GPG mode commits encrypted copies of the symmetric key under
  // .git-crypt/, and its own .gitattributes is what stops the filter from
  // encrypting them in turn.
  const keyDirectory = tracked.filter((entry) => entry.path.startsWith(".git-crypt/"));
  if (
    keyDirectory.length > 0 &&
    !keyDirectory.some((entry) => entry.path === ".git-crypt/.gitattributes")
  ) {
    errors.push("git-crypt key directory is tracked without .git-crypt/.gitattributes");
  }

  return { errors, protectedPaths: protectedPaths.size };
}

export function confidentialSummary(
  config: ConfidentialConfig,
  report: ConfidentialReport,
): string {
  const count = report.protectedPaths;
  return `confidential ok (${config.provider}, ${count} protected path${count === 1 ? "" : "s"})`;
}

export function confidentialReport(config: ConfidentialConfig, repoRoot = "."): ConfidentialReport {
  try {
    return report(config, repoRoot);
  } catch (error) {
    // Operational failures are check failures, not crashes: a confidentiality
    // gate that cannot inspect the index must never report success.
    return {
      errors: [error instanceof Error ? error.message : String(error)],
      protectedPaths: 0,
    };
  }
}
