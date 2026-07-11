import { loadKnownWords } from "../core/lexicon";
import { trace } from "../shared/diagnostics";
import { diagnosticPayloadFrom } from "../shared/errors";
import { createContentMessage, createGlossPortMessage, messageTimeoutError, validateBackgroundResponse, validateGlossPortOutbound } from "../shared/messages";
import { matchesShortcut } from "../shared/shortcut";
import GLOSSA_THEME from "../shared/theme.json";
import type { BackgroundResponseMessage, ContentToBackgroundMessage, ErrorPayload, GlossPortOutboundMessage, GlossTokenPayload } from "../shared/types";
import { userMessageForError } from "../shared/userMessages";
import { wordClickTimeoutMs } from "./cardTimeout";
import { createGlossOverlay } from "./overlay";
import { scanDocumentTextInChunks, toSerializableSentence, type ScanChunk, type ScannedToken } from "./scanner";
import { createSelectionController, type WordSelection } from "./selection";

const SCAN_CHUNK_MAX_TOKENS = 64;
const SCAN_CHUNK_MAX_MS = 16;
const MAX_UNACKED_SCAN_CHUNKS = 4;
const duplicatePromptResolvers = new WeakMap<Document, (confirmed: boolean) => void>();

interface ChunkAck {
  chunkId: string;
  sentAt: number;
  promise: Promise<void>;
  resolve(): void;
}

interface GlossSession {
  scanId: string;
  version: number;
  reason: string;
  tokenMap: Map<string, ScannedToken>;
  pendingTokenIds: Set<string>;
  pendingChunkAcks: Map<string, ChunkAck>;
  queuedOutcomes: GlossTokenPayload[];
  doneAfterQueuedOutcomes: boolean;
  terminalError?: ErrorPayload;
  aborted: boolean;
  port: chrome.runtime.Port;
}

