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
    return document.querySelector("[data-glossa-token-label]")?.textContent === "动态" && host !== null;
  });
});

test("content bundle lays out inline glosses without label or source overlap", async ({ page }) => {
  await page.setContent("<main><p id=\"target\">Obscure archive archive terms appear here.</p></main>");
  await page.evaluate(() => {
    const sent: unknown[] = [];
    Reflect.set(window, "__glossaMessages", sent);
    Reflect.set(window, "chrome", {
      runtime: {
        getURL: () => "/missing-known-word-list.txt",
        sendMessage(message: { type: string; requestId: string; source: "content-script"; payload?: { sentences?: Array<{ tokens: Array<{ id: string; surface: string }> }> } }, callback?: (response: unknown) => void) {
          sent.push(message);
          const tokens = message.payload?.sentences?.flatMap((sentence) => sentence.tokens) ?? [];
          const items = tokens
            .filter((token) => ["obscure", "archive"].includes(token.surface.toLowerCase()))
            .map((token, index) => ({
              tokenId: token.id,
              targetText: token.surface,
              display: index === 0 ? "极其晦涩的词" : "长期归档资料"
            }));
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
                    textColor: "#111111",
                    backgroundColor: "#ffffff",
                    backgroundOpacity: 1,
                    fontFamily: "Arial, sans-serif",
                    fontSize: 16
                  }
                }
              }
            }
            : {
              type: "gloss.response",
              version: 1,
              requestId: message.requestId,
              source: "service-worker",
              target: message.source,
              createdAt: Date.now(),
              payload: { items }
            };
          callback?.(response);
          return Promise.resolve(response);
        }
      }
    });
  });
  await page.addScriptTag({ type: "module", path: resolve("dist/content.js") });

  await page.waitForFunction(() => document.querySelectorAll("[data-glossa-token]").length === 2);
  const geometry = await page.evaluate(() => {
    const wrappers = Array.from(document.querySelectorAll<HTMLElement>("[data-glossa-token]"));
    const paragraph = document.querySelector("#target")!;
    const plainText = Array.from(paragraph.childNodes)
      .find((node): node is Text => node.nodeType === Node.TEXT_NODE && (node.nodeValue ?? "").includes("archive terms"));
    const plainRange = document.createRange();
    if (!plainText) {
      throw new Error("expected plain text after rendered gloss wrappers");
    }
    plainRange.setStart(plainText, 1);
    plainRange.setEnd(plainText, 8);
    const plainArchive = plainRange.getBoundingClientRect();
    plainRange.detach();
    return wrappers.map((wrapper) => {
      const label = wrapper.querySelector<HTMLElement>("[data-glossa-token-label]")!.getBoundingClientRect();
      const surface = wrapper.querySelector<HTMLElement>("[data-glossa-token-surface]")!.getBoundingClientRect();
      return {
        label: rect(label),
        surface: rect(surface),
        plainArchive: rect(plainArchive)
      };
    });

    function rect(value: DOMRect): { left: number; right: number; top: number; bottom: number; centerX: number } {
      return {
        left: value.left,
        right: value.right,
        top: value.top,
        bottom: value.bottom,
        centerX: value.left + value.width / 2
      };
    }
  });

  expect(geometry).toHaveLength(2);
  const [first, second] = geometry;
  if (!first || !second) {
    throw new Error("expected two rendered gloss wrappers");
  }
  for (const item of [first, second]) {
    expect(Math.abs(item.label.centerX - item.surface.centerX)).toBeLessThan(0.5);
    expect(item.label.bottom).toBeLessThanOrEqual(item.surface.top);
  }
  expect(Math.abs(second.surface.top - second.plainArchive.top)).toBeLessThan(1);
  expect(overlaps(first.label, second.label)).toBe(false);
  expect(overlaps(first.surface, second.surface)).toBe(false);
});

