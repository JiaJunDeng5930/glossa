import { diagnosticErrorFrom } from "../shared/errors";
import { createRequestMessage, type RequestMessage, type ResponseMessage, type RuntimeRequestType } from "../shared/messages";
import { sendRuntimeRequest } from "../shared/runtimeClient";
import { aiConnectionKey, ankiConnectionKey, jevConnectionKey, diffSettings, type SettingsPatch } from "../shared/settings";
import { claimFeedback, createAnkiCatalogController, createConnectionController, createFeedbackChannel, type OperationState, type OperationToken } from "../shared/connectionController";
import {
  applyAppearancePreview,
  applyTranslationFields,
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
  writeAnkiSelects,
  writeSettingsForm
} from "../shared/settingsForm";
import { createSettingsDraft, type SettingsDraft } from "../shared/settingsDraft";
import { DEFAULT_SETTINGS, type AiSettings, type AnkiSettings, type GlossaSettings } from "../shared/types";
import { userMessageForError } from "../shared/userMessages";
import { createJevClient } from "../shared/services/jevClient";
import { createAiClient } from "../shared/services/aiClient";
import { createAnkiClient } from "../shared/services/ankiClient";

type StepId = "smart" | "translation" | "anki-click" | "word-list" | "appearance" | "ai" | "anki" | "finish";
const STEP_IDS: readonly StepId[] = ["smart", "translation", "anki-click", "word-list", "appearance", "ai", "anki", "finish"];
type InitializationState = "loading" | "ready" | "error";
const form = document.querySelector<HTMLFormElement>("#settings-form")!;
form.inert = true;
const steps = Array.from(document.querySelectorAll<HTMLElement>("[data-step]"));
const progress = document.querySelector<HTMLElement>("#progress")!;
const retryLoadButton = document.querySelector<HTMLButtonElement>("#retry-load")!;
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
const testJevButton = document.querySelector<HTMLButtonElement>("#test-jev")!;
const jevStatus = document.querySelector<HTMLOutputElement>("#jev-status")!;
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
let initializationState: InitializationState = "loading";
let pendingStepFocus = false;
let draft: SettingsDraft | undefined;
let jevController: ReturnType<typeof createConnectionController<GlossaSettings>> | undefined;
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
  startSettingsLoad();
} else {
  setInitializationState("error", "首次设置页面无法加载，请重新打开", false);
}

