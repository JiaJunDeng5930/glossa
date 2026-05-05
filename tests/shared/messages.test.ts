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
          backgroundOpacity: 0.9,
          fontFamily: "system-ui",
          fontSize: 11
        },
        prompts: { gloss: "gloss", ankiCard: "card" },
        ai: { provider: "glossa-backend", endpoint: "https://example.test", reasoningEffort: "medium" },
        anki: { endpoint: "http://127.0.0.1:8765", deck: "Glossa" }
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

  it("validates gloss token, done and error port messages", () => {
    const token = createGlossPortMessage("gloss.token", {
      scanId: "scan-1",
      tokenId: "t1",
      status: "ready",
      item: { tokenId: "t1", targetText: "submit", display: "提交" }
    });
    const done = createGlossPortMessage("gloss.done", { scanId: "scan-1" });
    const error = createGlossPortMessage("gloss.error", { scanId: "scan-1", message: "failed" });

    expect(validateGlossPortOutbound(token, "scan-1")).toMatchObject({ type: "gloss.token", payload: { status: "ready" } });
    expect(validateGlossPortOutbound(done, "scan-1")).toMatchObject({ type: "gloss.done" });
    expect(validateGlossPortOutbound(error, "scan-1")).toMatchObject({ type: "gloss.error", payload: { message: "failed" } });
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
