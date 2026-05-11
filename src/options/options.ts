// @behavior glossa.settings_save User edits on the options page persist translation, provider, Anki, prompt, shortcut, and appearance settings.
import { KNOWN_WORD_LISTS } from "../core/lexicon";
import { createCandidateRecord, markRecordShown, normalizeLemma, vocabularyKey } from "../core/state";
import { createDiagnosticError, diagnosticErrorFrom, errorPayloadFromHttpStatus, requestDiagnosticErrorFrom } from "../shared/errors";
import { createOptionsMessage, messageTimeoutError, validateBackgroundResponse } from "../shared/messages";
import { defaultEndpointForProvider, mergeStoredSettings, settingsOverrides, type StoredGlossaSettings } from "../shared/settings";
import { formatShortcutFromEvent } from "../shared/shortcut";
import { DEFAULT_SETTINGS, GLOSS_TARGET_LANG, type AiSettings, type BackgroundResponseMessage, type ErrorService, type GlossaSettings, type KnownWordListId, type OptionsToBackgroundMessage, type VocabularyRecord } from "../shared/types";
import { userMessageForError } from "../shared/userMessages";
import { createExtensionStorage } from "../storage/db";

const form = document.querySelector<HTMLFormElement>("#settings-form")!;
const extensionStorage = createExtensionStorage();
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
const resetGlossPromptButton = document.querySelector<HTMLButtonElement>("#reset-gloss-prompt")!;
const resetAnkiPromptButton = document.querySelector<HTMLButtonElement>("#reset-anki-prompt")!;
const clearGlossCacheButton = document.querySelector<HTMLButtonElement>("#clear-gloss-cache")!;
const knownWordInput = document.querySelector<HTMLInputElement>("#known-word-input")!;
const addKnownWordButton = document.querySelector<HTMLButtonElement>("#add-known-word")!;
const knownWordsList = document.querySelector<HTMLElement>("#known-words-list")!;
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

resetGlossPromptButton.addEventListener("click", () => {
  setInput("glossPrompt", DEFAULT_SETTINGS.prompts.gloss);
  updatePreview(readFormSettings());
});

resetAnkiPromptButton.addEventListener("click", () => {
  setInput("ankiPrompt", DEFAULT_SETTINGS.prompts.ankiCard);
});

clearGlossCacheButton.addEventListener("click", () => {
  void clearGlossCache();
});

