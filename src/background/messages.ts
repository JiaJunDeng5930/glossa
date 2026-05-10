// @behavior glossa.extension_contracts.request_effects Word-click and settings requests update vocabulary records, create cards, and return diagnostic response envelopes.
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
  return async function handleMessage(message: ContentToBackgroundMessage): Promise<BackgroundResponseMessage> {
    try {
      if (message.type === "settings.get") {
        return createBackgroundResponse(message, "settings.response", { settings: await deps.storage.settings.get() });
      }
      // @behavior glossa.card_creation.duplicate_gate.response Word-click responses use the duplicate-card envelope when a carded word needs content-side confirmation.
      const result = await handleWordClicked(message.payload, deps, now());
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

async function handleWordClicked(
  payload: Extract<ContentToBackgroundMessage, { type: "word.clicked" }>["payload"],
  deps: BackgroundMessageHandlerDeps,
  now: number
): Promise<{ kind: "created"; payload: WordClickedOkPayload } | { kind: "duplicate"; payload: WordCardDuplicatePayload }> {
  const settings = await deps.storage.settings.get();
  const wordKey = vocabularyKey("en", payload.token.lemma);
  // @behavior glossa.card_creation.duplicate_gate Card creation for a word already recorded as carded returns a duplicate confirmation prompt before AI or Anki work unless the user explicitly confirms.
  if (payload.allowDuplicateCard !== true && await deps.storage.cardedWords.get(wordKey)) {
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
  // @behavior glossa.card_creation.duplicate_gate.learning_state Confirmed card creation keeps the clicked word in the learning vocabulary lifecycle.
  const existing = await deps.storage.lexicon.get(wordKey);
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
  const noteIds = await createNotes(cardOutput.cards, payload.token, settings, deps.anki);
  const ankiNoteIds = noteIds.length === 0 ? clicked.ankiNoteIds : [...new Set([...clicked.ankiNoteIds, ...noteIds])];
  // @constraint glossa.cache_identity.card_content_cache Card content cache stores AI card content only, so each confirmed click can write a fresh Anki note.
  await deps.storage.cardCache.put(cardKey, cardOutput);
  // @behavior glossa.card_creation.duplicate_gate.success Only successful Anki note creation writes the word-only carded record.
  if (noteIds.length > 0) {
    await deps.storage.cardedWords.put(wordKey, {
      key: wordKey,
      lang: "en",
      lemma: payload.token.lemma.toLocaleLowerCase("en-US"),
      createdAt: now
    });
  }
  // @behavior glossa.card_creation.note_request.ids Successful note ids are merged into the clicked vocabulary record after Anki writes finish.
  await deps.storage.lexicon.put({ ...clicked, ankiNoteIds });
  // @behavior glossa.card_creation.note_request.empty_result Empty Anki note results return an empty success payload.
  if (noteIds.length === 0) {
    return { kind: "created", payload: {} };
  }
  // @behavior glossa.card_creation.note_request.response_payload Successful card creation returns the first note id and the complete note id list.
  const [noteId] = noteIds as [number, ...number[]];
  return { kind: "created", payload: { noteId, noteIds } };
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
    await hashText(prompt)
  ].join(":");
}
