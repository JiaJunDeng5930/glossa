---
name: typescript-comment-requirement-automation
description: "Build TypeScript/JavaScript-specific automation for the source-comment requirement system: Node tool commands, TypeScript AST parsing, staged pre-commit checks, CI checks, detectors for exports/contracts, union/enum/reducer state machines, side effects, failure policy, access and safety rules, structural intent, test expectations, and AGENTS.md generated requirement index updates."
---

# TypeScript Comment Requirement Automation

## Goal

Implement the abstract source-comment requirement protocol in a TypeScript or JavaScript repository. Use the higher-level skill for protocol semantics and AGENTS.md policy. This nested skill maps those rules to TypeScript syntax, Node project layout, package-manager scripts, and common TypeScript framework idioms.

Build tools. Do not manually write the AGENTS.md index. Do not create a persistent machine index. The tool may build an in-memory registry during one command invocation.

## Tooling strategy

Create a project-local Node tool rather than a global dependency. Prefer `tools/requirements/` or `scripts/requirements/` implemented in TypeScript and executed with the repository’s existing runner, such as `tsx`, `ts-node`, or a compiled `node dist` command. Expose stable package-manager scripts so hooks and CI do not depend on editor plugins.

Use the TypeScript compiler API or `ts-morph` to parse `.ts`, `.tsx`, `.mts`, `.cts`, and typed project files. Use `@typescript-eslint/parser` or a Babel parser only when the repository has significant plain JavaScript syntax that the TypeScript parser does not cover. Use `fast-glob` plus the repository ignore rules for traversal. Use Git staged blobs for pre-commit so the tool validates the staged snapshot instead of the working tree.

Provide these commands through the real package manager:

- `pnpm req:scan` for local debugging of discovered comments, bindings, IDs, and diagnostics.
- `pnpm req:fmt-agents` to regenerate only the AGENTS.md requirement index block.
- `pnpm req:check:staged` for pre-commit validation of staged content.
- `pnpm req:check` for CI validation of the full checkout.

If the repository uses npm, yarn, or bun, keep the command semantics and adjust the prefix. Read `references/typescript-tooling-plan.md` before designing the tool layout.

## TypeScript comment binding

Accept `//`, `/* ... */`, and `/** ... */` comments that contain one tagged sentence. Normalize the comment marker away, then parse the tag, ID, and sentence.

Bind leading comments to the next declaration, expression statement, or framework registration that owns the behavior. Handle exported functions, classes, interfaces, type aliases, enums, const objects, React components, route handlers, resolver functions, controller methods, and function expressions assigned to variables or object properties. Inside function bodies, bind comments to the next `if`, `switch`, `case`, loop, `try`, `catch`, awaited call, assignment, return, throw, assertion, snapshot, or mock setup.

A requirement comment that cannot bind to a TypeScript syntax node is invalid. A broad file, class, or function comment does not remove the need for narrower descendant comments on inner branches, state transitions, side effects, structural abstractions, or assertions.

Read `references/typescript-binding-and-comments.md` for parser details.

## TypeScript diff detectors

Map abstract forced-anchor categories to TypeScript syntax and idioms. Public contract changes often involve `export`, public class members, interfaces, type aliases, discriminated unions, runtime schemas, route handlers, RPC procedures, GraphQL schema and resolvers, React props, package entrypoints, environment schemas, and configuration keys. State machines often use string-literal unions, discriminated unions, enums, reducers, state fields, `switch` statements, and XState machines. Structural intent often appears as interfaces, abstract classes, provider adapters, factories, registries, middleware chains, plugin hooks, dependency-injection bindings, generic wrappers, and compatibility layers.

Read `references/typescript-detectors.md` before implementing diff classification. Use repository-specific detector configuration for framework APIs, database clients, external SDKs, event emitters, audit logs, metrics, auth checks, and test mocks.

## AGENTS.md in TypeScript repositories

Update AGENTS.md with the abstract requirement rules and the real package-manager commands. The generated requirement index block must be updated by the project-local command such as `pnpm req:fmt-agents`; agents must not edit the block manually.

Read `references/typescript-agents-md.md` before patching AGENTS.md.

## Hook and CI wiring

Wire pre-commit to run the staged command, such as `pnpm req:check:staged`. It must fail when staged comments, bindings, IDs, AGENTS.md index, or forced-anchor checks are invalid.

Wire CI to run the full check, such as `pnpm req:check`, then the repository’s normal TypeScript checks such as format, lint, typecheck, build, and test. Adjust names to the repository’s existing package manager and scripts.

Use compiler-style diagnostics. Do not generate PR reports.
