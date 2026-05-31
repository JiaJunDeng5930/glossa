// @behavior glossa.ai_requests Gloss and card generation requests use the configured AI provider and expose provider failures as diagnostics.
import { createDiagnosticError, diagnosticErrorFrom, errorPayloadFromHttpStatus, requestDiagnosticErrorFrom } from "../shared/errors";
import { GLOSS_TARGET_LANG, type AnkiCard, type AnkiCardOutput, type GlossaSettings, type GlossItem, type TokenCandidate } from "../shared/types";

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
        return parseJsonOutput(output, validateGlossBackendOutput);
      }
      // @behavior glossa.ai_requests.glossa_backend.gloss The glossa-backend gloss request posts one sentence, token list, target language, prompts, and version inputs.
      return postJson(fetchImpl, `${trimSlash(input.settings.ai.endpoint)}/gloss`, {
        sentence: input.sentence,
        tokens: input.tokens,
        targetLang: GLOSS_TARGET_LANG,
        prompt: input.settings.prompts.gloss,
        reasoningEffort: input.settings.ai.reasoningEffort,
        promptVersion: input.settings.promptVersion,
        modelVersion: input.settings.modelVersion
      }, undefined, input.settings.ai.requestTimeoutMs, validateGlossBackendOutput);
    },
    async glossFrame(input) {
      if (isOpenAiProvider(input.settings.ai.provider)) {
        const output = await callOpenAiForTask(fetchImpl, input.settings, glossSystemInstruction(), {
          task: "gloss-frame",
          prompt: input.settings.prompts.gloss,
          targetLang: GLOSS_TARGET_LANG,
          items: input.items
        });
        return parseJsonOutput(output, validateGlossBackendOutput);
      }
      // @behavior glossa.ai_requests.glossa_backend.gloss_frame The glossa-backend frame request posts sentence-grounded token items and target language.
      return postJson(fetchImpl, `${trimSlash(input.settings.ai.endpoint)}/gloss`, {
        // glossa-backend accepts the same frame shape as the serial AI outlet:
        // one request carries multiple sentence-grounded token lookups.
        items: input.items,
        targetLang: GLOSS_TARGET_LANG,
        prompt: input.settings.prompts.gloss,
        reasoningEffort: input.settings.ai.reasoningEffort,
        promptVersion: input.settings.promptVersion,
        modelVersion: input.settings.modelVersion
      }, undefined, input.settings.ai.requestTimeoutMs, validateGlossBackendOutput);
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
        return parseJsonOutput(output, validateAnkiCardOutput);
      }
      // @behavior glossa.ai_requests.glossa_backend.anki_card The glossa-backend card request posts one sentence, clicked token, target language, prompts, and version inputs.
      return postJson(fetchImpl, `${trimSlash(input.settings.ai.endpoint)}/anki-card`, {
        sentence: input.sentence,
        token: input.token,
        targetLang: GLOSS_TARGET_LANG,
        prompt: input.settings.prompts.ankiCard,
        reasoningEffort: input.settings.ai.reasoningEffort,
        promptVersion: input.settings.promptVersion,
        modelVersion: input.settings.modelVersion
      }, undefined, input.settings.ai.requestTimeoutMs, validateAnkiCardOutput);
    }
  };
}

// @behavior glossa.ai_requests.openai OpenAI providers encode generation tasks into provider-specific request formats.
async function callOpenAiForTask(fetchImpl: typeof fetch, settings: GlossaSettings, systemInstruction: string, payload: unknown): Promise<string> {
  if (settings.ai.provider === "openai-chat-completions") {
    // @behavior glossa.ai_requests.openai.chat_completions Chat Completions requests send developer and user messages and read the first message content.
    const response = await postJson(fetchImpl, settings.ai.endpoint, {
      model: settings.modelVersion,
      messages: [
        { role: "developer", content: systemInstruction },
        { role: "user", content: JSON.stringify(payload) }
      ],
      ...reasoningBody(settings)
    }, settings.ai.apiKey, settings.ai.requestTimeoutMs, validateOpenAiChatCompletionResponse);
    return response.choices[0]?.message.content ?? "";
  }
  if (settings.ai.provider === "openai-completions") {
    // @behavior glossa.ai_requests.openai.legacy_completions Legacy Completions requests combine the system instruction and task payload into one prompt.
    const response = await postJson(fetchImpl, settings.ai.endpoint, {
      model: settings.modelVersion,
      prompt: `${systemInstruction}\n\n${JSON.stringify(payload)}`,
      temperature: 0
    }, settings.ai.apiKey, settings.ai.requestTimeoutMs, validateOpenAiCompletionResponse);
    return response.choices[0]?.text ?? "";
  }
  // @behavior glossa.ai_requests.openai.responses Responses API requests send system and user input items and read output text.
  const response = await postJson(fetchImpl, settings.ai.endpoint, {
    model: settings.modelVersion,
    input: [
      { role: "system", content: systemInstruction },
      { role: "user", content: JSON.stringify(payload) }
    ],
    ...reasoningBody(settings)
  }, settings.ai.apiKey, settings.ai.requestTimeoutMs, validateOpenAiResponse);
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

type JsonValidator<T> = (value: unknown) => T;

// @behavior glossa.ai_requests.failure.invalid_json.model_output Model text output is parsed before shape validation, and malformed JSON becomes an invalid AI response.
function parseJsonOutput<T>(value: string, validate: JsonValidator<T>): T {
  // @behavior glossa.ai_requests.failure.invalid_json.model_output.parsed_value Model JSON parsing keeps the parsed value unknown until validation succeeds.
  let parsed: unknown;
  // @behavior glossa.ai_requests.failure.invalid_json.model_output.parse_failure Model JSON parse failures become invalid AI response diagnostics.
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw invalidAiResponse("AI returned invalid JSON", error);
  }
  return validate(parsed);
}

