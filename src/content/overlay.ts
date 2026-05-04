import { DEFAULT_SETTINGS, type AppearanceSettings, type GlossItem } from "../shared/types";
import type { ScannedToken } from "./scanner";
import { validateTokenForRender } from "./range";

export interface GlossOverlay {
  render(items: GlossItem[], tokens: Map<string, ScannedToken>, scanVersion: number): RenderSummary;
  clear(): void;
  pruneDisconnected(): number;
  ownsMutation(mutation: MutationRecord): boolean;
}

export interface RenderSummary {
  rendered: number;
  skippedMissingToken: number;
  skippedStale: number;
  skippedDuplicate: number;
  skippedOverlap: number;
  preserved: number;
  prunedDisconnected: number;
}

interface RenderCandidate {
  item: GlossItem;
  token: ScannedToken;
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
      parent.normalize();
      renderedNodes.delete(node);
    }
  };

  const pruneDisconnectedNodes = (): number => {
    let pruned = 0;
    for (const node of Array.from(renderedNodes)) {
      if (node.isConnected) {
        continue;
      }
      renderedNodes.delete(node);
      pruned += 1;
    }
    return pruned;
  };

  return {
    render(items, tokens, scanVersion) {
      const seen = new Set<string>();
      const candidatesByTextNode = new Map<Text, RenderCandidate[]>();
      const summary: RenderSummary = {
        rendered: 0,
        skippedMissingToken: 0,
        skippedStale: 0,
        skippedDuplicate: 0,
        skippedOverlap: 0,
        preserved: 0,
        prunedDisconnected: pruneDisconnectedNodes()
      };
      for (const item of items) {
        const token = tokens.get(item.tokenId);
        if (!token) {
          summary.skippedMissingToken += 1;
          continue;
        }
        if (seen.has(token.id)) {
          summary.skippedDuplicate += 1;
          continue;
        }
        seen.add(token.id);
        const existing = findRenderedToken(token.id);
        if (existing) {
          if (existing.dataset.glossaDisplay === item.display && existing.dataset.glossaSurface === token.sourceText) {
            summary.preserved += 1;
            continue;
          }
          unwrapRenderedNode(existing);
        }
        const validation = validateTokenForRender(token, scanVersion);
        if (!validation.ok || !validation.rect) {
          summary.skippedStale += 1;
          continue;
        }
        validation.range?.detach();
        const candidates = candidatesByTextNode.get(token.textNode) ?? [];
        candidates.push({ item, token });
        candidatesByTextNode.set(token.textNode, candidates);
      }
      for (const [textNode, candidates] of candidatesByTextNode) {
        summary.rendered += renderTextNode(textNode, candidates, summary);
      }
      return summary;
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
    rememberMutationTarget(parent);
    parent.replaceChild(doc.createTextNode(surface), node);
    parent.normalize();
    renderedNodes.delete(node);
  }

  function renderTextNode(textNode: Text, candidates: RenderCandidate[], summary: RenderSummary): number {
    const parent = textNode.parentNode;
    const text = textNode.nodeValue ?? "";
    if (!parent || text.length === 0) {
      return 0;
    }
    const root = textNode.getRootNode();
    if (root instanceof Document || root instanceof ShadowRoot) {
      installStyle(root);
    }

    const fragment = doc.createDocumentFragment();
    let cursor = 0;
    let rendered = 0;
    for (const candidate of candidates.sort((left, right) => left.token.nodeStartOffset - right.token.nodeStartOffset)) {
      const { token } = candidate;
      if (token.nodeStartOffset < cursor || token.nodeEndOffset > text.length) {
        summary.skippedOverlap += 1;
        continue;
      }
      fragment.append(text.slice(cursor, token.nodeStartOffset));
      const wrapper = createTokenWrapper(candidate);
      fragment.append(wrapper);
      renderedNodes.add(wrapper);
      cursor = token.nodeEndOffset;
      rendered += 1;
    }
    fragment.append(text.slice(cursor));
    rememberMutationTarget(parent);
    parent.replaceChild(fragment, textNode);
    return rendered;
  }

  function createTokenWrapper(candidate: RenderCandidate): HTMLElement {
    const wrapper = doc.createElement("span");
    wrapper.dataset.glossaOwned = "1";
    wrapper.dataset.glossaToken = candidate.item.tokenId;
    wrapper.dataset.glossaSurface = candidate.token.sourceText;
    wrapper.dataset.glossaDisplay = candidate.item.display;
    wrapper.dataset.glossaFingerprint = candidate.token.sourceFingerprint;
    wrapper.dataset.glossaLemma = candidate.token.lemma;
    wrapper.className = "notranslate";
    wrapper.setAttribute("translate", "no");
    applyAppearance(wrapper, appearance);

    const label = doc.createElement("span");
    label.dataset.glossaOwned = "1";
    label.dataset.glossaTokenLabel = candidate.item.tokenId;
    label.dataset.glossaLabel = candidate.item.tokenId;
    label.setAttribute("translate", "no");
    label.textContent = candidate.item.display;

    const width = doc.createElement("span");
    width.dataset.glossaOwned = "1";
    width.dataset.glossaTokenWidth = candidate.item.tokenId;
    width.setAttribute("translate", "no");
    width.textContent = candidate.item.display;

    const surface = doc.createElement("span");
    surface.dataset.glossaOwned = "1";
    surface.dataset.glossaTokenSurface = candidate.item.tokenId;
    surface.setAttribute("translate", "no");
    surface.textContent = candidate.token.sourceText;

    wrapper.append(width, label, surface);
    return wrapper;
  }
}

function applyAppearance(host: HTMLElement, appearance: AppearanceSettings): void {
  host.style.setProperty("--glossa-text-color", appearance.textColor);
  host.style.setProperty("--glossa-bg-color", appearance.backgroundColor);
  host.style.setProperty("--glossa-bg-alpha", `${Math.round(appearance.backgroundOpacity * 100)}%`);
  host.style.setProperty("--glossa-font-family", appearance.fontFamily);
  host.style.setProperty("--glossa-font-size", `${appearance.fontSize}px`);
}
