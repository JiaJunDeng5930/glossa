// @constraint glossa.extension_contracts.message_envelopes Runtime requests, responses, and gloss-port traffic use versioned envelopes before payloads are accepted.
import type {
  BackgroundResponseMessage,
  ContentToBackgroundMessage,
  ErrorPayload,
  GlossCacheClearPayload,
  GlossCacheClearedPayload,
  GlossChunkAckPayload,
  GlossDonePayload,
  GlossScanChunkPayload,
  GlossScanEndPayload,
  GlossPortInboundMessage,
  GlossPortOutboundMessage,
  GlossPortErrorPayload,
  GlossScanPayload,
  GlossScanStartPayload,
  GlossTokenPayload,
  MessageEnvelope,
  MessageSource,
  OptionsToBackgroundMessage,
  RuntimeToBackgroundMessage,
  SettingsGetPayload,
  SettingsGetResponsePayload,
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
    requirePlainPayload(envelope.payload);
    return envelope as ContentToBackgroundMessage;
  }
  if (envelope.type === "word.clicked") {
    const payload = requirePlainPayload(envelope.payload);
    if (typeof payload.pageUrl !== "string" || typeof payload.sentence !== "string" || !isPlainObject(payload.token)) {
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
    requirePlainPayload(envelope.payload);
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
  const payload = requirePlainPayload(envelope.payload);
  if (envelope.type === "error" && !isErrorPayload(payload)) {
    throw new Error("Malformed error payload");
  }
  return envelope as BackgroundResponseMessage;
}

export function validateGlossPortInbound(value: unknown): GlossPortInboundMessage {
  const message = validateGlossPortEnvelope(value);
  if (message.type === "gloss.scan") {
    const payload = requirePlainPayload(message.payload);
    if (typeof payload.scanId !== "string" || typeof payload.pageUrl !== "string" || !Array.isArray(payload.sentences)) {
      throw new Error("Malformed gloss.scan payload");
    }
    return message as GlossPortInboundMessage;
  }
  if (message.type === "gloss.scan.start") {
    const payload = requirePlainPayload(message.payload);
    if (typeof payload.scanId !== "string" || typeof payload.pageUrl !== "string") {
      throw new Error("Malformed gloss.scan.start payload");
    }
    return message as GlossPortInboundMessage;
  }
  if (message.type === "gloss.scan.chunk") {
    const payload = requirePlainPayload(message.payload);
    if (
      typeof payload.scanId !== "string"
      || typeof payload.chunkId !== "string"
      || typeof payload.chunkIndex !== "number"
      || typeof payload.pageUrl !== "string"
      || !Array.isArray(payload.sentences)
    ) {
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
      || typeof payload.acceptedTokens !== "number"
    ) {
      throw new Error("Malformed gloss.chunk.ack payload");
    }
    if (scanId && payload.scanId !== scanId) {
      throw new Error("Gloss port scanId mismatch");
    }
    return message as GlossPortOutboundMessage;
  }
  if (message.type === "gloss.token") {
    const payload = requirePlainPayload(message.payload);
    if (
      typeof payload.scanId !== "string"
      || typeof payload.tokenId !== "string"
      || !isGlossTokenStatus(payload.status)
    ) {
      throw new Error("Malformed gloss.token payload");
    }
    if (scanId && payload.scanId !== scanId) {
      throw new Error("Gloss port scanId mismatch");
    }
    if (payload.status === "ready" && !isPlainObject(payload.item)) {
      throw new Error("Missing gloss token item");
    }
    if (payload.status === "error" && !isErrorPayload(payload.error)) {
      throw new Error("Missing gloss token error message");
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMessageSource(value: unknown): value is MessageSource {
  return value === "content-script" || value === "service-worker" || value === "options";
}

function isGlossTokenStatus(value: unknown): boolean {
  return value === "ready" || value === "pending" || value === "hidden" || value === "error";
}
