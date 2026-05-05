import type {
  BackgroundResponseMessage,
  ContentToBackgroundMessage,
  ErrorPayload,
  GlossDonePayload,
  GlossPortInboundMessage,
  GlossPortOutboundMessage,
  GlossPortErrorPayload,
  GlossScanPayload,
  GlossTokenPayload,
  MessageEnvelope,
  MessageSource,
  SettingsGetPayload,
  SettingsGetResponsePayload,
  UserWordClickPayload,
  WordClickedOkPayload
} from "./types";

export const MESSAGE_VERSION = 1;

type ContentPayloadByType = {
  "settings.get": SettingsGetPayload;
  "word.clicked": UserWordClickPayload;
};

type BackgroundPayloadByType = {
  "settings.response": SettingsGetResponsePayload;
  "word.clicked.ok": WordClickedOkPayload;
  error: ErrorPayload;
};

type GlossPortPayloadByType = {
  "gloss.scan": GlossScanPayload;
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

export function createBackgroundResponse<TType extends keyof BackgroundPayloadByType>(
  request: Pick<ContentToBackgroundMessage, "requestId" | "source">,
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

export function validateBackgroundResponse(value: unknown, request: ContentToBackgroundMessage): BackgroundResponseMessage {
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
    && envelope.type !== "error"
  ) {
    throw new Error("Unknown response type");
  }
  requirePlainPayload(envelope.payload);
  return envelope as BackgroundResponseMessage;
}

export function validateGlossPortInbound(value: unknown): GlossPortInboundMessage {
  const message = validateGlossPortEnvelope(value);
  if (message.type !== "gloss.scan") {
    throw new Error("Unknown gloss port message type");
  }
  const payload = requirePlainPayload(message.payload);
  if (typeof payload.scanId !== "string" || typeof payload.pageUrl !== "string" || !Array.isArray(payload.sentences)) {
    throw new Error("Malformed gloss.scan payload");
  }
  return message as GlossPortInboundMessage;
}

export function validateGlossPortOutbound(value: unknown, scanId?: string): GlossPortOutboundMessage {
  const message = validateGlossPortEnvelope(value);
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
    if (payload.status === "error" && typeof payload.message !== "string") {
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
    if ((payload.scanId !== undefined && typeof payload.scanId !== "string") || typeof payload.message !== "string") {
      throw new Error("Malformed gloss.error payload");
    }
    if (scanId && payload.scanId !== undefined && payload.scanId !== scanId) {
      throw new Error("Gloss port scanId mismatch");
    }
    return message as GlossPortOutboundMessage;
  }
  throw new Error("Unknown gloss port message type");
}

export function messageTimeoutError(message: Pick<ContentToBackgroundMessage, "type" | "requestId">): Error {
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
