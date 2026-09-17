import { AI_PROVIDER_DESCRIPTORS, getAiProviderDescriptor } from "./aiProviders";
import { KNOWN_WORD_LISTS } from "./knownWordLists";
import { defaultEndpointForProvider, endpointForProviderChange, SETTINGS_RULES, validateSettings, type SettingsNumberRule } from "./settings";
import {
  DEFAULT_SETTINGS,
  REASONING_EFFORTS,
  type ReasoningEffort,
  type AiProvider,
  type AppearanceSettings,
  type GlossaSettings,
} from "./types";

type SettingsControl = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
export type TestState = "idle" | "loading" | "success" | "error";

export interface AppearancePreviewTargets {
  preview: HTMLElement;
  labels: HTMLElement[];
  successLabels: HTMLElement[];
  errorLabels: HTMLElement[];
}

const NUMBER_CONTROLS: Record<string, { rule: SettingsNumberRule; units: number }> = {
  learningWindowDays: { rule: SETTINGS_RULES.learningWindowDays, units: 1 },
  glossCacheTtlHours: { rule: SETTINGS_RULES.glossCacheTtlMs, units: 3_600_000 },
  glossBackgroundOpacity: { rule: SETTINGS_RULES.appearance.backgroundOpacity, units: 1 },
  glossFontSize: { rule: SETTINGS_RULES.appearance.fontSize, units: 1 },
  aiRequestTimeoutSeconds: { rule: SETTINGS_RULES.ai.requestTimeoutMs, units: 1_000 },
  ankiRequestTimeoutSeconds: { rule: SETTINGS_RULES.anki.requestTimeoutMs, units: 1_000 },
  duplicatePromptSeconds: { rule: SETTINGS_RULES.anki.duplicatePromptMs, units: 1_000 }
};

export function applySettingsFormConstraints(form: HTMLFormElement): void {
  for (const [name, { rule, units }] of Object.entries(NUMBER_CONTROLS)) {
    const control = optionalFormControl(form, name);
    if (!(control instanceof HTMLInputElement)) continue;
    // Domain numbers allow fractions. Set step before writing a range value to prevent browser rounding.
    control.step = "any";
    control.min = String(rule.minimum / units);
    if (Number.isFinite(rule.maximum)) control.max = String(rule.maximum / units);
    else control.removeAttribute("max");
    // HTML has no exclusive numeric minimum; validateSettings enforces it when reading the form.
  }
}

