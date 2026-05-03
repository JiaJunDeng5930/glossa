import type { AnkiCard, GlossaSettings, GlossItem, TokenCandidate } from "../shared/types";

export interface GlossBackendInput {
  settings: GlossaSettings;
  sentence: string;
  tokens: TokenCandidate[];
}

export interface GlossBackendOutput {
  items: GlossItem[];
}

export interface AnkiCardInput {
  settings: GlossaSettings;
  sentence: string;
  token: TokenCandidate;
}

export interface AiBackend {
  gloss(input: GlossBackendInput): Promise<GlossBackendOutput>;
  ankiCard(input: AnkiCardInput): Promise<AnkiCard>;
}

export function createAiBackend(fetchImpl: typeof fetch = fetch): AiBackend {
  return {
    async gloss(input) {
      if (input.settings.ai.provider === "openai-responses") {
        return callOpenAiResponsesForGloss(fetchImpl, input);
      }
      return postJson<GlossBackendOutput>(fetchImpl, `${trimSlash(input.settings.ai.endpoint)}/gloss`, {
        sentence: input.sentence,
        tokens: input.tokens,
        targetLang: input.settings.targetLang,
        promptVersion: input.settings.promptVersion,
        modelVersion: input.settings.modelVersion
      });
    },
    async ankiCard(input) {
      if (input.settings.ai.provider === "openai-responses") {
        return callOpenAiResponsesForCard(fetchImpl, input);
      }
      return postJson<AnkiCard>(fetchImpl, `${trimSlash(input.settings.ai.endpoint)}/anki-card`, {
        sentence: input.sentence,
        token: input.token,
        targetLang: input.settings.targetLang,
        promptVersion: input.settings.promptVersion,
        modelVersion: input.settings.modelVersion
      });
    }
  };
}

async function callOpenAiResponsesForGloss(fetchImpl: typeof fetch, input: GlossBackendInput): Promise<GlossBackendOutput> {
  const output = await callOpenAiResponses(fetchImpl, input.settings, {
    task: "gloss",
    targetLang: input.settings.targetLang,
    sentence: input.sentence,
    tokens: input.tokens
  });
  return parseJsonOutput<GlossBackendOutput>(output);
}

async function callOpenAiResponsesForCard(fetchImpl: typeof fetch, input: AnkiCardInput): Promise<AnkiCard> {
  const output = await callOpenAiResponses(fetchImpl, input.settings, {
    task: "anki-card",
    targetLang: input.settings.targetLang,
    sentence: input.sentence,
    token: input.token
  });
  return parseJsonOutput<AnkiCard>(output);
}

async function callOpenAiResponses(fetchImpl: typeof fetch, settings: GlossaSettings, payload: unknown): Promise<string> {
  const response = await postJson<OpenAiResponse>(fetchImpl, settings.ai.endpoint, {
    model: settings.modelVersion,
    input: [
      {
        role: "system",
        content: "Return strict JSON only. For gloss return {\"items\":[{\"tokenId\":\"...\",\"targetText\":\"...\",\"display\":\"...\",\"phrase\":\"...\"}]}. For anki-card return {\"front\":\"...\",\"back\":\"...\",\"examples\":[\"...\"]}."
      },
      {
        role: "user",
        content: JSON.stringify(payload)
      }
    ]
  }, settings.ai.apiKey);
  return response.output_text ?? response.output?.flatMap((item) => item.content ?? []).map((part) => part.text ?? "").join("") ?? "";
}

interface OpenAiResponse {
  output_text?: string;
  output?: Array<{ content?: Array<{ text?: string }> }>;
}

function parseJsonOutput<T>(value: string): T {
  return JSON.parse(value) as T;
}

async function postJson<T>(fetchImpl: typeof fetch, url: string, body: unknown, apiKey?: string): Promise<T> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (apiKey) {
    headers.authorization = `Bearer ${apiKey}`;
  }
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const controller = new AbortController();
    const timeout = globalThis.setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await fetchImpl(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      return await response.json() as T;
    } catch (error) {
      lastError = error;
    } finally {
      globalThis.clearTimeout(timeout);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("AI backend request failed");
}

function trimSlash(value: string): string {
  return value.replace(/\/+$/, "");
}
