// @behavior glossa Activated pages show inline Chinese glosses for unfamiliar English words and remember vocabulary decisions.
// @constraint glossa.extension_contracts Extension contexts share stable contracts for messages, diagnostics, shortcuts, errors, and user messages.
// @intent glossa.extension_contracts.payload_consistency Shared payload types keep runtime messages and persisted records consistent across extension contexts.
export type VocabularyState = "known" | "learning_active" | "ignored" | "candidate";

export interface VocabularyRecord {
  key: string;
  lemma: string;
  surface: string;
  lang: string;
  state: VocabularyState;
  expiresAt?: number;
  shownCount: number;
  clickCount: number;
  lastShownAt?: number;
  lastClickedAt?: number;
  ankiNoteIds: number[];
}

export interface CardedWordRecord {
  // @constraint glossa.card_creation.duplicate_gate.record_key Carded-word records use the same language-and-lemma key as vocabulary records.
  key: string;
  // @constraint glossa.card_creation.duplicate_gate.record_lang Carded-word records store the source language for the keyed lemma.
  lang: string;
  // @constraint glossa.card_creation.duplicate_gate.record_lemma Carded-word records store the normalized lemma that was successfully carded.
  lemma: string;
  // @constraint glossa.card_creation.duplicate_gate.record_created_at Carded-word records store the time of the successful Anki write.
  createdAt: number;
}

export interface TokenCandidate {
  id: string;
  sentenceId: string;
  surface: string;
  lemma: string;
  startOffset: number;
  endOffset: number;
}

export interface SentenceCandidate {
  id: string;
  text: string;
  tokens: TokenCandidate[];
}

export interface GlossItem {
  tokenId: string;
  targetText: string;
  display: string;
  phrase?: string;
}

// @constraint glossa.cache_identity.gloss_cache_entry Persisted gloss cache records extend display gloss items with cache metadata.
export interface GlossCacheEntry extends GlossItem {
  // @constraint glossa.cache_identity.gloss_cache_entry.created_at Persisted gloss cache entries store the cache creation time in milliseconds.
  createdAt: number;
}

export type MessageSource = "content-script" | "service-worker" | "options";
export type MessageTarget = MessageSource;
export type MessageVersion = 1;
export type ErrorReason = "network" | "timeout" | "unauthorized" | "not-found" | "service-error" | "invalid-response" | "runtime";
export type ErrorService = "ai" | "anki" | "runtime";

export interface MessageEnvelope<TType extends string, TSource extends MessageSource, TTarget extends MessageTarget, TPayload> {
  type: TType;
  version: MessageVersion;
  requestId: string;
  source: TSource;
  target: TTarget;
  createdAt: number;
  payload: TPayload;
}

export interface GlossRequestPayload {
  pageUrl: string;
  sentences: SentenceCandidate[];
}

export interface GlossResponsePayload {
  items: GlossItem[];
}

export interface GlossScanPayload {
  scanId: string;
  pageUrl: string;
  sentences: SentenceCandidate[];
}

export interface GlossScanStartPayload {
  scanId: string;
  pageUrl: string;
}

export interface GlossScanChunkPayload {
  scanId: string;
  chunkId: string;
  chunkIndex: number;
  pageUrl: string;
  sentences: SentenceCandidate[];
}

export interface GlossScanEndPayload {
  scanId: string;
}

export interface GlossChunkAckPayload {
  scanId: string;
  chunkId: string;
  acceptedTokens: number;
}

export type GlossTokenStatus = "ready" | "pending" | "hidden" | "error";

export interface GlossTokenPayload {
  scanId: string;
  tokenId: string;
  status: GlossTokenStatus;
  item?: GlossItem;
  message?: string;
  error?: ErrorPayload;
}

export interface GlossDonePayload {
  scanId: string;
}

export interface GlossPortErrorPayload extends ErrorPayload {
  scanId?: string;
}

export interface GlossPortMessage<TType extends string, TPayload> {
  type: TType;
  version: MessageVersion;
  createdAt: number;
  payload: TPayload;
}

