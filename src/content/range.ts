import { createSourceFingerprint, type ScannedToken } from "./scanner";

export function rangeForToken(token: ScannedToken, doc: Document = token.textNode.ownerDocument): Range {
  const range = doc.createRange();
  range.setStart(token.textNode, token.nodeStartOffset);
  range.setEnd(token.textNode, token.nodeEndOffset);
  return range;
}

export function rectForToken(token: ScannedToken): DOMRect {
  const range = rangeForToken(token);
  const rect = range.getBoundingClientRect();
  range.detach();
  return rect;
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
  if (!token.textNode.isConnected) {
    return { ok: false, reason: "detached-node" };
  }
  const text = token.textNode.nodeValue ?? "";
  const currentText = text.slice(token.nodeStartOffset, token.nodeEndOffset);
  if (currentText !== token.sourceText) {
    return { ok: false, reason: "changed-text" };
  }
  if (createSourceFingerprint(text, token.nodeStartOffset, token.nodeEndOffset) !== token.sourceFingerprint) {
    return { ok: false, reason: "changed-text" };
  }
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
