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

test("onboarding keeps one visible topic per page and saves setup choices", async ({ page }) => {
  await loadOnboarding(page);
  await page.evaluate(() => {
    const store: Record<string, unknown> = {};
    const ankiRequests: unknown[] = [];
    Reflect.set(window, "__glossaStore", store);
    Reflect.set(window, "__ankiRequests", ankiRequests);
    Reflect.set(window, "fetch", async (url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(init.body as string) : undefined;
      Reflect.set(window, "__lastConnectionRequest", {
        url,
        body,
        authorization: (init?.headers as Record<string, string> | undefined)?.authorization
      });
      if (String(url).includes("876")) {
        ankiRequests.push({ url, body });
        const resultByAction: Record<string, unknown> = {
          version: 6,
          deckNames: ["general", "Glossa", "temp"],
          modelNames: ["Basic", "Broken"],
          modelFieldNames: body.params?.modelName === "Basic" ? ["Front", "Back"] : ["Front"]
        };
        return new Response(JSON.stringify({ result: resultByAction[body.action], error: null }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      return new Response(JSON.stringify({ result: null }), {
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

  await expect(page.getByRole("heading", { name: "智能识别生词" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "智能识别生词" })).toBeFocused();
  await expect.poll(() => visibleStepCount(page)).toBe(1);
  await page.locator("#continue").click();

  await expect(page.getByRole("heading", { name: "翻译本页" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "翻译本页" })).toBeFocused();
  await expect.poll(() => visibleStepCount(page)).toBe(1);
  await expect(page.locator("#back")).toBeVisible();
  await page.locator("#back").click();
  await expect(page.getByRole("heading", { name: "智能识别生词" })).toBeVisible();
  await expect(page.locator("#back")).toBeHidden();
  await page.locator("#continue").click();
  await expect(page.getByRole("heading", { name: "翻译本页" })).toBeVisible();
  await page.locator("#continue").click();

  await expect(page.getByRole("heading", { name: "加入 Anki" })).toBeVisible();
  await page.locator("#continue").click();

  await expect(page.getByRole("heading", { name: "选择基础词表" })).toBeVisible();
  await expect(page.locator("select[name=knownWordList] option")).toHaveCount(7);
  await page.locator("select[name=knownWordList]").selectOption("senior-high");
  await page.locator("#continue").click();

  await expect(page.getByRole("heading", { name: "设置释义样式" })).toBeVisible();
  await page.locator("input[name=glossTextColor]").fill("#ff5500");
  await page.locator("input[name=glossBackgroundColor]").fill("#113355");
  await page.locator("input[name=cardSuccessBackgroundColor]").fill("#228833");
  await page.locator("input[name=cardErrorBackgroundColor]").fill("#cc2222");
  await page.locator("input[name=glossBackgroundOpacity]").fill("0.65");
  await expect(page.locator("#gloss-background-opacity-value")).toHaveText("65%");
  await expect(page.locator("input[name=glossBackgroundOpacity]")).toHaveAttribute("aria-valuetext", "65%");
  await page.locator("select[name=glossFontFamily]").selectOption("Georgia, Times New Roman, serif");
  await page.locator("input[name=glossFontSize]").fill("18");
  await expect(page.locator(".preview-gloss").first()).toHaveCSS("color", "rgb(255, 85, 0)");
  await expect(page.locator(".preview-gloss").first()).toHaveCSS("font-size", "18px");
  await expect(page.locator(".preview-gloss-success")).toHaveCSS("background-color", "rgba(34, 136, 51, 0.65)");
  await page.locator("#continue").click();

  await expect(page.getByRole("heading", { name: "连接 AI 服务" })).toBeVisible();
  await page.locator("#continue").click();
  await expect(page.getByRole("heading", { name: "连接 AI 服务" })).toBeVisible();
  await expect(page.locator("#ai-status")).toHaveText("请先测试 AI 连接");
  await page.locator("select[name=provider]").selectOption("openai-chat-completions");
  await expect(page.locator("input[name=aiEndpoint]")).toHaveValue("https://api.openai.com/v1/chat/completions");
  await page.locator("input[name=aiEndpoint]").fill("https://custom-ai.test/v1");
  await page.locator("select[name=provider]").selectOption("glossa-backend");
  await expect(page.locator("input[name=aiEndpoint]")).toHaveValue("https://custom-ai.test/v1");
  await expect(page.locator("[data-ai-field=api-key]")).toBeHidden();
  await page.locator("select[name=provider]").selectOption("openai-completions");
  await expect(page.locator("[data-ai-field=reasoning]")).toBeHidden();
  await page.locator("select[name=provider]").selectOption("openai-chat-completions");
  await expect(page.locator("input[name=aiEndpoint]")).toHaveValue("https://custom-ai.test/v1");
  await page.locator("input[name=apiKey]").fill("sk-test");
  await page.locator("input[name=apiKey]").press("Enter");
  await expect(page.getByRole("heading", { name: "连接 AI 服务" })).toBeVisible();
  await expect.poll(async () => page.evaluate(() => location.search)).toBe("");
  await page.locator("input[name=modelVersion]").fill("gpt-test");
  await page.locator("select[name=reasoningEffort]").selectOption("high");
  await page.locator("input[name=aiRequestTimeoutSeconds]").fill("45");
  await page.locator("#test-ai").click();
  await expect(page.locator("#test-ai")).toHaveAttribute("data-state", "success");
  await expect(page.locator("#ai-status")).toHaveText("AI 连接成功");
  await page.locator("#continue").click();

  await expect(page.getByRole("heading", { name: "连接 AnkiConnect" })).toBeVisible();
  await page.setViewportSize({ width: 320, height: 720 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
  expect(await page.locator(".footer-actions").evaluate((actions) => {
    return Array.from(actions.querySelectorAll("button:not([hidden])")).every((button) => {
      const rect = button.getBoundingClientRect();
      return rect.width > 0 && rect.left >= 0 && rect.right <= window.innerWidth;
    });
  })).toBe(true);
  await page.setViewportSize({ width: 1280, height: 720 });
  await expect(page.getByRole("link", { name: /安装 AnkiConnect/ })).toHaveAttribute("href", "https://ankiweb.net/shared/info/2055492159");
  await expect(page.locator("#refresh-anki")).toHaveAttribute("data-state", "idle");
  await expect.poll(async () => page.evaluate(() => (Reflect.get(window, "__ankiRequests") as unknown[]).length)).toBe(0);
  await expect(page.locator("select[name=ankiDeck]")).toBeDisabled();
  await page.locator("#continue").click();
  await expect(page.getByRole("heading", { name: "连接 AnkiConnect" })).toBeVisible();
  await expect(page.locator("#anki-status")).toHaveText("请连接 Anki，或选择跳过");
  await page.locator("#skip-anki").click();
  await expect(page.getByRole("heading", { name: "可以开始阅读" })).toBeVisible();
  await page.locator("#back").click();
  await expect(page.getByRole("heading", { name: "连接 AnkiConnect" })).toBeVisible();
  await page.locator("input[name=ankiEndpoint]").fill("http://127.0.0.1:8766");
  await page.locator("#refresh-anki").click();
  await expect(page.locator("select[name=ankiDeck]")).toBeEnabled();
  await page.locator("select[name=ankiDeck]").selectOption("temp");
  await page.locator("input[name=ankiRequestTimeoutSeconds]").fill("35");
  await page.locator("input[name=duplicatePromptSeconds]").fill("7");
  await page.locator("#test-anki").click();
  await expect(page.locator("#test-anki")).toHaveAttribute("data-state", "success");
  await expect(page.locator("#anki-status")).toHaveText("Anki 已连接");
  await page.locator("#continue").click();

  await expect(page.getByRole("heading", { name: "可以开始阅读" })).toBeVisible();
  await expect(page.locator("#progress")).toHaveText("8 / 8");
  const storedSettings = await page.evaluate(() => Reflect.get(window, "__glossaStore").settings);
  expect(storedSettings).toMatchObject({
    knownWordList: "senior-high",
    appearance: {
      textColor: "#ff5500",
      backgroundColor: "#113355",
      cardSuccessBackgroundColor: "#228833",
      cardErrorBackgroundColor: "#cc2222",
      backgroundOpacity: 0.65,
      fontFamily: "Georgia, Times New Roman, serif",
      fontSize: 18
    },
    ai: {
      provider: "openai-chat-completions",
      apiKey: "sk-test",
      reasoningEffort: "high",
      requestTimeoutMs: 45000
    },
    anki: {
      endpoint: "http://127.0.0.1:8766",
      deck: "temp",
      requestTimeoutMs: 35000,
      duplicatePromptMs: 7000
    },
    modelVersion: "gpt-test"
  });
  await page.locator("#continue").click();
  await expect.poll(async () => page.evaluate(() => Reflect.get(window, "__onboardingClosed"))).toBe(true);
});

test("onboarding serializes continue clicks during pending step saves", async ({ page }) => {
  await loadOnboarding(page);
  await page.evaluate(() => {
    const store: Record<string, unknown> = {};
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
            window.setTimeout(() => callback?.(), 100);
          }
        }
      }
    });
  });
  await page.addScriptTag({ type: "module", path: resolve("dist/onboarding.js") });

  await expect(page.getByRole("heading", { name: "智能识别生词" })).toBeVisible();
  await page.locator("#continue").evaluate((button) => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });

  await expect(page.locator("#continue")).toBeDisabled();
  await expect(page.getByRole("heading", { name: "智能识别生词" })).toBeVisible();
  await page.waitForTimeout(150);
  await expect(page.getByRole("heading", { name: "翻译本页" })).toBeVisible();
  await expect(page.locator("#progress")).toHaveText("2 / 8");
});

test("onboarding locks verified AI settings while advancing", async ({ page }) => {
  await loadOnboarding(page);
  await page.evaluate(() => {
    const store: Record<string, unknown> = {};
    Reflect.set(window, "fetch", async () => new Response(JSON.stringify({ items: [] }), {
      status: 200,
      headers: { "content-type": "application/json" }
    }));
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
            if (Reflect.get(window, "__holdOnboardingSave")) {
              Reflect.set(window, "__resolveOnboardingSave", callback);
              return;
            }
            callback?.();
          }
        }
      }
    });
  });
  await page.addScriptTag({ type: "module", path: resolve("dist/onboarding.js") });

  for (let step = 0; step < 5; step += 1) {
    await page.locator("#continue").click();
  }
  await expect(page.getByRole("heading", { name: "连接 AI 服务" })).toBeVisible();
  await page.locator("#test-ai").click();
  await expect(page.locator("#test-ai")).toHaveAttribute("data-state", "success");
  await page.evaluate(() => Reflect.set(window, "__holdOnboardingSave", true));

  await page.locator("#continue").click();

  for (const name of ["provider", "aiEndpoint", "apiKey", "modelVersion", "reasoningEffort", "aiRequestTimeoutSeconds"]) {
    await expect(page.locator(`[name="${name}"]`)).toBeDisabled();
  }
  await expect(page.locator("#test-ai")).toBeDisabled();

  await page.evaluate(() => {
    const resolveSave = Reflect.get(window, "__resolveOnboardingSave") as (() => void) | undefined;
    resolveSave?.();
  });
  await expect(page.getByRole("heading", { name: "连接 AnkiConnect" })).toBeVisible();
});

