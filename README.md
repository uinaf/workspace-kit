# uinaf/workspace-kit

Config-driven validation and scaffolding for **agent workspaces** — the git
repositories that give coding/assistant agents a stable operating context.
This workspace model is distinct from package-manager workspaces and monorepo
tooling.

Supported execution environments are macOS and Linux.

## Install

```bash
npm install --save-dev --save-exact @uinaf/workspace-kit
```

Use the project-local binary so contributors and CI use the version recorded
by the workspace. Requires Node >= 24.18 plus git on PATH for the
history-dependent checks.

For a new workspace, start in an empty directory. The one-shot bootstrap
records the resolved release as an exact local development dependency; ongoing
commands then use that local pin:

```bash
npx --yes @uinaf/workspace-kit@latest init --profile personal
npm install
npm run verify
```

For a repository that already has `package.json`, follow
[Adopting an existing workspace](docs/convention.md#adopting-an-existing-workspace)
so its existing scripts and dependencies remain explicit. `init` validates a
compatible package when re-run and stops before writing around an incompatible
one.

## Quick usage

```bash
npm exec -- workspace-kit verify                    # complete offline gate
npm exec -- workspace-kit doctor                    # configured core checks
npm exec -- workspace-kit wiki backfill --check     # detect catalog drift
npm exec -- workspace-kit registry validate         # validate projects.json
npm exec -- workspace-kit registry status           # inspect registered checkouts
npm exec -- workspace-kit registry clone            # clone missing managed checkouts
npm exec -- workspace-kit registry pull             # fast-forward managed checkouts
npm exec -- workspace-kit hooks install              # enable tracked Git hooks
npm exec -- workspace-kit skills sync               # materialize workspace skills
```

`verify` is the canonical local and CI gate. It validates the config, runs the
configured `doctor` checks, validates a configured project registry, and checks
that configured wiki catalogs are current. `doctor` covers structure,
wiki-lint, ownership-contract, documentation-link, workspace-skill, and
soft-limit checks. Git-history-based wiki staleness remains an explicit
operation. Candidate paths are screened with `contract handoff <paths...>` for
human review eligibility. Absent config sections disable their checks, unknown
files are always tolerated, and all validation runs offline with zero runtime
dependencies.
`workspace-kit --help` lists all commands.

`registry validate` is an explicit project-registry gate. It validates the
entire declared entry shape before inspecting any locally present checkout,
then checks project paths against the configured home-relative prefix, allowed
Git origin hosts, repository paths, portable case/Unicode aliases, canonical
roots, optional catalog pointers, allowed repository owners, required entries,
and an optional entry limit. The explicit `registry.project` policy enables
this check; `originHosts` defaults to `["github.com"]`, and missing checkouts
are allowed. `verify` includes it whenever that policy is present. Personal and
runtime scaffolds use `verify` in their generated pre-commit hook.

The explicit `registry clone`, `registry status`, and `registry pull` commands
run the same validation first, then operate on the configured lifecycle modes.
Clone and pull affect only entries whose mode is `managed`; status also shows
locally present route-only entries. Pull is always fast-forward-only and
refuses a configured branch mismatch. `registry path <category/name>` resolves
one validated checkout for consumer-owned composition without teaching the
package about a particular repository. `hooks install` configures the tracked
`.githooks` directory for the current checkout.

For Git-aware wiki freshness, opt in with `wiki.revisionStaleness`. The check
then evaluates the current working tree, including staged and unstaged edits,
so source changes are visible before commit and a page edited in the same
proposed revision can attest them. For wiki-to-wiki sources, an `updated:`-only
frontmatter change is metadata: it does not make dependent pages stale.

## Composition model

`workspace-kit` owns portable workspace structure, scaffolding, and validation.
Consumers own machine-global setup and compose repository-local tools through
their workspace policy. The optional `skills sync` command links authored
workspace skills and installs the workspace's declared remote skills. It
records those copies in `skills/workspace-kit-lock.json` so later syncs retire
only workspace-kit-managed copies. Machine-global capabilities remain
consumer-owned.

Workspace repositories run history-based secret detection in a dedicated CI
workflow. Consumers can list that workflow in `workspace.json.required` when
its presence is part of their structural contract. Local `workspace-kit`
commands remain deterministic, credential-free workspace checks.

## Docs

- [Workspace convention, bootstrap, and check contracts](docs/convention.md) —
  workspace structure, skill ownership, scaffold follow-through, and exactly
  what each check enforces
- [Parity oracle](parity/README.md) — the executable spec the checks are
  held to, byte-for-byte
- [Release workflow](docs/releasing.md) — automatic, tokenless publishing

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Vulnerabilities: [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
