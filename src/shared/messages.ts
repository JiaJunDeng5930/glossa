// @constraint glossa.extension_contracts.message_envelopes Runtime requests, responses, and gloss-port traffic use versioned envelopes and nested payload structure checks before payloads are accepted.
import type {
  AiProvider,
  BackgroundResponseMessage,
  ContentToBackgroundMessage,
  ErrorPayload,
  GlossaSettings,
  GlossCacheClearPayload,
  GlossCacheClearedPayload,
  GlossChunkAckPayload,
  GlossDonePayload,
  GlossItem,
  GlossScanChunkPayload,
  GlossScanEndPayload,
  GlossPortInboundMessage,
  GlossPortOutboundMessage,
  GlossPortErrorPayload,
  GlossScanPayload,
  GlossScanStartPayload,
  GlossTokenPayload,
  GlossTokenStatus,
  KnownWordListId,
  MessageEnvelope,
  MessageSource,
  OptionsToBackgroundMessage,
  ReasoningEffort,
  RuntimeToBackgroundMessage,
  SentenceCandidate,
  SettingsGetPayload,
  SettingsGetResponsePayload,
  TokenCandidate,
  UserWordClickPayload,
  WordCardDuplicatePayload,
  WordClickedOkPayload
} from "./types";
import { isErrorPayload } from "./errors";

export const MESSAGE_VERSION = 1;

type ContentPayloadByType = {
  "settings.get": SettingsGetPayload;
  "word.clicked": UserWordClickPayload;
};

type OptionsPayloadByType = {
  "gloss.cache.clear": GlossCacheClearPayload;
};

type BackgroundPayloadByType = {
  "settings.response": SettingsGetResponsePayload;
  "word.clicked.ok": WordClickedOkPayload;
  "word.card.duplicate": WordCardDuplicatePayload;
  "gloss.cache.cleared": GlossCacheClearedPayload;
  error: ErrorPayload;
};

type GlossPortPayloadByType = {
  "gloss.scan": GlossScanPayload;
  "gloss.scan.start": GlossScanStartPayload;
  "gloss.scan.chunk": GlossScanChunkPayload;
  "gloss.scan.end": GlossScanEndPayload;
  "gloss.chunk.ack": GlossChunkAckPayload;
  "gloss.token": GlossTokenPayload;
  "gloss.done": GlossDonePayload;
  "gloss.error": GlossPortErrorPayload;
};

export function createContentMessage<TType extends keyof ContentPayloadByType>(
  type: TType,
  payload: ContentPayloadByType[TType]
): Extract<ContentToBackgroundMessage, { type: TType }> {
  return createEnvelope(type, "content-script", "service-worker", payload) as unknown as Extract<ContentToBackgroundMessage, { type: TType }>;
}

export function createOptionsMessage<TType extends keyof OptionsPayloadByType>(
  type: TType,
  payload: OptionsPayloadByType[TType]
): Extract<OptionsToBackgroundMessage, { type: TType }> {
  return createEnvelope(type, "options", "service-worker", payload) as unknown as Extract<OptionsToBackgroundMessage, { type: TType }>;
}

export function createBackgroundResponse<TType extends keyof BackgroundPayloadByType>(
  request: Pick<RuntimeToBackgroundMessage, "requestId" | "source">,
  type: TType,
  payload: BackgroundPayloadByType[TType]
): Extract<BackgroundResponseMessage, { type: TType }> {
  return {
    type,
    version: MESSAGE_VERSION,
    requestId: request.requestId,
    source: "service-worker",
    target: request.source,
    createdAt: Date.now(),
    payload
  } as Extract<BackgroundResponseMessage, { type: TType }>;
}

export function validateRuntimeMessage(value: unknown): RuntimeToBackgroundMessage {
  const envelope = validateEnvelope(value);
  if (envelope.source === "content-script") {
    return validateContentMessage(envelope);
  }
  if (envelope.source === "options") {
    return validateOptionsMessage(envelope);
  }
  throw new Error("Unexpected message route");
}

