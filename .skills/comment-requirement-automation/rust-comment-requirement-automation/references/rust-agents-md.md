# Rust AGENTS.md additions

## Human-maintained Rust instructions

Add a Rust-specific section to AGENTS.md when the repository uses this system. The section should say that Rust requirement comments are parsed by the xtask requirement tool, the generated requirement index is updated by `cargo xtask req fmt-agents`, pre-commit validation uses `cargo xtask req check --staged`, and CI validation uses `cargo xtask req check --all`.

Also say that agents must search source comments for an ID before changing Rust behavior, constraints, structural abstractions, or tests. The generated index only helps find IDs; the source comment next to Rust code carries the full sentence.

## Generated block placement

Place the generated requirement index in the root AGENTS.md unless the repository has package-specific AGENTS.md files. In a Rust workspace with multiple crates, one root block is usually better because `cargo metadata` can scan the workspace and produce one ID tree.

The xtask command should preserve all AGENTS.md content outside these markers:

```text
<!-- BEGIN AGENTS_MD_REQUIREMENT_INDEX -->
<!-- END AGENTS_MD_REQUIREMENT_INDEX -->
```

## Hook command guidance

Use the actual commands in AGENTS.md. A typical Rust setup says:

```text
After changing requirement tags, run cargo xtask req fmt-agents and stage AGENTS.md.
Before committing, run cargo xtask req check --staged.
CI runs cargo xtask req check --all on a clean checkout.
```

Do not ask agents to edit generated rows manually.
