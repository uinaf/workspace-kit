// Opt-in encrypted-content contract (default-off). The check is marker-based:
// it proves that staged blobs under declared protected paths carry the
// configured provider's ciphertext envelope, that git-crypt paths are covered
// by a filter attribute, and that provider key material is not tracked. It
// never decrypts, never touches keys, and stays offline. Detection proves
// "not plaintext", never end-to-end confidentiality — recipients, identities,
// and recovery remain consumer-owned.
import { spawnSync } from "node:child_process";
import { closeSync, constants, fstatSync, openSync, readFileSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  CONFIG_FILE,
  parseWorkspaceConfig,
  portablePathIdentity,
  unknownConfigKeys,
  type ConfidentialConfig,
} from "../config.ts";
import { gitEnvironmentForRepository } from "../lib/gitProcess.ts";
import { globToRegExp } from "./limits.ts";

export type ConfidentialReport = {
  errors: string[];
  // Non-fatal signals, currently unrecognized keys in the staged config:
  // tolerated for additive schema evolution, but surfaced so a typoed
  // section name cannot quietly stand the gate down.
  warnings: string[];
  state: string;
  active: boolean;
  // True when the prospective commit's declaration differs from HEAD's — a
  // staged edit, removal, or deletion is in flight, so the worktree copy's
  // problems must not mask the staged state.
  staged: boolean;
};

type IndexEntry = { mode: string; sha: string; path: string };

const BLOB_PREFIX_BYTES = 256;
const FULL_ENVELOPE_MAX_BYTES = 4 * 1024 * 1024;
const GIT_CRYPT_MAGIC = "\0GITCRYPT\0";
const GIT_CRYPT_KEY_MAGIC = "\0GITCRYPTKEY";
// An age v1 envelope is only ciphertext when its full grammar parses: the
// version line, one or more recipient stanzas (a `->` line followed by a
// base64 body wrapped at 64 columns, ending in a sub-64-column line), the
// header-MAC terminator, and a payload — 16-byte nonce plus at least one
// 16-byte AEAD tag. A bare version line and stanza marker over readable
// text is a forgery, not an age file.
// The v1 spec requires canonical raw base64 (RFC 4648 §3.5): a string whose
// length is 1 mod 4 cannot exist, and the final quantum's unused bits are
// zero, which constrains the last character (2-char tail: 4 pad bits; 3-char
// tail: 2 pad bits). age decoders reject non-canonical input, so the gate
// does too.
const AGE_B64_43 = /^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]$/;
const AGE_PAYLOAD_MIN_BYTES = 32;
const AGE_ARMOR_HEADER = "-----BEGIN AGE ENCRYPTED FILE-----";
const AGE_ARMOR_GRAMMAR =
  /^-----BEGIN AGE ENCRYPTED FILE-----\r?\n((?:[A-Za-z0-9+/]{64}\r?\n)*(?:[A-Za-z0-9+/]{1,63}={0,2}\r?\n)?)-----END AGE ENCRYPTED FILE-----\r?\n?$/;

function isCanonicalBase64(text: string): boolean {
  if (!/^[A-Za-z0-9+/]*$/.test(text) || text.length % 4 === 1) return false;
  if (text.length % 4 === 2) return /[AQgw]$/.test(text);
  if (text.length % 4 === 3) return /[AEIMQUYcgkosw048]$/.test(text);
  return true;
}

// Parses the age v1 header grammar from a bounded prefix and returns the
// byte offset just past the header-MAC terminator, or undefined when the
// prefix is not a complete age header.
function ageHeaderEnd(text: string): number | undefined {
  const intro = "age-encryption.org/v1\n";
  if (!text.startsWith(intro)) return undefined;
  let offset = intro.length;
  let stanzas = 0;
  for (;;) {
    if (text.startsWith("--- ", offset)) {
      if (
        stanzas === 0 ||
        !AGE_B64_43.test(text.slice(offset + 4, offset + 47)) ||
        text[offset + 47] !== "\n"
      ) {
        return undefined;
      }
      return offset + 48;
    }
    if (!text.startsWith("-> ", offset)) return undefined;
    const stanzaHeaderEnd = text.indexOf("\n", offset);
    if (
      stanzaHeaderEnd === -1 ||
      !/^-> [\x21-\x7e]+(?: [\x21-\x7e]+)*$/.test(text.slice(offset, stanzaHeaderEnd))
    ) {
      return undefined;
    }
    offset = stanzaHeaderEnd + 1;
    // ABNF: stanza = arg-line *full-line final-line. The final sub-64-column
    // line is mandatory — empty when the body wraps exactly, and empty even
    // for a zero-length body — so a stanza never ends directly at the next
    // marker line. Full lines are whole base64 quanta; the body's
    // canonicality is decided by the final line.
    for (;;) {
      const lineEnd = text.indexOf("\n", offset);
      if (lineEnd === -1) return undefined;
      const line = text.slice(offset, lineEnd);
      if (/^[A-Za-z0-9+/]{64}$/.test(line)) {
        offset = lineEnd + 1;
        continue;
      }
      if (line.length > 63 || !isCanonicalBase64(line)) return undefined;
      offset = lineEnd + 1;
      stanzas += 1;
      break;
    }
  }
}

