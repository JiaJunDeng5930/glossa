import { afterEach, expect, it, vi } from 'vitest';
import { createCardOperations } from '../../src/content/cardOperations';
import { createBackgroundResponse } from '../../src/shared/messages';
import type { BackgroundResponseMessage, ContentToBackgroundMessage } from '../../src/shared/types';
import { renderWord } from './fixtures';
const originalRects = Range.prototype.getClientRects;
afterEach(() => { Range.prototype.getClientRects = originalRects; });

it('cancels a late duplicate response before it can open a prompt or retry', async () => {
  document.body.innerHTML = '<p>A novel archive appears.</p>';
  const { token, overlay } = renderWord(document.querySelector('p')!.firstChild as Text, 'novel');
  let respond!: (value: BackgroundResponseMessage) => void;
  let request!: ContentToBackgroundMessage;
  const prompt = vi.fn(async () => true);
  const send = vi.fn((message: ContentToBackgroundMessage) => { request = message; return new Promise<BackgroundResponseMessage>(resolve => { respond = resolve; }); });
  const operations = createCardOperations({ document, overlay, request: send, prompt, cancelPrompt: vi.fn(), onError: vi.fn(), errorMessage: String });
  const running = operations.start({ token, renderToken: token, sentence: token.sentenceText }, 'https://example.test/original');
  operations.cancelAll();
  if (request.type !== 'word.clicked') throw new Error('Expected word request');
  respond(createBackgroundResponse(request, 'word.card.duplicate', { lang: 'en', lemma: 'novel', surface: 'novel', promptMs: 5000 }));
  await running;
  expect(prompt).not.toHaveBeenCalled(); expect(send).toHaveBeenCalledTimes(1);
  expect(document.querySelector('[data-glossa-feedback]')).toBeNull();
});

it('invalidates an already open confirmation before its continuation can submit a retry', async () => {
  document.body.innerHTML = '<p>A novel archive appears.</p>';
  const { token, overlay } = renderWord(document.querySelector('p')!.firstChild as Text, 'novel');
  let confirm!: (value: boolean) => void;
  const send = vi.fn(async (request: ContentToBackgroundMessage) => {
    if (request.type !== 'word.clicked') throw new Error('Expected word request');
    return createBackgroundResponse(request, 'word.card.duplicate', { lang: 'en', lemma: 'novel', surface: 'novel', promptMs: 5000 });
  });
  const prompt = vi.fn(() => new Promise<boolean>(resolve => { confirm = resolve; }));
  const operations = createCardOperations({ document, overlay, request: send, prompt, cancelPrompt: vi.fn(), onError: vi.fn(), errorMessage: String });
  const running = operations.start({ token, renderToken: token, sentence: token.sentenceText }, 'https://example.test/original');
  await Promise.resolve(); expect(prompt).toHaveBeenCalledOnce();
  operations.cancelAll(); confirm(true); await running;
  expect(send).toHaveBeenCalledTimes(1);
});

it('releases an invalid pending operation so a new snapshot at the same occurrence can be submitted', async () => {
  Range.prototype.getClientRects = () => [{ width: 20, height: 10 }] as unknown as DOMRectList;
  document.body.innerHTML = '<p>A novel archive appears.</p>';
  const { token, overlay } = renderWord(document.querySelector('p')!.firstChild as Text, 'novel');
  const pending: Array<{ request: ContentToBackgroundMessage; resolve(value: BackgroundResponseMessage): void }> = [];
  const send = vi.fn((request: ContentToBackgroundMessage) => new Promise<BackgroundResponseMessage>(resolve => { pending.push({ request, resolve }); }));
  const operations = createCardOperations({ document, overlay, request: send, prompt: vi.fn(async () => false), cancelPrompt: vi.fn(), onError: vi.fn(), errorMessage: String });
  const first = operations.start({ token, renderToken: token, sentence: token.sentenceText }, 'https://example.test/original');
  document.querySelector('p')!.firstChild!.textContent = 'The ';
  overlay.pruneDisconnected();
  const { scanDocumentTextInChunks } = await import('../../src/content/scanner');
  const scanned: import('../../src/content/scanner').ScannedToken[] = [];
  await scanDocumentTextInChunks(document, new Set(), {}, chunk => { scanned.push(...chunk.tokens); });
  const replacement = scanned.find(candidate => candidate.surface === 'novel')!;
  expect(replacement.id).toBe(token.id);
  const selection = { token: replacement, renderToken: replacement, sentence: replacement.sentenceText };
  const second = operations.start(selection, 'https://example.test/original');
  expect(send).toHaveBeenCalledTimes(2);
  await operations.start(selection, 'https://example.test/original');
  expect(send).toHaveBeenCalledTimes(2);
  for (const item of pending) {
    if (item.request.type !== 'word.clicked') throw new Error('Expected word request');
    item.resolve(createBackgroundResponse(item.request, 'word.clicked.ok', { noteId: 123 }));
  }
  await Promise.all([first, second]);
});
