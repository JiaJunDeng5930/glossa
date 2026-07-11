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
  WordCardDuplicatePayload,
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
  const wordClickLanes = new Map<string, Promise<void>>();
  return async function handleMessage(message: ContentToBackgroundMessage): Promise<BackgroundResponseMessage> {
    try {
      if (message.type === "settings.get") {
        return createBackgroundResponse(message, "settings.response", { settings: await deps.storage.settings.get() });
      }
      const result = await runSerializedWordClick(
        wordClickLanes,
        vocabularyKey("en", message.payload.token.lemma),
        () => handleWordClicked(message.payload, deps, now())
      );
      return result.kind === "duplicate"
        ? createBackgroundResponse(message, "word.card.duplicate", result.payload)
        : createBackgroundResponse(message, "word.clicked.ok", result.payload);
    } catch (error) {
      return createBackgroundResponse(message, "error", diagnosticPayloadFrom(error, {
        reason: "service-error",
        message: "Background request failed",
        service: "runtime"
      }));
    }
  };
}

async function runSerializedWordClick<T>(lanes: Map<string, Promise<void>>, wordKey: string, task: () => Promise<T>): Promise<T> {
  const previous = lanes.get(wordKey) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(task);
  const settled = current.then(() => undefined, () => undefined);
  lanes.set(wordKey, settled);
  try {
    return await current;
  } finally {
    if (lanes.get(wordKey) === settled) {
      lanes.delete(wordKey);
    }
  }
}

async function handleWordClicked(
  payload: Extract<ContentToBackgroundMessage, { type: "word.clicked" }>["payload"],
  deps: BackgroundMessageHandlerDeps,
  now: number
): Promise<{ kind: "created"; payload: WordClickedOkPayload } | { kind: "duplicate"; payload: WordCardDuplicatePayload }> {
  // The hold-and-click gesture commits the card immediately; only an existing word-level card requires confirmation.
  const settings = await deps.storage.settings.get();
  const wordKey = vocabularyKey("en", payload.token.lemma);
  const existing = await deps.storage.lexicon.get(wordKey);
  if (payload.allowDuplicateCard !== true && (await deps.storage.cardedWords.get(wordKey) || (existing?.ankiNoteIds.length ?? 0) > 0)) {
    return {
      kind: "duplicate",
      payload: {
        lang: "en",
        lemma: payload.token.lemma,
        surface: payload.token.surface,
        promptMs: settings.anki.duplicatePromptMs
      }
    };
  }
  const clicked = markRecordClicked(
    existing ?? createCandidateRecord(payload.token.lemma, payload.token.surface, "en", now),
    now,
    settings.learningWindowDays
  );
  const cardKey = await buildCardCacheKey({
    lang: "en",
    lemma: payload.token.lemma,
    targetLang: GLOSS_TARGET_LANG,
    promptVersion: await promptCacheVersion(settings, settings.prompts.ankiCard),
    sentence: payload.sentence
  });
  const cachedCardOutput = await deps.storage.cardCache.get(cardKey);
  const cardOutput = cachedCardOutput ?? await deps.ai.ankiCard({ settings, sentence: payload.sentence, token: payload.token });
  const sanitizedCardOutput = { cards: cardOutput.cards };
  const noteIds = await createNotes(sanitizedCardOutput.cards, payload.token, settings, deps.anki);
  if (noteIds.noteIds.length === 0 && noteIds.error) {
    throw noteIds.error;
  }
  const createdNoteIds = noteIds.noteIds;
  const ankiNoteIds = createdNoteIds.length === 0 ? clicked.ankiNoteIds : [...new Set([...clicked.ankiNoteIds, ...createdNoteIds])];
  await deps.storage.cardCache.put(cardKey, sanitizedCardOutput);
  if (createdNoteIds.length > 0) {
    await deps.storage.cardedWords.put(wordKey, {
      key: wordKey,
      lang: "en",
      lemma: payload.token.lemma.toLocaleLowerCase("en-US"),
      createdAt: now
    });
  }
  await deps.storage.lexicon.put({ ...clicked, ankiNoteIds });
  if (noteIds.error) {
    throw noteIds.error;
  }
  if (createdNoteIds.length === 0) {
    return { kind: "created", payload: {} };
  }
  const [noteId] = createdNoteIds as [number, ...number[]];
  return { kind: "created", payload: { noteId } };
}

interface CreateNotesResult {
  noteIds: number[];
  error?: unknown;
}

async function createNotes(
  cards: Awaited<ReturnType<AiBackend["ankiCard"]>>["cards"],
  token: Extract<ContentToBackgroundMessage, { type: "word.clicked" }>["payload"]["token"],
  settings: Awaited<ReturnType<ExtensionStorage["settings"]["get"]>>,
  anki: AnkiClient
): Promise<CreateNotesResult> {
  const results = await Promise.allSettled(cards.map((card) => anki.createNote({ settings, card, token })));
  const noteIds = results.flatMap((result) => result.status === "fulfilled" && result.value !== undefined ? [result.value] : []);
  const rejected = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
  return { noteIds, ...(rejected ? { error: rejected.reason } : {}) };
}

async function promptCacheVersion(settings: Awaited<ReturnType<ExtensionStorage["settings"]["get"]>>, prompt: string): Promise<string> {
  return [
    settings.promptVersion,
    await hashText(prompt)
  ].join(":");
}
