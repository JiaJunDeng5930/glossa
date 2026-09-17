import { expect, test } from "@playwright/test";
import { createOptionsMessage } from "../../src/shared/messages";
import {
  launchExtensionFixture,
  openExtensionOriginPage,
  readExtensionDatabase,
  sendExtensionMessage
} from "../helpers/extensionFixture";

test("real unpacked extension translates a page and creates one Anki card", async () => {
  const fixture = await launchExtensionFixture();
  try {
    const extensionPage = await openExtensionOriginPage(fixture.context, fixture.extensionOrigin);
    const settings = await sendExtensionMessage(extensionPage, createOptionsMessage("settings.patch", {
      patch: {
        autoTranslateEnabled: true,
        ai: {
          provider: "glossa-backend",
          endpoint: fixture.http.aiEndpoint,
          requestTimeoutMs: 5_000
        },
        anki: {
          endpoint: fixture.http.ankiEndpoint,
          requestTimeoutMs: 5_000
        }
      }
    }));
    expect(settings).toMatchObject({ type: "settings.response", source: "service-worker", target: "options" });

    const page = await fixture.context.newPage();
    await page.goto(fixture.http.pageUrl);
    const token = page.locator(`[data-glossa-token][data-glossa-surface="${fixture.http.targetWord}"]`).first();
    await expect(token).toBeVisible();
    await expect(token).toHaveAttribute("data-glossa-status", "ready");
    await expect(token).toHaveAttribute("data-glossa-display", fixture.http.glossDisplay);

    await page.keyboard.down("Alt");
    try {
      await token.click();
    } finally {
      await page.keyboard.up("Alt");
    }
    await expect(token).toHaveAttribute("data-glossa-feedback", "card-success");
    await expect.poll(() => addNoteRequests(fixture.http.requests.ankiRequests).length).toBe(1);
    await expect.poll(async () => {
      const snapshot = await readExtensionDatabase(extensionPage);
      return {
        cardCache: snapshot.cardCache.length,
        cardedWords: snapshot.cardedWords,
        lexicon: snapshot.lexicon
      };
    }).toMatchObject({
      cardCache: 1,
      cardedWords: [{ key: `en:${fixture.http.targetWord}`, lemma: fixture.http.targetWord }],
      lexicon: expect.arrayContaining([
        expect.objectContaining({ key: `en:${fixture.http.targetWord}`, state: "learning_active" })
      ])
    });

    const addNote = addNoteRequests(fixture.http.requests.ankiRequests)[0]!;
    expect(addNote).toMatchObject({
      action: "addNote",
      params: {
        note: {
          deckName: "Glossa",
          modelName: "Basic",
          fields: {
            Front: expect.stringContaining(fixture.http.targetWord),
            Back: fixture.http.cardBack
          },
          tags: ["glossa"]
        }
      }
    });
    expect(fixture.http.requests.glossRequests.length).toBeGreaterThan(0);
    expect(fixture.http.requests.ankiCardRequests).toHaveLength(1);

    const removeBeforeReset = await sendExtensionMessage(extensionPage, createOptionsMessage("known.words.remove", {
      lemma: fixture.http.targetWord
    }));
    expect(removeBeforeReset).toMatchObject({ type: "known.words.changed" });
    const afterRemove = await readExtensionDatabase(extensionPage);
    expect(afterRemove.lexicon.find((record) => record.key === `en:${fixture.http.targetWord}`)).toMatchObject({ state: "learning_active" });
    expect(afterRemove.cardedWords).toHaveLength(1);

    const reset = await sendExtensionMessage(extensionPage, createOptionsMessage("card.history.reset", {}));
    expect(reset).toMatchObject({ type: "card.history.reset.ok" });
    await expect.poll(async () => {
      const snapshot = await readExtensionDatabase(extensionPage);
      return { cardCache: snapshot.cardCache.length, cardedWords: snapshot.cardedWords.length };
    }).toEqual({ cardCache: 0, cardedWords: 0 });

    // A stale UI removal intent contains only a lemma; it cannot recreate the history marker after reset.
    const staleRemove = await sendExtensionMessage(extensionPage, createOptionsMessage("known.words.remove", {
      lemma: fixture.http.targetWord
    }));
    expect(staleRemove).toMatchObject({ type: "known.words.changed" });
    const afterStaleRemove = await readExtensionDatabase(extensionPage);
    expect(afterStaleRemove.cardedWords).toHaveLength(0);
    expect(afterStaleRemove.lexicon.find((record) => record.key === `en:${fixture.http.targetWord}`)).toMatchObject({ state: "learning_active" });
    expect(addNoteRequests(fixture.http.requests.ankiRequests)).toHaveLength(1);
  } finally {
    await fixture.close();
  }
});

function addNoteRequests(values: unknown[]): Array<Record<string, unknown>> {
  return values.filter((value): value is Record<string, unknown> => isRecord(value) && value.action === "addNote");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
