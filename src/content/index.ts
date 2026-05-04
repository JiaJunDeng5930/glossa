import { loadKnownWords } from "../core/lexicon";
import type { BackgroundResponseMessage, TokenCandidate } from "../shared/types";
import { createGlossOverlay } from "./overlay";
import { scanDocumentText, toSerializableSentence, type ScannedToken } from "./scanner";
import { createSelectionController } from "./selection";

async function boot(): Promise<void> {
  const settingsResponse = await runtimeMessage<{ type: "settings.get" }, BackgroundResponseMessage>({ type: "settings.get" })
    .catch(() => ({ type: "settings.response" as const, settings: undefined }));
  const settings = settingsResponse.type === "settings.response" ? settingsResponse.settings : undefined;
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
    console.info("[Glossa] scan", { reason, sentences: sentences.length, tokens: scan.tokens.length });

    if (scan.tokens.length === 0) {
      overlay.clear();
      return;
    }

    const response = await runtimeMessage({
      type: "gloss.request",
      pageUrl: location.href,
      sentences: sentences.map(toSerializableSentence)
    }).catch((error) => {
      reportError("gloss request failed", error);
      return undefined;
    });
    if (version !== scanVersion || !response) {
      return;
    }
    if (response.type === "gloss.response") {
      console.info("[Glossa] render", { reason, items: response.items.length });
      if (response.items.length > 0) {
        overlay.render(response.items, tokenMap);
      }
    } else if (response.type === "error") {
      reportError("background returned error", response.message);
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
      return runtimeMessage({
        type: "word.clicked",
        pageUrl: location.href,
        sentence: selection.sentence,
        token: selection.token
      }).then(() => undefined);
    }
  }).attach();

  const observer = new MutationObserver(() => scheduleScan("mutation"));
  observer.observe(document.body, { childList: true, characterData: true, subtree: true });
  window.addEventListener("scroll", () => scheduleScan("scroll"), { passive: true });
}

function runtimeMessage<TMessage, TResponse = BackgroundResponseMessage>(message: TMessage): Promise<TResponse> {
  return new Promise((resolve, reject) => {
    const runtime = (globalThis as typeof globalThis & { chrome?: typeof chrome }).chrome?.runtime;
    if (!runtime?.sendMessage) {
      reject(new Error("chrome.runtime.sendMessage is unavailable"));
      return;
    }
    const sendMessage = runtime.sendMessage as unknown as (
      message: TMessage,
      callback: (response: TResponse) => void
    ) => Promise<TResponse> | void;
    const maybePromise = sendMessage(message, (response: TResponse) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
      } else {
        resolve(response);
      }
    });
    if (maybePromise && typeof maybePromise.then === "function") {
      (maybePromise as Promise<TResponse>).then(resolve, reject);
    }
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => void boot().catch((error) => reportError("boot failed", error)), { once: true });
} else {
  void boot().catch((error) => reportError("boot failed", error));
}

function reportError(message: string, error: unknown): void {
  console.warn("[Glossa]", message, error);
}
