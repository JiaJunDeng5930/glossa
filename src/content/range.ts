import type { ScannedToken } from "./scanner";

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