export function readSettingsForm(form: HTMLFormElement, base: GlossaSettings = DEFAULT_SETTINGS): GlossaSettings {
  applySettingsFormConstraints(form);
  const provider = (readOptionalInput(form, "provider") ?? base.ai.provider) as AiProvider;
  const apiKeyValue = readOptionalInput(form, "apiKey");
  const ai = {
    ...base.ai,
    provider,
    endpoint: readOptionalInput(form, "aiEndpoint")?.trim() || (hasControl(form, "provider") ? defaultEndpointForProvider(provider) : base.ai.endpoint),
    reasoningEffort: readOptionalInput(form, "reasoningEffort") ?? base.ai.reasoningEffort,
    requestTimeoutMs: hasControl(form, "aiRequestTimeoutSeconds")
      ? secondsToMs(readFormInput(form, "aiRequestTimeoutSeconds"))
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
    ? Number(readFormInput(form, "glossFontSize"))
    : base.appearance.fontSize;
  return validateSettings({
    shortcutKey: readOptionalInput(form, "shortcutKey")?.trim() || base.shortcutKey,
    translateShortcutKey: readOptionalInput(form, "translateShortcutKey")?.trim() || base.translateShortcutKey,
    autoTranslateEnabled: hasControl(form, "autoTranslateEnabled") ? readFormCheckbox(form, "autoTranslateEnabled") : base.autoTranslateEnabled,
    learningWindowDays: hasControl(form, "learningWindowDays")
      ? Number(readFormInput(form, "learningWindowDays"))
      : base.learningWindowDays,
    glossCacheTtlMs: hasControl(form, "glossCacheTtlHours")
      ? hoursToMs(readFormInput(form, "glossCacheTtlHours"))
      : base.glossCacheTtlMs,
    knownWordList: readOptionalInput(form, "knownWordList") ?? base.knownWordList,
    promptVersion: base.promptVersion,
    modelVersion: readOptionalInput(form, "modelVersion")?.trim() || base.modelVersion,
    appearance: {
      textColor: readOptionalInput(form, "glossTextColor") || base.appearance.textColor,
      backgroundColor: readOptionalInput(form, "glossBackgroundColor") || base.appearance.backgroundColor,
      cardSuccessBackgroundColor: readOptionalInput(form, "cardSuccessBackgroundColor") || base.appearance.cardSuccessBackgroundColor,
      cardErrorBackgroundColor: readOptionalInput(form, "cardErrorBackgroundColor") || base.appearance.cardErrorBackgroundColor,
      backgroundOpacity: hasControl(form, "glossBackgroundOpacity")
        ? Number(readFormInput(form, "glossBackgroundOpacity"))
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
        ? secondsToMs(readFormInput(form, "ankiRequestTimeoutSeconds"))
        : base.anki.requestTimeoutMs,
      duplicatePromptMs: hasControl(form, "duplicatePromptSeconds")
        ? secondsToMs(readFormInput(form, "duplicatePromptSeconds"))
        : base.anki.duplicatePromptMs
    }
  });
}

export function writeSettingsForm(form: HTMLFormElement, settings: GlossaSettings): void {
  applySettingsFormConstraints(form);
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
  writeAnkiSelects(form, settings);
  setFormInput(form, "ankiRequestTimeoutSeconds", String(msToSeconds(settings.anki.requestTimeoutMs)));
  setFormInput(form, "duplicatePromptSeconds", String(msToSeconds(settings.anki.duplicatePromptMs)));
  setFormInput(form, "glossPrompt", settings.prompts.gloss);
  setFormInput(form, "ankiPrompt", settings.prompts.ankiCard);
}

/**
 * Update the setting represented by each dynamic Anki select while retaining
 * any choices already loaded from the current catalog.
 */
export function writeAnkiSelects(form: HTMLFormElement, settings: GlossaSettings): void {
  writeDynamicSelect(form, "ankiDeck", settings.anki.deck);
  writeDynamicSelect(form, "ankiModelName", settings.anki.modelName);
}

export function populateProviderSelect(select: HTMLSelectElement): void {
  select.replaceChildren(...AI_PROVIDER_DESCRIPTORS.map(provider => {
    const option = document.createElement("option");
    option.value = provider.id;
    option.textContent = provider.label;
    return option;
  }));
}

const REASONING_EFFORT_LABELS: Record<ReasoningEffort, string> = {
  none: "无", minimal: "极简", low: "低", medium: "中", high: "高", xhigh: "超高"
};

export function populateReasoningEffortSelect(select: HTMLSelectElement): void {
  select.replaceChildren(...REASONING_EFFORTS.map(effort => {
    const option = document.createElement("option");
    option.value = effort;
    option.textContent = REASONING_EFFORT_LABELS[effort];
    return option;
  }));
}

export function applyProviderFields(form: HTMLFormElement, provider: AiProvider): void {
  const descriptor = getAiProviderDescriptor(provider);
  for (const field of form.querySelectorAll<HTMLElement>('[data-ai-field="api-key"]')) {
    field.hidden = !descriptor.supportsApiKey;
  }
  for (const field of form.querySelectorAll<HTMLElement>('[data-ai-field="reasoning"]')) {
    field.hidden = !descriptor.supportsReasoning;
  }
}

export function applyProviderChange(form: HTMLFormElement, previousProvider: AiProvider, nextProvider: AiProvider): void {
  const endpoint = readOptionalInput(form, "aiEndpoint");
  if (endpoint !== undefined) {
    setFormInput(form, "aiEndpoint", endpointForProviderChange(previousProvider, nextProvider, endpoint));
  }
  applyProviderFields(form, nextProvider);
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

export function setTestState(button: HTMLButtonElement, state: TestState): void {
  button.dataset.state = state;
  button.disabled = state === "loading";
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
  return value / 1_000;
}

export function msToHours(value: number): number {
  return value / 3_600_000;
}

function readOptionalInput(form: HTMLFormElement, name: string): string | undefined {
  return optionalFormControl(form, name)?.value;
}

function writeDynamicSelect(form: HTMLFormElement, name: string, value: string): void {
  const control = optionalFormControl(form, name);
  if (!(control instanceof HTMLSelectElement)) return;
  if (![...control.options].some((option) => option.value === value)) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = value;
    control.append(option);
  }
  control.value = value;
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

function secondsToMs(value: string): number { return Number(value) * 1000; }
function hoursToMs(value: string): number { return Number(value) * 3600000; }

function hexToRgb(hex: string, alpha: number): string {
  const normalized = hex.replace("#", "");
  const value = Number.parseInt(normalized, 16);
  const red = (value >> 16) & 255;
  const green = (value >> 8) & 255;
  const blue = value & 255;
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}
