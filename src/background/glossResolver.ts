import pLimit from "p-limit";

import { buildGlossCacheKey, glossGenerationIdentity } from "../core/cache";
import { createDiagnosticError, diagnosticPayloadFrom } from "../shared/errors";
import { trace } from "../shared/diagnostics";
import {
  createCandidateRecord,
  markRecordShown,
  transitionExpiredLearning,
  vocabularyKey
} from "../core/state";
import type { ExtensionStorage } from "../storage/db";
import type { AiClient } from "../shared/services/aiClient";
import type { ErrorPayload, GlossaSettings, GlossCacheEntry, GlossItem, GlossTokenOutcome, SentenceCandidate, TokenCandidate, VocabularyRecord } from "../shared/types";
import { GLOSS_TARGET_LANG } from "../shared/types";

export interface GlossResolver {
  createSession(pageUrl: string, settings: GlossaSettings, now: number, sink: GlossResolverSink): GlossResolverSession;
  clearCache(): Promise<void>;
  activateGeneration(identity: string): Promise<void>;
}

export interface GlossResolverSession {
  acceptChunk(chunkId: string, chunkIndex: number, sentences: SentenceCandidate[]): Promise<void>;
  finish(): Promise<void>;
  close(): void;
}

export interface GlossResolverDeps {
  storage: ExtensionStorage;
  ai: Pick<AiClient, "glossFrame">;
  maxMemoryEntries?: number;
  lookupConcurrency?: number;
  dbReadCoalesceMs?: number;
  aiFrameMaxItems?: number;
  aiFrameMaxMs?: number;
}

export interface GlossResolverSink {
  emit(payload: GlossTokenOutcome): void;
  isActive?(): boolean;
}

interface GlossSubscriber {
  token: TokenCandidate;
  memoryKey: string;
  now: number;
  emit(payload: GlossTokenOutcome): void;
  trackWrite(task: () => Promise<void>): void;
  complete(): void;
}

// Jobs own demand; no occurrence or session becomes an owner of shared work.
interface GlossJob {
  sentence: string;
  token: Pick<TokenCandidate, "surface" | "lemma" | "startOffset" | "endOffset">;
  dbCacheKey: string;
  inFlightKey: string;
  settings: GlossaSettings;
  createdAt: number;
  cacheEpoch: number;
  subscribers: Set<GlossSubscriber>;
}

type GlossJobResult =
  | { ok: true; item: GlossItem }
  | { ok: false; error: ErrorPayload }
  | { ok: false; cancelled: true };

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
  jobs: GlossJob[];
  createdAt: number;
  timer: ReturnType<typeof globalThis.setTimeout>;
  controller: AbortController;
  cancelled: boolean;
}

const DEFAULT_MAX_MEMORY_ENTRIES = 512;
const DEFAULT_LOOKUP_CONCURRENCY = 8;
const DEFAULT_DB_READ_COALESCE_MS = 8;
const DEFAULT_AI_FRAME_MAX_ITEMS = 32;
const DEFAULT_AI_FRAME_MAX_MS = 50;

