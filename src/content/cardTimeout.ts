import { DEFAULT_SETTINGS, type GlossaSettings } from "../shared/types";

const FALLBACK_WORD_CLICK_TIMEOUT_MS = 60_000;
const AI_TRANSPORT_ATTEMPTS = 2;
const WORD_CLICK_TIMEOUT_BUFFER_MS = 5_000;

export function wordClickTimeoutMs(settings: Partial<GlossaSettings> | undefined): number {
  if (!settings) {
    return FALLBACK_WORD_CLICK_TIMEOUT_MS;
  }
  const aiRequestTimeoutMs = settings.ai?.requestTimeoutMs ?? DEFAULT_SETTINGS.ai.requestTimeoutMs;
  const ankiRequestTimeoutMs = settings.anki?.requestTimeoutMs ?? DEFAULT_SETTINGS.anki.requestTimeoutMs;
  const configuredBudget = aiRequestTimeoutMs * AI_TRANSPORT_ATTEMPTS
    + ankiRequestTimeoutMs
    + WORD_CLICK_TIMEOUT_BUFFER_MS;
  return Math.max(FALLBACK_WORD_CLICK_TIMEOUT_MS, configuredBudget);
}