// @behavior glossa.ai_requests.failure Provider HTTP, JSON, and transport failures become AI diagnostics.
// @constraint glossa.ai_requests.backend_interface.json_helper The AI JSON helper accepts an optional API key, timeout, and response validator for provider-specific calls.
async function postJson<T>(fetchImpl: typeof fetch, url: string, body: unknown, apiKey?: string, timeoutMs = 30_000, validate?: JsonValidator<T>): Promise<T> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (apiKey) {
    headers.authorization = `Bearer ${apiKey}`;
  }
  let lastError: unknown;
  // @constraint glossa.ai_requests.failure.retry_limit AI JSON requests retry recoverable transport failures for at most two total attempts.
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
      let parsed: unknown;
      try {
        parsed = await response.json();
      } catch (error) {
        throw invalidAiResponse("AI returned invalid JSON", error);
      }
      return validate ? validate(parsed) : parsed as T;
    } catch (error) {
      const diagnosticError = requestDiagnosticErrorFrom(error, { reason: "service-error", message: "AI backend request failed", service: "ai" });
      if (!isRetryableAiRequestError(diagnosticError)) {
        throw diagnosticError;
      }
      // @behavior glossa.ai_requests.failure.request_error AI request failures pass through the shared request error mapper before retry exhaustion.
      lastError = diagnosticError;
    } finally {
      // @constraint glossa.ai_requests.failure.timeout_cleanup AI JSON requests clear each attempt timeout after success or failure.
      globalThis.clearTimeout(timeout);
    }
  }
  throw diagnosticErrorFrom(lastError, { reason: "service-error", message: "AI backend request failed", service: "ai" });
}

// @constraint glossa.ai_requests.openai.responses.validation Responses API responses must provide output_text or output content parts with string text values.
function validateOpenAiResponse(value: unknown): OpenAiResponse {
  assertRecord(value);
  const outputText = value.output_text;
  const output = value.output;
  if (typeof outputText === "string") {
    return { output_text: outputText };
  }
  if (Array.isArray(output)) {
    return {
      output: output.map((item) => {
        assertRecord(item);
        if (item.content === undefined) {
          return {};
        }
        // @constraint glossa.ai_requests.openai.responses.validation.content_array Responses API output content must be an array when it is present.
        if (!Array.isArray(item.content)) {
          throw invalidResponseShape();
        }
        return {
          content: item.content.map((part) => {
            assertRecord(part);
            // @constraint glossa.ai_requests.openai.responses.validation.text_part Responses API output text parts must be text when present.
            if (part.text !== undefined && typeof part.text !== "string") {
              throw invalidResponseShape();
            }
            return part.text === undefined ? {} : { text: part.text };
          })
        };
      })
    };
  }
  // @constraint glossa.ai_requests.openai.responses.validation.required_output Responses API responses must provide either output_text or output.
  throw invalidResponseShape();
}

// @constraint glossa.ai_requests.openai.chat_completions.validation Chat Completions responses must provide a choices array with message content that is absent, null, or text.
function validateOpenAiChatCompletionResponse(value: unknown): OpenAiChatCompletionResponse {
  assertRecord(value);
  // @constraint glossa.ai_requests.openai.chat_completions.validation.choices Chat Completions responses must expose choices as an array.
  if (!Array.isArray(value.choices)) {
    throw invalidResponseShape();
  }
  return {
    choices: value.choices.map((choice) => {
      assertRecord(choice);
      assertRecord(choice.message);
      // @constraint glossa.ai_requests.openai.chat_completions.validation.content Chat Completions message content must be absent, null, or text.
      if (choice.message.content !== undefined && choice.message.content !== null && typeof choice.message.content !== "string") {
        throw invalidResponseShape();
      }
      return {
        message: choice.message.content === undefined ? {} : { content: choice.message.content }
      };
    })
  };
}

