import type { ScannedToken } from './scanner';
import { createSentenceContextResolver } from './context';
import type { ReadingPolicy } from './readability';

interface Segment { node: Text; start: number; end: number }
interface Source { segments: Segment[]; occurrences: Map<string, string> }
interface Slice { source: Source; start: number; end: number }
export interface SourceHandles { wrapper: HTMLElement; surface: HTMLElement }
const registries = new WeakMap<Document, OccurrenceRegistry>();

/** One registry owns occurrence identity and every source segment created by wrapping. */
export function occurrencesFor(doc: Document): OccurrenceRegistry {
  let registry = registries.get(doc);
  if (!registry) { registry = new OccurrenceRegistry(doc); registries.set(doc, registry); }
  return registry;
}

export class OccurrenceRegistry {
  private sequence = 0;
  private slices = new WeakMap<Text, Slice>();
  private tokens = new Map<string, ScannedToken>();
  private handles = new Map<string, SourceHandles>();
  private wrappers = new WeakMap<Node, string>();
  private expectedMutations: MutationRecord[] = [];
  private mutationObserver: MutationObserver;
  private roots = new WeakSet<Node>();
  private sourceRevision = 0;
  private verifiedRevisions = new WeakMap<ScannedToken, number>();
  private contextResolvers = new Map<ReadingPolicy, ReturnType<typeof createSentenceContextResolver>>();
  constructor(private doc: Document) {
    this.mutationObserver = new MutationObserver((records) => this.invalidateContexts(records));
    this.observe(doc);
  }
  observe(root: Node): void {
    if (this.roots.has(root)) return;
    this.roots.add(root);
    this.mutationObserver.observe(root, { subtree: true, childList: true, characterData: true });
  }
  mutate<T>(operation: () => T): T {
    this.invalidateContexts(this.mutationObserver.takeRecords());
    try { return operation(); }
    finally {
      const records = this.mutationObserver.takeRecords();
      this.expectedMutations.push(...records);
      // Context text is unchanged by our wrappers, but their Text handles have changed.
      if (records.length) this.contextResolvers.clear();
    }
  }
  ownsMutation(record: MutationRecord): boolean {
    const index = this.expectedMutations.findIndex((expected) => expected.target === record.target
      && expected.type === record.type && expected.attributeName === record.attributeName
      && sameNodes(expected.addedNodes, record.addedNodes) && sameNodes(expected.removedNodes, record.removedNodes));
    if (index < 0) return false;
    this.expectedMutations.splice(index, 1);
    return true;
  }
  slice(node: Text, start: number, end: number): Slice {
    let slice = this.slices.get(node);
    if (!slice) {
      const source: Source = { segments: [{ node, start: 0, end: node.length }], occurrences: new Map() };
      slice = { source, start: 0, end: node.length };
      this.slices.set(node, slice);
    }
    this.synchronizeSource(slice.source);
    return { source: slice.source, start: slice.start + start, end: slice.start + end };
  }
  private synchronizeSource(source: Source): void {
    if (!source.segments.some(segment => segment.end - segment.start !== (segment.node.isConnected ? segment.node.length : 0))) return;
    const prior = source.segments.map(segment => ({ start: segment.start, end: segment.end }));
    let offset = 0;
    for (const segment of source.segments) {
      segment.start = offset;
      segment.end = offset + (segment.node.isConnected ? segment.node.length : 0);
      const slice = this.slices.get(segment.node);
      if (slice) { slice.start = segment.start; slice.end = segment.end; }
      offset = segment.end;
    }
    // A preceding segment can grow without replacing a wrapped occurrence's source node.
    // Carry its identity along with that node rather than treating the shifted coordinate as a new occurrence.
    const relocated = new Map<string, string>();
    for (const [key, id] of source.occurrences) {
      const [start, end, surface] = JSON.parse(key) as [number, number, string];
      const index = prior.findIndex(segment => start >= segment.start && end <= segment.end);
      if (index < 0) continue;
      const shift = source.segments[index]!.start - prior[index]!.start;
      relocated.set(JSON.stringify([start + shift, end + shift, surface]), id);
    }
    source.occurrences = relocated;
  }
  private invalidateContexts(records: MutationRecord[]): void {
    if (!records.length) return;
    this.sourceRevision++;
    this.contextResolvers.clear();
  }
  identify(node: Text, start: number, end: number, surface: string): string {
    const slice = this.slice(node, start, end);
    const key = JSON.stringify([slice.start, slice.end, surface]);
    let id = slice.source.occurrences.get(key);
    if (!id) { id = `occurrence:${++this.sequence}`; slice.source.occurrences.set(key, id); }
    return id;
  }
  register(token: ScannedToken): ScannedToken {
    if (this.verifiedRevisions.has(token)) return token;
    this.invalidateContexts(this.mutationObserver.takeRecords());
    this.slice(token.textNode, 0, token.textNode.length);
    const slice = this.slice(token.textNode, token.nodeStartOffset, token.nodeEndOffset);
    if (token.sourceFingerprint === fingerprint(token.textNode.data, token.nodeStartOffset, token.nodeEndOffset)) {
      const current = this.sourcePosition(slice);
      token.sourceFingerprint = fingerprint(current.text, current.start, current.end);
    }
    this.tokens.set(token.id, token);
    this.verifiedRevisions.set(token, this.sourceRevision);
    return Object.freeze(token);
  }
  token(id: string): ScannedToken | undefined { return this.tokens.get(id); }
  handlesFor(id: string): SourceHandles | undefined { return this.handles.get(id); }
  findFromNode(node: Node): ScannedToken | undefined {
    let current: Node | null = node;
    while (current) { const id = this.wrappers.get(current); if (id) return this.tokens.get(id); current = current.parentNode; }
    return undefined;
  }
  sourceScaffold(element: Element): boolean {
    const token = this.findFromNode(element);
    const handles = token && this.handles.get(token.id);
    return !!handles && (element === handles.wrapper || element === handles.surface || handles.surface.contains(element));
  }
  currentSource(id: string): string | undefined {
    const handles = this.handles.get(id);
    return handles?.wrapper.contains(handles.surface) ? handles.surface.textContent ?? '' : undefined;
  }
  locate(token: ScannedToken): { node: Text; start: number; end: number } | undefined {
    const slice = this.slice(token.textNode, token.nodeStartOffset, token.nodeEndOffset);
    const segment = slice.source.segments.find((part) => part.node.isConnected && part.start <= slice.start && part.end >= slice.end);
    if (!segment) return undefined;
    const start = slice.start - segment.start;
    const end = slice.end - segment.start;
    if (segment.node.data.slice(start, end) !== token.surface) return undefined;
    return { node: segment.node, start, end };
  }
  valid(token: ScannedToken): boolean {
    this.invalidateContexts(this.mutationObserver.takeRecords());
    const handles = this.handles.get(token.id);
    if (handles && (!handles.wrapper.isConnected || this.currentSource(token.id) !== token.surface)) return false;
    const location = this.locate(token);
    if (!location) return false;
    const slice = this.slice(token.textNode, token.nodeStartOffset, token.nodeEndOffset);
    const current = this.sourcePosition(slice);
    if (fingerprint(current.text, current.start, current.end) !== token.sourceFingerprint) return false;
    if (this.verifiedRevisions.get(token) !== this.sourceRevision) {
      const policy = token.readingPolicy ?? "automatic";
      let resolve = this.contextResolvers.get(policy);
      if (!resolve) { resolve = createSentenceContextResolver(policy); this.contextResolvers.set(policy, resolve); }
      const context = resolve(location.node, location.start, location.end);
      if (!context || context.text !== token.sentenceText || context.startOffset !== token.startOffset || context.endOffset !== token.endOffset) return false;
      this.verifiedRevisions.set(token, this.sourceRevision);
    }
    return true;
  }
  private sourcePosition(slice: Slice): { text: string; start: number; end: number } {
    let text = '', start = slice.start, end = slice.end;
    for (const part of slice.source.segments) {
      if (slice.start >= part.start && slice.start < part.end) start = text.length + slice.start - part.start;
      if (slice.end > part.start && slice.end <= part.end) end = text.length + slice.end - part.start;
      text += part.node.isConnected ? part.node.data : '';
    }
    return { text, start, end };
  }

