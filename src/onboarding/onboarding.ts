// @behavior glossa.onboarding First-run onboarding teaches one Glossa action or setting per page and persists completed setup choices through shared settings storage.
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
// @constraint glossa.onboarding.step_collection Onboarding step state comes from the page's data-step sections.
const steps = Array.from(document.querySelectorAll<HTMLElement>("[data-step]"));
const progress = document.querySelector<HTMLElement>("#progress")!;
const continueButton = document.querySelector<HTMLButtonElement>("#continue")!;
// @constraint glossa.onboarding.status_output Onboarding status state is written to the shared status output element.
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

populateKnownWordSelect(knownWordListSelect);
void loadSettings();

continueButton.addEventListener("click", () => {
  void continueOnboarding();
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
  // @behavior glossa.onboarding.ai_check The onboarding AI step runs the shared settings-page AI connection test against the current onboarding form.
  void runSettingsConnectionTest(testAiButton, () => testAiSettings(readCurrentSettings()), "ai", setStatus, "AI 连接成功");
});

testAnkiButton.addEventListener("click", () => {
  // @behavior glossa.onboarding.anki_check The onboarding Anki step runs the shared settings-page Anki catalog validation against the current onboarding form.
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
  void refreshAnkiOptions(settings, { reportStatus: false });
}

async function continueOnboarding(): Promise<void> {
  setStatus("");
  settings = readCurrentSettings();
  // @behavior glossa.onboarding.settings_save Completing a setup step writes the current onboarding form through the shared settings form normalizer.
  await storage.settings.set(settings);
  if (currentStep >= steps.length - 1) {
    window.close();
    return;
  }
  showStep(currentStep + 1);
}

// @constraint glossa.onboarding.single_topic Only the current onboarding step is visible so each page presents one action or setting.
function showStep(index: number): void {
  currentStep = index;
  // @constraint glossa.onboarding.single_topic.visibility_write Step rendering hides every inactive page section.
  steps.forEach((step, stepIndex) => {
    step.hidden = stepIndex !== index;
  });
  progress.textContent = `${index + 1} / ${steps.length}`;
  continueButton.textContent = index === steps.length - 1 ? "完成" : "继续";
  steps[index]?.querySelector("h1")?.focus();
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

// @behavior glossa.onboarding.anki_refresh The onboarding Anki step refreshes deck and model choices from AnkiConnect while keeping defaults available on failure.
async function refreshAnkiOptions(nextSettings: GlossaSettings, options: { reportStatus: boolean }): Promise<void> {
  setTestState(refreshAnkiButton, "loading");
  setAnkiSelectsEnabled(false);
  // @behavior glossa.onboarding.anki_refresh.failure_state Anki refresh failures keep configured defaults visible and mark refresh as an error state.
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

// @behavior glossa.onboarding.status_state Onboarding status output marks AI and Anki successes as success and other visible messages as errors.
function setStatus(value: string): void {
  statusOutput.value = value;
  // @behavior glossa.onboarding.status_state.dataset Onboarding status output stores a success state for successful AI or Anki checks and an error state for other messages.
  statusOutput.dataset.state = value === "AI 连接成功" || value === "Anki 已连接" ? "success" : value ? "error" : "";
}
