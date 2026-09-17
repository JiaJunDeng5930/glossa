import { isErrorPayload } from "./errors";
import { validateSettings, validateSettingsPatch, type SettingsPatch } from "./settings";
import type { ErrorPayload, GlossaSettings, GlossChunkAckPayload, GlossDonePayload, GlossItem, GlossPortInboundMessage, GlossPortOutboundMessage, GlossPortErrorPayload, GlossScanChunkPayload, GlossScanEndPayload, GlossScanStartPayload, GlossTokenPayload, MessageEnvelope, MessageSource, SentenceCandidate, TokenCandidate, UserWordClickPayload, VocabularyRecord, WordCardDuplicatePayload, WordClickedOkPayload } from "./types";
export const MESSAGE_VERSION = 1;
type Guard<T> = (value: unknown) => value is T;
const checked = <T>(validate: (value: unknown) => T): Guard<T> => (value): value is T => { try { validate(value); return true; } catch { return false; } };
const settingsResponse: Guard<{settings:GlossaSettings}> = (v): v is {settings:GlossaSettings} => isPlainObject(v) && checked(validateSettings)(v.settings);
const settingsPatch: Guard<{patch:SettingsPatch}> = (v): v is {patch:SettingsPatch} => isPlainObject(v) && Object.keys(v).length === 1 && checked(validateSettingsPatch)(v.patch);
const lemmaPayload: Guard<{lemma:string}> = (v): v is {lemma:string} => isPlainObject(v) && Object.keys(v).length === 1 && typeof v.lemma === "string" && v.lemma.trim().length > 0;
const knownRecords: Guard<{records:VocabularyRecord[]}> = (v): v is {records:VocabularyRecord[]} => isPlainObject(v) && Array.isArray(v.records) && v.records.every(isVocabularyRecord);
const clickedOk: Guard<WordClickedOkPayload> = (v): v is WordClickedOkPayload => isPlainObject(v) && Number.isSafeInteger(v.noteId) && (v.noteId as number) > 0;
const duplicate: Guard<WordCardDuplicatePayload> = (v): v is WordCardDuplicatePayload => isPlainObject(v) && typeof v.lang === "string" && typeof v.lemma === "string" && typeof v.surface === "string" && isFiniteNumber(v.promptMs);
const enabled: Guard<{enabled:boolean}> = (v): v is {enabled:boolean} => isPlainObject(v) && typeof v.enabled === "boolean";
const frontend = ["content-script", "options", "onboarding", "popup"] as const;
// Runtime routes and TypeScript request/response relations derive from this same table.
export const RpcContract = {
  "settings.get": { sources: frontend, payload: isEmptyPayload, responses: { "settings.response": settingsResponse } },
  "settings.patch": { sources: ["options", "onboarding", "popup"], payload: settingsPatch, responses: { "settings.response": settingsResponse } },
  "known.words.list": { sources: ["options"], payload: isEmptyPayload, responses: { "known.words.list.result": knownRecords } },
  "known.words.add": { sources: ["options"], payload: lemmaPayload, responses: { "known.words.changed": isEmptyPayload } },
  "known.words.remove": { sources: ["options"], payload: lemmaPayload, responses: { "known.words.changed": isEmptyPayload } },
  "known.words.clear": { sources: ["options"], payload: isEmptyPayload, responses: { "known.words.changed": isEmptyPayload } },
  "word.clicked": { sources: ["content-script"], payload: isUserWordClickPayload, responses: { "word.clicked.ok": clickedOk, "word.card.duplicate": duplicate } },
  "translation.state.sync": { sources: ["content-script"], payload: isEmptyPayload, responses: { "translation.state.response": enabled } },
  "gloss.cache.clear": { sources: ["options"], payload: isEmptyPayload, responses: { "gloss.cache.cleared": isEmptyPayload } },
  "card.history.reset": { sources: ["options"], payload: isEmptyPayload, responses: { "card.history.reset.ok": isEmptyPayload } }
} as const;
export type RuntimeRequestType = keyof typeof RpcContract;
type GuardValue<G> = G extends Guard<infer T> ? T : never;
type Source<T extends RuntimeRequestType> = typeof RpcContract[T]["sources"][number];
export type RequestPayload<T extends RuntimeRequestType> = GuardValue<typeof RpcContract[T]["payload"]>;
export type RequestMessage<T extends RuntimeRequestType = RuntimeRequestType> = T extends RuntimeRequestType ? { [S in Source<T>]: MessageEnvelope<T,S,"service-worker",RequestPayload<T>> }[Source<T>] : never;
export type SuccessType<T extends RuntimeRequestType> = keyof typeof RpcContract[T]["responses"] & string;
export type ResponsePayload<T extends RuntimeRequestType,R extends SuccessType<T> | "error"> = R extends "error" ? ErrorPayload : R extends keyof typeof RpcContract[T]["responses"] ? GuardValue<typeof RpcContract[T]["responses"][R]> : never;
export type ResponseMessage<T extends RuntimeRequestType = RuntimeRequestType> = T extends RuntimeRequestType ? { [R in SuccessType<T> | "error"]: MessageEnvelope<R,"service-worker",Source<T>,ResponsePayload<T,R>> }[SuccessType<T> | "error"] : never;
export type RuntimeToBackgroundMessage = RequestMessage;
export type BackgroundResponseMessage = ResponseMessage;
type RequestForSource<S extends MessageSource> = { [T in RuntimeRequestType]: S extends Source<T> ? T : never }[RuntimeRequestType];
export function createRequestMessage<S extends Exclude<MessageSource,"service-worker">,T extends RequestForSource<S>>(source:S,type:T,payload:RequestPayload<T>): Extract<RequestMessage<T>,{source:S}> { return createEnvelope(type,source,"service-worker",payload) as unknown as Extract<RequestMessage<T>,{source:S}>; }
export function createContentMessage<T extends RequestForSource<"content-script">>(type:T,payload:RequestPayload<T>): Extract<RequestMessage<T>,{source:"content-script"}> { return createRequestMessage("content-script",type,payload); }
export function createOptionsMessage<T extends RequestForSource<"options">>(type:T,payload:RequestPayload<T>): Extract<RequestMessage<T>,{source:"options"}> { return createRequestMessage("options",type,payload); }
export function createBackgroundResponse<Q extends RequestMessage,R extends SuccessType<Q["type"]> | "error">(request:Q,type:R,payload:ResponsePayload<Q["type"],NoInfer<R>>): Extract<ResponseMessage<Q["type"]>,{type:R}> { return {type,version:MESSAGE_VERSION,requestId:request.requestId,source:"service-worker",target:request.source,createdAt:Date.now(),payload} as unknown as Extract<ResponseMessage<Q["type"]>,{type:R}>; }
export function validateRuntimeMessage(value:unknown): RuntimeToBackgroundMessage {
  const envelope = validateEnvelope(value);
  if (!Object.hasOwn(RpcContract, envelope.type)) throw new Error("Unknown message type");
  const contract = RpcContract[envelope.type as RuntimeRequestType];
  if (envelope.target !== "service-worker" || !(contract.sources as readonly string[]).includes(envelope.source)) throw new Error("Unexpected message route");
  if (!contract.payload(envelope.payload)) throw new Error(`Malformed ${envelope.type} payload`);
  return envelope as RuntimeToBackgroundMessage;
}
export function validateContentMessage(value:unknown): Extract<RequestMessage,{source:"content-script"}> { const request=validateRuntimeMessage(value); if(request.source !== "content-script") throw new Error("Unexpected message route"); return request; }
export function validateOptionsMessage(value:unknown): Extract<RequestMessage,{source:"options"}> { const request=validateRuntimeMessage(value); if(request.source !== "options") throw new Error("Unexpected message route"); return request; }
export function validateBackgroundResponse<T extends RuntimeRequestType>(value:unknown,request:RequestMessage<T>): ResponseMessage<T> {
  const envelope=validateEnvelope(value);
  if(envelope.requestId !== request.requestId) throw new Error("Response requestId mismatch");
  if(envelope.source !== "service-worker" || envelope.target !== request.source) throw new Error("Unexpected response route");
  const responses:Record<string,Guard<unknown>>=RpcContract[request.type].responses;
  const guard=envelope.type === "error" ? isErrorPayload : Object.hasOwn(responses, envelope.type) ? responses[envelope.type] : undefined;
  if(!guard) throw new Error("Unexpected response type for request");
  if(!guard(envelope.payload)) throw new Error(`Malformed ${envelope.type} payload`);
  return envelope as ResponseMessage<T>;
}
type GlossPortMessage = GlossPortInboundMessage | GlossPortOutboundMessage;
export function createGlossPortMessage<T extends GlossPortMessage["type"]>(type:T,payload:Extract<GlossPortMessage,{type:T}>["payload"]): Extract<GlossPortMessage,{type:T}> { return {type,version:MESSAGE_VERSION,createdAt:Date.now(),payload} as Extract<GlossPortMessage,{type:T}>; }