export interface UserWordClickPayload {
  pageUrl: string;
  sentence: string;
  token: TokenCandidate;
  // @behavior glossa.card_creation.duplicate_gate.message_confirmed Word-click requests carry duplicate approval only after content prompt confirmation.
  allowDuplicateCard?: boolean;
}

export interface WordClickedOkPayload {
  noteId?: number;
  noteIds?: number[];
}

export interface WordCardDuplicatePayload {
  // @constraint glossa.card_creation.duplicate_gate.message_lang Duplicate-card responses include the source language for the carded lemma.
  lang: string;
  // @constraint glossa.card_creation.duplicate_gate.message_lemma Duplicate-card responses include the lemma that matched the carded-word record.
  lemma: string;
  // @constraint glossa.card_creation.duplicate_gate.message_surface Duplicate-card responses include the clicked surface text for the prompt copy.
  surface: string;
  // @constraint glossa.card_creation.duplicate_gate.message_prompt_ms Duplicate-card responses include the configured prompt duration in milliseconds.
  promptMs: number;
}

export type SettingsGetPayload = Record<string, never>;

export interface SettingsGetResponsePayload {
  settings: GlossaSettings;
}

export type GlossCacheClearPayload = Record<string, never>;
export type GlossCacheClearedPayload = Record<string, never>;

export interface ErrorPayload {
  reason: ErrorReason;
  message: string;
  service?: ErrorService;
  status?: number;
}

export type GlossRequestMessage = MessageEnvelope<"gloss.request", "content-script", "service-worker", GlossRequestPayload>;
export type GlossResponseMessage = MessageEnvelope<"gloss.response", "service-worker", "content-script", GlossResponsePayload>;
export type GlossScanMessage = GlossPortMessage<"gloss.scan", GlossScanPayload>;
export type GlossScanStartMessage = GlossPortMessage<"gloss.scan.start", GlossScanStartPayload>;
export type GlossScanChunkMessage = GlossPortMessage<"gloss.scan.chunk", GlossScanChunkPayload>;
export type GlossScanEndMessage = GlossPortMessage<"gloss.scan.end", GlossScanEndPayload>;
export type GlossChunkAckMessage = GlossPortMessage<"gloss.chunk.ack", GlossChunkAckPayload>;
export type GlossTokenMessage = GlossPortMessage<"gloss.token", GlossTokenPayload>;
export type GlossDoneMessage = GlossPortMessage<"gloss.done", GlossDonePayload>;
export type GlossPortErrorMessage = GlossPortMessage<"gloss.error", GlossPortErrorPayload>;
export type UserWordClickMessage = MessageEnvelope<"word.clicked", "content-script", "service-worker", UserWordClickPayload>;
export type WordClickedOkMessage = MessageEnvelope<"word.clicked.ok", "service-worker", "content-script", WordClickedOkPayload>;
// @behavior glossa.card_creation.duplicate_gate.message_type The duplicate-card envelope is a service-worker response consumed by content.
export type WordCardDuplicateMessage = MessageEnvelope<"word.card.duplicate", "service-worker", "content-script", WordCardDuplicatePayload>;
export type SettingsGetMessage = MessageEnvelope<"settings.get", "content-script", "service-worker", SettingsGetPayload>;
export type SettingsGetResponseMessage = MessageEnvelope<"settings.response", "service-worker", "content-script", SettingsGetResponsePayload>;
export type GlossCacheClearMessage = MessageEnvelope<"gloss.cache.clear", "options", "service-worker", GlossCacheClearPayload>;
export type GlossCacheClearedMessage = MessageEnvelope<"gloss.cache.cleared", "service-worker", "options", GlossCacheClearedPayload>;
export type ErrorMessage = MessageEnvelope<"error", "service-worker", "content-script", ErrorPayload>;
export type OptionsErrorMessage = MessageEnvelope<"error", "service-worker", "options", ErrorPayload>;

export type GlossPortInboundMessage = GlossScanMessage | GlossScanStartMessage | GlossScanChunkMessage | GlossScanEndMessage;
export type GlossPortOutboundMessage = GlossTokenMessage | GlossDoneMessage | GlossPortErrorMessage | GlossChunkAckMessage;

