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

// @constraint glossa.extension_contracts.message_envelopes.sources Runtime envelopes use extension-owned message sources.
export type MessageSource = "content-script" | "service-worker" | "options";
// @constraint glossa.extension_contracts.message_envelopes.version Runtime envelopes use the current protocol version literal.
export type MessageVersion = 1;
// @constraint glossa.extension_contracts.message_envelopes.error_payload.reason Runtime error payload reasons use the shared diagnostic reason set.
export type ErrorReason = "network" | "timeout" | "unauthorized" | "not-found" | "service-error" | "invalid-response" | "runtime";
// @constraint glossa.extension_contracts.message_envelopes.error_payload.service Runtime error payload services identify the failing integration surface.
export type ErrorService = "ai" | "anki" | "runtime";

// @constraint glossa.extension_contracts.message_envelopes.envelope_shape Runtime envelopes carry type, version, request id, source, target, creation time, and payload.
export interface MessageEnvelope<TType extends string, TSource extends MessageSource, TTarget extends MessageSource, TPayload> {
  type: TType;
  version: MessageVersion;
  requestId: string;
  source: TSource;
  target: TTarget;
  createdAt: number;
  payload: TPayload;
}

export interface GlossScanStartPayload {
  // @constraint glossa.extension_contracts.message_envelopes.gloss_scan_start.scan_id Start messages identify the scan session.
  scanId: string;
  // @constraint glossa.extension_contracts.message_envelopes.gloss_scan_start.page_url Start messages identify the scanned page URL.
  pageUrl: string;
}

export interface GlossScanChunkPayload {
  // @constraint glossa.extension_contracts.message_envelopes.gloss_scan_chunk.scan_id Chunk messages identify their scan session.
  scanId: string;
  // @constraint glossa.extension_contracts.message_envelopes.gloss_scan_chunk.chunk_id Chunk messages identify their backpressure unit.
  chunkId: string;
  // @constraint glossa.extension_contracts.message_envelopes.gloss_scan_chunk.chunk_index Chunk messages carry their zero-based order within the scan.
  chunkIndex: number;
  // @constraint glossa.extension_contracts.message_envelopes.gloss_scan_chunk.page_url Chunk messages identify the page URL used by lookup and traces.
  pageUrl: string;
  // @constraint glossa.extension_contracts.message_envelopes.gloss_scan_chunk.sentences Chunk messages carry the sentence candidates for that batch.
  sentences: SentenceCandidate[];
}

export interface GlossScanEndPayload {
  // @constraint glossa.extension_contracts.message_envelopes.gloss_scan_end.payload_scan_id End messages identify the scan session to finish.
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

// @constraint glossa.extension_contracts.message_envelopes.gloss_port_inbound Gloss ports accept start, chunk, and end messages from content scan sessions.
export type GlossPortInboundMessage = GlossScanStartMessage | GlossScanChunkMessage | GlossScanEndMessage;
export type GlossPortOutboundMessage = GlossTokenMessage | GlossDoneMessage | GlossPortErrorMessage | GlossChunkAckMessage;

export type ContentToBackgroundMessage = UserWordClickMessage | SettingsGetMessage;
export type OptionsToBackgroundMessage = GlossCacheClearMessage;
export type RuntimeToBackgroundMessage = ContentToBackgroundMessage | OptionsToBackgroundMessage;
// @constraint glossa.extension_contracts.payload_consistency.duplicate_response Background responses include duplicate-card prompts alongside success, settings, and error envelopes.
export type BackgroundResponseMessage = WordClickedOkMessage | WordCardDuplicateMessage | SettingsGetResponseMessage | GlossCacheClearedMessage | ErrorMessage | OptionsErrorMessage;

export type AiProvider = "glossa-backend" | "openai-responses" | "openai-chat-completions" | "openai-completions";
export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
// @constraint glossa.word_memory.known_word_filter.ids Known-word filter ids are the shared source of truth for settings validation and lexicon metadata.
export const KNOWN_WORD_LIST_IDS = ["junior-high", "senior-high", "cet4", "cet6", "toefl", "gre", "coca-20000"] as const;
// @constraint glossa.word_memory.known_word_filter.id_type The known-word filter id type is derived from the shared id tuple.
export type KnownWordListId = typeof KNOWN_WORD_LIST_IDS[number];

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
