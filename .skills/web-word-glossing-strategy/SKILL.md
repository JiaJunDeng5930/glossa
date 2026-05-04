---
name: web-word-glossing-strategy
description: Design, implement, review, or debug Glossa's webpage word detection and inline word glossing behavior in a Chrome Manifest V3 extension. Use when work involves finding user-unknown words on real webpages, filtering visible DOM text, handling dynamic DOM updates, avoiding hidden or excluded content, preserving page layout, inserting inline translations, vocabulary-state transitions, cache behavior, or tests for content-script word annotation.
---

# Web Word Glossing Strategy

## Goal

Build Glossa's inline word glossing as a page-aware content-script pipeline. Detect only text that a user can plausibly read, choose eligible words from that text, insert stable inline glosses, and survive modern dynamic pages without repeated or stale annotations.

## Project Context

Use these Glossa boundaries unless the repository has changed:

- `src/content/*`: DOM scanning, range mapping, Shadow DOM labels, selection mode, and page-local interaction.
- `src/background/*`: AI requests, cache lookup, Anki work, message orchestration, and durable vocabulary persistence.
- `src/core/*`: vocabulary state machine, lemma normalization, known-word-list loading, and cache key construction.
- `src/storage/db.ts`: settings, IndexedDB lexicon/cache stores, and `chrome.storage.local` wrappers.
- `src/shared/messages.ts`: typed runtime message envelopes between content and background.

## Workflow

1. Define the page text surface before selecting words.
   Read `references/dom-visible-text-strategy.md` when touching scanners, observers, range mapping, or visible-text filtering.

2. Define eligibility before requesting glosses.
   Filter by language, token shape, lemma, known-word list, existing vocabulary state, page context, and UI safety. Read `references/word-glossing-strategy.md` when touching candidate selection, inline labels, cache keys, vocabulary transitions, or tests.

3. Keep content-script and background responsibilities separate.
   Let the content script produce DOM-grounded candidates and render page-local UI. Let the background own persistence, AI calls, cache lookup, Anki operations, and user settings.

4. Treat dynamic DOM as a first-class case.
   Observe mutations, resizes, frame/shadow boundaries, and URL changes. Version or fingerprint candidate ranges so async gloss results are discarded when their source DOM has changed.

5. Verify on real page behavior.
   Prefer focused unit tests for tokenization/state/cache plus Playwright extension tests for visible insertion, scrolling, dynamic updates, and duplicate prevention.

## Design Rules

- Start from visible text nodes, then tokenize. Avoid scanning raw `innerHTML` or whole-page `textContent` as the primary source.
- Respect exclusion surfaces: editable fields, code blocks, extension UI, hidden elements, aria-hidden decorative text, no-translate regions, and existing gloss wrappers.
- Use DOM `Range` or explicit text-node offsets for insertion. Store enough source identity to verify the target still matches before rendering.
- Insert annotations with minimal layout impact. Prefer small inline wrappers or Shadow DOM labels that preserve original text and can be removed cleanly.
- Mark extension-owned nodes and skip them in future scans and mutation handling.
- Batch background requests and cache by normalized lemma plus prompt/settings version. Keep request IDs and source ranges for diagnostics.
- Make vocabulary state deterministic: `candidate` can become `known` after display, clicked words can become active learning items, expired learning items can become known, and ignored words stay hidden.
- Keep failures observable. Record sanitized page URL, frame/document identity when available, scan reason, candidate counts, filtered counts, request ID, and render result.

## Review Checklist

Before accepting a change, verify:

- Hidden, offscreen, code, editable, and extension-owned text stays unannotated.
- Dynamic replacement of a paragraph removes or invalidates old candidates.
- Async results never render into a changed text node.
- Re-running the scanner does not duplicate labels.
- Scrolling or revealing content triggers delayed scanning where needed.
- Shadow DOM and same-origin iframes are handled intentionally.
- Long pages do not scan every node eagerly when dynamic mode is sufficient.
- Tests cover both scanner-level behavior and a real browser content-script path.

## Detailed References

- `references/dom-visible-text-strategy.md`: DOM traversal, visible-text filtering, observers, stale result handling, and insertion safeguards adapted for word-level annotation.
- `references/word-glossing-strategy.md`: unknown-word detection, candidate scoring, vocabulary states, inline gloss rendering, caching, diagnostics, and test cases.
