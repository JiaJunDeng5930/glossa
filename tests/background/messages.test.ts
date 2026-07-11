import { describe, expect, it, vi } from "vitest";

import { createBackgroundMessageHandler } from "../../src/background/messages";
import type { AnkiClient } from "../../src/background/anki";
import { buildCardCacheKey } from "../../src/core/cache";
import { hashText } from "../../src/shared/hash";
import { createContentMessage } from "../../src/shared/messages";
import type { ExtensionStorage } from "../../src/storage/db";
import { DEFAULT_SETTINGS, GLOSS_TARGET_LANG, type AnkiCardOutput, type CardedWordRecord, type GlossCacheEntry, type VocabularyRecord, type VocabularyState } from "../../src/shared/types";

describe("background message handler", () => {
  it("marks clicked words as learning_active and creates an Anki note through the background", async () => {
    const storage = createMemoryStorage();
    await storage.settings.set({
      ...DEFAULT_SETTINGS,
      shortcutKey: "Alt",
      learningWindowDays: 3,
      promptVersion: "gloss-v1",
      modelVersion: "gpt-4.1-mini",
      ai: { ...DEFAULT_SETTINGS.ai, provider: "glossa-backend", endpoint: "https://ai.example.test", reasoningEffort: "medium" },
      anki: { ...DEFAULT_SETTINGS.anki, endpoint: "http://127.0.0.1:8765", deck: "Glossa", modelName: "Basic" }
    });
    const message = createContentMessage("word.clicked", {
      pageUrl: "https://example.test",
      sentence: "A submit button finishes the form.",
      token: { id: "t2", sentenceId: "s1", surface: "submit", lemma: "submit", startOffset: 2, endOffset: 8 }
    });
    const ai = {
      glossFrame: vi.fn(),
      ankiCard: vi.fn(async () => ({
        cards: [
          { front: "A <b>submit</b> button finishes the form.", back: "提交" },
          { front: "Click <b>submit</b> after reviewing.", back: "提交按钮" }
        ]
      }))
    };
    const anki = { createNote: vi.fn(async (_input: unknown) => anki.createNote.mock.calls.length === 1 ? 42 : 43) };

    const handler = createBackgroundMessageHandler({ storage, ai, anki, now: () => 1_000 });
    const response = await handler(message);

    expect(response).toMatchObject({ type: "word.clicked.ok", requestId: message.requestId, payload: { noteId: 42 } });
    expect(anki.createNote).toHaveBeenCalledTimes(2);
    expect(await storage.lexicon.get("en:submit")).toMatchObject({
      state: "learning_active",
      clickCount: 1,
      ankiNoteIds: [42, 43]
    });
    expect(await storage.cardedWords.get("en:submit")).toMatchObject({
      key: "en:submit",
      lang: "en",
      lemma: "submit",
      createdAt: 1_000
    });
  });

  it("starts generated card note writes in the same Anki request window", async () => {
    const storage = createMemoryStorage();
    await storage.settings.set(DEFAULT_SETTINGS);
    const message = createContentMessage("word.clicked", {
      pageUrl: "https://example.test",
      sentence: "A submit button finishes the form.",
      token: { id: "t2", sentenceId: "s1", surface: "submit", lemma: "submit", startOffset: 2, endOffset: 8 }
    });
    const ai = {
      glossFrame: vi.fn(),
      ankiCard: vi.fn(async () => ({
        cards: [
          { front: "A <b>submit</b> button finishes the form.", back: "提交" },
          { front: "Click <b>submit</b> after reviewing.", back: "提交按钮" }
        ]
      }))
    };
    const firstNote = deferred<number>();
    const secondNote = deferred<number>();
    const anki = {
      createNote: vi.fn(() => anki.createNote.mock.calls.length === 1 ? firstNote.promise : secondNote.promise)
    };

    const handler = createBackgroundMessageHandler({ storage, ai, anki, now: () => 1_000 });
    const response = handler(message);

    await vi.waitFor(() => {
      expect(anki.createNote).toHaveBeenCalledTimes(2);
    });
    firstNote.resolve(42);
    secondNote.resolve(43);

    await expect(response).resolves.toMatchObject({ type: "word.clicked.ok", payload: { noteId: 42 } });
  });

  it("persists successful note ids before reporting a partial Anki failure", async () => {
    const storage = createMemoryStorage();
    await storage.settings.set(DEFAULT_SETTINGS);
    const message = createContentMessage("word.clicked", {
      pageUrl: "https://example.test",
      sentence: "A submit button finishes the form.",
      token: { id: "t2", sentenceId: "s1", surface: "submit", lemma: "submit", startOffset: 2, endOffset: 8 }
    });
    const ai = {
      glossFrame: vi.fn(),
      ankiCard: vi.fn(async () => ({
        cards: [
          { front: "A <b>submit</b> button finishes the form.", back: "提交" },
          { front: "Click <b>submit</b> after reviewing.", back: "提交按钮" }
        ]
      }))
    };
    const anki = {
      createNote: vi.fn(async () => {
        if (anki.createNote.mock.calls.length === 1) {
          return 42;
        }
        throw new Error("AnkiConnect request failed");
      })
    };

    const handler = createBackgroundMessageHandler({ storage, ai, anki, now: () => 1_000 });
    const response = await handler(message);

    expect(response).toMatchObject({ type: "error" });
    expect(await storage.lexicon.get("en:submit")).toMatchObject({ ankiNoteIds: [42] });
    expect(await storage.cardedWords.get("en:submit")).toMatchObject({
      key: "en:submit",
      lang: "en",
      lemma: "submit",
      createdAt: 1_000
    });
  });

  it("reports Anki failure without card history when every note write fails", async () => {
    const storage = createMemoryStorage();
    await storage.settings.set(DEFAULT_SETTINGS);
    const message = createContentMessage("word.clicked", {
      pageUrl: "https://example.test",
      sentence: "A submit button finishes the form.",
      token: { id: "t2", sentenceId: "s1", surface: "submit", lemma: "submit", startOffset: 2, endOffset: 8 }
    });
    const ai = {
      glossFrame: vi.fn(),
      ankiCard: vi.fn(async () => ({
        cards: [
          { front: "A <b>submit</b> button finishes the form.", back: "提交" },
          { front: "Click <b>submit</b> after reviewing.", back: "提交按钮" }
        ]
      }))
    };
    const anki = {
      createNote: vi.fn(async () => {
        throw new Error("AnkiConnect request failed");
      })
    };

    const handler = createBackgroundMessageHandler({ storage, ai, anki, now: () => 1_000 });
    const response = await handler(message);

    expect(response).toMatchObject({ type: "error" });
    expect(await storage.lexicon.get("en:submit")).toBeUndefined();
    expect(await storage.cardedWords.get("en:submit")).toBeUndefined();
  });

  it("returns duplicate-card confirmation before creating another note for a carded word", async () => {
    const storage = createMemoryStorage();
    await storage.settings.set(DEFAULT_SETTINGS);
    await storage.cardedWords.put("en:submit", { key: "en:submit", lang: "en", lemma: "submit", createdAt: 500 });
    const message = createContentMessage("word.clicked", {
      pageUrl: "https://example.test",
      sentence: "A submit button finishes the form.",
      token: { id: "t2", sentenceId: "s1", surface: "submit", lemma: "submit", startOffset: 2, endOffset: 8 }
    });
    const ai = {
      glossFrame: vi.fn(),
      ankiCard: vi.fn(async () => ({ cards: [{ front: "A <b>submit</b> button finishes the form.", back: "提交" }] }))
    };
    const anki = { createNote: vi.fn(async () => 42) };

    const handler = createBackgroundMessageHandler({ storage, ai, anki, now: () => 1_000 });
    const response = await handler(message);

    expect(response).toMatchObject({
      type: "word.card.duplicate",
      requestId: message.requestId,
      payload: { lang: "en", lemma: "submit", surface: "submit", promptMs: 5_000 }
    });
    expect(ai.ankiCard).not.toHaveBeenCalled();
    expect(anki.createNote).not.toHaveBeenCalled();
    expect(await storage.lexicon.get("en:submit")).toBeUndefined();
  });

  it("rechecks duplicate state after overlapping same-word card creation settles", async () => {
    const storage = createMemoryStorage();
    await storage.settings.set(DEFAULT_SETTINGS);
    const firstMessage = createContentMessage("word.clicked", {
      pageUrl: "https://example.test",
      sentence: "A submit button finishes the form.",
      token: { id: "t2", sentenceId: "s1", surface: "submit", lemma: "submit", startOffset: 2, endOffset: 8 }
    });
    const secondMessage = createContentMessage("word.clicked", {
      pageUrl: "https://example.test",
      sentence: "A submit button finishes the form.",
      token: { id: "t2", sentenceId: "s1", surface: "submit", lemma: "submit", startOffset: 2, endOffset: 8 }
    });
    const ai = {
      glossFrame: vi.fn(),
      ankiCard: vi.fn(async () => ({ cards: [{ front: "A <b>submit</b> button finishes the form.", back: "提交" }] }))
    };
    const note = deferred<number>();
    const anki = { createNote: vi.fn(() => note.promise) };

    const handler = createBackgroundMessageHandler({ storage, ai, anki, now: () => 1_000 });
    const first = handler(firstMessage);
    await vi.waitFor(() => {
      expect(anki.createNote).toHaveBeenCalledTimes(1);
    });
    const second = handler(secondMessage);
    await Promise.resolve();

    expect(ai.ankiCard).toHaveBeenCalledTimes(1);
    expect(anki.createNote).toHaveBeenCalledTimes(1);
    note.resolve(42);

    await expect(first).resolves.toMatchObject({ type: "word.clicked.ok", payload: { noteId: 42 } });
    await expect(second).resolves.toMatchObject({
      type: "word.card.duplicate",
      requestId: secondMessage.requestId,
      payload: { lang: "en", lemma: "submit", surface: "submit", promptMs: 5_000 }
    });
    expect(ai.ankiCard).toHaveBeenCalledTimes(1);
    expect(anki.createNote).toHaveBeenCalledTimes(1);
  });

  it("returns duplicate-card confirmation when existing vocabulary already has Anki note ids", async () => {
    const storage = createMemoryStorage();
    await storage.settings.set(DEFAULT_SETTINGS);
    await storage.lexicon.put({
      key: "en:submit",
      lang: "en",
      lemma: "submit",
      surface: "submit",
      state: "learning_active",
      shownCount: 1,
      clickCount: 1,
      ankiNoteIds: [99]
    });
    const message = createContentMessage("word.clicked", {
      pageUrl: "https://example.test",
      sentence: "A submit button finishes the form.",
      token: { id: "t2", sentenceId: "s1", surface: "submit", lemma: "submit", startOffset: 2, endOffset: 8 }
    });
    const ai = { glossFrame: vi.fn(), ankiCard: vi.fn() };
    const anki = { createNote: vi.fn() };

    const handler = createBackgroundMessageHandler({ storage, ai, anki, now: () => 1_000 });
    const response = await handler(message);

    expect(response).toMatchObject({
      type: "word.card.duplicate",
      payload: { lang: "en", lemma: "submit", surface: "submit", promptMs: 5_000 }
    });
    expect(ai.ankiCard).not.toHaveBeenCalled();
    expect(anki.createNote).not.toHaveBeenCalled();
  });

  it("creates another note for a carded word after explicit confirmation", async () => {
    const storage = createMemoryStorage();
    await storage.settings.set(DEFAULT_SETTINGS);
    await storage.cardedWords.put("en:submit", { key: "en:submit", lang: "en", lemma: "submit", createdAt: 500 });
    const message = createContentMessage("word.clicked", {
      pageUrl: "https://example.test",
      sentence: "A submit button finishes the form.",
      token: { id: "t2", sentenceId: "s1", surface: "submit", lemma: "submit", startOffset: 2, endOffset: 8 },
      allowDuplicateCard: true
    });
    const ai = {
      glossFrame: vi.fn(),
      ankiCard: vi.fn(async () => ({ cards: [{ front: "A <b>submit</b> button finishes the form.", back: "提交" }] }))
    };
    const anki = { createNote: vi.fn(async () => 42) };

    const handler = createBackgroundMessageHandler({ storage, ai, anki, now: () => 1_000 });
    const response = await handler(message);

    expect(response).toMatchObject({ type: "word.clicked.ok", payload: { noteId: 42 } });
    expect(await storage.cardedWords.get("en:submit")).toMatchObject({ createdAt: 1_000 });
  });

  it("reuses cached card content across provider and reasoning changes", async () => {
    const storage = createMemoryStorage();
    await storage.settings.set({
      ...DEFAULT_SETTINGS,
      promptVersion: "gloss-v1",
      prompts: { ...DEFAULT_SETTINGS.prompts, ankiCard: "Create one card." },
      ai: { ...DEFAULT_SETTINGS.ai, provider: "glossa-backend", endpoint: "https://ai.example.test", reasoningEffort: "medium" }
    });
    const message = createContentMessage("word.clicked", {
      pageUrl: "https://example.test",
      sentence: "A submit button finishes the form.",
      token: { id: "t2", sentenceId: "s1", surface: "submit", lemma: "submit", startOffset: 2, endOffset: 8 }
    });
    const ai = {
      glossFrame: vi.fn(),
      ankiCard: vi.fn(async () => ({ cards: [{ front: "A <b>submit</b> button finishes the form.", back: "提交" }] }))
    };
    const anki = { createNote: vi.fn(async () => 42) };
    const handler = createBackgroundMessageHandler({ storage, ai, anki, now: () => 1_000 });

    await handler(message);
    await storage.settings.set({
      ...DEFAULT_SETTINGS,
      promptVersion: "gloss-v1",
      prompts: { ...DEFAULT_SETTINGS.prompts, ankiCard: "Create one card." },
      ai: { ...DEFAULT_SETTINGS.ai, provider: "openai-responses", endpoint: "https://api.openai.com/v1/responses", reasoningEffort: "high" }
    });
    await handler(createContentMessage("word.clicked", {
      pageUrl: "https://example.test",
      sentence: "A submit button finishes the form.",
      token: { id: "t3", sentenceId: "s1", surface: "submit", lemma: "submit", startOffset: 2, endOffset: 8 },
      allowDuplicateCard: true
    }));

    expect(ai.ankiCard).toHaveBeenCalledTimes(1);
    expect(anki.createNote).toHaveBeenCalledTimes(2);
  });

  it("generates fresh card content for a confirmed duplicate in a new sentence", async () => {
    const storage = createMemoryStorage();
    await storage.settings.set(DEFAULT_SETTINGS);
    const ai = {
      glossFrame: vi.fn(),
      ankiCard: vi.fn(async ({ sentence }: { sentence: string }) => ({
        cards: [{ front: sentence, back: sentence.includes("river") ? "河岸" : "银行" }]
      }))
    };
    const anki = {
      createNote: vi.fn(async (_input: Parameters<AnkiClient["createNote"]>[0]) => anki.createNote.mock.calls.length)
    };
    const handler = createBackgroundMessageHandler({ storage, ai, anki, now: () => 1_000 });
    const token = { id: "t1", sentenceId: "s1", surface: "bank", lemma: "bank", startOffset: 23, endOffset: 27 };

    await handler(createContentMessage("word.clicked", {
      pageUrl: "https://example.test/river",
      sentence: "They rested on the river bank.",
      token
    }));
    await handler(createContentMessage("word.clicked", {
      pageUrl: "https://example.test/finance",
      sentence: "The bank approved the loan.",
      token: { ...token, id: "t2", startOffset: 4, endOffset: 8 },
      allowDuplicateCard: true
    }));

    expect(ai.ankiCard).toHaveBeenCalledTimes(2);
    expect(ai.ankiCard.mock.calls.map(([input]) => input.sentence)).toEqual([
      "They rested on the river bank.",
      "The bank approved the loan."
    ]);
    expect(anki.createNote.mock.calls.map(([input]) => input.card.back)).toEqual(["河岸", "银行"]);
  });

  it("strips legacy note ids when rewriting cached card content", async () => {
    const storage = createMemoryStorage();
    const settings = {
      ...DEFAULT_SETTINGS,
      promptVersion: "gloss-v1",
      prompts: { ...DEFAULT_SETTINGS.prompts, ankiCard: "Create one card." }
    };
    await storage.settings.set(settings);
    const cardKey = await buildCardCacheKey({
      lang: "en",
      lemma: "submit",
      targetLang: GLOSS_TARGET_LANG,
      promptVersion: [settings.promptVersion, await hashText(settings.prompts.ankiCard)].join(":"),
      sentence: "A submit button finishes the form."
    });
    await storage.cardCache.put(cardKey, {
      cards: [{ front: "A <b>submit</b> button finishes the form.", back: "提交" }],
      noteIds: [99]
    } as never);
    const message = createContentMessage("word.clicked", {
      pageUrl: "https://example.test",
      sentence: "A submit button finishes the form.",
      token: { id: "t2", sentenceId: "s1", surface: "submit", lemma: "submit", startOffset: 2, endOffset: 8 }
    });
    const ai = { glossFrame: vi.fn(), ankiCard: vi.fn() };
    const anki = { createNote: vi.fn(async () => 42) };

    const handler = createBackgroundMessageHandler({ storage, ai, anki, now: () => 1_000 });
    await handler(message);

    expect(await storage.cardCache.get(cardKey)).toEqual({
      cards: [{ front: "A <b>submit</b> button finishes the form.", back: "提交" }]
    });
  });

});

