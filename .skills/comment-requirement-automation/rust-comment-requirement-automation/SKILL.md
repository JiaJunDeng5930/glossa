---
name: rust-comment-requirement-automation
description: "Build Rust-specific automation for the source-comment requirement system: xtask commands, tree-sitter-rust parsing, staged pre-commit checks, CI checks, Rust diff detectors for contracts, state machines, side effects, failure policy, safety, structural intent, test expectations, and AGENTS.md generated requirement index updates."
---

# Rust Comment Requirement Automation

## Goal

Implement the abstract source-comment requirement protocol in a Rust repository. Use the higher-level skill for protocol semantics and AGENTS.md policy. This nested skill maps those rules to Rust syntax, Rust project layout, and Rust automation practices.

Build tools. Do not manually write the AGENTS.md index. Do not create a persistent machine index. The tool may build an in-memory registry during one command invocation.

## Tooling strategy

Use an `xtask` crate as the project-local automation entrypoint. Keep parser, scanner, diff classifier, registry builder, AGENTS.md updater, and diagnostics inside xtask so production crates do not inherit tool dependencies.

Use `tree-sitter-rust` to parse Rust files and bind requirement comments to Rust syntax nodes. Use `cargo metadata` to discover workspace packages, targets, examples, benches, and test files. Use Git staged blobs for pre-commit so the tool validates the staged snapshot instead of the working tree.

Provide these commands:

- `cargo xtask req scan` for local debugging of discovered comments, bindings, IDs, and diagnostics.
- `cargo xtask req fmt-agents` to regenerate only the AGENTS.md requirement index block.
- `cargo xtask req check --staged` for pre-commit validation of staged content.
- `cargo xtask req check --all` for CI validation of the full checkout.

Read `references/rust-tooling-plan.md` before designing the xtask layout.

## Rust comment binding

Accept Rust comment forms that can carry one tagged sentence: `//`, `///`, `//!`, `/* ... */`, and `/*! ... */`. Normalize the comment marker away, then parse the tag, ID, and sentence.

Bind outer doc comments and immediately preceding line comments to the next Rust item. Bind inner module doc comments to the module or file. Bind comments inside function bodies to the next block-level node or statement: `if`, `match`, match arm, loop, call expression, assignment, return, macro invocation, or assertion.

A requirement comment that cannot bind to a Rust item or statement is invalid. A broad module or function comment does not remove the need for more specific descendant comments on inner branches, state transitions, side effects, structural abstractions, or assertions.

Read `references/rust-binding-and-comments.md` for parser details.

## Rust diff detectors

Map abstract forced-anchor categories to Rust syntax and idioms. Public API changes often involve `pub fn`, `pub struct`, `pub enum`, `pub trait`, `pub use`, serde attributes, route macros, command macros, and schema derives. State machines often use `enum`, especially `pub enum`, with variants such as state, status, phase, mode, or lifecycle. Structural intent often appears as traits, trait objects, generic provider wrappers, factories, registries, middleware chains, or adapter layers.

Read `references/rust-detectors.md` before implementing diff classification. Use repository-specific detector configuration for project crates and method names that represent database writes, external calls, events, audit logs, metrics, auth checks, and test mocks.

## AGENTS.md in Rust repositories

Update AGENTS.md with the abstract requirement rules and the real xtask commands. The generated requirement index block must be updated by `cargo xtask req fmt-agents`; agents must not edit the block manually.

Read `references/rust-agents-md.md` before patching AGENTS.md.

## Hook and CI wiring

Wire pre-commit to run `cargo xtask req check --staged`. It must fail when staged comments, bindings, IDs, AGENTS.md index, or forced-anchor checks are invalid.

Wire CI to run `cargo xtask req check --all`, then the repository’s normal Rust checks such as `cargo fmt --check`, `cargo clippy --all-targets --all-features -- -D warnings`, and `cargo test --all-features`. Adjust flags to the repository’s existing policy.

Use compiler-style diagnostics. Do not generate PR reports.
