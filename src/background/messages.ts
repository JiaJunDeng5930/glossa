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
  const wordClickLanes = new Map<string, Promise<void>>();
  return async function handleMessage(message: ContentToBackgroundMessage): Promise<BackgroundResponseMessage> {
    try {
      if (message.type === "settings.get") {
        return createBackgroundResponse(message, "settings.response", { settings: await deps.storage.settings.get() });
      }
      // @behavior glossa.card_creation.duplicate_gate.response Word-click responses use the duplicate-card envelope when a carded word needs content-side confirmation.
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
  // @behavior glossa.card_creation.duplicate_gate.inflight_serialization Same-word card creation waits for prior word-click work before rechecking duplicate state.
  const current = previous.catch(() => undefined).then(task);
  const settled = current.then(() => undefined, () => undefined);
  // @behavior glossa.card_creation.duplicate_gate.inflight_lane Same-word card creation records the current lane before AI or Anki work can start.
  lanes.set(wordKey, settled);
  try {
    return await current;
  } finally {
    // @behavior glossa.card_creation.duplicate_gate.inflight_cleanup Completed same-word card work clears the lane only when it is still the newest queued task.
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
  const settings = await deps.storage.settings.get();
  const wordKey = vocabularyKey("en", payload.token.lemma);
  const existing = await deps.storage.lexicon.get(wordKey);
  // @behavior glossa.card_creation.duplicate_gate Card creation for a word already recorded as carded returns a duplicate confirmation prompt before AI or Anki work unless the user explicitly confirms.
  // @behavior glossa.card_creation.duplicate_gate.existing_note_history Existing vocabulary note ids count as prior successful card creation for upgraded users.
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
  // @behavior glossa.card_creation.duplicate_gate.learning_state Confirmed card creation keeps the clicked word in the learning vocabulary lifecycle.
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
  const sanitizedCardOutput = { cards: cardOutput.cards };
  const noteIds = await createNotes(sanitizedCardOutput.cards, payload.token, settings, deps.anki);
  // @behavior glossa.card_creation.note_request.full_failure A failed Anki batch with no successful note ids reports the failure before writing card history.
  if (noteIds.noteIds.length === 0 && noteIds.error) {
    throw noteIds.error;
  }
  const createdNoteIds = noteIds.noteIds;
  const ankiNoteIds = createdNoteIds.length === 0 ? clicked.ankiNoteIds : [...new Set([...clicked.ankiNoteIds, ...createdNoteIds])];
  // @constraint glossa.cache_identity.card_content_cache Card content cache stores AI card content only, so each confirmed click can write a fresh Anki note.
  await deps.storage.cardCache.put(cardKey, sanitizedCardOutput);
  // @behavior glossa.card_creation.duplicate_gate.success Only successful Anki note creation writes the word-only carded record.
  if (createdNoteIds.length > 0) {
    await deps.storage.cardedWords.put(wordKey, {
      key: wordKey,
      lang: "en",
      lemma: payload.token.lemma.toLocaleLowerCase("en-US"),
      createdAt: now
    });
  }
  // @behavior glossa.card_creation.note_request.ids Successful note ids are merged into the clicked vocabulary record after Anki writes finish.
  await deps.storage.lexicon.put({ ...clicked, ankiNoteIds });
  // @behavior glossa.card_creation.note_request.partial_success_persistence Partial Anki success is persisted before the failed note write is reported.
  if (noteIds.error) {
    throw noteIds.error;
  }
  // @behavior glossa.card_creation.note_request.empty_result Empty Anki note results return an empty success payload.
  if (createdNoteIds.length === 0) {
    return { kind: "created", payload: {} };
  }
  // @behavior glossa.card_creation.note_request.response_payload Successful card creation returns the first note id after settled Anki writes.
  const [noteId] = createdNoteIds as [number, ...number[]];
  // @behavior glossa.card_creation.note_request.response_payload.first_note Content success payloads expose the first created Anki note id.
  return { kind: "created", payload: { noteId } };
}

interface CreateNotesResult {
  // @behavior glossa.card_creation.note_request.settled_result_note_ids Settled note write results expose every successful numeric note id.
  noteIds: number[];
  // @behavior glossa.card_creation.note_request.settled_result_error Settled note write results expose the first Anki rejection as an optional diagnostic error.
  error?: unknown;
}

// @behavior glossa.card_creation.note_request.settled_result Card creation returns collected note ids with an optional diagnostic error after all Anki writes settle.
async function createNotes(
  cards: Awaited<ReturnType<AiBackend["ankiCard"]>>["cards"],
  token: Extract<ContentToBackgroundMessage, { type: "word.clicked" }>["payload"]["token"],
  settings: Awaited<ReturnType<ExtensionStorage["settings"]["get"]>>,
  anki: AnkiClient
): Promise<CreateNotesResult> {
  // @behavior glossa.card_creation.note_request.concurrent_cards Multiple generated cards start their Anki note writes in one concurrent request window.
  const results = await Promise.allSettled(cards.map((card) => anki.createNote({ settings, card, token })));
  // @behavior glossa.card_creation.note_request.settled_success_ids Fulfilled Anki note writes keep every numeric note id returned by AnkiConnect.
  const noteIds = results.flatMap((result) => result.status === "fulfilled" && result.value !== undefined ? [result.value] : []);
  // @behavior glossa.card_creation.note_request.settled_failure_reason The first rejected Anki note write becomes the diagnostic error for the card response.
  const rejected = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
  return { noteIds, ...(rejected ? { error: rejected.reason } : {}) };
}

async function promptCacheVersion(settings: Awaited<ReturnType<ExtensionStorage["settings"]["get"]>>, prompt: string): Promise<string> {
  return [
    settings.promptVersion,
    await hashText(prompt)
  ].join(":");
}
