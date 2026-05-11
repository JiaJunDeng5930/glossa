import { describe, expect, it, vi } from "vitest";

import { buildGlossCacheKey } from "../../src/core/cache";
import { createGlossResolver } from "../../src/background/glossResolver";
import type { ExtensionStorage } from "../../src/storage/db";
import { DEFAULT_SETTINGS, GLOSS_TARGET_LANG, type AnkiCardOutput, type CardedWordRecord, type GlossaSettings, type GlossItem, type GlossTokenPayload, type VocabularyRecord, type VocabularyState } from "../../src/shared/types";

// @verifies glossa.page_translation.lookup_order
// @verifies glossa.cache_identity.text_hash
describe("gloss resolver lookup-first pipeline", () => {
  it("emits hidden, ready, pending and AI ready outcomes in lookup order", async () => {
    const storage = createMemoryStorage();
    const settings = testSettings();
    await storage.settings.set(settings);
    await storage.lexicon.put(record("known", "known"));
    await storage.lexicon.put(record("ignored", "ignored"));
    await storage.lexicon.put(record("cached", "learning_active"));
    await storage.glossCache.put(await cacheKey(settings, "Known ignored cached novel words.", "cached", 14, 20), {
      tokenId: "old-cached",
      targetText: "cached",
      display: "缓存"
    });
    const ai = {
      gloss: vi.fn(),
      glossFrame: vi.fn(async () => ({
        items: [{ tokenId: "t-novel", targetText: "novel", display: "新词" }]
      })),
      ankiCard: vi.fn()
    };
    const resolver = createGlossResolver({ storage, ai });
    const events: Array<Omit<GlossTokenPayload, "scanId">> = [];

    await resolver.resolve("https://example.test/page", [{
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
  });

  it("replays page memory before shown state hides a rescan token", async () => {
    const storage = createMemoryStorage();
    const settings = testSettings();
    await storage.settings.set(settings);
    const ai = {
      gloss: vi.fn(),
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

    await resolver.resolve("https://example.test/a", [{
      id: "s1",
      text: sentence,
      tokens: [{ id: "t-first", sentenceId: "s1", surface: "novel", lemma: "novel", startOffset: 2, endOffset: 7 }]
    }], settings, 100, { emit: (event) => firstEvents.push(event) });
    await resolver.resolve("https://example.test/a", [{
      id: "s2",
      text: sentence,
      tokens: [{ id: "t-second", sentenceId: "s2", surface: "novel", lemma: "novel", startOffset: 2, endOffset: 7 }]
    }], settings, 200, { emit: (event) => secondEvents.push(event) });
    await resolver.resolve("https://example.test/b", [{
      id: "s3",
      text: sentence,
      tokens: [{ id: "t-third", sentenceId: "s3", surface: "novel", lemma: "novel", startOffset: 2, endOffset: 7 }]
    }], settings, 300, { emit: (event) => otherPageEvents.push(event) });

    expect(firstEvents.map((event) => event.status)).toEqual(["pending", "ready"]);
    expect(secondEvents).toEqual([
      { tokenId: "t-second", status: "ready", item: { tokenId: "t-second", targetText: "novel", display: "新词" } }
    ]);
    expect(otherPageEvents).toEqual([{ tokenId: "t-third", status: "hidden" }]);
    expect(ai.glossFrame).toHaveBeenCalledTimes(1);
  });

  // @verifies glossa.settings_save.clear_gloss_cache.memory_replay
  it("clears page memory replay after durable gloss cache clearing", async () => {
    const storage = createMemoryStorage();
    const settings = testSettings();
    await storage.settings.set(settings);
    const ai = {
      gloss: vi.fn(),
      glossFrame: vi.fn(async () => ({
        items: [{ tokenId: "t-first", targetText: "novel", display: "新词" }]
      })),
      ankiCard: vi.fn()
    };
    const resolver = createGlossResolver({ storage, ai });
    const sentence = "A novel archive appears.";
    const secondEvents: Array<Omit<GlossTokenPayload, "scanId">> = [];

    await resolver.resolve("https://example.test/a", [{
      id: "s1",
      text: sentence,
      tokens: [{ id: "t-first", sentenceId: "s1", surface: "novel", lemma: "novel", startOffset: 2, endOffset: 7 }]
    }], settings, 100, { emit: () => undefined });
    await storage.glossCache.clear();
    resolver.clearMemory();
    await resolver.resolve("https://example.test/a", [{
      id: "s2",
      text: sentence,
      tokens: [{ id: "t-second", sentenceId: "s2", surface: "novel", lemma: "novel", startOffset: 2, endOffset: 7 }]
    }], settings, 200, { emit: (event) => secondEvents.push(event) });

    expect(secondEvents).toEqual([{ tokenId: "t-second", status: "hidden" }]);
    expect(ai.glossFrame).toHaveBeenCalledTimes(1);
  });

  // @verifies glossa.settings_save.clear_gloss_cache.memory_replay
  it("blocks in-flight AI results from repopulating caches after clearing", async () => {
    const storage = createMemoryStorage();
    const settings = testSettings();
    await storage.settings.set(settings);
    let resolveAi!: (response: { items: GlossItem[] }) => void;
    const aiResponse = new Promise<{ items: GlossItem[] }>((resolve) => {
      resolveAi = resolve;
    });
    const ai = {
      gloss: vi.fn(),
      glossFrame: vi.fn(() => aiResponse),
      ankiCard: vi.fn()
    };
    const resolver = createGlossResolver({
      storage,
      ai,
      aiFrameMaxItems: 1,
      aiFrameMaxMs: 1_000
    });
    const sentence = "A novel archive appears.";
    const events: Array<Omit<GlossTokenPayload, "scanId">> = [];
    const key = await cacheKey(settings, sentence, "novel", 2, 7);

    const scan = resolver.resolve("https://example.test/a", [{
      id: "s1",
      text: sentence,
      tokens: [{ id: "t-first", sentenceId: "s1", surface: "novel", lemma: "novel", startOffset: 2, endOffset: 7 }]
    }], settings, 100, { emit: (event) => events.push(event) });
    await vi.waitFor(() => expect(ai.glossFrame).toHaveBeenCalledTimes(1));
    await storage.glossCache.clear();
    resolver.clearMemory();
    resolveAi({
      items: [{ tokenId: "t-first", targetText: "novel", display: "新词" }]
    });
    await scan;

    expect(events).toEqual([
      { tokenId: "t-first", status: "pending" },
      { tokenId: "t-first", status: "hidden" }
    ]);
    expect(await storage.glossCache.get(key)).toBeUndefined();
  });

  // @verifies glossa.settings_save.clear_gloss_cache.memory_replay
  it("suppresses in-flight AI failures after clearing", async () => {
    const storage = createMemoryStorage();
    const settings = testSettings();
    await storage.settings.set(settings);
    let rejectAi!: (error: Error) => void;
    const aiResponse = new Promise<{ items: GlossItem[] }>((_, reject) => {
      rejectAi = reject;
    });
    const ai = {
      gloss: vi.fn(),
      glossFrame: vi.fn(() => aiResponse),
      ankiCard: vi.fn()
    };
    const resolver = createGlossResolver({
      storage,
      ai,
      aiFrameMaxItems: 1,
      aiFrameMaxMs: 1_000
    });
    const sentence = "A novel archive appears.";
    const events: Array<Omit<GlossTokenPayload, "scanId">> = [];

    const scan = resolver.resolve("https://example.test/a", [{
      id: "s1",
      text: sentence,
      tokens: [{ id: "t-first", sentenceId: "s1", surface: "novel", lemma: "novel", startOffset: 2, endOffset: 7 }]
    }], settings, 100, { emit: (event) => events.push(event) });
    await vi.waitFor(() => expect(ai.glossFrame).toHaveBeenCalledTimes(1));
    await storage.glossCache.clear();
    resolver.clearMemory();
    rejectAi(new Error("backend unavailable"));
    await scan;

    expect(events).toEqual([
      { tokenId: "t-first", status: "pending" },
      { tokenId: "t-first", status: "hidden" }
    ]);
  });

  // @verifies glossa.settings_save.clear_gloss_cache.memory_replay
  it("holds cache reads while durable cache clearing is active", async () => {
    const storage = createMemoryStorage();
    const settings = testSettings();
    await storage.settings.set(settings);
    const sentence = "A novel archive appears.";
    await storage.glossCache.put(await cacheKey(settings, sentence, "novel", 2, 7), {
      tokenId: "old",
      targetText: "novel",
      display: "旧缓存"
    });
    const ai = {
      gloss: vi.fn(),
      glossFrame: vi.fn(async () => ({
        items: [{ tokenId: "t-first", targetText: "novel", display: "新词" }]
      })),
      ankiCard: vi.fn()
    };
    const resolver = createGlossResolver({
      storage,
      ai,
      aiFrameMaxItems: 1,
      aiFrameMaxMs: 1_000,
      dbReadCoalesceMs: 0
    });
    const events: Array<Omit<GlossTokenPayload, "scanId">> = [];
    const finishClear = resolver.beginCacheClear();

    const scan = resolver.resolve("https://example.test/a", [{
      id: "s1",
      text: sentence,
      tokens: [{ id: "t-first", sentenceId: "s1", surface: "novel", lemma: "novel", startOffset: 2, endOffset: 7 }]
    }], settings, 100, { emit: (event) => events.push(event) });
    await new Promise((resolve) => globalThis.setTimeout(resolve, 20));
    await storage.glossCache.clear();
    expect(events).toEqual([]);
    finishClear();
    await scan;

    expect(events).toEqual([
      { tokenId: "t-first", status: "pending" },
      { tokenId: "t-first", status: "ready", item: { tokenId: "t-first", targetText: "novel", display: "新词" } }
    ]);
  });

  it("groups cache misses into a size-triggered AI frame", async () => {
    const storage = createMemoryStorage();
    const settings = testSettings();
    await storage.settings.set(settings);
    const ai = {
      gloss: vi.fn(),
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

    await resolver.resolve("https://example.test/page", [{
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
      gloss: vi.fn(),
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
      resolver.resolve("https://example.test/old", [{
        id: "s-old",
        text: "A novel archive appears.",
        tokens: [{ id: "t-old", sentenceId: "s-old", surface: "novel", lemma: "novel", startOffset: 2, endOffset: 7 }]
      }], oldKeySettings, 100, { emit: (event) => oldKeyEvents.push(event) }),
      resolver.resolve("https://example.test/new", [{
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
      gloss: vi.fn(),
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

    const first = resolver.resolve("https://example.test/old", [{
      id: "s-old",
      text: sentence,
      tokens: [{ id: "t-old", sentenceId: "s-old", surface: "novel", lemma: "novel", startOffset: 2, endOffset: 7 }]
    }], oldKeySettings, 100, { emit: (event) => oldKeyEvents.push(event) });
    await vi.waitFor(() => expect(ai.glossFrame).toHaveBeenCalledTimes(1));

    const second = resolver.resolve("https://example.test/new", [{
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

  // @verifies glossa.ai_requests.failure.timeout.live_grouping
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
      gloss: vi.fn(),
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

    const first = resolver.resolve("https://example.test/short", [{
      id: "s-short",
      text: sentence,
      tokens: [{ id: "t-short", sentenceId: "s-short", surface: "novel", lemma: "novel", startOffset: 2, endOffset: 7 }]
    }], shortTimeoutSettings, 100, { emit: (event) => shortTimeoutEvents.push(event) });
    await vi.waitFor(() => expect(ai.glossFrame).toHaveBeenCalledTimes(1));

    const second = resolver.resolve("https://example.test/long", [{
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
      gloss: vi.fn(),
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

    await resolver.resolve("https://example.test/page", [{
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
      gloss: vi.fn(),
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

    const done = resolver.resolve("https://example.test/page", [{
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
      gloss: vi.fn(),
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
      gloss: vi.fn(),
      glossFrame: vi.fn(() => new Promise<{ items: Array<{ tokenId: string; targetText: string; display: string }> }>((resolve) => {
        resolveAi = resolve;
      })),
      ankiCard: vi.fn()
    };
    const resolver = createGlossResolver({ storage, ai });
    const sentence = "A novel archive appears.";
    const firstEvents: Array<Omit<GlossTokenPayload, "scanId">> = [];
    const secondEvents: Array<Omit<GlossTokenPayload, "scanId">> = [];

    const first = resolver.resolve("https://example.test/a", [{
      id: "s1",
      text: sentence,
      tokens: [{ id: "t-first", sentenceId: "s1", surface: "novel", lemma: "novel", startOffset: 2, endOffset: 7 }]
    }], settings, 100, { emit: (event) => firstEvents.push(event) });
    await vi.waitFor(() => expect(ai.glossFrame).toHaveBeenCalledTimes(1));

    const second = resolver.resolve("https://example.test/a", [{
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

  // @verifies glossa.page_translation.lookup_order.chunk_error_trace
  it("shares in-flight AI failures with duplicate lookups", async () => {
    const storage = createMemoryStorage();
    const settings = testSettings();
    await storage.settings.set(settings);
    let rejectAi: ((error: Error) => void) | undefined;
    const ai = {
      gloss: vi.fn(),
      glossFrame: vi.fn(() => new Promise<{ items: [] }>((_resolve, reject) => {
        rejectAi = reject;
      })),
      ankiCard: vi.fn()
    };
    const resolver = createGlossResolver({ storage, ai });
    const sentence = "A novel archive appears.";
    const firstEvents: Array<Omit<GlossTokenPayload, "scanId">> = [];
    const secondEvents: Array<Omit<GlossTokenPayload, "scanId">> = [];

    const first = resolver.resolve("https://example.test/a", [{
      id: "s1",
      text: sentence,
      tokens: [{ id: "t-first", sentenceId: "s1", surface: "novel", lemma: "novel", startOffset: 2, endOffset: 7 }]
    }], settings, 100, { emit: (event) => firstEvents.push(event) });
    await vi.waitFor(() => expect(ai.glossFrame).toHaveBeenCalledTimes(1));

    const second = resolver.resolve("https://example.test/a", [{
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
      gloss: vi.fn(),
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

    const first = resolver.resolve("https://example.test/a", [{
      id: "s1",
      text: sentence,
      tokens: [{ id: "t-first", sentenceId: "s1", surface: "novel", lemma: "novel", startOffset: 2, endOffset: 7 }]
    }], settings, 100, {
      emit: (event) => firstEvents.push(event),
      isActive: () => firstActive
    });
    await vi.waitFor(() => expect(ai.glossFrame).toHaveBeenCalledTimes(1));

    const second = resolver.resolve("https://example.test/a", [{
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

async function cacheKey(settings: GlossaSettings, sentence: string, targetText: string, startOffset: number, endOffset: number): Promise<string> {
  return buildGlossCacheKey({
    targetLang: GLOSS_TARGET_LANG,
    sentence,
    targetText,
    targetSpan: [startOffset, endOffset]
  });
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
        return readMany<GlossItem>(glossCache, keys);
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
