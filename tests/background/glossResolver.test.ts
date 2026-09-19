import { createMemoryStorage } from "../helpers/memoryStorage";
import { deferred } from "../state-model/asyncHarness";
import type { GlossFrameBackendInput, GlossBackendOutput } from "../../src/shared/services/aiClient";
import type { GlossGenerator } from "../../src/shared/services/glossGenerator";
import { describe, expect, it, vi } from "vitest";

import { buildGlossCacheKey, glossGenerationIdentity } from "../../src/core/cache";
import { createGlossResolver } from "../../src/background/glossResolver";
import { DEFAULT_SETTINGS, GLOSS_TARGET_LANG, type GlossaSettings, type GlossCacheEntry, type GlossTokenOutcome, type SentenceCandidate, type VocabularyRecord } from "../../src/shared/types";

describe("gloss resolver lookup-first pipeline", () => {
  it("emits and caches successful items when another item in the same frame fails", async () => {
    const settings: GlossaSettings = { ...testSettings(), translation: { mode: "dictionary-jev", fallbackToLlm: true } };
    const { storage, glossCache } = createMemoryStorage(settings);
    const generator: GlossGenerator = { glossFrame: vi.fn(async (input: GlossFrameBackendInput) => ({ items: input.items.map(({ requestItemId, token }) =>
      token.surface === "novel"
        ? { requestItemId, value: { targetText: token.surface, display: "新颖的" } }
        : { requestItemId, error: { reason: "network" as const, service: "ai" as const, message: "Fallback disconnected" } }
    ) })) };
    const resolver = createGlossResolver({ storage, generator, frameMaxItems: 2, dbReadCoalesceMs: 0 });
    const events: GlossTokenOutcome[] = [];
    await resolveScan(resolver, "https://example.test/mixed", [{
      id: "sentence", text: "novel obscure",
      tokens: [
        { id: "first", sentenceId: "sentence", surface: "novel", lemma: "novel", startOffset: 0, endOffset: 5 },
        { id: "second", sentenceId: "sentence", surface: "obscure", lemma: "obscure", startOffset: 6, endOffset: 13 }
      ]
    }], settings, 100, { emit: (event) => events.push(event) });
    expect(events.filter((event) => event.status !== "pending")).toEqual([
      { tokenId: "first", status: "ready", item: { tokenId: "first", targetText: "novel", display: "新颖的" } },
      { tokenId: "second", status: "error", error: { reason: "network", service: "ai", message: "Fallback disconnected" } }
    ]);
    expect([...glossCache.values()]).toEqual([expect.objectContaining({ targetText: "novel", display: "新颖的" })]);
    expect(await storage.lexicon.get("en:novel")).toMatchObject({ state: "known" });
    expect(await storage.lexicon.get("en:obscure")).toBeUndefined();
  });

  it("emits hidden, ready, pending and AI ready outcomes in lookup order", async () => {
    const { storage } = createMemoryStorage();
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
      glossFrame: vi.fn(async (input: GlossFrameBackendInput) => frameReply(input, "新词")),
      ankiCard: vi.fn()
    };
    const resolver = createGlossResolver({ storage, generator: ai });
    const events: Array<GlossTokenOutcome> = [];

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
        token: expect.objectContaining({ surface: "novel" })
      })]
    }));
    expect(await storage.lexicon.get("en:cached")).toMatchObject({ lastShownAt: 100 });
    expect(await storage.lexicon.get("en:novel")).toMatchObject({ state: "known" });
    expect(await storage.glossCache.get(await cacheKey("Known ignored cached novel words.", "novel", 21, 26))).toMatchObject({ createdAt: 100 });
  });

  it("uses fresh persisted gloss cache before known and ignored lexicon state and ignores expired cache entries", async () => {
    const { storage } = createMemoryStorage();
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
    const resolver = createGlossResolver({ storage, generator: ai });
    const events: Array<GlossTokenOutcome> = [];

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
    const { storage } = createMemoryStorage();
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
    const resolver = createGlossResolver({ storage, generator: ai });
    const events: Array<GlossTokenOutcome> = [];

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
    const { storage } = createMemoryStorage();
    const settings = testSettings();
    await storage.settings.set(settings);
    const ai = {
      glossFrame: vi.fn(async (input: GlossFrameBackendInput) => frameReply(input, "新词")),
      ankiCard: vi.fn()
    };
    const resolver = createGlossResolver({ storage, generator: ai });
    const sentence = "A novel archive appears.";
    const firstEvents: Array<GlossTokenOutcome> = [];
    const secondEvents: Array<GlossTokenOutcome> = [];
    const otherPageEvents: Array<GlossTokenOutcome> = [];

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
    const { storage } = createMemoryStorage();
    const settings = testSettings();
    await storage.settings.set(settings);
    const ai = {
      glossFrame: vi.fn(async (input: GlossFrameBackendInput) => frameReply(input, "新词")),
      ankiCard: vi.fn()
    };
    const resolver = createGlossResolver({ storage, generator: ai });
    const sentence = "A novel archive appears.";
    const secondEvents: Array<GlossTokenOutcome> = [];

    await resolveScan(resolver, "https://example.test/a", [{
      id: "s1",
      text: sentence,
      tokens: [{ id: "t-first", sentenceId: "s1", surface: "novel", lemma: "novel", startOffset: 2, endOffset: 7 }]
    }], settings, 100, { emit: () => undefined });
    await resolver.clearCache();
    await resolveScan(resolver, "https://example.test/a", [{
      id: "s2",
      text: sentence,
      tokens: [{ id: "t-second", sentenceId: "s2", surface: "novel", lemma: "novel", startOffset: 2, endOffset: 7 }]
    }], settings, 200, { emit: (event) => secondEvents.push(event) });

    expect(secondEvents).toEqual([{ tokenId: "t-second", status: "hidden" }]);
    expect(ai.glossFrame).toHaveBeenCalledTimes(1);
  });

  it("refreshes a rendered known token while continuing to hide ignored tokens", async () => {
    const { storage } = createMemoryStorage();
    const settings = testSettings();
    await storage.settings.set(settings);
    await storage.lexicon.put(record("novel", "known"));
    await storage.lexicon.put(record("ignored", "ignored"));
    const ai = {
      glossFrame: vi.fn(async (input: GlossFrameBackendInput) => frameReply(input, "新版")),
      ankiCard: vi.fn()
    };
    const resolver = createGlossResolver({ storage, generator: ai, frameMaxMs: 1, dbReadCoalesceMs: 0 });
    const events: Array<GlossTokenOutcome> = [];

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
      items: [expect.objectContaining({ token: expect.objectContaining({ surface: "novel" }) })]
    }));
    expect(ai.glossFrame.mock.calls[0]?.[0].items[0]?.token).not.toHaveProperty("forceRefresh");
  });

  it("keeps page memory replay independent from persistent gloss cache TTL", async () => {
    const { storage } = createMemoryStorage();
    const settings = { ...testSettings(), glossCacheTtlMs: 50 };
    await storage.settings.set(settings);
    const ai = {
      glossFrame: vi.fn(async (input: GlossFrameBackendInput) => frameReply(input, "新词")),
      ankiCard: vi.fn()
    };
    const resolver = createGlossResolver({ storage, generator: ai });
    const sentence = "A novel archive appears.";
    const firstEvents: Array<GlossTokenOutcome> = [];
    const samePageEvents: Array<GlossTokenOutcome> = [];
    const otherPageEvents: Array<GlossTokenOutcome> = [];

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
    const { storage } = createMemoryStorage();
    const settings = testSettings();
    await storage.settings.set(settings);
    const ai = {
      glossFrame: vi.fn(async (input: GlossFrameBackendInput) => ({
        items: input.items.map((item) => ({
          requestItemId: item.requestItemId,
          value: { targetText: item.token.surface, display: item.token.surface === "novel" ? "新词" : "晦涩" }
        }))
      })),
      ankiCard: vi.fn()
    };
    const resolver = createGlossResolver({
      storage,
      generator: ai,
      frameMaxItems: 2,
      frameMaxMs: 1_000,
      dbReadCoalesceMs: 0
    });
    const events: Array<GlossTokenOutcome> = [];

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
        expect.objectContaining({ token: expect.objectContaining({ surface: "novel" }) }),
        expect.objectContaining({ token: expect.objectContaining({ surface: "obscure" }) })
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
    const { storage } = createMemoryStorage();
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
      glossFrame: vi.fn(async (input: GlossFrameBackendInput) => ({
        items: input.items.map((item) => ({
          requestItemId: item.requestItemId,
          value: { targetText: item.token.surface, display: input.settings.ai.apiKey === "old-key" ? "旧钥" : "新钥" }
        }))
      })),
      ankiCard: vi.fn()
    };
    const resolver = createGlossResolver({
      storage,
      generator: ai,
      frameMaxItems: 2,
      frameMaxMs: 50,
      dbReadCoalesceMs: 0
    });
    const oldKeyEvents: Array<GlossTokenOutcome> = [];
    const newKeyEvents: Array<GlossTokenOutcome> = [];

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
    const { storage } = createMemoryStorage();
    const oldSettings = { ...testSettings(), modelVersion: "old-model" };
    const newSettings = { ...testSettings(), modelVersion: "new-model" };
    const ai = {
      glossFrame: vi.fn((input: GlossFrameBackendInput) => {
        if (input.settings.modelVersion === "old-model") {
          return new Promise<GlossBackendOutput>((_resolve, reject) => {
            input.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
          });
        }
        return Promise.resolve({
          items: input.items.map((item) => ({ requestItemId: item.requestItemId, value: { targetText: item.token.surface, display: "新版" } }))
        });
      }),
      ankiCard: vi.fn()
    };
    const resolver = createGlossResolver({ storage, generator: ai, frameMaxMs: 1, dbReadCoalesceMs: 0 });
    const oldEvents: Array<GlossTokenOutcome> = [];
    const newEvents: Array<GlossTokenOutcome> = [];
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
    const { storage } = createMemoryStorage();
    let releaseLexiconRead: ((value: Map<string, VocabularyRecord>) => void) | undefined;
    storage.lexicon.getMany = vi.fn(() => new Promise<Map<string, VocabularyRecord>>((resolve) => {
      releaseLexiconRead = resolve;
    }));
    const ai = {
      glossFrame: vi.fn(async (input: GlossFrameBackendInput) => frameReply(input, "旧版")),
      ankiCard: vi.fn()
    };
    const resolver = createGlossResolver({ storage, generator: ai, frameMaxMs: 1, dbReadCoalesceMs: 0 });
    const events: Array<GlossTokenOutcome> = [];

    const oldScan = resolveScan(resolver, "https://example.test/page", [{
      id: "s-old",
      text: "A novel archive appears.",
      tokens: [{ id: "t-old", sentenceId: "s-old", surface: "novel", lemma: "novel", startOffset: 2, endOffset: 7 }]
    }], testSettings(), 100, { emit: (event) => events.push(event) });
    await vi.waitFor(() => expect(storage.lexicon.getMany).toHaveBeenCalledTimes(1));

    await resolver.activateGeneration("initial");
    await resolver.activateGeneration("replacement");
    releaseLexiconRead?.(new Map());
    await oldScan;

    expect(events).toEqual([]);
    expect(ai.glossFrame).not.toHaveBeenCalled();
  });

  it("keeps a replacement session active when the same generation is activated again", async () => {
    // @verifies glossa.cache_identity.generation_activation
    const { storage } = createMemoryStorage();
    const settings = { ...testSettings(), modelVersion: "replacement-model" };
    let resolveFrame!: (value: GlossBackendOutput) => void;
    const ai = {
      glossFrame: vi.fn((_input: GlossFrameBackendInput) => new Promise<GlossBackendOutput>((resolve) => {
        resolveFrame = resolve;
      })),
      ankiCard: vi.fn()
    };
    const resolver = createGlossResolver({ storage, generator: ai, frameMaxMs: 1, dbReadCoalesceMs: 0 });
    const events: Array<GlossTokenOutcome> = [];
    const identity = glossGenerationIdentity(settings);
    await resolver.activateGeneration(identity);

    const scan = resolveScan(resolver, "https://example.test/page", [{
      id: "s-new",
      text: "A novel archive appears.",
      tokens: [{ id: "t-new", sentenceId: "s-new", surface: "novel", lemma: "novel", startOffset: 2, endOffset: 7 }]
    }], settings, 200, { emit: (event) => events.push(event) });
    await vi.waitFor(() => expect(ai.glossFrame).toHaveBeenCalledTimes(1));

    await resolver.activateGeneration(identity);
    resolveFrame(frameReply(ai.glossFrame.mock.calls.at(-1)![0], "新版"));
    await scan;

    expect(events).toEqual([
      { tokenId: "t-new", status: "pending" },
      { tokenId: "t-new", status: "ready", item: { tokenId: "t-new", targetText: "novel", display: "新版" } }
    ]);
  });

  it("keeps persistent cache across generation changes and clears it only explicitly", async () => {
    const { storage } = createMemoryStorage();
    storage.glossCache.clear = vi.fn(async () => undefined);
    const resolver = createGlossResolver({
      storage,
      generator: { glossFrame: vi.fn() }
    });
    await resolver.activateGeneration("old");

    await resolver.activateGeneration("new");
    await resolver.activateGeneration("new");
    expect(storage.glossCache.clear).not.toHaveBeenCalled();

    await resolver.clearCache();
    expect(storage.glossCache.clear).toHaveBeenCalledTimes(1);
  });

  it("splits in-flight AI reuse by API key for the same cache entry", async () => {
    const { storage } = createMemoryStorage();
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
    const frameResolvers = new Map<string, (value: GlossBackendOutput) => void>();
    const ai = {
      glossFrame: vi.fn((input: GlossFrameBackendInput) => new Promise<GlossBackendOutput>((resolve) => {
        frameResolvers.set(input.settings.ai.apiKey ?? "", resolve);
      })),
      ankiCard: vi.fn()
    };
    const resolver = createGlossResolver({
      storage,
      generator: ai,
      frameMaxItems: 2,
      frameMaxMs: 1,
      dbReadCoalesceMs: 0
    });
    const sentence = "A novel archive appears.";
    const oldKeyEvents: Array<GlossTokenOutcome> = [];
    const newKeyEvents: Array<GlossTokenOutcome> = [];

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

    frameResolvers.get("old-key")?.(frameReply(ai.glossFrame.mock.calls.at(-1)![0], "旧钥"));
    await vi.waitFor(() => expect(ai.glossFrame).toHaveBeenCalledTimes(2));
    frameResolvers.get("new-key")?.(frameReply(ai.glossFrame.mock.calls.at(-1)![0], "新钥"));
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

  it.each(["ai", "jev"] as const)("splits in-flight reuse by active %s timeout for the same cache entry", async (service) => {
    const { storage } = createMemoryStorage();
    const shortTimeoutSettings: GlossaSettings = {
      ...testSettings(),
      translation: { mode: service === "jev" ? "dictionary-jev" : "llm", fallbackToLlm: false },
      [service]: { ...testSettings()[service], requestTimeoutMs: 2_500 }
    };
    const longTimeoutSettings: GlossaSettings = {
      ...shortTimeoutSettings,
      [service]: { ...shortTimeoutSettings[service], requestTimeoutMs: 30_000 }
    };
    const frameResolvers = new Map<number, (value: GlossBackendOutput) => void>();
    const ai = {
      glossFrame: vi.fn((input: GlossFrameBackendInput) => new Promise<GlossBackendOutput>((resolve) => {
        frameResolvers.set(input.settings[service].requestTimeoutMs, resolve);
      })),
      ankiCard: vi.fn()
    };
    const resolver = createGlossResolver({
      storage,
      generator: ai,
      frameMaxItems: 2,
      frameMaxMs: 1,
      dbReadCoalesceMs: 0
    });
    const sentence = "A novel archive appears.";
    const shortTimeoutEvents: Array<GlossTokenOutcome> = [];
    const longTimeoutEvents: Array<GlossTokenOutcome> = [];

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

    frameResolvers.get(2_500)?.(frameReply(ai.glossFrame.mock.calls.at(-1)![0], "短时"));
    await vi.waitFor(() => expect(ai.glossFrame).toHaveBeenCalledTimes(2));
    frameResolvers.get(30_000)?.(frameReply(ai.glossFrame.mock.calls.at(-1)![0], "长时"));
    await Promise.all([first, second]);

    expect(ai.glossFrame.mock.calls.map(([input]) => input.settings[service].requestTimeoutMs)).toEqual(expect.arrayContaining([2_500, 30_000]));
    expect(shortTimeoutEvents).toEqual([
      { tokenId: "t-short", status: "pending" },
      { tokenId: "t-short", status: "ready", item: { tokenId: "t-short", targetText: "novel", display: "短时" } }
    ]);
    expect(longTimeoutEvents).toEqual([
      { tokenId: "t-long", status: "pending" },
      { tokenId: "t-long", status: "ready", item: { tokenId: "t-long", targetText: "novel", display: "长时" } }
    ]);
  });

  it("correlates reversed frame results for two sessions with the same token id", async () => {
    const { storage, glossCache } = createMemoryStorage(testSettings());
    const ai = { glossFrame: vi.fn(async (input: GlossFrameBackendInput) => ({
      items: input.items.map(({ requestItemId, token }) => ({
        requestItemId, value: { targetText: token.surface, display: token.surface.toUpperCase() }
      })).reverse()
    })) };
    const resolver = createGlossResolver({ storage, generator: ai, frameMaxItems: 2, dbReadCoalesceMs: 0 });
    const first = startSession(resolver, "same-id", "novel");
    const second = startSession(resolver, "same-id", "obscure");
    await Promise.all([first.done, second.done]);
    expect(first.events).toEqual([
      { tokenId: "same-id", status: "pending" },
      { tokenId: "same-id", status: "ready", item: { tokenId: "same-id", targetText: "novel", display: "NOVEL" } }
    ]);
    expect(second.events).toEqual([
      { tokenId: "same-id", status: "pending" },
      { tokenId: "same-id", status: "ready", item: { tokenId: "same-id", targetText: "obscure", display: "OBSCURE" } }
    ]);
    expect([...glossCache.values()]).toEqual(expect.arrayContaining([
      expect.objectContaining({targetText:"novel",display:"NOVEL"}),
      expect.objectContaining({targetText:"obscure",display:"OBSCURE"})
    ]));
  });

  it("stops before AI enqueue when the sink closes during async reads", async () => {
    const { storage } = createMemoryStorage();
    const settings = testSettings();
    await storage.settings.set(settings);
    const ai = {
      glossFrame: vi.fn(async () => ({ items: [] })),
      ankiCard: vi.fn()
    };
    const resolver = createGlossResolver({
      storage,
      generator: ai,
      dbReadCoalesceMs: 50,
      frameMaxMs: 1
    });
    const events: Array<GlossTokenOutcome> = [];
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

  it("does not mark a memory-cached word shown when the session closes during cache-key hashing", async () => {
    const { storage, lexicon } = createMemoryStorage(testSettings());
    const ai = { glossFrame: vi.fn(async (input: GlossFrameBackendInput) => frameReply(input, "新词")) };
    const resolver = createGlossResolver({ storage, generator: ai, dbReadCoalesceMs: 0, frameMaxMs: 0 });
    const sentences: SentenceCandidate[] = [{
      id: "sentence", text: "A novel appears.",
      tokens: [{ id: "token", sentenceId: "sentence", surface: "novel", lemma: "novel", startOffset: 2, endOffset: 7 }]
    }];
    const pageUrl = "https://example.test/page";
    await resolveScan(resolver, pageUrl, sentences, testSettings(), 100, { emit: () => undefined });
    await storage.lexicon.clearKnown();
    const hashingStarted = deferred();
    const releaseHash = deferred();
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    const digestSpy = vi.spyOn(crypto.subtle, "digest").mockImplementation(async (...args) => {
      hashingStarted.resolve();
      await releaseHash.promise;
      return digest(...args);
    });
    const events: GlossTokenOutcome[] = [];
    const session = resolver.createSession(pageUrl, testSettings(), 200, { emit: (event) => events.push(event) });
    try {
      const chunk = session.acceptChunk("chunk", 0, sentences);
      await hashingStarted.promise;
      session.close();
      releaseHash.resolve();
      await chunk;
      await session.finish();
      expect(events).toEqual([]);
      expect(lexicon.get("en:novel")).toBeUndefined();
      expect(ai.glossFrame).toHaveBeenCalledTimes(1);
    } finally {
      releaseHash.resolve();
      digestSpy.mockRestore();
    }
  });

  it("resolves chunk acceptance after lookup work leaves the concurrency gate", async () => {
    const { storage } = createMemoryStorage();
    const settings = testSettings();
    await storage.settings.set(settings);
    let releaseLexiconRead: ((value: Map<string, VocabularyRecord>) => void) | undefined;
    storage.lexicon.getMany = vi.fn(() => new Promise<Map<string, VocabularyRecord>>((resolve) => {
      releaseLexiconRead = resolve;
    }));
    const ai = {
      glossFrame: vi.fn(async (input: GlossFrameBackendInput) => frameReply(input, "新词")),
      ankiCard: vi.fn()
    };
    const resolver = createGlossResolver({
      storage,
      generator: ai,
      dbReadCoalesceMs: 0,
      frameMaxMs: 1
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
    const { storage } = createMemoryStorage();
    const settings = testSettings();
    await storage.settings.set(settings);
    let resolveAi: ((value: GlossBackendOutput) => void) | undefined;
    const ai = {
      glossFrame: vi.fn((_input: GlossFrameBackendInput) => new Promise<GlossBackendOutput>((resolve) => {
        resolveAi = resolve;
      })),
      ankiCard: vi.fn()
    };
    const resolver = createGlossResolver({ storage, generator: ai });
    const sentence = "A novel archive appears.";
    const firstEvents: Array<GlossTokenOutcome> = [];
    const secondEvents: Array<GlossTokenOutcome> = [];

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

    resolveAi?.(frameReply(ai.glossFrame.mock.calls.at(-1)![0], "新词"));
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
    const { storage } = createMemoryStorage();
    const settings = testSettings();
    await storage.settings.set(settings);
    let rejectAi: ((error: Error) => void) | undefined;
    const ai = {
      glossFrame: vi.fn(() => new Promise<{ items: [] }>((_resolve, reject) => {
        rejectAi = reject;
      })),
      ankiCard: vi.fn()
    };
    const resolver = createGlossResolver({ storage, generator: ai });
    const sentence = "A novel archive appears.";
    const firstEvents: Array<GlossTokenOutcome> = [];
    const secondEvents: Array<GlossTokenOutcome> = [];

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
        error: { reason: "service-error", message: "backend unavailable", service: "ai" }
      }
    ]);
    expect(secondEvents).toEqual([
      { tokenId: "t-second", status: "pending" },
      {
        tokenId: "t-second",
        status: "error",
        error: { reason: "service-error", message: "backend unavailable", service: "ai" }
      }
    ]);
  });

  it("finishes an in-flight lookup for active duplicate subscribers after the owner disconnects", async () => {
    const { storage } = createMemoryStorage();
    const settings = testSettings();
    await storage.settings.set(settings);
    let resolveAi: ((value: GlossBackendOutput) => void) | undefined;
    const ai = {
      glossFrame: vi.fn((_input: GlossFrameBackendInput) => new Promise<GlossBackendOutput>((resolve) => {
        resolveAi = resolve;
      })),
      ankiCard: vi.fn()
    };
    const resolver = createGlossResolver({ storage, generator: ai });
    const sentence = "A novel archive appears.";
    const firstEvents: Array<GlossTokenOutcome> = [];
    const secondEvents: Array<GlossTokenOutcome> = [];
    const firstSession = resolver.createSession("https://example.test/a", settings, 100, { emit: (event) => firstEvents.push(event) });
    const first = firstSession.acceptChunk("first", 0, [{
      id: "s1",
      text: sentence,
      tokens: [{ id: "t-first", sentenceId: "s1", surface: "novel", lemma: "novel", startOffset: 2, endOffset: 7 }]
    }]).then(() => firstSession.finish());
    await vi.waitFor(() => expect(ai.glossFrame).toHaveBeenCalledTimes(1));

    const second = resolveScan(resolver, "https://example.test/a", [{
      id: "s2",
      text: sentence,
      tokens: [{ id: "t-second", sentenceId: "s2", surface: "novel", lemma: "novel", startOffset: 2, endOffset: 7 }]
    }], settings, 200, { emit: (event) => secondEvents.push(event) });
    await vi.waitFor(() => expect(secondEvents).toEqual([{ tokenId: "t-second", status: "pending" }]));

    firstSession.close();
    resolveAi?.(frameReply(ai.glossFrame.mock.calls.at(-1)![0], "新词"));
    await Promise.all([first, second]);

    expect(ai.glossFrame).toHaveBeenCalledTimes(1);
    expect(firstEvents).toEqual([{ tokenId: "t-first", status: "pending" }]);
    expect(secondEvents).toEqual([
      { tokenId: "t-second", status: "pending" },
      { tokenId: "t-second", status: "ready", item: { tokenId: "t-second", targetText: "novel", display: "新词" } }
    ]);
  });
  it.each(["duplicate", "unknown", "missing"] as const)("validates %s frame result identities before committing", async (kind) => {
    const { storage, glossCache } = createMemoryStorage(testSettings());
    const ai = { glossFrame: vi.fn(async (input: GlossFrameBackendInput) => {
      const reply = frameReply(input, "译文");
      if (kind === "duplicate") reply.items.push(reply.items[0]!);
      if (kind === "unknown") reply.items.push({ requestItemId: "unknown", value: { targetText: "word", display: "错误" } });
      if (kind === "missing") reply.items.pop();
      return reply;
    }) };
    const resolver = createGlossResolver({ storage, generator: ai, dbReadCoalesceMs: 0, frameMaxItems: 2 });
    const left = startSession(resolver, "same-id", "novel");
    const right = startSession(resolver, "same-id", "obscure");
    await Promise.all([left.done, right.done]);
    const outcomes = [...left.events, ...right.events];
    expect(outcomes.filter((item) => item.status === "error")).toHaveLength(kind === "missing" ? 1 : 2);
    expect(outcomes.filter((item) => item.status === "ready")).toHaveLength(kind === "missing" ? 1 : 0);
    expect(glossCache.size).toBe(kind === "missing" ? 1 : 0);
  });

  it("removes queued jobs when their final subscriber closes", async () => {
    const { storage, glossCache } = createMemoryStorage(testSettings());
    const ai = { glossFrame: vi.fn(async (input: GlossFrameBackendInput) => frameReply(input, "译文")) };
    const resolver = createGlossResolver({ storage, generator: ai, dbReadCoalesceMs: 0, frameMaxMs: 60_000 });
    const scan = startSession(resolver, "token", "novel");
    await vi.waitFor(() => expect(scan.events).toHaveLength(1));
    scan.session.close();
    await scan.done;
    expect(ai.glossFrame).not.toHaveBeenCalled();
    expect(glossCache.size).toBe(0);
  });

  it("keeps demanded jobs in a dispatched mixed frame and aborts only after the last subscriber leaves", async () => {
    const { storage, glossCache } = createMemoryStorage(testSettings());
    const response = deferred<GlossBackendOutput>();
    const ai = { glossFrame: vi.fn((_input: GlossFrameBackendInput) => response.promise) };
    const resolver = createGlossResolver({ storage, generator: ai, dbReadCoalesceMs: 0, frameMaxItems: 2 });
    const left = startSession(resolver, "same-id", "novel");
    const right = startSession(resolver, "same-id", "obscure");
    await vi.waitFor(() => expect(ai.glossFrame).toHaveBeenCalledTimes(1));
    const input = ai.glossFrame.mock.calls[0]![0];
    expect(new Set(input.items.map((item) => item.requestItemId)).size).toBe(2);
    left.session.close();
    expect(input.signal?.aborted).toBe(false);
    response.resolve({ items: frameReply(input, "译文").items.reverse() });
    await Promise.all([left.done, right.done]);
    expect(left.events.map((item) => item.status)).toEqual(["pending"]);
    expect(right.events.map((item) => item.status)).toEqual(["pending", "ready"]);
    expect(glossCache.size).toBe(1);
  });

  it("aborts an unneeded frame and keeps a replacement job when the canceled request settles late", async () => {
    const { storage, glossCache } = createMemoryStorage(testSettings());
    const oldResponse = deferred<GlossBackendOutput>();
    const newResponse = deferred<GlossBackendOutput>();
    const ai = { glossFrame: vi.fn((_input: GlossFrameBackendInput) => ai.glossFrame.mock.calls.length === 1 ? oldResponse.promise : newResponse.promise) };
    const resolver = createGlossResolver({ storage, generator: ai, dbReadCoalesceMs: 0, frameMaxItems: 1 });
    const obsolete = startSession(resolver, "old", "novel");
    await vi.waitFor(() => expect(ai.glossFrame).toHaveBeenCalledTimes(1));
    obsolete.session.close();
    expect(ai.glossFrame.mock.calls[0]![0].signal?.aborted).toBe(true);
    const replacement = startSession(resolver, "new", "novel");
    await vi.waitFor(() => expect(replacement.events).toHaveLength(1));
    oldResponse.resolve(frameReply(ai.glossFrame.mock.calls[0]![0], "旧译"));
    await vi.waitFor(() => expect(ai.glossFrame).toHaveBeenCalledTimes(2));
    const duplicate = startSession(resolver, "duplicate", "novel");
    await vi.waitFor(() => expect(duplicate.events).toHaveLength(1));
    newResponse.resolve(frameReply(ai.glossFrame.mock.calls[1]![0], "新译"));
    await Promise.all([obsolete.done, replacement.done, duplicate.done]);
    expect(ai.glossFrame).toHaveBeenCalledTimes(2);
    expect([...glossCache.values()].map((item) => item.display)).toEqual(["新译"]);
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
  };
}

function frameReply(input: GlossFrameBackendInput, display: string): GlossBackendOutput {
  return { items: input.items.map(({requestItemId, token}) => ({requestItemId, value: {targetText: token.surface, display}})) };
}

function startSession(resolver: ReturnType<typeof createGlossResolver>, tokenId: string, word: string) {
  const events: GlossTokenOutcome[] = [];
  const session = resolver.createSession("https://example.test/" + tokenId, testSettings(), 100, { emit: (event) => events.push(event) });
  const done = session.acceptChunk(tokenId, 0, [{ id: tokenId, text: word, tokens: [{id:tokenId,sentenceId:tokenId,surface:word,lemma:word,startOffset:0,endOffset:word.length}] }]).then(() => session.finish());
  return { session, events, done };
}
