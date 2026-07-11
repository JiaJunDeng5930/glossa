import { KNOWN_WORD_LIST_IDS } from "./types";
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
  GlossPortInboundMessage,
  GlossPortOutboundMessage,
  GlossPortErrorPayload,
  GlossScanChunkPayload,
  GlossScanEndPayload,
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
    if (!isEmptyPayload(envelope.payload)) {
      throw new Error("Malformed settings.get payload");
    }
    return envelope as ContentToBackgroundMessage;
  }
  if (envelope.type === "word.clicked") {
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
  if (envelope.source !== "service-worker" || envelope.target !== request.source) {
    throw new Error("Unexpected response route");
  }
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
    if (!isSettingsGetResponsePayload(envelope.payload)) {
      throw new Error("Malformed settings.response payload");
    }
    return envelope as BackgroundResponseMessage;
  }
  if (envelope.type === "word.clicked.ok") {
    if (!isWordClickedOkPayload(envelope.payload)) {
      throw new Error("Malformed word.clicked.ok payload");
    }
    return envelope as BackgroundResponseMessage;
  }
  if (envelope.type === "word.card.duplicate") {
    if (!isWordCardDuplicatePayload(envelope.payload)) {
      throw new Error("Malformed word.card.duplicate payload");
    }
    return envelope as BackgroundResponseMessage;
  }
  if (envelope.type === "gloss.cache.cleared") {
    if (!isEmptyPayload(envelope.payload)) {
      throw new Error("Malformed gloss.cache.cleared payload");
    }
    return envelope as BackgroundResponseMessage;
  }
  if (envelope.type === "error") {
    if (!isErrorPayload(envelope.payload)) {
      throw new Error("Malformed error payload");
    }
    return envelope as BackgroundResponseMessage;
  }
  return envelope as BackgroundResponseMessage;
}

export function validateGlossPortInbound(value: unknown): GlossPortInboundMessage {
  const message = validateGlossPortEnvelope(value);
  if (message.type === "gloss.scan.start") {
    const payload = requirePlainPayload(message.payload);
    if (typeof payload.scanId !== "string" || typeof payload.pageUrl !== "string") {
      throw new Error("Malformed gloss.scan.start payload");
    }
    return message as GlossPortInboundMessage;
  }
  if (message.type === "gloss.scan.chunk") {
    if (!isGlossScanChunkPayload(message.payload)) {
      throw new Error("Malformed gloss.scan.chunk payload");
    }
    return message as GlossPortInboundMessage;
  }
  if (message.type === "gloss.scan.end") {
    const payload = requirePlainPayload(message.payload);
    if (typeof payload.scanId !== "string") {
      throw new Error("Malformed gloss.scan.end payload");
    }
    return message as GlossPortInboundMessage;
  }
  throw new Error("Unknown gloss port message type");
}

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
  if (message.type === "gloss.token") {
    const payload = message.payload;
    if (!isGlossTokenPayload(payload)) {
      throw new Error("Malformed gloss.token payload");
    }
    if (scanId && payload.scanId !== scanId) {
      throw new Error("Gloss port scanId mismatch");
    }
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
  if (value.status === "ready" && !isGlossItem(value.item)) {
    return false;
  }
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
    && isFiniteNumber(value.endOffset)
    && (value.forceRefresh === undefined || typeof value.forceRefresh === "boolean");
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
  return value.noteId === undefined || isFiniteNumber(value.noteId);
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
  return typeof value === "string" && (KNOWN_WORD_LIST_IDS as readonly string[]).includes(value);
}
