import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

async function loadOnboarding(page: Page): Promise<void> {
  const html = await readFile(resolve("dist/onboarding/onboarding.html"), "utf8");
  await page.setContent(html
    .replace("<link rel=\"stylesheet\" href=\"../assets/theme.css\">", "")
    .replace("<link rel=\"stylesheet\" href=\"../assets/onboarding.css\">", "")
    .replace("<script type=\"module\" src=\"../onboarding.js\"></script>", ""));
  await page.addStyleTag({ path: resolve("dist/assets/theme.css") });
  await page.addStyleTag({ path: resolve("dist/assets/onboarding.css") });
}

async function visibleStepCount(page: Page): Promise<number> {
  return await page.locator("[data-step]:not([hidden])").count();
}

// @verifies glossa.onboarding
// @verifies glossa.onboarding.single_topic
// @verifies glossa.onboarding.settings_save
// @verifies glossa.onboarding.ai_check
// @verifies glossa.onboarding.anki_check
test("onboarding keeps one visible topic per page and saves setup choices", async ({ page }) => {
  await loadOnboarding(page);
  await page.evaluate(() => {
    const store: Record<string, unknown> = {};
    Reflect.set(window, "__glossaStore", store);
    Reflect.set(window, "fetch", async (url: string, init?: RequestInit) => {
      Reflect.set(window, "__lastConnectionRequest", {
        url,
        body: init?.body ? JSON.parse(init.body as string) : undefined,
        authorization: (init?.headers as Record<string, string> | undefined)?.authorization
      });
      return new Response(JSON.stringify({ result: 6 }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    });
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
    window.close = () => {
      Reflect.set(window, "__onboardingClosed", true);
    };
  });
  await page.addScriptTag({ type: "module", path: resolve("dist/onboarding.js") });

  await expect(page.getByRole("heading", { name: "翻译本页" })).toBeVisible();
  await expect.poll(() => visibleStepCount(page)).toBe(1);
  await page.locator("#continue").click();

  await expect(page.getByRole("heading", { name: "加入 Anki" })).toBeVisible();
  await expect.poll(() => visibleStepCount(page)).toBe(1);
  await page.locator("#continue").click();

  await expect(page.getByRole("heading", { name: "选择基础词表" })).toBeVisible();
  await expect(page.locator("input[name=knownWordList]")).toHaveCount(7);
  await page.getByLabel("高中课标词汇").check();
  await page.locator("#continue").click();

  await expect(page.getByRole("heading", { name: "设置释义颜色" })).toBeVisible();
  await page.locator("input[name=glossTextColor]").fill("#ff5500");
  await page.locator("input[name=glossBackgroundColor]").fill("#113355");
  await expect(page.locator(".preview-word span")).toHaveCSS("color", "rgb(255, 85, 0)");
  await page.locator("#continue").click();

  await expect(page.getByRole("heading", { name: "连接 AI 服务" })).toBeVisible();
  await page.locator("input[name=apiKey]").fill("sk-test");
  await page.locator("#test-ai").click();
  await expect(page.locator("#test-ai")).toHaveAttribute("data-state", "success");
  await expect(page.locator("#status")).toHaveText("AI 连接成功");
  await page.locator("#continue").click();

  await expect(page.getByRole("heading", { name: "连接 AnkiConnect" })).toBeVisible();
  await page.locator("input[name=ankiEndpoint]").fill("http://127.0.0.1:8766");
  await page.locator("#test-anki").click();
  await expect(page.locator("#test-anki")).toHaveAttribute("data-state", "success");
  await expect(page.locator("#status")).toHaveText("Anki 已连接");
  await page.locator("#continue").click();

  await expect(page.getByRole("heading", { name: "可以开始阅读" })).toBeVisible();
  await expect(page.locator("#progress")).toHaveText("7 / 7");
  const storedSettings = await page.evaluate(() => Reflect.get(window, "__glossaStore").settings);
  expect(storedSettings).toMatchObject({
    knownWordList: "senior-high",
    appearance: {
      textColor: "#ff5500",
      backgroundColor: "#113355"
    },
    ai: { apiKey: "sk-test" },
    anki: { endpoint: "http://127.0.0.1:8766" }
  });
  await page.locator("#continue").click();
  await expect.poll(async () => page.evaluate(() => Reflect.get(window, "__onboardingClosed"))).toBe(true);
});
