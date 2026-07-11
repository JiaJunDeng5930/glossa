import { describe, expect, it } from "vitest";

import { cardOperationTimeoutMs } from "../../src/shared/cardTimeout";
import { DEFAULT_SETTINGS } from "../../src/shared/types";

describe("card creation content timeout", () => {
  it("covers the configured AI retry budget and concurrent Anki write budget", () => {
    expect(cardOperationTimeoutMs({
      ...DEFAULT_SETTINGS,
      ai: { ...DEFAULT_SETTINGS.ai, requestTimeoutMs: 45_000 },
      anki: { ...DEFAULT_SETTINGS.anki, requestTimeoutMs: 35_000 }
    })).toBe(130_000);
  });

  it("keeps the existing fallback envelope for tiny or unavailable settings", () => {
    expect(cardOperationTimeoutMs(undefined)).toBe(60_000);
    expect(cardOperationTimeoutMs({
      ...DEFAULT_SETTINGS,
      ai: { ...DEFAULT_SETTINGS.ai, requestTimeoutMs: 1_000 },
      anki: { ...DEFAULT_SETTINGS.anki, requestTimeoutMs: 1_000 }
    })).toBe(60_000);
  });

  it("uses default request budgets when older settings omit timeout sections", () => {
    expect(cardOperationTimeoutMs({ shortcutKey: "Alt" })).toBe(95_000);
  });
});
