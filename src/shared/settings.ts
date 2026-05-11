// @behavior glossa.settings_save.default_overrides Saved settings contain only normalized values that differ from the current defaults.
import {
  DEFAULT_SETTINGS,
  type AiSettings,
  type AnkiSettings,
  type AppearanceSettings,
  type GlossaSettings,
  type KnownWordListId,
  type PromptSettings
} from "./types";

// @constraint glossa.settings_save.default_overrides.stored_shape Stored settings keep top-level values and nested setting groups as optional override fields.
export type StoredGlossaSettings = Partial<Omit<GlossaSettings, "appearance" | "prompts" | "ai" | "anki">> & {
  // @constraint glossa.settings_save.default_overrides.stored_shape.appearance Stored settings keep appearance overrides as partial nested fields.
  appearance?: Partial<AppearanceSettings>;
  // @constraint glossa.settings_save.default_overrides.stored_shape.prompts Stored settings keep prompt overrides as partial nested fields.
  prompts?: Partial<PromptSettings>;
  // @constraint glossa.settings_save.default_overrides.stored_shape.ai Stored settings keep AI overrides as partial nested fields.
  ai?: Partial<AiSettings>;
  // @constraint glossa.settings_save.default_overrides.stored_shape.anki Stored settings keep Anki overrides as partial nested fields.
  anki?: Partial<AnkiSettings>;
};

// @behavior glossa.settings_save.default_overrides.merge Saved settings merge with the current defaults at read time so default updates reach unchanged fields.
export function mergeStoredSettings(value: StoredGlossaSettings | undefined): GlossaSettings {
  const stored = normalizeStoredSettings(value);
  const provider = stored?.ai?.provider ?? DEFAULT_SETTINGS.ai.provider;
  const endpoint = stored?.ai && "endpoint" in stored.ai ? stored.ai.endpoint : defaultEndpointForProvider(provider);
  return {
    ...DEFAULT_SETTINGS,
    ...stored,
    translateShortcutKey: stored?.translateShortcutKey ?? DEFAULT_SETTINGS.translateShortcutKey,
    autoTranslateEnabled: stored?.autoTranslateEnabled ?? DEFAULT_SETTINGS.autoTranslateEnabled,
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

// @behavior glossa.settings_save.default_overrides.write_filter Saving settings returns only values whose normalized form differs from the current defaults.
export function settingsOverrides(settings: GlossaSettings): StoredGlossaSettings {
  const overrides: StoredGlossaSettings = {};
  assignIfChanged(overrides, "shortcutKey", settings.shortcutKey, DEFAULT_SETTINGS.shortcutKey);
  assignIfChanged(overrides, "translateShortcutKey", settings.translateShortcutKey, DEFAULT_SETTINGS.translateShortcutKey);
  assignIfChanged(overrides, "autoTranslateEnabled", settings.autoTranslateEnabled, DEFAULT_SETTINGS.autoTranslateEnabled);
  assignIfChanged(overrides, "learningWindowDays", settings.learningWindowDays, DEFAULT_SETTINGS.learningWindowDays);
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

// @behavior glossa.settings_save.default_overrides.provider_endpoint_defaults Provider endpoint defaults follow the selected provider when no endpoint override is stored.
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

// @behavior glossa.settings_save.default_overrides.legacy_full Legacy full settings snapshots are reduced to default-diff overrides before merging with current defaults.
function normalizeStoredSettings(value: StoredGlossaSettings | undefined): StoredGlossaSettings | undefined {
  if (isLegacyFullSettings(value)) {
    return settingsOverrides(value);
  }
  return value;
}

function isLegacyFullSettings(value: StoredGlossaSettings | undefined): value is GlossaSettings {
  return Boolean(value?.appearance && value.prompts && value.ai && value.anki &&
    "shortcutKey" in value &&
    "translateShortcutKey" in value &&
    "autoTranslateEnabled" in value &&
    "learningWindowDays" in value &&
    "knownWordList" in value &&
    "promptVersion" in value &&
    "modelVersion" in value);
}

function isKnownWordList(value: unknown): value is KnownWordListId {
  return typeof value === "string" && ["junior-high", "senior-high", "cet4", "cet6", "toefl", "gre", "coca-20000"].includes(value);
}
