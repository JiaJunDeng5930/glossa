import { describe, expect, it } from "vitest";

import { formatShortcutFromEvent, matchesShortcut, normalizeShortcut } from "../../src/shared/shortcut";

describe("shortcut formatting and matching", () => {
  it("captures a pure modifier shortcut", () => {
    const event = new KeyboardEvent("keydown", { key: "Alt", altKey: true });

    expect(formatShortcutFromEvent(event)).toBe("Alt");
    expect(matchesShortcut(event, "Alt")).toBe(true);
  });

  it("captures and matches modified character shortcuts", () => {
    const event = new KeyboardEvent("keydown", { key: "k", ctrlKey: true, shiftKey: true });

    expect(formatShortcutFromEvent(event)).toBe("Ctrl+Shift+K");
    expect(matchesShortcut(event, "Ctrl+Shift+K")).toBe(true);
    expect(matchesShortcut(event, "Ctrl+K")).toBe(false);
  });

  it("normalizes equivalent modifier orders for conflict detection", () => {
    expect(normalizeShortcut("Shift+Ctrl+G")).toBe("Ctrl+Shift+G");
    expect(normalizeShortcut("Ctrl+Shift+G")).toBe("Ctrl+Shift+G");
  });
});