function isAgeArmorEnvelope(full: string): boolean {
  const body = AGE_ARMOR_GRAMMAR.exec(full)?.[1];
  if (body === undefined) return false;
  // Armor is strict PEM: canonical base64 with `=` padding, so the padding
  // count is determined by the data length — no more, no less.
  const chars = body.replace(/[\r\n]/g, "");
  const padding = chars.endsWith("==") ? 2 : chars.endsWith("=") ? 1 : 0;
  const dataChars = chars.length - padding;
  if (dataChars % 4 === 1 || padding !== (4 - (dataChars % 4)) % 4) return false;
  if (!isCanonicalBase64(chars.slice(0, dataChars))) return false;
  const totalBytes = Math.floor(dataChars / 4) * 3 + [0, 0, 1, 2][dataChars % 4]!;
  const decoded = Buffer.from(chars.slice(0, dataChars), "base64").toString("latin1");
  const headerEnd = ageHeaderEnd(decoded);
  return headerEnd !== undefined && totalBytes >= headerEnd + AGE_PAYLOAD_MIN_BYTES;
}
const SOPS_ENC_VALUE =
  /^ENC\[AES256_GCM,data:[A-Za-z0-9+/=]+,iv:[A-Za-z0-9+/=]+,tag:[A-Za-z0-9+/=]+,type:str\]$/;
// The whole bech32 HRP family: classical `AGE-SECRET-KEY-1` and post-quantum
// `AGE-SECRET-KEY-PQ-1` (age-keygen -pq, age v1.3+), plus future variants.
// Public recipients are `age1…`/`age1pq1…` and never carry this prefix.
const AGE_SECRET_MARKER = "AGE-SECRET-KEY-";
const PGP_SECRET_MARKER = "-----BEGIN PGP PRIVATE KEY BLOCK-----";
// PEM/DER-armored private keys: OpenSSH identities (usable as age
// identities), plus RSA/EC/PKCS#8 forms. Public-key armor never matches —
// the family requires the literal PRIVATE KEY suffix.
const PEM_PRIVATE_ARMOR = /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/;
// Walks an OpenPGP packet stream (RFC 4880 old- and new-format headers) and
// reports whether any packet carries secret key material: tag 5 (secret key)
// or tag 7 (secret subkey). A packet only qualifies once its length encoding
// and body are complete within the bounded content — a bare tag byte or a
// truncated packet is malformed, not key material. Leading Marker or other
// packets cannot hide a later secret packet. Bytes that do not parse as a
// packet stream are not usable OpenPGP material, so they pass; armored and
// raw-magic forms are covered by their own markers. git-crypt's committed
// recipient files open with session-key packets (tags 1 and 3) and parse
// cleanly.
function isOpenPgpSecretKey(text: string): boolean {
  const byte = (at: number): number => text.charCodeAt(at);
  let offset = 0;
  while (offset < text.length) {
    const header = byte(offset);
    if ((header & 0x80) === 0) return false;
    offset += 1;
    if ((header & 0x40) !== 0) {
      // New format: tag in the low 6 bits, then a length encoding that may
      // be a run of partial-body chunks followed by a final chunk.
      const tag = header & 0x3f;
      const secret = tag === 5 || tag === 7;
      let chunk: number;
      do {
        if (offset >= text.length) return false;
        chunk = byte(offset);
        offset += 1;
        let length: number;
        if (chunk < 192) {
          length = chunk;
        } else if (chunk < 224) {
          if (offset >= text.length) return false;
          length = ((chunk - 192) << 8) + byte(offset) + 192;
          offset += 1;
        } else if (chunk === 255) {
          if (offset + 4 > text.length) return false;
          length =
            byte(offset) * 0x1000000 +
            (byte(offset + 1) << 16) +
            (byte(offset + 2) << 8) +
            byte(offset + 3);
          offset += 4;
        } else {
          length = 1 << (chunk & 0x1f); // partial body chunk
        }
        offset += length;
        if (offset > text.length) return false;
      } while (chunk >= 224 && chunk !== 255);
      // A packet qualifies only once its body completes: a partial run must
      // terminate in a final definite chunk, not just survive one chunk.
      if (secret) return true;
      continue;
    }
    // Old format: tag in bits 5..2, length type in the low 2 bits.
    const tag = (header >> 2) & 0x0f;
    const secret = tag === 5 || tag === 7;
    const lengthType = header & 0x03;
    if (lengthType === 3) {
      // Indeterminate length: the body runs to the end of the stream, so
      // any remaining byte completes the packet; otherwise the stream ends.
      return secret && offset < text.length;
    }
    const lengthBytes = lengthType === 0 ? 1 : lengthType === 1 ? 2 : 4;
    if (offset + lengthBytes > text.length) return false;
    let length = 0;
    for (let i = 0; i < lengthBytes; i += 1) length = length * 256 + byte(offset + i);
    if (offset + lengthBytes + length > text.length) return false;
    if (secret) return true;
    offset += lengthBytes + length;
  }
  return false;
}
// Conventional identity locations: keys.txt and key.txt (the age-keygen
// default output name), SSH identity filenames (age accepts ssh-ed25519 and
// ssh-rsa private keys as decryption identities), plus common key-material
// extensions.
const KEY_MATERIAL_PATH =
  /(?:^|\/)(?:keys?\.txt|id_(?:rsa|dsa|ecdsa(?:_sk)?|ed25519(?:_sk)?)|[^/]*\.(?:key|keyfile|agekey|pem|asc|pgp|gpg))$/i;