export function createGlossResolver(deps: GlossResolverDeps): GlossResolver {
  const memoryCache = new Map<string, GlossItem>();
  const inFlight = new Map<string, GlossJob>();
  let generation = 0;
  let cacheEpoch = 0;
  let generationIdentity: string | undefined;
  let cacheLane = Promise.resolve();
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
    putCache,
    isCacheEpochCurrent: (epoch) => epoch === cacheEpoch,
    aiFrameMaxItems: deps.aiFrameMaxItems ?? DEFAULT_AI_FRAME_MAX_ITEMS,
    aiFrameMaxMs: deps.aiFrameMaxMs ?? DEFAULT_AI_FRAME_MAX_MS
  });

  function putCache(capturedEpoch: number, key: string, value: GlossCacheEntry): Promise<boolean> {
    const task = cacheLane.then(async () => {
      if (capturedEpoch !== cacheEpoch) {
        return false;
      }
      await deps.storage.glossCache.put(key, value);
      return capturedEpoch === cacheEpoch;
    });
    cacheLane = task.then(() => undefined, () => undefined);
    return task;
  }

  function clearCachedValues(): void {
    cacheEpoch += 1;
    memoryCache.clear();
  }

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
    const sessionGeneration = generation;
    let closed = false;
    const subscriptions = new Set<() => void>();
    const sessionCacheEpoch = cacheEpoch;
    const sessionCacheBarrier = cacheLane;
    const sessionSink: GlossResolverSink = {
      emit: (payload) => sink.emit(payload),
      isActive: () => !closed && sessionGeneration === generation
        && sink.isActive?.() !== false
    };
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

    const emit = (payload: GlossTokenOutcome): void => {
      stats[payload.status] += 1;
      if (sessionSink.isActive?.() === false) {
        return;
      }
      sessionSink.emit(payload);
    };

    return {
      acceptChunk(chunkId, chunkIndex, sentences) {
        const chunkStartedAt = nowMs();
        stats.chunks += 1;
        stats.tokens += sentences.reduce((total, sentence) => total + sentence.tokens.length, 0);
        const task = (async () => {
          await sessionCacheBarrier;
          if (sessionSink.isActive?.() === false) {
            return;
          }
          const tokenTasks = sentences.flatMap((sentence) => {
            return sentence.tokens.map((token) => lookupLimit(async () => {
              await resolveToken({
                deps,
                token,
                sentence,
                settings,
                now,
                cacheEpoch: sessionCacheEpoch,
                isCacheEpochCurrent: () => sessionCacheEpoch === cacheEpoch,
                pageUrl,
                inFlight,
                recall,
                remember,
                lexiconReads,
                glossCacheReads,
                aiOutlet,
                sink: sessionSink,
                emit,
                track,
                trackWrite,
                subscriptions
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
      close() {
        closed = true;
        for (const unsubscribe of subscriptions) unsubscribe();
        subscriptions.clear();
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
    clearCache() {
      clearCachedValues();
      const task = cacheLane.then(() => deps.storage.glossCache.clear());
      cacheLane = task.then(() => undefined, () => undefined);
      return task;
    },
    // @behavior glossa.cache_identity.generation_activation Repeating the active settings identity preserves replacement sessions while a changed identity retires older work.
    activateGeneration(identity) {
      if (identity === generationIdentity) {
        return Promise.resolve();
      }
      if (generationIdentity === undefined) {
        generationIdentity = identity;
        return Promise.resolve();
      }
      generationIdentity = identity;
      generation += 1;
      memoryCache.clear();
      aiOutlet.invalidate();
      return Promise.resolve();
    }
  };
}

async function resolveToken(input: {
  deps: GlossResolverDeps;
  token: TokenCandidate;
  sentence: SentenceCandidate;
  settings: GlossaSettings;
  now: number;
  cacheEpoch: number;
  isCacheEpochCurrent(): boolean;
  pageUrl: string;
  inFlight: Map<string, GlossJob>;
  recall(key: string): GlossItem | undefined;
  remember(key: string, item: GlossItem): void;
  lexiconReads: ReadCoalescer<VocabularyRecord>;
  glossCacheReads: ReadCoalescer<GlossCacheEntry>;
  aiOutlet: ReturnType<typeof createAiOutlet>;
  sink: GlossResolverSink;
  emit(payload: GlossTokenOutcome): void;
  track(task: Promise<void>): void;
  trackWrite(task: () => Promise<void>): void;
  subscriptions: Set<() => void>;
}): Promise<void> {
  try {
    if (input.sink.isActive?.() === false) {
      return;
    }
    const cacheKey = await glossCacheKey(input.sentence, input.token, input.settings);
    if (input.sink.isActive?.() === false || !input.isCacheEpochCurrent()) {
      return;
    }
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
    } else if (!input.isCacheEpochCurrent()) {
      return;
    } else if (cached) {
      const item = rehydrateCachedGloss(cached, input.token);
      input.remember(memoryKey, item);
      input.emit({ tokenId: input.token.id, status: "ready", item });
      input.trackWrite(() => persistShownRecord(input.deps.storage, input.token, input.now));
      return;
    }

    const record = await currentRecord(input.lexiconReads, input.deps.storage, input.token, input.now);
    // A currently rendered known word may refresh its label; an explicit ignore remains authoritative.
    if (input.sink.isActive?.() === false) {
      return;
    } else if (record?.state === "ignored" || (record?.state === "known" && input.token.forceRefresh !== true)) {
      input.emit({ tokenId: input.token.id, status: "hidden" });
      return;
    }

    input.emit({ tokenId: input.token.id, status: "pending" });
    const runtimeKey = aiInFlightKey(input.settings, cacheKey);
    let job = input.inFlight.get(runtimeKey);
    const newJob = !job;
    if (!job) {
      job = {
        sentence: input.sentence.text,
        token: tokenForAi(input.token),
        dbCacheKey: cacheKey,
        inFlightKey: runtimeKey,
        settings: input.settings,
        createdAt: input.now,
        cacheEpoch: input.cacheEpoch,
        subscribers: new Set()
      };
      input.inFlight.set(runtimeKey, job);
    }
    const subscribedJob = job;
    let complete!: () => void;
    const completed = new Promise<void>((resolve) => { complete = resolve; });
    const unsubscribe = (): void => {
      subscribedJob.subscribers.delete(subscriber);
      input.subscriptions.delete(unsubscribe);
      complete();
      if (subscribedJob.subscribers.size === 0) input.aiOutlet.remove(subscribedJob);
    };
    const subscriber: GlossSubscriber = {
      token: input.token,
      memoryKey,
      now: input.now,
      emit: input.emit,
      trackWrite: input.trackWrite,
      complete() {
        input.subscriptions.delete(unsubscribe);
        complete();
      }
    };
    subscribedJob.subscribers.add(subscriber);
    input.subscriptions.add(unsubscribe);
    input.track(completed);
    if (newJob) input.aiOutlet.enqueue(subscribedJob);
  } catch (error) {
    const payload = diagnosticPayloadFrom(error, {
      reason: "runtime",
      message: "Gloss lookup failed",
      service: "runtime"
    });
    input.emit({ tokenId: input.token.id, status: "error", error: payload });
  }
}

function createAiOutlet(input: {
  ai: Pick<AiClient, "glossFrame">;
  storage: ExtensionStorage;
  inFlight: Map<string, GlossJob>;
  remember(key: string, item: GlossItem): void;
  putCache(epoch: number, key: string, value: GlossCacheEntry): Promise<boolean>;
  isCacheEpochCurrent(epoch: number): boolean;
  aiFrameMaxItems: number;
  aiFrameMaxMs: number;
}) {
  const serialAi = pLimit(1);
  let currentFrame: AiFrame | undefined;
  const frames = new Set<AiFrame>();

  function settle(job: GlossJob, result: GlossJobResult): void {
    if (input.inFlight.get(job.inFlightKey) === job) input.inFlight.delete(job.inFlightKey);
    for (const subscriber of job.subscribers) {
      if (result.ok) {
        const item = rehydrateCachedGloss(result.item, subscriber.token);
        if (input.isCacheEpochCurrent(job.cacheEpoch)) input.remember(subscriber.memoryKey, item);
        subscriber.emit({ tokenId: subscriber.token.id, status: "ready", item });
        subscriber.trackWrite(() => persistShownRecord(input.storage, subscriber.token, subscriber.now));
      } else if ("error" in result) {
        subscriber.emit({ tokenId: subscriber.token.id, status: "error", error: result.error });
      }
      subscriber.complete();
    }
    job.subscribers.clear();
  }

  function cancelFrame(frame: AiFrame): void {
    frame.cancelled = true;
    globalThis.clearTimeout(frame.timer);
    frame.controller.abort();
    for (const job of frame.jobs) settle(job, { ok: false, cancelled: true });
    frames.delete(frame);
    if (currentFrame === frame) currentFrame = undefined;
  }

  async function executeFrame(frame: AiFrame, trigger: string): Promise<void> {
    if (frame.cancelled) return;
    // Request IDs belong to this frame, never to content occurrences in unrelated documents.
    const requested = new Map<string, GlossJob>(frame.jobs.filter((job) => job.subscribers.size > 0)
      .map((job) => [crypto.randomUUID(), job] as const));
    if (requested.size === 0) return;
    const startedAt = nowMs();
    try {
      const response = await input.ai.glossFrame({
        settings: frame.settings,
        items: Array.from(requested, ([requestItemId, job]) => ({ requestItemId, sentence: job.sentence, token: job.token })),
        signal: frame.controller.signal
      });
      if (frame.cancelled) return;
      const received = new Set<string>();
      // Validate the whole correspondence before any writes: duplicates and unknown IDs are ambiguous.
      for (const item of response.items) {
        if (!requested.has(item.requestItemId) || received.has(item.requestItemId)) {
          throw createDiagnosticError("invalid-response", "Gloss frame returned an unknown or duplicate request item ID", { service: "ai" });
        }
        received.add(item.requestItemId);
      }
      for (const item of response.items) {
        const job = requested.get(item.requestItemId)!;
        if (frame.cancelled) return;
        if (job.subscribers.size === 0) continue;
        const cachedItem: GlossItem = { tokenId: item.requestItemId, ...item.value };
        try {
          await input.putCache(job.cacheEpoch, job.dbCacheKey, { ...cachedItem, createdAt: job.createdAt });
          if (frame.cancelled) return;
          settle(job, { ok: true, item: cachedItem });
        } catch (error) {
          settle(job, { ok: false, error: diagnosticPayloadFrom(error, {
            reason: "runtime", message: "Gloss cache write failed", service: "runtime"
          }) });
        }
      }
      for (const [requestItemId, job] of requested) {
        if (!received.has(requestItemId)) settle(job, { ok: false, error: {
          reason: "invalid-response", message: "Gloss lookup returned no item", service: "ai"
        } });
      }
      trace({ component: "service-worker", operation: "service-worker.ai.frame", result: "ok",
        details: { trigger, items: requested.size, returned: response.items.length, queueMs: Math.round(startedAt - frame.createdAt), requestMs: elapsedMs(startedAt) } });
    } catch (error) {
      if (frame.cancelled) return;
      const payload = diagnosticPayloadFrom(error, { reason: "service-error", message: "Gloss lookup failed", service: "ai" });
      for (const job of requested.values()) settle(job, { ok: false, error: payload });
      trace({ component: "service-worker", operation: "service-worker.ai.frame", result: "error", error,
        details: { trigger, items: requested.size, requestMs: elapsedMs(startedAt) } });
    }
  }

  function flushFrame(trigger: string): void {
    const frame = currentFrame;
    if (!frame) return;
    currentFrame = undefined;
    globalThis.clearTimeout(frame.timer);
    void serialAi(async () => {
      try { await executeFrame(frame, trigger); }
      finally { frames.delete(frame); }
    });
  }

  return {
    enqueue(job: GlossJob): void {
      const key = aiFrameKey(job.settings);
      if (currentFrame && currentFrame.key !== key) flushFrame("settings-change");
      if (!currentFrame) {
        currentFrame = { key, settings: job.settings, jobs: [], createdAt: nowMs(),
          timer: globalThis.setTimeout(() => flushFrame("time"), input.aiFrameMaxMs),
          controller: new AbortController(), cancelled: false };
        frames.add(currentFrame);
      }
      currentFrame.jobs.push(job);
      if (currentFrame.jobs.length >= input.aiFrameMaxItems) flushFrame("size");
    },
    remove(job: GlossJob): void {
      if (input.inFlight.get(job.inFlightKey) === job) input.inFlight.delete(job.inFlightKey);
      for (const frame of frames) {
        if (!frame.jobs.includes(job)) continue;
        frame.jobs = frame.jobs.filter((candidate) => candidate !== job);
        if (frame.jobs.length === 0) cancelFrame(frame);
        break;
      }
    },
    invalidate(): void {
      for (const frame of frames) cancelFrame(frame);
      serialAi.clearQueue();
    }
  };
}

function tokenForAi(token: TokenCandidate): GlossJob["token"] {
  return { surface: token.surface, lemma: token.lemma, startOffset: token.startOffset, endOffset: token.endOffset };
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

async function glossCacheKey(
  sentence: SentenceCandidate,
  token: TokenCandidate,
  settings: GlossaSettings
): Promise<string> {
  return buildGlossCacheKey({
    targetLang: GLOSS_TARGET_LANG,
    sentence: sentence.text,
    targetText: token.surface,
    targetSpan: [token.startOffset, token.endOffset],
    settings
  });
}

async function currentRecord(
  lexiconReads: ReadCoalescer<VocabularyRecord>,
  storage: ExtensionStorage,
  token: TokenCandidate,
  now: number
): Promise<VocabularyRecord | undefined> {
  const key = vocabularyKey("en", token.lemma);
  const record = await lexiconReads.get(key);
  if (!record) {
    return undefined;
  }
  const current = transitionExpiredLearning(record, now);
  if (current !== record) {
    return storage.lexicon.update(key, (latest) => latest ? transitionExpiredLearning(latest, now) : undefined);
  }
  return current;
}

async function persistShownRecord(storage: ExtensionStorage, token: TokenCandidate, now: number): Promise<void> {
  const key = vocabularyKey("en", token.lemma);
  await storage.lexicon.update(key, (record) => {
    const current = record
      ? transitionExpiredLearning(record, now)
      : createCandidateRecord(token.lemma, token.surface, "en", now);
    return current.state === "ignored" ? current : markRecordShown(current, now);
  });
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
    glossGenerationIdentity(settings),
    String(settings.ai.requestTimeoutMs)
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
