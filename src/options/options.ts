import { normalizeLemma } from "../core/state";
import { diagnosticErrorFrom } from "../shared/errors";
import {
  createRequestMessage,
  type RequestMessage,
  type ResponseMessage,
  type RuntimeRequestType
} from "../shared/messages";
import { sendRuntimeRequest } from "../shared/runtimeClient";
import { aiConnectionKey, ankiConnectionKey, jevConnectionKey, diffSettings, type SettingsPatch } from "../shared/settings";
import {
  claimFeedback,
  createAnkiCatalogController,
  createConnectionController,
  createFeedbackChannel,
  type OperationToken,
  type OperationState
} from "../shared/connectionController";
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
  setFormInput,
  setSelectOptions,
  setTestState,
  writeAnkiSelects,
  writeSettingsForm
} from "../shared/settingsForm";
import { createSettingsDraft, type SettingsDraft } from "../shared/settingsDraft";
import { formatShortcutFromEvent, normalizeShortcut } from "../shared/shortcut";
import { DEFAULT_SETTINGS, type AiSettings, type AnkiSettings, type GlossaSettings, type VocabularyRecord } from "../shared/types";
import { userMessageForError } from "../shared/userMessages";
import { createAnkiClient } from "../shared/services/ankiClient";
import { createJevClient } from "../shared/services/jevClient";
import { createAiClient } from "../shared/services/aiClient";
import { createKnownWordsOperationLane } from "./knownWordsOperationLane";

const form = document.querySelector<HTMLFormElement>("#settings-form")!;
form.inert = true;
const statusOutput = document.querySelector<HTMLOutputElement>("#status")!;
const saveButton = document.querySelector<HTMLButtonElement>("#save-settings")!;
const saveLabel = saveButton.querySelector<HTMLElement>(".save-label")!;
const shortcutCapture = document.querySelector<HTMLButtonElement>("#shortcut-capture")!;
const translateShortcutCapture = document.querySelector<HTMLButtonElement>("#translate-shortcut-capture")!;
const shortcutCaptureError = document.querySelector<HTMLElement>("#shortcut-capture-error")!;
const translateShortcutCaptureError = document.querySelector<HTMLElement>("#translate-shortcut-capture-error")!;
const glossPreview = document.querySelector<HTMLElement>("#gloss-preview")!;
const glossPreviewLabels = Array.from(document.querySelectorAll<HTMLElement>(".preview-gloss"));
const glossPreviewSuccessLabels = Array.from(document.querySelectorAll<HTMLElement>(".preview-gloss-success"));
const glossPreviewErrorLabels = Array.from(document.querySelectorAll<HTMLElement>(".preview-gloss-error"));
const glossBackgroundOpacityInput = form.elements.namedItem("glossBackgroundOpacity") as HTMLInputElement;
const glossBackgroundOpacityValue = document.querySelector<HTMLOutputElement>("#gloss-background-opacity-value")!;
const knownWordListSelect = form.elements.namedItem("knownWordList") as HTMLSelectElement;
const ankiDeckSelect = form.elements.namedItem("ankiDeck") as HTMLSelectElement;
const ankiModelNameSelect = form.elements.namedItem("ankiModelName") as HTMLSelectElement;
const testJevButton = document.querySelector<HTMLButtonElement>("#test-jev")!;
const jevStatus = document.querySelector<HTMLOutputElement>("#jev-status")!;
const testAiButton = document.querySelector<HTMLButtonElement>("#test-ai")!;
const testAnkiButton = document.querySelector<HTMLButtonElement>("#test-anki")!;
const refreshAnkiButton = document.querySelector<HTMLButtonElement>("#refresh-anki")!;
const resetCardHistoryButton = document.querySelector<HTMLButtonElement>("#reset-card-history")!;
const aiStatus = document.querySelector<HTMLOutputElement>("#ai-status")!;
const ankiStatus = document.querySelector<HTMLOutputElement>("#anki-status")!;
const resetGlossPromptButton = document.querySelector<HTMLButtonElement>("#reset-gloss-prompt")!;
const resetAnkiPromptButton = document.querySelector<HTMLButtonElement>("#reset-anki-prompt")!;
const clearGlossCacheButton = document.querySelector<HTMLButtonElement>("#clear-gloss-cache")!;
const openKnownWordsButton = document.querySelector<HTMLButtonElement>("#open-known-words")!;
const closeKnownWordsButton = document.querySelector<HTMLButtonElement>("#close-known-words")!;
const clearKnownWordsButton = document.querySelector<HTMLButtonElement>("#clear-known-words")!;
const knownWordsDialog = document.querySelector<HTMLDialogElement>("#known-words-dialog")!;
const knownWordsSummary = document.querySelector<HTMLElement>("#known-words-summary")!;
const knownWordsNav = document.querySelector<HTMLElement>("#known-words-nav")!;
const knownWordForm = document.querySelector<HTMLFormElement>("#known-word-form")!;
const knownWordInput = document.querySelector<HTMLInputElement>("#known-word-input")!;
const addKnownWordButton = document.querySelector<HTMLButtonElement>("#add-known-word")!;
const knownWordsStatus = document.querySelector<HTMLOutputElement>("#known-words-status")!;
const knownWordsList = document.querySelector<HTMLElement>("#known-words-list")!;
const providerSelect = form.elements.namedItem("provider") as HTMLSelectElement;
const reasoningSelect = form.elements.namedItem("reasoningEffort") as HTMLSelectElement;
const ALPHABET = "abcdefghijklmnopqrstuvwxyz".split("");

