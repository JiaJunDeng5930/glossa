import { describe, expect, it, vi } from "vitest";

import { createAnkiClient } from "../../../src/shared/services/ankiClient";
import { DEFAULT_SETTINGS } from "../../../src/shared/types";

describe("AnkiConnect adapter diagnostics", () => {
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
      tags: ["glossa"]
    });
    expect(clearTimeoutSpy).toHaveBeenCalledTimes(1);
    clearTimeoutSpy.mockRestore();
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

  it("classifies AnkiConnect HTTP failures as service diagnostics with status", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: "offline" }, 503));

    await expect(createAnkiClient(fetchImpl as never).createNote(noteInput())).rejects.toMatchObject({
      payload: { reason: "service-error", service: "anki", status: 503 }
    });
  });

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
    card: { front: "<b>Submit</b> the form.", back: "提交" }
  };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" }
  });
}

describe("Anki note success boundary", () => {
  it.each([null, [], {}, {result:undefined}, {result:"42"}, {result:{}}, {result:0}, {result:-1}, {result:1.5}, {result:NaN}, {result:Infinity}, {result:42,error:{}}, {result:42,error:7}].map(envelope=>({envelope})))("rejects malformed note success $envelope without retrying", async ({envelope}) => {
    const fetchImpl=vi.fn(async()=>jsonResponse(envelope));
    await expect(createAnkiClient(fetchImpl as never).createNote(noteInput())).rejects.toMatchObject({payload:{reason:"invalid-response",service:"anki"}});
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it("classifies external service wording into a stable domain code", async()=> {
    const fetchImpl=vi.fn(async()=>jsonResponse({result:null,error:"deck was not found: Study"}));
    await expect(createAnkiClient(fetchImpl as never).createNote(noteInput())).rejects.toMatchObject({payload:{code:"anki-deck-not-found"}});
  });
  it("uses the same fields for catalog compatibility and note creation",async()=> {
    const replies=[6,["Glossa"],["Wrong","Basic"],["Question","Answer"],["Front","Back"]];
    const fetchImpl=vi.fn(async()=>jsonResponse({result:replies.shift(),error:null}));
    await expect(createAnkiClient(fetchImpl as never).loadCatalog(DEFAULT_SETTINGS.anki)).resolves.toEqual({decks:["Glossa"],modelNames:["Basic"]});
  });
});
