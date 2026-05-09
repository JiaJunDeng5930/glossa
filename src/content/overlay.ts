// @behavior glossa.translation.rendering Ready, pending, hidden, and error gloss outcomes keep the source word on its original text baseline.
import { DEFAULT_SETTINGS, type AppearanceSettings, type GlossTokenPayload } from "../shared/types";
import { userMessageForError } from "../shared/userMessages";
import type { ScannedToken } from "./scanner";
import { validateTokenForRender } from "./range";

export interface GlossOverlay {
  applyTokenOutcome(token: ScannedToken | undefined, outcome: GlossTokenPayload, scanVersion: number): RenderSummary;
  applyStalePendingOutcome(outcome: GlossTokenPayload): RenderSummary;
  applyCardFeedback(input: CardFeedbackInput): RenderSummary;
  setSelectionMode(active: boolean): void;
  markStalePendingAsError(tokenIds: Iterable<string>, message: string): void;
  clear(): void;
  pruneDisconnected(): number;
  ownsMutation(mutation: MutationRecord): boolean;
}

export interface RenderSummary {
  result: "rendered" | "updated" | "hidden" | "preserved" | "skipped";
  reason?: "missing-token" | "stale-token" | "stale-scan" | "detached-node" | "changed-text" | "invisible-range" | "overlap";
}

export type CardFeedback = "card-pending" | "card-success" | "card-error";

export interface CardFeedbackInput {
  tokenId: string;
  token?: ScannedToken;
  feedback: CardFeedback;
  message?: string;
}

type BadgeDisplayKind = "gloss" | "feedback";

interface RenderCandidate {
  display: string;
  status: GlossTokenPayload["status"];
  token: ScannedToken;
  feedback?: CardFeedback;
  displayKind?: BadgeDisplayKind;
  userMessage?: string;
}

interface TextSegment {
  node: Text;
  startOffset: number;
  endOffset: number;
  originalText: string;
}

const STYLE_ID = "glossa-inline-style";
const FINGERPRINT_CONTEXT_CHARS = 16;

