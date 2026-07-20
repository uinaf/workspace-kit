import {
  closeSync,
  constants,
  fchmodSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
  type Dirent,
  type Stats,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { join, posix, resolve } from "node:path";

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

function portablePath(raw: string): string {
  return raw.replaceAll("\\", "/");
}

function isPortableAbsolute(path: string): boolean {
  return path.startsWith("/") || /^[A-Za-z]:/.test(path);
}

export function normalizeWorkspacePath(raw: string, label = "path"): string {
  if (!raw || raw.includes("\0")) {
    throw new Error(`${label} must be a non-empty repository-relative path`);
  }
  const portable = portablePath(raw);
  if (isPortableAbsolute(portable)) {
    throw new Error(`${label} must stay inside the workspace`);
  }
  const normalized = posix.normalize(portable);
  if (normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`${label} must stay inside the workspace`);
  }
  return normalized.replace(/\/$/, "");
}

export function normalizeLinkTarget(linkPath: string, raw: string, label = "target"): string {
  if (!raw || raw.includes("\0")) {
    throw new Error(`${label} must be a non-empty workspace-contained target`);
  }
  const link = normalizeWorkspacePath(linkPath, "link path");
  const portable = portablePath(raw);
  if (isPortableAbsolute(portable)) {
    throw new Error(`${label} must stay inside the workspace`);
  }
  const normalized = posix.normalize(portable);
  const resolvedTarget = posix.normalize(posix.join(posix.dirname(link), normalized));
  if (resolvedTarget === "." || resolvedTarget === ".." || resolvedTarget.startsWith("../")) {
    throw new Error(`${label} must stay inside the workspace`);
  }
  return normalized;
}

export function assertWorkspaceLinkTarget(root: string, linkPath: string, target: string): string {
  const link = normalizeWorkspacePath(linkPath, "link path");
  const normalizedTarget = normalizeLinkTarget(link, target, "link target");
  const targetPath = normalizeWorkspacePath(
    posix.join(posix.dirname(link), normalizedTarget),
    "link target",
  );
  if (
    targetPath === link ||
    targetPath.startsWith(`${link}/`) ||
    link.startsWith(`${targetPath}/`)
  ) {
    throw new Error(`${targetPath}: link target would create a cycle`);
  }
  const stat = workspaceLstat(root, targetPath, "link target");
  if (!stat) throw new Error(`${targetPath}: link target is missing`);
  if (stat.isSymbolicLink()) {
    throw new Error(`${targetPath}: symbolic-link target is not allowed`);
  }
  return normalizedTarget;
}

function lstatOrUndefined(absolute: string): Stats | undefined {
  try {
    return lstatSync(absolute);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  }
}

function assertSafeParents(root: string, relative: string): void {
  const rootAbsolute = resolve(root);
  const segments = relative.split("/");
  let current = rootAbsolute;
  let currentRelative = "";
  for (const segment of segments.slice(0, -1)) {
    current = join(current, segment);
    currentRelative = currentRelative ? `${currentRelative}/${segment}` : segment;
    let stat: Stats | undefined;
    try {
      stat = lstatOrUndefined(current);
    } catch (error) {
      throw new Error(
        `${currentRelative}: could not inspect workspace path (${errorCode(error) ?? "error"})`,
      );
    }
    if (!stat) return;
    if (stat.isSymbolicLink()) {
      throw new Error(`${currentRelative}: symbolic-link parent is not allowed`);
    }
    if (!stat.isDirectory()) {
      throw new Error(`${currentRelative}: parent is not a directory`);
    }
  }
}

export function workspaceLstat(root: string, path: string, label = "path"): Stats | undefined {
  const relative = normalizeWorkspacePath(path, label);
  assertSafeParents(root, relative);
  try {
    return lstatOrUndefined(resolve(root, relative));
  } catch (error) {
    throw new Error(
      `${relative}: could not inspect workspace path (${errorCode(error) ?? "error"})`,
    );
  }
}