export function createGlossPortMessage<TType extends keyof GlossPortPayloadByType>(
  type: TType,
  payload: GlossPortPayloadByType[TType]
): Extract<GlossPortInboundMessage | GlossPortOutboundMessage, { type: TType }> {
  return {
    type,
    version: MESSAGE_VERSION,
    createdAt: Date.now(),
    payload
  } as Extract<GlossPortInboundMessage | GlossPortOutboundMessage, { type: TType }>;
}

export function validateContentMessage(value: unknown): ContentToBackgroundMessage {
  const envelope = validateEnvelope(value);
  if (envelope.version !== MESSAGE_VERSION) {
    throw new Error("Unsupported message version");
  }
  if (envelope.source !== "content-script" || envelope.target !== "service-worker") {
    throw new Error("Unexpected message route");
  }
  if (envelope.type === "settings.get") {
    // @constraint glossa.extension_contracts.message_envelopes.content_payloads Content settings requests must carry an empty payload.
    if (!isEmptyPayload(envelope.payload)) {
      throw new Error("Malformed settings.get payload");
    }
    return envelope as ContentToBackgroundMessage;
  }
  if (envelope.type === "word.clicked") {
    // @constraint glossa.extension_contracts.message_envelopes.word_click_payloads Word-click requests must carry page, sentence, token, and optional duplicate approval fields.
    if (!isUserWordClickPayload(envelope.payload)) {
      throw new Error("Malformed word.clicked payload");
    }
    return envelope as ContentToBackgroundMessage;
  }
  throw new Error("Unknown message type");
}

export function validateOptionsMessage(value: unknown): OptionsToBackgroundMessage {
  const envelope = validateEnvelope(value);
  if (envelope.version !== MESSAGE_VERSION) {
    throw new Error("Unsupported message version");
  }
  if (envelope.source !== "options" || envelope.target !== "service-worker") {
    throw new Error("Unexpected message route");
  }
  if (envelope.type === "gloss.cache.clear") {
    // @constraint glossa.extension_contracts.message_envelopes.options_payloads Options cache-clear requests must carry an empty payload.
    if (!isEmptyPayload(envelope.payload)) {
      throw new Error("Malformed gloss.cache.clear payload");
    }
    return envelope as OptionsToBackgroundMessage;
  }
  throw new Error("Unknown message type");
}

export function validateBackgroundResponse(value: unknown, request: RuntimeToBackgroundMessage): BackgroundResponseMessage {
  const envelope = validateEnvelope(value);
  if (envelope.version !== MESSAGE_VERSION) {
    throw new Error("Unsupported response version");
  }
  if (envelope.requestId !== request.requestId) {
    throw new Error("Response requestId mismatch");
  }
  // @constraint glossa.extension_contracts.message_envelopes.background_route Background responses must come from the service worker and target the original requester.
  if (envelope.source !== "service-worker" || envelope.target !== request.source) {
    throw new Error("Unexpected response route");
  }
  // @constraint glossa.extension_contracts.message_envelopes.background_response_types Background responses accept only settings, word-click, duplicate-card, cache-clear, and error envelope types.
  if (
    envelope.type !== "settings.response"
    && envelope.type !== "word.clicked.ok"
    && envelope.type !== "word.card.duplicate"
    && envelope.type !== "gloss.cache.cleared"
    && envelope.type !== "error"
  ) {
    throw new Error("Unknown response type");
  }
  if (envelope.type === "settings.response") {
    // @constraint glossa.extension_contracts.message_envelopes.settings_response_payload Settings responses must contain a fully typed settings object.
    if (!isSettingsGetResponsePayload(envelope.payload)) {
      throw new Error("Malformed settings.response payload");
    }
    return envelope as BackgroundResponseMessage;
  }
  if (envelope.type === "word.clicked.ok") {
    // @constraint glossa.extension_contracts.message_envelopes.word_clicked_ok_payload Word-click success responses may contain numeric note ids only.
    if (!isWordClickedOkPayload(envelope.payload)) {
      throw new Error("Malformed word.clicked.ok payload");
    }
    return envelope as BackgroundResponseMessage;
  }
  if (envelope.type === "word.card.duplicate") {
    // @constraint glossa.extension_contracts.message_envelopes.duplicate_payload Duplicate-card responses must contain language, lemma, surface, and prompt duration fields.
    if (!isWordCardDuplicatePayload(envelope.payload)) {
      throw new Error("Malformed word.card.duplicate payload");
    }
    return envelope as BackgroundResponseMessage;
  }
  if (envelope.type === "gloss.cache.cleared") {
    // @constraint glossa.extension_contracts.message_envelopes.cache_cleared_payload Cache-clear responses must carry an empty payload.
    if (!isEmptyPayload(envelope.payload)) {
      throw new Error("Malformed gloss.cache.cleared payload");
    }
    return envelope as BackgroundResponseMessage;
  }
  if (envelope.type === "error") {
    // @constraint glossa.extension_contracts.message_envelopes.error_payload Error responses must carry a structured error payload.
    if (!isErrorPayload(envelope.payload)) {
      throw new Error("Malformed error payload");
    }
    return envelope as BackgroundResponseMessage;
  }
  return envelope as BackgroundResponseMessage;
}

