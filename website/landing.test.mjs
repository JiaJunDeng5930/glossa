import assert from "node:assert/strict";
import { test } from "node:test";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";

const landingUrl = pathToFileURL(resolve("website/public/index.html")).href;
const navigationHrefs = [
  "#story",
  "#details",
  "#install",
  "https://github.com/JiaJunDeng5930/glossa",
];

async function assertMobileNavigation(page, viewport) {
  await page.setViewportSize(viewport);
  await page.goto(landingUrl, { waitUntil: "load" });
  await page.evaluate(() => { document.documentElement.style.scrollBehavior = "auto"; });

  const navigation = page.getByRole("navigation", { name: "主导航" });
  const links = navigation.getByRole("link");
  assert.equal(await navigation.count(), 1);
  assert.equal(await links.count(), navigationHrefs.length);
  assert.deepEqual(await links.evaluateAll((nodes) => nodes.map((node) => node.getAttribute("href"))), navigationHrefs);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), viewport.width);
  assert.equal(await page.evaluate(() => {
    const header = document.querySelector(".site-header").getBoundingClientRect();
    const cta = document.querySelector(".button-primary").getBoundingClientRect();
    return cta.top >= header.bottom;
  }), true);

  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  for (const href of navigationHrefs) {
    await page.keyboard.press("Tab");
    assert.deepEqual(await page.evaluate(() => ({
      href: document.activeElement?.getAttribute("href"),
      inNavigation: document.querySelector(".site-nav").contains(document.activeElement),
      focusVisible: document.activeElement?.matches(":focus-visible"),
    })), { href, inNavigation: true, focusVisible: true });
  }

  for (const href of navigationHrefs.slice(0, 3)) {
    await navigation.locator(`a[href="${href}"]`).focus();
    await page.keyboard.press("Enter");
    await page.waitForFunction((hash) => location.hash === hash, href);
    assert.equal(await page.locator(href).evaluate((target) => {
      const header = document.querySelector(".site-header").getBoundingClientRect();
      return target.getBoundingClientRect().top >= header.bottom - 1;
    }), true);
  }
}

