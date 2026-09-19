import type { ErrorPayload, ErrorService } from "./types";

export function userMessageForError(error: ErrorPayload | undefined, fallbackService: ErrorService): string {
  const service = error?.service ?? fallbackService;
  if (service === "dictionary") {
    return error?.code === "dictionary-word-not-found" ? "词典中没有这个词的释义" : "词典读取失败";
  }
  if (service === "jev") {
    return jevMessage(error);
  }
  if (service === "anki") {
    return ankiMessage(error);
  }
  if (service === "ai") {
    return aiMessage(error);
  }
  return runtimeMessage(error);
}

function aiMessage(error: ErrorPayload | undefined): string {
  if (!error) {
    return "无法连接 AI 服务，请检查网络和接口地址。";
  }
  if (error.reason === "network") {
    return "无法连接 AI 服务，请检查网络和接口地址。";
  }
  if (error.reason === "timeout") {
    return "等待 AI 回复超时，请检查服务是否可用。";
  }
  if (error.reason === "unauthorized") {
    return "AI 服务拒绝了请求，请检查 API Key 和访问权限。";
  }
  if (error.reason === "not-found") {
    return "找不到 AI 接口，请检查接口地址。";
  }
  if (error.reason === "invalid-response") {
    return "无法读取 AI 返回的内容，请检查接口和模型设置。";
  }
  return "AI 服务处理请求失败，请检查服务状态。";
}

function ankiMessage(error: ErrorPayload | undefined): string {
  if (!error) {
    return "无法连接 Anki，请确认 Anki 已打开且已安装 AnkiConnect。";
  }
  if (error.reason === "network") {
    return "无法连接 Anki，请确认 Anki 已打开且已安装 AnkiConnect。";
  }
  if (error.reason === "timeout") {
    return "等待 Anki 回复超时，请检查 Anki 是否正常运行。";
  }
  if (error.reason === "outcome-unknown") {
    return "无法确认卡片是否已加入，请先到 Anki 中查看，再决定是否重试。";
  }
  if (error.reason === "unauthorized") {
    return "AnkiConnect 拒绝了请求，请检查访问权限。";
  }
  if (error.reason === "not-found") {
    return "找不到 AnkiConnect 接口，请检查接口地址。";
  }
  if (error.reason === "invalid-response") {
    return "无法读取 AnkiConnect 返回的内容，请检查接口地址和 AnkiConnect 是否安装正常。";
  }
  if (error.reason === "service-error") {
    return ankiServiceMessage(error.code);
  }
  return "Anki 操作失败，请检查所选牌组和卡片模板。";
}

function runtimeMessage(error: ErrorPayload | undefined): string {
  if (error?.reason === "timeout") {
    return "扩展没有及时响应，请重新打开扩展或刷新页面。";
  }
  return "扩展暂时无法处理请求，请重新打开扩展或刷新页面。";
}

function ankiServiceMessage(code: ErrorPayload["code"]): string {
  if (code === "anki-model-not-found") {
    return "找不到所选 Anki 卡片模板，请在设置中刷新并重新选择。";
  }
  if (code === "anki-deck-not-found") {
    return "找不到所选 Anki 牌组，请在设置中刷新并重新选择。";
  }
  if (code === "anki-no-compatible-model") {
    return "Anki 没有包含 Front 和 Back 字段的卡片模板，请添加后刷新。";
  }
  if (code === "anki-empty-card") {
    return "生成的卡片内容为空，请检查 AI 设置和 Anki 卡片提示词。";
  }
  return "Anki 操作失败，请检查所选牌组和卡片模板。";
}

function jevMessage(error: ErrorPayload | undefined): string {
  if (!error || error.reason === "network") return "无法连接 Jev，请检查网络和接口地址。";
  if (error.reason === "timeout") return "等待 Jev 回复超时，请检查服务是否可用。";
  if (error.reason === "unauthorized") return "Jev 拒绝了请求，请检查 API Key 和访问权限。";
  if (error.reason === "not-found") return "找不到 Jev 接口，请检查接口地址。";
  if (error.reason === "invalid-response") return "无法读取 Jev 返回的内容，请检查接口和模型设置。";
  return "Jev 处理请求失败，请检查服务状态。";
}
