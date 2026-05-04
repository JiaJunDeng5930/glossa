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
      if (isOpenAiProvider(input.settings.ai.provider)) {
        const output = await callOpenAiForTask(fetchImpl, input.settings, {
          task: "gloss",
          prompt: input.settings.prompts.gloss,
          targetLang: input.settings.targetLang,
          sentence: input.sentence,
          tokens: input.tokens
        });
        return parseJsonOutput<GlossBackendOutput>(output);
      }
      return postJson<GlossBackendOutput>(fetchImpl, `${trimSlash(input.settings.ai.endpoint)}/gloss`, {
        sentence: input.sentence,
        tokens: input.tokens,
        targetLang: input.settings.targetLang,
        prompt: input.settings.prompts.gloss,
        reasoningEffort: input.settings.ai.reasoningEffort,
        promptVersion: input.settings.promptVersion,
        modelVersion: input.settings.modelVersion
      });
    },
    async ankiCard(input) {
      if (isOpenAiProvider(input.settings.ai.provider)) {
        const output = await callOpenAiForTask(fetchImpl, input.settings, {
          task: "anki-card",
          prompt: input.settings.prompts.ankiCard,
          targetLang: input.settings.targetLang,
          sentence: input.sentence,
          token: input.token
        });
        return parseJsonOutput<AnkiCard>(output);
      }
      return postJson<AnkiCard>(fetchImpl, `${trimSlash(input.settings.ai.endpoint)}/anki-card`, {
        sentence: input.sentence,
        token: input.token,
        targetLang: input.settings.targetLang,
        prompt: input.settings.prompts.ankiCard,
        reasoningEffort: input.settings.ai.reasoningEffort,
        promptVersion: input.settings.promptVersion,
        modelVersion: input.settings.modelVersion
      });
    }
  };
}

async function callOpenAiForTask(fetchImpl: typeof fetch, settings: GlossaSettings, payload: unknown): Promise<string> {
  if (settings.ai.provider === "openai-chat-completions") {
    const response = await postJson<OpenAiChatCompletionResponse>(fetchImpl, settings.ai.endpoint, {
      model: settings.modelVersion,
      messages: [
        { role: "developer", content: systemInstruction() },
        { role: "user", content: JSON.stringify(payload) }
      ],
      ...reasoningBody(settings)
    }, settings.ai.apiKey);
    return response.choices[0]?.message.content ?? "";
  }
  if (settings.ai.provider === "openai-completions") {
    const response = await postJson<OpenAiCompletionResponse>(fetchImpl, settings.ai.endpoint, {
      model: settings.modelVersion,
      prompt: `${systemInstruction()}\n\n${JSON.stringify(payload)}`,
      temperature: 0
    }, settings.ai.apiKey);
    return response.choices[0]?.text ?? "";
  }
  const response = await postJson<OpenAiResponse>(fetchImpl, settings.ai.endpoint, {
    model: settings.modelVersion,
    input: [
      { role: "system", content: systemInstruction() },
      { role: "user", content: JSON.stringify(payload) }
    ],
    ...reasoningBody(settings)
  }, settings.ai.apiKey);
  return response.output_text ?? response.output?.flatMap((item) => item.content ?? []).map((part) => part.text ?? "").join("") ?? "";
}

interface OpenAiResponse {
  output_text?: string;
  output?: Array<{ content?: Array<{ text?: string }> }>;
}

interface OpenAiChatCompletionResponse {
  choices: Array<{ message: { content?: string | null } }>;
}

interface OpenAiCompletionResponse {
  choices: Array<{ text?: string }>;
}

function isOpenAiProvider(provider: GlossaSettings["ai"]["provider"]): boolean {
  return provider === "openai-responses" || provider === "openai-chat-completions" || provider === "openai-completions";
}

function reasoningBody(settings: GlossaSettings): { reasoning?: { effort: Exclude<GlossaSettings["ai"]["reasoningEffort"], "none"> } } {
  if (settings.ai.reasoningEffort === "none") {
    return {};
  }
  return { reasoning: { effort: settings.ai.reasoningEffort } };
}

function systemInstruction(): string {
  return "Return strict JSON only. For gloss return {\"items\":[{\"tokenId\":\"...\",\"targetText\":\"...\",\"display\":\"...\",\"phrase\":\"...\"}]}. For anki-card return {\"front\":\"...\",\"back\":\"...\",\"examples\":[\"...\"]}. Follow the prompt field in the user payload.";
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
