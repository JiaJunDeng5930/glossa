import { buildCardCacheKey } from "../core/cache";
import { hashText } from "../shared/hash";
import { createBackgroundResponse } from "../shared/messages";
import {
  createCandidateRecord,
  markRecordClicked,
  vocabularyKey
} from "../core/state";
import type { ExtensionStorage } from "../storage/db";
import type { AiBackend } from "./ai";
import type { AnkiClient } from "./anki";
import type {
  BackgroundResponseMessage,
  ContentToBackgroundMessage
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
      const payload = await handleWordClicked(message.payload, deps, now());
      return createBackgroundResponse(message, "word.clicked.ok", payload);
    } catch (error) {
      return createBackgroundResponse(message, "error", {
        message: error instanceof Error ? error.message : "Unknown background error"
      });
    }
  };
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
