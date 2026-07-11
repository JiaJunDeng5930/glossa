import { afterEach, describe, expect, it, vi } from "vitest";

import { testAiSettings } from "../../src/shared/settingsForm";
import { DEFAULT_SETTINGS, type GlossaSettings } from "../../src/shared/types";

describe("AI settings connection test", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps the OpenAI API key out of Glossa backend requests", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ items: [] }), {
      status: 200,
      headers: { "content-type": "application/json" }
    }));
    vi.stubGlobal("fetch", fetchMock);
    const settings: GlossaSettings = {
      ...DEFAULT_SETTINGS,
      ai: {
        ...DEFAULT_SETTINGS.ai,
        provider: "glossa-backend",
        endpoint: "https://backend.test",
        apiKey: "sk-private"
      }
    };

    await testAiSettings(settings);

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.headers).toEqual({ "content-type": "application/json" });
  });

  it("sends the API key to OpenAI providers", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ items: [] }), {
      status: 200,
      headers: { "content-type": "application/json" }
    }));
    vi.stubGlobal("fetch", fetchMock);
    const settings: GlossaSettings = {
      ...DEFAULT_SETTINGS,
      ai: {
        ...DEFAULT_SETTINGS.ai,
        provider: "openai-responses",
        endpoint: "https://api.openai.test/v1/responses",
        apiKey: "sk-private"
      }
    };

    await testAiSettings(settings);

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.headers).toEqual({
      "content-type": "application/json",
      authorization: "Bearer sk-private"
    });
  });
});
