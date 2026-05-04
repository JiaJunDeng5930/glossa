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

export interface GlossRequestMessage {
  type: "gloss.request";
  pageUrl: string;
  sentences: SentenceCandidate[];
}

export interface GlossResponseMessage {
  type: "gloss.response";
  items: GlossItem[];
}

export interface UserWordClickMessage {
  type: "word.clicked";
  pageUrl: string;
  sentence: string;
  token: TokenCandidate;
}

export interface WordClickedOkMessage {
  type: "word.clicked.ok";
  noteId?: number;
}

export interface SettingsGetMessage {
  type: "settings.get";
}

export interface SettingsGetResponseMessage {
  type: "settings.response";
  settings: GlossaSettings;
}

export interface ErrorMessage {
  type: "error";
  message: string;
}

export type ContentToBackgroundMessage = GlossRequestMessage | UserWordClickMessage | SettingsGetMessage;
export type BackgroundResponseMessage = GlossResponseMessage | WordClickedOkMessage | SettingsGetResponseMessage | ErrorMessage;

export type AiProvider = "glossa-backend" | "openai-responses" | "openai-chat-completions" | "openai-completions";
export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh";

export interface AiSettings {
  provider: AiProvider;
  endpoint: string;
  apiKey?: string;
  reasoningEffort: ReasoningEffort;
}

export interface AnkiSettings {
  endpoint: string;
  deck: string;
}

export interface AppearanceSettings {
  textColor: string;
  backgroundColor: string;
  backgroundOpacity: number;
  fontFamily: string;
  fontSize: number;
}

export interface PromptSettings {
  gloss: string;
  ankiCard: string;
}

export interface GlossaSettings {
  targetLang: string;
  shortcutKey: string;
  learningWindowDays: number;
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
  examples: string[];
}

export const DEFAULT_SETTINGS: GlossaSettings = {
  targetLang: "zh-CN",
  shortcutKey: "Alt",
  learningWindowDays: 3,
  promptVersion: "gloss-v1",
  modelVersion: "gpt-4.1-mini",
  appearance: {
    textColor: "#ffffff",
    backgroundColor: "#0f172a",
    backgroundOpacity: 0.9,
    fontFamily: "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif",
    fontSize: 11
  },
  prompts: {
    gloss: "Translate only the contextual meaning of each unfamiliar English word or phrase into the target language. Return short inline labels that fit above the source word.",
    ankiCard: "Create concise Anki Basic card fields for the clicked English word in the sentence. Cover common meanings, the contextual meaning, and one natural example."
  },
  ai: {
    provider: "openai-responses",
    endpoint: "https://api.openai.com/v1/responses",
    reasoningEffort: "medium"
  },
  anki: {
    endpoint: "http://127.0.0.1:8765",
    deck: "Glossa"
  }
};
