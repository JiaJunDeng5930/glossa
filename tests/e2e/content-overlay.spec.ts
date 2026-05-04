import { expect, test } from "@playwright/test";
import { resolve } from "node:path";

test("content bundle renders inline glosses and captures shortcut word selection", async ({ page }) => {
  const messages: unknown[] = [];
  await page.setContent(`
    <main>
      <p>Press the submit button to finish.</p>
      <button id="save">Save draft</button>
      <script>
        window.buttonClicks = 0;
        document.querySelector("#save").addEventListener("click", () => { window.buttonClicks += 1; });
      </script>
    </main>
  `);
  await page.evaluate(() => {
    const sent: unknown[] = [];
    Reflect.set(window, "__glossaMessages", sent);
    Reflect.set(window, "chrome", {
      runtime: {
        getURL: () => "/missing-known-word-list.txt",
        sendMessage(message: { type: string; requestId: string; source: "content-script" }, callback?: (response: unknown) => void) {
          sent.push(message);
          const response = message.type === "settings.get"
            ? {
              type: "settings.response",
              version: 1,
              requestId: message.requestId,
              source: "service-worker",
              target: message.source,
              createdAt: Date.now(),
              payload: {
              settings: {
                shortcutKey: "Alt",
                knownWordList: "junior-high",
                appearance: {
                  textColor: "#ff5500",
                  backgroundColor: "#113355",
                  backgroundOpacity: 0.65,
                  fontFamily: "Georgia, Times New Roman, serif",
                  fontSize: 18
                }
              }
              }
            }
            : message.type === "gloss.request"
              ? {
                type: "gloss.response",
                version: 1,
                requestId: message.requestId,
                source: "service-worker",
                target: message.source,
                createdAt: Date.now(),
                payload: { items: [{ tokenId: "t1", targetText: "submit", display: "提交" }] }
              }
              : {
                type: "word.clicked.ok",
                version: 1,
                requestId: message.requestId,
                source: "service-worker",
                target: message.source,
                createdAt: Date.now(),
                payload: { noteId: 7 }
              };
          callback?.(response);
          return Promise.resolve(response);
        }
      }
    });
  });
  await page.addScriptTag({ type: "module", path: resolve("dist/content.js") });

  await expect(page.locator("#glossa-overlay")).toHaveCount(1);
  await expect(page.locator("#glossa-overlay")).toHaveCSS("--glossa-text-color", "#ff5500");
  await expect(page.locator("#glossa-overlay")).toHaveCSS("--glossa-bg-alpha", "65%");
  await expect(page.locator("#glossa-overlay")).toHaveCSS("--glossa-font-size", "18px");
  await page.waitForFunction(() => {
    const sent = Reflect.get(window, "__glossaMessages") as Array<{ type: string }>;
    return sent.some((message) => message.type === "gloss.request");
  });
  await page.keyboard.down("Alt");
  await page.locator("#save").click();
  await page.keyboard.up("Alt");

  expect(await page.evaluate(() => Reflect.get(window, "buttonClicks"))).toBe(0);
  messages.push(...await page.evaluate(() => Reflect.get(window, "__glossaMessages") as unknown[]));
  expect(messages).toEqual(expect.arrayContaining([
    expect.objectContaining({ type: "gloss.request" }),
    expect.objectContaining({ type: "word.clicked" })
  ]));
});

test("content bundle scans text added after boot", async ({ page }) => {
  await page.setContent("<main id=\"app\"></main>");
  await page.evaluate(() => {
    const sent: unknown[] = [];
    Reflect.set(window, "__glossaMessages", sent);
    Reflect.set(window, "chrome", {
      runtime: {
        getURL: () => "/missing-known-word-list.txt",
        sendMessage(message: { type: string; requestId: string; source: "content-script"; payload?: { sentences?: Array<{ tokens: Array<{ id: string; surface: string }> }> } }, callback?: (response: unknown) => void) {
          sent.push(message);
          const dynamicToken = message.payload?.sentences
            ?.flatMap((sentence) => sentence.tokens)
            .find((token) => token.surface.toLowerCase() === "dynamic");
          const response = message.type === "settings.get"
            ? {
              type: "settings.response",
              version: 1,
              requestId: message.requestId,
              source: "service-worker",
              target: message.source,
              createdAt: Date.now(),
              payload: { settings: { shortcutKey: "Alt", knownWordList: "junior-high" } }
            }
            : message.type === "gloss.request" && dynamicToken
              ? {
                type: "gloss.response",
                version: 1,
                requestId: message.requestId,
                source: "service-worker",
                target: message.source,
                createdAt: Date.now(),
                payload: { items: [{ tokenId: dynamicToken.id, targetText: dynamicToken.surface, display: "动态" }] }
              }
              : {
                type: "gloss.response",
                version: 1,
                requestId: message.requestId,
                source: "service-worker",
                target: message.source,
                createdAt: Date.now(),
                payload: { items: [] }
              };
          callback?.(response);
          return Promise.resolve(response);
        }
      }
    });
  });
  await page.addScriptTag({ type: "module", path: resolve("dist/content.js") });
  await page.locator("#app").evaluate((element) => {
    element.textContent = "A dynamic paragraph appears after boot.";
  });

  await page.waitForFunction(() => {
    const host = document.querySelector("#glossa-overlay");
    return host?.shadowRoot?.querySelector(".label")?.textContent === "动态";
  });
});
