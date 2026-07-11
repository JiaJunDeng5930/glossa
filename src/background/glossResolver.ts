import pLimit from "p-limit";

import { buildGlossCacheKey } from "../core/cache";
import { diagnosticPayloadFrom } from "../shared/errors";
import { trace } from "../shared/diagnostics";
import {
  createCandidateRecord,
  markRecordShown,
  transitionExpiredLearning,
  vocabularyKey
} from "../core/state";
import type { ExtensionStorage } from "../storage/db";
import type { AiBackend } from "./ai";
import type { ErrorPayload, GlossaSettings, GlossCacheEntry, GlossItem, GlossTokenPayload, SentenceCandidate, TokenCandidate, VocabularyRecord } from "../shared/types";
import { GLOSS_TARGET_LANG } from "../shared/types";

export interface GlossResolver {
  createSession(pageUrl: string, settings: GlossaSettings, now: number, sink: GlossResolverSink): GlossResolverSession;
  clearMemory(): void;
}

export interface GlossResolverSession {
  acceptChunk(chunkId: string, chunkIndex: number, sentences: SentenceCandidate[]): Promise<void>;
  finish(): Promise<void>;
}

export interface GlossResolverDeps {
  storage: ExtensionStorage;
  ai: AiBackend;
  maxMemoryEntries?: number;
  lookupConcurrency?: number;
  dbReadCoalesceMs?: number;
  aiFrameMaxItems?: number;
  aiFrameMaxMs?: number;
}

export interface GlossResolverSink {
  emit(payload: Omit<GlossTokenPayload, "scanId">): void;
  isActive?(): boolean;
}

interface Miss {
  token: TokenCandidate;
  sentence: string;
  memoryKey: string;
  dbCacheKey: string;
  inFlightKey: string;
  inFlight: InFlightGloss;
  settings: GlossaSettings;
  now: number;
  sink: GlossResolverSink;
  emit(payload: Omit<GlossTokenPayload, "scanId">): void;
  trackWrite(task: () => Promise<void>): void;
}

interface ReusedMiss {
  token: TokenCandidate;
  inFlight: InFlightGloss;
  now: number;
  sink: GlossResolverSink;
  emit(payload: Omit<GlossTokenPayload, "scanId">): void;
  trackWrite(task: () => Promise<void>): void;
}

type InFlightResult =
  | { ok: true; item: GlossItem }
  | { ok: false; error: ErrorPayload };

interface InFlightGloss {
  promise: Promise<InFlightResult>;
  resolve(result: InFlightResult): void;
}

interface ResolverStats {
  chunks: number;
  tokens: number;
  hidden: number;
  ready: number;
  pending: number;
  error: number;
}

interface ReadCoalescer<T> {
  get(key: string): Promise<T | undefined>;
}

interface PendingRead<T> {
  resolve(value: T | undefined): void;
  reject(error: unknown): void;
}

interface AiFrame {
  key: string;
  settings: GlossaSettings;
  misses: Miss[];
  createdAt: number;
  timer: ReturnType<typeof globalThis.setTimeout>;
}

const DEFAULT_MAX_MEMORY_ENTRIES = 512;
const DEFAULT_LOOKUP_CONCURRENCY = 8;
const DEFAULT_DB_READ_COALESCE_MS = 8;
const DEFAULT_AI_FRAME_MAX_ITEMS = 32;
const DEFAULT_AI_FRAME_MAX_MS = 50;

