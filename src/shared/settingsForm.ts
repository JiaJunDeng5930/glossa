// @intent glossa.settings_save.form_logic Shared settings form helpers keep options and onboarding on the same normalization, preview, and connection-test behavior.
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
// @constraint glossa.settings_save.form_logic.test_state Test button state values describe idle, loading, success, and error display states.
export type TestState = "idle" | "loading" | "success" | "error";

// @constraint glossa.settings_save.form_logic.anki_catalog Anki catalog data exposes selectable decks and compatible model names.
export interface AnkiCatalog {
  // @constraint glossa.settings_save.form_logic.anki_catalog.decks Anki catalog deck entries are plain deck names.
  decks: string[];
  // @constraint glossa.settings_save.form_logic.anki_catalog.model_names Anki catalog model entries are compatible model names.
  modelNames: string[];
}

// @constraint glossa.settings_save.form_logic.anki_action_response Anki action responses carry either a result value or a service error string.
interface AnkiActionResponse<T> {
  // @constraint glossa.settings_save.form_logic.anki_action_response.result Anki action result values stay optional until response validation accepts them.
  result?: T;
  // @constraint glossa.settings_save.form_logic.anki_action_response.error Anki action errors stay optional and nullable to match AnkiConnect responses.
  error?: string | null;
}

// @constraint glossa.settings_save.form_logic.preview_targets Appearance preview targets expose the preview root and label groups updated by shared preview rendering.
export interface AppearancePreviewTargets {
  // @constraint glossa.settings_save.form_logic.preview_targets.root The preview target root receives the configured font family.
  preview: HTMLElement;
  // @constraint glossa.settings_save.form_logic.preview_targets.labels Preview gloss labels receive configured text, background, font family, and font size styles.
  labels: HTMLElement[];
  // @constraint glossa.settings_save.form_logic.preview_targets.success_labels Success preview labels receive the configured success background color.
  successLabels: HTMLElement[];
  // @constraint glossa.settings_save.form_logic.preview_targets.error_labels Error preview labels receive the configured error background color.
  errorLabels: HTMLElement[];
}

