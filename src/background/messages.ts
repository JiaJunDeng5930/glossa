import { buildCardCacheKey, buildGlossCacheKey } from "../core/cache";
import { hashText } from "../shared/hash";
import { createBackgroundResponse } from "../shared/messages";
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
import { GLOSS_TARGET_LANG } from "../shared/types";

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
        return createBackgroundResponse(message, "settings.response", { settings: await deps.storage.settings.get() });
      }
      if (message.type === "gloss.request") {
        const payload = await handleGlossRequest(message.payload.sentences, deps, now());
        return createBackgroundResponse(message, "gloss.response", payload);
      }
      const payload = await handleWordClicked(message.payload, deps, now());
      return createBackgroundResponse(message, "word.clicked.ok", payload);
    } catch (error) {
      return createBackgroundResponse(message, "error", {
        message: error instanceof Error ? error.message : "Unknown background error"
      });
    }
  };
}

async function handleGlossRequest(
  sentences: SentenceCandidate[],
  deps: BackgroundMessageHandlerDeps,
  now: number
): Promise<{ items: GlossItem[] }> {
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
        targetLang: GLOSS_TARGET_LANG,
        sentence: sentence.text,
        targetText: token.surface,
        targetSpan: [token.startOffset, token.endOffset],
        promptVersion: await promptCacheVersion(settings, settings.prompts.gloss),
        modelVersion: settings.modelVersion
      });
      const cached = await deps.storage.glossCache.get(cacheKey);
      if (cached) {
        items.push({ ...cached, tokenId: token.id, targetText: token.surface });
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
          targetLang: GLOSS_TARGET_LANG,
          sentence: sentence.text,
          targetText: token.surface,
          targetSpan: [token.startOffset, token.endOffset],
          promptVersion: await promptCacheVersion(settings, settings.prompts.gloss),
          modelVersion: settings.modelVersion
        });
        await deps.storage.glossCache.put(cacheKey, item);
        await persistShownRecord(deps.storage, token, now);
        items.push(item);
      }
    }
  }

  return { items };
}

async function handleWordClicked(
  payload: Extract<ContentToBackgroundMessage, { type: "word.clicked" }>["payload"],
  deps: BackgroundMessageHandlerDeps,
  now: number
): Promise<{ noteId?: number }> {
  const settings = await deps.storage.settings.get();
  const existing = await deps.storage.lexicon.get(vocabularyKey("en", payload.token.lemma));
  const clicked = markRecordClicked(
    existing ?? createCandidateRecord(payload.token.lemma, payload.token.surface, "en", now),
    now,
    settings.learningWindowDays
  );
  const cardKey = await buildCardCacheKey({
    lang: "en",
    lemma: payload.token.lemma,
    targetLang: GLOSS_TARGET_LANG,
    promptVersion: await promptCacheVersion(settings, settings.prompts.ankiCard)
  });
  const cachedCard = await deps.storage.cardCache.get(cardKey);
  const card = cachedCard ?? await deps.ai.ankiCard({ settings, sentence: payload.sentence, token: payload.token });
  const noteId = cachedCard?.noteId ?? await deps.anki.createNote({ settings, card, token: payload.token });
  const ankiNoteIds = noteId === undefined ? clicked.ankiNoteIds : [...new Set([...clicked.ankiNoteIds, noteId])];
  await deps.storage.cardCache.put(cardKey, { ...card, ...(noteId === undefined ? {} : { noteId }) });
  await deps.storage.lexicon.put({ ...clicked, ankiNoteIds });
  return noteId === undefined ? {} : { noteId };
}

async function promptCacheVersion(settings: Awaited<ReturnType<ExtensionStorage["settings"]["get"]>>, prompt: string): Promise<string> {
  return [
    settings.promptVersion,
    settings.ai.provider,
    settings.ai.reasoningEffort,
    await hashText(prompt)
  ].join(":");
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
