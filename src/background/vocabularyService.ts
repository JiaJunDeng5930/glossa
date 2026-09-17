import { normalizeLemma } from "../core/state";
import { createDiagnosticError } from "../shared/errors";
import type { ExtensionStorage } from "../storage/db";

export function createVocabularyService(storage: ExtensionStorage) {
  const lemmaFrom = (value: string): string => {
    const lemma = normalizeLemma(value);
    if (!lemma) throw createDiagnosticError("runtime", "Known word lemma must not be empty", { service: "runtime" });
    return lemma;
  };
  return {
    listKnown: () => storage.lexicon.listByState("known"),
    addKnown: (lemma: string, now: number) => storage.lexicon.addKnown(lemmaFrom(lemma), now),
    removeKnown: (lemma: string) => storage.lexicon.removeKnown(lemmaFrom(lemma)),
    clearKnown: () => storage.lexicon.clearKnown()
  };
}