export function readWorkspaceText(root: string, path: string, label = "path"): string {
  const relative = normalizeWorkspacePath(path, label);
  const stat = workspaceLstat(root, relative, label);
  if (!stat) throw new Error(`${relative}: file is missing`);
  if (stat.isSymbolicLink()) throw new Error(`${relative}: symbolic-link file is not allowed`);
  if (!stat.isFile()) throw new Error(`${relative}: expected a regular file`);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(resolve(root, relative), constants.O_RDONLY | constants.O_NOFOLLOW);
    return readFileSync(descriptor, "utf8");
  } catch (error) {
    throw new Error(`${relative}: could not read file (${errorCode(error) ?? "error"})`);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export function readWorkspaceDirectory(
  root: string,
  path: string,
  missing: "empty" | "error" = "error",
): Dirent[] {
  const relative = normalizeWorkspacePath(path);
  const stat = workspaceLstat(root, relative);
  if (!stat) {
    if (missing === "empty") return [];
    throw new Error(`missing ${relative}`);
  }
  if (stat.isSymbolicLink()) throw new Error(`${relative}: symbolic-link directory is not allowed`);
  if (!stat.isDirectory()) throw new Error(`${relative}: expected a directory`);
  try {
    return readdirSync(resolve(root, relative), { withFileTypes: true });
  } catch (error) {
    throw new Error(`${relative}: could not read directory (${errorCode(error) ?? "error"})`);
  }
}

export function walkWorkspaceMarkdown(
  root: string,
  path: string,
  missing: "empty" | "error" = "error",
): string[] {
  const relativeRoot = normalizeWorkspacePath(path);
  const out: string[] = [];

  const walk = (relative: string, optional: "empty" | "error"): void => {
    const entries = readWorkspaceDirectory(root, relative, optional).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const entry of entries) {
      const child = posix.join(relative, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`${child}: symbolic links are not allowed in scanned directories`);
      }
      if (entry.isDirectory()) {
        walk(child, "error");
      } else if (entry.isFile() && child.endsWith(".md")) {
        out.push(child);
      }
    }
  };

  walk(relativeRoot, missing);
  return out.sort();
}

export function ensureWorkspaceDirectory(root: string, path: string): void {
  if (!path || path === ".") return;
  const relative = normalizeWorkspacePath(path);
  const rootAbsolute = resolve(root);
  let current = rootAbsolute;
  let currentRelative = "";
  for (const segment of relative.split("/")) {
    current = join(current, segment);
    currentRelative = currentRelative ? `${currentRelative}/${segment}` : segment;
    let stat: Stats | undefined;
    try {
      stat = lstatOrUndefined(current);
    } catch (error) {
      throw new Error(
        `${currentRelative}: could not inspect workspace path (${errorCode(error) ?? "error"})`,
      );
    }
    if (!stat) {
      try {
        mkdirSync(current);
      } catch (error) {
        throw new Error(
          `${currentRelative}: could not create directory (${errorCode(error) ?? "error"})`,
        );
      }
      continue;
    }
    if (stat.isSymbolicLink()) {
      throw new Error(`${currentRelative}: symbolic-link parent is not allowed`);
    }
    if (!stat.isDirectory()) throw new Error(`${currentRelative}: parent is not a directory`);
  }
}

