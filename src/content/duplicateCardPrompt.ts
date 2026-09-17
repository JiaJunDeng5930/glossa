import GLOSSA_THEME from "../shared/theme.json";
const duplicatePromptResolvers = new WeakMap<Document, (confirmed: boolean) => void>();

export function promptDuplicateCardCreation(doc: Document, input: { surface: string; timeoutMs: number }): Promise<boolean> {
  cancelDuplicateCardPrompt(doc);
  return new Promise((resolve) => {
    const previousFocus = doc.activeElement;
    const prompt = doc.createElement("div");
    prompt.dataset.glossaOwned = "1";
    prompt.dataset.glossaDuplicateCardPrompt = "1";
    prompt.setAttribute("role", "dialog");
    prompt.setAttribute("aria-modal", "true");
    prompt.setAttribute("aria-label", "重复制卡确认");
    prompt.style.cssText = [
      "position:fixed",
      "top:20px",
      "right:20px",
      "z-index:2147483647",
      "display:grid",
      "grid-template-columns:minmax(0,1fr) auto auto",
      "align-items:center",
      "gap:12px",
      "max-width:min(440px,calc(100vw - 40px))",
      "padding:15px 16px",
      "border:1px solid rgba(23,24,20,0.32)",
      `border-top:2px solid ${GLOSSA_THEME.accent}`,
      "border-radius:1px",
      "background:rgba(250,248,241,0.98)",
      "color:#171814",
      "font:14px/1.4 ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif",
      "box-shadow:0 20px 48px rgba(23,24,20,0.18)"
    ].join(";");
    const style = doc.createElement("style");
    style.dataset.glossaOwned = "1";
    style.textContent = `
      [data-glossa-duplicate-card-prompt="1"] button:focus-visible {
        outline: 3px solid rgba(227, 179, 77, 0.72);
        outline-offset: 2px;
      }
      @media (max-width: 360px) {
        [data-glossa-duplicate-card-prompt="1"] {
          left: 12px !important;
          top: 12px !important;
          right: 12px !important;
          grid-template-columns: repeat(2, minmax(0, 1fr)) !important;
          gap: 10px !important;
          max-width: none !important;
          padding: 14px !important;
        }
        [data-glossa-duplicate-card-prompt="1"] > span {
          grid-column: 1 / -1;
        }
        [data-glossa-duplicate-card-prompt="1"] > button {
          width: 100%;
          min-width: 0 !important;
        }
      }
    `;
    const text = doc.createElement("span");
    text.id = "glossa-duplicate-card-prompt-description";
    text.textContent = `${input.surface} 已经制过卡，继续制卡？`;
    text.style.cssText = "min-width:0;overflow-wrap:anywhere;font-weight:650;letter-spacing:0.005em";
    prompt.setAttribute("aria-describedby", text.id);
    const confirm = doc.createElement("button");
    confirm.type = "button";
    confirm.textContent = "继续制卡";
    confirm.setAttribute("aria-label", "继续制卡");
    const cancel = doc.createElement("button");
    cancel.type = "button";
    cancel.textContent = "取消";
    cancel.setAttribute("aria-label", "取消制卡");
    confirm.style.cssText = [
      "min-width:88px",
      "height:36px",
      `border:1px solid ${GLOSSA_THEME.accent}`,
      "border-radius:2px",
      `background:${GLOSSA_THEME.accent}`,
      "color:#fffaf2",
      "font:740 14px/1 ui-sans-serif,system-ui",
      "box-shadow:0 7px 16px rgba(200,71,36,0.17)",
      "cursor:pointer"
    ].join(";");
    cancel.style.cssText = [
      "min-width:54px",
      "height:36px",
      "border:1px solid rgba(23,24,20,0.32)",
      "border-radius:2px",
      "background:transparent",
      "color:#171814",
      "font:740 14px/1 ui-sans-serif,system-ui",
      "cursor:pointer"
    ].join(";");
    prompt.append(style, text, confirm, cancel);
    let settled = false;
    let timer: ReturnType<typeof globalThis.setTimeout> | undefined;
    const finish = (confirmed: boolean): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer !== undefined) {
        globalThis.clearTimeout(timer);
      }
      duplicatePromptResolvers.delete(doc);
      prompt.remove();
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected && previousFocus !== doc.body) {
        previousFocus.focus({ preventScroll: true });
      }
      resolve(confirmed);
    };
    // The configured timeout resolves through the same safe cancel path as Escape and the cancel button.
    timer = globalThis.setTimeout(() => finish(false), input.timeoutMs);
    duplicatePromptResolvers.set(doc, finish);
    confirm.addEventListener("click", () => finish(true), { once: true });
    cancel.addEventListener("click", () => finish(false), { once: true });
    prompt.addEventListener("keydown", (event) => {
      if (event.key === "Tab") {
        const activeElement = doc.activeElement;
        if (event.shiftKey && activeElement === confirm) {
          event.preventDefault();
          cancel.focus();
        } else if (!event.shiftKey && activeElement === cancel) {
          event.preventDefault();
          confirm.focus();
        }
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        finish(false);
      }
    });
    (doc.body ?? doc.documentElement).append(prompt);
    confirm.focus({ preventScroll: true });
  });
}

export function cancelDuplicateCardPrompt(doc: Document): void {
  const resolver = duplicatePromptResolvers.get(doc);
  if (resolver) {
    resolver(false);
    return;
  }
  doc.querySelector("[data-glossa-duplicate-card-prompt]")?.remove();
}

