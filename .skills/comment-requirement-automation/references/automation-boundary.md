# Automation boundary

## Tool capabilities to build

The project-local tool must scan source comments, extract the four tags, validate one-sentence bodies, build an in-memory registry of declared IDs and verification references, bind each tag to a concrete code unit, validate ID grammar and tree properties, generate the AGENTS.md requirement index block, classify changed hunks, run on the staged snapshot for pre-commit, and run on the full checkout for CI.

Do not persist a machine index in the repository. Runtime registries are allowed during one tool invocation. The only generated repository artifact is the AGENTS.md requirement index block.

## Pre-commit checks

Put checks in pre-commit when a single commit must preserve the property. Pre-commit must read staged content, not unstaged working-tree content.

Pre-commit must fail when a tag has invalid syntax, a comment body is missing or contains more than one sentence, an ID violates the dotted-tree grammar, a declaration ID appears more than once, a declared ID is missing any ancestor declaration, `@verifies` references a missing ID or an `@intent` ID, `@verifies` appears outside configured test paths, a tag cannot bind to a concrete code unit, the AGENTS.md generated index differs from the staged source-comment registry, or a changed hunk hits a forced-anchor category and the enclosing code unit lacks the required tag.

Forced-anchor categories are contract changes, side-effect changes, failure-policy changes, state-policy changes, access-and-safety changes, structure-intent changes, and test-expectation changes. Language-specific skills define concrete detectors for these categories.

Structure-intent changes require `@intent`. A behavior or constraint tag cannot justify a new abstraction boundary, adapter, factory, registry, plugin hook, generic wrapper, migration bridge, or extension point.

Test-expectation changes require `@verifies`. Assertions, snapshots, fixtures, mocks, and stubs declare expected behavior and cannot become an untracked requirement system.

Leaf `@behavior` and `@constraint` IDs must have at least one `@verifies` reference. Ancestor nodes can be verified through descendants, but a leaf behavior or constraint without verification leaves a concrete requirement untested.

## CI checks

CI must rerun the same validators on a clean checkout because hooks can be skipped. CI must also check whole-repository and merge-result properties that may not be visible in one local staged snapshot: duplicate IDs introduced by merge, missing ancestor declarations after merge, stale AGENTS.md generated block, invalid verification references, unbound tags across the full repository, and language test execution.

CI must run the language build, typecheck, lint, and test commands required by the repository. `@verifies` links a test expectation to a requirement; it does not prove the test passes.

Do not generate PR reports. CI should output diagnostics that look like compiler errors: path, line, rule name, and a concise reason. The diagnostics should point to the code unit that needs a one-sentence tag or verification link.
