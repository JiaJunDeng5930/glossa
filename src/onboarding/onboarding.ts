import { diagnosticErrorFrom } from "../shared/errors";
import { createRequestMessage, type RequestMessage, type ResponseMessage, type RuntimeRequestType } from "../shared/messages";
import { sendRuntimeRequest } from "../shared/runtimeClient";
import { aiConnectionKey, ankiConnectionKey, diffSettings, type SettingsPatch } from "../shared/settings";
import { claimFeedback, createAnkiCatalogController, createConnectionController, createFeedbackChannel, type OperationState, type OperationToken } from "../shared/connectionController";
import {
  applyAppearancePreview,
  applyProviderChange,
  applyProviderFields,
  pickExistingValue,
  populateKnownWordSelect,
  populateProviderSelect,
  populateReasoningEffortSelect,
  readFormInput,
  readSettingsForm,
  setSelectOptions,
  setTestState,
  writeSettingsForm
} from "../shared/settingsForm";
import { createSettingsDraft, type SettingsDraft } from "../shared/settingsDraft";
import { DEFAULT_SETTINGS, type AiSettings, type AnkiSettings, type GlossaSettings } from "../shared/types";
import { userMessageForError } from "../shared/userMessages";
import { createAiClient } from "../shared/services/aiClient";
import { createAnkiClient } from "../shared/services/ankiClient";

type StepId = "smart" | "translation" | "anki-click" | "word-list" | "appearance" | "ai" | "anki" | "finish";
const STEP_IDS: readonly StepId[] = ["smart", "translation", "anki-click", "word-list", "appearance", "ai", "anki", "finish"];
const form = document.querySelector<HTMLFormElement>("#settings-form")!;
form.inert = true;
const steps = Array.from(document.querySelectorAll<HTMLElement>("[data-step]"));
const progress = document.querySelector<HTMLElement>("#progress")!;
const continueButton = document.querySelector<HTMLButtonElement>("#continue")!;
const backButton = document.querySelector<HTMLButtonElement>("#back")!;
const skipAnkiButton = document.querySelector<HTMLButtonElement>("#skip-anki")!;
const statusOutput = document.querySelector<HTMLOutputElement>("#status")!;
const providerSelect = form.elements.namedItem("provider") as HTMLSelectElement;
const reasoningSelect = form.elements.namedItem("reasoningEffort") as HTMLSelectElement;
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

let currentStepIndex = 0;
let navigationBusy = false;
let draft: SettingsDraft | undefined;
let aiController: ReturnType<typeof createConnectionController<GlossaSettings>> | undefined;
let ankiController: ReturnType<typeof createConnectionController<AnkiSettings>> | undefined;
let catalogController: ReturnType<typeof createAnkiCatalogController<AnkiSettings, { decks: string[]; modelNames: string[] }>> | undefined;
let providerBeforeInput: AiSettings["provider"] | undefined;
let formValidationError = false;
const ankiFeedback = createFeedbackChannel();

populateProviderSelect(providerSelect);
populateReasoningEffortSelect(reasoningSelect);
populateKnownWordSelect(knownWordListSelect);
const validSteps = validateStepIdentities();
if (validSteps) {
  installStorageListener();
  void loadSettings().catch(() => setStatus("设置加载失败，请重新打开页面", "error"));
} else {
  setStatus("首次设置页面初始化失败，请重新打开页面", "error");
}

continueButton.addEventListener("click", () => startContinue(false));
skipAnkiButton.addEventListener("click", () => startContinue(true));
backButton.addEventListener("click", () => {
  if (navigationBusy) return;
  setStatus("", "");
  showStep(Math.max(0, currentStepIndex - 1));
});
form.addEventListener("submit", (event) => event.preventDefault());
form.addEventListener("input", editDraftFromForm);
providerSelect.addEventListener("input", () => {
  providerBeforeInput = draft?.value.ai.provider;
});
providerSelect.addEventListener("change", () => {
  if (!draft) return;
  const provider = readFormInput(form, "provider") as AiSettings["provider"];
  const previousProvider = providerBeforeInput ?? draft.value.ai.provider;
  providerBeforeInput = undefined;
  applyProviderChange(form, previousProvider, provider);
  editDraftFromForm();
});
testAiButton.addEventListener("click", () => {
  if (canRunSettingsOperation()) aiController?.test();
});
testAnkiButton.addEventListener("click", () => {
  if (canRunSettingsOperation()) ankiController?.test();
});
refreshAnkiButton.addEventListener("click", () => {
  if (canRunSettingsOperation()) catalogController?.refresh();
});
ankiDeckSelect.addEventListener("change", editDraftFromForm);
ankiModelNameSelect.addEventListener("change", editDraftFromForm);

