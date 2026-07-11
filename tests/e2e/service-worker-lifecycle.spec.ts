import { chromium, expect, test, type BrowserContext, type CDPSession, type Page, type Worker } from "@playwright/test";
import { resolve } from "node:path";

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

    await seedCardHistory(page);
    page.once("dialog", (dialog) => {
      void dialog.accept();
    });
    await page.locator("#reset-card-history").click();
    await expect(page.locator("#anki-status")).toHaveText("制卡记录已重置，Anki 中已有卡片保持不变");
    await expect.poll(() => readCardHistory(page)).toEqual({ cardCache: 0, cardedWords: 0, noteIds: 0 });
  } finally {
    await context.close();
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
      const request = indexedDB.open("glossa", 2);
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
            noteIds: (lexicon.result as Array<{ ankiNoteIds: number[] }>).reduce((total, record) => total + record.ankiNoteIds.length, 0)
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
