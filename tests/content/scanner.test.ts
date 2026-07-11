import { describe, expect, it } from "vitest";

import { scanDocumentTextInChunks, type ScanChunk, type ScanChunkOptions, type ScanStats } from "../../src/content/scanner";

describe("content scanner", () => {
  it("extracts English word candidates with sentence context and skips inert text", async () => {
    document.body.innerHTML = `
      <main>
        <p>Press the submit button to finish. The archive is ready.</p>
        <button>Cancel request</button>
        <script>const hidden = "invisible token";</script>
        <style>.hidden { color: red; }</style>
      </main>
    `;

    const result = await scanDocumentText(document, new Set(["the", "to", "is"]));

    expect(result.sentences.map((sentence) => sentence.text)).toEqual([
      "Press the submit button to finish.",
      "The archive is ready."
    ]);
    expect(result.tokens.map((token) => token.surface)).toEqual([
      "Press",
      "submit",
      "button",
      "finish",
      "archive",
      "ready"
    ]);
    expect(result.tokens.find((token) => token.surface === "submit")?.sentenceText).toBe("Press the submit button to finish.");
    expect(result.stats.rejectedBySubtree).toBeGreaterThan(0);
  });

  it("keeps one sentence context across inline markup", async () => {
    document.body.innerHTML = "<main><p>A <em>quizzical</em> bank appears in a complicated context.</p></main>";

    const result = await scanDocumentText(document, new Set());
    const quizzical = result.tokens.find((token) => token.surface === "quizzical");
    const bank = result.tokens.find((token) => token.surface === "bank");

    expect(quizzical).toMatchObject({
      sentenceText: "A quizzical bank appears in a complicated context.",
      startOffset: 2,
      endOffset: 11
    });
    expect(bank).toMatchObject({
      sentenceText: "A quizzical bank appears in a complicated context.",
      startOffset: 12,
      endOffset: 16
    });
  });

  it("skips hidden, editable, code, no-translate and extension-owned text", async () => {
    document.body.innerHTML = `
      <main>
        <p>Visible quarry emerges slowly.</p>
        <p style="display: none">Hidden quarry emerges slowly.</p>
        <p aria-hidden="true">Decorative quarry emerges slowly.</p>
        <div contenteditable="true">Editable quarry emerges slowly.</div>
        <pre>Code quarry emerges slowly.</pre>
        <p class="notranslate">Protected quarry emerges slowly.</p>
        <p data-glossa-owned="1">Owned quarry emerges slowly.</p>
      </main>
    `;

    const result = await scanDocumentText(document, new Set());

    expect(result.sentences.map((sentence) => sentence.text)).toEqual(["Visible quarry emerges slowly."]);
    expect(result.tokens.map((token) => token.surface)).toEqual(["Visible", "quarry", "emerges", "slowly"]);
  });

  it("rejects code-like shapes and limits repeated lemmas", async () => {
    document.body.innerHTML = `
      <main>
        <p>API clients use obscure obscure quarry words.</p>
      </main>
    `;

    const result = await scanDocumentText(document, new Set(["use"]));

    expect(result.tokens.map((token) => token.surface)).toEqual(["clients", "obscure", "quarry", "words"]);
    expect(result.stats.rejectedByShape).toBe(1);
    expect(result.stats.rejectedByFrequency).toBe(1);
  });

  it("attaches source identity to each token", async () => {
    document.body.innerHTML = "<main><p>Submit archive entries carefully.</p></main>";

    const result = await scanDocumentText(document, new Set(), { scanVersion: 7 });
    const token = result.tokens.find((item) => item.surface === "Submit");

    expect(token).toMatchObject({
      scanVersion: 7,
      sourceText: "Submit",
      nodeStartOffset: 0,
      nodeEndOffset: 6
    });
    expect(token?.sourceFingerprint).toMatch(/^\d+:\d+:[a-z0-9]+$/);
  });

  it("scans readable text inside open shadow roots", async () => {
    document.body.innerHTML = "<main><article id=\"host\"></article></main>";
    const host = document.querySelector("#host")!;
    const shadow = host.attachShadow({ mode: "open" });
    const paragraph = document.createElement("p");
    paragraph.textContent = "Shadow archive appears clearly.";
    shadow.append(paragraph);

    const result = await scanDocumentText(document, new Set());

    expect(result.tokens.map((token) => token.surface)).toEqual(["Shadow", "archive", "appears", "clearly"]);
  });

  it("keeps renderable tokens only when their ranges intersect the viewport", async () => {
    document.body.innerHTML = "<main><p>Visible archive appears. Hidden quarry appears.</p></main>";
    const originalGetClientRects = Range.prototype.getClientRects;
    Range.prototype.getClientRects = function () {
      const visible = this.toString().startsWith("Visible") || this.toString().startsWith("archive") || this.toString().startsWith("appears.");
      return [{
        width: 12,
        height: 12,
        top: visible ? 10 : 900,
        bottom: visible ? 22 : 912,
        left: 10,
        right: 22
      }] as unknown as DOMRectList;
    };

    try {
      const result = await scanDocumentText(document, new Set(), {
        requireRenderableRange: true,
        requireViewportRange: true
      });

      expect(result.tokens.map((token) => token.surface)).toEqual(["Visible", "archive"]);
      expect(result.stats.rejectedByVisibility).toBeGreaterThan(0);
    } finally {
      Range.prototype.getClientRects = originalGetClientRects;
    }
  });

  it("clips viewport token eligibility through overflow ancestors", async () => {
    document.body.innerHTML = `
      <main>
        <section id="scroller" style="height: 100px; overflow: auto;">
          <p>Visible archive appears.</p>
          <p>Hidden quarry appears.</p>
        </section>
      </main>
    `;
    const originalGetClientRects = Range.prototype.getClientRects;
    const originalGetBoundingClientRect = Element.prototype.getBoundingClientRect;
    Range.prototype.getClientRects = function () {
      const clipped = this.toString().startsWith("Hidden") || this.toString().startsWith("quarry");
      return [{
        width: 12,
        height: 12,
        top: clipped ? 140 : 10,
        bottom: clipped ? 152 : 22,
        left: 10,
        right: 22
      }] as unknown as DOMRectList;
    };
    Element.prototype.getBoundingClientRect = function () {
      if (this.id === "scroller") {
        return {
          width: 300,
          height: 100,
          top: 0,
          bottom: 100,
          left: 0,
          right: 300
        } as DOMRect;
      }
      return originalGetBoundingClientRect.call(this);
    };

    try {
      const result = await scanDocumentText(document, new Set(), {
        requireRenderableRange: true,
        requireViewportRange: true
      });

      expect(result.tokens.map((token) => token.surface)).toEqual(["Visible", "archive", "appears"]);
      expect(result.stats.rejectedByVisibility).toBeGreaterThan(0);
    } finally {
      Range.prototype.getClientRects = originalGetClientRects;
      Element.prototype.getBoundingClientRect = originalGetBoundingClientRect;
    }
  });

  it("clips shadow-root token eligibility through overflow ancestors outside the host", async () => {
    document.body.innerHTML = `
      <main>
        <section id="scroller" style="height: 100px; overflow: auto;">
          <article id="host"></article>
        </section>
      </main>
    `;
    const host = document.querySelector("#host")!;
    const shadow = host.attachShadow({ mode: "open" });
    const paragraph = document.createElement("p");
    paragraph.textContent = "Hidden quarry appears.";
    shadow.append(paragraph);
    const originalGetClientRects = Range.prototype.getClientRects;
    const originalGetBoundingClientRect = Element.prototype.getBoundingClientRect;
    Range.prototype.getClientRects = function () {
      return [{
        width: 12,
        height: 12,
        top: 140,
        bottom: 152,
        left: 10,
        right: 22
      }] as unknown as DOMRectList;
    };
    Element.prototype.getBoundingClientRect = function () {
      if (this.id === "scroller") {
        return {
          width: 300,
          height: 100,
          top: 0,
          bottom: 100,
          left: 0,
          right: 300
        } as DOMRect;
      }
      return originalGetBoundingClientRect.call(this);
    };

    try {
      const result = await scanDocumentText(document, new Set(), {
        requireRenderableRange: true,
        requireViewportRange: true
      });

      expect(result.tokens).toEqual([]);
      expect(result.stats.rejectedByVisibility).toBeGreaterThan(0);
    } finally {
      Range.prototype.getClientRects = originalGetClientRects;
      Element.prototype.getBoundingClientRect = originalGetBoundingClientRect;
    }
  });

  it("streams scan chunks by token count inside large text nodes", async () => {
    document.body.innerHTML = `
      <main>
        <p>Alpha archive emerges slowly. Beta quarry appears clearly.</p>
      </main>
    `;
    const chunks: string[][] = [];

    const stats = await scanDocumentTextInChunks(document, new Set(), {
      maxTokensPerChunk: 3,
      maxChunkDelayMs: 1_000
    }, (chunk) => {
      chunks.push(chunk.tokens.map((token) => token.surface));
    });

    expect(chunks).toEqual([
      ["Alpha", "archive", "emerges"],
      ["slowly", "Beta", "quarry"],
      ["appears", "clearly"]
    ]);
    expect(chunks.every((chunk) => chunk.length <= 3)).toBe(true);
    expect(stats.candidateWords).toBe(8);
  });
});

async function scanDocumentText(
  doc: Document,
  knownWords: ReadonlySet<string>,
  options: ScanChunkOptions = {}
): Promise<{ sentences: ScanChunk["sentences"]; tokens: ScanChunk["tokens"]; stats: ScanStats }> {
  const sentences: ScanChunk["sentences"] = [];
  const tokens: ScanChunk["tokens"] = [];
  const stats = await scanDocumentTextInChunks(doc, knownWords, {
    ...options,
    maxTokensPerChunk: Number.MAX_SAFE_INTEGER,
    maxChunkDelayMs: Number.MAX_SAFE_INTEGER
  }, (chunk) => {
    sentences.push(...chunk.sentences);
    tokens.push(...chunk.tokens);
  });
  return { sentences, tokens, stats };
}
