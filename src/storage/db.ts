// @intent glossa.extension_storage Settings, vocabulary records, gloss cache entries, card cache entries, and carded-word records stay inside extension-owned storage.
// @constraint glossa.extension_storage.typed_access Settings, lexicon, cache, and carded-word storage use one typed asynchronous access contract.
import type { AnkiCardOutput, CardedWordRecord, GlossaSettings, GlossCacheEntry, VocabularyRecord, VocabularyState } from "../shared/types";
import { mergeStoredSettings, settingsOverrides, type StoredGlossaSettings } from "../shared/settings";

export interface KeyValueStore<T> {
  get(key: string): Promise<T | undefined>;
  getMany(keys: string[]): Promise<Map<string, T>>;
  put(key: string, value: T): Promise<void>;
  // @constraint glossa.extension_storage.typed_access.key_value_delete Key-value stores expose deletion through the typed storage contract.
  delete(key: string): Promise<void>;
  // @constraint glossa.extension_storage.typed_access.key_value_clear Key-value stores expose full-store clearing through the typed storage contract.
  clear(): Promise<void>;
}

// @constraint glossa.cache_identity.gloss_cache_entry.fresh_store Gloss cache storage exposes fresh-read methods for TTL-aware database cache requests.
export interface GlossCacheStore extends KeyValueStore<GlossCacheEntry> {
  // @behavior glossa.cache_identity.gloss_cache_entry.fresh_read Gloss cache reads return persisted entries only while their creation time is inside the requested TTL window.
  getFresh(key: string, now: number, ttlMs: number): Promise<GlossCacheEntry | undefined>;
  // @behavior glossa.cache_identity.gloss_cache_entry.fresh_read_many Batched gloss cache reads return only entries that are fresh for the request time and TTL.
  getFreshMany(keys: string[], now: number, ttlMs: number): Promise<Map<string, GlossCacheEntry>>;
}

export interface LexiconStore {
  get(key: string): Promise<VocabularyRecord | undefined>;
  getMany(keys: string[]): Promise<Map<string, VocabularyRecord>>;
  // @behavior glossa.word_memory.known_management.store_listing The lexicon store can list vocabulary records by state for options-page known-word management.
  listByState(state: VocabularyState): Promise<VocabularyRecord[]>;
  put(record: VocabularyRecord): Promise<void>;
  // @constraint glossa.extension_storage.typed_access.lexicon_delete The lexicon store exposes deletion through the typed storage contract.
  delete(key: string): Promise<void>;
}

export interface SettingsStore {
  get(): Promise<GlossaSettings>;
  set(value: GlossaSettings): Promise<void>;
}

export interface ExtensionStorage {
  settings: SettingsStore;
  // @constraint glossa.cache_identity.gloss_cache_entry.store Extension storage persists gloss cache entries with cache metadata.
  glossCache: GlossCacheStore;
  lexicon: LexiconStore;
  // @constraint glossa.cache_identity.card_content_cache.store Card cache storage persists generated card content without note-write identifiers.
  cardCache: KeyValueStore<AnkiCardOutput>;
  // @constraint glossa.card_creation.duplicate_gate.record_store Extension storage exposes a word-only carded-word store for duplicate-card gating.
  cardedWords: KeyValueStore<CardedWordRecord>;
}

type StoreName = "lexicon" | "glossCache" | "cardCache" | "cardedWords";

export function createExtensionStorage(): ExtensionStorage {
  return {
    settings: createChromeSettingsStore(),
    lexicon: createLexiconStore(),
    glossCache: createGlossCacheStore(),
    cardCache: createIndexedStore<AnkiCardOutput>("cardCache"),
    cardedWords: createIndexedStore<CardedWordRecord>("cardedWords")
  };
}

function createChromeSettingsStore(): SettingsStore {
  return {
    async get() {
      const runtimeSettings = await readChromeLocal<StoredGlossaSettings>("settings");
      return mergeStoredSettings(runtimeSettings);
    },
    async set(value) {
      await writeChromeLocal("settings", settingsOverrides(value));
    }
  };
}

function readChromeLocal<T>(key: string): Promise<T | undefined> {
  if (!globalThis.chrome?.storage?.local) {
    return Promise.resolve(undefined);
  }
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(key, (result) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve(result[key] as T | undefined);
    });
  });
}

function writeChromeLocal<T>(key: string, value: T): Promise<void> {
  if (!globalThis.chrome?.storage?.local) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    chrome.storage.local.set({ [key]: value }, () => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve();
    });
  });
}

