import { buildCardCacheKey, buildGlossCacheKey } from "../core/cache";
import {
  createCandidateRecord,
  markRecordClicked,
  markRecordShown,
  transitionExpiredLearning,
  vocabularyKey
} from "../core/state";
import type { ExtensionStorage } from "../storage/db";
import type { AiBackend } from "./ai";
import type { AnkiClient } from "./anki";
import type {
  BackgroundResponseMessage,
  ContentToBackgroundMessage,
  GlossItem,
  SentenceCandidate,
  TokenCandidate,
  VocabularyRecord
} from "../shared/types";

export interface BackgroundMessageHandlerDeps {
  storage: ExtensionStorage;
  ai: AiBackend;
  anki: AnkiClient;
  now?: () => number;
}

export function createBackgroundMessageHandler(deps: BackgroundMessageHandlerDeps) {
  const now = deps.now ?? Date.now;
  return async function handleMessage(message: ContentToBackgroundMessage): Promise<BackgroundResponseMessage> {
    try {
      if (message.type === "settings.get") {
        return { type: "settings.response", settings: await deps.storage.settings.get() };
      }
      if (message.type === "gloss.request") {
        return await handleGlossRequest(message.sentences, deps, now());
      }
      return await handleWordClicked(message, deps, now());
    } catch (error) {
      return {
        type: "error",
        message: error instanceof Error ? error.message : "Unknown background error"
      };
    }
  };
}

async function handleGlossRequest(
  sentences: SentenceCandidate[],
  deps: BackgroundMessageHandlerDeps,
  now: number
): Promise<BackgroundResponseMessage> {
  const settings = await deps.storage.settings.get();
  const items: GlossItem[] = [];

  for (const sentence of sentences) {
    const misses: TokenCandidate[] = [];
    for (const token of sentence.tokens) {
      const record = await currentRecord(deps.storage, token, now);
      if (record?.state === "known" || record?.state === "ignored") {
        continue;
      }
      const cacheKey = await buildGlossCacheKey({
        targetLang: settings.targetLang,
        sentence: sentence.text,
        targetText: token.surface,
        targetSpan: [token.startOffset, token.endOffset],
        promptVersion: settings.promptVersion,
        modelVersion: settings.modelVersion
      });
      const cached = await deps.storage.glossCache.get(cacheKey);
      if (cached) {
        items.push(cached);
        await persistShownRecord(deps.storage, token, now);
      } else {
        misses.push(token);
      }
    }

    if (misses.length > 0) {
      const response = await deps.ai.gloss({ settings, sentence: sentence.text, tokens: misses });
      for (const item of response.items) {
        const token = misses.find((candidate) => candidate.id === item.tokenId);
        if (!token) {
          continue;
        }
        const cacheKey = await buildGlossCacheKey({
          targetLang: settings.targetLang,
          sentence: sentence.text,
          targetText: token.surface,
          targetSpan: [token.startOffset, token.endOffset],
          promptVersion: settings.promptVersion,
          modelVersion: settings.modelVersion
        });
        await deps.storage.glossCache.put(cacheKey, item);
        await persistShownRecord(deps.storage, token, now);
        items.push(item);
      }
    }
  }

  return { type: "gloss.response", items };
}

async function handleWordClicked(
  message: Extract<ContentToBackgroundMessage, { type: "word.clicked" }>,
  deps: BackgroundMessageHandlerDeps,
  now: number
): Promise<BackgroundResponseMessage> {
  const settings = await deps.storage.settings.get();
  const existing = await deps.storage.lexicon.get(vocabularyKey("en", message.token.lemma));
  const clicked = markRecordClicked(
    existing ?? createCandidateRecord(message.token.lemma, message.token.surface, "en", now),
    now,
    settings.learningWindowDays
  );
  const cardKey = await buildCardCacheKey({
    lang: "en",
    lemma: message.token.lemma,
    targetLang: settings.targetLang,
    promptVersion: settings.promptVersion
  });
  const cachedCard = await deps.storage.cardCache.get(cardKey);
  const card = cachedCard ?? await deps.ai.ankiCard({ settings, sentence: message.sentence, token: message.token });
  const noteId = cachedCard?.noteId ?? await deps.anki.createNote({ settings, card, token: message.token });
  const ankiNoteIds = noteId === undefined ? clicked.ankiNoteIds : [...new Set([...clicked.ankiNoteIds, noteId])];
  await deps.storage.cardCache.put(cardKey, { ...card, ...(noteId === undefined ? {} : { noteId }) });
  await deps.storage.lexicon.put({ ...clicked, ankiNoteIds });
  return noteId === undefined ? { type: "word.clicked.ok" } : { type: "word.clicked.ok", noteId };
}

async function currentRecord(storage: ExtensionStorage, token: TokenCandidate, now: number): Promise<VocabularyRecord | undefined> {
  const key = vocabularyKey("en", token.lemma);
  const record = await storage.lexicon.get(key);
  if (!record) {
    return undefined;
  }
  const current = transitionExpiredLearning(record, now);
  if (current !== record) {
    await storage.lexicon.put(current);
  }
  return current;
}

async function persistShownRecord(storage: ExtensionStorage, token: TokenCandidate, now: number): Promise<void> {
  const existing = await storage.lexicon.get(vocabularyKey("en", token.lemma));
  const record = existing ?? createCandidateRecord(token.lemma, token.surface, "en", now);
  const shown = markRecordShown(record, now);
  await storage.lexicon.put(shown);
}
