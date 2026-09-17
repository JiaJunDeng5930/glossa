import { expect, test } from "@playwright/test";
import { resolve } from "node:path";

import { installUiRuntime, loadUiPage } from "../helpers/uiPage";
import { DEFAULT_SETTINGS } from "../../src/shared/types";

test("onboarding uses stable step identities and only saves edited setup fields", async ({ page }) => {
  await loadUiPage(page, "onboarding");
  await installUiRuntime(page);
  await page.addScriptTag({ path: resolve("dist/onboarding.js"), type: "module" });

  await expect(page.locator("[data-step]:not([hidden])")).toHaveAttribute("data-step", "smart");
  await page.locator("#continue").click();
  await page.locator("#continue").click();
  await page.locator("#continue").click();
  expect(await page.evaluate(() => {
    const requests = (Reflect.get(window, "__glossaUiFixture") as { requests: Array<{ type: string }> }).requests;
    return requests.some((request) => request.type === "settings.patch");
  })).toBe(false);

  await expect(page.locator("[data-step]:not([hidden])")).toHaveAttribute("data-step", "word-list");
  await page.locator("select[name=knownWordList]").selectOption("senior-high");
  await page.locator("#continue").click();
  await expect.poll(() => page.evaluate(() => (Reflect.get(window, "__glossaUiFixture") as { requests: Array<{ type: string }> }).requests.map((request) => request.type))).toContain("settings.patch");
  await expect(page.locator("[data-step]:not([hidden])")).toHaveAttribute("data-step", "appearance");
});

test("onboarding keeps the AI step gated by the current controller success", async ({ page }) => {
  await loadUiPage(page, "onboarding");
  await installUiRuntime(page);
  await page.addScriptTag({ path: resolve("dist/onboarding.js"), type: "module" });

  for (let index = 0; index < 5; index += 1) await page.locator("#continue").click();
  await expect(page.locator("[data-step]:not([hidden])")).toHaveAttribute("data-step", "ai");
  await page.locator("#continue").click();
  await expect(page.locator("[data-step]:not([hidden])")).toHaveAttribute("data-step", "ai");
  await expect(page.locator("#ai-status")).toHaveAttribute("data-state", "error");
});

