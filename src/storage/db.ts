import { createCandidateRecord, markRecordClicked, normalizeLemma, vocabularyKey } from "../core/state";
import type { AnkiCard, CardedWordRecord, GlossaSettings, GlossCacheEntry, VocabularyRecord, VocabularyState } from "../shared/types";
import { mergeStoredSettings, settingsOverrides, type StoredGlossaSettings } from "../shared/settings";

export interface KeyValueStore<T> {
  get(key: string): Promise<T | undefined>;
  getMany(keys: string[]): Promise<Map<string, T>>;
  put(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
  clear(): Promise<void>;
}

export interface GlossCacheStore extends KeyValueStore<GlossCacheEntry> {
  getFreshMany(keys: string[], now: number, ttlMs: number): Promise<Map<string, GlossCacheEntry>>;
}

export interface LexiconStore {
  get(key: string): Promise<VocabularyRecord | undefined>;
  getMany(keys: string[]): Promise<Map<string, VocabularyRecord>>;
  listByState(state: VocabularyState): Promise<VocabularyRecord[]>;
  update(
    key: string,
    transition: (current: VocabularyRecord | undefined) => VocabularyRecord | undefined
  ): Promise<VocabularyRecord | undefined>;
  put(record: VocabularyRecord): Promise<void>;
  delete(key: string): Promise<void>;
  addKnown(lemma: string, now: number): Promise<void>;
  removeKnown(lemma: string): Promise<void>;
  clearKnown(): Promise<void>;
}

export interface SettingsStore {
  get(): Promise<GlossaSettings>;
  set(value: GlossaSettings): Promise<void>;
}

export interface ExtensionStorage {
  settings: SettingsStore;
  glossCache: GlossCacheStore;
  lexicon: LexiconStore;
  cardCache: KeyValueStore<AnkiCard>;
  cardedWords: KeyValueStore<CardedWordRecord>;
  recordCardCreated(input: { lang: "en"; lemma: string; surface: string; createdAt: number; learningWindowDays: number }): Promise<void>;
  resetCardHistory(): Promise<void>;
}

type StoreName = "lexicon" | "glossCache" | "cardCache" | "cardedWords";

export function createExtensionStorage(): ExtensionStorage {
  return {
    settings: createChromeSettingsStore(),
    lexicon: createLexiconStore(),
    glossCache: createGlossCacheStore(),
    cardCache: createIndexedStore<AnkiCard>("cardCache"),
    cardedWords: createIndexedStore<CardedWordRecord>("cardedWords"),
    recordCardCreated,
    resetCardHistory
  };
}

async function recordCardCreated(input: { lang: "en"; lemma: string; surface: string; createdAt: number; learningWindowDays: number }): Promise<void> {
  const db = await openDatabase();
  const tx = db.transaction(["lexicon", "cardedWords"], "readwrite");
  const done = transactionDone(tx);
  const store = tx.objectStore("lexicon");
  const key = vocabularyKey(input.lang, input.lemma);
  const request = store.get(key);
  request.onsuccess = () => {
    const current = request.result as VocabularyRecord | undefined;
    const candidate = current ?? createCandidateRecord(input.lemma, input.surface, input.lang, input.createdAt);
    store.put(markRecordClicked(candidate, input.createdAt, input.learningWindowDays), key);
    tx.objectStore("cardedWords").put({key,lang:input.lang,lemma:normalizeLemma(input.lemma),createdAt:input.createdAt} satisfies CardedWordRecord,key);
  };
  await done;
}

async function resetCardHistory(): Promise<void> {
  const db = await openDatabase();
  const tx = db.transaction(["cardCache", "cardedWords"], "readwrite");
  const done = transactionDone(tx);
  tx.objectStore("cardCache").clear();
  tx.objectStore("cardedWords").clear();
  await done;
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
    async getFreshMany(keys, now, ttlMs) {
      const values = await store.getMany(keys);
      const result = new Map<string, GlossCacheEntry>();
      for (const [key, value] of values) {
        if (isFreshGlossCacheEntry(value, now, ttlMs)) {
          result.set(key, value);
        }
      }
      return result;
    }
  };
}

