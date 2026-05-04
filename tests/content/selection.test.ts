import { describe, expect, it, vi } from "vitest";

import { createSelectionController } from "../../src/content/selection";

describe("selection controller", () => {
  it("enters selection mode while the shortcut is held and captures word clicks", () => {
    document.body.innerHTML = `<button id="save">Save draft</button>`;
    const button = document.querySelector<HTMLButtonElement>("#save")!;
    const onWordSelected = vi.fn();
    const onButtonClick = vi.fn();
    button.addEventListener("click", onButtonClick);

    const controller = createSelectionController({
      document,
      shortcutKey: "Alt",
      onWordSelected
    });
    controller.attach();

    button.dispatchEvent(new KeyboardEvent("keydown", { key: "Alt", bubbles: true }));
    button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    button.dispatchEvent(new KeyboardEvent("keyup", { key: "Alt", bubbles: true }));

    expect(onWordSelected).toHaveBeenCalledWith(expect.objectContaining({ surface: "Save" }));
    expect(onButtonClick).not.toHaveBeenCalled();

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
});
