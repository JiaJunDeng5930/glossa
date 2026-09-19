# ADR-0002: Separate dictionary lookup from contextual sense selection

- Status: Accepted
- Date: 2026-09-19

## Context

An ordinary language model generates a gloss, while Jev's Choice primitive selects from supplied candidates. Treating both as interchangeable AI providers would hide the dictionary's responsibility for defining the available meanings and could allow generated text to replace a selected dictionary sense. Readers also need useful results when some words have no dictionary entry and an optional ordinary model is unavailable.

## Decision

Keep dictionary lookup, Jev classification, and ordinary AI generation as separate entities. Bundle a pinned ECDICT dataset for local lookup and retain the meanings of both the encountered word form and its recorded base forms. Jev receives the sentence, the target occurrence, and all candidate meanings; the displayed text comes from the selected dictionary entry.

Allow ordinary-model fallback only after a successful dictionary lookup reports a missing word and the user enables fallback. A dictionary loading failure or a Jev failure is a failed operation, not evidence that a word is absent. Jev mode must work without ordinary-model configuration, including during onboarding.

Settle gloss results per word through the existing shared-job resolver. A failed lookup, classification, or fallback uses the existing inline red cross, without additional translation notifications. Successful neighboring words still settle and cache normally. Cache identity includes the chosen mode, relevant services, and dictionary version, so one mode cannot reuse another mode's results.

## Consequences

The extension gains a local dictionary payload, but dictionary lookup requires no external service or dictionary credential. Keeping it separate from the classification client makes the source of each displayed meaning explicit and lets failures retain their actual cause. Ordinary AI remains responsible for ordinary translation and Anki card generation. The existing subscriber cancellation and stale-result fences continue to own asynchronous publication.
