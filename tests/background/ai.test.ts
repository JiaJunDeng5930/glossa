import { describe, expect, it, vi } from "vitest";

import { createAiBackend } from "../../src/background/ai";
import { DEFAULT_SETTINGS, type GlossaSettings } from "../../src/shared/types";

describe("AI backend adapters", () => {
  it("sends reasoning effort to the Responses API and parses output_text", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ output_text: "{\"items\":[]}" }));
    const settings = settingsFor("openai-responses", "https://api.openai.com/v1/responses", "high");

    await createAiBackend(fetchImpl as never).gloss({
      settings,
      sentence: "Submit the form.",
      tokens: []
    });

    expect(fetchImpl).toHaveBeenCalledWith("https://api.openai.com/v1/responses", expect.objectContaining({
      body: expect.stringContaining("\"reasoning\":{\"effort\":\"high\"}")
    }));
  });

  it("supports Chat Completions request and response shape", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      choices: [{ message: { content: "{\"items\":[{\"tokenId\":\"t1\",\"targetText\":\"submit\",\"display\":\"提交\"}]}" } }]
    }));
    const settings = settingsFor("openai-chat-completions", "https://api.openai.com/v1/chat/completions", "low");

    const result = await createAiBackend(fetchImpl as never).gloss({
      settings,
      sentence: "Submit the form.",
      tokens: [{ id: "t1", sentenceId: "s1", surface: "submit", lemma: "submit", startOffset: 0, endOffset: 6 }]
    });

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

  it("classifies HTTP auth failures as AI diagnostic errors", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: "bad key" }, 401));
    const settings = settingsFor("openai-responses", "https://api.openai.com/v1/responses", "high");

    await expect(createAiBackend(fetchImpl as never).gloss({
      settings,
      sentence: "Submit the form.",
      tokens: []
    })).rejects.toMatchObject({
      payload: { reason: "unauthorized", service: "ai", status: 401 }
    });
  });

  it("classifies network failures as AI diagnostic errors", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const settings = settingsFor("glossa-backend", "https://ai.example.test", "high");

    await expect(createAiBackend(fetchImpl as never).gloss({
      settings,
      sentence: "Submit the form.",
      tokens: []
    })).rejects.toMatchObject({
      payload: { reason: "network", service: "ai" }
    });
  });

  it("classifies invalid model JSON as an AI response diagnostic error", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ output_text: "not json" }));
    const settings = settingsFor("openai-responses", "https://api.openai.com/v1/responses", "high");

    await expect(createAiBackend(fetchImpl as never).gloss({
      settings,
      sentence: "Submit the form.",
      tokens: []
    })).rejects.toMatchObject({
      payload: { reason: "invalid-response", service: "ai" }
    });
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
      provider,
      endpoint,
      apiKey: "test-key",
      reasoningEffort
    }
  };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" }
  });
}
