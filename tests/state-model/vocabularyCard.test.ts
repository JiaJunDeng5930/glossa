import { createMemoryStorage } from "../helpers/memoryStorage";
import { deferred } from "./asyncHarness";
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
  type ErrorReason,
  type GlossTokenOutcome,
  type SentenceCandidate,
  type VocabularyRecord,
  type VocabularyState
} from "../../src/shared/types";

describe("vocabulary and card state transitions", () => {
  it("preserves a committed shown timestamp when card creation follows it", async () => {
    const fixture = createMemoryStorage();
    const input = glossSentence("shown-token", "submit");
    await seedGloss(fixture, input, "提交");
    const resolver = createGlossResolver({
      storage: fixture.storage,
      ai: { glossFrame: vi.fn() },
      dbReadCoalesceMs: 0
    });
    const events: Array<GlossTokenOutcome> = [];

    await resolveScan(resolver, input, events);
    const { handler, anki } = cardHandler(fixture.storage, [{ front: "submit", back: "提交" }]);
    const response = await handler(wordMessage("submit", "shown-token"));

    expect(events.map((event) => event.status)).toEqual(["ready"]);
    expect(response).toMatchObject({ type: "word.clicked.ok", payload: { noteId: 42 } });
    expect(anki.createNote).toHaveBeenCalledTimes(1);
    expect(fixture.lexicon.get("en:submit")).toMatchObject({
      state: "learning_active", lastClickedAt: 1_000, lastShownAt: 200
    });
  });

  it("keeps ignored records unchanged when shown but lets an explicit card command enter learning", async () => {
    const fixture = createMemoryStorage();
    const input = glossSentence("ignored-token", "submit");
    await seedGloss(fixture, input, "提交");
    fixture.lexicon.set("en:submit", {
      key: "en:submit",
      lang: "en",
      lemma: "submit",
      surface: "submit",
      state: "ignored",
    });
    const resolver = createGlossResolver({
      storage: fixture.storage,
      ai: { glossFrame: vi.fn() },
      dbReadCoalesceMs: 0
    });
    const events: Array<GlossTokenOutcome> = [];

    await resolveScan(resolver, input, events);
    expect(fixture.lexicon.get("en:submit")).toMatchObject({ state: "ignored" });

    const { handler } = cardHandler(fixture.storage, [{ front: "submit", back: "提交" }]);
    await expect(handler(wordMessage("submit", "ignored-token"))).resolves.toMatchObject({
      type: "word.clicked.ok",
      payload: { noteId: 42 }
    });
    expect(fixture.lexicon.get("en:submit")).toMatchObject({ state: "learning_active" });
  });

  it("does not let a stale shown read overwrite a card transition", async () => {
    const fixture = createMemoryStorage();
    const input = glossSentence("race-token", "submit");
    await seedGloss(fixture, input, "提交");
    const shownStarted = deferred<void>();
    const releaseShown = deferred<void>();
    const originalUpdate = fixture.storage.lexicon.update;
    let updateCount = 0;
    fixture.storage.lexicon.update = vi.fn(async (key, transition) => {
      updateCount += 1;
      if (updateCount === 1) {
        shownStarted.resolve();
        await releaseShown.promise;
      }
      return originalUpdate(key, transition);
    });
    const resolver = createGlossResolver({
      storage: fixture.storage,
      ai: { glossFrame: vi.fn() },
      dbReadCoalesceMs: 0
    });
    const events: Array<GlossTokenOutcome> = [];
    const scan = resolveScan(resolver, input, events);
    await shownStarted.promise;
    const { handler } = cardHandler(fixture.storage, [{ front: "submit", back: "提交" }]);

    const card = await handler(wordMessage("submit", "race-token"));
    releaseShown.resolve();
    await scan;

    expect(card).toMatchObject({ type: "word.clicked.ok", payload: { noteId: 42 } });
    expect(fixture.lexicon.get("en:submit")).toMatchObject({
      state: "learning_active", lastClickedAt: 1_000, lastShownAt: 200
    });
  });

  it("does not let a stale remove-known command delete a card transition", async () => {
    const fixture = createMemoryStorage();
    const record: VocabularyRecord = {
      key: "en:submit",
      lang: "en",
      lemma: "submit",
      surface: "submit",
      state: "known",
      lastShownAt: 500
    };
    fixture.lexicon.set(record.key, record);
    const removeStarted = deferred<void>();
    const releaseRemove = deferred<void>();
    const originalRemove = fixture.storage.lexicon.removeKnown;
    fixture.storage.lexicon.removeKnown = vi.fn(async (lemma) => {
      removeStarted.resolve();
      await releaseRemove.promise;
      await originalRemove(lemma);
    });
    const { handler } = cardHandler(fixture.storage, [{ front: "submit", back: "提交" }]);
    const remove = handler(createOptionsMessage("known.words.remove", { lemma: record.lemma }));
    await removeStarted.promise;
    const card = await handler(wordMessage("submit", "card-after-remove", true));
    releaseRemove.resolve();
    await remove;

    expect(card).toMatchObject({ type: "word.clicked.ok", payload: { noteId: 42 } });
    expect(fixture.lexicon.get(record.key)).toMatchObject({
      state: "learning_active", lastClickedAt: 1_000
    });
  });

  it("serializes duplicate same-word commands and calls addNote at most once", async () => {
    const fixture = createMemoryStorage();
    const note = deferred<number>();
    const ai = {
      glossFrame: vi.fn(),
      ankiCard: vi.fn(async () => ({ front: "submit", back: "提交" }))
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
      ankiCard: vi.fn(async () => ({ front: "submit", back: "提交" }))
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
    fixture.storage.recordCardCreated = vi.fn(async () => {
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
        return { front: token.lemma, back: token.lemma };
      })
    };
    const anki = {
      createNote: vi.fn(({ card }: { card: { front: string } }) => {
        ledger.push(`anki:${card.front}`);
        return card.front === "submit" ? firstNote.promise : Promise.resolve(84);
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
  const ai = { glossFrame: vi.fn(), ankiCard: vi.fn(async () => cards[0]!) };
  const anki = { createNote: vi.fn(async () => 42) };
  return { handler: createBackgroundMessageHandler({ storage, ai, anki, now: () => 1_000 }), ai, anki };
}

function wordMessage(lemma: string, tokenId = `${lemma}-token`, allowDuplicateCard = false) {
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
    },
    ...(allowDuplicateCard ? { allowDuplicateCard: true } : {})
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
  events: Array<GlossTokenOutcome>
): Promise<void> {
  const session = resolver.createSession("https://example.test/page", DEFAULT_SETTINGS, 200, {
    emit: (event) => events.push(event)
  });
  await session.acceptChunk("chunk-0", 0, sentences);
  await session.finish();
}
