import { describe, expect, it } from "vitest";

import { sanitizeTraceEvent } from "../../src/shared/diagnostics";
import {
  createBackgroundResponse,
  createContentMessage,
  createGlossPortMessage,
  validateBackgroundResponse,
  validateContentMessage,
  validateGlossPortInbound,
  validateGlossPortOutbound
} from "../../src/shared/messages";
import { DEFAULT_SETTINGS } from "../../src/shared/types";

// @verifies glossa.extension_contracts.message_envelopes
describe("extension message envelopes", () => {
  it("creates and validates content-to-background messages with request ids", () => {
    const message = createContentMessage("settings.get", {});

    expect(validateContentMessage(message)).toMatchObject({
      type: "settings.get",
      version: 1,
      requestId: message.requestId,
      source: "content-script",
      target: "service-worker",
      payload: {}
    });
  });

  it("preserves the request id on background responses", () => {
    const request = createContentMessage("settings.get", {});
    const response = createBackgroundResponse(request, "settings.response", {
      settings: {
        shortcutKey: "Alt",
        translateShortcutKey: "Alt+G",
        autoTranslateEnabled: false,
        learningWindowDays: 3,
        knownWordList: "junior-high",
        promptVersion: "gloss-v1",
        modelVersion: "gpt-4.1-mini",
        appearance: {
          textColor: "#ffffff",
          backgroundColor: "#0f172a",
          cardSuccessBackgroundColor: "#16a34a",
          cardErrorBackgroundColor: "#dc2626",
          backgroundOpacity: 0.9,
          fontFamily: "system-ui",
          fontSize: 11
        },
        prompts: { gloss: "gloss", ankiCard: "card" },
        ai: { ...DEFAULT_SETTINGS.ai, provider: "glossa-backend", endpoint: "https://example.test", reasoningEffort: "medium" },
        anki: { ...DEFAULT_SETTINGS.anki, endpoint: "http://127.0.0.1:8765", deck: "Glossa", modelName: "Basic" }
      }
    });

    expect(validateBackgroundResponse(response, request)).toMatchObject({
      type: "settings.response",
      requestId: request.requestId,
      source: "service-worker",
      target: "content-script",
      payload: expect.objectContaining({ settings: expect.objectContaining({ shortcutKey: "Alt" }) })
    });
  });

  // @verifies glossa.card_creation.duplicate_gate.message_type
  // @verifies glossa.extension_contracts.payload_consistency.duplicate_response
  it("validates duplicate-card background responses", () => {
    const request = createContentMessage("word.clicked", {
      pageUrl: "https://example.test",
      sentence: "Create archive card.",
      token: { id: "t1", sentenceId: "s1", surface: "archive", lemma: "archive", startOffset: 7, endOffset: 14 }
    });
    const response = createBackgroundResponse(request, "word.card.duplicate", {
      lang: "en",
      lemma: "archive",
      surface: "archive",
      promptMs: 5_000
    });

    expect(validateBackgroundResponse(response, request)).toMatchObject({
      type: "word.card.duplicate",
      requestId: request.requestId,
      payload: { lang: "en", lemma: "archive", surface: "archive", promptMs: 5_000 }
    });
  });

  it("validates gloss scan port messages", () => {
    const message = createGlossPortMessage("gloss.scan", {
      scanId: "scan-1",
      pageUrl: "https://example.test/path",
      sentences: []
    });

    expect(validateGlossPortInbound(message)).toMatchObject({
      type: "gloss.scan",
      version: 1,
      payload: { scanId: "scan-1", pageUrl: "https://example.test/path", sentences: [] }
    });
  });

  it("validates chunked gloss scan port messages", () => {
    const start = createGlossPortMessage("gloss.scan.start", {
      scanId: "scan-1",
      pageUrl: "https://example.test/path"
    });
    const chunk = createGlossPortMessage("gloss.scan.chunk", {
      scanId: "scan-1",
      chunkId: "scan-1:0",
      chunkIndex: 0,
      pageUrl: "https://example.test/path",
      sentences: []
    });
    const end = createGlossPortMessage("gloss.scan.end", { scanId: "scan-1" });
    const ack = createGlossPortMessage("gloss.chunk.ack", {
      scanId: "scan-1",
      chunkId: "scan-1:0",
      acceptedTokens: 2
    });

    expect(validateGlossPortInbound(start)).toMatchObject({ type: "gloss.scan.start" });
    expect(validateGlossPortInbound(chunk)).toMatchObject({ type: "gloss.scan.chunk", payload: { chunkIndex: 0 } });
    expect(validateGlossPortInbound(end)).toMatchObject({ type: "gloss.scan.end" });
    expect(validateGlossPortOutbound(ack, "scan-1")).toMatchObject({ type: "gloss.chunk.ack", payload: { acceptedTokens: 2 } });
  });

  it("validates gloss token, done and error port messages", () => {
    const token = createGlossPortMessage("gloss.token", {
      scanId: "scan-1",
      tokenId: "t1",
      status: "ready",
      item: { tokenId: "t1", targetText: "submit", display: "提交" }
    });
    const done = createGlossPortMessage("gloss.done", { scanId: "scan-1" });
    const errorPayload = { reason: "service-error" as const, message: "failed", service: "ai" as const };
    const error = createGlossPortMessage("gloss.error", { scanId: "scan-1", ...errorPayload });

    expect(validateGlossPortOutbound(token, "scan-1")).toMatchObject({ type: "gloss.token", payload: { status: "ready" } });
    expect(validateGlossPortOutbound(done, "scan-1")).toMatchObject({ type: "gloss.done" });
    expect(validateGlossPortOutbound(error, "scan-1")).toMatchObject({ type: "gloss.error", payload: errorPayload });
  });

  it("rejects malformed diagnostic error payloads", () => {
    const request = createContentMessage("settings.get", {});
    const response = createBackgroundResponse(request, "error", {
      reason: "service-error",
      message: "failed",
      service: "ai"
    });

    expect(validateBackgroundResponse(response, request)).toMatchObject({
      type: "error",
      payload: { reason: "service-error", message: "failed", service: "ai" }
    });
    expect(() => validateBackgroundResponse({ ...response, payload: { message: "failed" } }, request)).toThrow("Malformed error payload");
  });

  it("rejects malformed message routes", () => {
    const message = {
      ...createContentMessage("settings.get", {}),
      source: "options"
    };

    expect(() => validateContentMessage(message)).toThrow("Unexpected message route");
  });
});

// @verifies glossa.failure_reporting.trace_privacy
describe("diagnostic trace sanitization", () => {
  it("removes query strings and fragments from trace URLs", () => {
    const event = sanitizeTraceEvent({
      component: "content-script",
      operation: "content.scan",
      result: "ok",
      url: "https://example.test/path?q=secret#section"
    });

    expect(event.url).toBe("https://example.test/path");
  });
});
