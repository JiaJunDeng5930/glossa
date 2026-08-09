import { createCandidateRecord, markRecordShown, normalizeLemma, vocabularyKey } from "../core/state";
import { diagnosticErrorFrom } from "../shared/errors";
import { createOptionsMessage, messageTimeoutError, validateBackgroundResponse } from "../shared/messages";
import { defaultEndpointForProvider } from "../shared/settings";
import {
  aiConnectionKey,
  ankiConnectionKey,
  applyAppearancePreview,
  loadAnkiCatalog,
  pickExistingValue,
  populateKnownWordSelect,
  readSettingsForm,
  runSettingsConnectionTest,
  setSelectOptions,
  setTestState,
  testAiSettings,
  testAnkiSettings,
  writeSettingsForm
} from "../shared/settingsForm";
import { formatShortcutFromEvent, normalizeShortcut } from "../shared/shortcut";
import { DEFAULT_SETTINGS, type AiSettings, type BackgroundResponseMessage, type GlossaSettings, type OptionsToBackgroundMessage, type VocabularyRecord } from "../shared/types";
import { userMessageForError } from "../shared/userMessages";
import { createExtensionStorage } from "../storage/db";
import { createKnownWordsOperationLane } from "./knownWordsOperationLane";
import { removeKnownRecord } from "./knownWordStorage";

const form = document.querySelector<HTMLFormElement>("#settings-form")!;
form.inert = true;
const extensionStorage = createExtensionStorage();
const knownWordsOperationLane = createKnownWordsOperationLane();
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
const ALPHABET = "abcdefghijklmnopqrstuvwxyz".split("");
let capturingShortcutName: "shortcutKey" | "translateShortcutKey" | undefined;
let pendingShortcut = "";
let settingsRevision = 0;
let testedAiSettings: string | undefined;
let testedAnkiSettings: string | undefined;
let aiConnectionTestRevision = 0;
let ankiConnectionTestRevision = 0;
let ankiCatalogRevision = 0;

populateKnownWordSelect(knownWordListSelect);
setupSectionNavigation();
setSaveState("clean");
void loadSettings().catch(() => setStatus("设置加载失败，请重新打开页面", "error"));

form.addEventListener("submit", (event) => {
  event.preventDefault();
  void persistSettings();
});

testAiButton.addEventListener("click", () => {
  const nextSettings = readSettingsForm(form);
  const connectionKey = aiConnectionKey(nextSettings);
  const revision = ++aiConnectionTestRevision;
  testedAiSettings = connectionKey;
  void runSettingsConnectionTest(
    testAiButton,
    () => testAiSettings(nextSettings),
    "ai",
    setAiStatus,
    "AI 连接可用",
    () => revision === aiConnectionTestRevision
  ).then(() => {
    if (revision === aiConnectionTestRevision) {
      invalidateConnectionTests(readSettingsForm(form));
    }
  });
});

testAnkiButton.addEventListener("click", () => {
  const nextSettings = readSettingsForm(form);
  const connectionKey = ankiConnectionKey(nextSettings);
  const revision = ++ankiConnectionTestRevision;
  testedAnkiSettings = connectionKey;
  void runSettingsConnectionTest(
    testAnkiButton,
    () => testAnkiSettings(nextSettings),
    "anki",
    setAnkiStatus,
    "Anki 连接可用",
    () => revision === ankiConnectionTestRevision
  ).then(() => {
    if (revision === ankiConnectionTestRevision) {
      invalidateConnectionTests(readSettingsForm(form));
    }
  });
});

refreshAnkiButton.addEventListener("click", () => {
  void refreshAnkiOptions(readSettingsForm(form), { reportStatus: true });
});

resetCardHistoryButton.addEventListener("click", () => {
  void resetCardHistory();
});

resetGlossPromptButton.addEventListener("click", () => {
  setInput("glossPrompt", DEFAULT_SETTINGS.prompts.gloss);
  updatePreview(readSettingsForm(form));
  markSettingsDirty();
});

resetAnkiPromptButton.addEventListener("click", () => {
  setInput("ankiPrompt", DEFAULT_SETTINGS.prompts.ankiCard);
  markSettingsDirty();
});

clearGlossCacheButton.addEventListener("click", () => {
  void clearGlossCache();
});

