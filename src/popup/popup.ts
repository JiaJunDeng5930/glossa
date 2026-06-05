// @behavior glossa.translation_start_popup The popup can activate translation for the current tab, open settings, and render failures from typed activation results.
import { isErrorPayload } from "../shared/errors";
import { mergeStoredSettings, type StoredGlossaSettings } from "../shared/settings";
import { DEFAULT_SETTINGS } from "../shared/types";
import { userMessageForError } from "../shared/userMessages";

const DEFAULT_ACTIVATION_FAILURE_MESSAGE = "当前页面无法翻译";
const DEFAULT_SHORTCUT_SETTINGS_FAILURE_MESSAGE = "无法读取快捷键设置";

// @constraint glossa.translation_start_popup.activation_result Popup activation resolves into a closed success state or a visible failure message.
type ActivationResult = ActivationActivatedResult | ActivationFailedResult;

interface ActivationActivatedResult {
  // @constraint glossa.translation_start_popup.activation_result.activated_kind Successful popup activation results carry the activated kind.
  kind: "activated";
}

interface ActivationFailedResult {
  // @constraint glossa.translation_start_popup.activation_result.failed_kind Failed popup activation results carry the failed kind.
  kind: "failed";
  // @constraint glossa.translation_start_popup.activation_result.failed_message Failed popup activation results carry visible failure text.
  message: string;
}

const translateButton = document.querySelector<HTMLButtonElement>("#translate-page")!;
const optionsButton = document.querySelector<HTMLButtonElement>("#open-options")!;
const statusOutput = document.querySelector<HTMLOutputElement>("#popup-status")!;
const translateShortcutHint = document.querySelector<HTMLElement>("#translate-shortcut-hint")!;

// @behavior glossa.translation_start_popup.shortcut_hint.failure Stored shortcut read failures render a visible popup status message.
void renderTranslateShortcutHint().catch((error) => {
  setStatus(shortcutSettingsFailureMessage(error));
});

translateButton.addEventListener("click", () => {
  void activateCurrentTab();
});

optionsButton.addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

// @behavior glossa.translation_start_popup.button_state The translate action disables the button while resolving activation and restores it only after visible failure output.
async function activateCurrentTab(): Promise<void> {
  // @behavior glossa.translation_start_popup.button_state.start The translate button clears prior status and disables itself before activation starts.
  setStatus("");
  translateButton.disabled = true;
  const result = await resolveCurrentTabActivation();
  // @behavior glossa.translation_start_popup.button_state.success Successful popup activation closes the popup without restoring the button.
  if (result.kind === "activated") {
    window.close();
    return;
  }
  // @behavior glossa.translation_start_popup.button_state.failure Failed popup activation shows the failure text and enables the translate button again.
  setStatus(result.message);
  translateButton.disabled = false;
}

// @behavior glossa.translation_start_popup.activation_resolution Popup activation targets the current tab and maps missing tabs, runtime responses, and exceptions into activation results.
async function resolveCurrentTabActivation(): Promise<ActivationResult> {
  // @behavior glossa.translation_start_popup.activation_resolution.result_mapping Current-tab lookup, tab messaging, and thrown errors all resolve to typed activation results.
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

// @behavior glossa.translation_start_popup.shortcut_hint The popup renders the page-translation shortcut from saved settings on load.
async function renderTranslateShortcutHint(): Promise<void> {
  const settings = await readPopupSettings();
  renderShortcutHint(settings.translateShortcutKey);
}

// @behavior glossa.translation_start_popup.shortcut_hint.storage Popup shortcut hint reads settings from Chrome local storage using the shared default merge rules.
async function readPopupSettings() {
  const stored = await readChromeLocalSettings();
  return mergeStoredSettings(stored);
}

function readChromeLocalSettings(): Promise<StoredGlossaSettings | undefined> {
  if (!globalThis.chrome?.storage?.local) {
    return Promise.resolve(undefined);
  }
  return new Promise((resolve, reject) => {
    // @behavior glossa.translation_start_popup.shortcut_hint.storage_read Popup shortcut hint reads the stored settings key from Chrome local storage.
    chrome.storage.local.get("settings", (result) => {
      // @behavior glossa.translation_start_popup.shortcut_hint.storage_error Chrome storage errors reject shortcut hint initialization with the runtime error message.
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve(result.settings as StoredGlossaSettings | undefined);
    });
  });
}

// @behavior glossa.translation_start_popup.shortcut_hint.render Shortcut hint rendering splits the stored shortcut into individual keycap labels.
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
  // @behavior glossa.translation_start_popup.shortcut_hint.failure_message Error instances with messages become visible shortcut settings failure text.
  if (error instanceof Error && error.message) {
    return error.message;
  }
  // @behavior glossa.translation_start_popup.shortcut_hint.failure_string String exceptions become visible shortcut settings failure text.
  if (typeof error === "string" && error) {
    return error;
  }
  // @behavior glossa.translation_start_popup.shortcut_hint.failure_default Empty or unknown shortcut settings failures use the default popup failure text.
  return DEFAULT_SHORTCUT_SETTINGS_FAILURE_MESSAGE;
}

function isOkResponse(value: unknown): value is { ok: true } {
  return typeof value === "object"
    && value !== null
    && "ok" in value
    && value.ok === true;
}

// @behavior glossa.translation_start_popup.structured_response Popup activation accepts ok responses as success and structured error responses as localized failure text.
function activationResultFromResponse(value: unknown): ActivationResult {
  // @behavior glossa.translation_start_popup.structured_response.success An ok activation response maps to the popup success state.
  if (isOkResponse(value)) {
    return { kind: "activated" };
  }
  // @behavior glossa.translation_start_popup.structured_response.error Structured activation errors map through runtime user-facing text.
  if (hasActivationError(value)) {
    return activationFailed(userMessageForError(value.error, "runtime"));
  }
  return activationFailed();
}

// @behavior glossa.translation_start_popup.exception_failure Popup activation exceptions become visible failure messages.
function activationFailureFromError(error: unknown): ActivationResult {
  // @behavior glossa.translation_start_popup.exception_failure.error_message Error instances with messages become visible popup failure text.
  if (error instanceof Error && error.message) {
    return activationFailed(error.message);
  }
  // @behavior glossa.translation_start_popup.exception_failure.string_message String exceptions become visible popup failure text.
  if (typeof error === "string" && error) {
    return activationFailed(error);
  }
  // @behavior glossa.translation_start_popup.exception_failure.default_message Empty or unknown exceptions use the default popup failure text.
  return activationFailed();
}

// @behavior glossa.translation_start_popup.default_failure Popup activation failures use a default message when no structured message is available.
function activationFailed(message = DEFAULT_ACTIVATION_FAILURE_MESSAGE): ActivationResult {
  // @behavior glossa.translation_start_popup.default_failure.result Popup activation failure results always carry visible text.
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
