const SENTENCE_RE = /[^.!?\n]+[.!?]?/g;
const CONTEXT_BOUNDARY_SELECTOR = "p,li,blockquote,dd,dt,figcaption,td,th,h1,h2,h3,h4,h5,h6,div";
const EXCLUDED_SELECTOR = [
  "script",
  "style",
  "noscript",
  "template",
  "textarea",
  "input",
  "select",
  "option",
  "pre",
  "code",
  "[hidden]",
  "[aria-hidden='true']",
  "[data-glossa-owned='1']",
  "[translate='no']",
  ".notranslate"
].join(",");

interface TextSegment {
  node: Text;
  start: number;
  end: number;
}

interface ContextSnapshot {
  text: string;
  segments: TextSegment[];
}

export interface SentenceContext {
  boundary: Node;
  sentenceStart: number;
  text: string;
  startOffset: number;
  endOffset: number;
}

export function createSentenceContextResolver(): (node: Text, startOffset: number, endOffset: number) => SentenceContext | undefined {
  const snapshots = new WeakMap<Node, ContextSnapshot>();

  return (node, startOffset, endOffset) => {
    const boundary = contextBoundary(node);
    let snapshot = snapshots.get(boundary);
    if (!snapshot) {
      snapshot = buildSnapshot(boundary, node.ownerDocument);
      snapshots.set(boundary, snapshot);
    }
    const segment = snapshot.segments.find((item) => item.node === node);
    if (!segment) {
      return undefined;
    }
    const absoluteStart = segment.start + startOffset;
    const absoluteEnd = segment.start + endOffset;
    for (const match of snapshot.text.matchAll(SENTENCE_RE)) {
      const raw = match[0];
      const leading = raw.length - raw.trimStart().length;
      const trailing = raw.length - raw.trimEnd().length;
      const sentenceStart = (match.index ?? 0) + leading;
      const sentenceEnd = (match.index ?? 0) + raw.length - trailing;
      if (absoluteStart < sentenceStart || absoluteEnd > sentenceEnd) {
        continue;
      }
      return {
        boundary,
        sentenceStart,
        text: snapshot.text.slice(sentenceStart, sentenceEnd),
        startOffset: absoluteStart - sentenceStart,
        endOffset: absoluteEnd - sentenceStart
      };
    }
    return undefined;
  };
}

function contextBoundary(node: Text): Node {
  return node.parentElement?.closest(CONTEXT_BOUNDARY_SELECTOR)
    ?? node.parentElement
    ?? node.getRootNode();
}

function buildSnapshot(boundary: Node, doc: Document): ContextSnapshot {
  const segments: TextSegment[] = [];
  let text = "";
  const walker = doc.createTreeWalker(boundary, NodeFilter.SHOW_TEXT);
  let current = walker.nextNode();
  while (current) {
    const textNode = current as Text;
    if (isContextText(textNode, boundary)) {
      const value = textNode.nodeValue ?? "";
      const start = text.length;
      text += value;
      segments.push({ node: textNode, start, end: text.length });
    }
    current = walker.nextNode();
  }
  return { text, segments };
}

function isContextText(node: Text, boundary: Node): boolean {
  let element = node.parentElement;
  while (element) {
    if (element.matches(EXCLUDED_SELECTOR)) {
      return false;
    }
    const style = element.ownerDocument.defaultView?.getComputedStyle(element);
    if (style && (style.display === "none" || style.visibility === "hidden" || style.opacity === "0")) {
      return false;
    }
    if (element === boundary) {
      break;
    }
    element = element.parentElement;
  }
  return true;
}