export type ContentToBackgroundMessage = UserWordClickMessage | SettingsGetMessage;
export type OptionsToBackgroundMessage = GlossCacheClearMessage;
export type RuntimeToBackgroundMessage = ContentToBackgroundMessage | OptionsToBackgroundMessage;
// @constraint glossa.extension_contracts.payload_consistency.duplicate_response Background responses include duplicate-card prompts alongside success, settings, and error envelopes.
export type BackgroundResponseMessage = WordClickedOkMessage | WordCardDuplicateMessage | SettingsGetResponseMessage | GlossCacheClearedMessage | ErrorMessage | OptionsErrorMessage;

export type AiProvider = "glossa-backend" | "openai-responses" | "openai-chat-completions" | "openai-completions";
export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
export type KnownWordListId = "junior-high" | "senior-high" | "cet4" | "cet6" | "toefl" | "gre" | "coca-20000";

export const GLOSS_TARGET_LANG = "zh-CN";

export interface AiSettings {
  provider: AiProvider;
  endpoint: string;
  apiKey?: string;
  reasoningEffort: ReasoningEffort;
  // @behavior glossa.ai_requests.failure.timeout.setting AI requests abort after this configured timeout in milliseconds.
  requestTimeoutMs: number;
}

export interface AnkiSettings {
  endpoint: string;
  deck: string;
  modelName: string;
  // @behavior glossa.card_creation.note_request.timeout.setting Anki note and catalog requests abort after this configured timeout in milliseconds.
  requestTimeoutMs: number;
  // @behavior glossa.card_creation.duplicate_gate.prompt_setting Duplicate-card prompts wait this many milliseconds before cancellation.
  duplicatePromptMs: number;
}

export interface AppearanceSettings {
  textColor: string;
  backgroundColor: string;
  cardSuccessBackgroundColor: string;
  cardErrorBackgroundColor: string;
  backgroundOpacity: number;
  fontFamily: string;
  fontSize: number;
}

export interface PromptSettings {
  gloss: string;
  ankiCard: string;
}

export interface GlossaSettings {
  shortcutKey: string;
  translateShortcutKey: string;
  autoTranslateEnabled: boolean;
  learningWindowDays: number;
  // @behavior glossa.settings_save.gloss_cache_ttl Gloss cache hits are fresh for this configured number of milliseconds after cache creation.
  glossCacheTtlMs: number;
  knownWordList: KnownWordListId;
  promptVersion: string;
  modelVersion: string;
  appearance: AppearanceSettings;
  prompts: PromptSettings;
  ai: AiSettings;
  anki: AnkiSettings;
}

export interface AnkiCard {
  front: string;
  back: string;
}

export interface AnkiCardOutput {
  cards: AnkiCard[];
}

export const DEFAULT_SETTINGS: GlossaSettings = {
  shortcutKey: "Alt",
  translateShortcutKey: "Alt+G",
  autoTranslateEnabled: false,
  learningWindowDays: 3,
  glossCacheTtlMs: 24 * 60 * 60 * 1_000,
  knownWordList: "junior-high",
  promptVersion: "gloss-v1",
  modelVersion: "gpt-4.1-mini",
  appearance: {
    textColor: "#1f2428",
    backgroundColor: "#fff4c9",
    cardSuccessBackgroundColor: "#e5f6eb",
    cardErrorBackgroundColor: "#ffece8",
    backgroundOpacity: 0.94,
    fontFamily: "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif",
    fontSize: 12
  },
  prompts: {
    gloss: "Translate each unfamiliar English word or phrase into Simplified Chinese for its current context. Return a short inline label that fits above the source word.",
    ankiCard: "Create Anki cards for the clicked English word. Put an English example sentence for the target sense on the front and bold the target word. Put only the direct Simplified Chinese meaning for the current context on the back."
  },
  ai: {
    provider: "openai-responses",
    endpoint: "https://api.openai.com/v1/responses",
    reasoningEffort: "medium",
    requestTimeoutMs: 30_000
  },
  anki: {
    endpoint: "http://127.0.0.1:8765",
    deck: "Glossa",
    modelName: "Basic",
    requestTimeoutMs: 30_000,
    duplicatePromptMs: 5_000
  }
};
