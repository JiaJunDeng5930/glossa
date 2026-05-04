import { describe, expect, it, vi } from "vitest";

import { createBackgroundMessageHandler } from "../../src/background/messages";
import { createContentMessage } from "../../src/shared/messages";
import type { ExtensionStorage } from "../../src/storage/db";
import { DEFAULT_SETTINGS } from "../../src/shared/types";

describe("background message handler", () => {
  it("serves gloss requests from state, cache and AI backend", async () => {
    const storage = createMemoryStorage();
    await storage.settings.set({
      ...DEFAULT_SETTINGS,
      shortcutKey: "Alt",
      learningWindowDays: 3,
      promptVersion: "gloss-v1",
      modelVersion: "gpt-4.1-mini",
      ai: { provider: "glossa-backend", endpoint: "https://ai.example.test", reasoningEffort: "medium" },
      anki: { endpoint: "http://127.0.0.1:8765", deck: "Glossa" }
    });
    await storage.lexicon.put({
      key: "known",
      lemma: "known",
      surface: "known",
      lang: "en",
      state: "known",
      shownCount: 1,
      clickCount: 0,
      ankiNoteIds: [],
      lastShownAt: 1
    });
    const request = createContentMessage("gloss.request", {
      pageUrl: "https://example.test",
      sentences: [{
        id: "s1",
        text: "A known submit button.",
        tokens: [
          { id: "t1", sentenceId: "s1", surface: "known", lemma: "known", startOffset: 2, endOffset: 7 },
          { id: "t2", sentenceId: "s1", surface: "submit", lemma: "submit", startOffset: 8, endOffset: 14 }
        ]
      }]
    });
    const ai = {
      gloss: vi.fn(async () => ({
        items: [{ tokenId: "t2", targetText: "submit", display: "提交", phrase: "submit button" }]
      })),
      ankiCard: vi.fn()
    };
    const anki = { createNote: vi.fn() };

    const handler = createBackgroundMessageHandler({ storage, ai, anki, now: () => 100 });
    const response = await handler(request);

    expect(response.type).toBe("gloss.response");
    if (response.type !== "gloss.response") {
      throw new Error("expected gloss response");
    }
    expect(response.requestId).toBe(request.requestId);
    expect(response.payload.items).toEqual([{ tokenId: "t2", targetText: "submit", display: "提交", phrase: "submit button" }]);
    expect(ai.gloss).toHaveBeenCalledTimes(1);
    expect(ai.gloss).toHaveBeenCalledWith(expect.objectContaining({
      settings: expect.objectContaining({
        prompts: expect.objectContaining({ gloss: DEFAULT_SETTINGS.prompts.gloss })
      })
    }));
    expect(await storage.lexicon.get("en:submit")).toMatchObject({ state: "known", shownCount: 1 });
  });

  it("marks clicked words as learning_active and creates an Anki note through the background", async () => {
    const storage = createMemoryStorage();
    await storage.settings.set({
      ...DEFAULT_SETTINGS,
      shortcutKey: "Alt",
      learningWindowDays: 3,
      promptVersion: "gloss-v1",
      modelVersion: "gpt-4.1-mini",
      ai: { provider: "glossa-backend", endpoint: "https://ai.example.test", reasoningEffort: "medium" },
      anki: { endpoint: "http://127.0.0.1:8765", deck: "Glossa" }
    });
    const message = createContentMessage("word.clicked", {
      pageUrl: "https://example.test",
      sentence: "A submit button finishes the form.",
      token: { id: "t2", sentenceId: "s1", surface: "submit", lemma: "submit", startOffset: 2, endOffset: 8 }
    });
    const ai = {
      gloss: vi.fn(),
      ankiCard: vi.fn(async () => ({
        front: "submit",
        back: "提交；提交表单",
        examples: ["Submit the form."]
      }))
    };
    const anki = { createNote: vi.fn(async () => 42) };

    const handler = createBackgroundMessageHandler({ storage, ai, anki, now: () => 1_000 });
    const response = await handler(message);

    expect(response).toMatchObject({ type: "word.clicked.ok", requestId: message.requestId, payload: { noteId: 42 } });
    expect(await storage.lexicon.get("en:submit")).toMatchObject({
      state: "learning_active",
      clickCount: 1,
      ankiNoteIds: [42]
    });
  });

  it("maps cached glosses onto the current scanned token id", async () => {
    const storage = createMemoryStorage();
    await storage.settings.set({
      ...DEFAULT_SETTINGS,
      ai: { provider: "glossa-backend", endpoint: "https://ai.example.test", reasoningEffort: "medium" }
    });
    await storage.lexicon.put({
      key: "en:submit",
      lemma: "submit",
      surface: "submit",
      lang: "en",
      state: "learning_active",
      expiresAt: 10_000,
      shownCount: 0,
      clickCount: 1,
      ankiNoteIds: []
    });
    const ai = {
      gloss: vi.fn(async () => ({
        items: [{ tokenId: "old-token", targetText: "submit", display: "提交" }]
      })),
      ankiCard: vi.fn()
    };
    const handler = createBackgroundMessageHandler({ storage, ai, anki: { createNote: vi.fn() }, now: () => 1_000 });
    const sentence = "A submit button.";
    const firstRequest = createContentMessage("gloss.request", {
      pageUrl: "https://example.test",
      sentences: [{
        id: "s1",
        text: sentence,
        tokens: [{ id: "old-token", sentenceId: "s1", surface: "submit", lemma: "submit", startOffset: 2, endOffset: 8 }]
      }]
    });
    const secondRequest = createContentMessage("gloss.request", {
      pageUrl: "https://example.test",
      sentences: [{
        id: "s2",
        text: sentence,
        tokens: [{ id: "new-token", sentenceId: "s2", surface: "submit", lemma: "submit", startOffset: 2, endOffset: 8 }]
      }]
    });
    const first = await handler(firstRequest);
    const second = await handler(secondRequest);

    expect(first).toMatchObject({ type: "gloss.response", payload: { items: [{ tokenId: "old-token" }] } });
    expect(second).toMatchObject({ type: "gloss.response", payload: { items: [{ tokenId: "new-token", targetText: "submit", display: "提交" }] } });
    expect(ai.gloss).toHaveBeenCalledTimes(1);
  });

  it("replays current in-memory glosses before known state blocks a DOM rescan", async () => {
    const storage = createMemoryStorage();
    await storage.settings.set({
      ...DEFAULT_SETTINGS,
      ai: { provider: "glossa-backend", endpoint: "https://ai.example.test", reasoningEffort: "medium" }
    });
    const ai = {
      gloss: vi.fn(async () => ({
        items: [{ tokenId: "old-token", targetText: "submit", display: "提交" }]
      })),
      ankiCard: vi.fn()
    };
    const anki = { createNote: vi.fn() };
    const sentence = "A submit button.";
    const firstRequest = createContentMessage("gloss.request", {
      pageUrl: "https://example.test",
      sentences: [{
        id: "s1",
        text: sentence,
        tokens: [{ id: "old-token", sentenceId: "s1", surface: "submit", lemma: "submit", startOffset: 2, endOffset: 8 }]
      }]
    });
    const secondRequest = createContentMessage("gloss.request", {
      pageUrl: "https://example.test",
      sentences: [{
        id: "s2",
        text: sentence,
        tokens: [{ id: "new-token", sentenceId: "s2", surface: "submit", lemma: "submit", startOffset: 2, endOffset: 8 }]
      }]
    });

    const handler = createBackgroundMessageHandler({ storage, ai, anki, now: () => 1_000 });
    const first = await handler(firstRequest);
    const second = await handler(secondRequest);
    const coldHandler = createBackgroundMessageHandler({ storage, ai, anki, now: () => 2_000 });
    const cold = await coldHandler(secondRequest);

    expect(first).toMatchObject({ type: "gloss.response", payload: { items: [{ tokenId: "old-token", targetText: "submit", display: "提交" }] } });
    expect(await storage.lexicon.get("en:submit")).toMatchObject({ state: "known", shownCount: 1 });
    expect(second).toMatchObject({ type: "gloss.response", payload: { items: [{ tokenId: "new-token", targetText: "submit", display: "提交" }] } });
    expect(cold).toMatchObject({ type: "gloss.response", payload: { items: [] } });
    expect(ai.gloss).toHaveBeenCalledTimes(1);
  });

  it("keeps in-memory replay scoped to the page URL", async () => {
    const storage = createMemoryStorage();
    await storage.settings.set({
      ...DEFAULT_SETTINGS,
      ai: { provider: "glossa-backend", endpoint: "https://ai.example.test", reasoningEffort: "medium" }
    });
    const ai = {
      gloss: vi.fn(async () => ({
        items: [{ tokenId: "old-token", targetText: "submit", display: "提交" }]
      })),
      ankiCard: vi.fn()
    };
    const anki = { createNote: vi.fn() };
    const sentence = "A submit button.";
    const samePageRequest = createContentMessage("gloss.request", {
      pageUrl: "https://example.test/page-a",
      sentences: [{
        id: "s1",
        text: sentence,
        tokens: [{ id: "old-token", sentenceId: "s1", surface: "submit", lemma: "submit", startOffset: 2, endOffset: 8 }]
      }]
    });
    const otherPageRequest = createContentMessage("gloss.request", {
      pageUrl: "https://example.test/page-b",
      sentences: [{
        id: "s2",
        text: sentence,
        tokens: [{ id: "new-token", sentenceId: "s2", surface: "submit", lemma: "submit", startOffset: 2, endOffset: 8 }]
      }]
    });

    const handler = createBackgroundMessageHandler({ storage, ai, anki, now: () => 1_000 });
    await handler(samePageRequest);
    const other = await handler(otherPageRequest);

    expect(other).toMatchObject({ type: "gloss.response", payload: { items: [] } });
    expect(ai.gloss).toHaveBeenCalledTimes(1);
  });
});

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
      async put(record) {
        lexicon.set(record.key, record);
      }
    },
    glossCache: {
      async get(key) {
        return glossCache.get(key) as never;
      },
      async put(key, value) {
        glossCache.set(key, value);
      }
    },
    cardCache: {
      async get(key) {
        return cardCache.get(key) as never;
      },
      async put(key, value) {
        cardCache.set(key, value);
      }
    }
  };
}
