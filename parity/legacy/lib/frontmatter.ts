export function clean(value: string): string {
  return value.trim().replace(/^['"]|['"]$/g, "");
}

export function parseFrontmatter(text: string): Record<string, unknown> {
  if (!text.startsWith("---\n")) return {};
  const end = text.indexOf("\n---\n", 4);
  if (end < 0) return {};
  const raw = text.slice(4, end);
  const out: Record<string, unknown> = {};
  let current: string | null = null;
  for (const line of raw.split("\n")) {
    const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (m) {
      current = m[1];
      const value = m[2].trim();
      if (value.startsWith("[") && value.endsWith("]")) {
        out[current] = value.slice(1, -1).split(",").map((x) => clean(x)).filter(Boolean);
      } else {
        out[current] = clean(value);
      }
      continue;
    }
    if (current && line.trim().startsWith("- ")) {
      const prev = out[current];
      const arr = Array.isArray(prev) ? prev : prev ? [String(prev)] : [];
      arr.push(clean(line.trim().slice(2)));
      out[current] = arr;
    }
  }
  return out;
}

export function asList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (typeof value === "string" && value.length > 0) return [value];
  return [];
}

export function isExternal(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(value);
}
