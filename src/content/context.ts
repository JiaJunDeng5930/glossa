const SENTENCE_RE = /[^.!?\n]+[.!?]?/g;
const CONTEXT_BOUNDARY_SELECTOR = "p,li,blockquote,dd,dt,figcaption,td,th,h1,h2,h3,h4,h5,h6,main,section,article,aside,nav,header,footer,address,div";
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
  "[contenteditable='true']",
  "[contenteditable='']",
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
  segments: WeakMap<Text, TextSegment>;
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
    const segment = snapshot.segments.get(node);
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
  const segments = new WeakMap<Text, TextSegment>();
  let text = "";
  const walker = doc.createTreeWalker(boundary, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
  let current = walker.nextNode();
  while (current) {
    if (
      current.nodeType === Node.ELEMENT_NODE
      && (current as Element).tagName === "BR"
      && isContextElement(current as Element, boundary)
    ) {
      text += "\n";
    } else if (current.nodeType === Node.TEXT_NODE && isContextText(current as Text, boundary)) {
      const textNode = current as Text;
      const value = textNode.nodeValue ?? "";
      const start = text.length;
      text += value;
      segments.set(textNode, { node: textNode, start, end: text.length });
    }
    current = walker.nextNode();
  }
  return { text, segments };
}

function isContextText(node: Text, boundary: Node): boolean {
  const sourceSurface = node.parentElement?.closest("[data-glossa-token-surface]");
  const sourceWrapper = sourceSurface?.closest("[data-glossa-token]");
  return isContextElement(node.parentElement, boundary, sourceSurface, sourceWrapper);
}

function isContextElement(
  source: Element | null,
  boundary: Node,
  sourceSurface?: Element | null,
  sourceWrapper?: Element | null
): boolean {
  let element = source;
  while (element) {
    // Existing wrappers contribute their source surface; generated label and measurement nodes remain excluded.
    const isSourceScaffold = sourceSurface !== null
      && sourceSurface !== undefined
      && (element === sourceSurface || sourceSurface.contains(element) || element === sourceWrapper);
    if (element.matches(EXCLUDED_SELECTOR) && !isSourceScaffold) {
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
