// @behavior glossa.translation_start_popup The popup can activate translation for the current tab, open settings, and show user-readable failures.
import { isErrorPayload } from "../shared/errors";
import { userMessageForError } from "../shared/userMessages";

const translateButton = document.querySelector<HTMLButtonElement>("#translate-page")!;
const optionsButton = document.querySelector<HTMLButtonElement>("#open-options")!;
const statusOutput = document.querySelector<HTMLOutputElement>("#popup-status")!;

translateButton.addEventListener("click", () => {
  void activateCurrentTab();
});

optionsButton.addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

async function activateCurrentTab(): Promise<void> {
  setStatus("");
  translateButton.disabled = true;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) {
      throw new Error("No active tab");
    }
    const response = await chrome.tabs.sendMessage(tab.id, { type: "glossa.activateTranslation" });
    if (!isOkResponse(response)) {
      if (hasActivationError(response)) {
        throw new Error(userMessageForError(response.error, "runtime"));
      }
      throw new Error("Activation failed");
    }
    window.close();
  } catch (error) {
    setStatus(error instanceof Error && error.message !== "Activation failed" ? error.message : "当前页面无法翻译");
    translateButton.disabled = false;
  }
}

function setStatus(value: string): void {
  statusOutput.value = value;
}

function isOkResponse(value: unknown): value is { ok: true } {
  return typeof value === "object"
    && value !== null
    && "ok" in value
    && value.ok === true;
}

function hasActivationError(value: unknown): value is { ok: false; error: Parameters<typeof userMessageForError>[0] } {
  return typeof value === "object"
    && value !== null
    && "ok" in value
    && value.ok === false
    && "error" in value
    && isErrorPayload(value.error);
}
