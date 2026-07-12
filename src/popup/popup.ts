import { diagnosticPayloadFrom, isErrorPayload } from "../shared/errors";
import { mergeStoredSettings, type StoredGlossaSettings } from "../shared/settings";
import { DEFAULT_SETTINGS } from "../shared/types";
import { userMessageForError } from "../shared/userMessages";

const DEFAULT_SHORTCUT_SETTINGS_FAILURE_MESSAGE = "无法读取快捷键设置";
// The probe window covers the content script's five-second settings read and local word-list startup.
const STATE_PROBE_ATTEMPTS = 61;
const STATE_PROBE_RETRY_MS = 100;

const translateButton = document.querySelector<HTMLButtonElement>("#translate-page")!;
const translateButtonLabel = document.querySelector<HTMLElement>("#translate-page-label")!;
const pageStateLabel = document.querySelector<HTMLElement>("#page-state-label")!;
const pageStateMark = document.querySelector<HTMLElement>("#page-state-mark")!;
const optionsButton = document.querySelector<HTMLButtonElement>("#open-options")!;
const statusOutput = document.querySelector<HTMLOutputElement>("#popup-status")!;
const translateShortcutHint = document.querySelector<HTMLElement>("#translate-shortcut-hint")!;
let currentTabId: number | undefined;
let translationEnabled = false;

void initializeTranslationState();
void renderTranslateShortcutHint().catch((error) => {
  setStatus(shortcutSettingsFailureMessage(error));
});

translateButton.addEventListener("click", () => {
  void toggleCurrentTab();
});

optionsButton.addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

async function initializeTranslationState(): Promise<void> {
  setStatus("");
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) {
      renderUnavailable();
      return;
    }
    const response = await probeTranslationState(tab.id);
    if (!isTranslationStateResponse(response)) {
      renderUnavailable(messageFromControlResponse(response));
      return;
    }
    currentTabId = tab.id;
    translationEnabled = response.enabled;
    renderAvailableState();
  } catch {
    renderUnavailable();
  }
}

async function probeTranslationState(tabId: number): Promise<unknown> {
  for (let attempt = 1; attempt <= STATE_PROBE_ATTEMPTS; attempt += 1) {
    try {
      return await chrome.tabs.sendMessage(tabId, { type: "glossa.getTranslationState" }, { frameId: 0 });
    } catch (error) {
      if (attempt === STATE_PROBE_ATTEMPTS || !isReceiverStartupError(error)) {
        throw error;
      }
      await new Promise<void>((resolve) => globalThis.setTimeout(resolve, STATE_PROBE_RETRY_MS));
    }
  }
  return undefined;
}

function isReceiverStartupError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("Receiving end does not exist") || message.includes("Could not establish connection");
}

async function toggleCurrentTab(): Promise<void> {
  if (currentTabId === undefined) {
    return;
  }
  setStatus("");
  translateButton.disabled = true;
  translateButtonLabel.textContent = translationEnabled ? "正在停止…" : "正在开启…";
  try {
    const desiredState = !translationEnabled;
    // The top frame defines the tab state; an explicit value keeps every injected frame synchronized.
    const response = await chrome.tabs.sendMessage(currentTabId, {
      type: "glossa.setTranslationState",
      enabled: desiredState
    });
    if (!isTranslationStateResponse(response)) {
      setStatus(messageFromControlResponse(response));
      renderAvailableState();
      return;
    }
    translationEnabled = response.enabled;
    window.close();
  } catch (error) {
    setStatus(userMessageForError(diagnosticPayloadFrom(error, {
      reason: "runtime",
      message: "Translation toggle failed",
      service: "runtime"
    }), "runtime"));
    renderAvailableState();
  }
}

function renderAvailableState(): void {
  pageStateLabel.textContent = translationEnabled ? "翻译已开启" : "翻译已关闭";
  pageStateMark.textContent = translationEnabled ? "开启" : "可用";
  pageStateMark.dataset.state = translationEnabled ? "active" : "available";
  translateButtonLabel.textContent = translationEnabled ? "停止翻译" : "翻译本页";
  translateButton.disabled = false;
}

function renderUnavailable(message = "当前页面不支持扩展翻译"): void {
  currentTabId = undefined;
  pageStateLabel.textContent = "此页面不可用";
  pageStateMark.textContent = "不可用";
  pageStateMark.dataset.state = "unavailable";
  translateButtonLabel.textContent = "当前页面不可用";
  translateButton.disabled = true;
  setStatus(message);
}

function setStatus(value: string): void {
  statusOutput.value = value;
}

async function renderTranslateShortcutHint(): Promise<void> {
  const settings = await readPopupSettings();
  renderShortcutHint(settings.translateShortcutKey);
}

async function readPopupSettings() {
  const stored = await readChromeLocalSettings();
  return mergeStoredSettings(stored);
}

function readChromeLocalSettings(): Promise<StoredGlossaSettings | undefined> {
  if (!globalThis.chrome?.storage?.local) {
    return Promise.resolve(undefined);
  }
  return new Promise((resolve, reject) => {
    chrome.storage.local.get("settings", (result) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve(result.settings as StoredGlossaSettings | undefined);
    });
  });
}

function renderShortcutHint(shortcut: string): void {
  const parts = shortcutParts(shortcut);
  translateShortcutHint.replaceChildren(...shortcutNodes(parts));
  translateShortcutHint.setAttribute("aria-label", parts.join("+"));
}

function shortcutParts(shortcut: string): string[] {
  const parts = shortcut.split("+").map((part) => part.trim()).filter(Boolean);
  return parts.length > 0 ? parts : DEFAULT_SETTINGS.translateShortcutKey.split("+");
}

function shortcutNodes(parts: string[]): Node[] {
  const nodes: Node[] = [];
  for (const [index, part] of parts.entries()) {
    if (index > 0) {
      const separator = document.createElement("span");
      separator.className = "shortcut-separator";
      separator.textContent = "+";
      nodes.push(separator);
    }
    const keycap = document.createElement("kbd");
    keycap.textContent = part;
    nodes.push(keycap);
  }
  return nodes;
}

function shortcutSettingsFailureMessage(_error: unknown): string {
  return DEFAULT_SHORTCUT_SETTINGS_FAILURE_MESSAGE;
}

function isTranslationStateResponse(value: unknown): value is { ok: true; enabled: boolean } {
  return typeof value === "object"
    && value !== null
    && "ok" in value
    && value.ok === true
    && "enabled" in value
    && typeof value.enabled === "boolean";
}

function messageFromControlResponse(value: unknown): string {
  if (hasControlError(value)) {
    return userMessageForError(value.error, "runtime");
  }
  return "扩展运行时错误";
}

function hasControlError(value: unknown): value is { ok: false; error: Parameters<typeof userMessageForError>[0] } {
  return typeof value === "object"
    && value !== null
    && "ok" in value
    && value.ok === false
    && "error" in value
    && isErrorPayload(value.error);
}