// git-crypt supports named keys via filter=git-crypt-<name>; both spellings
// are provider policy and must be versioned, never local-only. An empty key
// name (`filter=git-crypt-`) is not a spelling git-crypt produces.
const GIT_CRYPT_FILTER_RULE = /(?:^|\s)filter=git-crypt(?:-\S+)?(?:\s|$)/;
const GIT_CRYPT_FILTER_VALUE = /^filter=git-crypt(?:-\S+)?$/;
const GIT_CRYPT_RESOLVED_FILTER = /^git-crypt(?:-\S+)?$/;

// Listings (ls-files, check-attr) scale with repository size, unlike the
// fixed-size config/attribute probes. 64 MiB covers on the order of a
// million tracked paths; beyond that the gate fails loudly instead of
// silently evaluating a truncated protected set.
const LISTING_MAX_BYTES = 64 * 1024 * 1024;

// Index paths are contributor-controlled and may carry newlines or terminal
// control bytes; JSON quoting keeps every diagnostic single-line and inert.
function displayPath(path: string): string {
  return JSON.stringify(path);
}

type GitResult = { status: number; stdout: string; stderr: string; truncated: boolean };

function git(
  repoRoot: string,
  args: string[],
  input?: string,
  maxBuffer?: number,
  env?: Record<string, string>,
): GitResult {
  const result = spawnSync("git", ["-C", repoRoot, ...args], {
    encoding: "utf8",
    input,
    maxBuffer,
    env: { ...gitEnvironmentForRepository(), ...env },
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    truncated: (result.error as { code?: string } | undefined)?.code === "ENOBUFS",
  };
}

function indexEntries(repoRoot: string): IndexEntry[] {
  const result = git(repoRoot, ["ls-files", "-s", "-z"], undefined, LISTING_MAX_BYTES);
  if (result.truncated) throw new Error("tracked-file listing exceeds 64 MiB");
  if (result.status !== 0) throw new Error("could not list tracked files");
  const entries: IndexEntry[] = [];
  for (const record of result.stdout.split("\0")) {
    if (!record) continue;
    const match = /^(\d+) ([0-9a-f]+) \d+\t([\s\S]*)$/.exec(record);
    if (match) entries.push({ mode: match[1]!, sha: match[2]!, path: match[3]! });
  }
  return entries;
}

// Bounded blob read: maxBuffer truncation kills cat-file after the first pipe
// chunk, so ENOBUFS with a non-empty stdout is a successful bounded read, not
// a failure. Detection reads stay latin1 (byte fidelity for magic markers);
// JSON config reads must be utf8 so non-ASCII declared paths survive decoding.
function blobText(
  repoRoot: string,
  sha: string,
  maxBytes: number,
  encoding: "latin1" | "utf8" = "latin1",
): string {
  const result = spawnSync("git", ["-C", repoRoot, "cat-file", "blob", sha], {
    encoding,
    maxBuffer: maxBytes,
    env: gitEnvironmentForRepository(),
  });
  if (result.error && (result.error as { code?: string }).code !== "ENOBUFS") {
    throw new Error(`could not inspect staged blob ${sha.slice(0, 12)}`);
  }
  if (result.error === undefined && result.status !== 0) {
    throw new Error(`could not inspect staged blob ${sha.slice(0, 12)}`);
  }
  return result.stdout ?? "";
}

// The binary age check proves payload presence from the blob size alone, so
// large encrypted files never require a full read.
function blobSize(repoRoot: string, sha: string): number {
  const result = git(repoRoot, ["cat-file", "-s", sha]);
  if (result.status !== 0) throw new Error(`could not inspect staged blob ${sha.slice(0, 12)}`);
  return Number.parseInt(result.stdout.trim(), 10);
}

// Callers that need the complete blob (envelopes, key-material scans, config,
// attribute definitions) must not silently evaluate a truncated one.
function fullBlobText(
  repoRoot: string,
  sha: string,
  maxBytes: number,
  encoding: "latin1" | "utf8" = "latin1",
): string {
  const result = spawnSync("git", ["-C", repoRoot, "cat-file", "blob", sha], {
    encoding,
    maxBuffer: maxBytes,
    env: gitEnvironmentForRepository(),
  });
  if (result.error || result.status !== 0) {
    throw new Error(`could not inspect staged blob ${sha.slice(0, 12)}`);
  }
  return result.stdout ?? "";
}

// Coverage must be provable from the commit alone. Local-only attribute
// sources take precedence over tracked .gitattributes when `git add` resolves
// filters, so a git-crypt rule there can make an unprotected commit look
// covered. The contract forbids git-crypt filter policy in every local-only
// source git consults per repository and per user: info/attributes plus either
// the configured core.attributesFile or its per-user default. The system-wide
// etc/gitattributes file needs no screening: coverage resolution disables it
// outright via GIT_ATTR_NOSYSTEM.
//
// Direct `filter=git-crypt` assignments, applications of attribute macros
// whose expansion carries one, and local-only macro definitions whose
// expansion reaches one are all screened: a definition can be versioned in
// the top-level .gitattributes while a local file applies it, or a versioned
// application can name a macro only a local file defines — both leave fresh
// clones without the policy.
const ATTRIBUTE_MACRO_DEF = /^\[attr\](\S+)\s+(.+)$/;
const ATTRIBUTE_RULE = /^\S+\s+(.+)$/;

function gitCryptMacroNames(definitions: Array<{ macro: string; tokens: string[] }>): Set<string> {
  const expansions = new Map<string, string[]>();
  for (const definition of definitions) {
    expansions.set(definition.macro, [
      ...(expansions.get(definition.macro) ?? []),
      ...definition.tokens,
    ]);
  }
  const names = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, tokens] of expansions) {
      if (names.has(name)) continue;
      if (tokens.some((token) => GIT_CRYPT_FILTER_VALUE.test(token) || names.has(token))) {
        names.add(name);
        changed = true;
      }
    }
  }
  return names;
}

