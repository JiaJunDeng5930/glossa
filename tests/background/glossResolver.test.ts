import { describe, expect, it, vi } from "vitest";

import { buildGlossCacheKey, glossGenerationIdentity } from "../../src/core/cache";
import { createGlossResolver } from "../../src/background/glossResolver";
import type { ExtensionStorage } from "../../src/storage/db";
import { DEFAULT_SETTINGS, GLOSS_TARGET_LANG, type AnkiCardOutput, type CardedWordRecord, type GlossaSettings, type GlossCacheEntry, type GlossTokenPayload, type SentenceCandidate, type TokenCandidate, type VocabularyRecord, type VocabularyState } from "../../src/shared/types";

describe("gloss resolver lookup-first pipeline", () => {
  it("emits hidden, ready, pending and AI ready outcomes in lookup order", async () => {
    const storage = createMemoryStorage();
    const settings = testSettings();
    await storage.settings.set(settings);
    await storage.lexicon.put(record("known", "known"));
    await storage.lexicon.put(record("ignored", "ignored"));
    await storage.lexicon.put(record("cached", "learning_active"));
    await storage.glossCache.put(await cacheKey("Known ignored cached novel words.", "cached", 14, 20), {
      tokenId: "old-cached",
      targetText: "cached",
      display: "缓存",
      createdAt: 50
    });
    const ai = {
      glossFrame: vi.fn(async () => ({
        items: [{ tokenId: "t-novel", targetText: "novel", display: "新词" }]
      })),
      ankiCard: vi.fn()
    };
    const resolver = createGlossResolver({ storage, ai });
    const events: Array<Omit<GlossTokenPayload, "scanId">> = [];

    await resolveScan(resolver, "https://example.test/page", [{
      id: "s1",
      text: "Known ignored cached novel words.",
      tokens: [
        { id: "t-known", sentenceId: "s1", surface: "Known", lemma: "known", startOffset: 0, endOffset: 5 },
        { id: "t-ignored", sentenceId: "s1", surface: "ignored", lemma: "ignored", startOffset: 6, endOffset: 13 },
        { id: "t-cached", sentenceId: "s1", surface: "cached", lemma: "cached", startOffset: 14, endOffset: 20 },
        { id: "t-novel", sentenceId: "s1", surface: "novel", lemma: "novel", startOffset: 21, endOffset: 26 }
      ]
    }], settings, 100, { emit: (event) => events.push(event) });

    expect(events).toEqual(expect.arrayContaining([
      { tokenId: "t-known", status: "hidden" },
      { tokenId: "t-ignored", status: "hidden" },
      { tokenId: "t-cached", status: "ready", item: { tokenId: "t-cached", targetText: "cached", display: "缓存" } },
      { tokenId: "t-novel", status: "pending" },
      { tokenId: "t-novel", status: "ready", item: { tokenId: "t-novel", targetText: "novel", display: "新词" } }
    ]));
    expect(events).toHaveLength(5);
    expect(ai.glossFrame).toHaveBeenCalledWith(expect.objectContaining({
      items: [expect.objectContaining({
        sentence: "Known ignored cached novel words.",
        token: expect.objectContaining({ id: "t-novel" })
      })]
    }));
    expect(await storage.lexicon.get("en:cached")).toMatchObject({ shownCount: 1, lastShownAt: 100 });
    expect(await storage.lexicon.get("en:novel")).toMatchObject({ state: "known", shownCount: 1 });
    expect(await storage.glossCache.get(await cacheKey("Known ignored cached novel words.", "novel", 21, 26))).toMatchObject({ createdAt: 100 });
  });

  it("uses fresh persisted gloss cache before known and ignored lexicon state and ignores expired cache entries", async () => {
    const storage = createMemoryStorage();
    const settings = { ...testSettings(), glossCacheTtlMs: 100 };
    await storage.settings.set(settings);
    await storage.lexicon.put(record("fresh", "known"));
    await storage.lexicon.put(record("ignored", "ignored"));
    await storage.lexicon.put(record("stale", "known"));
    await storage.glossCache.put(await cacheKey("Fresh ignored stale words.", "fresh", 0, 5), {
      tokenId: "old-fresh",
      targetText: "fresh",
      display: "新鲜",
      createdAt: 150
    });
    await storage.glossCache.put(await cacheKey("Fresh ignored stale words.", "ignored", 6, 13), {
      tokenId: "old-ignored",
      targetText: "ignored",
      display: "忽略缓存",
      createdAt: 150
    });
    await storage.glossCache.put(await cacheKey("Fresh ignored stale words.", "stale", 14, 19), {
      tokenId: "old-stale",
      targetText: "stale",
      display: "过期",
      createdAt: 50
    });
    const ai = { glossFrame: vi.fn(), ankiCard: vi.fn() };
    const resolver = createGlossResolver({ storage, ai });
    const events: Array<Omit<GlossTokenPayload, "scanId">> = [];

    await resolveScan(resolver, "https://example.test/page", [{
      id: "s1",
      text: "Fresh ignored stale words.",
      tokens: [
        { id: "t-fresh", sentenceId: "s1", surface: "Fresh", lemma: "fresh", startOffset: 0, endOffset: 5 },
        { id: "t-ignored", sentenceId: "s1", surface: "ignored", lemma: "ignored", startOffset: 6, endOffset: 13 },
        { id: "t-stale", sentenceId: "s1", surface: "stale", lemma: "stale", startOffset: 14, endOffset: 19 }
      ]
    }], settings, 200, { emit: (event) => events.push(event) });

    expect(events).toHaveLength(3);
    expect(events).toEqual(expect.arrayContaining([
      { tokenId: "t-fresh", status: "ready", item: { tokenId: "t-fresh", targetText: "Fresh", display: "新鲜" } },
      { tokenId: "t-ignored", status: "ready", item: { tokenId: "t-ignored", targetText: "ignored", display: "忽略缓存" } },
      { tokenId: "t-stale", status: "hidden" }
    ]));
    expect(ai.glossFrame).not.toHaveBeenCalled();
  });

  it("treats legacy persisted gloss cache entries without createdAt as expired", async () => {
    const storage = createMemoryStorage();
    const settings = { ...testSettings(), glossCacheTtlMs: 100 };
    await storage.settings.set(settings);
    await storage.lexicon.put(record("legacy", "known"));
    const key = await cacheKey("Legacy cache words.", "Legacy", 0, 6);
    await storage.glossCache.put(key, {
      tokenId: "old-legacy",
      targetText: "legacy",
      display: "旧缓存"
    } as GlossCacheEntry);
    const ai = { glossFrame: vi.fn(), ankiCard: vi.fn() };
    const resolver = createGlossResolver({ storage, ai });
    const events: Array<Omit<GlossTokenPayload, "scanId">> = [];

    await resolveScan(resolver, "https://example.test/page", [{
      id: "s1",
      text: "Legacy cache words.",
      tokens: [
        { id: "t-legacy", sentenceId: "s1", surface: "Legacy", lemma: "legacy", startOffset: 0, endOffset: 6 }
      ]
    }], settings, 200, { emit: (event) => events.push(event) });

    expect(events).toEqual([
      { tokenId: "t-legacy", status: "hidden" }
    ]);
    expect(await storage.glossCache.get(key)).not.toHaveProperty("createdAt");
    expect(ai.glossFrame).not.toHaveBeenCalled();
  });

  it("replays page memory and fresh cache before shown state hides rescan tokens", async () => {
    const storage = createMemoryStorage();
    const settings = testSettings();
    await storage.settings.set(settings);
    const ai = {
      glossFrame: vi.fn(async () => ({
        items: [{ tokenId: "t-first", targetText: "novel", display: "新词" }]
      })),
      ankiCard: vi.fn()
    };
    const resolver = createGlossResolver({ storage, ai });
    const sentence = "A novel archive appears.";
    const firstEvents: Array<Omit<GlossTokenPayload, "scanId">> = [];
    const secondEvents: Array<Omit<GlossTokenPayload, "scanId">> = [];
    const otherPageEvents: Array<Omit<GlossTokenPayload, "scanId">> = [];

    await resolveScan(resolver, "https://example.test/a", [{
      id: "s1",
      text: sentence,
      tokens: [{ id: "t-first", sentenceId: "s1", surface: "novel", lemma: "novel", startOffset: 2, endOffset: 7 }]
    }], settings, 100, { emit: (event) => firstEvents.push(event) });
    await resolveScan(resolver, "https://example.test/a", [{
      id: "s2",
      text: sentence,
      tokens: [{ id: "t-second", sentenceId: "s2", surface: "novel", lemma: "novel", startOffset: 2, endOffset: 7 }]
    }], settings, 200, { emit: (event) => secondEvents.push(event) });
    await resolveScan(resolver, "https://example.test/b", [{
      id: "s3",
      text: sentence,
      tokens: [{ id: "t-third", sentenceId: "s3", surface: "novel", lemma: "novel", startOffset: 2, endOffset: 7 }]
    }], settings, 300, { emit: (event) => otherPageEvents.push(event) });

    expect(firstEvents.map((event) => event.status)).toEqual(["pending", "ready"]);
    expect(secondEvents).toEqual([
      { tokenId: "t-second", status: "ready", item: { tokenId: "t-second", targetText: "novel", display: "新词" } }
    ]);
    expect(otherPageEvents).toEqual([
      { tokenId: "t-third", status: "ready", item: { tokenId: "t-third", targetText: "novel", display: "新词" } }
    ]);
    expect(ai.glossFrame).toHaveBeenCalledTimes(1);
  });

  it("stops replaying page memory after the resolver cache is cleared", async () => {
    const storage = createMemoryStorage();
    const settings = testSettings();
    await storage.settings.set(settings);
    const ai = {
      glossFrame: vi.fn(async () => ({
        items: [{ tokenId: "t-first", targetText: "novel", display: "新词" }]
      })),
      ankiCard: vi.fn()
    };
    const resolver = createGlossResolver({ storage, ai });
    const sentence = "A novel archive appears.";
    const secondEvents: Array<Omit<GlossTokenPayload, "scanId">> = [];

    await resolveScan(resolver, "https://example.test/a", [{
      id: "s1",
      text: sentence,
      tokens: [{ id: "t-first", sentenceId: "s1", surface: "novel", lemma: "novel", startOffset: 2, endOffset: 7 }]
    }], settings, 100, { emit: () => undefined });
    await storage.glossCache.clear();
    resolver.clearMemory();
    await resolveScan(resolver, "https://example.test/a", [{
      id: "s2",
      text: sentence,
      tokens: [{ id: "t-second", sentenceId: "s2", surface: "novel", lemma: "novel", startOffset: 2, endOffset: 7 }]
    }], settings, 200, { emit: (event) => secondEvents.push(event) });

    expect(secondEvents).toEqual([{ tokenId: "t-second", status: "hidden" }]);
    expect(ai.glossFrame).toHaveBeenCalledTimes(1);
  });

  it("refreshes a rendered known token while continuing to hide ignored tokens", async () => {
    const storage = createMemoryStorage();
    const settings = testSettings();
    await storage.settings.set(settings);
    await storage.lexicon.put(record("novel", "known"));
    await storage.lexicon.put(record("ignored", "ignored"));
    const ai = {
      glossFrame: vi.fn(async (_input: { items: Array<{ token: TokenCandidate }> }) => ({
        items: [{ tokenId: "t-novel", targetText: "novel", display: "新版" }]
      })),
      ankiCard: vi.fn()
    };
    const resolver = createGlossResolver({ storage, ai, aiFrameMaxMs: 1, dbReadCoalesceMs: 0 });
    const events: Array<Omit<GlossTokenPayload, "scanId">> = [];

    await resolveScan(resolver, "https://example.test/page", [{
      id: "s1",
      text: "A novel ignored archive appears.",
      tokens: [
        { id: "t-novel", sentenceId: "s1", surface: "novel", lemma: "novel", startOffset: 2, endOffset: 7, forceRefresh: true },
        { id: "t-ignored", sentenceId: "s1", surface: "ignored", lemma: "ignored", startOffset: 8, endOffset: 15, forceRefresh: true }
      ]
    }], settings, 200, { emit: (event) => events.push(event) });

    expect(events).toEqual(expect.arrayContaining([
      { tokenId: "t-novel", status: "pending" },
      { tokenId: "t-novel", status: "ready", item: { tokenId: "t-novel", targetText: "novel", display: "新版" } },
      { tokenId: "t-ignored", status: "hidden" }
    ]));
    expect(ai.glossFrame).toHaveBeenCalledWith(expect.objectContaining({
      items: [expect.objectContaining({ token: expect.objectContaining({ id: "t-novel" }) })]
    }));
    expect(ai.glossFrame.mock.calls[0]?.[0].items[0]?.token).not.toHaveProperty("forceRefresh");
  });

  it("keeps page memory replay independent from persistent gloss cache TTL", async () => {
    const storage = createMemoryStorage();
    const settings = { ...testSettings(), glossCacheTtlMs: 50 };
    await storage.settings.set(settings);
    const ai = {
      glossFrame: vi.fn(async () => ({
        items: [{ tokenId: "t-first", targetText: "novel", display: "新词" }]
      })),
      ankiCard: vi.fn()
    };
    const resolver = createGlossResolver({ storage, ai });
    const sentence = "A novel archive appears.";
    const firstEvents: Array<Omit<GlossTokenPayload, "scanId">> = [];
    const samePageEvents: Array<Omit<GlossTokenPayload, "scanId">> = [];
    const otherPageEvents: Array<Omit<GlossTokenPayload, "scanId">> = [];

    await resolveScan(resolver, "https://example.test/a", [{
      id: "s1",
      text: sentence,
      tokens: [{ id: "t-first", sentenceId: "s1", surface: "novel", lemma: "novel", startOffset: 2, endOffset: 7 }]
    }], settings, 100, { emit: (event) => firstEvents.push(event) });
    await resolveScan(resolver, "https://example.test/a", [{
      id: "s2",
      text: sentence,
      tokens: [{ id: "t-second", sentenceId: "s2", surface: "novel", lemma: "novel", startOffset: 2, endOffset: 7 }]
    }], settings, 200, { emit: (event) => samePageEvents.push(event) });
    await resolveScan(resolver, "https://example.test/b", [{
      id: "s3",
      text: sentence,
      tokens: [{ id: "t-third", sentenceId: "s3", surface: "novel", lemma: "novel", startOffset: 2, endOffset: 7 }]
    }], settings, 200, { emit: (event) => otherPageEvents.push(event) });

    expect(firstEvents.map((event) => event.status)).toEqual(["pending", "ready"]);
    expect(samePageEvents).toEqual([
      { tokenId: "t-second", status: "ready", item: { tokenId: "t-second", targetText: "novel", display: "新词" } }
    ]);
    expect(otherPageEvents).toEqual([{ tokenId: "t-third", status: "hidden" }]);
    expect(ai.glossFrame).toHaveBeenCalledTimes(1);
  });

  it("groups cache misses into a size-triggered AI frame", async () => {
    const storage = createMemoryStorage();
    const settings = testSettings();
    await storage.settings.set(settings);
    const ai = {
      glossFrame: vi.fn(async (input: { items: Array<{ sentence: string; token: { id: string; surface: string } }> }) => ({
        items: input.items.map((item) => ({
          tokenId: item.token.id,
          targetText: item.token.surface,
          display: item.token.surface === "novel" ? "新词" : "晦涩"
        }))
      })),
      ankiCard: vi.fn()
    };
    const resolver = createGlossResolver({
      storage,
      ai,
      aiFrameMaxItems: 2,
      aiFrameMaxMs: 1_000,
      dbReadCoalesceMs: 0
    });
    const events: Array<Omit<GlossTokenPayload, "scanId">> = [];

    await resolveScan(resolver, "https://example.test/page", [{
      id: "s1",
      text: "A novel obscure archive appears.",
      tokens: [
        { id: "t-novel", sentenceId: "s1", surface: "novel", lemma: "novel", startOffset: 2, endOffset: 7 },
        { id: "t-obscure", sentenceId: "s1", surface: "obscure", lemma: "obscure", startOffset: 8, endOffset: 15 }
      ]
    }], settings, 100, { emit: (event) => events.push(event) });

    expect(ai.glossFrame).toHaveBeenCalledTimes(1);
    expect(ai.glossFrame).toHaveBeenCalledWith(expect.objectContaining({
      items: expect.arrayContaining([
        expect.objectContaining({ token: expect.objectContaining({ id: "t-novel" }) }),
        expect.objectContaining({ token: expect.objectContaining({ id: "t-obscure" }) })
      ])
    }));
    expect(events).toEqual(expect.arrayContaining([
      { tokenId: "t-novel", status: "pending" },
      { tokenId: "t-obscure", status: "pending" },
      { tokenId: "t-novel", status: "ready", item: { tokenId: "t-novel", targetText: "novel", display: "新词" } },
      { tokenId: "t-obscure", status: "ready", item: { tokenId: "t-obscure", targetText: "obscure", display: "晦涩" } }
    ]));
  });

  it("splits AI frames by API key during concurrent scans", async () => {
    const storage = createMemoryStorage();
    const oldKeySettings: GlossaSettings = {
      ...testSettings(),
      ai: {
        ...DEFAULT_SETTINGS.ai,
        provider: "openai-responses",
        endpoint: "https://api.openai.com/v1/responses",
        reasoningEffort: "medium",
        apiKey: "old-key"
      }
    };
    const newKeySettings: GlossaSettings = {
      ...oldKeySettings,
      ai: {
        ...oldKeySettings.ai,
        apiKey: "new-key"
      }
    };
    await storage.settings.set(newKeySettings);
    const ai = {
      glossFrame: vi.fn(async (input: { settings: GlossaSettings; items: Array<{ token: { id: string; surface: string } }> }) => ({
        items: input.items.map((item) => ({
          tokenId: item.token.id,
          targetText: item.token.surface,
          display: input.settings.ai.apiKey === "old-key" ? "旧钥" : "新钥"
        }))
      })),
      ankiCard: vi.fn()
    };
    const resolver = createGlossResolver({
      storage,
      ai,
      aiFrameMaxItems: 2,
      aiFrameMaxMs: 50,
      dbReadCoalesceMs: 0
    });
    const oldKeyEvents: Array<Omit<GlossTokenPayload, "scanId">> = [];
    const newKeyEvents: Array<Omit<GlossTokenPayload, "scanId">> = [];

    await Promise.all([
      resolveScan(resolver, "https://example.test/old", [{
        id: "s-old",
        text: "A novel archive appears.",
        tokens: [{ id: "t-old", sentenceId: "s-old", surface: "novel", lemma: "novel", startOffset: 2, endOffset: 7 }]
      }], oldKeySettings, 100, { emit: (event) => oldKeyEvents.push(event) }),
      resolveScan(resolver, "https://example.test/new", [{
        id: "s-new",
        text: "An obscure archive appears.",
        tokens: [{ id: "t-new", sentenceId: "s-new", surface: "obscure", lemma: "obscure", startOffset: 3, endOffset: 10 }]
      }], newKeySettings, 100, { emit: (event) => newKeyEvents.push(event) })
    ]);

    expect(ai.glossFrame).toHaveBeenCalledTimes(2);
    expect(ai.glossFrame.mock.calls.map(([input]) => input.settings.ai.apiKey)).toEqual(expect.arrayContaining(["old-key", "new-key"]));
    expect(oldKeyEvents).toEqual([
      { tokenId: "t-old", status: "pending" },
      { tokenId: "t-old", status: "ready", item: { tokenId: "t-old", targetText: "novel", display: "旧钥" } }
    ]);
    expect(newKeyEvents).toEqual([
      { tokenId: "t-new", status: "pending" },
      { tokenId: "t-new", status: "ready", item: { tokenId: "t-new", targetText: "obscure", display: "新钥" } }
    ]);
  });

  it("cancels obsolete AI frames before starting a new generation era", async () => {
    const storage = createMemoryStorage();
    const oldSettings = { ...testSettings(), modelVersion: "old-model" };
    const newSettings = { ...testSettings(), modelVersion: "new-model" };
    const ai = {
      glossFrame: vi.fn((input: { settings: GlossaSettings; items: Array<{ token: { id: string; surface: string } }>; signal?: AbortSignal }) => {
        if (input.settings.modelVersion === "old-model") {
          return new Promise<{ items: Array<{ tokenId: string; targetText: string; display: string }> }>((_resolve, reject) => {
            input.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
          });
        }
        return Promise.resolve({
          items: input.items.map((item) => ({ tokenId: item.token.id, targetText: item.token.surface, display: "新版" }))
        });
      }),
      ankiCard: vi.fn()
    };
    const resolver = createGlossResolver({ storage, ai, aiFrameMaxMs: 1, dbReadCoalesceMs: 0 });
    const oldEvents: Array<Omit<GlossTokenPayload, "scanId">> = [];
    const newEvents: Array<Omit<GlossTokenPayload, "scanId">> = [];
    await resolver.activateGeneration(glossGenerationIdentity(oldSettings));

    const oldScan = resolveScan(resolver, "https://example.test/page", [{
      id: "s-old",
      text: "A novel archive appears.",
      tokens: [{ id: "t-old", sentenceId: "s-old", surface: "novel", lemma: "novel", startOffset: 2, endOffset: 7 }]
    }], oldSettings, 100, { emit: (event) => oldEvents.push(event) });
    await vi.waitFor(() => expect(ai.glossFrame).toHaveBeenCalledTimes(1));

    await resolver.activateGeneration(glossGenerationIdentity(newSettings));
    const newScan = resolveScan(resolver, "https://example.test/page", [{
      id: "s-new",
      text: "An obscure archive appears.",
      tokens: [{ id: "t-new", sentenceId: "s-new", surface: "obscure", lemma: "obscure", startOffset: 3, endOffset: 10 }]
    }], newSettings, 200, { emit: (event) => newEvents.push(event) });
    await Promise.all([oldScan, newScan]);

    expect(ai.glossFrame.mock.calls.map(([input]) => input.settings.modelVersion)).toEqual(["old-model", "new-model"]);
    expect(oldEvents).toEqual([{ tokenId: "t-old", status: "pending" }]);
    expect(newEvents).toEqual([
      { tokenId: "t-new", status: "pending" },
      { tokenId: "t-new", status: "ready", item: { tokenId: "t-new", targetText: "obscure", display: "新版" } }
    ]);
  });

  it("drops obsolete lookups that are still waiting for storage", async () => {
    const storage = createMemoryStorage();
    let releaseLexiconRead: ((value: Map<string, VocabularyRecord>) => void) | undefined;
    storage.lexicon.getMany = vi.fn(() => new Promise<Map<string, VocabularyRecord>>((resolve) => {
      releaseLexiconRead = resolve;
    }));
    const ai = {
      glossFrame: vi.fn(async () => ({
        items: [{ tokenId: "t-old", targetText: "novel", display: "旧版" }]
      })),
      ankiCard: vi.fn()
    };
    const resolver = createGlossResolver({ storage, ai, aiFrameMaxMs: 1, dbReadCoalesceMs: 0 });
    const events: Array<Omit<GlossTokenPayload, "scanId">> = [];

    const oldScan = resolveScan(resolver, "https://example.test/page", [{
      id: "s-old",
      text: "A novel archive appears.",
      tokens: [{ id: "t-old", sentenceId: "s-old", surface: "novel", lemma: "novel", startOffset: 2, endOffset: 7 }]
    }], testSettings(), 100, { emit: (event) => events.push(event) });
    await vi.waitFor(() => expect(storage.lexicon.getMany).toHaveBeenCalledTimes(1));

    resolver.invalidateGeneration();
    releaseLexiconRead?.(new Map());
    await oldScan;

    expect(events).toEqual([]);
    expect(ai.glossFrame).not.toHaveBeenCalled();
  });

  it("keeps a replacement session active when the same generation is activated again", async () => {
    // @verifies glossa.cache_identity.generation_activation
    const storage = createMemoryStorage();
    const settings = { ...testSettings(), modelVersion: "replacement-model" };
    let resolveFrame!: (value: { items: Array<{ tokenId: string; targetText: string; display: string }> }) => void;
    const ai = {
      glossFrame: vi.fn(() => new Promise<{ items: Array<{ tokenId: string; targetText: string; display: string }> }>((resolve) => {
        resolveFrame = resolve;
      })),
      ankiCard: vi.fn()
    };
    const resolver = createGlossResolver({ storage, ai, aiFrameMaxMs: 1, dbReadCoalesceMs: 0 });
    const events: Array<Omit<GlossTokenPayload, "scanId">> = [];
    const identity = glossGenerationIdentity(settings);
    await resolver.activateGeneration(identity);

    const scan = resolveScan(resolver, "https://example.test/page", [{
      id: "s-new",
      text: "A novel archive appears.",
      tokens: [{ id: "t-new", sentenceId: "s-new", surface: "novel", lemma: "novel", startOffset: 2, endOffset: 7 }]
    }], settings, 200, { emit: (event) => events.push(event) });
    await vi.waitFor(() => expect(ai.glossFrame).toHaveBeenCalledTimes(1));

    await resolver.activateGeneration(identity);
    resolveFrame({ items: [{ tokenId: "t-new", targetText: "novel", display: "新版" }] });
    await scan;

    expect(events).toEqual([
      { tokenId: "t-new", status: "pending" },
      { tokenId: "t-new", status: "ready", item: { tokenId: "t-new", targetText: "novel", display: "新版" } }
    ]);
  });

  it("keeps persistent cache across generation changes and clears it only explicitly", async () => {
    const storage = createMemoryStorage();
    storage.glossCache.clear = vi.fn(async () => undefined);
    const resolver = createGlossResolver({
      storage,
      ai: { glossFrame: vi.fn(), ankiCard: vi.fn() }
    });
    await resolver.activateGeneration("old");

    await resolver.activateGeneration("new");
    await resolver.activateGeneration("new");
    expect(storage.glossCache.clear).not.toHaveBeenCalled();

    await resolver.clearCache();
    expect(storage.glossCache.clear).toHaveBeenCalledTimes(1);
  });

  it("splits in-flight AI reuse by API key for the same cache entry", async () => {
    const storage = createMemoryStorage();
    const oldKeySettings: GlossaSettings = {
      ...testSettings(),
      ai: {
        ...DEFAULT_SETTINGS.ai,
        provider: "openai-responses",
        endpoint: "https://api.openai.com/v1/responses",
        reasoningEffort: "medium",
        apiKey: "old-key"
      }
    };
    const newKeySettings: GlossaSettings = {
      ...oldKeySettings,
      ai: {
        ...oldKeySettings.ai,
        apiKey: "new-key"
      }
    };
    const frameResolvers = new Map<string, (value: { items: Array<{ tokenId: string; targetText: string; display: string }> }) => void>();
    const ai = {
      glossFrame: vi.fn((input: { settings: GlossaSettings }) => new Promise<{ items: Array<{ tokenId: string; targetText: string; display: string }> }>((resolve) => {
        frameResolvers.set(input.settings.ai.apiKey ?? "", resolve);
      })),
      ankiCard: vi.fn()
    };
    const resolver = createGlossResolver({
      storage,
      ai,
      aiFrameMaxItems: 2,
      aiFrameMaxMs: 1,
      dbReadCoalesceMs: 0
    });
    const sentence = "A novel archive appears.";
    const oldKeyEvents: Array<Omit<GlossTokenPayload, "scanId">> = [];
    const newKeyEvents: Array<Omit<GlossTokenPayload, "scanId">> = [];

    const first = resolveScan(resolver, "https://example.test/old", [{
      id: "s-old",
      text: sentence,
      tokens: [{ id: "t-old", sentenceId: "s-old", surface: "novel", lemma: "novel", startOffset: 2, endOffset: 7 }]
    }], oldKeySettings, 100, { emit: (event) => oldKeyEvents.push(event) });
    await vi.waitFor(() => expect(ai.glossFrame).toHaveBeenCalledTimes(1));

    const second = resolveScan(resolver, "https://example.test/new", [{
      id: "s-new",
      text: sentence,
      tokens: [{ id: "t-new", sentenceId: "s-new", surface: "novel", lemma: "novel", startOffset: 2, endOffset: 7 }]
    }], newKeySettings, 100, { emit: (event) => newKeyEvents.push(event) });
    await vi.waitFor(() => expect(newKeyEvents).toEqual([{ tokenId: "t-new", status: "pending" }]));

    frameResolvers.get("old-key")?.({ items: [{ tokenId: "t-old", targetText: "novel", display: "旧钥" }] });
    await vi.waitFor(() => expect(ai.glossFrame).toHaveBeenCalledTimes(2));
    frameResolvers.get("new-key")?.({ items: [{ tokenId: "t-new", targetText: "novel", display: "新钥" }] });
    await Promise.all([first, second]);

    expect(ai.glossFrame.mock.calls.map(([input]) => input.settings.ai.apiKey)).toEqual(expect.arrayContaining(["old-key", "new-key"]));
    expect(oldKeyEvents).toEqual([
      { tokenId: "t-old", status: "pending" },
      { tokenId: "t-old", status: "ready", item: { tokenId: "t-old", targetText: "novel", display: "旧钥" } }
    ]);
    expect(newKeyEvents).toEqual([
      { tokenId: "t-new", status: "pending" },
      { tokenId: "t-new", status: "ready", item: { tokenId: "t-new", targetText: "novel", display: "新钥" } }
    ]);
  });

  it("splits in-flight AI reuse by timeout for the same cache entry", async () => {
    const storage = createMemoryStorage();
    const shortTimeoutSettings: GlossaSettings = {
      ...testSettings(),
      ai: {
        ...DEFAULT_SETTINGS.ai,
        provider: "openai-responses",
        endpoint: "https://api.openai.com/v1/responses",
        reasoningEffort: "medium",
        requestTimeoutMs: 2_500
      }
    };
    const longTimeoutSettings: GlossaSettings = {
      ...shortTimeoutSettings,
      ai: {
        ...shortTimeoutSettings.ai,
        requestTimeoutMs: 30_000
      }
    };
    const frameResolvers = new Map<number, (value: { items: Array<{ tokenId: string; targetText: string; display: string }> }) => void>();
    const ai = {
      glossFrame: vi.fn((input: { settings: GlossaSettings }) => new Promise<{ items: Array<{ tokenId: string; targetText: string; display: string }> }>((resolve) => {
        frameResolvers.set(input.settings.ai.requestTimeoutMs, resolve);
      })),
      ankiCard: vi.fn()
    };
    const resolver = createGlossResolver({
      storage,
      ai,
      aiFrameMaxItems: 2,
      aiFrameMaxMs: 1,
      dbReadCoalesceMs: 0
    });
    const sentence = "A novel archive appears.";
    const shortTimeoutEvents: Array<Omit<GlossTokenPayload, "scanId">> = [];
    const longTimeoutEvents: Array<Omit<GlossTokenPayload, "scanId">> = [];

    const first = resolveScan(resolver, "https://example.test/short", [{
      id: "s-short",
      text: sentence,
      tokens: [{ id: "t-short", sentenceId: "s-short", surface: "novel", lemma: "novel", startOffset: 2, endOffset: 7 }]
    }], shortTimeoutSettings, 100, { emit: (event) => shortTimeoutEvents.push(event) });
    await vi.waitFor(() => expect(ai.glossFrame).toHaveBeenCalledTimes(1));

    const second = resolveScan(resolver, "https://example.test/long", [{
      id: "s-long",
      text: sentence,
      tokens: [{ id: "t-long", sentenceId: "s-long", surface: "novel", lemma: "novel", startOffset: 2, endOffset: 7 }]
    }], longTimeoutSettings, 100, { emit: (event) => longTimeoutEvents.push(event) });
    await vi.waitFor(() => expect(longTimeoutEvents).toEqual([{ tokenId: "t-long", status: "pending" }]));

    frameResolvers.get(2_500)?.({ items: [{ tokenId: "t-short", targetText: "novel", display: "短时" }] });
    await vi.waitFor(() => expect(ai.glossFrame).toHaveBeenCalledTimes(2));
    frameResolvers.get(30_000)?.({ items: [{ tokenId: "t-long", targetText: "novel", display: "长时" }] });
    await Promise.all([first, second]);

    expect(ai.glossFrame.mock.calls.map(([input]) => input.settings.ai.requestTimeoutMs)).toEqual(expect.arrayContaining([2_500, 30_000]));
    expect(shortTimeoutEvents).toEqual([
      { tokenId: "t-short", status: "pending" },
      { tokenId: "t-short", status: "ready", item: { tokenId: "t-short", targetText: "novel", display: "短时" } }
    ]);
    expect(longTimeoutEvents).toEqual([
      { tokenId: "t-long", status: "pending" },
      { tokenId: "t-long", status: "ready", item: { tokenId: "t-long", targetText: "novel", display: "长时" } }
    ]);
  });

  it("resolves duplicate token ids inside one AI frame independently", async () => {
    const storage = createMemoryStorage();
    const settings = testSettings();
    await storage.settings.set(settings);
    const ai = {
      glossFrame: vi.fn(async (input: { items: Array<{ token: { id: string; surface: string } }> }) => ({
        items: input.items.map((item) => ({
          tokenId: item.token.id,
          targetText: item.token.surface,
          display: item.token.surface.toUpperCase()
        }))
      })),
      ankiCard: vi.fn()
    };
    const resolver = createGlossResolver({
      storage,
      ai,
      aiFrameMaxItems: 2,
      aiFrameMaxMs: 1_000,
      dbReadCoalesceMs: 0
    });
    const events: Array<Omit<GlossTokenPayload, "scanId">> = [];

    await resolveScan(resolver, "https://example.test/page", [{
      id: "s1",
      text: "A novel obscure archive appears.",
      tokens: [
        { id: "t-shared", sentenceId: "s1", surface: "novel", lemma: "novel", startOffset: 2, endOffset: 7 },
        { id: "t-shared", sentenceId: "s1", surface: "obscure", lemma: "obscure", startOffset: 8, endOffset: 15 }
      ]
    }], settings, 100, { emit: (event) => events.push(event) });

    expect(events).toEqual(expect.arrayContaining([
      { tokenId: "t-shared", status: "pending" },
      { tokenId: "t-shared", status: "ready", item: { tokenId: "t-shared", targetText: "novel", display: "NOVEL" } },
      { tokenId: "t-shared", status: "ready", item: { tokenId: "t-shared", targetText: "obscure", display: "OBSCURE" } }
    ]));
    expect(events.filter((event) => event.status === "pending")).toHaveLength(2);
    expect(events.filter((event) => event.status === "ready")).toHaveLength(2);
  });

  it("stops before AI enqueue when the sink closes during async reads", async () => {
    const storage = createMemoryStorage();
    const settings = testSettings();
    await storage.settings.set(settings);
    const ai = {
      glossFrame: vi.fn(async () => ({ items: [] })),
      ankiCard: vi.fn()
    };
    const resolver = createGlossResolver({
      storage,
      ai,
      dbReadCoalesceMs: 50,
      aiFrameMaxMs: 1
    });
    const events: Array<Omit<GlossTokenPayload, "scanId">> = [];
    let active = true;

    const done = resolveScan(resolver, "https://example.test/page", [{
      id: "s1",
      text: "A novel archive appears.",
      tokens: [{ id: "t-novel", sentenceId: "s1", surface: "novel", lemma: "novel", startOffset: 2, endOffset: 7 }]
    }], settings, 100, {
      emit: (event) => events.push(event),
      isActive: () => active
    });
    active = false;
    await done;

    expect(events).toEqual([]);
    expect(ai.glossFrame).not.toHaveBeenCalled();
  });

  it("resolves chunk acceptance after lookup work leaves the concurrency gate", async () => {
    const storage = createMemoryStorage();
    const settings = testSettings();
    await storage.settings.set(settings);
    let releaseLexiconRead: ((value: Map<string, VocabularyRecord>) => void) | undefined;
    storage.lexicon.getMany = vi.fn(() => new Promise<Map<string, VocabularyRecord>>((resolve) => {
      releaseLexiconRead = resolve;
    }));
    const ai = {
      glossFrame: vi.fn(async () => ({
        items: [{ tokenId: "t-novel", targetText: "novel", display: "新词" }]
      })),
      ankiCard: vi.fn()
    };
    const resolver = createGlossResolver({
      storage,
      ai,
      dbReadCoalesceMs: 0,
      aiFrameMaxMs: 1
    });
    const session = resolver.createSession("https://example.test/page", settings, 100, { emit: () => undefined });
    let accepted = false;

    const acceptedPromise = session.acceptChunk("chunk-1", 0, [{
      id: "s1",
      text: "A novel archive appears.",
      tokens: [{ id: "t-novel", sentenceId: "s1", surface: "novel", lemma: "novel", startOffset: 2, endOffset: 7 }]
    }]).then(() => {
      accepted = true;
    });
    await vi.waitFor(() => expect(storage.lexicon.getMany).toHaveBeenCalledTimes(1));
    await Promise.resolve();

    expect(accepted).toBe(false);

    releaseLexiconRead?.(new Map());
    await acceptedPromise;
    await session.finish();

    expect(accepted).toBe(true);
    expect(ai.glossFrame).toHaveBeenCalledTimes(1);
  });

  it("reuses in-flight AI lookups for the same cache key", async () => {
    const storage = createMemoryStorage();
    const settings = testSettings();
    await storage.settings.set(settings);
    let resolveAi: ((value: { items: Array<{ tokenId: string; targetText: string; display: string }> }) => void) | undefined;
    const ai = {
      glossFrame: vi.fn(() => new Promise<{ items: Array<{ tokenId: string; targetText: string; display: string }> }>((resolve) => {
        resolveAi = resolve;
      })),
      ankiCard: vi.fn()
    };
    const resolver = createGlossResolver({ storage, ai });
    const sentence = "A novel archive appears.";
    const firstEvents: Array<Omit<GlossTokenPayload, "scanId">> = [];
    const secondEvents: Array<Omit<GlossTokenPayload, "scanId">> = [];

    const first = resolveScan(resolver, "https://example.test/a", [{
      id: "s1",
      text: sentence,
      tokens: [{ id: "t-first", sentenceId: "s1", surface: "novel", lemma: "novel", startOffset: 2, endOffset: 7 }]
    }], settings, 100, { emit: (event) => firstEvents.push(event) });
    await vi.waitFor(() => expect(ai.glossFrame).toHaveBeenCalledTimes(1));

    const second = resolveScan(resolver, "https://example.test/a", [{
      id: "s2",
      text: sentence,
      tokens: [{ id: "t-second", sentenceId: "s2", surface: "novel", lemma: "novel", startOffset: 2, endOffset: 7 }]
    }], settings, 200, { emit: (event) => secondEvents.push(event) });
    await vi.waitFor(() => expect(secondEvents).toEqual([{ tokenId: "t-second", status: "pending" }]));

    resolveAi?.({ items: [{ tokenId: "t-first", targetText: "novel", display: "新词" }] });
    await Promise.all([first, second]);

    expect(ai.glossFrame).toHaveBeenCalledTimes(1);
    expect(firstEvents).toEqual([
      { tokenId: "t-first", status: "pending" },
      { tokenId: "t-first", status: "ready", item: { tokenId: "t-first", targetText: "novel", display: "新词" } }
    ]);
    expect(secondEvents).toEqual([
      { tokenId: "t-second", status: "pending" },
      { tokenId: "t-second", status: "ready", item: { tokenId: "t-second", targetText: "novel", display: "新词" } }
    ]);
  });

  it("shares in-flight AI failures with duplicate lookups", async () => {
    const storage = createMemoryStorage();
    const settings = testSettings();
    await storage.settings.set(settings);
    let rejectAi: ((error: Error) => void) | undefined;
    const ai = {
      glossFrame: vi.fn(() => new Promise<{ items: [] }>((_resolve, reject) => {
        rejectAi = reject;
      })),
      ankiCard: vi.fn()
    };
    const resolver = createGlossResolver({ storage, ai });
    const sentence = "A novel archive appears.";
    const firstEvents: Array<Omit<GlossTokenPayload, "scanId">> = [];
    const secondEvents: Array<Omit<GlossTokenPayload, "scanId">> = [];

    const first = resolveScan(resolver, "https://example.test/a", [{
      id: "s1",
      text: sentence,
      tokens: [{ id: "t-first", sentenceId: "s1", surface: "novel", lemma: "novel", startOffset: 2, endOffset: 7 }]
    }], settings, 100, { emit: (event) => firstEvents.push(event) });
    await vi.waitFor(() => expect(ai.glossFrame).toHaveBeenCalledTimes(1));

    const second = resolveScan(resolver, "https://example.test/a", [{
      id: "s2",
      text: sentence,
      tokens: [{ id: "t-second", sentenceId: "s2", surface: "novel", lemma: "novel", startOffset: 2, endOffset: 7 }]
    }], settings, 200, { emit: (event) => secondEvents.push(event) });
    await vi.waitFor(() => expect(secondEvents).toEqual([{ tokenId: "t-second", status: "pending" }]));

    rejectAi?.(new Error("backend unavailable"));
    await Promise.all([first, second]);

    expect(ai.glossFrame).toHaveBeenCalledTimes(1);
    expect(firstEvents).toEqual([
      { tokenId: "t-first", status: "pending" },
      {
        tokenId: "t-first",
        status: "error",
        message: "backend unavailable",
        error: { reason: "service-error", message: "backend unavailable", service: "ai" }
      }
    ]);
    expect(secondEvents).toEqual([
      { tokenId: "t-second", status: "pending" },
      {
        tokenId: "t-second",
        status: "error",
        message: "backend unavailable",
        error: { reason: "service-error", message: "backend unavailable", service: "ai" }
      }
    ]);
  });

  it("finishes an in-flight lookup for active duplicate subscribers after the owner disconnects", async () => {
    const storage = createMemoryStorage();
    const settings = testSettings();
    await storage.settings.set(settings);
    let resolveAi: ((value: { items: Array<{ tokenId: string; targetText: string; display: string }> }) => void) | undefined;
    const ai = {
      glossFrame: vi.fn(() => new Promise<{ items: Array<{ tokenId: string; targetText: string; display: string }> }>((resolve) => {
        resolveAi = resolve;
      })),
      ankiCard: vi.fn()
    };
    const resolver = createGlossResolver({ storage, ai });
    const sentence = "A novel archive appears.";
    const firstEvents: Array<Omit<GlossTokenPayload, "scanId">> = [];
    const secondEvents: Array<Omit<GlossTokenPayload, "scanId">> = [];
    let firstActive = true;

    const first = resolveScan(resolver, "https://example.test/a", [{
      id: "s1",
      text: sentence,
      tokens: [{ id: "t-first", sentenceId: "s1", surface: "novel", lemma: "novel", startOffset: 2, endOffset: 7 }]
    }], settings, 100, {
      emit: (event) => firstEvents.push(event),
      isActive: () => firstActive
    });
    await vi.waitFor(() => expect(ai.glossFrame).toHaveBeenCalledTimes(1));

    const second = resolveScan(resolver, "https://example.test/a", [{
      id: "s2",
      text: sentence,
      tokens: [{ id: "t-second", sentenceId: "s2", surface: "novel", lemma: "novel", startOffset: 2, endOffset: 7 }]
    }], settings, 200, { emit: (event) => secondEvents.push(event) });
    await vi.waitFor(() => expect(secondEvents).toEqual([{ tokenId: "t-second", status: "pending" }]));

    firstActive = false;
    resolveAi?.({ items: [{ tokenId: "t-first", targetText: "novel", display: "新词" }] });
    await Promise.all([first, second]);

    expect(ai.glossFrame).toHaveBeenCalledTimes(1);
    expect(firstEvents).toEqual([{ tokenId: "t-first", status: "pending" }]);
    expect(secondEvents).toEqual([
      { tokenId: "t-second", status: "pending" },
      { tokenId: "t-second", status: "ready", item: { tokenId: "t-second", targetText: "novel", display: "新词" } }
    ]);
  });
});

