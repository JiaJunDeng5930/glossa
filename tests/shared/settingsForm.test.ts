import { describe, expect, it } from "vitest";
import { applySettingsFormConstraints, applyTranslationFields, applyProviderChange, applyProviderFields, populateProviderSelect, populateReasoningEffortSelect, readSettingsForm, writeSettingsForm } from "../../src/shared/settingsForm";
import { defaultEndpointForProvider, normalizeSettings, SETTINGS_RULES } from "../../src/shared/settings";

describe("settings form numeric constraints", () => {
  function createForm(): HTMLFormElement {
    const form = document.createElement("form");
    form.innerHTML = `
      <input name="learningWindowDays" type="number" min="1" step="1">
      <input name="glossCacheTtlHours" type="number" min="1" step="1">
      <input name="glossBackgroundOpacity" type="range" min="0.2" max="1" step="0.05">
      <input name="glossFontSize" type="number" min="9" max="24" step="1">
      <input name="aiRequestTimeoutSeconds" type="number" min="1" step="1">
      <input name="ankiRequestTimeoutSeconds" type="number" min="1" step="1">
      <input name="duplicatePromptSeconds" type="number" min="1" step="1">`;
    return form;
  }

  it("round-trips fractional domain values without imposing integer input steps", () => {
    const form = createForm();
    const settings = normalizeSettings({
      learningWindowDays: 1.5,
      glossCacheTtlMs: 1_800_000,
      appearance: { backgroundOpacity: 0.94, fontSize: 12.5 },
      ai: { requestTimeoutMs: 1500 },
      anki: { requestTimeoutMs: 2500, duplicatePromptMs: 3500 }
    });
    writeSettingsForm(form, settings);
    expect(readSettingsForm(form, settings)).toEqual(settings);
    expect(Array.from(form.querySelectorAll("input")).every(input => input.step === "any" && input.checkValidity())).toBe(true);
  });

  it("derives ranges and unit conversions from the same field rules", () => {
    const form = createForm();
    writeSettingsForm(form, normalizeSettings({}));
    applySettingsFormConstraints(form);
    const input = (name: string) => form.elements.namedItem(name) as HTMLInputElement;
    expect(input("glossFontSize").min).toBe(String(SETTINGS_RULES.appearance.fontSize.minimum));
    expect(input("glossFontSize").max).toBe(String(SETTINGS_RULES.appearance.fontSize.maximum));
    expect(input("aiRequestTimeoutSeconds").min).toBe(String(SETTINGS_RULES.ai.requestTimeoutMs.minimum / 1000));
    input("glossCacheTtlHours").value = "0";
    expect(() => readSettingsForm(form)).toThrow("glossCacheTtlMs");
  });
});


describe("settings form provider choices", () => {
  it("renders provider capabilities and keeps custom endpoints on provider changes", () => {
    const form = document.createElement("form");
    form.innerHTML = `<select name="provider"></select><select name="reasoningEffort"></select>
      <input name="aiEndpoint"><label data-ai-field="api-key"></label><label data-ai-field="reasoning"></label>`;
    const provider = form.elements.namedItem("provider") as HTMLSelectElement;
    const reasoning = form.elements.namedItem("reasoningEffort") as HTMLSelectElement;
    const endpoint = form.elements.namedItem("aiEndpoint") as HTMLInputElement;
    populateProviderSelect(provider);
    populateReasoningEffortSelect(reasoning);
    writeSettingsForm(form, normalizeSettings({}));
    expect(provider.selectedOptions[0]?.textContent).toBe("OpenAI Responses API");
    expect(reasoning.selectedOptions[0]?.textContent).toBe("中");
    applyProviderChange(form, "openai-responses", "openai-completions");
    expect(endpoint.value).toBe(defaultEndpointForProvider("openai-completions"));
    expect(form.querySelector<HTMLElement>('[data-ai-field="reasoning"]')!.hidden).toBe(true);
    endpoint.value = "https://custom.test/service";
    applyProviderChange(form, "openai-completions", "glossa-backend");
    expect(endpoint.value).toBe("https://custom.test/service");
    expect(form.querySelector<HTMLElement>('[data-ai-field="api-key"]')!.hidden).toBe(true);
    expect(form.querySelector<HTMLElement>('[data-ai-field="reasoning"]')!.hidden).toBe(false);
    applyProviderFields(form, "openai-responses");
    expect(form.querySelector<HTMLElement>('[data-ai-field="api-key"]')!.hidden).toBe(false);
  });
});

