# Parity oracle

This directory is the migration contract for 0.1.0: the ported TypeScript in
`src/` must reproduce these goldens byte-for-byte before any consumer adopts
the kit.

## Layout

- `legacy/` — frozen validator scripts (bun) from the private workspaces that
  originated the convention, at extraction time. Do not edit, except
  for the two fixes recorded in the spec (missing `log.md` crash; hardcoded
  `bun` sub-spawn) — and those land in `src/`, never here.
- `fixtures/green-personal/` — one synthetic workspace exercising every green
  code path. Error scenarios are defined as mutations inside `capture.ts`,
  not as separate trees.
- `goldens/` — captured legacy outputs: `<scenario>.out` / `.err` / `.exit`,
  plus `backfill-generated.tree` (generated-file snapshot) and
  `backfill-worktree-status.txt` (idempotency proof).
- `capture.ts` — rebuilds fixtures as real git repos with pinned
  author/committer dates (deterministic commit ids) and regenerates all
  goldens. Requires bun and git locally; CI never runs legacy scripts.

## Normalization

Captured text replaces the fixture working directory with `<WORK>`, the
capture day's date with `<TODAY>` (the legacy backfill stamps the current
date into generated frontmatter), and — in the `peer-check-shared` scenario
only — 40-hex commit ids with `<SHA>`. Any parity comparison must apply the
same normalization to the new implementation's output.

## Scenario map

| Scenario                                         | Covers                                                                                                                                                                   |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `doctor-green`                                   | full doctor pass: required files, symlink, registry shape, daily H1, wiki lint + contract subchecks                                                                      |
| `doctor-cascade-errors`                          | failing wiki child: streamed child stderr ordering + `wiki-lint failed (exit 1)` aggregation                                                                             |
| `contract-check-green-https`                     | https remote form of the origin match                                                                                                                                    |
| `wiki-lint-green`                                | frontmatter, source existence, page-relative / root-relative / unique-leaf wikilinks, alias + anchor, code stripping, %20 markdown links, orphan exemptions, log grammar |
| `contract-check-green` / `contract-check-errors` | origin match, tracked required / forbidden owner paths, ancestor validation (all errors accumulate)                                                                      |
| `handoff-allowed` / `handoff-blocked`            | tolerant pass-through plus every denylist class: `.env*` basenames, exact paths, prefixes, absolute, `..` traversal                                                      |
| `peer-check-green` / `peer-check-shared`         | reciprocity, shared ancestor, post-split commit-id intersection                                                                                                          |
| `wiki-stale-green` / `wiki-stale-flagged`        | commit-date map vs `updated:` comparison and report shape                                                                                                                |
| `backfill-*` + `wiki-lint-post-backfill`         | generated catalogs, tag materialization threshold, stale tag-page purge, generator/linter lockstep, second-run idempotency                                               |
| `doctor-structure-errors` / `wiki-lint-errors`   | every structure and wiki failure class, including ambiguous-leaf resolution reported as a broken wikilink                                                                |

## Regenerating

```
bun parity/capture.ts
```

Run it twice and `git diff` — the output must be identical (determinism is
part of the contract). Goldens only change when a legacy script changes, and
legacy scripts are frozen.

## Known legacy behaviors that are FIXES in src/, not parity targets

1. `wiki-lint` crashes with a stack trace when `memory/wiki/log.md` is
   missing — the port reports a clean error (or skips when the wiki section
   is unconfigured). No golden exists for this on purpose.
2. `doctor` spawns the literal `bun` binary for sub-checks — the port runs
   sub-checks in-process. Behavior is identical on the green path.
3. `doctor`'s `projects.json` parse-failure message embeds the JS engine's
   JSON error text (JavaScriptCore vs V8 differ) — byte parity is impossible
   there and that message is explicitly excluded from the contract.
4. Audited filesystem containment is a kit-level security invariant, not a
   legacy parity behavior: backfill canonicalizes its workspace-relative root,
   rejects symlinked or incomplete scans and output trees, preflights every
   mutation, and surfaces purge failures. The frozen fixtures contain none of
   these hostile shapes, so their generated bytes remain unchanged.

## Port-time unit-test debt (behaviors goldens cannot capture)

Record these as `src/` unit tests during the port; each is a real legacy
behavior with no golden:

- Backfill cross-day idempotency: the date-only-diff suppression in
  `wiki-backfill.ts` `write()` cannot be goldened same-day. Unit test: write
  a generated file with yesterday's `updated:`, rerun, assert byte-identical.
- Frontmatter parser quirks (`lib/frontmatter.ts`): inline arrays split on
  commas even inside quotes; single-quote stripping; CRLF files never parse.
  The port keeps this parser as-is — tests define the kept quirks.
- Non-string `updated:` values silently skip validation in both wiki-lint
  and wiki-stale.
- `wiki-lint` missing-wiki-root exit-1 message; markdown-link `#fragment`
  splitting.
- `doctor`: symlink-with-wrong-target message, projects.json parse-failure /
  root-array / non-array-category / non-object-entry branches, BOM
  stripping, non-directory entries under `memory/contexts/`.
- Contract/peer: `origin remote is missing`, non-hex `sharedAncestor`
  message, `loadContract` field-order fail-fast, non-reciprocal contracts
  and different-ancestor early return (which deliberately SKIPS the
  shared-history check), `current:`/`peer:` error prefixes.
- `wiki-stale`: `git log failed` fallback still prints `wiki-stale ok`.
- Handoff: `--handoff` with zero args exits 2 (usage), not an empty
  eligible list.
- Backfill `Source.source` (`source:` frontmatter field) is dead code —
  never read by output generation. The port may drop it; do not cargo-cult.