export function createGlossOverlay(doc: Document, appearance: AppearanceSettings = DEFAULT_SETTINGS.appearance): GlossOverlay {
  const host = doc.createElement("div");
  host.id = "glossa-overlay";
  host.dataset.glossaOwned = "1";
  host.className = "notranslate";
  host.setAttribute("translate", "no");
  applyAppearance(host, appearance);
  const shadow = host.attachShadow({ mode: "open" });
  const style = doc.createElement("style");
  style.textContent = `
    :host {
      all: initial;
      position: fixed;
      inset: 0;
      pointer-events: none;
      z-index: 2147483647;
      font-family: var(--glossa-font-family);
    }
    .selection-veil {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.18);
      opacity: 0;
      pointer-events: none;
      transition: opacity 120ms ease;
    }
    :host([data-glossa-selecting="true"]) .selection-veil {
      opacity: 1;
    }
  `;
  const veil = doc.createElement("div");
  veil.className = "selection-veil";
  veil.dataset.glossaOwned = "1";
  veil.setAttribute("aria-hidden", "true");
  const layer = doc.createElement("div");
  layer.part.add("layer");
  shadow.append(style, veil, layer);
  doc.documentElement.append(host);
  const renderedNodes = new Set<HTMLElement>();
  const originalTextNodesByToken = new Map<string, Text>();
  let textSegments = new WeakMap<Text, TextSegment[]>();
  let ignoredMutationTargets = new WeakSet<Node>();
  let ignoreResetTimer: ReturnType<typeof globalThis.setTimeout> | undefined;

  const rememberMutationTarget = (target: Node): void => {
    ignoredMutationTargets.add(target);
    if (ignoreResetTimer) {
      globalThis.clearTimeout(ignoreResetTimer);
    }
    ignoreResetTimer = globalThis.setTimeout(() => {
      ignoredMutationTargets = new WeakSet<Node>();
      ignoreResetTimer = undefined;
    }, 0);
  };

  const installStyle = (root: Document | ShadowRoot): void => {
    const existing = root instanceof Document
      ? root.getElementById(STYLE_ID)
      : root.querySelector(`#${STYLE_ID}`);
    if (existing) {
      return;
    }
    const inlineStyle = doc.createElement("style");
    inlineStyle.id = STYLE_ID;
    inlineStyle.dataset.glossaOwned = "1";
    inlineStyle.setAttribute("translate", "no");
    inlineStyle.textContent = `
      [data-glossa-token] {
        display: inline-block;
        position: relative;
        min-width: max-content;
        padding-block-start: calc(var(--glossa-font-size) * 1.25 + 4px);
        vertical-align: baseline;
        max-width: max-content;
        white-space: nowrap;
        line-height: inherit;
        margin-inline: 1px;
        text-align: center;
      }
      [data-glossa-token-label] {
        display: block;
        position: absolute;
        top: 0;
        left: 50%;
        padding: 1px 4px;
        border-radius: 4px;
        background: color-mix(in srgb, var(--glossa-bg-color) var(--glossa-bg-alpha), transparent);
        color: var(--glossa-text-color);
        font-family: var(--glossa-font-family);
        font-size: var(--glossa-font-size);
        line-height: 1.25;
        white-space: nowrap;
        box-shadow: 0 1px 3px rgba(15, 23, 42, 0.25);
        pointer-events: none;
        transform: translateX(-50%);
      }
      [data-glossa-token][data-glossa-status="pending"] [data-glossa-token-label] {
        min-width: 1.25em;
        text-align: center;
      }
      [data-glossa-token][data-glossa-status="error"] [data-glossa-token-label] {
        background: color-mix(in srgb, var(--glossa-card-error-bg-color) var(--glossa-bg-alpha), transparent);
      }
      [data-glossa-token][data-glossa-feedback="card-pending"] [data-glossa-token-label] {
        background: color-mix(in srgb, var(--glossa-bg-color) var(--glossa-bg-alpha), transparent);
        min-width: 1.25em;
        text-align: center;
      }
      [data-glossa-token][data-glossa-feedback="card-success"] [data-glossa-token-label] {
        background: color-mix(in srgb, var(--glossa-card-success-bg-color) var(--glossa-bg-alpha), transparent);
      }
      [data-glossa-token][data-glossa-feedback="card-error"] [data-glossa-token-label] {
        background: color-mix(in srgb, var(--glossa-card-error-bg-color) var(--glossa-bg-alpha), transparent);
      }
      [data-glossa-token][data-glossa-display-kind="feedback"][data-glossa-feedback="card-error"] [data-glossa-token-label],
      [data-glossa-token][data-glossa-display-kind="feedback"][data-glossa-status="error"] [data-glossa-token-label] {
        width: 1.5em;
        height: 1.5em;
        min-width: 1.5em;
        padding: 0;
        color: transparent;
        overflow: hidden;
      }
      [data-glossa-token][data-glossa-display-kind="feedback"][data-glossa-feedback="card-error"] [data-glossa-token-label]::before,
      [data-glossa-token][data-glossa-display-kind="feedback"][data-glossa-feedback="card-error"] [data-glossa-token-label]::after,
      [data-glossa-token][data-glossa-display-kind="feedback"][data-glossa-status="error"] [data-glossa-token-label]::before,
      [data-glossa-token][data-glossa-display-kind="feedback"][data-glossa-status="error"] [data-glossa-token-label]::after {
        content: "";
        position: absolute;
        left: 50%;
        top: 50%;
        width: 0.82em;
        height: 2px;
        border-radius: 999px;
        background: var(--glossa-text-color);
        transform-origin: center;
      }
      [data-glossa-token][data-glossa-display-kind="feedback"][data-glossa-feedback="card-error"] [data-glossa-token-label]::before,
      [data-glossa-token][data-glossa-display-kind="feedback"][data-glossa-status="error"] [data-glossa-token-label]::before {
        transform: translate(-50%, -50%) rotate(45deg);
      }
      [data-glossa-token][data-glossa-display-kind="feedback"][data-glossa-feedback="card-error"] [data-glossa-token-label]::after,
      [data-glossa-token][data-glossa-display-kind="feedback"][data-glossa-status="error"] [data-glossa-token-label]::after {
        transform: translate(-50%, -50%) rotate(-45deg);
      }
      [data-glossa-token-surface] {
        display: inline;
        line-height: inherit;
      }
      [data-glossa-token-width] {
        display: block;
        height: 0;
        overflow: hidden;
        visibility: hidden;
        padding-inline: 4px;
        font-family: var(--glossa-font-family);
        font-size: var(--glossa-font-size);
        line-height: 1.25;
        white-space: nowrap;
      }
    `;
    if (root instanceof Document) {
      const parent = root.head ?? root.documentElement;
      parent.append(inlineStyle);
      rememberMutationTarget(parent);
    } else {
      root.append(inlineStyle);
      rememberMutationTarget(root);
    }
  };

  const clearRenderedNodes = (): void => {
    for (const node of Array.from(renderedNodes)) {
      const parent = node.parentNode;
      if (!parent) {
        renderedNodes.delete(node);
        continue;
      }
      const surface = node.dataset.glossaSurface ?? "";
      rememberMutationTarget(parent);
      parent.replaceChild(doc.createTextNode(surface), node);
      renderedNodes.delete(node);
      if (node.dataset.glossaToken) {
        originalTextNodesByToken.delete(node.dataset.glossaToken);
      }
    }
    originalTextNodesByToken.clear();
    textSegments = new WeakMap<Text, TextSegment[]>();
  };

  const pruneDisconnectedNodes = (): number => {
    let pruned = 0;
    for (const node of Array.from(renderedNodes)) {
      if (node.isConnected) {
        continue;
      }
      renderedNodes.delete(node);
      if (node.dataset.glossaToken) {
        originalTextNodesByToken.delete(node.dataset.glossaToken);
      }
      pruned += 1;
    }
    return pruned;
  };

  return {
    applyTokenOutcome(token, outcome, scanVersion) {
      pruneDisconnectedNodes();
      const existing = findRenderedToken(outcome.tokenId);
      if (outcome.status === "hidden") {
        if (existing) {
          unwrapRenderedNode(existing);
        }
        return { result: "hidden" };
      }
      if (!token) {
        return { result: "skipped", reason: "missing-token" };
      }
      if (outcome.status === "error") {
        const userMessage = userMessageForError(outcome.error, "ai");
        if (existing) {
          updateRenderedNode(existing, "×", "error", "card-error", "feedback", userMessage);
          return { result: "updated" };
        }
        return renderToken({ token, display: "×", status: "error", feedback: "card-error", displayKind: "feedback", userMessage }, scanVersion);
      }
      const display = outcome.status === "ready" ? outcome.item?.display : "...";
      if (!display) {
        return { result: "skipped", reason: "missing-token" };
      }
      if (existing) {
        if (existing.dataset.glossaDisplay === display && existing.dataset.glossaStatus === outcome.status) {
          return { result: "preserved" };
        }
        updateRenderedNode(existing, display, outcome.status);
        return { result: "updated" };
      }
      return renderToken({ token, display, status: outcome.status }, scanVersion);
    },
    applyStalePendingOutcome(outcome) {
      pruneDisconnectedNodes();
      const existing = findRenderedToken(outcome.tokenId);
      if (!existing || !isPendingNodeCurrent(existing)) {
        return { result: "skipped", reason: "missing-token" };
      }
      if (outcome.status === "hidden") {
        unwrapRenderedNode(existing);
        return { result: "hidden" };
      }
      if (outcome.status === "error") {
        updateRenderedNode(existing, "×", "error", "card-error", "feedback", userMessageForError(outcome.error, "ai"));
        return { result: "updated" };
      }
      if (outcome.status === "pending") {
        return { result: "preserved" };
      }
      const display = outcome.item?.display;
      if (!display) {
        return { result: "skipped", reason: "missing-token" };
      }
      updateRenderedNode(existing, display, "ready");
      return { result: "updated" };
    },
    applyCardFeedback(input) {
      pruneDisconnectedNodes();
      const existing = findRenderedToken(input.tokenId);
      if (existing) {
        const status = readTokenStatus(existing);
        const badge = badgeForFeedback(existing, input.feedback);
        updateRenderedNode(existing, badge.display, status, input.feedback, badge.displayKind, input.message);
        return { result: "updated" };
      }
      if (!input.token) {
        return { result: "skipped", reason: "missing-token" };
      }
      return renderToken({
        token: input.token,
        display: feedbackFallback(input.feedback),
        status: "ready",
        feedback: input.feedback,
        displayKind: "feedback",
        ...(input.message ? { userMessage: input.message } : {})
      }, input.token.scanVersion);
    },
    setSelectionMode(active) {
      if (active) {
        host.dataset.glossaSelecting = "true";
      } else {
        delete host.dataset.glossaSelecting;
      }
    },
    markStalePendingAsError(tokenIds, message) {
      for (const tokenId of tokenIds) {
        const existing = findRenderedToken(tokenId);
        if (existing && isPendingNodeCurrent(existing)) {
          updateRenderedNode(existing, "×", "error", "card-error", "feedback", message);
        }
      }
    },
    clear() {
      clearRenderedNodes();
    },
    pruneDisconnected() {
      return pruneDisconnectedNodes();
    },
    ownsMutation(mutation) {
      return ignoredMutationTargets.has(mutation.target);
    }
  };

  function findRenderedToken(tokenId: string): HTMLElement | undefined {
    for (const node of Array.from(renderedNodes)) {
      if (!node.isConnected) {
        renderedNodes.delete(node);
        continue;
      }
      if (node.dataset.glossaToken === tokenId) {
        return node;
      }
    }
    return undefined;
  }

  function unwrapRenderedNode(node: HTMLElement): void {
    const parent = node.parentNode;
    if (!parent) {
      renderedNodes.delete(node);
      return;
    }
    const surface = node.dataset.glossaSurface ?? "";
    const originalTextNode = findOriginalTextNode(node);
    rememberMutationTarget(parent);
    const restored = doc.createTextNode(surface);
    parent.replaceChild(restored, node);
    if (originalTextNode) {
      insertRestoredSegment(originalTextNode, node, restored);
    }
    renderedNodes.delete(node);
    if (node.dataset.glossaToken) {
      originalTextNodesByToken.delete(node.dataset.glossaToken);
    }
  }

  function renderToken(candidate: RenderCandidate, scanVersion: number): RenderSummary {
    if (candidate.token.scanVersion !== scanVersion) {
      return { result: "skipped", reason: "stale-token" };
    }
    const location = locateTokenSegment(candidate.token, scanVersion);
    if (!location.ok) {
      return location.reason ? { result: "skipped", reason: location.reason } : { result: "skipped" };
    }
    const { segment, localStart, localEnd } = location;
    const parent = segment.node.parentNode;
    if (!parent) {
      return { result: "skipped", reason: "detached-node" };
    }
    const root = segment.node.getRootNode();
    if (root instanceof Document || root instanceof ShadowRoot) {
      installStyle(root);
    }
    const text = segment.node.nodeValue ?? "";
    const fragment = doc.createDocumentFragment();
    const beforeText = text.slice(0, localStart);
    const afterText = text.slice(localEnd);
    const nextSegments: TextSegment[] = [];
    if (beforeText.length > 0) {
      const before = doc.createTextNode(beforeText);
      fragment.append(before);
      nextSegments.push({
        node: before,
        startOffset: segment.startOffset,
        endOffset: candidate.token.nodeStartOffset,
        originalText: segment.originalText
      });
    }
    const wrapper = createTokenWrapper(candidate);
    fragment.append(wrapper);
    if (afterText.length > 0) {
      const after = doc.createTextNode(afterText);
      fragment.append(after);
      nextSegments.push({
        node: after,
        startOffset: candidate.token.nodeEndOffset,
        endOffset: segment.endOffset,
        originalText: segment.originalText
      });
    }
    replaceSegment(candidate.token.textNode, segment, nextSegments);
    rememberMutationTarget(parent);
    parent.replaceChild(fragment, segment.node);
    renderedNodes.add(wrapper);
    return { result: "rendered" };
  }

  function createTokenWrapper(candidate: RenderCandidate): HTMLElement {
    const wrapper = doc.createElement("span");
    wrapper.dataset.glossaOwned = "1";
    wrapper.dataset.glossaToken = candidate.token.id;
    wrapper.dataset.glossaSurface = candidate.token.sourceText;
    wrapper.dataset.glossaDisplay = candidate.display;
    wrapper.dataset.glossaDisplayKind = candidate.displayKind ?? "gloss";
    if (candidate.status === "ready" && !candidate.feedback) {
      wrapper.dataset.glossaGlossDisplay = candidate.display;
    }
    wrapper.dataset.glossaStatus = candidate.status;
    if (candidate.feedback) {
      wrapper.dataset.glossaFeedback = candidate.feedback;
    }
    wrapper.dataset.glossaFingerprint = candidate.token.sourceFingerprint;
    wrapper.dataset.glossaLemma = candidate.token.lemma;
    wrapper.dataset.glossaOriginalStart = String(candidate.token.nodeStartOffset);
    wrapper.dataset.glossaOriginalEnd = String(candidate.token.nodeEndOffset);
    const text = candidate.token.textNode.nodeValue ?? "";
    wrapper.dataset.glossaContextBefore = text.slice(
      Math.max(0, candidate.token.nodeStartOffset - FINGERPRINT_CONTEXT_CHARS),
      candidate.token.nodeStartOffset
    );
    wrapper.dataset.glossaContextAfter = text.slice(
      candidate.token.nodeEndOffset,
      Math.min(text.length, candidate.token.nodeEndOffset + FINGERPRINT_CONTEXT_CHARS)
    );
    wrapper.className = "notranslate";
    wrapper.setAttribute("translate", "no");
    applyUserMessage(wrapper, candidate.userMessage);
    applyAppearance(wrapper, appearance);

    const label = doc.createElement("span");
    label.dataset.glossaOwned = "1";
    label.dataset.glossaTokenLabel = candidate.token.id;
    label.dataset.glossaLabel = candidate.token.id;
    label.setAttribute("translate", "no");
    label.textContent = candidate.display;

    const width = doc.createElement("span");
    width.dataset.glossaOwned = "1";
    width.dataset.glossaTokenWidth = candidate.token.id;
    width.setAttribute("translate", "no");
    width.textContent = candidate.display;

    const surface = doc.createElement("span");
    surface.dataset.glossaOwned = "1";
    surface.dataset.glossaTokenSurface = candidate.token.id;
    surface.setAttribute("translate", "no");
    surface.textContent = candidate.token.sourceText;

    wrapper.append(width, label, surface);
    originalTextNodesByToken.set(candidate.token.id, candidate.token.textNode);
    return wrapper;
  }

  function updateRenderedNode(
    node: HTMLElement,
    display: string,
    status: GlossTokenPayload["status"],
    feedback?: CardFeedback,
    displayKind: BadgeDisplayKind = "gloss",
    userMessage?: string
  ): void {
    const nextFeedback = feedback ?? readFeedback(node);
    const nextKind = visibleDisplayKind(displayKind, nextFeedback);
    const nextDisplay = visibleDisplay(display, displayKind, nextFeedback);
    if (
      node.dataset.glossaDisplay === nextDisplay
      && node.dataset.glossaDisplayKind === nextKind
      && node.dataset.glossaStatus === status
      && node.dataset.glossaFeedback === nextFeedback
      && node.dataset.glossaUserMessage === userMessage
    ) {
      return;
    }
    if (displayKind === "gloss" && status === "ready") {
      node.dataset.glossaGlossDisplay = display;
    }
    const label = node.querySelector<HTMLElement>("[data-glossa-token-label]");
    const width = node.querySelector<HTMLElement>("[data-glossa-token-width]");
    if (label) {
      label.textContent = nextDisplay;
    }
    if (width) {
      width.textContent = nextDisplay;
    }
    node.dataset.glossaDisplay = nextDisplay;
    node.dataset.glossaDisplayKind = nextKind;
    node.dataset.glossaStatus = status;
    applyUserMessage(node, userMessage);
    if (nextFeedback) {
      node.dataset.glossaFeedback = nextFeedback;
    } else {
      delete node.dataset.glossaFeedback;
    }
    rememberMutationTarget(node);
  }

  function applyUserMessage(node: HTMLElement, message: string | undefined): void {
    if (message) {
      node.dataset.glossaUserMessage = message;
      node.title = message;
      node.setAttribute("aria-label", message);
      return;
    }
    delete node.dataset.glossaUserMessage;
    node.removeAttribute("title");
    node.removeAttribute("aria-label");
  }

  function readTokenStatus(node: HTMLElement): GlossTokenPayload["status"] {
    const status = node.dataset.glossaStatus;
    return status === "pending" || status === "hidden" || status === "error" || status === "ready" ? status : "ready";
  }

  function readFeedback(node: HTMLElement): CardFeedback | undefined {
    const feedback = node.dataset.glossaFeedback;
    return feedback === "card-pending" || feedback === "card-success" || feedback === "card-error" ? feedback : undefined;
  }

  function badgeForFeedback(node: HTMLElement, feedback: CardFeedback): { display: string; displayKind: BadgeDisplayKind } {
    if (feedback === "card-pending") {
      return { display: feedbackFallback(feedback), displayKind: "feedback" };
    }
    const glossDisplay = node.dataset.glossaGlossDisplay;
    if (glossDisplay) {
      return { display: glossDisplay, displayKind: "gloss" };
    }
    const display = node.dataset.glossaDisplay;
    if (node.dataset.glossaStatus === "ready" && node.dataset.glossaDisplayKind === "gloss" && display) {
      return { display, displayKind: "gloss" };
    }
    return { display: feedbackFallback(feedback), displayKind: "feedback" };
  }

  function visibleDisplay(display: string, displayKind: BadgeDisplayKind, feedback?: CardFeedback): string {
    if (displayKind === "gloss" && feedback === "card-pending") {
      return feedbackFallback(feedback);
    }
    return display;
  }

  function visibleDisplayKind(displayKind: BadgeDisplayKind, feedback?: CardFeedback): BadgeDisplayKind {
    if (displayKind === "gloss" && feedback === "card-pending") {
      return "feedback";
    }
    return displayKind;
  }

  function isPendingNodeCurrent(node: HTMLElement): boolean {
    if (!node.isConnected || node.dataset.glossaStatus !== "pending") {
      return false;
    }
    const parent = node.parentNode;
    if (!parent) {
      return false;
    }
    const contextBefore = node.dataset.glossaContextBefore ?? "";
    const contextAfter = node.dataset.glossaContextAfter ?? "";
    const context = textContextAroundNode(parent, node);
    return context.before.endsWith(contextBefore) && context.after.startsWith(contextAfter);
  }

  function textContextAroundNode(parent: Node, target: HTMLElement): { before: string; after: string } {
    let before = "";
    let after = "";
    let seenTarget = false;
    for (const child of Array.from(parent.childNodes)) {
      if (child === target) {
        seenTarget = true;
        continue;
      }
      const text = sourceTextForNode(child);
      if (seenTarget) {
        after += text;
      } else {
        before += text;
      }
    }
    return { before, after };
  }

  function sourceTextForNode(node: Node): string {
    if (node.nodeType === Node.TEXT_NODE) {
      return node.nodeValue ?? "";
    }
    if (node instanceof HTMLElement && node.dataset.glossaToken) {
      return node.dataset.glossaSurface ?? "";
    }
    return node.textContent ?? "";
  }

  function locateTokenSegment(
    token: ScannedToken,
    scanVersion: number
  ): { ok: true; segment: TextSegment; localStart: number; localEnd: number } | { ok: false; reason: RenderSummary["reason"] } {
    if (token.textNode.isConnected) {
      const validation = validateTokenForRender(token, scanVersion);
      if (!validation.ok) {
        return { ok: false, reason: validation.reason };
      }
      validation.range?.detach();
      const text = token.textNode.nodeValue ?? "";
      const segment = ensureInitialSegment(token.textNode, text);
      return {
        ok: true,
        segment,
        localStart: token.nodeStartOffset,
        localEnd: token.nodeEndOffset
      };
    }
    const segment = (textSegments.get(token.textNode) ?? [])
      .find((candidate) => candidate.node.isConnected
        && token.nodeStartOffset >= candidate.startOffset
        && token.nodeEndOffset <= candidate.endOffset);
    if (!segment) {
      return { ok: false, reason: "detached-node" };
    }
    if (token.scanVersion !== scanVersion) {
      return { ok: false, reason: "stale-token" };
    }
    if (segment.originalText.slice(token.nodeStartOffset, token.nodeEndOffset) !== token.sourceText) {
      return { ok: false, reason: "changed-text" };
    }
    const localStart = token.nodeStartOffset - segment.startOffset;
    const localEnd = token.nodeEndOffset - segment.startOffset;
    const currentText = segment.node.nodeValue ?? "";
    if (currentText.slice(localStart, localEnd) !== token.sourceText) {
      return { ok: false, reason: "changed-text" };
    }
    const range = doc.createRange();
    try {
      range.setStart(segment.node, localStart);
      range.setEnd(segment.node, localEnd);
      if (!Array.from(range.getClientRects()).some((rect) => rect.width > 0 && rect.height > 0)) {
        return { ok: false, reason: "invisible-range" };
      }
    } finally {
      range.detach();
    }
    return { ok: true, segment, localStart, localEnd };
  }

  function ensureInitialSegment(textNode: Text, text: string): TextSegment {
    const existing = textSegments.get(textNode);
    if (existing?.length === 1 && existing[0]?.node === textNode) {
      return existing[0];
    }
    const segment: TextSegment = {
      node: textNode,
      startOffset: 0,
      endOffset: text.length,
      originalText: text
    };
    textSegments.set(textNode, [segment]);
    return segment;
  }

  function replaceSegment(originalTextNode: Text, oldSegment: TextSegment, nextSegments: TextSegment[]): void {
    const current = textSegments.get(originalTextNode) ?? [];
    const next = current.flatMap((segment) => segment === oldSegment ? nextSegments : [segment]);
    textSegments.set(originalTextNode, next);
  }

  function findOriginalTextNode(node: HTMLElement): Text | undefined {
    const tokenId = node.dataset.glossaToken;
    return tokenId ? originalTextNodesByToken.get(tokenId) : undefined;
  }

  function insertRestoredSegment(originalTextNode: Text, wrapper: HTMLElement, restored: Text): void {
    const start = Number(wrapper.dataset.glossaOriginalStart);
    const end = Number(wrapper.dataset.glossaOriginalEnd);
    const current = textSegments.get(originalTextNode);
    if (!current || !Number.isFinite(start) || !Number.isFinite(end)) {
      return;
    }
    const originalText = current[0]?.originalText ?? restored.nodeValue ?? "";
    current.push({ node: restored, startOffset: start, endOffset: end, originalText });
    current.sort((left, right) => left.startOffset - right.startOffset);
  }

}

