// @behavior glossa.page_translation.candidate_scan Visible editable-safe text nodes produce DOM-grounded English token candidates.
import { isKnownLemma } from "../core/lexicon";
import { normalizeLemma } from "../core/state";
import type { SentenceCandidate, TokenCandidate } from "../shared/types";

export interface ScannedToken extends TokenCandidate {
  textNode: Text;
  nodeStartOffset: number;
  nodeEndOffset: number;
  sentenceText: string;
  sourceText: string;
  sourceFingerprint: string;
  scanVersion: number;
}

export interface ScannedSentence extends SentenceCandidate {
  tokens: ScannedToken[];
}

export interface ScanResult {
  sentences: ScannedSentence[];
  tokens: ScannedToken[];
  stats: ScanStats;
}

export interface ScanChunk {
  chunkIndex: number;
  sentences: ScannedSentence[];
  tokens: ScannedToken[];
}

export interface ScanStats {
  scannedTextNodes: number;
  rejectedBySubtree: number;
  rejectedByVisibility: number;
  rejectedByText: number;
  rejectedByKnownWord: number;
  rejectedByShape: number;
  rejectedByFrequency: number;
  candidateWords: number;
}

export interface ScanOptions {
  scanVersion?: number;
  maxOccurrencesPerLemma?: number;
  minWordLength?: number;
  minContextChars?: number;
  requireRenderableRange?: boolean;
}

export interface ScanChunkOptions extends ScanOptions {
  maxTokensPerChunk?: number;
  maxChunkDelayMs?: number;
}

