---
name: comment-requirement-automation
description: Build repository automation and AGENTS.md rules for a source-comment requirement system where requirements live as one-sentence tagged comments next to code, dotted IDs form an arbitrary-depth requirement tree, AGENTS.md contains an auto-generated index, and pre-commit/CI enforce the protocol. Use when designing or implementing these tools for a codebase.
---

# Comment Requirement Automation

## Goal

Build repository-local automation for a requirement system whose only durable source of truth is source comments. The system solves four problems: code that cannot explain which requirement it serves, demand-to-code tracing without code-to-demand tracing, AI-generated abstractions that enter the repository without a current purpose, and low-level runtime behavior such as retries, error mapping, state transitions, and side effects being absent from requirements.

This skill is for building the automation and AGENTS.md rules that enforce the system. The automation builder must understand the comment protocol because the tools must parse, validate, bind, index, and enforce it.

## Core protocol

A requirement comment is one tag, one dotted ID, and one sentence bound to one code unit. The tag gives the semantic kind. The ID gives the node position in the requirement tree. The sentence states the local behavior, constraint, structure purpose, or verification attached to that code unit.

Use only these tags:

- `@behavior <id> <sentence>` for observable runtime behavior.
- `@constraint <id> <sentence>` for an invariant, boundary, or limit the system must preserve.
- `@intent <id> <sentence>` for the current purpose of an abstraction, adapter, interface, registry, extension point, migration bridge, or compatibility layer.
- `@verifies <id> <sentence>` for a test expectation that verifies a declared behavior or constraint.

Every comment body is one sentence. The dotted ID tree can have any depth. Each declared node carries the local statement for the code unit it is attached to. A more specific node refines an ancestor by adding one local detail close to the code that implements that detail. Detail may move downward through as many levels as the code requires: module, type, function, branch, state transition, external call, error case, assertion, or any narrower code unit.

Do not make a single comment comprehensive. Add more specific descendant IDs near the inner code units that implement details. Do not add type segments inside IDs. The tag carries type; the ID carries tree position. Do not add relationship tags for dependencies; the dotted tree expresses decomposition. Do not create standalone requirement documents. Do not create persistent machine indexes such as `trace.json`.

Read `references/one-sentence-comment-protocol.md` before implementing scanners, validators, binding logic, or diagnostics.

## Language-specific skills

Use this abstract skill for the protocol, enforcement boundary, and AGENTS.md design. Load a concrete nested skill for language-specific parsing and diff detectors:

- Rust: `rust-comment-requirement-automation/SKILL.md`
- TypeScript: `typescript-comment-requirement-automation/SKILL.md`

Add future language skills as sibling folders and link them here.

## AGENTS.md requirement index

AGENTS.md must contain a generated requirement index block for AI retrieval. The block is derived from source comments by an automation command. Agents must not edit it by hand.

Use these markers:

```text
<!-- BEGIN AGENTS_MD_REQUIREMENT_INDEX -->
...
<!-- END AGENTS_MD_REQUIREMENT_INDEX -->
```

Use compact tree rows inside the block:

```text
[Requirement Index]|root:.
|IMPORTANT: Requirement truth lives in source comments; search source comments for an ID before changing code.
|source:source_comments_only
|comment_body:single_sentence
|tags:{@behavior,@constraint,@intent,@verifies}
|a.b.c|a.b.c.{x,y,z}
|a.b.c.x|a.b.c.x.{m,n}
|a.b.c.x.m|a.b.c.x.m.{}
```

The row `a.b.c|a.b.c.{x,y,z}` means the declared node `a.b.c` has the immediate narrower nodes `a.b.c.x`, `a.b.c.y`, and `a.b.c.z`. Each of those nodes can have its own row and further descendants. Leaf rows use `{}`. Sort rows and immediate-node segments deterministically.

Read `references/agents-md.md` before updating AGENTS.md rules or generated block behavior.

## Automation boundary

Place checks that must hold for every individual commit in pre-commit. Place full-repository, merge-result, and expensive execution checks in CI. CI reruns validators as a bypass guard, but CI must not become the only enforcement point.

Do not create PR reports. CI should fail with compiler-style diagnostics: file, line, rule ID, and concise reason.

Read `references/automation-boundary.md` before deciding where a check belongs.

## Implementation workflow

First inspect the repository’s languages, test layout, existing AGENTS.md, hook mechanism, and CI provider. Then load the language-specific nested skill. For Rust, load `rust-comment-requirement-automation/SKILL.md`. For TypeScript or JavaScript, load `typescript-comment-requirement-automation/SKILL.md`.

Design one project-local tool family that can run in pre-commit and CI. It must scan source comments, parse one-sentence tags, bind tags to code units, build an in-memory requirement registry, validate ID-tree properties, generate the AGENTS.md index block, classify changed hunks, and check the staged or full repository snapshot.

Update AGENTS.md with a human-maintained rule section and the generated block markers. The section must name the real project command that regenerates the index. Do not instruct agents to manually update the generated block.

Wire the tool into pre-commit and CI. Pre-commit must read the staged snapshot, not the working tree. CI must run on a clean checkout and validate the merge-result repository.
