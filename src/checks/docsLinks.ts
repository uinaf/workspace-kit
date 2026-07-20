// Bounded Markdown destination checking for git-tracked *.md files. This is
// intentionally not a complete CommonMark parser: it covers inline links and
// images plus one-line reference definitions, while ignoring code spans and
// backtick/tilde fenced blocks.
import { spawnSync } from "node:child_process";
import { posix } from "node:path";
import type { DocsLinksConfig } from "../config.ts";
import { readWorkspaceText, workspaceLstat } from "../lib/workspaceFs.ts";

type Destination = { offset: number; raw: string };
type DestinationToken = { end: number; raw: string };
type Fence = { marker: "`" | "~"; length: number; rest: string };

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isEscaped(text: string, index: number): boolean {
  let slashes = 0;
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === "\\"; cursor -= 1) {
    slashes += 1;
  }
  return slashes % 2 === 1;
}

function fenceAt(line: string): Fence | undefined {
  let cursor = 0;
  while (cursor < 3 && line[cursor] === " ") cursor += 1;
  const marker = line[cursor];
  if (marker !== "`" && marker !== "~") return undefined;
  let end = cursor;
  while (line[end] === marker) end += 1;
  if (end - cursor < 3) return undefined;
  const rest = line.slice(end);
  if (marker === "`" && rest.includes("`")) return undefined;
  return { marker, length: end - cursor, rest };
}

function blank(chars: string[], start: number, end: number): void {
  for (let index = start; index < end; index += 1) {
    if (chars[index] !== "\n" && chars[index] !== "\r") chars[index] = " ";
  }
}

function maskFencedBlocks(text: string): string {
  const chars = text.split("");
  let open: Omit<Fence, "rest"> | undefined;
  let offset = 0;

  for (const match of text.matchAll(/[^\n]*(?:\n|$)/g)) {
    const rawLine = match[0];
    if (!rawLine) continue;
    const withoutLf = rawLine.endsWith("\n") ? rawLine.slice(0, -1) : rawLine;
    const line = withoutLf.endsWith("\r") ? withoutLf.slice(0, -1) : withoutLf;
    const fence = fenceAt(line);

    if (open) {
      blank(chars, offset, offset + rawLine.length);
      if (
        fence?.marker === open.marker &&
        fence.length >= open.length &&
        fence.rest.trim().length === 0
      ) {
        open = undefined;
      }
    } else if (fence) {
      blank(chars, offset, offset + rawLine.length);
      open = { marker: fence.marker, length: fence.length };
    }
    offset += rawLine.length;
  }

  return chars.join("");
}

function maskCode(text: string): string {
  const fenced = maskFencedBlocks(text);
  const chars = fenced.split("");
  let cursor = 0;

  while (cursor < fenced.length) {
    if (fenced[cursor] !== "`" || isEscaped(fenced, cursor)) {
      cursor += 1;
      continue;
    }
    let openingEnd = cursor;
    while (fenced[openingEnd] === "`") openingEnd += 1;
    const width = openingEnd - cursor;
    let search = openingEnd;
    let closingEnd: number | undefined;
    while (search < fenced.length) {
      if (fenced[search] !== "`") {
        search += 1;
        continue;
      }
      let runEnd = search;
      while (fenced[runEnd] === "`") runEnd += 1;
      if (runEnd - search === width) {
        closingEnd = runEnd;
        break;
      }
      search = runEnd;
    }
    if (closingEnd === undefined) {
      cursor = openingEnd;
      continue;
    }
    blank(chars, cursor, closingEnd);
    cursor = closingEnd;
  }

  return chars.join("");
}

function skipWhitespace(text: string, start: number, end = text.length): number {
  let cursor = start;
  while (cursor < end && /\s/.test(text[cursor]!)) cursor += 1;
  return cursor;
}

function skipHorizontalWhitespace(text: string, start: number, end: number): number {
  let cursor = start;
  while (cursor < end && (text[cursor] === " " || text[cursor] === "\t")) cursor += 1;
  return cursor;
}

function closingBracket(text: string, open: number, end = text.length): number | undefined {
  let depth = 0;
  for (let cursor = open; cursor < end; cursor += 1) {
    if (text[cursor] === "\\") {
      cursor += 1;
    } else if (text[cursor] === "[") {
      depth += 1;
    } else if (text[cursor] === "]") {
      depth -= 1;
      if (depth === 0) return cursor;
    }
  }
  return undefined;
}

function destinationToken(
  text: string,
  start: number,
  end = text.length,
): DestinationToken | undefined {
  if (start >= end) return undefined;
  if (text[start] === "<") {
    for (let cursor = start + 1; cursor < end; cursor += 1) {
      const char = text[cursor];
      if (char === "\n" || char === "\r" || (char === "<" && !isEscaped(text, cursor))) {
        return undefined;
      }
      if (char === ">" && !isEscaped(text, cursor)) {
        return { raw: text.slice(start + 1, cursor), end: cursor + 1 };
      }
    }
    return undefined;
  }

  let depth = 0;
  let cursor = start;
  while (cursor < end) {
    const char = text[cursor]!;
    if (char === "\\" && cursor + 1 < end) {
      cursor += 2;
      continue;
    }
    if (/\s/.test(char)) break;
    if (char === "(") {
      depth += 1;
    } else if (char === ")") {
      if (depth === 0) break;
      depth -= 1;
    } else if (char === "<" || char === ">") {
      return undefined;
    }
    cursor += 1;
  }
  if (depth !== 0) return undefined;
  return { raw: text.slice(start, cursor), end: cursor };
}

