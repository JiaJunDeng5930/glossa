import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { attachGlossPort, type GlossPortDependencies } from "../../src/background/glossPort";
import type { GlossResolverSession, GlossResolverSink } from "../../src/background/glossResolver";
import { glossScanConfigHash } from "../../src/core/cache";
import { createGlossPortMessage } from "../../src/shared/messages";
import {
  DEFAULT_SETTINGS,
  type GlossPortOutboundMessage,
  type GlossaSettings,
  type SentenceCandidate
} from "../../src/shared/types";
import { createTestEvent, deferred, drainMicrotasks, waitForMicrotask } from "./asyncHarness";

const PAGE_URL = "https://example.test/article";

beforeEach(() => {
  vi.spyOn(console, "debug").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("background gloss port state transitions", () => {
  it("serializes start, chunk 0, chunk 1 and end when settings are delayed", async () => {
    const settings = deferred<GlossaSettings>();
    const chunk0 = deferred();
    const chunk1 = deferred();
    const finish = deferred();
    const ledger: string[] = [];
    const fixture = createFixture({
      settings,
      ledger,
      acceptChunk: async (_chunkId, chunkIndex) => {
        ledger.push(`accept:${chunkIndex}:start`);
        await (chunkIndex === 0 ? chunk0.promise : chunk1.promise);
        ledger.push(`accept:${chunkIndex}:end`);
      },
      finish: async () => {
        ledger.push("finish:start");
        await finish.promise;
        ledger.push("finish:end");
      }
    });

    fixture.receive(start("scan-1"));
    fixture.receive(chunk("scan-1", "chunk-0", 0));
    fixture.receive(chunk("scan-1", "chunk-1", 1));
    fixture.receive(end("scan-1"));
    expect(ledger).toEqual(["settings:get"]);

    settings.resolve(DEFAULT_SETTINGS);
    await waitForMicrotask(() => ledger.includes("accept:0:start"), "first chunk starts");
    chunk0.resolve();
    await waitForMicrotask(() => fixture.messages.some(isAckFor("chunk-0")), "first chunk is acknowledged");
    await waitForMicrotask(() => ledger.includes("accept:1:start"), "second chunk starts");
    chunk1.resolve();
    await waitForMicrotask(() => fixture.messages.some(isAckFor("chunk-1")), "second chunk is acknowledged");
    await waitForMicrotask(() => ledger.includes("finish:start"), "finish starts after both chunks");
    finish.resolve();
    await waitForMicrotask(() => fixture.messages.some((message) => message.type === "gloss.done"), "done is posted");

    expect(ledger).toEqual([
      "settings:get",
      "generation:activate",
      "session:create",
      "accept:0:start",
      "accept:0:end",
      "post:gloss.chunk.ack:chunk-0",
      "accept:1:start",
      "accept:1:end",
      "post:gloss.chunk.ack:chunk-1",
      "finish:start",
      "finish:end",
      "post:gloss.done"
    ]);
    expect(fixture.messages.map((message) => message.type)).toEqual([
      "gloss.chunk.ack",
      "gloss.chunk.ack",
      "gloss.done"
    ]);
  });

  it("closes the session after the first invalid chunk sequence", async () => {
    const foreignLedger: string[] = [];
    const foreign = createFixture({ ledger: foreignLedger });
    foreign.receive(start("scan-1"));
    await waitForMicrotask(() => foreignLedger.includes("session:create"), "foreign fixture opens");
    foreign.receive(chunk("scan-other", "foreign", 0));
    await waitForMicrotask(() => errorCount(foreign.messages) === 1, "foreign scan error");
    foreign.receive(chunk("scan-1", "chunk-0", 0));
    await drainMicrotasks();
    expect(foreignLedger.filter((entry) => entry.startsWith("accept:"))).toEqual([]);
    expect(errorCount(foreign.messages)).toBe(1);

    const orderLedger: string[] = [];
    const outOfOrder = createFixture({ ledger: orderLedger });
    outOfOrder.receive(start("scan-1"));
    await waitForMicrotask(() => orderLedger.includes("session:create"), "order fixture opens");
    outOfOrder.receive(chunk("scan-1", "out-of-order", 1));
    await waitForMicrotask(() => errorCount(outOfOrder.messages) === 1, "out-of-order error");
    expect(orderLedger.filter((entry) => entry.startsWith("accept:"))).toEqual([]);

    const duplicateLedger: string[] = [];
    const duplicate = createFixture({ ledger: duplicateLedger });
    duplicate.receive(start("scan-1"));
    await waitForMicrotask(() => duplicateLedger.includes("session:create"), "duplicate fixture opens");
    duplicate.receive(chunk("scan-1", "chunk-0", 0));
    await waitForMicrotask(() => duplicate.messages.some(isAckFor("chunk-0")), "first chunk acknowledgement");
    duplicate.receive(chunk("scan-1", "chunk-0", 1));
    await waitForMicrotask(() => errorCount(duplicate.messages) === 1, "duplicate id error");
    expect(duplicateLedger.filter((entry) => entry.startsWith("accept:"))).toEqual([
      "accept:0:start",
      "accept:0:end"
    ]);
    expect(duplicate.messages.filter((message) => message.type === "gloss.chunk.ack")).toHaveLength(1);
  });

  it("rejects a scan whose captured configuration no longer matches current settings", async () => {
    const settings = deferred<GlossaSettings>();
    const ledger: string[] = [];
    const fixture = createFixture({ settings, ledger });

    fixture.receive(start("scan-1"));
    settings.resolve({ ...DEFAULT_SETTINGS, knownWordList: "senior-high" });
    await waitForMicrotask(() => errorCount(fixture.messages) === 1, "obsolete configuration error");

    expect(ledger).toEqual(["settings:get", "post:gloss.error"]);
    expect(fixture.messages[0]).toMatchObject({
      type: "gloss.error",
      payload: { scanId: "scan-1", reason: "runtime" }
    });
  });

  it("closes a pending session on disconnect without acknowledging or finishing queued work", async () => {
    const pendingChunk = deferred();
    const ledger: string[] = [];
    let sink: GlossResolverSink | undefined;
    const fixture = createFixture({
      ledger,
      onCreateSession(createdSink) {
        sink = createdSink;
      },
      acceptChunk: async () => {
        ledger.push("accept:0:start");
        await pendingChunk.promise;
        ledger.push("accept:0:end");
      }
    });
    fixture.receive(start("scan-1"));
    await waitForMicrotask(() => sink !== undefined, "session sink is captured");
    fixture.receive(chunk("scan-1", "chunk-0", 0));
    await waitForMicrotask(() => ledger.includes("accept:0:start"), "chunk lookup is pending");

    fixture.receive(end("scan-1"));
    fixture.disconnect();
    expect(sink?.isActive?.()).toBe(false);
    pendingChunk.resolve();
    await drainMicrotasks();

    expect(ledger).not.toContain("finish:start");
    expect(fixture.messages).toEqual([]);
  });
});

interface FixtureOptions {
  settings?: ReturnType<typeof deferred<GlossaSettings>>;
  ledger?: string[];
  acceptChunk?: GlossResolverSession["acceptChunk"];
  finish?: GlossResolverSession["finish"];
  onCreateSession?(sink: GlossResolverSink): void;
}

function createFixture(options: FixtureOptions = {}) {
  const ledger = options.ledger ?? [];
  const settings = options.settings;
  let disconnected = false;
  const onMessage = createTestEvent<[unknown]>();
  const onDisconnect = createTestEvent<[]>();
  const messages: GlossPortOutboundMessage[] = [];
  const session: GlossResolverSession = {
    acceptChunk: options.acceptChunk ?? (async (_chunkId, chunkIndex) => {
      ledger.push(`accept:${chunkIndex}:start`, `accept:${chunkIndex}:end`);
    }),
    finish: options.finish ?? (async () => {
      ledger.push("finish:start", "finish:end");
    })
  };
  const port = {
    name: "gloss.session",
    onMessage,
    onDisconnect,
    postMessage(rawMessage: unknown) {
      if (disconnected) {
        throw new Error("Port is disconnected");
      }
      const message = rawMessage as GlossPortOutboundMessage;
      messages.push(message);
      ledger.push(message.type === "gloss.chunk.ack"
        ? `post:${message.type}:${message.payload.chunkId}`
        : `post:${message.type}`);
    }
  } as unknown as chrome.runtime.Port;
  const dependencies: GlossPortDependencies = {
    storage: {
      settings: {
        get: vi.fn(() => {
          ledger.push("settings:get");
          return settings?.promise ?? Promise.resolve(DEFAULT_SETTINGS);
        })
      }
    } as unknown as GlossPortDependencies["storage"],
    glossResolver: {
      activateGeneration: vi.fn(async () => {
        ledger.push("generation:activate");
      }),
      createSession: vi.fn((_pageUrl, _settings, _now, createdSink) => {
        ledger.push("session:create");
        options.onCreateSession?.(createdSink);
        return session;
      })
    }
  };
  attachGlossPort(port, dependencies);

  return {
    ledger,
    messages,
    receive(message: unknown) {
      onMessage.emit(message);
    },
    disconnect() {
      disconnected = true;
      onDisconnect.emit();
    }
  };
}

function start(scanId: string) {
  return createGlossPortMessage("gloss.scan.start", {
    scanId,
    pageUrl: PAGE_URL,
    scanConfigHash: glossScanConfigHash(DEFAULT_SETTINGS)
  });
}

function chunk(scanId: string, chunkId: string, chunkIndex: number) {
  return createGlossPortMessage("gloss.scan.chunk", {
    scanId,
    chunkId,
    chunkIndex,
    pageUrl: PAGE_URL,
    sentences: [sentence(chunkIndex)]
  });
}

function end(scanId: string) {
  return createGlossPortMessage("gloss.scan.end", { scanId });
}

function sentence(index: number): SentenceCandidate {
  const sentenceId = `sentence-${index}`;
  return {
    id: sentenceId,
    text: "Word.",
    tokens: [{
      id: `token-${index}`,
      sentenceId,
      surface: "Word",
      lemma: "word",
      startOffset: 0,
      endOffset: 4
    }]
  };
}

function isAckFor(chunkId: string): (message: GlossPortOutboundMessage) => boolean {
  return (message) => message.type === "gloss.chunk.ack" && message.payload.chunkId === chunkId;
}

function errorCount(messages: GlossPortOutboundMessage[]): number {
  return messages.filter((message) => message.type === "gloss.error").length;
}
