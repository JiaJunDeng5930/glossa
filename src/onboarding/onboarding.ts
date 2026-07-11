import { defaultEndpointForProvider } from "../shared/settings";
import {
  applyAppearancePreview,
  loadAnkiCatalog,
  pickExistingValue,
  populateKnownWordSelect,
  readFormInput,
  readSettingsForm,
  runSettingsConnectionTest,
  setFormInput,
  setSelectOptions,
  setTestState,
  testAiSettings,
  testAnkiSettings,
  writeSettingsForm
} from "../shared/settingsForm";
import { DEFAULT_SETTINGS, type GlossaSettings } from "../shared/types";
import { createExtensionStorage } from "../storage/db";

const storage = createExtensionStorage();
const form = document.querySelector<HTMLFormElement>("#settings-form")!;
const steps = Array.from(document.querySelectorAll<HTMLElement>("[data-step]"));
const progress = document.querySelector<HTMLElement>("#progress")!;
const continueButton = document.querySelector<HTMLButtonElement>("#continue")!;
const backButton = document.querySelector<HTMLButtonElement>("#back")!;
const skipAnkiButton = document.querySelector<HTMLButtonElement>("#skip-anki")!;
const statusOutput = document.querySelector<HTMLOutputElement>("#status")!;
const providerSelect = form.elements.namedItem("provider") as HTMLSelectElement;
const apiKeyField = document.querySelector<HTMLElement>("[data-ai-field='api-key']")!;
const reasoningField = document.querySelector<HTMLElement>("[data-ai-field='reasoning']")!;
const knownWordListSelect = form.elements.namedItem("knownWordList") as HTMLSelectElement;
const ankiDeckSelect = form.elements.namedItem("ankiDeck") as HTMLSelectElement;
const ankiModelNameSelect = form.elements.namedItem("ankiModelName") as HTMLSelectElement;
const refreshAnkiButton = document.querySelector<HTMLButtonElement>("#refresh-anki")!;
const testAiButton = document.querySelector<HTMLButtonElement>("#test-ai")!;
const testAnkiButton = document.querySelector<HTMLButtonElement>("#test-anki")!;
const aiStatus = document.querySelector<HTMLOutputElement>("#ai-status")!;
const ankiStatus = document.querySelector<HTMLOutputElement>("#anki-status")!;
const glossPreview = document.querySelector<HTMLElement>("#gloss-preview")!;
const glossPreviewLabels = Array.from(document.querySelectorAll<HTMLElement>(".preview-gloss"));
const glossPreviewSuccessLabels = Array.from(document.querySelectorAll<HTMLElement>(".preview-gloss-success"));
const glossPreviewErrorLabels = Array.from(document.querySelectorAll<HTMLElement>(".preview-gloss-error"));
const glossBackgroundOpacityInput = form.elements.namedItem("glossBackgroundOpacity") as HTMLInputElement;
const glossBackgroundOpacityValue = document.querySelector<HTMLOutputElement>("#gloss-background-opacity-value")!;

let currentStep = 0;
let settings: GlossaSettings = DEFAULT_SETTINGS;
let continueInFlight = false;
let verifiedAiSettings: string | undefined;
let verifiedAnkiSettings: string | undefined;
let currentProvider = providerSelect.value as GlossaSettings["ai"]["provider"];

populateKnownWordSelect(knownWordListSelect);
void loadSettings().catch(() => setStatus("设置加载失败，请重新打开页面"));

continueButton.addEventListener("click", () => {
  startContinue(false);
});

skipAnkiButton.addEventListener("click", () => {
  startContinue(true);
});

function startContinue(skipAnki: boolean): void {
  if (continueInFlight) {
    return;
  }
  continueInFlight = true;
  setNavigationBusy(true);
  void continueOnboarding(skipAnki).catch(() => {
    setStatus("设置保存失败，请重试");
  }).finally(() => {
    continueInFlight = false;
    setNavigationBusy(false);
  });
}