function titleEnd(text: string, start: number, end = text.length): number | undefined {
  const opener = text[start];
  const closer = opener === "(" ? ")" : opener;
  if (opener !== '"' && opener !== "'" && opener !== "(") return undefined;
  let depth = opener === "(" ? 1 : 0;
  for (let cursor = start + 1; cursor < end; cursor += 1) {
    const char = text[cursor];
    if (char === "\n" || char === "\r") return undefined;
    if (char === "\\") {
      cursor += 1;
    } else if (opener === "(" && char === "(") {
      depth += 1;
    } else if (char === closer) {
      if (opener !== "(" || --depth === 0) return cursor + 1;
    }
  }
  return undefined;
}

function inlineDestinations(text: string): Destination[] {
  const out: Destination[] = [];
  for (let cursor = 0; cursor < text.length; cursor += 1) {
    if (text[cursor] !== "[" || isEscaped(text, cursor)) continue;
    const labelEnd = closingBracket(text, cursor);
    if (labelEnd === undefined || text[labelEnd + 1] !== "(") continue;
    const bodyStart = skipWhitespace(text, labelEnd + 2);
    const token = destinationToken(text, bodyStart);
    if (!token) continue;
    let tail = skipWhitespace(text, token.end);
    if (text[tail] !== ")") {
      if (tail === token.end) continue;
      const end = titleEnd(text, tail);
      if (end === undefined) continue;
      tail = skipWhitespace(text, end);
      if (text[tail] !== ")") continue;
    }
    out.push({ offset: bodyStart, raw: token.raw });
    cursor = tail;
  }
  return out;
}

function referenceDestinations(text: string): Destination[] {
  const out: Destination[] = [];
  let lineStart = 0;
  while (lineStart < text.length) {
    const newline = text.indexOf("\n", lineStart);
    const rawEnd = newline === -1 ? text.length : newline;
    const lineEnd = rawEnd > lineStart && text[rawEnd - 1] === "\r" ? rawEnd - 1 : rawEnd;
    let cursor = lineStart;
    let indent = 0;
    while (indent < 3 && text[cursor] === " ") {
      cursor += 1;
      indent += 1;
    }
    if (text[cursor] === "[" && text[cursor + 1] !== "^") {
      const labelEnd = closingBracket(text, cursor, lineEnd);
      if (labelEnd !== undefined && text[labelEnd + 1] === ":") {
        const bodyStart = skipHorizontalWhitespace(text, labelEnd + 2, lineEnd);
        const token = destinationToken(text, bodyStart, lineEnd);
        if (token && token.raw.length > 0) {
          let tail = skipHorizontalWhitespace(text, token.end, lineEnd);
          let valid = tail === lineEnd;
          if (!valid && tail > token.end) {
            const end = titleEnd(text, tail, lineEnd);
            if (end !== undefined) {
              tail = skipHorizontalWhitespace(text, end, lineEnd);
              valid = tail === lineEnd;
            }
          }
          if (valid) out.push({ offset: bodyStart, raw: token.raw });
        }
      }
    }
    if (newline === -1) break;
    lineStart = newline + 1;
  }
  return out;
}

function destinations(text: string): Destination[] {
  const visible = maskCode(text);
  return [...inlineDestinations(visible), ...referenceDestinations(visible)].sort(
    (left, right) => left.offset - right.offset,
  );
}

function unescapeMarkdown(text: string): string {
  return text.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g, "$1");
}

function pathPart(href: string): string {
  for (let cursor = 0; cursor < href.length; cursor += 1) {
    if (href[cursor] === "\\") {
      cursor += 1;
    } else if (href[cursor] === "#" || href[cursor] === "?") {
      return href.slice(0, cursor);
    }
  }
  return href;
}

export function docsLinkErrors(config: DocsLinksConfig): string[] {
  const bad: string[] = [];
  const result = spawnSync("git", ["ls-files", "-z"], { encoding: "utf8" });
  if (result.status !== 0) return ["could not list tracked files"];
  const tracked = new Set(result.stdout.split("\0").filter(Boolean));
  const isTracked = (target: string): boolean => {
    if (target === ".") return tracked.size > 0;
    if (tracked.has(target)) return true;
    const prefix = `${target}/`;
    for (const file of tracked) {
      if (file.startsWith(prefix)) return true;
    }
    return false;
  };

  const files = [...tracked]
    .filter((file) => file.endsWith(".md"))
    .filter(
      (file) => !config.exclude.some((prefix) => file === prefix || file.startsWith(`${prefix}/`)),
    )
    .sort();

  for (const file of files) {
    let text: string;
    try {
      const stat = workspaceLstat(".", file, "tracked Markdown file");
      if (!stat) {
        bad.push(`${file}: tracked Markdown file is missing`);
        continue;
      }
      if (stat.isSymbolicLink()) continue;
      text = readWorkspaceText(".", file, "tracked Markdown file");
    } catch (error) {
      bad.push(`${file}: could not read tracked Markdown (${message(error)})`);
      continue;
    }

    for (const { raw } of destinations(text)) {
      const unescaped = unescapeMarkdown(raw);
      if (/^[a-z][a-z0-9+.-]*:/i.test(unescaped) || unescaped.startsWith("//")) continue;
      const encodedPath = pathPart(raw);
      if (!encodedPath) continue;
      let href: string;
      try {
        href = decodeURIComponent(unescapeMarkdown(encodedPath));
      } catch {
        bad.push(`${file}: broken link (${raw})`);
        continue;
      }
      if (href.startsWith("/")) continue;
      const target = posix.normalize(posix.join(posix.dirname(file), href)).replace(/\/+$/, "");
      if (target === ".." || target.startsWith("../") || !isTracked(target)) {
        bad.push(`${file}: broken link (${raw})`);
      }
    }
  }
  return bad;
}
