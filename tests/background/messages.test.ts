import { createMemoryStorage } from "../helpers/memoryStorage";
import { deferred } from "../state-model/asyncHarness";
import { describe, expect, it, vi } from "vitest";

import { createBackgroundMessageHandler } from "../../src/background/messages";
import type { AnkiClient } from "../../src/shared/services/ankiClient";
import { buildCardCacheKey } from "../../src/core/cache";
import { hashText } from "../../src/shared/hash";
import { createContentMessage, createOptionsMessage } from "../../src/shared/messages";
import { DEFAULT_SETTINGS, GLOSS_TARGET_LANG } from "../../src/shared/types";

describe("background message handler", () => {
  it("relays a child frame's state sync through the top frame", async () => {
    // @verifies glossa.extension_contracts.frame_state_sync.relay
    const { storage } = createMemoryStorage();
    const getTopFrameTranslationState = vi.fn(async () => true);
    const handler = createBackgroundMessageHandler({
      storage,
      ai: { ankiCard: vi.fn() },
      anki: { createNote: vi.fn() },
      getTopFrameTranslationState
    });
    const message = createContentMessage("translation.state.sync", {});

    const response = await handler(message, { tabId: 11 });

    expect(getTopFrameTranslationState).toHaveBeenCalledWith(11);
    expect(response).toMatchObject({
      type: "translation.state.response",
      requestId: message.requestId,
      payload: { enabled: true }
    });
  });

  it("marks clicked words as learning_active and creates an Anki note through the background", async () => {
    const { storage } = createMemoryStorage();
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
      ankiCard: vi.fn(async () => ({ front: "A <b>submit</b> button finishes the form.", back: "提交" }))
    };
    const anki = { createNote: vi.fn(async () => 42) };

    const handler = createBackgroundMessageHandler({ storage, ai, anki, now: () => 1_000 });
    const response = await handler(message);

    expect(response).toMatchObject({ type: "word.clicked.ok", requestId: message.requestId, payload: { noteId: 42 } });
    expect(anki.createNote).toHaveBeenCalledTimes(1);
    expect(await storage.lexicon.get("en:submit")).toMatchObject({
      state: "learning_active",
    });
    expect(await storage.cardedWords.get("en:submit")).toMatchObject({
      key: "en:submit",
      lang: "en",
      lemma: "submit",
      createdAt: 1_000
    });
  });

  it("starts the generated card note write without waiting for unrelated work", async () => {
    const { storage } = createMemoryStorage();
    await storage.settings.set(DEFAULT_SETTINGS);
    const message = createContentMessage("word.clicked", {
      pageUrl: "https://example.test",
      sentence: "A submit button finishes the form.",
      token: { id: "t2", sentenceId: "s1", surface: "submit", lemma: "submit", startOffset: 2, endOffset: 8 }
    });
    const ai = {
      glossFrame: vi.fn(),
      ankiCard: vi.fn(async () => ({ front: "A <b>submit</b> button finishes the form.", back: "提交" }))
    };
    const firstNote = deferred<number>();
    const anki = {
      createNote: vi.fn(() => firstNote.promise)
    };

    const handler = createBackgroundMessageHandler({ storage, ai, anki, now: () => 1_000 });
    const response = handler(message);

    await vi.waitFor(() => {
      expect(anki.createNote).toHaveBeenCalledTimes(1);
    });
    firstNote.resolve(42);

    await expect(response).resolves.toMatchObject({ type: "word.clicked.ok", payload: { noteId: 42 } });
  });
  it("reports Anki failure without card history when every note write fails", async () => {
    const { storage } = createMemoryStorage();
    await storage.settings.set(DEFAULT_SETTINGS);
    const message = createContentMessage("word.clicked", {
      pageUrl: "https://example.test",
      sentence: "A submit button finishes the form.",
      token: { id: "t2", sentenceId: "s1", surface: "submit", lemma: "submit", startOffset: 2, endOffset: 8 }
    });
    const ai = {
      glossFrame: vi.fn(),
      ankiCard: vi.fn(async () => ({ front: "A <b>submit</b> button finishes the form.", back: "提交" }))
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
    const { storage } = createMemoryStorage();
    await storage.settings.set(DEFAULT_SETTINGS);
    await storage.cardedWords.put("en:submit", { key: "en:submit", lang: "en", lemma: "submit", createdAt: 500 });
    const message = createContentMessage("word.clicked", {
      pageUrl: "https://example.test",
      sentence: "A submit button finishes the form.",
      token: { id: "t2", sentenceId: "s1", surface: "submit", lemma: "submit", startOffset: 2, endOffset: 8 }
    });
    const ai = {
      glossFrame: vi.fn(),
      ankiCard: vi.fn(async () => ({ front: "A <b>submit</b> button finishes the form.", back: "提交" }))
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
    const { storage } = createMemoryStorage();
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
      ankiCard: vi.fn(async () => ({ front: "A <b>submit</b> button finishes the form.", back: "提交" }))
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

  it("returns duplicate-card confirmation when word history records an existing card", async () => {
    const { storage } = createMemoryStorage();
    await storage.settings.set(DEFAULT_SETTINGS);
    await storage.lexicon.put({
      key: "en:submit",
      lang: "en",
      lemma: "submit",
      surface: "submit",
      state: "learning_active",
    });
    await storage.cardedWords.put("en:submit", {key:"en:submit",lang:"en",lemma:"submit",createdAt:500});
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
    const { storage } = createMemoryStorage();
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
      ankiCard: vi.fn(async () => ({ front: "A <b>submit</b> button finishes the form.", back: "提交" }))
    };
    const anki = { createNote: vi.fn(async () => 42) };

    const handler = createBackgroundMessageHandler({ storage, ai, anki, now: () => 1_000 });
    const response = await handler(message);

    expect(response).toMatchObject({ type: "word.clicked.ok", payload: { noteId: 42 } });
    expect(await storage.cardedWords.get("en:submit")).toMatchObject({ createdAt: 1_000 });
  });

  it("reuses cached card content across provider and reasoning changes", async () => {
    const { storage } = createMemoryStorage();
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
      ankiCard: vi.fn(async () => ({ front: "A <b>submit</b> button finishes the form.", back: "提交" }))
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
    const { storage } = createMemoryStorage();
    await storage.settings.set(DEFAULT_SETTINGS);
    const ai = {
      glossFrame: vi.fn(),
      ankiCard: vi.fn(async ({ sentence }: { sentence: string }) => ({ front: sentence, back: sentence.includes("river") ? "河岸" : "银行" }))
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
  // @verifies glossa.card_creation.history_reset.serialization
  it("waits for active card creation before clearing every card-history store", async () => {
    const { storage } = createMemoryStorage();
    await storage.settings.set(DEFAULT_SETTINGS);
    await storage.cardCache.put("old-card", { front: "old", back: "旧" });
    await storage.cardedWords.put("en:old", { key: "en:old", lang: "en", lemma: "old", createdAt: 500 });
    await storage.lexicon.put({
      key: "en:old",
      lang: "en",
      lemma: "old",
      surface: "old",
      state: "learning_active",
    });
    const message = createContentMessage("word.clicked", {
      pageUrl: "https://example.test",
      sentence: "A submit button finishes the form.",
      token: { id: "t2", sentenceId: "s1", surface: "submit", lemma: "submit", startOffset: 2, endOffset: 8 }
    });
    const ai = {
      glossFrame: vi.fn(),
      ankiCard: vi.fn(async () => ({ front: "A <b>submit</b> button finishes the form.", back: "提交" }))
    };
    const note = deferred<number>();
    const anki = { createNote: vi.fn(() => note.promise) };
    const handler = createBackgroundMessageHandler({ storage, ai, anki, now: () => 1_000 });

    const cardCreation = handler(message);
    await vi.waitFor(() => {
      expect(anki.createNote).toHaveBeenCalledTimes(1);
    });
    const resetSettled = vi.fn();
    const resetMessage = createOptionsMessage("card.history.reset", {});
    const reset = handler(resetMessage).then((response) => {
      resetSettled();
      return response;
    });
    const laterCreation = handler(createContentMessage("word.clicked", {
      pageUrl: "https://example.test",
      sentence: "Create an archive for the report.",
      token: { id: "t3", sentenceId: "s2", surface: "archive", lemma: "archive", startOffset: 10, endOffset: 17 }
    }));

    await Promise.resolve();
    expect(resetSettled).not.toHaveBeenCalled();
    expect(anki.createNote).toHaveBeenCalledTimes(1);
    note.resolve(42);

    await expect(cardCreation).resolves.toMatchObject({ type: "word.clicked.ok" });
    await expect(reset).resolves.toMatchObject({ type: "card.history.reset.ok", requestId: resetMessage.requestId });
    await expect(laterCreation).resolves.toMatchObject({ type: "word.clicked.ok" });
    expect(await storage.cardCache.get("old-card")).toBeUndefined();
    expect(await storage.cardedWords.get("en:old")).toBeUndefined();
    expect(await storage.cardedWords.get("en:submit")).toBeUndefined();
    expect(await storage.cardedWords.get("en:archive")).toMatchObject({ lemma: "archive" });
    expect(await storage.lexicon.get("en:old")).toMatchObject({ state: "learning_active" });
    expect(await storage.lexicon.get("en:submit")).toMatchObject({ state: "learning_active" });
    expect(await storage.lexicon.get("en:archive")).toMatchObject({ state: "learning_active" });
  });

  it("merges concurrent disjoint settings patches without waiting for an active Anki request", async () => {
    const { storage } = createMemoryStorage(DEFAULT_SETTINGS);
    const note = deferred<number>();
    const anki = { createNote: vi.fn(() => note.promise) };
    const handler = createBackgroundMessageHandler({ storage, anki,
      ai: { ankiCard: vi.fn(async () => ({front:"word",back:"词"})) } });
    const card = handler(createContentMessage("word.clicked", {
      pageUrl:"https://example.test",sentence:"word",token:{id:"word",sentenceId:"sentence",surface:"word",lemma:"word",startOffset:0,endOffset:4}
    }));
    await vi.waitFor(() => expect(anki.createNote).toHaveBeenCalledOnce());
    await Promise.all([
      handler(createOptionsMessage("settings.patch", {patch:{ai:{apiKey:"temporary-key"}}})),
      handler(createOptionsMessage("settings.patch", {patch:{appearance:{fontSize:17}}})),
      handler(createOptionsMessage("settings.patch", {patch:{anki:{deck:"New deck"}}}))
    ]);
    expect(await storage.settings.get()).toMatchObject({ai:{apiKey:"temporary-key"},appearance:{fontSize:17},anki:{deck:"New deck"}});
    await handler(createOptionsMessage("settings.patch", {patch:{ai:{apiKey:null}}}));
    expect((await storage.settings.get()).ai.apiKey).toBeUndefined();
    note.resolve(42);
    await expect(card).resolves.toMatchObject({type:"word.clicked.ok"});
  });

});
