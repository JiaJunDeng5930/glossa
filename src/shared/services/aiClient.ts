import { AI_REQUEST_POLICY } from "./requestPolicy";
import { createDiagnosticError, diagnosticErrorFrom, errorPayloadFromHttpStatus, requestDiagnosticErrorFrom } from "../errors";
import { GLOSS_TARGET_LANG, type AnkiCard, type GlossaSettings, type TokenCandidate } from "../types";

export interface GlossBackendOutput {
  items: Array<{ requestItemId: string; value: { targetText: string; display: string } }>;
}

export interface GlossFrameItem {
  requestItemId: string;
  sentence: string;
  token: Pick<TokenCandidate, "surface" | "lemma" | "startOffset" | "endOffset">;
}

export interface GlossFrameBackendInput {
  settings: GlossaSettings;
  items: GlossFrameItem[];
  signal?: AbortSignal;
}

export interface AnkiCardInput {
  settings: GlossaSettings;
  sentence: string;
  token: TokenCandidate;
}

export interface AiClient {
  glossFrame(input: GlossFrameBackendInput): Promise<GlossBackendOutput>;
  ankiCard(input: AnkiCardInput): Promise<AnkiCard>;
  probe(settings: GlossaSettings, signal?: AbortSignal): Promise<void>;
}

// Contextual AI calls send the current sentence and target token to the endpoint selected in settings.
export function createAiClient(fetchImpl: typeof fetch = fetch): AiClient {
  return {
    async probe(settings, signal) {
      if (isOpenAiProvider(settings.ai.provider)) {
        await callOpenAiForTask(fetchImpl, settings, "Reply with OK.", { task: "connection-test" }, signal);
      } else {
        await postJson(fetchImpl, `${trimSlash(settings.ai.endpoint)}/gloss`, { items: [], targetLang: GLOSS_TARGET_LANG, prompt: settings.prompts.gloss, reasoningEffort: settings.ai.reasoningEffort, promptVersion: settings.promptVersion, modelVersion: settings.modelVersion }, undefined, settings.ai.requestTimeoutMs, validateGlossBackendOutput, signal);
      }
    },
    async glossFrame(input) {
      if (isOpenAiProvider(input.settings.ai.provider)) {
        const output = await callOpenAiForTask(fetchImpl, input.settings, glossSystemInstruction(), {
          task: "gloss-frame",
          prompt: input.settings.prompts.gloss,
          targetLang: GLOSS_TARGET_LANG,
          items: input.items
        }, input.signal);
        return parseJsonOutput(output, validateGlossBackendOutput);
      }
      return postJson(fetchImpl, `${trimSlash(input.settings.ai.endpoint)}/gloss`, {
        // glossa-backend accepts the same frame shape as the serial AI outlet:
        // one request carries multiple sentence-grounded token lookups.
        items: input.items,
        targetLang: GLOSS_TARGET_LANG,
        prompt: input.settings.prompts.gloss,
        reasoningEffort: input.settings.ai.reasoningEffort,
        promptVersion: input.settings.promptVersion,
        modelVersion: input.settings.modelVersion
      }, undefined, input.settings.ai.requestTimeoutMs, validateGlossBackendOutput, input.signal);
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

async function callOpenAiForTask(fetchImpl: typeof fetch, settings: GlossaSettings, systemInstruction: string, payload: unknown, signal?: AbortSignal): Promise<string> {
  if (settings.ai.provider === "openai-chat-completions") {
    const response = await postJson(fetchImpl, settings.ai.endpoint, {
      model: settings.modelVersion,
      messages: [
        { role: "developer", content: systemInstruction },
        { role: "user", content: JSON.stringify(payload) }
      ],
      ...reasoningBody(settings)
    }, settings.ai.apiKey, settings.ai.requestTimeoutMs, validateOpenAiChatCompletionResponse, signal);
    return response.choices[0]?.message.content ?? "";
  }
  if (settings.ai.provider === "openai-completions") {
    const response = await postJson(fetchImpl, settings.ai.endpoint, {
      model: settings.modelVersion,
      prompt: `${systemInstruction}\n\n${JSON.stringify(payload)}`,
      temperature: 0
    }, settings.ai.apiKey, settings.ai.requestTimeoutMs, validateOpenAiCompletionResponse, signal);
    return response.choices[0]?.text ?? "";
  }
  const response = await postJson(fetchImpl, settings.ai.endpoint, {
    model: settings.modelVersion,
    input: [
      { role: "system", content: systemInstruction },
      { role: "user", content: JSON.stringify(payload) }
    ],
    ...reasoningBody(settings)
  }, settings.ai.apiKey, settings.ai.requestTimeoutMs, validateOpenAiResponse, signal);
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
  return "Return strict JSON only for the gloss task: {\"items\":[{\"requestItemId\":\"...\",\"value\":{\"targetText\":\"...\",\"display\":\"...\"}}]}. Follow the prompt field in the user payload.";
}

function ankiCardSystemInstruction(): string {
  return "Return strict JSON only for the anki-card task: {\"cards\":[{\"front\":\"...\",\"back\":\"...\"}]}. The cards array must contain exactly one card. Follow the prompt field in the user payload.";
}

type JsonValidator<T> = (value: unknown) => T;

function parseJsonOutput<T>(value: string, validate: JsonValidator<T>): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw invalidAiResponse("AI returned invalid JSON", error);
  }
  return validate(parsed);
}

async function postJson<T>(fetchImpl: typeof fetch, url: string, body: unknown, apiKey: string | undefined, timeoutMs: number, validate: JsonValidator<T>, signal?: AbortSignal): Promise<T> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (apiKey) {
    headers.authorization = `Bearer ${apiKey}`;
  }
  let lastError: unknown;
  for (let attempt = 0; attempt < AI_REQUEST_POLICY.maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const abortFromCaller = (): void => controller.abort();
    if (signal?.aborted) {
      controller.abort();
    } else {
      signal?.addEventListener("abort", abortFromCaller, { once: true });
    }
    const timeout = globalThis.setTimeout(() => controller.abort(), timeoutMs);
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
      let parsed: unknown;
      try {
        parsed = await response.json();
      } catch (error) {
        throw invalidAiResponse("AI returned invalid JSON", error);
      }
      return validate(parsed);
    } catch (error) {
      const diagnosticError = requestDiagnosticErrorFrom(error, { reason: "service-error", message: "AI backend request failed", service: "ai" });
      if (signal?.aborted) {
        throw diagnosticError;
      }
      if (!isRetryableAiRequestError(diagnosticError)) {
        throw diagnosticError;
      }
      lastError = diagnosticError;
    } finally {
      globalThis.clearTimeout(timeout);
      signal?.removeEventListener("abort", abortFromCaller);
    }
  }
  throw diagnosticErrorFrom(lastError, { reason: "service-error", message: "AI backend request failed", service: "ai" });
}

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
        if (!Array.isArray(item.content)) {
          throw invalidResponseShape();
        }
        return {
          content: item.content.map((part) => {
            assertRecord(part);
            if (part.text !== undefined && typeof part.text !== "string") {
              throw invalidResponseShape();
            }
            return part.text === undefined ? {} : { text: part.text };
          })
        };
      })
    };
  }
  throw invalidResponseShape();
}

