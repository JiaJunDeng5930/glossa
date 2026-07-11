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
});
