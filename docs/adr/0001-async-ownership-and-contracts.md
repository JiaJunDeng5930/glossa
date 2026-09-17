# ADR-0001: Keep asynchronous ownership at domain boundaries

- Status: Accepted
- Date: 2026-09-17

## Context

Glossa combines page-local DOM work, streamed gloss requests, cached AI generation, settings forms, vocabulary transactions, and Anki side effects. These operations can finish in a different order from the input that started them. A single generic coordinator would blur which identity may commit a result and would make stale UI or external side effects easy to reintroduce.

## Decision

Keep one owner for each mutable fact and keep the identities that cross the boundaries separate.

- A content occurrence identifies a source location and its request snapshot. An AI `requestItemId` identifies one item in one dispatched frame. Frame allocation and response lookup use the latter, so equal page token IDs cannot select the wrong job.
- A shared gloss job owns generation/cache identity and result settlement. Each session subscribes with its own occurrence and emission/write behavior. The first subscriber has no special lifetime authority; closing one session removes only its subscription.
- Settings pages submit typed patches for dirty fields. The worker reads the latest saved settings, validates the patch, and commits it. This preserves disjoint edits and prevents a stale full-form snapshot from changing fields the user did not edit.
- One click produces one Anki card. `cardedWords` is the single durable word-level card-history fact. Vocabulary learning state remains separate, and an external note ID is returned to the caller without becoming a second local history model. An uncertain Anki side effect is reported as outcome-unknown and is not retried automatically.
- Connection tests, Anki catalog reads, and vocabulary views expose operation state owned by the initiating UI control. Their request identity and navigation/save locks are independent, so a late completion cannot overwrite newer input or unlock unrelated work.
- Shared types and boundary validators are the first line of the contract. Tests prove temporal and side-effect behavior; documentation records the reasons and trade-offs rather than copying the implementation.

## Consequences

The source has a few small, explicit coordination boundaries instead of one general-purpose async framework. Cache and generation invalidation must fence old completions, and every caller must carry the identity needed by its owner. In return, page feedback, storage transactions, settings saves, and external card creation can be reasoned about independently and tested at their real boundaries.

The ownership rationale is summarized in `docs/async-state-model.md`; current behavior remains defined by the implementation, types, and tests.