function validateStepIdentities(): boolean {
  if (steps.length !== STEP_IDS.length) return false;
  const identities = steps.map((step) => step.dataset.step);
  return identities.every((identity, index): identity is StepId => identity === STEP_IDS[index])
    && new Set(identities).size === STEP_IDS.length;
}

function currentStepId(): StepId {
  return steps[currentStepIndex]!.dataset.step as StepId;
}

function startContinue(skipAnki: boolean): void {
  if (navigationBusy) return;
  navigationBusy = true;
  setNavigationBusy(true);
  void continueOnboarding(skipAnki).catch(() => setStatus("设置保存失败，请重试", "error")).finally(() => {
    navigationBusy = false;
    setNavigationBusy(false);
  });
}

async function continueOnboarding(skipAnki: boolean): Promise<void> {
  setStatus("", "");
  const step = currentStepId();
  const current = readCurrentSettings();
  if (!current) return;
  if (step === "ai" && (!aiController || aiController.state.phase !== "success" || aiController.state.key !== aiConnectionKey(current))) {
    setAiStatus("请先测试 AI 连接", "error");
    return;
  }
  if (step === "anki" && !skipAnki && (!ankiController || ankiController.state.phase !== "success" || ankiController.state.key !== ankiConnectionKey(current))) {
    setAnkiStatus("请连接 Anki，或选择跳过", "error");
    return;
  }
  const scope = stepScope(step);
  if (scope.length > 0 && draft?.dirty) await draft.save(scope);
  if (currentStepIndex >= steps.length - 1) {
    window.close();
    return;
  }
  showStep(currentStepIndex + 1);
}

function stepScope(step: StepId): readonly string[] {
  if (step === "word-list") return ["knownWordList"];
  if (step === "appearance") return ["appearance"];
  if (step === "ai") return ["ai", "modelVersion"];
  if (step === "anki") return ["anki"];
  return [];
}

function showStep(index: number): void {
  if (index < 0 || index >= steps.length) return;
  currentStepIndex = index;
  steps.forEach((step, stepIndex) => {
    step.hidden = stepIndex !== index;
    step.inert = stepIndex !== index || navigationBusy;
  });
  progress.textContent = `${index + 1} / ${steps.length}`;
  continueButton.textContent = index === steps.length - 1 ? "完成" : "继续";
  backButton.hidden = index === 0;
  skipAnkiButton.hidden = currentStepId() !== "anki";
  const heading = steps[index]?.querySelector<HTMLHeadingElement>("h1");
  if (heading) {
    heading.tabIndex = -1;
    heading.focus();
  }
}

function setNavigationBusy(busy: boolean): void {
  continueButton.disabled = busy;
  backButton.disabled = busy;
  skipAnkiButton.disabled = busy;
  const step = steps[currentStepIndex];
  if (step) step.inert = busy;
}

function readCurrentSettings(): GlossaSettings | undefined {
  return syncDraftFromForm() ?? (draft ? undefined : DEFAULT_SETTINGS);
}

function editDraftFromForm(): void {
  syncDraftFromForm();
}

function syncDraftFromForm(): GlossaSettings | undefined {
  if (!draft) return undefined;
  let next: GlossaSettings;
  try {
    next = readSettingsForm(form, draft.value);
  } catch {
    markFormInvalid();
    return undefined;
  }
  const wasInvalid = formValidationError;
  formValidationError = false;
  const patch = diffSettings(draft.value, next);
  if (Object.keys(patch).length > 0) draft.edit(patch);
  updatePreview(draft.value);
  updateControllers(draft.value);
  if (wasInvalid) setStatus("", "");
  return draft.value;
}

function markFormInvalid(): void {
  formValidationError = true;
  aiController?.invalidate();
  ankiController?.invalidate();
  catalogController?.invalidate();
  setStatus("设置格式无效，请修正后再继续", "error");
}

function canRunSettingsOperation(): boolean {
  if (!formValidationError) return true;
  setStatus("设置格式无效，请修正后再继续", "error");
  return false;
}

