import type {
  BackgroundResponseMessage,
  ContentToBackgroundMessage,
  ErrorPayload,
  GlossRequestPayload,
  GlossResponsePayload,
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
  "gloss.request": GlossRequestPayload;
  "word.clicked": UserWordClickPayload;
};

type BackgroundPayloadByType = {
  "settings.response": SettingsGetResponsePayload;
  "gloss.response": GlossResponsePayload;
  "word.clicked.ok": WordClickedOkPayload;
  error: ErrorPayload;
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
  if (envelope.type === "gloss.request") {
    const payload = requirePlainPayload(envelope.payload);
    if (typeof payload.pageUrl !== "string" || !Array.isArray(payload.sentences)) {
      throw new Error("Malformed gloss.request payload");
    }
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
    && envelope.type !== "gloss.response"
    && envelope.type !== "word.clicked.ok"
    && envelope.type !== "error"
  ) {
    throw new Error("Unknown response type");
  }
  requirePlainPayload(envelope.payload);
  return envelope as BackgroundResponseMessage;
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