// Local attribute sources are host-controlled and unbounded by git, so the
// gate applies its own full-content bound: an oversized source fails loudly
// instead of exhausting memory or being silently skimmed.
function readBoundedTextOrUndefined(absolute: string, label: string): string | undefined {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(absolute, constants.O_RDONLY);
  } catch {
    return undefined; // Missing or unreadable sources are skipped by git as well.
  }
  try {
    if (fstatSync(descriptor).size > FULL_ENVELOPE_MAX_BYTES) {
      throw new Error(`local git attribute source exceeds the 4 MiB bound: ${label}`);
    }
    return readFileSync(descriptor, "utf8");
  } finally {
    closeSync(descriptor);
  }
}

function localOnlyAttributeErrors(repoRoot: string, entries: IndexEntry[]): string[] {
  const sources: Array<{ label: string; absolute: string }> = [];
  const commonDir = git(repoRoot, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (commonDir.status !== 0) throw new Error("could not locate the git directory");
  sources.push({
    label: ".git/info/attributes",
    absolute: join(commonDir.stdout.replace(/\n$/, ""), "info", "attributes"),
  });
  // --type=path applies git's own ~user and %(prefix) expansion; -z keeps
  // the value byte-exact so quoted paths with meaningful whitespace resolve
  // to the same file git reads.
  const configured = git(repoRoot, ["config", "--type=path", "-z", "--get", "core.attributesFile"]);
  if (configured.status === 0) {
    // An explicitly empty value disables the per-user file: git keeps it and
    // does not fall back to the default location, so neither does the gate.
    const raw = configured.stdout.endsWith("\0")
      ? configured.stdout.slice(0, -1)
      : configured.stdout;
    if (raw !== "") {
      // The expanded value is an absolute local path: keep it for reading,
      // but emit a stable label so diagnostics never disclose local roots.
      sources.push({ label: "configured core.attributesFile", absolute: resolve(repoRoot, raw) });
    }
  } else {
    const xdg = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
    sources.push({
      label: "per-user global git attributes",
      absolute: join(xdg, "git", "attributes"),
    });
  }

  const contents = sources.map((source) => ({
    ...source,
    text: readBoundedTextOrUndefined(source.absolute, source.label),
  }));

  // Custom macros are only recognized in top-level attribute files: the
  // staged root .gitattributes and the local-only sources themselves.
  const definitions: Array<{ macro: string; tokens: string[] }> = [];
  const collectDefinitions = (text: string | undefined): void => {
    if (text === undefined) return;
    for (const raw of text.split("\n")) {
      const line = raw.trim();
      const macro = ATTRIBUTE_MACRO_DEF.exec(line);
      if (macro) definitions.push({ macro: macro[1]!, tokens: macro[2]!.split(/\s+/) });
    }
  };
  const rootAttributes = entries.find((entry) => entry.path === ".gitattributes");
  collectDefinitions(
    rootAttributes
      ? fullBlobText(repoRoot, rootAttributes.sha, FULL_ENVELOPE_MAX_BYTES)
      : undefined,
  );
  for (const source of contents) collectDefinitions(source.text);
  const macros = gitCryptMacroNames(definitions);

  const errors: string[] = [];
  for (const source of contents) {
    if (source.text === undefined) continue;
    const assignsGitCrypt = source.text.split("\n").some((raw) => {
      const line = raw.trim();
      if (line === "" || line.startsWith("#")) return false;
      if (GIT_CRYPT_FILTER_RULE.test(line)) return true;
      // A local-only macro definition whose expansion reaches git-crypt is
      // itself local-only policy: versioned .gitattributes can apply the name
      // and check-attr resolves the chain on this machine, while fresh clones
      // lack the definition. The closure deliberately unions definitions
      // across sources rather than emulating git's override precedence, so a
      // local shadow of a versioned git-crypt macro is rejected too — the
      // machine/clones divergence that creates is exactly what the contract
      // refuses.
      const macroDef = ATTRIBUTE_MACRO_DEF.exec(line);
      if (macroDef) return macros.has(macroDef[1]!);
      const attributes = ATTRIBUTE_RULE.exec(line)?.[1];
      if (!attributes) return false;
      return attributes
        .split(/\s+/)
        .some((token) => !token.startsWith("-") && !token.includes("=") && macros.has(token));
    });
    if (assignsGitCrypt) {
      errors.push(`local-only git attributes assign git-crypt filters: ${source.label}`);
    }
  }
  return errors;
}

function worktreePrefix(repoRoot: string, path: string, bytes: number): string | undefined {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(resolve(repoRoot, path), constants.O_RDONLY | constants.O_NOFOLLOW);
    const buffer = Buffer.alloc(bytes);
    const read = readSync(descriptor, buffer, 0, bytes, 0);
    return buffer.toString("latin1", 0, read);
  } catch {
    return undefined;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

// Walks a JSON document alongside JSON.parse and reports duplicate object
// members at any level: JSON.parse silently collapses them, so a second
// well-formed `data` key could shadow a plaintext first one. Keys compare
// after escape decoding, matching JSON.parse semantics. Syntax errors also
// report true — the caller rejects either way and JSON.parse arbitrates
// validity.
function jsonHasDuplicateKeys(text: string): boolean {
  let index = 0;
  const skipWhitespace = (): void => {
    while (index < text.length && " \t\n\r".includes(text[index]!)) index += 1;
  };
  const parseString = (): string | undefined => {
    if (text[index] !== '"') return undefined;
    index += 1;
    let out = "";
    while (index < text.length) {
      const char = text[index]!;
      if (char === '"') {
        index += 1;
        return out;
      }
      if (char === "\\") {
        index += 1;
        if (index >= text.length) return undefined;
        const escape = text[index]!;
        if (escape === "u") {
          const hex = text.slice(index + 1, index + 5);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) return undefined;
          out += String.fromCharCode(Number.parseInt(hex, 16));
          index += 5;
          continue;
        }
        const simple: Record<string, string> = {
          '"': '"',
          "\\": "\\",
          "/": "/",
          b: "\b",
          f: "\f",
          n: "\n",
          r: "\r",
          t: "\t",
        };
        if (!(escape in simple)) return undefined;
        out += simple[escape]!;
        index += 1;
        continue;
      }
      if (char < " ") return undefined;
      out += char;
      index += 1;
    }
    return undefined;
  };
  const walk = (depth: number): boolean => {
    if (depth > 512) return true;
    skipWhitespace();
    const char = text[index];
    if (char === '"') return parseString() === undefined;
    if (char === "{") {
      index += 1;
      const keys = new Set<string>();
      skipWhitespace();
      if (text[index] === "}") {
        index += 1;
        return false;
      }
      for (;;) {
        skipWhitespace();
        const key = parseString();
        if (key === undefined || keys.has(key)) return true;
        keys.add(key);
        skipWhitespace();
        if (text[index] !== ":") return true;
        index += 1;
        if (walk(depth + 1)) return true;
        skipWhitespace();
        if (text[index] === ",") {
          index += 1;
          continue;
        }
        if (text[index] === "}") {
          index += 1;
          return false;
        }
        return true;
      }
    }
    if (char === "[") {
      index += 1;
      skipWhitespace();
      if (text[index] === "]") {
        index += 1;
        return false;
      }
      for (;;) {
        if (walk(depth + 1)) return true;
        skipWhitespace();
        if (text[index] === ",") {
          index += 1;
          continue;
        }
        if (text[index] === "]") {
          index += 1;
          return false;
        }
        return true;
      }
    }
    while (index < text.length && !",}] \t\n\r".includes(text[index]!)) index += 1;
    return false;
  };
  return walk(0);
}

// The sops contract accepts only whole-file binary envelopes: the blob parses
// as JSON whose top level is exactly `data` plus `sops` metadata carrying a
// `mac`, both well-formed `ENC[AES256_GCM,…]` values. Structured sops
// documents expose keys and document shape, so they fail like plaintext.
function isSopsEnvelope(text: string): boolean {
  if (jsonHasDuplicateKeys(text)) return false;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return false;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 2 || !keys.includes("data") || !keys.includes("sops")) return false;
  const sops = record.sops;
  return (
    typeof record.data === "string" &&
    SOPS_ENC_VALUE.test(record.data) &&
    !!sops &&
    typeof sops === "object" &&
    !Array.isArray(sops) &&
    typeof (sops as Record<string, unknown>).mac === "string" &&
    SOPS_ENC_VALUE.test((sops as Record<string, unknown>).mac as string)
  );
}

