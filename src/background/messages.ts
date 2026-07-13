import { buildCardCacheKey } from "../core/cache";
import { hashText } from "../shared/hash";
import { createDiagnosticError, diagnosticPayloadFrom } from "../shared/errors";
import { trace } from "../shared/diagnostics";
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
  CardHistoryResetMessage,
  ContentToBackgroundMessage,
  WordCardDuplicatePayload,
  WordClickedOkPayload
} from "../shared/types";
import { GLOSS_TARGET_LANG } from "../shared/types";

export interface BackgroundMessageHandlerDeps {
  storage: ExtensionStorage;
  ai: AiBackend;
  anki: AnkiClient;
  getTopFrameTranslationState?: (tabId: number) => Promise<boolean>;
  now?: () => number;
}

export interface BackgroundMessageContext {
  tabId?: number;
}

type BackgroundHandledMessage = ContentToBackgroundMessage | CardHistoryResetMessage;

export function createBackgroundMessageHandler(deps: BackgroundMessageHandlerDeps) {
  const now = deps.now ?? Date.now;
  const wordClickLanes = new Map<string, Promise<void>>();
  const activeWordClicks = new Set<Promise<void>>();
  let cardHistoryBarrier = Promise.resolve();
  return async function handleMessage(message: BackgroundHandledMessage, context: BackgroundMessageContext = {}): Promise<BackgroundResponseMessage> {
    try {
      if (message.type === "settings.get") {
        return createBackgroundResponse(message, "settings.response", { settings: await deps.storage.settings.get() });
      }
      // @behavior glossa.extension_contracts.frame_state_sync.relay The service worker relays a child frame's startup request to frame zero in the same tab.
      if (message.type === "translation.state.sync") {
        if (context.tabId === undefined || !deps.getTopFrameTranslationState) {
          throw new Error("Top-frame translation state is unavailable");
        }
        const enabled = await deps.getTopFrameTranslationState(context.tabId);
        return createBackgroundResponse(message, "translation.state.response", { enabled });
      }
      // @behavior glossa.card_creation.history_reset.serialization A reset waits for earlier card requests and blocks later card requests until local history is cleared.
      if (message.type === "card.history.reset") {
        const previousBarrier = cardHistoryBarrier;
        let releaseReset!: () => void;
        const resetBarrier = new Promise<void>((resolve) => {
          releaseReset = resolve;
        });
        cardHistoryBarrier = previousBarrier.then(() => resetBarrier);
        const activeBeforeReset = Array.from(activeWordClicks);
        try {
          await previousBarrier;
          await Promise.all(activeBeforeReset);
          await deps.storage.resetCardHistory();
        } finally {
          releaseReset();
        }
        return createBackgroundResponse(message, "card.history.reset.ok", {});
      }
      const precedingReset = cardHistoryBarrier;
      const operation = runSerializedWordClick(
        wordClickLanes,
        vocabularyKey("en", message.payload.token.lemma),
        async () => {
          await precedingReset;
          return handleWordClicked(message.payload, deps, now());
        }
      );
      const settled = operation.then(() => undefined, () => undefined);
      activeWordClicks.add(settled);
      void settled.then(() => activeWordClicks.delete(settled));
      const result = await operation;
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
  const cardKey = await buildCardCacheKey({
    lang: "en",
    lemma: payload.token.lemma,
    targetLang: GLOSS_TARGET_LANG,
    promptVersion: await promptCacheVersion(settings, settings.prompts.ankiCard),
    sentence: payload.sentence
  });
  const cachedCardOutput = await deps.storage.cardCache.get(cardKey);
  const cardOutput = cachedCardOutput ?? await deps.ai.ankiCard({ settings, sentence: payload.sentence, token: payload.token });
  if (cardOutput.cards.length !== 1) {
    throw createDiagnosticError("invalid-response", "AI must return exactly one Anki card", { service: "ai" });
  }
  const sanitizedCardOutput = { cards: cardOutput.cards };
  await deps.storage.cardCache.put(cardKey, sanitizedCardOutput);
  const card = sanitizedCardOutput.cards[0]!;
  let noteId: number | undefined;
  try {
    noteId = await deps.anki.createNote({ settings, card, token: payload.token });
  } catch (error) {
    const diagnostic = diagnosticPayloadFrom(error, {
      reason: "service-error",
      message: "Anki note creation failed",
      service: "anki"
    });
    if (diagnostic.reason === "timeout" || diagnostic.reason === "network" || diagnostic.reason === "invalid-response") {
      throw createDiagnosticError("outcome-unknown", diagnostic.message, {
        service: "anki",
        ...(diagnostic.status === undefined ? {} : { status: diagnostic.status }),
        cause: error
      });
    }
    throw error;
  }
  if (noteId === undefined) {
    throw createDiagnosticError("service-error", "AnkiConnect did not create a note", { service: "anki" });
  }

  await persistAfterExternalCommit("carded-word", () => deps.storage.cardedWords.put(wordKey, {
      key: wordKey,
      lang: "en",
      lemma: payload.token.lemma.toLocaleLowerCase("en-US"),
      createdAt: now
    }));
  await persistAfterExternalCommit("lexicon-card-created", () => deps.storage.lexicon.update(wordKey, (current) => {
    const clicked = markRecordClicked(
      current ?? createCandidateRecord(payload.token.lemma, payload.token.surface, "en", now),
      now,
      settings.learningWindowDays
    );
    return { ...clicked, ankiNoteIds: [...new Set([...clicked.ankiNoteIds, noteId])] };
  }).then(() => undefined));
  return { kind: "created", payload: { noteId } };
}

async function persistAfterExternalCommit(operation: string, task: () => Promise<void>): Promise<void> {
  try {
    await task();
  } catch (error) {
    trace({
      component: "service-worker",
      operation,
      result: "error",
      error
    });
  }
}

async function promptCacheVersion(settings: Awaited<ReturnType<ExtensionStorage["settings"]["get"]>>, prompt: string): Promise<string> {
  return [
    settings.promptVersion,
    await hashText(prompt)
  ].join(":");
}
