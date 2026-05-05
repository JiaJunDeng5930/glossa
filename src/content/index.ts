import { loadKnownWords } from "../core/lexicon";
import { trace } from "../shared/diagnostics";
import { createContentMessage, messageTimeoutError, validateBackgroundResponse } from "../shared/messages";
import { matchesShortcut } from "../shared/shortcut";
import type { BackgroundResponseMessage, ContentToBackgroundMessage } from "../shared/types";
import { createGlossOverlay } from "./overlay";
import { scanDocumentText, toSerializableSentence, type ScannedToken } from "./scanner";
import { createSelectionController } from "./selection";

async function boot(): Promise<void> {
  const settingsResponse = await runtimeMessage(createContentMessage("settings.get", {}))
    .catch((error) => {
      if (isExtensionContextInvalidated(error)) {
        throw error;
      }
      return undefined;
    });
  const settings = settingsResponse?.type === "settings.response" ? settingsResponse.payload.settings : undefined;
  const knownWords = await loadKnownWords(settings?.knownWordList ?? "junior-high");
  const overlay = createGlossOverlay(document, settings?.appearance);
  let scanVersion = 0;
  let scanTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
  let pageUrl = urlWithoutHash(location.href);
  let stopped = false;
  const autoTranslateEnabled = settings?.autoTranslateEnabled ?? false;
  let translationEnabled = autoTranslateEnabled;
  let selectionController: ReturnType<typeof createSelectionController> | undefined;
  let observer: MutationObserver | undefined;

  const stopContentScript = (reason: string): void => {
    if (stopped) {
      return;
    }
    stopped = true;
    if (scanTimer) {
      globalThis.clearTimeout(scanTimer);
      scanTimer = undefined;
    }
    observer?.disconnect();
    selectionController?.detach();
    overlay.clear();
    trace({
      component: "content-script",
      operation: "content.stop",
      result: "ignored",
      url: location.href,
      details: { reason }
    });
  };

  const handleRuntimeError = (operation: string, error: unknown, requestId?: string): void => {
    if (isExtensionContextInvalidated(error)) {
      stopContentScript("extension-context-invalidated");
      return;
    }
    reportError(operation, error, requestId);
  };

  const scanAndRender = async (reason: string, options: { manualActivation?: boolean } = {}) => {
    if (stopped) {
      return;
    }
    const routeUrl = urlWithoutHash(location.href);
    if (routeUrl !== pageUrl) {
      pageUrl = routeUrl;
      scanVersion += 1;
      overlay.clear();
      translationEnabled = options.manualActivation === true || autoTranslateEnabled;
    }
    if (!translationEnabled) {
      return;
    }
    const version = ++scanVersion;
    const scan = scanDocumentText(document, knownWords, {
      scanVersion: version,
      requireRenderableRange: true
    });
    const tokenMap = new Map<string, ScannedToken>(scan.tokens.map((token) => [token.id, token]));
    const sentences = scan.sentences.filter((sentence) => sentence.tokens.length > 0);
    trace({
      component: "content-script",
      operation: "content.scan",
      result: "ok",
      url: location.href,
      details: {
        reason,
        sentences: sentences.length,
        tokens: scan.tokens.length,
        scannedTextNodes: scan.stats.scannedTextNodes,
        rejectedBySubtree: scan.stats.rejectedBySubtree,
        rejectedByVisibility: scan.stats.rejectedByVisibility,
        rejectedByKnownWord: scan.stats.rejectedByKnownWord,
        rejectedByShape: scan.stats.rejectedByShape,
        rejectedByFrequency: scan.stats.rejectedByFrequency
      }
    });

    overlay.pruneDisconnected();
    if (scan.tokens.length === 0) {
      return;
    }

    const response = await runtimeMessage(createContentMessage("gloss.request", {
      pageUrl: location.href,
      sentences: sentences.map(toSerializableSentence)
    })).catch((error) => {
      handleRuntimeError("gloss.request", error);
      return undefined;
    });
    if (stopped || version !== scanVersion || !response) {
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
        const render = overlay.render(response.payload.items, tokenMap, version);
        trace({
          component: "content-script",
          operation: "content.render.result",
          requestId: response.requestId,
          result: "ok",
          url: location.href,
          details: {
            rendered: render.rendered,
            skippedMissingToken: render.skippedMissingToken,
            skippedStale: render.skippedStale,
            skippedDuplicate: render.skippedDuplicate,
            skippedOverlap: render.skippedOverlap,
            preserved: render.preserved,
            prunedDisconnected: render.prunedDisconnected
          }
        });
      }
    } else if (response.type === "error") {
      reportError("background.error", response.payload.message, response.requestId);
    }
  };

  const scheduleScan = (reason: string) => {
    if (stopped || !translationEnabled) {
      return;
    }
    if (scanTimer) {
      globalThis.clearTimeout(scanTimer);
    }
    scanTimer = globalThis.setTimeout(() => {
      scanTimer = undefined;
      void scanAndRender(reason);
    }, 150);
  };

  const activateTranslation = async (reason: string): Promise<void> => {
    if (stopped) {
      return;
    }
    translationEnabled = true;
    await scanAndRender(reason, { manualActivation: true });
  };

  const onShortcutKeyDown = (event: KeyboardEvent): void => {
    if (matchesShortcut(event, settings?.translateShortcutKey ?? "Alt+G")) {
      event.preventDefault();
      event.stopPropagation();
      void activateTranslation("shortcut");
    }
  };

  const runtime = (globalThis as typeof globalThis & { chrome?: typeof chrome }).chrome?.runtime;
  runtime?.onMessage?.addListener((message: unknown, _sender, sendResponse) => {
    if (!isTranslateActivationMessage(message)) {
      return false;
    }
    void activateTranslation("popup").then(() => {
      sendResponse({ ok: true });
    }).catch((error) => {
      handleRuntimeError("content.activate", error);
      sendResponse({ ok: false, message: error instanceof Error ? error.message : "Translation activation failed" });
    });
    return true;
  });

  document.addEventListener("keydown", onShortcutKeyDown, true);

  if (translationEnabled) {
    await scanAndRender("boot");
  }
  if (stopped) {
    return;
  }

  selectionController = createSelectionController({
    document,
    shortcutKey: settings?.shortcutKey ?? "Alt",
    onWordSelected(selection) {
      return runtimeMessage(createContentMessage("word.clicked", {
        pageUrl: location.href,
        sentence: selection.sentence,
        token: selection.token
      })).then(() => undefined).catch((error) => {
        handleRuntimeError("word.clicked", error);
      });
    },
    onError(error) {
      handleRuntimeError("word.clicked", error);
    }
  });
  selectionController.attach();

  observer = new MutationObserver((mutations) => {
    if (stopped) {
      return;
    }
    if (mutations.every((mutation) => overlay.ownsMutation(mutation) || isGlossaOwnedMutation(mutation))) {
      return;
    }
    scanVersion += 1;
    overlay.pruneDisconnected();
    observeOpenShadowRoots(document.body);
    scheduleScan("mutation");
  });
  observer.observe(document.body, { childList: true, characterData: true, subtree: true });
  observeOpenShadowRoots(document.body);
  window.addEventListener("scroll", () => scheduleScan("scroll"), { passive: true });

  function observeOpenShadowRoots(root: ParentNode): void {
    if (stopped) {
      return;
    }
    for (const element of Array.from(root.querySelectorAll("*"))) {
      if (element.shadowRoot) {
        observer?.observe(element.shadowRoot, { childList: true, characterData: true, subtree: true });
        observeOpenShadowRoots(element.shadowRoot);
      }
    }
  }
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
    let maybePromise: Promise<unknown> | void;
    try {
      maybePromise = sendMessage(message, (response: unknown) => {
        let error: chrome.runtime.LastError | undefined;
        try {
          error = chrome.runtime.lastError;
        } catch (lastError) {
          globalThis.clearTimeout(timeout);
          reject(lastError);
          return;
        }
        if (error) {
          globalThis.clearTimeout(timeout);
          reject(new Error(error.message));
        } else {
          settle(response);
        }
      }) as Promise<unknown> | void;
    } catch (error) {
      globalThis.clearTimeout(timeout);
      reject(error);
      return;
    }
    if (maybePromise && typeof maybePromise.then === "function") {
      maybePromise.then(settle, (error) => {
        globalThis.clearTimeout(timeout);
        reject(error);
      });
    }
  });
}