// Structural envelope validation: what each provider can prove offline without
// key material. sops envelopes are shape-checked end to end; age binary and
// armored envelopes are parsed against the v1 grammar (recipient stanzas,
// MACs, payload presence) — a bare version line over readable text is a
// forgery, not ciphertext. git-crypt is detectable only by its magic — nonce
// and ciphertext are indistinguishable from random without the key, so a
// forged magic prefix around readable content is undetectable offline and
// stays outside the threat model (see docs).
function isProviderCiphertext(
  provider: ConfidentialConfig["provider"],
  prefix: string,
  fullText: () => string,
  ageBinary: () => { header: string; size: number },
): boolean {
  if (provider === "git-crypt") return prefix.startsWith(GIT_CRYPT_MAGIC);
  if (provider === "age") {
    // The v1 spec exempts whitespace around the PEM block from non-canonical
    // armor rejection, so armor detection scans the same bounded window the
    // header parses from — not just the short detection prefix. Binary
    // payloads are proven from the blob size, so large encrypted files
    // still never require a complete read.
    const { header, size } = ageBinary();
    if (header.trimStart().startsWith(AGE_ARMOR_HEADER)) {
      return isAgeArmorEnvelope(fullText().trim());
    }
    const headerEnd = ageHeaderEnd(header);
    return headerEnd !== undefined && size >= headerEnd + AGE_PAYLOAD_MIN_BYTES;
  }
  return isSopsEnvelope(fullText());
}