let draft: SettingsDraft | undefined;
let jevController: ReturnType<typeof createConnectionController<GlossaSettings>> | undefined;
let aiController: ReturnType<typeof createConnectionController<GlossaSettings>> | undefined;
let ankiController: ReturnType<typeof createConnectionController<AnkiSettings>> | undefined;
let catalogController: ReturnType<typeof createAnkiCatalogController<AnkiSettings, { decks: string[]; modelNames: string[] }>> | undefined;
let capturingShortcutName: "shortcutKey" | "translateShortcutKey" | undefined;
let pendingShortcut = "";
let providerBeforeInput: AiSettings["provider"] | undefined;
let formValidationError = false;
const ankiFeedback = createFeedbackChannel();
let knownWordsViewRevision = 0;
const knownWordsOperationLane = createKnownWordsOperationLane();

populateProviderSelect(providerSelect);
populateReasoningEffortSelect(reasoningSelect);
populateKnownWordSelect(knownWordListSelect);
setupSectionNavigation();
setSaveState("clean");
installStorageListener();
void loadSettings().catch(() => setStatus("设置加载失败，请重新打开页面", "error"));

form.addEventListener("submit", (event) => {
  event.preventDefault();
  void persistForm();
});

form.addEventListener("input", () => editDraftFromForm());

providerSelect.addEventListener("input", () => {
  providerBeforeInput = draft?.value.ai.provider;
});
providerSelect.addEventListener("change", () => {
  const provider = readFormInput(form, "provider") as AiSettings["provider"];
  const previousProvider = providerBeforeInput ?? draft?.value.ai.provider ?? provider;
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

resetCardHistoryButton.addEventListener("click", () => void resetCardHistory());
resetGlossPromptButton.addEventListener("click", () => {
  setFormInput(form, "glossPrompt", DEFAULT_SETTINGS.prompts.gloss);
  editDraftFromForm();
});
resetAnkiPromptButton.addEventListener("click", () => {
  setFormInput(form, "ankiPrompt", DEFAULT_SETTINGS.prompts.ankiCard);
  editDraftFromForm();
});
clearGlossCacheButton.addEventListener("click", () => void clearGlossCache());

openKnownWordsButton.addEventListener("click", () => {
  knownWordsDialog.showModal();
  const viewRevision = ++knownWordsViewRevision;
  void knownWordsOperationLane.run(() => refreshKnownWords("", viewRevision));
});
closeKnownWordsButton.addEventListener("click", () => {
  knownWordsViewRevision += 1;
  knownWordsDialog.close();
});
knownWordForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void knownWordsOperationLane.run(() => addKnownWord(knownWordsViewRevision));
});
clearKnownWordsButton.addEventListener("click", () => {
  void knownWordsOperationLane.run(() => clearKnownWords(knownWordsViewRevision));
});
knownWordsNav.addEventListener("click", (event) => {
  const button = (event.target as Element).closest<HTMLButtonElement>("button[data-letter]");
  if (button?.dataset.letter) {
    document.querySelector<HTMLElement>(`#known-words-${button.dataset.letter}`)?.scrollIntoView({ block: "start" });
  }
});

