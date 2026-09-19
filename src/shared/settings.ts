import { getAiProviderDescriptor } from "./aiProviders";
import { glossGenerationIdentity } from "../core/cache";
import { normalizeShortcut } from "./shortcut";
import { AI_PROVIDERS, DEFAULT_SETTINGS, KNOWN_WORD_LIST_IDS, REASONING_EFFORTS, type AiProvider, type AiSettings, type AnkiSettings, type AppearanceSettings, type GlossaSettings, type PromptSettings, type TranslationSettings, type JevSettings } from "./types";

export type SettingsPatch = Partial<Omit<GlossaSettings, "appearance" | "prompts" | "ai" | "anki" | "translation" | "jev">> & {
  translation?: Partial<TranslationSettings>;
  jev?: Partial<Omit<JevSettings, "apiKey">> & { apiKey?: string | null };
  appearance?: Partial<AppearanceSettings>; prompts?: Partial<PromptSettings>;
  ai?: Partial<Omit<AiSettings, "apiKey">> & { apiKey?: string | null }; anki?: Partial<AnkiSettings>;
};
export type StoredGlossaSettings = Omit<SettingsPatch, "ai" | "jev"> & { ai?: Partial<AiSettings>; jev?: Partial<JevSettings> };
type Rule<T> = { parse(value: unknown): T };
export interface SettingsNumberRule extends Rule<number> {
  readonly minimum: number;
  readonly maximum: number;
  readonly exclusiveMinimum: boolean;
}
type Rules<T> = { [K in keyof T]-?: T[K] extends object ? Rules<T[K]> : T[K] extends number ? SettingsNumberRule : Rule<T[K]> };
export class SettingsValidationError extends Error {
  constructor(readonly field: string) {
    super(`Invalid settings field: ${field}`);
    this.name = "SettingsValidationError";
  }
}