const WORD_RE = /[A-Za-z]+(?:['-][A-Za-z]+)*/g;
const SENTENCE_RE = /[^.!?\n]+[.!?]?/g;
const SKIPPED_TAGS = new Set([
  "SCRIPT",
  "STYLE",
  "NOSCRIPT",
  "TEMPLATE",
  "SVG",
  "CANVAS",
  "MATH",
  "TEXTAREA",
  "INPUT",
  "SELECT",
  "OPTION",
  "PRE",
  "CODE",
  "KBD",
  "SAMP",
  "VAR",
  "BUTTON"
]);
const SKIPPED_SELECTOR = [
  "[contenteditable='true']",
  "[contenteditable='']",
  "[aria-hidden='true']",
  "[translate='no']",
  ".notranslate",
  ".imt-notranslate",
  "[data-glossa-owned='1']",
  "[data-glossa-label]",
  "#glossa-overlay"
].join(",");

export function scanDocumentText(
  doc: Document,
  knownWords: ReadonlySet<string>,
  options: ScanOptions = {}
): ScanResult {
  const stats = createScanStats();
  const textNodes = doc.body ? collectTextNodes(doc.body, stats) : [];
  const sentences: ScannedSentence[] = [];
  const tokens: ScannedToken[] = [];
  const lemmaCounts = new Map<string, number>();
  let sentenceIndex = 0;
  const scanVersion = options.scanVersion ?? 0;
  const maxOccurrencesPerLemma = options.maxOccurrencesPerLemma ?? 1;
  const minWordLength = options.minWordLength ?? 3;
  const minContextChars = options.minContextChars ?? 12;

  for (const textNode of textNodes) {
    stats.scannedTextNodes += 1;
    const text = textNode.nodeValue ?? "";
    for (const sentenceMatch of text.matchAll(SENTENCE_RE)) {
      const raw = sentenceMatch[0];
      const trimmed = raw.trim();
      if (trimmed.length === 0) {
        stats.rejectedByText += 1;
        continue;
      }
      if (trimmed.length < minContextChars) {
        stats.rejectedByText += 1;
        continue;
      }
      const leading = raw.length - raw.trimStart().length;
      const sentenceStart = (sentenceMatch.index ?? 0) + leading;
      const sentenceId = `s${sentenceIndex++}`;
      const sentenceTokens: ScannedToken[] = [];

      for (const wordMatch of trimmed.matchAll(WORD_RE)) {
        const surface = wordMatch[0];
        if (!isEligibleSurface(surface, minWordLength)) {
          stats.rejectedByShape += 1;
          continue;
        }
        const lemma = normalizeLemma(surface);
        if (isKnownLemma(knownWords, lemma)) {
          stats.rejectedByKnownWord += 1;
          continue;
        }
        const count = lemmaCounts.get(lemma) ?? 0;
        if (count >= maxOccurrencesPerLemma) {
          stats.rejectedByFrequency += 1;
          continue;
        }
        const startOffset = wordMatch.index ?? 0;
        const endOffset = startOffset + surface.length;
        const nodeStartOffset = sentenceStart + startOffset;
        const nodeEndOffset = sentenceStart + endOffset;
        if (options.requireRenderableRange && !hasRenderableRange(textNode, nodeStartOffset, nodeEndOffset)) {
          stats.rejectedByVisibility += 1;
          continue;
        }
        const sourceFingerprint = createSourceFingerprint(text, nodeStartOffset, nodeEndOffset);
        const token: ScannedToken = {
          id: createTokenId(textNode, surface, lemma, sentenceStart, sourceFingerprint),
          sentenceId,
          surface,
          lemma,
          startOffset,
          endOffset,
          textNode,
          nodeStartOffset,
          nodeEndOffset,
          sentenceText: trimmed,
          sourceText: surface,
          sourceFingerprint,
          scanVersion
        };
        sentenceTokens.push(token);
        tokens.push(token);
        lemmaCounts.set(lemma, count + 1);
        stats.candidateWords += 1;
      }

      sentences.push({
        id: sentenceId,
        text: trimmed,
        tokens: sentenceTokens
      });
    }
  }

  return { sentences, tokens, stats };
}

export async function scanDocumentTextInChunks(
  doc: Document,
  knownWords: ReadonlySet<string>,
  options: ScanChunkOptions,
  onChunk: (chunk: ScanChunk) => Promise<boolean | void> | boolean | void
): Promise<ScanStats> {
  const stats = createScanStats();
  const textNodes = doc.body ? collectTextNodes(doc.body, stats) : [];
  const lemmaCounts = new Map<string, number>();
  let sentenceIndex = 0;
  let chunkIndex = 0;
  let chunkStartedAt = nowMs();
  let chunkSentences: ScannedSentence[] = [];
  let chunkTokens: ScannedToken[] = [];
  const scanVersion = options.scanVersion ?? 0;
  const maxOccurrencesPerLemma = options.maxOccurrencesPerLemma ?? 1;
  const minWordLength = options.minWordLength ?? 3;
  const minContextChars = options.minContextChars ?? 12;
  const maxTokensPerChunk = options.maxTokensPerChunk ?? 64;
  const maxChunkDelayMs = options.maxChunkDelayMs ?? 16;

  const flushChunk = async (): Promise<boolean> => {
    if (chunkTokens.length === 0) {
      chunkStartedAt = nowMs();
      return true;
    }
    const chunk: ScanChunk = {
      chunkIndex,
      sentences: chunkSentences,
      tokens: chunkTokens
    };
    chunkIndex += 1;
    chunkSentences = [];
    chunkTokens = [];
    chunkStartedAt = nowMs();
    const keepGoing = await onChunk(chunk);
    return keepGoing !== false;
  };

  for (const textNode of textNodes) {
    stats.scannedTextNodes += 1;
    const text = textNode.nodeValue ?? "";
    for (const sentenceMatch of text.matchAll(SENTENCE_RE)) {
      const raw = sentenceMatch[0];
      const trimmed = raw.trim();
      if (trimmed.length === 0) {
        stats.rejectedByText += 1;
        continue;
      }
      if (trimmed.length < minContextChars) {
        stats.rejectedByText += 1;
        continue;
      }
      const leading = raw.length - raw.trimStart().length;
      const sentenceStart = (sentenceMatch.index ?? 0) + leading;
      const sentenceId = `s${sentenceIndex++}`;
      let sentenceTokens: ScannedToken[] = [];

      const appendSentencePart = (): void => {
        if (sentenceTokens.length === 0) {
          return;
        }
        chunkSentences.push({
          id: sentenceId,
          text: trimmed,
          tokens: sentenceTokens
        });
        sentenceTokens = [];
      };

      for (const wordMatch of trimmed.matchAll(WORD_RE)) {
        const surface = wordMatch[0];
        if (!isEligibleSurface(surface, minWordLength)) {
          stats.rejectedByShape += 1;
          continue;
        }
        const lemma = normalizeLemma(surface);
        if (isKnownLemma(knownWords, lemma)) {
          stats.rejectedByKnownWord += 1;
          continue;
        }
        const count = lemmaCounts.get(lemma) ?? 0;
        if (count >= maxOccurrencesPerLemma) {
          stats.rejectedByFrequency += 1;
          continue;
        }
        const startOffset = wordMatch.index ?? 0;
        const endOffset = startOffset + surface.length;
        const nodeStartOffset = sentenceStart + startOffset;
        const nodeEndOffset = sentenceStart + endOffset;
        if (options.requireRenderableRange && !hasRenderableRange(textNode, nodeStartOffset, nodeEndOffset)) {
          stats.rejectedByVisibility += 1;
          continue;
        }
        const sourceFingerprint = createSourceFingerprint(text, nodeStartOffset, nodeEndOffset);
        const token: ScannedToken = {
          id: createTokenId(textNode, surface, lemma, sentenceStart, sourceFingerprint),
          sentenceId,
          surface,
          lemma,
          startOffset,
          endOffset,
          textNode,
          nodeStartOffset,
          nodeEndOffset,
          sentenceText: trimmed,
          sourceText: surface,
          sourceFingerprint,
          scanVersion
        };
        sentenceTokens.push(token);
        chunkTokens.push(token);
        lemmaCounts.set(lemma, count + 1);
        stats.candidateWords += 1;

        if (
          chunkTokens.length >= maxTokensPerChunk
          || nowMs() - chunkStartedAt >= maxChunkDelayMs
        ) {
          appendSentencePart();
          const keepGoing = await flushChunk();
          if (!keepGoing) {
            return stats;
          }
        }
      }

      appendSentencePart();
    }

    if (
      chunkTokens.length >= maxTokensPerChunk
      || (chunkTokens.length > 0 && nowMs() - chunkStartedAt >= maxChunkDelayMs)
    ) {
      const keepGoing = await flushChunk();
      if (!keepGoing) {
        return stats;
      }
    }
  }

  await flushChunk();
  return stats;
}

function createTokenId(
  textNode: Text,
  surface: string,
  lemma: string,
  sentenceStart: number,
  sourceFingerprint: string
): string {
  const root = textNode.getRootNode();
  const rootKind = root instanceof ShadowRoot ? "shadow" : "document";
  const parentPath = textNode.parentElement ? elementPath(textNode.parentElement) : "text";
  return [
    "t",
    rootKind,
    hashSmall(parentPath),
    hashSmall(`${sentenceStart}:${surface}:${lemma}`),
    sourceFingerprint
  ].join(":");
}

function elementPath(element: Element): string {
  const parts: string[] = [];
  let current: Element | null = element;
  while (current && parts.length < 8) {
    const parent: Element | null = current.parentElement;
    const siblingIndex = parent
      ? Array.from<Element>(parent.children)
        .filter((sibling) => !sibling.matches("[data-glossa-owned='1']"))
        .indexOf(current)
      : 0;
    parts.push(`${current.tagName.toLowerCase()}:${Math.max(0, siblingIndex)}`);
    current = parent;
  }
  return parts.reverse().join("/");
}

function collectTextNodes(root: HTMLElement, stats: ScanStats): Text[] {
  const nodes: Text[] = [];
  const visit = (node: Node) => {
    if (node.nodeType === Node.ELEMENT_NODE) {
      const element = node as Element;
      if (isExcludedElement(element)) {
        stats.rejectedBySubtree += 1;
        return;
      }
      if (!isVisibleElement(element)) {
        stats.rejectedByVisibility += 1;
        return;
      }
    }
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node as Text;
      if (text.parentElement && hasMeaningfulText(text.nodeValue)) {
        nodes.push(text);
      } else {
        stats.rejectedByText += 1;
      }
      return;
    }
    if (node instanceof Element && node.shadowRoot) {
      visit(node.shadowRoot);
    }
    for (const child of Array.from(node.childNodes)) {
      visit(child);
    }
  };
  visit(root);
  return nodes;
}

function nowMs(): number {
  return globalThis.performance?.now?.() ?? Date.now();
}

function createScanStats(): ScanStats {
  return {
    scannedTextNodes: 0,
    rejectedBySubtree: 0,
    rejectedByVisibility: 0,
    rejectedByText: 0,
    rejectedByKnownWord: 0,
    rejectedByShape: 0,
    rejectedByFrequency: 0,
    candidateWords: 0
  };
}

function isExcludedElement(element: Element): boolean {
  if (SKIPPED_TAGS.has(element.tagName)) {
    return true;
  }
  if (element.matches(SKIPPED_SELECTOR)) {
    return true;
  }
  return element.closest(SKIPPED_SELECTOR) !== null;
}

function isVisibleElement(element: Element): boolean {
  if (!element.isConnected) {
    return false;
  }
  const view = element.ownerDocument.defaultView;
  if (!view?.getComputedStyle) {
    return true;
  }
  const style = view.getComputedStyle(element);
  if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
    return false;
  }
  return style.contentVisibility !== "hidden";
}