shortcutCapture.addEventListener("click", () => startShortcutCapture("shortcutKey", shortcutCapture));
translateShortcutCapture.addEventListener("click", () => startShortcutCapture("translateShortcutKey", translateShortcutCapture));
document.addEventListener("keydown", (event) => {
  if (!capturingShortcutName) return;
  event.preventDefault();
  event.stopPropagation();
  pendingShortcut = formatShortcutFromEvent(event);
  shortcutButtonFor(capturingShortcutName).textContent = pendingShortcut;
  if (!isModifierKey(event.key)) finishShortcutCapture();
});
document.addEventListener("keyup", (event) => {
  if (!capturingShortcutName || !pendingShortcut) return;
  event.preventDefault();
  event.stopPropagation();
  if (isModifierKey(event.key)) finishShortcutCapture();
});

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
  if (wasInvalid) {
    setStatus("", "");
    setSaveState(draft.saving ? "saving" : draft.dirty ? "dirty" : "clean");
  }
  return draft.value;
}

function markFormInvalid(): void {
  formValidationError = true;
  aiController?.invalidate();
  jevController?.invalidate();
  ankiController?.invalidate();
  catalogController?.invalidate();
  setSaveState("error");
  setStatus("设置格式无效，请修正后再保存", "error");
}

function canRunSettingsOperation(): boolean {
  if (!formValidationError) return true;
  setStatus("设置格式无效，请修正后再保存", "error");
  return false;
}

function installStorageListener(): void {
  chrome.storage?.onChanged?.addListener((changes, areaName) => {
    if (areaName === "local" && "settings" in changes) void refreshSettingsFromWorker();
  });
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

async function loadSettings(): Promise<void> {
  const settings = await getSettings();
  draft = createSettingsDraft({ initial: settings, persist: persistSettings });
  formValidationError = false;
  draft.subscribe((next) => setSaveState(next.saving ? "saving" : next.dirty ? "dirty" : "clean"));
  writeSettingsForm(form, settings);
  shortcutCapture.textContent = settings.shortcutKey;
  translateShortcutCapture.textContent = settings.translateShortcutKey;
  applyProviderFields(form, settings.ai.provider);
  setSelectOptions(ankiDeckSelect, [settings.anki.deck], settings.anki.deck);
  setSelectOptions(ankiModelNameSelect, [settings.anki.modelName], settings.anki.modelName);
  setAnkiSelectsEnabled(false);
  updatePreview(settings);
  createControllers(settings);
  form.inert = false;
  void knownWordsOperationLane.run(() => refreshKnownWords());
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
    setAiStatus("AI 连接可用", "success");
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
    if (ownsOutput) setAnkiStatus("Anki 连接可用", "success");
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
    return;
  }
  if (state.phase === "success") {
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
    return;
  }
  setTestState(refreshAnkiButton, state.phase === "error" ? "error" : "idle");
  setAnkiSelectsEnabled(false);
  setCatalogPlaceholders(draft.value.anki);
  if (state.phase === "error" && ownsOutput) setAnkiStatus(userMessageForError(state.error, "anki"), "error");
  if (state.phase === "idle" && ownsOutput) setAnkiStatus("", "");
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
  const response = await request(createRequestMessage("options", "settings.patch", { patch }));
  return expectResponse(response, "settings.response").payload.settings;
}

async function getSettings(): Promise<GlossaSettings> {
  const response = await request(createRequestMessage("options", "settings.get", {}));
  return expectResponse(response, "settings.response").payload.settings;
}

function request<T extends RuntimeRequestType>(message: RequestMessage<T>): Promise<ResponseMessage<T>> {
  return sendRuntimeRequest(message) as Promise<ResponseMessage<T>>;
}

