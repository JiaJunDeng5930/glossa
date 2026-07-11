import { createDiagnosticError, errorPayloadFromHttpStatus, requestDiagnosticErrorFrom } from "../shared/errors";
import type { AnkiCard, GlossaSettings, TokenCandidate } from "../shared/types";

export interface AnkiClient {
  createNote(input: { settings: GlossaSettings; card: AnkiCard; token: TokenCandidate }): Promise<number | undefined>;
}

export function createAnkiClient(fetchImpl: typeof fetch = fetch): AnkiClient {
  return {
    async createNote(input) {
      const controller = new AbortController();
      const timeout = globalThis.setTimeout(() => controller.abort(), input.settings.anki.requestTimeoutMs);
      try {
        const fields = {
          Front: input.card.front,
          Back: input.card.back
        };
        const tags = ["glossa"];
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
        const response = await fetchImpl(input.settings.anki.endpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal
        });
        if (!response.ok) {
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
          throw createDiagnosticError("invalid-response", "AnkiConnect returned invalid JSON", { service: "anki", cause: error });
        }
        if (result.error) {
          throw createDiagnosticError("service-error", result.error, { service: "anki" });
        }
        return result.result;
      } catch (error) {
        throw requestDiagnosticErrorFrom(error, { reason: "service-error", message: "AnkiConnect request failed", service: "anki" });
      } finally {
        globalThis.clearTimeout(timeout);
      }
    }
  };
}
