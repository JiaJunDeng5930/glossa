// @behavior glossa Activated pages show inline Chinese glosses for unfamiliar English words and remember vocabulary decisions.
// @constraint glossa.runtime Every extension context uses the same message, diagnostic, shortcut, error, and user-message rules.
// @intent glossa.runtime.contracts The shared payload boundary exists to keep runtime messages and persisted records consistent across extension contexts.
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
}

export interface WordClickedOkPayload {
  noteId?: number;
  noteIds?: number[];
}

export type SettingsGetPayload = Record<string, never>;

export interface SettingsGetResponsePayload {
  settings: GlossaSettings;
}

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
export type SettingsGetMessage = MessageEnvelope<"settings.get", "content-script", "service-worker", SettingsGetPayload>;
export type SettingsGetResponseMessage = MessageEnvelope<"settings.response", "service-worker", "content-script", SettingsGetResponsePayload>;
export type ErrorMessage = MessageEnvelope<"error", "service-worker", "content-script", ErrorPayload>;

export type GlossPortInboundMessage = GlossScanMessage | GlossScanStartMessage | GlossScanChunkMessage | GlossScanEndMessage;
export type GlossPortOutboundMessage = GlossTokenMessage | GlossDoneMessage | GlossPortErrorMessage | GlossChunkAckMessage;

export type ContentToBackgroundMessage = UserWordClickMessage | SettingsGetMessage;
export type BackgroundResponseMessage = WordClickedOkMessage | SettingsGetResponseMessage | ErrorMessage;

export type AiProvider = "glossa-backend" | "openai-responses" | "openai-chat-completions" | "openai-completions";
export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
export type KnownWordListId = "junior-high" | "senior-high" | "cet4" | "cet6" | "toefl" | "gre" | "coca-20000";

export const GLOSS_TARGET_LANG = "zh-CN";

export interface AiSettings {
  provider: AiProvider;
  endpoint: string;
  apiKey?: string;
  reasoningEffort: ReasoningEffort;
}

export interface AnkiSettings {
  endpoint: string;
  deck: string;
  modelName: string;
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
  knownWordList: "junior-high",
  promptVersion: "gloss-v1",
  modelVersion: "gpt-4.1-mini",
  appearance: {
    textColor: "#ffffff",
    backgroundColor: "#0f172a",
    cardSuccessBackgroundColor: "#16a34a",
    cardErrorBackgroundColor: "#dc2626",
    backgroundOpacity: 0.9,
    fontFamily: "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif",
    fontSize: 11
  },
  prompts: {
    gloss: "只把每个陌生英文单词或短语在当前语境中的意思翻译成简体中文。返回适合显示在原词上方的简短行内标签。",
    ankiCard: "为点击的英文单词制作 Anki 卡片。正面写目标词汇在对应含义下的例句，并加粗目标词汇；背面写这个词汇在当前语境中的简体中文翻译。"
  },
  ai: {
    provider: "openai-responses",
    endpoint: "https://api.openai.com/v1/responses",
    reasoningEffort: "medium"
  },
  anki: {
    endpoint: "http://127.0.0.1:8765",
    deck: "Glossa",
    modelName: "Basic"
  }
};
