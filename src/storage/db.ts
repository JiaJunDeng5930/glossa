import type { AnkiCardOutput, CardedWordRecord, GlossaSettings, GlossCacheEntry, VocabularyRecord, VocabularyState } from "../shared/types";
import { mergeStoredSettings, settingsOverrides, type StoredGlossaSettings } from "../shared/settings";

export interface KeyValueStore<T> {
  get(key: string): Promise<T | undefined>;
  getMany(keys: string[]): Promise<Map<string, T>>;
  put(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
  clear(): Promise<void>;
}

export interface GlossCacheStore extends KeyValueStore<GlossCacheEntry> {
  getFresh(key: string, now: number, ttlMs: number): Promise<GlossCacheEntry | undefined>;
  getFreshMany(keys: string[], now: number, ttlMs: number): Promise<Map<string, GlossCacheEntry>>;
}

export interface LexiconStore {
  get(key: string): Promise<VocabularyRecord | undefined>;
  getMany(keys: string[]): Promise<Map<string, VocabularyRecord>>;
  listByState(state: VocabularyState): Promise<VocabularyRecord[]>;
  put(record: VocabularyRecord): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface SettingsStore {
  get(): Promise<GlossaSettings>;
  set(value: GlossaSettings): Promise<void>;
}

export interface ExtensionStorage {
  settings: SettingsStore;
  glossCache: GlossCacheStore;
  lexicon: LexiconStore;
  cardCache: KeyValueStore<AnkiCardOutput>;
  cardedWords: KeyValueStore<CardedWordRecord>;
  resetCardHistory(): Promise<void>;
}

type StoreName = "lexicon" | "glossCache" | "cardCache" | "cardedWords";

export function createExtensionStorage(): ExtensionStorage {
  return {
    settings: createChromeSettingsStore(),
    lexicon: createLexiconStore(),
    glossCache: createGlossCacheStore(),
    cardCache: createIndexedStore<AnkiCardOutput>("cardCache"),
    cardedWords: createIndexedStore<CardedWordRecord>("cardedWords"),
    resetCardHistory
  };
}

// @behavior glossa.card_creation.history_reset.storage_transaction Card caches, duplicate markers, and lexicon note ids are cleared in one IndexedDB transaction.
async function resetCardHistory(): Promise<void> {
  const db = await openDatabase();
  const tx = db.transaction(["cardCache", "cardedWords", "lexicon"], "readwrite");
  const done = transactionDone(tx);
  tx.objectStore("cardCache").clear();
  tx.objectStore("cardedWords").clear();
  const lexicon = tx.objectStore("lexicon");
  const cursorRequest = lexicon.openCursor();
  const cursorDone = new Promise<void>((resolve, reject) => {
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result;
      if (!cursor) {
        resolve();
        return;
      }
      const record = cursor.value as VocabularyRecord;
      if (record.ankiNoteIds.length > 0) {
        cursor.update({ ...record, ankiNoteIds: [] });
      }
      cursor.continue();
    };
    cursorRequest.onerror = () => reject(cursorRequest.error);
  });
  await Promise.all([cursorDone, done]);
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
        await store.put(key, entry);
      }
      return isFreshGlossCacheEntry(entry, now, ttlMs) ? entry : undefined;
    },
    async getFreshMany(keys, now, ttlMs) {
      const values = await store.getMany(keys);
      const result = new Map<string, GlossCacheEntry>();
      const backfills: Array<Promise<void>> = [];
      for (const [key, value] of values) {
        const entry = normalizeGlossCacheEntry(value, now);
        if (entry !== value) {
          backfills.push(store.put(key, entry));
        }
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
  return { ...value, createdAt: now };
}

function createLexiconStore(): LexiconStore {
  const store = createIndexedStore<VocabularyRecord>("lexicon");
  return {
    get: store.get,
    getMany: store.getMany,
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
    delete(key) {
      return store.delete(key);
    }
  };
}

let databasePromise: Promise<IDBDatabase> | undefined;

function openDatabase(): Promise<IDBDatabase> {
  databasePromise ??= new Promise((resolve, reject) => {
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
