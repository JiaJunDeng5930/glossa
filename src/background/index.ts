// @behavior glossa.extension_contracts.restart_continuity The service worker continues answering runtime messages and gloss-port scans with storage-backed results after restart.
import { createAnkiClient } from "./anki";
import { createAiBackend } from "./ai";
import { createGlossResolver } from "./glossResolver";
import { createBackgroundMessageHandler } from "./messages";
import { trace } from "../shared/diagnostics";
import { diagnosticPayloadFrom } from "../shared/errors";
import { createBackgroundResponse, createGlossPortMessage, MESSAGE_VERSION, validateGlossPortInbound, validateRuntimeMessage } from "../shared/messages";
import { createExtensionStorage } from "../storage/db";
import type { ErrorMessage, MessageSource, OptionsErrorMessage } from "../shared/types";

const storage = createExtensionStorage();
const ai = createAiBackend();
const anki = createAnkiClient();
const glossResolver = createGlossResolver({ storage, ai });
const handleMessage = createBackgroundMessageHandler({
  storage,
  ai,
  anki
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
      // @behavior glossa.settings_save.clear_gloss_cache.background_request The service worker clears durable and in-memory translation caches for options-page clear requests.
      const finishCacheClear = glossResolver.beginCacheClear();
      try {
        await storage.glossCache.clear();
      } finally {
        finishCacheClear();
      }
      sendResponse(createBackgroundResponse(message, "gloss.cache.cleared", {}));
      return;
    }
    sendResponse(await handleMessage(message));
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
        sessionPromise = storage.settings.get().then((settings) => glossResolver.createSession(startPayload.pageUrl, settings, Date.now(), {
          emit(outcome) {
            safePost(port, createGlossPortMessage("gloss.token", {
              ...outcome,
              scanId: startPayload.scanId
            }));
          },
          isActive() {
            return active;
          }
        }));
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
      trace({
        component: "service-worker",
        operation: message.type,
        result: "ok",
        url: message.payload.pageUrl,
        details: {
          scanId: message.payload.scanId,
          sentences: message.payload.sentences.length
        }
      });
      const settings = await storage.settings.get();
      await glossResolver.resolve(message.payload.pageUrl, message.payload.sentences, settings, Date.now(), {
        emit(outcome) {
          safePost(port, createGlossPortMessage("gloss.token", {
            ...outcome,
            scanId: message.payload.scanId
          }));
        },
        isActive() {
          return active;
        }
      });
      safePost(port, createGlossPortMessage("gloss.done", { scanId: message.payload.scanId }));
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