export function createGlossResolver(deps: GlossResolverDeps): GlossResolver {
  const memoryCache = new Map<string, GlossItem>();
  const inFlight = new Map<string, InFlightGloss>();
  const maxMemoryEntries = deps.maxMemoryEntries ?? DEFAULT_MAX_MEMORY_ENTRIES;
  const lookupLimit = pLimit(deps.lookupConcurrency ?? DEFAULT_LOOKUP_CONCURRENCY);
  const writeLimit = pLimit(1);
  const lexiconReads = createReadCoalescer(
    "lexicon",
    (keys) => deps.storage.lexicon.getMany(keys),
    deps.dbReadCoalesceMs ?? DEFAULT_DB_READ_COALESCE_MS
  );
  const aiOutlet = createAiOutlet({
    ai: deps.ai,
    storage: deps.storage,
    inFlight,
    remember,
    aiFrameMaxItems: deps.aiFrameMaxItems ?? DEFAULT_AI_FRAME_MAX_ITEMS,
    aiFrameMaxMs: deps.aiFrameMaxMs ?? DEFAULT_AI_FRAME_MAX_MS
  });

  function remember(key: string, item: GlossItem): void {
    memoryCache.delete(key);
    memoryCache.set(key, item);
    while (memoryCache.size > maxMemoryEntries) {
      const oldest = memoryCache.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      memoryCache.delete(oldest);
    }
  }

  function recall(key: string): GlossItem | undefined {
    const item = memoryCache.get(key);
    if (!item) {
      return undefined;
    }
    remember(key, item);
    return item;
  }

  const createSession = (pageUrl: string, settings: GlossaSettings, now: number, sink: GlossResolverSink): GlossResolverSession => {
    const startedAt = nowMs();
    const tasks = new Set<Promise<void>>();
    const glossCacheReads = createReadCoalescer(
      "glossCache",
      (keys) => deps.storage.glossCache.getFreshMany(keys, now, settings.glossCacheTtlMs),
      deps.dbReadCoalesceMs ?? DEFAULT_DB_READ_COALESCE_MS
    );
    const stats: ResolverStats = {
      chunks: 0,
      tokens: 0,
      hidden: 0,
      ready: 0,
      pending: 0,
      error: 0
    };

    const track = (task: Promise<void>): void => {
      tasks.add(task);
      task.finally(() => {
        tasks.delete(task);
      });
    };

    const trackWrite = (task: () => Promise<void>): void => {
      track(writeLimit(async () => {
        try {
          await task();
        } catch (error) {
          trace({
            component: "service-worker",
            operation: "service-worker.db.write",
            result: "error",
            error
          });
        }
      }));
    };

    const emit = (payload: Omit<GlossTokenPayload, "scanId">): void => {
      stats[payload.status] += 1;
      if (sink.isActive?.() === false) {
        return;
      }
      sink.emit(payload);
    };

    return {
      acceptChunk(chunkId, chunkIndex, sentences) {
        const chunkStartedAt = nowMs();
        stats.chunks += 1;
        stats.tokens += sentences.reduce((total, sentence) => total + sentence.tokens.length, 0);
        const task = (async () => {
          const tokenTasks = sentences.flatMap((sentence) => {
            return sentence.tokens.map((token) => lookupLimit(async () => {
              await resolveToken({
                deps,
                token,
                sentence,
                settings,
                now,
                pageUrl,
                inFlight,
                recall,
                remember,
                lexiconReads,
                glossCacheReads,
                aiOutlet,
                sink,
                emit,
                track,
                trackWrite
              });
            }));
          });
          await Promise.all(tokenTasks);
          trace({
            component: "service-worker",
            operation: "service-worker.lookup.chunk",
            result: "ok",
            url: pageUrl,
            details: {
              chunkIndex,
              tokens: sentences.reduce((total, sentence) => total + sentence.tokens.length, 0),
              sentences: sentences.length,
              elapsedMs: elapsedMs(chunkStartedAt),
              lookupPending: lookupLimit.pendingCount,
              lookupActive: lookupLimit.activeCount,
              chunkIdHash: hashSmall(chunkId)
            }
          });
        })().catch((error) => {
          trace({
            component: "service-worker",
            operation: "service-worker.lookup.chunk",
            result: "error",
            url: pageUrl,
            error,
            details: {
              chunkIndex,
              tokens: sentences.reduce((total, sentence) => total + sentence.tokens.length, 0),
              chunkIdHash: hashSmall(chunkId)
            }
          });
        });
        track(task);
        return task;
      },
      async finish() {
        while (tasks.size > 0) {
          await Promise.allSettled(Array.from(tasks));
        }
        trace({
          component: "service-worker",
          operation: "service-worker.scan.done",
          result: "ok",
          url: pageUrl,
          details: {
            chunks: stats.chunks,
            tokens: stats.tokens,
            ready: stats.ready,
            hidden: stats.hidden,
            pending: stats.pending,
            error: stats.error,
            elapsedMs: elapsedMs(startedAt)
          }
        });
      }
    };
  };

  return {
    createSession,
    clearMemory() {
      memoryCache.clear();
    }
  };
}