function expectResponse<T extends RuntimeRequestType, R extends ResponseMessage<T>["type"]>(response: ResponseMessage<T>, type: R): Extract<ResponseMessage<T>, { type: R }> {
  if (response.type === "error") {
    throw diagnosticErrorFrom(response.payload, { reason: "runtime", message: "后台请求失败", service: "runtime" });
  }
  if (response.type !== type) throw new Error(`Unexpected response type: ${response.type}`);
  return response as Extract<ResponseMessage<T>, { type: R }>;
}

async function persistForm(): Promise<void> {
  if (!draft || draft.saving) return;
  if (!syncDraftFromForm() || formValidationError) return;
  setSaveState("saving");
  setStatus("正在保存…", "pending");
  try {
    await draft.save();
    if (!syncDraftFromForm() || formValidationError) return;
    writeSettingsForm(form, draft.value);
    shortcutCapture.textContent = draft.value.shortcutKey;
    translateShortcutCapture.textContent = draft.value.translateShortcutKey;
    applyProviderFields(form, draft.value.ai.provider);
    updatePreview(draft.value);
    updateControllers(draft.value);
    setSaveState(draft.dirty ? "dirty" : "clean");
    setStatus(draft.dirty ? "保存完成，仍有未保存的更改" : "已保存", draft.dirty ? "dirty" : "success");
  } catch {
    if (formValidationError) {
      setSaveState("error");
      setStatus("设置格式无效，请修正后再保存", "error");
    } else {
      setSaveState("error");
      setStatus("设置保存失败，请重试", "error");
    }
  }
}

function setStatus(value: string, state: "dirty" | "pending" | "success" | "error" | "" = value ? "error" : ""): void {
  statusOutput.value = value;
  statusOutput.dataset.state = state;
}

type SettingsSaveState = "clean" | "dirty" | "saving" | "error";
function setSaveState(state: SettingsSaveState): void {
  const labels: Record<SettingsSaveState, string> = { clean: "保存", dirty: "保存更改", saving: "保存中…", error: "重试保存" };
  saveButton.dataset.state = state;
  saveButton.disabled = state === "saving";
  saveLabel.textContent = labels[state];
}

function updatePreview(settings: GlossaSettings): void {
  applyAppearancePreview({ preview: glossPreview, labels: glossPreviewLabels, successLabels: glossPreviewSuccessLabels, errorLabels: glossPreviewErrorLabels }, settings.appearance);
  const opacityPercent = `${Math.round(settings.appearance.backgroundOpacity * 100)}%`;
  glossBackgroundOpacityValue.value = opacityPercent;
  glossBackgroundOpacityInput.setAttribute("aria-valuetext", opacityPercent);
}

async function resetCardHistory(): Promise<void> {
  if (!window.confirm("重置制卡记录？Glossa 的卡片缓存与重复提醒记录会被清空，Anki 中已有卡片会保留。")) return;
  const owner = ankiFeedback.claimExternal();
  resetCardHistoryButton.disabled = true;
  setAnkiStatus("正在重置制卡记录…", "pending");
  try {
    const response = await request(createRequestMessage("options", "card.history.reset", {}));
    expectResponse(response, "card.history.reset.ok");
    if (ankiFeedback.owns(owner)) setAnkiStatus("制卡记录已重置，Anki 中已有卡片保持不变", "success");
  } catch (error) {
    if (ankiFeedback.owns(owner)) setAnkiStatus(userMessageForError(diagnosticErrorFrom(error, { reason: "runtime", message: "制卡记录重置失败", service: "runtime" }).payload, "runtime"), "error");
  } finally {
    resetCardHistoryButton.disabled = false;
  }
}

async function clearGlossCache(): Promise<void> {
  setStatus("", "");
  try {
    const response = await request(createRequestMessage("options", "gloss.cache.clear", {}));
    expectResponse(response, "gloss.cache.cleared");
    setStatus("翻译缓存已清空", "success");
  } catch (error) {
    setStatus(userMessageForError(diagnosticErrorFrom(error, { reason: "runtime", message: "翻译缓存清空失败", service: "runtime" }).payload, "runtime"), "error");
  }
}

