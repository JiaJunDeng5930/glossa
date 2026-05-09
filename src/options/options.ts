// @behavior glossa.options The options page edits settings, verifies provider connections, previews appearance, and persists configuration.
import { KNOWN_WORD_LISTS } from "../core/lexicon";
import { createDiagnosticError, diagnosticErrorFrom, errorPayloadFromHttpStatus, requestDiagnosticErrorFrom } from "../shared/errors";
import { formatShortcutFromEvent } from "../shared/shortcut";
import { DEFAULT_SETTINGS, GLOSS_TARGET_LANG, type AiSettings, type ErrorService, type GlossaSettings, type KnownWordListId } from "../shared/types";
import { userMessageForError } from "../shared/userMessages";

const form = document.querySelector<HTMLFormElement>("#settings-form")!;
const statusOutput = document.querySelector<HTMLOutputElement>("#status")!;
const shortcutCapture = document.querySelector<HTMLButtonElement>("#shortcut-capture")!;
const translateShortcutCapture = document.querySelector<HTMLButtonElement>("#translate-shortcut-capture")!;
const glossPreview = document.querySelector<HTMLElement>("#gloss-preview")!;
const glossPreviewLabels = Array.from(document.querySelectorAll<HTMLElement>(".preview-gloss"));
const glossPreviewSuccessLabels = Array.from(document.querySelectorAll<HTMLElement>(".preview-gloss-success"));
const glossPreviewErrorLabels = Array.from(document.querySelectorAll<HTMLElement>(".preview-gloss-error"));
const knownWordListSelect = form.elements.namedItem("knownWordList") as HTMLSelectElement;
const ankiDeckSelect = form.elements.namedItem("ankiDeck") as HTMLSelectElement;
const ankiModelNameSelect = form.elements.namedItem("ankiModelName") as HTMLSelectElement;
const testAiButton = document.querySelector<HTMLButtonElement>("#test-ai")!;
const testAnkiButton = document.querySelector<HTMLButtonElement>("#test-anki")!;
const refreshAnkiButton = document.querySelector<HTMLButtonElement>("#refresh-anki")!;
let capturingShortcutName: "shortcutKey" | "translateShortcutKey" | undefined;
let pendingShortcut = "";

populateKnownWordLists();
void loadSettings();

form.addEventListener("submit", (event) => {
  event.preventDefault();
  void saveSettings(readFormSettings()).then(() => setStatus("已保存"));
});

testAiButton.addEventListener("click", () => {
  void runConnectionTest(testAiButton, () => testAi(readFormSettings()), "ai");
});

testAnkiButton.addEventListener("click", () => {
  void runConnectionTest(testAnkiButton, () => testAnki(readFormSettings()), "anki");
});

refreshAnkiButton.addEventListener("click", () => {
  void refreshAnkiOptions(readFormSettings(), { reportStatus: true });
});

const providerSelect = form.elements.namedItem("provider") as HTMLSelectElement;
providerSelect.addEventListener("change", () => {
  const provider = readInput("provider") as AiSettings["provider"];
  setInput("aiEndpoint", defaultEndpointForProvider(provider));
});

shortcutCapture.addEventListener("click", () => {
  startShortcutCapture("shortcutKey", shortcutCapture);
});

translateShortcutCapture.addEventListener("click", () => {
  startShortcutCapture("translateShortcutKey", translateShortcutCapture);
});

