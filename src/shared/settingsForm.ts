import { KNOWN_WORD_LISTS } from "../core/lexicon";
import { createDiagnosticError, diagnosticErrorFrom, errorPayloadFromHttpStatus, requestDiagnosticErrorFrom } from "./errors";
import { defaultEndpointForProvider } from "./settings";
import {
  DEFAULT_SETTINGS,
  GLOSS_TARGET_LANG,
  KNOWN_WORD_LIST_IDS,
  type AiProvider,
  type AppearanceSettings,
  type ErrorService,
  type GlossaSettings,
  type KnownWordListId,
  type ReasoningEffort
} from "./types";
import { userMessageForError } from "./userMessages";

type SettingsControl = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
export type TestState = "idle" | "loading" | "success" | "error";

export interface AnkiCatalog {
  decks: string[];
  modelNames: string[];
}

interface AnkiActionResponse<T> {
  result?: T;
  error?: string | null;
}

export interface AppearancePreviewTargets {
  preview: HTMLElement;
  labels: HTMLElement[];
  successLabels: HTMLElement[];
  errorLabels: HTMLElement[];
}

export function readSettingsForm(form: HTMLFormElement, base: GlossaSettings = DEFAULT_SETTINGS): GlossaSettings {
  const provider = aiProvider(readOptionalInput(form, "provider"), base.ai.provider);
  const apiKeyValue = readOptionalInput(form, "apiKey");
  const ai = {
    ...base.ai,
    provider,
    endpoint: readOptionalInput(form, "aiEndpoint")?.trim() || (hasControl(form, "provider") ? defaultEndpointForProvider(provider) : base.ai.endpoint),
    reasoningEffort: reasoningEffort(readOptionalInput(form, "reasoningEffort"), base.ai.reasoningEffort),
    requestTimeoutMs: hasControl(form, "aiRequestTimeoutSeconds")
      ? secondsToMs(readFormInput(form, "aiRequestTimeoutSeconds"), base.ai.requestTimeoutMs)
      : base.ai.requestTimeoutMs
  };
  if (apiKeyValue !== undefined) {
    const apiKey = apiKeyValue.trim();
    if (apiKey) {
      ai.apiKey = apiKey;
    } else {
      delete ai.apiKey;
    }
  }
  const fontSize = hasControl(form, "glossFontSize")
    ? Math.max(9, Math.min(24, Number(readFormInput(form, "glossFontSize")) || base.appearance.fontSize))
    : base.appearance.fontSize;
  return {
    shortcutKey: readOptionalInput(form, "shortcutKey")?.trim() || base.shortcutKey,
    translateShortcutKey: readOptionalInput(form, "translateShortcutKey")?.trim() || base.translateShortcutKey,
    autoTranslateEnabled: hasControl(form, "autoTranslateEnabled") ? readFormCheckbox(form, "autoTranslateEnabled") : base.autoTranslateEnabled,
    learningWindowDays: hasControl(form, "learningWindowDays")
      ? Math.max(1, Number(readFormInput(form, "learningWindowDays")) || base.learningWindowDays)
      : base.learningWindowDays,
    glossCacheTtlMs: hasControl(form, "glossCacheTtlHours")
      ? hoursToMs(readFormInput(form, "glossCacheTtlHours"), base.glossCacheTtlMs)
      : base.glossCacheTtlMs,
    knownWordList: readKnownWordList(form, base.knownWordList),
    promptVersion: base.promptVersion,
    modelVersion: readOptionalInput(form, "modelVersion")?.trim() || base.modelVersion,
    appearance: {
      textColor: readOptionalInput(form, "glossTextColor") || base.appearance.textColor,
      backgroundColor: readOptionalInput(form, "glossBackgroundColor") || base.appearance.backgroundColor,
      cardSuccessBackgroundColor: readOptionalInput(form, "cardSuccessBackgroundColor") || base.appearance.cardSuccessBackgroundColor,
      cardErrorBackgroundColor: readOptionalInput(form, "cardErrorBackgroundColor") || base.appearance.cardErrorBackgroundColor,
      backgroundOpacity: hasControl(form, "glossBackgroundOpacity")
        ? clamp(Number(readFormInput(form, "glossBackgroundOpacity")) || base.appearance.backgroundOpacity, 0.2, 1)
        : base.appearance.backgroundOpacity,
      fontFamily: readOptionalInput(form, "glossFontFamily") || base.appearance.fontFamily,
      fontSize
    },
    prompts: {
      gloss: readOptionalInput(form, "glossPrompt")?.trim() || base.prompts.gloss,
      ankiCard: readOptionalInput(form, "ankiPrompt")?.trim() || base.prompts.ankiCard
    },
    ai,
    anki: {
      endpoint: readOptionalInput(form, "ankiEndpoint")?.trim() || base.anki.endpoint,
      deck: readOptionalInput(form, "ankiDeck")?.trim() || base.anki.deck,
      modelName: readOptionalInput(form, "ankiModelName")?.trim() || base.anki.modelName,
      requestTimeoutMs: hasControl(form, "ankiRequestTimeoutSeconds")
        ? secondsToMs(readFormInput(form, "ankiRequestTimeoutSeconds"), base.anki.requestTimeoutMs)
        : base.anki.requestTimeoutMs,
      duplicatePromptMs: hasControl(form, "duplicatePromptSeconds")
        ? secondsToMs(readFormInput(form, "duplicatePromptSeconds"), base.anki.duplicatePromptMs)
        : base.anki.duplicatePromptMs
    }
  };
}

