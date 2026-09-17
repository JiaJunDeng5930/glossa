import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { chromium, type BrowserContext, type Page, type Worker } from "@playwright/test";

const DATABASE_NAME = "glossa";

export const REAL_EXTENSION_WORD = "sesquipedalian";
export const REAL_EXTENSION_GLOSS = "测试释义";
export const REAL_EXTENSION_CARD_BACK = "罕见的";

export interface ExtensionNetworkCapture {
  glossRequests: unknown[];
  ankiCardRequests: unknown[];
  ankiRequests: unknown[];
}

export interface ExtensionHttpFixture {
  origin: string;
  pageUrl: string;
  aiEndpoint: string;
  ankiEndpoint: string;
  targetWord: string;
  glossDisplay: string;
  cardBack: string;
  requests: ExtensionNetworkCapture;
  close(): Promise<void>;
}

export interface ExtensionFixture {
  context: BrowserContext;
  worker: Worker;
  extensionId: string;
  extensionOrigin: string;
  http: ExtensionHttpFixture;
  close(): Promise<void>;
}

export interface ExtensionDatabaseSnapshot {
  version: number;
  stores: string[];
  lexicon: Array<Record<string, unknown>>;
  cardCache: Array<Record<string, unknown>>;
  cardedWords: Array<Record<string, unknown>>;
  glossCache: Array<Record<string, unknown>>;
}

export interface LegacyDatabaseSeed {
  historyKey: string;
  existingMarkerKey: string;
  cacheKey: string;
}

export async function createExtensionHttpFixture(options: {
  targetWord?: string;
  glossDisplay?: string;
  cardBack?: string;
  sentence?: string;
} = {}): Promise<ExtensionHttpFixture> {
  const targetWord = options.targetWord ?? REAL_EXTENSION_WORD;
  const glossDisplay = options.glossDisplay ?? REAL_EXTENSION_GLOSS;
  const cardBack = options.cardBack ?? REAL_EXTENSION_CARD_BACK;
  const sentence = options.sentence ?? `The ${targetWord} sentence gives the word a clear context.`;
  const requests: ExtensionNetworkCapture = {
    glossRequests: [],
    ankiCardRequests: [],
    ankiRequests: []
  };
  let nextNoteId = 10_001;
  const server = createServer(async (request, response) => {
    setCorsHeaders(response);
    if (request.method === "OPTIONS") {
      response.writeHead(204);
      response.end();
      return;
    }
    if (request.method === "GET" && request.url === "/fixture.html") {
      writeResponse(response, 200, "text/html; charset=utf-8", `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>Glossa extension fixture</title></head>
  <body>
    <main style="padding: 48px; font: 24px/1.7 sans-serif;">${escapeHtml(sentence)}</main>
  </body>
</html>`);
      return;
    }
    if (request.method !== "POST") {
      writeJson(response, 404, { error: "not-found" });
      return;
    }
    const body = await readJson(request);
    if (request.url === "/gloss") {
      requests.glossRequests.push(body);
      writeJson(response, 200, { items: glossItemsFrom(body, glossDisplay) });
      return;
    }
    if (request.url === "/anki-card") {
      requests.ankiCardRequests.push(body);
      writeJson(response, 200, { cards: [{ front: `The <b>${targetWord}</b> sentence gives the word a clear context.`, back: cardBack }] });
      return;
    }
    if (request.url === "/anki-connect") {
      requests.ankiRequests.push(body);
      const action = isRecord(body) && typeof body.action === "string" ? body.action : "";
      if (action === "addNote") {
        writeJson(response, 200, { result: nextNoteId++, error: null });
      } else if (action === "version") {
        writeJson(response, 200, { result: 6, error: null });
      } else if (action === "deckNames") {
        writeJson(response, 200, { result: ["Glossa"], error: null });
      } else if (action === "modelNames") {
        writeJson(response, 200, { result: ["Basic"], error: null });
      } else if (action === "modelFieldNames") {
        writeJson(response, 200, { result: ["Front", "Back"], error: null });
      } else {
        writeJson(response, 400, { result: null, error: `Unsupported fixture action: ${action}` });
      }
      return;
    }
    writeJson(response, 404, { error: "not-found" });
  });
  await listen(server);
  const address = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${address.port}`;
  return {
    origin,
    pageUrl: `${origin}/fixture.html`,
    aiEndpoint: origin,
    ankiEndpoint: `${origin}/anki-connect`,
    targetWord,
    glossDisplay,
    cardBack,
    requests,
    close: () => closeServer(server)
  };
}

export async function launchExtensionFixture(options: {
  targetWord?: string;
  glossDisplay?: string;
  cardBack?: string;
  sentence?: string;
} = {}): Promise<ExtensionFixture> {
  const http = await createExtensionHttpFixture(options);
  const extensionPath = resolve("dist");
  let context: BrowserContext | undefined;
  try {
    context = await chromium.launchPersistentContext("", {
      channel: "chromium",
      headless: true,
      args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`
      ]
    });
    const worker = await waitForExtensionWorker(context);
    const extensionId = new URL(worker.url()).host;
    const extensionOrigin = `chrome-extension://${extensionId}`;
    return {
      context,
      worker,
      extensionId,
      extensionOrigin,
      http,
      close: async () => {
        await context!.close();
        await http.close();
      }
    };
  } catch (error) {
    await context?.close().catch(() => undefined);
    await http.close();
    throw error;
  }
}