test("onboarding serializes a step save and keeps the active step inert", async ({ page }) => {
  await loadUiPage(page, "onboarding");
  await installUiRuntime(page, { deferredTypes: ["settings.patch"] });
  await page.addScriptTag({ path: resolve("dist/onboarding.js"), type: "module" });

  for (let index = 0; index < 3; index += 1) await page.locator("#continue").click();
  await expect(page.locator("[data-step]:not([hidden])")).toHaveAttribute("data-step", "word-list");
  await page.locator("select[name=knownWordList]").selectOption("senior-high");
  await page.locator("#continue").evaluate((button) => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  await expect(page.locator("#continue")).toBeDisabled();
  await expect(page.locator("[data-step=word-list]")).toHaveJSProperty("inert", true);
  await page.evaluate(() => (Reflect.get(window, "__glossaUiFixture") as { release(type: string): void }).release("settings.patch"));
  await expect(page.locator("[data-step]:not([hidden])")).toHaveAttribute("data-step", "appearance");
});

test("onboarding keeps a failed step save retryable", async ({ page }) => {
  await loadUiPage(page, "onboarding");
  await installUiRuntime(page, { failOnceTypes: ["settings.patch"] });
  await page.addScriptTag({ path: resolve("dist/onboarding.js"), type: "module" });

  for (let index = 0; index < 3; index += 1) await page.locator("#continue").click();
  await page.locator("select[name=knownWordList]").selectOption("senior-high");
  await page.locator("#continue").click();
  await expect(page.locator("[data-step]:not([hidden])")).toHaveAttribute("data-step", "word-list");
  await expect(page.locator("#status")).toHaveText("设置保存失败，请重试");
  await expect(page.locator("#continue")).toBeEnabled();
  await page.locator("#continue").click();
  await expect(page.locator("[data-step]:not([hidden])")).toHaveAttribute("data-step", "appearance");
});

test("onboarding keeps the form inert until settings arrive", async ({ page }) => {
  await loadUiPage(page, "onboarding");
  await installUiRuntime(page, { deferredTypes: ["settings.get"] });
  await page.addScriptTag({ path: resolve("dist/onboarding.js"), type: "module" });

  await expect(page.locator("#settings-form")).toHaveJSProperty("inert", true);
  await page.evaluate(() => (Reflect.get(window, "__glossaUiFixture") as { release(type: string): void }).release("settings.get"));
  await expect(page.locator("#settings-form")).toHaveJSProperty("inert", false);
});

test("onboarding refreshes external Anki choices before saving the active non-Anki step", async ({ page }) => {
  await loadUiPage(page, "onboarding");
  await installUiRuntime(page);
  await page.addScriptTag({ path: resolve("dist/onboarding.js"), type: "module" });

  for (let index = 0; index < 3; index += 1) await page.locator("#continue").click();
  await expect(page.locator("[data-step]:not([hidden])")).toHaveAttribute("data-step", "word-list");
  await page.locator("select[name=knownWordList]").selectOption("senior-high");

  const external = {
    ...DEFAULT_SETTINGS,
    anki: { ...DEFAULT_SETTINGS.anki, deck: "External deck", modelName: "External model" }
  };
  const settingsGetsBefore = await page.evaluate(() => {
    const requests = (Reflect.get(window, "__glossaUiFixture") as { requests: Array<{ type: string }> }).requests;
    return requests.filter((request) => request.type === "settings.get").length;
  });
  await page.evaluate((next) => {
    (Reflect.get(window, "__glossaUiFixture") as { emitSettings(settings: typeof next): void }).emitSettings(next);
  }, external);
  await expect.poll(() => page.evaluate(() => {
    const requests = (Reflect.get(window, "__glossaUiFixture") as { requests: Array<{ type: string }> }).requests;
    return requests.filter((request) => request.type === "settings.get").length;
  })).toBe(settingsGetsBefore + 1);
  await expect(page.locator("select[name=ankiDeck]")).toHaveValue("External deck");
  await expect(page.locator("select[name=ankiModelName]")).toHaveValue("External model");
  await expect(page.locator("select[name=knownWordList]")).toHaveValue("senior-high");

  await page.locator("#continue").click();
  await expect(page.locator("[data-step]:not([hidden])")).toHaveAttribute("data-step", "appearance");
  const patch = await page.evaluate(() => {
    const requests = (Reflect.get(window, "__glossaUiFixture") as { requests: Array<{ type: string; payload: unknown }> }).requests;
    return requests.filter((request) => request.type === "settings.patch").at(-1)?.payload as { patch: Record<string, unknown> };
  });
  expect(patch.patch).toEqual({ knownWordList: "senior-high" });
});

test("onboarding locks verified AI settings while advancing", async ({ page }) => {
  await loadUiPage(page, "onboarding");
  await installUiRuntime(page, {
    deferredTypes: [],
    settings: { ...DEFAULT_SETTINGS, ai: { ...DEFAULT_SETTINGS.ai, provider: "glossa-backend", endpoint: "https://ai.test" } }
  });
  await page.evaluate(() => {
    Reflect.set(window, "fetch", async () => new Response(JSON.stringify({ items: [] }), { status: 200, headers: { "content-type": "application/json" } }));
  });
  await page.addScriptTag({ path: resolve("dist/onboarding.js"), type: "module" });

  for (let index = 0; index < 5; index += 1) await page.locator("#continue").click();
  await page.locator("input[name=modelVersion]").fill("gpt-onboarding-test");
  await page.locator("#test-ai").click();
  await expect(page.locator("#test-ai")).toHaveAttribute("data-state", "success");
  await page.evaluate(() => (Reflect.get(window, "__glossaUiFixture") as { setDeferred(type: string, deferred: boolean): void }).setDeferred("settings.patch", true));
  await page.locator("#continue").click();
  await expect(page.locator("#continue")).toBeDisabled();
  await expect(page.locator("[data-step=ai]")).toHaveJSProperty("inert", true);
  await page.evaluate(() => (Reflect.get(window, "__glossaUiFixture") as { release(type: string): void }).release("settings.patch"));
  await expect(page.locator("[data-step]:not([hidden])")).toHaveAttribute("data-step", "anki");
});

test("onboarding refresh can be started with an ordinary click after its endpoint changes", async ({ page }) => {
  await loadUiPage(page, "onboarding");
  await installUiRuntime(page, {
    deferredTypes: [],
    settings: { ...DEFAULT_SETTINGS, ai: { ...DEFAULT_SETTINGS.ai, provider: "glossa-backend", endpoint: "http://ai.test" } }
  });
  await page.evaluate(() => {
    const pendingA: Array<() => void> = [];
    Reflect.set(window, "__releaseOnboardingEndpointA", () => pendingA.shift()?.());
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
      if (!url.includes("anki-")) return new Response(JSON.stringify({ items: [] }), { status: 200, headers: { "content-type": "application/json" } });
      return respond();
    });
  });
  await page.addScriptTag({ path: resolve("dist/onboarding.js"), type: "module" });

  for (let index = 0; index < 5; index += 1) await page.locator("#continue").click();
  await page.locator("#test-ai").click();
  await expect(page.locator("#ai-status")).toHaveAttribute("data-state", "success");
  await page.locator("#continue").click();
  await expect(page.locator("[data-step]:not([hidden])")).toHaveAttribute("data-step", "anki");
  await page.locator("input[name=ankiEndpoint]").fill("https://anki-a.test");
  await page.locator("#refresh-anki").click();
  await expect(page.locator("#refresh-anki")).toBeDisabled();
  await page.locator("input[name=ankiEndpoint]").fill("https://anki-b.test");
  await expect(page.locator("#refresh-anki")).toBeEnabled();
  await page.locator("#refresh-anki").click();
  await expect(page.locator("select[name=ankiDeck]")).toHaveValue("Deck B");
  await expect(page.locator("select[name=ankiModelName]")).toHaveValue("Model B");
  await expect(page.locator("select[name=ankiModelName] option")).toHaveCount(1);
  await page.evaluate(() => (Reflect.get(window, "__releaseOnboardingEndpointA") as () => void)());
  await expect(page.locator("select[name=ankiDeck]")).toHaveValue("Deck B");
  await expect(page.locator("#refresh-anki")).toBeEnabled();
});
