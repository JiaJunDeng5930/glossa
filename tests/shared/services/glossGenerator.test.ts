import { describe, expect, it, vi } from "vitest";

import { createDiagnosticError } from "../../../src/shared/errors";
import type { GlossFrameBackendInput } from "../../../src/shared/services/aiClient";
import type { Dictionary, DictionarySense } from "../../../src/shared/services/dictionary";
import { createGlossGenerator } from "../../../src/shared/services/glossGenerator";
import type { JevClient } from "../../../src/shared/services/jevClient";
import { DEFAULT_SETTINGS, type GlossaSettings } from "../../../src/shared/types";
import { deferred } from "../../state-model/asyncHarness";

const senses: readonly DictionarySense[] = [
  { id: "finance", definition: "银行", partOfSpeech: "n." },
  { id: "river", definition: "河岸；堤岸", partOfSpeech: "n." }
];

describe("gloss generator", () => {
  it("preserves ordinary LLM mode without reading the dictionary or using Jev", async () => {
    const fixture = createFixture();
    const input = frame(["bank"], { ...DEFAULT_SETTINGS });
    await expect(fixture.generator.glossFrame(input)).resolves.toEqual({ items: [
      { requestItemId: "request-bank", value: { targetText: "bank", display: "普通释义" } }
    ] });
    expect(fixture.ai.glossFrame).toHaveBeenCalledWith(input);
    expect(fixture.dictionary.lookup).not.toHaveBeenCalled();
    expect(fixture.jev.selectSense).not.toHaveBeenCalled();
  });

  it("sends the sentence, target occurrence and every dictionary sense to Jev and preserves the selected definition", async () => {
    const fixture = createFixture();
    const input = frame(["bank"]);
    const controller = new AbortController();
    input.signal = controller.signal;
    await expect(fixture.generator.glossFrame(input)).resolves.toEqual({ items: [
      { requestItemId: "request-bank", value: { targetText: "bank", display: "河岸；堤岸" } }
    ] });
    expect(fixture.jev.selectSense).toHaveBeenCalledWith({
      settings: input.settings.jev,
      sentence: input.items[0]!.sentence,
      word: input.items[0]!.token,
      senses,
      signal: controller.signal
    });
    expect(fixture.ai.glossFrame).not.toHaveBeenCalled();
  });

  it("returns a missing-word error without ordinary LLM fallback when disabled", async () => {
    const fixture = createFixture();
    fixture.dictionary.lookup.mockResolvedValue({ kind: "missing" });
    await expect(fixture.generator.glossFrame(frame(["invented"]))).resolves.toMatchObject({ items: [
      { requestItemId: "request-invented", error: { code: "dictionary-word-not-found", service: "dictionary" } }
    ] });
    expect(fixture.ai.glossFrame).not.toHaveBeenCalled();
    expect(fixture.jev.selectSense).not.toHaveBeenCalled();
  });

  it("falls back only for missing words and retains dictionary successes when the ordinary LLM is disconnected", async () => {
    const fixture = createFixture();
    fixture.dictionary.lookup.mockImplementation(async ({ surface }) => surface === "bank"
      ? { kind: "found", senses }
      : { kind: "missing" });
    fixture.ai.glossFrame.mockRejectedValue(createDiagnosticError("network", "Ordinary LLM disconnected", { service: "ai" }));
    const input = frame(["bank", "invented"], dictionarySettings(true));
    await expect(fixture.generator.glossFrame(input)).resolves.toMatchObject({ items: [
      { requestItemId: "request-bank", value: { targetText: "bank", display: "河岸；堤岸" } },
      { requestItemId: "request-invented", error: { reason: "network", service: "ai" } }
    ] });
    expect(fixture.ai.glossFrame).toHaveBeenCalledWith({ ...input, items: [input.items[1]] });
  });

  it.each([
    ["unknown", ["wrong-id"]],
    ["duplicate", ["request-invented", "request-invented"]],
    ["dictionary result", ["request-bank"]]
  ] as const)("isolates an invalid fallback %s ID from dictionary successes", async (_kind, returnedIds) => {
    const fixture = createFixture();
    fixture.dictionary.lookup.mockImplementation(async ({ surface }) => surface === "bank"
      ? { kind: "found", senses }
      : { kind: "missing" });
    fixture.ai.glossFrame.mockResolvedValue({ items: returnedIds.map((requestItemId) => ({
      requestItemId, value: { targetText: "invented", display: "普通释义" }
    })) });
    await expect(fixture.generator.glossFrame(frame(["bank", "invented", "unlisted"], dictionarySettings(true)))).resolves.toMatchObject({ items: [
      { requestItemId: "request-bank", value: { targetText: "bank", display: "河岸；堤岸" } },
      { requestItemId: "request-invented", error: { reason: "invalid-response", service: "ai" } },
      { requestItemId: "request-unlisted", error: { reason: "invalid-response", service: "ai" } }
    ] });
  });

  it("keeps valid fallback items when another fallback result is omitted", async () => {
    const fixture = createFixture();
    fixture.dictionary.lookup.mockImplementation(async ({ surface }) => surface === "bank"
      ? { kind: "found", senses }
      : { kind: "missing" });
    fixture.ai.glossFrame.mockResolvedValue({ items: [
      { requestItemId: "request-invented", value: { targetText: "invented", display: "普通释义" } }
    ] });
    await expect(fixture.generator.glossFrame(frame(["bank", "invented", "unlisted"], dictionarySettings(true)))).resolves.toEqual({ items: [
      { requestItemId: "request-bank", value: { targetText: "bank", display: "河岸；堤岸" } },
      { requestItemId: "request-invented", value: { targetText: "invented", display: "普通释义" } }
    ] });
  });

  it.each(["dictionary", "jev"] as const)("does not fall back after a %s service failure", async (service) => {
    const fixture = createFixture();
    const failure = createDiagnosticError("network", "Service disconnected", { service });
    if (service === "dictionary") fixture.dictionary.lookup.mockRejectedValue(failure);
    else fixture.jev.selectSense.mockRejectedValue(failure);
    await expect(fixture.generator.glossFrame(frame(["bank"], dictionarySettings(true)))).resolves.toMatchObject({ items: [
      { requestItemId: "request-bank", error: { reason: "network", service } }
    ] });
    expect(fixture.ai.glossFrame).not.toHaveBeenCalled();
  });

  it("rejects an unknown selected sense without accepting generated text or using fallback", async () => {
    const fixture = createFixture();
    fixture.jev.selectSense.mockResolvedValue({ senseId: "not-a-candidate" });
    await expect(fixture.generator.glossFrame(frame(["bank"], dictionarySettings(true)))).resolves.toMatchObject({ items: [
      { requestItemId: "request-bank", error: { reason: "invalid-response", service: "jev" } }
    ] });
    expect(fixture.ai.glossFrame).not.toHaveBeenCalled();
  });

  it("bounds classification concurrency and avoids queued requests after cancellation", async () => {
    const fixture = createFixture();
    const response = deferred<{ senseId: string }>();
    fixture.jev.selectSense.mockImplementation(() => response.promise);
    const input = frame(Array.from({ length: 12 }, (_, index) => `word${index}`));
    const controller = new AbortController();
    input.signal = controller.signal;
    const pending = fixture.generator.glossFrame(input);
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(fixture.jev.selectSense).toHaveBeenCalledTimes(4));
    controller.abort();
    response.resolve({ senseId: "river" });
    await rejected;
    expect(fixture.jev.selectSense).toHaveBeenCalledTimes(4);
    expect(fixture.ai.glossFrame).not.toHaveBeenCalled();
  });
});

function dictionarySettings(fallbackToLlm = false): GlossaSettings {
  return { ...DEFAULT_SETTINGS, translation: { mode: "dictionary-jev", fallbackToLlm } };
}

function frame(words: string[], settings = dictionarySettings()): GlossFrameBackendInput {
  return { settings, items: words.map((word) => ({
    requestItemId: `request-${word}`,
    sentence: `We walked beside the ${word}.`,
    token: { surface: word, lemma: word, startOffset: 21, endOffset: 21 + word.length }
  })) };
}

function createFixture() {
  const ai = { glossFrame: vi.fn(async (input: GlossFrameBackendInput) => ({ items: input.items.map(({ requestItemId, token }) => ({
    requestItemId, value: { targetText: token.surface, display: "普通释义" }
  })) })) };
  const dictionary = {
    id: "test-dictionary", version: "v1",
    lookup: vi.fn<Dictionary["lookup"]>(async () => ({ kind: "found", senses }))
  };
  const jev = { selectSense: vi.fn<JevClient["selectSense"]>(async () => ({ senseId: "river" })) };
  return { ai, dictionary, jev, generator: createGlossGenerator({ ai, dictionary, jev }) };
}
