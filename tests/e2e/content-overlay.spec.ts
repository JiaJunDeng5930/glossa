import { expect, test, type Page } from "@playwright/test";
import { resolve } from "node:path";

type RuntimeSettings = Record<string, unknown>;

// @verifies glossa.page_translation.activation
// @verifies glossa.page_translation.inline_rendering
test("content bundle waits for manual activation before requesting glosses", async ({ page }) => {
  await page.setContent("<main><p>Manual archive appears here.</p></main>");
  await installChromeRuntime(page, {
    shortcutKey: "Alt",
    translateShortcutKey: "Alt+G",
    autoTranslateEnabled: false,
    knownWordList: "junior-high"
  });
  await page.evaluate(() => {
    Reflect.set(window, "__glossaOnScan", (message: { payload: { scanId: string; sentences: Array<{ tokens: Array<{ id: string; surface: string }> }> } }, emit: (response: unknown) => void) => {
      const glossToken = Reflect.get(window, "glossToken") as (scanId: string, tokenId: string, status: string, item?: unknown) => unknown;
      const glossDone = Reflect.get(window, "glossDone") as (scanId: string) => unknown;
      const manualToken = message.payload.sentences
        .flatMap((sentence) => sentence.tokens)
        .find((token) => token.surface.toLowerCase() === "manual");
      if (manualToken) {
        emit(glossToken(message.payload.scanId, manualToken.id, "ready", { tokenId: manualToken.id, targetText: manualToken.surface, display: "手动" }));
      }
      emit(glossDone(message.payload.scanId));
    });
  });
  await page.addScriptTag({ type: "module", path: resolve("dist/content.js") });
  await page.waitForTimeout(300);
  expect(await sentMessageTypes(page)).toEqual(["settings.get"]);

  await page.evaluate(() => {
    const listeners = Reflect.get(window, "__glossaListeners") as Array<(message: unknown, sender: unknown, sendResponse: (response: unknown) => void) => boolean | void>;
    return new Promise((resolve) => {
      listeners[0]?.({ type: "glossa.activateTranslation" }, {}, resolve);
    });
  });

  await page.waitForFunction(() => document.querySelector("[data-glossa-token-label]")?.textContent === "手动");
  expect(await sentMessageTypes(page)).toContain("gloss.scan");
});

// @verifies glossa.page_translation.activation
test("content bundle toggles page translation with the configured shortcut", async ({ page }) => {
  await page.setContent("<main><p>Shortcut archive appears here.</p></main>");
  await installChromeRuntime(page, {
    shortcutKey: "Alt",
    translateShortcutKey: "Ctrl+Shift+G",
    autoTranslateEnabled: false,
    knownWordList: "junior-high"
  });
  await page.evaluate(() => {
    Reflect.set(window, "__glossaOnScan", (message: { payload: { scanId: string; sentences: Array<{ tokens: Array<{ id: string; surface: string }> }> } }, emit: (response: unknown) => void) => {
      const glossToken = Reflect.get(window, "glossToken") as (scanId: string, tokenId: string, status: string, item?: unknown) => unknown;
      const glossDone = Reflect.get(window, "glossDone") as (scanId: string) => unknown;
      const shortcutToken = message.payload.sentences
        .flatMap((sentence) => sentence.tokens)
        .find((token) => token.surface.toLowerCase() === "shortcut");
      if (shortcutToken) {
        emit(glossToken(message.payload.scanId, shortcutToken.id, "ready", { tokenId: shortcutToken.id, targetText: shortcutToken.surface, display: "快捷" }));
      }
      emit(glossDone(message.payload.scanId));
    });
  });
  await page.addScriptTag({ type: "module", path: resolve("dist/content.js") });
  await page.waitForTimeout(300);
  expect(await sentMessageTypes(page)).toEqual(["settings.get"]);

  await pressTranslationShortcut(page);

  await page.waitForFunction(() => document.querySelector("[data-glossa-token-label]")?.textContent === "快捷");
  expect(await sentMessageTypes(page)).toContain("gloss.scan");

  const scanCount = (await sentMessageTypes(page)).filter((type) => type === "gloss.scan").length;

  await pressTranslationShortcut(page);

  await expect(page.locator("[data-glossa-token]")).toHaveCount(0);
  await expect(page.locator("p")).toHaveText("Shortcut archive appears here.");

  await page.locator("p").evaluate((element) => {
    element.textContent = "Shortcut archive mutates while closed.";
  });
  await page.waitForTimeout(250);

  expect((await sentMessageTypes(page)).filter((type) => type === "gloss.scan")).toHaveLength(scanCount);
  await expect(page.locator("[data-glossa-token]")).toHaveCount(0);

  await pressTranslationShortcut(page);

  await page.waitForFunction(() => document.querySelector("[data-glossa-token-label]")?.textContent === "快捷");
  expect((await sentMessageTypes(page)).filter((type) => type === "gloss.scan").length).toBe(scanCount + 1);
});

// @verifies glossa.page_translation.activation
test("content bundle drops pending shortcut glosses after translation is toggled off", async ({ page }) => {
  await page.setContent("<main><p>Pending archive appears here.</p></main>");
  await installChromeRuntime(page, {
    shortcutKey: "Alt",
    translateShortcutKey: "Ctrl+Shift+G",
    autoTranslateEnabled: false,
    knownWordList: "junior-high"
  });
  await page.evaluate(() => {
    Reflect.set(window, "__glossaOnScan", (message: { payload: { scanId: string; sentences: Array<{ tokens: Array<{ id: string; surface: string }> }> } }, emit: (response: unknown) => void) => {
      const glossToken = Reflect.get(window, "glossToken") as (scanId: string, tokenId: string, status: string, item?: unknown) => unknown;
      const pendingToken = message.payload.sentences
        .flatMap((sentence) => sentence.tokens)
        .find((token) => token.surface.toLowerCase() === "pending");
      if (!pendingToken) {
        return;
      }
      emit(glossToken(message.payload.scanId, pendingToken.id, "pending"));
      Reflect.set(window, "__glossaEmitLateReady", () => {
        emit(glossToken(message.payload.scanId, pendingToken.id, "ready", { tokenId: pendingToken.id, targetText: pendingToken.surface, display: "待定" }));
      });
    });
  });
  await page.addScriptTag({ type: "module", path: resolve("dist/content.js") });
  await page.waitForTimeout(300);

  await pressTranslationShortcut(page);
  await page.waitForFunction(() => document.querySelector("[data-glossa-token-label]")?.textContent === "...");

  await pressTranslationShortcut(page);
  await expect(page.locator("[data-glossa-token]")).toHaveCount(0);
  await expect.poll(async () => page.evaluate(() => Reflect.get(window, "__glossaDisconnects"))).toBe(1);

  await page.evaluate(() => {
    (Reflect.get(window, "__glossaEmitLateReady") as () => void)();
  });
  await page.waitForTimeout(200);

  await expect(page.locator("[data-glossa-token]")).toHaveCount(0);
  await expect(page.locator("p")).toHaveText("Pending archive appears here.");
});