function isEligibleSurface(surface: string, minWordLength: number): boolean {
  if (surface.length < minWordLength) {
    return false;
  }
  if (/^[A-Z]{2,}$/.test(surface)) {
    return false;
  }
  if (/[-']{2,}/.test(surface)) {
    return false;
  }
  if (/^[a-fA-F0-9]{6,}$/.test(surface)) {
    return false;
  }
  return true;
}

function hasMeaningfulText(text: string | null): boolean {
  return typeof text === "string" && /[A-Za-z]/.test(text);
}

function hasRenderableRange(textNode: Text, startOffset: number, endOffset: number): boolean {
  const doc = textNode.ownerDocument;
  const range = doc.createRange();
  try {
    range.setStart(textNode, startOffset);
    range.setEnd(textNode, endOffset);
    const rects = range.getClientRects();
    return Array.from(rects).some((rect) => rect.width > 0 && rect.height > 0);
  } catch {
    return false;
  } finally {
    range.detach();
  }
}

export function createSourceFingerprint(text: string, startOffset: number, endOffset: number): string {
  const before = text.slice(Math.max(0, startOffset - 16), startOffset);
  const target = text.slice(startOffset, endOffset);
  const after = text.slice(endOffset, Math.min(text.length, endOffset + 16));
  return `${startOffset}:${endOffset}:${hashSmall(`${before}|${target}|${after}`)}`;
}

function hashSmall(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

export function toSerializableSentence(sentence: ScannedSentence): SentenceCandidate {
  return {
    id: sentence.id,
    text: sentence.text,
    tokens: sentence.tokens.map(({ id, sentenceId, surface, lemma, startOffset, endOffset }) => ({
      id,
      sentenceId,
      surface,
      lemma,
      startOffset,
      endOffset
    }))
  };
}
