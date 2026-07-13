import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

async function loadPopup(page: Page): Promise<void> {
  const html = await readFile(resolve("dist/popup/popup.html"), "utf8");
  await page.setContent(html.replace("<link rel=\"stylesheet\" href=\"../assets/popup.css\">", "").replace("<script type=\"module\" src=\"../popup.js\"></script>", ""));
  await page.addStyleTag({ path: resolve("dist/assets/popup.css") });
}

test("popup reads and toggles translation state for the current tab", async ({ page }) => {
  await loadPopup(page);
  await expect.poll(async () => page.evaluate(() => document.body.getBoundingClientRect().width)).toBe(300);
  await page.evaluate(() => {
    const sent: unknown[] = [];
    Reflect.set(window, "__glossaTabMessages", sent);
    Reflect.set(window, "chrome", {
      runtime: {
        openOptionsPage() {}
      },
      tabs: {
        async query() {
          return [{ id: 11 }];
        },
        async sendMessage(tabId: number, message: unknown, options?: unknown) {
          sent.push(options ? { tabId, message, options } : { tabId, message });
          const type = (message as { type?: string }).type;
          return type === "glossa.getTranslationState"
            ? { ok: true, enabled: false }
            : { ok: true, enabled: true };
        }
      }
    });
    window.close = () => {
      Reflect.set(window, "__glossaPopupClosed", true);
    };
  });
  await page.addScriptTag({ type: "module", path: resolve("dist/popup.js") });

  await expect(page.locator("#page-state-label")).toHaveText("翻译已关闭");
  await expect(page.locator("#translate-page")).toHaveText("翻译本页");
  await page.locator("#translate-page").click();

  await expect.poll(async () => page.evaluate(() => Reflect.get(window, "__glossaPopupClosed"))).toBe(true);
  expect(await page.evaluate(() => Reflect.get(window, "__glossaTabMessages"))).toEqual([
    { tabId: 11, message: { type: "glossa.getTranslationState" }, options: { frameId: 0 } },
    { tabId: 11, message: { type: "glossa.toggleTranslationState" }, options: { frameId: 0 } },
    { tabId: 11, message: { type: "glossa.setTranslationState", enabled: true } }
  ]);
});

test("popup shortcut hint reflects the saved translation shortcut", async ({ page }) => {
  await loadPopup(page);
  await page.evaluate(() => {
    Reflect.set(window, "chrome", {
      runtime: {
        openOptionsPage() {}
      },
      storage: {
        local: {
          get(key: string, callback: (result: unknown) => void) {
            if (key === "settings") {
              callback({ settings: { translateShortcutKey: "Ctrl+Shift+K" } });
              return;
            }
            callback({});
          }
        }
      },
      tabs: {
        async query() {
          return [{ id: 11 }];
        },
        async sendMessage() {
          return { ok: true };
        }
      }
    });
  });

  await page.addScriptTag({ type: "module", path: resolve("dist/popup.js") });

  await expect(page.locator("#translate-shortcut-hint")).toHaveAttribute("aria-label", "Ctrl+Shift+K");
  await expect(page.locator("#translate-shortcut-hint kbd")).toHaveText(["Ctrl", "Shift", "K"]);
});

test("popup translate button reports structured toggle errors", async ({ page }) => {
  await loadPopup(page);
  await page.evaluate(() => {
    Reflect.set(window, "chrome", {
      runtime: {
        openOptionsPage() {}
      },
      tabs: {
        async query() {
          return [{ id: 11 }];
        },
        async sendMessage(_tabId: number, message: { type?: string }) {
          if (message.type === "glossa.getTranslationState") {
            return { ok: true, enabled: false };
          }
          return {
            ok: false,
            error: { reason: "timeout", message: "runtime timeout", service: "runtime" }
          };
        }
      }
    });
    window.close = () => {
      Reflect.set(window, "__glossaPopupClosed", true);
    };
  });
  await page.addScriptTag({ type: "module", path: resolve("dist/popup.js") });

  await page.locator("#translate-page").click();

  await expect(page.locator("#popup-status")).toHaveText("扩展请求超时");
  await expect(page.locator("#translate-page")).toBeEnabled();
  await expect.poll(async () => page.evaluate(() => Reflect.get(window, "__glossaPopupClosed"))).toBeFalsy();
});