// @verifies glossa.page_translation.shortcut_selection
// @verifies glossa.card_creation.note_request
test("content bundle renders inline glosses and captures shortcut word selection", async ({ page }) => {
  const messages: unknown[] = [];
  await page.setContent(`
    <main>
      <p>Press the submit button to finish.</p>
      <button id="save">Save draft</button>
      <script>
        window.buttonClicks = 0;
        document.querySelector("#save").addEventListener("click", () => { window.buttonClicks += 1; });
      </script>
    </main>
  `);
  await installChromeRuntime(page, {
    shortcutKey: "Alt",
    autoTranslateEnabled: true,
    knownWordList: "junior-high",
    appearance: {
      textColor: "#ff5500",
      backgroundColor: "#113355",
      cardSuccessBackgroundColor: "#228833",
      cardErrorBackgroundColor: "#cc2222",
      backgroundOpacity: 0.65,
      fontFamily: "Georgia, Times New Roman, serif",
      fontSize: 18
    }
  });
  await page.evaluate(() => {
    Reflect.set(window, "__glossaOnScan", (message: { payload: { scanId: string; sentences: Array<{ tokens: Array<{ id: string; surface: string }> }> } }, emit: (response: unknown) => void) => {
      const glossToken = Reflect.get(window, "glossToken") as (scanId: string, tokenId: string, status: string, item?: unknown) => unknown;
      const glossDone = Reflect.get(window, "glossDone") as (scanId: string) => unknown;
      const submit = message.payload.sentences
        .flatMap((sentence) => sentence.tokens)
        .find((token) => token.surface.toLowerCase() === "submit");
      if (submit) {
        emit(glossToken(message.payload.scanId, submit.id, "ready", { tokenId: submit.id, targetText: submit.surface, display: "提交" }));
      }
      emit(glossDone(message.payload.scanId));
    });
  });
  await page.addScriptTag({ type: "module", path: resolve("dist/content.js") });

  await expect(page.locator("#glossa-overlay")).toHaveCount(1);
  await expect(page.locator("#glossa-overlay")).toHaveCSS("--glossa-text-color", "#ff5500");
  await expect(page.locator("#glossa-overlay")).toHaveCSS("--glossa-bg-alpha", "65%");
  await expect(page.locator("#glossa-overlay")).toHaveCSS("--glossa-font-size", "18px");
  await page.waitForFunction(() => {
    const sent = Reflect.get(window, "__glossaMessages") as Array<{ type: string }>;
    return sent.some((message) => message.type === "gloss.scan");
  });
  await page.keyboard.down("Alt");
  await expect(page.locator("#glossa-overlay")).toHaveAttribute("data-glossa-selecting", "true");
  await page.locator("#save").click();
  await page.keyboard.up("Alt");
  await expect(page.locator("#glossa-overlay")).not.toHaveAttribute("data-glossa-selecting", "true");

  expect(await page.evaluate(() => Reflect.get(window, "buttonClicks"))).toBe(0);
  messages.push(...await page.evaluate(() => Reflect.get(window, "__glossaMessages") as unknown[]));
  expect(messages).toEqual(expect.arrayContaining([
    expect.objectContaining({ type: "gloss.scan" }),
    expect.objectContaining({ type: "word.clicked" })
  ]));
  await page.waitForFunction(() => {
    return Array.from(document.querySelectorAll<HTMLElement>("[data-glossa-token]")).some((node) => {
      return node.dataset.glossaFeedback === "card-success"
        && node.querySelector("[data-glossa-token-label]")?.textContent === "✓";
    });
  });
});

// @verifies glossa.card_creation.note_request
test("content bundle marks an existing gloss after confirmed card creation", async ({ page }) => {
  await page.setContent("<main><p id=\"target\">Press the submit button.</p></main>");
  await installChromeRuntime(page, {
    shortcutKey: "Alt",
    autoTranslateEnabled: true,
    knownWordList: "junior-high",
    appearance: {
      textColor: "#ffffff",
      backgroundColor: "#113355",
      cardSuccessBackgroundColor: "#228833",
      cardErrorBackgroundColor: "#cc2222",
      backgroundOpacity: 0.65,
      fontFamily: "Arial, sans-serif",
      fontSize: 16
    }
  });
  await page.evaluate(() => {
    Reflect.set(window, "__glossaOnScan", (message: { payload: { scanId: string; sentences: Array<{ tokens: Array<{ id: string; surface: string }> }> } }, emit: (response: unknown) => void) => {
      const glossToken = Reflect.get(window, "glossToken") as (scanId: string, tokenId: string, status: string, item?: unknown) => unknown;
      const glossDone = Reflect.get(window, "glossDone") as (scanId: string) => unknown;
      const submit = message.payload.sentences.flatMap((sentence) => sentence.tokens).find((token) => token.surface.toLowerCase() === "submit");
      if (submit) {
        emit(glossToken(message.payload.scanId, submit.id, "ready", { tokenId: submit.id, targetText: submit.surface, display: "提交" }));
      }
      emit(glossDone(message.payload.scanId));
    });
  });
  await page.addScriptTag({ type: "module", path: resolve("dist/content.js") });
  await page.waitForFunction(() => document.querySelector("[data-glossa-token-label]")?.textContent === "提交");

  await page.keyboard.down("Alt");
  await page.locator("[data-glossa-token]").click();
  await page.keyboard.up("Alt");

  await page.waitForFunction(() => {
    const node = document.querySelector<HTMLElement>("[data-glossa-token]");
    return node?.dataset.glossaFeedback === "card-success"
      && node.querySelector("[data-glossa-token-label]")?.textContent === "提交";
  });
});

// @verifies glossa.card_creation.failure.request_error
// @verifies glossa.failure_reporting.user_copy
test("content bundle marks card failures with the shared badge renderer", async ({ page }) => {
  await page.setContent("<main><p id=\"target\">Create archive card.</p></main>");
  await installChromeRuntime(page, {
    shortcutKey: "Alt",
    autoTranslateEnabled: false,
    knownWordList: "junior-high",
    appearance: {
      textColor: "#ffffff",
      backgroundColor: "#113355",
      cardSuccessBackgroundColor: "#228833",
      cardErrorBackgroundColor: "#cc2222",
      backgroundOpacity: 0.65,
      fontFamily: "Arial, sans-serif",
      fontSize: 16
    }
  });
  await page.evaluate(() => {
    let attempts = 0;
    Reflect.set(window, "__glossaOnSendMessage", (message: { type: string; requestId: string; source: "content-script" }, callback?: (response: unknown) => void) => {
      if (message.type !== "word.clicked") {
        return undefined;
      }
      attempts += 1;
      const response = attempts === 1 ? {
        type: "error",
        version: 1,
        requestId: message.requestId,
        source: "service-worker",
        target: message.source,
        createdAt: Date.now(),
        payload: { reason: "network", message: "AnkiConnect failed", service: "anki" }
      } : {
        type: "word.clicked.ok",
        version: 1,
        requestId: message.requestId,
        source: "service-worker",
        target: message.source,
        createdAt: Date.now(),
        payload: { noteId: 11 }
      };
      callback?.(response);
      return Promise.resolve(response);
    });
  });
  await page.addScriptTag({ type: "module", path: resolve("dist/content.js") });

  await page.keyboard.down("Alt");
  await page.locator("#target").click();
  await page.keyboard.up("Alt");

  await page.waitForFunction(() => {
    const node = document.querySelector<HTMLElement>("[data-glossa-token]");
    return node?.dataset.glossaFeedback === "card-error"
      && node.querySelector("[data-glossa-token-label]")?.textContent === "×"
      && node.title === "Anki 服务未启动或无法访问";
  });
  expect(await page.evaluate(() => {
    const label = document.querySelector<HTMLElement>("[data-glossa-token-label]")!;
    const rect = label.getBoundingClientRect();
    const before = getComputedStyle(label, "::before");
    const after = getComputedStyle(label, "::after");
    return {
      square: Math.abs(rect.width - rect.height) < 1,
      hasDrawnCross: before.content === "\"\"" && after.content === "\"\"",
      beforeVisible: before.backgroundColor !== "rgba(0, 0, 0, 0)",
      afterVisible: after.backgroundColor !== "rgba(0, 0, 0, 0)"
    };
  })).toEqual({
    square: true,
    hasDrawnCross: true,
    beforeVisible: true,
    afterVisible: true
  });

  await page.keyboard.down("Alt");
  await page.locator("[data-glossa-token]").click();
  await page.keyboard.up("Alt");

  await page.waitForFunction(() => {
    const node = document.querySelector<HTMLElement>("[data-glossa-token]");
    return node?.dataset.glossaFeedback === "card-success"
      && node.dataset.glossaDisplayKind === "feedback"
      && node.querySelector("[data-glossa-token-label]")?.textContent === "✓";
  });
});