function isExtensionContextInvalidated(error: unknown): boolean {
  return error instanceof Error && /Extension context invalidated/i.test(error.message);
}

function handleBootError(error: unknown): void {
  if (isExtensionContextInvalidated(error)) {
    return;
  }
  reportError("boot failed", error);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => void boot().catch(handleBootError), { once: true });
} else {
  void boot().catch(handleBootError);
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

function urlWithoutHash(value: string): string {
  try {
    const url = new URL(value);
    url.hash = "";
    return url.toString();
  } catch {
    return value;
  }
}

function isGlossaOwnedMutation(mutation: MutationRecord): boolean {
  if (isGlossaOwnedNode(mutation.target)) {
    return true;
  }
  const changedNodes = [...Array.from(mutation.addedNodes), ...Array.from(mutation.removedNodes)];
  return changedNodes.length > 0 && changedNodes.every(isGlossaOwnedNode);
}

function isGlossaOwnedNode(node: Node): boolean {
  if (node.nodeType === Node.TEXT_NODE) {
    return node.parentElement?.closest("[data-glossa-owned='1']") !== null;
  }
  return node instanceof Element && node.closest("[data-glossa-owned='1']") !== null;
}

function isTranslateActivationMessage(value: unknown): value is { type: "glossa.activateTranslation" } {
  return typeof value === "object"
    && value !== null
    && "type" in value
    && value.type === "glossa.activateTranslation";
}
