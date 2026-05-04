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
      choices: [{ text: "{\"front\":\"submit\",\"back\":\"提交\",\"examples\":[\"Submit the form.\"]}" }]
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
    expect(body.prompt).toContain("\"task\":\"anki-card\"");
    expect(body.reasoning).toBeUndefined();
    expect(result).toMatchObject({ front: "submit", back: "提交" });
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

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}
