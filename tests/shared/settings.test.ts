import { describe, expect, it } from "vitest";

import { mergeStoredSettings, settingsOverrides } from "../../src/shared/settings";
import { DEFAULT_SETTINGS, type GlossaSettings } from "../../src/shared/types";

// @verifies glossa.settings_save.default_overrides.merge
// @verifies glossa.settings_save.default_overrides.legacy_full
// @verifies glossa.settings_save.default_overrides.write_filter
describe("settings default overrides", () => {
  it("normalizes legacy full settings snapshots into default overrides", () => {
    const legacyFullSettings: GlossaSettings = {
      ...DEFAULT_SETTINGS,
      prompts: { ...DEFAULT_SETTINGS.prompts },
      appearance: { ...DEFAULT_SETTINGS.appearance },
      ai: { ...DEFAULT_SETTINGS.ai },
      anki: { ...DEFAULT_SETTINGS.anki, deck: "Research" }
    };

    const merged = mergeStoredSettings(legacyFullSettings);

    expect(merged.anki.deck).toBe("Research");
    expect(settingsOverrides(merged)).toEqual({ anki: { deck: "Research" } });
  });
});
