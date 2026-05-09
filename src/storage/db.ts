// @intent glossa.extension_storage Settings, vocabulary records, and gloss cache entries stay inside extension-owned storage.
// @intent glossa.extension_storage.typed_access Settings, lexicon, and cache storage use one typed asynchronous access contract.
import type { AnkiCardOutput, GlossaSettings, GlossItem, VocabularyRecord } from "../shared/types";
import { DEFAULT_SETTINGS } from "../shared/types";

export interface KeyValueStore<T> {
  get(key: string): Promise<T | undefined>;
  getMany(keys: string[]): Promise<Map<string, T>>;
  put(key: string, value: T): Promise<void>;
}

export interface LexiconStore {
  get(key: string): Promise<VocabularyRecord | undefined>;
  getMany(keys: string[]): Promise<Map<string, VocabularyRecord>>;
  put(record: VocabularyRecord): Promise<void>;
}

export interface SettingsStore {
  get(): Promise<GlossaSettings>;
  set(value: GlossaSettings): Promise<void>;
}

export interface ExtensionStorage {
  settings: SettingsStore;
  lexicon: LexiconStore;
  glossCache: KeyValueStore<GlossItem>;
  cardCache: KeyValueStore<AnkiCardOutput & { noteIds?: number[] }>;
}

type StoreName = "lexicon" | "glossCache" | "cardCache";

export function createExtensionStorage(): ExtensionStorage {
  return {
    settings: createChromeSettingsStore(),
    lexicon: createLexiconStore(),
    glossCache: createIndexedStore<GlossItem>("glossCache"),
    cardCache: createIndexedStore<AnkiCardOutput & { noteIds?: number[] }>("cardCache")
  };
}

function createChromeSettingsStore(): SettingsStore {
  return {
    async get() {
      const runtimeSettings = await readChromeLocal<Partial<GlossaSettings>>("settings");
      return mergeSettings(runtimeSettings);
    },
    async set(value) {
      await writeChromeLocal("settings", value);
    }
  };
}

function mergeSettings(value: Partial<GlossaSettings> | undefined): GlossaSettings {
  const ai = { ...DEFAULT_SETTINGS.ai, ...value?.ai };
  return {
    ...DEFAULT_SETTINGS,
    ...value,
    translateShortcutKey: value?.translateShortcutKey ?? DEFAULT_SETTINGS.translateShortcutKey,
    autoTranslateEnabled: value?.autoTranslateEnabled ?? DEFAULT_SETTINGS.autoTranslateEnabled,
    knownWordList: value?.knownWordList ?? DEFAULT_SETTINGS.knownWordList,
    appearance: { ...DEFAULT_SETTINGS.appearance, ...value?.appearance },
    prompts: { ...DEFAULT_SETTINGS.prompts, ...value?.prompts },
    ai: { ...ai, endpoint: ai.endpoint || defaultEndpointForProvider(ai.provider) },
    anki: { ...DEFAULT_SETTINGS.anki, ...value?.anki }
  };
}

function defaultEndpointForProvider(provider: GlossaSettings["ai"]["provider"]): string {
  if (provider === "openai-chat-completions") {
    return "https://api.openai.com/v1/chat/completions";
  }
  if (provider === "openai-completions") {
    return "https://api.openai.com/v1/completions";
  }
  if (provider === "glossa-backend") {
    return "http://127.0.0.1:8787";
  }
  return DEFAULT_SETTINGS.ai.endpoint;
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
    }
  };
}

function createLexiconStore(): LexiconStore {
  const store = createIndexedStore<VocabularyRecord>("lexicon");
  return {
    get: store.get,
    getMany: store.getMany,
    put(record) {
      return store.put(record.key, record);
    }
  };
}

let databasePromise: Promise<IDBDatabase> | undefined;

function openDatabase(): Promise<IDBDatabase> {
  databasePromise ??= new Promise((resolve, reject) => {
    const request = indexedDB.open("glossa", 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      for (const store of ["lexicon", "glossCache", "cardCache"] satisfies StoreName[]) {
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
