import {
  DEFAULT_SETTINGS,
  KNOWN_WORD_LIST_IDS,
  type AiSettings,
  type AnkiSettings,
  type AppearanceSettings,
  type GlossaSettings,
  type KnownWordListId,
  type PromptSettings
} from "./types";

export type StoredGlossaSettings = Partial<Omit<GlossaSettings, "appearance" | "prompts" | "ai" | "anki">> & {
  appearance?: Partial<AppearanceSettings>;
  prompts?: Partial<PromptSettings>;
  ai?: Partial<AiSettings>;
  anki?: Partial<AnkiSettings>;
};

export function mergeStoredSettings(value: StoredGlossaSettings | undefined): GlossaSettings {
  const stored = value;
  const provider = stored?.ai?.provider ?? DEFAULT_SETTINGS.ai.provider;
  const endpoint = stored?.ai && "endpoint" in stored.ai ? stored.ai.endpoint : defaultEndpointForProvider(provider);
  return {
    ...DEFAULT_SETTINGS,
    ...stored,
    translateShortcutKey: stored?.translateShortcutKey ?? DEFAULT_SETTINGS.translateShortcutKey,
    autoTranslateEnabled: stored?.autoTranslateEnabled ?? DEFAULT_SETTINGS.autoTranslateEnabled,
    glossCacheTtlMs: positiveNumber(stored?.glossCacheTtlMs, DEFAULT_SETTINGS.glossCacheTtlMs),
    knownWordList: isKnownWordList(stored?.knownWordList) ? stored.knownWordList : DEFAULT_SETTINGS.knownWordList,
    appearance: { ...DEFAULT_SETTINGS.appearance, ...stored?.appearance },
    prompts: { ...DEFAULT_SETTINGS.prompts, ...stored?.prompts },
    ai: {
      ...DEFAULT_SETTINGS.ai,
      ...stored?.ai,
      provider,
      endpoint: endpoint || defaultEndpointForProvider(provider)
    },
    anki: { ...DEFAULT_SETTINGS.anki, ...stored?.anki }
  };
}

export function settingsOverrides(settings: GlossaSettings): StoredGlossaSettings {
  const overrides: StoredGlossaSettings = {};
  assignIfChanged(overrides, "shortcutKey", settings.shortcutKey, DEFAULT_SETTINGS.shortcutKey);
  assignIfChanged(overrides, "translateShortcutKey", settings.translateShortcutKey, DEFAULT_SETTINGS.translateShortcutKey);
  assignIfChanged(overrides, "autoTranslateEnabled", settings.autoTranslateEnabled, DEFAULT_SETTINGS.autoTranslateEnabled);
  assignIfChanged(overrides, "learningWindowDays", settings.learningWindowDays, DEFAULT_SETTINGS.learningWindowDays);
  assignIfChanged(overrides, "glossCacheTtlMs", settings.glossCacheTtlMs, DEFAULT_SETTINGS.glossCacheTtlMs);
  assignIfChanged(overrides, "knownWordList", settings.knownWordList, DEFAULT_SETTINGS.knownWordList);
  assignIfChanged(overrides, "promptVersion", settings.promptVersion, DEFAULT_SETTINGS.promptVersion);
  assignIfChanged(overrides, "modelVersion", settings.modelVersion, DEFAULT_SETTINGS.modelVersion);

  const appearance = pickChanged(settings.appearance, DEFAULT_SETTINGS.appearance);
  if (hasKeys(appearance)) {
    overrides.appearance = appearance;
  }

  const prompts = pickChanged(settings.prompts, DEFAULT_SETTINGS.prompts);
  if (hasKeys(prompts)) {
    overrides.prompts = prompts;
  }

  const ai = pickChanged(settings.ai, {
    ...DEFAULT_SETTINGS.ai,
    endpoint: defaultEndpointForProvider(settings.ai.provider)
  });
  if (hasKeys(ai)) {
    overrides.ai = ai;
  }

  const anki = pickChanged(settings.anki, DEFAULT_SETTINGS.anki);
  if (hasKeys(anki)) {
    overrides.anki = anki;
  }

  return overrides;
}

export function glossOutputSettingsChanged(previous: GlossaSettings, next: GlossaSettings): boolean {
  return previous.promptVersion !== next.promptVersion
    || previous.modelVersion !== next.modelVersion
    || previous.prompts.gloss !== next.prompts.gloss
    || previous.ai.provider !== next.ai.provider
    || previous.ai.endpoint !== next.ai.endpoint
    || previous.ai.apiKey !== next.ai.apiKey
    || previous.ai.reasoningEffort !== next.ai.reasoningEffort;
}

export function defaultEndpointForProvider(provider: GlossaSettings["ai"]["provider"]): string {
  if (provider === "openai-chat-completions") {
    return "https://api.openai.com/v1/chat/completions";
  }
  if (provider === "openai-completions") {
    return "https://api.openai.com/v1/completions";
  }
  if (provider === "glossa-backend") {
    return "http://127.0.0.1:8787";
  }
  return DEFAULT_SETTINGS.ai.endpoint;
}

function pickChanged<T extends object>(value: T, defaults: T): Partial<T> {
  const result: Partial<T> = {};
  for (const key of Object.keys(value) as Array<keyof T>) {
    if (value[key] !== defaults[key]) {
      result[key] = value[key];
    }
  }
  return result;
}

function assignIfChanged<T extends keyof StoredGlossaSettings>(
  target: StoredGlossaSettings,
  key: T,
  value: StoredGlossaSettings[T],
  defaultValue: StoredGlossaSettings[T]
): void {
  if (value !== defaultValue) {
    target[key] = value;
  }
}

function hasKeys(value: object): boolean {
  return Object.keys(value).length > 0;
}

function positiveNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function isKnownWordList(value: unknown): value is KnownWordListId {
  return typeof value === "string" && (KNOWN_WORD_LIST_IDS as readonly string[]).includes(value);
}