// @verifies glossa.failure_reporting.user_copy
test("content bundle exposes user-readable gloss failure text", async ({ page }) => {
  await page.setContent("<main><p>Unusual archive appears here.</p></main>");
  await installChromeRuntime(page, {
    shortcutKey: "Alt",
    autoTranslateEnabled: true,
    knownWordList: "junior-high"
  });
  await page.evaluate(() => {
    Reflect.set(window, "__glossaOnScan", (message: { payload: { scanId: string; sentences: Array<{ tokens: Array<{ id: string; surface: string }> }> } }, emit: (response: unknown) => void) => {
      const glossToken = Reflect.get(window, "glossToken") as (scanId: string, tokenId: string, status: string, item?: unknown, error?: unknown) => unknown;
      const glossDone = Reflect.get(window, "glossDone") as (scanId: string) => unknown;
      const unusual = message.payload.sentences
        .flatMap((sentence) => sentence.tokens)
        .find((token) => token.surface.toLowerCase() === "unusual");
      if (unusual) {
        emit(glossToken(message.payload.scanId, unusual.id, "error", undefined, {
          reason: "invalid-response",
          message: "bad json",
          service: "ai"
        }));
      }
      emit(glossDone(message.payload.scanId));
    });
  });
  await page.addScriptTag({ type: "module", path: resolve("dist/content.js") });

  await page.waitForFunction(() => {
    const node = document.querySelector<HTMLElement>("[data-glossa-token]");
    return node?.dataset.glossaStatus === "error"
      && node.title === "AI 返回格式错误"
      && node.getAttribute("aria-label") === "AI 返回格式错误";
  });
});

// @verifies glossa.card_creation.note_request
test("content bundle shows card loading feedback before creation finishes", async ({ page }) => {
  await page.setContent("<main><p id=\"target\">Create archive card.</p></main>");
  await installChromeRuntime(page, {
    shortcutKey: "Alt",
    autoTranslateEnabled: false,
    knownWordList: "junior-high"
  });
  await page.evaluate(() => {
    Reflect.set(window, "__glossaOnSendMessage", (message: { type: string; requestId: string; source: "content-script" }, callback?: (response: unknown) => void) => {
      if (message.type !== "word.clicked") {
        return undefined;
      }
      return new Promise((resolve) => {
        Reflect.set(window, "__resolveCardClick", () => {
          const response = {
            type: "word.clicked.ok",
            version: 1,
            requestId: message.requestId,
            source: "service-worker",
            target: message.source,
            createdAt: Date.now(),
            payload: { noteId: 12 }
          };
          callback?.(response);
          resolve(response);
        });
      });
    });
  });
  await page.addScriptTag({ type: "module", path: resolve("dist/content.js") });

  await page.keyboard.down("Alt");
  await page.locator("#target").click();
  await page.keyboard.up("Alt");

  await page.waitForFunction(() => {
    const node = document.querySelector<HTMLElement>("[data-glossa-token]");
    return node?.dataset.glossaFeedback === "card-pending"
      && node.dataset.glossaDisplayKind === "feedback"
      && node.querySelector("[data-glossa-token-label]")?.textContent === "...";
  });

  await page.evaluate(() => {
    const resolveCardClick = Reflect.get(window, "__resolveCardClick") as () => void;
    resolveCardClick();
  });

  await page.waitForFunction(() => {
    const node = document.querySelector<HTMLElement>("[data-glossa-token]");
    return node?.dataset.glossaFeedback === "card-success"
      && node.querySelector("[data-glossa-token-label]")?.textContent === "✓";
  });
});

// @verifies glossa.card_creation.duplicate_gate
// @verifies glossa.card_creation.duplicate_gate.content_prompt
// @verifies glossa.card_creation.duplicate_gate.content_cancel
// @verifies glossa.card_creation.duplicate_gate.content_confirm
// @verifies glossa.card_creation.note_request.content_feedback
// @verifies glossa.card_creation.duplicate_gate.prompt
// @verifies glossa.card_creation.duplicate_gate.prompt_dom
// @verifies glossa.card_creation.duplicate_gate.prompt_controls
// @verifies glossa.card_creation.duplicate_gate.feedback_state
// @verifies glossa.card_creation.duplicate_gate.feedback_dataset_state
// @verifies glossa.card_creation.duplicate_gate.feedback_clear
// @verifies glossa.card_creation.note_request.feedback_display
// @verifies glossa.card_creation.note_request.feedback_badge
test("content bundle asks before creating another card for a carded word", async ({ page }) => {
  await page.setContent("<main><p id=\"target\">Create archive card.</p></main>");
  await installChromeRuntime(page, {
    shortcutKey: "Alt",
    autoTranslateEnabled: false,
    knownWordList: "junior-high"
  });
  await page.evaluate(() => {
    const messages: unknown[] = [];
    Reflect.set(window, "__duplicateMessages", messages);
    Reflect.set(window, "__glossaOnSendMessage", (message: { type: string; requestId: string; source: "content-script"; payload?: { allowDuplicateCard?: boolean } }, callback?: (response: unknown) => void) => {
      if (message.type !== "word.clicked") {
        return undefined;
      }
      messages.push(message);
      const response = message.payload?.allowDuplicateCard === true ? {
        type: "word.clicked.ok",
        version: 1,
        requestId: message.requestId,
        source: "service-worker",
        target: message.source,
        createdAt: Date.now(),
        payload: { noteId: 12 }
      } : {
        type: "word.card.duplicate",
        version: 1,
        requestId: message.requestId,
        source: "service-worker",
        target: message.source,
        createdAt: Date.now(),
        payload: { lang: "en", lemma: "archive", surface: "archive", promptMs: 5_000 }
      };
      callback?.(response);
      return Promise.resolve(response);
    });
  });
  await page.addScriptTag({ type: "module", path: resolve("dist/content.js") });

  await page.keyboard.down("Alt");
  await page.locator("#target").click();
  await page.keyboard.up("Alt");

  await expect(page.locator("[data-glossa-duplicate-card-prompt]")).toBeVisible();
  await page.getByRole("button", { name: "取消制卡" }).click();
  await expect(page.locator("[data-glossa-duplicate-card-prompt]")).toHaveCount(0);
  expect(await page.evaluate(() => {
    const messages = Reflect.get(window, "__duplicateMessages") as Array<{ payload?: { allowDuplicateCard?: boolean } }>;
    return messages.map((message) => message.payload?.allowDuplicateCard === true);
  })).toEqual([false]);

  await page.keyboard.down("Alt");
  await page.locator("#target").click();
  await page.keyboard.up("Alt");
  await expect(page.locator("[data-glossa-duplicate-card-prompt]")).toBeVisible();
  await page.getByRole("button", { name: "继续制卡" }).click();

  await page.waitForFunction(() => {
    const node = document.querySelector<HTMLElement>("[data-glossa-token]");
    return node?.dataset.glossaFeedback === "card-success";
  });
  expect(await page.evaluate(() => {
    const messages = Reflect.get(window, "__duplicateMessages") as Array<{ payload?: { allowDuplicateCard?: boolean } }>;
    return messages.map((message) => message.payload?.allowDuplicateCard === true);
  })).toEqual([false, false, true]);
});