test("content bundle drops async glosses after the source paragraph changes", async ({ page }) => {
  await page.setContent("<main><p id=\"target\">Obscure archive appears here.</p></main>");
  await page.evaluate(() => {
    const sent: unknown[] = [];
    Reflect.set(window, "__glossaMessages", sent);
    Reflect.set(window, "chrome", {
      runtime: {
        getURL: () => "/missing-known-word-list.txt",
        sendMessage(message: { type: string; requestId: string; source: "content-script"; payload?: { sentences?: Array<{ tokens: Array<{ id: string; surface: string }> }> } }, callback?: (response: unknown) => void) {
          sent.push(message);
          if (message.type === "settings.get") {
            const response = {
              type: "settings.response",
              version: 1,
              requestId: message.requestId,
              source: "service-worker",
              target: message.source,
              createdAt: Date.now(),
              payload: { settings: { shortcutKey: "Alt", knownWordList: "junior-high" } }
            };
            callback?.(response);
            return Promise.resolve(response);
          }
          if (message.type === "gloss.request" && !Reflect.get(window, "__firstGlossHeld")) {
            Reflect.set(window, "__firstGlossHeld", true);
            const token = message.payload?.sentences
              ?.flatMap((sentence) => sentence.tokens)
              .find((item) => item.surface.toLowerCase() === "obscure");
            return new Promise((resolve) => {
              Reflect.set(window, "__resolveFirstGloss", () => {
                const response = {
                  type: "gloss.response",
                  version: 1,
                  requestId: message.requestId,
                  source: "service-worker",
                  target: message.source,
                  createdAt: Date.now(),
                  payload: token ? { items: [{ tokenId: token.id, targetText: token.surface, display: "晦涩" }] } : { items: [] }
                };
                callback?.(response);
                resolve(response);
              });
            });
          }
          const response = {
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
  await page.waitForFunction(() => typeof Reflect.get(window, "__resolveFirstGloss") === "function");

  await page.locator("#target").evaluate((element) => {
    element.textContent = "Replacement archive appears here.";
  });
  await page.evaluate(() => {
    (Reflect.get(window, "__resolveFirstGloss") as () => void)();
  });

  await page.waitForTimeout(300);
  expect(await page.evaluate(() => {
    const host = document.querySelector("#glossa-overlay");
    return host?.shadowRoot?.querySelectorAll(".label").length ?? 0;
  })).toBe(0);
});

test("content bundle preserves existing glosses while mutation rescans wait for responses", async ({ page }) => {
  await page.setContent("<main><p id=\"stable\">Obscure archive appears here.</p><p id=\"dynamic\"></p></main>");
  await page.evaluate(() => {
    const sent: unknown[] = [];
    Reflect.set(window, "__glossaMessages", sent);
    Reflect.set(window, "chrome", {
      runtime: {
        getURL: () => "/missing-known-word-list.txt",
        sendMessage(message: { type: string; requestId: string; source: "content-script"; payload?: { sentences?: Array<{ tokens: Array<{ id: string; surface: string }> }> } }, callback?: (response: unknown) => void) {
          sent.push(message);
          if (message.type === "settings.get") {
            const response = {
              type: "settings.response",
              version: 1,
              requestId: message.requestId,
              source: "service-worker",
              target: message.source,
              createdAt: Date.now(),
              payload: { settings: { shortcutKey: "Alt", knownWordList: "junior-high" } }
            };
            callback?.(response);
            return Promise.resolve(response);
          }
          const tokens = message.payload?.sentences?.flatMap((sentence) => sentence.tokens) ?? [];
          const obscure = tokens.find((token) => token.surface.toLowerCase() === "obscure");
          if (message.type === "gloss.request" && obscure && !Reflect.get(window, "__initialGlossRendered")) {
            Reflect.set(window, "__initialGlossRendered", true);
            const response = {
              type: "gloss.response",
              version: 1,
              requestId: message.requestId,
              source: "service-worker",
              target: message.source,
              createdAt: Date.now(),
              payload: { items: [{ tokenId: obscure.id, targetText: obscure.surface, display: "晦涩" }] }
            };
            callback?.(response);
            return Promise.resolve(response);
          }
          if (message.type === "gloss.request") {
            return new Promise((resolve) => {
              Reflect.set(window, "__mutationGlossHeld", true);
              Reflect.set(window, "__resolveMutationGloss", () => {
                const dynamic = tokens.find((token) => token.surface.toLowerCase() === "dynamic");
                const response = {
                  type: "gloss.response",
                  version: 1,
                  requestId: message.requestId,
                  source: "service-worker",
                  target: message.source,
                  createdAt: Date.now(),
                  payload: dynamic ? { items: [{ tokenId: dynamic.id, targetText: dynamic.surface, display: "动态" }] } : { items: [] }
                };
                callback?.(response);
                resolve(response);
              });
            });
          }
          const response = {
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
  await page.waitForFunction(() => document.querySelector("[data-glossa-token-label]")?.textContent === "晦涩");

  await page.locator("#dynamic").evaluate((element) => {
    element.textContent = "A dynamic paragraph appears after boot.";
  });
  await page.waitForFunction(() => Reflect.get(window, "__mutationGlossHeld") === true);

  expect(await page.locator("[data-glossa-token-label]", { hasText: "晦涩" }).count()).toBe(1);

  await page.evaluate(() => {
    (Reflect.get(window, "__resolveMutationGloss") as () => void)();
  });
  await page.waitForFunction(() => {
    return Array.from(document.querySelectorAll("[data-glossa-token-label]"))
      .some((label) => label.textContent === "动态");
  });
});

function overlaps(
  left: { left: number; right: number; top: number; bottom: number },
  right: { left: number; right: number; top: number; bottom: number }
): boolean {
  return left.left < right.right
    && left.right > right.left
    && left.top < right.bottom
    && left.bottom > right.top;
}
