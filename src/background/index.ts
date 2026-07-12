import { createAnkiClient } from "./anki";
import { createAiBackend } from "./ai";
import { createGlossResolver } from "./glossResolver";
import { createBackgroundMessageHandler } from "./messages";
import { openOnboardingAfterInstall } from "./onboarding";
import { glossGenerationIdentity } from "../core/cache";
import { trace } from "../shared/diagnostics";
import { diagnosticPayloadFrom } from "../shared/errors";
import { createBackgroundResponse, createGlossPortMessage, MESSAGE_VERSION, validateGlossPortInbound, validateRuntimeMessage } from "../shared/messages";
import { glossOutputSettingsChanged, mergeStoredSettings } from "../shared/settings";
import { createExtensionStorage } from "../storage/db";
import type { ErrorMessage, MessageSource, OptionsErrorMessage } from "../shared/types";

const storage = createExtensionStorage();
const ai = createAiBackend();
const anki = createAnkiClient();
const glossResolver = createGlossResolver({ storage, ai });
const handleMessage = createBackgroundMessageHandler({
  storage,
  ai,
  anki,
  async getTopFrameTranslationState(tabId) {
    const response = await chrome.tabs.sendMessage(tabId, { type: "glossa.getTranslationState" }, { frameId: 0 });
    if (!isTranslationControlResponse(response)) {
      throw new Error("Top-frame translation state response is malformed");
    }
    return response.enabled;
  }
});

chrome.runtime.onInstalled.addListener(openOnboardingAfterInstall);

chrome.storage.onChanged.addListener((changes, areaName) => {
  const settingsChange = changes.settings;
  if (areaName !== "local" || !settingsChange) {
    return;
  }
  const previous = mergeStoredSettings(settingsChange.oldValue);
  const next = mergeStoredSettings(settingsChange.newValue);
  if (!glossOutputSettingsChanged(previous, next)) {
    return;
  }
  // A generation-setting change starts one shared cache era for both listener and scan-start ordering.
  void glossResolver.activateGeneration(glossGenerationIdentity(next));
});

chrome.runtime.onMessage.addListener((rawMessage: unknown, sender, sendResponse) => {
  void (async () => {
    const message = validateRuntimeMessage(rawMessage);
    trace({
      component: "service-worker",
      operation: message.type,
      requestId: message.requestId,
      tabId: sender.tab?.id,
      frameId: sender.frameId,
      documentId: sender.documentId,
      origin: sender.origin,
      url: sender.url,
      result: "ok"
    });
    if (message.type === "gloss.cache.clear") {
      await storage.glossCache.clear();
      glossResolver.clearMemory();
      sendResponse(createBackgroundResponse(message, "gloss.cache.cleared", {}));
      return;
    }
    const tabId = sender.tab?.id;
    sendResponse(await handleMessage(message, tabId === undefined ? {} : { tabId }));
  })().catch((error) => {
    trace({
      component: "service-worker",
      operation: "runtime.onMessage",
      requestId: requestIdFrom(rawMessage),
      tabId: sender.tab?.id,
      frameId: sender.frameId,
      documentId: sender.documentId,
      origin: sender.origin,
      url: sender.url,
      result: "error",
      error
    });
    sendResponse(createInvalidMessageResponse(rawMessage, error));
  });
  return true;
});

