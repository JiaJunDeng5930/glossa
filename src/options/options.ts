import { formatShortcutFromEvent } from "../shared/shortcut";
import { DEFAULT_SETTINGS, type AiSettings, type GlossaSettings } from "../shared/types";

const form = document.querySelector<HTMLFormElement>("#settings-form")!;
const statusOutput = document.querySelector<HTMLOutputElement>("#status")!;
const shortcutCapture = document.querySelector<HTMLButtonElement>("#shortcut-capture")!;
const glossPreview = document.querySelector<HTMLElement>("#gloss-preview")!;
let capturingShortcut = false;
let pendingShortcut = "";

void loadSettings();

form.addEventListener("submit", (event) => {
  event.preventDefault();
  void saveSettings(readFormSettings()).then(() => setStatus("Saved"));
});

document.querySelector<HTMLButtonElement>("#test-ai")!.addEventListener("click", () => {
  void testAi(readFormSettings()).then(
    () => setStatus("AI endpoint returned a valid response"),
    (error) => setStatus(error instanceof Error ? error.message : "AI test failed")
  );
});

document.querySelector<HTMLButtonElement>("#test-anki")!.addEventListener("click", () => {
  void testAnki(readFormSettings()).then(
    () => setStatus("AnkiConnect endpoint is reachable"),
    (error) => setStatus(error instanceof Error ? error.message : "Anki test failed")
  );
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
  setInput("targetLang", settings.targetLang);
  setInput("shortcutKey", settings.shortcutKey);
  shortcutCapture.textContent = settings.shortcutKey;
  setInput("learningWindowDays", String(settings.learningWindowDays));
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
    targetLang: readInput("targetLang").trim() || DEFAULT_SETTINGS.targetLang,
    shortcutKey: readInput("shortcutKey").trim() || DEFAULT_SETTINGS.shortcutKey,
    learningWindowDays: Math.max(1, Number(readInput("learningWindowDays")) || DEFAULT_SETTINGS.learningWindowDays),
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
    ? { sentence: "Submit the form.", tokens: [], targetLang: settings.targetLang, reasoningEffort: settings.ai.reasoningEffort }
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
    throw new Error(`AI HTTP ${response.status}`);
  }
}

async function testAnki(settings: GlossaSettings): Promise<void> {
  const response = await fetch(settings.anki.endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "version", version: 6 })
  });
  if (!response.ok) {
    throw new Error(`Anki HTTP ${response.status}`);
  }
}

function mergeSettings(value: Partial<GlossaSettings> | undefined): GlossaSettings {
  const ai = { ...DEFAULT_SETTINGS.ai, ...value?.ai };
  return {
    ...DEFAULT_SETTINGS,
    ...value,
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
  glossPreview.style.color = settings.appearance.textColor;
  glossPreview.style.backgroundColor = hexToRgb(settings.appearance.backgroundColor, settings.appearance.backgroundOpacity);
  glossPreview.style.fontFamily = settings.appearance.fontFamily;
  glossPreview.style.fontSize = `${settings.appearance.fontSize}px`;
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