export function validateGlossPortInbound(value: unknown): GlossPortInboundMessage {
  const message = validateGlossPortEnvelope(value);
  if (message.type === "gloss.scan") {
    if (!isGlossScanPayload(message.payload)) {
      throw new Error("Malformed gloss.scan payload");
    }
    return message as GlossPortInboundMessage;
  }
  // @constraint glossa.extension_contracts.message_envelopes.gloss_scan_start Gloss scan start messages must identify the scan and page before background lookup accepts them.
  if (message.type === "gloss.scan.start") {
    const payload = requirePlainPayload(message.payload);
    if (typeof payload.scanId !== "string" || typeof payload.pageUrl !== "string") {
      throw new Error("Malformed gloss.scan.start payload");
    }
    // @constraint glossa.extension_contracts.message_envelopes.gloss_scan_start.accepted Valid gloss scan start payloads are accepted as inbound gloss-port messages.
    return message as GlossPortInboundMessage;
  }
  // @constraint glossa.extension_contracts.message_envelopes.gloss_scan_chunk Gloss scan chunks must carry typed chunk payloads before background lookup accepts them.
  if (message.type === "gloss.scan.chunk") {
    // @constraint glossa.extension_contracts.message_envelopes.gloss_scan_chunk.payload Gloss scan chunk payloads must pass nested sentence and token validation.
    if (!isGlossScanChunkPayload(message.payload)) {
      throw new Error("Malformed gloss.scan.chunk payload");
    }
    // @constraint glossa.extension_contracts.message_envelopes.gloss_scan_chunk.accepted Valid gloss scan chunks are accepted as inbound gloss-port messages.
    return message as GlossPortInboundMessage;
  }
  // @constraint glossa.extension_contracts.message_envelopes.gloss_scan_end Gloss scan end messages must identify the scan being closed.
  if (message.type === "gloss.scan.end") {
    const payload = requirePlainPayload(message.payload);
    // @constraint glossa.extension_contracts.message_envelopes.gloss_scan_end.scan_id Gloss scan end payloads must carry a string scan id.
    if (typeof payload.scanId !== "string") {
      throw new Error("Malformed gloss.scan.end payload");
    }
    return message as GlossPortInboundMessage;
  }
  throw new Error("Unknown gloss port message type");
}