async function resolveToken(input: {
  deps: GlossResolverDeps;
  token: TokenCandidate;
  sentence: SentenceCandidate;
  settings: GlossaSettings;
  now: number;
  pageUrl: string;
  inFlight: Map<string, InFlightGloss>;
  recall(key: string): GlossItem | undefined;
  remember(key: string, item: GlossItem): void;
  lexiconReads: ReadCoalescer<VocabularyRecord>;
  glossCacheReads: ReadCoalescer<GlossCacheEntry>;
  aiOutlet: ReturnType<typeof createAiOutlet>;
  sink: GlossResolverSink;
  emit(payload: Omit<GlossTokenPayload, "scanId">): void;
  track(task: Promise<void>): void;
  trackWrite(task: () => Promise<void>): void;
}): Promise<void> {
  try {
    if (input.sink.isActive?.() === false) {
      return;
    }
    const cacheKey = await glossCacheKey(input.sentence, input.token);
    const memoryKey = transientMemoryKey(input.pageUrl, cacheKey);
    // Fresh cached glosses replay before vocabulary state so toggling or rescanning keeps the current reading stable.
    const memoryCached = input.recall(memoryKey);
    if (memoryCached) {
      const item = rehydrateCachedGloss(memoryCached, input.token);
      input.emit({ tokenId: input.token.id, status: "ready", item });
      input.trackWrite(() => persistShownRecord(input.deps.storage, input.token, input.now));
      return;
    }

    const cached = await input.glossCacheReads.get(cacheKey);
    if (input.sink.isActive?.() === false) {
      return;
    } else if (cached) {
      const item = rehydrateCachedGloss(cached, input.token);
      input.remember(memoryKey, item);
      input.emit({ tokenId: input.token.id, status: "ready", item });
      input.trackWrite(() => persistShownRecord(input.deps.storage, input.token, input.now));
      return;
    }

    const record = await currentRecord(input.lexiconReads, input.deps.storage, input.token, input.now, input.trackWrite);
    if (input.sink.isActive?.() === false) {
      return;
    } else if (record?.state === "known" || record?.state === "ignored") {
      input.emit({ tokenId: input.token.id, status: "hidden" });
      return;
    }

    input.emit({ tokenId: input.token.id, status: "pending" });
    const runtimeKey = aiInFlightKey(input.settings, cacheKey);
    const active = input.inFlight.get(runtimeKey);
    if (active) {
      input.track(emitReusedMiss({
        token: input.token,
        inFlight: active,
        now: input.now,
        sink: input.sink,
        emit: input.emit,
        trackWrite: input.trackWrite
      }, input.deps.storage));
      return;
    }

    const pending = createInFlightGloss();
    input.inFlight.set(runtimeKey, pending);
    const miss: Miss = {
      token: input.token,
      sentence: input.sentence.text,
      memoryKey,
      dbCacheKey: cacheKey,
      inFlightKey: runtimeKey,
      inFlight: pending,
      settings: input.settings,
      now: input.now,
      sink: input.sink,
      emit: input.emit,
      trackWrite: input.trackWrite
    };
    input.aiOutlet.enqueue(miss);
    input.track(pending.promise.then(() => undefined));
  } catch (error) {
    const payload = diagnosticPayloadFrom(error, {
      reason: "runtime",
      message: "Gloss lookup failed",
      service: "runtime"
    });
    input.emit({ tokenId: input.token.id, status: "error", message: payload.message, error: payload });
  }
}

function createAiOutlet(input: {
  ai: AiBackend;
  storage: ExtensionStorage;
  inFlight: Map<string, InFlightGloss>;
  remember(key: string, item: GlossItem): void;
  aiFrameMaxItems: number;
  aiFrameMaxMs: number;
}) {
  const serialAi = pLimit(1);
  let currentFrame: AiFrame | undefined;

  const enqueue = (miss: Miss): void => {
    const key = aiFrameKey(miss.settings);
    if (currentFrame && currentFrame.key !== key) {
      flushFrame("settings-change");
    }
    if (!currentFrame) {
      currentFrame = {
        key,
        settings: miss.settings,
        misses: [],
        createdAt: nowMs(),
        timer: globalThis.setTimeout(() => flushFrame("time"), input.aiFrameMaxMs)
      };
    }
    currentFrame.misses.push(miss);
    if (currentFrame.misses.length >= input.aiFrameMaxItems) {
      flushFrame("size");
    }
  };

  const flushFrame = (trigger: string): void => {
    const frame = currentFrame;
    if (!frame) {
      return;
    }
    currentFrame = undefined;
    globalThis.clearTimeout(frame.timer);
    void serialAi(() => executeFrame(input, frame, trigger));
  };

  return { enqueue, flushFrame };
}

