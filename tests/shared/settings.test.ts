import { afterEach, describe, expect, it, vi } from "vitest";

import { mergeStoredSettings, settingsOverrides } from "../../src/shared/settings";
import { DEFAULT_SETTINGS, type GlossaSettings } from "../../src/shared/types";
import { createExtensionStorage } from "../../src/storage/db";

afterEach(() => {
  vi.unstubAllGlobals();
});

// @verifies glossa.settings_save.default_overrides.merge
// @verifies glossa.settings_save.default_overrides.legacy_full
// @verifies glossa.settings_save.default_overrides.legacy_full.persist
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

  it("persists normalized legacy full settings snapshots after reading", async () => {
    const stored: { settings: unknown } = {
      settings: {
        ...DEFAULT_SETTINGS,
        prompts: { ...DEFAULT_SETTINGS.prompts },
        appearance: { ...DEFAULT_SETTINGS.appearance },
        ai: { ...DEFAULT_SETTINGS.ai },
        anki: { ...DEFAULT_SETTINGS.anki, deck: "Research" }
      }
    };
    vi.stubGlobal("chrome", {
      runtime: { lastError: undefined },
      storage: {
        local: {
          get(key: string, callback: (result: Record<string, unknown>) => void) {
            callback({ [key]: stored[key as keyof typeof stored] });
          },
          set(value: Record<string, unknown>, callback?: () => void) {
            Object.assign(stored, value);
            callback?.();
          }
        }
      }
    });
    const storage = createExtensionStorage();

    const settings = await storage.settings.get();

    expect(settings.anki.deck).toBe("Research");
    expect(stored.settings).toEqual({ anki: { deck: "Research" } });
  });
});