function testSettings(): GlossaSettings {
  return {
    ...DEFAULT_SETTINGS,
    ai: { ...DEFAULT_SETTINGS.ai, provider: "glossa-backend", endpoint: "https://ai.example.test", reasoningEffort: "medium" }
  };
}

async function cacheKey(sentence: string, targetText: string, startOffset: number, endOffset: number): Promise<string> {
  return buildGlossCacheKey({
    targetLang: GLOSS_TARGET_LANG,
    sentence,
    targetText,
    targetSpan: [startOffset, endOffset],
    settings: testSettings()
  });
}

async function resolveScan(
  resolver: ReturnType<typeof createGlossResolver>,
  pageUrl: string,
  sentences: SentenceCandidate[],
  settings: GlossaSettings,
  now: number,
  sink: Parameters<ReturnType<typeof createGlossResolver>["createSession"]>[3]
): Promise<void> {
  const session = resolver.createSession(pageUrl, settings, now, sink);
  await session.acceptChunk("test", 0, sentences);
  await session.finish();
}

function record(lemma: string, state: "known" | "ignored" | "learning_active") {
  return {
    key: `en:${lemma}`,
    lemma,
    surface: lemma,
    lang: "en",
    state,
    shownCount: 0,
    clickCount: 0,
    ankiNoteIds: []
  };
}

