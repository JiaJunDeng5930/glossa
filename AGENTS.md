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

Settings contain `autoTranslateEnabled`, `translateShortcutKey`, `shortcutKey`, `appearance` for inline label colors, opacity, font family, and font size, plus `knownWordList`, `prompts.gloss`, and `prompts.ankiCard`. The extension is fixed to English source text and `zh-CN` gloss output through `GLOSS_TARGET_LANG`. Prompt text, OpenAI provider, and reasoning effort are included in cache versioning so edits create fresh gloss/card cache entries. OpenAI providers are `openai-responses`, `openai-chat-completions`, and `openai-completions`; `glossa-backend` keeps the existing `/gloss` and `/anki-card` contract.

Content translation has a page-local activation flag. It starts from `settings.autoTranslateEnabled`, turns on when the action popup sends `glossa.activateTranslation` or the page receives `settings.translateShortcutKey`, and resets to the setting value after a route URL change. Mutation and scroll rescans only request glosses while the page is active.

Runtime messages use `src/shared/messages.ts`. Settings and word-click messages use request/response envelopes with `type`, `version`, `requestId`, `source`, `target`, `createdAt`, and `payload`. Gloss lookup uses a `chrome.runtime.connect({ name: "gloss.session" })` port: content sends `gloss.scan`, background streams `gloss.token` outcomes with `ready`, `pending`, `hidden`, or `error`, then sends `gloss.done`. Content opens a fresh port for each scan and disconnects the previous scan on route changes, mutations, and teardown.

Background gloss resolution is lookup-first: page memory replay, lexicon state, IndexedDB gloss cache, then sentence-batched AI. Memory and cache hits emit `ready` immediately and update shown state. `known` and `ignored` emit `hidden`. AI misses emit `pending`, then the AI batch writes gloss cache, page memory, lexicon shown state, and emits per-token `ready`.

Content scanning starts from visible, non-editable, non-code text nodes, including open shadow roots and extension-injected frames, and produces DOM-grounded tokens with text-node offsets, source fingerprints, and scan versions. Non-Glossa DOM mutations invalidate the active gloss session immediately; render code rechecks scan version, source text, fingerprint, and range rects before placing labels. `overlay.applyTokenOutcome(token, outcome, scanVersion)` is the single DOM update path for `ready`, `pending`, `hidden`, and `error`. Glosses render as inline `data-glossa-token` wrappers that keep the source word on the text baseline, reserve text-flow space, place the label above the source word, and align their vertical centerlines. Glossa-owned nodes carry `data-glossa-owned="1"`, `translate="no"`, and `notranslate` so future scans and mutation handling can identify them.

Structured diagnostics use `src/shared/diagnostics.ts`. Trace events include component, operation, result, request id, sender tab/frame/document fields when Chrome provides them, and sanitized URLs. `sanitizeUrl` keeps only origin and path, so query strings and fragments stay out of logs.

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