test("onboarding keeps the current step visible when saving fails", async ({ page }) => {
  await loadOnboarding(page);
  await page.evaluate(() => {
    const store: Record<string, unknown> = {};
    const runtime = { lastError: undefined as { message: string } | undefined };
    Reflect.set(window, "__failOnboardingSave", true);
    Reflect.set(window, "chrome", {
      runtime,
      storage: {
        local: {
          get(key: string, callback: (result: Record<string, unknown>) => void) {
            callback({ [key]: store[key] });
          },
          set(value: Record<string, unknown>, callback?: () => void) {
            if (Reflect.get(window, "__failOnboardingSave")) {
              runtime.lastError = { message: "save failed" };
              callback?.();
              runtime.lastError = undefined;
              return;
            }
            Object.assign(store, value);
            callback?.();
          }
        }
      }
    });
  });
  await page.addScriptTag({ type: "module", path: resolve("dist/onboarding.js") });

  await page.locator("#continue").click();
  await expect(page.getByRole("heading", { name: "智能识别生词" })).toBeVisible();
  await expect(page.locator("#status")).toHaveText("设置保存失败，请重试");
  await expect(page.locator("#continue")).toBeEnabled();

  await page.evaluate(() => Reflect.set(window, "__failOnboardingSave", false));
  await page.locator("#continue").click();
  await expect(page.getByRole("heading", { name: "翻译本页" })).toBeVisible();
});
