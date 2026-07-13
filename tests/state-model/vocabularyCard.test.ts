import { describe, expect, it, vi } from "vitest";

import { createGlossResolver } from "../../src/background/glossResolver";
import { createBackgroundMessageHandler } from "../../src/background/messages";
import { buildGlossCacheKey } from "../../src/core/cache";
import { createDiagnosticError } from "../../src/shared/errors";
import { createContentMessage, createOptionsMessage } from "../../src/shared/messages";
import type { ExtensionStorage } from "../../src/storage/db";
import {
  DEFAULT_SETTINGS,
  GLOSS_TARGET_LANG,
  type AnkiCardOutput,
  type CardedWordRecord,
  type ErrorReason,
  type GlossaSettings,
  type GlossCacheEntry,
  type GlossTokenPayload,
  type SentenceCandidate,
  type VocabularyRecord,
  type VocabularyState
} from "../../src/shared/types";

describe("vocabulary and card state transitions", () => {
  it("preserves a committed shown count when card creation follows it", async () => {
    const fixture = createMemoryStorage();
    const input = glossSentence("shown-token", "submit");
    await seedGloss(fixture, input, "提交");
    const resolver = createGlossResolver({
      storage: fixture.storage,
      ai: { glossFrame: vi.fn(), ankiCard: vi.fn() },
      dbReadCoalesceMs: 0
    });
    const events: Array<Omit<GlossTokenPayload, "scanId">> = [];

    await resolveScan(resolver, input, events);
    const { handler, anki } = cardHandler(fixture.storage, [{ front: "submit", back: "提交" }]);
    const response = await handler(wordMessage("submit", "shown-token"));

    expect(events.map((event) => event.status)).toEqual(["ready"]);
    expect(response).toMatchObject({ type: "word.clicked.ok", payload: { noteId: 42 } });
    expect(anki.createNote).toHaveBeenCalledTimes(1);
    expect(fixture.lexicon.get("en:submit")).toMatchObject({
      state: "learning_active",
      shownCount: 1,
      clickCount: 1,
      ankiNoteIds: [42]
    });
  });

  it("does not let a stale shown read overwrite a card transition", async () => {
    const fixture = createMemoryStorage();
    const input = glossSentence("race-token", "submit");
    await seedGloss(fixture, input, "提交");
    const shownRead = deferred<VocabularyRecord | undefined>();
    const originalGet = fixture.storage.lexicon.get;
    let getCount = 0;
    fixture.storage.lexicon.get = vi.fn((key) => {
      getCount += 1;
      return getCount === 1 ? shownRead.promise : originalGet(key);
    });
    const resolver = createGlossResolver({
      storage: fixture.storage,
      ai: { glossFrame: vi.fn(), ankiCard: vi.fn() },
      dbReadCoalesceMs: 0
    });
    const events: Array<Omit<GlossTokenPayload, "scanId">> = [];
    const scan = resolveScan(resolver, input, events);
    await vi.waitFor(() => expect(fixture.storage.lexicon.get).toHaveBeenCalledTimes(1));
    const { handler } = cardHandler(fixture.storage, [{ front: "submit", back: "提交" }]);

    const card = await handler(wordMessage("submit", "race-token"));
    shownRead.resolve(undefined);
    await scan;

    expect(card).toMatchObject({ type: "word.clicked.ok", payload: { noteId: 42 } });
    expect(fixture.lexicon.get("en:submit")).toMatchObject({
      state: "learning_active",
      shownCount: 1,
      clickCount: 1,
      ankiNoteIds: [42]
    });
  });

  it.each([
    { count: 0, cards: [] },
    {
      count: 2,
      cards: [
        { front: "first", back: "第一张" },
        { front: "second", back: "第二张" }
      ]
    }
  ])("rejects AI cardinality $count before addNote", async ({ cards }) => {
    const fixture = createMemoryStorage();
    const { handler, anki } = cardHandler(fixture.storage, cards);

    const response = await handler(wordMessage("submit"));

    expect(response).toMatchObject({
      type: "error",
      payload: { reason: "invalid-response", service: "ai" }
    });
    expect(anki.createNote).not.toHaveBeenCalled();
    expect(fixture.lexicon.get("en:submit")).toBeUndefined();
    expect(fixture.cardedWords.get("en:submit")).toBeUndefined();
  });

  it("serializes duplicate same-word commands and calls addNote at most once", async () => {
    const fixture = createMemoryStorage();
    const note = deferred<number>();
    const ai = {
      glossFrame: vi.fn(),
      ankiCard: vi.fn(async () => ({ cards: [{ front: "submit", back: "提交" }] }))
    };
    const anki = { createNote: vi.fn(() => note.promise) };
    const handler = createBackgroundMessageHandler({ storage: fixture.storage, ai, anki, now: () => 1_000 });

    const first = handler(wordMessage("submit", "same-occurrence"));
    const second = handler(wordMessage("submit", "same-occurrence"));
    await vi.waitFor(() => expect(anki.createNote).toHaveBeenCalledTimes(1));
    note.resolve(42);

    await expect(first).resolves.toMatchObject({ type: "word.clicked.ok", payload: { noteId: 42 } });
    await expect(second).resolves.toMatchObject({ type: "word.card.duplicate" });
    expect(anki.createNote).toHaveBeenCalledTimes(1);
  });

  it.each([
    { reason: "timeout", message: "Anki request timed out" },
    { reason: "network", message: "Anki connection closed" },
    { reason: "invalid-response", message: "Anki returned invalid JSON" }
  ] satisfies Array<{ reason: ErrorReason; message: string }>)
  ("reports post-submit $reason as outcome unknown without retrying", async ({ reason, message }) => {
    const fixture = createMemoryStorage();
    const ai = {
      glossFrame: vi.fn(),
      ankiCard: vi.fn(async () => ({ cards: [{ front: "submit", back: "提交" }] }))
    };
    const anki = {
      createNote: vi.fn(async () => {
        throw createDiagnosticError(reason, message, { service: "anki" });
      })
    };
    const handler = createBackgroundMessageHandler({ storage: fixture.storage, ai, anki, now: () => 1_000 });

    const response = await handler(wordMessage("submit"));

    expect(response).toMatchObject({
      type: "error",
      payload: { reason: "outcome-unknown", service: "anki" }
    });
    expect(anki.createNote).toHaveBeenCalledTimes(1);
    expect(fixture.cardedWords.get("en:submit")).toBeUndefined();
  });

  it("keeps user success after a note id when local persistence fails", async () => {
    const fixture = createMemoryStorage();
    fixture.storage.cardedWords.put = vi.fn(async () => {
      throw new Error("card marker write failed");
    });
    const { handler, anki } = cardHandler(fixture.storage, [{ front: "submit", back: "提交" }]);

    const response = await handler(wordMessage("submit"));

    expect(response).toMatchObject({ type: "word.clicked.ok", payload: { noteId: 42 } });
    expect(anki.createNote).toHaveBeenCalledTimes(1);
  });

  it("drains an earlier card, resets, then admits a later card", async () => {
    const fixture = createMemoryStorage();
    const firstNote = deferred<number>();
    const ledger: string[] = [];
    const originalReset = fixture.storage.resetCardHistory;
    fixture.storage.resetCardHistory = vi.fn(async () => {
      ledger.push("reset");
      await originalReset();
    });
    const ai = {
      glossFrame: vi.fn(),
      ankiCard: vi.fn(async ({ token }: { token: { lemma: string } }) => {
        ledger.push(`ai:${token.lemma}`);
        return { cards: [{ front: token.lemma, back: token.lemma }] };
      })
    };
    const anki = {
      createNote: vi.fn(({ token }: { token: { lemma: string } }) => {
        ledger.push(`anki:${token.lemma}`);
        return token.lemma === "submit" ? firstNote.promise : Promise.resolve(84);
      })
    };
    const handler = createBackgroundMessageHandler({ storage: fixture.storage, ai, anki, now: () => 1_000 });

    const earlier = handler(wordMessage("submit"));
    await vi.waitFor(() => expect(anki.createNote).toHaveBeenCalledTimes(1));
    const resetMessage = createOptionsMessage("card.history.reset", {});
    const reset = handler(resetMessage);
    const later = handler(wordMessage("archive"));
    await Promise.resolve();
    expect(ledger).toEqual(["ai:submit", "anki:submit"]);

    firstNote.resolve(42);
    await expect(earlier).resolves.toMatchObject({ type: "word.clicked.ok", payload: { noteId: 42 } });
    await expect(reset).resolves.toMatchObject({ type: "card.history.reset.ok" });
    await expect(later).resolves.toMatchObject({ type: "word.clicked.ok", payload: { noteId: 84 } });

    expect(ledger).toEqual(["ai:submit", "anki:submit", "reset", "ai:archive", "anki:archive"]);
    expect(fixture.cardedWords.get("en:submit")).toBeUndefined();
    expect(fixture.cardedWords.get("en:archive")).toMatchObject({ lemma: "archive" });
  });
});

