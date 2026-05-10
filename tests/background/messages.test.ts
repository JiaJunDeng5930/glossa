import { describe, expect, it, vi } from "vitest";

import { createBackgroundMessageHandler } from "../../src/background/messages";
import { buildCardCacheKey } from "../../src/core/cache";
import { hashText } from "../../src/shared/hash";
import { createContentMessage } from "../../src/shared/messages";
import type { ExtensionStorage } from "../../src/storage/db";
import { DEFAULT_SETTINGS, GLOSS_TARGET_LANG, type AnkiCardOutput, type CardedWordRecord, type GlossItem, type VocabularyRecord, type VocabularyState } from "../../src/shared/types";

// @verifies glossa.extension_contracts.request_effects
// @verifies glossa.extension_storage.typed_access
describe("background message handler", () => {
  // @verifies glossa.card_creation.duplicate_gate.success
  // @verifies glossa.card_creation.duplicate_gate.learning_state
  // @verifies glossa.card_creation.note_request.ids
  // @verifies glossa.card_creation.note_request.empty_result
  // @verifies glossa.card_creation.note_request.response_payload
  // @verifies glossa.card_creation.duplicate_gate.record_key
  // @verifies glossa.card_creation.duplicate_gate.record_lang
  // @verifies glossa.card_creation.duplicate_gate.record_lemma
  // @verifies glossa.card_creation.duplicate_gate.record_created_at
  // @verifies glossa.card_creation.duplicate_gate.record_store
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
      gloss: vi.fn(),
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

    expect(response).toMatchObject({ type: "word.clicked.ok", requestId: message.requestId, payload: { noteId: 42, noteIds: [42, 43] } });
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

  // @verifies glossa.card_creation.duplicate_gate
  // @verifies glossa.card_creation.duplicate_gate.response
  // @verifies glossa.card_creation.duplicate_gate.message_lang
  // @verifies glossa.card_creation.duplicate_gate.message_lemma
  // @verifies glossa.card_creation.duplicate_gate.message_surface
  // @verifies glossa.card_creation.duplicate_gate.message_prompt_ms
  // @verifies glossa.card_creation.duplicate_gate.prompt_setting
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
      gloss: vi.fn(),
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

  // @verifies glossa.card_creation.duplicate_gate.existing_note_history
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
    const ai = { gloss: vi.fn(), glossFrame: vi.fn(), ankiCard: vi.fn() };
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

  // @verifies glossa.card_creation.duplicate_gate
  // @verifies glossa.card_creation.duplicate_gate.message_confirmed
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
      gloss: vi.fn(),
      glossFrame: vi.fn(),
      ankiCard: vi.fn(async () => ({ cards: [{ front: "A <b>submit</b> button finishes the form.", back: "提交" }] }))
    };
    const anki = { createNote: vi.fn(async () => 42) };

    const handler = createBackgroundMessageHandler({ storage, ai, anki, now: () => 1_000 });
    const response = await handler(message);

    expect(response).toMatchObject({ type: "word.clicked.ok", payload: { noteId: 42, noteIds: [42] } });
    expect(await storage.cardedWords.get("en:submit")).toMatchObject({ createdAt: 1_000 });
  });

  // @verifies glossa.cache_identity.card_content_cache
  // @verifies glossa.cache_identity.card_content_cache.store
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
      gloss: vi.fn(),
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

  // @verifies glossa.cache_identity.card_content_cache
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
      promptVersion: [settings.promptVersion, await hashText(settings.prompts.ankiCard)].join(":")
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
    const ai = { gloss: vi.fn(), glossFrame: vi.fn(), ankiCard: vi.fn() };
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
        return readMany<GlossItem>(glossCache, keys);
      },
      async put(key, value) {
        glossCache.set(key, value);
      },
      async delete(key) {
        glossCache.delete(key);
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
