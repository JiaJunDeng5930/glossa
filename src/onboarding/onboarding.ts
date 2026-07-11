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
const statusOutput = document.querySelector<HTMLOutputElement>("#status")!;
const providerSelect = form.elements.namedItem("provider") as HTMLSelectElement;
const knownWordListSelect = form.elements.namedItem("knownWordList") as HTMLSelectElement;
const ankiDeckSelect = form.elements.namedItem("ankiDeck") as HTMLSelectElement;
const ankiModelNameSelect = form.elements.namedItem("ankiModelName") as HTMLSelectElement;
const refreshAnkiButton = document.querySelector<HTMLButtonElement>("#refresh-anki")!;
const testAiButton = document.querySelector<HTMLButtonElement>("#test-ai")!;
const testAnkiButton = document.querySelector<HTMLButtonElement>("#test-anki")!;
const glossPreview = document.querySelector<HTMLElement>("#gloss-preview")!;
const glossPreviewLabels = Array.from(document.querySelectorAll<HTMLElement>(".preview-gloss"));
const glossPreviewSuccessLabels = Array.from(document.querySelectorAll<HTMLElement>(".preview-gloss-success"));
const glossPreviewErrorLabels = Array.from(document.querySelectorAll<HTMLElement>(".preview-gloss-error"));

let currentStep = 0;
let settings: GlossaSettings = DEFAULT_SETTINGS;
let continueInFlight = false;

populateKnownWordSelect(knownWordListSelect);
void loadSettings();

continueButton.addEventListener("click", () => {
  if (continueInFlight) {
    return;
  }
  continueInFlight = true;
  continueButton.disabled = true;
  void continueOnboarding().finally(() => {
    continueInFlight = false;
    continueButton.disabled = false;
  });
});

form.addEventListener("submit", (event) => {
  event.preventDefault();
});

form.addEventListener("input", () => {
  updatePreview(readCurrentSettings());
});

providerSelect.addEventListener("change", () => {
  setFormInput(form, "aiEndpoint", defaultEndpointForProvider(readFormInput(form, "provider") as GlossaSettings["ai"]["provider"]));
});

refreshAnkiButton.addEventListener("click", () => {
  void refreshAnkiOptions(readCurrentSettings(), { reportStatus: true });
});

testAiButton.addEventListener("click", () => {
  void runSettingsConnectionTest(testAiButton, () => testAiSettings(readCurrentSettings()), "ai", setStatus, "AI 连接成功");
});

testAnkiButton.addEventListener("click", () => {
  void runSettingsConnectionTest(testAnkiButton, () => testAnkiSettings(readCurrentSettings()), "anki", setStatus, "Anki 已连接");
});

async function loadSettings(): Promise<void> {
  settings = await storage.settings.get();
  writeSettingsForm(form, settings);
  setSelectOptions(ankiDeckSelect, [settings.anki.deck], settings.anki.deck);
  setSelectOptions(ankiModelNameSelect, [settings.anki.modelName], settings.anki.modelName);
  setAnkiSelectsEnabled(false);
  updatePreview(settings);
  showStep(0);
  setTestState(refreshAnkiButton, "idle");
}

async function continueOnboarding(): Promise<void> {
  setStatus("");
  settings = readCurrentSettings();
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
}

async function refreshAnkiOptions(nextSettings: GlossaSettings, options: { reportStatus: boolean }): Promise<void> {
  setTestState(refreshAnkiButton, "loading");
  setAnkiSelectsEnabled(false);
  try {
    const catalog = await loadAnkiCatalog(nextSettings.anki.endpoint, nextSettings.anki.requestTimeoutMs);
    const deck = pickExistingValue(nextSettings.anki.deck, catalog.decks);
    const modelName = pickExistingValue(nextSettings.anki.modelName, catalog.modelNames);
    setSelectOptions(ankiDeckSelect, catalog.decks, deck);
    setSelectOptions(ankiModelNameSelect, catalog.modelNames, modelName);
    setAnkiSelectsEnabled(true);
    setTestState(refreshAnkiButton, "idle");
    if (options.reportStatus) {
      setStatus("");
    }
  } catch {
    setSelectOptions(ankiDeckSelect, [nextSettings.anki.deck], nextSettings.anki.deck);
    setSelectOptions(ankiModelNameSelect, [nextSettings.anki.modelName], nextSettings.anki.modelName);
    setAnkiSelectsEnabled(false);
    setTestState(refreshAnkiButton, "error");
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
