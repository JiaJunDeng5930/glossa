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
      throw new Error("Activation failed");
    }
    window.close();
  } catch {
    setStatus("当前页面无法翻译");
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
