import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

async function deleteGlossaDatabase(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await new Promise<void>((resolve, reject) => {
      const deleteRequest = indexedDB.deleteDatabase("glossa");
      deleteRequest.onsuccess = () => resolve();
      deleteRequest.onerror = () => reject(deleteRequest.error);
      deleteRequest.onblocked = () => reject(new Error("glossa IndexedDB deletion was blocked"));
    });
  });
}

async function glossaDatabaseExists(page: Page): Promise<boolean> {
  return await page.evaluate(async () => {
    const databases = await indexedDB.databases();
    return databases.some((database) => database.name === "glossa" && database.version === 2);
  });
}

async function glossaDatabaseHasStore(page: Page, storeName: string): Promise<boolean> {
  return await page.evaluate(async (name) => {
    return await new Promise<boolean>((resolve, reject) => {
      const request = indexedDB.open("glossa", 2);
      request.onsuccess = () => {
        const db = request.result;
        const hasStore = db.objectStoreNames.contains(name);
        db.close();
        resolve(hasStore);
      };
      request.onerror = () => reject(request.error);
    });
  }, storeName);
}

test("options page captures shortcuts, previews style changes and saves prompts", async ({ page }) => {
  const html = await readFile(resolve("dist/options/options.html"), "utf8");
  await page.route("https://options.test/", (route) => route.fulfill({ contentType: "text/html", body: "<!doctype html><html></html>" }));
  await page.goto("https://options.test/");
  await page.setContent(html.replace("<link rel=\"stylesheet\" href=\"../assets/options.css\">", "").replace("<script type=\"module\" src=\"../options.js\"></script>", ""));
  await page.addStyleTag({ path: resolve("dist/assets/options.css") });
  await page.evaluate(() => {
    const store: Record<string, unknown> = {};
    const aiRequests: Array<{ url: string; body: unknown }> = [];
    Reflect.set(window, "__glossaStore", store);
    Reflect.set(window, "__aiRequests", aiRequests);
    Reflect.set(window, "fetch", async (url: string, init?: RequestInit) => {
      if (!url.includes("8765")) {
        aiRequests.push({
          url,
          body: init?.body ? JSON.parse(init.body as string) : undefined
        });
        return new Response(JSON.stringify({ result: null }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      const body = JSON.parse(init?.body as string) as { action: string; params?: { modelName?: string } };
      const resultByAction: Record<string, unknown> = {
        version: 6,
        deckNames: ["general", "Glossa", "temp"],
        modelNames: ["KaTeX and Markdown Basic", "问答题"],
        modelFieldNames: body.params?.modelName === "KaTeX and Markdown Basic" ? ["Front", "Back"] : ["正面", "背面"]
      };
      return new Response(JSON.stringify({ result: resultByAction[body.action], error: null }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    });
    const runtimeApi: { lastError: { message: string } | undefined; sendMessage(message: { type: string; requestId: string; source: string }, callback: (response: unknown) => void): void } = {
      lastError: undefined,
      sendMessage(message, callback) {
        if (Reflect.get(window, "__glossaFailCacheClear")) {
          runtimeApi.lastError = { message: "cache clear failed" };
          callback(undefined);
          runtimeApi.lastError = undefined;
          return;
        }
        if (message.type !== "gloss.cache.clear") {
          callback({
            type: "error",
            version: 1,
            requestId: message.requestId,
            source: "service-worker",
            target: message.source,
            createdAt: Date.now(),
            payload: { reason: "runtime", message: "unknown message", service: "runtime" }
          });
          return;
        }
        const request = indexedDB.open("glossa", 2);
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction("glossCache", "readwrite");
          tx.objectStore("glossCache").clear();
          tx.oncomplete = () => {
            db.close();
            callback({
              type: "gloss.cache.cleared",
              version: 1,
              requestId: message.requestId,
              source: "service-worker",
              target: message.source,
              createdAt: Date.now(),
              payload: {}
            });
          };
        };
      }
    };
    Reflect.set(window, "chrome", {
      runtime: runtimeApi,
      storage: {
        local: {
          get(key: string, callback: (result: Record<string, unknown>) => void) {
            callback({ [key]: store[key] });
          },
          set(value: Record<string, unknown>, callback?: () => void) {
            if (Reflect.get(window, "__glossaFailSettingsSave")) {
              runtimeApi.lastError = { message: "settings save failed" };
              callback?.();
              runtimeApi.lastError = undefined;
              return;
            }
            Object.assign(store, value);
            callback?.();
          }
        }
      }
    });
  });
  await deleteGlossaDatabase(page);
  await page.evaluate(async () => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open("glossa", 2);
      request.onupgradeneeded = () => {
        const db = request.result;
        for (const store of ["lexicon", "glossCache", "cardCache", "cardedWords"]) {
          if (!db.objectStoreNames.contains(store)) {
            db.createObjectStore(store);
          }
        }
      };
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction(["lexicon", "glossCache", "cardCache", "cardedWords"], "readwrite");
        tx.objectStore("lexicon").put({
          key: "en:archive",
          lemma: "archive",
          surface: "archive",
          lang: "en",
          state: "known",
          shownCount: 1,
          clickCount: 0,
          ankiNoteIds: []
        }, "en:archive");
        tx.objectStore("lexicon").put({
          key: "en:legacy",
          lemma: "legacy",
          surface: "legacy",
          lang: "en",
          state: "known",
          shownCount: 1,
          clickCount: 1,
          lastClickedAt: 777,
          ankiNoteIds: [99]
        }, "en:legacy");
        tx.objectStore("lexicon").put({
          key: "en:vector",
          lemma: "vector",
          surface: "vector",
          lang: "en",
          state: "known",
          shownCount: 1,
          clickCount: 1,
          lastClickedAt: 888,
          ankiNoteIds: [100]
        }, "en:vector");
        tx.objectStore("glossCache").put({
          tokenId: "cached-token",
          targetText: "cached",
          display: "缓存",
          phrase: "cached"
        }, "gloss:cached");
        tx.objectStore("cardCache").put({ cards: [{ front: "front", back: "back" }] }, "card:legacy");
        tx.objectStore("cardedWords").put({
          key: "en:seeded",
          lang: "en",
          lemma: "seeded",
          createdAt: 1
        }, "en:seeded");
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      };
      request.onerror = () => reject(request.error);
    });
  });
  await page.addScriptTag({ type: "module", path: resolve("dist/options.js") });

  await expect(page.locator("select[name=ankiModelName]")).toHaveValue("Basic");
  await expect(page.locator("select[name=ankiModelName]")).toBeEnabled();
  await expect(page.locator("#save-settings .save-label")).toHaveText("保存");
  await expect(page.locator("#status")).toHaveText("");
  await expect(page.getByRole("link", { name: "重新打开首次设置" })).toHaveAttribute("href", "../onboarding/onboarding.html");

  await expect(page.locator('.section-nav a[href="#reading-section"]')).toHaveAttribute("aria-current", "location");
  await page.setViewportSize({ width: 1280, height: 6000 });
  expect(await page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight)).toBe(true);
  await expect(page.locator('.section-nav a[href="#reading-section"]')).toHaveAttribute("aria-current", "location");
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.evaluate(() => {
    document.documentElement.style.scrollBehavior = "auto";
    const section = document.querySelector<HTMLElement>("#appearance-section")!;
    window.scrollTo(0, section.getBoundingClientRect().top + window.scrollY - 100);
  });
  await expect(page.locator('.section-nav a[href="#appearance-section"]')).toHaveAttribute("aria-current", "location");
  await test.step("keeps AI current when the AI and Anki panels share a row", async () => {
    await page.evaluate(() => {
      const section = document.querySelector<HTMLElement>("#ai-section")!;
      window.scrollTo(0, section.getBoundingClientRect().top + window.scrollY - 100);
    });
    await expect(page.locator('.section-nav a[href="#ai-section"]')).toHaveAttribute("aria-current", "location");
  });
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await expect(page.locator('.section-nav a[href="#cache-section"]')).toHaveAttribute("aria-current", "location");
  await page.evaluate(() => window.scrollTo(0, 0));

  await page.locator("#shortcut-capture").click();
  await page.keyboard.down("Control");
  await page.keyboard.down("Shift");
  await page.keyboard.press("KeyK");
  await page.keyboard.up("Shift");
  await page.keyboard.up("Control");
  await page.locator("#translate-shortcut-capture").click();
  await page.keyboard.down("Alt");
  await page.keyboard.press("KeyG");
  await page.keyboard.up("Alt");
  await expect(page.locator("#save-settings .save-label")).toHaveText("保存更改");
  await expect(page.locator("#status")).toHaveAttribute("data-state", "dirty");
  await expect(page.locator("#status")).toHaveText("快捷键已记录，等待保存");

  await page.locator("input[name=glossTextColor]").fill("#ff5500");
  await page.locator("input[name=glossBackgroundColor]").fill("#113355");
  await page.locator("input[name=cardSuccessBackgroundColor]").fill("#228833");
  await page.locator("input[name=cardErrorBackgroundColor]").fill("#cc2222");
  await page.locator("input[name=glossBackgroundOpacity]").fill("0.65");
  await expect(page.locator("#gloss-background-opacity-value")).toHaveText("65%");
  await expect(page.locator("input[name=glossBackgroundOpacity]")).toHaveAttribute("aria-valuetext", "65%");
  await page.locator("select[name=glossFontFamily]").selectOption("Georgia, Times New Roman, serif");
  await page.locator("input[name=glossFontSize]").fill("18");
  await expect(page.locator("select[name=knownWordList] option")).toHaveCount(7);
  await expect(page.locator("select[name=knownWordList]")).toContainText("托福 6586 词");
  await page.locator("select[name=knownWordList]").selectOption("toefl");
  await page.locator("input[name=glossCacheTtlHours]").fill("48");
  await page.locator("input[name=autoTranslateEnabled]").check();
  await page.locator("select[name=provider]").selectOption("openai-chat-completions");
  await page.locator("select[name=reasoningEffort]").selectOption("high");
  await page.locator("input[name=aiRequestTimeoutSeconds]").fill("45");
  await expect(page.locator("input[name=aiEndpoint]")).toHaveValue("https://api.openai.com/v1/chat/completions");
  await page.locator("#refresh-anki").click();
  await expect(page.locator("select[name=ankiDeck]")).toBeEnabled();
  await expect(page.locator("select[name=ankiDeck] option")).toHaveCount(3);
  await expect(page.locator("select[name=ankiModelName] option")).toHaveCount(1);
  await expect(page.locator("select[name=ankiModelName]")).toHaveValue("KaTeX and Markdown Basic");
  await page.locator("select[name=ankiDeck]").selectOption("temp");
  await page.locator("input[name=ankiRequestTimeoutSeconds]").fill("35");
  await page.locator("input[name=duplicatePromptSeconds]").fill("7");
  await page.locator("textarea[name=glossPrompt]").fill("Use compact contextual labels.");
  await page.locator("textarea[name=ankiPrompt]").fill("Create concise learning cards.");
  await page.getByRole("button", { name: "重置释义提示词" }).click();
  await expect(page.locator("textarea[name=glossPrompt]")).toHaveValue("Translate each unfamiliar English word or phrase into Simplified Chinese for its current context. Return a short inline label that fits above the source word.");
  await page.getByRole("button", { name: "重置 Anki 卡片提示词" }).click();
  await expect(page.locator("textarea[name=ankiPrompt]")).toHaveValue("Create Anki cards for the clicked English word. Put an English example sentence for the target sense on the front and bold the target word. Put only the direct Simplified Chinese meaning for the current context on the back.");
  await page.locator("textarea[name=glossPrompt]").fill("Use compact contextual labels.");
  await page.locator("textarea[name=ankiPrompt]").fill("Create concise learning cards.");
  await expect(page.locator("#known-words-summary")).toHaveText("共 3 个已掌握词汇。");
  await page.locator("#open-known-words").click();
  await expect(page.locator("#known-words-dialog")).toBeVisible();
  await expect(page.locator("#known-words-nav button")).toHaveCount(3);
  await page.locator("#known-word-input").fill("two words");
  await page.locator("#known-word-input").press("Enter");
  await expect(page.locator("#known-words-status")).toHaveText("请输入一个英文单词，可包含连字符或撇号");
  await expect(page.locator("#known-word-input")).toHaveValue("two words");
  await page.setViewportSize({ width: 320, height: 720 });
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).minWidth)).toBe("0px");
  const narrowKnownWordsNav = await page.locator("#known-words-nav").evaluate((nav) => {
    const firstButton = nav.querySelector("button")!;
    const buttonRect = firstButton.getBoundingClientRect();
    return {
      clientWidth: nav.clientWidth,
      scrollWidth: nav.scrollWidth,
      buttonWidth: buttonRect.width,
      buttonHeight: buttonRect.height
    };
  });
  expect(narrowKnownWordsNav.scrollWidth).toBeLessThanOrEqual(narrowKnownWordsNav.clientWidth + 1);
  expect(narrowKnownWordsNav.buttonWidth).toBeGreaterThanOrEqual(24);
  expect(narrowKnownWordsNav.buttonHeight).toBeGreaterThanOrEqual(28);
  expect(await page.locator("#known-words-list").evaluate((list) => getComputedStyle(list).overflowY)).toBe("visible");
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.locator("#known-words-nav button", { hasText: "L" }).click();
  await expect(page.locator("#known-words-l")).toBeInViewport();
  await expect(page.locator("#known-words-list")).toContainText("archive");
  await page.locator(".known-word-row", { hasText: "archive" }).getByRole("button", { name: "移除" }).click();
  await expect(page.locator("#known-words-list")).not.toContainText("archive");
  await expect(page.locator("#known-words-list")).toContainText("legacy");
  await page.locator("#known-word-input").fill("legacy");
  await page.locator("#add-known-word").click();
  expect(await page.evaluate(async () => {
    return await new Promise<unknown>((resolve, reject) => {
      const request = indexedDB.open("glossa", 2);
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction("cardedWords", "readonly");
        const getRequest = tx.objectStore("cardedWords").get("en:legacy");
        getRequest.onsuccess = () => {
          db.close();
          resolve(getRequest.result);
        };
        getRequest.onerror = () => reject(getRequest.error);
      };
      request.onerror = () => reject(request.error);
    });
  })).toMatchObject({ key: "en:legacy", lemma: "legacy", createdAt: 777 });
  await page.locator(".known-word-row", { hasText: "legacy" }).getByRole("button", { name: "移除" }).click();
  await expect(page.locator("#known-words-list")).not.toContainText("legacy");
  expect(await page.evaluate(async () => {
    return await new Promise<unknown>((resolve, reject) => {
      const request = indexedDB.open("glossa", 2);
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction("cardedWords", "readonly");
        const getRequest = tx.objectStore("cardedWords").get("en:legacy");
        getRequest.onsuccess = () => {
          db.close();
          resolve(getRequest.result);
        };
        getRequest.onerror = () => reject(getRequest.error);
      };
      request.onerror = () => reject(request.error);
    });
  })).toMatchObject({ key: "en:legacy", lemma: "legacy", createdAt: 777 });
  await page.locator("#known-word-input").fill("calibrate");
  await page.locator("#known-word-input").press("Enter");
  await expect(page.locator("#known-words-list")).toContainText("calibrate");
  const cancelClearDialog = page.waitForEvent("dialog", { timeout: 5_000 });
  const cancelClearClick = page.locator("#clear-known-words").click();
  const cancelDialog = await cancelClearDialog;
  await cancelDialog.dismiss();
  await cancelClearClick;
  await expect(page.locator("#known-words-list")).toContainText("calibrate");
  const confirmClearDialog = page.waitForEvent("dialog", { timeout: 5_000 });
  const confirmClearClick = page.locator("#clear-known-words").click();
  const confirmDialog = await confirmClearDialog;
  await confirmDialog.accept();
  await confirmClearClick;
  await expect(page.locator("#known-words-summary")).toHaveText("当前没有已掌握词汇。");
  await expect(page.locator("#known-words-list")).not.toContainText("calibrate");
  expect(await page.evaluate(async () => {
    return await new Promise<unknown>((resolve, reject) => {
      const request = indexedDB.open("glossa", 2);
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction(["lexicon", "cardedWords"], "readonly");
        const calibrateRequest = tx.objectStore("lexicon").get("en:calibrate");
        const vectorRequest = tx.objectStore("cardedWords").get("en:vector");
        tx.oncomplete = () => {
          db.close();
          resolve({ calibrate: calibrateRequest.result, vector: vectorRequest.result });
        };
        tx.onerror = () => reject(tx.error);
      };
      request.onerror = () => reject(request.error);
    });
  })).toMatchObject({ vector: { key: "en:vector", lemma: "vector", createdAt: 888 } });
  await page.locator("#close-known-words").click();
  await page.locator("#clear-gloss-cache").click();
  await expect(page.locator("#status")).toHaveText("翻译缓存已清空");
  await expect(page.locator("#status")).toHaveAttribute("data-state", "success");
  expect(await page.evaluate(async () => {
    return await new Promise<number>((resolve, reject) => {
      const request = indexedDB.open("glossa", 2);
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction("glossCache", "readonly");
        const countRequest = tx.objectStore("glossCache").count();
        countRequest.onsuccess = () => {
          db.close();
          resolve(countRequest.result);
        };
        countRequest.onerror = () => reject(countRequest.error);
      };
      request.onerror = () => reject(request.error);
    });
  })).toBe(0);
  await page.evaluate(() => Reflect.set(window, "__glossaFailCacheClear", true));
  await page.locator("#clear-gloss-cache").click();
  await expect(page.locator("#status")).toHaveText("扩展运行时错误");
  await expect(page.locator("#status")).toHaveAttribute("data-state", "error");
  await page.evaluate(() => Reflect.set(window, "__glossaFailCacheClear", false));

  await expect(page.locator("#shortcut-capture")).toHaveText("Ctrl+Shift+K");
  await expect(page.locator("#translate-shortcut-capture")).toHaveText("Alt+G");
  await expect(page.locator(".preview-gloss").first()).toHaveCSS("color", "rgb(255, 85, 0)");
  await expect(page.locator(".preview-gloss").first()).toHaveCSS("font-size", "18px");
  await expect(page.locator(".preview-gloss-success")).toHaveCSS("background-color", "rgba(34, 136, 51, 0.65)");
  await expect(page.locator(".preview-gloss-error")).toHaveCSS("background-color", "rgba(204, 34, 34, 0.65)");
  await expect(page.locator("#test-ai")).toHaveText("测试 AI");
  await expect(page.locator("#test-anki")).toHaveText("测试 Anki");
  const buttonPositions = await page.evaluate(() => {
    const reasoning = document.querySelector("select[name=reasoningEffort]")!.getBoundingClientRect();
    const testAi = document.querySelector("#test-ai")!.getBoundingClientRect();
    const ankiDeck = document.querySelector("select[name=ankiDeck]")!.getBoundingClientRect();
    const testAnki = document.querySelector("#test-anki")!.getBoundingClientRect();
    return {
      aiBelowReasoning: testAi.top >= reasoning.bottom,
      ankiBelowDeck: testAnki.top >= ankiDeck.bottom
    };
  });
  expect(buttonPositions).toEqual({ aiBelowReasoning: true, ankiBelowDeck: true });

  await page.locator("input[name=aiEndpoint]").fill("https://custom-ai.test/v1");
  await page.locator("select[name=provider]").selectOption("glossa-backend");
  await expect(page.locator("input[name=aiEndpoint]")).toHaveValue("https://custom-ai.test/v1");
  await expect(page.locator("[data-ai-field=api-key]")).toBeHidden();
  await expect(page.locator("[data-ai-field=reasoning]")).toBeVisible();
  await page.locator("textarea[name=glossPrompt]").fill("Use compact contextual labels.");
  await page.locator("#test-ai").click();
  await expect(page.locator("#test-ai")).toHaveAttribute("data-state", "success");
  const glossaBackendPayload = await page.evaluate(() => {
    const requests = Reflect.get(window, "__aiRequests") as Array<{ url: string; body: Record<string, unknown> }>;
    return requests.find((request) => request.url.endsWith("/gloss"))?.body;
  });
  expect(glossaBackendPayload).toMatchObject({
    items: [],
    targetLang: "zh-CN",
    prompt: "Use compact contextual labels.",
    reasoningEffort: "high",
    promptVersion: "gloss-v1",
    modelVersion: "gpt-4.1-mini"
  });

  await page.locator("select[name=provider]").selectOption("openai-completions");
  await expect(page.locator("[data-ai-field=api-key]")).toBeVisible();
  await expect(page.locator("[data-ai-field=reasoning]")).toBeHidden();
  await page.locator("select[name=provider]").selectOption("openai-chat-completions");
  await page.locator("select[name=reasoningEffort]").selectOption("high");
  await expect(page.locator("input[name=aiEndpoint]")).toHaveValue("https://custom-ai.test/v1");
  await page.locator("#test-ai").click();
  await expect(page.locator("#test-ai")).toHaveAttribute("data-state", "success");
  await expect(page.locator("#test-ai .test-label")).not.toBeVisible();
  await expect(page.locator("#test-ai .test-icon-success")).toBeVisible();
  await expect(page.locator("#test-ai")).toHaveCSS("width", "44px");
  await expect(page.locator("#ai-status")).toHaveText("AI 连接可用");
  await expect(page.locator("#ai-status")).toHaveAttribute("data-state", "success");
  await expect(page.locator("#status")).toHaveText("有未保存的更改");
  await page.locator("input[name=modelVersion]").fill("gpt-edited-after-test");
  await expect(page.locator("#test-ai")).toHaveAttribute("data-state", "idle");
  await expect(page.locator("#ai-status")).toHaveText("");
  await page.locator("input[name=modelVersion]").fill("gpt-4.1-mini");
  await page.locator("#test-ai").click();
  await expect(page.locator("#test-ai")).toHaveAttribute("data-state", "success");

  await page.locator("#test-anki").click();
  await expect(page.locator("#test-anki")).toHaveAttribute("data-state", "success");
  await expect(page.locator("#test-anki .test-label")).not.toBeVisible();
  await expect(page.locator("#test-anki .test-icon-success")).toBeVisible();
  await expect(page.locator("#test-anki")).toHaveCSS("width", "44px");
  await expect(page.locator("#anki-status")).toHaveText("Anki 连接可用");
  await expect(page.locator("#anki-status")).toHaveAttribute("data-state", "success");
  await expect(page.locator("#status")).toHaveText("有未保存的更改");
  await page.locator("select[name=ankiDeck]").selectOption("general");
  await expect(page.locator("#test-anki")).toHaveAttribute("data-state", "idle");
  await expect(page.locator("#anki-status")).toHaveText("");
  await page.locator("select[name=ankiDeck]").selectOption("temp");
  await page.locator("#test-anki").click();
  await expect(page.locator("#test-anki")).toHaveAttribute("data-state", "success");

  await page.evaluate(async () => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open("glossa", 2);
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction("lexicon", "readwrite");
        tx.objectStore("lexicon").put({
          key: "en:reset-history",
          lemma: "reset-history",
          surface: "reset-history",
          lang: "en",
          state: "learning_active",
          shownCount: 1,
          clickCount: 1,
          ankiNoteIds: [101]
        }, "en:reset-history");
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      };
      request.onerror = () => reject(request.error);
    });
  });

  const resetHistoryDialog = page.waitForEvent("dialog", { timeout: 5_000 });
  const resetHistoryClick = page.locator("#reset-card-history").click();
  const historyDialog = await resetHistoryDialog;
  expect(historyDialog.message()).toContain("Anki 中已有卡片会保留");
  await historyDialog.accept();
  await resetHistoryClick;
  await expect(page.locator("#anki-status")).toHaveText("制卡记录已重置，Anki 中已有卡片保持不变");
  expect(await page.evaluate(async () => {
    return await new Promise<Record<string, number>>((resolve, reject) => {
      const request = indexedDB.open("glossa", 2);
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction(["cardCache", "cardedWords", "lexicon"], "readwrite");
        const cardCache = tx.objectStore("cardCache").count();
        const cardedWords = tx.objectStore("cardedWords").count();
        const lexiconStore = tx.objectStore("lexicon");
        const lexicon = lexiconStore.getAll();
        lexicon.onsuccess = () => lexiconStore.delete("en:reset-history");
        tx.oncomplete = () => {
          db.close();
          const noteIds = (lexicon.result as Array<{ ankiNoteIds?: number[] }>)
            .reduce((total, record) => total + (record.ankiNoteIds?.length ?? 0), 0);
          resolve({ cardCache: cardCache.result, cardedWords: cardedWords.result, noteIds });
        };
        tx.onerror = () => reject(tx.error);
      };
      request.onerror = () => reject(request.error);
    });
  })).toEqual({ cardCache: 0, cardedWords: 0, noteIds: 0 });

  await page.locator("#save-settings").click();
  await expect(page.locator("#status")).toHaveText("已保存");
  await expect(page.locator("#status")).toHaveAttribute("data-state", "success");
  await expect(page.locator("#save-settings .save-label")).toHaveText("保存");
  await expect(page.locator("#save-settings")).toBeEnabled();

  const settings = await page.evaluate(() => (Reflect.get(window, "__glossaStore") as { settings: unknown }).settings);
  expect(settings).toMatchObject({
    shortcutKey: "Ctrl+Shift+K",
    autoTranslateEnabled: true,
    glossCacheTtlMs: 172800000,
    knownWordList: "toefl",
    appearance: {
      textColor: "#ff5500",
      backgroundColor: "#113355",
      cardSuccessBackgroundColor: "#228833",
      cardErrorBackgroundColor: "#cc2222",
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
      reasoningEffort: "high",
      requestTimeoutMs: 45000
    },
    anki: {
      deck: "temp",
      modelName: "KaTeX and Markdown Basic",
      requestTimeoutMs: 35000,
      duplicatePromptMs: 7000
    }
  });
  const storedSettings = settings as Record<string, unknown>;
  expect(storedSettings).not.toHaveProperty("translateShortcutKey");
  expect(storedSettings).not.toHaveProperty("learningWindowDays");
  expect(storedSettings).not.toHaveProperty("promptVersion");
  expect(storedSettings).not.toHaveProperty("modelVersion");
  expect(storedSettings.ai as Record<string, unknown>).toHaveProperty("endpoint", "https://custom-ai.test/v1");
  expect(storedSettings.anki as Record<string, unknown>).not.toHaveProperty("endpoint");
  expect(await page.evaluate(async () => {
    return await new Promise<unknown>((resolve, reject) => {
      const request = indexedDB.open("glossa", 2);
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction("lexicon", "readonly");
        const countRequest = tx.objectStore("lexicon").count();
        countRequest.onsuccess = () => {
          db.close();
          resolve(countRequest.result);
        };
        countRequest.onerror = () => reject(countRequest.error);
      };
      request.onerror = () => reject(request.error);
    });
  })).toBe(0);

  await page.locator("input[name=learningWindowDays]").fill("9");
  await page.evaluate(() => Reflect.set(window, "__glossaFailSettingsSave", true));
  await page.locator("#save-settings").click();
  await expect(page.locator("#status")).toHaveText("设置保存失败，请重试");
  await expect(page.locator("#status")).toHaveAttribute("data-state", "error");
  await expect(page.locator("#save-settings .save-label")).toHaveText("重试保存");
  await expect(page.locator("#save-settings")).toBeEnabled();
  await page.evaluate(() => Reflect.set(window, "__glossaFailSettingsSave", false));
  await page.locator("#save-settings").click();
  await expect(page.locator("#status")).toHaveText("已保存");
  await expect(page.locator("#save-settings .save-label")).toHaveText("保存");
});

