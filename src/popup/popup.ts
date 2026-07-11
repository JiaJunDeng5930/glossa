import { isErrorPayload } from "../shared/errors";
import { mergeStoredSettings, type StoredGlossaSettings } from "../shared/settings";
import { DEFAULT_SETTINGS } from "../shared/types";
import { userMessageForError } from "../shared/userMessages";

const DEFAULT_ACTIVATION_FAILURE_MESSAGE = "当前页面无法翻译";
const DEFAULT_SHORTCUT_SETTINGS_FAILURE_MESSAGE = "无法读取快捷键设置";

type ActivationResult = ActivationActivatedResult | ActivationFailedResult;

interface ActivationActivatedResult {
  kind: "activated";
}

interface ActivationFailedResult {
  kind: "failed";
  message: string;
}

const translateButton = document.querySelector<HTMLButtonElement>("#translate-page")!;
const optionsButton = document.querySelector<HTMLButtonElement>("#open-options")!;
const statusOutput = document.querySelector<HTMLOutputElement>("#popup-status")!;
const translateShortcutHint = document.querySelector<HTMLElement>("#translate-shortcut-hint")!;

void renderTranslateShortcutHint().catch((error) => {
  setStatus(shortcutSettingsFailureMessage(error));
});

translateButton.addEventListener("click", () => {
  void activateCurrentTab();
});

optionsButton.addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

async function activateCurrentTab(): Promise<void> {
  setStatus("");
  translateButton.disabled = true;
  const result = await resolveCurrentTabActivation();
  if (result.kind === "activated") {
    window.close();
    return;
  }
  setStatus(result.message);
  translateButton.disabled = false;
}

async function resolveCurrentTabActivation(): Promise<ActivationResult> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) {
      return activationFailed();
    }
    const response = await chrome.tabs.sendMessage(tab.id, { type: "glossa.activateTranslation" });
    return activationResultFromResponse(response);
  } catch (error) {
    return activationFailureFromError(error);
  }
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

function shortcutSettingsFailureMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  if (typeof error === "string" && error) {
    return error;
  }
  return DEFAULT_SHORTCUT_SETTINGS_FAILURE_MESSAGE;
}

function isOkResponse(value: unknown): value is { ok: true } {
  return typeof value === "object"
    && value !== null
    && "ok" in value
    && value.ok === true;
}

function activationResultFromResponse(value: unknown): ActivationResult {
  if (isOkResponse(value)) {
    return { kind: "activated" };
  }
  if (hasActivationError(value)) {
    return activationFailed(userMessageForError(value.error, "runtime"));
  }
  return activationFailed();
}

function activationFailureFromError(error: unknown): ActivationResult {
  if (error instanceof Error && error.message) {
    return activationFailed(error.message);
  }
  if (typeof error === "string" && error) {
    return activationFailed(error);
  }
  return activationFailed();
}

function activationFailed(message = DEFAULT_ACTIVATION_FAILURE_MESSAGE): ActivationResult {
  return { kind: "failed", message };
}

function hasActivationError(value: unknown): value is { ok: false; error: Parameters<typeof userMessageForError>[0] } {
  return typeof value === "object"
    && value !== null
    && "ok" in value
    && value.ok === false
    && "error" in value
    && isErrorPayload(value.error);
}
