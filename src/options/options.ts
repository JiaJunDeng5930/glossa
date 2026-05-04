import { KNOWN_WORD_LISTS } from "../core/lexicon";
import { formatShortcutFromEvent } from "../shared/shortcut";
import { DEFAULT_SETTINGS, GLOSS_TARGET_LANG, type AiSettings, type GlossaSettings, type KnownWordListId } from "../shared/types";

const form = document.querySelector<HTMLFormElement>("#settings-form")!;
const statusOutput = document.querySelector<HTMLOutputElement>("#status")!;
const shortcutCapture = document.querySelector<HTMLButtonElement>("#shortcut-capture")!;
const glossPreview = document.querySelector<HTMLElement>("#gloss-preview")!;
const glossPreviewLabels = Array.from(document.querySelectorAll<HTMLElement>(".preview-gloss"));
const knownWordListSelect = form.elements.namedItem("knownWordList") as HTMLSelectElement;
const testAiButton = document.querySelector<HTMLButtonElement>("#test-ai")!;
const testAnkiButton = document.querySelector<HTMLButtonElement>("#test-anki")!;
let capturingShortcut = false;
let pendingShortcut = "";

populateKnownWordLists();
void loadSettings();

form.addEventListener("submit", (event) => {
  event.preventDefault();
  void saveSettings(readFormSettings()).then(() => setStatus("Saved"));
});

testAiButton.addEventListener("click", () => {
  void runConnectionTest(testAiButton, () => testAi(readFormSettings()), "AI");
});

testAnkiButton.addEventListener("click", () => {
  void runConnectionTest(testAnkiButton, () => testAnki(readFormSettings()), "AnkiConnect");
});

const providerSelect = form.elements.namedItem("provider") as HTMLSelectElement;
providerSelect.addEventListener("change", () => {
  const provider = readInput("provider") as AiSettings["provider"];
  setInput("aiEndpoint", defaultEndpointForProvider(provider));
});

shortcutCapture.addEventListener("click", () => {
  capturingShortcut = true;
  pendingShortcut = "";
  shortcutCapture.textContent = "Press keys";
  shortcutCapture.focus();
});

document.addEventListener("keydown", (event) => {
  if (!capturingShortcut) {
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  pendingShortcut = formatShortcutFromEvent(event);
  shortcutCapture.textContent = pendingShortcut;
  if (!isModifierKey(event.key)) {
    finishShortcutCapture();
  }
});

document.addEventListener("keyup", (event) => {
  if (!capturingShortcut || !pendingShortcut) {
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
  setInput("learningWindowDays", String(settings.learningWindowDays));
  setInput("knownWordList", settings.knownWordList);
  setInput("glossTextColor", settings.appearance.textColor);
  setInput("glossBackgroundColor", settings.appearance.backgroundColor);
  setInput("glossBackgroundOpacity", String(settings.appearance.backgroundOpacity));
  setInput("glossFontFamily", settings.appearance.fontFamily);
  setInput("glossFontSize", String(settings.appearance.fontSize));
  setInput("provider", settings.ai.provider);
  setInput("aiEndpoint", settings.ai.endpoint);
  setInput("apiKey", settings.ai.apiKey ?? "");
  setInput("reasoningEffort", settings.ai.reasoningEffort);
  setInput("modelVersion", settings.modelVersion);
  setInput("ankiEndpoint", settings.anki.endpoint);
  setInput("ankiDeck", settings.anki.deck);
  setInput("glossPrompt", settings.prompts.gloss);
  setInput("ankiPrompt", settings.prompts.ankiCard);
  updatePreview(settings);
}

async function saveSettings(settings: GlossaSettings): Promise<void> {
  await chromeLocalSet("settings", settings);
}

function readFormSettings(): GlossaSettings {
  const provider = readInput("provider") as AiSettings["provider"];
  const apiKey = readInput("apiKey").trim();
  return {
    shortcutKey: readInput("shortcutKey").trim() || DEFAULT_SETTINGS.shortcutKey,
    learningWindowDays: Math.max(1, Number(readInput("learningWindowDays")) || DEFAULT_SETTINGS.learningWindowDays),
    knownWordList: readKnownWordList(),
    promptVersion: DEFAULT_SETTINGS.promptVersion,
    modelVersion: readInput("modelVersion").trim() || DEFAULT_SETTINGS.modelVersion,
    appearance: {
      textColor: readInput("glossTextColor") || DEFAULT_SETTINGS.appearance.textColor,
      backgroundColor: readInput("glossBackgroundColor") || DEFAULT_SETTINGS.appearance.backgroundColor,
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
      deck: readInput("ankiDeck").trim() || DEFAULT_SETTINGS.anki.deck
    }
  };
}

async function testAi(settings: GlossaSettings): Promise<void> {
  const endpoint = settings.ai.provider === "glossa-backend"
    ? `${settings.ai.endpoint.replace(/\/+$/, "")}/gloss`
    : settings.ai.endpoint;
  const body = settings.ai.provider === "glossa-backend"
    ? { sentence: "Submit the form.", tokens: [], targetLang: GLOSS_TARGET_LANG, reasoningEffort: settings.ai.reasoningEffort }
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
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(settings.ai.apiKey ? { authorization: `Bearer ${settings.ai.apiKey}` } : {})
    },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    throw new EndpointStatusError("AI", response.status);
  }
}

async function testAnki(settings: GlossaSettings): Promise<void> {
  const response = await fetch(settings.anki.endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "version", version: 6 })
  });
  if (!response.ok) {
    throw new EndpointStatusError("AnkiConnect", response.status);
  }
}