export function validateGlossPortInbound(value: unknown): GlossPortInboundMessage {
  const message = validateGlossPortEnvelope(value);
  if (message.type === "gloss.scan.start") {
    const payload = requirePlainPayload(message.payload);
    if (
      typeof payload.scanId !== "string"
      || typeof payload.pageUrl !== "string"
      || typeof payload.scanConfigHash !== "string"
    ) {
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
  if (!isFiniteNumber(message.createdAt)) {
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
  if (!isFiniteNumber(envelope.createdAt)) {
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
  if (!isPlainObject(value) || typeof value.scanId !== "string" || typeof value.tokenId !== "string") return false;
  if (value.status === "ready") return isGlossItem(value.item) && value.error === undefined && value.message === undefined;
  if (value.status === "error") return isErrorPayload(value.error) && value.item === undefined && value.message === undefined;
  return (value.status === "pending" || value.status === "hidden") && value.item === undefined && value.error === undefined && value.message === undefined;
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
    && typeof value.display === "string";
}

function isFiniteNumber(value:unknown): value is number { return typeof value === "number" && Number.isFinite(value); }
function isPlainObject(value:unknown): value is Record<string,unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function isMessageSource(value:unknown): value is MessageSource { return typeof value === "string" && ["content-script","service-worker","options","onboarding","popup"].includes(value); }
function isVocabularyRecord(value:unknown): value is VocabularyRecord { return isPlainObject(value) && typeof value.key === "string" && typeof value.lang === "string" && typeof value.lemma === "string" && typeof value.surface === "string" && ["candidate","known","learning_active","ignored"].includes(value.state as string) && (value.expiresAt === undefined || isFiniteNumber(value.expiresAt)) && (value.lastShownAt === undefined || isFiniteNumber(value.lastShownAt)) && (value.lastClickedAt === undefined || isFiniteNumber(value.lastClickedAt)); }
