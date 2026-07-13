import { describe, expect, it } from "vitest";

import { sanitizeTraceEvent } from "../../src/shared/diagnostics";
import {
  createBackgroundResponse,
  createContentMessage,
  createGlossPortMessage,
  createOptionsMessage,
  validateBackgroundResponse,
  validateContentMessage,
  validateGlossPortInbound,
  validateGlossPortOutbound,
  validateRuntimeMessage
} from "../../src/shared/messages";
import { DEFAULT_SETTINGS } from "../../src/shared/types";

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

  it("creates and validates options-to-background cache clear messages", () => {
    const message = createOptionsMessage("gloss.cache.clear", {});

    expect(validateRuntimeMessage(message)).toMatchObject({
      type: "gloss.cache.clear",
      version: 1,
      requestId: message.requestId,
      source: "options",
      target: "service-worker",
      payload: {}
    });
  });

  it("validates iframe translation-state synchronization", () => {
    // @verifies glossa.extension_contracts.frame_state_sync
    const request = createContentMessage("translation.state.sync", {});
    const response = createBackgroundResponse(request, "translation.state.response", { enabled: true });

    expect(validateRuntimeMessage(request)).toMatchObject({
      type: "translation.state.sync",
      source: "content-script",
      target: "service-worker",
      payload: {}
    });
    expect(validateBackgroundResponse(response, request)).toMatchObject({
      type: "translation.state.response",
      source: "service-worker",
      target: "content-script",
      payload: { enabled: true }
    });
  });

  it("validates card-history reset requests and responses", () => {
    const request = createOptionsMessage("card.history.reset", {});
    const response = createBackgroundResponse(request, "card.history.reset.ok", {});

    expect(validateRuntimeMessage(request)).toMatchObject({
      type: "card.history.reset",
      source: "options",
      target: "service-worker",
      payload: {}
    });
    expect(validateBackgroundResponse(response, request)).toMatchObject({
      type: "card.history.reset.ok",
      requestId: request.requestId,
      source: "service-worker",
      target: "options",
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
        glossCacheTtlMs: DEFAULT_SETTINGS.glossCacheTtlMs,
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

  it("preserves the request id on cache clear responses", () => {
    const request = createOptionsMessage("gloss.cache.clear", {});
    const response = createBackgroundResponse(request, "gloss.cache.cleared", {});

    expect(validateBackgroundResponse(response, request)).toMatchObject({
      type: "gloss.cache.cleared",
      requestId: request.requestId,
      source: "service-worker",
      target: "options",
      payload: {}
    });
  });

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

  it("rejects malformed nested word-click token fields", () => {
    const message = createContentMessage("word.clicked", {
      pageUrl: "https://example.test",
      sentence: "Create archive card.",
      token: { id: "t1", sentenceId: "s1", surface: "archive", lemma: "archive", startOffset: 7, endOffset: 14 }
    });
    const malformed = {
      ...message,
      payload: {
        ...message.payload,
        token: { ...message.payload.token, startOffset: "7" }
      }
    };

    expect(() => validateContentMessage(malformed)).toThrow("Malformed word.clicked payload");
  });

  it("validates chunked gloss scan port messages", () => {
    const start = createGlossPortMessage("gloss.scan.start", {
      scanId: "scan-1",
      pageUrl: "https://example.test/path",
      scanConfigHash: "config-1"
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
    expect(() => validateGlossPortInbound({
      ...start,
      payload: { scanId: "scan-1", pageUrl: "https://example.test/path" }
    })).toThrow("Malformed gloss.scan.start payload");
  });

  it("rejects malformed nested gloss scan chunk sentence fields", () => {
    const message = createGlossPortMessage("gloss.scan.chunk", {
      scanId: "scan-1",
      chunkId: "scan-1:0",
      chunkIndex: 0,
      pageUrl: "https://example.test/path",
      sentences: [
        {
          id: "s1",
          text: "Create archive card.",
          tokens: [{ id: "t1", sentenceId: "s1", surface: "archive", lemma: "archive", startOffset: 7, endOffset: 14 }]
        }
      ]
    });
    const malformed = {
      ...message,
      payload: {
        ...message.payload,
        sentences: [
          {
            id: "s1",
            text: "Create archive card.",
            tokens: [{ id: "t1", sentenceId: "s1", surface: "archive", lemma: 42, startOffset: 7, endOffset: 14 }]
          }
        ]
      }
    };

    expect(() => validateGlossPortInbound(malformed)).toThrow("Malformed gloss.scan.chunk payload");
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

  it("rejects malformed nested ready gloss token items", () => {
    const message = createGlossPortMessage("gloss.token", {
      scanId: "scan-1",
      tokenId: "t1",
      status: "ready",
      item: { tokenId: "t1", targetText: "submit", display: "提交" }
    });
    const malformed = {
      ...message,
      payload: {
        ...message.payload,
        item: { tokenId: "t1", targetText: "submit", display: 42 }
      }
    };

    expect(() => validateGlossPortOutbound(malformed, "scan-1")).toThrow("Malformed gloss.token payload");
  });

  it("rejects malformed nested background response fields", () => {
    const settingsRequest = createContentMessage("settings.get", {});
    const settingsResponse = createBackgroundResponse(settingsRequest, "settings.response", { settings: DEFAULT_SETTINGS });
    const malformedSettingsResponse = {
      ...settingsResponse,
      payload: {
        settings: {
          ...DEFAULT_SETTINGS,
          appearance: { ...DEFAULT_SETTINGS.appearance, fontSize: "11" }
        }
      }
    };
    const clickRequest = createContentMessage("word.clicked", {
      pageUrl: "https://example.test",
      sentence: "Create archive card.",
      token: { id: "t1", sentenceId: "s1", surface: "archive", lemma: "archive", startOffset: 7, endOffset: 14 }
    });
    const clickResponse = createBackgroundResponse(clickRequest, "word.clicked.ok", { noteId: 123 });
    const malformedClickResponse = {
      ...clickResponse,
      payload: { noteId: "123" }
    };

    expect(() => validateBackgroundResponse(malformedSettingsResponse, settingsRequest)).toThrow("Malformed settings.response payload");
    expect(() => validateBackgroundResponse(malformedClickResponse, clickRequest)).toThrow("Malformed word.clicked.ok payload");
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
