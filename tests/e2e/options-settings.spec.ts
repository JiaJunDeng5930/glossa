import { expect, test, type Page } from "@playwright/test";
import { resolve } from "node:path";
import { readFile } from "node:fs/promises";

import { installUiRuntime, loadUiPage } from "../helpers/uiPage";
import { DEFAULT_SETTINGS, type GlossaSettings } from "../../src/shared/types";

async function loadOptionsHtml(page: Page): Promise<void> {
  await loadUiPage(page, "options");
  if (process.env.GLOSSA_SCREENSHOT_DIR) {
    const logo = await readFile(resolve("dist/assets/logo.png"));
    await page.locator(".brand-logo").evaluate((image, source) => { (image as HTMLImageElement).src = source; }, `data:image/png;base64,${logo.toString("base64")}`);
  }
}

async function loadOptions(page: Page, settings: GlossaSettings = DEFAULT_SETTINGS): Promise<void> {
  await loadOptionsHtml(page);
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
  await expect(page.locator("#status")).toHaveText("AI 地址：请输入完整的 http:// 或 https:// 地址。");
  await page.locator("#test-ai").click();
  await page.locator("#save-settings").click();

  await expect(page.locator("#status")).toHaveText("AI 地址：请输入完整的 http:// 或 https:// 地址。");
  await expect(page.locator("input[name=aiEndpoint]")).toHaveAttribute("aria-invalid", "true");
  await expect(page.locator("input[name=aiEndpoint]")).toBeFocused();
  await expect(page.locator("input[name=aiEndpoint]")).toBeInViewport();
  await expect(page.locator("#settings-field-error")).toHaveText("AI 地址：请输入完整的 http:// 或 https:// 地址。");
  if (process.env.GLOSSA_SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.GLOSSA_SCREENSHOT_DIR}/invalid-field.png` });
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
  await loadOptionsHtml(page);
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
  await loadOptionsHtml(page);
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
  await loadOptionsHtml(page);
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
  await loadOptionsHtml(page);
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

test("options refreshes external Anki choices before a later non-Anki save", async ({ page }) => {
  await loadOptions(page);

  await page.locator("textarea[name=glossPrompt]").fill("Keep the local prompt.");
  await page.locator("input[name=learningWindowDays]").fill("0");
  await expect(page.locator("#status")).toHaveText("学习窗口（天）：请输入不小于 1 的数字。");

  const external = {
    ...DEFAULT_SETTINGS,
    learningWindowDays: 7,
    prompts: { ...DEFAULT_SETTINGS.prompts, gloss: "Replace the prompt." },
    anki: { ...DEFAULT_SETTINGS.anki, deck: "External deck", modelName: "External model" }
  };
  const settingsGetsBefore = await page.evaluate(() => {
    const requests = (Reflect.get(window, "__glossaUiFixture") as { requests: Array<{ type: string }> }).requests;
    return requests.filter((request) => request.type === "settings.get").length;
  });
  await page.evaluate((next) => {
    (Reflect.get(window, "__glossaUiFixture") as { emitSettings(settings: GlossaSettings): void }).emitSettings(next);
  }, external);
  await expect.poll(() => page.evaluate(() => {
    const requests = (Reflect.get(window, "__glossaUiFixture") as { requests: Array<{ type: string }> }).requests;
    return requests.filter((request) => request.type === "settings.get").length;
  })).toBe(settingsGetsBefore + 1);
  await expect(page.locator("select[name=ankiDeck]")).toHaveValue("External deck");
  await expect(page.locator("select[name=ankiModelName]")).toHaveValue("External model");
  await expect(page.locator("textarea[name=glossPrompt]")).toHaveValue("Keep the local prompt.");

  await page.locator("input[name=learningWindowDays]").fill("8");
  await page.locator("#save-settings").click();
  await expect(page.locator("#status")).toHaveText("已保存");
  const patch = await page.evaluate(() => {
    const requests = (Reflect.get(window, "__glossaUiFixture") as { requests: Array<{ type: string; payload: unknown }> }).requests;
    return requests.filter((request) => request.type === "settings.patch").at(-1)?.payload as { patch: Record<string, unknown> };
  });
  expect(patch.patch).toEqual({ learningWindowDays: 8, prompts: { gloss: "Keep the local prompt." } });
});

test("options refreshes Anki through a real click after the endpoint changes", async ({ page }) => {
  await loadOptionsHtml(page);
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
  await loadOptionsHtml(page);
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
  await loadOptionsHtml(page);
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

test("options disables save until settings load and offers a working load retry", async ({ page }) => {
  await loadOptionsHtml(page);
  await installUiRuntime(page, { failOnceTypes: ["settings.get"], deferredTypes: ["settings.get"] });
  await page.addScriptTag({ path: resolve("dist/options.js"), type: "module" });
  await expect(page.locator("#status")).toHaveText("设置加载失败，请重试加载。");
  await expect(page.locator("#save-settings")).toBeDisabled();
  await expect(page.locator("#settings-form")).toHaveJSProperty("inert", true);
  if (process.env.GLOSSA_SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.GLOSSA_SCREENSHOT_DIR}/load-error.png` });
  await page.locator("#retry-settings").click();
  await expect(page.locator("#status")).toHaveText("正在加载设置…");
  await expect(page.locator("#save-settings")).toBeDisabled();
  await expect(page.locator("#settings-form")).toHaveJSProperty("inert", true);
  if (process.env.GLOSSA_SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.GLOSSA_SCREENSHOT_DIR}/loading.png` });
  await page.evaluate(() => (Reflect.get(window, "__glossaUiFixture") as { release(type: string): void }).release("settings.get"));
  await expect(page.locator("#settings-form")).toHaveJSProperty("inert", false);
  await expect(page.locator("#save-settings")).toBeEnabled();
  await expect(page.locator("#retry-settings")).toBeHidden();
});

test("options keeps a pending save disabled when a newer edit is invalid", async ({ page }) => {
  await loadOptionsHtml(page);
  await installUiRuntime(page, { deferredTypes: ["settings.patch"] });
  await page.addScriptTag({ path: resolve("dist/options.js"), type: "module" });
  await expect(page.locator("#settings-form")).toHaveJSProperty("inert", false);
  await page.locator("input[name=learningWindowDays]").fill("8");
  await page.locator("#save-settings").click();
  await page.locator("input[name=aiEndpoint]").fill("localhost");
  await expect(page.locator("#save-settings")).toBeDisabled();
  await expect(page.locator("#save-settings")).toHaveAttribute("data-state", "saving");
  await page.evaluate(() => (Reflect.get(window, "__glossaUiFixture") as { release(type: string): void }).release("settings.patch"));
  await expect(page.locator("#save-settings")).toBeEnabled();
  await expect(page.locator("input[name=aiEndpoint]")).toHaveValue("localhost");
  await expect(page.locator("input[name=aiEndpoint]")).toHaveAttribute("aria-invalid", "true");
});

test("options searches existing words and recovers from an empty search", async ({ page }) => {
  await loadOptions(page);
  await page.locator("#open-known-words").click();
  for (const word of ["apple", "banana"]) {
    await page.locator("#known-word-input").fill(word);
    await page.locator("#add-known-word").click();
    await expect(page.locator("#known-words-status")).toHaveText("已添加");
  }
  await page.locator("#known-words-search").fill("APP");
  await expect(page.locator(".known-word-row")).toHaveCount(1);
  await expect(page.locator(".known-word-row")).toContainText("apple");
  if (process.env.GLOSSA_SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.GLOSSA_SCREENSHOT_DIR}/search.png` });
  await page.locator("#known-words-search").fill("missing");
  await expect(page.locator("#known-words-list")).toHaveText("没有匹配的词汇，请修改搜索内容。");
  await expect(page.locator("#known-words-nav")).toBeHidden();
  await page.locator("#known-words-search").fill("");
  await expect(page.locator(".known-word-row")).toHaveCount(2);
});