function isFreshGlossCacheEntry(value: GlossCacheEntry, now: number, ttlMs: number): boolean {
  return Number.isFinite(value.createdAt) && now < value.createdAt + ttlMs;
}

function createLexiconStore(): LexiconStore {
  const store = createIndexedStore<VocabularyRecord>("lexicon");
  const update: LexiconStore["update"] = async (key, transition) => {
    const db = await openDatabase();
    const tx = db.transaction("lexicon", "readwrite");
    const done = transactionDone(tx);
    const objectStore = tx.objectStore("lexicon");
    let next: VocabularyRecord | undefined;
    const request = objectStore.get(key);
    request.onsuccess = () => {
      try {
        next = transition(request.result as VocabularyRecord | undefined);
        if (next === undefined) objectStore.delete(key); else objectStore.put(next,key);
      } catch { tx.abort(); }
    };
    await done;
    return next;
  };
  return {
    update,
    async addKnown(lemma, now) {
      const normalized = normalizeLemma(lemma);
      if (!normalized) throw new Error("Known word must not be empty");
      await update(vocabularyKey("en", normalized), current => {
        const { expiresAt: _expiresAt, ...record } = current ?? createCandidateRecord(normalized, normalized, "en", now);
        return { ...record, state: "known" };
      });
    },
    async removeKnown(lemma) {
      await update(vocabularyKey("en", lemma), current => current?.state === "known" ? undefined : current);
    },
    async clearKnown() {
      const db = await openDatabase();
      const tx = db.transaction("lexicon", "readwrite");
      const done = transactionDone(tx);
      const request = tx.objectStore("lexicon").openCursor();
      request.onsuccess = () => { const cursor = request.result; if (!cursor) return; if ((cursor.value as VocabularyRecord).state === "known") cursor.delete(); cursor.continue(); };
      await done;
    },
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
    const request = indexedDB.open("glossa", 3);
    request.onupgradeneeded = (event) => {
      const db = request.result;
      for (const store of ["lexicon", "glossCache", "cardCache", "cardedWords"] satisfies StoreName[]) {
        if (!db.objectStoreNames.contains(store)) {
          db.createObjectStore(store);
        }
      }
      if (event.oldVersion < 3) {
        const tx = request.transaction!;
        // Preserve legacy card facts once, then remove fields that no longer own domain behavior.
        const lexicon = tx.objectStore("lexicon");
        const cursorRequest = lexicon.openCursor();
        cursorRequest.onsuccess = () => {
          const cursor = cursorRequest.result;
          if (!cursor) return;
          const { shownCount: _shown, clickCount: _clicked, ankiNoteIds, ...record } = cursor.value as VocabularyRecord & { shownCount?:number; clickCount?:number; ankiNoteIds?:unknown[] };
          if (Array.isArray(ankiNoteIds) && ankiNoteIds.length > 0) {
            const markers = tx.objectStore("cardedWords");
            const existing = markers.get(record.key);
            existing.onsuccess = () => { if (!existing.result) markers.put({key:record.key,lang:record.lang,lemma:record.lemma,createdAt:record.lastClickedAt ?? 0} satisfies CardedWordRecord,record.key); };
          }
          cursor.update(record);
          cursor.continue();
        };
        // Generated data is disposable; old array/card and phrase/gloss formats cannot leak into live reads.
        tx.objectStore("cardCache").clear();
        tx.objectStore("glossCache").clear();
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => { db.close(); databasePromise = undefined; };
      db.onclose = () => { databasePromise = undefined; };
      resolve(db);
    };
    request.onerror = () => { databasePromise = undefined; reject(request.error); };
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
