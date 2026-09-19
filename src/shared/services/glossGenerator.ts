import pLimit from "p-limit";

import { createDiagnosticError, diagnosticPayloadFrom } from "../errors";
import type { ErrorPayload } from "../types";
import type { AiClient, GlossFrameBackendInput, GlossFrameItem } from "./aiClient";
import type { Dictionary } from "./dictionary";
import type { JevClient } from "./jevClient";

export type GlossGenerationItem =
  | { requestItemId: string; value: { targetText: string; display: string } }
  | { requestItemId: string; error: ErrorPayload };

export interface GlossGenerator {
  glossFrame(input: GlossFrameBackendInput): Promise<{ items: GlossGenerationItem[] }>;
}

export function createGlossGenerator(deps: {
  ai: Pick<AiClient, "glossFrame">;
  dictionary: Dictionary;
  jev: Pick<JevClient, "selectSense">;
}): GlossGenerator {
  async function generateLlmFrame(input: GlossFrameBackendInput): Promise<GlossGenerationItem[]> {
    if (input.items.length === 0) return [];
    try {
      const response = await deps.ai.glossFrame(input);
      const requested = new Set(input.items.map(({ requestItemId }) => requestItemId));
      const received = new Set<string>();
      // Validate before merging: a malformed fallback batch must not invalidate or replace dictionary successes.
      for (const item of response.items) {
        if (!requested.has(item.requestItemId) || received.has(item.requestItemId)) {
          throw createDiagnosticError("invalid-response", "LLM gloss frame returned an unknown or duplicate request item ID", { service: "ai" });
        }
        received.add(item.requestItemId);
      }
      return response.items;
    } catch (error) {
      const payload = diagnosticPayloadFrom(error, {
        reason: "service-error", message: "Gloss generation failed", service: "ai"
      });
      return input.items.map(({ requestItemId }) => ({ requestItemId, error: payload }));
    }
  }

  return {
    async glossFrame(input) {
      if (input.settings.translation.mode === "llm") {
        return { items: await generateLlmFrame(input) };
      }

      // A frame can contain many words; bound classification requests within the resolver's serial frame outlet.
      const classifyLimit = pLimit(4);
      const fallbackItems: GlossFrameItem[] = [];
      const results = await Promise.all(input.items.map((item) => classifyLimit(async (): Promise<GlossGenerationItem | undefined> => {
        let entry: Awaited<ReturnType<Dictionary["lookup"]>>;
        try {
          input.signal?.throwIfAborted();
          entry = await deps.dictionary.lookup(item.token, input.signal);
        } catch (error) {
          return { requestItemId: item.requestItemId, error: diagnosticPayloadFrom(error, {
            reason: "service-error", message: "Dictionary lookup failed", service: "dictionary"
          }) };
        }

        if (entry.kind === "missing") {
          if (input.settings.translation.fallbackToLlm) {
            fallbackItems.push(item);
            return undefined;
          }
          return { requestItemId: item.requestItemId, error: {
            reason: "not-found", code: "dictionary-word-not-found", service: "dictionary",
            message: "Dictionary has no entry for the target word"
          } };
        }

        if (entry.senses.length === 0) {
          return { requestItemId: item.requestItemId, error: {
            reason: "invalid-response", service: "dictionary", message: "Dictionary entry has no senses"
          } };
        }

        try {
          input.signal?.throwIfAborted();
          const selection = await deps.jev.selectSense({
            settings: input.settings.jev,
            sentence: item.sentence,
            word: item.token,
            senses: entry.senses,
            ...(input.signal ? { signal: input.signal } : {})
          });
          const selected = entry.senses.find((sense) => sense.id === selection.senseId);
          if (!selected) {
            throw createDiagnosticError("invalid-response", "Jev selected an unknown dictionary sense", { service: "jev" });
          }
          return { requestItemId: item.requestItemId, value: { targetText: item.token.surface, display: selected.definition } };
        } catch (error) {
          return { requestItemId: item.requestItemId, error: diagnosticPayloadFrom(error, {
            reason: "service-error", message: "Jev sense selection failed", service: "jev"
          }) };
        }
      })));
      const selectedItems = results.filter((item): item is GlossGenerationItem => item !== undefined);
      input.signal?.throwIfAborted();
      const fallbackResults = await generateLlmFrame({ ...input, items: fallbackItems });
      return { items: [...selectedItems, ...fallbackResults] };
    }
  };
}
