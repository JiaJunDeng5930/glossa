# Glossa Engineering Notes

Glossa is a Chrome Manifest V3 extension built with TypeScript, esbuild, native DOM and Shadow DOM. The extension translates unfamiliar English words inline on the page, keeps vocabulary state in storage, and delegates AI and Anki work to the background service worker.

## Module Boundaries

- `src/content/*`: page scanning, DOM range mapping, inline gloss wrappers, and shortcut-based selection mode. Content code sends requests to background and keeps page interaction local.
- `src/background/*`: message orchestration, AI calls, AnkiConnect calls, cache lookup, and vocabulary state persistence. Service worker code persists task state and cache results.
- `src/core/*`: vocabulary state machine, lemma normalization, known-word-list loading, and cache key construction.
- `src/storage/db.ts`: minimal wrapper for `chrome.storage.local` settings and IndexedDB-backed lexicon/cache stores.
- `src/options/*`: settings UI for shortcut, known-word filter, AI endpoint, OpenAI Responses API key, AnkiConnect endpoint, prompts, and connection checks.
- `src/popup/*`: action popup menu. The translate button sends a tab message that activates content translation for the current page.
- `src/shared/shortcut.ts`: shared shortcut capture and matching rules for options and content selection mode.

## State Model

Vocabulary records use one table keyed by `lang:lemma`. `candidate` records become `known` after a displayed gloss. A clicked word becomes `learning_active`, receives an `expiresAt`, and stays eligible for display until expiry. Expired `learning_active` records transition to `known`. `ignored` records stay hidden.

Settings contain `autoTranslateEnabled`, `translateShortcutKey`, `shortcutKey`, `appearance` for inline label colors, opacity, font family, and font size, plus `knownWordList`, `prompts.gloss`, and `prompts.ankiCard`. The extension is fixed to English source text and `zh-CN` gloss output through `GLOSS_TARGET_LANG`. Anki settings contain endpoint, deck, and model name; note creation writes `Front` and `Back`, so options only enables model names whose fields include both. Prompt text, OpenAI provider, and reasoning effort are included in cache versioning so edits create fresh gloss/card cache entries. OpenAI providers are `openai-responses`, `openai-chat-completions`, and `openai-completions`; `glossa-backend` keeps the existing `/gloss` and `/anki-card` contract.

Content translation has a page-local activation flag. It starts from `settings.autoTranslateEnabled`, turns on when the action popup sends `glossa.activateTranslation`, toggles when the page receives `settings.translateShortcutKey`, and resets to the setting value after a route URL change. Toggling off clears queued scans, closes gloss ports, unwraps rendered tokens, and keeps mutation and scroll rescans idle while the page is inactive.

Runtime messages use `src/shared/messages.ts`. Settings and word-click messages use request/response envelopes with `type`, `version`, `requestId`, `source`, `target`, `createdAt`, and `payload`. Gloss lookup uses a `chrome.runtime.connect({ name: "gloss.session" })` port: content sends `gloss.scan.start`, streams `gloss.scan.chunk`, sends `gloss.scan.end`, receives `gloss.chunk.ack` for backpressure, then receives streamed `gloss.token` outcomes with `ready`, `pending`, `hidden`, or `error` before `gloss.done`. Content opens a fresh port for each scan and disconnects all gloss ports on route changes and teardown.

Background gloss resolution is lookup-first and chunked: page memory replay, lexicon state, IndexedDB gloss cache, then framed AI. Memory and cache hits emit `ready` immediately and update shown state. `known` and `ignored` emit `hidden`. AI misses emit `pending`, enter an in-flight map keyed by durable gloss cache key, then owner misses enter an AI frame buffer. Frames close at 32 misses or 50ms and execute through a global serial AI outlet with concurrency 1. Duplicate misses subscribe to the owner in-flight result and receive per-token `ready` or `error`.

IndexedDB reads for lexicon and gloss cache pass through a DB read coalescer. It batches same-store key reads within an 8ms window and exposes aggregate trace events through `service-worker.db.read`. Visible lookup outcomes are emitted before shown-state writes complete.

Content scanning starts from visible, non-editable, non-code text nodes, including open shadow roots and extension-injected frames, and produces DOM-grounded tokens with text-node offsets, source fingerprints, and scan versions. Non-Glossa DOM mutations invalidate the active scan version and schedule a new scan; pending wrappers may still accept stale-session outcomes when their stored surface, lemma, offsets, fingerprint, and local text context still match. `overlay.applyTokenOutcome(token, outcome, scanVersion)` handles current-session updates, and stale pending reconciliation handles slow results after ordinary DOM changes. Glosses render as inline `data-glossa-token` wrappers that keep the source word on the text baseline, reserve text-flow space, place the label above the source word, and align their vertical centerlines. Glossa-owned nodes carry `data-glossa-owned="1"`, `translate="no"`, and `notranslate` so future scans and mutation handling can identify them.

Structured diagnostics use `src/shared/diagnostics.ts`. Trace events include component, operation, result, request id, sender tab/frame/document fields when Chrome provides them, and sanitized URLs. `sanitizeUrl` keeps only origin and path, so query strings and fragments stay out of logs. Performance traces include `content.scan.chunk`, `service-worker.lookup.chunk`, `service-worker.db.read`, `service-worker.ai.frame`, and `service-worker.scan.done`.

Runtime error payloads are diagnostic data: `reason`, `message`, optional `service`, and optional `status`. Background code reports diagnostic facts through message and port payloads. Frontend code maps those diagnostics to user-facing text through `src/shared/userMessages.ts`; inline page UI keeps the `×` badge and exposes the text through title and aria-label.

Known-word filter assets live in `assets/known-wordlists/`. `junior-high` is the unstarred compulsory-education subset and `senior-high` is the full 3000-word appendix from the Ministry of Education high-school English curriculum standard zip. Extra filter presets cover CET-4, CET-6, TOEFL, GRE, and COCA 20000.

The options page follows `DESIGN.md`: `#f5f5f7` canvas, white 28px cards, no shadows, and a single blue Save action. Connection test buttons are text buttons placed directly below Reasoning effort and Anki deck.

## Commands

- `npm run typecheck`: TypeScript contract check.
- `npm run test`: Vitest unit and integration tests.
- `npm run build`: bundle `content.js`, `background.js`, `options.js`, and `popup.js` into `dist/`.
- `npm run test:e2e`: Playwright browser check against the built content bundle.
- `npm run verify`: full local gate.

The pre-commit hook runs typecheck, unit tests, and build. CI runs `npm run verify` with Chromium installed.

For Chrome extension debugability work, run `.skills/chrome-extension-debugability/scripts/audit_chrome_extension_debugability.py .` as a source triage pass and run it on `dist/` after `npm run build` when checking the unpacked extension. The root audit reports `background.js` as unreadable because the service worker is a build artifact; inspect `src/background/index.ts` and `dist/background.js` together.
