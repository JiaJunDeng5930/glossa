import manifest from "../../../assets/dictionaries/ecdict/manifest.json" with { type: "json" };
import { createDiagnosticError, diagnosticErrorFrom } from "../errors";

export interface DictionarySense {
  id: string;
  definition: string;
  partOfSpeech?: string;
}

export interface Dictionary {
  readonly id: string;
  readonly version: string;
  lookup(word: { surface: string; lemma: string }, signal?: AbortSignal): Promise<
    { kind: "found"; senses: readonly DictionarySense[] } | { kind: "missing" }
  >;
}

export const dictionaryIdentity = Object.freeze({ id: manifest.id, version: manifest.version });

type DictionaryEntry = [translations: string[], bases: string[]];
type DictionaryPartition = Record<string, DictionaryEntry>;
const dictionaryAssetRoot = "assets/dictionaries/ecdict/";
const maximumLoadedPartitions = 4;
const partOfSpeechPattern = /^((?:(?:adj|adv|pron|prep|conj|interj|int|num|art|aux|abbr|modal|linkv|vbl|pref|suff|symb|vt|vi|n|v|a|pl)\.\s*(?:(?:\/|&|,|，|and)\s*)?)+)/i;

export function createDictionary(): Dictionary {
  return new EcdictDictionary();
}

export class EcdictDictionary implements Dictionary {
  readonly id = dictionaryIdentity.id;
  readonly version = dictionaryIdentity.version;
  private readonly fetchImpl: typeof fetch;
  private readonly assetUrl: (path: string) => string;
  private readonly loaded = new Map<string, DictionaryPartition>();
  private readonly loading = new Map<string, Promise<DictionaryPartition>>();

  constructor(options: { fetchImpl?: typeof fetch; assetUrl?: (path: string) => string } = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.assetUrl = options.assetUrl ?? ((path) => chrome.runtime.getURL(path));
  }

  async lookup(word: { surface: string; lemma: string }, signal?: AbortSignal): Promise<
    { kind: "found"; senses: readonly DictionarySense[] } | { kind: "missing" }
  > {
    signal?.throwIfAborted();
    const pending = [...new Set([word.surface, word.lemma].map(normalizeDictionaryWord))];
    const visited = new Set<string>();
    const senses: DictionarySense[] = [];
    while (pending.length > 0) {
      signal?.throwIfAborted();
      const headword = pending.shift()!;
      if (visited.has(headword) || !/^[a-z]+(?:[-'][a-z]+)*$/.test(headword)) continue;
      visited.add(headword);
      const partition = await abortable(this.loadPartition(headword[0]!), signal);
      if (!Object.hasOwn(partition, headword)) continue;
      const [translations, bases] = partition[headword]!;
      for (const [translationIndex, translation] of translations.entries()) {
        for (const [senseIndex, sense] of splitDictionarySenses(translation).entries()) {
          senses.push({ id: `${this.id}:${headword}:${translationIndex}:${senseIndex}`, ...sense });
        }
      }
      pending.push(...bases);
    }
    return senses.length > 0 ? { kind: "found", senses } : { kind: "missing" };
  }

  private loadPartition(initial: string): Promise<DictionaryPartition> {
    const loaded = this.loaded.get(initial);
    if (loaded) {
      this.loaded.delete(initial);
      this.loaded.set(initial, loaded);
      return Promise.resolve(loaded);
    }
    const loading = this.loading.get(initial);
    if (loading) return loading;
    const promise = this.readPartition(initial).then((partition) => {
      this.loaded.set(initial, partition);
      while (this.loaded.size > maximumLoadedPartitions) this.loaded.delete(this.loaded.keys().next().value!);
      return partition;
    }).finally(() => this.loading.delete(initial));
    this.loading.set(initial, promise);
    return promise;
  }

  private async readPartition(initial: string): Promise<DictionaryPartition> {
    try {
      const metadata = manifest.partitions[initial as keyof typeof manifest.partitions];
      if (!metadata) throw new Error(`Unknown ECDICT partition: ${initial}`);
      // A lookup owns cancellation; the shared local load remains usable by other lookups.
      const fetchImpl = this.fetchImpl;
      const response = await fetchImpl(this.assetUrl(`${dictionaryAssetRoot}${metadata.file}`));
      if (!response.ok || !response.body) {
        throw createDiagnosticError("service-error", `ECDICT asset load failed: ${initial} (HTTP ${response.status})`, { service: "dictionary", status: response.status });
      }
      const text = await new Response(response.body.pipeThrough(new DecompressionStream("gzip"))).text();
      const value: unknown = JSON.parse(text);
      if (!isDictionaryPartition(value, initial, metadata.entries)) {
        throw createDiagnosticError("invalid-response", `ECDICT asset data is invalid: ${initial}`, { service: "dictionary" });
      }
      return value;
    } catch (error) {
      throw diagnosticErrorFrom(error, { reason: "invalid-response", message: `ECDICT asset could not be read: ${initial}`, service: "dictionary" });
    }
  }
}

function normalizeDictionaryWord(value: string): string {
  return value.trim().toLowerCase().replaceAll("’", "'");
}

function isDictionaryPartition(value: unknown, initial: string, expectedEntries: number): value is DictionaryPartition {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const entries = Object.entries(value);
  return entries.length === expectedEntries && entries.every(([word, entry]) =>
    word[0] === initial && /^[a-z]+(?:[-'][a-z]+)*$/.test(word)
    && Array.isArray(entry) && entry.length === 2
    && entry.every((values: unknown) => Array.isArray(values) && values.every((item: unknown) => typeof item === "string" && item.trim() !== ""))
  );
}

function splitDictionarySenses(translation: string): Array<Omit<DictionarySense, "id">> {
  const senses: Array<Omit<DictionarySense, "id">> = [];
  for (const rawLine of translation.replaceAll("\\n", "\n").split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line) continue;
    const partOfSpeech = line.match(partOfSpeechPattern)?.[1]?.trim();
    if (partOfSpeech) line = line.slice(partOfSpeech.length).trim();
    const domain = line.match(/^(?:(?:\[[^\]]+\]|【[^】]+】)\s*)+/)?.[0]?.trim() ?? "";
    if (domain) line = line.slice(domain.length).trim();
    const definitions = splitOutsideBrackets(line);
    for (const definition of definitions) {
      senses.push({ definition: domain ? `${domain} ${definition}` : definition, ...(partOfSpeech ? { partOfSpeech } : {}) });
    }
    // Even a source line containing only a label is still retained as a candidate.
    if (definitions.length === 0) senses.push({ definition: rawLine.trim() });
  }
  return senses;
}

function splitOutsideBrackets(text: string): string[] {
  const closingBrackets: Record<string, string> = { "(": ")", "（": "）", "[": "]", "【": "】", "{": "}", "〈": "〉", "《": "》" };
  const stack: string[] = [];
  const parts: string[] = [];
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (closingBrackets[char]) stack.push(closingBrackets[char]!);
    else if (char === stack[stack.length - 1]) stack.pop();
    else if (stack.length === 0 && /[,，;；、]/.test(char)) {
      const part = text.slice(start, index).trim();
      if (part) parts.push(part);
      start = index + 1;
    }
  }
  const last = text.slice(start).trim();
  if (last) parts.push(last);
  return parts;
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}
