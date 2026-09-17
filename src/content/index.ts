import { loadKnownWords } from "../core/lexicon";
import { glossScanConfigHash } from "../core/cache";
import { trace } from "../shared/diagnostics";
import { diagnosticPayloadFrom } from "../shared/errors";
import { createContentMessage, createGlossPortMessage, validateGlossPortOutbound } from "../shared/messages";
import { glossOutputSettingsChanged, mergeStoredSettings } from "../shared/settings";
import { cardOperationTimeoutMs } from "../shared/cardTimeout";
import { promptDuplicateCardCreation, cancelDuplicateCardPrompt } from "./duplicateCardPrompt";
import type { BackgroundResponseMessage, ContentToBackgroundMessage, ErrorPayload, GlossaSettings, GlossPortOutboundMessage, GlossTokenPayload } from "../shared/types";
import { userMessageForError } from "../shared/userMessages";
import { createGlossOverlay } from "./overlay";
import { glossRefreshKey, scanDocumentTextInChunks, toSerializableSentence, type ScanChunk, type ScannedToken } from "./scanner";
import { createSelectionController } from "./selection";
import { createTranslationShortcutHandler } from "./translationShortcut";
import { sendRuntimeRequest } from "../shared/runtimeClient";
import { createCardOperations } from "./cardOperations";

const SCAN_CHUNK_MAX_TOKENS = 64;
const SCAN_CHUNK_MAX_MS = 16;
const MAX_UNACKED_SCAN_CHUNKS = 4;

interface ChunkAck {
  sentAt: number;
  promise: Promise<void>;
  resolve(): void;
}

interface GlossSession {
  scanId: string;
  pageUrl: string;
  version: number;
  tokenMap: Map<string, ScannedToken>;
  pendingTokenIds: Set<string>;
  pendingChunkAcks: Map<string, ChunkAck>;
  aborted: boolean;
  port: chrome.runtime.Port;
}

type RuntimeMessageListener = Parameters<typeof chrome.runtime.onMessage.addListener>[0];
type TranslationControlHandler = RuntimeMessageListener;

const translationControlOwner = createTranslationControlOwner();
let bootFailureCleanup: (() => void) | undefined;