async function executeFrame(
  deps: {
    ai: AiBackend;
    storage: ExtensionStorage;
    inFlight: Map<string, InFlightGloss>;
    remember(key: string, item: GlossItem): void;
  },
  frame: AiFrame,
  trigger: string
): Promise<void> {
  const queueElapsed = elapsedMs(frame.createdAt);
  const requestStartedAt = nowMs();
  try {
    const response = await deps.ai.glossFrame({
      settings: frame.settings,
      items: frame.misses.map((miss) => ({
        sentence: miss.sentence,
        token: miss.token
      }))
    });
    const unresolved = new Set(frame.misses);
    const writeStartedAt = nowMs();
    for (const item of response.items) {
      const miss = frame.misses.find((candidate) => unresolved.has(candidate) && candidate.token.id === item.tokenId);
      if (!miss) {
        continue;
      }
      const readyItem = rehydrateCachedGloss(item, miss.token);
      try {
        await deps.storage.glossCache.put(miss.dbCacheKey, { ...readyItem, createdAt: miss.now });
        deps.remember(miss.memoryKey, readyItem);
        if (miss.sink.isActive?.() !== false) {
          miss.trackWrite(() => persistShownRecord(deps.storage, miss.token, miss.now));
          miss.emit({ tokenId: miss.token.id, status: "ready", item: readyItem });
        }
        resolveInFlightMiss(deps.inFlight, miss, { ok: true, item: readyItem });
      } catch (error) {
        const payload = diagnosticPayloadFrom(error, {
          reason: "runtime",
          message: "Gloss cache write failed",
          service: "runtime"
        });
        resolveInFlightMiss(deps.inFlight, miss, { ok: false, error: payload });
        if (miss.sink.isActive?.() !== false) {
          miss.emit({ tokenId: miss.token.id, status: "error", message: payload.message, error: payload });
        }
      }
      unresolved.delete(miss);
    }
    for (const miss of frame.misses) {
      if (!unresolved.has(miss)) {
        continue;
      }
      const payload: ErrorPayload = {
        reason: "invalid-response",
        message: "Gloss lookup returned no item",
        service: "ai"
      };
      resolveInFlightMiss(deps.inFlight, miss, { ok: false, error: payload });
      if (miss.sink.isActive?.() !== false) {
        miss.emit({ tokenId: miss.token.id, status: "error", message: payload.message, error: payload });
      }
    }
    trace({
      component: "service-worker",
      operation: "service-worker.ai.frame",
      result: "ok",
      details: {
        trigger,
        items: frame.misses.length,
        returned: response.items.length,
        queueMs: queueElapsed,
        requestMs: elapsedMs(requestStartedAt),
        writeMs: elapsedMs(writeStartedAt)
      }
    });
  } catch (error) {
    const payload = diagnosticPayloadFrom(error, {
      reason: "service-error",
      message: "Gloss lookup failed",
      service: "ai"
    });
    for (const miss of frame.misses) {
      resolveInFlightMiss(deps.inFlight, miss, { ok: false, error: payload });
      if (miss.sink.isActive?.() !== false) {
        miss.emit({ tokenId: miss.token.id, status: "error", message: payload.message, error: payload });
      }
    }
    trace({
      component: "service-worker",
      operation: "service-worker.ai.frame",
      result: "error",
      error,
      details: {
        trigger,
        items: frame.misses.length,
        queueMs: queueElapsed,
        requestMs: elapsedMs(requestStartedAt)
      }
    });
  }
}

