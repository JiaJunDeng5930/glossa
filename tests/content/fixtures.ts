import { createSentenceContextResolver } from '../../src/content/context';
import { createGlossOverlay } from '../../src/content/overlay';
import { createSourceFingerprint, type ScannedToken } from '../../src/content/scanner';
import { occurrencesFor } from '../../src/content/occurrence';
export function renderWord(node: Text, surface: string) {
  const registry = occurrencesFor(node.ownerDocument);
  const start = node.data.indexOf(surface), end = start + surface.length;
  const context = createSentenceContextResolver()(node, start, end)!;
  const token: ScannedToken = { id: registry.identify(node, start, end, surface), sentenceId: 'fixture', surface, lemma: surface.toLowerCase(), startOffset: context.startOffset, endOffset: context.endOffset, textNode: node, nodeStartOffset: start, nodeEndOffset: end, sentenceText: context.text, sourceFingerprint: createSourceFingerprint(node.data, start, end), scanVersion: 1 };
  const original = Range.prototype.getClientRects;
  Range.prototype.getClientRects = () => [{ width: 20, height: 10 }] as unknown as DOMRectList;
  const overlay = createGlossOverlay(node.ownerDocument);
  registry.register(token);
  overlay.applyTokenOutcome(token, { scanId: 'fixture', tokenId: token.id, status: 'ready', item: { tokenId: token.id, display: '释义', targetText: surface } }, 1);
  Range.prototype.getClientRects = original;
  return { token, overlay, wrapper: registry.handlesFor(token.id)!.wrapper, surface: registry.handlesFor(token.id)!.surface };
}
