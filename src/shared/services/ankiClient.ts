import { createDiagnosticError, errorPayloadFromHttpStatus, requestDiagnosticErrorFrom } from "../errors";
import type { AnkiCard, AnkiSettings, ErrorCode, GlossaSettings } from "../types";

export const ANKI_CARD_FIELDS = { front: "Front", back: "Back" } as const;
export interface AnkiCatalog { decks: string[]; modelNames: string[] }
export interface AnkiClient {
  createNote(input: { settings: GlossaSettings; card: AnkiCard; signal?: AbortSignal }): Promise<number>;
  loadCatalog(settings: AnkiSettings, signal?: AbortSignal): Promise<AnkiCatalog>;
  probe(settings: AnkiSettings, signal?: AbortSignal): Promise<void>;
}
const invalidResponse = () => createDiagnosticError("invalid-response", "AnkiConnect returned invalid response data", { service: "anki" });
const isNoteId = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const isStrings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === "string");
function serviceError(message: string) {
  let code: ErrorCode | undefined;
  if (/model.*not found|Anki model was not found/i.test(message)) code = "anki-model-not-found";
  else if (/deck.*not found|Anki deck was not found/i.test(message)) code = "anki-deck-not-found";
  else if (/No compatible Anki model was found/i.test(message)) code = "anki-no-compatible-model";
  else if (/empty/i.test(message)) code = "anki-empty-card";
  return createDiagnosticError("service-error", message, { service: "anki", ...(code ? { code } : {}) });
}
export function createAnkiClient(fetchImpl: typeof fetch = fetch): AnkiClient {
  async function action<T>(settings: AnkiSettings, name: string, validate: (value: unknown) => value is T, params?: Record<string,unknown>, signal?: AbortSignal): Promise<T> {
    const controller = new AbortController();
    const cancel = () => controller.abort();
    if (signal?.aborted) controller.abort(); else signal?.addEventListener("abort", cancel, { once:true });
    const timeout = setTimeout(cancel, settings.requestTimeoutMs);
    try {
      const response = await fetchImpl(settings.endpoint, { method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify({action:name,version:6,...(params ? {params} : {})}), signal:controller.signal });
      if (!response.ok) { const error = errorPayloadFromHttpStatus("anki", response.status); throw createDiagnosticError(error.reason, `AnkiConnect HTTP ${response.status}`, {service:"anki",status:response.status}); }
      let value: unknown;
      try { value = await response.json(); } catch { throw invalidResponse(); }
      if (typeof value !== "object" || value === null || Array.isArray(value)) throw invalidResponse();
      const envelope = value as Record<string,unknown>;
      if (envelope.error !== undefined && envelope.error !== null && typeof envelope.error !== "string") throw invalidResponse();
      if (typeof envelope.error === "string" && envelope.error.length > 0) throw serviceError(envelope.error);
      if (!validate(envelope.result)) throw invalidResponse();
      return envelope.result;
    } catch (error) { throw requestDiagnosticErrorFrom(error, {reason:"service-error",message:"AnkiConnect request failed",service:"anki"}); }
    finally { clearTimeout(timeout); signal?.removeEventListener("abort",cancel); }
  }
  async function loadCatalog(settings: AnkiSettings, signal?: AbortSignal): Promise<AnkiCatalog> {
    await action(settings,"version",isNoteId,undefined,signal);
    const decks = await action(settings,"deckNames",isStrings,undefined,signal);
    const models = await action(settings,"modelNames",isStrings,undefined,signal);
    const modelNames: string[] = [];
    for (const modelName of models) {
      const fields = await action(settings,"modelFieldNames",isStrings,{modelName},signal);
      if (Object.values(ANKI_CARD_FIELDS).every(field => fields.includes(field))) modelNames.push(modelName);
    }
    if (modelNames.length === 0) throw createDiagnosticError("service-error","No compatible Anki model was found",{service:"anki",code:"anki-no-compatible-model"});
    return {decks,modelNames};
  }
  return {
    createNote({settings,card,signal}) {
      return action(settings.anki,"addNote",isNoteId,{note:{deckName:settings.anki.deck,modelName:settings.anki.modelName,fields:{[ANKI_CARD_FIELDS.front]:card.front,[ANKI_CARD_FIELDS.back]:card.back},tags:["glossa"]}},signal);
    },
    loadCatalog,
    async probe(settings, signal) {
      const catalog = await loadCatalog(settings,signal);
      if (!catalog.decks.includes(settings.deck)) throw createDiagnosticError("service-error","Anki deck was not found",{service:"anki",code:"anki-deck-not-found"});
      if (!catalog.modelNames.includes(settings.modelName)) throw createDiagnosticError("service-error","Anki model was not found",{service:"anki",code:"anki-model-not-found"});
    }
  };
}
