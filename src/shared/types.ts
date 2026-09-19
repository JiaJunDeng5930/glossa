import { DEFAULT_AI_PROVIDER, getAiProviderDescriptor, type AiProvider } from "./aiProviders";
export { AI_PROVIDERS, type AiProvider } from "./aiProviders";
import type { RuntimeToBackgroundMessage, BackgroundResponseMessage, RequestMessage } from "./messages";
export type { RuntimeToBackgroundMessage, BackgroundResponseMessage } from "./messages";
import type { KnownWordListId } from "./knownWordLists";
export { KNOWN_WORD_LIST_IDS, type KnownWordListId } from "./knownWordLists";

export type VocabularyState = "known" | "learning_active" | "ignored" | "candidate";

export interface VocabularyRecord {
  key: string;
  lemma: string;
  surface: string;
  lang: string;
  state: VocabularyState;
  expiresAt?: number;
  lastShownAt?: number;
  lastClickedAt?: number;
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
}

export interface GlossCacheEntry extends GlossItem {
  createdAt: number;
}

export type MessageSource = "content-script" | "service-worker" | "options" | "onboarding" | "popup";
export type MessageVersion = 1;
export type ErrorReason = "network" | "timeout" | "unauthorized" | "not-found" | "service-error" | "invalid-response" | "runtime" | "outcome-unknown";
export type ErrorService = "ai" | "jev" | "dictionary" | "anki" | "runtime";

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
  scanConfigHash: string;
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

export type GlossOutcome = { status: "ready"; item: GlossItem }
  | { status: "pending" }
  | { status: "hidden" }
  | { status: "error"; error: ErrorPayload };
export type GlossTokenOutcome = { tokenId: string } & GlossOutcome;
export type GlossTokenPayload = { scanId: string } & GlossTokenOutcome;

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
  noteId: number;
}

export interface WordCardDuplicatePayload {
  lang: string;
  lemma: string;
  surface: string;
  promptMs: number;
}

export const ERROR_CODES = ["dictionary-word-not-found", "anki-deck-not-found", "anki-model-not-found", "anki-no-compatible-model", "anki-empty-card"] as const;
export type ErrorCode = typeof ERROR_CODES[number];

export interface ErrorPayload {
  code?: ErrorCode;
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
export type UserWordClickMessage = RequestMessage<"word.clicked">;
export type SettingsGetMessage = RequestMessage<"settings.get">;
export type ContentToBackgroundMessage = Extract<RuntimeToBackgroundMessage, {source:"content-script"}>;
export type OptionsToBackgroundMessage = Extract<RuntimeToBackgroundMessage, {source:"options"}>;
export type ErrorMessage = Extract<BackgroundResponseMessage, {type:"error"}>;
export type OptionsErrorMessage = ErrorMessage;
export type GlossPortInboundMessage = GlossScanStartMessage | GlossScanChunkMessage | GlossScanEndMessage;
export type GlossPortOutboundMessage = GlossTokenMessage | GlossDoneMessage | GlossPortErrorMessage | GlossChunkAckMessage;

export const REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh"] as const;
export type ReasoningEffort = typeof REASONING_EFFORTS[number];

export const GLOSS_TARGET_LANG = "zh-CN";

export interface AiSettings {
  provider: AiProvider;
  endpoint: string;
  apiKey?: string;
  reasoningEffort: ReasoningEffort;
  requestTimeoutMs: number;
}

export type TranslationMode = "llm" | "dictionary-jev";

export interface TranslationSettings {
  mode: TranslationMode;
  fallbackToLlm: boolean;
}

export interface JevSettings {
  endpoint: string;
  apiKey?: string;
  model: string;
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
  translation: TranslationSettings;
  jev: JevSettings;
  anki: AnkiSettings;
}

export interface AnkiCard {
  front: string;
  back: string;
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
  translation: { mode: "llm", fallbackToLlm: false },
  jev: {
    endpoint: "https://api.typesafe.ai/v1/systemone",
    model: "jev-latest",
    requestTimeoutMs: 30_000
  },
  ai: {
    provider: DEFAULT_AI_PROVIDER,
    endpoint: getAiProviderDescriptor(DEFAULT_AI_PROVIDER).defaultEndpoint,
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
