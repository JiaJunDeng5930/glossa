import { DEFAULT_SETTINGS, type AppearanceSettings, type GlossItem } from "../shared/types";
import type { ScannedToken } from "./scanner";
import { rectForToken } from "./range";

export interface GlossOverlay {
  render(items: GlossItem[], tokens: Map<string, ScannedToken>): void;
  clear(): void;
}

export function createGlossOverlay(doc: Document, appearance: AppearanceSettings = DEFAULT_SETTINGS.appearance): GlossOverlay {
  const host = doc.createElement("div");
  host.id = "glossa-overlay";
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
    .label {
      position: fixed;
      transform: translateY(-100%);
      padding: 1px 4px;
      border-radius: 4px;
      background: color-mix(in srgb, var(--glossa-bg-color) var(--glossa-bg-alpha), transparent);
      color: var(--glossa-text-color);
      font-size: var(--glossa-font-size);
      line-height: 1.25;
      white-space: nowrap;
      box-shadow: 0 1px 3px rgba(15, 23, 42, 0.25);
    }
  `;
  const layer = doc.createElement("div");
  layer.part.add("layer");
  shadow.append(style, layer);
  doc.documentElement.append(host);

  return {
    render(items, tokens) {
      layer.replaceChildren();
      for (const item of items) {
        const token = tokens.get(item.tokenId);
        if (!token) {
          continue;
        }
        const rect = rectForToken(token);
        const label = doc.createElement("span");
        label.className = "label";
        label.dataset.glossaLabel = item.tokenId;
        label.textContent = item.display;
        label.style.left = `${Math.max(0, rect.left)}px`;
        label.style.top = `${Math.max(12, rect.top)}px`;
        layer.append(label);
      }
    },
    clear() {
      layer.replaceChildren();
    }
  };
}

function applyAppearance(host: HTMLElement, appearance: AppearanceSettings): void {
  host.style.setProperty("--glossa-text-color", appearance.textColor);
  host.style.setProperty("--glossa-bg-color", appearance.backgroundColor);
  host.style.setProperty("--glossa-bg-alpha", `${Math.round(appearance.backgroundOpacity * 100)}%`);
  host.style.setProperty("--glossa-font-family", appearance.fontFamily);
  host.style.setProperty("--glossa-font-size", `${appearance.fontSize}px`);
}
