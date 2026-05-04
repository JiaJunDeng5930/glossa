import { createAnkiClient } from "./anki";
import { createAiBackend } from "./ai";
import { createBackgroundMessageHandler } from "./messages";
import { trace } from "../shared/diagnostics";
import { MESSAGE_VERSION, validateContentMessage } from "../shared/messages";
import { createExtensionStorage } from "../storage/db";
import type { ErrorMessage } from "../shared/types";

const handleMessage = createBackgroundMessageHandler({
  storage: createExtensionStorage(),
  ai: createAiBackend(),
  anki: createAnkiClient()
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
