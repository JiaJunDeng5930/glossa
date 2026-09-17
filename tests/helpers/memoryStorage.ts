import {
  createCandidateRecord,
  markRecordClicked,
  normalizeLemma,
  vocabularyKey
} from "../../src/core/state";
import type {
  ExtensionStorage,
  GlossCacheStore,
  KeyValueStore,
  LexiconStore
} from "../../src/storage/db";
import type {
  AnkiCard,
  CardedWordRecord,
  GlossaSettings,
  GlossCacheEntry,
  VocabularyRecord,
  VocabularyState
} from "../../src/shared/types";
import { normalizeSettings } from "../../src/shared/settings";
import { DEFAULT_SETTINGS } from "../../src/shared/types";

export interface MemoryStorageFixture {
  storage: ExtensionStorage;
  lexicon: Map<string, VocabularyRecord>;
  glossCache: Map<string, GlossCacheEntry>;
  cardCache: Map<string, AnkiCard>;
  cardedWords: Map<string, CardedWordRecord>;
}

interface CardCreatedInput {
  lang: "en";
  lemma: string;
  surface: string;
  createdAt: number;
  learningWindowDays: number;
}

export function createMemoryStorage(initialSettings: GlossaSettings = DEFAULT_SETTINGS): MemoryStorageFixture {
  const settingsValue = { value: clone(initialSettings) };
  const lexicon = new Map<string, VocabularyRecord>();
  const glossCache = new Map<string, GlossCacheEntry>();
  const cardCache = new Map<string, AnkiCard>();
  const cardedWords = new Map<string, CardedWordRecord>();

  const settings = {
    async get(): Promise<GlossaSettings> {
      return clone(settingsValue.value);
    },
    async set(value: GlossaSettings): Promise<void> {
      settingsValue.value = normalizeSettings(clone(value));
    }
  };

  const storage: ExtensionStorage = {
    settings,
    lexicon: createLexiconStore(lexicon),
    glossCache: createGlossCacheStore(glossCache),
    cardCache: createKeyValueStore(cardCache),
    cardedWords: createKeyValueStore(cardedWords),
    async recordCardCreated(input: CardCreatedInput): Promise<void> {
      const key = vocabularyKey(input.lang, input.lemma);
      const current = lexicon.get(key);
      const candidate = current ?? createCandidateRecord(input.lemma, input.surface, input.lang, input.createdAt);
      lexicon.set(key, clone(markRecordClicked(candidate, input.createdAt, input.learningWindowDays)));
      cardedWords.set(key, {
        key,
        lang: input.lang,
        lemma: normalizeLemma(input.lemma),
        createdAt: input.createdAt
      });
    },
    async resetCardHistory(): Promise<void> {
      cardCache.clear();
      cardedWords.clear();
    }
  };

  return { storage, lexicon, glossCache, cardCache, cardedWords };
}

function createKeyValueStore<T>(values: Map<string, T>): KeyValueStore<T> {
  return {
    async get(key): Promise<T | undefined> {
      const value = values.get(key);
      return value === undefined ? undefined : clone(value);
    },
    async getMany(keys): Promise<Map<string, T>> {
      return readMany(values, keys);
    },
    async put(key, value): Promise<void> {
      values.set(key, clone(value));
    },
    async delete(key): Promise<void> {
      values.delete(key);
    },
    async clear(): Promise<void> {
      values.clear();
    }
  };
}

function createGlossCacheStore(values: Map<string, GlossCacheEntry>): GlossCacheStore {
  const store = createKeyValueStore(values);
  return {
    ...store,
    async getFreshMany(keys, now, ttlMs): Promise<Map<string, GlossCacheEntry>> {
      const result = new Map<string, GlossCacheEntry>();
      for (const [key, value] of await store.getMany(keys)) {
        if (isFresh(value, now, ttlMs)) {
          result.set(key, value);
        }
      }
      return result;
    }
  };
}

function createLexiconStore(values: Map<string, VocabularyRecord>): LexiconStore {
  return {
    async get(key): Promise<VocabularyRecord | undefined> {
      const value = values.get(key);
      return value === undefined ? undefined : clone(value);
    },
    async getMany(keys): Promise<Map<string, VocabularyRecord>> {
      return readMany(values, keys);
    },
    async listByState(state: VocabularyState): Promise<VocabularyRecord[]> {
      return Array.from(values.values())
        .filter((record) => record.state === state)
        .sort((left, right) => left.lemma.localeCompare(right.lemma))
        .map(clone);
    },
    async update(key, transition): Promise<VocabularyRecord | undefined> {
      const current = values.get(key);
      const next = transition(current === undefined ? undefined : clone(current));
      if (next === undefined) {
        values.delete(key);
        return undefined;
      }
      const stored = clone(next);
      values.set(key, stored);
      return clone(stored);
    },
    async put(record): Promise<void> {
      values.set(record.key, clone(record));
    },
    async delete(key): Promise<void> {
      values.delete(key);
    },
    async addKnown(lemma, now): Promise<void> {
      const normalized = normalizeLemma(lemma);
      if (!normalized) {
        throw new Error("Known word must not be empty");
      }
      const key = vocabularyKey("en", normalized);
      const current = values.get(key);
      const { expiresAt: _expiresAt, ...record } = current ?? createCandidateRecord(normalized, normalized, "en", now);
      values.set(key, clone({ ...record, state: "known" }));
    },
    async removeKnown(lemma): Promise<void> {
      const key = vocabularyKey("en", lemma);
      if (values.get(key)?.state === "known") {
        values.delete(key);
      }
    },
    async clearKnown(): Promise<void> {
      for (const [key, record] of values) {
        if (record.state === "known") {
          values.delete(key);
        }
      }
    }
  };
}

function readMany<T>(values: Map<string, T>, keys: string[]): Map<string, T> {
  const result = new Map<string, T>();
  for (const key of new Set(keys)) {
    const value = values.get(key);
    if (value !== undefined) {
      result.set(key, clone(value));
    }
  }
  return result;
}

function isFresh(value: GlossCacheEntry, now: number, ttlMs: number): boolean {
  return Number.isFinite(value.createdAt) && now < value.createdAt + ttlMs;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}
