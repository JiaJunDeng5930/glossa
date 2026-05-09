// @behavior glossa.core.cache The cache module builds stable gloss and card keys from model, prompt, language, text, and token identity.
import { hashText } from "../shared/hash";

export interface GlossCacheKeyInput {
  targetLang: string;
  sentence: string;
  targetText: string;
  targetSpan: readonly [number, number];
  promptVersion: string;
  modelVersion: string;
}

export async function buildGlossCacheKey(input: GlossCacheKeyInput): Promise<string> {
  const sentenceHash = await hashText(input.sentence);
  return [
    "gloss",
    input.targetLang,
    sentenceHash,
    input.targetText.toLocaleLowerCase("en-US"),
    `${input.targetSpan[0]}-${input.targetSpan[1]}`,
    input.promptVersion,
    input.modelVersion
  ].join(":");
}

export interface CardCacheKeyInput {
  lang: string;
  lemma: string;
  targetLang: string;
  promptVersion: string;
}

export async function buildCardCacheKey(input: CardCacheKeyInput): Promise<string> {
  return [
    "card",
    input.lang,
    input.targetLang,
    input.promptVersion,
    input.lemma.toLocaleLowerCase("en-US")
  ].join(":");
}
