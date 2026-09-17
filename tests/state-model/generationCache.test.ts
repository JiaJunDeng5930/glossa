import { createMemoryStorage } from "../helpers/memoryStorage";
import { deferred } from "./asyncHarness";
import type { GlossFrameBackendInput, GlossBackendOutput } from "../../src/shared/services/aiClient";
import { describe, expect, it, vi } from "vitest";

import { createGlossResolver } from "../../src/background/glossResolver";
import { buildGlossCacheKey, glossGenerationIdentity } from "../../src/core/cache";
import {
  DEFAULT_SETTINGS,
  GLOSS_TARGET_LANG,
  type GlossaSettings,
  type GlossCacheEntry,
  type GlossTokenOutcome,
  type SentenceCandidate,
  type VocabularyState
} from "../../src/shared/types";

describe("generation and cache state transitions", () => {
  it("retires an obsolete generation before its AI result can emit or persist", async () => {
    const fixture = createMemoryStorage();
    const oldSettings = settings("old-model");
    const newSettings = settings("new-model");
    const oldEvents: Array<GlossTokenOutcome> = [];
    const newEvents: Array<GlossTokenOutcome> = [];
    const ai = {
      glossFrame: vi.fn((input: GlossFrameBackendInput) => {
        if (input.settings.modelVersion === "old-model") {
          return new Promise<GlossBackendOutput>((_resolve, reject) => {
            input.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
          });
        }
        return Promise.resolve({
          items: input.items.map(({ requestItemId, token }) => ({ requestItemId, value: { targetText: token.surface, display: "新版" } }))
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
      expect.objectContaining({ display: "新版", createdAt: 200 })
    ]);
  });

  it("settles in-flight AI without repopulating caches after a manual clear", async () => {
    const fixture = createMemoryStorage();
    const activeSettings = settings("active-model");
    const response = deferred<GlossBackendOutput>();
    const ai = {
      glossFrame: vi.fn((_input: GlossFrameBackendInput) => response.promise),
      ankiCard: vi.fn()
    };
    const resolver = createGlossResolver({ storage: fixture.storage, ai, aiFrameMaxMs: 1, dbReadCoalesceMs: 0 });
    await resolver.activateGeneration(glossGenerationIdentity(activeSettings));
    const events: Array<GlossTokenOutcome> = [];
    const scan = resolveScan(resolver, sentence("stale-token", "stale"), activeSettings, 100, events);
    await vi.waitFor(() => expect(ai.glossFrame).toHaveBeenCalledTimes(1));

    await resolver.clearCache();
    response.resolve(frameReply(ai.glossFrame.mock.calls.at(-1)![0], "旧结果"));
    await scan;

    expect(events).toEqual([
      { tokenId: "stale-token", status: "pending" },
      { tokenId: "stale-token", status: "ready", item: { tokenId: "stale-token", targetText: "stale", display: "旧结果" } }
    ]);
    expect(fixture.glossCache.size).toBe(0);

    const replayEvents: Array<GlossTokenOutcome> = [];
    await resolveScan(resolver, sentence("replay-token", "stale"), activeSettings, 200, replayEvents);
    expect(replayEvents).toEqual([{ tokenId: "replay-token", status: "hidden" }]);
    expect(ai.glossFrame).toHaveBeenCalledTimes(1);
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
    const events: Array<GlossTokenOutcome> = [];
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
      glossFrame: vi.fn(async (input: GlossFrameBackendInput) => frameReply(input, "新结果")),
      ankiCard: vi.fn()
    };
    const resolver = createGlossResolver({ storage: fixture.storage, ai, aiFrameMaxMs: 1, dbReadCoalesceMs: 0 });
    await resolver.activateGeneration(glossGenerationIdentity(activeSettings));

    const clear = resolver.clearCache();
    const events: Array<GlossTokenOutcome> = [];
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
  events: Array<GlossTokenOutcome>
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

function frameReply(input: GlossFrameBackendInput, display: string): GlossBackendOutput {
  return { items: input.items.map(({requestItemId, token}) => ({requestItemId, value: {targetText: token.surface, display}})) };
}
