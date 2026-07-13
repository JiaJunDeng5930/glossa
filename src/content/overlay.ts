import { DEFAULT_SETTINGS, type AppearanceSettings, type GlossTokenPayload } from "../shared/types";
import GLOSSA_THEME from "../shared/theme.json";
import { userMessageForError } from "../shared/userMessages";
import type { ScannedToken } from "./scanner";
import { validateTokenForRender } from "./range";

export interface GlossOverlay {
  applyTokenOutcome(token: ScannedToken | undefined, outcome: GlossTokenPayload, scanVersion: number): RenderSummary;
  applyStalePendingOutcome(outcome: GlossTokenPayload): RenderSummary;
  applyCardFeedback(input: CardFeedbackInput): RenderSummary;
  setSelectionMode(active: boolean): void;
  setAppearance(appearance: AppearanceSettings): void;
  markStalePendingAsError(tokenIds: Iterable<string>, message: string): void;
  clear(): void;
  pruneDisconnected(): number;
  ownsMutation(mutation: MutationRecord): boolean;
}

export interface RenderSummary {
  result: "rendered" | "updated" | "hidden" | "preserved" | "skipped";
  reason?: "missing-token" | "stale-token" | "stale-scan" | "detached-node" | "changed-text" | "invisible-range" | "overlap";
}