// @verifies glossa.card_creation.duplicate_gate.prompt_timeout
// @verifies glossa.card_creation.duplicate_gate.feedback_skip
test("content bundle cancels duplicate card prompts after their timeout", async ({ page }) => {
  await page.setContent("<main><p id=\"target\">Create archive card.</p></main>");
  await installChromeRuntime(page, {
    shortcutKey: "Alt",
    autoTranslateEnabled: false,
    knownWordList: "junior-high"
  });
  await page.evaluate(() => {
    const messages: unknown[] = [];
    Reflect.set(window, "__duplicateMessages", messages);
    Reflect.set(window, "__glossaOnSendMessage", (message: { type: string; requestId: string; source: "content-script" }, callback?: (response: unknown) => void) => {
      if (message.type !== "word.clicked") {
        return undefined;
      }
      messages.push(message);
      const response = {
        type: "word.card.duplicate",
        version: 1,
        requestId: message.requestId,
        source: "service-worker",
        target: message.source,
        createdAt: Date.now(),
        payload: { lang: "en", lemma: "archive", surface: "archive", promptMs: 300 }
      };
      callback?.(response);
      return Promise.resolve(response);
    });
  });
  await page.addScriptTag({ type: "module", path: resolve("dist/content.js") });

  await page.keyboard.down("Alt");
  await page.locator("#target").click();
  await page.keyboard.up("Alt");

  await expect(page.locator("[data-glossa-duplicate-card-prompt]")).toBeVisible();
  await expect(page.locator("[data-glossa-duplicate-card-prompt]")).toHaveCount(0, { timeout: 2_000 });
  expect(await page.evaluate(() => (Reflect.get(window, "__duplicateMessages") as unknown[]).length)).toBe(1);
});

// @verifies glossa.card_creation.duplicate_gate.prompt_supersede
// @verifies glossa.card_creation.duplicate_gate.prompt_supersede_state
test("content bundle cancels the active duplicate prompt when a new one opens", async ({ page }) => {
  await page.setContent("<main><p><span id=\"first\">archive</span> <span id=\"second\">submit</span></p></main>");
  await installChromeRuntime(page, {
    shortcutKey: "Alt",
    autoTranslateEnabled: false,
    knownWordList: "junior-high"
  });
  await page.evaluate(() => {
    const messages: unknown[] = [];
    Reflect.set(window, "__duplicateMessages", messages);
    Reflect.set(window, "__glossaOnSendMessage", (message: { type: string; requestId: string; source: "content-script"; payload?: { token?: { surface?: string } } }, callback?: (response: unknown) => void) => {
      if (message.type !== "word.clicked") {
        return undefined;
      }
      messages.push(message);
      const surface = message.payload?.token?.surface ?? "word";
      const response = {
        type: "word.card.duplicate",
        version: 1,
        requestId: message.requestId,
        source: "service-worker",
        target: message.source,
        createdAt: Date.now(),
        payload: { lang: "en", lemma: surface.toLocaleLowerCase("en-US"), surface, promptMs: 5_000 }
      };
      callback?.(response);
      return Promise.resolve(response);
    });
  });
  await page.addScriptTag({ type: "module", path: resolve("dist/content.js") });

  await page.keyboard.down("Alt");
  await page.locator("#first").click();
  await page.keyboard.up("Alt");
  await expect(page.locator("[data-glossa-duplicate-card-prompt]")).toBeVisible();

  await page.keyboard.down("Alt");
  await page.locator("#second").click();
  await page.keyboard.up("Alt");

  await expect(page.locator("[data-glossa-duplicate-card-prompt]")).toContainText("submit");
  expect(await page.evaluate(() => document.querySelectorAll("[data-glossa-feedback=\"card-pending\"]").length)).toBe(1);
  expect(await page.evaluate(() => (Reflect.get(window, "__duplicateMessages") as unknown[]).length)).toBe(2);
});

// @verifies glossa.card_creation.failure.request_error
test("content bundle keeps waiting for slow card creation Anki errors", async ({ page }) => {
  await page.setContent("<main><p id=\"target\">Create archive card.</p></main>");
  await installChromeRuntime(page, {
    shortcutKey: "Alt",
    autoTranslateEnabled: false,
    knownWordList: "junior-high"
  });
  await page.evaluate(() => {
    Reflect.set(window, "__glossaOnSendMessage", (message: { type: string; requestId: string; source: "content-script" }, callback?: (response: unknown) => void) => {
      if (message.type !== "word.clicked") {
        return undefined;
      }
      return new Promise((resolve) => {
        setTimeout(() => {
          const response = {
            type: "error",
            version: 1,
            requestId: message.requestId,
            source: "service-worker",
            target: message.source,
            createdAt: Date.now(),
            payload: { reason: "service-error", message: "model was not found: Basic", service: "anki" }
          };
          callback?.(response);
          resolve(response);
        }, 5_200);
      });
    });
  });
  await page.addScriptTag({ type: "module", path: resolve("dist/content.js") });

  await page.keyboard.down("Alt");
  await page.locator("#target").click();
  await page.keyboard.up("Alt");

  await page.waitForFunction(() => {
    const node = document.querySelector<HTMLElement>("[data-glossa-token]");
    return node?.dataset.glossaFeedback === "card-pending";
  });

  await page.waitForFunction(() => {
    const node = document.querySelector<HTMLElement>("[data-glossa-token]");
    return node?.dataset.glossaFeedback === "card-error"
      && node.querySelector("[data-glossa-token-label]")?.textContent === "×"
      && node.title === "Anki 卡片模板不存在";
  }, undefined, { timeout: 10_000 });
});

// @verifies glossa.page_translation.candidate_scan
test("content bundle scans text added after boot", async ({ page }) => {
  await page.setContent("<main id=\"app\"></main>");
  await installChromeRuntime(page, { shortcutKey: "Alt", autoTranslateEnabled: true, knownWordList: "junior-high" });
  await page.evaluate(() => {
    Reflect.set(window, "__glossaOnScan", (message: { payload: { scanId: string; sentences: Array<{ tokens: Array<{ id: string; surface: string }> }> } }, emit: (response: unknown) => void) => {
      const glossToken = Reflect.get(window, "glossToken") as (scanId: string, tokenId: string, status: string, item?: unknown) => unknown;
      const glossDone = Reflect.get(window, "glossDone") as (scanId: string) => unknown;
      const dynamicToken = message.payload.sentences
        .flatMap((sentence) => sentence.tokens)
        .find((token) => token.surface.toLowerCase() === "dynamic");
      if (dynamicToken) {
        emit(glossToken(message.payload.scanId, dynamicToken.id, "ready", { tokenId: dynamicToken.id, targetText: dynamicToken.surface, display: "动态" }));
      }
      emit(glossDone(message.payload.scanId));
    });
  });
  await page.addScriptTag({ type: "module", path: resolve("dist/content.js") });
  await page.locator("#app").evaluate((element) => {
    element.textContent = "A dynamic paragraph appears after boot.";
  });

  await page.waitForFunction(() => {
    const host = document.querySelector("#glossa-overlay");
    return document.querySelector("[data-glossa-token-label]")?.textContent === "动态" && host !== null;
  });
});

