import { expect, test, type Page } from "@playwright/test";
import { resolve } from "node:path";

import { installUiRuntime, loadUiPage } from "../helpers/uiPage";
import { DEFAULT_SETTINGS, type GlossaSettings } from "../../src/shared/types";

async function loadOptions(page: Page, settings: GlossaSettings = DEFAULT_SETTINGS): Promise<void> {
  await loadUiPage(page, "options");
  await installUiRuntime(page, { settings });
  await page.addScriptTag({ path: resolve("dist/options.js"), type: "module" });
  await expect(page.locator("#settings-form")).toHaveJSProperty("inert", false);
}

test("options loads the shared theme and saves only edited settings fields", async ({ page }) => {
  await loadOptions(page);
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--glossa-theme-accent").trim())).not.toBe("");

  await page.locator("input[name=learningWindowDays]").fill("9");
  await page.locator("textarea[name=glossPrompt]").fill("Use compact contextual labels.");
  await page.locator("#save-settings").click();
  await expect(page.locator("#status")).toHaveText("已保存");
  await expect(page.locator("#save-settings")).toBeEnabled();

  const requests = await page.evaluate(() => (Reflect.get(window, "__glossaUiFixture") as { requests: Array<{ type: string; payload: unknown }> }).requests);
  const patch = requests.find((request) => request.type === "settings.patch")?.payload as { patch: Record<string, unknown> };
  expect(patch.patch).toEqual({ learningWindowDays: 9, prompts: { gloss: "Use compact contextual labels." } });
});

test("options switches the default endpoint with the selected provider", async ({ page }) => {
  await loadOptions(page);

  await page.locator("select[name=provider]").selectOption("openai-completions");

  await expect(page.locator("input[name=aiEndpoint]")).toHaveValue("https://api.openai.com/v1/completions");
});

test("options reports an invalid form and does not test or save the previous settings", async ({ page }) => {
  await loadOptions(page);
  await page.evaluate(() => {
    let calls = 0;
    Reflect.set(window, "__glossaFetchCalls", () => calls);
    Reflect.set(window, "fetch", async () => {
      calls += 1;
      return new Response(JSON.stringify({ items: [] }), { status: 200, headers: { "content-type": "application/json" } });
    });
  });

  await page.locator("input[name=aiEndpoint]").fill("localhost");
  await expect(page.locator("#status")).toHaveText("设置格式无效，请修正后再保存");
  await page.locator("#test-ai").click();
  await page.locator("#save-settings").click();

  await expect(page.locator("#status")).toHaveText("设置格式无效，请修正后再保存");
  expect(await page.evaluate(() => (Reflect.get(window, "__glossaFetchCalls") as () => number)())).toBe(0);
  const requests = await page.evaluate(() => (Reflect.get(window, "__glossaUiFixture") as { requests: Array<{ type: string }> }).requests);
  expect(requests.some((request) => request.type === "settings.patch")).toBe(false);
});

test("options preserves fractional appearance values and renders the live preview", async ({ page }) => {
  await loadOptions(page, {
    ...DEFAULT_SETTINGS,
    appearance: { ...DEFAULT_SETTINGS.appearance, backgroundOpacity: 0.8 }
  });

  await page.locator("input[name=glossTextColor]").fill("#ff5500");
  await page.locator("input[name=glossBackgroundColor]").fill("#113355");
  await page.locator("input[name=cardSuccessBackgroundColor]").fill("#228833");
  await page.locator("input[name=cardErrorBackgroundColor]").fill("#cc2222");
  await page.locator("input[name=glossBackgroundOpacity]").fill("0.94");
  await page.locator("input[name=glossFontSize]").fill("12.5");

  await expect(page.locator("input[name=glossBackgroundOpacity]")).toHaveValue("0.94");
  await expect(page.locator("#gloss-background-opacity-value")).toHaveText("94%");
  await expect(page.locator(".preview-gloss").first()).toHaveCSS("color", "rgb(255, 85, 0)");
  await expect(page.locator(".preview-gloss").first()).toHaveCSS("font-size", "12.5px");
  await expect(page.locator(".preview-gloss-success")).toHaveCSS("background-color", "rgba(34, 136, 51, 0.94)");
  expect(await page.locator("input[name=glossBackgroundOpacity]").evaluate((input) => (input as HTMLInputElement).validity.valid)).toBe(true);

  await page.locator("#save-settings").click();
  await expect(page.locator("#status")).toHaveText("已保存");
  const patch = await page.evaluate(() => {
    const requests = (Reflect.get(window, "__glossaUiFixture") as { requests: Array<{ type: string; payload: unknown }> }).requests;
    return requests.find((request) => request.type === "settings.patch")?.payload as { patch: Record<string, unknown> };
  });
  expect(patch.patch).toMatchObject({ appearance: { backgroundOpacity: 0.94, fontSize: 12.5 } });
});

