# Background Gloss Pipeline

`GlossResolver` owns the transient display pipeline for gloss requests:

1. Build the stable gloss cache key from target language, sentence text, token span, prompt/provider/reasoning version, and model.
2. Check the page-scoped in-memory gloss cache first. A hit returns a display item for the current token id without reading lexicon state. This keeps labels stable when the page mutates and the content script immediately rescans during the same service-worker lifetime.
3. On memory miss, read the lexicon state from IndexedDB. `known` and `ignored` stop the pipeline before IndexedDB cache and AI work.
4. For displayable records, check the IndexedDB gloss cache. A hit hydrates the memory cache, returns a display item for the current token id, and records the show event in lexicon state.
5. For remaining misses, call the AI provider, write the result to IndexedDB cache, hydrate memory cache, record the show event in lexicon state, and return the display item.

The in-memory cache is a bounded replay layer for the current page URL and background lifetime. IndexedDB remains the durable source for gloss cache and lexicon state. Marking a word as shown updates only lexicon state; it does not invalidate or mutate the gloss caches.

AI misses also use an in-flight map keyed by the same durable gloss cache key. A duplicate miss attaches to the running lookup, emits its own `pending`, then receives the shared `ready` or `error` result with the current token id. The first lookup owns the AI call and cache write.
