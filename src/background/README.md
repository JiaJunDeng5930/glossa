# Background Gloss Pipeline

`GlossResolver` owns the transient display pipeline for gloss requests. Content sends scan chunks over `gloss.session`; the resolver accepts each chunk, runs token lookup through a limited parallel gate, and emits token outcomes as soon as each lookup resolves. The background sends `gloss.chunk.ack` after that chunk has completed the lookup phase, so content-side backpressure limits queued resolver work.

1. Build the stable gloss cache key from target language, sentence text, token text, and token span.
2. Check the page-scoped in-memory gloss cache first. A hit returns a display item for the current token id without reading lexicon state. This keeps labels stable when the page mutates and the content script immediately rescans during the same service-worker lifetime.
3. On memory miss, read the IndexedDB gloss cache. A fresh hit hydrates the memory cache, returns a display item for the current token id, and records the show event in lexicon state before `known` or `ignored` lexicon state can hide the token. Cache freshness uses the stored `createdAt` plus `settings.glossCacheTtlMs`; legacy rows without `createdAt` receive the current read time and are written back.
4. When the persistent gloss cache misses or is stale, read the lexicon state from IndexedDB. `known` and `ignored` stop the pipeline before AI work.
5. For remaining misses, emit `pending` and enqueue the owner miss for the AI outlet.

The in-memory cache is a bounded replay layer for the current page URL and background lifetime. IndexedDB remains the durable source for gloss cache and lexicon state. Marking a word as shown updates only lexicon state; it does not invalidate or mutate the gloss caches.

DB reads pass through a short-window coalescer. Individual token lookups ask for lexicon keys and fresh gloss cache keys; the gloss cache store applies `createdAt + settings.glossCacheTtlMs` before returning entries, and the coalescer batches same-store reads into one transaction per 8ms window. Shown-state and cache writes run through the write side after visible outcomes have already been emitted.

AI misses use an in-flight map keyed by the durable gloss cache key plus the live AI settings that select the outlet. A duplicate miss with the same settings attaches to the running lookup, emits its own `pending`, then receives the shared `ready` or `error` result with the current token id. The first lookup owns the AI frame entry and cache write.

The AI outlet frames owner misses by count or time: 32 misses or 50ms closes a frame. Frames are real AI requests and execute through a global serial outlet with concurrency 1. A frame request sends multiple `{ sentence, token }` items and returns per-token `GlossItem` results. Returned token ids consume one unresolved miss at a time, so duplicate DOM token ids in the same frame still resolve independently. A closed sink stops after pending DB reads and before AI enqueue.

Card creation uses the word-click request path. Before card generation, the background checks the word-only carded-word store; a recorded word returns a duplicate-confirmation response to content. Confirmed clicks continue to the AI card payload, which has its own system instruction and returns `{ "cards": [{ "front": "...", "back": "..." }] }`. Each card becomes one Anki note using the configured model's `Front` and `Back` fields, and successful Anki writes record the word in the carded-word store. When the prompt does not ask for a card count, the AI creates one card.

For `glossa-backend`, `/gloss` receives the same frame-shaped payload: `{ items: Array<{ sentence, token }>, targetLang, prompt, reasoningEffort, promptVersion, modelVersion }`. The single-sentence `gloss(...)` adapter remains for legacy callers and tests.

Performance traces use aggregate operations: `service-worker.lookup.chunk`, `service-worker.db.read`, `service-worker.ai.frame`, and `service-worker.scan.done`. These logs report counts, queue depth, and elapsed times for locating DB pressure, lookup backlog, and AI outlet latency.