export function createMemoryStorage(): ExtensionStorage {
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
      async put(record) {
        lexicon.set(record.key, record);
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
        if (!value) {
          return undefined;
        }
        const entry = normalizeGlossCacheEntry(value, now);
        if (entry !== value) {
          glossCache.set(key, entry);
        }
        return isFreshGlossCacheEntry(entry, now, ttlMs) ? entry : undefined;
      },
      async getFreshMany(keys, now, ttlMs) {
        return freshMany(glossCache, readMany<GlossCacheEntry>(glossCache, keys), now, ttlMs);
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

function freshMany(store: Map<string, unknown>, values: Map<string, GlossCacheEntry>, now: number, ttlMs: number): Map<string, GlossCacheEntry> {
  const result = new Map<string, GlossCacheEntry>();
  for (const [key, value] of values) {
    const entry = normalizeGlossCacheEntry(value, now);
    if (entry !== value) {
      store.set(key, entry);
    }
    if (isFreshGlossCacheEntry(entry, now, ttlMs)) {
      result.set(key, entry);
    }
  }
  return result;
}

function isFreshGlossCacheEntry(value: GlossCacheEntry, now: number, ttlMs: number): boolean {
  return now < value.createdAt + ttlMs;
}

function normalizeGlossCacheEntry(value: GlossCacheEntry, now: number): GlossCacheEntry {
  return Number.isFinite(value.createdAt) ? value : { ...value, createdAt: now };
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}
