import { occurrencesFor } from './occurrence';
import { isReadableElement, yieldToPage, type ReadingPolicy } from './readability';
const SENTENCE_RE = /[^.!?\n]+[.!?]?/g;
const BOUNDARIES = 'p,li,blockquote,dd,dt,figcaption,td,th,h1,h2,h3,h4,h5,h6,main,section,article,aside,nav,header,footer,address,div';
interface ContextSnapshot { text: string; segments: WeakMap<Text, number>; sentences: Array<{ start: number; end: number }> }
export interface SentenceContext { boundary: Node; sentenceStart: number; text: string; startOffset: number; endOffset: number }
function boundaryFor(node: Text): Node {
  const registry = occurrencesFor(node.ownerDocument);
  const token = registry.findFromNode(node);
  const wrapper = token && registry.handlesFor(token.id)?.wrapper;
  const parent = wrapper?.parentNode ?? node.parentNode;
  const element = parent instanceof Element ? parent : node.parentElement;
  return element?.closest(BOUNDARIES) ?? parent ?? node.getRootNode();
}
function* snapshotSteps(boundary: Node, snapshot: ContextSnapshot, policy: ReadingPolicy = "automatic"): Generator<void> {
  const stack: Node[] = [];
  if (boundary.firstChild) stack.push(boundary.firstChild);
  while (stack.length) {
    const node = stack.pop()!;
    if (node.nextSibling) stack.push(node.nextSibling);
    if (node instanceof Element && !isReadableElement(node, true, policy)) { if (!occurrencesFor(node.ownerDocument).findFromNode(node)) snapshot.text += ' '; yield; continue; }
    if (node instanceof Text) { snapshot.segments.set(node, snapshot.text.length); snapshot.text += node.data; }
    else if (node instanceof Element && node.tagName === 'BR') snapshot.text += '\n';
    else if (node.firstChild) stack.push(node.firstChild);
    yield;
  }
}
function* sentenceSteps(snapshot: ContextSnapshot): Generator<void> {
  for (const match of snapshot.text.matchAll(SENTENCE_RE)) {
    const raw = match[0];
    snapshot.sentences.push({ start: match.index! + raw.length - raw.trimStart().length, end: match.index! + raw.trimEnd().length });
    yield;
  }
}
function resolve(snapshot: ContextSnapshot, boundary: Node, node: Text, start: number, end: number): SentenceContext | undefined {
  const offset = snapshot.segments.get(node);
  if (offset === undefined) return undefined;
  let left = 0, right = snapshot.sentences.length;
  while (left < right) { const middle = (left + right) >>> 1; if (snapshot.sentences[middle]!.end < offset + end) left = middle + 1; else right = middle; }
  const sentence = snapshot.sentences[left];
  if (sentence && offset + start >= sentence.start && offset + end <= sentence.end) return { boundary, sentenceStart: sentence.start, text: snapshot.text.slice(sentence.start, sentence.end), startOffset: offset + start - sentence.start, endOffset: offset + end - sentence.start };

  return undefined;
}
export function createSentenceContextResolver(policy: ReadingPolicy = "automatic"): (node: Text, start: number, end: number) => SentenceContext | undefined {
  const snapshots = new WeakMap<Node, ContextSnapshot>();
  return (node, start, end) => {
    const boundary = boundaryFor(node);
    let snapshot = snapshots.get(boundary);
    if (!snapshot) { snapshot = { text: '', segments: new WeakMap(), sentences: [] }; for (const _ of snapshotSteps(boundary, snapshot, policy)) { /* synchronous manual selection */ } for (const _ of sentenceSteps(snapshot)) { /* one immutable sentence index per boundary */ } snapshots.set(boundary, snapshot); }
    return resolve(snapshot, boundary, node, start, end);
  };
}
export function createAsyncSentenceContextResolver(shouldContinue: () => boolean = () => true): (node: Text, start: number, end: number) => Promise<SentenceContext | undefined> {
  const snapshots = new WeakMap<Node, Promise<ContextSnapshot>>();
  const boundaries = new WeakMap<Text, Node>();
  return async (node, start, end) => {
    let boundary = boundaries.get(node);
    if (!boundary) { boundary = boundaryFor(node); boundaries.set(node, boundary); }
    let promise = snapshots.get(boundary);
    if (!promise) {
      promise = (async () => {
        const snapshot: ContextSnapshot = { text: '', segments: new WeakMap(), sentences: [] }; let began = performance.now();
        for (const _ of snapshotSteps(boundary!, snapshot)) {
          if (!shouldContinue()) break;
          if (performance.now() - began >= 8) { await yieldToPage(); began = performance.now(); }
        }
        for (const _ of sentenceSteps(snapshot)) { if (!shouldContinue()) break; if (performance.now() - began >= 8) { await yieldToPage(); began = performance.now(); } }
        return snapshot;
      })();
      snapshots.set(boundary, promise);
    }
    const snapshot = await promise;
    return shouldContinue() ? resolve(snapshot, boundary, node, start, end) : undefined;
  };
}
