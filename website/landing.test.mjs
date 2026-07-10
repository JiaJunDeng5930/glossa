import assert from "node:assert/strict";
import { test } from "node:test";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";

const landingUrl = pathToFileURL(resolve("website/public/index.html")).href;

test("landing page keeps its story, CTA, and responsive layout intact", async () => {
  const browser = await chromium.launch({ headless: true });

  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const runtimeErrors = [];
    page.on("pageerror", (error) => runtimeErrors.push(error.message));
    page.on("console", (message) => message.type() === "error" && runtimeErrors.push(message.text()));

    await page.goto(landingUrl, { waitUntil: "load" });
    await page.evaluate(() => { document.documentElement.style.scrollBehavior = "auto"; });

    assert.match(await page.title(), /^Glossa/);
    assert.equal(
      await page.locator(".button-primary").getAttribute("href"),
      "https://github.com/JiaJunDeng5930/glossa/releases/latest",
    );
    assert.equal(await page.locator("[data-story]").evaluate((node) => node.classList.contains("is-interactive")), true);

    const story = page.locator("[data-story]");
    const geometry = await story.evaluate((node) => ({
      top: node.getBoundingClientRect().top + scrollY,
      distance: node.offsetHeight - innerHeight,
    }));
    await page.evaluate(({ top, distance }) => scrollTo(0, top + distance * 0.94), geometry);
    await page.waitForFunction(() => Number.parseFloat(getComputedStyle(document.querySelector("[data-story]")).getPropertyValue("--card")) > 0.9);

    assert.equal(await page.locator("[data-story-step]").textContent(), "03");
    assert.ok(Number.parseFloat(await page.locator(".anki-memory-card").evaluate((node) => getComputedStyle(node).opacity)) > 0.9);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 1440);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload({ waitUntil: "load" });

    assert.equal(await page.locator("[data-story]").evaluate((node) => node.classList.contains("is-interactive")), false);
    assert.equal(await page.locator(".story-chapter").count(), 3);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390);

    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.reload({ waitUntil: "load" });
    assert.equal(await page.locator("[data-story]").evaluate((node) => node.classList.contains("is-interactive")), false);
    assert.deepEqual(runtimeErrors, []);
  } finally {
    await browser.close();
  }
});
