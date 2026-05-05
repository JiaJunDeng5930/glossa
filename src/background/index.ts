import { createAnkiClient } from "./anki";
import { createAiBackend } from "./ai";
import { createGlossResolver } from "./glossResolver";
import { createBackgroundMessageHandler } from "./messages";
import { trace } from "../shared/diagnostics";
import { createGlossPortMessage, MESSAGE_VERSION, validateContentMessage, validateGlossPortInbound } from "../shared/messages";
import { createExtensionStorage } from "../storage/db";
import type { ErrorMessage } from "../shared/types";

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
    const message = validateContentMessage(rawMessage);
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
  port.onDisconnect.addListener(() => {
    active = false;
  });
  port.onMessage.addListener((rawMessage: unknown) => {
    void (async () => {
      const message = validateGlossPortInbound(rawMessage);
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
        message: error instanceof Error ? error.message : "Unknown gloss session error"
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

function createInvalidMessageResponse(value: unknown, error: unknown): ErrorMessage {
  return {
    type: "error",
    version: MESSAGE_VERSION,
    requestId: requestIdFrom(value) ?? "invalid-message",
    source: "service-worker",
    target: "content-script",
    createdAt: Date.now(),
    payload: { message: error instanceof Error ? error.message : "Unknown background error" }
  };
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
