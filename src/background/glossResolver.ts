import { buildGlossCacheKey } from "../core/cache";
import { diagnosticPayloadFrom } from "../shared/errors";
import { hashText } from "../shared/hash";
import {
  createCandidateRecord,
  markRecordShown,
  transitionExpiredLearning,
  vocabularyKey
} from "../core/state";
import type { ExtensionStorage } from "../storage/db";
import type { AiBackend } from "./ai";
import type { ErrorPayload, GlossaSettings, GlossItem, GlossTokenPayload, SentenceCandidate, TokenCandidate, VocabularyRecord } from "../shared/types";
import { GLOSS_TARGET_LANG } from "../shared/types";

export interface GlossResolver {
  resolve(pageUrl: string, sentences: SentenceCandidate[], settings: GlossaSettings, now: number, sink: GlossResolverSink): Promise<void>;
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
  inFlight: InFlightGloss;
}

interface ReusedMiss {
  token: TokenCandidate;
  inFlight: InFlightGloss;
}

type InFlightResult =
  | { ok: true; item: GlossItem }
  | { ok: false; error: ErrorPayload };

interface InFlightGloss {
  promise: Promise<InFlightResult>;
  resolve(result: InFlightResult): void;
}

export interface GlossResolverSink {
  emit(payload: Omit<GlossTokenPayload, "scanId">): void;
  isActive?(): boolean;
}

const DEFAULT_MAX_MEMORY_ENTRIES = 512;

export function createGlossResolver(deps: GlossResolverDeps): GlossResolver {
  const memoryCache = new Map<string, GlossItem>();
  const inFlight = new Map<string, InFlightGloss>();
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
    async resolve(pageUrl, sentences, settings, now, sink) {
      const promptVersion = await promptCacheVersion(settings, settings.prompts.gloss);
      for (const sentence of sentences) {
        const misses: Miss[] = [];
        const reusedMisses: ReusedMiss[] = [];
        for (const token of sentence.tokens) {
          if (sink.isActive?.() === false) {
            return;
          }
          const cacheKey = await glossCacheKey(settings, promptVersion, sentence, token);
          const memoryKey = transientMemoryKey(pageUrl, cacheKey);
          const memoryCached = recall(memoryKey);
          if (memoryCached) {
            const item = rehydrateCachedGloss(memoryCached, token);
            sink.emit({ tokenId: token.id, status: "ready", item });
            await persistShownRecord(deps.storage, token, now);
            continue;
          }

          const record = await currentRecord(deps.storage, token, now);
          if (record?.state === "known" || record?.state === "ignored") {
            sink.emit({ tokenId: token.id, status: "hidden" });
            continue;
          }

          const cached = await deps.storage.glossCache.get(cacheKey);
          if (cached) {
            const item = rehydrateCachedGloss(cached, token);
            remember(memoryKey, item);
            sink.emit({ tokenId: token.id, status: "ready", item });
            await persistShownRecord(deps.storage, token, now);
          } else {
            sink.emit({ tokenId: token.id, status: "pending" });
            const active = inFlight.get(cacheKey);
            if (active) {
              reusedMisses.push({ token, inFlight: active });
            } else {
              const pending = createInFlightGloss();
              inFlight.set(cacheKey, pending);
              misses.push({ token, memoryKey, dbCacheKey: cacheKey, inFlight: pending });
            }
          }
        }

        if (misses.length > 0) {
          let response: { items: GlossItem[] };
          try {
            response = await deps.ai.gloss({
              settings,
              sentence: sentence.text,
              tokens: misses.map((miss) => miss.token)
            });
          } catch (error) {
            const payload = diagnosticPayloadFrom(error, {
              reason: "service-error",
              message: "Gloss lookup failed",
              service: "ai"
            });
            for (const miss of misses) {
              resolveInFlightMiss(inFlight, miss, { ok: false, error: payload });
              if (sink.isActive?.() !== false) {
                sink.emit({ tokenId: miss.token.id, status: "error", message: payload.message, error: payload });
              }
            }
            await emitReusedMisses(deps.storage, reusedMisses, sink, now);
            continue;
          }
          const emitted = new Set<string>();
          for (const item of response.items) {
            const miss = misses.find((candidate) => candidate.token.id === item.tokenId);
            if (!miss) {
              continue;
            }
            await deps.storage.glossCache.put(miss.dbCacheKey, item);
            remember(miss.memoryKey, item);
            if (sink.isActive?.() !== false) {
              await persistShownRecord(deps.storage, miss.token, now);
              sink.emit({ tokenId: miss.token.id, status: "ready", item });
            }
            resolveInFlightMiss(inFlight, miss, { ok: true, item });
            emitted.add(miss.token.id);
          }
          for (const miss of misses) {
            if (!emitted.has(miss.token.id)) {
              const payload: ErrorPayload = {
                reason: "invalid-response",
                message: "Gloss lookup returned no item",
                service: "ai"
              };
              resolveInFlightMiss(inFlight, miss, { ok: false, error: payload });
              if (sink.isActive?.() !== false) {
                sink.emit({ tokenId: miss.token.id, status: "error", message: payload.message, error: payload });
              }
            }
          }
        }
        await emitReusedMisses(deps.storage, reusedMisses, sink, now);
      }
    }
  };
}

function createInFlightGloss(): InFlightGloss {
  let resolvePromise: (result: InFlightResult) => void = () => undefined;
  const promise = new Promise<InFlightResult>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: resolvePromise
  };
}

function resolveInFlightMiss(inFlight: Map<string, InFlightGloss>, miss: Miss, result: InFlightResult): void {
  if (inFlight.get(miss.dbCacheKey) === miss.inFlight) {
    inFlight.delete(miss.dbCacheKey);
  }
  miss.inFlight.resolve(result);
}

async function emitReusedMisses(
  storage: ExtensionStorage,
  reusedMisses: ReusedMiss[],
  sink: GlossResolverSink,
  now: number
): Promise<void> {
  for (const miss of reusedMisses) {
    if (sink.isActive?.() === false) {
      return;
    }
    const result = await miss.inFlight.promise;
    if (sink.isActive?.() === false) {
      return;
    }
    if (result.ok) {
      const item = rehydrateCachedGloss(result.item, miss.token);
      sink.emit({ tokenId: miss.token.id, status: "ready", item });
      await persistShownRecord(storage, miss.token, now);
    } else {
      sink.emit({ tokenId: miss.token.id, status: "error", message: result.error.message, error: result.error });
    }
  }
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