function mergeSettings(value: Partial<GlossaSettings> | undefined): GlossaSettings {
  const ai = { ...DEFAULT_SETTINGS.ai, ...value?.ai };
  return {
    ...DEFAULT_SETTINGS,
    ...value,
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

function setStatus(value: string): void {
  statusOutput.value = value;
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

async function runConnectionTest(button: HTMLButtonElement, run: () => Promise<void>, serviceName: string): Promise<void> {
  setStatus("");
  setTestState(button, "loading");
  try {
    await run();
    setTestState(button, "success");
  } catch (error) {
    setTestState(button, "error");
    setStatus(friendlyConnectionError(serviceName, error));
  }
}

type TestState = "idle" | "loading" | "success" | "error";

function setTestState(button: HTMLButtonElement, state: TestState): void {
  button.dataset.state = state;
  button.disabled = state === "loading";
}

class EndpointStatusError extends Error {
  constructor(readonly serviceName: string, readonly status: number) {
    super(`${serviceName} returned HTTP ${status}`);
  }
}

function friendlyConnectionError(serviceName: string, error: unknown): string {
  if (error instanceof EndpointStatusError) {
    if (error.status === 401 || error.status === 403) {
      return `${serviceName} rejected the request. Check the API key or access setting.`;
    }
    if (error.status === 404) {
      return `${serviceName} endpoint was reached, and the test path was missing. Check the endpoint URL.`;
    }
    if (error.status >= 500) {
      return `${serviceName} endpoint is reachable, and it reported a server error. Try again after the service is healthy.`;
    }
    return `${serviceName} endpoint returned HTTP ${error.status}. Check the endpoint setting.`;
  }
  if (error instanceof DOMException && error.name === "AbortError") {
    return `${serviceName} test timed out. Check that the endpoint is running and reachable.`;
  }
  if (error instanceof TypeError) {
    return `${serviceName} endpoint could not be reached. Check the URL and network access.`;
  }
  return `${serviceName} test failed. Check the endpoint setting.`;
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

function reasoningBody(settings: GlossaSettings): { reasoning?: { effort: Exclude<GlossaSettings["ai"]["reasoningEffort"], "none"> } } {
  if (settings.ai.reasoningEffort === "none") {
    return {};
  }
  return { reasoning: { effort: settings.ai.reasoningEffort } };
}

function finishShortcutCapture(): void {
  setInput("shortcutKey", pendingShortcut);
  shortcutCapture.textContent = pendingShortcut;
  capturingShortcut = false;
  pendingShortcut = "";
  setStatus("Shortcut captured");
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
  return new Promise((resolve) => chrome.storage.local.get(key, (result) => resolve(result[key] as T | undefined)));
}

function chromeLocalSet<T>(key: string, value: T): Promise<void> {
  return new Promise((resolve) => chrome.storage.local.set({ [key]: value }, () => resolve()));
}
