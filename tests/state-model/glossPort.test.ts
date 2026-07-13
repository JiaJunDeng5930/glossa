import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { attachGlossPort, type GlossPortDependencies } from "../../src/background/glossPort";
import type { GlossResolverSession, GlossResolverSink } from "../../src/background/glossResolver";
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

  it("rejects chunks with a different scan identity, an unexpected index, or a reused chunk id", async () => {
    const ledger: string[] = [];
    const fixture = createFixture({ ledger });
    fixture.receive(start("scan-1"));
    await waitForMicrotask(() => ledger.includes("session:create"), "session is created");

    fixture.receive(chunk("scan-other", "foreign", 0));
    await waitForMicrotask(() => errorCount(fixture.messages) === 1, "foreign scan error");
    expect(ledger.filter((entry) => entry.startsWith("accept:"))).toEqual([]);

    fixture.receive(chunk("scan-1", "out-of-order", 1));
    await waitForMicrotask(
      () => errorCount(fixture.messages) === 2 || ledger.includes("accept:1:start"),
      "out-of-order chunk result"
    );

    fixture.receive(chunk("scan-1", "chunk-0", 0));
    await waitForMicrotask(() => fixture.messages.some(isAckFor("chunk-0")), "valid first chunk acknowledgement");
    fixture.receive(chunk("scan-1", "chunk-0", 1));
    await waitForMicrotask(
      () => errorCount(fixture.messages) === 3 || ledger.filter((entry) => entry === "accept:1:start").length > 1,
      "duplicate chunk result"
    );

    expect(ledger.filter((entry) => entry.startsWith("accept:"))).toEqual([
      "accept:0:start",
      "accept:0:end"
    ]);
    expect(errorCount(fixture.messages)).toBe(3);
    expect(fixture.messages.filter((message) => message.type === "gloss.chunk.ack")).toHaveLength(1);
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
  return createGlossPortMessage("gloss.scan.start", { scanId, pageUrl: PAGE_URL });
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
