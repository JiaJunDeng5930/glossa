import type { ScannedToken } from "./scanner";
import { occurrencesFor } from "./occurrence";

export function rangeForToken(token: ScannedToken, doc: Document = token.textNode.ownerDocument): Range {
  const range = doc.createRange();
  const location = occurrencesFor(doc).locate(token);
  if (!location) throw new Error("Source occurrence is no longer attached");
  range.setStart(location.node, location.start);
  range.setEnd(location.node, location.end);
  return range;
}

export interface TokenRenderValidation {
  ok: boolean;
  range?: Range;
  rect?: DOMRectReadOnly;
  reason?: "stale-scan" | "detached-node" | "changed-text" | "invisible-range";
}

export function validateTokenForRender(token: ScannedToken, expectedScanVersion: number): TokenRenderValidation {
  if (token.scanVersion !== expectedScanVersion) {
    return { ok: false, reason: "stale-scan" };
  }
  const registry = occurrencesFor(token.textNode.ownerDocument);
  if (!registry.token(token.id)) registry.register(token);
  if (!registry.valid(token)) return { ok: false, reason: token.textNode.isConnected ? "changed-text" : "detached-node" };
  const range = rangeForToken(token);
  const rect = firstRenderableRect(range);
  if (!rect) {
    range.detach();
    return { ok: false, reason: "invisible-range" };
  }
  return { ok: true, range, rect };
}

function firstRenderableRect(range: Range): DOMRectReadOnly | undefined {
  for (const rect of Array.from(range.getClientRects())) {
    if (rect.width > 0 && rect.height > 0) {
      return rect;
    }
  }
  return undefined;
}