// @verifies glossa.page_translation.inline_rendering
test("content bundle replaces pending gloss spinners with ready labels", async ({ page }) => {
  await page.setContent("<main><p id=\"target\">Pending archive appears here.</p></main>");
  await installChromeRuntime(page, { shortcutKey: "Alt", autoTranslateEnabled: true, knownWordList: "junior-high" });
  await page.evaluate(() => {
    Reflect.set(window, "__glossaOnScan", (message: { payload: { scanId: string; sentences: Array<{ tokens: Array<{ id: string; surface: string }> }> } }, emit: (response: unknown) => void) => {
      const glossToken = Reflect.get(window, "glossToken") as (scanId: string, tokenId: string, status: string, item?: unknown) => unknown;
      const glossDone = Reflect.get(window, "glossDone") as (scanId: string) => unknown;
      const pending = message.payload.sentences
        .flatMap((sentence) => sentence.tokens)
        .find((token) => token.surface.toLowerCase() === "pending");
      if (!pending) {
        emit(glossDone(message.payload.scanId));
        return;
      }
      emit(glossToken(message.payload.scanId, pending.id, "pending"));
      Reflect.set(window, "__resolvePendingGloss", () => {
        emit(glossToken(message.payload.scanId, pending.id, "ready", { tokenId: pending.id, targetText: pending.surface, display: "等待" }));
        emit(glossDone(message.payload.scanId));
      });
    });
  });
  await page.addScriptTag({ type: "module", path: resolve("dist/content.js") });

  await page.waitForFunction(() => document.querySelector("[data-glossa-token-label]")?.textContent === "...");
  const pendingGeometry = await tokenGeometry(page);
  expect(pendingGeometry.label.bottom).toBeLessThanOrEqual(pendingGeometry.surface.top);
  expect(Math.abs(pendingGeometry.label.centerX - pendingGeometry.surface.centerX)).toBeLessThan(0.5);

  await page.evaluate(() => {
    (Reflect.get(window, "__resolvePendingGloss") as () => void)();
  });
  await page.waitForFunction(() => document.querySelector("[data-glossa-token-label]")?.textContent === "等待");
});

// @verifies glossa.page_translation.inline_rendering
test("content bundle resolves pending glosses after external page mutations", async ({ page }) => {
  await page.setContent("<main><p id=\"target\">Pending archive appears here.</p><p id=\"dynamic\"></p></main>");
  await installChromeRuntime(page, { shortcutKey: "Alt", autoTranslateEnabled: true, knownWordList: "junior-high" });
  await page.evaluate(() => {
    Reflect.set(window, "__glossaOnScan", (message: { payload: { scanId: string; sentences: Array<{ tokens: Array<{ id: string; surface: string }> }> } }, emit: (response: unknown) => void) => {
      const glossToken = Reflect.get(window, "glossToken") as (scanId: string, tokenId: string, status: string, item?: unknown) => unknown;
      const glossDone = Reflect.get(window, "glossDone") as (scanId: string) => unknown;
      const pending = message.payload.sentences
        .flatMap((sentence) => sentence.tokens)
        .find((token) => token.surface.toLowerCase() === "pending");
      if (pending && !Reflect.get(window, "__pendingGlossHeld")) {
        Reflect.set(window, "__pendingGlossHeld", true);
        emit(glossToken(message.payload.scanId, pending.id, "pending"));
        Reflect.set(window, "__resolvePendingAfterMutation", () => {
          emit(glossToken(message.payload.scanId, pending.id, "ready", { tokenId: pending.id, targetText: pending.surface, display: "等待" }));
          emit(glossDone(message.payload.scanId));
        });
        return;
      }
      emit(glossDone(message.payload.scanId));
    });
  });
  await page.addScriptTag({ type: "module", path: resolve("dist/content.js") });
  await page.waitForFunction(() => document.querySelector("[data-glossa-token-label]")?.textContent === "...");

  await page.locator("#dynamic").evaluate((element) => {
    element.textContent = "A dynamic paragraph appears after boot.";
  });
  await page.waitForFunction(() => {
    const sent = Reflect.get(window, "__glossaMessages") as Array<{ type: string }>;
    return sent.filter((message) => message.type === "gloss.scan").length > 1;
  });
  await page.evaluate(() => {
    (Reflect.get(window, "__resolvePendingAfterMutation") as () => void)();
  });

  await page.waitForFunction(() => document.querySelector("[data-glossa-token-label]")?.textContent === "等待");
});

// @verifies glossa.page_translation.inline_rendering
test("content bundle drops pending glosses after their source text is replaced", async ({ page }) => {
  await page.setContent("<main><p id=\"target\">Pending archive appears here.</p></main>");
  await installChromeRuntime(page, { shortcutKey: "Alt", autoTranslateEnabled: true, knownWordList: "junior-high" });
  await page.evaluate(() => {
    Reflect.set(window, "__glossaOnScan", (message: { payload: { scanId: string; sentences: Array<{ tokens: Array<{ id: string; surface: string }> }> } }, emit: (response: unknown) => void) => {
      const glossToken = Reflect.get(window, "glossToken") as (scanId: string, tokenId: string, status: string, item?: unknown) => unknown;
      const glossDone = Reflect.get(window, "glossDone") as (scanId: string) => unknown;
      const pending = message.payload.sentences
        .flatMap((sentence) => sentence.tokens)
        .find((token) => token.surface.toLowerCase() === "pending");
      if (pending && !Reflect.get(window, "__removedPendingGlossHeld")) {
        Reflect.set(window, "__removedPendingGlossHeld", true);
        emit(glossToken(message.payload.scanId, pending.id, "pending"));
        Reflect.set(window, "__resolveRemovedPendingGloss", () => {
          emit(glossToken(message.payload.scanId, pending.id, "ready", { tokenId: pending.id, targetText: pending.surface, display: "等待" }));
          emit(glossDone(message.payload.scanId));
        });
        return;
      }
      emit(glossDone(message.payload.scanId));
    });
  });
  await page.addScriptTag({ type: "module", path: resolve("dist/content.js") });
  await page.waitForFunction(() => document.querySelector("[data-glossa-token-label]")?.textContent === "...");

  await page.locator("#target").evaluate((element) => {
    element.textContent = "Replacement archive appears here.";
  });
  await page.evaluate(() => {
    (Reflect.get(window, "__resolveRemovedPendingGloss") as () => void)();
  });

  await page.waitForTimeout(300);
  expect(await page.locator("[data-glossa-token-label]", { hasText: "等待" }).count()).toBe(0);
});

// @verifies glossa.page_translation.lookup_order
test("content bundle leaves hidden tokens as original page text", async ({ page }) => {
  await page.setContent("<main><p id=\"target\">Ignored archive appears here.</p></main>");
  await installChromeRuntime(page, { shortcutKey: "Alt", autoTranslateEnabled: true, knownWordList: "junior-high" });
  await page.evaluate(() => {
    Reflect.set(window, "__glossaOnScan", (message: { payload: { scanId: string; sentences: Array<{ tokens: Array<{ id: string; surface: string }> }> } }, emit: (response: unknown) => void) => {
      const glossToken = Reflect.get(window, "glossToken") as (scanId: string, tokenId: string, status: string) => unknown;
      const glossDone = Reflect.get(window, "glossDone") as (scanId: string) => unknown;
      const ignored = message.payload.sentences
        .flatMap((sentence) => sentence.tokens)
        .find((token) => token.surface.toLowerCase() === "ignored");
      if (ignored) {
        emit(glossToken(message.payload.scanId, ignored.id, "hidden"));
      }
      emit(glossDone(message.payload.scanId));
    });
  });
  await page.addScriptTag({ type: "module", path: resolve("dist/content.js") });
  await page.waitForFunction(() => {
    const sent = Reflect.get(window, "__glossaMessages") as Array<{ type: string }>;
    return sent.some((message) => message.type === "gloss.scan");
  });

  await expect(page.locator("[data-glossa-token]")).toHaveCount(0);
  await expect(page.locator("#target")).toHaveText("Ignored archive appears here.");
});

