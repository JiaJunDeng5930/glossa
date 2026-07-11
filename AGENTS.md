# Glossa Engineering Notes

Glossa is a Chrome Manifest V3 extension built with TypeScript, esbuild, native DOM and Shadow DOM. The extension translates unfamiliar English words inline on the page, keeps vocabulary state in storage, and delegates AI and Anki work to the background service worker.

## Module Boundaries

- `src/content/*`: page scanning, DOM range mapping, inline gloss wrappers, and shortcut-based selection mode. Content code sends requests to background and keeps page interaction local.
- `src/background/*`: message orchestration, AI calls, AnkiConnect calls, cache lookup, and vocabulary state persistence. Service worker code persists task state and cache results.
- `src/core/*`: vocabulary state machine, lemma normalization, known-word-list loading, and cache key construction.
- `src/storage/db.ts`: minimal wrapper for `chrome.storage.local` settings and IndexedDB-backed lexicon, cache, and carded-word stores.
- `src/onboarding/*`: first-run extension page opened after a fresh install. Each step teaches one action or setting, then writes completed setup choices through shared settings storage.
- `src/options/*`: settings UI for shortcut, known-word filter, AI endpoint, OpenAI Responses API key, AnkiConnect endpoint, prompts, and connection checks.
- `src/popup/*`: action popup menu. The translate button sends a tab message that activates content translation for the current page.
- `src/shared/shortcut.ts`: shared shortcut capture and matching rules for options and content selection mode.

## State Model

Vocabulary records use one table keyed by `lang:lemma`. `candidate` records become `known` after a displayed gloss. A clicked word becomes `learning_active`, receives an `expiresAt`, and stays eligible for display until expiry. Expired `learning_active` records transition to `known`. `ignored` records stay hidden.

Settings contain `autoTranslateEnabled`, `translateShortcutKey`, `shortcutKey`, `glossCacheTtlMs`, `appearance` for inline label colors, opacity, font family, and font size, plus `knownWordList`, `prompts.gloss`, and `prompts.ankiCard`. The extension is fixed to English source text and `zh-CN` gloss output through `GLOSS_TARGET_LANG`. AI settings include provider, endpoint, reasoning effort, API key, and request timeout. Anki settings contain endpoint, deck, model name, request timeout, and duplicate-card prompt duration; note creation writes `Front` and `Back`, so options only enables model names whose fields include both. Gloss cache identity uses target language, sentence text, token text, token span, and a hash of the active AI generation settings; stored gloss cache entries include `createdAt`, and entries stay fresh for `settings.glossCacheTtlMs`. Card content cache identity uses language, target language, lemma, sentence, and Anki-card prompt version; its model name remains outside cache identity. OpenAI providers are `openai-responses`, `openai-chat-completions`, and `openai-completions`; `glossa-backend` uses `/gloss` with frame-shaped `items` for gloss batches and `/anki-card` for card creation.

Content translation has a frame-local activation flag. It starts from `settings.autoTranslateEnabled`, accepts an explicit state when the action popup broadcasts `glossa.setTranslationState` across the tab, toggles when the frame receives `settings.translateShortcutKey`, and resets to the setting value after a route URL change. The popup reads frame 0 as the tab state before broadcasting. Toggling off clears queued scans, closes gloss ports, unwraps rendered tokens, and keeps mutation and scroll rescans idle while the page is inactive.

Runtime messages use `src/shared/messages.ts`. Settings and word-click messages use request/response envelopes with `type`, `version`, `requestId`, `source`, `target`, `createdAt`, and `payload`. Gloss lookup uses a `chrome.runtime.connect({ name: "gloss.session" })` port: content sends `gloss.scan.start`, streams `gloss.scan.chunk`, sends `gloss.scan.end`, receives `gloss.chunk.ack` for backpressure, then receives streamed `gloss.token` outcomes with `ready`, `pending`, `hidden`, or `error` before `gloss.done`. Content opens a fresh port for each scan and disconnects all gloss ports on route changes and teardown.

