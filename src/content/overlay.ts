import { DEFAULT_SETTINGS, type AppearanceSettings, type GlossTokenPayload } from "../shared/types";
import GLOSSA_THEME from "../shared/theme.json";
import { userMessageForError } from "../shared/userMessages";
import type { ScannedToken } from "./scanner";
import { occurrencesFor } from "./occurrence";
import { validateTokenForRender } from "./range";
import { glossRefreshKey } from "./scanner";

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
  refreshKeys(): Set<string>;
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

type GlossState = { status: "none" | "pending" | "hidden" } | { status: "ready"; display: string } | { status: "error"; message: string };
type FeedbackState = { status: "none" } | { status: Exclude<CardFeedback, "card-cancelled">; message?: string };
interface RenderedOccurrence { token: ScannedToken; wrapper: HTMLElement; surface: HTMLElement; label: HTMLElement; width: HTMLElement; gloss: GlossState; feedback: FeedbackState }
const STYLE_ID = "glossa-inline-style";
const INLINE_LABEL_FONT_WEIGHT = 750;
export function createGlossOverlay(doc: Document, appearance: AppearanceSettings = DEFAULT_SETTINGS.appearance): GlossOverlay {
  const registry = occurrencesFor(doc);
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
      background: ${GLOSSA_THEME.selectionWash};
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
  shadow.append(style, veil, selectionNote);
  doc.documentElement.append(host);
  const rendered = new Map<string, RenderedOccurrence>();
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

    } else {
      root.append(inlineStyle);

    }
  };


  function prune(): number {
    let count = 0;
    for (const [id, record] of rendered) if (!record.wrapper.isConnected || !registry.valid(record.token)) { rendered.delete(id); registry.unwrap(id); count++; }
    return count;
  }
  function ensure(token: ScannedToken): RenderedOccurrence | undefined {
    const existing = rendered.get(token.id);
    if (existing) return existing;
    if (!registry.token(token.id)) registry.register(token);
    if (!registry.valid(token)) return undefined;
    const location = registry.locate(token);
    if (!location) return undefined;
    const validation = validateTokenForRender(token, token.scanVersion);
    validation.range?.detach();
    if (!validation.ok) return undefined;
    const root = location.node.getRootNode();
    if (root instanceof Document || root instanceof ShadowRoot) { registry.observe(root); registry.mutate(() => installStyle(root)); }
    const wrapper = doc.createElement("span");
    wrapper.dataset.glossaToken = token.id;
    wrapper.dataset.glossaOwned = "1";
    wrapper.dataset.glossaSurface = token.surface;
    wrapper.className = "notranslate";
    wrapper.setAttribute("translate", "no");
    applyAppearance(wrapper, appearance);
    const label = doc.createElement("span"), width = doc.createElement("span"), surface = doc.createElement("span");
    label.dataset.glossaTokenLabel = token.id;
    label.dataset.glossaLabel = token.id;
    width.dataset.glossaTokenWidth = token.id;
    surface.dataset.glossaTokenSurface = token.id;
    for (const node of [label, width, surface]) { node.dataset.glossaOwned = "1"; node.setAttribute("translate", "no"); }
    wrapper.append(width, label, surface);
    if (!registry.wrap(token, { wrapper, surface })) return undefined;
    const record: RenderedOccurrence = { token, wrapper, surface, label, width, gloss: { status: "none" }, feedback: { status: "none" } };
    rendered.set(token.id, record);
    return record;
  }
  function commit(record: RenderedOccurrence, gloss: GlossState, feedback: FeedbackState): RenderSummary {
    record.gloss = gloss; record.feedback = feedback;
    if (feedback.status === "none" && (gloss.status === "none" || gloss.status === "hidden")) {
      registry.unwrap(record.token.id); rendered.delete(record.token.id); return { result: "hidden" };
    }
    const kind = feedback.status !== "card-pending" && gloss.status === "ready" ? "gloss" : "feedback";
    const display = feedback.status === "card-pending" ? "..."
      : gloss.status === "ready" ? gloss.display
      : feedback.status !== "none" ? feedbackFallback(feedback.status)
      : gloss.status === "pending" ? "..." : "×";
    const message = feedback.status !== "none" && feedback.message ? feedback.message
      : feedback.status === "card-pending" ? `${record.token.surface}：正在制卡`
      : feedback.status === "card-success" ? `${record.token.surface}：制卡完成`
      : feedback.status === "card-error" ? `${record.token.surface}：制卡失败`
      : feedback.status === "card-unknown" ? `${record.token.surface}：制卡结果未知`
      : gloss.status === "error" ? gloss.message
      : gloss.status === "pending" ? `${record.token.surface}：正在生成释义` : `${record.token.surface}：${display}`;
    registry.mutate(() => {
      record.label.dataset.glossaVisual = display; record.width.dataset.glossaVisual = display;
      record.wrapper.dataset.glossaDisplay = display;
      record.wrapper.dataset.glossaDisplayKind = kind;
      record.wrapper.dataset.glossaStatus = gloss.status;
      if (feedback.status === "none") delete record.wrapper.dataset.glossaFeedback;
      else record.wrapper.dataset.glossaFeedback = feedback.status;
      record.wrapper.title = message; record.wrapper.setAttribute("aria-label", message);
    });
    return { result: "updated" };
  }
  function glossFor(outcome: GlossTokenPayload): GlossState {
    if (outcome.status === "ready") return { status: "ready", display: outcome.item!.display };
    if (outcome.status === "error") return { status: "error", message: userMessageForError(outcome.error, "ai") };
    return { status: outcome.status };
  }
  return {
    applyTokenOutcome(token, outcome, version) {
      if (!token) return { result: "skipped", reason: "missing-token" };
      if (token.scanVersion !== version) return { result: "skipped", reason: "stale-scan" };
      if (!registry.token(token.id)) registry.register(token);
      if (!registry.valid(token)) return { result: "skipped", reason: "changed-text" };
      const existing = rendered.get(token.id);
      if (!existing && outcome.status === "hidden") return { result: "hidden" };
      const record = existing ?? ensure(token);
      if (!record) return { result: "skipped", reason: "invisible-range" };
      const result = commit(record, glossFor(outcome), record.feedback);
      return !existing && result.result === "updated" ? { result: "rendered" } : result;
    },
    applyStalePendingOutcome(outcome) {
      const record = rendered.get(outcome.tokenId);
      if (!record || record.gloss.status !== "pending") return { result: "skipped", reason: "missing-token" };
      if (!registry.valid(record.token)) return { result: "skipped", reason: "changed-text" };
      if (outcome.status === "pending") return { result: "preserved" };
      return commit(record, glossFor(outcome), record.feedback);
    },
    applyCardFeedback(input) {
      const existing = rendered.get(input.tokenId);
      if (input.feedback === "card-cancelled") return existing ? commit(existing, existing.gloss, { status: "none" }) : { result: "skipped", reason: "missing-token" };
      const token = input.token ?? registry.token(input.tokenId);
      if (!token) return { result: "skipped", reason: "missing-token" };
      if (!registry.token(token.id)) registry.register(token);
      if (!registry.valid(token)) return { result: "skipped", reason: "changed-text" };
      const record = existing ?? ensure(token);
      if (!record) return { result: "skipped", reason: "invisible-range" };
      const result = commit(record, record.gloss, { status: input.feedback, ...(input.message ? { message: input.message } : {}) });
      return !existing && result.result === "updated" ? { result: "rendered" } : result;
    },
    setSelectionMode(active) { registry.mutate(() => { if (active) host.dataset.glossaSelecting = "true"; else delete host.dataset.glossaSelecting; }); },
    setAppearance(next) { appearance = next; registry.mutate(() => { applyAppearance(host, next); for (const record of rendered.values()) applyAppearance(record.wrapper, next); }); },
    markStalePendingAsError(ids, message) { for (const id of ids) { const record = rendered.get(id); if (record?.gloss.status === "pending" && registry.valid(record.token)) commit(record, { status: "error", message }, record.feedback); } },
    clear() { for (const id of rendered.keys()) registry.unwrap(id); rendered.clear(); },
    pruneDisconnected: prune,
    ownsMutation(record) { return registry.ownsMutation(record); },
    refreshKeys() { return new Set(Array.from(rendered.values()).filter(record => record.gloss.status === "ready" && registry.valid(record.token)).map(record => glossRefreshKey(record.token))); }
  };
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