function validateOpenAiChatCompletionResponse(value: unknown): OpenAiChatCompletionResponse {
  assertRecord(value);
  if (!Array.isArray(value.choices)) {
    throw invalidResponseShape();
  }
  return {
    choices: value.choices.map((choice) => {
      assertRecord(choice);
      assertRecord(choice.message);
      if (choice.message.content !== undefined && choice.message.content !== null && typeof choice.message.content !== "string") {
        throw invalidResponseShape();
      }
      return {
        message: choice.message.content === undefined ? {} : { content: choice.message.content }
      };
    })
  };
}

function validateOpenAiCompletionResponse(value: unknown): OpenAiCompletionResponse {
  assertRecord(value);
  if (!Array.isArray(value.choices)) {
    throw invalidResponseShape();
  }
  return {
    choices: value.choices.map((choice) => {
      assertRecord(choice);
      if (choice.text !== undefined && typeof choice.text !== "string") {
        throw invalidResponseShape();
      }
      return choice.text === undefined ? {} : { text: choice.text };
    })
  };
}

function validateGlossBackendOutput(value: unknown): GlossBackendOutput {
  assertRecord(value);
  if (!Array.isArray(value.items)) {
    throw invalidResponseShape();
  }
  return { items: value.items.map(validateGlossItem) };
}

function validateGlossItem(value: unknown): GlossBackendOutput["items"][number] {
  assertRecord(value);
  assertRecord(value.value);
  if (typeof value.requestItemId !== "string" || typeof value.value.targetText !== "string" || typeof value.value.display !== "string") throw invalidResponseShape();
  return { requestItemId: value.requestItemId, value: { targetText: value.value.targetText, display: value.value.display } };
}

function validateAnkiCardOutput(value: unknown): AnkiCard {
  assertRecord(value);
  if (!Array.isArray(value.cards) || value.cards.length !== 1) throw invalidResponseShape();
  return validateAnkiCard(value.cards[0]);
}

function validateAnkiCard(value: unknown): AnkiCard {
  assertRecord(value);
  if (typeof value.front !== "string" || typeof value.back !== "string") {
    throw invalidResponseShape();
  }
  return { front: value.front, back: value.back };
}

function assertRecord(value: unknown): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalidResponseShape();
  }
}

function invalidResponseShape(): Error {
  return invalidAiResponse("AI returned invalid response shape");
}

function invalidAiResponse(message: string, cause?: unknown): Error {
  if (cause === undefined) {
    return createDiagnosticError("invalid-response", message, { service: "ai" });
  }
  return createDiagnosticError("invalid-response", message, { service: "ai", cause });
}

function isRetryableAiRequestError(error: ReturnType<typeof requestDiagnosticErrorFrom>): boolean {
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
