import { describe, expect, it } from "vitest";

import { sanitizeTraceEvent } from "../../src/shared/diagnostics";
import { createBackgroundResponse, createContentMessage, validateBackgroundResponse, validateContentMessage } from "../../src/shared/messages";

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
    const request = createContentMessage("gloss.request", {
      pageUrl: "https://example.test/path?token=secret",
      sentences: []
    });
    const response = createBackgroundResponse(request, "gloss.response", { items: [] });

    expect(validateBackgroundResponse(response, request)).toMatchObject({
      type: "gloss.response",
      requestId: request.requestId,
      source: "service-worker",
      target: "content-script",
      payload: { items: [] }
    });
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