test("popup translate button reports malformed toggle responses", async ({ page }) => {
  await loadPopup(page);
  await page.evaluate(() => {
    Reflect.set(window, "chrome", {
      runtime: {
        openOptionsPage() {}
      },
      tabs: {
        async query() {
          return [{ id: 11 }];
        },
        async sendMessage(_tabId: number, message: { type?: string }) {
          if (message.type === "glossa.getTranslationState") {
            return { ok: true, enabled: false };
          }
          return { ok: false };
        }
      }
    });
  });
  await page.addScriptTag({ type: "module", path: resolve("dist/popup.js") });

  await page.locator("#translate-page").click();

  await expect(page.locator("#popup-status")).toHaveText("扩展运行时错误");
  await expect(page.locator("#translate-page")).toBeEnabled();
});

test("popup offers stop when translation is active", async ({ page }) => {
  await loadPopup(page);
  await page.evaluate(() => {
    Reflect.set(window, "chrome", {
      runtime: { openOptionsPage() {} },
      tabs: {
        async query() {
          return [{ id: 11 }];
        },
        async sendMessage(_tabId: number, message: { type?: string }) {
          return message.type === "glossa.getTranslationState"
            ? { ok: true, enabled: true }
            : { ok: true, enabled: false };
        }
      }
    });
    window.close = () => {
      Reflect.set(window, "__glossaPopupClosed", true);
    };
  });
  await page.addScriptTag({ type: "module", path: resolve("dist/popup.js") });

  await expect(page.locator("#page-state-label")).toHaveText("翻译已开启");
  await expect(page.locator("#translate-page")).toHaveText("停止翻译");
  await page.locator("#translate-page").click();
  await expect.poll(async () => page.evaluate(() => Reflect.get(window, "__glossaPopupClosed"))).toBe(true);
});

test("popup retries its state probe while the content script starts", async ({ page }) => {
  await loadPopup(page);
  await page.evaluate(() => {
    let attempts = 0;
    Reflect.set(window, "__glossaProbeAttempts", () => attempts);
    Reflect.set(window, "chrome", {
      runtime: { openOptionsPage() {} },
      tabs: {
        async query() {
          return [{ id: 11 }];
        },
        async sendMessage() {
          attempts += 1;
          if (attempts <= 4) {
            throw new Error("Could not establish connection. Receiving end does not exist.");
          }
          return { ok: true, enabled: false };
        }
      }
    });
  });
  await page.addScriptTag({ type: "module", path: resolve("dist/popup.js") });

  await expect(page.locator("#page-state-label")).toHaveText("翻译已关闭");
  await expect(page.locator("#translate-page")).toBeEnabled();
  expect(await page.evaluate(() => (Reflect.get(window, "__glossaProbeAttempts") as () => number)())).toBe(5);
});

test("popup localizes pages where the content script is unavailable", async ({ page }) => {
  await loadPopup(page);
  await page.evaluate(() => {
    Reflect.set(window, "chrome", {
      runtime: { openOptionsPage() {} },
      tabs: {
        async query() {
          return [{ id: 11 }];
        },
        async sendMessage() {
          throw new Error("Could not establish connection. Receiving end does not exist.");
        }
      }
    });
  });
  await page.addScriptTag({ type: "module", path: resolve("dist/popup.js") });

  await expect(page.locator("#page-state-label")).toHaveText("此页面不可用", { timeout: 8_000 });
  await expect(page.locator("#translate-page")).toBeDisabled();
  await expect(page.locator("#popup-status")).toHaveText("当前页面不支持扩展翻译");
  await expect(page.locator("#popup-status")).not.toContainText("Receiving end");
});