function applyAppearance(host: HTMLElement, appearance: AppearanceSettings): void {
  host.style.setProperty("--glossa-text-color", appearance.textColor ?? DEFAULT_SETTINGS.appearance.textColor);
  host.style.setProperty("--glossa-bg-color", appearance.backgroundColor ?? DEFAULT_SETTINGS.appearance.backgroundColor);
  host.style.setProperty("--glossa-card-success-bg-color", appearance.cardSuccessBackgroundColor ?? DEFAULT_SETTINGS.appearance.cardSuccessBackgroundColor);
  host.style.setProperty("--glossa-card-error-bg-color", appearance.cardErrorBackgroundColor ?? DEFAULT_SETTINGS.appearance.cardErrorBackgroundColor);
  host.style.setProperty("--glossa-bg-alpha", `${Math.round((appearance.backgroundOpacity ?? DEFAULT_SETTINGS.appearance.backgroundOpacity) * 100)}%`);
  host.style.setProperty("--glossa-font-family", appearance.fontFamily ?? DEFAULT_SETTINGS.appearance.fontFamily);
  host.style.setProperty("--glossa-font-size", `${appearance.fontSize ?? DEFAULT_SETTINGS.appearance.fontSize}px`);
}

function feedbackFallback(feedback: CardFeedback): string {
  if (feedback === "card-pending") {
    return "...";
  }
  return feedback === "card-success" ? "✓" : "×";
}