  wrap(token: ScannedToken, handles: SourceHandles): boolean {
    const location = this.locate(token);
    if (!location || !this.valid(token)) return false;
    const { node, start, end } = location;
    const parent = node.parentNode;
    if (!parent) return false;
    const slice = this.slice(node, 0, node.length);
    const old = slice.source.segments.find((part) => part.node === node)!;
    const before = this.doc.createTextNode(node.data.slice(0, start));
    const surface = this.doc.createTextNode(node.data.slice(start, end));
    const after = this.doc.createTextNode(node.data.slice(end));
    const next: Segment[] = [
      { node: before, start: old.start, end: old.start + start },
      { node: surface, start: old.start + start, end: old.start + end },
      { node: after, start: old.start + end, end: old.end }
    ];
    for (const part of next) this.slices.set(part.node, { source: slice.source, start: part.start, end: part.end });
    slice.source.segments.splice(slice.source.segments.indexOf(old), 1, ...next);
    this.handles.set(token.id, handles);
    this.wrappers.set(handles.wrapper, token.id);
    this.mutate(() => { handles.surface.append(surface); const fragment = this.doc.createDocumentFragment(); fragment.append(before, handles.wrapper, after); parent.replaceChild(fragment, node); });
    return true;
  }
  unwrap(id: string): void {
    const handles = this.handles.get(id);
    if (!handles) return;
    this.mutate(() => {
      if (handles.wrapper.parentNode) {
        const fragment = this.doc.createDocumentFragment();
        // Move the current source children; snapshots must never resurrect text overwritten by the page.
        if (handles.wrapper.contains(handles.surface)) fragment.append(...Array.from(handles.surface.childNodes));
        handles.wrapper.replaceWith(fragment);
      }
    });
    this.handles.delete(id);
    this.wrappers.delete(handles.wrapper);
  }
}
function sameNodes(a: NodeList, b: NodeList): boolean { return a.length === b.length && Array.from(a).every((node, i) => node === b[i]); }
export function fingerprint(text: string, start: number, end: number): string {
  let hash = 2166136261;
  const value = `${text.slice(Math.max(0, start - 16), start)}|${text.slice(start, end)}|${text.slice(end, end + 16)}`;
  for (let i = 0; i < value.length; i++) { hash ^= value.charCodeAt(i); hash = Math.imul(hash, 16777619); }
  return `${start}:${end}:${(hash >>> 0).toString(36)}`;
}
