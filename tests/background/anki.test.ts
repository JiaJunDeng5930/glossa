import { describe, expect, it, vi } from "vitest";

import { createAnkiClient } from "../../src/background/anki";
import { DEFAULT_SETTINGS } from "../../src/shared/types";

// @verifies glossa.background.anki The test verifies that AnkiConnect note creation uses configured settings and maps endpoint diagnostics.
describe("AnkiConnect adapter diagnostics", () => {
  it("uses the configured Anki model when creating notes", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ result: 42, error: null }));

    await expect(createAnkiClient(fetchImpl as never).createNote(noteInput())).resolves.toBe(42);

    const calls = fetchImpl.mock.calls as unknown as Array<[string, RequestInit]>;
    const body = JSON.parse(calls[0]?.[1].body as string) as {
      params: { note: { deckName: string; modelName: string; fields: Record<string, string> } };
    };
    expect(body.params.note).toMatchObject({
      deckName: "Glossa",
      modelName: "Basic",
      fields: { Front: "<b>Submit</b> the form.", Back: "提交" }
    });
  });

  it("classifies unavailable AnkiConnect as a network diagnostic error", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });

    await expect(createAnkiClient(fetchImpl as never).createNote(noteInput())).rejects.toMatchObject({
      payload: { reason: "network", service: "anki" }
    });
  });

  it("classifies AnkiConnect service errors as service diagnostics", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ result: null, error: "deck missing" }));

    await expect(createAnkiClient(fetchImpl as never).createNote(noteInput())).rejects.toMatchObject({
      payload: { reason: "service-error", message: "deck missing", service: "anki" }
    });
  });

  it("classifies malformed AnkiConnect JSON as an invalid response diagnostic", async () => {
    const fetchImpl = vi.fn(async () => new Response("{", {
      status: 200,
      headers: { "content-type": "application/json" }
    }));

    await expect(createAnkiClient(fetchImpl as never).createNote(noteInput())).rejects.toMatchObject({
      payload: { reason: "invalid-response", service: "anki" }
    });
  });
});

function noteInput(): Parameters<ReturnType<typeof createAnkiClient>["createNote"]>[0] {
  return {
    settings: DEFAULT_SETTINGS,
    card: { front: "<b>Submit</b> the form.", back: "提交" },
    token: { id: "t1", sentenceId: "s1", surface: "submit", lemma: "submit", startOffset: 0, endOffset: 6 }
  };
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}
