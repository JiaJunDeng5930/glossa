import { describe, expect, it, vi } from "vitest";

import { validateTokenForRender } from "../../src/content/range";
import { createSourceFingerprint, type ScannedToken } from "../../src/content/scanner";

// @verifies glossa.translation.geometry The test verifies that range validation accepts current connected tokens and rejects stale DOM geometry.
describe("content range validation", () => {
  it("accepts a connected token whose source text and rects are current", () => {
    document.body.innerHTML = "<main><p>Submit archive entries carefully.</p></main>";
    const token = tokenFromText(document.querySelector("p")!.firstChild as Text, "Submit", 3);
    const restore = stubRenderableRects();

    const result = validateTokenForRender(token, 3);

    expect(result.ok).toBe(true);
    expect(result.rect).toMatchObject({ left: 10, top: 20, width: 30, height: 12 });
    result.range?.detach();
    restore();
  });

  it("rejects stale scan versions", () => {
    document.body.innerHTML = "<main><p>Submit archive entries carefully.</p></main>";
    const token = tokenFromText(document.querySelector("p")!.firstChild as Text, "Submit", 3);

    expect(validateTokenForRender(token, 4)).toEqual({ ok: false, reason: "stale-scan" });
  });

  it("rejects changed text at the original offsets", () => {
    document.body.innerHTML = "<main><p>Submit archive entries carefully.</p></main>";
    const textNode = document.querySelector("p")!.firstChild as Text;
    const token = tokenFromText(textNode, "Submit", 3);

    textNode.nodeValue = "Archive entries changed carefully.";

    expect(validateTokenForRender(token, 3)).toEqual({ ok: false, reason: "changed-text" });
  });
});

function tokenFromText(textNode: Text, surface: string, scanVersion: number): ScannedToken {
  const text = textNode.nodeValue ?? "";
  const nodeStartOffset = text.indexOf(surface);
  const nodeEndOffset = nodeStartOffset + surface.length;
  return {
    id: "t0",
    sentenceId: "s0",
    surface,
    lemma: surface.toLowerCase(),
    startOffset: nodeStartOffset,
    endOffset: nodeEndOffset,
    textNode,
    nodeStartOffset,
    nodeEndOffset,
    sentenceText: text,
    sourceText: surface,
    sourceFingerprint: createSourceFingerprint(text, nodeStartOffset, nodeEndOffset),
    scanVersion
  };
}

function stubRenderableRects(): () => void {
  const prototype = Range.prototype as unknown as { getClientRects: () => DOMRectList };
  const original = prototype.getClientRects;
  const rect = { left: 10, top: 20, right: 40, bottom: 32, width: 30, height: 12, x: 10, y: 20, toJSON: vi.fn() };
  prototype.getClientRects = () => [rect] as unknown as DOMRectList;
  return () => {
    prototype.getClientRects = original;
  };
}
