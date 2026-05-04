# Glossa Engineering Notes

Glossa is a Chrome Manifest V3 extension built with TypeScript, esbuild, native DOM and Shadow DOM. The extension translates unfamiliar English words inline on the page, keeps vocabulary state in storage, and delegates AI and Anki work to the background service worker.

## Module Boundaries

- `src/content/*`: page scanning, DOM range mapping, Shadow DOM labels, and shortcut-based selection mode. Content code sends requests to background and keeps page interaction local.
- `src/background/*`: message orchestration, AI calls, AnkiConnect calls, cache lookup, and vocabulary state persistence. Service worker code persists task state and cache results.
- `src/core/*`: vocabulary state machine, lemma normalization, known-word-list loading, and cache key construction.
- `src/storage/db.ts`: minimal wrapper for `chrome.storage.local` settings and IndexedDB-backed lexicon/cache stores.
- `src/options/*`: settings UI for shortcut, known-word filter, AI endpoint, OpenAI Responses API key, AnkiConnect endpoint, prompts, and connection checks.
- `src/shared/shortcut.ts`: shared shortcut capture and matching rules for options and content selection mode.

## State Model

Vocabulary records use one table keyed by `lang:lemma`. `candidate` records become `known` after a displayed gloss. A clicked word becomes `learning_active`, receives an `expiresAt`, and stays eligible for display until expiry. Expired `learning_active` records transition to `known`. `ignored` records stay hidden.

Settings contain `appearance` for inline label colors, opacity, font family, and font size, plus `knownWordList`, `prompts.gloss`, and `prompts.ankiCard`. The extension is fixed to English source text and `zh-CN` gloss output through `GLOSS_TARGET_LANG`. Prompt text, OpenAI provider, and reasoning effort are included in cache versioning so edits create fresh gloss/card cache entries. OpenAI providers are `openai-responses`, `openai-chat-completions`, and `openai-completions`; `glossa-backend` keeps the existing `/gloss` and `/anki-card` contract.

Known-word filter assets live in `assets/known-wordlists/`. `junior-high` is the unstarred compulsory-education subset and `senior-high` is the full 3000-word appendix from the Ministry of Education high-school English curriculum standard zip.

The options page follows `DESIGN.md`: `#f5f5f7` canvas, white 28px cards, no shadows, and a single blue Save action. Connection test buttons are text buttons placed directly below Reasoning effort and Anki deck.

## Commands

- `npm run typecheck`: TypeScript contract check.
- `npm run test`: Vitest unit and integration tests.
- `npm run build`: bundle `content.js`, `background.js`, and `options.js` into `dist/`.
- `npm run test:e2e`: Playwright browser check against the built content bundle.
- `npm run verify`: full local gate.

The pre-commit hook runs typecheck, unit tests, and build. CI runs `npm run verify` with Chromium installed.
