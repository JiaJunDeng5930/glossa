# One-sentence comment protocol

## Problem the protocol solves

The repository needs a code-to-requirement path. A reviewer or AI agent must be able to point at a code unit and answer which behavior, constraint, structural purpose, or test expectation justifies it. The protocol also prevents low-level runtime behavior from living only in implementation habits. Retry limits, error returns, state transitions, persistence writes, event emission, and observability effects are requirements when other code, users, operators, or external systems can rely on them.

The protocol keeps requirements physically close to implementation. The comment next to a module states the module-level requirement. The comment next to a function states the function-level requirement. The comment next to a branch, call, state transition, or assertion states the narrow requirement for that specific code unit. The dotted ID tree carries arbitrary-depth decomposition from broad system areas down to narrow code units.

## Comment shape

A valid requirement comment has exactly one tag, one ID, and one sentence:

```text
@behavior <id> <sentence>
@constraint <id> <sentence>
@intent <id> <sentence>
@verifies <id> <sentence>
```

The sentence must describe the bound code unit directly. It should use concrete subjects such as the module, function, branch, transition, adapter, or test. It should state what the code does or guarantees in the running system.

Good sentences are local:

```text
@behavior db.connection The function creates a database connection pool and returns its handle.
@constraint db.connection.invalid_url The branch returns a configuration error when the database URL is invalid.
@behavior pay.auth.retry.timeout The branch returns a pending authorization when all timeout attempts are exhausted.
@intent pay.auth.gateway The trait defines the active authorization boundary shared by Stripe and Adyen providers.
@verifies pay.auth.retry.timeout The test verifies that exhausted timeout attempts return a pending authorization.
```

Overloaded sentences make the tree useless. When one sentence tries to describe the function, failure handling, configuration, metrics, and side effects together, split it into narrower descendant IDs placed next to the corresponding code units.

## Tag semantics

`@behavior` declares behavior that can be observed or relied on. This includes API returns, state changes, error mapping, retries, fallback, cache behavior, logs, metrics, audit events, data writes, outbound calls, event publication, and other side effects.

`@constraint` declares a property that must remain true. This includes idempotency, authorization boundaries, validation limits, privacy filtering, compatibility boundaries, ordering, concurrency control, persistence invariants, data retention, and resource limits.

`@intent` declares why a structural code unit exists now. Use it for traits, interfaces, abstract classes, adapters, registries, plugin hooks, middleware chains, migration bridges, compatibility layers, factories, provider abstractions, and generic wrappers. The sentence must name the structure and its current concrete purpose. Future possibility alone is not enough for a useful intent sentence.

`@verifies` attaches a test expectation to an existing behavior or constraint ID. It does not create a requirement node. It verifies that a declared behavior or constraint still holds.

## ID tree

IDs are dotted paths. Recommended grammar:

```text
[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*
```

The tree expresses decomposition through any number of levels. If `pay.auth.retry.timeout.exhausted` exists, then `pay`, `pay.auth`, `pay.auth.retry`, and `pay.auth.retry.timeout` must also exist as declared IDs. Each ancestor carries a broader local statement. Each deeper descendant carries a narrower local statement bound closer to the code that implements that detail.

A declared ID is created only by `@behavior`, `@constraint`, or `@intent`. A declared ID must be unique across the scanned root. Many tests may use `@verifies` for the same behavior or constraint.

Use deeper IDs instead of repeating the same ID in several production code locations. If several functions implement one broad behavior, declare the broad ID on the shared module, type, or function, then declare narrower descendant IDs on each specific function, branch, call, or block.

## Binding rules

A tag must bind to one concrete code unit.

A tag before the first import or executable statement binds to the file or module. A tag immediately before a top-level declaration binds to that declaration. A tag immediately before a method binds to that method. A tag immediately before a branch, match arm, loop, try/catch-equivalent block, external call, database write, return, throw, assertion, or snapshot binds to that code unit.

A tag separated from its target by executable code is unbound. Unbound tags are invalid because they cannot explain a concrete code unit.

A file-level or module-level requirement does not automatically justify all inner changes. Inner code that changes error handling, state transitions, external calls, persistence, access control, abstractions, or assertions needs a more specific descendant ID close to the changed code unit.

## Validation properties

The automation must validate these properties: tag syntax is valid, each comment has one sentence, each declared ID is unique, every declared ID has all ancestor declarations, each tag binds to one code unit, `@verifies` references an existing behavior or constraint, leaf behavior and constraint IDs have at least one verification, and the AGENTS.md generated index matches the declared ID tree.

The automation must also classify changed hunks and require a local anchor when the diff changes a contract, side effect, failure policy, state policy, access or safety rule, structural abstraction, or test expectation. Language-specific skills define concrete detectors for these categories.
