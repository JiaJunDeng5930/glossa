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
  key: string;
  lang: string;
  lemma: string;
  createdAt: number;
}

export interface TokenCandidate {
  id: string;
  sentenceId: string;
  surface: string;
  lemma: string;
  startOffset: number;
  endOffset: number;
  // A generation refresh may revisit a currently rendered known word; this flag stays inside the extension pipeline.
  forceRefresh?: boolean;
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

export interface GlossCacheEntry extends GlossItem {
  createdAt: number;
}

export type MessageSource = "content-script" | "service-worker" | "options";
export type MessageVersion = 1;
export type ErrorReason = "network" | "timeout" | "unauthorized" | "not-found" | "service-error" | "invalid-response" | "runtime";
export type ErrorService = "ai" | "anki" | "runtime";

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
  allowDuplicateCard?: boolean;
}

export interface WordClickedOkPayload {
  noteId?: number;
}

export interface WordCardDuplicatePayload {
  lang: string;
  lemma: string;
  surface: string;
  promptMs: number;
}

export type SettingsGetPayload = Record<string, never>;

export interface SettingsGetResponsePayload {
  settings: GlossaSettings;
}

export type GlossCacheClearPayload = Record<string, never>;
export type GlossCacheClearedPayload = Record<string, never>;
export type CardHistoryResetPayload = Record<string, never>;
export type CardHistoryResetOkPayload = Record<string, never>;

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
export type WordCardDuplicateMessage = MessageEnvelope<"word.card.duplicate", "service-worker", "content-script", WordCardDuplicatePayload>;
export type SettingsGetMessage = MessageEnvelope<"settings.get", "content-script", "service-worker", SettingsGetPayload>;
export type SettingsGetResponseMessage = MessageEnvelope<"settings.response", "service-worker", "content-script", SettingsGetResponsePayload>;
export type GlossCacheClearMessage = MessageEnvelope<"gloss.cache.clear", "options", "service-worker", GlossCacheClearPayload>;
export type GlossCacheClearedMessage = MessageEnvelope<"gloss.cache.cleared", "service-worker", "options", GlossCacheClearedPayload>;
// @behavior glossa.extension_contracts.card_history_reset The options page resets local card history through the service worker and receives an empty success response.
export type CardHistoryResetMessage = MessageEnvelope<"card.history.reset", "options", "service-worker", CardHistoryResetPayload>;
export type CardHistoryResetOkMessage = MessageEnvelope<"card.history.reset.ok", "service-worker", "options", CardHistoryResetOkPayload>;
export type ErrorMessage = MessageEnvelope<"error", "service-worker", "content-script", ErrorPayload>;
export type OptionsErrorMessage = MessageEnvelope<"error", "service-worker", "options", ErrorPayload>;

export type GlossPortInboundMessage = GlossScanStartMessage | GlossScanChunkMessage | GlossScanEndMessage;
export type GlossPortOutboundMessage = GlossTokenMessage | GlossDoneMessage | GlossPortErrorMessage | GlossChunkAckMessage;

export type ContentToBackgroundMessage = UserWordClickMessage | SettingsGetMessage;
export type OptionsToBackgroundMessage = GlossCacheClearMessage | CardHistoryResetMessage;
export type RuntimeToBackgroundMessage = ContentToBackgroundMessage | OptionsToBackgroundMessage;
export type BackgroundResponseMessage = WordClickedOkMessage | WordCardDuplicateMessage | SettingsGetResponseMessage | GlossCacheClearedMessage | CardHistoryResetOkMessage | ErrorMessage | OptionsErrorMessage;

export type AiProvider = "glossa-backend" | "openai-responses" | "openai-chat-completions" | "openai-completions";
export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
export const KNOWN_WORD_LIST_IDS = ["junior-high", "senior-high", "cet4", "cet6", "toefl", "gre", "coca-20000"] as const;
export type KnownWordListId = typeof KNOWN_WORD_LIST_IDS[number];

export const GLOSS_TARGET_LANG = "zh-CN";

export interface AiSettings {
  provider: AiProvider;
  endpoint: string;
  apiKey?: string;
  reasoningEffort: ReasoningEffort;
  requestTimeoutMs: number;
}

export interface AnkiSettings {
  endpoint: string;
  deck: string;
  modelName: string;
  requestTimeoutMs: number;
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