test("options explains unavailable, loading, empty, and failed Anki catalogs", async ({ page }) => {
  await loadOptionsHtml(page);
  await installUiRuntime(page);
  await page.evaluate(() => {
    Reflect.set(window, "fetch", (...args: unknown[]) => (Reflect.get(window, "__catalogFetch") as (...args: unknown[]) => Promise<Response>)(...args));
    Reflect.set(window, "__catalogFetch", async (_url: string, init?: RequestInit) => {
      const { action } = JSON.parse(String(init?.body)) as { action: string };
      return new Response(JSON.stringify({ error: null, result: action === "version" ? 6 : action === "modelNames" ? ["Basic"] : action === "modelFieldNames" ? ["Front", "Back"] : [] }));
    });
  });
  await page.addScriptTag({ path: resolve("dist/options.js"), type: "module" });
  await expect(page.locator("#settings-form")).toHaveJSProperty("inert", false);
  await expect(page.locator("#anki-catalog-help")).toContainText("目录尚未读取");
  await expect(page.locator("#refresh-anki")).toHaveText("刷新牌组与模板");
  await expect(page.locator("select[name=ankiDeck]")).toBeDisabled();
  await page.getByRole("button", { name: "刷新牌组与模板" }).click();
  await expect(page.locator("#anki-catalog-help")).toContainText("未找到牌组");
  if (process.env.GLOSSA_SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.GLOSSA_SCREENSHOT_DIR}/catalog-empty.png` });
  await expect(page.locator("select[name=ankiDeck]")).toBeDisabled();
  await page.evaluate(() => {
    Reflect.set(window, "__catalogFetch", () => new Promise((_resolve, reject) => {
      Reflect.set(window, "__rejectCatalog", () => reject(new TypeError("offline")));
    }));
  });
  await page.getByRole("button", { name: "刷新牌组与模板" }).click();
  await expect(page.locator("#anki-catalog-help")).toContainText("正在读取");
  await page.evaluate(() => (Reflect.get(window, "__rejectCatalog") as () => void)());
  await expect(page.locator("#anki-catalog-help")).toContainText("请检查后刷新");
  if (process.env.GLOSSA_SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.GLOSSA_SCREENSHOT_DIR}/catalog-error.png` });
});

