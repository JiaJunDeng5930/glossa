import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

// @verifies glossa.settings_save
// @verifies glossa.settings_save.timeout_seconds
// @verifies glossa.word_memory.known_management
// @verifies glossa.word_memory.known_management.add_known
// @verifies glossa.word_memory.known_management.store_listing
// @verifies glossa.word_memory.known_management.store_read
// @verifies glossa.word_memory.known_management.preserve_card_history
// @verifies glossa.extension_storage.typed_access.key_value_delete
// @verifies glossa.extension_storage.typed_access.lexicon_delete
// @verifies glossa.extension_storage.typed_access.lexicon_delete_impl
// @verifies glossa.card_creation.duplicate_gate.record_store_upgrade
// @verifies glossa.ai_requests.failure.timeout.options_check
// @verifies glossa.ai_requests.failure.timeout.connection_helper
// @verifies glossa.card_creation.note_request.timeout.options_check
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
  await page.evaluate(async () => {
    await new Promise<void>((resolve, reject) => {
      const deleteRequest = indexedDB.deleteDatabase("glossa");
      deleteRequest.onsuccess = () => resolve();
      deleteRequest.onerror = () => reject(deleteRequest.error);
      deleteRequest.onblocked = () => resolve();
    });
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
        const tx = db.transaction("lexicon", "readwrite");
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

  await page.locator("input[name=glossTextColor]").fill("#ff5500");
  await page.locator("input[name=glossBackgroundColor]").fill("#113355");
  await page.locator("input[name=cardSuccessBackgroundColor]").fill("#228833");
  await page.locator("input[name=cardErrorBackgroundColor]").fill("#cc2222");
  await page.locator("input[name=glossBackgroundOpacity]").fill("0.65");
  await page.locator("select[name=glossFontFamily]").selectOption("Georgia, Times New Roman, serif");
  await page.locator("input[name=glossFontSize]").fill("18");
  await expect(page.locator("select[name=knownWordList] option")).toHaveCount(7);
  await expect(page.locator("select[name=knownWordList]")).toContainText("托福 4510 词");
  await page.locator("select[name=knownWordList]").selectOption("toefl");
  await page.locator("input[name=autoTranslateEnabled]").check();
  await page.locator("select[name=provider]").selectOption("openai-chat-completions");
  await page.locator("select[name=reasoningEffort]").selectOption("high");
  await page.locator("input[name=aiRequestTimeoutSeconds]").fill("45");
  await expect(page.locator("input[name=aiEndpoint]")).toHaveValue("https://api.openai.com/v1/chat/completions");
  await expect(page.locator("select[name=ankiDeck]")).toBeEnabled();
  await expect(page.locator("select[name=ankiDeck] option")).toHaveCount(3);
  await expect(page.locator("select[name=ankiModelName] option")).toHaveCount(1);
  await expect(page.locator("select[name=ankiModelName]")).toHaveValue("KaTeX and Markdown Basic");
  await page.locator("select[name=ankiDeck]").selectOption("temp");
  await page.locator("input[name=ankiRequestTimeoutSeconds]").fill("35");
  await page.locator("input[name=duplicatePromptSeconds]").fill("7");
  await page.locator("textarea[name=glossPrompt]").fill("Use compact contextual labels.");
  await page.locator("textarea[name=ankiPrompt]").fill("Create concise learning cards.");
  await expect(page.locator("#known-words-list")).toContainText("archive");
  await page.locator(".known-word-row", { hasText: "archive" }).getByRole("button", { name: "移除" }).click();
  await expect(page.locator("#known-words-list")).not.toContainText("archive");
  await expect(page.locator("#known-words-list")).toContainText("legacy");
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
  await page.locator("#add-known-word").click();
  await expect(page.locator("#known-words-list")).toContainText("calibrate");

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

  await page.locator("select[name=provider]").selectOption("glossa-backend");
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

  await page.locator("select[name=provider]").selectOption("openai-chat-completions");
  await page.locator("select[name=reasoningEffort]").selectOption("high");
  await expect(page.locator("input[name=aiEndpoint]")).toHaveValue("https://api.openai.com/v1/chat/completions");
  await page.locator("#test-ai").click();
  await expect(page.locator("#test-ai")).toHaveAttribute("data-state", "success");
  await expect(page.locator("#test-ai .test-label")).not.toBeVisible();
  await expect(page.locator("#test-ai .test-icon-success")).toBeVisible();
  await expect(page.locator("#test-ai")).toHaveCSS("width", "44px");
  await expect(page.locator("#status")).toHaveText("");

  await page.locator("#test-anki").click();
  await expect(page.locator("#test-anki")).toHaveAttribute("data-state", "success");
  await expect(page.locator("#test-anki .test-label")).not.toBeVisible();
  await expect(page.locator("#test-anki .test-icon-success")).toBeVisible();
  await expect(page.locator("#test-anki")).toHaveCSS("width", "44px");
  await expect(page.locator("#status")).toHaveText("");

  await page.locator("button[type=submit]").click();

  const settings = await page.evaluate(() => (Reflect.get(window, "__glossaStore") as { settings: unknown }).settings);
  expect(settings).toMatchObject({
    shortcutKey: "Ctrl+Shift+K",
    translateShortcutKey: "Alt+G",
    autoTranslateEnabled: true,
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
  expect(await page.evaluate(async () => {
    return await new Promise<unknown>((resolve, reject) => {
      const request = indexedDB.open("glossa", 2);
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction("lexicon", "readonly");
        const getRequest = tx.objectStore("lexicon").get("en:calibrate");
        getRequest.onsuccess = () => {
          db.close();
          resolve(getRequest.result);
        };
        getRequest.onerror = () => reject(getRequest.error);
      };
      request.onerror = () => reject(request.error);
    });
  })).toMatchObject({ lemma: "calibrate", state: "known" });
});

// @verifies glossa.settings_save
// @verifies glossa.card_creation.note_request.timeout.anki_catalog
// @verifies glossa.card_creation.note_request.timeout.anki_action
test("options page disables Anki selectors until refresh reaches AnkiConnect", async ({ page }) => {
  const html = await readFile(resolve("dist/options/options.html"), "utf8");
  await page.route("https://options.test/", (route) => route.fulfill({ contentType: "text/html", body: "<!doctype html><html></html>" }));
  await page.goto("https://options.test/");
  await page.setContent(html.replace("<link rel=\"stylesheet\" href=\"../assets/options.css\">", "").replace("<script type=\"module\" src=\"../options.js\"></script>", ""));
  await page.addStyleTag({ path: resolve("dist/assets/options.css") });
  await page.evaluate(() => {
    const store: Record<string, unknown> = {};
    Reflect.set(window, "__glossaStore", store);
    Reflect.set(window, "__ankiUp", false);
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

  await expect(page.locator("select[name=ankiDeck]")).toBeDisabled();
  await expect(page.locator("select[name=ankiModelName]")).toBeDisabled();
  await expect(page.locator("#refresh-anki")).toBeEnabled();

  await page.evaluate(() => Reflect.set(window, "__ankiUp", true));
  await page.locator("#refresh-anki").click();

  await expect(page.locator("select[name=ankiDeck]")).toBeEnabled();
  await expect(page.locator("select[name=ankiModelName]")).toBeEnabled();
  await expect(page.locator("select[name=ankiDeck]")).toHaveValue("Glossa");
  await expect(page.locator("select[name=ankiModelName]")).toHaveValue("KaTeX and Markdown Basic");
});

// @verifies glossa.card_creation.duplicate_gate.record_store_upgrade
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
  await page.evaluate(async () => {
    await new Promise<void>((resolve, reject) => {
      const deleteRequest = indexedDB.deleteDatabase("glossa");
      deleteRequest.onsuccess = () => resolve();
      deleteRequest.onerror = () => reject(deleteRequest.error);
      deleteRequest.onblocked = () => resolve();
    });
  });
  await page.addScriptTag({ type: "module", path: resolve("dist/options.js") });

  await expect.poll(() => page.evaluate(async () => {
    return await new Promise<boolean>((resolve, reject) => {
      const request = indexedDB.open("glossa", 2);
      request.onsuccess = () => {
        const db = request.result;
        const hasStore = db.objectStoreNames.contains("cardedWords");
        db.close();
        resolve(hasStore);
      };
      request.onerror = () => reject(request.error);
    });
  })).toBe(true);
});
