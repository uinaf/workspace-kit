# workspace-kit

Config-driven validation and scaffolding for **agent workspaces** — the git
repositories that give coding/assistant agents a stable operating context.
This workspace model is distinct from package-manager workspaces and monorepo
tooling.

## Install

```
npm install -D @uinaf/workspace-kit
```

Or run one-shot with `npx -y @uinaf/workspace-kit`. Requires Node >= 24.18,
plus git on PATH for the history-dependent checks. Pin exact versions.

## Quick usage

```
npx -y @uinaf/workspace-kit init --profile personal   # scaffold a workspace
npx -y @uinaf/workspace-kit doctor                    # validate it
npx -y @uinaf/workspace-kit wiki backfill --check     # detect catalog drift
npx -y @uinaf/workspace-kit registry validate         # validate projects.json
npx -y @uinaf/workspace-kit skills sync               # materialize workspace skills
```

`doctor` runs the configured structure, wiki-lint, ownership-contract,
documentation-link, workspace-skill, and soft-limit checks. Project-registry
validation and wiki freshness remain explicit commands because they have
separate operational contracts. Candidate paths are screened with
`contract handoff <paths...>` for human review eligibility. Absent config
sections disable their checks, unknown files are always tolerated, and all
validation runs offline with zero runtime dependencies.
`workspace-kit --help` lists all commands.

`registry validate` is an explicit project-registry gate. It validates the
entire declared entry shape before inspecting any locally present checkout,
then checks project paths against the configured home-relative prefix, allowed
Git origin hosts, repository paths, portable case/Unicode aliases, canonical
roots, and optional catalog pointers. The explicit `registry.project` policy
enables this command; `originHosts` defaults to `["github.com"]`, and missing
checkouts are allowed.
Personal and runtime scaffolds include this gate in their generated pre-commit
hook and validation instructions.

For Git-aware wiki freshness, opt in with `wiki.revisionStaleness`. The check
then evaluates the current working tree, including staged and unstaged edits,
so source changes are visible before commit and a page edited in the same
proposed revision can attest them. For wiki-to-wiki sources, an `updated:`-only
frontmatter change is metadata: it does not make dependent pages stale.

## Composition model

`workspace-kit` owns portable workspace structure, scaffolding, and validation.
Consumers compose it with independently installed and released companion tools
such as `uinaf/agents` and `uinaf/dotfiles`. The optional `skills sync` command
links authored workspace skills and installs the workspace's declared remote
skills while leaving machine-global capabilities to the consumer.

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
