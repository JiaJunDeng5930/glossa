import { buildGlossCacheKey } from "../core/cache";
import { hashText } from "../shared/hash";
import {
  createCandidateRecord,
  markRecordShown,
  transitionExpiredLearning,
  vocabularyKey
} from "../core/state";
import type { ExtensionStorage } from "../storage/db";
import type { AiBackend } from "./ai";
import type { GlossaSettings, GlossItem, SentenceCandidate, TokenCandidate, VocabularyRecord } from "../shared/types";
import { GLOSS_TARGET_LANG } from "../shared/types";

export interface GlossResolver {
  resolve(pageUrl: string, sentences: SentenceCandidate[], settings: GlossaSettings, now: number): Promise<{ items: GlossItem[] }>;
}

export interface GlossResolverDeps {
  storage: ExtensionStorage;
  ai: AiBackend;
  maxMemoryEntries?: number;
}

interface Miss {
  token: TokenCandidate;
  memoryKey: string;
  dbCacheKey: string;
}

const DEFAULT_MAX_MEMORY_ENTRIES = 512;

export function createGlossResolver(deps: GlossResolverDeps): GlossResolver {
  const memoryCache = new Map<string, GlossItem>();
  const maxMemoryEntries = deps.maxMemoryEntries ?? DEFAULT_MAX_MEMORY_ENTRIES;

  const remember = (key: string, item: GlossItem) => {
    memoryCache.delete(key);
    memoryCache.set(key, item);
    while (memoryCache.size > maxMemoryEntries) {
      const oldest = memoryCache.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      memoryCache.delete(oldest);
    }
  };

  const recall = (key: string): GlossItem | undefined => {
    const item = memoryCache.get(key);
    if (!item) {
      return undefined;
    }
    remember(key, item);
    return item;
  };

  return {
    async resolve(pageUrl, sentences, settings, now) {
      const items: GlossItem[] = [];

      for (const sentence of sentences) {
        const misses: Miss[] = [];
        const promptVersion = await promptCacheVersion(settings, settings.prompts.gloss);
        for (const token of sentence.tokens) {
          const cacheKey = await glossCacheKey(settings, promptVersion, sentence, token);
          const memoryKey = transientMemoryKey(pageUrl, cacheKey);
          const memoryCached = recall(memoryKey);
          if (memoryCached) {
            items.push(rehydrateCachedGloss(memoryCached, token));
            continue;
          }

          const record = await currentRecord(deps.storage, token, now);
          if (record?.state === "known" || record?.state === "ignored") {
            continue;
          }

          const cached = await deps.storage.glossCache.get(cacheKey);
          if (cached) {
            remember(memoryKey, cached);
            items.push(rehydrateCachedGloss(cached, token));
            await persistShownRecord(deps.storage, token, now);
          } else {
            misses.push({ token, memoryKey, dbCacheKey: cacheKey });
          }
        }

        if (misses.length > 0) {
          const response = await deps.ai.gloss({
            settings,
            sentence: sentence.text,
            tokens: misses.map((miss) => miss.token)
          });
          for (const item of response.items) {
            const miss = misses.find((candidate) => candidate.token.id === item.tokenId);
            if (!miss) {
              continue;
            }
            await deps.storage.glossCache.put(miss.dbCacheKey, item);
            remember(miss.memoryKey, item);
            await persistShownRecord(deps.storage, miss.token, now);
            items.push(item);
          }
        }
      }

      return { items };
    }
  };
}

async function glossCacheKey(
  settings: GlossaSettings,
  promptVersion: string,
  sentence: SentenceCandidate,
  token: TokenCandidate
): Promise<string> {
  return buildGlossCacheKey({
    targetLang: GLOSS_TARGET_LANG,
    sentence: sentence.text,
    targetText: token.surface,
    targetSpan: [token.startOffset, token.endOffset],
    promptVersion,
    modelVersion: settings.modelVersion
  });
}

async function promptCacheVersion(settings: GlossaSettings, prompt: string): Promise<string> {
  return [
    settings.promptVersion,
    settings.ai.provider,
    settings.ai.reasoningEffort,
    await hashText(prompt)
  ].join(":");
}

async function currentRecord(storage: ExtensionStorage, token: TokenCandidate, now: number): Promise<VocabularyRecord | undefined> {
  const key = vocabularyKey("en", token.lemma);
  const record = await storage.lexicon.get(key);
  if (!record) {
    return undefined;
  }
  const current = transitionExpiredLearning(record, now);
  if (current !== record) {
    await storage.lexicon.put(current);
  }
  return current;
}

async function persistShownRecord(storage: ExtensionStorage, token: TokenCandidate, now: number): Promise<void> {
  const existing = await storage.lexicon.get(vocabularyKey("en", token.lemma));
  const record = existing ?? createCandidateRecord(token.lemma, token.surface, "en", now);
  const shown = markRecordShown(record, now);
  await storage.lexicon.put(shown);
}

function rehydrateCachedGloss(item: GlossItem, token: TokenCandidate): GlossItem {
  return { ...item, tokenId: token.id, targetText: token.surface };
}

function transientMemoryKey(pageUrl: string, cacheKey: string): string {
  return `${pageUrl}\n${cacheKey}`;
}
