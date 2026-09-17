import { isKnownLemma } from "../core/lexicon";
import { normalizeLemma } from "../core/state";
import type { SentenceCandidate, TokenCandidate } from "../shared/types";
import { createAsyncSentenceContextResolver, type SentenceContext } from "./context";
import { fingerprint, occurrencesFor } from "./occurrence";
import { WORD_PATTERN, isReadableElement, yieldToPage, type ReadingPolicy } from "./readability";

export interface ScannedToken extends TokenCandidate {
  readingPolicy?: ReadingPolicy;
  textNode: Text;
  nodeStartOffset: number;
  nodeEndOffset: number;
  sentenceText: string;
  sourceFingerprint: string;
  scanVersion: number;
}

export interface ScannedSentence extends SentenceCandidate {
  tokens: ScannedToken[];
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
  forceRefreshKeys?: ReadonlySet<string>;
  minWordLength?: number;
  minContextChars?: number;
  requireRenderableRange?: boolean;
  requireViewportRange?: boolean;
}

export interface ScanChunkOptions extends ScanOptions {
  maxTokensPerChunk?: number;
  maxChunkDelayMs?: number;
  shouldContinue?: () => boolean;
  onShadowRoot?: (root: ShadowRoot) => void;
}

export async function scanDocumentTextInChunks(
  doc: Document,
  knownWords: ReadonlySet<string>,
  options: ScanChunkOptions,
  onChunk: (chunk: ScanChunk) => Promise<boolean | void> | boolean | void
): Promise<ScanStats> {
  const stats = createScanStats();
  const registry = occurrencesFor(doc);
  const textNodes = doc.body ? discoverTextNodes(doc.body, stats, options.onShadowRoot) : [];
  const shouldContinue = options.shouldContinue ?? (() => true);
  let sliceStarted = nowMs();
  const lemmaCounts = new Map<string, number>();
  const resolveSentenceContext = createAsyncSentenceContextResolver(shouldContinue);
  const sentenceIds = new WeakMap<Node, Map<number, string>>();
  let sentenceIndex = 0;
  let chunkIndex = 0;
  let chunkStartedAt = nowMs();
  let chunkSentences: ScannedSentence[] = [];
  let chunkTokens: ScannedToken[] = [];
  const scanVersion = options.scanVersion ?? 0;
  // Automatic glossing stays sparse by design: short shapes, acronyms, and repeated lemmas reduce page noise.
  const maxOccurrencesPerLemma = options.maxOccurrencesPerLemma ?? 1;
  const minWordLength = options.minWordLength ?? 3;
  const minContextChars = options.minContextChars ?? 12;
  const maxTokensPerChunk = options.maxTokensPerChunk ?? 64;
  const maxChunkDelayMs = options.maxChunkDelayMs ?? 16;
  // @behavior glossa.page_translation.generation_refresh.snapshot One scan keeps an immutable refresh-key snapshot across every streamed chunk.
  const forceRefreshKeys = options.forceRefreshKeys ? new Set(options.forceRefreshKeys) : undefined;

  const flushChunk = async (): Promise<boolean> => {
    if (!shouldContinue()) return false;
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

  const sentenceIdFor = (context: SentenceContext): string => {
    let ids = sentenceIds.get(context.boundary);
    if (!ids) {
      ids = new Map();
      sentenceIds.set(context.boundary, ids);
    }
    let id = ids.get(context.sentenceStart);
    if (!id) {
      id = `s${sentenceIndex++}`;
      ids.set(context.sentenceStart, id);
    }
    return id;
  };

  const appendToken = (token: ScannedToken): void => {
    const sentence = chunkSentences.find((item) => item.id === token.sentenceId);
    if (sentence) {
      sentence.tokens.push(token);
      return;
    }
    chunkSentences.push({ id: token.sentenceId, text: token.sentenceText, tokens: [token] });
  };

  for (const textNode of textNodes) {
    if (!shouldContinue()) return stats;
    if (chunkTokens.length > 0 && nowMs() - chunkStartedAt >= maxChunkDelayMs && !await flushChunk()) return stats;
    if (nowMs() - sliceStarted >= 8) { await yieldToPage(); sliceStarted = nowMs(); }
    if (!textNode) continue;
    stats.scannedTextNodes += 1;
    const text = textNode.nodeValue ?? "";
    for (const wordMatch of text.matchAll(WORD_PATTERN)) {
      if (!shouldContinue()) return stats;
      if (nowMs() - sliceStarted >= 8) { await yieldToPage(); sliceStarted = nowMs(); }
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
      const nodeStartOffset = wordMatch.index ?? 0;
      const nodeEndOffset = nodeStartOffset + surface.length;
      const context = await resolveSentenceContext(textNode, nodeStartOffset, nodeEndOffset);
      if (!context || context.text.length < minContextChars) {
        stats.rejectedByText += 1;
        continue;
      }
      const forceRefresh = forceRefreshKeys?.has(glossRefreshKey({
        sentenceText: context.text,
        lemma,
        startOffset: context.startOffset,
        endOffset: context.endOffset
      })) === true;
      const count = lemmaCounts.get(lemma) ?? 0;
      if (count >= maxOccurrencesPerLemma && !forceRefresh) {
        stats.rejectedByFrequency += 1;
        continue;
      }
      const currentLocation = registry.locate({ textNode, nodeStartOffset, nodeEndOffset, surface } as ScannedToken);
      if (options.requireRenderableRange && (!currentLocation || !hasRenderableRange(currentLocation.node, currentLocation.start, currentLocation.end, options.requireViewportRange === true))) {
        stats.rejectedByVisibility += 1;
        continue;
      }
      const sentenceId = sentenceIdFor(context);
      const sourceFingerprint = createSourceFingerprint(text, nodeStartOffset, nodeEndOffset);
      const token: ScannedToken = {
        id: registry.identify(textNode, nodeStartOffset, nodeEndOffset, surface),
        sentenceId,
        surface,
        lemma,
        startOffset: context.startOffset,
        endOffset: context.endOffset,
        textNode,
        nodeStartOffset,
        nodeEndOffset,
        sentenceText: context.text,
        sourceFingerprint,
        scanVersion,
        ...(forceRefresh ? { forceRefresh: true } : {})
      };
      registry.register(token);
      appendToken(token);
      chunkTokens.push(token);
      lemmaCounts.set(lemma, count + 1);
      stats.candidateWords += 1;

      if (
        chunkTokens.length >= maxTokensPerChunk
        || nowMs() - chunkStartedAt >= maxChunkDelayMs
      ) {
        const keepGoing = await flushChunk();
        if (!keepGoing) {
          return stats;
        }
      }
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

export function glossRefreshKey(input: { sentenceText: string; lemma: string; startOffset: number; endOffset: number }): string {
  return JSON.stringify([input.sentenceText, input.lemma, input.startOffset, input.endOffset]);
}

function* discoverTextNodes(root: HTMLElement, stats: ScanStats, onShadowRoot?: (root: ShadowRoot) => void): Generator<Text | undefined> {
  const stack: Node[] = [root];
  while (stack.length) {
    const node = stack.pop()!;
    if (node !== root && node.nextSibling) stack.push(node.nextSibling);
    if (node instanceof Element && !isReadableElement(node)) { stats.rejectedBySubtree++; yield undefined; continue; }
    if (node instanceof Text) { if (hasMeaningfulText(node.data)) yield node; else { stats.rejectedByText++; yield undefined; } continue; }
    if (node.firstChild) stack.push(node.firstChild);
    if (node instanceof Element && node.shadowRoot) { occurrencesFor(node.ownerDocument).observe(node.shadowRoot); onShadowRoot?.(node.shadowRoot); if (node.shadowRoot.firstChild) stack.push(node.shadowRoot.firstChild); }
    yield undefined;
  }
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

function hasRenderableRange(textNode: Text, startOffset: number, endOffset: number, requireViewportRange: boolean): boolean {
  const doc = textNode.ownerDocument;
  const range = doc.createRange();
  try {
    range.setStart(textNode, startOffset);
    range.setEnd(textNode, endOffset);
    const rects = range.getClientRects();
    return Array.from(rects).some((rect) => {
      if (rect.width <= 0 || rect.height <= 0) {
        return false;
      }
      return !requireViewportRange || intersectsVisibleArea(rect, textNode, doc);
    });
  } catch {
    return false;
  } finally {
    range.detach();
  }
}

function intersectsVisibleArea(rect: DOMRect, textNode: Text, doc: Document): boolean {
  const view = doc.defaultView;
  const width = view?.innerWidth ?? doc.documentElement.clientWidth;
  const height = view?.innerHeight ?? doc.documentElement.clientHeight;
  let left = Math.max(rect.left, 0);
  let right = Math.min(rect.right, width);
  let top = Math.max(rect.top, 0);
  let bottom = Math.min(rect.bottom, height);
  if (!hasPositiveArea(left, right, top, bottom)) {
    return false;
  }
  let element = firstClipAncestor(textNode);
  while (element) {
    if (!view?.getComputedStyle) {
      return true;
    }
    const style = view.getComputedStyle(element);
    const clipsX = clipsOverflow(style.overflowX || style.overflow);
    const clipsY = clipsOverflow(style.overflowY || style.overflow);
    if (clipsX || clipsY) {
      const clipRect = element.getBoundingClientRect();
      if (clipsX) {
        left = Math.max(left, clipRect.left);
        right = Math.min(right, clipRect.right);
      }
      if (clipsY) {
        top = Math.max(top, clipRect.top);
        bottom = Math.min(bottom, clipRect.bottom);
      }
      if (!hasPositiveArea(left, right, top, bottom)) {
        return false;
      }
    }
    element = nextClipAncestor(element);
  }
  return true;
}

function firstClipAncestor(textNode: Text): Element | null {
  if (textNode.parentElement) {
    return textNode.parentElement;
  }
  const root = textNode.getRootNode();
  return root instanceof ShadowRoot ? root.host : null;
}

function nextClipAncestor(element: Element): Element | null {
  if (element.parentElement) {
    return element.parentElement;
  }
  const root = element.getRootNode();
  return root instanceof ShadowRoot ? root.host : null;
}

function clipsOverflow(value: string): boolean {
  return value === "auto" || value === "scroll" || value === "hidden" || value === "clip";
}

function hasPositiveArea(left: number, right: number, top: number, bottom: number): boolean {
  return right > left && bottom > top;
}

export const createSourceFingerprint = fingerprint;

export function toSerializableSentence(sentence: ScannedSentence): SentenceCandidate {
  return {
    id: sentence.id,
    text: sentence.text,
    tokens: sentence.tokens.map(({ id, sentenceId, surface, lemma, startOffset, endOffset, forceRefresh }) => ({
      id,
      sentenceId,
      surface,
      lemma,
      startOffset,
      endOffset,
      ...(forceRefresh ? { forceRefresh: true } : {})
    }))
  };
}
