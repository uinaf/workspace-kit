import { posix } from "node:path";
import type { WikiConfig } from "../config.ts";
import { maskCode, relativeLinks, type RelativeLink } from "./docsLinks.ts";
import { readWorkspaceText, walkWorkspaceMarkdown, workspaceLstat } from "../lib/workspaceFs.ts";

const WIKILINK = /\[\[([^\]|#\n]+)(?:#[^\]|\n]*)?(?:\|[^\]\n]*)?\]\]/g;
const LOG_HEADING = /^## \[(\d{4}-\d{2}-\d{2})\] \S/;

function exists(path: string): boolean {
  try {
    return workspaceLstat(".", path) !== undefined;
  } catch {
    return false;
  }
}

function inside(path: string): boolean {
  return path !== ".." && !path.startsWith("../") && !path.startsWith("/");
}

function wikilinks(page: string, text: string, root: string): RelativeLink[] {
  const out: RelativeLink[] = [];
  for (const match of maskCode(text).matchAll(WIKILINK)) {
    const raw = match[0];
    const name = match[1]!.trim();
    const spellings = posix.extname(name) ? [name] : [`${name}.md`, name];
    const candidates = [posix.dirname(page), root]
      .flatMap((base) => spellings.map((spelling) => posix.normalize(posix.join(base, spelling))))
      .filter(inside);
    const target = candidates.find(exists);
    out.push(target ? { raw, target } : { raw, broken: true });
  }
  return out;
}

function validDate(date: string): boolean {
  const parsed = new Date(`${date}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(date);
}

function logErrors(log: string): string[] {
  const errors: string[] = [];
  let previous: string | undefined;
  maskCode(readWorkspaceText(".", log))
    .split(/\r?\n/)
    .forEach((line, index) => {
      if (!line.startsWith("## ")) return;
      const date = line.match(LOG_HEADING)?.[1];
      if (!date || !validDate(date)) {
        errors.push(`${log}:${index + 1}: heading must be "## [YYYY-MM-DD] summary"`);
        return;
      }
      if (previous !== undefined && date < previous) {
        errors.push(`${log}:${index + 1}: ${date} is earlier than ${previous}`);
      }
      previous = date;
    });
  return errors;
}

export function wikiErrors(wiki: WikiConfig, exclude: string[] = []): string[] {
  const index = posix.join(wiki.root, "index.md");
  const log = posix.join(wiki.root, "log.md");
  if (!exists(index)) return [`missing ${index}`];
  const pages = walkWorkspaceMarkdown(".", wiki.root).filter(
    (page) => !exclude.some((dir) => page.startsWith(`${dir}/`)),
  );

  const errors: string[] = [];
  const indexed = new Set<string>();
  for (const page of pages) {
    const text = readWorkspaceText(".", page);
    for (const link of [...relativeLinks(page, text), ...wikilinks(page, text, wiki.root)]) {
      if ("broken" in link || !exists(link.target)) {
        errors.push(`${page}: broken link (${link.raw})`);
      } else if (page === index) {
        indexed.add(link.target);
      }
    }
  }
  for (const page of pages) {
    if (page !== index && page !== log && !indexed.has(page)) {
      errors.push(`${index}: missing entry for ${page}`);
    }
  }
  if (pages.includes(log)) errors.push(...logErrors(log));
  return errors;
}