export function writeSettingsForm(form: HTMLFormElement, settings: GlossaSettings): void {
  setFormInput(form, "shortcutKey", settings.shortcutKey);
  setFormInput(form, "translateShortcutKey", settings.translateShortcutKey);
  setFormChecked(form, "autoTranslateEnabled", settings.autoTranslateEnabled);
  setFormInput(form, "learningWindowDays", String(settings.learningWindowDays));
  setFormInput(form, "glossCacheTtlHours", String(msToHours(settings.glossCacheTtlMs)));
  setFormInput(form, "knownWordList", settings.knownWordList);
  setFormInput(form, "glossTextColor", settings.appearance.textColor);
  setFormInput(form, "glossBackgroundColor", settings.appearance.backgroundColor);
  setFormInput(form, "cardSuccessBackgroundColor", settings.appearance.cardSuccessBackgroundColor);
  setFormInput(form, "cardErrorBackgroundColor", settings.appearance.cardErrorBackgroundColor);
  setFormInput(form, "glossBackgroundOpacity", String(settings.appearance.backgroundOpacity));
  setFormInput(form, "glossFontFamily", settings.appearance.fontFamily);
  setFormInput(form, "glossFontSize", String(settings.appearance.fontSize));
  setFormInput(form, "provider", settings.ai.provider);
  setFormInput(form, "aiEndpoint", settings.ai.endpoint);
  setFormInput(form, "apiKey", settings.ai.apiKey ?? "");
  setFormInput(form, "reasoningEffort", settings.ai.reasoningEffort);
  setFormInput(form, "aiRequestTimeoutSeconds", String(msToSeconds(settings.ai.requestTimeoutMs)));
  setFormInput(form, "modelVersion", settings.modelVersion);
  setFormInput(form, "ankiEndpoint", settings.anki.endpoint);
  setFormInput(form, "ankiRequestTimeoutSeconds", String(msToSeconds(settings.anki.requestTimeoutMs)));
  setFormInput(form, "duplicatePromptSeconds", String(msToSeconds(settings.anki.duplicatePromptMs)));
  setFormInput(form, "glossPrompt", settings.prompts.gloss);
  setFormInput(form, "ankiPrompt", settings.prompts.ankiCard);
}

