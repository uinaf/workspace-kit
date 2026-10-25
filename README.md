![workspace-kit — validates and scaffolds agent workspaces.](https://uinaf.dev/og/banner/workspace-kit.png)

# uinaf/workspace-kit

Config-driven validation and scaffolding for **agent workspaces**: git
repositories that give coding agents a stable operating context. These are not
package-manager workspaces. Runs on macOS and Linux.

## Install

```bash
pnpm add --save-dev --save-exact @uinaf/workspace-kit
```

Needs the Node range in `engines` and git on PATH. Run the project-local
binary so contributors and CI use the pinned version.

To start a new workspace, run this in an empty directory:

```bash
pnpm dlx @uinaf/workspace-kit@latest init --profile personal
pnpm install
pnpm verify
```

A repository that already has a `package.json` follows
[Adopting an existing workspace](docs/convention.md#adopting-an-existing-workspace).

## Use

```bash
pnpm exec workspace-kit verify    # complete offline gate, local and CI
pnpm exec workspace-kit --help    # every command
```

`workspace.json` selects the checks; an absent section disables its check.
[docs/convention.md](docs/convention.md) holds the workspace layout, the
configuration, and the output contract. Secret detection belongs in each
workspace's own CI
([security composition](docs/convention.md#repository-security-composition)).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Vulnerabilities:
[SECURITY.md](https://github.com/uinaf/workspace-kit/security/policy).

## License

[MIT](LICENSE)
