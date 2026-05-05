import { describe, expect, it, vi } from "vitest";

import { createBackgroundMessageHandler } from "../../src/background/messages";
import { createContentMessage } from "../../src/shared/messages";
import type { ExtensionStorage } from "../../src/storage/db";
import { DEFAULT_SETTINGS } from "../../src/shared/types";

describe("background message handler", () => {
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

});

export function createMemoryStorage(): ExtensionStorage {
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