Background gloss resolution is lookup-first and chunked: page memory replay, fresh IndexedDB gloss cache, lexicon state, then framed AI. Memory and fresh cache hits emit `ready` immediately and update shown state. Stale or missing persistent cache entries continue to lexicon state, where `known` and `ignored` emit `hidden`. AI misses emit `pending`, enter an in-flight map keyed by durable gloss cache key plus active AI settings, then owner misses enter an AI frame buffer. Frames close at 32 misses or 50ms and execute through a global serial AI outlet with concurrency 1. Duplicate misses subscribe to the owner in-flight result and receive per-token `ready` or `error`.

Card creation keeps a word-only `cardedWords` store keyed by `lang:lemma`. A normal Anki success writes that record after note creation returns at least one note id. When a clicked word already has a carded-word record, background returns `word.card.duplicate`; content shows a top-right confirmation for `settings.anki.duplicatePromptMs`, defaults to no on timeout or cancel, and resends `word.clicked` with `allowDuplicateCard` only after the user confirms.

IndexedDB reads for lexicon and gloss cache pass through a DB read coalescer. It batches same-store key reads within an 8ms window and exposes aggregate trace events through `service-worker.db.read`. Visible lookup outcomes are emitted before shown-state writes complete.

Content scanning starts from viewport-visible, non-editable, non-code text ranges, including open shadow roots and extension-injected frames, and produces DOM-grounded tokens with text-node offsets, source fingerprints, and scan versions. Non-Glossa DOM mutations invalidate the active scan version and schedule a new scan; pending wrappers may still accept stale-session outcomes when their stored surface, lemma, offsets, fingerprint, and local text context still match. Scrolling schedules a viewport scan and leaves rendered wrappers in place when they move outside the viewport. `overlay.applyTokenOutcome(token, outcome, scanVersion)` handles current-session updates, and stale pending reconciliation handles slow results after ordinary DOM changes. Glosses render as inline `data-glossa-token` wrappers that keep the source word on the text baseline, reserve text-flow space, place the label above the source word, and align their vertical centerlines. Glossa-owned nodes carry `data-glossa-owned="1"`, `translate="no"`, and `notranslate` so future scans and mutation handling can identify them.

Structured diagnostics use `src/shared/diagnostics.ts`. Trace events include component, operation, result, request id, sender tab/frame/document fields when Chrome provides them, and sanitized URLs. `sanitizeUrl` keeps only origin and path, so query strings and fragments stay out of logs. Performance traces include `content.scan.chunk`, `service-worker.lookup.chunk`, `service-worker.db.read`, `service-worker.ai.frame`, and `service-worker.scan.done`.

Runtime error payloads are diagnostic data: `reason`, `message`, optional `service`, and optional `status`. Background code reports diagnostic facts through message and port payloads. Frontend code maps those diagnostics to user-facing text through `src/shared/userMessages.ts`; inline page UI keeps the `×` badge and exposes the text through title and aria-label.

Known-word filter assets live in `assets/known-wordlists/`. `junior-high` is the unstarred compulsory-education subset and `senior-high` is the full 3000-word appendix from the Ministry of Education high-school English curriculum standard zip. Extra filter presets cover CET-4, CET-6, TOEFL, GRE, and COCA 20000. The options page opens known lexicon records in a dialog grouped by first letter and lets the user add, remove, or clear those records manually.

Plugin UI follows `DESIGN.md`: warm editorial paper, ink typography, fine rules, vermillion actions, restrained motion, and square document-like surfaces. Connection test buttons stay directly below Reasoning effort and Anki deck.

## Commands

- `npm run typecheck`: TypeScript contract check.
- `npm run test`: Vitest unit and integration tests.
- `npm run build`: bundle `content.js`, `background.js`, `options.js`, and `popup.js` into `dist/`.
- `npm run test:e2e`: Playwright browser check against the built content bundle.
- `npm run verify`: full local gate.
The pre-commit hook runs typecheck, unit tests, and build. CI runs `npm run verify` with Chromium installed.

For Chrome extension debugability work, run `.skills/chrome-extension-debugability/scripts/audit_chrome_extension_debugability.py .` as a source triage pass and run it on `dist/` after `npm run build` when checking the unpacked extension. The root audit reports `background.js` as unreadable because the service worker is a build artifact; inspect `src/background/index.ts` and `dist/background.js` together.
