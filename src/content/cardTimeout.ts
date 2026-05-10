import { DEFAULT_SETTINGS, type GlossaSettings } from "../shared/types";

const FALLBACK_WORD_CLICK_TIMEOUT_MS = 60_000;
const AI_TRANSPORT_ATTEMPTS = 2;
const WORD_CLICK_TIMEOUT_BUFFER_MS = 5_000;

// @constraint glossa.card_creation.note_request.content_timeout Content-side card creation waits long enough for configured AI retry and Anki write budgets.
export function wordClickTimeoutMs(settings: Partial<GlossaSettings> | undefined): number {
  if (!settings) {
    return FALLBACK_WORD_CLICK_TIMEOUT_MS;
  }
  // @constraint glossa.card_creation.note_request.content_timeout.budget The word-click timeout includes two AI transport attempts, one concurrent Anki write window, and a small message overhead buffer.
  const aiRequestTimeoutMs = settings.ai?.requestTimeoutMs ?? DEFAULT_SETTINGS.ai.requestTimeoutMs;
  const ankiRequestTimeoutMs = settings.anki?.requestTimeoutMs ?? DEFAULT_SETTINGS.anki.requestTimeoutMs;
  const configuredBudget = aiRequestTimeoutMs * AI_TRANSPORT_ATTEMPTS
    + ankiRequestTimeoutMs
    + WORD_CLICK_TIMEOUT_BUFFER_MS;
  return Math.max(FALLBACK_WORD_CLICK_TIMEOUT_MS, configuredBudget);
}
