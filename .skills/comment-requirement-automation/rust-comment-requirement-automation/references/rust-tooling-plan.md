# Rust tooling plan

## xtask layout

Prefer this layout:

```text
Cargo.toml
xtask/
  Cargo.toml
  src/main.rs
AGENTS.md
```

Organize xtask modules around tool responsibilities: scanning source comments, parsing tagged sentences, binding comments to Rust syntax nodes, building the in-memory registry, generating the AGENTS.md index, classifying changed hunks, enforcing rules, and printing diagnostics.

Keep the registry in memory during each command. Do not write `trace.json` or any other persistent machine index.

## Dependencies

Use `tree-sitter` and `tree-sitter-rust` for parsing comments and Rust syntax. Use `cargo_metadata` for workspace discovery. Use `ignore` or `walkdir` for traversal. Use a small parser for tag extraction and sentence validation. Use Git commands or a Git library to read staged blobs. Use parsed Git diffs or a diff crate to map changed hunks to Rust syntax nodes.

Keep these dependencies inside `xtask` so production crates do not inherit them.

## Commands

`cargo xtask req scan` prints discovered declarations, verification links, bindings, and diagnostics for local debugging.

`cargo xtask req fmt-agents` scans source comments and rewrites only the AGENTS.md generated block.

`cargo xtask req check --staged` reads the Git index and validates the staged snapshot. For partially staged files, parse the staged blob and ignore unstaged working-tree content.

`cargo xtask req check --all` validates the full checkout. Use it in CI.

Optional: `cargo xtask req check --base <git-ref>` can classify changed hunks against a base ref when the repository wants CI to focus diagnostics on a branch diff while still scanning the full registry.

## Staged snapshot handling

Handle added, modified, deleted, and renamed files. Treat renames as delete plus add unless the implementation reliably preserves rename metadata. If AGENTS.md is not staged but regeneration would change it, fail and instruct the user to run `cargo xtask req fmt-agents` and stage AGENTS.md.

## Diagnostics

Emit compiler-style diagnostics:

```text
src/db.rs:14: invalid-comment-body: requirement comments must contain one tagged sentence
src/auth.rs:91: missing-requirement-anchor: changed reqwest call requires @behavior or @constraint on the enclosing unit
src/gateway.rs:8: missing-structure-intent: new trait PaymentGateway requires @intent
AGENTS.md:1: stale-requirement-index: run cargo xtask req fmt-agents
```

Diagnostics should not invent requirement text. They should point to the code unit that needs a one-sentence requirement or verification comment.
