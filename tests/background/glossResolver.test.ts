import { describe, expect, it, vi } from "vitest";

import { buildGlossCacheKey } from "../../src/core/cache";
import { createGlossResolver } from "../../src/background/glossResolver";
import { hashText } from "../../src/shared/hash";
import type { ExtensionStorage } from "../../src/storage/db";
import { DEFAULT_SETTINGS, GLOSS_TARGET_LANG, type AnkiCardOutput, type GlossaSettings, type GlossItem, type GlossTokenPayload, type VocabularyRecord } from "../../src/shared/types";

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
      items: [
        expect.objectContaining({ token: expect.objectContaining({ id: "t-novel" }) }),
        expect.objectContaining({ token: expect.objectContaining({ id: "t-obscure" }) })
      ]
    }));
    expect(events).toEqual(expect.arrayContaining([
      { tokenId: "t-novel", status: "pending" },
      { tokenId: "t-obscure", status: "pending" },
      { tokenId: "t-novel", status: "ready", item: { tokenId: "t-novel", targetText: "novel", display: "新词" } },
      { tokenId: "t-obscure", status: "ready", item: { tokenId: "t-obscure", targetText: "obscure", display: "晦涩" } }
    ]));
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
    ai: { provider: "glossa-backend", endpoint: "https://ai.example.test", reasoningEffort: "medium" }
  };
}

async function cacheKey(settings: GlossaSettings, sentence: string, targetText: string, startOffset: number, endOffset: number): Promise<string> {
  const promptVersion = [
    settings.promptVersion,
    settings.ai.provider,
    settings.ai.reasoningEffort,
    await hashText(settings.prompts.gloss)
  ].join(":");
  return buildGlossCacheKey({
    targetLang: GLOSS_TARGET_LANG,
    sentence,
    targetText,
    targetSpan: [startOffset, endOffset],
    promptVersion,
    modelVersion: settings.modelVersion
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
      async put(value) {
        lexicon.set(value.key, value);
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
      }
    },
    cardCache: {
      async get(key) {
        return cardCache.get(key) as never;
      },
      async getMany(keys) {
        return readMany<AnkiCardOutput & { noteIds?: number[] }>(cardCache, keys);
      },
      async put(key, value) {
        cardCache.set(key, value);
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
