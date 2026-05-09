import { chromium, expect, test, type BrowserContext, type CDPSession, type Page, type Worker } from "@playwright/test";
import { resolve } from "node:path";

// @verifies glossa.extension_contracts.restart_continuity
test("extension service worker handles settings messages after restart", async () => {
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
  } finally {
    await context.close();
  }
});

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