async function assertStoryCopySeparation(page) {
  const separation = await page.evaluate(() => {
    const eyebrow = document.querySelector(".story-copy > .eyebrow").getBoundingClientRect();
    const chapter = [...document.querySelectorAll(".story-chapter")]
      .find((node) => Number.parseFloat(getComputedStyle(node).opacity) > 0.5)
      .getBoundingClientRect();
    const progress = document.querySelector(".story-progress").getBoundingClientRect();
    return {
      eyebrowBeforeChapter: eyebrow.bottom <= chapter.top,
      chapterBeforeProgress: chapter.bottom + 16 <= progress.top,
    };
  });
  assert.deepEqual(separation, {
    eyebrowBeforeChapter: true,
    chapterBeforeProgress: true,
  });
}

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
    assert.equal(await page.locator("#hero-title").textContent(), "生词智能语境翻译，让原文阅读不被打断。");
    assert.equal(await page.locator(".hero-caption span").count(), 0);
    assert.match(await page.locator(".margin-note").textContent(), /结合整句语境，\s*给出此处词义。/);
    assert.equal(
      await page.locator(".button-primary").getAttribute("href"),
      "https://github.com/JiaJunDeng5930/glossa/releases/latest",
    );
    await page.evaluate(() => document.getAnimations().forEach((animation) => animation.finish()));
    assert.equal(await page.locator(".article-body-copy").evaluate((root) => {
      const textRects = [];
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        if (node.parentElement.closest(".glossa-label")) continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        textRects.push(...range.getClientRects());
      }
      return [...root.querySelectorAll(".glossa-label")].filter((label) => {
        const labelRect = label.getBoundingClientRect();
        return textRects.some((textRect) => (
          labelRect.left < textRect.right
            && labelRect.right > textRect.left
            && labelRect.top < textRect.bottom
            && labelRect.bottom > textRect.top
        ));
      }).length;
    }), 0);
    assert.equal(await page.locator("[data-story]").evaluate((node) => node.classList.contains("is-interactive")), true);

    const story = page.locator("[data-story]");
    const geometry = await story.evaluate((node) => ({
      top: node.getBoundingClientRect().top + scrollY,
      distance: node.offsetHeight - innerHeight,
    }));
    await page.evaluate(({ top, distance }) => scrollTo(0, top + distance * 0.785), geometry);
    await page.waitForFunction(() => Number.parseFloat(getComputedStyle(document.querySelector(".story-pointer")).opacity) > 0.95);
    const pointerAnchorState = await page.evaluate(() => {
      const pointer = document.querySelector(".story-pointer");
      const target = document.querySelector(".card-target .glossa-surface");
      const pointerRect = pointer.getBoundingClientRect();
      const targetRect = target.getBoundingClientRect();
      return {
        anchoredToTarget: pointer.parentElement === target,
        hotspotInsideTarget: pointerRect.left >= targetRect.left
          && pointerRect.left <= targetRect.right
          && pointerRect.top >= targetRect.top
          && pointerRect.top <= targetRect.bottom,
        cardOpacity: Number.parseFloat(getComputedStyle(document.querySelector(".anki-memory-card")).opacity),
      };
    });
    assert.equal(pointerAnchorState.anchoredToTarget, true);
    assert.equal(pointerAnchorState.hotspotInsideTarget, true);
    assert.ok(pointerAnchorState.cardOpacity < 0.01);

    await page.evaluate(({ top, distance }) => scrollTo(0, top + distance * 0.94), geometry);
    await page.waitForFunction(() => Number.parseFloat(getComputedStyle(document.querySelector("[data-story]")).getPropertyValue("--card")) > 0.9);

    assert.equal(await page.locator("[data-story-step]").textContent(), "03");
    assert.ok(Number.parseFloat(await page.locator(".anki-memory-card").evaluate((node) => getComputedStyle(node).opacity)) > 0.9);
    const storyOverlayState = await page.evaluate(() => {
      const overlaps = (first, second) => (
        first.left < second.right
          && first.right > second.left
          && first.top < second.bottom
          && first.bottom > second.top
      );
      const hint = document.querySelector(".selection-hint").getBoundingClientRect();
      const kicker = document.querySelector(".story-article-kicker").getBoundingClientRect();
      const heading = document.querySelector(".story-article h3").getBoundingClientRect();
      const pointer = document.querySelector(".story-pointer");
      const target = document.querySelector(".card-target .glossa-surface");
      const dim = document.querySelector(".story-dim");
      const card = document.querySelector(".anki-memory-card").getBoundingClientRect();
      const browserFrame = document.querySelector(".story-browser").getBoundingClientRect();
      return {
        hintOverlapsCopy: overlaps(hint, kicker) || overlaps(hint, heading),
        pointerOpacity: Number.parseFloat(getComputedStyle(pointer).opacity),
        targetAboveDim: Number.parseInt(getComputedStyle(target).zIndex, 10)
          > Number.parseInt(getComputedStyle(dim).zIndex, 10),
        cardAboveTarget: Number.parseInt(getComputedStyle(document.querySelector(".anki-memory-card")).zIndex, 10)
          > Number.parseInt(getComputedStyle(target).zIndex, 10),
        cardInsideFrame: card.top >= browserFrame.top
          && card.right <= browserFrame.right
          && card.bottom <= browserFrame.bottom
          && card.left >= browserFrame.left,
      };
    });
    assert.equal(storyOverlayState.hintOverlapsCopy, false);
    assert.ok(storyOverlayState.pointerOpacity < 0.05);
    assert.equal(storyOverlayState.targetAboveDim, true);
    assert.equal(storyOverlayState.cardAboveTarget, true);
    assert.equal(storyOverlayState.cardInsideFrame, true);
    assert.match(await page.locator(".memory-word").textContent(), /Words that become indispensable to the argument\./);
    assert.equal(await page.locator(".memory-meaning p").count(), 0);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 1440);

    assert.equal(await page.locator(".install-heading h2").evaluate((node) => (
      Math.round(node.getBoundingClientRect().height / Number.parseFloat(getComputedStyle(node).lineHeight))
    )), 2);

    await page.setViewportSize({ width: 1081, height: 700 });
    await page.reload({ waitUntil: "load" });
    const thresholdStory = page.locator("[data-story]");
    const thresholdStoryTop = await thresholdStory.evaluate((node) => node.getBoundingClientRect().top + scrollY);
    await page.evaluate((top) => {
      document.documentElement.style.scrollBehavior = "auto";
      scrollTo(0, top);
    }, thresholdStoryTop);
    assert.equal(await thresholdStory.evaluate((node) => node.classList.contains("is-interactive")), true);
    await assertStoryCopySeparation(page);
    assert.equal(await page.evaluate(() => {
      const header = document.querySelector(".site-header").getBoundingClientRect();
      const demo = document.querySelector(".story-browser").getBoundingClientRect();
      return demo.top >= header.bottom && demo.bottom <= innerHeight;
    }), true);

    await page.setViewportSize({ width: 1280, height: 720 });
    await page.reload({ waitUntil: "load" });
    const laptopStory = page.locator("[data-story]");
    const laptopStoryTop = await laptopStory.evaluate((node) => node.getBoundingClientRect().top + scrollY);
    await page.evaluate((top) => {
      document.documentElement.style.scrollBehavior = "auto";
      scrollTo(0, top);
    }, laptopStoryTop);
    assert.equal(await laptopStory.evaluate((node) => node.classList.contains("is-interactive")), true);
    assert.equal(await page.evaluate(() => {
      const header = document.querySelector(".site-header").getBoundingClientRect();
      const demo = document.querySelector(".story-browser").getBoundingClientRect();
      return demo.top >= header.bottom;
    }), true);

    await page.setViewportSize({ width: 1024, height: 768 });
    await page.reload({ waitUntil: "load" });
    assert.equal(await page.locator("[data-story]").evaluate((node) => node.classList.contains("is-interactive")), false);
    assert.equal(await page.getByRole("navigation", { name: "主导航" }).evaluate((node) => (
      getComputedStyle(node).display !== "none"
    )), true);

    await assertMobileNavigation(page, { width: 390, height: 844 });

    assert.equal(await page.locator("[data-story]").evaluate((node) => node.classList.contains("is-interactive")), false);
    assert.equal(await page.locator(".story-chapter").count(), 3);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390);
    assert.equal(await page.evaluate(() => {
      const preview = document.querySelector(".settings-window").getBoundingClientRect();
      return preview.left >= 0 && preview.right <= innerWidth;
    }), true);
    assert.equal(await page.locator(".details-intro h2 br").evaluate((node) => getComputedStyle(node).display), "none");
    assert.equal(await page.locator(".install-heading h2 br").evaluate((node) => getComputedStyle(node).display), "none");

    await assertMobileNavigation(page, { width: 320, height: 700 });

    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.reload({ waitUntil: "load" });
    assert.equal(await page.locator("[data-story]").evaluate((node) => node.classList.contains("is-interactive")), false);
    assert.ok(Number.parseFloat(await page.locator(".story-pointer").evaluate((node) => getComputedStyle(node).opacity)) < 0.05);
    assert.deepEqual(runtimeErrors, []);
  } finally {
    await browser.close();
  }
});
