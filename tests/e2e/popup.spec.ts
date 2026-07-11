import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

async function loadPopup(page: Page): Promise<void> {
  const html = await readFile(resolve("dist/popup/popup.html"), "utf8");
  await page.setContent(html.replace("<link rel=\"stylesheet\" href=\"../assets/popup.css\">", "").replace("<script type=\"module\" src=\"../popup.js\"></script>", ""));
  await page.addStyleTag({ path: resolve("dist/assets/popup.css") });
}

test("popup translate button activates the current tab", async ({ page }) => {
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
        async sendMessage(tabId: number, message: unknown) {
          sent.push({ tabId, message });
          return { ok: true };
        }
      }
    });
    window.close = () => {
      Reflect.set(window, "__glossaPopupClosed", true);
    };
  });
  await page.addScriptTag({ type: "module", path: resolve("dist/popup.js") });

  await page.locator("#translate-page").click();

  await expect.poll(async () => page.evaluate(() => Reflect.get(window, "__glossaPopupClosed"))).toBe(true);
  expect(await page.evaluate(() => Reflect.get(window, "__glossaTabMessages"))).toEqual([{
    tabId: 11,
    message: { type: "glossa.activateTranslation" }
  }]);
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

test("popup translate button reports structured activation errors", async ({ page }) => {
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
        async sendMessage() {
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

test("popup translate button reports malformed activation responses", async ({ page }) => {
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
        async sendMessage() {
          return { ok: false };
        }
      }
    });
  });
  await page.addScriptTag({ type: "module", path: resolve("dist/popup.js") });

  await page.locator("#translate-page").click();

  await expect(page.locator("#popup-status")).toHaveText("当前页面无法翻译");
  await expect(page.locator("#translate-page")).toBeEnabled();
});
