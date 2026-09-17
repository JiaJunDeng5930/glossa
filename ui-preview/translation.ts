import { createGlossOverlay } from '../src/content/overlay';
import { scanDocumentTextInChunks } from '../src/content/scanner';
import { promptDuplicateCardCreation } from '../src/content/duplicateCardPrompt';
const overlay = createGlossOverlay(document);
await scanDocumentTextInChunks(document, new Set(), {}, (chunk) => {
  for (const token of chunk.tokens) {
    const base = { scanId: 'preview', tokenId: token.id };
    if (token.surface === 'distributed' || token.surface === 'nuanced') {
      overlay.applyTokenOutcome(token, { ...base, status: 'ready', item: { tokenId: token.id, targetText: token.surface, display: token.surface === 'distributed' ? '分布式' : '细致' } }, token.scanVersion);
      if (token.surface === 'nuanced') overlay.applyCardFeedback({ tokenId: token.id, feedback: 'card-success' });
    } else if (token.surface === 'pending') {
      overlay.applyTokenOutcome(token, { ...base, status: 'pending' }, token.scanVersion);
      overlay.applyCardFeedback({ tokenId: token.id, feedback: 'card-pending' });
    } else if (token.surface === 'unavailable') {
      overlay.applyTokenOutcome(token, { ...base, status: 'error', error: { reason: 'network', message: 'Preview service unavailable', service: 'ai' } }, token.scanVersion);
    }
  }
});
overlay.setSelectionMode(true);
void promptDuplicateCardCreation(document, { surface: 'archive', timeoutMs: 2_000_000_000 });