// @behavior glossa.settings_save.form_logic.read Settings forms normalize the same fields in onboarding and options while preserving base settings for absent controls.
export function readSettingsForm(form: HTMLFormElement, base: GlossaSettings = DEFAULT_SETTINGS): GlossaSettings {
  const provider = aiProvider(readOptionalInput(form, "provider"), base.ai.provider);
  // @constraint glossa.settings_save.form_logic.read.api_key_optional Settings form reads treat the API key control as optional so partial onboarding pages can save safely.
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
  // @behavior glossa.settings_save.form_logic.read.api_key_write A present API key control either stores a trimmed key or clears the saved key.
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

// @behavior glossa.settings_save.form_logic.write Settings forms load persisted values into matching controls without requiring every settings control on every page.
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
  // @constraint glossa.settings_save.form_logic.write.api_key_empty Missing API keys render as an empty settings input.
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

// @behavior glossa.settings_save.form_logic.known_word_options Settings forms populate known-word preset controls from the shared known-word list catalog.
export function populateKnownWordSelect(select: HTMLSelectElement): void {
  select.replaceChildren(...KNOWN_WORD_LISTS.map((list) => {
    const option = document.createElement("option");
    option.value = list.id;
    option.textContent = list.label;
    return option;
  }));
}

// @behavior glossa.settings_save.form_logic.preview Appearance previews in onboarding and options render label color, feedback colors, opacity, font family, and font size from the same settings.
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

// @behavior glossa.settings_save.form_logic.ai_check AI connection checks use the same provider-specific request body and timeout in onboarding and options.
export async function testAiSettings(settings: GlossaSettings): Promise<void> {
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
  // @behavior glossa.settings_save.form_logic.ai_check.request The AI connection check posts the selected provider probe with the configured API key and timeout.
  await postConnectionTest(endpoint, body, "ai", settings.ai.apiKey, settings.ai.requestTimeoutMs);
}

// @behavior glossa.settings_save.form_logic.anki_check Anki connection checks use the same catalog validation in onboarding and options.
export async function testAnkiSettings(settings: GlossaSettings): Promise<void> {
  const catalog = await loadAnkiCatalog(settings.anki.endpoint, settings.anki.requestTimeoutMs);
  // @behavior glossa.settings_save.form_logic.anki_check.deck_failure Missing configured Anki decks fail the shared Anki connection check.
  if (!catalog.decks.includes(settings.anki.deck)) {
    throw createDiagnosticError("service-error", "Anki deck was not found", { service: "anki" });
  }
  // @behavior glossa.settings_save.form_logic.anki_check.model_failure Missing compatible Anki models fail the shared Anki connection check.
  if (!catalog.modelNames.includes(settings.anki.modelName)) {
    throw createDiagnosticError("service-error", "Anki model was not found", { service: "anki" });
  }
}

// @behavior glossa.settings_save.form_logic.connection_state Shared connection-test buttons expose loading, success, and error states while mapping failures to user text.
export async function runSettingsConnectionTest(
  button: HTMLButtonElement,
  run: () => Promise<void>,
  service: ErrorService,
  setStatus: (value: string) => void,
  successStatus = ""
): Promise<void> {
  setStatus("");
  setTestState(button, "loading");
  // @behavior glossa.settings_save.form_logic.connection_state.failure_mapping Connection-test failures set the button error state and display localized service text.
  try {
    await run();
    setTestState(button, "success");
    setStatus(successStatus);
  } catch (error) {
    setTestState(button, "error");
    setStatus(userMessageForError(diagnosticErrorFrom(error, {
      reason: "service-error",
      message: "Connection test failed",
      service
    }).payload, service));
  }
}

// @behavior glossa.settings_save.form_logic.test_state_apply Test buttons store their state in data-state and disable only while loading.
export function setTestState(button: HTMLButtonElement, state: TestState): void {
  // @behavior glossa.settings_save.form_logic.test_state_apply.dataset Test button state is exposed through the data-state attribute for CSS and tests.
  button.dataset.state = state;
  // @behavior glossa.settings_save.form_logic.test_state_apply.loading_disabled Test buttons are disabled while a connection check is loading.
  button.disabled = state === "loading";
}

// @behavior glossa.settings_save.form_logic.anki_catalog_load Anki catalog loading verifies AnkiConnect, reads deck names, and filters models to Front and Back fields.
export async function loadAnkiCatalog(endpoint: string, timeoutMs: number): Promise<AnkiCatalog> {
  // @behavior glossa.card_creation.note_request.timeout.options_check.catalog_version Anki catalog loading checks the AnkiConnect version with the configured timeout.
  await ankiAction<number>(endpoint, "version", undefined, timeoutMs);
  // @behavior glossa.card_creation.note_request.timeout.options_check.catalog_decks Anki catalog loading reads deck names with the configured timeout.
  const decks = await ankiAction<string[]>(endpoint, "deckNames", undefined, timeoutMs);
  // @behavior glossa.card_creation.note_request.timeout.options_check.catalog_models Anki catalog loading reads model names with the configured timeout.
  const modelNames = await ankiAction<string[]>(endpoint, "modelNames", undefined, timeoutMs);
  // @behavior glossa.settings_save.form_logic.anki_catalog_load.shape_failure Invalid deck or model catalog payloads fail the Anki catalog load.
  if (!isStringArray(decks) || !isStringArray(modelNames)) {
    throw createDiagnosticError("invalid-response", "AnkiConnect returned invalid catalog data", { service: "anki" });
  }
  const compatibleModels: string[] = [];
  // @behavior glossa.settings_save.form_logic.anki_catalog_load.model_filter Anki catalog loading keeps models whose field list includes Front and Back.
  for (const modelName of modelNames) {
    const fields = await ankiAction<string[]>(endpoint, "modelFieldNames", { modelName }, timeoutMs);
    if (isStringArray(fields) && fields.includes("Front") && fields.includes("Back")) {
      compatibleModels.push(modelName);
    }
  }
  // @behavior glossa.settings_save.form_logic.anki_catalog_load.empty_compatible_models Anki catalog loading fails when no compatible model remains after field filtering.
  if (compatibleModels.length === 0) {
    throw createDiagnosticError("service-error", "No compatible Anki model was found", { service: "anki" });
  }
  return { decks, modelNames: compatibleModels };
}

// @behavior glossa.settings_save.form_logic.select_options Select-backed setup controls keep unique non-empty options and fall back to the first available value.
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

// @constraint glossa.settings_save.form_logic.pick_existing Existing select values win, then the first catalog value, then the original value.
export function pickExistingValue(value: string, values: string[]): string {
  return values.includes(value) ? value : values[0] ?? value;
}

// @behavior glossa.settings_save.form_logic.control_access Settings form helpers throw for required missing controls and ignore absent optional controls.
export function readFormInput(form: HTMLFormElement, name: string): string {
  return formControl(form, name).value;
}

// @constraint glossa.settings_save.form_logic.control_access.optional_set Form writes skip absent controls so partial settings forms remain valid.
export function setFormInput(form: HTMLFormElement, name: string, value: string): void {
  const control = optionalFormControl(form, name);
  if (control) {
    control.value = value;
  }
}

// @constraint glossa.settings_save.form_logic.control_access.checkbox_read Checkbox reads require a present checkbox-compatible form control.
export function readFormCheckbox(form: HTMLFormElement, name: string): boolean {
  return (formControl(form, name) as HTMLInputElement).checked;
}

// @constraint glossa.settings_save.form_logic.control_access.checkbox_optional_set Checkbox writes update only present input controls.
export function setFormChecked(form: HTMLFormElement, name: string, value: boolean): void {
  const control = optionalFormControl(form, name);
  if (control instanceof HTMLInputElement) {
    control.checked = value;
  }
}

// @constraint glossa.settings_save.timeout_seconds.display Seconds display values round persisted milliseconds up to at least one second.
export function msToSeconds(value: number): number {
  return Math.max(1, Math.round(value / 1_000));
}

// @constraint glossa.settings_save.gloss_cache_ttl.display Hours display values round persisted milliseconds up to at least one hour.
export function msToHours(value: number): number {
  return Math.max(1, Math.round(value / 3_600_000));
}

// @constraint glossa.settings_save.form_logic.known_word_read Known-word list reads accept both radio lists and select controls.
function readKnownWordList(form: HTMLFormElement, fallback: KnownWordListId): KnownWordListId {
  const control = optionalFormControl(form, "knownWordList");
  // @constraint glossa.settings_save.form_logic.known_word_read.radio Radio-backed known-word controls read their selected value through RadioNodeList.
  if (control instanceof RadioNodeList) {
    return knownWordList(control.value, fallback);
  }
  // @constraint glossa.settings_save.form_logic.known_word_read.select Select-backed known-word controls read their value when present.
  return knownWordList(control?.value, fallback);
}

// @constraint glossa.settings_save.form_logic.known_word_read.validation Known-word list validation accepts declared preset ids and falls back to the prior setting.
function knownWordList(value: unknown, fallback: KnownWordListId): KnownWordListId {
  // @constraint glossa.settings_save.form_logic.known_word_read.validation.allowed_ids Known-word list validation only returns configured preset ids.
  return typeof value === "string" && (KNOWN_WORD_LIST_IDS as readonly string[]).includes(value) ? value as KnownWordListId : fallback;
}

// @constraint glossa.settings_save.form_logic.provider_read Provider reads accept supported AI providers and fall back to the prior setting.
function aiProvider(value: unknown, fallback: AiProvider): AiProvider {
  // @constraint glossa.settings_save.form_logic.provider_read.allowed_values Provider validation only returns supported provider ids.
  return value === "glossa-backend" || value === "openai-responses" || value === "openai-chat-completions" || value === "openai-completions" ? value : fallback;
}

// @constraint glossa.settings_save.form_logic.reasoning_effort_read Reasoning effort reads accept supported effort values and fall back to the prior setting.
function reasoningEffort(value: unknown, fallback: ReasoningEffort): ReasoningEffort {
  // @constraint glossa.settings_save.form_logic.reasoning_effort_read.allowed_values Reasoning effort validation only returns supported effort ids.
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
  // @constraint glossa.settings_save.form_logic.control_access.required_missing Required settings controls fail fast when missing or radio-backed.
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

// @behavior glossa.settings_save.form_logic.anki_action Anki action calls post AnkiConnect actions and validate response result or service error fields.
async function ankiAction<T>(endpoint: string, action: string, params?: Record<string, unknown>, timeoutMs = DEFAULT_SETTINGS.anki.requestTimeoutMs): Promise<T> {
  // @behavior glossa.settings_save.form_logic.anki_action.request Anki action calls reuse the shared connection POST helper with AnkiConnect version six payloads.
  const response = await postConnectionTest(endpoint, {
    action,
    version: 6,
    ...(params ? { params } : {})
  }, "anki", undefined, timeoutMs) as AnkiActionResponse<T>;
  // @behavior glossa.settings_save.form_logic.anki_action.invalid_shape Empty or non-object Anki responses fail response validation.
  if (!response || typeof response !== "object") {
    throw createDiagnosticError("invalid-response", "AnkiConnect returned invalid response data", { service: "anki" });
  }
  // @behavior glossa.settings_save.form_logic.anki_action.service_error Anki response error strings fail as Anki service errors.
  if (response.error) {
    throw createDiagnosticError("service-error", response.error, { service: "anki" });
  }
  // @behavior glossa.settings_save.form_logic.anki_action.missing_result Anki responses without a result field fail response validation.
  if (response.result === undefined) {
    throw createDiagnosticError("invalid-response", "AnkiConnect response is missing result", { service: "anki" });
  }
  return response.result;
}

// @behavior glossa.ai_requests.failure.timeout.connection_helper.shared Shared settings connection requests abort after the supplied timeout and map HTTP, JSON, and request failures.
async function postConnectionTest(endpoint: string, body: unknown, service: Extract<ErrorService, "ai" | "anki">, apiKey?: string, timeoutMs = DEFAULT_SETTINGS.ai.requestTimeoutMs): Promise<unknown> {
  // @behavior glossa.ai_requests.failure.timeout.connection_helper.shared.abort_controller Shared settings connection requests create one abort controller per probe.
  const controller = new AbortController();
  // @behavior glossa.ai_requests.failure.timeout.connection_helper.shared.timeout Shared settings connection requests abort after the configured timeout.
  const timeout = globalThis.setTimeout(() => controller.abort(), timeoutMs);
  // @behavior glossa.ai_requests.failure.timeout.connection_helper.shared.request Shared settings connection requests send JSON POST probes with optional bearer authorization.
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
    // @behavior glossa.ai_requests.failure.timeout.connection_helper.shared.http_status Non-OK connection responses become service diagnostics with HTTP status.
    if (!response.ok) {
      const payload = errorPayloadFromHttpStatus(service, response.status);
      throw createDiagnosticError(payload.reason, `${service} HTTP ${response.status}`, {
        service,
        status: response.status
      });
    }
    // @behavior glossa.ai_requests.failure.timeout.connection_helper.shared.json_parse Connection responses must parse as JSON before catalog or provider checks continue.
    try {
      return await response.json();
    } catch (error) {
      throw createDiagnosticError("invalid-response", `${service} returned invalid JSON`, { service, cause: error });
    }
  } catch (error) {
    // @behavior glossa.ai_requests.failure.timeout.connection_helper.shared.request_error Connection request errors are mapped to service diagnostics.
    throw requestDiagnosticErrorFrom(error, {
      reason: "service-error",
      message: "Connection test failed",
      service
    });
  } finally {
    // @behavior glossa.ai_requests.failure.timeout.connection_helper.shared.timeout_cleanup Shared connection requests always clear their timeout handle.
    globalThis.clearTimeout(timeout);
  }
}

// @constraint glossa.settings_save.form_logic.reasoning_body Reasoning request bodies omit provider reasoning when the setting is none and include effort otherwise.
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

// @constraint glossa.settings_save.timeout_seconds.input_parse Saved second inputs fall back to prior milliseconds and clamp to at least one second.
function secondsToMs(value: string, fallbackMs: number): number {
  // @constraint glossa.settings_save.timeout_seconds.input_parse.minimum Saved second inputs use the larger value between one second and the parsed or fallback seconds.
  const seconds = Math.max(1, Number(value) || fallbackMs / 1_000);
  return Math.round(seconds * 1_000);
}

// @constraint glossa.settings_save.gloss_cache_ttl.input_parse Saved hour inputs fall back to prior milliseconds and clamp to at least one hour.
function hoursToMs(value: string, fallbackMs: number): number {
  // @constraint glossa.settings_save.gloss_cache_ttl.input_parse.minimum Saved hour inputs use the larger value between one hour and the parsed or fallback hours.
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
