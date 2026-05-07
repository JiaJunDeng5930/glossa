import { KNOWN_WORD_LISTS } from "../core/lexicon";
import { formatShortcutFromEvent } from "../shared/shortcut";
import { DEFAULT_SETTINGS, GLOSS_TARGET_LANG, type AiSettings, type GlossaSettings, type KnownWordListId } from "../shared/types";

const form = document.querySelector<HTMLFormElement>("#settings-form")!;
const statusOutput = document.querySelector<HTMLOutputElement>("#status")!;
const shortcutCapture = document.querySelector<HTMLButtonElement>("#shortcut-capture")!;
const translateShortcutCapture = document.querySelector<HTMLButtonElement>("#translate-shortcut-capture")!;
const glossPreview = document.querySelector<HTMLElement>("#gloss-preview")!;
const glossPreviewLabels = Array.from(document.querySelectorAll<HTMLElement>(".preview-gloss"));
const glossPreviewSuccessLabels = Array.from(document.querySelectorAll<HTMLElement>(".preview-gloss-success"));
const glossPreviewErrorLabels = Array.from(document.querySelectorAll<HTMLElement>(".preview-gloss-error"));
const knownWordListSelect = form.elements.namedItem("knownWordList") as HTMLSelectElement;
const testAiButton = document.querySelector<HTMLButtonElement>("#test-ai")!;
const testAnkiButton = document.querySelector<HTMLButtonElement>("#test-anki")!;
let capturingShortcutName: "shortcutKey" | "translateShortcutKey" | undefined;
let pendingShortcut = "";

populateKnownWordLists();
void loadSettings();

form.addEventListener("submit", (event) => {
  event.preventDefault();
  void saveSettings(readFormSettings()).then(() => setStatus("已保存"));
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
  serviceName: string
): Promise<void> {
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
      return `${serviceName} 拒绝了请求，请检查 API 密钥或访问权限。`;
    }
    if (error.status === 404) {
      return `${serviceName} 接口可以访问，但测试路径不存在，请检查接口地址。`;
    }
    if (error.status >= 500) {
      return `${serviceName} 接口可以访问，但服务返回了错误，请在服务恢复后重试。`;
    }
    return `${serviceName} 接口返回 HTTP ${error.status}，请检查接口设置。`;
  }
  if (error instanceof DOMException && error.name === "AbortError") {
    return `${serviceName} 测试超时，请检查接口服务是否正在运行且可以访问。`;
  }
  if (error instanceof TypeError) {
    return `${serviceName} 接口无法访问，请检查地址和网络连接。`;
  }
  return `${serviceName} 测试失败，请检查接口设置。`;
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