// Resolves the filter attribute from the index alone (--cached): the policy
// the prospective commit actually carries. Worktree-only, dirty, or
// skip-worktree attribute files cannot leak in, attr.tree/GIT_ATTR_SOURCE
// cannot redirect the evaluation (index direction wins over both), and
// GIT_ATTR_NOSYSTEM keeps machine-wide admin policy out of the proof — the
// remaining local-only sources are screened by localOnlyAttributeErrors, so
// an accepted assignment can only come from a staged .gitattributes file.
// HEAD's blob sha for the path, or undefined when HEAD does not track it —
// including unborn HEAD, where an absent index entry means adoption, never
// deletion.
function headBlobSha(repoRoot: string, path: string): string | undefined {
  const result = git(repoRoot, ["ls-tree", "-z", "HEAD", "--", path]);
  if (result.status !== 0 || result.stdout === "") return undefined;
  return /^\d+ blob ([0-9a-f]+)\t/.exec(result.stdout)?.[1];
}

// A HEAD config that does not parse declares nothing: it cannot prove a
// section drop is in flight, so it never authorizes a stand-down.
function headConfidentialSection(repoRoot: string, sha: string): ConfidentialConfig | undefined {
  try {
    return parseWorkspaceConfig(
      JSON.parse(fullBlobText(repoRoot, sha, FULL_ENVELOPE_MAX_BYTES, "utf8")),
    ).confidential;
  } catch {
    return undefined;
  }
}

