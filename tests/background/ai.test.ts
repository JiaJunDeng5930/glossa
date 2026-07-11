import { describe, expect, it, vi } from "vitest";

import { createAiBackend } from "../../src/background/ai";
import { DEFAULT_SETTINGS, type GlossaSettings, type TokenCandidate } from "../../src/shared/types";

describe("AI backend adapters", () => {
  it("sends reasoning effort to the Responses API and parses output_text", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ output_text: "{\"items\":[]}" }));
    const settings = settingsFor("openai-responses", "https://api.openai.com/v1/responses", "high");
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");

    await createAiBackend(fetchImpl as never).glossFrame(glossFrameInput(settings));

    expect(fetchImpl).toHaveBeenCalledWith("https://api.openai.com/v1/responses", expect.objectContaining({
      body: expect.stringContaining("\"reasoning\":{\"effort\":\"high\"}")
    }));
    expect(clearTimeoutSpy).toHaveBeenCalledTimes(1);
    clearTimeoutSpy.mockRestore();
  });

  it("supports Chat Completions request and response shape", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      choices: [{ message: { content: "{\"items\":[{\"tokenId\":\"t1\",\"targetText\":\"submit\",\"display\":\"提交\"}]}" } }]
    }));
    const settings = settingsFor("openai-chat-completions", "https://api.openai.com/v1/chat/completions", "low");

    const result = await createAiBackend(fetchImpl as never).glossFrame(glossFrameInput(settings, [
      { id: "t1", sentenceId: "s1", surface: "submit", lemma: "submit", startOffset: 0, endOffset: 6 }
    ]));

    const calls = fetchImpl.mock.calls as unknown as Array<[string, RequestInit]>;
    const body = JSON.parse(calls[0]![1].body as string) as {
      model: string;
      reasoning: { effort: string };
      messages: Array<{ role: string; content: string }>;
    };
    expect(calls[0]![0]).toBe("https://api.openai.com/v1/chat/completions");
    expect(body.reasoning).toEqual({ effort: "low" });
    expect(body.messages.map((message) => message.role)).toEqual(["developer", "user"]);
    expect(result.items[0]).toMatchObject({ display: "提交" });
  });

  it("sends frame-shaped gloss batches to the backend", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      items: [{ tokenId: "t1", targetText: "submit", display: "提交" }]
    }));
    const settings = settingsFor("glossa-backend", "https://ai.example.test", "medium");

    const result = await createAiBackend(fetchImpl as never).glossFrame({
      settings,
      items: [{
        sentence: "Submit the form.",
        token: { id: "t1", sentenceId: "s1", surface: "submit", lemma: "submit", startOffset: 0, endOffset: 6 }
      }]
    });

    const calls = fetchImpl.mock.calls as unknown as Array<[string, RequestInit]>;
    const body = JSON.parse(calls[0]![1].body as string) as { items: unknown[]; targetLang: string };
    expect(calls[0]![0]).toBe("https://ai.example.test/gloss");
    expect(body.items).toHaveLength(1);
    expect(body.targetLang).toBe("zh-CN");
    expect(result.items[0]).toMatchObject({ display: "提交" });
  });

  it("supports legacy Completions request and response shape", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      choices: [{ text: "{\"cards\":[{\"front\":\"<b>Submit</b> the form.\",\"back\":\"提交\"}]}" }]
    }));
    const settings = settingsFor("openai-completions", "https://api.openai.com/v1/completions", "medium");

    const result = await createAiBackend(fetchImpl as never).ankiCard({
      settings,
      sentence: "Submit the form.",
      token: { id: "t1", sentenceId: "s1", surface: "submit", lemma: "submit", startOffset: 0, endOffset: 6 }
    });

    const calls = fetchImpl.mock.calls as unknown as Array<[string, RequestInit]>;
    const body = JSON.parse(calls[0]![1].body as string) as {
      model: string;
      prompt: string;
      reasoning?: unknown;
    };
    expect(calls[0]![0]).toBe("https://api.openai.com/v1/completions");
    expect(body.prompt).toContain("Return strict JSON only for the anki-card task");
    expect(body.prompt).toContain("\"task\":\"anki-card\"");
    expect(body.reasoning).toBeUndefined();
    expect(result.cards[0]).toMatchObject({ front: "<b>Submit</b> the form.", back: "提交" });
  });

  it("sends card requests to the glossa backend", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      cards: [{ front: "<b>Submit</b> the form.", back: "提交" }]
    }));
    const settings = settingsFor("glossa-backend", "https://ai.example.test/", "medium");

    const result = await createAiBackend(fetchImpl as never).ankiCard({
      settings,
      sentence: "Submit the form.",
      token: { id: "t1", sentenceId: "s1", surface: "submit", lemma: "submit", startOffset: 0, endOffset: 6 }
    });

    const calls = fetchImpl.mock.calls as unknown as Array<[string, RequestInit]>;
    const body = JSON.parse(calls[0]![1].body as string) as { sentence: string; token: unknown; targetLang: string };
    expect(calls[0]![0]).toBe("https://ai.example.test/anki-card");
    expect(body).toMatchObject({ sentence: "Submit the form.", targetLang: "zh-CN" });
    expect(body.token).toMatchObject({ lemma: "submit" });
    expect(result.cards[0]).toMatchObject({ front: "<b>Submit</b> the form.", back: "提交" });
  });

  it("classifies HTTP auth failures as AI diagnostic errors", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: "bad key" }, 401));
    const settings = settingsFor("openai-responses", "https://api.openai.com/v1/responses", "high");

    await expect(createAiBackend(fetchImpl as never).glossFrame(glossFrameInput(settings))).rejects.toMatchObject({
      payload: { reason: "unauthorized", service: "ai", status: 401 }
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("classifies HTTP missing endpoint failures after one AI request attempt", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: "missing" }, 404));
    const settings = settingsFor("glossa-backend", "https://ai.example.test", "high");

    await expect(createAiBackend(fetchImpl as never).glossFrame(glossFrameInput(settings))).rejects.toMatchObject({
      payload: { reason: "not-found", service: "ai", status: 404 }
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("classifies network failures as AI diagnostic errors", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const settings = settingsFor("glossa-backend", "https://ai.example.test", "high");

    await expect(createAiBackend(fetchImpl as never).glossFrame(glossFrameInput(settings))).rejects.toMatchObject({
      payload: { reason: "network", service: "ai" }
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("retries recoverable AI request errors before returning a valid response", async () => {
    let attempt = 0;
    const fetchImpl = vi.fn(async () => {
      attempt += 1;
      if (attempt === 1) {
        throw new TypeError("fetch failed");
      }
      return jsonResponse({ items: [] });
    });
    const settings = settingsFor("glossa-backend", "https://ai.example.test", "high");

    const result = await createAiBackend(fetchImpl as never).glossFrame(glossFrameInput(settings));

    expect(result.items).toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("classifies invalid model JSON as an AI response diagnostic error", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ output_text: "not json" }));
    const settings = settingsFor("openai-responses", "https://api.openai.com/v1/responses", "high");

    await expect(createAiBackend(fetchImpl as never).glossFrame(glossFrameInput(settings))).rejects.toMatchObject({
      payload: { reason: "invalid-response", service: "ai" }
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("classifies malformed backend JSON after one AI request attempt", async () => {
    const fetchImpl = vi.fn(async () => textResponse("not json"));
    const settings = settingsFor("glossa-backend", "https://ai.example.test", "high");

    await expect(createAiBackend(fetchImpl as never).glossFrame(glossFrameInput(settings))).rejects.toMatchObject({
      payload: { reason: "invalid-response", service: "ai" }
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("classifies invalid gloss response shapes after one AI request attempt", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      items: [{ tokenId: "t1", display: "提交" }]
    }));
    const settings = settingsFor("glossa-backend", "https://ai.example.test", "high");

    await expect(createAiBackend(fetchImpl as never).glossFrame(glossFrameInput(settings, [
      { id: "t1", sentenceId: "s1", surface: "submit", lemma: "submit", startOffset: 0, endOffset: 6 }
    ]))).rejects.toMatchObject({
      payload: { reason: "invalid-response", service: "ai" }
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("classifies invalid Anki card response shapes after one AI request attempt", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      cards: [{ front: "<b>Submit</b> the form.", back: 42 }]
    }));
    const settings = settingsFor("glossa-backend", "https://ai.example.test", "high");

    await expect(createAiBackend(fetchImpl as never).ankiCard({
      settings,
      sentence: "Submit the form.",
      token: { id: "t1", sentenceId: "s1", surface: "submit", lemma: "submit", startOffset: 0, endOffset: 6 }
    })).rejects.toMatchObject({
      payload: { reason: "invalid-response", service: "ai" }
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("aborts slow AI transport attempts after the timeout", async () => {
    vi.useFakeTimers();
    try {
      const signals: AbortSignal[] = [];
      const fetchImpl = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal ?? undefined;
        if (signal) signals.push(signal);
        signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      }));
      const settings = settingsFor("glossa-backend", "https://ai.example.test", "medium");

      const request = createAiBackend(fetchImpl as never).glossFrame(glossFrameInput(settings));
      const assertion = expect(request).rejects.toMatchObject({
        payload: { service: "ai" }
      });
      await vi.advanceTimersByTimeAsync(30_000);
      await vi.advanceTimersByTimeAsync(30_000);

      await assertion;
      expect(signals).toHaveLength(2);
      expect(signals.every((signal) => signal.aborted)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses the configured AI request timeout", async () => {
    vi.useFakeTimers();
    try {
      let signal: AbortSignal | undefined;
      const fetchImpl = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
        signal = init?.signal ?? undefined;
        signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      }));
      const baseSettings = settingsFor("glossa-backend", "https://ai.example.test", "medium");
      const settings = {
        ...baseSettings,
        ai: {
          ...baseSettings.ai,
          requestTimeoutMs: 2_500
        }
      };

      const request = createAiBackend(fetchImpl as never).glossFrame(glossFrameInput(settings));
      const assertion = expect(request).rejects.toMatchObject({
        payload: { service: "ai" }
      });
      await vi.advanceTimersByTimeAsync(2_500);
      await vi.advanceTimersByTimeAsync(2_500);

      await assertion;
      expect(signal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

function settingsFor(
  provider: GlossaSettings["ai"]["provider"],
  endpoint: string,
  reasoningEffort: GlossaSettings["ai"]["reasoningEffort"]
): GlossaSettings {
  return {
    ...DEFAULT_SETTINGS,
    modelVersion: provider === "openai-completions" ? "gpt-3.5-turbo-instruct" : DEFAULT_SETTINGS.modelVersion,
    ai: {
      ...DEFAULT_SETTINGS.ai,
      provider,
      endpoint,
      apiKey: "test-key",
      reasoningEffort
    }
  };
}

function glossFrameInput(settings: GlossaSettings, tokens: TokenCandidate[] = []) {
  return {
    settings,
    items: tokens.map((token) => ({
      sentence: "Submit the form.",
      token
    }))
  };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function textResponse(value: string, status = 200): Response {
  return new Response(value, {
    status,
    headers: { "content-type": "application/json" }
  });
}