export function populateKnownWordSelect(select: HTMLSelectElement): void {
  select.replaceChildren(...KNOWN_WORD_LISTS.map((list) => {
    const option = document.createElement("option");
    option.value = list.id;
    option.textContent = list.label;
    return option;
  }));
}

export function applyAppearancePreview(targets: AppearancePreviewTargets, appearance: AppearanceSettings): void {
  targets.preview.style.fontFamily = appearance.fontFamily;
  for (const label of targets.labels) {
    label.style.color = appearance.textColor;
    label.style.backgroundColor = hexToRgb(appearance.backgroundColor, appearance.backgroundOpacity);
    label.style.fontFamily = appearance.fontFamily;
    label.style.fontSize = `${appearance.fontSize}px`;
  }
  for (const label of targets.successLabels) {
    label.style.backgroundColor = hexToRgb(appearance.cardSuccessBackgroundColor, appearance.backgroundOpacity);
  }
  for (const label of targets.errorLabels) {
    label.style.backgroundColor = hexToRgb(appearance.cardErrorBackgroundColor, appearance.backgroundOpacity);
  }
}

export function aiConnectionKey(value: GlossaSettings): string {
  return JSON.stringify([
    value.ai.provider,
    value.ai.endpoint,
    value.ai.apiKey ?? "",
    value.modelVersion,
    value.ai.reasoningEffort,
    value.ai.requestTimeoutMs
  ]);
}

export function ankiConnectionKey(value: GlossaSettings): string {
  return JSON.stringify([
    value.anki.endpoint,
    value.anki.deck,
    value.anki.modelName,
    value.anki.requestTimeoutMs
  ]);
}

export async function testAiSettings(settings: GlossaSettings): Promise<void> {
  // This check confirms that the configured transport accepts a request; normal gloss and card calls validate their own output contracts.
  const endpoint = settings.ai.provider === "glossa-backend"
    ? `${settings.ai.endpoint.replace(/\/+$/, "")}/gloss`
    : settings.ai.endpoint;
  const body = settings.ai.provider === "glossa-backend"
    ? {
      items: [],
      targetLang: GLOSS_TARGET_LANG,
      prompt: settings.prompts.gloss,
      reasoningEffort: settings.ai.reasoningEffort,
      promptVersion: settings.promptVersion,
      modelVersion: settings.modelVersion
    }
    : settings.ai.provider === "openai-chat-completions"
      ? {
        model: settings.modelVersion,
        messages: [
          { role: "developer", content: "Return strict JSON only." },
          { role: "user", content: "Return {\"items\":[]} as JSON." }
        ],
        ...reasoningBody(settings)
      }
      : settings.ai.provider === "openai-completions"
        ? { model: settings.modelVersion, prompt: "Return {\"items\":[]} as JSON.", temperature: 0 }
        : { model: settings.modelVersion, input: "Return {\"items\":[]} as JSON.", ...reasoningBody(settings) };
  const apiKey = settings.ai.provider === "glossa-backend" ? undefined : settings.ai.apiKey;
  await postConnectionTest(endpoint, body, "ai", apiKey, settings.ai.requestTimeoutMs);
}

export async function testAnkiSettings(settings: GlossaSettings): Promise<void> {
  const catalog = await loadAnkiCatalog(settings.anki.endpoint, settings.anki.requestTimeoutMs);
  if (!catalog.decks.includes(settings.anki.deck)) {
    throw createDiagnosticError("service-error", "Anki deck was not found", { service: "anki" });
  }
  if (!catalog.modelNames.includes(settings.anki.modelName)) {
    throw createDiagnosticError("service-error", "Anki model was not found", { service: "anki" });
  }
}

