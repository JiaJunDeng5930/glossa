// @behavior glossa.core.lexicon The lexicon module loads configured known-word lists and normalizes entries for filtering.
import type { KnownWordListId } from "../shared/types";
import { normalizeLemma } from "./state";

export const KNOWN_WORD_LISTS = [
  {
    id: "junior-high",
    label: "初中课标词汇",
    file: "assets/known-wordlists/junior-high.txt"
  },
  {
    id: "senior-high",
    label: "高中课标词汇",
    file: "assets/known-wordlists/senior-high.txt"
  },
  {
    id: "cet4",
    label: "四级 4535 词",
    file: "assets/known-wordlists/cet4.txt"
  },
  {
    id: "cet6",
    label: "六级 2219 词",
    file: "assets/known-wordlists/cet6.txt"
  },
  {
    id: "toefl",
    label: "托福 4510 词",
    file: "assets/known-wordlists/toefl.txt"
  },
  {
    id: "gre",
    label: "GRE 7728 词",
    file: "assets/known-wordlists/gre.txt"
  },
  {
    id: "coca-20000",
    label: "COCA 20000 高频词",
    file: "assets/known-wordlists/coca-20000.txt"
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
