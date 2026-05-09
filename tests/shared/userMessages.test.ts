import { describe, expect, it } from "vitest";

import { userMessageForError } from "../../src/shared/userMessages";

// @verifies glossa.runtime.user_messages The test verifies that diagnostic payloads map to stable Chinese user-facing copy.
describe("frontend user error messages", () => {
  it("maps AI diagnostics to UI copy", () => {
    expect(userMessageForError({ reason: "network", message: "fetch failed", service: "ai" }, "ai")).toBe("AI 服务访问失败");
    expect(userMessageForError({ reason: "invalid-response", message: "bad json", service: "ai" }, "ai")).toBe("AI 返回格式错误");
  });

  it("maps Anki diagnostics to UI copy", () => {
    expect(userMessageForError({ reason: "network", message: "fetch failed", service: "anki" }, "anki")).toBe("Anki 服务未启动或无法访问");
    expect(userMessageForError({ reason: "unauthorized", message: "HTTP 401", service: "anki" }, "anki")).toContain("AnkiConnect 拒绝了请求");
    expect(userMessageForError({ reason: "service-error", message: "model was not found: Basic", service: "anki" }, "anki")).toBe("Anki 卡片模板不存在");
    expect(userMessageForError({ reason: "service-error", message: "Anki deck was not found", service: "anki" }, "anki")).toBe("Anki 牌组不存在");
    expect(userMessageForError({ reason: "service-error", message: "deck missing", service: "anki" }, "anki")).toBe("Anki 操作失败，请检查当前牌组和卡片模板");
  });
});
