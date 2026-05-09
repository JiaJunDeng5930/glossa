import { describe, expect, it } from "vitest";

import { buildCardCacheKey, buildGlossCacheKey } from "../../src/core/cache";

// @verifies glossa.core.cache The test verifies that cache keys include language, token, prompt, model, and card content identity.
describe("cache keys", () => {
  it("builds stable gloss keys from target language, sentence, token span, prompt and model versions", async () => {
    const input = {
      targetLang: "zh-CN",
      sentence: "Click the submit button to finish.",
      targetText: "submit",
      targetSpan: [10, 16] as const,
      promptVersion: "gloss-v1",
      modelVersion: "gpt-4.1-mini"
    };

    await expect(buildGlossCacheKey(input)).resolves.toBe(await buildGlossCacheKey(input));
    await expect(buildGlossCacheKey({ ...input, targetSpan: [10, 15] })).resolves.not.toBe(await buildGlossCacheKey(input));
  });

  it("builds stable card keys from lemma, language and card prompt version", async () => {
    await expect(buildCardCacheKey({
      lang: "en",
      lemma: "submit",
      targetLang: "zh-CN",
      promptVersion: "anki-v1"
    })).resolves.toBe("card:en:zh-CN:anki-v1:submit");
  });
});
