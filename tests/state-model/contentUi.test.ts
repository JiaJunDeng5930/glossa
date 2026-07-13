import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createGlossOverlay } from "../../src/content/overlay";
import { createSelectionController } from "../../src/content/selection";
import { createSourceFingerprint, type ScannedToken } from "../../src/content/scanner";
import { createTranslationShortcutHandler } from "../../src/content/translationShortcut";
import { runSettingsConnectionTest } from "../../src/shared/settingsForm";

describe("runtime state-machine contracts: content and UI", () => {
  let originalPart: PropertyDescriptor | undefined;

  beforeEach(() => {
    document.body.innerHTML = "";
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    originalPart = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "part");
    if (!originalPart) {
      Object.defineProperty(HTMLElement.prototype, "part", {
        configurable: true,
        get(this: HTMLElement) {
          return { add: (...tokens: string[]) => this.setAttribute("part", tokens.join(" ")) };
        }
      });
    }
  });

  afterEach(() => {
    document.body.innerHTML = "";
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    if (!originalPart) {
      Reflect.deleteProperty(HTMLElement.prototype, "part");
    }
  });

  it("keeps card feedback visible when a hidden gloss outcome arrives", () => {
    document.body.innerHTML = "<main><p>A novel archive appears.</p></main>";
    const textNode = document.querySelector("p")!.firstChild as Text;
    const token = tokenFromText(textNode, "novel", 1);
    const restoreRects = stubRenderableRects();
    const overlay = createGlossOverlay(document);

    try {
      expect(overlay.applyTokenOutcome(token, {
        scanId: "scan-1",
        tokenId: token.id,
        status: "ready",
        item: { tokenId: token.id, targetText: "novel", display: "新颖" }
      }, 1).result).toBe("rendered");
      overlay.applyCardFeedback({ tokenId: token.id, feedback: "card-pending" });
      const rendered = document.querySelector<HTMLElement>(`[data-glossa-token="${token.id}"]`)!;

      overlay.applyTokenOutcome(undefined, {
        scanId: "scan-1",
        tokenId: token.id,
        status: "hidden"
      }, 1);

      expect(rendered.isConnected).toBe(true);
      expect(rendered.dataset.glossaFeedback).toBe("card-pending");
    } finally {
      restoreRects();
    }
  });

  it("toggles translation once for the first keydown and consumes repeats without toggling", () => {
    const toggle = vi.fn();
    const handler = createTranslationShortcutHandler({ shortcut: () => "Alt+G", toggle });
    document.addEventListener("keydown", handler, true);

    try {
      document.dispatchEvent(shortcutKeydown("g", { altKey: true }));
      document.dispatchEvent(shortcutKeydown("g", { altKey: true, repeat: true }));

      expect(toggle).toHaveBeenCalledTimes(1);
    } finally {
      document.removeEventListener("keydown", handler, true);
    }
  });

  it("gives translation priority when legacy settings contain conflicting shortcuts", () => {
    const toggle = vi.fn();
    const selectionChanges: boolean[] = [];
    const translation = createTranslationShortcutHandler({ shortcut: () => "Alt+G", toggle });
    const selection = createSelectionController({
      document,
      shortcutKey: "Alt+G",
      onWordSelected: vi.fn(),
      onSelectionModeChange: (active) => selectionChanges.push(active)
    });
    document.addEventListener("keydown", translation, true);
    selection.attach();

    try {
      document.dispatchEvent(shortcutKeydown("g", { altKey: true }));

      expect(toggle).toHaveBeenCalledTimes(1);
      expect(document.documentElement.dataset.glossaSelecting).toBeUndefined();
      expect(selectionChanges).toEqual([]);
    } finally {
      selection.detach();
      document.removeEventListener("keydown", translation, true);
    }
  });

  it("leaves a non-translation chord untouched after exiting selection hold", () => {
    const pageKeydown = vi.fn();
    const selection = createSelectionController({
      document,
      shortcutKey: "Alt",
      onWordSelected: vi.fn()
    });
    selection.attach();
    document.addEventListener("keydown", pageKeydown);
    document.dispatchEvent(shortcutKeydown("Alt", { altKey: true }));

    const tab = shortcutKeydown("Tab", { altKey: true });
    document.dispatchEvent(tab);

    expect(tab.defaultPrevented).toBe(false);
    expect(pageKeydown).toHaveBeenCalledWith(tab);
    expect(document.documentElement.dataset.glossaSelecting).toBeUndefined();
    document.removeEventListener("keydown", pageKeydown);
    selection.detach();
  });

  it("does not let a stale connection result overwrite the latest UI task", async () => {
    const button = document.createElement("button");
    const first = deferred<void>();
    const second = deferred<void>();
    const statuses: Array<{ value: string; state: string }> = [];
    let currentOperation = 1;
    const firstRun = runSettingsConnectionTest(
      button,
      () => first.promise,
      "ai",
      (value, state) => statuses.push({ value, state }),
      "first",
      () => currentOperation === 1
    );
    currentOperation = 2;
    const secondRun = runSettingsConnectionTest(
      button,
      () => second.promise,
      "ai",
      (value, state) => statuses.push({ value, state }),
      "second",
      () => currentOperation === 2
    );

    second.resolve();
    await secondRun;
    first.resolve();
    await firstRun;

    expect(statuses.filter(({ state }) => state === "success")).toEqual([{ value: "second", state: "success" }]);
    expect(button.dataset.state).toBe("success");
  });

  it("asks frame zero to toggle its live state instead of deriving a desired state from popup cache", async () => {
    document.body.innerHTML = bodyFromHtml(readFileSync(resolve("src/popup/popup.html"), "utf8"));
    const sent: Array<{ tabId: number; message: unknown; options?: unknown }> = [];
    const chromeMock = {
      runtime: { openOptionsPage: vi.fn(), lastError: undefined },
      storage: {
        local: {
          get(_key: string, callback: (value: Record<string, unknown>) => void) {
            callback({});
          }
        }
      },
      tabs: {
        query: vi.fn(async () => [{ id: 11 }]),
        sendMessage: vi.fn(async (tabId: number, message: unknown, options?: unknown) => {
          sent.push({ tabId, message, ...(options === undefined ? {} : { options }) });
          return (message as { type?: string }).type === "glossa.getTranslationState"
            ? { ok: true, enabled: false }
            : { ok: true, enabled: true };
        })
      }
    };
    vi.stubGlobal("chrome", chromeMock as unknown as typeof chrome);
    vi.spyOn(window, "close").mockImplementation(() => undefined);
    vi.resetModules();
    await import("../../src/popup/popup");
    await vi.waitFor(() => expect(document.querySelector<HTMLButtonElement>("#translate-page")?.disabled).toBe(false));

    document.querySelector<HTMLButtonElement>("#translate-page")!.click();
    await vi.waitFor(() => expect(sent).toHaveLength(2));

    expect(sent[1]).toEqual({
      tabId: 11,
      message: { type: "glossa.toggleTranslationState" },
      options: { frameId: 0 }
    });
  });
});