retryLoadButton.addEventListener("click", () => {
  if (initializationState === "error") startSettingsLoad();
});
continueButton.addEventListener("click", () => startContinue(false));
skipAnkiButton.addEventListener("click", () => startContinue(true));
backButton.addEventListener("click", () => {
  if (initializationState !== "ready" || navigationBusy) return;
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
testJevButton.addEventListener("click", () => {
  if (canRunSettingsOperation()) jevController?.test();
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
  if (initializationState !== "ready" || navigationBusy) return;
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
  if (step === "ai") {
    const dictionaryMode = current.translation.mode === "dictionary-jev";
    const controller = dictionaryMode ? jevController : aiController;
    const key = dictionaryMode ? jevConnectionKey(current) : aiConnectionKey(current);
    if (!controller || controller.state.phase !== "success" || controller.state.key !== key) {
      if (dictionaryMode) setJevStatus("请先测试 Jev 连接", "error");
      else setAiStatus("请先测试 AI 连接", "error");
      return;
    }
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
  if (step === "ai") return ["translation", "jev", "ai", "modelVersion"];
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
  form.style.setProperty("--step-progress", String((index + 1) / steps.length));
  progress.textContent = `${index + 1} / ${steps.length}`;
  continueButton.textContent = index === steps.length - 1 ? "完成" : "继续";
  backButton.hidden = index === 0;
  skipAnkiButton.hidden = currentStepId() !== "anki";
  if (navigationBusy) pendingStepFocus = true;
  else focusCurrentStepHeading();
}

function setNavigationBusy(busy: boolean): void {
  continueButton.disabled = busy || initializationState !== "ready";
  backButton.disabled = busy || initializationState !== "ready";
  skipAnkiButton.disabled = busy || initializationState !== "ready";
  const step = steps[currentStepIndex];
  if (step) step.inert = busy;
  if (!busy && pendingStepFocus) {
    pendingStepFocus = false;
    focusCurrentStepHeading();
  }
}

function focusCurrentStepHeading(): void {
  const heading = steps[currentStepIndex]?.querySelector<HTMLHeadingElement>("h1");
  if (!heading) return;
  heading.tabIndex = -1;
  heading.focus();
}

function startSettingsLoad(): void {
  setInitializationState("loading");
  void loadSettings()
    .then(() => setInitializationState("ready"))
    .catch(() => setInitializationState("error", "设置加载失败，请重试", true));
}

function setInitializationState(state: InitializationState, message = "", retryable = false): void {
  initializationState = state;
  form.dataset.initialization = state;
  form.setAttribute("aria-busy", state === "loading" ? "true" : "false");
  retryLoadButton.hidden = !retryable;
  retryLoadButton.disabled = !retryable;
  const controlsDisabled = state !== "ready";
  continueButton.disabled = controlsDisabled || navigationBusy;
  backButton.disabled = controlsDisabled || navigationBusy;
  skipAnkiButton.disabled = controlsDisabled || navigationBusy;
  testJevButton.disabled = controlsDisabled;
  testAiButton.disabled = controlsDisabled;
  testAnkiButton.disabled = controlsDisabled;
  refreshAnkiButton.disabled = controlsDisabled;

  if (state === "loading") {
    form.inert = true;
    steps.forEach((step) => { step.inert = true; });
    setStatus(message || "正在加载设置…", "pending");
  } else if (state === "error") {
    form.inert = false;
    steps.forEach((step) => { step.inert = true; });
    setStatus(message || "设置加载失败，请重试", "error");
  } else {
    form.inert = false;
    setStatus("", "");
  }
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
  jevController?.invalidate();
  ankiController?.invalidate();
  catalogController?.invalidate();
  setStatus("部分设置填写有误，请修改后再继续", "error");
}

function canRunSettingsOperation(): boolean {
  if (!formValidationError) return true;
  setStatus("部分设置填写有误，请修改后再继续", "error");
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
    else writeAnkiSelects(form, draft.value);
    applyProviderFields(form, draft.value.ai.provider);
    updatePreview(draft.value);
    updateControllers(draft.value);
  } catch {
    setStatus("设置刷新失败，请重试", "error");
  }
}

function createControllers(settings: GlossaSettings): void {
  const aiClient = createAiClient();
  const jevClient = createJevClient();
  const ankiClient = createAnkiClient();
  jevController = createConnectionController<GlossaSettings>({
    identity: jevConnectionKey,
    run: (value, signal) => jevClient.probe(value.jev, signal),
    errorFallback: { reason: "service-error", message: "Jev 连接检测失败", service: "jev" }
  }, settings);
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
  jevController.subscribe(renderJevState);
  ankiController.subscribe(renderAnkiState);
  catalogController.subscribe(renderCatalogState);
}

function updateControllers(settings: GlossaSettings): void {
  applyTranslationFields(form, settings);
  aiController?.updateSettings(settings);
  jevController?.updateSettings(settings);
  ankiController?.updateSettings(settings.anki);
  catalogController?.updateSettings(settings.anki);
}

function renderJevState(state: OperationState<void>): void {
  if (state.phase === "pending") {
    setTestState(testJevButton, "loading");
    setJevStatus("正在测试 Jev 连接…", "pending");
  } else if (state.phase === "success") {
    setTestState(testJevButton, "success");
    setJevStatus("Jev 连接可用", "success");
  } else if (state.phase === "error") {
    setTestState(testJevButton, "error");
    setJevStatus(userMessageForError(state.error, "jev"), "error");
  } else {
    setTestState(testJevButton, "idle");
    setJevStatus("", "");
  }
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
    if (ownsOutput) setAnkiStatus("正在读取 Anki 牌组与模板…", "pending");
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
    if (ownsOutput) setAnkiStatus(state.value.decks.length > 0 && state.value.modelNames.length > 0 ? "Anki 牌组与模板已更新" : "Anki 没有可用的牌组或模板，请检查后刷新", state.value.decks.length > 0 && state.value.modelNames.length > 0 ? "success" : "error");
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

function setJevStatus(value: string, state: "pending" | "success" | "error" | "" = value ? "error" : ""): void {
  jevStatus.value = value;
  jevStatus.dataset.state = state;
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
