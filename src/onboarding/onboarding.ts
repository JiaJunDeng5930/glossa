// @behavior glossa.onboarding First-run onboarding teaches one Glossa action or setting per page and persists completed setup choices through shared settings storage.
import { KNOWN_WORD_LISTS } from "../core/lexicon";
import { DEFAULT_SETTINGS, type GlossaSettings, type KnownWordListId } from "../shared/types";
import { createExtensionStorage } from "../storage/db";

const storage = createExtensionStorage();
const steps = Array.from(document.querySelectorAll<HTMLElement>("[data-step]"));
const progress = document.querySelector<HTMLElement>("#progress")!;
const continueButton = document.querySelector<HTMLButtonElement>("#continue")!;
const statusOutput = document.querySelector<HTMLOutputElement>("#status")!;
const knownWordList = document.querySelector<HTMLFieldSetElement>("#known-word-list")!;
const textColorInput = input("glossTextColor");
const backgroundColorInput = input("glossBackgroundColor");
const apiKeyInput = input("apiKey");
const ankiEndpointInput = input("ankiEndpoint");
const testAiButton = document.querySelector<HTMLButtonElement>("#test-ai")!;
const testAnkiButton = document.querySelector<HTMLButtonElement>("#test-anki")!;

let currentStep = 0;
let settings: GlossaSettings = DEFAULT_SETTINGS;

populateKnownWordLists();
void loadSettings();

continueButton.addEventListener("click", () => {
  void continueOnboarding();
});

testAiButton.addEventListener("click", () => {
  void runConnectionTest(testAiButton, testAiConnection, "AI 连接成功");
});

testAnkiButton.addEventListener("click", () => {
  void runConnectionTest(testAnkiButton, testAnkiConnection, "Anki 已连接");
});

textColorInput.addEventListener("input", updatePreview);
backgroundColorInput.addEventListener("input", updatePreview);

async function loadSettings(): Promise<void> {
  settings = await storage.settings.get();
  setKnownWordList(settings.knownWordList);
  textColorInput.value = settings.appearance.textColor;
  backgroundColorInput.value = settings.appearance.backgroundColor;
  apiKeyInput.value = settings.ai.apiKey ?? "";
  ankiEndpointInput.value = settings.anki.endpoint;
  updatePreview();
  showStep(0);
}

async function continueOnboarding(): Promise<void> {
  setStatus("");
  await saveCurrentStep();
  if (currentStep >= steps.length - 1) {
    window.close();
    return;
  }
  showStep(currentStep + 1);
}

// @constraint glossa.onboarding.single_topic Only the current onboarding step is visible so each page presents one action or setting.
function showStep(index: number): void {
  currentStep = index;
  steps.forEach((step, stepIndex) => {
    step.hidden = stepIndex !== index;
  });
  progress.textContent = `${index + 1} / ${steps.length}`;
  continueButton.textContent = index === steps.length - 1 ? "完成" : "继续";
  steps[index]?.querySelector("h1")?.focus();
}

// @behavior glossa.onboarding.settings_save Completing a setup step writes that step's setting through the shared settings store while preserving the rest of the current settings.
async function saveCurrentStep(): Promise<void> {
  if (currentStep === 2) {
    settings = { ...settings, knownWordList: readKnownWordList() };
    await storage.settings.set(settings);
    return;
  }
  if (currentStep === 3) {
    settings = {
      ...settings,
      appearance: {
        ...settings.appearance,
        textColor: textColorInput.value,
        backgroundColor: backgroundColorInput.value
      }
    };
    await storage.settings.set(settings);
    return;
  }
  if (currentStep === 4) {
    const apiKey = apiKeyInput.value.trim();
    const ai = { ...settings.ai };
    if (apiKey) {
      ai.apiKey = apiKey;
    } else {
      delete ai.apiKey;
    }
    settings = {
      ...settings,
      ai
    };
    await storage.settings.set(settings);
    return;
  }
  if (currentStep === 5) {
    settings = {
      ...settings,
      anki: {
        ...settings.anki,
        endpoint: ankiEndpointInput.value.trim() || DEFAULT_SETTINGS.anki.endpoint
      }
    };
    await storage.settings.set(settings);
  }
}

function populateKnownWordLists(): void {
  knownWordList.replaceChildren(...KNOWN_WORD_LISTS.map((list) => {
    const label = document.createElement("label");
    label.className = "choice-row";
    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = "knownWordList";
    radio.value = list.id;
    const span = document.createElement("span");
    span.textContent = list.label;
    label.append(radio, span);
    return label;
  }));
}

function readKnownWordList(): KnownWordListId {
  const selected = document.querySelector<HTMLInputElement>("input[name=knownWordList]:checked");
  return isKnownWordList(selected?.value) ? selected.value : DEFAULT_SETTINGS.knownWordList;
}

function setKnownWordList(value: KnownWordListId): void {
  const selected = document.querySelector<HTMLInputElement>(`input[name=knownWordList][value="${value}"]`);
  (selected ?? document.querySelector<HTMLInputElement>("input[name=knownWordList]"))!.checked = true;
}

function isKnownWordList(value: unknown): value is KnownWordListId {
  return typeof value === "string" && KNOWN_WORD_LISTS.some((list) => list.id === value);
}

function updatePreview(): void {
  document.documentElement.style.setProperty("--preview-gloss-text", textColorInput.value);
  document.documentElement.style.setProperty("--preview-gloss-bg", backgroundColorInput.value);
}

// @behavior glossa.onboarding.ai_check The onboarding AI step checks the saved OpenAI Responses endpoint with the entered API key before reporting success.
async function testAiConnection(): Promise<void> {
  const apiKey = apiKeyInput.value.trim();
  if (!apiKey) {
    throw new Error("请输入 API Key");
  }
  await postJson(settings.ai.endpoint, {
    model: settings.modelVersion,
    input: "Return {\"items\":[]} as JSON."
  }, apiKey, settings.ai.requestTimeoutMs);
}

// @behavior glossa.onboarding.anki_check The onboarding Anki step checks the configured AnkiConnect endpoint with the version action before reporting success.
async function testAnkiConnection(): Promise<void> {
  await postJson(ankiEndpointInput.value.trim() || DEFAULT_SETTINGS.anki.endpoint, {
    action: "version",
    version: 6
  }, undefined, settings.anki.requestTimeoutMs);
}

async function runConnectionTest(button: HTMLButtonElement, run: () => Promise<void>, success: string): Promise<void> {
  setStatus("");
  setTestState(button, "loading");
  try {
    await run();
    setTestState(button, "success");
    setStatus(success, "success");
  } catch (error) {
    setTestState(button, "error");
    setStatus(error instanceof Error ? error.message : "连接失败", "error");
  }
}

type TestState = "idle" | "loading" | "success" | "error";

function setTestState(button: HTMLButtonElement, state: TestState): void {
  button.dataset.state = state;
  button.disabled = state === "loading";
}

async function postJson(endpoint: string, body: unknown, apiKey: string | undefined, timeoutMs: number): Promise<void> {
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
      throw new Error(`HTTP ${response.status}`);
    }
  } finally {
    globalThis.clearTimeout(timeout);
  }
}

function input(name: string): HTMLInputElement {
  return document.querySelector<HTMLInputElement>(`input[name="${name}"]`)!;
}

function setStatus(value: string, state: "success" | "error" | "" = ""): void {
  statusOutput.value = value;
  statusOutput.dataset.state = state;
}
