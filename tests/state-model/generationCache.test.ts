import { describe, expect, it, vi } from "vitest";

import { createGlossResolver } from "../../src/background/glossResolver";
import { buildGlossCacheKey, glossGenerationIdentity } from "../../src/core/cache";
import type { ExtensionStorage } from "../../src/storage/db";
import {
  DEFAULT_SETTINGS,
  GLOSS_TARGET_LANG,
  type AnkiCardOutput,
  type CardedWordRecord,
  type GlossaSettings,
  type GlossCacheEntry,
  type GlossTokenPayload,
  type SentenceCandidate,
  type VocabularyRecord,
  type VocabularyState
} from "../../src/shared/types";

describe("generation and cache state transitions", () => {
  it("retires an obsolete generation before its AI result can emit or persist", async () => {
    const fixture = createMemoryStorage();
    const oldSettings = settings("old-model");
    const newSettings = settings("new-model");
    const oldEvents: Array<Omit<GlossTokenPayload, "scanId">> = [];
    const newEvents: Array<Omit<GlossTokenPayload, "scanId">> = [];
    const ai = {
      glossFrame: vi.fn((input: { settings: GlossaSettings; items: Array<{ token: { id: string; surface: string } }>; signal?: AbortSignal }) => {
        if (input.settings.modelVersion === "old-model") {
          return new Promise<{ items: Array<{ tokenId: string; targetText: string; display: string }> }>((_resolve, reject) => {
            input.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
          });
        }
        return Promise.resolve({
          items: input.items.map(({ token }) => ({ tokenId: token.id, targetText: token.surface, display: "新版" }))
        });
      }),
      ankiCard: vi.fn()
    };
    const resolver = createGlossResolver({ storage: fixture.storage, ai, aiFrameMaxMs: 1, dbReadCoalesceMs: 0 });
    await resolver.activateGeneration(glossGenerationIdentity(oldSettings));

    const oldScan = resolveScan(resolver, sentence("old-token", "novel"), oldSettings, 100, oldEvents);
    await vi.waitFor(() => expect(ai.glossFrame).toHaveBeenCalledTimes(1));

    await resolver.activateGeneration(glossGenerationIdentity(newSettings));
    const newScan = resolveScan(resolver, sentence("new-token", "archive"), newSettings, 200, newEvents);
    await Promise.all([oldScan, newScan]);

    expect(oldEvents).toEqual([{ tokenId: "old-token", status: "pending" }]);
    expect(newEvents).toEqual([
      { tokenId: "new-token", status: "pending" },
      { tokenId: "new-token", status: "ready", item: { tokenId: "new-token", targetText: "archive", display: "新版" } }
    ]);
    expect(Array.from(fixture.glossCache.values())).toEqual([
      expect.objectContaining({ tokenId: "new-token", display: "新版", createdAt: 200 })
    ]);
  });

  it("does not let an AI cache put cross a completed manual clear", async () => {
    const fixture = createMemoryStorage();
    const activeSettings = settings("active-model");
    const response = deferred<{ items: Array<{ tokenId: string; targetText: string; display: string }> }>();
    const ai = {
      glossFrame: vi.fn(() => response.promise),
      ankiCard: vi.fn()
    };
    const resolver = createGlossResolver({ storage: fixture.storage, ai, aiFrameMaxMs: 1, dbReadCoalesceMs: 0 });
    await resolver.activateGeneration(glossGenerationIdentity(activeSettings));
    const events: Array<Omit<GlossTokenPayload, "scanId">> = [];
    const scan = resolveScan(resolver, sentence("stale-token", "stale"), activeSettings, 100, events);
    await vi.waitFor(() => expect(ai.glossFrame).toHaveBeenCalledTimes(1));

    await resolver.clearCache();
    response.resolve({ items: [{ tokenId: "stale-token", targetText: "stale", display: "旧结果" }] });
    await scan;

    expect(events).toEqual([{ tokenId: "stale-token", status: "pending" }]);
    expect(fixture.glossCache.size).toBe(0);
  });

  it("does not replay a cache read that completed after a manual clear", async () => {
    const fixture = createMemoryStorage();
    const activeSettings = settings("active-model");
    const read = deferred<Map<string, GlossCacheEntry>>();
    fixture.storage.glossCache.getFreshMany = vi.fn(() => read.promise);
    const ai = { glossFrame: vi.fn(), ankiCard: vi.fn() };
    const resolver = createGlossResolver({ storage: fixture.storage, ai, aiFrameMaxMs: 1, dbReadCoalesceMs: 0 });
    await resolver.activateGeneration(glossGenerationIdentity(activeSettings));
    const input = sentence("cached-token", "cached");
    const events: Array<Omit<GlossTokenPayload, "scanId">> = [];
    const scan = resolveScan(resolver, input, activeSettings, 100, events);
    await vi.waitFor(() => expect(fixture.storage.glossCache.getFreshMany).toHaveBeenCalledTimes(1));
    const key = await cacheKey(input[0]!, activeSettings);

    await resolver.clearCache();
    read.resolve(new Map([[key, { tokenId: "old-token", targetText: "cached", display: "旧缓存", createdAt: 50 }]]));
    await scan;

    expect(events).toEqual([]);
    expect(ai.glossFrame).not.toHaveBeenCalled();
    expect(fixture.glossCache.size).toBe(0);
  });

  it("holds a session created during manual clear behind the clear barrier", async () => {
    const fixture = createMemoryStorage();
    const activeSettings = settings("active-model");
    const input = sentence("fresh-token", "fresh");
    const key = await cacheKey(input[0]!, activeSettings);
    fixture.glossCache.set(key, {
      tokenId: "old-token",
      targetText: "fresh",
      display: "旧缓存",
      createdAt: 50
    });
    const clearGate = deferred<void>();
    fixture.storage.glossCache.clear = vi.fn(async () => {
      await clearGate.promise;
      fixture.glossCache.clear();
    });
    const originalRead = fixture.storage.glossCache.getFreshMany;
    fixture.storage.glossCache.getFreshMany = vi.fn((keys, now, ttlMs) => originalRead(keys, now, ttlMs));
    const ai = {
      glossFrame: vi.fn(async () => ({ items: [{ tokenId: "fresh-token", targetText: "fresh", display: "新结果" }] })),
      ankiCard: vi.fn()
    };
    const resolver = createGlossResolver({ storage: fixture.storage, ai, aiFrameMaxMs: 1, dbReadCoalesceMs: 0 });
    await resolver.activateGeneration(glossGenerationIdentity(activeSettings));

    const clear = resolver.clearCache();
    const events: Array<Omit<GlossTokenPayload, "scanId">> = [];
    const scan = resolveScan(resolver, input, activeSettings, 100, events);
    await Promise.resolve();
    expect(fixture.storage.glossCache.getFreshMany).not.toHaveBeenCalled();

    clearGate.resolve(undefined);
    await Promise.all([clear, scan]);

    expect(fixture.storage.glossCache.getFreshMany).toHaveBeenCalledTimes(1);
    expect(events).toEqual([
      { tokenId: "fresh-token", status: "pending" },
      { tokenId: "fresh-token", status: "ready", item: { tokenId: "fresh-token", targetText: "fresh", display: "新结果" } }
    ]);
  });
});

