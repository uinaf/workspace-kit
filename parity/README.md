# Parity oracle

The TypeScript checks in `src/` reproduce these goldens byte-for-byte
([`test/golden-parity.test.ts`](../test/golden-parity.test.ts)).

- `legacy/`: frozen bun validators from the workspaces that originated the
  convention. Fixes land in `src/`, never here.
- `fixtures/green-personal/`: one synthetic workspace that covers every green
  path. [`scenarios.ts`](scenarios.ts) defines each error scenario as a
  mutation of it, and owns the output normalization every comparison applies.
- `goldens/`: captured legacy output. Never edit by hand.

## Regenerate

Needs bun and git; CI never runs the legacy scripts.

```
bun parity/capture.ts
```

Run it twice: `git diff` must stay empty.

Legacy quirks no golden can capture are pinned in
[`test/unit.test.ts`](../test/unit.test.ts). Change one only on purpose.