async function boot(): Promise<void> {
  const settingsRequest = createContentMessage("settings.get", {});
  let settingsResponse: BackgroundResponseMessage;
  try {
    settingsResponse = await runtimeMessage(settingsRequest);
  } catch (error) {
    if (isExtensionContextInvalidated(error)) {
      throw error;
    }
    reportError("settings.get", error, settingsRequest.requestId);
    return;
  }
  if (settingsResponse.type !== "settings.response") {
    reportError("settings.get", settingsResponse.type === "error" ? settingsResponse.payload : new Error(`Unexpected settings response ${settingsResponse.type}`), settingsResponse.requestId);
    return;
  }
  const settings = settingsResponse.payload.settings;
  const knownWords = await loadKnownWords(settings.knownWordList);
  const overlay = createGlossOverlay(document, settings?.appearance);
  let scanVersion = 0;
  let scanTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
  let pageUrl = urlWithoutHash(location.href);
  let stopped = false;
  const lifecycleCleanups: Array<() => void> = [];
  const autoTranslateEnabled = settings?.autoTranslateEnabled ?? false;
  const wordClickTimeout = wordClickTimeoutMs(settings);
  let translationEnabled = autoTranslateEnabled;
  let selectionController: ReturnType<typeof createSelectionController> | undefined;
  let observer: MutationObserver | undefined;
  let currentGlossSession: GlossSession | undefined;
  const glossSessions = new Set<GlossSession>();
  let scanInProgress = 0;

  const stopContentScript = (reason: string): void => {
    if (stopped) {
      return;
    }
    stopped = true;
    cancelDuplicateCardPrompt(document);
    if (scanTimer) {
      globalThis.clearTimeout(scanTimer);
      scanTimer = undefined;
    }
    closeAllGlossSessions();
    runLifecycleCleanups();
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

  const registerLifecycleCleanup = (cleanup: () => void): void => {
    if (stopped) {
      cleanup();
      return;
    }
    lifecycleCleanups.push(cleanup);
  };

  const runLifecycleCleanups = (): void => {
    for (const cleanup of lifecycleCleanups.splice(0).reverse()) {
      cleanup();
    }
    observer = undefined;
    selectionController = undefined;
  };

  const addLifecycleEventListener = (
    target: EventTarget,
    type: string,
    listener: EventListener,
    options?: boolean | AddEventListenerOptions
  ): void => {
    target.addEventListener(type, listener, options);
    registerLifecycleCleanup(() => target.removeEventListener(type, listener, options));
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
      cancelDuplicateCardPrompt(document);
      overlay.clear();
      // Manual activation belongs to one route; navigation restores the configured automatic default.
      translationEnabled = options.manualActivation === true || autoTranslateEnabled;
    }
    if (!translationEnabled) {
      return;
    }
    const version = ++scanVersion;
    const tokenMap = new Map<string, ScannedToken>();
    let session: GlossSession | undefined;
    let chunks = 0;
    let tokens = 0;
    const startedAt = nowMs();

    overlay.pruneDisconnected();
    scanInProgress += 1;
    const stats = await (async () => {
      try {
        return await scanDocumentTextInChunks(document, knownWords, {
          scanVersion: version,
          requireRenderableRange: true,
          requireViewportRange: true,
          maxTokensPerChunk: SCAN_CHUNK_MAX_TOKENS,
          maxChunkDelayMs: SCAN_CHUNK_MAX_MS
        }, async (chunk) => {
          if (stopped || version !== scanVersion || session?.aborted === true) {
            return false;
          }
          if (!session) {
            session = startGlossSession({
              reason,
              version,
              pageUrl: location.href,
              tokenMap
            });
            if (!session) {
              return false;
            }
          }
          for (const token of chunk.tokens) {
            tokenMap.set(token.id, token);
          }
          const sent = await sendGlossChunk(session, chunk, () => version === scanVersion);
          if (sent) {
            chunks += 1;
            tokens += chunk.tokens.length;
          }
          return sent;
        });
      } finally {
        scanInProgress -= 1;
        if (scanInProgress === 0) {
          flushQueuedGlossOutcomes();
        }
      }
    })();
    trace({
      component: "content-script",
      operation: "content.scan",
      result: "ok",
      url: location.href,
      details: {
        reason,
        chunks,
        tokens,
        elapsedMs: elapsedMs(startedAt),
        scannedTextNodes: stats.scannedTextNodes,
        rejectedBySubtree: stats.rejectedBySubtree,
        rejectedByVisibility: stats.rejectedByVisibility,
        rejectedByKnownWord: stats.rejectedByKnownWord,
        rejectedByShape: stats.rejectedByShape,
        rejectedByFrequency: stats.rejectedByFrequency
      }
    });

    if (!session) {
      return;
    }
    sendGlossScanEnd(session);
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
    session.queuedOutcomes = [];
    session.doneAfterQueuedOutcomes = false;
    delete session.terminalError;
    session.aborted = true;
    resolvePendingChunkAcks(session);
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
    tokenMap: Map<string, ScannedToken>;
  }): GlossSession | undefined => {
    if (stopped) {
      return undefined;
    }
    const runtime = (globalThis as typeof globalThis & { chrome?: typeof chrome }).chrome?.runtime;
    if (!runtime?.connect) {
      reportError("gloss.session", new Error("chrome.runtime.connect is unavailable"));
      return undefined;
    }
    const scanId = createScanId();
    let port: chrome.runtime.Port;
    try {
      port = runtime.connect({ name: "gloss.session" });
    } catch (error) {
      handleRuntimeError("gloss.session.connect", error);
      return undefined;
    }
    const session: GlossSession = {
      scanId,
      version: sessionInput.version,
      reason: sessionInput.reason,
      tokenMap: sessionInput.tokenMap,
      pendingTokenIds: new Set(),
      pendingChunkAcks: new Map(),
      queuedOutcomes: [],
      doneAfterQueuedOutcomes: false,
      aborted: false,
      port
    };
    glossSessions.add(session);
    currentGlossSession = session;
    port.onDisconnect.addListener(() => {
      glossSessions.delete(session);
      resolvePendingChunkAcks(session);
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
      port.postMessage(createGlossPortMessage("gloss.scan.start", {
        scanId,
        pageUrl: sessionInput.pageUrl
      }));
    } catch (error) {
      handleRuntimeError("gloss.scan.start", error);
      return undefined;
    }
    return session;
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
    if (message.type === "gloss.chunk.ack") {
      const ack = session.pendingChunkAcks.get(message.payload.chunkId);
      if (ack) {
        session.pendingChunkAcks.delete(message.payload.chunkId);
        ack.resolve();
        trace({
          component: "content-script",
          operation: "content.scan.chunk",
          result: "ok",
          url: location.href,
          details: {
            reason,
            scanId: session.scanId,
            acceptedTokens: message.payload.acceptedTokens,
            ackMs: elapsedMs(ack.sentAt)
          }
        });
      }
      return;
    }
    if (message.type === "gloss.token") {
      if (scanInProgress > 0) {
        session.queuedOutcomes.push(message.payload);
        trace({
          component: "content-script",
          operation: "content.token.queue",
          result: "ok",
          url: location.href,
          details: {
            reason,
            scanId: session.scanId,
            tokenId: message.payload.tokenId,
            status: message.payload.status,
            queued: session.queuedOutcomes.length
          }
        });
        return;
      }
      applyGlossOutcome(session, message.payload, reason, false);
      return;
    }
    if (message.type === "gloss.done") {
      if (scanInProgress > 0 && session.queuedOutcomes.length > 0) {
        session.doneAfterQueuedOutcomes = true;
        return;
      }
      completeGlossSession(session, reason);
      return;
    }
    if (scanInProgress > 0) {
      session.terminalError = message.payload;
      session.aborted = true;
      resolvePendingChunkAcks(session);
      return;
    }
    failGlossSession(session, message.payload);
  };

  const applyGlossOutcome = (session: GlossSession, outcome: GlossTokenPayload, reason: string, queued: boolean): void => {
    const current = currentGlossSession === session && session.version === scanVersion;
    const token = session.tokenMap.get(outcome.tokenId);
    const render = current || (queued && token)
      ? overlay.applyTokenOutcome(token, outcome, token?.scanVersion ?? session.version)
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
        stale: !current,
        queued
      }
    });
  };

  const flushQueuedGlossOutcomes = (): void => {
    for (const session of Array.from(glossSessions)) {
      while (session.queuedOutcomes.length > 0) {
        applyGlossOutcome(session, session.queuedOutcomes.shift()!, session.reason, true);
      }
      if (session.terminalError) {
        const error = session.terminalError;
        delete session.terminalError;
        failGlossSession(session, error);
        continue;
      }
      if (session.doneAfterQueuedOutcomes) {
        session.doneAfterQueuedOutcomes = false;
        completeGlossSession(session, session.reason);
      }
    }
  };

  const completeGlossSession = (session: GlossSession, reason: string): void => {
    trace({
      component: "content-script",
      operation: "content.scan.done",
      result: "ok",
      url: location.href,
      details: { reason, scanId: session.scanId }
    });
    closeGlossSession(session);
  };

  const failGlossSession = (session: GlossSession, error: ErrorPayload): void => {
    overlay.markStalePendingAsError(session.pendingTokenIds, userMessageForError(error, "ai"));
    closeGlossSession(session);
    reportError("gloss.session.error", error);
  };

  const sendGlossChunk = async (session: GlossSession, chunk: ScanChunk, isCurrent: () => boolean): Promise<boolean> => {
    await waitForChunkCapacity(session);
    if (stopped || session.aborted || !isCurrent()) {
      return false;
    }
    const chunkId = `${session.scanId}:${chunk.chunkIndex}`;
    const ack = createChunkAck(chunkId);
    session.pendingChunkAcks.set(chunkId, ack);
    try {
      session.port.postMessage(createGlossPortMessage("gloss.scan.chunk", {
        scanId: session.scanId,
        chunkId,
        chunkIndex: chunk.chunkIndex,
        pageUrl: location.href,
        sentences: chunk.sentences.map(toSerializableSentence)
      }));
    } catch (error) {
      session.pendingChunkAcks.delete(chunkId);
      ack.resolve();
      handleRuntimeError("gloss.scan.chunk", error);
      return false;
    }
    trace({
      component: "content-script",
      operation: "content.scan.chunk",
      result: "ok",
      url: location.href,
      details: {
        scanId: session.scanId,
        chunkIndex: chunk.chunkIndex,
        tokens: chunk.tokens.length,
        sentences: chunk.sentences.length,
        pendingAcks: session.pendingChunkAcks.size
      }
    });
    return true;
  };

  const sendGlossScanEnd = (session: GlossSession): void => {
    if (session.aborted) {
      return;
    }
    try {
      session.port.postMessage(createGlossPortMessage("gloss.scan.end", {
        scanId: session.scanId
      }));
    } catch (error) {
      handleRuntimeError("gloss.scan.end", error);
    }
  };

  async function waitForChunkCapacity(session: GlossSession): Promise<void> {
    while (!stopped && !session.aborted && session.pendingChunkAcks.size >= MAX_UNACKED_SCAN_CHUNKS) {
      await Promise.race(Array.from(session.pendingChunkAcks.values()).map((ack) => ack.promise));
    }
  }

  function createChunkAck(chunkId: string): ChunkAck {
    let resolveAck: () => void = () => undefined;
    const promise = new Promise<void>((resolve) => {
      resolveAck = resolve;
    });
    return {
      chunkId,
      sentAt: nowMs(),
      promise,
      resolve: resolveAck
    };
  }

  function resolvePendingChunkAcks(session: GlossSession): void {
    for (const ack of session.pendingChunkAcks.values()) {
      ack.resolve();
    }
    session.pendingChunkAcks.clear();
  }

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
    cancelDuplicateCardPrompt(document);
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

  const onShortcutKeyDown: EventListener = (event): void => {
    if (!(event instanceof KeyboardEvent)) {
      return;
    }
    // Selection hold exits in its own listener while this listener keeps matching extension chords actionable.
    if (matchesShortcut(event, settings?.translateShortcutKey ?? "Alt+G")) {
      event.preventDefault();
      event.stopPropagation();
      void toggleTranslation("shortcut");
    }
  };

  const runtime = (globalThis as typeof globalThis & { chrome?: typeof chrome }).chrome?.runtime;
  const onRuntimeMessage: Parameters<typeof chrome.runtime.onMessage.addListener>[0] = (message: unknown, _sender, sendResponse) => {
    if (isTranslationStateMessage(message)) {
      sendResponse({ ok: true, enabled: translationEnabled } satisfies TranslationControlResponse);
      return false;
    }
    if (!isTranslateActivationMessage(message) && !isTranslationToggleMessage(message)) {
      return false;
    }
    const action = isTranslationToggleMessage(message)
      ? toggleTranslation("popup")
      : enableTranslation("popup");
    void action.then(() => {
      sendResponse({ ok: true, enabled: translationEnabled } satisfies TranslationControlResponse);
    }).catch((error) => {
      handleRuntimeError("content.activate", error);
      const payload = diagnosticPayloadFrom(error, {
        reason: "runtime",
        message: "Translation activation failed",
        service: "runtime"
      });
      sendResponse({ ok: false, message: payload.message, error: payload } satisfies TranslationControlResponse);
    });
    return true;
  };
  if (runtime?.onMessage) {
    runtime.onMessage.addListener(onRuntimeMessage);
    registerLifecycleCleanup(() => runtime.onMessage.removeListener(onRuntimeMessage));
  }

  addLifecycleEventListener(document, "keydown", onShortcutKeyDown, true);

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
      }), wordClickTimeout).then((response) => {
        if (response.type === "word.card.duplicate") {
          return promptDuplicateCardCreation(document, {
            surface: response.payload.surface,
            timeoutMs: response.payload.promptMs
          }).then((confirmed) => {
            if (!confirmed) {
              overlay.applyCardFeedback({ tokenId: selection.token.id, feedback: "card-cancelled" });
              return undefined;
            }
            return runtimeMessage(createContentMessage("word.clicked", {
              pageUrl: location.href,
              sentence: selection.sentence,
              token: selection.token,
              allowDuplicateCard: true
            }), wordClickTimeout).then((confirmedResponse) => {
              applyCardResponse(selection, confirmedResponse);
            });
          });
        }
        applyCardResponse(selection, response);
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

  function applyCardResponse(selection: WordSelection, response: BackgroundResponseMessage): void {
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
  }
  selectionController.attach();
  registerLifecycleCleanup(() => selectionController?.detach());

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
  const onScroll = (): void => scheduleScan("scroll");
  const scrollObservedShadowRoots = new WeakSet<ShadowRoot>();
  addLifecycleEventListener(document, "scroll", onScroll, { passive: true, capture: true });
  addLifecycleEventListener(window, "scroll", onScroll, { passive: true });
  registerLifecycleCleanup(() => observer?.disconnect());
  observer.observe(document.body, { childList: true, characterData: true, subtree: true });
  observeOpenShadowRoots(document.body);

  function observeOpenShadowRoots(root: ParentNode): void {
    if (stopped) {
      return;
    }
    for (const element of Array.from(root.querySelectorAll("*"))) {
      if (element.shadowRoot) {
        if (!scrollObservedShadowRoots.has(element.shadowRoot)) {
          scrollObservedShadowRoots.add(element.shadowRoot);
          addLifecycleEventListener(element.shadowRoot, "scroll", onScroll, { passive: true, capture: true });
        }
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
    let settled = false;
    const timeout = globalThis.setTimeout(() => {
      if (settled) {
        return;
      }
      trace({
        component: "content-script",
        operation: message.type,
        requestId: message.requestId,
        result: "timeout",
        url: location.href
      });
      rejectMessage(messageTimeoutError(message));
    }, timeoutMs);
    const finish = (callback: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      globalThis.clearTimeout(timeout);
      callback();
    };
    const resolveMessage = (value: unknown): void => {
      finish(() => {
        try {
          resolve(validateBackgroundResponse(value, message));
        } catch (error) {
          reject(error);
        }
      });
    };
    const rejectMessage = (error: unknown): void => {
      finish(() => reject(error));
    };
    let maybePromise: Promise<unknown> | void;
    try {
      maybePromise = sendMessage(message, (response: unknown) => {
        if (settled) {
          return;
        }
        let error: chrome.runtime.LastError | undefined;
        try {
          error = chrome.runtime.lastError;
        } catch (lastError) {
          rejectMessage(lastError);
          return;
        }
        if (error) {
          rejectMessage(new Error(error.message));
        } else {
          resolveMessage(response);
        }
      }) as Promise<unknown> | void;
    } catch (error) {
      rejectMessage(error);
      return;
    }
    if (maybePromise && typeof maybePromise.then === "function") {
      maybePromise.then(resolveMessage, rejectMessage);
    }
  });
}

function promptDuplicateCardCreation(doc: Document, input: { surface: string; timeoutMs: number }): Promise<boolean> {
  cancelDuplicateCardPrompt(doc);
  return new Promise((resolve) => {
    const previousFocus = doc.activeElement;
    const prompt = doc.createElement("div");
    prompt.dataset.glossaOwned = "1";
    prompt.dataset.glossaDuplicateCardPrompt = "1";
    prompt.setAttribute("role", "dialog");
    prompt.setAttribute("aria-label", "重复制卡确认");
    prompt.style.cssText = [
      "position:fixed",
      "top:20px",
      "right:20px",
      "z-index:2147483647",
      "display:grid",
      "grid-template-columns:minmax(0,1fr) auto auto",
      "align-items:center",
      "gap:12px",
      "max-width:min(440px,calc(100vw - 40px))",
      "padding:15px 16px",
      "border:1px solid rgba(23,24,20,0.32)",
      `border-top:2px solid ${GLOSSA_THEME.accent}`,
      "border-radius:1px",
      "background:rgba(250,248,241,0.98)",
      "color:#171814",
      "font:14px/1.4 ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif",
      "box-shadow:0 20px 48px rgba(23,24,20,0.18)"
    ].join(";");
    const style = doc.createElement("style");
    style.dataset.glossaOwned = "1";
    style.textContent = `
      [data-glossa-duplicate-card-prompt="1"] button:focus-visible {
        outline: 3px solid rgba(227, 179, 77, 0.72);
        outline-offset: 2px;
      }
      @media (max-width: 360px) {
        [data-glossa-duplicate-card-prompt="1"] {
          left: 12px !important;
          top: 12px !important;
          right: 12px !important;
          grid-template-columns: repeat(2, minmax(0, 1fr)) !important;
          gap: 10px !important;
          max-width: none !important;
          padding: 14px !important;
        }
        [data-glossa-duplicate-card-prompt="1"] > span {
          grid-column: 1 / -1;
        }
        [data-glossa-duplicate-card-prompt="1"] > button {
          width: 100%;
          min-width: 0 !important;
        }
      }
    `;
    const text = doc.createElement("span");
    text.id = "glossa-duplicate-card-prompt-description";
    text.textContent = `${input.surface} 已经制过卡，继续制卡？`;
    text.style.cssText = "min-width:0;overflow-wrap:anywhere;font-weight:650;letter-spacing:0.005em";
    prompt.setAttribute("aria-describedby", text.id);
    const confirm = doc.createElement("button");
    confirm.type = "button";
    confirm.textContent = "继续制卡";
    confirm.setAttribute("aria-label", "继续制卡");
    const cancel = doc.createElement("button");
    cancel.type = "button";
    cancel.textContent = "取消";
    cancel.setAttribute("aria-label", "取消制卡");
    confirm.style.cssText = [
      "min-width:88px",
      "height:36px",
      `border:1px solid ${GLOSSA_THEME.accent}`,
      "border-radius:2px",
      `background:${GLOSSA_THEME.accent}`,
      "color:#fffaf2",
      "font:740 14px/1 ui-sans-serif,system-ui",
      "box-shadow:0 7px 16px rgba(200,71,36,0.17)",
      "cursor:pointer"
    ].join(";");
    cancel.style.cssText = [
      "min-width:54px",
      "height:36px",
      "border:1px solid rgba(23,24,20,0.32)",
      "border-radius:2px",
      "background:transparent",
      "color:#171814",
      "font:740 14px/1 ui-sans-serif,system-ui",
      "cursor:pointer"
    ].join(";");
    prompt.append(style, text, confirm, cancel);
    let settled = false;
    let timer: ReturnType<typeof globalThis.setTimeout> | undefined;
    const finish = (confirmed: boolean): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer !== undefined) {
        globalThis.clearTimeout(timer);
      }
      duplicatePromptResolvers.delete(doc);
      prompt.remove();
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected && previousFocus !== doc.body) {
        previousFocus.focus({ preventScroll: true });
      }
      resolve(confirmed);
    };
    timer = globalThis.setTimeout(() => finish(false), input.timeoutMs);
    duplicatePromptResolvers.set(doc, finish);
    confirm.addEventListener("click", () => finish(true), { once: true });
    cancel.addEventListener("click", () => finish(false), { once: true });
    prompt.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        finish(false);
      }
    });
    (doc.body ?? doc.documentElement).append(prompt);
    confirm.focus({ preventScroll: true });
  });
}

function cancelDuplicateCardPrompt(doc: Document): void {
  const resolver = duplicatePromptResolvers.get(doc);
  if (resolver) {
    resolver(false);
    return;
  }
  doc.querySelector("[data-glossa-duplicate-card-prompt]")?.remove();
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

function nowMs(): number {
  return globalThis.performance?.now?.() ?? Date.now();
}

function elapsedMs(startedAt: number): number {
  return Math.round(nowMs() - startedAt);
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

function isTranslationStateMessage(value: unknown): value is { type: "glossa.getTranslationState" } {
  return typeof value === "object"
    && value !== null
    && "type" in value
    && value.type === "glossa.getTranslationState";
}

function isTranslationToggleMessage(value: unknown): value is { type: "glossa.toggleTranslation" } {
  return typeof value === "object"
    && value !== null
    && "type" in value
    && value.type === "glossa.toggleTranslation";
}

type TranslationControlResponse = { ok: true; enabled: boolean } | { ok: false; message: string; error?: ErrorPayload };
