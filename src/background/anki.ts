import type { AnkiCard, GlossaSettings, TokenCandidate } from "../shared/types";

export interface AnkiClient {
  createNote(input: { settings: GlossaSettings; card: AnkiCard; token: TokenCandidate }): Promise<number | undefined>;
}

export function createAnkiClient(fetchImpl: typeof fetch = fetch): AnkiClient {
  return {
    async createNote(input) {
      const response = await fetchImpl(input.settings.anki.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "addNote",
          version: 6,
          params: {
            note: {
              deckName: input.settings.anki.deck,
              modelName: "Basic",
              fields: {
                Front: input.card.front,
                Back: [input.card.back, ...input.card.examples].join("<br>")
              },
              tags: ["glossa", input.token.lemma]
            }
          }
        })
      });
      if (!response.ok) {
        throw new Error(`AnkiConnect HTTP ${response.status}`);
      }
      const result = await response.json() as { result?: number; error?: string };
      if (result.error) {
        throw new Error(result.error);
      }
      return result.result;
    }
  };
}
