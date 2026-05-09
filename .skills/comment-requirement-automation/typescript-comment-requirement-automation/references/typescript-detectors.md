# TypeScript diff detectors

## Contract changes

Require `@behavior` or `@constraint` when a diff changes a public contract. Detect exported functions, classes, interfaces, type aliases, enums, const objects, public class members, overloads, generic parameters, return types, parameter names, optionality, default values, literal unions, discriminated unions, and `as const` objects used as public values.

Also detect route handlers and framework contracts: Next.js route exports such as `GET` and `POST`, Express/Fastify route registrations, NestJS controllers and DTOs, tRPC routers and procedures, GraphQL schemas and resolvers, OpenAPI builders, SDK client methods, package `exports`, CLI commands, environment schemas, config schemas, and React component prop types.

## State policy changes

Require `@behavior` or `@constraint` when a diff changes a state machine. TypeScript state machines commonly appear as `enum`, string-literal union type, discriminated union, object map of statuses, reducer, Zustand or Redux slice, XState machine, or variables and fields named `state`, `status`, `phase`, `mode`, `step`, `kind`, or `lifecycle`.

Detect union member changes, enum variant changes, discriminant key changes, transition table changes, reducer case changes, `switch` changes over state values, assignments to state fields, transition functions such as `advance`, `transitionTo`, `setState`, `mark*`, `complete`, `fail`, `cancel`, `retry`, and event handlers that move between states.

Do not exempt internal state structures automatically. Internal state can still define externally observable behavior through API responses, persisted records, events, logs, or external calls.

## Side-effect changes

Require `@behavior` or `@constraint` when a diff changes durable state, external systems, or observability effects. Detect database writes through Prisma, Drizzle, TypeORM, Sequelize, Knex, Mongo clients, SQL builders, and project repositories. Detect filesystem writes through `fs`, `fs/promises`, streams, and upload handlers. Detect network and SDK calls through `fetch`, Axios, got, GraphQL clients, Stripe, payment SDKs, email clients, storage clients, queue clients, pub/sub clients, LLM clients, and browser APIs that change external state.

Also detect event emits, queue publishes, cache writes, localStorage/sessionStorage writes, cookies, audit events, metrics, tracing, and logging calls when those calls are part of expected observability or compliance behavior. Keep repository-specific client names in a configurable detector table.

## Failure-policy changes

Require `@behavior` or `@constraint` when a diff changes timeout, retry, backoff, fallback, error mapping, propagation, compensation, cleanup, rollback, reconciliation, or degradation behavior.

TypeScript signals include `try/catch/finally`, `.catch`, `.finally`, changed placement of `throw`, `return` inside catch blocks, custom error classes, HTTP error mapping, `AbortController`, timeout options, `Promise.race`, `setTimeout`, retry loops, attempt counters, backoff functions, `p-retry`, `async-retry`, `p-timeout`, fallback values, and changed handling of rejected promises.

## Access and safety changes

Require `@behavior` or `@constraint` when a diff changes authentication, authorization, roles, permissions, tenants, sessions, cookies, JWTs, API keys, capability checks, input validation, schema validation, sanitization, escaping, path normalization, CORS, CSRF, rate limits, quotas, redaction, retention, encryption, secret handling, or browser security boundaries.

Detect common validation and safety libraries such as Zod, Yup, Valibot, io-ts, class-validator, DOMPurify, helmet, rate-limit middleware, auth providers, and project-specific policy modules.

## Structure-intent changes

Require `@intent` when a diff adds or changes structural abstraction: `interface`, `abstract class`, base class, generic provider/store/transport wrapper, adapter, factory, registry, plugin hook, middleware chain, dependency-injection binding, service locator, compatibility layer, migration bridge, or extension point.

The one-sentence `@intent` should name the structure and its current concrete purpose. If the only available sentence says the structure might help future extensibility, the abstraction should fail review even if the mechanical tag exists.

## Test-expectation changes

Require `@verifies` when a diff changes Jest, Vitest, node:test, Mocha, Playwright, Cypress, or Testing Library expectations. Detect `expect`, `assert`, `should`, snapshots, inline snapshots, mock expectations, fake timers, MSW handlers, nock stubs, fixture outputs, golden files, fake server responses, and test-specific error expectations.

The verification sentence should state the scenario and expected result. The tool should validate that the referenced ID is declared by `@behavior` or `@constraint`.
