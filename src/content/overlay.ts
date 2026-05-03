import type { GlossItem } from "../shared/types";
import type { ScannedToken } from "./scanner";
import { rectForToken } from "./range";

export interface GlossOverlay {
  render(items: GlossItem[], tokens: Map<string, ScannedToken>): void;
  clear(): void;
}

export function createGlossOverlay(doc: Document): GlossOverlay {
  const host = doc.createElement("div");
  host.id = "glossa-overlay";
  const shadow = host.attachShadow({ mode: "open" });
  const style = doc.createElement("style");
  style.textContent = `
    :host {
      all: initial;
      position: fixed;
      inset: 0;
      pointer-events: none;
      z-index: 2147483647;
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    .label {
      position: fixed;
      transform: translateY(-100%);
      padding: 1px 4px;
      border-radius: 4px;
      background: rgba(15, 23, 42, 0.9);
      color: white;
      font-size: 11px;
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