export async function runSettingsConnectionTest(
  button: HTMLButtonElement,
  run: () => Promise<void>,
  service: ErrorService,
  setStatus: (value: string, state: "success" | "error" | "") => void,
  successStatus = "",
  isCurrent: () => boolean = () => true
): Promise<boolean> {
  setStatus("", "");
  setTestState(button, "loading");
  try {
    await run();
    if (!isCurrent()) {
      return false;
    }
    setTestState(button, "success");
    setStatus(successStatus, "success");
    return true;
  } catch (error) {
    if (!isCurrent()) {
      return false;
    }
    setTestState(button, "error");
    setStatus(userMessageForError(diagnosticErrorFrom(error, {
      reason: "service-error",
      message: "Connection test failed",
      service
    }).payload, service), "error");
    return false;
  }
}

export function setTestState(button: HTMLButtonElement, state: TestState): void {
  button.dataset.state = state;
  button.disabled = state === "loading";
}

export async function loadAnkiCatalog(endpoint: string, timeoutMs: number): Promise<AnkiCatalog> {
  await ankiAction<number>(endpoint, "version", undefined, timeoutMs);
  const decks = await ankiAction<string[]>(endpoint, "deckNames", undefined, timeoutMs);
  const modelNames = await ankiAction<string[]>(endpoint, "modelNames", undefined, timeoutMs);
  if (!isStringArray(decks) || !isStringArray(modelNames)) {
    throw createDiagnosticError("invalid-response", "AnkiConnect returned invalid catalog data", { service: "anki" });
  }
  const compatibleModels: string[] = [];
  for (const modelName of modelNames) {
    const fields = await ankiAction<string[]>(endpoint, "modelFieldNames", { modelName }, timeoutMs);
    if (isStringArray(fields) && fields.includes("Front") && fields.includes("Back")) {
      compatibleModels.push(modelName);
    }
  }
  if (compatibleModels.length === 0) {
    throw createDiagnosticError("service-error", "No compatible Anki model was found", { service: "anki" });
  }
  return { decks, modelNames: compatibleModels };
}

export function setSelectOptions(select: HTMLSelectElement, values: string[], selected: string): void {
  const uniqueValues = [...new Set(values.filter((value) => value.length > 0))];
  select.replaceChildren(...uniqueValues.map((value) => {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = value;
    return option;
  }));
  select.value = uniqueValues.includes(selected) ? selected : uniqueValues[0] ?? "";
}

export function pickExistingValue(value: string, values: string[]): string {
  return values.includes(value) ? value : values[0] ?? value;
}

export function readFormInput(form: HTMLFormElement, name: string): string {
  return formControl(form, name).value;
}

export function setFormInput(form: HTMLFormElement, name: string, value: string): void {
  const control = optionalFormControl(form, name);
  if (control) {
    control.value = value;
  }
}

export function readFormCheckbox(form: HTMLFormElement, name: string): boolean {
  return (formControl(form, name) as HTMLInputElement).checked;
}

export function setFormChecked(form: HTMLFormElement, name: string, value: boolean): void {
  const control = optionalFormControl(form, name);
  if (control instanceof HTMLInputElement) {
    control.checked = value;
  }
}

export function msToSeconds(value: number): number {
  return Math.max(1, Math.round(value / 1_000));
}

export function msToHours(value: number): number {
  return Math.max(1, Math.round(value / 3_600_000));
}

function readKnownWordList(form: HTMLFormElement, fallback: KnownWordListId): KnownWordListId {
  const control = optionalFormControl(form, "knownWordList");
  if (control instanceof RadioNodeList) {
    return knownWordList(control.value, fallback);
  }
  return knownWordList(control?.value, fallback);
}

function knownWordList(value: unknown, fallback: KnownWordListId): KnownWordListId {
  return typeof value === "string" && (KNOWN_WORD_LIST_IDS as readonly string[]).includes(value) ? value as KnownWordListId : fallback;
}

function aiProvider(value: unknown, fallback: AiProvider): AiProvider {
  return value === "glossa-backend" || value === "openai-responses" || value === "openai-chat-completions" || value === "openai-completions" ? value : fallback;
}