test("options rejects a conflicting shortcut and accepts a distinct chord", async ({ page }) => {
  await loadUiPage(page, "options");
  await installUiRuntime(page, { settings: { ...DEFAULT_SETTINGS, translateShortcutKey: "Ctrl+Shift+G" } });
  await page.addScriptTag({ path: resolve("dist/options.js"), type: "module" });
  await expect(page.locator("#settings-form")).toHaveJSProperty("inert", false);

  await page.locator("#shortcut-capture").click();
  await page.keyboard.down("Control");
  await page.keyboard.down("Shift");
  await page.keyboard.press("KeyG");
  await page.keyboard.up("Shift");
  await page.keyboard.up("Control");
  await expect(page.locator("#shortcut-capture-error")).toContainText("与翻译快捷键冲突");
  await expect(page.locator("input[name=shortcutKey]")).toHaveValue("Alt");

  await page.keyboard.down("Control");
  await page.keyboard.down("Shift");
  await page.keyboard.press("KeyK");
  await page.keyboard.up("Shift");
  await page.keyboard.up("Control");
  await expect(page.locator("input[name=shortcutKey]")).toHaveValue("Ctrl+Shift+K");
  await expect(page.locator("#shortcut-capture-error")).toHaveText("");
});

test("options keeps a failed settings save retryable", async ({ page }) => {
  await loadUiPage(page, "options");
  await installUiRuntime(page, { failOnceTypes: ["settings.patch"] });
  await page.addScriptTag({ path: resolve("dist/options.js"), type: "module" });
  await expect(page.locator("#settings-form")).toHaveJSProperty("inert", false);

  await page.locator("input[name=learningWindowDays]").fill("9");
  await page.locator("#save-settings").click();
  await expect(page.locator("#status")).toHaveText("设置保存失败，请重试");
  await expect(page.locator("#save-settings .save-label")).toHaveText("重试保存");
  await page.locator("#save-settings").click();
  await expect(page.locator("#status")).toHaveText("已保存");
});

test("options clears a verified AI result when its settings change", async ({ page }) => {
  await loadUiPage(page, "options");
  await installUiRuntime(page, {
    settings: { ...DEFAULT_SETTINGS, ai: { ...DEFAULT_SETTINGS.ai, provider: "glossa-backend", endpoint: "https://ai.test" } }
  });
  await page.evaluate(() => {
    Reflect.set(window, "fetch", async () => new Response(JSON.stringify({ items: [] }), { status: 200, headers: { "content-type": "application/json" } }));
  });
  await page.addScriptTag({ path: resolve("dist/options.js"), type: "module" });
  await expect(page.locator("#settings-form")).toHaveJSProperty("inert", false);

  await page.locator("#test-ai").click();
  await expect(page.locator("#test-ai")).toHaveAttribute("data-state", "success");
  await page.locator("input[name=modelVersion]").fill("changed-model");
  await expect(page.locator("#test-ai")).toHaveAttribute("data-state", "idle");
  await expect(page.locator("#ai-status")).toHaveText("");
});

test("options preserves a local edit made while a settings save is pending", async ({ page }) => {
  await loadUiPage(page, "options");
  await installUiRuntime(page, { deferredTypes: ["settings.patch"] });
  await page.addScriptTag({ path: resolve("dist/options.js"), type: "module" });
  await expect(page.locator("#settings-form")).toHaveJSProperty("inert", false);

  await page.locator("input[name=learningWindowDays]").fill("8");
  await page.locator("#save-settings").click();
  await expect(page.locator("#save-settings")).toBeDisabled();
  await page.locator("textarea[name=ankiPrompt]").fill("Keep the current sentence.");
  await page.evaluate(() => (Reflect.get(window, "__glossaUiFixture") as { release(type: string): void }).release("settings.patch"));
  await expect(page.locator("#save-settings")).toBeEnabled();
  await expect(page.locator("#save-settings")).toHaveAttribute("data-state", "dirty");
  await expect(page.locator("textarea[name=ankiPrompt]")).toHaveValue("Keep the current sentence.");
});