// @constraint glossa.extension_contracts.message_envelopes.gloss_outbound_payloads Gloss outbound messages validate acknowledgement, token, done, and error payload shapes before use.
export function validateGlossPortOutbound(value: unknown, scanId?: string): GlossPortOutboundMessage {
  const message = validateGlossPortEnvelope(value);
  if (message.type === "gloss.chunk.ack") {
    const payload = requirePlainPayload(message.payload);
    if (
      typeof payload.scanId !== "string"
      || typeof payload.chunkId !== "string"
      || !isFiniteNumber(payload.acceptedTokens)
    ) {
      throw new Error("Malformed gloss.chunk.ack payload");
    }
    if (scanId && payload.scanId !== scanId) {
      throw new Error("Gloss port scanId mismatch");
    }
    return message as GlossPortOutboundMessage;
  }
  // @constraint glossa.extension_contracts.message_envelopes.gloss_token_outbound Gloss token outbound messages must validate the nested token payload before use.
  if (message.type === "gloss.token") {
    // @constraint glossa.extension_contracts.message_envelopes.gloss_token_outbound.payload_source Gloss token outbound validation reads the payload without weakening it through a plain-object cast.
    const payload = message.payload;
    // @constraint glossa.extension_contracts.message_envelopes.gloss_token_outbound.payload Gloss token outbound payloads must pass status-specific token validation.
    if (!isGlossTokenPayload(payload)) {
      throw new Error("Malformed gloss.token payload");
    }
    if (scanId && payload.scanId !== scanId) {
      throw new Error("Gloss port scanId mismatch");
    }
    // @constraint glossa.extension_contracts.message_envelopes.gloss_token_outbound.accepted Valid gloss token payloads are accepted as outbound gloss-port messages.
    return message as GlossPortOutboundMessage;
  }
  if (message.type === "gloss.done") {
    const payload = requirePlainPayload(message.payload);
    if (typeof payload.scanId !== "string") {
      throw new Error("Malformed gloss.done payload");
    }
    if (scanId && payload.scanId !== scanId) {
      throw new Error("Gloss port scanId mismatch");
    }
    return message as GlossPortOutboundMessage;
  }
  if (message.type === "gloss.error") {
    const payload = requirePlainPayload(message.payload);
    if ((payload.scanId !== undefined && typeof payload.scanId !== "string") || !isErrorPayload(payload)) {
      throw new Error("Malformed gloss.error payload");
    }
    if (scanId && payload.scanId !== undefined && payload.scanId !== scanId) {
      throw new Error("Gloss port scanId mismatch");
    }
    return message as GlossPortOutboundMessage;
  }
  throw new Error("Unknown gloss port message type");
}

export function messageTimeoutError(message: Pick<RuntimeToBackgroundMessage, "type" | "requestId">): Error {
  return new Error(`Message timeout for ${message.type} (${message.requestId})`);
}

function createEnvelope<TType extends string, TSource extends MessageSource, TTarget extends MessageSource, TPayload>(
  type: TType,
  source: TSource,
  target: TTarget,
  payload: TPayload
): MessageEnvelope<TType, TSource, TTarget, TPayload> {
  return {
    type,
    version: MESSAGE_VERSION,
    requestId: createRequestId(),
    source,
    target,
    createdAt: Date.now(),
    payload
  };
}