openKnownWordsButton.addEventListener("click", () => {
  knownWordsDialog.showModal();
  void knownWordsOperationLane.run(() => refreshKnownWords());
});

closeKnownWordsButton.addEventListener("click", () => {
  knownWordsDialog.close();
});

knownWordForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void knownWordsOperationLane.run(() => addKnownWord());
});

clearKnownWordsButton.addEventListener("click", () => {
  void knownWordsOperationLane.run(() => clearKnownWords());
});

knownWordsNav.addEventListener("click", (event) => {
  const button = (event.target as Element).closest<HTMLButtonElement>("button[data-letter]");
  if (!button?.dataset.letter) {
    return;
  }
  document.querySelector<HTMLElement>(`#known-words-${button.dataset.letter}`)?.scrollIntoView({ block: "start" });
});

const providerSelect = form.elements.namedItem("provider") as HTMLSelectElement;
const apiKeyField = document.querySelector<HTMLElement>("[data-ai-field='api-key']")!;
const reasoningField = document.querySelector<HTMLElement>("[data-ai-field='reasoning']")!;
let currentProvider = providerSelect.value as AiSettings["provider"];
providerSelect.addEventListener("change", () => {
  const provider = readInput("provider") as AiSettings["provider"];
  const endpoint = readInput("aiEndpoint").trim();
  if (!endpoint || endpoint === defaultEndpointForProvider(currentProvider)) {
    setInput("aiEndpoint", defaultEndpointForProvider(provider));
  }
  currentProvider = provider;
  updateProviderFields(provider);
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

form.addEventListener("input", () => {
  const nextSettings = readSettingsForm(form);
  updatePreview(nextSettings);
  invalidateConnectionTests(nextSettings);
  // Settings use an explicit save commit so users can adjust several related fields as one change.
  markSettingsDirty();
});

function invalidateConnectionTests(nextSettings: GlossaSettings): void {
  if (testedAiSettings && aiConnectionKey(nextSettings) !== testedAiSettings) {
    testedAiSettings = undefined;
    aiConnectionTestRevision += 1;
    setTestState(testAiButton, "idle");
    setAiStatus("");
  }
  if (testedAnkiSettings && ankiConnectionKey(nextSettings) !== testedAnkiSettings) {
    testedAnkiSettings = undefined;
    ankiConnectionTestRevision += 1;
    setTestState(testAnkiButton, "idle");
    setAnkiStatus("");
  }
}

function readInput(name: string): string {
  return (form.elements.namedItem(name) as HTMLInputElement | HTMLSelectElement).value;
}

function setInput(name: string, value: string): void {
  (form.elements.namedItem(name) as HTMLInputElement | HTMLSelectElement).value = value;
}

type StatusState = "dirty" | "pending" | "success" | "error" | "";
type SettingsSaveState = "clean" | "dirty" | "saving" | "error";

function setStatus(value: string, state: StatusState = value ? "error" : ""): void {
  statusOutput.value = value;
  statusOutput.dataset.state = state;
}

function setSaveState(state: SettingsSaveState): void {
  const labels: Record<SettingsSaveState, string> = {
    clean: "保存",
    dirty: "保存更改",
    saving: "保存中…",
    error: "重试保存"
  };
  saveButton.dataset.state = state;
  saveButton.disabled = state === "saving";
  saveLabel.textContent = labels[state];
}

function markSettingsDirty(message = "有未保存的更改"): void {
  settingsRevision += 1;
  if (saveButton.dataset.state === "saving") {
    return;
  }
  setSaveState("dirty");
  setStatus(message, "dirty");
}

async function persistSettings(): Promise<void> {
  const submittedRevision = settingsRevision;
  setSaveState("saving");
  setStatus("正在保存…", "pending");
  try {
    await saveSettings(readSettingsForm(form));
    if (settingsRevision === submittedRevision) {
      setSaveState("clean");
      setStatus("已保存", "success");
      return;
    }
    setSaveState("dirty");
    setStatus("保存完成，仍有未保存的更改", "dirty");
  } catch {
    setSaveState("error");
    setStatus("设置保存失败，请重试", "error");
  }
}

function setupSectionNavigation(): void {
  const entries = Array.from(document.querySelectorAll<HTMLAnchorElement>(".section-nav a[href^='#']")).flatMap((link) => {
    const section = document.getElementById(link.hash.slice(1));
    return section ? [{ link, section }] : [];
  });
  if (entries.length === 0) {
    return;
  }
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
        if (sectionTop > readingMarker) {
          break;
        }
        if (sectionTop > activeTop) {
          activeEntry = entry;
          activeTop = sectionTop;
        }
      }
    }
    for (const entry of entries) {
      if (entry === activeEntry) {
        entry.link.setAttribute("aria-current", "location");
      } else {
        entry.link.removeAttribute("aria-current");
      }
    }
  };
  const scheduleRender = (): void => {
    if (animationFrame === undefined) {
      animationFrame = window.requestAnimationFrame(render);
    }
  };
  window.addEventListener("scroll", scheduleRender, { passive: true });
  window.addEventListener("resize", scheduleRender, { passive: true });
  window.addEventListener("hashchange", scheduleRender);
  render();
}

