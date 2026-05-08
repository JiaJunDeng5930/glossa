import { loadKnownWords } from "../core/lexicon";
import { trace } from "../shared/diagnostics";
import { diagnosticPayloadFrom } from "../shared/errors";
import { createContentMessage, createGlossPortMessage, messageTimeoutError, validateBackgroundResponse, validateGlossPortOutbound } from "../shared/messages";
import { matchesShortcut } from "../shared/shortcut";
import type { BackgroundResponseMessage, ContentToBackgroundMessage, ErrorPayload, GlossPortOutboundMessage, GlossTokenPayload, SentenceCandidate } from "../shared/types";
import { userMessageForError } from "../shared/userMessages";
import { createGlossOverlay } from "./overlay";
import { scanDocumentText, toSerializableSentence, type ScannedToken } from "./scanner";
import { createSelectionController } from "./selection";

const WORD_CLICK_TIMEOUT_MS = 60_000;

interface GlossSession {
  scanId: string;
  version: number;
  tokenMap: Map<string, ScannedToken>;
  pendingTokenIds: Set<string>;
  port: chrome.runtime.Port;
}

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
  let currentGlossSession: GlossSession | undefined;
  const glossSessions = new Set<GlossSession>();

  const stopContentScript = (reason: string): void => {
    if (stopped) {
      return;
    }
    stopped = true;
    if (scanTimer) {
      globalThis.clearTimeout(scanTimer);
      scanTimer = undefined;
    }
    closeAllGlossSessions();
    observer?.disconnect();
    selectionController?.detach();
    overlay.setSelectionMode(false);
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
      closeAllGlossSessions();
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

    startGlossSession({
      reason,
      version,
      pageUrl: location.href,
      sentences: sentences.map(toSerializableSentence),
      tokenMap
    });
  };

  const closeAllGlossSessions = (): void => {
    for (const session of Array.from(glossSessions)) {
      closeGlossSession(session);
    }
  };

  const closeGlossSession = (session: GlossSession): void => {
    glossSessions.delete(session);
    if (currentGlossSession === session) {
      currentGlossSession = undefined;
    }
    try {
      session.port.disconnect();
    } catch (error) {
      if (isExtensionContextInvalidated(error)) {
        stopContentScript("extension-context-invalidated");
      }
    }
  };

  const startGlossSession = (sessionInput: {
    reason: string;
    version: number;
    pageUrl: string;
    sentences: SentenceCandidate[];
    tokenMap: Map<string, ScannedToken>;
  }): void => {
    if (stopped) {
      return;
    }
    const runtime = (globalThis as typeof globalThis & { chrome?: typeof chrome }).chrome?.runtime;
    if (!runtime?.connect) {
      reportError("gloss.session", new Error("chrome.runtime.connect is unavailable"));
      return;
    }
    const scanId = createScanId();
    let port: chrome.runtime.Port;
    try {
      port = runtime.connect({ name: "gloss.session" });
    } catch (error) {
      handleRuntimeError("gloss.session.connect", error);
      return;
    }
    const session: GlossSession = {
      scanId,
      version: sessionInput.version,
      tokenMap: sessionInput.tokenMap,
      pendingTokenIds: new Set(),
      port
    };
    glossSessions.add(session);
    currentGlossSession = session;
    port.onDisconnect.addListener(() => {
      glossSessions.delete(session);
      if (currentGlossSession === session) {
        currentGlossSession = undefined;
      }
      const error = readRuntimeLastError();
      if (error) {
        handleRuntimeError("gloss.session.disconnect", new Error(error.message));
      }
    });
    port.onMessage.addListener((rawMessage: unknown) => {
      handleGlossPortMessage(rawMessage, session, sessionInput.reason);
    });
    try {
      port.postMessage(createGlossPortMessage("gloss.scan", {
        scanId,
        pageUrl: sessionInput.pageUrl,
        sentences: sessionInput.sentences
      }));
    } catch (error) {
      handleRuntimeError("gloss.scan", error);
    }
  };

  const handleGlossPortMessage = (rawMessage: unknown, session: GlossSession, reason: string): void => {
    let message: GlossPortOutboundMessage;
    try {
      message = validateGlossPortOutbound(rawMessage, session.scanId);
    } catch (error) {
      reportError("gloss.session.message", error);
      return;
    }
    if (stopped) {
      return;
    }
    if (message.type === "gloss.token") {
      const outcome = message.payload;
      const current = currentGlossSession === session && session.version === scanVersion;
      const render = current
        ? overlay.applyTokenOutcome(session.tokenMap.get(outcome.tokenId), outcome, session.version)
        : overlay.applyStalePendingOutcome(outcome);
      updatePendingTokenState(session, outcome, render);
      trace({
        component: "content-script",
        operation: "content.token",
        result: render.result === "skipped" ? "ignored" : "ok",
        url: location.href,
        details: {
          reason,
          scanId: session.scanId,
          tokenId: outcome.tokenId,
          status: outcome.status,
          render: render.result,
          skipReason: render.reason,
          stale: !current
        }
      });
      return;
    }
    if (message.type === "gloss.done") {
      trace({
        component: "content-script",
        operation: "content.scan.done",
        result: "ok",
        url: location.href,
        details: { reason, scanId: session.scanId }
      });
      closeGlossSession(session);
      return;
    }
    overlay.markStalePendingAsError(session.pendingTokenIds, userMessageForError(message.payload, "ai"));
    closeGlossSession(session);
    reportError("gloss.session.error", message.payload);
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

  const enableTranslation = async (reason: string): Promise<void> => {
    if (stopped) {
      return;
    }
    translationEnabled = true;
    await scanAndRender(reason, { manualActivation: true });
  };

  const disableTranslation = (reason: string): void => {
    if (stopped) {
      return;
    }
    translationEnabled = false;
    if (scanTimer) {
      globalThis.clearTimeout(scanTimer);
      scanTimer = undefined;
    }
    scanVersion += 1;
    closeAllGlossSessions();
    overlay.clear();
    trace({
      component: "content-script",
      operation: "content.translation.disable",
      result: "ok",
      url: location.href,
      details: { reason }
    });
  };

  const toggleTranslation = async (reason: string): Promise<void> => {
    if (translationEnabled) {
      disableTranslation(reason);
      return;
    }
    await enableTranslation(reason);
  };

  const onShortcutKeyDown = (event: KeyboardEvent): void => {
    if (matchesShortcut(event, settings?.translateShortcutKey ?? "Alt+G")) {
      event.preventDefault();
      event.stopPropagation();
      void toggleTranslation("shortcut");
    }
  };

  const runtime = (globalThis as typeof globalThis & { chrome?: typeof chrome }).chrome?.runtime;
  runtime?.onMessage?.addListener((message: unknown, _sender, sendResponse) => {
    if (!isTranslateActivationMessage(message)) {
      return false;
    }
    void enableTranslation("popup").then(() => {
      sendResponse({ ok: true });
    }).catch((error) => {
      handleRuntimeError("content.activate", error);
      const payload = diagnosticPayloadFrom(error, {
        reason: "runtime",
        message: "Translation activation failed",
        service: "runtime"
      });
      sendResponse({ ok: false, message: payload.message, error: payload } satisfies TranslateActivationResponse);
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
      overlay.applyCardFeedback(selection.renderToken
        ? { tokenId: selection.token.id, token: selection.renderToken, feedback: "card-pending" }
        : { tokenId: selection.token.id, feedback: "card-pending" });
      return runtimeMessage(createContentMessage("word.clicked", {
        pageUrl: location.href,
        sentence: selection.sentence,
        token: selection.token
      }), WORD_CLICK_TIMEOUT_MS).then((response) => {
        const created = response.type === "word.clicked.ok" && typeof response.payload.noteId === "number";
        const failureMessage = response.type === "error" ? userMessageForError(response.payload, "anki") : undefined;
        overlay.applyCardFeedback(selection.renderToken
          ? {
            tokenId: selection.token.id,
            token: selection.renderToken,
            feedback: created ? "card-success" : "card-error",
            ...(failureMessage ? { message: failureMessage } : {})
          }
          : {
            tokenId: selection.token.id,
            feedback: created ? "card-success" : "card-error",
            ...(failureMessage ? { message: failureMessage } : {})
          });
        if (!created && response.type === "error") {
          reportError("word.clicked", response.payload, response.requestId);
        }
      }).catch((error) => {
        if (isExtensionContextInvalidated(error)) {
          handleRuntimeError("word.clicked", error);
          return;
        }
        overlay.applyCardFeedback(selection.renderToken
          ? { tokenId: selection.token.id, token: selection.renderToken, feedback: "card-error", message: runtimeFailureMessage(error) }
          : { tokenId: selection.token.id, feedback: "card-error", message: runtimeFailureMessage(error) });
        handleRuntimeError("word.clicked", error);
      });
    },
    onSelectionModeChange(active) {
      overlay.setSelectionMode(active);
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

  function updatePendingTokenState(session: GlossSession, outcome: GlossTokenPayload, render: { result: string }): void {
    if (outcome.status === "pending" && render.result !== "skipped") {
      session.pendingTokenIds.add(outcome.tokenId);
      return;
    }
    if (outcome.status === "ready" || outcome.status === "hidden" || outcome.status === "error") {
      session.pendingTokenIds.delete(outcome.tokenId);
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

function createScanId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `scan-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function readRuntimeLastError(): chrome.runtime.LastError | undefined {
  try {
    return chrome.runtime.lastError;
  } catch {
    return undefined;
  }
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

function runtimeFailureMessage(error: unknown): string {
  return userMessageForError(diagnosticPayloadFrom(error, {
    reason: isMessageTimeout(error) ? "timeout" : "runtime",
    message: "Runtime request failed",
    service: "runtime"
  }), "runtime");
}

function isMessageTimeout(error: unknown): boolean {
  return error instanceof Error && /^Message timeout for /.test(error.message);
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

type TranslateActivationResponse = { ok: true } | { ok: false; message: string; error?: ErrorPayload };