test("options refreshes Anki through a real click after the endpoint changes", async ({ page }) => {
  await loadUiPage(page, "options");
  await installUiRuntime(page);
  await page.evaluate(() => {
    const pendingA: Array<() => void> = [];
    Reflect.set(window, "__releaseOptionsEndpointA", () => pendingA.shift()?.());
    Reflect.set(window, "fetch", async (url: string, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { action: string; params?: { modelName?: string } };
      const action = request.action;
      const endpoint = url.includes("anki-a.test") ? "A" : "B";
      const respond = () => {
        const values: Record<string, unknown> = endpoint === "A"
          ? { version: 6, deckNames: ["Deck A"], modelNames: ["Model A"], modelFieldNames: ["Front", "Back"] }
          : { version: 6, deckNames: ["Deck B"], modelNames: ["Model B", "Broken B"], modelFieldNames: request.params?.modelName === "Broken B" ? ["Front"] : ["Front", "Back"] };
        return new Response(JSON.stringify({ result: values[action], error: null }), { status: 200, headers: { "content-type": "application/json" } });
      };
      if (endpoint === "A" && action === "version") return await new Promise<Response>((resolve) => pendingA.push(() => resolve(respond())));
      return respond();
    });
  });
  await page.addScriptTag({ path: resolve("dist/options.js"), type: "module" });
  await expect(page.locator("#settings-form")).toHaveJSProperty("inert", false);

  await page.locator("input[name=ankiEndpoint]").fill("https://anki-a.test");
  await page.locator("#refresh-anki").click();
  await expect(page.locator("#refresh-anki")).toBeDisabled();
  await page.locator("input[name=ankiEndpoint]").fill("https://anki-b.test");
  await expect(page.locator("#refresh-anki")).toBeEnabled();
  await page.locator("#refresh-anki").click();
  await expect(page.locator("select[name=ankiDeck]")).toHaveValue("Deck B");
  await expect(page.locator("select[name=ankiModelName]")).toHaveValue("Model B");
  await expect(page.locator("select[name=ankiModelName] option")).toHaveCount(1);
  await page.evaluate(() => (Reflect.get(window, "__releaseOptionsEndpointA") as () => void)());
  await expect(page.locator("select[name=ankiDeck]")).toHaveValue("Deck B");
});

test("options manages known words through typed worker requests", async ({ page }) => {
  await loadUiPage(page, "options");
  await installUiRuntime(page, { knownRecords: [{ key: "en:alpha", lang: "en", lemma: "alpha", surface: "alpha", state: "known" }] });
  await page.addScriptTag({ path: resolve("dist/options.js"), type: "module" });
  await expect(page.locator("#settings-form")).toHaveJSProperty("inert", false);

  await page.locator("#open-known-words").click();
  await expect(page.locator(".known-word-row")).toHaveCount(1);
  await page.locator("#known-word-input").fill("beta");
  await page.locator("#add-known-word").click();
  await expect(page.locator(".known-word-row")).toHaveCount(2);
  await page.locator(".known-word-row").filter({ hasText: "beta" }).getByRole("button", { name: "移除" }).click();
  await expect(page.locator(".known-word-row")).toHaveCount(1);

  const types = await page.evaluate(() => (Reflect.get(window, "__glossaUiFixture") as { requests: Array<{ type: string }> }).requests.map((request) => request.type));
  expect(types).toContain("known.words.list");
  expect(types).toContain("known.words.add");
  expect(types).toContain("known.words.remove");
});

test("options keeps reset-card-history pending until the worker responds", async ({ page }) => {
  await loadUiPage(page, "options");
  await installUiRuntime(page, { deferredTypes: ["card.history.reset"] });
  await page.addScriptTag({ path: resolve("dist/options.js"), type: "module" });
  await expect(page.locator("#settings-form")).toHaveJSProperty("inert", false);

  page.once("dialog", (dialog) => void dialog.accept());
  await page.locator("#reset-card-history").click();
  await expect(page.locator("#anki-status")).toHaveAttribute("data-state", "pending");
  await expect(page.locator("#reset-card-history")).toBeDisabled();
  await page.evaluate(() => (Reflect.get(window, "__glossaUiFixture") as { release(type: string): void }).release("card.history.reset"));
  await expect(page.locator("#anki-status")).toHaveText("制卡记录已重置，Anki 中已有卡片保持不变");
  await expect(page.locator("#reset-card-history")).toBeEnabled();
});
