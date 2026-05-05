import { DEFAULT_SETTINGS, type AppearanceSettings, type GlossTokenPayload } from "../shared/types";
import type { ScannedToken } from "./scanner";
import { validateTokenForRender } from "./range";

export interface GlossOverlay {
  applyTokenOutcome(token: ScannedToken | undefined, outcome: GlossTokenPayload, scanVersion: number): RenderSummary;
  clear(): void;
  pruneDisconnected(): number;
  ownsMutation(mutation: MutationRecord): boolean;
}

export interface RenderSummary {
  result: "rendered" | "updated" | "hidden" | "preserved" | "skipped";
  reason?: "missing-token" | "stale-token" | "stale-scan" | "detached-node" | "changed-text" | "invisible-range" | "overlap";
}

interface RenderCandidate {
  display: string;
  status: GlossTokenPayload["status"];
  token: ScannedToken;
}

interface TextSegment {
  node: Text;
  startOffset: number;
  endOffset: number;
  originalText: string;
}

const STYLE_ID = "glossa-inline-style";

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
  `;
  const layer = doc.createElement("div");
  layer.part.add("layer");
  shadow.append(style, layer);
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
        background: color-mix(in srgb, #b91c1c 85%, transparent);
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
        if (existing) {
          updateRenderedNode(existing, outcome.message ?? "!", "error");
          return { result: "updated" };
        }
        return renderToken({ token, display: outcome.message ?? "!", status: "error" }, scanVersion);
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
    wrapper.dataset.glossaStatus = candidate.status;
    wrapper.dataset.glossaFingerprint = candidate.token.sourceFingerprint;
    wrapper.dataset.glossaLemma = candidate.token.lemma;
    wrapper.dataset.glossaOriginalStart = String(candidate.token.nodeStartOffset);
    wrapper.dataset.glossaOriginalEnd = String(candidate.token.nodeEndOffset);
    wrapper.className = "notranslate";
    wrapper.setAttribute("translate", "no");
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

  function updateRenderedNode(node: HTMLElement, display: string, status: GlossTokenPayload["status"]): void {
    if (node.dataset.glossaDisplay === display && node.dataset.glossaStatus === status) {
      return;
    }
    const label = node.querySelector<HTMLElement>("[data-glossa-token-label]");
    const width = node.querySelector<HTMLElement>("[data-glossa-token-width]");
    if (label) {
      label.textContent = display;
    }
    if (width) {
      width.textContent = display;
    }
    node.dataset.glossaDisplay = display;
    node.dataset.glossaStatus = status;
    rememberMutationTarget(node);
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
  host.style.setProperty("--glossa-text-color", appearance.textColor);
  host.style.setProperty("--glossa-bg-color", appearance.backgroundColor);
  host.style.setProperty("--glossa-bg-alpha", `${Math.round(appearance.backgroundOpacity * 100)}%`);
  host.style.setProperty("--glossa-font-family", appearance.fontFamily);
  host.style.setProperty("--glossa-font-size", `${appearance.fontSize}px`);
}
