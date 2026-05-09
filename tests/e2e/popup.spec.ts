import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

// @verifies glossa.translation_start_popup
test("popup translate button activates the current tab", async ({ page }) => {
  const html = await readFile(resolve("dist/popup/popup.html"), "utf8");
  await page.setContent(html.replace("<link rel=\"stylesheet\" href=\"../assets/popup.css\">", "").replace("<script type=\"module\" src=\"../popup.js\"></script>", ""));
  await page.addStyleTag({ path: resolve("dist/assets/popup.css") });
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