for (const width of [1440, 390, 320]) {
  test(`options keeps save feedback reachable and empty vocabulary readable at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await loadOptions(page);
    if (process.env.GLOSSA_SCREENSHOT_DIR) {
      await page.screenshot({ path: `${process.env.GLOSSA_SCREENSHOT_DIR}/normal-${width}.png`, fullPage: true });
      await page.locator(".settings-grid").screenshot({ path: `${process.env.GLOSSA_SCREENSHOT_DIR}/ai-anki-${width}.png` });
    }
    await page.locator("textarea[name=ankiPrompt]").fill("Updated card prompt");
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await expect(page.locator("#save-settings")).toBeInViewport();
    await page.locator("#save-settings").click();
    await expect(page.locator("#status")).toHaveText("已保存");
    await expect(page.locator("#status")).toBeInViewport();
    if (process.env.GLOSSA_SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.GLOSSA_SCREENSHOT_DIR}/bottom-${width}.png` });
    await page.locator("#open-known-words").click();
    await expect(page.locator("#known-words-list")).toHaveText("当前没有已掌握词汇。");
    const list = await page.locator("#known-words-list").boundingBox();
    expect(list!.width).toBeGreaterThan(180);
    if (process.env.GLOSSA_SCREENSHOT_DIR) {
      await page.screenshot({ path: `${process.env.GLOSSA_SCREENSHOT_DIR}/empty-${width}.png` });
      await page.locator("#known-word-input").fill("apple");
      await page.locator("#add-known-word").click();
      await expect(page.locator(".known-word-row")).toHaveCount(1);
      await page.screenshot({ path: `${process.env.GLOSSA_SCREENSHOT_DIR}/known-word-${width}.png` });
    }
  });
}

test("options does not unlock an Anki refresh when an unrelated AI field is invalid", async ({ page }) => {
  await loadOptionsHtml(page);
  await installUiRuntime(page);
  await page.evaluate(() => {
    Reflect.set(window, "fetch", () => new Promise(() => {}));
  });
  await page.addScriptTag({ path: resolve("dist/options.js"), type: "module" });
  await expect(page.locator("#settings-form")).toHaveJSProperty("inert", false);
  await page.locator("#refresh-anki").click();
  await expect(page.locator("#refresh-anki")).toBeDisabled();
  await page.locator("input[name=aiEndpoint]").fill("localhost");
  await expect(page.locator("#refresh-anki")).toBeDisabled();
  await expect(page.locator("#anki-catalog-help")).toContainText("正在读取");
});

test("options keeps clear known words pending while searching cached records", async ({ page }) => {
  await loadOptionsHtml(page);
  await installUiRuntime(page, {
    knownRecords: [{ key: "en:alpha", lang: "en", lemma: "alpha", surface: "alpha", state: "known" }],
    deferredTypes: ["known.words.clear"]
  });
  await page.addScriptTag({ path: resolve("dist/options.js"), type: "module" });
  await expect(page.locator("#settings-form")).toHaveJSProperty("inert", false);
  await page.locator("#open-known-words").click();
  await expect(page.locator(".known-word-row")).toHaveCount(1);

  let confirmations = 0;
  page.on("dialog", async (dialog) => {
    confirmations += 1;
    await dialog.accept();
  });
  await page.locator("#clear-known-words").click();
  await expect(page.locator("#clear-known-words")).toBeDisabled();
  await expect(page.locator("#known-words-status")).toHaveText("正在清空…");
  await page.locator("#known-words-search").fill("missing");
  await expect(page.locator(".known-word-row")).toHaveCount(0);
  await expect(page.locator("#clear-known-words")).toBeDisabled();
  await page.locator("#known-words-search").fill("");
  await expect(page.locator(".known-word-row")).toHaveCount(1);
  await expect(page.locator("#clear-known-words")).toBeDisabled();

  await page.evaluate(() => (Reflect.get(window, "__glossaUiFixture") as { release(type: string): void }).release("known.words.clear"));
  await expect(page.locator("#known-words-status")).toHaveText("已清空");
  await expect(page.locator(".known-word-row")).toHaveCount(0);
  await expect(page.locator("#clear-known-words")).toBeDisabled();
  expect(confirmations).toBe(1);
  const requests = await page.evaluate(() => (Reflect.get(window, "__glossaUiFixture") as { requests: Array<{ type: string }> }).requests);
  expect(requests.filter((request) => request.type === "known.words.clear")).toHaveLength(1);
});