document.addEventListener("keydown", (event) => {
  if (!capturingShortcutName) {
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  pendingShortcut = formatShortcutFromEvent(event);
  shortcutButtonFor(capturingShortcutName).textContent = pendingShortcut;
  if (!isModifierKey(event.key)) {
    finishShortcutCapture();
  }
});

document.addEventListener("keyup", (event) => {
  if (!capturingShortcutName || !pendingShortcut) {
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  if (isModifierKey(event.key)) {
    finishShortcutCapture();
  }
});

form.addEventListener("input", () => updatePreview(readFormSettings()));

async function loadSettings(): Promise<void> {
  const settings = await chromeLocalGet<GlossaSettings>("settings").then((value) => mergeSettings(value));
  setInput("shortcutKey", settings.shortcutKey);
  shortcutCapture.textContent = settings.shortcutKey;
  setInput("translateShortcutKey", settings.translateShortcutKey);
  translateShortcutCapture.textContent = settings.translateShortcutKey;
  setChecked("autoTranslateEnabled", settings.autoTranslateEnabled);
  setInput("learningWindowDays", String(settings.learningWindowDays));
  setInput("knownWordList", settings.knownWordList);
  setInput("glossTextColor", settings.appearance.textColor);
  setInput("glossBackgroundColor", settings.appearance.backgroundColor);
  setInput("cardSuccessBackgroundColor", settings.appearance.cardSuccessBackgroundColor);
  setInput("cardErrorBackgroundColor", settings.appearance.cardErrorBackgroundColor);
  setInput("glossBackgroundOpacity", String(settings.appearance.backgroundOpacity));
  setInput("glossFontFamily", settings.appearance.fontFamily);
  setInput("glossFontSize", String(settings.appearance.fontSize));
  setInput("provider", settings.ai.provider);
  setInput("aiEndpoint", settings.ai.endpoint);
  setInput("apiKey", settings.ai.apiKey ?? "");
  setInput("reasoningEffort", settings.ai.reasoningEffort);
  setInput("modelVersion", settings.modelVersion);
  setInput("ankiEndpoint", settings.anki.endpoint);
  setSelectOptions(ankiDeckSelect, [settings.anki.deck], settings.anki.deck);
  setSelectOptions(ankiModelNameSelect, [settings.anki.modelName], settings.anki.modelName);
  setAnkiSelectsEnabled(false);
  setInput("glossPrompt", settings.prompts.gloss);
  setInput("ankiPrompt", settings.prompts.ankiCard);
  updatePreview(settings);
  void refreshAnkiOptions(settings, { reportStatus: false });
}

async function saveSettings(settings: GlossaSettings): Promise<void> {
  await chromeLocalSet("settings", settings);
}

function readFormSettings(): GlossaSettings {
  const provider = readInput("provider") as AiSettings["provider"];
  const apiKey = readInput("apiKey").trim();
  return {
    shortcutKey: readInput("shortcutKey").trim() || DEFAULT_SETTINGS.shortcutKey,
    translateShortcutKey: readInput("translateShortcutKey").trim() || DEFAULT_SETTINGS.translateShortcutKey,
    autoTranslateEnabled: readCheckbox("autoTranslateEnabled"),
    learningWindowDays: Math.max(1, Number(readInput("learningWindowDays")) || DEFAULT_SETTINGS.learningWindowDays),
    knownWordList: readKnownWordList(),
    promptVersion: DEFAULT_SETTINGS.promptVersion,
    modelVersion: readInput("modelVersion").trim() || DEFAULT_SETTINGS.modelVersion,
    appearance: {
      textColor: readInput("glossTextColor") || DEFAULT_SETTINGS.appearance.textColor,
      backgroundColor: readInput("glossBackgroundColor") || DEFAULT_SETTINGS.appearance.backgroundColor,
      cardSuccessBackgroundColor: readInput("cardSuccessBackgroundColor") || DEFAULT_SETTINGS.appearance.cardSuccessBackgroundColor,
      cardErrorBackgroundColor: readInput("cardErrorBackgroundColor") || DEFAULT_SETTINGS.appearance.cardErrorBackgroundColor,
      backgroundOpacity: clamp(Number(readInput("glossBackgroundOpacity")) || DEFAULT_SETTINGS.appearance.backgroundOpacity, 0.2, 1),
      fontFamily: readInput("glossFontFamily") || DEFAULT_SETTINGS.appearance.fontFamily,
      fontSize: Math.max(9, Math.min(24, Number(readInput("glossFontSize")) || DEFAULT_SETTINGS.appearance.fontSize))
    },
    prompts: {
      gloss: readInput("glossPrompt").trim() || DEFAULT_SETTINGS.prompts.gloss,
      ankiCard: readInput("ankiPrompt").trim() || DEFAULT_SETTINGS.prompts.ankiCard
    },
    ai: {
      provider,
      endpoint: readInput("aiEndpoint").trim() || DEFAULT_SETTINGS.ai.endpoint,
      reasoningEffort: readInput("reasoningEffort") as GlossaSettings["ai"]["reasoningEffort"],
      ...(apiKey ? { apiKey } : {})
    },
    anki: {
      endpoint: readInput("ankiEndpoint").trim() || DEFAULT_SETTINGS.anki.endpoint,
      deck: readInput("ankiDeck").trim() || DEFAULT_SETTINGS.anki.deck,
      modelName: readInput("ankiModelName").trim() || DEFAULT_SETTINGS.anki.modelName
    }
  };
}

async function testAi(settings: GlossaSettings): Promise<void> {
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
  await postConnectionTest(endpoint, body, "ai", settings.ai.apiKey);
}

async function testAnki(settings: GlossaSettings): Promise<void> {
  const catalog = await loadAnkiCatalog(settings.anki.endpoint);
  if (!catalog.decks.includes(settings.anki.deck)) {
    throw createDiagnosticError("service-error", "Anki deck was not found", { service: "anki" });
  }
  if (!catalog.modelNames.includes(settings.anki.modelName)) {
    throw createDiagnosticError("service-error", "Anki model was not found", { service: "anki" });
  }
}

function mergeSettings(value: Partial<GlossaSettings> | undefined): GlossaSettings {
  const ai = { ...DEFAULT_SETTINGS.ai, ...value?.ai };
  return {
    ...DEFAULT_SETTINGS,
    ...value,
    translateShortcutKey: value?.translateShortcutKey ?? DEFAULT_SETTINGS.translateShortcutKey,
    autoTranslateEnabled: value?.autoTranslateEnabled ?? DEFAULT_SETTINGS.autoTranslateEnabled,
    knownWordList: isKnownWordList(value?.knownWordList) ? value.knownWordList : DEFAULT_SETTINGS.knownWordList,
    appearance: { ...DEFAULT_SETTINGS.appearance, ...value?.appearance },
    prompts: { ...DEFAULT_SETTINGS.prompts, ...value?.prompts },
    ai: { ...ai, endpoint: ai.endpoint || defaultEndpointForProvider(ai.provider) },
    anki: { ...DEFAULT_SETTINGS.anki, ...value?.anki }
  };
}

function readInput(name: string): string {
  return (form.elements.namedItem(name) as HTMLInputElement | HTMLSelectElement).value;
}

function setInput(name: string, value: string): void {
  (form.elements.namedItem(name) as HTMLInputElement | HTMLSelectElement).value = value;
}

function readCheckbox(name: string): boolean {
  return (form.elements.namedItem(name) as HTMLInputElement).checked;
}

function setChecked(name: string, value: boolean): void {
  (form.elements.namedItem(name) as HTMLInputElement).checked = value;
}

function setStatus(value: string): void {
  statusOutput.value = value;
}

function setAnkiSelectsEnabled(enabled: boolean): void {
  ankiDeckSelect.disabled = !enabled;
  ankiModelNameSelect.disabled = !enabled;
}

function populateKnownWordLists(): void {
  knownWordListSelect.replaceChildren(...KNOWN_WORD_LISTS.map((list) => {
    const option = document.createElement("option");
    option.value = list.id;
    option.textContent = list.label;
    return option;
  }));
}

function readKnownWordList(): KnownWordListId {
  const value = readInput("knownWordList");
  return isKnownWordList(value) ? value : DEFAULT_SETTINGS.knownWordList;
}

function isKnownWordList(value: unknown): value is KnownWordListId {
  return typeof value === "string" && KNOWN_WORD_LISTS.some((item) => item.id === value);
}

async function runConnectionTest(
  button: HTMLButtonElement,
  run: () => Promise<void>,
  service: ErrorService
): Promise<void> {
  setStatus("");
  setTestState(button, "loading");
  try {
    await run();
    setTestState(button, "success");
  } catch (error) {
    setTestState(button, "error");
    setStatus(userMessageForError(diagnosticErrorFrom(error, {
      reason: "service-error",
      message: "Connection test failed",
      service
    }).payload, service));
  }
}

type TestState = "idle" | "loading" | "success" | "error";

interface AnkiCatalog {
  decks: string[];
  modelNames: string[];
}

interface AnkiActionResponse<T> {
  result?: T;
  error?: string | null;
}

function setTestState(button: HTMLButtonElement, state: TestState): void {
  button.dataset.state = state;
  button.disabled = state === "loading";
}

function defaultEndpointForProvider(provider: AiSettings["provider"]): string {
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

async function refreshAnkiOptions(settings: GlossaSettings, options: { reportStatus: boolean }): Promise<void> {
  setTestState(refreshAnkiButton, "loading");
  setAnkiSelectsEnabled(false);
  try {
    const catalog = await loadAnkiCatalog(settings.anki.endpoint);
    const deck = pickExistingValue(settings.anki.deck, catalog.decks);
    const modelName = pickExistingValue(settings.anki.modelName, catalog.modelNames);
    setSelectOptions(ankiDeckSelect, catalog.decks, deck);
    setSelectOptions(ankiModelNameSelect, catalog.modelNames, modelName);
    setAnkiSelectsEnabled(true);
    setTestState(refreshAnkiButton, "idle");
    if (options.reportStatus) {
      setStatus("");
    }
  } catch (error) {
    setSelectOptions(ankiDeckSelect, [settings.anki.deck], settings.anki.deck);
    setSelectOptions(ankiModelNameSelect, [settings.anki.modelName], settings.anki.modelName);
    setAnkiSelectsEnabled(false);
    setTestState(refreshAnkiButton, "error");
    if (options.reportStatus) {
      setStatus(userMessageForError(diagnosticErrorFrom(error, {
        reason: "service-error",
        message: "Connection test failed",
        service: "anki"
      }).payload, "anki"));
    }
  }
}

async function loadAnkiCatalog(endpoint: string): Promise<AnkiCatalog> {
  await ankiAction<number>(endpoint, "version");
  const decks = await ankiAction<string[]>(endpoint, "deckNames");
  const modelNames = await ankiAction<string[]>(endpoint, "modelNames");
  if (!isStringArray(decks) || !isStringArray(modelNames)) {
    throw createDiagnosticError("invalid-response", "AnkiConnect returned invalid catalog data", { service: "anki" });
  }
  const compatibleModels: string[] = [];
  for (const modelName of modelNames) {
    const fields = await ankiAction<string[]>(endpoint, "modelFieldNames", { modelName });
    if (isStringArray(fields) && fields.includes("Front") && fields.includes("Back")) {
      compatibleModels.push(modelName);
    }
  }
  if (compatibleModels.length === 0) {
    throw createDiagnosticError("service-error", "No compatible Anki model was found", { service: "anki" });
  }
  return { decks, modelNames: compatibleModels };
}

async function ankiAction<T>(endpoint: string, action: string, params?: Record<string, unknown>): Promise<T> {
  const response = await postConnectionTest(endpoint, {
    action,
    version: 6,
    ...(params ? { params } : {})
  }, "anki") as AnkiActionResponse<T>;
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

function setSelectOptions(select: HTMLSelectElement, values: string[], selected: string): void {
  const uniqueValues = [...new Set(values.filter((value) => value.length > 0))];
  select.replaceChildren(...uniqueValues.map((value) => {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = value;
    return option;
  }));
  select.value = uniqueValues.includes(selected) ? selected : uniqueValues[0] ?? "";
}

function pickExistingValue(value: string, values: string[]): string {
  return values.includes(value) ? value : values[0] ?? value;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

async function postConnectionTest(endpoint: string, body: unknown, service: Extract<ErrorService, "ai" | "anki">, apiKey?: string): Promise<unknown> {
  const controller = new AbortController();
  const timeout = globalThis.setTimeout(() => controller.abort(), 15_000);
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

function finishShortcutCapture(): void {
  if (!capturingShortcutName) {
    return;
  }
  setInput(capturingShortcutName, pendingShortcut);
  shortcutButtonFor(capturingShortcutName).textContent = pendingShortcut;
  capturingShortcutName = undefined;
  pendingShortcut = "";
  setStatus("已记录快捷键");
}

function isModifierKey(key: string): boolean {
  return key === "Control" || key === "Alt" || key === "Shift" || key === "Meta";
}

function updatePreview(settings: GlossaSettings): void {
  glossPreview.style.fontFamily = settings.appearance.fontFamily;
  for (const label of glossPreviewLabels) {
    label.style.color = settings.appearance.textColor;
    label.style.backgroundColor = hexToRgb(settings.appearance.backgroundColor, settings.appearance.backgroundOpacity);
    label.style.fontFamily = settings.appearance.fontFamily;
    label.style.fontSize = `${settings.appearance.fontSize}px`;
  }
  for (const label of glossPreviewSuccessLabels) {
    label.style.backgroundColor = hexToRgb(settings.appearance.cardSuccessBackgroundColor, settings.appearance.backgroundOpacity);
  }
  for (const label of glossPreviewErrorLabels) {
    label.style.backgroundColor = hexToRgb(settings.appearance.cardErrorBackgroundColor, settings.appearance.backgroundOpacity);
  }
}

function startShortcutCapture(name: "shortcutKey" | "translateShortcutKey", button: HTMLButtonElement): void {
  capturingShortcutName = name;
  pendingShortcut = "";
  button.textContent = "按下快捷键";
  button.focus();
}

function shortcutButtonFor(name: "shortcutKey" | "translateShortcutKey"): HTMLButtonElement {
  return name === "shortcutKey" ? shortcutCapture : translateShortcutCapture;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function hexToRgb(hex: string, alpha: number): string {
  const normalized = hex.replace("#", "");
  const value = Number.parseInt(normalized, 16);
  const red = (value >> 16) & 255;
  const green = (value >> 8) & 255;
  const blue = value & 255;
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}

function chromeLocalGet<T>(key: string): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(key, (result) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve(result[key] as T | undefined);
    });
  });
}

function chromeLocalSet<T>(key: string, value: T): Promise<void> {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set({ [key]: value }, () => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve();
    });
  });
}
