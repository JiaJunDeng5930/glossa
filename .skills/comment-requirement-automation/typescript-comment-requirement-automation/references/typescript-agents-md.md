# TypeScript AGENTS.md additions

Add a short rule section to AGENTS.md for TypeScript repositories. It should say that requirement truth lives in one-sentence source comments, `@behavior`, `@constraint`, `@intent`, and `@verifies` are the only requirement tags, dotted IDs form an arbitrary-depth tree, the generated requirement index is for retrieval only, agents must search source comments for an ID before changing behavior, and agents must run the project-local index command after changing requirement tags.

Use the repository’s package manager. For pnpm projects, include commands like:

```text
pnpm req:fmt-agents
pnpm req:check:staged
pnpm req:check
```

For npm, yarn, or bun projects, replace the prefix and keep the same command meanings.

Place the generated requirement index in the root AGENTS.md unless the repository has package-specific AGENTS.md files. In a TypeScript monorepo, one root block is usually better when the tool scans all packages. Use per-package blocks only when the repository already has package-specific agent scopes.

The generated block must be updated by the automation tool. Agents must not manually edit rows inside `BEGIN AGENTS_MD_REQUIREMENT_INDEX` and `END AGENTS_MD_REQUIREMENT_INDEX`.
