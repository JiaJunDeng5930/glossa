import { normalizeLemma } from "./state";

const BUILTIN_KNOWN_WORDS = [
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

export function createKnownWordSet(words: Iterable<string> = BUILTIN_KNOWN_WORDS): Set<string> {
  return new Set(Array.from(words, normalizeLemma));
}

export function isKnownLemma(known: ReadonlySet<string>, value: string): boolean {
  return known.has(normalizeLemma(value));
}

export async function loadDefaultKnownWords(): Promise<Set<string>> {
  const runtime = globalThis.chrome?.runtime;
  if (runtime?.getURL) {
    try {
      const response = await fetch(runtime.getURL("assets/default-known.txt"));
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