async function refreshKnownWords(successStatus = "", viewRevision = knownWordsViewRevision): Promise<void> {
  try {
    const response = await request(createRequestMessage("options", "known.words.list", {}));
    const records = expectResponse(response, "known.words.list.result").payload.records;
    if (viewRevision !== knownWordsViewRevision) return;
    renderKnownWords(records);
    setKnownWordsStatus(successStatus, successStatus ? "success" : "");
  } catch {
    if (viewRevision !== knownWordsViewRevision) return;
    knownWordsSummary.textContent = "词汇读取失败。";
    setKnownWordsStatus("词汇读取失败，请重试", "error");
  }
}

async function addKnownWord(viewRevision: number): Promise<void> {
  const lemma = normalizeLemma(knownWordInput.value);
  if (!/^[a-z]+(?:['-][a-z]+)*$/i.test(lemma)) {
    setKnownWordsStatus("请输入一个英文单词，可包含连字符或撇号", "error");
    return;
  }
  addKnownWordButton.disabled = true;
  setKnownWordsStatus("正在添加…", "pending");
  try {
    const response = await request(createRequestMessage("options", "known.words.add", { lemma }));
    expectResponse(response, "known.words.changed");
    knownWordInput.value = "";
    await refreshKnownWords("已添加", viewRevision);
  } catch {
    setKnownWordsStatus("词汇操作失败，请重试", "error");
  } finally {
    addKnownWordButton.disabled = false;
  }
}

function renderKnownWords(records: VocabularyRecord[]): void {
  knownWordsSummary.textContent = records.length > 0 ? `共 ${records.length} 个已掌握词汇。` : "当前没有已掌握词汇。";
  clearKnownWordsButton.disabled = records.length === 0;
  const groups = new Map<string, VocabularyRecord[]>();
  for (const record of records) {
    const initial = record.lemma.charAt(0).toLowerCase();
    const letter = ALPHABET.includes(initial) ? initial : "z";
    const group = groups.get(letter) ?? [];
    group.push(record);
    groups.set(letter, group);
  }
  const letters = ALPHABET.filter((letter) => groups.has(letter));
  populateKnownWordsNav(letters);
  if (records.length === 0) {
    const empty = document.createElement("p");
    empty.className = "field-help known-words-empty";
    empty.textContent = "当前没有已掌握词汇。";
    knownWordsList.replaceChildren(empty);
    return;
  }
  knownWordsList.replaceChildren(...letters.map((letter) => renderKnownWordsSection(letter, groups.get(letter)!)));
}

function renderKnownWordsSection(letter: string, records: VocabularyRecord[]): HTMLElement {
  const section = document.createElement("section");
  section.id = `known-words-${letter}`;
  section.className = "known-words-section";
  const heading = document.createElement("h3");
  heading.textContent = letter.toUpperCase();
  section.append(heading);
  section.append(...records.map((record) => {
    const row = document.createElement("div");
    row.className = "known-word-row";
    row.setAttribute("role", "listitem");
    const word = document.createElement("span");
    word.textContent = record.lemma;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "移除";
    remove.addEventListener("click", () => void knownWordsOperationLane.run(() => removeKnownWord(record.lemma, knownWordsViewRevision)));
    row.append(word, remove);
    return row;
  }));
  return section;
}

async function removeKnownWord(lemma: string, viewRevision: number): Promise<void> {
  setKnownWordsStatus("正在移除…", "pending");
  try {
    const response = await request(createRequestMessage("options", "known.words.remove", { lemma }));
    expectResponse(response, "known.words.changed");
    await refreshKnownWords("已移除", viewRevision);
  } catch {
    setKnownWordsStatus("词汇操作失败，请重试", "error");
  }
}

async function clearKnownWords(viewRevision: number): Promise<void> {
  if (!window.confirm("清空所有已掌握词汇？这些词之后会重新出现在页面释义中。Anki 卡片和制卡记录会保留。")) return;
  clearKnownWordsButton.disabled = true;
  setKnownWordsStatus("正在清空…", "pending");
  try {
    const response = await request(createRequestMessage("options", "known.words.clear", {}));
    expectResponse(response, "known.words.changed");
    await refreshKnownWords("已清空", viewRevision);
  } catch {
    setKnownWordsStatus("词汇操作失败，请重试", "error");
    clearKnownWordsButton.disabled = false;
  }
}

function populateKnownWordsNav(letters: string[]): void {
  knownWordsNav.hidden = letters.length === 0;
  knownWordsNav.replaceChildren(...letters.map((letter) => {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.letter = letter;
    button.textContent = letter.toUpperCase();
    return button;
  }));
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

function setKnownWordsStatus(value: string, state: "pending" | "success" | "error" | "" = value ? "error" : ""): void {
  knownWordsStatus.value = value;
  knownWordsStatus.dataset.state = state;
}

function startShortcutCapture(name: "shortcutKey" | "translateShortcutKey", button: HTMLButtonElement): void {
  capturingShortcutName = name;
  pendingShortcut = "";
  shortcutErrorFor(name).textContent = "";
  button.textContent = "按下快捷键";
  button.focus();
}

function finishShortcutCapture(): void {
  if (!capturingShortcutName) return;
  const otherName = capturingShortcutName === "shortcutKey" ? "translateShortcutKey" : "shortcutKey";
  if (normalizeShortcut(pendingShortcut) === normalizeShortcut(readFormInput(form, otherName))) {
    shortcutButtonFor(capturingShortcutName).textContent = "按下快捷键";
    shortcutErrorFor(capturingShortcutName).textContent = capturingShortcutName === "shortcutKey" ? "与翻译快捷键冲突，请按其他组合键。" : "与选词快捷键冲突，请按其他组合键。";
    pendingShortcut = "";
    return;
  }
  setFormInput(form, capturingShortcutName, pendingShortcut);
  shortcutButtonFor(capturingShortcutName).textContent = pendingShortcut;
  shortcutErrorFor(capturingShortcutName).textContent = "";
  capturingShortcutName = undefined;
  pendingShortcut = "";
  editDraftFromForm();
}

function isModifierKey(key: string): boolean {
  return key === "Control" || key === "Alt" || key === "Shift" || key === "Meta";
}

function shortcutButtonFor(name: "shortcutKey" | "translateShortcutKey"): HTMLButtonElement {
  return name === "shortcutKey" ? shortcutCapture : translateShortcutCapture;
}

function shortcutErrorFor(name: "shortcutKey" | "translateShortcutKey"): HTMLElement {
  return name === "shortcutKey" ? shortcutCaptureError : translateShortcutCaptureError;
}

function setupSectionNavigation(): void {
  const entries = Array.from(document.querySelectorAll<HTMLAnchorElement>(".section-nav a[href^='#']")).flatMap((link) => {
    const section = document.getElementById(link.hash.slice(1));
    return section ? [{ link, section }] : [];
  });
  if (entries.length === 0) return;
  let animationFrame: number | undefined;
  const render = (): void => {
    animationFrame = undefined;
    const atDocumentEnd = window.scrollY > 0 && window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 2;
    let activeEntry = atDocumentEnd ? entries.at(-1)! : entries[0]!;
    if (!atDocumentEnd) {
      const readingMarker = Math.min(window.innerHeight * 0.32, 240);
      let activeTop = Number.NEGATIVE_INFINITY;
      for (const entry of entries) {
        const sectionTop = entry.section.getBoundingClientRect().top;
        if (sectionTop > readingMarker) break;
        if (sectionTop > activeTop) {
          activeEntry = entry;
          activeTop = sectionTop;
        }
      }
    }
    for (const entry of entries) {
      if (entry === activeEntry) entry.link.setAttribute("aria-current", "location");
      else entry.link.removeAttribute("aria-current");
    }
  };
  const scheduleRender = (): void => {
    if (animationFrame === undefined) animationFrame = window.requestAnimationFrame(render);
  };
  window.addEventListener("scroll", scheduleRender, { passive: true });
  window.addEventListener("resize", scheduleRender);
  window.addEventListener("hashchange", scheduleRender);
  render();
}
