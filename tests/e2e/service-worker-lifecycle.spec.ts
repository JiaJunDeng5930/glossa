import { chromium, expect, test, type BrowserContext, type CDPSession, type Page, type Worker } from "@playwright/test";
import { resolve } from "node:path";
import { createOptionsMessage } from "../../src/shared/messages";
import {
  launchExtensionFixture,
  openExtensionOriginPage,
  readExtensionDatabase,
  seedLegacyDatabase,
  sendExtensionMessage
} from "../helpers/extensionFixture";

test("extension service worker handles settings and card-history reset after restart", async () => {
  const extensionPath = resolve("dist");
  const context = await chromium.launchPersistentContext("", {
    channel: "chromium",
    headless: true,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`
    ]
  });

  try {
    const serviceWorker = await waitForExtensionWorker(context);
    const extensionId = new URL(serviceWorker.url()).host;
    const seedPage = await context.newPage();
    await seedPage.goto(`chrome-extension://${extensionId}/manifest.json`);
    await seedCardHistory(seedPage);
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/options/options.html`);

    const first = await requestSettings(page);
    await stopServiceWorker(context, page, serviceWorker.url());
    const second = await requestSettings(page);

    expect(first).toMatchObject({
      type: "settings.response",
      source: "service-worker",
      target: "content-script",
      payload: {
        settings: {
          shortcutKey: "Alt",
          knownWordList: "junior-high"
        }
      }
    });
    expect(second).toMatchObject({
      type: "settings.response",
      source: "service-worker",
      target: "content-script",
      payload: {
        settings: {
          shortcutKey: "Alt",
          knownWordList: "junior-high"
        }
      }
    });
    expect(second.requestId).not.toBe(first.requestId);

    page.once("dialog", (dialog) => {
      void dialog.accept();
    });
    await page.locator("#reset-card-history").click();
    await expect(page.locator("#anki-status")).toHaveText("制卡记录已重置，Anki 中已有的卡片已保留");
    await expect.poll(() => readCardHistory(page)).toEqual({ cardCache: 0, cardedWords: 0, noteIds: 0 });
  } finally {
    await context.close();
  }
});

test("extension worker upgrades legacy IndexedDB state during a real restart", async () => {
  const fixture = await launchExtensionFixture();
  try {
    const page = await openExtensionOriginPage(fixture.context, fixture.extensionOrigin);
    const seed = await seedLegacyDatabase(page);
    await stopServiceWorker(fixture.context, page, fixture.worker.url());

    const response = await sendExtensionMessage(page, createOptionsMessage("known.words.list", {}));
    expect(response).toMatchObject({
      type: "known.words.list.result",
      source: "service-worker",
      target: "options",
      payload: {
        records: expect.arrayContaining([
          expect.objectContaining({ key: seed.historyKey, state: "known" }),
          expect.objectContaining({ key: seed.existingMarkerKey, state: "known" })
        ])
      }
    });

    const snapshot = await readExtensionDatabase(page);
    expect(snapshot.version).toBe(3);
    expect(snapshot.cardCache).toHaveLength(0);

    const migrated = snapshot.lexicon.find((record) => record.key === seed.historyKey);
    expect(migrated).toMatchObject({
      key: seed.historyKey,
      state: "known",
      lastShownAt: 400,
      lastClickedAt: 500
    });
    expect(migrated).not.toHaveProperty("shownCount");
    expect(migrated).not.toHaveProperty("clickCount");
    expect(migrated).not.toHaveProperty("ankiNoteIds");

    const migratedMarker = snapshot.cardedWords.find((record) => record.key === seed.historyKey);
    expect(migratedMarker).toMatchObject({ key: seed.historyKey, createdAt: 500 });
    const existingMarker = snapshot.cardedWords.find((record) => record.key === seed.existingMarkerKey);
    expect(existingMarker).toMatchObject({ key: seed.existingMarkerKey, createdAt: 777 });
    expect(snapshot.lexicon.every((record) => !("shownCount" in record) && !("clickCount" in record) && !("ankiNoteIds" in record))).toBe(true);
  } finally {
    await fixture.close();
  }
});

async function seedCardHistory(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open("glossa", 2);
      request.onupgradeneeded = () => {
        for (const store of ["lexicon", "glossCache", "cardCache", "cardedWords"]) {
          if (!request.result.objectStoreNames.contains(store)) {
            request.result.createObjectStore(store);
          }
        }
      };
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction(["cardCache", "cardedWords", "lexicon"], "readwrite");
        tx.objectStore("cardCache").put({ cards: [{ front: "old", back: "旧" }] }, "old-card");
        tx.objectStore("cardedWords").put({ key: "en:old", lang: "en", lemma: "old", createdAt: 1 }, "en:old");
        tx.objectStore("lexicon").put({
          key: "en:old",
          lang: "en",
          lemma: "old",
          surface: "old",
          state: "learning_active",
          shownCount: 1,
          clickCount: 1,
          ankiNoteIds: [42]
        }, "en:old");
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      };
      request.onerror = () => reject(request.error);
    });
  });
}

async function readCardHistory(page: Page): Promise<{ cardCache: number; cardedWords: number; noteIds: number }> {
  return await page.evaluate(async () => {
    return await new Promise<{ cardCache: number; cardedWords: number; noteIds: number }>((resolve, reject) => {
      const request = indexedDB.open("glossa");
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction(["cardCache", "cardedWords", "lexicon"], "readonly");
        const cardCache = tx.objectStore("cardCache").count();
        const cardedWords = tx.objectStore("cardedWords").count();
        const lexicon = tx.objectStore("lexicon").getAll();
        tx.oncomplete = () => {
          db.close();
          resolve({
            cardCache: cardCache.result,
            cardedWords: cardedWords.result,
            noteIds: (lexicon.result as Array<{ ankiNoteIds?: unknown }>).reduce((total, record) => {
              return total + (Array.isArray(record.ankiNoteIds) ? record.ankiNoteIds.length : 0);
            }, 0)
          });
        };
        tx.onerror = () => reject(tx.error);
      };
      request.onerror = () => reject(request.error);
    });
  });
}

async function requestSettings(page: Page): Promise<{ type: string; requestId: string; source: string; target: string; payload: unknown }> {
  return await page.evaluate<{ type: string; requestId: string; source: string; target: string; payload: unknown }>(() => {
    const request = {
      type: "settings.get",
      version: 1,
      requestId: crypto.randomUUID(),
      source: "content-script",
      target: "service-worker",
      createdAt: Date.now(),
      payload: {}
    };
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(request, (response) => {
        const error = chrome.runtime.lastError;
        if (error) {
          reject(new Error(error.message));
          return;
        }
        resolve(response);
      });
    });
  });
}

async function waitForExtensionWorker(context: BrowserContext): Promise<Worker> {
  const existing = context.serviceWorkers().find((worker) => worker.url().startsWith("chrome-extension://"));
  if (existing) {
    return existing;
  }
  const worker = await context.waitForEvent("serviceworker");
  if (!worker.url().startsWith("chrome-extension://")) {
    return waitForExtensionWorker(context);
  }
  return worker;
}

async function stopServiceWorker(context: BrowserContext, page: Page, scriptUrl: string): Promise<void> {
  const session = await context.newCDPSession(page);
  try {
    const version = await waitForRunningServiceWorkerVersion(session, scriptUrl);
    await session.send("ServiceWorker.stopWorker", { versionId: version.versionId });
  } finally {
    await session.detach();
  }
}

async function waitForRunningServiceWorkerVersion(session: CDPSession, scriptUrl: string): Promise<{ versionId: string }> {
  const versions: Array<{ versionId: string; scriptURL: string; runningStatus: string }> = [];
  session.on("ServiceWorker.workerVersionUpdated", (event) => {
    versions.splice(0, versions.length, ...event.versions);
  });
  await session.send("ServiceWorker.enable");
  const existing = versions.find((version) => version.scriptURL === scriptUrl && version.runningStatus === "running");
  if (existing) {
    return existing;
  }
  return await new Promise((resolve) => {
    session.on("ServiceWorker.workerVersionUpdated", (event) => {
      const version = event.versions.find((item: { scriptURL: string; runningStatus: string }) => {
        return item.scriptURL === scriptUrl && item.runningStatus === "running";
      });
      if (version) {
        resolve(version);
      }
    });
  });
}
