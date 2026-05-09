// @behavior glossa.ai_requests Gloss and card generation requests use the configured AI provider and expose provider failures as diagnostics.
import { createDiagnosticError, diagnosticErrorFrom, errorPayloadFromHttpStatus, requestDiagnosticErrorFrom } from "../shared/errors";
import { GLOSS_TARGET_LANG, type AnkiCardOutput, type GlossaSettings, type GlossItem, type TokenCandidate } from "../shared/types";

export interface GlossBackendInput {
  settings: GlossaSettings;
  sentence: string;
  tokens: TokenCandidate[];
}

export interface GlossBackendOutput {
  items: GlossItem[];
}

export interface GlossFrameItem {
  sentence: string;
  token: TokenCandidate;
}

export interface GlossFrameBackendInput {
  settings: GlossaSettings;
  items: GlossFrameItem[];
}

export interface AnkiCardInput {
  settings: GlossaSettings;
  sentence: string;
  token: TokenCandidate;
}

export interface AiBackend {
  gloss(input: GlossBackendInput): Promise<GlossBackendOutput>;
  glossFrame(input: GlossFrameBackendInput): Promise<GlossBackendOutput>;
  ankiCard(input: AnkiCardInput): Promise<AnkiCardOutput>;
}

export function createAiBackend(fetchImpl: typeof fetch = fetch): AiBackend {
  return {
    async gloss(input) {
      if (isOpenAiProvider(input.settings.ai.provider)) {
        const output = await callOpenAiForTask(fetchImpl, input.settings, glossSystemInstruction(), {
          task: "gloss",
          prompt: input.settings.prompts.gloss,
          targetLang: GLOSS_TARGET_LANG,
          sentence: input.sentence,
          tokens: input.tokens
        });
        return parseJsonOutput<GlossBackendOutput>(output);
      }
      return postJson<GlossBackendOutput>(fetchImpl, `${trimSlash(input.settings.ai.endpoint)}/gloss`, {
        sentence: input.sentence,
        tokens: input.tokens,
        targetLang: GLOSS_TARGET_LANG,
        prompt: input.settings.prompts.gloss,
        reasoningEffort: input.settings.ai.reasoningEffort,
        promptVersion: input.settings.promptVersion,
        modelVersion: input.settings.modelVersion
      });
    },
    async glossFrame(input) {
      if (isOpenAiProvider(input.settings.ai.provider)) {
        const output = await callOpenAiForTask(fetchImpl, input.settings, glossSystemInstruction(), {
          task: "gloss-frame",
          prompt: input.settings.prompts.gloss,
          targetLang: GLOSS_TARGET_LANG,
          items: input.items
        });
        return parseJsonOutput<GlossBackendOutput>(output);
      }
      return postJson<GlossBackendOutput>(fetchImpl, `${trimSlash(input.settings.ai.endpoint)}/gloss`, {
        // glossa-backend accepts the same frame shape as the serial AI outlet:
        // one request carries multiple sentence-grounded token lookups.
        items: input.items,
        targetLang: GLOSS_TARGET_LANG,
        prompt: input.settings.prompts.gloss,
        reasoningEffort: input.settings.ai.reasoningEffort,
        promptVersion: input.settings.promptVersion,
        modelVersion: input.settings.modelVersion
      });
    },
    async ankiCard(input) {
      if (isOpenAiProvider(input.settings.ai.provider)) {
        const output = await callOpenAiForTask(fetchImpl, input.settings, ankiCardSystemInstruction(), {
          task: "anki-card",
          prompt: input.settings.prompts.ankiCard,
          targetLang: GLOSS_TARGET_LANG,
          sentence: input.sentence,
          token: input.token
        });
        return parseJsonOutput<AnkiCardOutput>(output);
      }
      return postJson<AnkiCardOutput>(fetchImpl, `${trimSlash(input.settings.ai.endpoint)}/anki-card`, {
        sentence: input.sentence,
        token: input.token,
        targetLang: GLOSS_TARGET_LANG,
        prompt: input.settings.prompts.ankiCard,
        reasoningEffort: input.settings.ai.reasoningEffort,
        promptVersion: input.settings.promptVersion,
        modelVersion: input.settings.modelVersion
      });
    }
  };
}

async function callOpenAiForTask(fetchImpl: typeof fetch, settings: GlossaSettings, systemInstruction: string, payload: unknown): Promise<string> {
  if (settings.ai.provider === "openai-chat-completions") {
    const response = await postJson<OpenAiChatCompletionResponse>(fetchImpl, settings.ai.endpoint, {
      model: settings.modelVersion,
      messages: [
        { role: "developer", content: systemInstruction },
        { role: "user", content: JSON.stringify(payload) }
      ],
      ...reasoningBody(settings)
    }, settings.ai.apiKey);
    return response.choices[0]?.message.content ?? "";
  }
  if (settings.ai.provider === "openai-completions") {
    const response = await postJson<OpenAiCompletionResponse>(fetchImpl, settings.ai.endpoint, {
      model: settings.modelVersion,
      prompt: `${systemInstruction}\n\n${JSON.stringify(payload)}`,
      temperature: 0
    }, settings.ai.apiKey);
    return response.choices[0]?.text ?? "";
  }
  const response = await postJson<OpenAiResponse>(fetchImpl, settings.ai.endpoint, {
    model: settings.modelVersion,
    input: [
      { role: "system", content: systemInstruction },
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

function glossSystemInstruction(): string {
  return "Return strict JSON only for the gloss task: {\"items\":[{\"tokenId\":\"...\",\"targetText\":\"...\",\"display\":\"...\",\"phrase\":\"...\"}]}. Follow the prompt field in the user payload.";
}

function ankiCardSystemInstruction(): string {
  return "Return strict JSON only for the anki-card task: {\"cards\":[{\"front\":\"...\",\"back\":\"...\"}]}. The cards array may contain multiple cards. When the user prompt does not request a card count, create one card. Follow the prompt field in the user payload.";
}

function parseJsonOutput<T>(value: string): T {
  try {
    return JSON.parse(value) as T;
  } catch (error) {
    throw createDiagnosticError("invalid-response", "AI returned invalid JSON", { service: "ai", cause: error });
  }
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
        throw createDiagnosticErrorFromPayload(response.status);
      }
      try {
        return await response.json() as T;
      } catch (error) {
        throw createDiagnosticError("invalid-response", "AI returned invalid JSON", { service: "ai", cause: error });
      }
    } catch (error) {
      lastError = requestDiagnosticErrorFrom(error, { reason: "service-error", message: "AI backend request failed", service: "ai" });
    } finally {
      globalThis.clearTimeout(timeout);
    }
  }
  throw diagnosticErrorFrom(lastError, { reason: "service-error", message: "AI backend request failed", service: "ai" });
}

function createDiagnosticErrorFromPayload(status: number): Error {
  return createDiagnosticError(
    errorPayloadFromHttpStatus("ai", status).reason,
    `AI HTTP ${status}`,
    { service: "ai", status }
  );
}

function trimSlash(value: string): string {
  return value.replace(/\/+$/, "");
}
