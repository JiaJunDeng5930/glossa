import { createContentMessage } from '../shared/messages';
import type { BackgroundResponseMessage, ContentToBackgroundMessage } from '../shared/types';
import { userMessageForError } from '../shared/userMessages';
import type { CardFeedback, GlossOverlay } from './overlay';
import { occurrencesFor } from './occurrence';
import type { ScannedToken } from './scanner';
import type { WordSelection } from './selection';

type TerminalFeedback = Exclude<CardFeedback, 'card-pending' | 'card-cancelled'>;
type OperationState = { phase: 'requesting' | 'confirming' | 'submittingDuplicate' } | { phase: 'awaitingPresentation'; feedback: TerminalFeedback; message?: string } | { phase: 'cancelled' };
interface CardOperation { token: ScannedToken; state: OperationState }
interface CardOperationDependencies {
  document: Document;
  overlay: GlossOverlay;
  request(message: ContentToBackgroundMessage): Promise<BackgroundResponseMessage>;
  prompt(input: { surface: string; timeoutMs: number }): Promise<boolean>;
  cancelPrompt(): void;
  onError(error: unknown): void;
  errorMessage(error: unknown): string;
}
/** Cancellation owns every continuation, including the duplicate prompt and retry request. */
export function createCardOperations(dependencies: CardOperationDependencies) {
  const operations = new Map<string, CardOperation>();
  const registry = occurrencesFor(dependencies.document);
  function valid(operation: CardOperation): boolean {
    if (operation.state.phase === 'cancelled' || operations.get(operation.token.id) !== operation) return false;
    if (registry.valid(operation.token)) return true;
    dependencies.overlay.applyCardFeedback({ tokenId: operation.token.id, feedback: 'card-cancelled' });
    const confirming = operation.state.phase === 'confirming';
    remove(operation);
    if (confirming) dependencies.cancelPrompt();
    return false;
  }
  function remove(operation: CardOperation): void { operation.state = { phase: 'cancelled' }; operations.delete(operation.token.id); }
  function present(operation: CardOperation, token = operation.token): void {
    if (!valid(operation)) return;
    const state = operation.state;
    if (state.phase === 'cancelled') return;
    const feedback = state.phase === 'awaitingPresentation' ? state.feedback : 'card-pending';
    const result = dependencies.overlay.applyCardFeedback({ tokenId: token.id, token, feedback, ...(state.phase === 'awaitingPresentation' && state.message ? { message: state.message } : {}) });
    if (state.phase === 'awaitingPresentation' && result.result !== 'skipped') remove(operation);
  }
  function finish(operation: CardOperation, response: BackgroundResponseMessage): void {
    if (!valid(operation)) return;
    const created = response.type === 'word.clicked.ok' && typeof response.payload.noteId === 'number';
    operation.state = { phase: 'awaitingPresentation', feedback: created ? 'card-success' : response.type === 'error' && response.payload.reason === 'outcome-unknown' ? 'card-unknown' : 'card-error', ...(response.type === 'error' ? { message: userMessageForError(response.payload, 'anki') } : {}) };
    present(operation);
  }
  return {
    async start(selection: WordSelection, pageUrl: string): Promise<void> {
      const token = selection.renderToken;
      if (!token || !registry.valid(token)) return;
      const existing = operations.get(token.id);
      if (existing && valid(existing)) { present(existing, token); return; }
      const request = createContentMessage('word.clicked', { pageUrl, sentence: selection.sentence, token: selection.token });
      const operation: CardOperation = { token, state: { phase: 'requesting' } };
      operations.set(token.id, operation); present(operation);
      try {
        const response = await dependencies.request(request);
        if (!valid(operation)) return;
        if (response.type !== 'word.card.duplicate') { finish(operation, response); return; }
        operation.state = { phase: 'confirming' };
        const confirmed = await dependencies.prompt({ surface: response.payload.surface, timeoutMs: response.payload.promptMs });
        if (!valid(operation)) return;
        if (!confirmed) { dependencies.overlay.applyCardFeedback({ tokenId: token.id, feedback: 'card-cancelled' }); remove(operation); return; }
        operation.state = { phase: 'submittingDuplicate' };
        const retried = await dependencies.request(createContentMessage('word.clicked', { ...request.payload, allowDuplicateCard: true }));
        finish(operation, retried);
      } catch (error) {
        if (!valid(operation)) return;
        operation.state = { phase: 'awaitingPresentation', feedback: 'card-error', message: dependencies.errorMessage(error) };
        present(operation); dependencies.onError(error);
      }
    },
    replay(token: ScannedToken): void { const operation = operations.get(token.id); if (operation) present(operation, token); },
    cancelAll(): void {
      for (const operation of operations.values()) { dependencies.overlay.applyCardFeedback({ tokenId: operation.token.id, feedback: 'card-cancelled' }); operation.state = { phase: 'cancelled' }; }
      operations.clear(); dependencies.cancelPrompt();
    }
  };
}
