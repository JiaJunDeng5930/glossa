import { describe, expect, it } from 'vitest';
import { occurrencesFor } from '../../src/content/occurrence';
import { scanDocumentTextInChunks } from '../../src/content/scanner';
import { renderWord } from './fixtures';

describe('source occurrences', () => {
  it('rejects late outcomes after page edits and unwraps the current source nodes', () => {
    document.body.innerHTML = '<p>A novel archive appears.</p>';
    const { token, overlay, surface } = renderWord(document.querySelector('p')!.firstChild as Text, 'novel');
    surface.firstChild!.textContent = 'changed';
    const emphasis = document.createElement('em'); emphasis.textContent = ' addition'; surface.append(emphasis);
    for (const status of ['ready', 'hidden', 'error'] as const) {
      const outcome = status === 'ready' ? { status, item: { tokenId: token.id, display: '旧', targetText: 'novel' } }
        : status === 'error' ? { status, error: { reason: 'runtime' as const, message: 'old' } } : { status };
      expect(overlay.applyTokenOutcome(token, { scanId: 'old', tokenId: token.id, ...outcome }, 1)).toMatchObject({ result: 'skipped', reason: 'changed-text' });
    }
    overlay.clear();
    expect(document.querySelector('p')!.textContent).toBe('A changed addition archive appears.');
    expect(document.querySelector('em')).toBe(emphasis);
  });

  it('distinguishes identical adjacent text nodes and identical shadow trees', async () => {
    document.body.innerHTML = '<main><p></p><article></article><article></article></main>';
    document.querySelector('p')!.append(document.createTextNode('Novel archive. '), document.createTextNode('Novel archive.'));
    for (const host of document.querySelectorAll('article')) host.attachShadow({ mode: 'open' }).innerHTML = '<p>Novel archive.</p>';
    const ids: string[] = [];
    await scanDocumentTextInChunks(document, new Set(), { maxOccurrencesPerLemma: 10 }, chunk => { ids.push(...chunk.tokens.map(token => token.id)); });
    expect(ids).toHaveLength(8); expect(new Set(ids).size).toBe(8);
  });

  it('recognizes exact wrapper mutations without swallowing external mutations on the same parent', () => {
    document.body.innerHTML = '<p>A novel archive appears.</p>';
    const observer = new MutationObserver(() => {});
    observer.observe(document.body, { subtree: true, childList: true, characterData: true });
    const { overlay, surface } = renderWord(document.querySelector('p')!.firstChild as Text, 'novel');
    const own = observer.takeRecords();
    document.querySelector('p')!.append(' external');
    surface.firstChild!.textContent = 'changed';
    const external = observer.takeRecords();
    expect(own.length).toBeGreaterThan(0);
    expect(own.every(record => overlay.ownsMutation(record))).toBe(true);
    expect(external.some(record => overlay.ownsMutation(record))).toBe(false);
    observer.disconnect();
  });

  it('preserves occurrence identity and source validity through wrapping and clearing', () => {
    document.body.innerHTML = '<p>A novel archive appears.</p>';
    const { token, overlay, surface } = renderWord(document.querySelector('p')!.firstChild as Text, 'novel');
    const source = surface.firstChild as Text;
    const registry = occurrencesFor(document);
    expect(registry.identify(source, 0, source.length, 'novel')).toBe(token.id);
    overlay.clear();
    expect(source.isConnected).toBe(true);
    expect(registry.valid(token)).toBe(true);
  });
});

it('locates appended words after an existing Text node grows between scans', async () => {
  document.body.innerHTML = '<p>Novel.</p>';
  const node = document.querySelector('p')!.firstChild as Text;
  await scanDocumentTextInChunks(document, new Set(), { minContextChars: 1 }, () => {});
  node.appendData(' extraordinary');
  const tokens: import('../../src/content/scanner').ScannedToken[] = [];
  await scanDocumentTextInChunks(document, new Set(), { minContextChars: 1 }, chunk => { tokens.push(...chunk.tokens); });
  const appended = tokens.find(token => token.surface === 'extraordinary')!;
  expect(appended).toBeDefined();
  expect(occurrencesFor(document).locate(appended)).toMatchObject({ node, start: 7, end: 20 });
  expect(occurrencesFor(document).valid(appended)).toBe(true);
});

it('rejects a pending result when another inline node changes its sentence context', () => {
  document.body.innerHTML = '<p>She deposited money in a <em>bank</em> today.</p>';
  const { token, overlay } = renderWord(document.querySelector('em')!.firstChild as Text, 'bank');
  overlay.applyTokenOutcome(token, { scanId: 'old', tokenId: token.id, status: 'pending' }, 1);
  document.querySelector('p')!.firstChild!.textContent = 'She walked along the river ';
  const result = overlay.applyStalePendingOutcome({ scanId: 'old', tokenId: token.id, status: 'ready', item: { tokenId: token.id, display: '银行', targetText: 'bank' } });
  expect(result).toMatchObject({ result: 'skipped', reason: 'changed-text' });
  overlay.clear();
  expect(document.querySelector('p')!.textContent).toBe('She walked along the river bank today.');
});
