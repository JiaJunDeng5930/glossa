import { describe, expect, it } from "vitest";

import { mergeStoredSettings, settingsOverrides } from "../../src/shared/settings";
import { DEFAULT_SETTINGS } from "../../src/shared/types";

// @verifies glossa.settings_save.default_overrides.merge
// @verifies glossa.settings_save.default_overrides.write_filter
describe("settings default overrides", () => {
  it("merges stored overrides with current defaults", () => {
    const merged = mergeStoredSettings({ anki: { deck: "Research" } });

    expect(merged.anki.deck).toBe("Research");
    expect(merged.prompts.gloss).toBe(DEFAULT_SETTINGS.prompts.gloss);
  });

  it("returns only settings that differ from defaults", () => {
    const settings = mergeStoredSettings({ anki: { deck: "Research" } });
    expect(settings.anki.deck).toBe("Research");
    expect(settingsOverrides(settings)).toEqual({ anki: { deck: "Research" } });
  });
});