async function boot(): Promise<void> {
  bootFailureCleanup = () => translationControlOwner.close();
  const settingsRequest = createContentMessage("settings.get", {});
  let settingsResponse: BackgroundResponseMessage;
  try {
    settingsResponse = await runtimeMessage(settingsRequest);
  } catch (error) {
    if (isExtensionContextInvalidated(error)) {
      translationControlOwner.close();
      bootFailureCleanup = undefined;
      throw error;
    }
    reportError("settings.get", error, settingsRequest.requestId);
    translationControlOwner.close();
    bootFailureCleanup = undefined;
    return;
  }
  if (settingsResponse.type !== "settings.response") {
    reportError("settings.get", settingsResponse.type === "error" ? settingsResponse.payload : new Error(`Unexpected settings response ${settingsResponse.type}`), settingsResponse.requestId);
    translationControlOwner.close();
    bootFailureCleanup = undefined;
    return;
  }
  let settings = settingsResponse.payload.settings;
  const storageChanges = (globalThis as typeof globalThis & { chrome?: typeof chrome }).chrome?.storage?.onChanged;
  let queuedSettingsChange: GlossaSettings | undefined;
  let reconcileSettingsChange: ((nextSettings: GlossaSettings) => Promise<void>) | undefined;
  const onStoredSettingsChanged: Parameters<typeof chrome.storage.onChanged.addListener>[0] = (changes, areaName) => {
    const settingsChange = changes.settings;
    if (areaName !== "local" || !settingsChange) {
      return;
    }
    const nextSettings = mergeStoredSettings(settingsChange.newValue);
    if (!reconcileSettingsChange) {
      queuedSettingsChange = nextSettings;
      return;
    }
    void reconcileSettingsChange(nextSettings).catch((error) => handleRuntimeError("settings.changed", error));
  };
  if (storageChanges) {
    // Register before the first word-list load so settings writes during content startup are queued.
    storageChanges.addListener(onStoredSettingsChanged);
  }
  let knownWords = await loadKnownWords(settings.knownWordList);
  let knownWordsLoadRevision = 0;
  const overlay = createGlossOverlay(document, settings?.appearance);
  let scanVersion = 0;
  let scanTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
  let pageUrl = urlWithoutHash(location.href);
  let stopped = false;
  const lifecycleCleanups: Array<() => void> = [];
  let autoTranslateEnabled = settings?.autoTranslateEnabled ?? false;
  let wordClickTimeout = cardOperationTimeoutMs(settings);
  let translationEnabled = autoTranslateEnabled;
  let bootSettingsOpen = true;
  let selectionController: ReturnType<typeof createSelectionController> | undefined;
  let observer: MutationObserver | undefined;
  let currentGlossSession: GlossSession | undefined;
  const glossSessions = new Set<GlossSession>();
  const pendingGenerationRefreshKeys = new Set<string>();
  const cardOperations = createCardOperations({
    document, overlay,
    request: (request) => runtimeMessage(request, wordClickTimeout),
    prompt: (input) => promptDuplicateCardCreation(document, input),
    cancelPrompt: () => cancelDuplicateCardPrompt(document),
    onError: (error) => handleRuntimeError("word.clicked", error),
    errorMessage: runtimeFailureMessage
  });

  const stopContentScript = (reason: string): void => {
    if (stopped) {
      return;
    }
    stopped = true;
    cardOperations.cancelAll();
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
  bootFailureCleanup = () => stopContentScript("boot-failed");

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
  if (storageChanges) {
    registerLifecycleCleanup(() => storageChanges.removeListener(onStoredSettingsChanged));
  }
  registerLifecycleCleanup(() => translationControlOwner.close());

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

  const synchronizeRouteState = (manualActivation = false): boolean => {
    const routeUrl = urlWithoutHash(location.href);
    if (routeUrl === pageUrl) {
      return false;
    }
    pageUrl = routeUrl;
    scanVersion += 1;
    closeAllGlossSessions();
    cardOperations.cancelAll();
    overlay.clear();
    pendingGenerationRefreshKeys.clear();
    // Manual activation belongs to one route; navigation restores the configured automatic default.
    translationEnabled = manualActivation || autoTranslateEnabled;
    return true;
  };

  const scanAndRender = async (reason: string, options: { manualActivation?: boolean } = {}) => {
    if (stopped) {
      return;
    }
    synchronizeRouteState(options.manualActivation === true);
    if (!translationEnabled) {
      return;
    }
    const version = ++scanVersion;
    const scanPageUrl = location.href;
    const scanSettings = settings;
    const scanKnownWords = knownWords;
    const scanConfigHash = glossScanConfigHash(scanSettings);
    const tokenMap = new Map<string, ScannedToken>();
    let session: GlossSession | undefined;
    let chunks = 0;
    let tokens = 0;
    const startedAt = nowMs();

    overlay.pruneDisconnected();
    const stats = await scanDocumentTextInChunks(document, scanKnownWords, {
          scanVersion: version,
          requireRenderableRange: true,
          requireViewportRange: true,
          forceRefreshKeys: pendingGenerationRefreshKeys,
          shouldContinue: () => !stopped && version === scanVersion && session?.aborted !== true,
          onShadowRoot: observeShadowRoot,
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
              pageUrl: scanPageUrl,
              scanConfigHash,
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
        }).catch((error) => {
      if (session && !session.aborted) {
        failGlossSession(session, diagnosticPayloadFrom(error, {
          reason: "runtime",
          message: "Content scan failed",
          service: "runtime"
        }));
      }
      throw error;
    });
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

    // Zero-candidate scans stay silent so ordinary reading has no empty-state interruption.
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
    scanConfigHash: string;
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
      pageUrl: sessionInput.pageUrl,
      version: sessionInput.version,
      tokenMap: sessionInput.tokenMap,
      pendingTokenIds: new Set(),
      pendingChunkAcks: new Map(),
      aborted: false,
      port
    };
    glossSessions.add(session);
    currentGlossSession = session;
    port.onDisconnect.addListener(() => {
      if (session.aborted) {
        return;
      }
      const error = readRuntimeLastError();
      failGlossSession(session, diagnosticPayloadFrom(
        error ? new Error(error.message) : new Error("Gloss session disconnected"),
        { reason: "runtime", message: "Gloss session disconnected", service: "runtime" }
      ));
    });
    port.onMessage.addListener((rawMessage: unknown) => {
      handleGlossPortMessage(rawMessage, session, sessionInput.reason);
    });
    try {
      port.postMessage(createGlossPortMessage("gloss.scan.start", {
        scanId,
        pageUrl: sessionInput.pageUrl,
        scanConfigHash: sessionInput.scanConfigHash
      }));
    } catch (error) {
      handleRuntimeError("gloss.scan.start", error);
      closeGlossSession(session);
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
      applyGlossOutcome(session, message.payload, reason, false);
      return;
    }
    if (message.type === "gloss.done") {
      completeGlossSession(session, reason);
      return;
    }
    failGlossSession(session, message.payload);
  };

  const applyGlossOutcome = (session: GlossSession, outcome: GlossTokenPayload, reason: string, queued: boolean): void => {
    const current = currentGlossSession === session && session.version === scanVersion;
    const token = session.tokenMap.get(outcome.tokenId);
    const render = current
      ? overlay.applyTokenOutcome(token, outcome, token?.scanVersion ?? session.version)
      : overlay.applyStalePendingOutcome(outcome);
    updatePendingTokenState(session, outcome, render);
    if (current && token && outcome.status !== "hidden") {
      cardOperations.replay(token);
    }
    if (current && token?.forceRefresh && (outcome.status === "ready" || outcome.status === "hidden")) {
      pendingGenerationRefreshKeys.delete(glossRefreshKey(token));
    }
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
    const ack = createChunkAck();
    session.pendingChunkAcks.set(chunkId, ack);
    try {
      session.port.postMessage(createGlossPortMessage("gloss.scan.chunk", {
        scanId: session.scanId,
        chunkId,
        chunkIndex: chunk.chunkIndex,
        pageUrl: session.pageUrl,
        sentences: chunk.sentences.map(toSerializableSentence)
      }));
    } catch (error) {
      session.pendingChunkAcks.delete(chunkId);
      ack.resolve();
      if (isExtensionContextInvalidated(error)) {
        stopContentScript("extension-context-invalidated");
      } else {
        failGlossSession(session, diagnosticPayloadFrom(error, {
          reason: "runtime",
          message: "Gloss scan chunk failed",
          service: "runtime"
        }));
      }
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
      if (isExtensionContextInvalidated(error)) {
        stopContentScript("extension-context-invalidated");
      } else {
        failGlossSession(session, diagnosticPayloadFrom(error, {
          reason: "runtime",
          message: "Gloss scan finalization failed",
          service: "runtime"
        }));
      }
    }
  };

  async function waitForChunkCapacity(session: GlossSession): Promise<void> {
    while (!stopped && !session.aborted && session.pendingChunkAcks.size >= MAX_UNACKED_SCAN_CHUNKS) {
      await Promise.race(Array.from(session.pendingChunkAcks.values()).map((ack) => ack.promise));
    }
  }

  function createChunkAck(): ChunkAck {
    let resolveAck: () => void = () => undefined;
    const promise = new Promise<void>((resolve) => {
      resolveAck = resolve;
    });
    return {
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
    if (stopped) {
      return;
    }
    synchronizeRouteState();
    if (!translationEnabled) {
      return;
    }
    if (scanTimer) {
      globalThis.clearTimeout(scanTimer);
    }
    scanTimer = globalThis.setTimeout(() => {
      scanTimer = undefined;
      void scanAndRender(reason).catch((error) => handleRuntimeError("content.scan", error));
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
    cardOperations.cancelAll();
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

  const setTranslationState = async (enabled: boolean, reason: string): Promise<void> => {
    const routeChanged = synchronizeRouteState();
    if (enabled === translationEnabled) {
      if (routeChanged && enabled) {
        await scanAndRender(reason);
      }
      return;
    }
    if (enabled) {
      await enableTranslation(reason);
    } else {
      disableTranslation(reason);
    }
  };

  const toggleTranslation = async (reason: string): Promise<void> => {
    synchronizeRouteState();
    await setTranslationState(!translationEnabled, reason);
  };

  const onShortcutKeyDown = createTranslationShortcutHandler({
    shortcut: () => settings?.translateShortcutKey ?? "Alt+G",
    beforeToggle: () => selectionController?.releaseHold(),
    toggle: () => toggleTranslation("shortcut")
  });

  reconcileSettingsChange = async (nextSettings) => {
    const previousSettings = settings;
    const knownWordListChanged = nextSettings.knownWordList !== previousSettings.knownWordList;
    const generationSettingsChanged = glossOutputSettingsChanged(previousSettings, nextSettings);
    if (generationSettingsChanged) {
      for (const key of overlay.refreshKeys()) {
        pendingGenerationRefreshKeys.add(key);
      }
    }
    settings = nextSettings;
    autoTranslateEnabled = nextSettings.autoTranslateEnabled;
    if (bootSettingsOpen) {
      translationEnabled = autoTranslateEnabled;
    }
    wordClickTimeout = cardOperationTimeoutMs(nextSettings);
    overlay.setAppearance(nextSettings.appearance);
    selectionController?.setShortcut(nextSettings.shortcutKey);
    // The automatic setting becomes the next route default while the user's current-route choice stays stable.
    if (!knownWordListChanged && !generationSettingsChanged) {
      return;
    }
    scanVersion += 1;
    closeAllGlossSessions();
    overlay.clear();
    if (knownWordListChanged) {
      const requestedList = nextSettings.knownWordList;
      const loadRevision = ++knownWordsLoadRevision;
      const loadedWords = await loadKnownWords(requestedList);
      if (stopped || loadRevision !== knownWordsLoadRevision || settings.knownWordList !== requestedList) {
        return;
      }
      knownWords = loadedWords;
    }
    if (stopped) {
      return;
    }
    if (translationEnabled) {
      const reason = knownWordListChanged ? "settings-known-word-list" : "settings-gloss-generation";
      await scanAndRender(reason);
    }
  };
  if (queuedSettingsChange) {
    const latestSettings = queuedSettingsChange;
    queuedSettingsChange = undefined;
    await reconcileSettingsChange(latestSettings);
  }
  bootSettingsOpen = false;
  const handleRuntimeControlMessage: TranslationControlHandler = (message: unknown, _sender, sendResponse) => {
    if (isTranslationStateMessage(message)) {
      const routeChanged = synchronizeRouteState();
      if (routeChanged && translationEnabled) {
        void scanAndRender("popup-state").catch((error) => handleRuntimeError("content.route", error));
      }
      sendResponse({ ok: true, enabled: translationEnabled } satisfies TranslationControlResponse);
      return false;
    }
    if (!isTranslateActivationMessage(message) && !isTranslationToggleMessage(message) && !isTranslationSetMessage(message)) {
      return false;
    }
    const action = isTranslationSetMessage(message)
      ? setTranslationState(message.enabled, "popup")
      : isTranslationToggleMessage(message)
        ? toggleTranslation("popup")
        : setTranslationState(true, "popup");
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
  translationControlOwner.bind(handleRuntimeControlMessage);

  observer = new MutationObserver((mutations) => {
    if (stopped) {
      return;
    }
    if (mutations.map((mutation) => overlay.ownsMutation(mutation) || isTransientUiMutation(mutation)).every(Boolean)) {
      return;
    }
    scanVersion += 1;
    overlay.pruneDisconnected();
    scheduleScan("mutation");
  });
  const onScroll = (): void => scheduleScan("scroll");
  const scrollObservedShadowRoots = new WeakSet<ShadowRoot>();
  addLifecycleEventListener(document, "scroll", onScroll, { passive: true, capture: true });
  addLifecycleEventListener(window, "scroll", onScroll, { passive: true });
  registerLifecycleCleanup(() => observer?.disconnect());
  observer.observe(document.body, { childList: true, characterData: true, subtree: true });

  function observeShadowRoot(root: ShadowRoot): void {
    if (stopped || scrollObservedShadowRoots.has(root)) return;
    scrollObservedShadowRoots.add(root);
    addLifecycleEventListener(root, "scroll", onScroll, { passive: true, capture: true });
    observer?.observe(root, { childList: true, characterData: true, subtree: true });
  }

  // @behavior glossa.extension_contracts.frame_state_sync.child_apply A child frame adopts frame zero's live state before its first viewport scan.
  if (window.top !== window) {
    try {
      const response = await runtimeMessage(createContentMessage("translation.state.sync", {}));
      if (response.type === "translation.state.response") {
        translationEnabled = response.payload.enabled;
      }
    } catch (error) {
      handleRuntimeError("translation.state.sync", error);
    }
    if (stopped) {
      return;
    }
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
    onWordSelected(selection) { return cardOperations.start(selection, location.href); },
    onSelectionModeChange(active) {
      overlay.setSelectionMode(active);
    },
    onError(error) {
      handleRuntimeError("word.clicked", error);
    }
  });

  selectionController.attach();
  registerLifecycleCleanup(() => selectionController?.detach());

  bootFailureCleanup = undefined;

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
  return sendRuntimeRequest(message, { timeoutMs });
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
  bootFailureCleanup?.();
  bootFailureCleanup = undefined;
  translationControlOwner.close();
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

function isTransientUiMutation(mutation: MutationRecord): boolean {
  const isUi = (node: Node) => { const element = node instanceof Element ? node : node.parentElement; return !!element?.closest("#glossa-overlay, [data-glossa-duplicate-card-prompt], #glossa-duplicate-card-style"); };
  if (isUi(mutation.target)) return true;
  const changed = [...mutation.addedNodes, ...mutation.removedNodes];
  return changed.length > 0 && changed.every(isUi);
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

function isTranslationToggleMessage(value: unknown): value is { type: "glossa.toggleTranslationState" } {
  return typeof value === "object"
    && value !== null
    && "type" in value
    && value.type === "glossa.toggleTranslationState";
}

function isTranslationSetMessage(value: unknown): value is { type: "glossa.setTranslationState"; enabled: boolean } {
  return typeof value === "object"
    && value !== null
    && "type" in value
    && value.type === "glossa.setTranslationState"
    && "enabled" in value
    && typeof value.enabled === "boolean";
}

type TranslationControlResponse = { ok: true; enabled: boolean } | { ok: false; message: string; error?: ErrorPayload };

function createTranslationControlOwner(): {
  bind(handler: TranslationControlHandler): void;
  close(): void;
} {
  const runtime = (globalThis as typeof globalThis & { chrome?: typeof chrome }).chrome?.runtime;
  let handler: TranslationControlHandler | undefined;
  let closed = false;
  const onMessage: RuntimeMessageListener = (message, sender, sendResponse) => {
    if (!isTranslationControlMessage(message)) {
      return false;
    }
    if (handler) {
      return handler(message, sender, sendResponse);
    }
    if (closed) {
      return false;
    }
    if (isTranslationStateMessage(message)) {
      sendResponse({ ok: true, phase: "booting" } satisfies TranslationBootingResponse);
    } else {
      sendResponse({
        ok: false,
        phase: "booting",
        message: "Translation state is still starting"
      } satisfies TranslationBootingResponse);
    }
    return false;
  };
  runtime?.onMessage?.addListener(onMessage);
  return {
    bind(nextHandler) {
      if (!closed) {
        handler = nextHandler;
      }
    },
    close() {
      if (closed) {
        return;
      }
      closed = true;
      handler = undefined;
      runtime?.onMessage?.removeListener(onMessage);
    }
  };
}

type TranslationBootingResponse =
  | { ok: true; phase: "booting" }
  | { ok: false; phase: "booting"; message: string };

function isTranslationControlMessage(value: unknown): boolean {
  return isTranslationStateMessage(value)
    || isTranslateActivationMessage(value)
    || isTranslationToggleMessage(value)
    || isTranslationSetMessage(value);
}
