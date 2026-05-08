import { describe, expect, it } from "vitest";

import { scanDocumentText, scanDocumentTextInChunks } from "../../src/content/scanner";

describe("content scanner", () => {
  it("extracts English word candidates with sentence context and skips inert text", () => {
    document.body.innerHTML = `
      <main>
        <p>Press the submit button to finish. The archive is ready.</p>
        <button>Cancel request</button>
        <script>const hidden = "invisible token";</script>
        <style>.hidden { color: red; }</style>
      </main>
    `;

    const result = scanDocumentText(document, new Set(["the", "to", "is"]));

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

  it("skips hidden, editable, code, no-translate and extension-owned text", () => {
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

    const result = scanDocumentText(document, new Set());

    expect(result.sentences.map((sentence) => sentence.text)).toEqual(["Visible quarry emerges slowly."]);
    expect(result.tokens.map((token) => token.surface)).toEqual(["Visible", "quarry", "emerges", "slowly"]);
  });

  it("rejects code-like shapes and limits repeated lemmas", () => {
    document.body.innerHTML = `
      <main>
        <p>API clients use obscure obscure quarry words.</p>
      </main>
    `;

    const result = scanDocumentText(document, new Set(["use"]));

    expect(result.tokens.map((token) => token.surface)).toEqual(["clients", "obscure", "quarry", "words"]);
    expect(result.stats.rejectedByShape).toBe(1);
    expect(result.stats.rejectedByFrequency).toBe(1);
  });

  it("attaches source identity to each token", () => {
    document.body.innerHTML = "<main><p>Submit archive entries carefully.</p></main>";

    const result = scanDocumentText(document, new Set(), { scanVersion: 7 });
    const token = result.tokens.find((item) => item.surface === "Submit");

    expect(token).toMatchObject({
      scanVersion: 7,
      sourceText: "Submit",
      nodeStartOffset: 0,
      nodeEndOffset: 6
    });
    expect(token?.sourceFingerprint).toMatch(/^\d+:\d+:[a-z0-9]+$/);
  });

  it("scans readable text inside open shadow roots", () => {
    document.body.innerHTML = "<main><article id=\"host\"></article></main>";
    const host = document.querySelector("#host")!;
    const shadow = host.attachShadow({ mode: "open" });
    const paragraph = document.createElement("p");
    paragraph.textContent = "Shadow archive appears clearly.";
    shadow.append(paragraph);

    const result = scanDocumentText(document, new Set());

    expect(result.tokens.map((token) => token.surface)).toEqual(["Shadow", "archive", "appears", "clearly"]);
  });

  it("streams scan chunks by token count between text nodes", async () => {
    document.body.innerHTML = `
      <main>
        <p>Alpha archive emerges slowly.</p>
        <p>Beta quarry appears clearly.</p>
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
      ["Alpha", "archive", "emerges", "slowly"],
      ["Beta", "quarry", "appears", "clearly"]
    ]);
    expect(stats.candidateWords).toBe(8);
  });
});
