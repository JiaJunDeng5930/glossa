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

Settings contain `autoTranslateEnabled`, `translateShortcutKey`, `shortcutKey`, `appearance` for inline label colors, opacity, font family, and font size, plus `knownWordList`, `prompts.gloss`, and `prompts.ankiCard`. The extension is fixed to English source text and `zh-CN` gloss output through `GLOSS_TARGET_LANG`. Anki settings contain endpoint, deck, and model name; note creation writes `Front` and `Back`, so options only enables model names whose fields include both. Prompt text, OpenAI provider, and reasoning effort are included in cache versioning so edits create fresh gloss/card cache entries. OpenAI providers are `openai-responses`, `openai-chat-completions`, and `openai-completions`; `glossa-backend` uses `/gloss` with frame-shaped `items` for gloss batches and `/anki-card` for card creation.

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

## Requirement Comments

Requirement truth lives in one-sentence source comments. Use only `@behavior`, `@constraint`, `@intent`, and `@verifies`; dotted IDs form an arbitrary-depth tree; details belong in narrower descendant IDs near the code units that implement them. Search source comments for an ID before changing behavior or structure. The generated requirement index is for retrieval and is updated with `npm run req:fmt-agents` after requirement tag changes.

<!-- BEGIN AGENTS_MD_REQUIREMENT_INDEX -->
[Requirement Index]|root:.
|IMPORTANT: Requirement truth lives in source comments; search source comments for an ID before changing code.
|source:source_comments_only
|comment_body:single_sentence
|tags:{@behavior,@constraint,@intent,@verifies}
|glossa|glossa.{background,content,core,options,popup,shared,storage}
|glossa.background|glossa.background.{ai,anki,gloss_resolver,messages,runtime}
|glossa.background.ai|glossa.background.ai.{}
|glossa.background.anki|glossa.background.anki.{}
|glossa.background.gloss_resolver|glossa.background.gloss_resolver.{}
|glossa.background.messages|glossa.background.messages.{}
|glossa.background.runtime|glossa.background.runtime.{}
|glossa.content|glossa.content.{overlay,range,runtime,scanner,selection}
|glossa.content.overlay|glossa.content.overlay.{}
|glossa.content.range|glossa.content.range.{}
|glossa.content.runtime|glossa.content.runtime.{}
|glossa.content.scanner|glossa.content.scanner.{}
|glossa.content.selection|glossa.content.selection.{}
|glossa.core|glossa.core.{cache,lexicon,state}
|glossa.core.cache|glossa.core.cache.{}
|glossa.core.lexicon|glossa.core.lexicon.{}
|glossa.core.state|glossa.core.state.{}
|glossa.options|glossa.options.{}
|glossa.popup|glossa.popup.{}
|glossa.shared|glossa.shared.{diagnostics,errors,hash,messages,shortcut,types,user_messages}
|glossa.shared.diagnostics|glossa.shared.diagnostics.{}
|glossa.shared.errors|glossa.shared.errors.{}
|glossa.shared.hash|glossa.shared.hash.{}
|glossa.shared.messages|glossa.shared.messages.{}
|glossa.shared.shortcut|glossa.shared.shortcut.{}
|glossa.shared.types|glossa.shared.types.{}
|glossa.shared.user_messages|glossa.shared.user_messages.{}
|glossa.storage|glossa.storage.{db}
|glossa.storage.db|glossa.storage.db.{}
|requirements|requirements.{agents,binding,cli,diagnostic,diff,git,location,output,parse,path,registry,snapshot,types,validate}
|requirements.agents|requirements.agents.{check,default,extract,index,parent}
|requirements.agents.check|requirements.agents.check.{}
|requirements.agents.default|requirements.agents.default.{}
|requirements.agents.extract|requirements.agents.extract.{}
|requirements.agents.index|requirements.agents.index.{}
|requirements.agents.parent|requirements.agents.parent.{}
|requirements.binding|requirements.binding.{first_code,kinds,nodes,trivia}
|requirements.binding.first_code|requirements.binding.first_code.{}
|requirements.binding.kinds|requirements.binding.kinds.{}
|requirements.binding.nodes|requirements.binding.nodes.{}
|requirements.binding.trivia|requirements.binding.trivia.{}
|requirements.cli|requirements.cli.{command,help}
|requirements.cli.command|requirements.cli.command.{}
|requirements.cli.help|requirements.cli.help.{}
|requirements.diagnostic|requirements.diagnostic.{}
|requirements.diff|requirements.diff.{anchor,classify,group,parse,rule}
|requirements.diff.anchor|requirements.diff.anchor.{}
|requirements.diff.classify|requirements.diff.classify.{}
|requirements.diff.group|requirements.diff.group.{}
|requirements.diff.parse|requirements.diff.parse.{}
|requirements.diff.rule|requirements.diff.rule.{}
|requirements.git|requirements.git.{}
|requirements.location|requirements.location.{}
|requirements.output|requirements.output.{diagnostics,scan}
|requirements.output.diagnostics|requirements.output.diagnostics.{}
|requirements.output.scan|requirements.output.scan.{}
|requirements.parse|requirements.parse.{comments,normalize,sentence}
|requirements.parse.comments|requirements.parse.comments.{}
|requirements.parse.normalize|requirements.parse.normalize.{}
|requirements.parse.sentence|requirements.parse.sentence.{}
|requirements.path|requirements.path.{}
|requirements.registry|requirements.registry.{}
|requirements.snapshot|requirements.snapshot.{sources,staged,worktree}
|requirements.snapshot.sources|requirements.snapshot.sources.{}
|requirements.snapshot.staged|requirements.snapshot.staged.{}
|requirements.snapshot.worktree|requirements.snapshot.worktree.{}
|requirements.types|requirements.types.{comment,diagnostic,hunk_line,registry,source_file,target}
|requirements.types.comment|requirements.types.comment.{}
|requirements.types.diagnostic|requirements.types.diagnostic.{}
|requirements.types.hunk_line|requirements.types.hunk_line.{}
|requirements.types.registry|requirements.types.registry.{}
|requirements.types.source_file|requirements.types.source_file.{}
|requirements.types.target|requirements.types.target.{}
|requirements.validate|requirements.validate.{ancestors,leaf,tests}
|requirements.validate.ancestors|requirements.validate.ancestors.{}
|requirements.validate.leaf|requirements.validate.leaf.{}
|requirements.validate.tests|requirements.validate.tests.{}
<!-- END AGENTS_MD_REQUIREMENT_INDEX -->
