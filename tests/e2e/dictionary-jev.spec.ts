import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, test } from "@playwright/test";
import { createOptionsMessage } from "../../src/shared/messages";
import {
  launchExtensionFixture,
  openExtensionOriginPage,
  sendExtensionMessage
} from "../helpers/extensionFixture";

const WORD = "crane";
const MISSING_WORD = "glossaunknownword";
const SENTENCE = `The ${WORD} is next to ${MISSING_WORD}.`;

for (const fallbackToLlm of [false, true]) {
  test(`real dictionary and Jev translate a word while a dictionary miss stays inline (fallback ${fallbackToLlm})`, async () => {
    const network = await startTranslationServer();
    const fixture = await launchExtensionFixture({ targetWord: WORD, sentence: SENTENCE });
    try {
      const extensionPage = await openExtensionOriginPage(fixture.context, fixture.extensionOrigin);
      const settings = await sendExtensionMessage(extensionPage, createOptionsMessage("settings.patch", {
        patch: {
          autoTranslateEnabled: true,
          translation: { mode: "dictionary-jev", fallbackToLlm },
          jev: {
            endpoint: `${network.origin}/jev`,
            apiKey: "e2e-jev-key",
            requestTimeoutMs: 5_000
          },
          ai: {
            provider: fallbackToLlm ? "glossa-backend" : "openai-responses",
            endpoint: network.origin,
            apiKey: null,
            requestTimeoutMs: 1_000
          }
        }
      }));
      expect(settings).toMatchObject({ type: "settings.response" });

      const page = await fixture.context.newPage();
      const dialogs: string[] = [];
      page.on("dialog", async dialog => {
        dialogs.push(dialog.message());
        await dialog.dismiss();
      });
      await page.goto(fixture.http.pageUrl);

      const translated = page.locator(`[data-glossa-token][data-glossa-surface="${WORD}"]`).first();
      const missing = page.locator(`[data-glossa-token][data-glossa-surface="${MISSING_WORD}"]`).first();
      await expect(translated).toHaveAttribute("data-glossa-status", "ready");
      await expect(translated).toHaveAttribute("data-glossa-display", "起重机");
      await expect(missing).toHaveAttribute("data-glossa-status", "error");
      await expect(missing).toHaveAttribute("data-glossa-display", "×");
      expect(await missing.locator("[data-glossa-token-label]").evaluate(label =>
        ["::before", "::after"].map(pseudo => getComputedStyle(label, pseudo).backgroundColor)
      )).toEqual(["rgb(180, 59, 50)", "rgb(180, 59, 50)"]);
      await expect(page.locator('[role="alert"], [role="alertdialog"], [role="dialog"], dialog, [aria-live], [data-glossa-toast], [class*="toast"]')).toHaveCount(0);
      expect(dialogs).toEqual([]);

      expect(network.jevRequests).toHaveLength(1);
      const request = network.jevRequests[0]!;
      expect(request.state).toMatchObject({
        sentence: SENTENCE,
        word: { surface: WORD, lemma: WORD }
      });
      const criteria = Object.values(request.questions.dictionary_sense!.criteria);
      expect(criteria).toContainEqual(expect.stringMatching(/鹤/));
      expect(criteria).toContainEqual(expect.stringMatching(/起重机$/));
      expect(criteria.length).toBeGreaterThan(1);
      expect(network.authorizations).toEqual(["Bearer e2e-jev-key"]);
      if (fallbackToLlm) {
        expect(network.aiRequests.length).toBeGreaterThan(0);
        expect(JSON.stringify(network.aiRequests)).toContain(MISSING_WORD);
        expect(JSON.stringify(network.aiRequests)).not.toContain(`"${WORD}"`);
      } else {
        expect(network.aiRequests).toEqual([]);
      }
    } finally {
      await fixture.close();
      await closeServer(network.server);
    }
  });
}

test("onboarding can verify Jev and continue without connecting the optional ordinary LLM", async () => {
  const network = await startTranslationServer();
  const fixture = await launchExtensionFixture();
  try {
    const page = await fixture.context.newPage();
    await page.goto(`${fixture.extensionOrigin}/onboarding/onboarding.html`);
    for (let index = 0; index < 5; index += 1) await page.locator("#continue").click();
    await expect(page.locator("[data-step]:not([hidden])")).toHaveAttribute("data-step", "ai");
    await page.locator("select[name=translationMode]").selectOption("dictionary-jev");
    await expect(page.locator("[data-onboarding-llm-settings]")).toBeHidden();
    await page.locator("input[name=fallbackToLlm]").check();
    await expect(page.locator("[data-onboarding-llm-settings]")).toBeVisible();
    await page.locator("input[name=jevEndpoint]").fill(`${network.origin}/jev`);
    await page.locator("input[name=jevApiKey]").fill("e2e-jev-key");
    await page.locator("#continue").click();
    await expect(page.locator("[data-step]:not([hidden])")).toHaveAttribute("data-step", "ai");
    await page.locator("#test-jev").click();
    await expect(page.locator("#jev-status")).toHaveAttribute("data-state", "success");
    await page.locator("#continue").click();
    await expect(page.locator("[data-step]:not([hidden])")).toHaveAttribute("data-step", "anki");
    const settings = await sendExtensionMessage(page, createOptionsMessage("settings.get", {}));
    expect(settings).toMatchObject({
      type: "settings.response",
      payload: {
        settings: {
          translation: { mode: "dictionary-jev", fallbackToLlm: true },
          jev: { endpoint: `${network.origin}/jev`, apiKey: "e2e-jev-key" }
        }
      }
    });
    expect(network.jevRequests).toHaveLength(1);
    expect(network.aiRequests).toEqual([]);
  } finally {
    await fixture.close();
    await closeServer(network.server);
  }
});

interface JevRequest {
  state: unknown;
  questions: Record<string, { criteria: Record<string, string> }>;
}

async function startTranslationServer(): Promise<{
  origin: string;
  server: Server;
  jevRequests: JevRequest[];
  authorizations: Array<string | undefined>;
  aiRequests: unknown[];
}> {
  const jevRequests: JevRequest[] = [];
  const authorizations: Array<string | undefined> = [];
  const aiRequests: unknown[] = [];
  const server = createServer(async (request, response) => {
    response.setHeader("access-control-allow-origin", "*");
    response.setHeader("access-control-allow-methods", "POST, OPTIONS");
    response.setHeader("access-control-allow-headers", "content-type, authorization");
    if (request.method === "OPTIONS") {
      response.writeHead(204).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (request.url === "/jev") {
      const jevRequest = body as JevRequest;
      jevRequests.push(jevRequest);
      authorizations.push(request.headers.authorization);
      // Select by the actual dictionary definition, never by its request-local position.
      const [questionId, question] = Object.entries(jevRequest.questions)[0]!;
      const choice = Object.entries(question.criteria).find(([, definition]) => /(?:起重机|河岸)$/.test(definition))?.[0];
      response.writeHead(choice ? 200 : 422, { "content-type": "application/json" });
      response.end(JSON.stringify({ answers: { [questionId]: { choice } } }));
      return;
    }
    aiRequests.push(body);
    request.socket.destroy();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return {
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    server,
    jevRequests,
    authorizations,
    aiRequests
  };
}

async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