backButton.addEventListener("click", () => {
  setStatus("");
  showStep(Math.max(0, currentStep - 1));
});

form.addEventListener("submit", (event) => {
  event.preventDefault();
});

form.addEventListener("input", () => {
  const nextSettings = readCurrentSettings();
  updatePreview(nextSettings);
  if (verifiedAiSettings && verifiedAiSettings !== aiConnectionKey(nextSettings)) {
    verifiedAiSettings = undefined;
    setTestState(testAiButton, "idle");
    setAiStatus("");
  }
  if (verifiedAnkiSettings && verifiedAnkiSettings !== ankiConnectionKey(nextSettings)) {
    verifiedAnkiSettings = undefined;
    setTestState(testAnkiButton, "idle");
    setAnkiStatus("");
  }
});

providerSelect.addEventListener("change", () => {
  const provider = readFormInput(form, "provider") as GlossaSettings["ai"]["provider"];
  const endpoint = readFormInput(form, "aiEndpoint").trim();
  if (!endpoint || endpoint === defaultEndpointForProvider(currentProvider)) {
    setFormInput(form, "aiEndpoint", defaultEndpointForProvider(provider));
  }
  currentProvider = provider;
  updateProviderFields(provider);
});

refreshAnkiButton.addEventListener("click", () => {
  void refreshAnkiOptions(readCurrentSettings(), { reportStatus: true });
});

testAiButton.addEventListener("click", () => {
  const nextSettings = readCurrentSettings();
  void runSettingsConnectionTest(testAiButton, () => testAiSettings(nextSettings), "ai", setAiStatus, "AI 连接成功").then((verified) => {
    verifiedAiSettings = verified ? aiConnectionKey(nextSettings) : undefined;
  });
});

testAnkiButton.addEventListener("click", () => {
  const nextSettings = readCurrentSettings();
  void runSettingsConnectionTest(testAnkiButton, () => testAnkiSettings(nextSettings), "anki", setAnkiStatus, "Anki 已连接").then((verified) => {
    verifiedAnkiSettings = verified ? ankiConnectionKey(nextSettings) : undefined;
  });
});

async function loadSettings(): Promise<void> {
  settings = await storage.settings.get();
  writeSettingsForm(form, settings);
  currentProvider = settings.ai.provider;
  updateProviderFields(settings.ai.provider);
  setSelectOptions(ankiDeckSelect, [settings.anki.deck], settings.anki.deck);
  setSelectOptions(ankiModelNameSelect, [settings.anki.modelName], settings.anki.modelName);
  setAnkiSelectsEnabled(false);
  updatePreview(settings);
  showStep(0);
  setTestState(refreshAnkiButton, "idle");
}

async function continueOnboarding(skipAnki: boolean): Promise<void> {
  setStatus("");
  const nextSettings = readCurrentSettings();
  if (currentStep === 5 && verifiedAiSettings !== aiConnectionKey(nextSettings)) {
    setAiStatus("请先测试 AI 连接");
    return;
  }
  if (currentStep === 6 && !skipAnki && verifiedAnkiSettings !== ankiConnectionKey(nextSettings)) {
    setAnkiStatus("请连接 Anki，或选择跳过");
    return;
  }
  settings = nextSettings;
  await storage.settings.set(settings);
  if (currentStep >= steps.length - 1) {
    window.close();
    return;
  }
  showStep(currentStep + 1);
}

function showStep(index: number): void {
  currentStep = index;
  steps.forEach((step, stepIndex) => {
    step.hidden = stepIndex !== index;
  });
  progress.textContent = `${index + 1} / ${steps.length}`;
  continueButton.textContent = index === steps.length - 1 ? "完成" : "继续";
  backButton.hidden = index === 0;
  skipAnkiButton.hidden = index !== 6;
  const heading = steps[index]?.querySelector<HTMLHeadingElement>("h1");
  if (heading) {
    heading.tabIndex = -1;
    heading.focus();
  }
}

