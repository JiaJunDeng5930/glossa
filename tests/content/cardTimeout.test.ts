import { describe, expect, it } from "vitest";

import { wordClickTimeoutMs } from "../../src/content/cardTimeout";
import { DEFAULT_SETTINGS } from "../../src/shared/types";

// @verifies glossa.card_creation.note_request.content_timeout
describe("card creation content timeout", () => {
  // @verifies glossa.card_creation.note_request.content_timeout.budget
  it("covers the configured AI retry budget and concurrent Anki write budget", () => {
    expect(wordClickTimeoutMs({
      ...DEFAULT_SETTINGS,
      ai: { ...DEFAULT_SETTINGS.ai, requestTimeoutMs: 45_000 },
      anki: { ...DEFAULT_SETTINGS.anki, requestTimeoutMs: 35_000 }
    })).toBe(130_000);
  });

  it("keeps the existing fallback envelope for tiny or unavailable settings", () => {
    expect(wordClickTimeoutMs(undefined)).toBe(60_000);
    expect(wordClickTimeoutMs({
      ...DEFAULT_SETTINGS,
      ai: { ...DEFAULT_SETTINGS.ai, requestTimeoutMs: 1_000 },
      anki: { ...DEFAULT_SETTINGS.anki, requestTimeoutMs: 1_000 }
    })).toBe(60_000);
  });

  it("uses default request budgets when older settings omit timeout sections", () => {
    expect(wordClickTimeoutMs({ shortcutKey: "Alt" })).toBe(95_000);
  });
});
