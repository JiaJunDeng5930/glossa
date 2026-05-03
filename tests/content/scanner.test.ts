import { describe, expect, it } from "vitest";

import { scanDocumentText } from "../../src/content/scanner";

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
      "The archive is ready.",
      "Cancel request"
    ]);
    expect(result.tokens.map((token) => token.surface)).toEqual([
      "Press",
      "submit",
      "button",
      "finish",
      "archive",
      "ready",
      "Cancel",
      "request"
    ]);
    expect(result.tokens.find((token) => token.surface === "submit")?.sentenceText).toBe("Press the submit button to finish.");
  });
});
