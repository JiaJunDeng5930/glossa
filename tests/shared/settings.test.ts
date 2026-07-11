import { describe, expect, it } from "vitest";

import { glossOutputSettingsChanged, mergeStoredSettings, settingsOverrides } from "../../src/shared/settings";
import { DEFAULT_SETTINGS } from "../../src/shared/types";

describe("settings default overrides", () => {
  it("merges stored overrides with current defaults", () => {
    const merged = mergeStoredSettings({ anki: { deck: "Research" }, glossCacheTtlMs: 48 * 60 * 60 * 1_000 });

    expect(merged.anki.deck).toBe("Research");
    expect(merged.glossCacheTtlMs).toBe(48 * 60 * 60 * 1_000);
    expect(merged.prompts.gloss).toBe(DEFAULT_SETTINGS.prompts.gloss);
  });

  it("returns only settings that differ from defaults", () => {
    const settings = mergeStoredSettings({ anki: { deck: "Research" } });
    expect(settings.anki.deck).toBe("Research");
    expect(settingsOverrides(settings)).toEqual({ anki: { deck: "Research" } });
  });

  it("identifies settings changes that can alter generated glosses", () => {
    const current = mergeStoredSettings(undefined);
    const outputChanges = [
      { ...current, promptVersion: "gloss-v2" },
      { ...current, modelVersion: "gpt-new" },
      { ...current, prompts: { ...current.prompts, gloss: "A different gloss prompt" } },
      { ...current, ai: { ...current.ai, provider: "openai-chat-completions" as const } },
      { ...current, ai: { ...current.ai, endpoint: "https://example.test/v1" } },
      { ...current, ai: { ...current.ai, reasoningEffort: "high" as const } }
    ];

    expect(outputChanges.every((next) => glossOutputSettingsChanged(current, next))).toBe(true);
    expect(glossOutputSettingsChanged(current, {
      ...current,
      appearance: { ...current.appearance, fontSize: current.appearance.fontSize + 1 },
      ai: { ...current.ai, apiKey: "new-secret", requestTimeoutMs: current.ai.requestTimeoutMs + 1 }
    })).toBe(false);
  });
});