function createMemoryStorage(): ExtensionStorage {
  const settings = { value: undefined as unknown };
  const lexicon = new Map<string, unknown>();
  const glossCache = new Map<string, unknown>();
  const cardCache = new Map<string, unknown>();
  const cardedWords = new Map<string, unknown>();

  return {
    settings: {
      async get() {
        return settings.value as never;
      },
      async set(value) {
        settings.value = value;
      }
    },
    lexicon: {
      async get(key) {
        return lexicon.get(key) as never;
      },
      async getMany(keys) {
        return readMany<VocabularyRecord>(lexicon, keys);
      },
      async listByState(state: VocabularyState) {
        return Array.from(lexicon.values())
          .filter((record): record is VocabularyRecord => (record as VocabularyRecord).state === state)
          .sort((left, right) => left.lemma.localeCompare(right.lemma));
      },
      async update(key, transition) {
        const next = transition(lexicon.get(key) as VocabularyRecord | undefined);
        if (next) lexicon.set(key, next); else lexicon.delete(key);
        return next;
      },
      async put(value) {
        lexicon.set(value.key, value);
      },
      async delete(key) {
        lexicon.delete(key);
      }
    },
    glossCache: {
      async get(key) {
        return glossCache.get(key) as never;
      },
      async getMany(keys) {
        return readMany<GlossCacheEntry>(glossCache, keys);
      },
      async getFresh(key, now, ttlMs) {
        const value = glossCache.get(key) as GlossCacheEntry | undefined;
        return value && isFreshGlossCacheEntry(value, now, ttlMs) ? value : undefined;
      },
      async getFreshMany(keys, now, ttlMs) {
        return freshMany(readMany<GlossCacheEntry>(glossCache, keys), now, ttlMs);
      },
      async put(key, value) {
        glossCache.set(key, value);
      },
      async delete(key) {
        glossCache.delete(key);
      },
      async clear() {
        glossCache.clear();
      }
    },
    cardCache: {
      async get(key) {
        return cardCache.get(key) as never;
      },
      async getMany(keys) {
        return readMany<AnkiCardOutput>(cardCache, keys);
      },
      async put(key, value) {
        cardCache.set(key, value);
      },
      async delete(key) {
        cardCache.delete(key);
      },
      async clear() {
        cardCache.clear();
      }
    },
    cardedWords: {
      async get(key) {
        return cardedWords.get(key) as never;
      },
      async getMany(keys) {
        return readMany<CardedWordRecord>(cardedWords, keys);
      },
      async put(key, value) {
        cardedWords.set(key, value);
      },
      async delete(key) {
        cardedWords.delete(key);
      },
      async clear() {
        cardedWords.clear();
      }
    },
    async resetCardHistory() {
      cardCache.clear();
      cardedWords.clear();
      for (const [key, value] of lexicon) {
        const record = value as VocabularyRecord;
        lexicon.set(key, { ...record, ankiNoteIds: [] });
      }
    }
  };
}

function readMany<T>(store: Map<string, unknown>, keys: string[]): Map<string, T> {
  const result = new Map<string, T>();
  for (const key of keys) {
    if (store.has(key)) {
      result.set(key, store.get(key) as T);
    }
  }
  return result;
}

function freshMany(values: Map<string, GlossCacheEntry>, now: number, ttlMs: number): Map<string, GlossCacheEntry> {
  const result = new Map<string, GlossCacheEntry>();
  for (const [key, value] of values) {
    if (isFreshGlossCacheEntry(value, now, ttlMs)) {
      result.set(key, value);
    }
  }
  return result;
}

function isFreshGlossCacheEntry(value: GlossCacheEntry, now: number, ttlMs: number): boolean {
  return Number.isFinite(value.createdAt) && now < value.createdAt + ttlMs;
}
