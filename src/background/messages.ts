import { buildCardCacheKey } from "../core/cache";
import { hashText } from "../shared/hash";
import { createDiagnosticError, diagnosticPayloadFrom } from "../shared/errors";
import { trace } from "../shared/diagnostics";
import { createBackgroundResponse } from "../shared/messages";
import { vocabularyKey } from "../core/state";
import { createSettingsService } from "./settingsService";
import { createVocabularyService } from "./vocabularyService";
import type { ExtensionStorage } from "../storage/db";
import type { AiClient } from "../shared/services/aiClient";
import type { AnkiClient } from "../shared/services/ankiClient";
import type {
  BackgroundResponseMessage,
  RuntimeToBackgroundMessage,
  ContentToBackgroundMessage,
  WordCardDuplicatePayload,
  WordClickedOkPayload
} from "../shared/types";
import { GLOSS_TARGET_LANG } from "../shared/types";

export interface BackgroundMessageHandlerDeps {
  storage: ExtensionStorage;
  ai: Pick<AiClient, "ankiCard">;
  anki: Pick<AnkiClient, "createNote">;
  getTopFrameTranslationState?: (tabId: number) => Promise<boolean>;
  now?: () => number;
}

export interface BackgroundMessageContext {
  tabId?: number;
}

type BackgroundHandledMessage = Exclude<RuntimeToBackgroundMessage, { type: "gloss.cache.clear" }>;

export function createBackgroundMessageHandler(deps: BackgroundMessageHandlerDeps) {
  const now = deps.now ?? Date.now;
  const settingsService = createSettingsService(deps.storage);
  const vocabularyService = createVocabularyService(deps.storage);
  const wordClickLanes = new Map<string, Promise<void>>();
  const activeWordClicks = new Set<Promise<void>>();
  let cardHistoryBarrier = Promise.resolve();
  return async function handleMessage(message: BackgroundHandledMessage, context: BackgroundMessageContext = {}): Promise<BackgroundResponseMessage> {
    try {
      if (message.type === "settings.get") {
        return createBackgroundResponse(message, "settings.response", { settings: await deps.storage.settings.get() });
      }
      if (message.type === "settings.patch") {
        return createBackgroundResponse(message, "settings.response", { settings: await settingsService.patch(message.payload.patch) });
      }
      if (message.type === "known.words.list") {
        return createBackgroundResponse(message, "known.words.list.result", { records: await vocabularyService.listKnown() });
      }
      if (message.type === "known.words.add") {
        await vocabularyService.addKnown(message.payload.lemma, now());
        return createBackgroundResponse(message, "known.words.changed", {});
      }
      if (message.type === "known.words.remove") {
        await vocabularyService.removeKnown(message.payload.lemma);
        return createBackgroundResponse(message, "known.words.changed", {});
      }
      if (message.type === "known.words.clear") {
        await vocabularyService.clearKnown();
        return createBackgroundResponse(message, "known.words.changed", {});
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
  const cardKey = await buildCardCacheKey({
    lang: "en",
    lemma: payload.token.lemma,
    targetLang: GLOSS_TARGET_LANG,
    promptVersion: await promptCacheVersion(settings, settings.prompts.ankiCard),
    sentence: payload.sentence
  });
  const cachedCard = await deps.storage.cardCache.get(cardKey);
  const card = cachedCard ?? await deps.ai.ankiCard({ settings, sentence: payload.sentence, token: payload.token });
  await deps.storage.cardCache.put(cardKey, card);
  let noteId: number;
  try {
    noteId = await deps.anki.createNote({ settings, card });
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
  await persistAfterExternalCommit("card-created", () => deps.storage.recordCardCreated({
    lang: "en", lemma: payload.token.lemma, surface: payload.token.surface,
    createdAt: now, learningWindowDays: settings.learningWindowDays
  }));
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
