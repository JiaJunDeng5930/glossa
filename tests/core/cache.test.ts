import { describe, expect, it } from "vitest";

import { buildCardCacheKey, buildGlossCacheKey, glossGenerationIdentity } from "../../src/core/cache";
import { dictionaryIdentity } from "../../src/shared/services/dictionary";
import { DEFAULT_SETTINGS } from "../../src/shared/types";

describe("cache keys", () => {
  it("separates dictionary selection from ordinary LLM results and includes the dictionary revision", () => {
    const settings = { ...DEFAULT_SETTINGS, translation: { mode: "dictionary-jev" as const, fallbackToLlm: false } };
    expect(glossGenerationIdentity(settings)).not.toBe(glossGenerationIdentity(DEFAULT_SETTINGS));
    expect(JSON.parse(glossGenerationIdentity(settings))).toContain(dictionaryIdentity.id);
    expect(JSON.parse(glossGenerationIdentity(settings))).toContain(dictionaryIdentity.version);
    for (const jev of [
      { ...settings.jev, endpoint: "https://other.jev.test/classify" },
      { ...settings.jev, apiKey: "new-key" },
      { ...settings.jev, model: "new-classifier" }
    ]) {
      expect(glossGenerationIdentity({ ...settings, jev })).not.toBe(glossGenerationIdentity(settings));
    }
  });

  it("ignores inactive LLM settings in dictionary mode and includes them when fallback is enabled", () => {
    const settings = { ...DEFAULT_SETTINGS, translation: { mode: "dictionary-jev" as const, fallbackToLlm: false } };
    const changed = { ...settings, ai: { ...settings.ai, endpoint: "https://other-llm.test" }, modelVersion: "other-llm" };
    expect(glossGenerationIdentity(changed)).toBe(glossGenerationIdentity(settings));
    const fallback = { ...settings, translation: { ...settings.translation, fallbackToLlm: true } };
    expect(glossGenerationIdentity(fallback)).not.toBe(glossGenerationIdentity(settings));
    expect(glossGenerationIdentity({ ...changed, translation: fallback.translation })).not.toBe(glossGenerationIdentity(fallback));
  });

  it("reuses completed dictionary results when only request timeouts change", () => {
    const settings = { ...DEFAULT_SETTINGS, translation: { mode: "dictionary-jev" as const, fallbackToLlm: true } };
    expect(glossGenerationIdentity({
      ...settings,
      jev: { ...settings.jev, requestTimeoutMs: 1234 },
      ai: { ...settings.ai, requestTimeoutMs: 5678 }
    })).toBe(glossGenerationIdentity(settings));
  });

  it("separates gloss results across generation settings", async () => {
    const input = {
      targetLang: "zh-CN",
      sentence: "Click the submit button to finish.",
      targetText: "submit",
      targetSpan: [10, 16] as const,
      settings: {
        ...DEFAULT_SETTINGS,
        ai: {
          ...DEFAULT_SETTINGS.ai,
          provider: "openai-responses" as const,
          endpoint: "https://api.openai.com/v1/responses",
          apiKey: "sk-test",
          reasoningEffort: "medium" as const
        },
        promptVersion: "gloss-v1",
        modelVersion: "gpt-4.1-mini",
        prompts: { ...DEFAULT_SETTINGS.prompts, gloss: "Translate the current word." }
      }
    };

    await expect(buildGlossCacheKey(input)).resolves.toBe(await buildGlossCacheKey(input));
    const changedGenerationSettings = {
      ...input,
      settings: {
        ...input.settings,
        ai: { ...input.settings.ai, reasoningEffort: "high" as const },
        promptVersion: "gloss-v2",
        modelVersion: "gpt-5.1",
        prompts: { ...input.settings.prompts, gloss: "Use the revised prompt." }
      }
    };
    await expect(buildGlossCacheKey(changedGenerationSettings)).resolves.not.toBe(await buildGlossCacheKey(input));
    await expect(buildGlossCacheKey({ ...input, targetSpan: [10, 15] })).resolves.not.toBe(await buildGlossCacheKey(input));
  });

  it("separates card content for the same lemma in different sentence contexts", async () => {
    const riverContext = {
      lang: "en",
      lemma: "bank",
      targetLang: "zh-CN",
      promptVersion: "anki-v1",
      sentence: "They rested on the river bank."
    };
    const financeContext = {
      ...riverContext,
      sentence: "The bank approved the loan."
    };

    await expect(buildCardCacheKey(riverContext)).resolves.not.toBe(await buildCardCacheKey(financeContext));
    await expect(buildCardCacheKey(riverContext)).resolves.toBe(await buildCardCacheKey(riverContext));
  });
});