function reasoningEffort(value: unknown, fallback: ReasoningEffort): ReasoningEffort {
  return value === "none" || value === "minimal" || value === "low" || value === "medium" || value === "high" || value === "xhigh" ? value : fallback;
}

function readOptionalInput(form: HTMLFormElement, name: string): string | undefined {
  return optionalFormControl(form, name)?.value;
}

function hasControl(form: HTMLFormElement, name: string): boolean {
  return optionalFormControl(form, name) !== undefined;
}

function formControl(form: HTMLFormElement, name: string): SettingsControl {
  const control = optionalFormControl(form, name);
  if (!control || control instanceof RadioNodeList) {
    throw new Error(`Missing settings control: ${name}`);
  }
  return control;
}

function optionalFormControl(form: HTMLFormElement, name: string): SettingsControl | RadioNodeList | undefined {
  const control = form.elements.namedItem(name);
  return control instanceof HTMLInputElement || control instanceof HTMLSelectElement || control instanceof HTMLTextAreaElement || control instanceof RadioNodeList
    ? control
    : undefined;
}

async function ankiAction<T>(endpoint: string, action: string, params?: Record<string, unknown>, timeoutMs = DEFAULT_SETTINGS.anki.requestTimeoutMs): Promise<T> {
  const response = await postConnectionTest(endpoint, {
    action,
    version: 6,
    ...(params ? { params } : {})
  }, "anki", undefined, timeoutMs) as AnkiActionResponse<T>;
  if (!response || typeof response !== "object") {
    throw createDiagnosticError("invalid-response", "AnkiConnect returned invalid response data", { service: "anki" });
  }
  if (response.error) {
    throw createDiagnosticError("service-error", response.error, { service: "anki" });
  }
  if (response.result === undefined) {
    throw createDiagnosticError("invalid-response", "AnkiConnect response is missing result", { service: "anki" });
  }
  return response.result;
}

async function postConnectionTest(endpoint: string, body: unknown, service: Extract<ErrorService, "ai" | "anki">, apiKey?: string, timeoutMs = DEFAULT_SETTINGS.ai.requestTimeoutMs): Promise<unknown> {
  const controller = new AbortController();
  const timeout = globalThis.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {})
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    if (!response.ok) {
      const payload = errorPayloadFromHttpStatus(service, response.status);
      throw createDiagnosticError(payload.reason, `${service} HTTP ${response.status}`, {
        service,
        status: response.status
      });
    }
    try {
      return await response.json();
    } catch (error) {
      throw createDiagnosticError("invalid-response", `${service} returned invalid JSON`, { service, cause: error });
    }
  } catch (error) {
    throw requestDiagnosticErrorFrom(error, {
      reason: "service-error",
      message: "Connection test failed",
      service
    });
  } finally {
    globalThis.clearTimeout(timeout);
  }
}

function reasoningBody(settings: GlossaSettings): { reasoning?: { effort: Exclude<GlossaSettings["ai"]["reasoningEffort"], "none"> } } {
  if (settings.ai.reasoningEffort === "none") {
    return {};
  }
  return { reasoning: { effort: settings.ai.reasoningEffort } };
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function secondsToMs(value: string, fallbackMs: number): number {
  const seconds = Math.max(1, Number(value) || fallbackMs / 1_000);
  return Math.round(seconds * 1_000);
}

function hoursToMs(value: string, fallbackMs: number): number {
  const hours = Math.max(1, Number(value) || fallbackMs / 3_600_000);
  return Math.round(hours * 3_600_000);
}

function hexToRgb(hex: string, alpha: number): string {
  const normalized = hex.replace("#", "");
  const value = Number.parseInt(normalized, 16);
  const red = (value >> 16) & 255;
  const green = (value >> 8) & 255;
  const blue = value & 255;
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}