function readCurrentSettings(): GlossaSettings {
  return readSettingsForm(form, settings);
}

function updatePreview(nextSettings: GlossaSettings): void {
  applyAppearancePreview({
    preview: glossPreview,
    labels: glossPreviewLabels,
    successLabels: glossPreviewSuccessLabels,
    errorLabels: glossPreviewErrorLabels
  }, nextSettings.appearance);
  const opacityPercent = `${Math.round(nextSettings.appearance.backgroundOpacity * 100)}%`;
  glossBackgroundOpacityValue.value = opacityPercent;
  glossBackgroundOpacityInput.setAttribute("aria-valuetext", opacityPercent);
}

async function refreshAnkiOptions(nextSettings: GlossaSettings, options: { reportStatus: boolean }): Promise<void> {
  setTestState(refreshAnkiButton, "loading");
  setAnkiSelectsEnabled(false);
  if (options.reportStatus) {
    setAnkiStatus("正在读取 Anki 选项…");
  }
  try {
    const catalog = await loadAnkiCatalog(nextSettings.anki.endpoint, nextSettings.anki.requestTimeoutMs);
    const deck = pickExistingValue(nextSettings.anki.deck, catalog.decks);
    const modelName = pickExistingValue(nextSettings.anki.modelName, catalog.modelNames);
    setSelectOptions(ankiDeckSelect, catalog.decks, deck);
    setSelectOptions(ankiModelNameSelect, catalog.modelNames, modelName);
    setAnkiSelectsEnabled(true);
    setTestState(refreshAnkiButton, "idle");
    if (options.reportStatus) {
      setAnkiStatus("Anki 选项已更新");
    }
  } catch {
    setSelectOptions(ankiDeckSelect, [nextSettings.anki.deck], nextSettings.anki.deck);
    setSelectOptions(ankiModelNameSelect, [nextSettings.anki.modelName], nextSettings.anki.modelName);
    setAnkiSelectsEnabled(true);
    setTestState(refreshAnkiButton, "error");
    if (options.reportStatus) {
      setAnkiStatus("无法读取 Anki 选项，请确认 Anki 已打开");
    }
  }
}

function setAnkiSelectsEnabled(enabled: boolean): void {
  ankiDeckSelect.disabled = !enabled;
  ankiModelNameSelect.disabled = !enabled;
}

function setStatus(value: string): void {
  statusOutput.value = value;
  statusOutput.dataset.state = value === "AI 连接成功" || value === "Anki 已连接" ? "success" : value ? "error" : "";
}

function updateProviderFields(provider: GlossaSettings["ai"]["provider"]): void {
  apiKeyField.hidden = provider === "glossa-backend";
  reasoningField.hidden = provider === "openai-completions";
}

function setAiStatus(value: string): void {
  aiStatus.value = value;
  aiStatus.dataset.state = value === "AI 连接成功" ? "success" : value ? "error" : "";
}

function setAnkiStatus(value: string): void {
  ankiStatus.value = value;
  ankiStatus.dataset.state = value === "Anki 已连接" || value === "Anki 选项已更新"
    ? "success"
    : value.startsWith("正在")
      ? "pending"
      : value
        ? "error"
        : "";
}

function setNavigationBusy(busy: boolean): void {
  continueButton.disabled = busy;
  backButton.disabled = busy;
  skipAnkiButton.disabled = busy;
}

function aiConnectionKey(value: GlossaSettings): string {
  return JSON.stringify([
    value.ai.provider,
    value.ai.endpoint,
    value.ai.apiKey ?? "",
    value.modelVersion,
    value.ai.reasoningEffort,
    value.ai.requestTimeoutMs
  ]);
}

function ankiConnectionKey(value: GlossaSettings): string {
  return JSON.stringify([
    value.anki.endpoint,
    value.anki.deck,
    value.anki.modelName,
    value.anki.requestTimeoutMs
  ]);
}