const invalid = (): never => { throw new Error("Invalid settings field"); };
const text: Rule<string> = { parse: v => typeof v === "string" && v.trim() ? v.trim() : invalid() };
const number = (minimum: number, maximum = Infinity, exclusiveMinimum = false): SettingsNumberRule => ({
  minimum,
  maximum,
  exclusiveMinimum,
  parse: value => typeof value === "number" && Number.isFinite(value)
    && (exclusiveMinimum ? value > minimum : value >= minimum) && value <= maximum ? value : invalid()
});
const choice = <T extends string>(values: readonly T[]): Rule<T> => ({ parse: v => typeof v === "string" && values.includes(v as T) ? v as T : invalid() });
const endpoint: Rule<string> = { parse(v) { const value = text.parse(v); const url = new URL(value); return ["http:", "https:"].includes(url.protocol) ? value : invalid(); } };
const shortcut: Rule<string> = { parse(v) { return typeof v === "string" ? normalizeShortcut(v) ?? invalid() : invalid(); } };
const color: Rule<string> = { parse: v => typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v) ? v : invalid() };
// This complete field tree drives boundary validation, stored-data repair, patches and persistence projection.
export const SETTINGS_RULES: Rules<GlossaSettings> = {
  shortcutKey: shortcut, translateShortcutKey: shortcut, autoTranslateEnabled: { parse: v => typeof v === "boolean" ? v : invalid() },
  learningWindowDays: number(1), glossCacheTtlMs: number(0, Infinity, true), knownWordList: choice(KNOWN_WORD_LIST_IDS), promptVersion: text, modelVersion: text,
  appearance: { textColor: color, backgroundColor: color, cardSuccessBackgroundColor: color, cardErrorBackgroundColor: color, backgroundOpacity: number(0.2, 1), fontFamily: text, fontSize: number(9,24) },
  prompts: { gloss: text, ankiCard: text },
  translation: { mode: choice(["llm", "dictionary-jev"] as const), fallbackToLlm: { parse: v => typeof v === "boolean" ? v : invalid() } },
  jev: { endpoint, apiKey: { parse: v => v === undefined || v === null ? undefined : typeof v === "string" ? v.trim() || undefined : invalid() }, model: text, requestTimeoutMs: number(1000) },
  ai: { provider: choice(AI_PROVIDERS), endpoint, apiKey: { parse: v => v === undefined || v === null ? undefined : typeof v === "string" ? v.trim() || undefined : invalid() }, reasoningEffort: choice(REASONING_EFFORTS), requestTimeoutMs: number(1000) },
  anki: { endpoint, deck: text, modelName: text, requestTimeoutMs: number(1000), duplicatePromptMs: number(1000) }
};
type Tree = { [key:string]: Tree | Rule<unknown> };
function object(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function walk(schema: Tree, value: unknown, defaults: Record<string, unknown> = {}, mode: "repair" | "full" | "patch", path = ""): Record<string, unknown> {
  if (!object(value)) { if (mode !== "repair") throw new Error(`Invalid settings group: ${path}`); value = {}; }
  const input = value as Record<string, unknown>;
  if (mode !== "repair") for (const key of Object.keys(input)) if (!Object.hasOwn(schema, key)) throw new Error(`Unknown settings field: ${path}${key}`);
  const result: Record<string, unknown> = {};
  for (const [key, rule] of Object.entries(schema)) {
    if (mode === "patch" && !(key in input)) continue;
    if (typeof rule.parse !== "function") { result[key] = walk(rule as Tree, input[key], defaults[key] as Record<string, unknown>, mode, `${path}${key}.`); continue; }
    const parser = rule as Rule<unknown>;
    try {
      if (mode === "full" && !(key in input) && key !== "apiKey") invalid();
      if (input[key] === null && !(mode === "patch" && (path === "ai." || path === "jev.") && key === "apiKey")) invalid();
      const parsed = parser.parse(input[key]);
      if (parsed !== undefined) result[key] = parsed;
      else if (mode === "patch") result[key] = null;
    } catch {
      if (mode !== "repair") throw new SettingsValidationError(`${path}${key}`);
      if (defaults[key] !== undefined) result[key] = defaults[key];
    }
  }
  return result;
}
function defaultsFor(raw: unknown): GlossaSettings {
  let provider = DEFAULT_SETTINGS.ai.provider;
  try { if (object(raw) && object(raw.ai)) provider = SETTINGS_RULES.ai.provider.parse(raw.ai.provider); } catch { /* Stored invalid provider uses the default provider. */ }
  return { ...DEFAULT_SETTINGS, ai: { ...DEFAULT_SETTINGS.ai, endpoint: defaultEndpointForProvider(provider) } };
}
export function normalizeSettings(raw: unknown): GlossaSettings { return walk(SETTINGS_RULES as Tree, raw, defaultsFor(raw) as unknown as Record<string,unknown>, "repair") as unknown as GlossaSettings; }
export const mergeStoredSettings = normalizeSettings;
export function validateSettings(raw: unknown): GlossaSettings { return walk(SETTINGS_RULES as Tree, raw, {}, "full") as unknown as GlossaSettings; }
export function validateSettingsPatch(raw: unknown): SettingsPatch { return walk(SETTINGS_RULES as Tree, raw, {}, "patch") as SettingsPatch; }
export function applySettingsPatch(current: GlossaSettings, raw: SettingsPatch): GlossaSettings {
  const patch = validateSettingsPatch(raw);
  const ai = { ...current.ai, ...patch.ai };
  if (patch.ai?.provider && patch.ai.endpoint === undefined) {
    ai.endpoint = endpointForProviderChange(current.ai.provider, patch.ai.provider, current.ai.endpoint);
  }
  if (ai.apiKey === null) delete ai.apiKey;
  const jev = { ...current.jev, ...patch.jev };
  if (jev.apiKey === null) delete jev.apiKey;
  return validateSettings({ ...current, ...patch, appearance: { ...current.appearance, ...patch.appearance }, prompts: { ...current.prompts, ...patch.prompts }, translation: { ...current.translation, ...patch.translation }, ai, jev, anki: { ...current.anki, ...patch.anki } });
}
function difference(schema: Tree, base: Record<string,unknown>, next: Record<string,unknown>, deletion: boolean): Record<string,unknown> {
  const result: Record<string,unknown> = {};
  for (const [key, rule] of Object.entries(schema)) {
    if (typeof rule.parse !== "function") { const group = difference(rule as Tree, base[key] as Record<string,unknown>, next[key] as Record<string,unknown>, deletion); if (Object.keys(group).length) result[key] = group; }
    else if (base[key] !== next[key] && (next[key] !== undefined || deletion)) result[key] = next[key] ?? null;
  }
  return result;
}
export function diffSettings(base: GlossaSettings, draft: GlossaSettings): SettingsPatch { return difference(SETTINGS_RULES as Tree, base as unknown as Record<string,unknown>, draft as unknown as Record<string,unknown>, true) as SettingsPatch; }
export function settingsOverrides(settings: GlossaSettings): StoredGlossaSettings { const normalized = validateSettings(settings); return difference(SETTINGS_RULES as Tree, defaultsFor(normalized) as unknown as Record<string,unknown>, normalized as unknown as Record<string,unknown>, false) as StoredGlossaSettings; }
export function glossOutputSettingsChanged(previous: GlossaSettings, next: GlossaSettings): boolean { return glossGenerationIdentity(previous) !== glossGenerationIdentity(next); }
export function defaultEndpointForProvider(provider: AiProvider): string {
  return getAiProviderDescriptor(provider).defaultEndpoint;
}
export function endpointForProviderChange(previousProvider: AiProvider, nextProvider: AiProvider, endpoint: string): string {
  return !endpoint.trim() || endpoint === defaultEndpointForProvider(previousProvider)
    ? defaultEndpointForProvider(nextProvider)
    : endpoint;
}
export function aiConnectionKey(value: GlossaSettings): string { return JSON.stringify([value.ai.provider,value.ai.endpoint,value.ai.apiKey ?? "",value.modelVersion,value.ai.reasoningEffort,value.ai.requestTimeoutMs]); }
export function ankiConnectionKey(value: GlossaSettings): string { return JSON.stringify([value.anki.endpoint,value.anki.deck,value.anki.modelName,value.anki.requestTimeoutMs]); }

export function jevConnectionKey(value: GlossaSettings): string { return JSON.stringify([value.jev.endpoint, value.jev.apiKey ?? "", value.jev.model, value.jev.requestTimeoutMs]); }
