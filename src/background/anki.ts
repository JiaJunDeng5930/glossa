// @behavior glossa.card_creation Clicked words can create Anki notes through configured AnkiConnect settings and report endpoint or model failures as diagnostics.
import { createDiagnosticError, errorPayloadFromHttpStatus, requestDiagnosticErrorFrom } from "../shared/errors";
import type { AnkiCard, GlossaSettings, TokenCandidate } from "../shared/types";

// @intent glossa.card_creation.anki_client The Anki client abstraction is the active boundary for AnkiConnect note creation.
export interface AnkiClient {
  createNote(input: { settings: GlossaSettings; card: AnkiCard; token: TokenCandidate }): Promise<number | undefined>;
}

export function createAnkiClient(fetchImpl: typeof fetch = fetch): AnkiClient {
  return {
    // @behavior glossa.card_creation.note_request The create note operation submits one configured AnkiConnect note request and returns its note id.
    async createNote(input) {
      const controller = new AbortController();
      // @constraint glossa.card_creation.note_request.timeout The note request aborts after fifteen seconds so AnkiConnect calls cannot wait forever.
      const timeout = globalThis.setTimeout(() => controller.abort(), 15_000);
      // @behavior glossa.card_creation.failure AnkiConnect request, response, and service failures become diagnostics for card creation.
      try {
        // @constraint glossa.card_creation.note_request.fields The Anki note fields map generated card front and back into Basic Front and Back fields.
        const fields = {
          Front: input.card.front,
          Back: input.card.back
        };
        // @constraint glossa.card_creation.note_request.tags The Anki note tags include glossa and the clicked token lemma.
        const tags = ["glossa", input.token.lemma];
        // @constraint glossa.card_creation.note_request.payload The Anki note payload uses the configured deck and model with the prepared fields and tags.
        const body = {
          action: "addNote",
          version: 6,
          params: {
            note: {
              deckName: input.settings.anki.deck,
              modelName: input.settings.anki.modelName,
              fields,
              tags
            },
          }
        };
        // @behavior glossa.card_creation.note_request.http_call The request posts the addNote payload to the configured AnkiConnect endpoint with JSON headers.
        const response = await fetchImpl(input.settings.anki.endpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal
        });
        if (!response.ok) {
          // @behavior glossa.card_creation.failure.http_status Non-OK AnkiConnect HTTP responses become diagnostics with Anki service and status.
          const payload = errorPayloadFromHttpStatus("anki", response.status);
          throw createDiagnosticError(payload.reason, `AnkiConnect HTTP ${response.status}`, {
            service: "anki",
            status: response.status
          });
        }
        let result: { result?: number; error?: string };
        try {
          result = await response.json() as { result?: number; error?: string };
        } catch (error) {
          // @behavior glossa.card_creation.failure.invalid_response Malformed AnkiConnect JSON becomes an invalid-response diagnostic for Anki.
          throw createDiagnosticError("invalid-response", "AnkiConnect returned invalid JSON", { service: "anki", cause: error });
        }
        if (result.error) {
          // @behavior glossa.card_creation.failure.service_error AnkiConnect result errors become service-error diagnostics that preserve the service message.
          throw createDiagnosticError("service-error", result.error, { service: "anki" });
        }
        return result.result;
      } catch (error) {
        // @behavior glossa.card_creation.failure.request_error Request failures become Anki diagnostics through the shared request error mapper.
        throw requestDiagnosticErrorFrom(error, { reason: "service-error", message: "AnkiConnect request failed", service: "anki" });
      } finally {
        // @constraint glossa.card_creation.note_request.timeout_cleanup The note request clears its timeout after success or failure.
        globalThis.clearTimeout(timeout);
      }
    }
  };
}