function shortcutKeydown(key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  return new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
}

function tokenFromText(textNode: Text, surface: string, scanVersion: number): ScannedToken {
  const text = textNode.nodeValue ?? "";
  const nodeStartOffset = text.indexOf(surface);
  const nodeEndOffset = nodeStartOffset + surface.length;
  return {
    id: "token-1",
    sentenceId: "sentence-1",
    surface,
    lemma: surface.toLocaleLowerCase("en-US"),
    startOffset: nodeStartOffset,
    endOffset: nodeEndOffset,
    textNode,
    nodeStartOffset,
    nodeEndOffset,
    sentenceText: text,
    sourceText: surface,
    sourceFingerprint: createSourceFingerprint(text, nodeStartOffset, nodeEndOffset),
    scanVersion
  };
}

function stubRenderableRects(): () => void {
  const prototype = Range.prototype as unknown as { getClientRects: () => DOMRectList };
  const original = prototype.getClientRects;
  const rect = { left: 10, top: 20, right: 40, bottom: 32, width: 30, height: 12, x: 10, y: 20, toJSON: vi.fn() };
  prototype.getClientRects = () => [rect] as unknown as DOMRectList;
  return () => {
    prototype.getClientRects = original;
  };
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T | PromiseLike<T>): void } {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

function bodyFromHtml(html: string): string {
  return /<body[^>]*>([\s\S]*?)<\/body>/i.exec(html)?.[1] ?? html;
}