export function writeWorkspaceText(
  root: string,
  path: string,
  content: string,
  options: { exclusive?: boolean; mode?: number } = {},
): void {
  const relative = normalizeWorkspacePath(path);
  ensureWorkspaceDirectory(root, posix.dirname(relative));
  const stat = workspaceLstat(root, relative);
  if (stat?.isSymbolicLink()) throw new Error(`${relative}: refusing to write through a symlink`);
  if (stat && !stat.isFile()) throw new Error(`${relative}: expected a regular file`);
  const absolute = resolve(root, relative);
  const mode = options.mode ?? (stat ? stat.mode & 0o777 : 0o666);

  if (options.exclusive) {
    let descriptor: number | undefined;
    try {
      descriptor = openSync(
        absolute,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        mode,
      );
      writeFileSync(descriptor, content);
      if (options.mode !== undefined) fchmodSync(descriptor, mode);
    } catch (error) {
      throw new Error(`${relative}: could not write file (${errorCode(error) ?? "error"})`);
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
    return;
  }

  if (stat) {
    try {
      const permissionProbe = openSync(absolute, constants.O_WRONLY | constants.O_NOFOLLOW);
      closeSync(permissionProbe);
    } catch (error) {
      throw new Error(`${relative}: could not replace file (${errorCode(error) ?? "error"})`);
    }
  }

  const temporaryRelative = posix.join(
    posix.dirname(relative),
    `.workspace-kit-${randomBytes(8).toString("hex")}.tmp`,
  );
  const temporaryAbsolute = resolve(root, temporaryRelative);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      temporaryAbsolute,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      mode,
    );
    writeFileSync(descriptor, content);
    if (stat || options.mode !== undefined) fchmodSync(descriptor, mode);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporaryAbsolute, absolute);
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // The primary write error is more useful than a second close error.
      }
    }
    let cleanup = "";
    try {
      unlinkSync(temporaryAbsolute);
    } catch (cleanupError) {
      const code = errorCode(cleanupError);
      if (code !== "ENOENT") cleanup = `; temporary cleanup failed (${code ?? "error"})`;
    }
    throw new Error(
      `${relative}: could not replace file (${errorCode(error) ?? "error"})${cleanup}`,
    );
  }
}

export function unlinkWorkspaceFile(root: string, path: string): void {
  const relative = normalizeWorkspacePath(path);
  const stat = workspaceLstat(root, relative);
  if (!stat) throw new Error(`${relative}: file is missing`);
  if (stat.isSymbolicLink()) throw new Error(`${relative}: refusing to delete a symlink`);
  if (!stat.isFile()) throw new Error(`${relative}: expected a regular file`);
  try {
    unlinkSync(resolve(root, relative));
  } catch (error) {
    throw new Error(`${relative}: could not delete file (${errorCode(error) ?? "error"})`);
  }
}

export function readWorkspaceLink(root: string, path: string): string {
  const relative = normalizeWorkspacePath(path);
  const stat = workspaceLstat(root, relative);
  if (!stat) throw new Error(`missing ${relative}`);
  if (!stat.isSymbolicLink()) throw new Error(`${relative}: expected a symbolic link`);
  try {
    return readlinkSync(resolve(root, relative));
  } catch (error) {
    throw new Error(`${relative}: could not read symbolic link (${errorCode(error) ?? "error"})`);
  }
}

export function createWorkspaceLink(root: string, path: string, target: string): void {
  const relative = normalizeWorkspacePath(path, "link path");
  const normalizedTarget = assertWorkspaceLinkTarget(root, relative, target);
  ensureWorkspaceDirectory(root, posix.dirname(relative));
  if (workspaceLstat(root, relative)) throw new Error(`${relative}: path already exists`);
  try {
    symlinkSync(normalizedTarget, resolve(root, relative));
  } catch (error) {
    throw new Error(`${relative}: could not create symbolic link (${errorCode(error) ?? "error"})`);
  }
}

export function unlinkWorkspaceLink(root: string, path: string): void {
  const relative = normalizeWorkspacePath(path, "link path");
  const stat = workspaceLstat(root, relative);
  if (!stat?.isSymbolicLink()) throw new Error(`${relative}: expected a symbolic link`);
  try {
    unlinkSync(resolve(root, relative));
  } catch (error) {
    throw new Error(`${relative}: could not remove symbolic link (${errorCode(error) ?? "error"})`);
  }
}