function filterAttributes(repoRoot: string, paths: string[]): Map<string, string> {
  if (paths.length === 0) return new Map();
  const result = git(
    repoRoot,
    ["check-attr", "--cached", "-z", "--stdin", "filter"],
    `${paths.join("\0")}\0`,
    LISTING_MAX_BYTES,
    { GIT_ATTR_NOSYSTEM: "1" },
  );
  if (result.truncated) throw new Error("attribute listing exceeds 64 MiB");
  if (result.status !== 0) throw new Error("could not inspect git attributes");
  const tokens = result.stdout.split("\0");
  const out = new Map<string, string>();
  for (let i = 0; i + 2 < tokens.length; i += 3) {
    out.set(tokens[i]!, tokens[i + 2]!);
  }
  return out;
}

export function confidentialReport(
  repoRoot: string,
  section: ConfidentialConfig | undefined,
): ConfidentialReport {
  const errors: string[] = [];
  // With no worktree section and an unreadable index (not a git repository),
  // nothing is declared anywhere and the gate stays inert. A declared section
  // with an unreadable index still fails closed below.
  let entries: IndexEntry[];
  try {
    entries = indexEntries(repoRoot);
  } catch (error) {
    if (!section) {
      return {
        errors,
        warnings: [],
        state: `no confidential section in ${CONFIG_FILE}`,
        active: false,
        staged: false,
      };
    }
    throw error;
  }

  // The gate evaluates the prospective commit: staged blobs, the staged
  // attribute policy, and the staged declaration itself. The index config
  // therefore supplies the effective section — unstaged edits take effect
  // once staged, and a commit that drops the section honestly declares
  // nothing. A config staged for deletion (tracked in HEAD, absent from the
  // index) declares nothing either: de-adoption must not be blocked by the
  // very copy being removed. Only a genuinely untracked config — adoption in
  // progress — falls back to the worktree section.
  const stagedConfigEntry = entries.find((entry) => entry.path === CONFIG_FILE);
  const headConfigSha = headBlobSha(repoRoot, CONFIG_FILE);
  const configDeleted = stagedConfigEntry === undefined && headConfigSha !== undefined;
  // A declaration is in flight only when the index state differs from HEAD;
  // a steady tracked config is just the workspace's ordinary declaration.
  const declarationInFlight = stagedConfigEntry?.sha !== headConfigSha;
  let config = configDeleted ? undefined : section;
  let warnings: string[] = [];
  if (stagedConfigEntry) {
    const stagedText = fullBlobText(
      repoRoot,
      stagedConfigEntry.sha,
      FULL_ENVELOPE_MAX_BYTES,
      "utf8",
    );
    try {
      const stagedRaw: unknown = JSON.parse(stagedText);
      config = parseWorkspaceConfig(stagedRaw).confidential;
      warnings = unknownConfigKeys(stagedRaw).map(
        (key) =>
          `warning: staged ${CONFIG_FILE} has unrecognized key ${JSON.stringify(key)} (ignored by this kit version)`,
      );
    } catch (error) {
      return {
        errors: [
          `staged ${CONFIG_FILE} is not a valid workspace config: ${
            error instanceof Error ? error.message : String(error)
          }`,
        ],
        warnings: [],
        state: "invalid staged config",
        active: true,
        staged: true,
      };
    }
  }
  if (!config) {
    // The gate stands down only when the declaration itself is being
    // removed: a config staged for deletion, or a staged drop of a section
    // HEAD still carries. A sectionless config that is merely being edited
    // is the ordinary unconfigured state, so the standalone command must
    // keep reporting the missing contract instead of going green.
    const headHasSection =
      headConfigSha !== undefined && headConfidentialSection(repoRoot, headConfigSha) !== undefined;
    const standDown = configDeleted || headHasSection;
    return {
      errors,
      warnings,
      state: configDeleted
        ? `${CONFIG_FILE} staged for deletion`
        : standDown
          ? `no confidential section in staged ${CONFIG_FILE}`
          : `no confidential section in ${CONFIG_FILE}`,
      active: false,
      staged: standDown,
    };
  }

  const matchers = config.paths.map((pattern) => globToRegExp(portablePathIdentity(pattern)));
  // The config file must never be confidential itself: an encrypted
  // workspace.json leaves fresh clones unable to load any configuration.
  if (matchers.some((regex) => regex.test(portablePathIdentity(CONFIG_FILE)))) {
    errors.push(`confidential paths must not cover ${CONFIG_FILE}`);
  }
  const protectedEntries = entries.filter(
    (entry) =>
      entry.path !== CONFIG_FILE &&
      matchers.some((regex) => regex.test(portablePathIdentity(entry.path))),
  );

  let locked = 0;
  let unlocked = 0;
  for (const entry of protectedEntries) {
    if (entry.mode !== "100644" && entry.mode !== "100755") {
      errors.push(`protected path is not a regular file: ${displayPath(entry.path)}`);
      continue;
    }
    const prefix = blobText(repoRoot, entry.sha, BLOB_PREFIX_BYTES);
    if (
      !isProviderCiphertext(
        config.provider,
        prefix,
        () => fullBlobText(repoRoot, entry.sha, FULL_ENVELOPE_MAX_BYTES),
        () => ({
          header: blobText(repoRoot, entry.sha, FULL_ENVELOPE_MAX_BYTES),
          size: blobSize(repoRoot, entry.sha),
        }),
      )
    ) {
      errors.push(`plaintext staged in protected path: ${displayPath(entry.path)}`);
      continue;
    }
    if (config.provider === "git-crypt") {
      const worktree = worktreePrefix(repoRoot, entry.path, GIT_CRYPT_MAGIC.length);
      if (worktree !== undefined) {
        if (worktree.startsWith(GIT_CRYPT_MAGIC)) locked += 1;
        else unlocked += 1;
      }
    }
  }

  if (config.provider === "git-crypt" && protectedEntries.length > 0) {
    // Coverage is resolved from the staged attribute policy and proven
    // versioned by construction: local-only sources are screened for git-crypt
    // policy, so an accepted assignment can only come from a staged
    // .gitattributes file.
    const attributes = filterAttributes(
      repoRoot,
      protectedEntries.map((entry) => entry.path),
    );
    for (const entry of protectedEntries) {
      if (!GIT_CRYPT_RESOLVED_FILTER.test(attributes.get(entry.path) ?? "")) {
        errors.push(`missing git-crypt filter attribute: ${displayPath(entry.path)}`);
      }
    }
    errors.push(...localOnlyAttributeErrors(repoRoot, entries));
  }

  const protectedPaths = new Set(protectedEntries.map((entry) => entry.path));
  for (const entry of entries) {
    // Protected paths already fail as plaintext when they hold key material;
    // the content scan exists for conventional key names elsewhere. Under
    // .git-crypt/, git-crypt's committed GPG-encrypted recipient files are
    // legitimate artifacts of the add-gpg-user workflow — only raw exported
    // key material is rejected there.
    if (protectedPaths.has(entry.path)) continue;
    if (entry.mode !== "100644" && entry.mode !== "100755") continue;
    const underGitCrypt = entry.path.split("/")[0] === ".git-crypt";
    if (!underGitCrypt && !KEY_MATERIAL_PATH.test(entry.path)) continue;
    // Candidate files are already named like key material, so scan their
    // complete bounded contents: age identity files permit comments, and a
    // secret line beyond a short prefix would otherwise slip through.
    const text = fullBlobText(repoRoot, entry.sha, FULL_ENVELOPE_MAX_BYTES);
    if (
      text.startsWith(GIT_CRYPT_KEY_MAGIC) ||
      text.includes(PGP_SECRET_MARKER) ||
      PEM_PRIVATE_ARMOR.test(text) ||
      text.includes(AGE_SECRET_MARKER) ||
      isOpenPgpSecretKey(text)
    ) {
      errors.push(`secret key material is tracked: ${displayPath(entry.path)}`);
    }
  }

  const total = protectedEntries.length;
  const state =
    config.provider === "git-crypt"
      ? `git-crypt, ${total} protected, ${locked} locked, ${unlocked} unlocked`
      : `${config.provider}, ${total} protected`;
  return {
    errors,
    warnings,
    state,
    active: true,
    staged: declarationInFlight,
  };
}