function installStorageListener(): void {
  chrome.storage?.onChanged?.addListener((changes, areaName) => {
    if (areaName === "local" && "settings" in changes) void refreshSettingsFromWorker();
  });
}

async function loadSettings(): Promise<void> {
  const settings = await getSettings();
  draft = createSettingsDraft({ initial: settings, persist: persistSettings });
  formValidationError = false;
  writeSettingsForm(form, settings);
  applyProviderFields(form, settings.ai.provider);
  setSelectOptions(ankiDeckSelect, [settings.anki.deck], settings.anki.deck);
  setSelectOptions(ankiModelNameSelect, [settings.anki.modelName], settings.anki.modelName);
  setAnkiSelectsEnabled(false);
  updatePreview(settings);
  createControllers(settings);
  form.inert = false;
  showStep(0);
}

async function refreshSettingsFromWorker(): Promise<void> {
  try {
    const settings = await getSettings();
    draft?.acceptExternal(settings);
    if (!draft) return;
    if (!formValidationError) writeSettingsForm(form, draft.value);
    applyProviderFields(form, draft.value.ai.provider);
    updatePreview(draft.value);
    updateControllers(draft.value);
  } catch {
    setStatus("设置刷新失败，请重试", "error");
  }
}

function createControllers(settings: GlossaSettings): void {
  const aiClient = createAiClient();
  const ankiClient = createAnkiClient();
  aiController = createConnectionController<GlossaSettings>({
    identity: aiConnectionKey,
    run: (value, signal) => aiClient.probe(value, signal),
    errorFallback: { reason: "service-error", message: "AI 连接检测失败", service: "ai" }
  }, settings);
  ankiController = createConnectionController<AnkiSettings>({
    identity: (value) => ankiConnectionKey({ ...settings, anki: value }),
    run: (value, signal) => ankiClient.probe(value, signal),
    errorFallback: { reason: "service-error", message: "Anki 连接检测失败", service: "anki" }
  }, settings.anki);
  catalogController = createAnkiCatalogController<AnkiSettings, { decks: string[]; modelNames: string[] }>({
    identity: (value) => JSON.stringify([value.endpoint, value.requestTimeoutMs]),
    run: (value, signal) => ankiClient.loadCatalog(value, signal),
    errorFallback: { reason: "service-error", message: "Anki 选项读取失败", service: "anki" }
  }, settings.anki);
  aiController.subscribe(renderAiState);
  ankiController.subscribe(renderAnkiState);
  catalogController.subscribe(renderCatalogState);
}

function updateControllers(settings: GlossaSettings): void {
  aiController?.updateSettings(settings);
  ankiController?.updateSettings(settings.anki);
  catalogController?.updateSettings(settings.anki);
}

function renderAiState(state: OperationState<void>): void {
  if (state.phase === "pending") {
    setTestState(testAiButton, "loading");
    setAiStatus("正在测试 AI 连接…", "pending");
  } else if (state.phase === "success") {
    setTestState(testAiButton, "success");
    setAiStatus("AI 连接成功", "success");
  } else if (state.phase === "error") {
    setTestState(testAiButton, "error");
    setAiStatus(userMessageForError(state.error, "ai"), "error");
  } else {
    setTestState(testAiButton, "idle");
    setAiStatus("", "");
  }
}

function renderAnkiState(state: OperationState<void>, token: OperationToken | undefined): void {
  const ownsOutput = claimFeedback(ankiFeedback, state, token);
  if (state.phase === "pending") {
    setTestState(testAnkiButton, "loading");
    if (ownsOutput) setAnkiStatus("正在测试 Anki 连接…", "pending");
  } else if (state.phase === "success") {
    setTestState(testAnkiButton, "success");
    if (ownsOutput) setAnkiStatus("Anki 已连接", "success");
  } else if (state.phase === "error") {
    setTestState(testAnkiButton, "error");
    if (ownsOutput) setAnkiStatus(userMessageForError(state.error, "anki"), "error");
  } else {
    setTestState(testAnkiButton, "idle");
    if (ownsOutput) setAnkiStatus("", "");
  }
}

