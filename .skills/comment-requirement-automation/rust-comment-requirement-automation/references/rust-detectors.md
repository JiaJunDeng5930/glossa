# Rust diff detectors

## Contract changes

Require `@behavior` or `@constraint` when a diff changes public or externally consumed Rust contracts: `pub fn`, `pub async fn`, `pub struct`, `pub enum`, `pub trait`, `pub type`, `pub const`, `pub static`, public struct fields, public enum variants, public methods, visibility modifiers, `pub use`, route macros, command macros, RPC handlers, CLI derives, serde attributes, and serialization derives.

Treat `#[serde(rename = ...)]`, `#[serde(tag = ...)]`, `#[repr(...)]`, discriminant values, JSON schema derives, Tauri commands, Axum/Actix/Rocket route macros, tonic service definitions, and clap `Parser`/`Args` changes as contract changes.

## State policy changes

Require `@behavior` or `@constraint` when a diff changes a state machine. In Rust, state machines commonly appear as `enum` or `pub enum` with names or fields containing `state`, `status`, `phase`, `mode`, `lifecycle`, `step`, or `kind`.

Detect enum variant additions, removals, renames, serde rename changes, discriminant changes, `match` expressions over state enums, transition methods such as `transition_to`, `advance`, `mark_*`, `set_state`, `complete`, `fail`, `cancel`, `retry`, or `resume`, and assignments to fields named `state`, `status`, `phase`, `mode`, or `lifecycle`.

Do not exempt private enums automatically. Internal state enums can still define externally observable behavior through returned values, persisted state, emitted events, logs, or external calls.

## Side-effect changes

Require `@behavior` or `@constraint` when a diff changes durable state, external systems, or observability effects. Detect database writes through `sqlx`, Diesel, SeaORM, migrations, and project-specific repositories. Detect filesystem writes through `std::fs`, `tokio::fs`, `File::create`, `OpenOptions`, remove, rename, and permission-changing calls. Detect network and SDK calls through `reqwest`, `hyper`, `tonic`, websockets, platform SDKs, payment SDKs, email clients, storage clients, LLM clients, and ASR clients.

Also detect queue publishes, event emits, channel sends across task boundaries, Redis/cache writes, audit events, metrics, tracing/logging calls when those calls are part of expected observability or compliance behavior. Keep repository-specific crate and method names in a configurable detector table.

## Failure-policy changes

Require `@behavior` or `@constraint` when a diff changes timeout, retry, backoff, fallback, error mapping, propagation, compensation, cleanup, rollback, reconciliation, or degradation behavior.

Rust signals include `tokio::time::timeout`, sleeps, intervals, deadlines, retry loops, attempt counters, max attempts, jitter, retry crates, `map_err`, `anyhow::Context`, `thiserror` enum changes, API error conversions, `match Err`, `if let Err`, changed placement of `?`, production `unwrap`, `expect`, `panic!`, `bail!`, and `ensure!`.

## Access and safety changes

Require `@behavior` or `@constraint` when a diff changes authentication, authorization, roles, permissions, capabilities, tenants, sessions, tokens, API keys, validation, sanitization, canonicalization, escaping, path traversal checks, input size limits, rate limits, quotas, redaction, retention, encryption, key handling, secret handling, unsafe blocks, or FFI boundary behavior.

Changes to `unsafe` blocks normally require `@constraint` because the code protects memory, aliasing, lifetime, or external ABI invariants.

## Structure-intent changes

Require `@intent` when a diff adds or changes structural abstraction: `trait`, `dyn Trait`, `Box<dyn Trait>`, `Arc<dyn Trait>`, generic provider/store/transport wrappers, factory functions, builders, registries, plugin hooks, middleware chains, dependency-injection containers, adapter layers, migration bridges, compatibility layers, and service locators.

The one-sentence `@intent` should name the structure and its current concrete purpose. If the only available sentence says the structure might help future extensibility, the abstraction should fail review even if the mechanical tag exists.

## Test-expectation changes

Require `@verifies` when a diff changes `assert!`, `assert_eq!`, `assert_ne!`, `matches!`, `insta` snapshots, golden fixtures, rstest cases, mock expectations, wiremock stubs, fake server responses, fixture outputs, or test-specific error expectations.

The verification sentence should state the scenario and expected result. The tool should validate that the referenced ID is declared by `@behavior` or `@constraint`.