describe("settings form dynamic Anki choices", () => {
  it("keeps catalog choices and represents an Anki value outside the catalog", () => {
    const form = document.createElement("form");
    form.innerHTML = `
      <select name="ankiDeck"><option value="Catalog deck">Catalog deck</option></select>
      <select name="ankiModelName"><option value="Catalog model">Catalog model</option></select>`;
    const settings = normalizeSettings({ anki: { deck: "External deck", modelName: "External model" } });

    writeSettingsForm(form, settings);

    const values = (name: string) => Array.from((form.elements.namedItem(name) as HTMLSelectElement).options, option => option.value);
    expect(values("ankiDeck")).toEqual(["Catalog deck", "External deck"]);
    expect(values("ankiModelName")).toEqual(["Catalog model", "External model"]);
    expect((form.elements.namedItem("ankiDeck") as HTMLSelectElement).value).toBe("External deck");
    expect((form.elements.namedItem("ankiModelName") as HTMLSelectElement).value).toBe("External model");
  });

  it("creates a visible value when no Anki catalog has loaded", () => {
    const form = document.createElement("form");
    form.innerHTML = `<select name="ankiDeck"></select><select name="ankiModelName"></select>`;
    const settings = normalizeSettings({ anki: { deck: "External deck", modelName: "External model" } });

    writeSettingsForm(form, settings);

    expect((form.elements.namedItem("ankiDeck") as HTMLSelectElement).value).toBe("External deck");
    expect((form.elements.namedItem("ankiModelName") as HTMLSelectElement).value).toBe("External model");
  });
});


describe("dictionary and Jev settings form", () => {
  it("preserves service settings when their controls are absent", () => {
    const form = document.createElement("form");
    form.innerHTML = '<input name="learningWindowDays" value="5">';
    const base = normalizeSettings({ translation: { mode: "dictionary-jev", fallbackToLlm: true }, jev: { apiKey: "test-key", model: "custom-jev" } });
    expect(readSettingsForm(form, base)).toEqual({ ...base, learningWindowDays: 5 });
  });

  it("round-trips the selected mode and allows independently clearing the Jev key", () => {
    const form = document.createElement("form");
    form.innerHTML = `<select name="translationMode"><option value="llm">LLM</option><option value="dictionary-jev">Jev</option></select>
      <input name="fallbackToLlm" type="checkbox"><input name="jevEndpoint"><input name="jevApiKey">
      <input name="jevModel"><input name="jevRequestTimeoutSeconds" type="number">
      <div data-dictionary-settings></div><div data-onboarding-llm-settings></div>`;
    const base = normalizeSettings({ translation: { mode: "dictionary-jev" }, jev: { apiKey: "test-key", requestTimeoutMs: 1500 }, ai: { apiKey: "ordinary-key" } });
    writeSettingsForm(form, base);
    expect(readSettingsForm(form, base)).toEqual(base);
    expect(form.querySelector<HTMLElement>("[data-dictionary-settings]")!.hidden).toBe(false);
    expect(form.querySelector<HTMLElement>("[data-onboarding-llm-settings]")!.hidden).toBe(true);
    (form.elements.namedItem("jevApiKey") as HTMLInputElement).value = "";
    (form.elements.namedItem("fallbackToLlm") as HTMLInputElement).checked = true;
    const updated = readSettingsForm(form, base);
    expect(updated.jev.apiKey).toBeUndefined();
    expect(updated.ai.apiKey).toBe("ordinary-key");
    applyTranslationFields(form, updated);
    expect(form.querySelector<HTMLElement>("[data-onboarding-llm-settings]")!.hidden).toBe(false);
  });
});
