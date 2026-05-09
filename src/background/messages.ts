// @behavior glossa.background.messages The background message handler updates vocabulary records, creates Anki cards, and returns diagnostic response envelopes.
import { buildCardCacheKey } from "../core/cache";
import { hashText } from "../shared/hash";
import { diagnosticPayloadFrom } from "../shared/errors";
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
  ContentToBackgroundMessage,
  WordClickedOkPayload
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
      return createBackgroundResponse(message, "error", diagnosticPayloadFrom(error, {
        reason: "service-error",
        message: "Background request failed",
        service: "runtime"
      }));
    }
  };
}

async function handleWordClicked(
  payload: Extract<ContentToBackgroundMessage, { type: "word.clicked" }>["payload"],
  deps: BackgroundMessageHandlerDeps,
  now: number
): Promise<WordClickedOkPayload> {
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
  const cachedCardOutput = await deps.storage.cardCache.get(cardKey);
  const cardOutput = cachedCardOutput ?? await deps.ai.ankiCard({ settings, sentence: payload.sentence, token: payload.token });
  const noteIds = cachedCardOutput?.noteIds ?? await createNotes(cardOutput.cards, payload.token, settings, deps.anki);
  const ankiNoteIds = noteIds.length === 0 ? clicked.ankiNoteIds : [...new Set([...clicked.ankiNoteIds, ...noteIds])];
  await deps.storage.cardCache.put(cardKey, { ...cardOutput, ...(noteIds.length === 0 ? {} : { noteIds }) });
  await deps.storage.lexicon.put({ ...clicked, ankiNoteIds });
  if (noteIds.length === 0) {
    return {};
  }
  const [noteId] = noteIds as [number, ...number[]];
  return { noteId, noteIds };
}

async function createNotes(
  cards: Awaited<ReturnType<AiBackend["ankiCard"]>>["cards"],
  token: Extract<ContentToBackgroundMessage, { type: "word.clicked" }>["payload"]["token"],
  settings: Awaited<ReturnType<ExtensionStorage["settings"]["get"]>>,
  anki: AnkiClient
): Promise<number[]> {
  const noteIds: number[] = [];
  for (const card of cards) {
    const noteId = await anki.createNote({ settings, card, token });
    if (noteId !== undefined) {
      noteIds.push(noteId);
    }
  }
  return noteIds;
}

async function promptCacheVersion(settings: Awaited<ReturnType<ExtensionStorage["settings"]["get"]>>, prompt: string): Promise<string> {
  return [
    settings.promptVersion,
    settings.ai.provider,
    settings.ai.reasoningEffort,
    await hashText(prompt)
  ].join(":");
}
