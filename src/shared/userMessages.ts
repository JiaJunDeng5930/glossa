import type { ErrorPayload, ErrorService } from "./types";

export function userMessageForError(error: ErrorPayload | undefined, fallbackService: ErrorService): string {
  const service = error?.service ?? fallbackService;
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
    return "AI 服务访问失败";
  }
  if (error.reason === "network") {
    return "AI 服务访问失败";
  }
  if (error.reason === "timeout") {
    return "AI 服务请求超时";
  }
  if (error.reason === "unauthorized") {
    return "AI 拒绝了请求，请检查 API 密钥或访问权限。";
  }
  if (error.reason === "not-found") {
    return "AI 接口地址错误";
  }
  if (error.reason === "invalid-response") {
    return "AI 返回格式错误";
  }
  return "AI 服务返回错误";
}

function ankiMessage(error: ErrorPayload | undefined): string {
  if (!error) {
    return "Anki 服务未启动或无法访问";
  }
  if (error.reason === "network") {
    return "Anki 服务未启动或无法访问";
  }
  if (error.reason === "timeout") {
    return "Anki 服务请求超时";
  }
  if (error.reason === "unauthorized") {
    return "AnkiConnect 拒绝了请求，请检查访问权限。";
  }
  if (error.reason === "not-found") {
    return "AnkiConnect 接口地址错误";
  }
  if (error.reason === "invalid-response") {
    return "Anki 服务返回格式错误";
  }
  return "Anki 服务返回错误";
}

function runtimeMessage(error: ErrorPayload | undefined): string {
  if (error?.reason === "timeout") {
    return "扩展请求超时";
  }
  return "扩展运行时错误";
}
