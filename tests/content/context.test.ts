import { describe, expect, it, vi } from "vitest";

import { createSentenceContextResolver } from "../../src/content/context";

describe("sentence context resolver", () => {
  it("reuses a direct text-segment index across repeated word lookups", () => {
    document.body.innerHTML = `<div>${Array.from({ length: 12 }, (_, index) => `<span>word${index}${index === 11 ? "." : " "}</span>`).join("")}</div>`;
    const nodes = Array.from(document.querySelectorAll("span"), (element) => element.firstChild as Text);
    const resolveContext = createSentenceContextResolver();
    const findSpy = vi.spyOn(Array.prototype, "find");

    const contexts = nodes.map((node) => resolveContext(node, 0, node.data.trimEnd().length));
    const findCalls = findSpy.mock.calls.length;
    findSpy.mockRestore();

    expect(contexts.every(Boolean)).toBe(true);
    expect(findCalls).toBe(0);
  });

  it("excludes editable descendants from the surrounding sentence", () => {
    document.body.innerHTML = `<p>Visible archive<span contenteditable="true"> private draft</span> appears clearly.</p>`;
    const node = document.querySelector("p")!.firstChild as Text;
    const resolveContext = createSentenceContextResolver();

    const context = resolveContext(node, 8, 15);

    expect(context).toMatchObject({
      text: "Visible archive appears clearly.",
      startOffset: 8,
      endOffset: 15
    });
  });

  it("uses rendered line breaks as sentence boundaries", () => {
    document.body.innerHTML = `<p>Previous sentence without punctuation<br><em>quizzical</em> term appears.</p>`;
    const node = document.querySelector("em")!.firstChild as Text;
    const resolveContext = createSentenceContextResolver();

    const context = resolveContext(node, 0, "quizzical".length);

    expect(context).toMatchObject({
      text: "quizzical term appears.",
      startOffset: 0,
      endOffset: "quizzical".length
    });
  });

  it("uses semantic block containers as the sentence boundary", () => {
    document.body.innerHTML = `<main><span>A contextual <em>quizzical</em> term appears.</span></main>`;
    const node = document.querySelector("em")!.firstChild as Text;
    const resolveContext = createSentenceContextResolver();

    const context = resolveContext(node, 0, "quizzical".length);

    expect(context).toMatchObject({
      text: "A contextual quizzical term appears.",
      startOffset: 13,
      endOffset: 22
    });
  });
});
