import { createAnkiClient } from "./anki";
import { createAiBackend } from "./ai";
import { createGlossResolver } from "./glossResolver";
import { attachGlossPort } from "./glossPort";
import { createBackgroundMessageHandler } from "./messages";
import { openOnboardingAfterInstall } from "./onboarding";
import { glossGenerationIdentity } from "../core/cache";
import { trace } from "../shared/diagnostics";
import { diagnosticPayloadFrom } from "../shared/errors";
import { createBackgroundResponse, MESSAGE_VERSION, validateRuntimeMessage } from "../shared/messages";
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
    while (true) {
      const response = await chrome.tabs.sendMessage(tabId, { type: "glossa.getTranslationState" }, { frameId: 0 });
      if (isTranslationControlResponse(response)) {
        return response.enabled;
      }
      if (!isTranslationBootingResponse(response)) {
        throw new Error("Top-frame translation state response is malformed");
      }
      await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 100));
    }
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
      await glossResolver.clearCache();
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

function isTranslationBootingResponse(value: unknown): value is { phase: "booting" } {
  return typeof value === "object"
    && value !== null
    && "phase" in value
    && value.phase === "booting";
}

chrome.runtime.onConnect.addListener((port) => {
  attachGlossPort(port, { storage, glossResolver });
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
