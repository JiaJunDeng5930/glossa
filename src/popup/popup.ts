// @behavior glossa.translation_start_popup The popup can activate translation for the current tab, open settings, and render failures from typed activation results.
import { isErrorPayload } from "../shared/errors";
import { userMessageForError } from "../shared/userMessages";

const DEFAULT_ACTIVATION_FAILURE_MESSAGE = "当前页面无法翻译";

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
