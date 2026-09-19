import { describe, expect, it } from "vitest";

import { glossOutputSettingsChanged, mergeStoredSettings, settingsOverrides, normalizeSettings, validateSettingsPatch, applySettingsPatch, diffSettings } from "../../src/shared/settings";
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
      { ...current, ai: { ...current.ai, reasoningEffort: "high" as const } },
      { ...current, ai: { ...current.ai, apiKey: "new-secret" } }
    ];

    expect(outputChanges.every((next) => glossOutputSettingsChanged(current, next))).toBe(true);
    expect(glossOutputSettingsChanged(current, {
      ...current,
      appearance: { ...current.appearance, fontSize: current.appearance.fontSize + 1 },
      ai: { ...current.ai, requestTimeoutMs: current.ai.requestTimeoutMs + 1 }
    })).toBe(false);
  });
});

describe("settings field rules", () => {
  it("repairs malformed stored leaves without preserving unknown legacy fields", () => {
    const result = normalizeSettings({ ai: { provider: "bad", endpoint: "file:///secret", requestTimeoutMs: Infinity }, appearance: { fontSize: 900 }, learningWindowDays: -2, autoTranslateEnabled: "yes", legacy: true });
    expect(result).toEqual(DEFAULT_SETTINGS);
  });

  it("rejects invalid patches rather than silently changing their intent", () => {
    for (const patch of [{unknown:1},{ai:null},{ai:{requestTimeoutMs:999}},{anki:{endpoint:"file:///tmp"}},{learningWindowDays:NaN},{appearance:{fontSize:25}},{prompts:{gloss:""}},{knownWordList:"unsupported"},{ai:{apiKey:42}}]) {
      expect(() => validateSettingsPatch(patch)).toThrow();
    }
    expect(validateSettingsPatch({ai:{apiKey:null},learningWindowDays:1.5})).toEqual({ai:{apiKey:null},learningWindowDays:1.5});
  });

  it("merges disjoint leaf patches and explicitly deletes a key", () => {
    const base = normalizeSettings({ai:{apiKey:"secret"}});
    const first = applySettingsPatch(base,{appearance:{fontSize:14},anki:{deck:"Study"}});
    const second = applySettingsPatch(first,{appearance:{textColor:"#123456"},ai:{apiKey:null}});
    expect(second.appearance).toMatchObject({fontSize:14,textColor:"#123456"});
    expect(second.anki.deck).toBe("Study");
    expect(second.ai.apiKey).toBeUndefined();
    expect(diffSettings(base,second)).toEqual({appearance:{fontSize:14,textColor:"#123456"},anki:{deck:"Study"},ai:{apiKey:null}});
  });

  it("switches provider defaults while retaining a custom endpoint", () => {
    expect(applySettingsPatch(DEFAULT_SETTINGS,{ai:{provider:"openai-completions"}}).ai.endpoint).toBe("https://api.openai.com/v1/completions");
    const custom=normalizeSettings({ai:{endpoint:"https://custom.test/api"}});
    expect(applySettingsPatch(custom,{ai:{provider:"openai-completions"}}).ai.endpoint).toBe(custom.ai.endpoint);
    expect(normalizeSettings(settingsOverrides(applySettingsPatch(DEFAULT_SETTINGS,{ai:{provider:"openai-completions"}})))).toEqual(applySettingsPatch(DEFAULT_SETTINGS,{ai:{provider:"openai-completions"}}));
  });
});


describe("dictionary and Jev settings", () => {
  it("repairs missing mode settings and invalid Jev leaves", () => {
    expect(normalizeSettings({ jev: { endpoint: "file:///tmp", model: "", requestTimeoutMs: 1 }, translation: { mode: "unsupported", fallbackToLlm: "yes" } })).toEqual(DEFAULT_SETTINGS);
    expect(() => validateSettingsPatch({ translation: { mode: "unsupported" } })).toThrow("translation.mode");
    expect(() => validateSettingsPatch({ jev: { apiKey: 42 } })).toThrow("jev.apiKey");
  });

  it("merges Jev and translation leaves without overwriting a newer service configuration", () => {
    const base = normalizeSettings({ jev: { apiKey: "test-key", model: "custom-jev" }, ai: { apiKey: "ordinary-key" } });
    const latest = applySettingsPatch(base, { jev: { endpoint: "https://example.test/jev" }, translation: { fallbackToLlm: true } });
    const updated = applySettingsPatch(latest, { jev: { apiKey: null }, translation: { mode: "dictionary-jev" } });
    expect(updated.jev).toEqual({ endpoint: "https://example.test/jev", model: "custom-jev", requestTimeoutMs: 30_000 });
    expect(updated.translation).toEqual({ mode: "dictionary-jev", fallbackToLlm: true });
    expect(updated.ai.apiKey).toBe("ordinary-key");
    expect(diffSettings(latest, updated)).toEqual({ jev: { apiKey: null }, translation: { mode: "dictionary-jev" } });
    expect(normalizeSettings(settingsOverrides(updated))).toEqual(updated);
  });
});
