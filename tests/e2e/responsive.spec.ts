import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

async function loadStaticPage(page: Page, htmlPath: string, stylePaths: string[]): Promise<void> {
  const html = await readFile(resolve(htmlPath), "utf8");
  await page.setContent(html
    .replace(/<link[^>]+rel="stylesheet"[^>]*>\s*/g, "")
    .replace(/<script\b[\s\S]*?<\/script>\s*/g, ""));
  for (const stylePath of stylePaths) {
    await page.addStyleTag({ path: resolve(stylePath) });
  }
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const dimensions = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth
  }));
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth);
}

test("onboarding fits the usable width beside a classic scrollbar", async ({ page }) => {
  await page.setViewportSize({ width: 305, height: 720 });
  await loadStaticPage(page, "dist/onboarding/onboarding.html", [
    "dist/assets/theme.css",
    "dist/assets/onboarding.css"
  ]);
  await expectNoHorizontalOverflow(page);
});

test("website fits the usable width beside a classic scrollbar", async ({ page }) => {
  await page.setViewportSize({ width: 305, height: 720 });
  await loadStaticPage(page, "website/public/index.html", ["website/public/styles/global.css"]);
  await expectNoHorizontalOverflow(page);
});