// @verifies glossa.extension_contracts.restart_continuity
test("content bundle stops quietly when gloss messaging sees an invalidated extension context", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.setContent("<main><p>Obscure archive appears here.</p></main>");
  await installChromeRuntime(page, { shortcutKey: "Alt", autoTranslateEnabled: true, knownWordList: "junior-high" });
  await page.evaluate(() => {
    Reflect.set(window, "__glossaOnScan", () => {
      throw new Error("Extension context invalidated.");
    });
  });

  await page.addScriptTag({ type: "module", path: resolve("dist/content.js") });
  await page.waitForTimeout(300);

  expect(pageErrors).toEqual([]);
});

// @verifies glossa.extension_contracts.restart_continuity
test("content bundle handles invalidated extension context during word click", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.setContent("<main><p id=\"target\">Submit draft carefully.</p></main>");
  await installChromeRuntime(page, { shortcutKey: "Alt", autoTranslateEnabled: true, knownWordList: "junior-high" });
  await page.evaluate(() => {
    Reflect.set(window, "__glossaOnScan", (message: { payload: { scanId: string } }, emit: (response: unknown) => void) => {
      const glossDone = Reflect.get(window, "glossDone") as (scanId: string) => unknown;
      emit(glossDone(message.payload.scanId));
    });
    Reflect.set(window, "__glossaOnSendMessage", (message: { type: string }) => {
      if (message.type === "word.clicked") {
        throw new Error("Extension context invalidated.");
      }
      return undefined;
    });
  });
  await page.addScriptTag({ type: "module", path: resolve("dist/content.js") });
  await page.waitForFunction(() => {
    const sent = Reflect.get(window, "__glossaMessages") as Array<{ type: string }>;
    return sent.some((message) => message.type === "gloss.scan");
  });

  await page.keyboard.down("Alt");
  await page.locator("#target").click();
  await page.keyboard.up("Alt");
  await page.waitForTimeout(300);

  expect(pageErrors).toEqual([]);
});

// @verifies glossa.page_translation.token_geometry
test("content bundle lays out inline glosses without label or source overlap", async ({ page }) => {
  await page.setContent("<main><p id=\"target\">Obscure archive archive terms appear here.</p></main>");
  await installChromeRuntime(page, {
    shortcutKey: "Alt",
    autoTranslateEnabled: true,
    knownWordList: "junior-high",
    appearance: {
      textColor: "#111111",
      backgroundColor: "#ffffff",
      cardSuccessBackgroundColor: "#16a34a",
      cardErrorBackgroundColor: "#dc2626",
      backgroundOpacity: 1,
      fontFamily: "Arial, sans-serif",
      fontSize: 16
    }
  });
  await page.evaluate(() => {
    Reflect.set(window, "__glossaOnScan", (message: { payload: { scanId: string; sentences: Array<{ tokens: Array<{ id: string; surface: string }> }> } }, emit: (response: unknown) => void) => {
      const glossToken = Reflect.get(window, "glossToken") as (scanId: string, tokenId: string, status: string, item?: unknown) => unknown;
      const glossDone = Reflect.get(window, "glossDone") as (scanId: string) => unknown;
      const tokens = message.payload.sentences.flatMap((sentence) => sentence.tokens);
      tokens
        .filter((token) => ["obscure", "archive"].includes(token.surface.toLowerCase()))
        .forEach((token, index) => {
          emit(glossToken(message.payload.scanId, token.id, "ready", {
            tokenId: token.id,
            targetText: token.surface,
            display: index === 0 ? "极其晦涩的词" : "长期归档资料"
          }));
        });
      emit(glossDone(message.payload.scanId));
    });
  });
  await page.addScriptTag({ type: "module", path: resolve("dist/content.js") });

  await page.waitForFunction(() => document.querySelectorAll("[data-glossa-token]").length === 2);
  const geometry = await page.evaluate(() => {
    const wrappers = Array.from(document.querySelectorAll<HTMLElement>("[data-glossa-token]"));
    const paragraph = document.querySelector("#target")!;
    const plainText = Array.from(paragraph.childNodes)
      .find((node): node is Text => node.nodeType === Node.TEXT_NODE && (node.nodeValue ?? "").includes("archive terms"));
    const plainRange = document.createRange();
    if (!plainText) {
      throw new Error("expected plain text after rendered gloss wrappers");
    }
    plainRange.setStart(plainText, 1);
    plainRange.setEnd(plainText, 8);
    const plainArchive = plainRange.getBoundingClientRect();
    plainRange.detach();
    return wrappers.map((wrapper) => {
      const label = wrapper.querySelector<HTMLElement>("[data-glossa-token-label]")!.getBoundingClientRect();
      const surface = wrapper.querySelector<HTMLElement>("[data-glossa-token-surface]")!.getBoundingClientRect();
      return {
        label: rect(label),
        surface: rect(surface),
        plainArchive: rect(plainArchive)
      };
    });

    function rect(value: DOMRect): { left: number; right: number; top: number; bottom: number; centerX: number } {
      return {
        left: value.left,
        right: value.right,
        top: value.top,
        bottom: value.bottom,
        centerX: value.left + value.width / 2
      };
    }
  });

  expect(geometry).toHaveLength(2);
  const [first, second] = geometry;
  if (!first || !second) {
    throw new Error("expected two rendered gloss wrappers");
  }
  for (const item of [first, second]) {
    expect(Math.abs(item.label.centerX - item.surface.centerX)).toBeLessThan(0.5);
    expect(item.label.bottom).toBeLessThanOrEqual(item.surface.top);
  }
  expect(Math.abs(second.surface.top - second.plainArchive.top)).toBeLessThan(1);
  expect(overlaps(first.label, second.label)).toBe(false);
  expect(overlaps(first.surface, second.surface)).toBe(false);
});

// @verifies glossa.page_translation.inline_rendering
test("content bundle drops async glosses after the source paragraph changes", async ({ page }) => {
  await page.setContent("<main><p id=\"target\">Obscure archive appears here.</p></main>");
  await installChromeRuntime(page, { shortcutKey: "Alt", autoTranslateEnabled: true, knownWordList: "junior-high" });
  await page.evaluate(() => {
    Reflect.set(window, "__glossaOnScan", (message: { payload: { scanId: string; sentences: Array<{ tokens: Array<{ id: string; surface: string }> }> } }, emit: (response: unknown) => void) => {
      const glossToken = Reflect.get(window, "glossToken") as (scanId: string, tokenId: string, status: string, item?: unknown) => unknown;
      const glossDone = Reflect.get(window, "glossDone") as (scanId: string) => unknown;
      if (!Reflect.get(window, "__firstGlossHeld")) {
        Reflect.set(window, "__firstGlossHeld", true);
        const token = message.payload.sentences
          .flatMap((sentence) => sentence.tokens)
          .find((item) => item.surface.toLowerCase() === "obscure");
        Reflect.set(window, "__resolveFirstGloss", () => {
          if (token) {
            emit(glossToken(message.payload.scanId, token.id, "ready", { tokenId: token.id, targetText: token.surface, display: "晦涩" }));
          }
          emit(glossDone(message.payload.scanId));
        });
        return;
      }
      emit(glossDone(message.payload.scanId));
    });
  });
  await page.addScriptTag({ type: "module", path: resolve("dist/content.js") });
  await page.waitForFunction(() => typeof Reflect.get(window, "__resolveFirstGloss") === "function");

  await page.locator("#target").evaluate((element) => {
    element.textContent = "Replacement archive appears here.";
  });
  await page.evaluate(() => {
    (Reflect.get(window, "__resolveFirstGloss") as () => void)();
  });

  await page.waitForTimeout(300);
  expect(await page.locator("[data-glossa-token-label]", { hasText: "晦涩" }).count()).toBe(0);
});

