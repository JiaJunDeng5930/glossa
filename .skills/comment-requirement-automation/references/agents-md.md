# AGENTS.md integration

## Human-maintained instructions

Add a short human-maintained section near the repository guidance. It must say that requirement truth lives only in source comments, requirement comments use `@behavior`, `@constraint`, `@intent`, and `@verifies`, every requirement comment body is one sentence, dotted IDs form an arbitrary-depth requirement tree, details belong in narrower descendant IDs near the code units that implement them, the generated index is only for retrieval, source comments must be searched for the full sentence before changing behavior or structure, the generated index must not be edited manually, and the project-local command must be run after changing requirement tags.

Use the real command installed in the repository. For Rust projects using xtask, prefer:

```text
cargo xtask req fmt-agents
```

For TypeScript projects, prefer package-manager scripts that call the project-local tool, such as:

```text
pnpm req:fmt-agents
```

## Generated block

Place this generated block in AGENTS.md:

```text
<!-- BEGIN AGENTS_MD_REQUIREMENT_INDEX -->
[Requirement Index]|root:.
|IMPORTANT: Requirement truth lives in source comments; search source comments for an ID before changing code.
|source:source_comments_only
|comment_body:single_sentence
|tags:{@behavior,@constraint,@intent,@verifies}
<!-- END AGENTS_MD_REQUIREMENT_INDEX -->
```

The automation tool replaces only the content between the markers and preserves every other byte outside the block when possible.

## Index row format

Use one row per declared requirement ID:

```text
|a.b.c|a.b.c.{x,y,z}
|a.b.c.x|a.b.c.x.{m,n}
|a.b.c.x.m|a.b.c.x.m.{}
```

The row `a.b.c|a.b.c.{x,y,z}` means `a.b.c` exists and has the immediate narrower nodes `a.b.c.x`, `a.b.c.y`, and `a.b.c.z`. Each listed node can have its own row with further descendants. Leaf rows use `{}`. Rows and immediate-node segments must be sorted deterministically.

Rows come from declaration tags only: `@behavior`, `@constraint`, and `@intent`. `@verifies` links tests to existing IDs and does not create index nodes.

If AGENTS.md does not exist, create it with the human-maintained instruction section and generated block. If a monorepo already uses multiple AGENTS.md files, update the one that governs the scanned root unless the repository has an explicit per-package policy.
