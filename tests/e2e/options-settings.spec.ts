import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

test("options page captures shortcuts, previews style changes and saves prompts", async ({ page }) => {
  const html = await readFile(resolve("dist/options/options.html"), "utf8");
  await page.setContent(html.replace("<link rel=\"stylesheet\" href=\"../assets/options.css\">", "").replace("<script type=\"module\" src=\"../options.js\"></script>", ""));
  await page.addStyleTag({ path: resolve("dist/assets/options.css") });
  await page.evaluate(() => {
    const store: Record<string, unknown> = {};
    Reflect.set(window, "__glossaStore", store);
    Reflect.set(window, "fetch", (url: string) => Promise.resolve(new Response(null, {
      status: url.includes("8765") ? 401 : 200
    })));
    Reflect.set(window, "chrome", {
      runtime: {
        lastError: undefined
      },
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
  await expect(page.locator("select[name=knownWordList] option")).toHaveCount(7);
  await expect(page.locator("select[name=knownWordList]")).toContainText("托福 4510 词");
  await page.locator("select[name=knownWordList]").selectOption("toefl");
  await page.locator("select[name=provider]").selectOption("openai-chat-completions");
  await page.locator("select[name=reasoningEffort]").selectOption("high");
  await expect(page.locator("input[name=aiEndpoint]")).toHaveValue("https://api.openai.com/v1/chat/completions");
  await page.locator("textarea[name=glossPrompt]").fill("Use compact contextual labels.");
  await page.locator("textarea[name=ankiPrompt]").fill("Create concise learning cards.");

  await expect(page.locator("#shortcut-capture")).toHaveText("Ctrl+Shift+K");
  await expect(page.locator(".preview-gloss").first()).toHaveCSS("color", "rgb(255, 85, 0)");
  await expect(page.locator(".preview-gloss").first()).toHaveCSS("font-size", "18px");
  await expect(page.locator("#test-ai")).toHaveText("测试 AI");
  await expect(page.locator("#test-anki")).toHaveText("测试 Anki");
  const buttonPositions = await page.evaluate(() => {
    const reasoning = document.querySelector("select[name=reasoningEffort]")!.getBoundingClientRect();
    const testAi = document.querySelector("#test-ai")!.getBoundingClientRect();
    const ankiDeck = document.querySelector("input[name=ankiDeck]")!.getBoundingClientRect();
    const testAnki = document.querySelector("#test-anki")!.getBoundingClientRect();
    return {
      aiBelowReasoning: testAi.top >= reasoning.bottom,
      ankiBelowDeck: testAnki.top >= ankiDeck.bottom
    };
  });
  expect(buttonPositions).toEqual({ aiBelowReasoning: true, ankiBelowDeck: true });

  await page.locator("#test-ai").click();
  await expect(page.locator("#test-ai")).toHaveAttribute("data-state", "success");
  await expect(page.locator("#test-ai .test-label")).not.toBeVisible();
  await expect(page.locator("#test-ai .test-icon-success")).toBeVisible();
  await expect(page.locator("#test-ai")).toHaveCSS("width", "44px");
  await expect(page.locator("#status")).toHaveText("");

  await page.locator("#test-anki").click();
  await expect(page.locator("#test-anki")).toHaveAttribute("data-state", "error");
  await expect(page.locator("#test-anki .test-label")).not.toBeVisible();
  await expect(page.locator("#test-anki .test-icon-error")).toBeVisible();
  await expect(page.locator("#test-anki")).toHaveCSS("width", "44px");
  await expect(page.locator("#status")).toContainText("AnkiConnect 拒绝了请求");

  await page.locator("button[type=submit]").click();

  const settings = await page.evaluate(() => (Reflect.get(window, "__glossaStore") as { settings: unknown }).settings);
  expect(settings).toMatchObject({
    shortcutKey: "Ctrl+Shift+K",
    knownWordList: "toefl",
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
    },
    ai: {
      provider: "openai-chat-completions",
      reasoningEffort: "high"
    }
  });
});