function createRequestId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `glossa-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function validateGlossPortEnvelope(value: unknown): { type: string; version: typeof MESSAGE_VERSION; createdAt: number; payload: unknown } {
  if (!isPlainObject(value)) {
    throw new Error("Invalid gloss port message");
  }
  const message = value as Record<string, unknown>;
  if (typeof message.type !== "string") {
    throw new Error("Missing gloss port message type");
  }
  if (message.version !== MESSAGE_VERSION) {
    throw new Error("Unsupported gloss port message version");
  }
  if (typeof message.createdAt !== "number") {
    throw new Error("Missing gloss port createdAt");
  }
  return message as { type: string; version: 1; createdAt: number; payload: unknown };
}

function validateEnvelope(value: unknown): MessageEnvelope<string, MessageSource, MessageSource, unknown> {
  if (!isPlainObject(value)) {
    throw new Error("Invalid message envelope");
  }
  const envelope = value as Record<string, unknown>;
  if (typeof envelope.type !== "string") {
    throw new Error("Missing message type");
  }
  if (envelope.version !== MESSAGE_VERSION) {
    throw new Error("Missing message version");
  }
  if (typeof envelope.requestId !== "string" || envelope.requestId.length === 0) {
    throw new Error("Missing requestId");
  }
  if (!isMessageSource(envelope.source) || !isMessageSource(envelope.target)) {
    throw new Error("Invalid message route");
  }
  if (typeof envelope.createdAt !== "number") {
    throw new Error("Missing createdAt");
  }
  return envelope as unknown as MessageEnvelope<string, MessageSource, MessageSource, unknown>;
}

function requirePlainPayload(value: unknown): Record<string, unknown> {
  if (!isPlainObject(value)) {
    throw new Error("Invalid message payload");
  }
  return value as Record<string, unknown>;
}

function isEmptyPayload(value: unknown): value is Record<string, never> {
  return isPlainObject(value) && Object.keys(value).length === 0;
}

function isUserWordClickPayload(value: unknown): value is UserWordClickPayload {
  if (!isPlainObject(value)) {
    return false;
  }
  return typeof value.pageUrl === "string"
    && typeof value.sentence === "string"
    && isTokenCandidate(value.token)
    && (value.allowDuplicateCard === undefined || typeof value.allowDuplicateCard === "boolean");
}

function isGlossScanPayload(value: unknown): value is GlossScanPayload {
  if (!isPlainObject(value)) {
    return false;
  }
  return typeof value.scanId === "string"
    && typeof value.pageUrl === "string"
    && isSentenceCandidateArray(value.sentences);
}

function isGlossScanChunkPayload(value: unknown): value is GlossScanChunkPayload {
  if (!isPlainObject(value)) {
    return false;
  }
  return typeof value.scanId === "string"
    && typeof value.chunkId === "string"
    && isFiniteNumber(value.chunkIndex)
    && typeof value.pageUrl === "string"
    && isSentenceCandidateArray(value.sentences);
}

function isGlossTokenPayload(value: unknown): value is GlossTokenPayload {
  if (!isPlainObject(value)) {
    return false;
  }
  // @constraint glossa.extension_contracts.message_envelopes.gloss_token_base Gloss token payloads must identify the scan, token, and known token status.
  if (typeof value.scanId !== "string" || typeof value.tokenId !== "string" || !isGlossTokenStatus(value.status)) {
    return false;
  }
  if (value.message !== undefined && typeof value.message !== "string") {
    return false;
  }
  if (value.item !== undefined && !isGlossItem(value.item)) {
    return false;
  }
  if (value.error !== undefined && !isErrorPayload(value.error)) {
    return false;
  }
  // @constraint glossa.extension_contracts.message_envelopes.gloss_token_ready Ready gloss token payloads must carry a complete gloss item.
  if (value.status === "ready" && !isGlossItem(value.item)) {
    return false;
  }
  // @constraint glossa.extension_contracts.message_envelopes.gloss_token_error Error gloss token payloads must carry a structured error payload.
  if (value.status === "error" && !isErrorPayload(value.error)) {
    return false;
  }
  return true;
}

function isTokenCandidate(value: unknown): value is TokenCandidate {
  if (!isPlainObject(value)) {
    return false;
  }
  return typeof value.id === "string"
    && typeof value.sentenceId === "string"
    && typeof value.surface === "string"
    && typeof value.lemma === "string"
    && isFiniteNumber(value.startOffset)
    && isFiniteNumber(value.endOffset);
}

function isSentenceCandidate(value: unknown): value is SentenceCandidate {
  if (!isPlainObject(value)) {
    return false;
  }
  return typeof value.id === "string"
    && typeof value.text === "string"
    && isTokenCandidateArray(value.tokens);
}

function isSentenceCandidateArray(value: unknown): value is SentenceCandidate[] {
  return Array.isArray(value) && value.every(isSentenceCandidate);
}

function isTokenCandidateArray(value: unknown): value is TokenCandidate[] {
  return Array.isArray(value) && value.every(isTokenCandidate);
}

function isGlossItem(value: unknown): value is GlossItem {
  if (!isPlainObject(value)) {
    return false;
  }
  return typeof value.tokenId === "string"
    && typeof value.targetText === "string"
    && typeof value.display === "string"
    && (value.phrase === undefined || typeof value.phrase === "string");
}

function isSettingsGetResponsePayload(value: unknown): value is SettingsGetResponsePayload {
  return isPlainObject(value) && isGlossaSettings(value.settings);
}

function isWordClickedOkPayload(value: unknown): value is WordClickedOkPayload {
  if (!isPlainObject(value)) {
    return false;
  }
  return (value.noteId === undefined || isFiniteNumber(value.noteId))
    && (value.noteIds === undefined || isFiniteNumberArray(value.noteIds));
}

function isWordCardDuplicatePayload(value: unknown): value is WordCardDuplicatePayload {
  if (!isPlainObject(value)) {
    return false;
  }
  return typeof value.lang === "string"
    && typeof value.lemma === "string"
    && typeof value.surface === "string"
    && isFiniteNumber(value.promptMs);
}

function isGlossaSettings(value: unknown): value is GlossaSettings {
  if (!isPlainObject(value)) {
    return false;
  }
  return typeof value.shortcutKey === "string"
    && typeof value.translateShortcutKey === "string"
    && typeof value.autoTranslateEnabled === "boolean"
    && isFiniteNumber(value.learningWindowDays)
    && isFiniteNumber(value.glossCacheTtlMs)
    && isKnownWordListId(value.knownWordList)
    && typeof value.promptVersion === "string"
    && typeof value.modelVersion === "string"
    && isAppearanceSettings(value.appearance)
    && isPromptSettings(value.prompts)
    && isAiSettings(value.ai)
    && isAnkiSettings(value.anki);
}

function isAppearanceSettings(value: unknown): value is GlossaSettings["appearance"] {
  if (!isPlainObject(value)) {
    return false;
  }
  return typeof value.textColor === "string"
    && typeof value.backgroundColor === "string"
    && typeof value.cardSuccessBackgroundColor === "string"
    && typeof value.cardErrorBackgroundColor === "string"
    && isFiniteNumber(value.backgroundOpacity)
    && typeof value.fontFamily === "string"
    && isFiniteNumber(value.fontSize);
}

function isPromptSettings(value: unknown): value is GlossaSettings["prompts"] {
  if (!isPlainObject(value)) {
    return false;
  }
  return typeof value.gloss === "string" && typeof value.ankiCard === "string";
}

function isAiSettings(value: unknown): value is GlossaSettings["ai"] {
  if (!isPlainObject(value)) {
    return false;
  }
  // @constraint glossa.extension_contracts.message_envelopes.ai_settings_payload AI settings payloads must preserve provider, endpoint, optional API key, reasoning effort, and request timeout shape.
  return isAiProvider(value.provider)
    && typeof value.endpoint === "string"
    && (value.apiKey === undefined || typeof value.apiKey === "string")
    && isReasoningEffort(value.reasoningEffort)
    && isFiniteNumber(value.requestTimeoutMs);
}

function isAnkiSettings(value: unknown): value is GlossaSettings["anki"] {
  if (!isPlainObject(value)) {
    return false;
  }
  return typeof value.endpoint === "string"
    && typeof value.deck === "string"
    && typeof value.modelName === "string"
    && isFiniteNumber(value.requestTimeoutMs)
    && isFiniteNumber(value.duplicatePromptMs);
}

function isFiniteNumberArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.every(isFiniteNumber);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMessageSource(value: unknown): value is MessageSource {
  return value === "content-script" || value === "service-worker" || value === "options";
}

function isGlossTokenStatus(value: unknown): value is GlossTokenStatus {
  return value === "ready" || value === "pending" || value === "hidden" || value === "error";
}

function isAiProvider(value: unknown): value is AiProvider {
  return value === "glossa-backend"
    || value === "openai-responses"
    || value === "openai-chat-completions"
    || value === "openai-completions";
}

function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return value === "none"
    || value === "minimal"
    || value === "low"
    || value === "medium"
    || value === "high"
    || value === "xhigh";
}

function isKnownWordListId(value: unknown): value is KnownWordListId {
  return value === "junior-high"
    || value === "senior-high"
    || value === "cet4"
    || value === "cet6"
    || value === "toefl"
    || value === "gre"
    || value === "coca-20000";
}
