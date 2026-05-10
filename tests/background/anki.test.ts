import { describe, expect, it, vi } from "vitest";

import { createAnkiClient } from "../../src/background/anki";
import { DEFAULT_SETTINGS } from "../../src/shared/types";

describe("AnkiConnect adapter diagnostics", () => {
  // @verifies glossa.card_creation.note_request
  // @verifies glossa.card_creation.note_request.fields
  // @verifies glossa.card_creation.note_request.tags
  // @verifies glossa.card_creation.note_request.payload
  // @verifies glossa.card_creation.note_request.http_call
  // @verifies glossa.card_creation.note_request.timeout_cleanup
  it("uses the configured Anki model when creating notes", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ result: 42, error: null }));
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");

    await expect(createAnkiClient(fetchImpl as never).createNote(noteInput())).resolves.toBe(42);

    const calls = fetchImpl.mock.calls as unknown as Array<[string, RequestInit]>;
    const body = JSON.parse(calls[0]?.[1].body as string) as {
      params: { note: { deckName: string; modelName: string; fields: Record<string, string>; tags: string[] } };
    };
    expect(calls[0]?.[0]).toBe("http://127.0.0.1:8765");
    expect(calls[0]?.[1]).toMatchObject({
      method: "POST",
      headers: { "content-type": "application/json" }
    });
    expect(body.params.note).toMatchObject({
      deckName: "Glossa",
      modelName: "Basic",
      fields: { Front: "<b>Submit</b> the form.", Back: "提交" },
      tags: ["glossa", "submit"]
    });
    expect(clearTimeoutSpy).toHaveBeenCalledTimes(1);
    clearTimeoutSpy.mockRestore();
  });

  // @verifies glossa.card_creation.failure.request_error
  it("classifies unavailable AnkiConnect as a network diagnostic error", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });

    await expect(createAnkiClient(fetchImpl as never).createNote(noteInput())).rejects.toMatchObject({
      payload: { reason: "network", service: "anki" }
    });
  });

  // @verifies glossa.card_creation.failure.service_error
  it("classifies AnkiConnect service errors as service diagnostics", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ result: null, error: "deck missing" }));

    await expect(createAnkiClient(fetchImpl as never).createNote(noteInput())).rejects.toMatchObject({
      payload: { reason: "service-error", message: "deck missing", service: "anki" }
    });
  });

  // @verifies glossa.card_creation.failure.invalid_response
  it("classifies malformed AnkiConnect JSON as an invalid response diagnostic", async () => {
    const fetchImpl = vi.fn(async () => new Response("{", {
      status: 200,
      headers: { "content-type": "application/json" }
    }));

    await expect(createAnkiClient(fetchImpl as never).createNote(noteInput())).rejects.toMatchObject({
      payload: { reason: "invalid-response", service: "anki" }
    });
  });

  // @verifies glossa.card_creation.failure.http_status
  it("classifies AnkiConnect HTTP failures as service diagnostics with status", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: "offline" }, 503));

    await expect(createAnkiClient(fetchImpl as never).createNote(noteInput())).rejects.toMatchObject({
      payload: { reason: "service-error", service: "anki", status: 503 }
    });
  });

  // @verifies glossa.card_creation.note_request.timeout
  it("aborts slow AnkiConnect note requests after the timeout", async () => {
    vi.useFakeTimers();
    try {
      let signal: AbortSignal | undefined;
      const fetchImpl = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
        signal = init?.signal ?? undefined;
        signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      }));

      const request = createAnkiClient(fetchImpl as never).createNote(noteInput());
      const assertion = expect(request).rejects.toMatchObject({
        payload: { service: "anki" }
      });
      await vi.advanceTimersByTimeAsync(30_000);

      await assertion;
      expect(signal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  // @verifies glossa.card_creation.note_request.timeout
  // @verifies glossa.card_creation.note_request.timeout.setting
  it("uses the configured Anki request timeout", async () => {
    vi.useFakeTimers();
    try {
      let signal: AbortSignal | undefined;
      const fetchImpl = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
        signal = init?.signal ?? undefined;
        signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      }));

      const request = createAnkiClient(fetchImpl as never).createNote({
        ...noteInput(),
        settings: {
          ...DEFAULT_SETTINGS,
          anki: {
            ...DEFAULT_SETTINGS.anki,
            requestTimeoutMs: 2_500
          }
        }
      });
      const assertion = expect(request).rejects.toMatchObject({
        payload: { service: "anki" }
      });
      await vi.advanceTimersByTimeAsync(2_500);

      await assertion;
      expect(signal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

function noteInput(): Parameters<ReturnType<typeof createAnkiClient>["createNote"]>[0] {
  return {
    settings: DEFAULT_SETTINGS,
    card: { front: "<b>Submit</b> the form.", back: "提交" },
    token: { id: "t1", sentenceId: "s1", surface: "submit", lemma: "submit", startOffset: 0, endOffset: 6 }
  };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" }
  });
}
