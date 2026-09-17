import { AI_REQUEST_POLICY } from "./services/requestPolicy";
import { DEFAULT_SETTINGS, type GlossaSettings } from "./types";

const FALLBACK_CARD_OPERATION_TIMEOUT_MS = 60_000;

const CARD_OPERATION_TIMEOUT_BUFFER_MS = 5_000;

export function cardOperationTimeoutMs(settings: Partial<GlossaSettings> | undefined): number {
  if (!settings) {
    return FALLBACK_CARD_OPERATION_TIMEOUT_MS;
  }
  const aiRequestTimeoutMs = settings.ai?.requestTimeoutMs ?? DEFAULT_SETTINGS.ai.requestTimeoutMs;
  const ankiRequestTimeoutMs = settings.anki?.requestTimeoutMs ?? DEFAULT_SETTINGS.anki.requestTimeoutMs;
  const configuredBudget = aiRequestTimeoutMs * AI_REQUEST_POLICY.maxAttempts
    + ankiRequestTimeoutMs
    + CARD_OPERATION_TIMEOUT_BUFFER_MS;
  return Math.max(FALLBACK_CARD_OPERATION_TIMEOUT_MS, configuredBudget);
}
