import { SETTINGS_RULES, SettingsValidationError, type SettingsNumberRule } from "../shared/settings";

interface FieldFeedback {
  control: string;
  message: string;
}

const numberFeedback = (control: string, label: string, rule: SettingsNumberRule, units = 1): FieldFeedback => ({
  control,
  message: `${label}：请输入${rule.exclusiveMinimum ? "大于" : "不小于"} ${rule.minimum / units}${Number.isFinite(rule.maximum) ? ` 且不大于 ${rule.maximum / units}` : ""} 的数字。`
});

const fields: Record<string, FieldFeedback> = {
  "ai.endpoint": { control: "aiEndpoint", message: "AI 地址：请输入完整的 http:// 或 https:// 地址。" },
  "anki.endpoint": { control: "ankiEndpoint", message: "Anki 地址：请输入完整的 http:// 或 https:// 地址。" },
  "jev.endpoint": { control: "jevEndpoint", message: "Jev 地址：请输入完整的 http:// 或 https:// 地址。" },
  learningWindowDays: numberFeedback("learningWindowDays", "加入 Anki 后继续显示释义（天）", SETTINGS_RULES.learningWindowDays),
  glossCacheTtlMs: numberFeedback("glossCacheTtlHours", "中文释义缓存有效期（小时）", SETTINGS_RULES.glossCacheTtlMs, 3_600_000),
  "appearance.backgroundOpacity": numberFeedback("glossBackgroundOpacity", "背景不透明度", SETTINGS_RULES.appearance.backgroundOpacity),
  "appearance.fontSize": numberFeedback("glossFontSize", "字号", SETTINGS_RULES.appearance.fontSize),
  "ai.requestTimeoutMs": numberFeedback("aiRequestTimeoutSeconds", "AI 请求超时（秒）", SETTINGS_RULES.ai.requestTimeoutMs, 1_000),
  "anki.requestTimeoutMs": numberFeedback("ankiRequestTimeoutSeconds", "Anki 请求超时（秒）", SETTINGS_RULES.anki.requestTimeoutMs, 1_000),
  "jev.requestTimeoutMs": numberFeedback("jevRequestTimeoutSeconds", "Jev 请求超时（秒）", SETTINGS_RULES.jev.requestTimeoutMs, 1_000),
  "anki.duplicatePromptMs": numberFeedback("duplicatePromptSeconds", "重复加入提示时长（秒）", SETTINGS_RULES.anki.duplicatePromptMs, 1_000)
};

export function settingsFieldFeedback(error: unknown): FieldFeedback | undefined {
  return error instanceof SettingsValidationError ? fields[error.field] : undefined;
}