// @verifies glossa.page_translation.inline_rendering
test("content bundle preserves existing glosses while mutation rescans wait for responses", async ({ page }) => {
  await page.setContent("<main><p id=\"stable\">Obscure archive appears here.</p><p id=\"dynamic\"></p></main>");
  await installChromeRuntime(page, { shortcutKey: "Alt", autoTranslateEnabled: true, knownWordList: "junior-high" });
  await page.evaluate(() => {
    Reflect.set(window, "__glossaOnScan", (message: { payload: { scanId: string; sentences: Array<{ tokens: Array<{ id: string; surface: string }> }> } }, emit: (response: unknown) => void) => {
      const glossToken = Reflect.get(window, "glossToken") as (scanId: string, tokenId: string, status: string, item?: unknown) => unknown;
      const glossDone = Reflect.get(window, "glossDone") as (scanId: string) => unknown;
      const tokens = message.payload.sentences.flatMap((sentence) => sentence.tokens);
      const obscure = tokens.find((token) => token.surface.toLowerCase() === "obscure");
      if (obscure && !Reflect.get(window, "__initialGlossRendered")) {
        Reflect.set(window, "__initialGlossRendered", true);
        emit(glossToken(message.payload.scanId, obscure.id, "ready", { tokenId: obscure.id, targetText: obscure.surface, display: "晦涩" }));
        emit(glossDone(message.payload.scanId));
        return;
      }
      Reflect.set(window, "__mutationGlossHeld", true);
      Reflect.set(window, "__resolveMutationGloss", () => {
        const dynamic = tokens.find((token) => token.surface.toLowerCase() === "dynamic");
        if (dynamic) {
          emit(glossToken(message.payload.scanId, dynamic.id, "ready", { tokenId: dynamic.id, targetText: dynamic.surface, display: "动态" }));
        }
        emit(glossDone(message.payload.scanId));
      });
    });
  });
  await page.addScriptTag({ type: "module", path: resolve("dist/content.js") });
  await page.waitForFunction(() => document.querySelector("[data-glossa-token-label]")?.textContent === "晦涩");

  await page.locator("#dynamic").evaluate((element) => {
    element.textContent = "A dynamic paragraph appears after boot.";
  });
  await page.waitForFunction(() => Reflect.get(window, "__mutationGlossHeld") === true);

  expect(await page.locator("[data-glossa-token-label]", { hasText: "晦涩" }).count()).toBe(1);

  await page.evaluate(() => {
    (Reflect.get(window, "__resolveMutationGloss") as () => void)();
  });
  await page.waitForFunction(() => {
    return Array.from(document.querySelectorAll("[data-glossa-token-label]"))
      .some((label) => label.textContent === "动态");
  });
});

// @verifies glossa.page_translation.inline_rendering
test("content bundle defers chunk outcomes until a large text-node scan finishes", async ({ page }) => {
  const words = largeWordList(150);
  const target = words[140]!;
  await page.setContent(`<main><p>${words.join(" ")}.</p></main>`);
  await installChromeRuntime(page, { shortcutKey: "Alt", autoTranslateEnabled: true, knownWordList: "junior-high" });
  await page.evaluate(() => {
    Reflect.set(window, "__glossaOnScan", (message: { payload: { scanId: string; sentences: Array<{ tokens: Array<{ id: string; surface: string }> }> } }, emit: (response: unknown) => void) => {
      const glossToken = Reflect.get(window, "glossToken") as (scanId: string, tokenId: string, status: string, item?: unknown) => unknown;
      const glossDone = Reflect.get(window, "glossDone") as (scanId: string) => unknown;
      for (const token of message.payload.sentences.flatMap((sentence) => sentence.tokens)) {
        emit(glossToken(message.payload.scanId, token.id, "ready", {
          tokenId: token.id,
          targetText: token.surface,
          display: token.surface.toUpperCase()
        }));
      }
      emit(glossDone(message.payload.scanId));
    });
  });
  await page.addScriptTag({ type: "module", path: resolve("dist/content.js") });

  await page.waitForFunction((surface) => {
    if (typeof surface !== "string") {
      return false;
    }
    const wrapper = document.querySelector<HTMLElement>(`[data-glossa-surface="${surface}"]`);
    return wrapper?.querySelector("[data-glossa-token-label]")?.textContent === surface.toUpperCase();
  }, target);

  const scannedTokenCount = await page.evaluate(() => {
    const sent = Reflect.get(window, "__glossaMessages") as Array<{ type: string; payload?: { sentences?: Array<{ tokens?: unknown[] }> } }>;
    return sent
      .filter((message) => message.type === "gloss.scan")
      .reduce((total, message) => total + (message.payload?.sentences ?? []).reduce((innerTotal, sentence) => {
        return innerTotal + (sentence.tokens?.length ?? 0);
      }, 0), 0);
  });
  expect(scannedTokenCount).toBe(words.length);
});

// @verifies glossa.page_translation.inline_rendering
test("content bundle replays queued ready outcomes after scan invalidation", async ({ page }) => {
  const words = largeWordList(150);
  const target = words[0]!;
  await page.setContent(`<main><p>${words.join(" ")}.</p><p id="mutating">before</p></main>`);
  await installChromeRuntime(page, { shortcutKey: "Alt", autoTranslateEnabled: true, knownWordList: "junior-high" });
  await page.evaluate(() => {
    Reflect.set(window, "__glossaOnScan", (message: { payload: { scanId: string; sentences: Array<{ tokens: Array<{ id: string; surface: string }> }> } }, emit: (response: unknown) => void) => {
      const glossToken = Reflect.get(window, "glossToken") as (scanId: string, tokenId: string, status: string, item?: unknown) => unknown;
      const glossDone = Reflect.get(window, "glossDone") as (scanId: string) => unknown;
      const token = message.payload.sentences
        .flatMap((sentence) => sentence.tokens)
        .find((item) => item.surface === "worda");
      if (token) {
        emit(glossToken(message.payload.scanId, token.id, "ready", {
          tokenId: token.id,
          targetText: token.surface,
          display: "QUEUED"
        }));
      }
      if (!Reflect.get(window, "__queuedInvalidationTriggered")) {
        Reflect.set(window, "__queuedInvalidationTriggered", true);
        document.querySelector("#mutating")!.textContent = "after";
      }
      emit(glossDone(message.payload.scanId));
    });
  });
  await page.addScriptTag({ type: "module", path: resolve("dist/content.js") });

  await page.waitForFunction((surface) => {
    if (typeof surface !== "string") {
      return false;
    }
    const wrapper = document.querySelector<HTMLElement>(`[data-glossa-surface="${surface}"]`);
    return wrapper?.querySelector("[data-glossa-token-label]")?.textContent === "QUEUED";
  }, target);
  await expect(page.locator("#mutating")).toHaveText("after");
});

// @verifies glossa.page_translation.inline_rendering
test("content bundle aborts chunk scans after a deferred gloss error", async ({ page }) => {
  const words = largeWordList(150);
  await page.setContent(`<main><p>${words.join(" ")}.</p></main>`);
  await installChromeRuntime(page, { shortcutKey: "Alt", autoTranslateEnabled: true, knownWordList: "junior-high" });
  await page.evaluate(() => {
    Reflect.set(window, "__glossaSuppressChunkAck", true);
    Reflect.set(window, "__glossaOnScan", (message: { payload: { scanId: string } }, emit: (response: unknown) => void) => {
      if (Reflect.get(window, "__glossaErrorSent")) {
        return;
      }
      Reflect.set(window, "__glossaErrorSent", true);
      const glossError = Reflect.get(window, "glossError") as (scanId: string, message: string) => unknown;
      emit(glossError(message.payload.scanId, "boom"));
    });
  });
  await page.addScriptTag({ type: "module", path: resolve("dist/content.js") });

  await page.waitForFunction(() => Reflect.get(window, "__glossaErrorSent") === true);
  await page.waitForTimeout(300);
  const sentTypes = await sentMessageTypes(page);
  expect(sentTypes.filter((type) => type === "gloss.scan.chunk")).toHaveLength(1);
  expect(sentTypes).not.toContain("gloss.scan.end");
});

