import { expect, test } from "@playwright/test";
import { resolve } from "node:path";

import { installPopupChrome, loadUiPage } from "../helpers/uiPage";

test("popup loads the shared theme and toggles translation for the current tab", async ({ page }) => {
  await loadUiPage(page, "popup");
  await installPopupChrome(page);
  await page.addScriptTag({ path: resolve("dist/popup.js"), type: "module" });

  await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--glossa-theme-accent").trim())).not.toBe("");
  await expect(page.locator("#page-state-label")).toHaveText("翻译已关闭");
  await expect(page.locator("#translate-page")).toHaveText("翻译本页");
  await page.locator("#translate-page").click();
  await expect.poll(() => page.evaluate(() => Boolean(Reflect.get(window, "__glossaPopupClosed")))).toBe(true);
  expect(await page.evaluate(() => Reflect.get(window, "__glossaTabMessages"))).toEqual([
    { tabId: 11, message: { type: "glossa.getTranslationState" }, options: { frameId: 0 } },
    { tabId: 11, message: { type: "glossa.toggleTranslationState" }, options: { frameId: 0 } },
    { tabId: 11, message: { type: "glossa.setTranslationState", enabled: true } }
  ]);
});

test("popup renders the saved translation shortcut through settings RPC", async ({ page }) => {
  await loadUiPage(page, "popup");
  await installPopupChrome(page, { shortcut: "Ctrl+Shift+K" });
  await page.addScriptTag({ path: resolve("dist/popup.js"), type: "module" });

  await expect(page.locator("#translate-shortcut-hint")).toHaveAttribute("aria-label", "Ctrl+Shift+K");
  await expect(page.locator("#translate-shortcut-hint kbd")).toHaveText(["Ctrl", "Shift", "K"]);
});

test("popup reports a structured toggle error and restores the button", async ({ page }) => {
  await loadUiPage(page, "popup");
  await installPopupChrome(page, { toggleError: true });
  await page.addScriptTag({ path: resolve("dist/popup.js"), type: "module" });

  await page.locator("#translate-page").click();
  await expect(page.locator("#popup-status")).toHaveText("扩展请求超时");
  await expect(page.locator("#translate-page")).toBeEnabled();
});

test("popup reports malformed toggle responses without closing", async ({ page }) => {
  await loadUiPage(page, "popup");
  await installPopupChrome(page, { malformedToggle: true });
  await page.addScriptTag({ path: resolve("dist/popup.js"), type: "module" });

  await page.locator("#translate-page").click();
  await expect(page.locator("#popup-status")).toHaveText("扩展运行时错误");
  await expect(page.locator("#translate-page")).toBeEnabled();
  await expect.poll(() => page.evaluate(() => Boolean(Reflect.get(window, "__glossaPopupClosed")))).toBe(false);
});

test("popup offers stop when translation is active", async ({ page }) => {
  await loadUiPage(page, "popup");
  await installPopupChrome(page, { enabled: true });
  await page.addScriptTag({ path: resolve("dist/popup.js"), type: "module" });

  await expect(page.locator("#page-state-label")).toHaveText("翻译已开启");
  await expect(page.locator("#translate-page")).toHaveText("停止翻译");
});

test("popup retries its state probe while the content script starts", async ({ page }) => {
  await loadUiPage(page, "popup");
  await installPopupChrome(page, { probeFailures: 4 });
  await page.addScriptTag({ path: resolve("dist/popup.js"), type: "module" });

  await expect(page.locator("#page-state-label")).toHaveText("翻译已关闭", { timeout: 8_000 });
  await expect(page.locator("#translate-page")).toBeEnabled();
  expect(await page.evaluate(() => (Reflect.get(window, "__glossaProbeAttempts") as () => number)())).toBe(5);
});

test("popup localizes pages without a content script", async ({ page }) => {
  await loadUiPage(page, "popup");
  await installPopupChrome(page, { unavailable: true });
  await page.addScriptTag({ path: resolve("dist/popup.js"), type: "module" });

  await expect(page.locator("#page-state-label")).toHaveText("此页面不可用", { timeout: 8_000 });
  await expect(page.locator("#translate-page")).toBeDisabled();
  await expect(page.locator("#popup-status")).toHaveText("当前页面不支持扩展翻译");
  await expect(page.locator("#popup-status")).not.toContainText("Receiving end");
});
