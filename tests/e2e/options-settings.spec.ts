import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

test("options page captures shortcuts, previews style changes and saves prompts", async ({ page }) => {
  const html = await readFile(resolve("dist/options/options.html"), "utf8");
  await page.setContent(html.replace("<script type=\"module\" src=\"../options.js\"></script>", ""));
  await page.evaluate(() => {
    const store: Record<string, unknown> = {};
    Reflect.set(window, "__glossaStore", store);
    Reflect.set(window, "chrome", {
      storage: {
        local: {
          get(key: string, callback: (result: Record<string, unknown>) => void) {
            callback({ [key]: store[key] });
          },
          set(value: Record<string, unknown>, callback?: () => void) {
            Object.assign(store, value);
            callback?.();
          }
        }
      }
    });
  });
  await page.addScriptTag({ type: "module", path: resolve("dist/options.js") });

  await page.locator("#shortcut-capture").click();
  await page.keyboard.down("Control");
  await page.keyboard.down("Shift");
  await page.keyboard.press("KeyK");
  await page.keyboard.up("Shift");
  await page.keyboard.up("Control");

  await page.locator("input[name=glossTextColor]").fill("#ff5500");
  await page.locator("input[name=glossBackgroundColor]").fill("#113355");
  await page.locator("input[name=glossBackgroundOpacity]").fill("0.65");
  await page.locator("select[name=glossFontFamily]").selectOption("Georgia, Times New Roman, serif");
  await page.locator("input[name=glossFontSize]").fill("18");
  await page.locator("textarea[name=glossPrompt]").fill("Use compact contextual labels.");
  await page.locator("textarea[name=ankiPrompt]").fill("Create concise learning cards.");

  await expect(page.locator("#shortcut-capture")).toHaveText("Ctrl+Shift+K");
  await expect(page.locator("#gloss-preview")).toHaveCSS("color", "rgb(255, 85, 0)");
  await expect(page.locator("#gloss-preview")).toHaveCSS("font-size", "18px");

  await page.locator("button[type=submit]").click();

  const settings = await page.evaluate(() => (Reflect.get(window, "__glossaStore") as { settings: unknown }).settings);
  expect(settings).toMatchObject({
    shortcutKey: "Ctrl+Shift+K",
    appearance: {
      textColor: "#ff5500",
      backgroundColor: "#113355",
      backgroundOpacity: 0.65,
      fontFamily: "Georgia, Times New Roman, serif",
      fontSize: 18
    },
    prompts: {
      gloss: "Use compact contextual labels.",
      ankiCard: "Create concise learning cards."
    }
  });
});