function largeWordList(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `word${letters(index)}`);
}

function letters(value: number): string {
  let current = value;
  let output = "";
  do {
    output = String.fromCharCode(97 + (current % 26)) + output;
    current = Math.floor(current / 26) - 1;
  } while (current >= 0);
  return output;
}

function overlaps(
  left: { left: number; right: number; top: number; bottom: number },
  right: { left: number; right: number; top: number; bottom: number }
): boolean {
  return left.left < right.right
    && left.right > right.left
    && left.top < right.bottom
    && left.bottom > right.top;
}

async function tokenGeometry(page: Page): Promise<{
  label: { top: number; bottom: number; centerX: number };
  surface: { top: number; bottom: number; centerX: number };
}> {
  return await page.evaluate(() => {
    const wrapper = document.querySelector<HTMLElement>("[data-glossa-token]");
    if (!wrapper) {
      throw new Error("expected gloss token wrapper");
    }
    const label = wrapper.querySelector<HTMLElement>("[data-glossa-token-label]")!.getBoundingClientRect();
    const surface = wrapper.querySelector<HTMLElement>("[data-glossa-token-surface]")!.getBoundingClientRect();
    return {
      label: rect(label),
      surface: rect(surface)
    };

    function rect(value: DOMRect): { top: number; bottom: number; centerX: number } {
      return {
        top: value.top,
        bottom: value.bottom,
        centerX: value.left + value.width / 2
      };
    }
  });
}

async function sentMessageTypes(page: Page): Promise<string[]> {
  return await page.evaluate(() => {
    const sent = Reflect.get(window, "__glossaMessages") as Array<{ type: string }>;
    return sent.map((message) => message.type);
  });
}

async function pressTranslationShortcut(page: Page): Promise<void> {
  await page.keyboard.down("Control");
  await page.keyboard.down("Shift");
  await page.keyboard.press("KeyG");
  await page.keyboard.up("Shift");
  await page.keyboard.up("Control");
}

async function installChromeRuntime(page: Page, settings: RuntimeSettings): Promise<void> {
  await page.evaluate((settings) => {
    const sent: unknown[] = [];
    const activationListeners: Array<(message: unknown, sender: unknown, sendResponse: (response: unknown) => void) => boolean | void> = [];
    const endedScans = new Set<string>();
    const pendingDone = new Map<string, unknown>();
    Reflect.set(window, "__glossaMessages", sent);
    Reflect.set(window, "__glossaListeners", activationListeners);
    Reflect.set(window, "__glossaDisconnects", 0);
    Reflect.set(window, "glossToken", (scanId: string, tokenId: string, status: string, item?: unknown, error?: { message?: string }) => ({
      type: "gloss.token",
      version: 1,
      createdAt: Date.now(),
      payload: {
        scanId,
        tokenId,
        status,
        ...(item ? { item } : {}),
        ...(error ? { message: error.message, error } : {})
      }
    }));
    Reflect.set(window, "glossDone", (scanId: string) => ({
      type: "gloss.done",
      version: 1,
      createdAt: Date.now(),
      payload: { scanId }
    }));
    Reflect.set(window, "glossError", (scanId: string, message: string) => ({
      type: "gloss.error",
      version: 1,
      createdAt: Date.now(),
      payload: { scanId, reason: "runtime", service: "runtime", message }
    }));
    const glossChunkAck = (scanId: string, chunkId: string, acceptedTokens: number) => ({
      type: "gloss.chunk.ack",
      version: 1,
      createdAt: Date.now(),
      payload: { scanId, chunkId, acceptedTokens }
    });
    Reflect.set(window, "chrome", {
      runtime: {
        getURL: () => "/missing-known-word-list.txt",
        onMessage: {
          addListener(listener: (message: unknown, sender: unknown, sendResponse: (response: unknown) => void) => boolean | void) {
            activationListeners.push(listener);
          }
        },
        connect() {
          const messageListeners: Array<(message: unknown) => void> = [];
          const disconnectListeners: Array<() => void> = [];
          const port = {
            name: "gloss.session",
            onMessage: {
              addListener(listener: (message: unknown) => void) {
                messageListeners.push(listener);
              }
            },
            onDisconnect: {
              addListener(listener: () => void) {
                disconnectListeners.push(listener);
              }
            },
            postMessage(message: { type: string; payload?: { scanId?: string } }) {
              sent.push(message);
              const emit = (response: unknown) => {
                if (
                  typeof response === "object"
                  && response !== null
                  && "type" in response
                  && response.type === "gloss.done"
                  && "payload" in response
                  && typeof response.payload === "object"
                  && response.payload !== null
                  && "scanId" in response.payload
                  && typeof response.payload.scanId === "string"
                ) {
                  if (endedScans.has(response.payload.scanId)) {
                    for (const listener of messageListeners) {
                      listener(response);
                    }
                  } else {
                    pendingDone.set(response.payload.scanId, response);
                  }
                  return;
                }
                for (const listener of messageListeners) {
                  listener(response);
                }
              };
              if (
                message.type === "gloss.scan.chunk"
                && message.payload
                && "chunkId" in message.payload
                && typeof message.payload.scanId === "string"
                && typeof message.payload.chunkId === "string"
                && "sentences" in message.payload
                && Array.isArray(message.payload.sentences)
              ) {
                const acceptedTokens = message.payload.sentences.reduce((total: number, sentence: { tokens?: unknown[] }) => {
                  return total + (Array.isArray(sentence.tokens) ? sentence.tokens.length : 0);
                }, 0);
                if (Reflect.get(window, "__glossaSuppressChunkAck") !== true) {
                  emit(glossChunkAck(message.payload.scanId, message.payload.chunkId, acceptedTokens));
                }
                const legacyScan = {
                  type: "gloss.scan",
                  version: 1,
                  createdAt: Date.now(),
                  payload: {
                    scanId: message.payload.scanId,
                    pageUrl: "https://example.test",
                    sentences: message.payload.sentences
                  }
                };
                sent.push(legacyScan);
                const responder = Reflect.get(window, "__glossaOnScan");
                if (typeof responder === "function") {
                  responder(legacyScan, emit);
                }
              }
              if (message.type === "gloss.scan.end" && message.payload?.scanId) {
                endedScans.add(message.payload.scanId);
                const done = pendingDone.get(message.payload.scanId);
                if (done) {
                  pendingDone.delete(message.payload.scanId);
                  for (const listener of messageListeners) {
                    listener(done);
                  }
                }
              }
            },
            disconnect() {
              const disconnects = Reflect.get(window, "__glossaDisconnects") as number;
              Reflect.set(window, "__glossaDisconnects", disconnects + 1);
              for (const listener of disconnectListeners) {
                listener();
              }
            }
          };
          return port;
        },
        sendMessage(message: { type: string; requestId: string; source: "content-script" }, callback?: (response: unknown) => void) {
          sent.push(message);
          const override = Reflect.get(window, "__glossaOnSendMessage");
          if (typeof override === "function") {
            const result = override(message, callback);
            if (result !== undefined) {
              return result;
            }
          }
          const response = message.type === "settings.get"
            ? {
              type: "settings.response",
              version: 1,
              requestId: message.requestId,
              source: "service-worker",
              target: message.source,
              createdAt: Date.now(),
              payload: { settings }
            }
            : {
              type: "word.clicked.ok",
              version: 1,
              requestId: message.requestId,
              source: "service-worker",
              target: message.source,
              createdAt: Date.now(),
              payload: { noteId: 7 }
            };
          callback?.(response);
          return Promise.resolve(response);
        }
      }
    });
  }, settings);
}
