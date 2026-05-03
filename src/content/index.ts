import { loadDefaultKnownWords } from "../core/lexicon";
import type { GlossResponseMessage, TokenCandidate } from "../shared/types";
import { createGlossOverlay } from "./overlay";
import { scanDocumentText, toSerializableSentence, type ScannedToken } from "./scanner";
import { createSelectionController } from "./selection";

async function boot(): Promise<void> {
  const knownWords = await loadDefaultKnownWords();
  const scan = scanDocumentText(document, knownWords);
  const tokenMap = new Map<string, ScannedToken>(scan.tokens.map((token) => [token.id, token]));
  const overlay = createGlossOverlay(document);
  const settingsResponse = await runtimeMessage({ type: "settings.get" })
    .catch(() => ({ type: "settings.response" as const, settings: { shortcutKey: "Alt" } }));

  if (scan.tokens.length > 0) {
    const response = await runtimeMessage({
      type: "gloss.request",
      pageUrl: location.href,
      sentences: scan.sentences.map(toSerializableSentence)
    });
    if (response.type === "gloss.response") {
      overlay.render(response.items, tokenMap);
    }
  }

  createSelectionController({
    document,
    shortcutKey: settingsResponse.type === "settings.response" ? settingsResponse.settings.shortcutKey : "Alt",
    onWordSelected(selection) {
      return runtimeMessage({
        type: "word.clicked",
        pageUrl: location.href,
        sentence: selection.sentence,
        token: selection.token
      }).then(() => undefined);
    }
  }).attach();

  window.addEventListener("scroll", () => {
    runtimeMessage({
      type: "gloss.request",
      pageUrl: location.href,
      sentences: scan.sentences.map(toSerializableSentence)
    })
      .then((response) => {
        if (response.type === "gloss.response") {
          overlay.render(response.items, tokenMap);
        }
      })
      .catch(() => undefined);
  }, { passive: true });
}

function runtimeMessage<TMessage, TResponse = GlossResponseMessage>(message: TMessage): Promise<TResponse> {
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
  document.addEventListener("DOMContentLoaded", () => void boot(), { once: true });
} else {
  void boot();
}
