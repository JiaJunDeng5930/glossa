import type { KnownWordListId } from "../shared/types";
import { normalizeLemma } from "./state";

export const KNOWN_WORD_LISTS = [
  {
    id: "junior-high",
    label: "Junior high curriculum words",
    file: "assets/known-wordlists/junior-high.txt"
  },
  {
    id: "senior-high",
    label: "Senior high curriculum words",
    file: "assets/known-wordlists/senior-high.txt"
  }
] as const satisfies readonly { id: KnownWordListId; label: string; file: string }[];

const FALLBACK_KNOWN_WORDS = [
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "that",
  "the",
  "this",
  "to",
  "with"
];

export function createKnownWordSet(words: Iterable<string> = FALLBACK_KNOWN_WORDS): Set<string> {
  return new Set(Array.from(words, normalizeLemma));
}

export function isKnownLemma(known: ReadonlySet<string>, value: string): boolean {
  return known.has(normalizeLemma(value));
}

export async function loadKnownWords(listId: KnownWordListId): Promise<Set<string>> {
  const runtime = globalThis.chrome?.runtime;
  if (runtime?.getURL) {
    try {
      const list = KNOWN_WORD_LISTS.find((item) => item.id === listId) ?? KNOWN_WORD_LISTS[0];
      const response = await fetch(runtime.getURL(list.file));
      if (response.ok) {
        const text = await response.text();
        return createKnownWordSet(text.split(/\s+/).filter(Boolean));
      }
    } catch {
      return createKnownWordSet();
    }
  }
  return createKnownWordSet();
}