function createIndexedStore<T>(name: StoreName): KeyValueStore<T> {
  return {
    async get(key) {
      const db = await openDatabase();
      return requestToPromise<T | undefined>(db.transaction(name, "readonly").objectStore(name).get(key));
    },
    async getMany(keys) {
      const uniqueKeys = Array.from(new Set(keys));
      const db = await openDatabase();
      const tx = db.transaction(name, "readonly");
      const store = tx.objectStore(name);
      const entries = await Promise.all(uniqueKeys.map(async (key) => {
        const value = await requestToPromise<T | undefined>(store.get(key));
        return [key, value] as const;
      }));
      await transactionDone(tx);
      const result = new Map<string, T>();
      for (const [key, value] of entries) {
        if (value !== undefined) {
          result.set(key, value);
        }
      }
      return result;
    },
    async put(key, value) {
      const db = await openDatabase();
      const tx = db.transaction(name, "readwrite");
      tx.objectStore(name).put(value, key);
      await transactionDone(tx);
    },
    async delete(key) {
      const db = await openDatabase();
      const tx = db.transaction(name, "readwrite");
      tx.objectStore(name).delete(key);
      await transactionDone(tx);
    },
    async clear() {
      const db = await openDatabase();
      const tx = db.transaction(name, "readwrite");
      tx.objectStore(name).clear();
      await transactionDone(tx);
    }
  };
}

function createGlossCacheStore(): GlossCacheStore {
  const store = createIndexedStore<GlossCacheEntry>("glossCache");
  return {
    ...store,
    async getFresh(key, now, ttlMs) {
      const value = await store.get(key);
      if (!value) {
        return undefined;
      }
      const entry = normalizeGlossCacheEntry(value, now);
      if (entry !== value) {
        // @behavior glossa.cache_identity.gloss_cache_entry.legacy_created_at.single_read_backfill A single fresh read writes back a legacy gloss cache entry with request-time createdAt before returning it.
        await store.put(key, entry);
      }
      // @behavior glossa.cache_identity.gloss_cache_entry.fresh_read.expiry A gloss cache entry past createdAt plus TTL is returned as a cache miss.
      return isFreshGlossCacheEntry(entry, now, ttlMs) ? entry : undefined;
    },
    async getFreshMany(keys, now, ttlMs) {
      const values = await store.getMany(keys);
      const result = new Map<string, GlossCacheEntry>();
      const backfills: Array<Promise<void>> = [];
      for (const [key, value] of values) {
        const entry = normalizeGlossCacheEntry(value, now);
        if (entry !== value) {
          // @behavior glossa.cache_identity.gloss_cache_entry.legacy_created_at.batch_read_backfill A batched fresh read writes back each legacy gloss cache entry with request-time createdAt before returning it.
          backfills.push(store.put(key, entry));
        }
        // @behavior glossa.cache_identity.gloss_cache_entry.fresh_read_many.expiry Batched gloss cache reads omit entries past createdAt plus TTL.
        if (isFreshGlossCacheEntry(entry, now, ttlMs)) {
          result.set(key, entry);
        }
      }
      await Promise.all(backfills);
      return result;
    }
  };
}

function isFreshGlossCacheEntry(value: GlossCacheEntry, now: number, ttlMs: number): boolean {
  return now < value.createdAt + ttlMs;
}

function normalizeGlossCacheEntry(value: GlossCacheEntry, now: number): GlossCacheEntry {
  if (Number.isFinite(value.createdAt)) {
    return value;
  }
  // @behavior glossa.cache_identity.gloss_cache_entry.legacy_created_at Legacy gloss cache entries without createdAt receive request time before TTL freshness is evaluated.
  return { ...value, createdAt: now };
}

function createLexiconStore(): LexiconStore {
  const store = createIndexedStore<VocabularyRecord>("lexicon");
  return {
    get: store.get,
    getMany: store.getMany,
    // @behavior glossa.word_memory.known_management.store_read Known-word management reads lexicon records by state from IndexedDB.
    async listByState(state) {
      const db = await openDatabase();
      const tx = db.transaction("lexicon", "readonly");
      const values = await requestToPromise<VocabularyRecord[]>(tx.objectStore("lexicon").getAll());
      await transactionDone(tx);
      return values
        .filter((record) => record.state === state)
        .sort((left, right) => left.lemma.localeCompare(right.lemma));
    },
    put(record) {
      return store.put(record.key, record);
    },
    // @constraint glossa.extension_storage.typed_access.lexicon_delete_impl Lexicon deletion delegates to the shared IndexedDB key-value delete operation.
    delete(key) {
      return store.delete(key);
    }
  };
}

let databasePromise: Promise<IDBDatabase> | undefined;

function openDatabase(): Promise<IDBDatabase> {
  databasePromise ??= new Promise((resolve, reject) => {
    // @constraint glossa.card_creation.duplicate_gate.record_store_upgrade IndexedDB schema version 2 creates the carded-word object store.
    const request = indexedDB.open("glossa", 2);
    request.onupgradeneeded = () => {
      const db = request.result;
      for (const store of ["lexicon", "glossCache", "cardCache", "cardedWords"] satisfies StoreName[]) {
        if (!db.objectStoreNames.contains(store)) {
          db.createObjectStore(store);
        }
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return databasePromise;
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}
