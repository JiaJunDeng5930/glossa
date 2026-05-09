import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { KNOWN_WORD_LISTS, createKnownWordSet } from "../../src/core/lexicon";

// @verifies glossa.vocabulary.known_words The test verifies that known-word list presets load normalized filter entries.
describe("known-word lists", () => {
  it("exposes curriculum, exam and frequency filters", () => {
    expect(KNOWN_WORD_LISTS.map((list) => list.id)).toEqual([
      "junior-high",
      "senior-high",
      "cet4",
      "cet6",
      "toefl",
      "gre",
      "coca-20000"
    ]);
  });

  it("ships word-list assets for scanner filtering", async () => {
    const junior = await readWords("assets/known-wordlists/junior-high.txt");
    const senior = await readWords("assets/known-wordlists/senior-high.txt");
    const cet4 = await readWords("assets/known-wordlists/cet4.txt");
    const cet6 = await readWords("assets/known-wordlists/cet6.txt");
    const toefl = await readWords("assets/known-wordlists/toefl.txt");
    const gre = await readWords("assets/known-wordlists/gre.txt");
    const coca = await readWords("assets/known-wordlists/coca-20000.txt");

    expect(junior.size).toBeGreaterThan(1_400);
    expect(senior.size).toBeGreaterThan(2_900);
    expect(cet4.size).toBeGreaterThan(4_400);
    expect(cet6.size).toBeGreaterThan(2_100);
    expect(toefl.size).toBeGreaterThan(4_400);
    expect(gre.size).toBeGreaterThan(7_500);
    expect(coca.size).toBeGreaterThan(17_000);
    expect(junior).toContain("ability");
    expect(junior).toContain("according");
    expect(senior).toContain("abandon");
    expect(senior).toContain("abstract");
    expect(cet4).toContain("abandon");
    expect(cet6).toContain("absurd");
    expect(toefl).toContain("abduct");
    expect(gre).toContain("aberration");
    expect(coca).toContain("the");
  });

  it("normalizes custom word input", () => {
    expect(createKnownWordSet(["Ability", " abstract "])).toEqual(new Set(["ability", "abstract"]));
  });
});

async function readWords(path: string): Promise<Set<string>> {
  return new Set((await readFile(path, "utf8")).trim().split(/\s+/));
}