function setAnkiSelectsEnabled(enabled: boolean): void {
  ankiDeckSelect.disabled = !enabled;
  ankiModelNameSelect.disabled = !enabled;
}

async function refreshKnownWords(successStatus = ""): Promise<void> {
  try {
    const records = await extensionStorage.lexicon.listByState("known");
    renderKnownWords(records);
    setKnownWordsStatus(successStatus, successStatus ? "success" : "");
  } catch {
    knownWordsSummary.textContent = "词汇读取失败。";
    setKnownWordsStatus("词汇读取失败，请重试", "error");
  }
}

async function addKnownWord(): Promise<void> {
  const lemma = normalizeLemma(knownWordInput.value);
  if (!/^[a-z]+(?:['-][a-z]+)*$/i.test(lemma)) {
    setKnownWordsStatus("请输入一个英文单词，可包含连字符或撇号", "error");
    return;
  }
  setKnownWordsStatus("");
  addKnownWordButton.disabled = true;
  setKnownWordsStatus("正在添加…", "pending");
  try {
    const now = Date.now();
    const key = vocabularyKey("en", lemma);
    const updated = await extensionStorage.lexicon.update(key, (existing) => {
      const shown = markRecordShown(existing ?? createCandidateRecord(lemma, lemma, "en", now), now);
      return { ...shown, state: "known", ankiNoteIds: existing?.ankiNoteIds ?? shown.ankiNoteIds };
    });
    if ((updated?.ankiNoteIds.length ?? 0) > 0) {
      await extensionStorage.cardedWords.put(key, {
        key,
        lang: updated?.lang ?? "en",
        lemma,
        createdAt: updated?.lastClickedAt ?? updated?.lastShownAt ?? now
      });
    }
    knownWordInput.value = "";
    await refreshKnownWords("已添加");
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

function setLocalStatus(output: HTMLOutputElement, value: string, state: "pending" | "success" | "error" | "" = value ? "error" : ""): void {
  output.value = value;
  output.dataset.state = state;
}

function setAiStatus(value: string, state?: "pending" | "success" | "error" | ""): void {
  setLocalStatus(aiStatus, value, state);
}

function setAnkiStatus(value: string, state?: "pending" | "success" | "error" | ""): void {
  setLocalStatus(ankiStatus, value, state);
}

function setKnownWordsStatus(value: string, state: "pending" | "success" | "error" | "" = value ? "error" : ""): void {
  knownWordsStatus.value = value;
  knownWordsStatus.dataset.state = state;
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
    remove.addEventListener("click", () => {
      void knownWordsOperationLane.run(() => removeKnownWord(record));
    });
    row.append(word, remove);
    return row;
  }));
  return section;
}

async function removeKnownWord(record: VocabularyRecord): Promise<void> {
  setKnownWordsStatus("正在移除…", "pending");
  try {
    await removeKnownRecord(extensionStorage, record);
    await refreshKnownWords("已移除");
  } catch {
    setKnownWordsStatus("词汇操作失败，请重试", "error");
  }
}

async function clearKnownWords(): Promise<void> {
  if (!window.confirm("清空所有已掌握词汇？这些词之后会重新出现在页面释义中。Anki 卡片和制卡记录会保留。")) {
    return;
  }
  clearKnownWordsButton.disabled = true;
  setKnownWordsStatus("正在清空…", "pending");
  try {
    const records = await extensionStorage.lexicon.listByState("known");
    await Promise.all(records.map((record) => removeKnownRecord(extensionStorage, record)));
    await refreshKnownWords("已清空");
  } catch {
    setKnownWordsStatus("词汇操作失败，请重试", "error");
    clearKnownWordsButton.disabled = false;
  }
}

async function clearGlossCache(): Promise<void> {
  setStatus("");
  try {
    await runtimeMessage(createOptionsMessage("gloss.cache.clear", {}));
    setStatus("翻译缓存已清空", "success");
  } catch (error) {
    setStatus(userMessageForError(diagnosticErrorFrom(error, {
      reason: "runtime",
      message: "Gloss cache clear failed",
      service: "runtime"
    }).payload, "runtime"));
  }
}

function runtimeMessage(message: OptionsToBackgroundMessage, timeoutMs: number | null = 5_000): Promise<BackgroundResponseMessage> {
  return new Promise((resolve, reject) => {
    if (!globalThis.chrome?.runtime?.sendMessage) {
      reject(new Error("chrome.runtime.sendMessage is unavailable"));
      return;
    }
    const timeout = timeoutMs === null ? undefined : globalThis.setTimeout(() => {
      reject(messageTimeoutError(message));
    }, timeoutMs);
    chrome.runtime.sendMessage(message, (rawResponse: unknown) => {
      if (timeout !== undefined) {
        globalThis.clearTimeout(timeout);
      }
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      try {
        const response = validateBackgroundResponse(rawResponse, message);
        if (response.type === "error") {
          reject(diagnosticErrorFrom(response.payload, {
            reason: "runtime",
            message: "Background request failed",
            service: "runtime"
          }));
          return;
        }
        resolve(response);
      } catch (validationError) {
        reject(validationError);
      }
    });
  });
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

async function refreshAnkiOptions(settings: GlossaSettings, options: { reportStatus: boolean }): Promise<void> {
  const revision = ++ankiCatalogRevision;
  const previousDeck = ankiDeckSelect.value;
  const previousModelName = ankiModelNameSelect.value;
  setTestState(refreshAnkiButton, "loading");
  setAnkiSelectsEnabled(false);
  if (options.reportStatus) {
    setAnkiStatus("正在读取 Anki 选项…", "pending");
  }
  try {
    const catalog = await loadAnkiCatalog(settings.anki.endpoint, settings.anki.requestTimeoutMs);
    if (revision !== ankiCatalogRevision || readInput("ankiEndpoint").trim() !== settings.anki.endpoint) {
      return;
    }
    const deck = pickExistingValue(settings.anki.deck, catalog.decks);
    const modelName = pickExistingValue(settings.anki.modelName, catalog.modelNames);
    setSelectOptions(ankiDeckSelect, catalog.decks, deck);
    setSelectOptions(ankiModelNameSelect, catalog.modelNames, modelName);
    setAnkiSelectsEnabled(true);
    setTestState(refreshAnkiButton, "idle");
    invalidateConnectionTests(readSettingsForm(form));
    if (ankiDeckSelect.value !== previousDeck || ankiModelNameSelect.value !== previousModelName) {
      markSettingsDirty("Anki 选项已更新，等待保存");
      setAnkiStatus("Anki 选项已更新", "success");
    } else if (options.reportStatus) {
      setAnkiStatus("Anki 选项已更新", "success");
    }
  } catch (error) {
    if (revision !== ankiCatalogRevision || readInput("ankiEndpoint").trim() !== settings.anki.endpoint) {
      return;
    }
    setSelectOptions(ankiDeckSelect, [settings.anki.deck], settings.anki.deck);
    setSelectOptions(ankiModelNameSelect, [settings.anki.modelName], settings.anki.modelName);
    setAnkiSelectsEnabled(true);
    setTestState(refreshAnkiButton, "error");
    if (options.reportStatus) {
      setAnkiStatus(userMessageForError(diagnosticErrorFrom(error, {
        reason: "service-error",
        message: "Connection test failed",
        service: "anki"
      }).payload, "anki"), "error");
    }
  }
}

function finishShortcutCapture(): void {
  if (!capturingShortcutName) {
    return;
  }
  const otherName = capturingShortcutName === "shortcutKey" ? "translateShortcutKey" : "shortcutKey";
  if (normalizeShortcut(pendingShortcut) === normalizeShortcut(readInput(otherName))) {
    shortcutButtonFor(capturingShortcutName).textContent = "按下快捷键";
    shortcutErrorFor(capturingShortcutName).textContent = capturingShortcutName === "shortcutKey"
      ? "与翻译快捷键冲突，请按其他组合键。"
      : "与选词快捷键冲突，请按其他组合键。";
    pendingShortcut = "";
    return;
  }
  setInput(capturingShortcutName, pendingShortcut);
  shortcutButtonFor(capturingShortcutName).textContent = pendingShortcut;
  shortcutErrorFor(capturingShortcutName).textContent = "";
  capturingShortcutName = undefined;
  pendingShortcut = "";
  markSettingsDirty("快捷键已记录，等待保存");
}

function isModifierKey(key: string): boolean {
  return key === "Control" || key === "Alt" || key === "Shift" || key === "Meta";
}

function updatePreview(settings: GlossaSettings): void {
  applyAppearancePreview({
    preview: glossPreview,
    labels: glossPreviewLabels,
    successLabels: glossPreviewSuccessLabels,
    errorLabels: glossPreviewErrorLabels
  }, settings.appearance);
  const opacityPercent = `${Math.round(settings.appearance.backgroundOpacity * 100)}%`;
  glossBackgroundOpacityValue.value = opacityPercent;
  glossBackgroundOpacityInput.setAttribute("aria-valuetext", opacityPercent);
}

async function resetCardHistory(): Promise<void> {
  if (!window.confirm("重置制卡记录？Glossa 的卡片缓存与重复提醒记录会被清空，Anki 中已有卡片会保留。")) {
    return;
  }
  resetCardHistoryButton.disabled = true;
  setAnkiStatus("正在重置制卡记录…", "pending");
  try {
    // @behavior glossa.card_creation.history_reset.options_request The reset control delegates history mutation to the service worker so it can coordinate active card creation.
    await runtimeMessage(createOptionsMessage("card.history.reset", {}), null);
    setAnkiStatus("制卡记录已重置，Anki 中已有卡片保持不变", "success");
  } catch (error) {
    setAnkiStatus(userMessageForError(diagnosticErrorFrom(error, {
      reason: "runtime",
      message: "Card history reset failed",
      service: "runtime"
    }).payload, "runtime"), "error");
  } finally {
    resetCardHistoryButton.disabled = false;
  }
}

function updateProviderFields(provider: AiSettings["provider"]): void {
  apiKeyField.hidden = provider === "glossa-backend";
  reasoningField.hidden = provider === "openai-completions";
}

function startShortcutCapture(name: "shortcutKey" | "translateShortcutKey", button: HTMLButtonElement): void {
  capturingShortcutName = name;
  pendingShortcut = "";
  shortcutErrorFor(name).textContent = "";
  button.textContent = "按下快捷键";
  button.focus();
}

function shortcutButtonFor(name: "shortcutKey" | "translateShortcutKey"): HTMLButtonElement {
  return name === "shortcutKey" ? shortcutCapture : translateShortcutCapture;
}

async function loadSettings(): Promise<void> {
  const settings = await extensionStorage.settings.get();
  writeSettingsForm(form, settings);
  shortcutCapture.textContent = settings.shortcutKey;
  translateShortcutCapture.textContent = settings.translateShortcutKey;
  currentProvider = settings.ai.provider;
  updateProviderFields(settings.ai.provider);
  setSelectOptions(ankiDeckSelect, [settings.anki.deck], settings.anki.deck);
  setSelectOptions(ankiModelNameSelect, [settings.anki.modelName], settings.anki.modelName);
  setAnkiSelectsEnabled(true);
  updatePreview(settings);
  void knownWordsOperationLane.run(() => refreshKnownWords());
  form.inert = false;
}

function shortcutErrorFor(name: "shortcutKey" | "translateShortcutKey"): HTMLElement {
  return name === "shortcutKey" ? shortcutCaptureError : translateShortcutCaptureError;
}

async function saveSettings(settings: GlossaSettings): Promise<void> {
  await extensionStorage.settings.set(settings);
}
