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
import { readFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import {
  CONFIG_FILE,
  parseWorkspaceConfig,
  portablePathIdentity,
  type ConfidentialConfig,
} from "../config.ts";
import { gitEnvironmentForRepository } from "../lib/gitProcess.ts";
import { globToRegExp } from "./limits.ts";

// git-crypt writes `\0GITCRYPT\0` plus a 12-byte nonce ahead of the ciphertext,
// and `\0GITCRYPTKEY` ahead of a key file. Byte 9 separates the two forms.
const FILE_MAGIC = Buffer.from("\0GITCRYPT\0", "latin1");
const KEY_MAGIC = Buffer.from("\0GITCRYPTKEY", "latin1");
// The magic alone is not ciphertext: anything shorter than the framing cannot
// have been produced by the provider, so a short secret behind a copied magic
// must not read as encrypted.
const FRAMING_BYTES = FILE_MAGIC.length + 12;
const HEADER_BYTES = Math.max(FRAMING_BYTES, KEY_MAGIC.length);
// `cat-file --batch` buffers whole objects, so group requests under a byte
// budget instead of reading the entire protected set in one pass.
const BATCH_BUDGET = 8 * 1024 * 1024;
// An object above this is read on its own with a bounded buffer, so a large
// protected archive costs a header read rather than its own size in memory.
const BATCH_OBJECT_LIMIT = 1024 * 1024;
// Encrypting the files that define policy silently disables that policy. Names
// are folded like every other path comparison here, so a case variant that is
// the real policy file on a case-insensitive checkout cannot slip through.
// `.gitattributes` and `.gitignore` are per-directory policy at any depth; the
// other two are policy only at the repository root, where a nested file of the
// same name is ordinary content.
const POLICY_BASENAMES = new Set([".gitattributes", ".gitignore"].map(portablePathIdentity));
const POLICY_PATHS = new Set([".gitmodules", CONFIG_FILE].map(portablePathIdentity));
// `git-crypt init -k <name>` installs a per-key filter, so coverage is the
// default filter or one of that namespace.
const PROVIDER_FILTER = /^git-crypt(-[A-Za-z0-9._-]+)?$/;

export type ConfidentialReport = { errors: string[]; protectedPaths: number };

type IndexEntry = { mode: string; oid: string; stage: string; path: string };
// `completed` separates "git ran and exited" from "git could not be run":
// spawnSync reports the latter with a null status, and a check that read that
// as an ordinary exit code would treat a truncated scan as a clean one.
type GitResult = { completed: boolean; status: number; stdout: string };

function basename(path: string): string {
  return path.split("/").at(-1) ?? path;
}

function gitText(
  repoRoot: string,
  env: NodeJS.ProcessEnv,
  args: string[],
  input?: string,
): GitResult {
  const result = spawnSync("git", ["-C", repoRoot, ...args], {
    encoding: "utf8",
    env,
    maxBuffer: BATCH_BUDGET,
    ...(input === undefined ? {} : { input }),
  });
  return {
    completed: result.error === undefined && result.status !== null,
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
  };
}

function gitOutput(
  repoRoot: string,
  env: NodeJS.ProcessEnv,
  args: string[],
  failure: string,
  input?: string,
): string {
  const result = gitText(repoRoot, env, args, input);
  if (!result.completed || result.status !== 0) throw new Error(failure);
  return result.stdout;
}

type Repository = { root: string; commonDir: string; env: NodeJS.ProcessEnv };

// Distinguished because "there is no repository" is the one failure that proves
// nothing can be staged; every other failure only proves we could not look.
const NOT_A_REPOSITORY = "not a Git repository";

// Every path this check handles is repository-root-relative, and Git resolves
// pathspecs and `check-attr` inputs against its own working directory: running
// from a subdirectory would silently evaluate the wrong paths. Resolve the top
// level once and run everything there.
//
// `git commit -a` and `git commit <path>` hand hooks a temporary index through
// GIT_INDEX_FILE; reading the repository's default index instead would inspect
// stale content and pass plaintext that is about to be committed. Honour the
// inherited index only when it belongs to this repository.
function repository(repoRoot: string): Repository {
  const env = gitEnvironmentForRepository();
  // Attribute rules from outside the repository are not part of any clone, and
  // a local replacement ref could otherwise substitute ciphertext for the
  // plaintext object the tree actually records.
  env.GIT_ATTR_NOSYSTEM = "1";
  env.GIT_NO_REPLACE_OBJECTS = "1";
  const [top = "", gitDir = "", common = ""] = gitOutput(
    repoRoot,
    env,
    ["rev-parse", "--show-toplevel", "--absolute-git-dir", "--git-common-dir"],
    NOT_A_REPOSITORY,
  )
    .split("\n")
    .map((line) => line.trim());
  if (!top || !gitDir) throw new Error("could not resolve the repository root");
  const root = resolve(top);
  const inherited = process.env.GIT_INDEX_FILE;
  if (inherited) {
    const directory = resolve(gitDir);
    const indexFile = resolve(inherited);
    if (indexFile !== directory && !indexFile.startsWith(`${directory}${sep}`)) {
      throw new Error("GIT_INDEX_FILE points outside this repository");
    }
    env.GIT_INDEX_FILE = indexFile;
  }
  // `--git-common-dir` can be relative, and it is relative to the directory Git
  // ran in — `repoRoot`, not the top level. Resolving it against the top level
  // would inspect a sibling `.git` whenever this runs from a subdirectory.
  return { root, commonDir: resolve(repoRoot, common), env };
}

function indexEntries({ root, env }: Repository): IndexEntry[] {
  // `-- :/` pins the pathspec to the whole repository rather than a subtree.
  return gitOutput(
    root,
    env,
    ["ls-files", "-s", "-z", "--full-name", "--", ":/"],
    "could not read the Git index",
  )
    .split("\0")
    .filter(Boolean)
    .map((record) => {
      const tab = record.indexOf("\t");
      const [mode = "", oid = "", stage = ""] = record.slice(0, tab).split(" ");
      return { mode, oid, stage, path: record.slice(tab + 1) };
    });
}

function filterAttributes({ root, env }: Repository, paths: string[]): Map<string, string> {
  const out = new Map<string, string>();
  if (paths.length === 0) return out;
  // A rule that is not committed protects nothing in a clone, so every
  // attribute source outside the index is excluded: `--cached` ignores the
  // working tree, `core.attributesFile=/dev/null` drops the user's global file,
  // and GIT_ATTR_NOSYSTEM drops the system-wide one. Git offers no equivalent
  // for `$GIT_COMMON_DIR/info/attributes`, which is reported separately.
  const stdout = gitOutput(
    root,
    env,
    ["-c", "core.attributesFile=/dev/null", "check-attr", "--cached", "--stdin", "-z", "filter"],
    "could not resolve Git attributes",
    `${paths.join("\0")}\0`,
  );
  // `-z` output is a flat `path NUL attribute NUL value NUL` stream.
  const fields = stdout.split("\0");
  for (let i = 0; i + 2 < fields.length; i += 3) out.set(fields[i]!, fields[i + 2]!);
  return out;
}

// Git gives the repository-local, uncommitted attributes file the highest
// precedence and offers no way to ignore it, so any rule there is policy that no
// clone receives. Its effect cannot be narrowed by inspection either: a tracked
// `[attr]` macro lets `info/attributes` grant git-crypt coverage without ever
// naming the provider. Any effective line is therefore reported.
function localAttributeOverride({ commonDir }: Repository): boolean {
  let content: string;
  try {
    content = readFileSync(resolve(commonDir, "info", "attributes"), "utf8");
  } catch {
    return false; // No repository-local attributes file, or it is unreadable.
  }
  return content
    .split("\n")
    .some((line) => line.trim().length > 0 && !line.trimStart().startsWith("#"));
}

function stagedPolicy(repo: Repository, oid: string): ConfidentialConfig | undefined {
  const result = gitText(repo.root, repo.env, ["cat-file", "blob", oid]);
  if (!result.completed || result.status !== 0) return undefined;
  try {
    return parseWorkspaceConfig(JSON.parse(result.stdout)).confidential;
  } catch {
    return undefined;
  }
}

function samePolicy(a: ConfidentialConfig, b: ConfidentialConfig): boolean {
  return (
    a.provider === b.provider &&
    a.paths.length === b.paths.length &&
    a.paths.every((path, index) => path === b.paths[index])
  );
}

// Only the exact path binds. A case alias such as `Workspace.json` can be the
// real configuration on one filesystem and a decoy on another, so it is
// reported rather than read.
function stagedConfigEntry(tracked: readonly IndexEntry[]): IndexEntry | undefined {
  return tracked.find((entry) => entry.path === CONFIG_FILE && entry.mode.startsWith("100"));
}

function stagedConfigAliases(tracked: readonly IndexEntry[]): string[] {
  const wanted = portablePathIdentity(CONFIG_FILE);
  return tracked
    .filter((entry) => entry.path !== CONFIG_FILE && portablePathIdentity(entry.path) === wanted)
    .map((entry) => entry.path);
}

// The commit carries its own policy, so a workspace whose working-tree config
// has dropped the section is still bound by the declaration in its index: the
// alternative lets an unstaged config edit switch the gate off for a partial
// commit. Absent from both is genuinely disabled — but "could not tell" is not
// absence, so an unreadable staged config is reported separately.
export type IndexedPolicy = { policy: ConfidentialConfig | undefined; unreadable: boolean };

export function indexedConfidentialPolicy(repoRoot = "."): IndexedPolicy {
  let repo: Repository;
  try {
    repo = repository(repoRoot);
  } catch (error) {
    // Only the absence of a repository proves nothing is staged. A rejected
    // index or any other failure means we could not look, which must not pass
    // for an absent policy.
    const absent = error instanceof Error && error.message === NOT_A_REPOSITORY;
    return { policy: undefined, unreadable: !absent };
  }

  // `:<path>` addresses that exact path in the index relative to the repository
  // root, and `--batch-check` reports an absent entry as `missing` while still
  // exiting zero. That keeps "no staged policy" distinguishable from "could not
  // look" without listing the whole index on every run of every workspace,
  // including the ones that never adopted this section.
  const probe = gitText(repo.root, repo.env, ["cat-file", "--batch-check"], `:${CONFIG_FILE}\n`);
  if (!probe.completed || probe.status !== 0) return { policy: undefined, unreadable: true };
  const [oid, type] = probe.stdout.trim().split(" ");
  if (!oid || type !== "blob") return { policy: undefined, unreadable: false };

  const result = gitText(repo.root, repo.env, ["cat-file", "blob", oid]);
  if (!result.completed || result.status !== 0) return { policy: undefined, unreadable: true };
  try {
    return {
      policy: parseWorkspaceConfig(JSON.parse(result.stdout)).confidential,
      unreadable: false,
    };
  } catch {
    return { policy: undefined, unreadable: true };
  }
}

function objectSizes({ root, env }: Repository, oids: string[]): Map<string, number> {
  const sizes = new Map<string, number>();
  if (oids.length === 0) return sizes;
  const stdout = gitOutput(
    root,
    env,
    ["cat-file", "--batch-check"],
    "could not inspect indexed content",
    `${oids.join("\n")}\n`,
  );
  for (const line of stdout.split("\n")) {
    const [oid, type, size] = line.split(" ");
    if (!oid || type !== "blob" || size === undefined) continue;
    const bytes = Number.parseInt(size, 10);
    if (Number.isInteger(bytes) && bytes >= 0) sizes.set(oid, bytes);
  }
  return sizes;
}

// An oversized object is read on its own with a bounded buffer. Only the header
// is needed, so a truncated read is still conclusive; a read that does not even
// reach the header leaves the object unverified, which fails closed.
function oversizedHeader({ root, env }: Repository, oid: string): Buffer | undefined {
  const result = spawnSync("git", ["-C", root, "cat-file", "blob", oid], {
    env,
    maxBuffer: BATCH_OBJECT_LIMIT,
  });
  const stdout = result.stdout;
  if (!stdout || stdout.length < HEADER_BYTES) return undefined;
  return stdout.subarray(0, HEADER_BYTES);
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
function objectHeaders(repo: Repository, oids: string[]): Map<string, Buffer> {
  const headers = new Map<string, Buffer>();
  const unique = [...new Set(oids)];
  const sizes = objectSizes(repo, unique);
  let batch: string[] = [];
  let bytes = 0;

  const flush = (): void => {
    if (batch.length === 0) return;
    const result = spawnSync("git", ["-C", repo.root, "cat-file", "--batch"], {
      env: repo.env,
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
    if (size > BATCH_OBJECT_LIMIT) {
      const header = oversizedHeader(repo, oid);
      if (header) headers.set(oid, header);
      continue;
    }
    // Each record adds the object id, a type, a decimal size, separators, and
    // two newlines. Deriving the width from the id keeps SHA-256 repositories,
    // whose ids are twice as wide, inside the buffer.
    const cost = size + oid.length + 40;
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
//
// This recognizes the headered key format only. git-crypt still loads pre-0.4
// keys, which are raw key bytes with no header and are therefore
// indistinguishable from any other small binary blob offline — the contract
// documents that constraint rather than pretending to detect them.
function keyMaterialCandidates({ root, env }: Repository): Set<string> {
  const result = gitText(root, env, [
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
  // Exit 1 is grep's "no candidates"; a scan that did not run to completion
  // must never be read as a clean one.
  if (!result.completed || result.status > 1) {
    throw new Error("could not search indexed content");
  }
  return new Set(result.stdout.split("\0").filter(Boolean));
}

// Whether a directory could sit on a route a pattern matches, i.e. whether
// `<directory>/…` can still satisfy the pattern. Used to spot a submodule
// mounted above a protected root. `**` consumes any number of segments, so this
// walks the pattern rather than slicing it to a fixed depth.
function couldContain(pattern: string, directory: string): boolean {
  const segments = pattern.split("/");
  const parts = directory.split("/");
  const walk = (index: number, part: number): boolean => {
    if (part === parts.length) return index < segments.length;
    if (index === segments.length) return false;
    if (segments[index] === "**") {
      // A globstar can absorb any remaining directory segments, and a trailing
      // one keeps matching content deeper than the directory itself.
      for (let skip = part; skip <= parts.length; skip += 1) {
        if (walk(index + 1, skip)) return true;
      }
      return true;
    }
    if (!globToRegExp(segments[index]!).test(parts[part]!)) return false;
    return walk(index + 1, part + 1);
  };
  return walk(0, 0);
}

function report(config: ConfidentialConfig, repoRoot: string): ConfidentialReport {
  const repo = repository(repoRoot);
  const entries = indexEntries(repo);
  const errors: string[] = [];

  // Case- and Unicode-folded matching deliberately over-selects: a path that
  // differs from a declared pattern only by spelling is treated as protected,
  // so a case-insensitive author and a case-sensitive collaborator cannot
  // disagree about what is covered.
  const patterns = config.paths.map((path) => ({
    path,
    identity: portablePathIdentity(path),
    regex: globToRegExp(portablePathIdentity(path)),
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
  if (localAttributeOverride(repo)) {
    errors.push("attribute policy comes from an untracked source: info/attributes");
  }
  for (const alias of stagedConfigAliases(tracked)) {
    errors.push(`${CONFIG_FILE} has a tracked case alias: ${alias}`);
  }
  const stagedConfig = stagedConfigEntry(tracked);
  if (!stagedConfig) {
    errors.push(`${CONFIG_FILE} is not tracked: the confidential policy is not committed`);
  } else {
    const staged = stagedPolicy(repo, stagedConfig.oid);
    if (staged === undefined || !samePolicy(staged, config)) {
      errors.push(`${CONFIG_FILE} declares a different confidential policy than the one checked`);
    }
  }

  // A pattern that covers nothing is the failure mode that makes a green run
  // meaningless, so it fails rather than passing quietly.
  for (const pattern of patterns) {
    const covered = [...protectedPaths, ...unmerged].some((path) =>
      pattern.regex.test(portablePathIdentity(path)),
    );
    if (!covered) errors.push(`no tracked content matches protected path: ${pattern.path}`);
  }

  // A gitlink above a protected route keeps the content in another repository's
  // history, where this contract does not reach.
  for (const entry of tracked) {
    if (entry.mode !== "160000") continue;
    const identity = portablePathIdentity(entry.path);
    if (patterns.some((pattern) => couldContain(pattern.identity, identity))) {
      errors.push(`protected content is inside a tracked submodule: ${entry.path}`);
    }
  }

  const attributes = filterAttributes(
    repo,
    tracked.map((entry) => entry.path),
  );
  const covered = (path: string): boolean => PROVIDER_FILTER.test(attributes.get(path) ?? "");
  const candidates = keyMaterialCandidates(repo);
  const inspected = [
    ...protectedEntries,
    ...tracked.filter((entry) => candidates.has(entry.path) && !protectedPaths.has(entry.path)),
  ].filter((entry) => entry.mode.startsWith("100"));
  const headers = objectHeaders(
    repo,
    inspected.map((entry) => entry.oid),
  );
  const isKeyMaterial = (entry: IndexEntry): boolean => {
    const header = headers.get(entry.oid);
    return header !== undefined && header.subarray(0, KEY_MAGIC.length).equals(KEY_MAGIC);
  };

  // One finding per protected path, most specific first: an unverifiable entry
  // must not also be reported as plaintext.
  for (const entry of protectedEntries) {
    if (unmerged.includes(entry.path)) continue; // Reported with the unmerged paths.
    const header = headers.get(entry.oid);
    if (
      POLICY_BASENAMES.has(portablePathIdentity(basename(entry.path))) ||
      POLICY_PATHS.has(portablePathIdentity(entry.path))
    ) {
      errors.push(`protected path must not cover Git or workspace policy: ${entry.path}`);
    } else if (!entry.mode.startsWith("100")) {
      errors.push(`protected path is not a regular file: ${entry.path}`);
    } else if (isKeyMaterial(entry)) {
      errors.push(`git-crypt key material is tracked: ${entry.path}`);
    } else if (!covered(entry.path)) {
      errors.push(`protected path is not covered by git-crypt policy: ${entry.path}`);
    } else if (header === undefined) {
      errors.push(`protected path could not be verified: ${entry.path}`);
    } else if (
      header.length < FRAMING_BYTES ||
      !header.subarray(0, FILE_MAGIC.length).equals(FILE_MAGIC)
    ) {
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
    if (covered(entry.path) && !protectedPaths.has(entry.path)) {
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