function cardHandler(storage: ExtensionStorage, cards: Array<{ front: string; back: string }>) {
  const ai = { glossFrame: vi.fn(), ankiCard: vi.fn(async () => ({ cards })) };
  const anki = { createNote: vi.fn(async () => 42) };
  return { handler: createBackgroundMessageHandler({ storage, ai, anki, now: () => 1_000 }), ai, anki };
}

function wordMessage(lemma: string, tokenId = `${lemma}-token`) {
  return createContentMessage("word.clicked", {
    pageUrl: "https://example.test/page",
    sentence: `A ${lemma} word.`,
    token: {
      id: tokenId,
      sentenceId: `${lemma}-sentence`,
      surface: lemma,
      lemma,
      startOffset: 2,
      endOffset: 2 + lemma.length
    }
  });
}

function glossSentence(tokenId: string, word: string): SentenceCandidate[] {
  return [{
    id: `${word}-sentence`,
    text: `A ${word} word.`,
    tokens: [{
      id: tokenId,
      sentenceId: `${word}-sentence`,
      surface: word,
      lemma: word,
      startOffset: 2,
      endOffset: 2 + word.length
    }]
  }];
}

async function seedGloss(fixture: ReturnType<typeof createMemoryStorage>, input: SentenceCandidate[], display: string): Promise<void> {
  const sentence = input[0]!;
  const token = sentence.tokens[0]!;
  const key = await buildGlossCacheKey({
    targetLang: GLOSS_TARGET_LANG,
    sentence: sentence.text,
    targetText: token.surface,
    targetSpan: [token.startOffset, token.endOffset],
    settings: DEFAULT_SETTINGS
  });
  await fixture.storage.glossCache.put(key, {
    tokenId: token.id,
    targetText: token.surface,
    display,
    createdAt: 100
  });
}

async function resolveScan(
  resolver: ReturnType<typeof createGlossResolver>,
  sentences: SentenceCandidate[],
  events: Array<Omit<GlossTokenPayload, "scanId">>
): Promise<void> {
  const session = resolver.createSession("https://example.test/page", DEFAULT_SETTINGS, 200, {
    emit: (event) => events.push(event)
  });
  await session.acceptChunk("chunk-0", 0, sentences);
  await session.finish();
}

function createMemoryStorage(): {
  storage: ExtensionStorage;
  lexicon: Map<string, VocabularyRecord>;
  cardedWords: Map<string, CardedWordRecord>;
} {
  let storedSettings: GlossaSettings = DEFAULT_SETTINGS;
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
      for (const [key, record] of lexicon) {
        lexicon.set(key, { ...record, ankiNoteIds: [] });
      }
    }
  };
  return { storage, lexicon, cardedWords };
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
