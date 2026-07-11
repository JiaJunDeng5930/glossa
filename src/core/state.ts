import type { VocabularyRecord } from "../shared/types";

const DAY_MS = 24 * 60 * 60 * 1_000;

export function vocabularyKey(lang: string, lemma: string): string {
  return `${lang}:${normalizeLemma(lemma)}`;
}

export function normalizeLemma(value: string): string {
  return value.trim().toLocaleLowerCase("en-US");
}

export function createCandidateRecord(
  lemma: string,
  surface: string,
  lang: string,
  now: number
): VocabularyRecord {
  return {
    key: vocabularyKey(lang, lemma),
    lemma: normalizeLemma(lemma),
    surface,
    lang,
    state: "candidate",
    shownCount: 0,
    clickCount: 0,
    lastShownAt: now,
    ankiNoteIds: []
  };
}

export function markRecordShown(record: VocabularyRecord, now: number): VocabularyRecord {
  return {
    ...record,
    state: record.state === "candidate" ? "known" : record.state,
    shownCount: record.shownCount + 1,
    lastShownAt: now
  };
}

export function markRecordClicked(record: VocabularyRecord, now: number, learningWindowDays: number): VocabularyRecord {
  return {
    ...record,
    state: "learning_active",
    expiresAt: now + learningWindowDays * DAY_MS,
    clickCount: record.clickCount + 1,
    lastClickedAt: now
  };
}

export function transitionExpiredLearning(record: VocabularyRecord, now: number): VocabularyRecord {
  if (record.state === "learning_active" && record.expiresAt !== undefined && record.expiresAt <= now) {
    const { expiresAt: _expiresAt, ...rest } = record;
    return { ...rest, state: "known" };
  }
  return record;
}

export function shouldRequestGloss(record: VocabularyRecord | undefined, now: number): boolean {
  if (record === undefined) {
    return true;
  }
  const current = transitionExpiredLearning(record, now);
  return current.state === "candidate" || current.state === "learning_active";
}
