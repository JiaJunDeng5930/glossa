import { hashText } from "../shared/hash";
import type { GlossaSettings } from "../shared/types";

export interface GlossCacheKeyInput {
  targetLang: string;
  sentence: string;
  targetText: string;
  targetSpan: readonly [number, number];
  settings: GlossaSettings;
}

export async function buildGlossCacheKey(input: GlossCacheKeyInput): Promise<string> {
  const [sentenceHash, generationHash] = await Promise.all([
    hashText(input.sentence),
    hashText(glossGenerationIdentity(input.settings))
  ]);
  return [
    "gloss",
    input.targetLang,
    generationHash,
    sentenceHash,
    input.targetText.toLocaleLowerCase("en-US"),
    `${input.targetSpan[0]}-${input.targetSpan[1]}`
  ].join(":");
}

export interface CardCacheKeyInput {
  lang: string;
  lemma: string;
  targetLang: string;
  promptVersion: string;
  sentence: string;
}

export async function buildCardCacheKey(input: CardCacheKeyInput): Promise<string> {
  // Card content is reusable within one sentence context; word-level duplicate history is tracked separately.
  const sentenceHash = await hashText(input.sentence);
  return [
    "card",
    input.lang,
    input.targetLang,
    input.promptVersion,
    input.lemma.toLocaleLowerCase("en-US"),
    sentenceHash
  ].join(":");
}

export function glossGenerationIdentity(settings: GlossaSettings): string {
  return [
    settings.ai.provider,
    settings.ai.endpoint,
    settings.ai.reasoningEffort,
    settings.ai.apiKey ?? "",
    settings.promptVersion,
    settings.modelVersion,
    settings.prompts.gloss
  ].join("\n");
}

export function glossScanConfigHash(settings: GlossaSettings): string {
  const value = [
    settings.knownWordList,
    String(settings.glossCacheTtlMs),
    glossGenerationIdentity(settings)
  ].join("\n");
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
