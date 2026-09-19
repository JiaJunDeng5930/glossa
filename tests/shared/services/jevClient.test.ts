import { afterEach, describe, expect, it, vi } from "vitest";

import { createJevClient, type JevClient } from "../../../src/shared/services/jevClient";
import type { JevSettings } from "../../../src/shared/types";

const settings: JevSettings = {
  endpoint: "https://api.typesafe.ai/v1/systemone",
  apiKey: "jev-test-key",
  model: "jev-latest",
  requestTimeoutMs: 2_500
};

afterEach(() => vi.useRealTimers());

describe("Jev dictionary sense selection", () => {
  it("sends the complete sentence, target occurrence and every sense, returning the original dictionary ID", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => jsonResponse({
      answers: { dictionary_sense: { choice: "sense_2", confidence: 0.1 } }
    }));
    const input = senseInput();

    await expect(createJevClient(fetchImpl).selectSense(input)).resolves.toEqual({ senseId: "dictionary:bank:river" });

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(settings.endpoint);
    expect(init).toMatchObject({ method: "POST", headers: { authorization: "Bearer jev-test-key" } });
    const body = JSON.parse(init?.body as string);
    expect(body.model).toBe("jev-latest");
    expect(body.state).toEqual({ sentence: input.sentence, word: input.word });
    expect(body.questions.dictionary_sense).toMatchObject({
      type: "choice",
      criteria: { sense_1: "noun: 银行", sense_2: "noun: 河岸" }
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([1, 255])("sends all %i dictionary senses without inventing or truncating candidates", async count => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => choiceResponse(`sense_${count}`));
    const senses = Array.from({ length: count }, (_, index) => ({ id: `entry-${index}`, definition: `释义 ${index}` }));

    await expect(createJevClient(fetchImpl).selectSense({ ...senseInput(), senses })).resolves.toEqual({ senseId: `entry-${count - 1}` });

    const body = JSON.parse(fetchImpl.mock.calls[0]![1]?.body as string);
    expect(Object.values(body.questions.dictionary_sense.criteria)).toEqual(senses.map(sense => sense.definition));
  });

  it.each([0, 256])("rejects %i senses before making an invalid Jev request", async count => {
    const fetchImpl = vi.fn(async () => choiceResponse("sense_1"));
    const senses = Array.from({ length: count }, (_, index) => ({ id: `entry-${index}`, definition: `释义 ${index}` }));
    await expect(createJevClient(fetchImpl).selectSense({ ...senseInput(), senses })).rejects.toMatchObject({
      payload: { reason: "service-error", service: "jev" }
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    null,
    { answers: [] },
    { answers: { dictionary_sense: { choice: "invented-translation" } } },
    { answers: { dictionary_sense: { choice: 1 } } },
    { answers: { different_question: { choice: "sense_1" } } }
  ])("rejects malformed or out-of-candidate answers: %j", async response => {
    const fetchImpl = vi.fn(async () => jsonResponse(response));
    await expect(createJevClient(fetchImpl).selectSense(senseInput())).rejects.toMatchObject({
      payload: { reason: "invalid-response", service: "jev" }
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("probes with a fixed public example", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => choiceResponse("sense_2"));
    await expect(createJevClient(fetchImpl).probe(settings)).resolves.toBeUndefined();
    const body = JSON.parse(fetchImpl.mock.calls[0]![1]?.body as string);
    expect(body.state.sentence).toBe("She sat on the bank of the river.");
    expect(body.state.sentence.slice(body.state.word.startOffset, body.state.word.endOffset)).toBe("bank");
  });
});

describe("Jev request diagnostics", () => {
  it("does not request without a configured API key", async () => {
    const { apiKey: _apiKey, ...unconfiguredSettings } = settings;
    const fetchImpl = vi.fn(async () => choiceResponse("sense_1"));
    await expect(createJevClient(fetchImpl).selectSense({ ...senseInput(), settings: unconfiguredSettings })).rejects.toMatchObject({
      payload: { reason: "unauthorized", service: "jev" }
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([{ status: 401, reason: "unauthorized" }, { status: 503, reason: "service-error" }])(
    "classifies HTTP $status without including the external error body",
    async ({ status, reason }) => {
      const fetchImpl = vi.fn(async () => jsonResponse({ error: "Bearer jev-test-key" }, status));
      const error = await createJevClient(fetchImpl).selectSense(senseInput()).catch(error => error);
      expect(error).toMatchObject({ payload: { reason, service: "jev", status } });
      expect(JSON.stringify(error)).not.toContain("jev-test-key");
      expect(error.message).not.toContain("jev-test-key");
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
  );

  it("keeps the network diagnostic category while discarding sensitive transport details", async () => {
    const fetchImpl = vi.fn(async () => { throw new TypeError("Authorization: Bearer jev-test-key"); });
    const error = await createJevClient(fetchImpl).selectSense(senseInput()).catch(error => error);
    expect(error).toMatchObject({ payload: { reason: "network", message: "Jev request failed", service: "jev" } });
    expect(error.cause).toBeUndefined();
    expect(JSON.stringify(error)).not.toContain("jev-test-key");
  });

  it("rejects invalid JSON without retaining response contents", async () => {
    const fetchImpl = vi.fn(async () => new Response("Bearer jev-test-key"));
    const error = await createJevClient(fetchImpl).selectSense(senseInput()).catch(error => error);
    expect(error).toMatchObject({ payload: { reason: "invalid-response", service: "jev" } });
    expect(JSON.stringify(error)).not.toContain("jev-test-key");
  });

  it("aborts at the configured timeout and releases its timer", async () => {
    vi.useFakeTimers();
    const fetchImpl = abortableFetch();
    const request = createJevClient(fetchImpl).selectSense(senseInput());
    const assertion = expect(request).rejects.toMatchObject({ payload: { reason: "timeout", service: "jev" } });
    await vi.advanceTimersByTimeAsync(settings.requestTimeoutMs);
    await assertion;
    expect(fetchImpl.mock.calls[0]![1]?.signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("propagates caller cancellation without retrying and removes its listener", async () => {
    const controller = new AbortController();
    const removeListener = vi.spyOn(controller.signal, "removeEventListener");
    const fetchImpl = abortableFetch();
    const request = createJevClient(fetchImpl).selectSense({ ...senseInput(), signal: controller.signal });
    const assertion = expect(request).rejects.toMatchObject({ payload: { message: "Jev request canceled", service: "jev" } });
    controller.abort();
    await assertion;
    expect(fetchImpl.mock.calls[0]![1]?.signal?.aborted).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(removeListener).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  it("does not send an already canceled request", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchImpl = vi.fn(async () => choiceResponse("sense_1"));
    await expect(createJevClient(fetchImpl).selectSense({ ...senseInput(), signal: controller.signal })).rejects.toMatchObject({
      payload: { message: "Jev request canceled", service: "jev" }
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

function senseInput(): Parameters<JevClient["selectSense"]>[0] {
  return {
    settings,
    sentence: "She walked along the bank of the river.",
    word: { surface: "bank", lemma: "bank", startOffset: 21, endOffset: 25 },
    senses: [
      { id: "dictionary:bank:finance", definition: "银行", partOfSpeech: "noun" },
      { id: "dictionary:bank:river", definition: "河岸", partOfSpeech: "noun" }
    ]
  };
}

function choiceResponse(choice: string): Response {
  return jsonResponse({ answers: { dictionary_sense: { choice } } });
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

function abortableFetch() {
  return vi.fn((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
  }));
}
