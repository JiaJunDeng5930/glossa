import { vocabularyKey } from "../core/state";
import type { VocabularyRecord } from "../shared/types";
import type { ExtensionStorage } from "../storage/db";

export async function removeKnownRecord(
  storage: Pick<ExtensionStorage, "lexicon" | "cardedWords">,
  record: VocabularyRecord,
  now = Date.now
): Promise<void> {
  const key = vocabularyKey(record.lang, record.lemma);
  if (record.ankiNoteIds.length > 0) {
    await storage.cardedWords.put(key, {
      key,
      lang: record.lang,
      lemma: record.lemma,
      createdAt: record.lastClickedAt ?? record.lastShownAt ?? now()
    });
  }
  await storage.lexicon.delete(key);
}
