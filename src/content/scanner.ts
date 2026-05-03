import { isKnownLemma } from "../core/lexicon";
import { normalizeLemma } from "../core/state";
import type { SentenceCandidate, TokenCandidate } from "../shared/types";

export interface ScannedToken extends TokenCandidate {
  textNode: Text;
  nodeStartOffset: number;
  nodeEndOffset: number;
  sentenceText: string;
}

export interface ScannedSentence extends SentenceCandidate {
  tokens: ScannedToken[];
}

export interface ScanResult {
  sentences: ScannedSentence[];
  tokens: ScannedToken[];
}

const WORD_RE = /[A-Za-z][A-Za-z'-]*/g;
const SENTENCE_RE = /[^.!?\n]+[.!?]?/g;
const SKIPPED_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEXTAREA", "INPUT", "SELECT", "OPTION"]);

export function scanDocumentText(doc: Document, knownWords: ReadonlySet<string>): ScanResult {
  const textNodes = collectTextNodes(doc.body);
  const sentences: ScannedSentence[] = [];
  const tokens: ScannedToken[] = [];
  let sentenceIndex = 0;
  let tokenIndex = 0;

  for (const textNode of textNodes) {
    const text = textNode.nodeValue ?? "";
    for (const sentenceMatch of text.matchAll(SENTENCE_RE)) {
      const raw = sentenceMatch[0];
      const trimmed = raw.trim();
      if (trimmed.length === 0) {
        continue;
      }
      const leading = raw.length - raw.trimStart().length;
      const sentenceStart = (sentenceMatch.index ?? 0) + leading;
      const sentenceId = `s${sentenceIndex++}`;
      const sentenceTokens: ScannedToken[] = [];

      for (const wordMatch of trimmed.matchAll(WORD_RE)) {
        const surface = wordMatch[0];
        const lemma = normalizeLemma(surface);
        if (isKnownLemma(knownWords, lemma)) {
          continue;
        }
        const startOffset = wordMatch.index ?? 0;
        const endOffset = startOffset + surface.length;
        const token: ScannedToken = {
          id: `t${tokenIndex++}`,
          sentenceId,
          surface,
          lemma,
          startOffset,
          endOffset,
          textNode,
          nodeStartOffset: sentenceStart + startOffset,
          nodeEndOffset: sentenceStart + endOffset,
          sentenceText: trimmed
        };
        sentenceTokens.push(token);
        tokens.push(token);
      }

      sentences.push({
        id: sentenceId,
        text: trimmed,
        tokens: sentenceTokens
      });
    }
  }

  return { sentences, tokens };
}

function collectTextNodes(root: HTMLElement): Text[] {
  const nodes: Text[] = [];
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent || SKIPPED_TAGS.has(parent.tagName) || !hasMeaningfulText(node.nodeValue)) {
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    }
  });

  let current = walker.nextNode();
  while (current) {
    nodes.push(current as Text);
    current = walker.nextNode();
  }
  return nodes;
}

function hasMeaningfulText(text: string | null): boolean {
  return typeof text === "string" && /[A-Za-z]/.test(text);
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
