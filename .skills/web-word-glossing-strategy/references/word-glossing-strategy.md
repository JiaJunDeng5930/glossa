# Word Glossing Strategy

## Purpose

Use this reference when implementing or reviewing unknown-word detection, lemma filtering, vocabulary state transitions, gloss caching, inline rendering, diagnostics, or tests for Glossa.

## Pipeline

Use this order:

1. Extract visible text surfaces from the DOM.
2. Tokenize English words with DOM offsets preserved.
3. Normalize token to lemma or lookup form.
4. Filter known, ignored, ineligible, and unsafe candidates.
5. Score and dedupe candidates.
6. Request or reuse glosses through background.
7. Verify the source DOM is still current.
8. Render inline glosses.
9. Update vocabulary state after display and user interaction.

Keep each stage observable and testable.

## Tokenization

Tokenize from text-node content with offsets:

- Include alphabetic English words and contractions when the project supports them.
- Keep hyphenated compounds configurable; many pages contain product names and code-like tokens.
- Reject URLs, emails, handles, hashtags, file paths, CSS fragments, hex values, long identifiers, all-caps acronyms, and mostly numeric tokens.
- Reject tokens shorter than the configured minimum length unless the lemma is explicitly eligible.
- Preserve casing and original surface text for rendering.

Return token records like:

```ts
type WordCandidate = {
  id: string;
  surface: string;
  lemma: string;
  textNode: Text;
  startOffset: number;
  endOffset: number;
  sentenceContext: string;
  paragraphContext: string;
  sourceFingerprint: string;
  scanVersion: number;
};
```

## Unknown-Word Eligibility

Apply filters in this order:

1. Source language: process English text only unless the product adds a new language path.
2. Shape: reject non-word and code-like tokens.
3. Lemma: normalize plural, tense, and common inflections before lookup.
4. Known list: reject words from selected known-word presets.
5. User state: reject `known` and `ignored`; allow eligible `candidate` and active learning states.
6. Frequency cap: limit repeated labels for the same lemma on the same page.
7. Context quality: require enough sentence or nearby text for a useful gloss.
8. UI safety: require renderable range rects and enough horizontal or vertical space for the chosen label style.

Treat user vocabulary state as stronger than automatic known-word presets.

## Candidate Scoring

Prefer candidates that are useful and unobtrusive:

- Higher score for words repeated in meaningful body text.
- Higher score for words in article paragraphs than navigation or controls.
- Higher score for active learning words that have not expired.
- Lower score for links, buttons, captions, tables of numbers, and UI chrome.
- Lower score for dense clusters where labels would overwhelm the paragraph.

Set per-container and per-viewport limits. A page with many unfamiliar words should show a controlled number of labels.

## Batch And Cache Strategy

Batch background requests by lemma and context:

- Dedupe same lemma within a page scan.
- Cache glosses by normalized lemma, target language, prompt/settings version, provider, and relevant known context policy.
- Include sentence context for AI quality, but keep cache key stable enough to reuse across similar pages when intended.
- Use request IDs so render callbacks can be traced back to DOM candidates.

For privacy, send only the word and bounded context needed for gloss quality.

## Vocabulary State

Use deterministic state transitions:

- `candidate`: word detected as eligible but not yet actively studied.
- `known`: word should stay hidden.
- `learning_active`: user clicked or accepted the word for active learning and it remains eligible until `expiresAt`.
- `ignored`: user explicitly suppressed the word.

Recommended transitions:

- Displayed gloss can promote `candidate` toward `known` according to product policy.
- User click can set `learning_active` and refresh `expiresAt`.
- Expired `learning_active` can become `known`.
- User ignore action sets `ignored` and wins over automatic detection.

Keep transitions in `src/core/*` or storage-facing code, not in DOM rendering code.

## Rendering Strategy

Render as a small, removable annotation:

- Preserve the original word text.
- Add a wrapper or adjacent label with `data-glossa-owned="1"`, `translate="no"`, and `notranslate`.
- Store original text and candidate id for cleanup.
- Avoid changing surrounding whitespace.
- Avoid labels inside editable text, code, or controls.
- Collapse or suppress labels in dense clusters.
- Support removal when the page is restored, settings change, or vocabulary state changes.

For a word in the middle of a text node, use `Range` or split text nodes carefully. After splitting, invalidate remaining candidates from the original text node and rescan the container to prevent offset drift.

## Dynamic Page Strategy

For every candidate request:

- Record scan version, text-node identity, offsets, original surface, lemma, and source fingerprint.
- On result, verify the node is connected and current.
- Confirm the range text still equals the candidate surface.
- Confirm the range has visible rects.
- Confirm no existing label owns the same candidate id.
- Render only after all checks pass.

If verification fails, drop the result and let the next scan produce a fresh candidate.

## User Interaction

Keep interactions local and explicit:

- Click or hover can open a detailed gloss popover.
- A known/ignore action should update vocabulary state through background and remove matching labels on the current page.
- Selection mode should avoid fighting automatic labels.
- Keyboard shortcuts should use the shared shortcut matcher.

Do not make AI or Anki calls directly from content script.

## Diagnostics

Log structured events for:

- scan start and end
- candidate extraction
- filter counts by reason
- background request and response
- cache hit or miss
- render success
- stale DOM skip
- duplicate skip
- state transition

Include component, operation, request ID, tab/frame/document fields when available, sanitized URL, candidate count, lemma count, and elapsed time. Avoid logging page body or full sentence context unless a local debug mode explicitly enables it.

## Test Matrix

Cover these cases:

- Static paragraph with one unknown word.
- Paragraph with repeated same lemma.
- Known-list word remains hidden.
- `ignored` word remains hidden.
- `learning_active` word appears until expiry.
- Code block, editable field, button, and navigation stay unannotated.
- Hidden `display:none`, `visibility:hidden`, `opacity:0`, and zero-rect text stay unannotated.
- Dynamic paragraph replacement discards stale async result.
- Repeated scanner run creates no duplicate labels.
- Long page scans viewport-proximate content first.
- Same-origin iframe and open shadow root behavior is intentional.
- Cache hit still verifies DOM before rendering.
- User action updates state and removes labels for that lemma.
