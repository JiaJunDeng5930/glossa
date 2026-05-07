import { describe, expect, it, vi } from "vitest";

import { createSelectionController } from "../../src/content/selection";

describe("selection controller", () => {
  it("enters selection mode while the shortcut is held and captures word clicks", () => {
    document.body.innerHTML = `<button id="save">Save draft</button>`;
    const button = document.querySelector<HTMLButtonElement>("#save")!;
    const onWordSelected = vi.fn();
    const onButtonClick = vi.fn();
    const onSelectionModeChange = vi.fn();
    button.addEventListener("click", onButtonClick);

    const controller = createSelectionController({
      document,
      shortcutKey: "Alt",
      onWordSelected,
      onSelectionModeChange
    });
    controller.attach();

    button.dispatchEvent(new KeyboardEvent("keydown", { key: "Alt", bubbles: true }));
    button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    button.dispatchEvent(new KeyboardEvent("keyup", { key: "Alt", bubbles: true }));

    expect(onWordSelected).toHaveBeenCalledWith(expect.objectContaining({ surface: "Save" }));
    expect(onWordSelected).toHaveBeenCalledWith(expect.objectContaining({
      renderToken: expect.objectContaining({ sourceText: "Save" })
    }));
    expect(onButtonClick).not.toHaveBeenCalled();
    expect(onSelectionModeChange).toHaveBeenNthCalledWith(1, true);
    expect(onSelectionModeChange).toHaveBeenNthCalledWith(2, false);

    controller.detach();
  });

  it("reuses rendered token metadata when a gloss wrapper is clicked", () => {
    document.body.innerHTML = `
      <p>
        <span
          data-glossa-token="t-submit"
          data-glossa-surface="Submit"
          data-glossa-lemma="submit"
          data-glossa-original-start="0"
          data-glossa-original-end="6"
        >
          <span data-glossa-token-label="t-submit">提交</span>
          <span data-glossa-token-surface="t-submit">Submit</span>
        </span>
      </p>
    `;
    const onWordSelected = vi.fn();
    const controller = createSelectionController({
      document,
      shortcutKey: "Alt",
      onWordSelected
    });
    controller.attach();

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Alt", bubbles: true }));
    document.querySelector("[data-glossa-token-surface]")!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

    expect(onWordSelected).toHaveBeenCalledWith(expect.objectContaining({
      token: expect.objectContaining({ id: "t-submit", lemma: "submit", surface: "Submit" })
    }));
    expect(onWordSelected.mock.calls[0]?.[0].renderToken).toBeUndefined();

    controller.detach();
  });

  it("supports captured shortcut combinations", () => {
    document.body.innerHTML = `<button id="save">Save draft</button>`;
    const button = document.querySelector<HTMLButtonElement>("#save")!;
    const onWordSelected = vi.fn();

    const controller = createSelectionController({
      document,
      shortcutKey: "Ctrl+Shift+K",
      onWordSelected
    });
    controller.attach();

    button.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, shiftKey: true, bubbles: true }));
    button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    button.dispatchEvent(new KeyboardEvent("keyup", { key: "k", bubbles: true }));

    expect(onWordSelected).toHaveBeenCalledWith(expect.objectContaining({ surface: "Save" }));

    controller.detach();
  });

  it("routes async selection failures to the error handler", async () => {
    document.body.innerHTML = `<button id="save">Save draft</button>`;
    const button = document.querySelector<HTMLButtonElement>("#save")!;
    const error = new Error("selection failed");
    const onError = vi.fn();

    const controller = createSelectionController({
      document,
      shortcutKey: "Alt",
      onWordSelected: vi.fn(async () => {
        throw error;
      }),
      onError
    });
    controller.attach();

    button.dispatchEvent(new KeyboardEvent("keydown", { key: "Alt", bubbles: true }));
    button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await Promise.resolve();

    expect(onError).toHaveBeenCalledWith(error);

    controller.detach();
  });
});