export type CardFeedback = "card-pending" | "card-success" | "card-error" | "card-unknown" | "card-cancelled";

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
const INLINE_LABEL_FONT_WEIGHT = 750;

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
      background:
        radial-gradient(circle at 12% 8%, rgba(255, 255, 255, 0.18), transparent 26rem),
        ${GLOSSA_THEME.selectionWash};
      opacity: 0;
      pointer-events: none;
      transition: opacity 160ms ease;
    }
    :host([data-glossa-selecting="true"]) .selection-veil {
      opacity: 1;
    }
    .selection-note {
      position: fixed;
      top: 18px;
      right: 18px;
      max-width: min(320px, calc(100vw - 36px));
      padding: 11px 14px;
      border: 1px solid rgba(23, 24, 20, 0.32);
      border-top: 2px solid ${GLOSSA_THEME.accent};
      border-radius: 1px;
      background: rgba(250, 248, 241, 0.98);
      color: #171814;
      font: 720 13px/1.4 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif;
      letter-spacing: 0.01em;
      box-shadow: 0 16px 36px rgba(23, 24, 20, 0.14);
      opacity: 0;
      transform: translateY(-6px);
      transition: opacity 160ms ease, transform 160ms ease;
    }
    :host([data-glossa-selecting="true"]) .selection-note {
      opacity: 1;
      transform: translateY(0);
    }
  `;
  style.textContent += `
    @media (prefers-reduced-motion: reduce) {
      .selection-veil,
      .selection-note {
        transition: none;
      }
    }
  `;
  const veil = doc.createElement("div");
  veil.className = "selection-veil";
  veil.dataset.glossaOwned = "1";
  veil.setAttribute("aria-hidden", "true");
  const selectionNote = doc.createElement("div");
  selectionNote.className = "selection-note";
  selectionNote.dataset.glossaOwned = "1";
  selectionNote.textContent = "选择单词来制卡";
  const layer = doc.createElement("div");
  layer.part.add("layer");
  shadow.append(style, veil, selectionNote, layer);
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
        padding-block-start: calc(var(--glossa-font-size) + 12px);
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
        padding: 1px 5px 2px;
        border: 1px solid color-mix(in srgb, ${GLOSSA_THEME.accent} 48%, var(--glossa-bg-color));
        border-radius: 1px;
        background: color-mix(in srgb, var(--glossa-bg-color) var(--glossa-bg-alpha), transparent);
        color: var(--glossa-text-color);
        font-family: var(--glossa-font-family);
        font-size: var(--glossa-font-size);
        font-weight: ${INLINE_LABEL_FONT_WEIGHT};
        line-height: 1.15;
        box-sizing: border-box;
        max-width: min(10em, 40vw);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        box-shadow: 0 1px 2px rgba(23, 24, 20, 0.12);
        pointer-events: none;
        transform: translateX(-50%);
        transform-origin: 50% 100%;
        animation: glossa-label-enter 180ms cubic-bezier(0.2, 0.72, 0.2, 1) both;
      }
      [data-glossa-token-label]::before,
      [data-glossa-token-width]::before {
        content: attr(data-glossa-visual);
      }
      [data-glossa-token][data-glossa-status="pending"] [data-glossa-token-label] {
        min-width: 2.1em;
        text-align: center;
      }
      [data-glossa-token][data-glossa-status="error"] [data-glossa-token-label] {
        border-color: color-mix(in srgb, #b43b32 55%, var(--glossa-card-error-bg-color));
        background: color-mix(in srgb, var(--glossa-card-error-bg-color) var(--glossa-bg-alpha), transparent);
        color: #b43b32;
      }
      [data-glossa-token][data-glossa-feedback="card-pending"] [data-glossa-token-label] {
        background: color-mix(in srgb, var(--glossa-bg-color) var(--glossa-bg-alpha), transparent);
        min-width: 2.1em;
        text-align: center;
      }
      [data-glossa-token][data-glossa-feedback="card-success"] [data-glossa-token-label] {
        border-color: color-mix(in srgb, #25784a 55%, var(--glossa-card-success-bg-color));
        background: color-mix(in srgb, var(--glossa-card-success-bg-color) var(--glossa-bg-alpha), transparent);
        color: #25784a;
      }
      [data-glossa-token][data-glossa-feedback="card-error"] [data-glossa-token-label] {
        border-color: color-mix(in srgb, #b43b32 55%, var(--glossa-card-error-bg-color));
        background: color-mix(in srgb, var(--glossa-card-error-bg-color) var(--glossa-bg-alpha), transparent);
        color: #b43b32;
      }
      [data-glossa-token][data-glossa-feedback="card-unknown"] [data-glossa-token-label] {
        border-color: color-mix(in srgb, #946200 55%, var(--glossa-card-error-bg-color));
        background: color-mix(in srgb, var(--glossa-card-error-bg-color) var(--glossa-bg-alpha), transparent);
        color: #946200;
      }
      [data-glossa-token][data-glossa-display-kind="feedback"][data-glossa-feedback="card-error"] [data-glossa-token-label],
      [data-glossa-token][data-glossa-display-kind="feedback"][data-glossa-status="error"] [data-glossa-token-label] {
        width: 1.65em;
        height: 1.65em;
        min-width: 1.65em;
        padding: 0;
        border-radius: 50%;
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
        width: 0.86em;
        height: 2px;
        border-radius: 999px;
        background: #b43b32;
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
        text-decoration: underline;
        text-decoration-color: color-mix(in srgb, ${GLOSSA_THEME.accent} 72%, currentColor);
        text-decoration-thickness: 1px;
        text-underline-offset: 3px;
      }
      [data-glossa-token-width] {
        display: block;
        height: 0;
        overflow: hidden;
        visibility: hidden;
        padding-inline: 5px;
        font-family: var(--glossa-font-family);
        font-size: var(--glossa-font-size);
        font-weight: ${INLINE_LABEL_FONT_WEIGHT};
        line-height: 1.15;
        box-sizing: border-box;
        max-width: min(10em, 40vw);
        white-space: nowrap;
      }
      @keyframes glossa-label-enter {
        from {
          opacity: 0;
          transform: translate(-50%, 3px);
        }
      }
      @media (prefers-reduced-motion: reduce) {
        [data-glossa-token-label] {
          animation: none;
        }
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
          if (readFeedback(existing)) {
            existing.dataset.glossaStatus = "hidden";
            rememberMutationTarget(existing);
            return { result: "preserved" };
          }
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
        if (readFeedback(existing)) {
          existing.dataset.glossaStatus = "hidden";
          rememberMutationTarget(existing);
          return { result: "preserved" };
        }
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
        if (input.feedback === "card-cancelled") {
          clearCardFeedback(existing);
          return { result: "updated" };
        }
        const status = readTokenStatus(existing);
        const badge = badgeForFeedback(existing, input.feedback);
        updateRenderedNode(existing, badge.display, status, input.feedback, badge.displayKind, input.message);
        return { result: "updated" };
      }
      if (!input.token) {
        return { result: "skipped", reason: "missing-token" };
      }
      if (input.feedback === "card-cancelled") {
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
    setAppearance(nextAppearance) {
      appearance = nextAppearance;
      applyAppearance(host, nextAppearance);
      for (const node of renderedNodes) {
        applyAppearance(node, nextAppearance);
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
    wrapper.dataset.glossaSentence = candidate.token.sentenceText;
    wrapper.dataset.glossaSentenceStart = String(candidate.token.startOffset);
    wrapper.dataset.glossaSentenceEnd = String(candidate.token.endOffset);
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
    applyAccessibleStatus(wrapper, candidate.status, candidate.display, candidate.feedback, candidate.userMessage);
    applyAppearance(wrapper, appearance);

    const label = doc.createElement("span");
    label.dataset.glossaOwned = "1";
    label.dataset.glossaTokenLabel = candidate.token.id;
    label.dataset.glossaLabel = candidate.token.id;
    label.dataset.glossaVisual = candidate.display;
    label.setAttribute("translate", "no");

    const width = doc.createElement("span");
    width.dataset.glossaOwned = "1";
    width.dataset.glossaTokenWidth = candidate.token.id;
    width.dataset.glossaVisual = candidate.display;
    width.setAttribute("translate", "no");

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
    feedback?: Exclude<CardFeedback, "card-cancelled">,
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
      label.dataset.glossaVisual = nextDisplay;
    }
    if (width) {
      width.dataset.glossaVisual = nextDisplay;
    }
    node.dataset.glossaDisplay = nextDisplay;
    node.dataset.glossaDisplayKind = nextKind;
    node.dataset.glossaStatus = status;
    if (nextFeedback) {
      node.dataset.glossaFeedback = nextFeedback;
    } else {
      delete node.dataset.glossaFeedback;
    }
    applyAccessibleStatus(node, status, nextDisplay, nextFeedback, userMessage);
    rememberMutationTarget(node);
  }

  function applyAccessibleStatus(
    node: HTMLElement,
    status: GlossTokenPayload["status"],
    display: string,
    feedback: CardFeedback | undefined,
    message: string | undefined
  ): void {
    if (message) {
      node.dataset.glossaUserMessage = message;
    } else {
      delete node.dataset.glossaUserMessage;
    }
    const surface = node.dataset.glossaSurface ?? "单词";
    const description = message
      ?? (feedback === "card-pending"
        ? `${surface}：正在制卡`
        : feedback === "card-success"
          ? `${surface}：制卡完成`
          : feedback === "card-error"
            ? `${surface}：制卡失败`
            : feedback === "card-unknown"
              ? `${surface}：制卡结果未知`
            : status === "pending"
              ? `${surface}：正在生成释义`
              : `${surface}：${display}`);
    node.title = description;
    node.setAttribute("aria-label", description);
  }

  function readTokenStatus(node: HTMLElement): GlossTokenPayload["status"] {
    const status = node.dataset.glossaStatus;
    return status === "pending" || status === "hidden" || status === "error" || status === "ready" ? status : "ready";
  }

  function readFeedback(node: HTMLElement): CardFeedback | undefined {
    const feedback = node.dataset.glossaFeedback;
    return feedback === "card-pending" || feedback === "card-success" || feedback === "card-error" || feedback === "card-unknown" ? feedback : undefined;
  }

  function badgeForFeedback(node: HTMLElement, feedback: Exclude<CardFeedback, "card-cancelled">): { display: string; displayKind: BadgeDisplayKind } {
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

  function clearCardFeedback(node: HTMLElement): void {
    if (readTokenStatus(node) === "hidden") {
      unwrapRenderedNode(node);
      return;
    }
    const glossDisplay = node.dataset.glossaGlossDisplay;
    if (glossDisplay) {
      const label = node.querySelector<HTMLElement>("[data-glossa-token-label]");
      const width = node.querySelector<HTMLElement>("[data-glossa-token-width]");
      if (label) {
        label.dataset.glossaVisual = glossDisplay;
      }
      if (width) {
        width.dataset.glossaVisual = glossDisplay;
      }
      node.dataset.glossaDisplay = glossDisplay;
      node.dataset.glossaDisplayKind = "gloss";
      node.dataset.glossaStatus = readTokenStatus(node);
      delete node.dataset.glossaFeedback;
      applyAccessibleStatus(node, readTokenStatus(node), glossDisplay, undefined, undefined);
      rememberMutationTarget(node);
      return;
    }
    unwrapRenderedNode(node);
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

function feedbackFallback(feedback: Exclude<CardFeedback, "card-cancelled">): string {
  if (feedback === "card-pending") {
    // The compact ellipsis is the visible in-page signal; title and aria-label carry the semantic detail.
    return "...";
  }
  return feedback === "card-success" ? "✓" : feedback === "card-unknown" ? "?" : "×";
}
