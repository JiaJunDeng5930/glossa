import { loadKnownWords } from "../core/lexicon";
import { trace } from "../shared/diagnostics";
import { createContentMessage, messageTimeoutError, validateBackgroundResponse } from "../shared/messages";
import type { BackgroundResponseMessage, ContentToBackgroundMessage, TokenCandidate } from "../shared/types";
import { createGlossOverlay } from "./overlay";
import { scanDocumentText, toSerializableSentence, type ScannedToken } from "./scanner";
import { createSelectionController } from "./selection";

async function boot(): Promise<void> {
  const settingsResponse = await runtimeMessage(createContentMessage("settings.get", {}))
    .catch(() => undefined);
  const settings = settingsResponse?.type === "settings.response" ? settingsResponse.payload.settings : undefined;
  const knownWords = await loadKnownWords(settings?.knownWordList ?? "junior-high");
  const overlay = createGlossOverlay(document, settings?.appearance);
  let scanVersion = 0;
  let scanTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
  let pageUrl = location.href;

  const scanAndRender = async (reason: string) => {
    if (location.href !== pageUrl) {
      pageUrl = location.href;
      overlay.clear();
    }
    const scan = scanDocumentText(document, knownWords);
    const tokenMap = new Map<string, ScannedToken>(scan.tokens.map((token) => [token.id, token]));
    const sentences = scan.sentences.filter((sentence) => sentence.tokens.length > 0);
    const version = ++scanVersion;
    trace({
      component: "content-script",
      operation: "content.scan",
      result: "ok",
      url: location.href,
      details: { reason, sentences: sentences.length, tokens: scan.tokens.length }
    });

    if (scan.tokens.length === 0) {
      overlay.clear();
      return;
    }

    const response = await runtimeMessage(createContentMessage("gloss.request", {
      pageUrl: location.href,
      sentences: sentences.map(toSerializableSentence)
    })).catch((error) => {
      reportError("gloss.request", error);
      return undefined;
    });
    if (version !== scanVersion || !response) {
      return;
    }
    if (response.type === "gloss.response") {
      trace({
        component: "content-script",
        operation: "content.render",
        requestId: response.requestId,
        result: "ok",
        url: location.href,
        details: { reason, items: response.payload.items.length }
      });
      if (response.payload.items.length > 0) {
        overlay.render(response.payload.items, tokenMap);
      }
    } else if (response.type === "error") {
      reportError("background.error", response.payload.message, response.requestId);
    }
  };

  const scheduleScan = (reason: string) => {
    if (scanTimer) {
      globalThis.clearTimeout(scanTimer);
    }
    scanTimer = globalThis.setTimeout(() => {
      scanTimer = undefined;
      void scanAndRender(reason);
    }, 150);
  };

  await scanAndRender("boot");

  createSelectionController({
    document,
    shortcutKey: settings?.shortcutKey ?? "Alt",
    onWordSelected(selection) {
      return runtimeMessage(createContentMessage("word.clicked", {
        pageUrl: location.href,
        sentence: selection.sentence,
        token: selection.token
      })).then(() => undefined);
    }
  }).attach();

  const observer = new MutationObserver(() => scheduleScan("mutation"));
  observer.observe(document.body, { childList: true, characterData: true, subtree: true });
  window.addEventListener("scroll", () => scheduleScan("scroll"), { passive: true });
}

function runtimeMessage(message: ContentToBackgroundMessage, timeoutMs = 5_000): Promise<BackgroundResponseMessage> {
  return new Promise((resolve, reject) => {
    const runtime = (globalThis as typeof globalThis & { chrome?: typeof chrome }).chrome?.runtime;
    if (!runtime?.sendMessage) {
      reject(new Error("chrome.runtime.sendMessage is unavailable"));
      return;
    }
    const sendMessage = runtime.sendMessage as unknown as (
      message: ContentToBackgroundMessage,
      callback: (response: unknown) => void
    ) => Promise<unknown> | void;
    const timeout = globalThis.setTimeout(() => {
      trace({
        component: "content-script",
        operation: message.type,
        requestId: message.requestId,
        result: "timeout",
        url: location.href
      });
      reject(messageTimeoutError(message));
    }, timeoutMs);
    const settle = (value: unknown) => {
      globalThis.clearTimeout(timeout);
      resolve(validateBackgroundResponse(value, message));
    };
    const maybePromise = sendMessage(message, (response: unknown) => {
      const error = chrome.runtime.lastError;
      if (error) {
        globalThis.clearTimeout(timeout);
        reject(new Error(error.message));
      } else {
        settle(response);
      }
    });
    if (maybePromise && typeof maybePromise.then === "function") {
      (maybePromise as Promise<unknown>).then(settle, (error) => {
        globalThis.clearTimeout(timeout);
        reject(error);
      });
    }
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => void boot().catch((error) => reportError("boot failed", error)), { once: true });
} else {
  void boot().catch((error) => reportError("boot failed", error));
}

function reportError(operation: string, error: unknown, requestId?: string): void {
  trace({
    component: "content-script",
    operation,
    ...(requestId ? { requestId } : {}),
    result: "error",
    url: location.href,
    error
  });
}
