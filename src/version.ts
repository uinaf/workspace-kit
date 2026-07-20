import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export function kitVersion(): string {
  // Works from src/ (repo checkout) and dist/ (published package) alike:
  // package.json sits one directory up from this module in both layouts.
  const here = dirname(fileURLToPath(import.meta.url));
  const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8"));
  return typeof pkg.version === "string" ? pkg.version : "0.0.0";
}