// @constraint glossa.ai_requests.openai.legacy_completions.validation Legacy Completions responses must provide a choices array with optional text fields.
function validateOpenAiCompletionResponse(value: unknown): OpenAiCompletionResponse {
  assertRecord(value);
  // @constraint glossa.ai_requests.openai.legacy_completions.validation.choices Legacy Completions responses must expose choices as an array.
  if (!Array.isArray(value.choices)) {
    throw invalidResponseShape();
  }
  return {
    choices: value.choices.map((choice) => {
      assertRecord(choice);
      // @constraint glossa.ai_requests.openai.legacy_completions.validation.text Legacy Completions choice text must be text when present.
      if (choice.text !== undefined && typeof choice.text !== "string") {
        throw invalidResponseShape();
      }
      return choice.text === undefined ? {} : { text: choice.text };
    })
  };
}

// @constraint glossa.ai_requests.glossa_backend.gloss.validation Gloss backend responses must expose an items array before gloss items are accepted.
function validateGlossBackendOutput(value: unknown): GlossBackendOutput {
  assertRecord(value);
  // @constraint glossa.ai_requests.glossa_backend.gloss.validation.items Gloss backend responses must expose items as an array.
  if (!Array.isArray(value.items)) {
    throw invalidResponseShape();
  }
  return { items: value.items.map(validateGlossItem) };
}

// @constraint glossa.ai_requests.glossa_backend.gloss.item_validation Gloss items must carry token id, target text, display text, and optional phrase text.
function validateGlossItem(value: unknown): GlossItem {
  assertRecord(value);
  // @constraint glossa.ai_requests.glossa_backend.gloss.item_validation.fields Gloss item fields must preserve string token id, target text, display text, and optional phrase.
  if (
    typeof value.tokenId !== "string"
    || typeof value.targetText !== "string"
    || typeof value.display !== "string"
    || (value.phrase !== undefined && typeof value.phrase !== "string")
  ) {
    throw invalidResponseShape();
  }
  return {
    tokenId: value.tokenId,
    targetText: value.targetText,
    display: value.display,
    ...(value.phrase === undefined ? {} : { phrase: value.phrase })
  };
}

// @constraint glossa.ai_requests.glossa_backend.anki_card.validation Anki-card backend responses must expose a cards array before card items are accepted.
function validateAnkiCardOutput(value: unknown): AnkiCardOutput {
  assertRecord(value);
  // @constraint glossa.ai_requests.glossa_backend.anki_card.validation.cards Anki-card backend responses must expose cards as an array.
  if (!Array.isArray(value.cards)) {
    throw invalidResponseShape();
  }
  return { cards: value.cards.map(validateAnkiCard) };
}

// @constraint glossa.ai_requests.glossa_backend.anki_card.item_validation Anki-card items must carry text front and back fields.
function validateAnkiCard(value: unknown): AnkiCard {
  assertRecord(value);
  // @constraint glossa.ai_requests.glossa_backend.anki_card.item_validation.fields Anki-card front and back fields must be text.
  if (typeof value.front !== "string" || typeof value.back !== "string") {
    throw invalidResponseShape();
  }
  return { front: value.front, back: value.back };
}

// @constraint glossa.ai_requests.failure.invalid_json.record_shape Validated AI response objects must be non-null records.
function assertRecord(value: unknown): asserts value is Record<string, unknown> {
  // @constraint glossa.ai_requests.failure.invalid_json.record_shape.object AI response validation rejects nulls, primitives, and arrays where records are required.
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalidResponseShape();
  }
}

// @behavior glossa.ai_requests.failure.invalid_json.shape_failure AI response shape failures are normalized before diagnostic creation.
function invalidResponseShape(): Error {
  // @behavior glossa.ai_requests.failure.invalid_json.shape_message AI response shape failures use the shared invalid-response diagnostic message.
  return invalidAiResponse("AI returned invalid response shape");
}

// @behavior glossa.ai_requests.failure.invalid_json Malformed AI JSON and validated response shape failures become invalid-response diagnostics for AI.
function invalidAiResponse(message: string, cause?: unknown): Error {
  if (cause === undefined) {
    // @behavior glossa.ai_requests.failure.invalid_json.no_cause Invalid AI response diagnostics omit a cause when validation detects only a shape mismatch.
    return createDiagnosticError("invalid-response", message, { service: "ai" });
  }
  // @behavior glossa.ai_requests.failure.invalid_json.with_cause Invalid AI response diagnostics preserve parse causes for malformed JSON payloads.
  return createDiagnosticError("invalid-response", message, { service: "ai", cause });
}

// @constraint glossa.ai_requests.failure.retry_limit.retryable Only network and timeout AI diagnostics are retried by the AI request helper.
function isRetryableAiRequestError(error: ReturnType<typeof requestDiagnosticErrorFrom>): boolean {
  // @constraint glossa.ai_requests.failure.retry_limit.retryable_reasons Retryable AI request diagnostics are limited to network and timeout reasons.
  return error.payload.reason === "network" || error.payload.reason === "timeout";
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