function createReadCoalescer<T>(
  store: string,
  readMany: (keys: string[]) => Promise<Map<string, T>>,
  delayMs: number
): ReadCoalescer<T> {
  const pending = new Map<string, PendingRead<T>[]>();
  let timer: ReturnType<typeof globalThis.setTimeout> | undefined;

  const schedule = (): void => {
    if (timer) {
      return;
    }
    timer = globalThis.setTimeout(() => {
      timer = undefined;
      void flush();
    }, delayMs);
  };

  const flush = async (): Promise<void> => {
    const entries = Array.from(pending.entries());
    pending.clear();
    if (entries.length === 0) {
      return;
    }
    const startedAt = nowMs();
    const keys = entries.map(([key]) => key);
    try {
      const values = await readMany(keys);
      for (const [key, subscribers] of entries) {
        const value = values.get(key);
        for (const subscriber of subscribers) {
          subscriber.resolve(value);
        }
      }
      trace({
        component: "service-worker",
        operation: "service-worker.db.read",
        result: "ok",
        details: {
          store,
          keys: keys.length,
          subscribers: entries.reduce((total, [, subscribers]) => total + subscribers.length, 0),
          elapsedMs: elapsedMs(startedAt)
        }
      });
    } catch (error) {
      for (const [, subscribers] of entries) {
        for (const subscriber of subscribers) {
          subscriber.reject(error);
        }
      }
      trace({
        component: "service-worker",
        operation: "service-worker.db.read",
        result: "error",
        error,
        details: {
          store,
          keys: keys.length,
          elapsedMs: elapsedMs(startedAt)
        }
      });
    }
  };

  return {
    get(key) {
      return new Promise<T | undefined>((resolve, reject) => {
        const subscribers = pending.get(key);
        if (subscribers) {
          subscribers.push({ resolve, reject });
        } else {
          pending.set(key, [{ resolve, reject }]);
        }
        schedule();
      });
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
  if (inFlight.get(miss.inFlightKey) === miss.inFlight) {
    inFlight.delete(miss.inFlightKey);
  }
  miss.inFlight.resolve(result);
}

async function emitReusedMiss(
  miss: ReusedMiss,
  storage: ExtensionStorage
): Promise<void> {
  if (miss.sink.isActive?.() === false) {
    return;
  }
  const result = await miss.inFlight.promise;
  if (miss.sink.isActive?.() === false) {
    return;
  }
  if (result.ok) {
    const item = rehydrateCachedGloss(result.item, miss.token);
    miss.emit({ tokenId: miss.token.id, status: "ready", item });
    miss.trackWrite(() => persistShownRecord(storage, miss.token, miss.now));
  } else {
    miss.emit({ tokenId: miss.token.id, status: "error", message: result.error.message, error: result.error });
  }
}

async function glossCacheKey(
  sentence: SentenceCandidate,
  token: TokenCandidate
): Promise<string> {
  return buildGlossCacheKey({
    targetLang: GLOSS_TARGET_LANG,
    sentence: sentence.text,
    targetText: token.surface,
    targetSpan: [token.startOffset, token.endOffset]
  });
}

async function currentRecord(
  lexiconReads: ReadCoalescer<VocabularyRecord>,
  storage: ExtensionStorage,
  token: TokenCandidate,
  now: number,
  trackWrite: (task: () => Promise<void>) => void
): Promise<VocabularyRecord | undefined> {
  const key = vocabularyKey("en", token.lemma);
  const record = await lexiconReads.get(key);
  if (!record) {
    return undefined;
  }
  const current = transitionExpiredLearning(record, now);
  if (current !== record) {
    trackWrite(() => storage.lexicon.put(current));
  }
  return current;
}

async function persistShownRecord(storage: ExtensionStorage, token: TokenCandidate, now: number): Promise<void> {
  const key = vocabularyKey("en", token.lemma);
  const record = await storage.lexicon.get(key);
  const current = record ? transitionExpiredLearning(record, now) : createCandidateRecord(token.lemma, token.surface, "en", now);
  await storage.lexicon.put(markRecordShown(current, now));
}

function rehydrateCachedGloss(item: GlossItem, token: TokenCandidate): GlossItem {
  const { createdAt: _createdAt, ...displayItem } = item as GlossItem & { createdAt?: number };
  return {
    ...displayItem,
    tokenId: token.id,
    targetText: token.surface
  };
}

function transientMemoryKey(pageUrl: string, cacheKey: string): string {
  return `${pageUrl}::${cacheKey}`;
}

function aiInFlightKey(settings: GlossaSettings, cacheKey: string): string {
  return `${aiFrameKey(settings)}\n${cacheKey}`;
}

function aiFrameKey(settings: GlossaSettings): string {
  return [
    settings.ai.provider,
    settings.ai.endpoint,
    settings.ai.reasoningEffort,
    String(settings.ai.requestTimeoutMs),
    settings.ai.apiKey ? hashSmall(settings.ai.apiKey) : "",
    settings.promptVersion,
    settings.modelVersion,
    settings.prompts.gloss
  ].join("\n");
}

function nowMs(): number {
  return globalThis.performance?.now?.() ?? Date.now();
}

function elapsedMs(startedAt: number): number {
  return Math.round(nowMs() - startedAt);
}

function hashSmall(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
}
