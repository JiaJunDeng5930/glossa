import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { KNOWN_WORD_LISTS, createKnownWordSet } from "../../src/core/lexicon";

describe("known-word lists", () => {
  it("exposes junior and senior curriculum filters", () => {
    expect(KNOWN_WORD_LISTS.map((list) => list.id)).toEqual(["junior-high", "senior-high"]);
  });

  it("ships curriculum word-list assets for scanner filtering", async () => {
    const junior = await readWords("assets/known-wordlists/junior-high.txt");
    const senior = await readWords("assets/known-wordlists/senior-high.txt");

    expect(junior.size).toBeGreaterThan(1_400);
    expect(senior.size).toBeGreaterThan(2_900);
    expect(junior).toContain("ability");
    expect(junior).toContain("according");
    expect(senior).toContain("abandon");
    expect(senior).toContain("abstract");
  });

  it("normalizes custom word input", () => {
    expect(createKnownWordSet(["Ability", " abstract "])).toEqual(new Set(["ability", "abstract"]));
  });
});

async function readWords(path: string): Promise<Set<string>> {
  return new Set((await readFile(path, "utf8")).trim().split(/\s+/));
}