export async function openExtensionOriginPage(context: BrowserContext, extensionOrigin: string): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`${extensionOrigin}/manifest.json`);
  return page;
}

export async function sendExtensionMessage(page: Page, message: unknown): Promise<unknown> {
  return await page.evaluate((request) => new Promise<unknown>((resolve, reject) => {
    chrome.runtime.sendMessage(request, (response: unknown) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve(response);
    });
  }), message);
}

export function createRuntimeRequest(source: "options" | "content-script", type: string, payload: unknown): Record<string, unknown> {
  return {
    type,
    version: 1,
    requestId: randomUUID(),
    source,
    target: "service-worker",
    createdAt: Date.now(),
    payload
  };
}

export async function readExtensionDatabase(page: Page): Promise<ExtensionDatabaseSnapshot> {
  return await page.evaluate(async (databaseName) => {
    return await new Promise<ExtensionDatabaseSnapshot>((resolve, reject) => {
      const request = indexedDB.open(databaseName);
      request.onupgradeneeded = () => {
        request.transaction?.abort();
        reject(new Error("Expected an existing Glossa database"));
      };
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        const stores = Array.from(db.objectStoreNames);
        const required = ["lexicon", "cardCache", "cardedWords", "glossCache"];
        if (!required.every((name) => stores.includes(name))) {
          db.close();
          reject(new Error(`Missing Glossa stores: ${stores.join(",")}`));
          return;
        }
        const tx = db.transaction(required, "readonly");
        const values = new Map<string, Array<Record<string, unknown>>>();
        for (const name of required) {
          const getAll = tx.objectStore(name).getAll();
          getAll.onsuccess = () => values.set(name, getAll.result as Array<Record<string, unknown>>);
        }
        tx.oncomplete = () => {
          db.close();
          resolve({
            version: db.version,
            stores,
            lexicon: values.get("lexicon") ?? [],
            cardCache: values.get("cardCache") ?? [],
            cardedWords: values.get("cardedWords") ?? [],
            glossCache: values.get("glossCache") ?? []
          });
        };
        tx.onerror = () => {
          db.close();
          reject(tx.error);
        };
      };
    });
  }, DATABASE_NAME);
}