function isTranslationControlResponse(value: unknown): value is { ok: true; enabled: boolean } {
  return typeof value === "object"
    && value !== null
    && "ok" in value
    && value.ok === true
    && "enabled" in value
    && typeof value.enabled === "boolean";
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "gloss.session") {
    return;
  }
  let active = true;
  let session: ReturnType<typeof glossResolver.createSession> | undefined;
  let sessionPromise: Promise<ReturnType<typeof glossResolver.createSession>> | undefined;
  let scanId: string | undefined;
  let pageUrl: string | undefined;
  port.onDisconnect.addListener(() => {
    active = false;
  });
  port.onMessage.addListener((rawMessage: unknown) => {
    void (async () => {
      const message = validateGlossPortInbound(rawMessage);
      if (message.type === "gloss.scan.start") {
        scanId = message.payload.scanId;
        pageUrl = message.payload.pageUrl;
        const startPayload = message.payload;
        sessionPromise = storage.settings.get().then(async (settings) => {
          // Scan startup and the storage listener converge on one identity, independent of listener ordering.
          const generationGate = glossResolver.activateGeneration(glossGenerationIdentity(settings));
          const createdSession = glossResolver.createSession(startPayload.pageUrl, settings, Date.now(), {
            emit(outcome) {
              safePost(port, createGlossPortMessage("gloss.token", {
                ...outcome,
                scanId: startPayload.scanId
              }));
            },
            isActive() {
              return active;
            }
          });
          await generationGate;
          return createdSession;
        });
        session = await sessionPromise;
        trace({
          component: "service-worker",
          operation: message.type,
          result: "ok",
          url: message.payload.pageUrl,
          details: { scanId: message.payload.scanId }
        });
        return;
      }
      if (message.type === "gloss.scan.chunk") {
        if (!sessionPromise || scanId !== message.payload.scanId) {
          throw new Error("Gloss scan chunk received before scan start");
        }
        session = await sessionPromise;
        const acceptedTokens = message.payload.sentences.reduce((total, sentence) => total + sentence.tokens.length, 0);
        await session.acceptChunk(message.payload.chunkId, message.payload.chunkIndex, message.payload.sentences);
        safePost(port, createGlossPortMessage("gloss.chunk.ack", {
          scanId: message.payload.scanId,
          chunkId: message.payload.chunkId,
          acceptedTokens
        }));
        trace({
          component: "service-worker",
          operation: message.type,
          result: "ok",
          url: message.payload.pageUrl,
          details: {
            scanId: message.payload.scanId,
            chunkIndex: message.payload.chunkIndex,
            tokens: acceptedTokens,
            sentences: message.payload.sentences.length
          }
        });
        return;
      }
      if (message.type === "gloss.scan.end") {
        if (!sessionPromise || scanId !== message.payload.scanId) {
          throw new Error("Gloss scan end received before scan start");
        }
        session = await sessionPromise;
        trace({
          component: "service-worker",
          operation: message.type,
          result: "ok",
          url: pageUrl,
          details: { scanId: message.payload.scanId }
        });
        await session.finish();
        safePost(port, createGlossPortMessage("gloss.done", { scanId: message.payload.scanId }));
        return;
      }
    })().catch((error) => {
      const scanId = scanIdFrom(rawMessage);
      trace({
        component: "service-worker",
        operation: "gloss.session",
        result: "error",
        error,
        ...(scanId ? { details: { scanId } } : {})
      });
      safePost(port, createGlossPortMessage("gloss.error", {
        ...(scanId ? { scanId } : {}),
        ...diagnosticPayloadFrom(error, {
          reason: "runtime",
          message: "Gloss session failed",
          service: "runtime"
        })
      }));
    });
  });
});

function requestIdFrom(value: unknown): string | undefined {
  if (typeof value === "object" && value !== null && "requestId" in value && typeof value.requestId === "string") {
    return value.requestId;
  }
  return undefined;
}

function createInvalidMessageResponse(value: unknown, error: unknown): ErrorMessage | OptionsErrorMessage {
  return {
    type: "error",
    version: MESSAGE_VERSION,
    requestId: requestIdFrom(value) ?? "invalid-message",
    source: "service-worker",
    target: responseTargetFrom(value),
    createdAt: Date.now(),
    payload: diagnosticPayloadFrom(error, {
      reason: "runtime",
      message: "Invalid background message",
      service: "runtime"
    })
  };
}

function responseTargetFrom(value: unknown): Exclude<MessageSource, "service-worker"> {
  if (typeof value === "object" && value !== null && "source" in value && value.source === "options") {
    return "options";
  }
  return "content-script";
}

function safePost(port: chrome.runtime.Port, message: unknown): void {
  try {
    port.postMessage(message);
  } catch {
    // The content side closes obsolete scan ports during rescans and route changes.
  }
}

function scanIdFrom(value: unknown): string | undefined {
  if (
    typeof value === "object"
    && value !== null
    && "payload" in value
    && typeof value.payload === "object"
    && value.payload !== null
    && "scanId" in value.payload
    && typeof value.payload.scanId === "string"
  ) {
    return value.payload.scanId;
  }
  return undefined;
}