test("options page waits for an explicit refresh before reading Anki options", async ({ page }) => {
  const html = await readFile(resolve("dist/options/options.html"), "utf8");
  await page.route("https://options.test/", (route) => route.fulfill({ contentType: "text/html", body: "<!doctype html><html></html>" }));
  await page.goto("https://options.test/");
  await page.setContent(html.replace("<link rel=\"stylesheet\" href=\"../assets/options.css\">", "").replace("<script type=\"module\" src=\"../options.js\"></script>", ""));
  await page.addStyleTag({ path: resolve("dist/assets/options.css") });
  await page.evaluate(() => {
    const store: Record<string, unknown> = {};
    const actions: string[] = [];
    Reflect.set(window, "__glossaStore", store);
    Reflect.set(window, "__ankiUp", false);
    Reflect.set(window, "__ankiActions", actions);
    Reflect.set(window, "fetch", async (url: string, init?: RequestInit) => {
      if (!url.includes("8765")) {
        return new Response(JSON.stringify({ result: null }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      if (!Reflect.get(window, "__ankiUp")) {
        throw new TypeError("fetch failed");
      }
      const body = JSON.parse(init?.body as string) as { action: string; params?: { modelName?: string } };
      actions.push(body.action);
      const resultByAction: Record<string, unknown> = {
        version: 6,
        deckNames: ["Glossa"],
        modelNames: ["KaTeX and Markdown Basic"],
        modelFieldNames: ["Front", "Back"]
      };
      return new Response(JSON.stringify({ result: resultByAction[body.action], error: null }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    });
    Reflect.set(window, "chrome", {
      runtime: { lastError: undefined },
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

  await expect(page.locator("select[name=ankiDeck]")).toBeEnabled();
  await expect(page.locator("select[name=ankiModelName]")).toBeEnabled();
  await expect(page.locator("select[name=ankiDeck]")).toHaveValue("Glossa");
  await expect(page.locator("select[name=ankiModelName]")).toHaveValue("Basic");
  await expect(page.locator("#refresh-anki")).toBeEnabled();
  expect(await page.evaluate(() => Reflect.get(window, "__ankiActions"))).toEqual([]);

  await page.evaluate(() => Reflect.set(window, "__ankiUp", true));
  await page.locator("#refresh-anki").click();

  await expect(page.locator("select[name=ankiDeck]")).toBeEnabled();
  await expect(page.locator("select[name=ankiModelName]")).toBeEnabled();
  await expect(page.locator("select[name=ankiDeck]")).toHaveValue("Glossa");
  await expect(page.locator("select[name=ankiModelName]")).toHaveValue("KaTeX and Markdown Basic");
  expect(await page.evaluate(() => Reflect.get(window, "__ankiActions"))).toEqual([
    "version",
    "deckNames",
    "modelNames",
    "modelFieldNames"
  ]);
});

test("options page creates the carded-word store on a fresh IndexedDB", async ({ page }) => {
  const html = await readFile(resolve("dist/options/options.html"), "utf8");
  await page.route("https://options-fresh-db.test/", (route) => route.fulfill({ contentType: "text/html", body: "<!doctype html><html></html>" }));
  await page.goto("https://options-fresh-db.test/");
  await page.setContent(html.replace("<link rel=\"stylesheet\" href=\"../assets/options.css\">", "").replace("<script type=\"module\" src=\"../options.js\"></script>", ""));
  await page.addStyleTag({ path: resolve("dist/assets/options.css") });
  await page.evaluate(() => {
    const store: Record<string, unknown> = {};
    Reflect.set(globalThis, "chrome", {
      runtime: { lastError: undefined },
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
  await deleteGlossaDatabase(page);
  await page.addScriptTag({ type: "module", path: resolve("dist/options.js") });

  await expect.poll(() => glossaDatabaseExists(page)).toBe(true);
  await expect.poll(() => glossaDatabaseHasStore(page, "cardedWords")).toBe(true);
});
