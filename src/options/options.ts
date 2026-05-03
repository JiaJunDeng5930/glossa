import { DEFAULT_SETTINGS, type AiSettings, type GlossaSettings } from "../shared/types";

const form = document.querySelector<HTMLFormElement>("#settings-form")!;
const statusOutput = document.querySelector<HTMLOutputElement>("#status")!;

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

async function loadSettings(): Promise<void> {
  const settings = await chromeLocalGet<GlossaSettings>("settings").then((value) => mergeSettings(value));
  setInput("targetLang", settings.targetLang);
  setInput("shortcutKey", settings.shortcutKey);
  setInput("learningWindowDays", String(settings.learningWindowDays));
  setInput("provider", settings.ai.provider);
  setInput("aiEndpoint", settings.ai.endpoint);
  setInput("apiKey", settings.ai.apiKey ?? "");
  setInput("modelVersion", settings.modelVersion);
  setInput("ankiEndpoint", settings.anki.endpoint);
  setInput("ankiDeck", settings.anki.deck);
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
    ai: {
      provider,
      endpoint: readInput("aiEndpoint").trim() || DEFAULT_SETTINGS.ai.endpoint,
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
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(settings.ai.apiKey ? { authorization: `Bearer ${settings.ai.apiKey}` } : {})
    },
    body: JSON.stringify(settings.ai.provider === "glossa-backend"
      ? { sentence: "Submit the form.", tokens: [], targetLang: settings.targetLang }
      : { model: settings.modelVersion, input: "Return {\"items\":[]} as JSON." })
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
  return {
    ...DEFAULT_SETTINGS,
    ...value,
    ai: { ...DEFAULT_SETTINGS.ai, ...value?.ai },
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

function chromeLocalGet<T>(key: string): Promise<T | undefined> {
  return new Promise((resolve) => chrome.storage.local.get(key, (result) => resolve(result[key] as T | undefined)));
}

function chromeLocalSet<T>(key: string, value: T): Promise<void> {
  return new Promise((resolve) => chrome.storage.local.set({ [key]: value }, () => resolve()));
}