export async function seedLegacyDatabase(page: Page): Promise<LegacyDatabaseSeed> {
  const seed = {
    historyKey: "en:migrated",
    existingMarkerKey: "en:existing-marker",
    cacheKey: "legacy-card-cache"
  } satisfies LegacyDatabaseSeed;
  await page.evaluate(async ({ databaseName, seed }) => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open(databaseName, 2);
      request.onupgradeneeded = () => {
        const db = request.result;
        for (const name of ["lexicon", "glossCache", "cardCache", "cardedWords"]) {
          if (!db.objectStoreNames.contains(name)) db.createObjectStore(name);
        }
      };
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        if (db.version !== 2) {
          db.close();
          reject(new Error(`Expected a version 2 seed database, got ${db.version}`));
          return;
        }
        const tx = db.transaction(["lexicon", "glossCache", "cardCache", "cardedWords"], "readwrite");
        tx.objectStore("lexicon").put({
          key: seed.historyKey,
          lang: "en",
          lemma: "migrated",
          surface: "migrated",
          state: "known",
          shownCount: 4,
          clickCount: 2,
          ankiNoteIds: [42],
          lastShownAt: 400,
          lastClickedAt: 500
        }, seed.historyKey);
        tx.objectStore("lexicon").put({
          key: "en:plain",
          lang: "en",
          lemma: "plain",
          surface: "plain",
          state: "candidate",
          shownCount: 1,
          clickCount: 0,
          ankiNoteIds: []
        }, "en:plain");
        tx.objectStore("lexicon").put({
          key: seed.existingMarkerKey,
          lang: "en",
          lemma: "existing-marker",
          surface: "existing-marker",
          state: "known",
          ankiNoteIds: [55],
          lastClickedAt: 123
        }, seed.existingMarkerKey);
        tx.objectStore("cardedWords").put({
          key: seed.existingMarkerKey,
          lang: "en",
          lemma: "existing-marker",
          createdAt: 777
        }, seed.existingMarkerKey);
        tx.objectStore("cardCache").put({ cards: [{ front: "old", back: "旧" }] }, seed.cacheKey);
        tx.objectStore("glossCache").put({ tokenId: "old", targetText: "old", display: "旧", createdAt: 1 }, "legacy-gloss");
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => {
          db.close();
          reject(tx.error);
        };
        tx.onabort = () => {
          db.close();
          reject(tx.error);
        };
      };
    });
  }, { databaseName: DATABASE_NAME, seed });
  return seed;
}

function glossItemsFrom(body: unknown, display: string): Array<Record<string, unknown>> {
  const items = isRecord(body) && Array.isArray(body.items) ? body.items : [];
  return items.map((item, index) => {
    const value = isRecord(item) ? item : {};
    const token = isRecord(value.token) ? value.token : value;
    const requestItemId = typeof value.requestItemId === "string"
      ? value.requestItemId
      : typeof value.tokenId === "string" ? value.tokenId : `fixture-item-${index}`;
    const surface = typeof token.surface === "string" ? token.surface : "fixture";
    return { requestItemId, value: { targetText: surface, display } };
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const body = Buffer.concat(chunks).toString("utf8");
  if (!body) return {};
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return undefined;
  }
}

function writeJson(response: ServerResponse, status: number, body: unknown): void {
  writeResponse(response, status, "application/json; charset=utf-8", JSON.stringify(body));
}

function writeResponse(response: ServerResponse, status: number, contentType: string, body: string): void {
  response.writeHead(status, { "content-type": contentType });
  response.end(body);
}

function setCorsHeaders(response: ServerResponse): void {
  response.setHeader("access-control-allow-origin", "*");
  response.setHeader("access-control-allow-headers", "content-type, authorization");
  response.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[character]!);
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING" ? reject(error) : resolve());
  });
}

async function waitForExtensionWorker(context: BrowserContext): Promise<Worker> {
  const existing = context.serviceWorkers().find((worker) => worker.url().startsWith("chrome-extension://"));
  if (existing) return existing;
  return await context.waitForEvent("serviceworker", { predicate: (worker) => worker.url().startsWith("chrome-extension://") });
}
