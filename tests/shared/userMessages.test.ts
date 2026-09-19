import { describe, expect, it } from "vitest";

import { userMessageForError } from "../../src/shared/userMessages";

describe("frontend user error messages", () => {
  it("maps AI diagnostics to UI copy", () => {
    expect(userMessageForError({ reason: "network", message: "fetch failed", service: "ai" }, "ai")).toBe("无法连接 AI 服务，请检查网络和接口地址。");
    expect(userMessageForError({ reason: "invalid-response", message: "bad json", service: "ai" }, "ai")).toBe("无法读取 AI 返回的内容，请检查接口和模型设置。");
  });

  it("maps dictionary and Jev diagnostics without displaying transport text", () => {
    expect(userMessageForError({ reason: "not-found", code: "dictionary-word-not-found", message: "internal dictionary lookup", service: "dictionary" }, "ai")).toBe("词典中没有这个词的释义");
    expect(userMessageForError({ reason: "unauthorized", message: "HTTP 401", service: "jev" }, "ai")).toBe("Jev 拒绝了请求，请检查 API Key 和访问权限。");
  });

  it("maps Anki diagnostics to UI copy", () => {
    expect(userMessageForError({ reason: "network", message: "fetch failed", service: "anki" }, "anki")).toBe("无法连接 Anki，请确认 Anki 已打开且已安装 AnkiConnect。");
    expect(userMessageForError({ reason: "unauthorized", message: "HTTP 401", service: "anki" }, "anki")).toContain("AnkiConnect 拒绝了请求");
    expect(userMessageForError({ reason: "service-error", message: "model was not found: Basic", code: "anki-model-not-found", service: "anki" }, "anki")).toBe("找不到所选 Anki 卡片模板，请在设置中刷新并重新选择。");
    expect(userMessageForError({ reason: "service-error", message: "Anki deck was not found", code: "anki-deck-not-found", service: "anki" }, "anki")).toBe("找不到所选 Anki 牌组，请在设置中刷新并重新选择。");
    expect(userMessageForError({ reason: "service-error", message: "deck missing", service: "anki" }, "anki")).toBe("Anki 操作失败，请检查所选牌组和卡片模板。");
  });
});