function settings(modelVersion: string): GlossaSettings {
  return { ...DEFAULT_SETTINGS, modelVersion, glossCacheTtlMs: 1_000 };
}

function sentence(tokenId: string, word: string): SentenceCandidate[] {
  return [{
    id: `sentence-${tokenId}`,
    text: `A ${word} word.`,
    tokens: [{
      id: tokenId,
      sentenceId: `sentence-${tokenId}`,
      surface: word,
      lemma: word,
      startOffset: 2,
      endOffset: 2 + word.length
    }]
  }];
}

async function resolveScan(
  resolver: ReturnType<typeof createGlossResolver>,
  sentences: SentenceCandidate[],
  activeSettings: GlossaSettings,
  now: number,
  events: Array<Omit<GlossTokenPayload, "scanId">>
): Promise<void> {
  const session = resolver.createSession("https://example.test/page", activeSettings, now, {
    emit: (event) => events.push(event)
  });
  await session.acceptChunk("chunk-0", 0, sentences);
  await session.finish();
}

async function cacheKey(input: SentenceCandidate, activeSettings: GlossaSettings): Promise<string> {
  const token = input.tokens[0]!;
  return buildGlossCacheKey({
    targetLang: GLOSS_TARGET_LANG,
    sentence: input.text,
    targetText: token.surface,
    targetSpan: [token.startOffset, token.endOffset],
    settings: activeSettings
  });
}

function createMemoryStorage(): {
  storage: ExtensionStorage;
  glossCache: Map<string, GlossCacheEntry>;
} {
  let storedSettings = DEFAULT_SETTINGS;
  const lexicon = new Map<string, VocabularyRecord>();
  const glossCache = new Map<string, GlossCacheEntry>();
  const cardCache = new Map<string, AnkiCardOutput>();
  const cardedWords = new Map<string, CardedWordRecord>();
  const readMany = <T>(store: Map<string, T>, keys: string[]) => new Map(
    keys.flatMap((key) => store.has(key) ? [[key, store.get(key)!] as const] : [])
  );
  const storage: ExtensionStorage = {
    settings: {
      async get() { return storedSettings; },
      async set(value) { storedSettings = value; }
    },
    lexicon: {
      async get(key) { return lexicon.get(key); },
      async getMany(keys) { return readMany(lexicon, keys); },
      async listByState(state: VocabularyState) { return Array.from(lexicon.values()).filter((record) => record.state === state); },
      async update(key, transition) {
        const next = transition(lexicon.get(key));
        if (next) lexicon.set(key, next); else lexicon.delete(key);
        return next;
      },
      async put(record) { lexicon.set(record.key, record); },
      async delete(key) { lexicon.delete(key); }
    },
    glossCache: {
      async get(key) { return glossCache.get(key); },
      async getMany(keys) { return readMany(glossCache, keys); },
      async getFresh(key, now, ttlMs) {
        const value = glossCache.get(key);
        return value && now < value.createdAt + ttlMs ? value : undefined;
      },
      async getFreshMany(keys, now, ttlMs) {
        return new Map(Array.from(readMany(glossCache, keys)).filter(([, value]) => now < value.createdAt + ttlMs));
      },
      async put(key, value) { glossCache.set(key, value); },
      async delete(key) { glossCache.delete(key); },
      async clear() { glossCache.clear(); }
    },
    cardCache: keyValueStore(cardCache, readMany),
    cardedWords: keyValueStore(cardedWords, readMany),
    async resetCardHistory() {
      cardCache.clear();
      cardedWords.clear();
    }
  };
  return { storage, glossCache };
}

function keyValueStore<T>(store: Map<string, T>, readMany: <V>(store: Map<string, V>, keys: string[]) => Map<string, V>) {
  return {
    async get(key: string) { return store.get(key); },
    async getMany(keys: string[]) { return readMany(store, keys); },
    async put(key: string, value: T) { store.set(key, value); },
    async delete(key: string) { store.delete(key); },
    async clear() { store.clear(); }
  };
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => { resolve = innerResolve; });
  return { promise, resolve };
}
