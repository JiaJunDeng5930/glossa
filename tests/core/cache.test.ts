import { describe, expect, it } from "vitest";

import { buildCardCacheKey, buildGlossCacheKey } from "../../src/core/cache";
import { DEFAULT_SETTINGS } from "../../src/shared/types";

describe("cache keys", () => {
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
