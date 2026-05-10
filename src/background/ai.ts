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

// @intent glossa.ai_requests.backend_interface The AI backend interface is the active boundary for gloss and card generation providers.
export interface AiBackend {
  gloss(input: GlossBackendInput): Promise<GlossBackendOutput>;
  glossFrame(input: GlossFrameBackendInput): Promise<GlossBackendOutput>;
  ankiCard(input: AnkiCardInput): Promise<AnkiCardOutput>;
}

// @behavior glossa.ai_requests.glossa_backend Non-OpenAI providers send generation tasks to configured glossa-backend endpoints.
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
      // @behavior glossa.ai_requests.glossa_backend.gloss The glossa-backend gloss request posts one sentence, token list, target language, prompts, and version inputs.
      return postJson<GlossBackendOutput>(fetchImpl, `${trimSlash(input.settings.ai.endpoint)}/gloss`, {
        sentence: input.sentence,
        tokens: input.tokens,
        targetLang: GLOSS_TARGET_LANG,
        prompt: input.settings.prompts.gloss,
        reasoningEffort: input.settings.ai.reasoningEffort,
        promptVersion: input.settings.promptVersion,
        modelVersion: input.settings.modelVersion
      }, undefined, input.settings.ai.requestTimeoutMs);
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
      // @behavior glossa.ai_requests.glossa_backend.gloss_frame The glossa-backend frame request posts sentence-grounded token items and target language.
      return postJson<GlossBackendOutput>(fetchImpl, `${trimSlash(input.settings.ai.endpoint)}/gloss`, {
        // glossa-backend accepts the same frame shape as the serial AI outlet:
        // one request carries multiple sentence-grounded token lookups.
        items: input.items,
        targetLang: GLOSS_TARGET_LANG,
        prompt: input.settings.prompts.gloss,
        reasoningEffort: input.settings.ai.reasoningEffort,
        promptVersion: input.settings.promptVersion,
        modelVersion: input.settings.modelVersion
      }, undefined, input.settings.ai.requestTimeoutMs);
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
      // @behavior glossa.ai_requests.glossa_backend.anki_card The glossa-backend card request posts one sentence, clicked token, target language, prompts, and version inputs.
      return postJson<AnkiCardOutput>(fetchImpl, `${trimSlash(input.settings.ai.endpoint)}/anki-card`, {
        sentence: input.sentence,
        token: input.token,
        targetLang: GLOSS_TARGET_LANG,
        prompt: input.settings.prompts.ankiCard,
        reasoningEffort: input.settings.ai.reasoningEffort,
        promptVersion: input.settings.promptVersion,
        modelVersion: input.settings.modelVersion
      }, undefined, input.settings.ai.requestTimeoutMs);
    }
  };
}

// @behavior glossa.ai_requests.openai OpenAI providers encode generation tasks into provider-specific request formats.
async function callOpenAiForTask(fetchImpl: typeof fetch, settings: GlossaSettings, systemInstruction: string, payload: unknown): Promise<string> {
  if (settings.ai.provider === "openai-chat-completions") {
    // @behavior glossa.ai_requests.openai.chat_completions Chat Completions requests send developer and user messages and read the first message content.
    const response = await postJson<OpenAiChatCompletionResponse>(fetchImpl, settings.ai.endpoint, {
      model: settings.modelVersion,
      messages: [
        { role: "developer", content: systemInstruction },
        { role: "user", content: JSON.stringify(payload) }
      ],
      ...reasoningBody(settings)
    }, settings.ai.apiKey, settings.ai.requestTimeoutMs);
    return response.choices[0]?.message.content ?? "";
  }
  if (settings.ai.provider === "openai-completions") {
    // @behavior glossa.ai_requests.openai.legacy_completions Legacy Completions requests combine the system instruction and task payload into one prompt.
    const response = await postJson<OpenAiCompletionResponse>(fetchImpl, settings.ai.endpoint, {
      model: settings.modelVersion,
      prompt: `${systemInstruction}\n\n${JSON.stringify(payload)}`,
      temperature: 0
    }, settings.ai.apiKey, settings.ai.requestTimeoutMs);
    return response.choices[0]?.text ?? "";
  }
  // @behavior glossa.ai_requests.openai.responses Responses API requests send system and user input items and read output text.
  const response = await postJson<OpenAiResponse>(fetchImpl, settings.ai.endpoint, {
    model: settings.modelVersion,
    input: [
      { role: "system", content: systemInstruction },
      { role: "user", content: JSON.stringify(payload) }
    ],
    ...reasoningBody(settings)
  }, settings.ai.apiKey, settings.ai.requestTimeoutMs);
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

// @constraint glossa.ai_requests.reasoning_effort Non-none reasoning effort settings are sent through provider request bodies.
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

// @behavior glossa.ai_requests.failure Provider HTTP, JSON, and transport failures become AI diagnostics.
async function postJson<T>(fetchImpl: typeof fetch, url: string, body: unknown, apiKey?: string, timeoutMs = 30_000): Promise<T> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (apiKey) {
    headers.authorization = `Bearer ${apiKey}`;
  }
  let lastError: unknown;
  // @constraint glossa.ai_requests.failure.retry_limit AI JSON requests try at most two transport attempts.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const controller = new AbortController();
    // @constraint glossa.ai_requests.failure.timeout AI JSON requests abort each transport attempt after the configured request timeout, which defaults to thirty seconds.
    const timeout = globalThis.setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal
      });
      if (!response.ok) {
        // @behavior glossa.ai_requests.failure.http_status Non-OK AI HTTP responses become diagnostics with provider service and status.
        throw createDiagnosticErrorFromPayload(response.status);
      }
      try {
        return await response.json() as T;
      } catch (error) {
        // @behavior glossa.ai_requests.failure.invalid_json Malformed AI JSON responses become invalid-response diagnostics for AI.
        throw createDiagnosticError("invalid-response", "AI returned invalid JSON", { service: "ai", cause: error });
      }
    } catch (error) {
      // @behavior glossa.ai_requests.failure.request_error AI request failures pass through the shared request error mapper before retry exhaustion.
      lastError = requestDiagnosticErrorFrom(error, { reason: "service-error", message: "AI backend request failed", service: "ai" });
    } finally {
      // @constraint glossa.ai_requests.failure.timeout_cleanup AI JSON requests clear each attempt timeout after success or failure.
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
