import { describe, expect, it } from "vitest";

import { formatShortcutFromEvent, matchesShortcut } from "../../src/shared/shortcut";

// @verifies glossa.shared.shortcut The test verifies shortcut formatting and matching for modifier-only and mixed keyboard events.
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
});
