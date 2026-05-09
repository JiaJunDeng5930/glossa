# TypeScript tooling plan

## Tool layout

Keep the requirement automation inside the repository. Prefer one of these layouts:

```text
tools/requirements/
  package.json
  src/main.ts
```

```text
scripts/requirements/
  main.ts
```

Expose the tool through root package scripts. For pnpm projects, use names such as:

```text
pnpm req:scan
pnpm req:fmt-agents
pnpm req:check:staged
pnpm req:check
```

For npm, yarn, or bun projects, keep the same command meanings and adapt syntax to the package manager. Do not require agents to invoke a raw script path.

## Parser stack

Use the TypeScript compiler API or `ts-morph` as the primary parser. These APIs understand TypeScript, TSX, decorators, imports, exports, declaration shapes, and source positions. Use `@typescript-eslint/parser` or a Babel parser only for JavaScript forms that the selected TypeScript parser cannot represent in the repository.

Use `fast-glob` and ignore rules to select source files. Exclude generated output, coverage, caches, package manager stores, `node_modules`, build artifacts, vendored code, and generated API clients unless the repository intentionally treats generated clients as editable source.

Use Git to read staged blobs for pre-commit. Partially staged files must be parsed from the staged snapshot, not from the working tree.

## Commands

`req:scan` prints discovered declarations, verification links, bindings, and diagnostics for local debugging.

`req:fmt-agents` scans source comments and rewrites only the AGENTS.md generated block.

`req:check:staged` validates the Git index and compares the staged AGENTS.md block with the generated block.

`req:check` validates the full checkout. Use this command in CI before or alongside lint, typecheck, build, and test.

Optional: `req:check --base <git-ref>` can classify changed hunks against a base ref when CI wants branch-focused diagnostics while still scanning the full registry.

## Staged snapshot handling

Handle added, modified, deleted, and renamed files. Treat renames as delete plus add unless the implementation reliably preserves rename metadata. If AGENTS.md is not staged but regeneration would change it, fail and instruct the user to run the repository’s AGENTS.md formatting command and stage AGENTS.md.

## Diagnostics

Emit compiler-style diagnostics:

```text
src/db.ts:14 invalid-comment-body requirement comments must contain one tagged sentence
src/auth.ts:91 missing-requirement-anchor changed fetch call requires @behavior or @constraint on the enclosing unit
src/gateway.ts:8 missing-structure-intent new interface PaymentGateway requires @intent
AGENTS.md:1 stale-requirement-index run pnpm req:fmt-agents
```

Diagnostics should not invent requirement text. They should point to the code unit that needs a one-sentence requirement or verification comment.