function renderCatalogState(state: OperationState<{ decks: string[]; modelNames: string[] }>, token: OperationToken | undefined): void {
  const ownsOutput = claimFeedback(ankiFeedback, state, token);
  if (!draft) return;
  if (state.phase === "pending") {
    setTestState(refreshAnkiButton, "loading");
    setAnkiSelectsEnabled(false);
    setCatalogPlaceholders(draft.value.anki);
    if (ownsOutput) setAnkiStatus("正在读取 Anki 选项…", "pending");
  } else if (state.phase === "success") {
    setTestState(refreshAnkiButton, "success");
    const deck = pickExistingValue(draft.value.anki.deck, state.value.decks);
    const modelName = pickExistingValue(draft.value.anki.modelName, state.value.modelNames);
    setSelectOptions(ankiDeckSelect, state.value.decks, deck);
    setSelectOptions(ankiModelNameSelect, state.value.modelNames, modelName);
    setAnkiSelectsEnabled(state.value.decks.length > 0 && state.value.modelNames.length > 0);
    const patch: SettingsPatch = { anki: {} };
    if (deck !== draft.value.anki.deck) patch.anki!.deck = deck;
    if (modelName !== draft.value.anki.modelName) patch.anki!.modelName = modelName;
    if (Object.keys(patch.anki!).length > 0) {
      draft.edit(patch);
      updateControllers(draft.value);
    }
    if (ownsOutput) setAnkiStatus(state.value.decks.length > 0 && state.value.modelNames.length > 0 ? "Anki 选项已更新" : "Anki 没有可用的牌组或兼容模板", state.value.decks.length > 0 && state.value.modelNames.length > 0 ? "success" : "error");
  } else {
    setTestState(refreshAnkiButton, state.phase === "error" ? "error" : "idle");
    setAnkiSelectsEnabled(false);
    setCatalogPlaceholders(draft.value.anki);
    if (state.phase === "error" && ownsOutput) setAnkiStatus(userMessageForError(state.error, "anki"), "error");
    if (state.phase === "idle" && ownsOutput) setAnkiStatus("", "");
  }
}

function setCatalogPlaceholders(settings: AnkiSettings): void {
  setSelectOptions(ankiDeckSelect, [settings.deck], settings.deck);
  setSelectOptions(ankiModelNameSelect, [settings.modelName], settings.modelName);
}

function setAnkiSelectsEnabled(enabled: boolean): void {
  ankiDeckSelect.disabled = !enabled;
  ankiModelNameSelect.disabled = !enabled;
}

async function persistSettings(patch: SettingsPatch): Promise<GlossaSettings> {
  const response = await request(createRequestMessage("onboarding", "settings.patch", { patch }));
  return expectResponse(response, "settings.response").payload.settings;
}

async function getSettings(): Promise<GlossaSettings> {
  const response = await request(createRequestMessage("onboarding", "settings.get", {}));
  return expectResponse(response, "settings.response").payload.settings;
}

function request<T extends RuntimeRequestType>(message: RequestMessage<T>): Promise<ResponseMessage<T>> {
  return sendRuntimeRequest(message) as Promise<ResponseMessage<T>>;
}

function expectResponse<T extends RuntimeRequestType, R extends ResponseMessage<T>["type"]>(response: ResponseMessage<T>, type: R): Extract<ResponseMessage<T>, { type: R }> {
  if (response.type === "error") throw diagnosticErrorFrom(response.payload, { reason: "runtime", message: "后台请求失败", service: "runtime" });
  if (response.type !== type) throw new Error(`Unexpected response type: ${response.type}`);
  return response as Extract<ResponseMessage<T>, { type: R }>;
}

function setStatus(value: string, state: "pending" | "success" | "error" | "" = value ? "error" : ""): void {
  statusOutput.value = value;
  statusOutput.dataset.state = state;
}

function setAiStatus(value: string, state: "pending" | "success" | "error" | "" = value ? "error" : ""): void {
  aiStatus.value = value;
  aiStatus.dataset.state = state;
}

function setAnkiStatus(value: string, state: "pending" | "success" | "error" | "" = value ? "error" : ""): void {
  ankiStatus.value = value;
  ankiStatus.dataset.state = state;
}

function updatePreview(settings: GlossaSettings): void {
  applyAppearancePreview({ preview: glossPreview, labels: glossPreviewLabels, successLabels: glossPreviewSuccessLabels, errorLabels: glossPreviewErrorLabels }, settings.appearance);
  const opacityPercent = `${Math.round(settings.appearance.backgroundOpacity * 100)}%`;
  glossBackgroundOpacityValue.value = opacityPercent;
  glossBackgroundOpacityInput.setAttribute("aria-valuetext", opacityPercent);
}
