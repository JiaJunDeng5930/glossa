// @constraint glossa.cache_identity Repeated translation and card requests use stable cache identity for equivalent inputs.
// @constraint glossa.cache_identity.request_parts Gloss cache identity uses language, sentence text, and token position while card cache identity also uses the card prompt version.
import { hashText } from "../shared/hash";

// @constraint glossa.cache_identity.request_parts.gloss_key_fields Gloss cache key input exposes target language, sentence text, token text, and token span.
export interface GlossCacheKeyInput {
  targetLang: string;
  sentence: string;
  targetText: string;
  targetSpan: readonly [number, number];
}

export async function buildGlossCacheKey(input: GlossCacheKeyInput): Promise<string> {
  const sentenceHash = await hashText(input.sentence);
  return [
    "gloss",
    input.targetLang,
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