addKnownWordButton.addEventListener("click", () => {
  void addKnownWord();
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
  const settings = await chromeLocalGet<StoredGlossaSettings>("settings").then((value) => mergeStoredSettings(value));
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
  setInput("aiRequestTimeoutSeconds", String(msToSeconds(settings.ai.requestTimeoutMs)));
  setInput("modelVersion", settings.modelVersion);
  setInput("ankiEndpoint", settings.anki.endpoint);
  setInput("ankiRequestTimeoutSeconds", String(msToSeconds(settings.anki.requestTimeoutMs)));
  setInput("duplicatePromptSeconds", String(msToSeconds(settings.anki.duplicatePromptMs)));
  setSelectOptions(ankiDeckSelect, [settings.anki.deck], settings.anki.deck);
  setSelectOptions(ankiModelNameSelect, [settings.anki.modelName], settings.anki.modelName);
  setAnkiSelectsEnabled(false);
  setInput("glossPrompt", settings.prompts.gloss);
  setInput("ankiPrompt", settings.prompts.ankiCard);
  updatePreview(settings);
  void refreshKnownWords();
  void refreshAnkiOptions(settings, { reportStatus: false });
}

async function saveSettings(settings: GlossaSettings): Promise<void> {
  await chromeLocalSet("settings", settingsOverrides(settings));
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
      endpoint: readInput("aiEndpoint").trim() || defaultEndpointForProvider(provider),
      reasoningEffort: readInput("reasoningEffort") as GlossaSettings["ai"]["reasoningEffort"],
      requestTimeoutMs: secondsToMs(readInput("aiRequestTimeoutSeconds"), DEFAULT_SETTINGS.ai.requestTimeoutMs),
      ...(apiKey ? { apiKey } : {})
    },
    anki: {
      endpoint: readInput("ankiEndpoint").trim() || DEFAULT_SETTINGS.anki.endpoint,
      deck: readInput("ankiDeck").trim() || DEFAULT_SETTINGS.anki.deck,
      modelName: readInput("ankiModelName").trim() || DEFAULT_SETTINGS.anki.modelName,
      requestTimeoutMs: secondsToMs(readInput("ankiRequestTimeoutSeconds"), DEFAULT_SETTINGS.anki.requestTimeoutMs),
      duplicatePromptMs: secondsToMs(readInput("duplicatePromptSeconds"), DEFAULT_SETTINGS.anki.duplicatePromptMs)
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
  // @behavior glossa.ai_requests.failure.timeout.options_check AI connection checks use the configured AI request timeout.
  await postConnectionTest(endpoint, body, "ai", settings.ai.apiKey, settings.ai.requestTimeoutMs);
}

async function testAnki(settings: GlossaSettings): Promise<void> {
  // @behavior glossa.card_creation.note_request.timeout.options_check Anki connection checks use the configured Anki request timeout.
  const catalog = await loadAnkiCatalog(settings.anki.endpoint, settings.anki.requestTimeoutMs);
  if (!catalog.decks.includes(settings.anki.deck)) {
    throw createDiagnosticError("service-error", "Anki deck was not found", { service: "anki" });
  }
  if (!catalog.modelNames.includes(settings.anki.modelName)) {
    throw createDiagnosticError("service-error", "Anki model was not found", { service: "anki" });
  }
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

// @behavior glossa.word_memory.known_management The options page lists known vocabulary records and lets users add or remove known words manually.
async function refreshKnownWords(): Promise<void> {
  const records = await extensionStorage.lexicon.listByState("known");
  renderKnownWords(records);
}

async function addKnownWord(): Promise<void> {
  const lemma = normalizeLemma(knownWordInput.value);
  if (!lemma) {
    return;
  }
  const now = Date.now();
  const key = vocabularyKey("en", lemma);
  const existing = await extensionStorage.lexicon.get(key);
  // @behavior glossa.word_memory.known_management.add_known Adding a known word writes a known vocabulary record keyed by normalized English lemma.
  const shown = markRecordShown(existing ?? createCandidateRecord(lemma, lemma, "en", now), now);
  // @behavior glossa.word_memory.known_management.preserve_card_history_add Adding a known word preserves existing Anki note history in the lexicon and carded-word store.
  if ((existing?.ankiNoteIds.length ?? 0) > 0) {
    await extensionStorage.cardedWords.put(key, {
      key,
      lang: existing?.lang ?? "en",
      lemma,
      createdAt: existing?.lastClickedAt ?? existing?.lastShownAt ?? now
    });
  }
  await extensionStorage.lexicon.put({ ...shown, state: "known", ankiNoteIds: existing?.ankiNoteIds ?? shown.ankiNoteIds });
  knownWordInput.value = "";
  await refreshKnownWords();
}

function renderKnownWords(records: VocabularyRecord[]): void {
  if (records.length === 0) {
    const empty = document.createElement("p");
    empty.className = "field-help";
    empty.textContent = "当前没有手动记录的 known 词汇。";
    knownWordsList.replaceChildren(empty);
    return;
  }
  knownWordsList.replaceChildren(...records.map((record) => {
    const row = document.createElement("div");
    row.className = "known-word-row";
    row.setAttribute("role", "listitem");
    const word = document.createElement("span");
    word.textContent = record.lemma;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "移除";
    remove.addEventListener("click", () => {
      void removeKnownWord(record);
    });
    row.append(word, remove);
    return row;
  }));
}

// @behavior glossa.word_memory.known_management.preserve_card_history_remove Removing a known word preserves existing Anki note history in the carded-word store.
async function removeKnownWord(record: VocabularyRecord): Promise<void> {
  const key = vocabularyKey(record.lang, record.lemma);
  if (record.ankiNoteIds.length > 0) {
    await extensionStorage.cardedWords.put(key, {
      key,
      lang: record.lang,
      lemma: record.lemma,
      createdAt: record.lastClickedAt ?? record.lastShownAt ?? Date.now()
    });
  }
  await extensionStorage.lexicon.delete(key);
  await refreshKnownWords();
}

async function clearGlossCache(): Promise<void> {
  setStatus("");
  // @behavior glossa.settings_save.clear_gloss_cache The options page clears cached translation labels while leaving vocabulary state unchanged.
  await runtimeMessage(createOptionsMessage("gloss.cache.clear", {}));
  setStatus("翻译缓存已清空");
}

function runtimeMessage(message: OptionsToBackgroundMessage, timeoutMs = 5_000): Promise<BackgroundResponseMessage> {
  return new Promise((resolve, reject) => {
    if (!globalThis.chrome?.runtime?.sendMessage) {
      reject(new Error("chrome.runtime.sendMessage is unavailable"));
      return;
    }
    const timeout = globalThis.setTimeout(() => {
      reject(messageTimeoutError(message));
    }, timeoutMs);
    chrome.runtime.sendMessage(message, (rawResponse: unknown) => {
      globalThis.clearTimeout(timeout);
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      try {
        const response = validateBackgroundResponse(rawResponse, message);
        if (response.type === "error") {
          reject(diagnosticErrorFrom(response.payload, {
            reason: "runtime",
            message: "Background request failed",
            service: "runtime"
          }));
          return;
        }
        resolve(response);
      } catch (validationError) {
        reject(validationError);
      }
    });
  });
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

async function refreshAnkiOptions(settings: GlossaSettings, options: { reportStatus: boolean }): Promise<void> {
  setTestState(refreshAnkiButton, "loading");
  setAnkiSelectsEnabled(false);
  try {
    const catalog = await loadAnkiCatalog(settings.anki.endpoint, settings.anki.requestTimeoutMs);
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

// @behavior glossa.card_creation.note_request.timeout.anki_catalog Anki catalog refresh applies the selected timeout to every AnkiConnect catalog action.
async function loadAnkiCatalog(endpoint: string, timeoutMs: number): Promise<AnkiCatalog> {
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

// @behavior glossa.card_creation.note_request.timeout.anki_action Anki option-page actions pass their timeout into the shared connection request helper.
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

// @behavior glossa.ai_requests.failure.timeout.connection_helper Option-page connection requests abort after the supplied timeout, defaulting to 30 seconds.
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

// @constraint glossa.settings_save.timeout_seconds Timeout settings are stored in milliseconds after positive second values are rounded to whole milliseconds.
function secondsToMs(value: string, fallbackMs: number): number {
  const seconds = Math.max(1, Number(value) || fallbackMs / 1_000);
  return Math.round(seconds * 1_000);
}

function msToSeconds(value: number): number {
  return Math.max(1, Math.round(value / 1_000));
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
