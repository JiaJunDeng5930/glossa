import { afterEach, describe, expect, it, vi } from "vitest";

import { createSelectionController } from "../../src/content/selection";

describe("selection controller", () => {
  afterEach(() => {
    Reflect.deleteProperty(document, "caretPositionFromPoint");
    Reflect.deleteProperty(document, "caretRangeFromPoint");
    vi.restoreAllMocks();
  });

  it("enters selection mode while the shortcut is held and captures word clicks", () => {
    document.body.innerHTML = `<button id="save">Save draft</button>`;
    const button = document.querySelector<HTMLButtonElement>("#save")!;
    const onWordSelected = vi.fn();
    const onButtonClick = vi.fn();
    const onSelectionModeChange = vi.fn();
    button.addEventListener("click", onButtonClick);
    installCaretPosition(button.firstChild as Text, 2);

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

  it("uses the complete sentence when a clicked word sits inside inline markup", () => {
    document.body.innerHTML = `<p>A <em id="target">quizzical</em> bank appears in a complicated context.</p>`;
    const target = document.querySelector<HTMLElement>("#target")!;
    const onWordSelected = vi.fn();
    installCaretPosition(target.firstChild as Text, 2);
    const controller = createSelectionController({ document, shortcutKey: "Alt", onWordSelected });
    controller.attach();

    target.dispatchEvent(new KeyboardEvent("keydown", { key: "Alt", bubbles: true }));
    target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    controller.detach();

    expect(onWordSelected).toHaveBeenCalledWith(expect.objectContaining({
      sentence: "A quizzical bank appears in a complicated context.",
      token: expect.objectContaining({ startOffset: 2, endOffset: 11 })
    }));
  });

  it("freezes page pointer preparation while preserving click selection for button text", () => {
    document.body.innerHTML = `<button id="save">Save draft</button>`;
    const button = document.querySelector<HTMLButtonElement>("#save")!;
    const onWordSelected = vi.fn();
    const onPointerDown = vi.fn();
    const onMouseDown = vi.fn();
    button.addEventListener("pointerdown", onPointerDown);
    button.addEventListener("mousedown", onMouseDown);
    installCaretPosition(button.firstChild as Text, 2);

    const controller = createSelectionController({
      document,
      shortcutKey: "Alt",
      onWordSelected
    });
    controller.attach();

    button.dispatchEvent(new KeyboardEvent("keydown", { key: "Alt", bubbles: true }));
    const pointerDown = new MouseEvent("pointerdown", { bubbles: true, cancelable: true });
    const mouseDown = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    button.dispatchEvent(pointerDown);
    button.dispatchEvent(mouseDown);
    button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

    expect(pointerDown.defaultPrevented).toBe(true);
    expect(mouseDown.defaultPrevented).toBe(true);
    expect(onPointerDown).not.toHaveBeenCalled();
    expect(onMouseDown).not.toHaveBeenCalled();
    expect(onWordSelected).toHaveBeenCalledWith(expect.objectContaining({ surface: "Save" }));

    controller.detach();
  });

  it("freezes wheel, touch, and shortcut key events while the shortcut is held", () => {
    document.body.innerHTML = `<main id="page">Readable content</main>`;
    const page = document.querySelector<HTMLElement>("#page")!;
    const onWheel = vi.fn();
    const onTouchMove = vi.fn();
    const onKey = vi.fn();
    page.addEventListener("wheel", onWheel);
    page.addEventListener("touchmove", onTouchMove);
    page.addEventListener("keydown", onKey);
    page.addEventListener("keyup", onKey);

    const controller = createSelectionController({
      document,
      shortcutKey: "Alt",
      onWordSelected: vi.fn()
    });
    controller.attach();

    const altDown = new KeyboardEvent("keydown", { key: "Alt", bubbles: true, cancelable: true });
    const wheel = new WheelEvent("wheel", { bubbles: true, cancelable: true });
    const touchMove = new Event("touchmove", { bubbles: true, cancelable: true });
    const altUp = new KeyboardEvent("keyup", { key: "Alt", bubbles: true, cancelable: true });
    page.dispatchEvent(altDown);
    page.dispatchEvent(wheel);
    page.dispatchEvent(touchMove);
    page.dispatchEvent(altUp);

    expect(altDown.defaultPrevented).toBe(true);
    expect(wheel.defaultPrevented).toBe(true);
    expect(touchMove.defaultPrevented).toBe(true);
    expect(altUp.defaultPrevented).toBe(true);
    expect(onWheel).not.toHaveBeenCalled();
    expect(onTouchMove).not.toHaveBeenCalled();
    expect(onKey).not.toHaveBeenCalled();

    controller.detach();
  });

  it("attaches scroll blockers only while selection mode is active", () => {
    const addSpy = vi.spyOn(document, "addEventListener");
    const removeSpy = vi.spyOn(document, "removeEventListener");
    const controller = createSelectionController({
      document,
      shortcutKey: "Alt",
      onWordSelected: vi.fn()
    });
    controller.attach();

    expect(addSpy).not.toHaveBeenCalledWith("wheel", expect.any(Function), expect.objectContaining({ passive: false }));
    expect(addSpy).not.toHaveBeenCalledWith("touchmove", expect.any(Function), expect.objectContaining({ passive: false }));

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Alt", bubbles: true, cancelable: true }));

    expect(addSpy).toHaveBeenCalledWith("wheel", expect.any(Function), expect.objectContaining({ passive: false }));
    expect(addSpy).toHaveBeenCalledWith("touchmove", expect.any(Function), expect.objectContaining({ passive: false }));

    document.dispatchEvent(new KeyboardEvent("keyup", { key: "Alt", bubbles: true, cancelable: true }));

    expect(removeSpy).toHaveBeenCalledWith("wheel", expect.any(Function), expect.objectContaining({ passive: false }));
    expect(removeSpy).toHaveBeenCalledWith("touchmove", expect.any(Function), expect.objectContaining({ passive: false }));

    controller.detach();
  });

  it("leaves selection mode when another key joins a modifier-only shortcut", () => {
    document.body.innerHTML = `<button id="save">Save draft</button>`;
    const button = document.querySelector<HTMLButtonElement>("#save")!;
    const onWordSelected = vi.fn();
    const onButtonClick = vi.fn();
    const onPageKey = vi.fn();
    const onSelectionModeChange = vi.fn();
    button.addEventListener("click", onButtonClick);
    button.addEventListener("keydown", onPageKey);
    installCaretPosition(button.firstChild as Text, 2);

    const controller = createSelectionController({
      document,
      shortcutKey: "Alt",
      onWordSelected,
      onSelectionModeChange
    });
    controller.attach();

    button.dispatchEvent(new KeyboardEvent("keydown", { key: "Alt", bubbles: true, cancelable: true }));
    const chordKey = new KeyboardEvent("keydown", { key: "v", altKey: true, bubbles: true, cancelable: true });
    button.dispatchEvent(chordKey);
    button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

    expect(chordKey.defaultPrevented).toBe(false);
    expect(onPageKey).toHaveBeenCalledTimes(1);
    expect(onWordSelected).not.toHaveBeenCalled();
    expect(onButtonClick).toHaveBeenCalledTimes(1);
    expect(onSelectionModeChange).toHaveBeenNthCalledWith(1, true);
    expect(onSelectionModeChange).toHaveBeenNthCalledWith(2, false);

    controller.detach();
  });

  it("leaves selection mode when the page loses focus during a shortcut hold", () => {
    document.body.innerHTML = `<button id="save">Save draft</button>`;
    const button = document.querySelector<HTMLButtonElement>("#save")!;
    const onWordSelected = vi.fn();
    const onButtonClick = vi.fn();
    const onSelectionModeChange = vi.fn();
    button.addEventListener("click", onButtonClick);
    installCaretPosition(button.firstChild as Text, 2);

    const controller = createSelectionController({
      document,
      shortcutKey: "Alt",
      onWordSelected,
      onSelectionModeChange
    });
    controller.attach();

    button.dispatchEvent(new KeyboardEvent("keydown", { key: "Alt", bubbles: true, cancelable: true }));
    window.dispatchEvent(new Event("blur"));
    button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

    expect(document.documentElement.dataset.glossaSelecting).toBeUndefined();
    expect(onWordSelected).not.toHaveBeenCalled();
    expect(onButtonClick).toHaveBeenCalledTimes(1);
    expect(onSelectionModeChange).toHaveBeenNthCalledWith(1, true);
    expect(onSelectionModeChange).toHaveBeenNthCalledWith(2, false);

    controller.detach();
  });

  it("recomputes rendered token context when surrounding text changes", () => {
    document.body.innerHTML = `<p>Updated <span data-glossa-token="t-submit" data-glossa-owned="1" data-glossa-surface="Submit" data-glossa-lemma="submit" data-glossa-original-start="0" data-glossa-original-end="6" data-glossa-sentence="A submit button finishes the form." data-glossa-sentence-start="2" data-glossa-sentence-end="8"><span data-glossa-token-label="t-submit">提交</span><span data-glossa-token-surface="t-submit">Submit</span></span> context appears.</p>`;
    const onWordSelected = vi.fn();
    const controller = createSelectionController({
      document,
      shortcutKey: "Alt",
      onWordSelected
    });
    controller.attach();

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Alt", bubbles: true }));
    document.querySelector("[data-glossa-token-surface]")!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    controller.detach();

    expect(onWordSelected).toHaveBeenCalledWith(expect.objectContaining({
      token: expect.objectContaining({ id: "t-submit", lemma: "submit", surface: "Submit", startOffset: 8, endOffset: 14 }),
      sentence: "Updated Submit context appears."
    }));
    expect(onWordSelected.mock.calls[0]?.[0].renderToken).toBeUndefined();
  });

  it("supports captured shortcut combinations", () => {
    document.body.innerHTML = `<button id="save">Save draft</button>`;
    const button = document.querySelector<HTMLButtonElement>("#save")!;
    const onWordSelected = vi.fn();
    installCaretPosition(button.firstChild as Text, 2);

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

  it("leaves combination selection when a chord modifier is released", () => {
    document.body.innerHTML = `<button id="save">Save draft</button>`;
    const button = document.querySelector<HTMLButtonElement>("#save")!;
    const onWordSelected = vi.fn();
    const onButtonClick = vi.fn();
    button.addEventListener("click", onButtonClick);
    installCaretPosition(button.firstChild as Text, 2);

    const controller = createSelectionController({
      document,
      shortcutKey: "Alt+V",
      onWordSelected
    });
    controller.attach();

    button.dispatchEvent(new KeyboardEvent("keydown", { key: "v", altKey: true, bubbles: true, cancelable: true }));
    const altUp = new KeyboardEvent("keyup", { key: "Alt", bubbles: true, cancelable: true });
    button.dispatchEvent(altUp);
    button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

    expect(altUp.defaultPrevented).toBe(true);
    expect(onWordSelected).not.toHaveBeenCalled();
    expect(onButtonClick).toHaveBeenCalledTimes(1);

    controller.detach();
  });

  it("ignores plain-text clicks that resolve outside an English word", () => {
    document.body.innerHTML = `<p id="target">Save  draft</p>`;
    const target = document.querySelector<HTMLParagraphElement>("#target")!;
    const onWordSelected = vi.fn();
    installCaretPosition(target.firstChild as Text, 5);

    const controller = createSelectionController({
      document,
      shortcutKey: "Alt",
      onWordSelected
    });
    controller.attach();

    target.dispatchEvent(new KeyboardEvent("keydown", { key: "Alt", bubbles: true }));
    target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

    expect(onWordSelected).not.toHaveBeenCalled();

    controller.detach();
  });

  it("ignores plain-text clicks that resolve at a word end boundary", () => {
    document.body.innerHTML = `<p id="target">Save  draft</p>`;
    const target = document.querySelector<HTMLParagraphElement>("#target")!;
    const onWordSelected = vi.fn();
    installCaretPosition(target.firstChild as Text, 4);

    const controller = createSelectionController({
      document,
      shortcutKey: "Alt",
      onWordSelected
    });
    controller.attach();

    target.dispatchEvent(new KeyboardEvent("keydown", { key: "Alt", bubbles: true }));
    target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

    expect(onWordSelected).not.toHaveBeenCalled();

    controller.detach();
  });

  it("ignores plain-text clicks when the browser cannot resolve a text point", () => {
    document.body.innerHTML = `<p id="target">Save draft</p>`;
    const target = document.querySelector<HTMLParagraphElement>("#target")!;
    const onWordSelected = vi.fn();

    const controller = createSelectionController({
      document,
      shortcutKey: "Alt",
      onWordSelected
    });
    controller.attach();

    target.dispatchEvent(new KeyboardEvent("keydown", { key: "Alt", bubbles: true }));
    target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

    expect(onWordSelected).not.toHaveBeenCalled();

    controller.detach();
  });

  it("lets duplicate prompt controls receive clicks while the shortcut is held", () => {
    document.body.innerHTML = `<div data-glossa-owned="1" data-glossa-duplicate-card-prompt="1"><button id="confirm">Confirm</button></div>`;
    const button = document.querySelector<HTMLButtonElement>("#confirm")!;
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

    expect(onButtonClick).toHaveBeenCalledTimes(1);
    expect(onWordSelected).not.toHaveBeenCalled();

    controller.detach();
  });

  it("routes async selection failures to the error handler", async () => {
    document.body.innerHTML = `<button id="save">Save draft</button>`;
    const button = document.querySelector<HTMLButtonElement>("#save")!;
    const error = new Error("selection failed");
    const onError = vi.fn();
    installCaretPosition(button.firstChild as Text, 2);

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

function installCaretPosition(node: Text, offset: number): void {
  Object.defineProperty(document, "caretPositionFromPoint", {
    configurable: true,
    value: vi.fn(() => ({ offsetNode: node, offset }))
  });
  Object.defineProperty(document, "caretRangeFromPoint", {
    configurable: true,
    value: undefined
  });
}
