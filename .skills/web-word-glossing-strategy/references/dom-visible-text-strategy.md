# DOM Visible Text Strategy

## Purpose

Use this reference when implementing or reviewing webpage scanning, visible-text extraction, DOM observers, range mapping, or stale-result prevention for Glossa's content script.

## Completion Standard

A scanner is acceptable when it can identify readable text on a representative dynamic page, skip excluded and hidden content, survive repeated rescans, and render no stale or duplicate annotations after DOM replacement.

## Page Readiness

Start scanning after a lightweight readiness gate:

- Wait until `document.body` exists.
- Require enough readable body text before automatic full-page work, unless the user invoked a direct action.
- Use a bounded timeout for pages that stream content slowly.
- Record scan reason: initial load, manual trigger, scroll visibility, mutation, URL change, frame attach, or shadow-root attach.

Keep the gate permissive for explicit user actions and stricter for automatic scanning.

## DOM Scope Selection

Prefer a scoped surface over the entire document:

- Use site-specific selectors when available.
- Prefer `article`, `main`, and large readable containers when they exist.
- Include comments, feeds, and cards only when the feature is expected to annotate them.
- Avoid global navigation, sidebars, footers, share bars, cookie banners, modals, and extension UI.

For Glossa, word glossing may need more page regions than paragraph translation. Keep the scanner configurable so article-only mode and body-wide mode are separate settings.

## Exclusion Rules

Reject a node or subtree when any ancestor matches:

- `script`, `style`, `noscript`, `template`, `svg`, `canvas`, `math`, `textarea`, `select`, `option`, `pre`, `kbd`, or code-oriented custom elements.
- `[contenteditable="true"]`, editable form controls, active compose boxes, and rich text editors.
- `.notranslate`, `.imt-notranslate`, `[translate="no"]`, `[aria-hidden="true"]` when used as decorative text, or project-specific no-gloss selectors.
- Glossa-owned wrappers, labels, portals, popovers, and Shadow DOM roots.
- Syntax highlighters, code blocks, terminal blocks, diff views, and PDF text layers unless a dedicated mode exists.

Use a single predicate for subtree exclusion and reuse it in initial scans and mutation scans.

## Visibility Rules

Use browser layout data, then text semantics:

- Reject elements with `display: none`, `visibility: hidden`, `opacity: 0`, or `content-visibility: hidden`.
- Reject text whose nearest rendered ancestor has both near-zero width and near-zero height.
- Reject text nodes inside collapsed containers, detached nodes, or nodes outside the current document.
- Prefer `innerText`-equivalent behavior for block-level text decisions, because it tracks rendered text better than raw `textContent`.
- Use `Range.getClientRects()` for final word candidate validation. A candidate with no rects is not currently renderable.

`Range.getClientRects()` is the strongest local check before rendering a word gloss. It catches many cases where an ancestor appears visible but the specific text run has no rendered box.

## Traversal Pattern

Traverse with `TreeWalker` over text and elements:

1. On element entry, compute and cache relevant style for the current scan pass.
2. Reject excluded subtrees early.
3. For text nodes, trim and reject empty or whitespace-only content.
4. Split work into containers so long pages do not block the main thread.
5. Yield periodically with a scheduler or small timeout after a fixed number of nodes.

Keep scanner output DOM-grounded:

```ts
type TextSurface = {
  textNode: Text;
  startOffset: number;
  endOffset: number;
  text: string;
  rects: DOMRectReadOnly[];
  container: Element;
  scanVersion: number;
};
```

## Container And Viewport Scheduling

Use viewport scheduling for long pages:

- Scan immediately around the current viewport and a small margin below it.
- Observe candidate containers with `IntersectionObserver`.
- Scan deferred containers when they approach the viewport.
- Use `ResizeObserver` for containers that were hidden, collapsed, or empty during the first pass.

Avoid inserting loading placeholders for word glossing. Word-level glosses should appear only after a resolved candidate is ready to render.

## Dynamic DOM Handling

Use one `MutationObserver` per document or shadow root:

- Observe `childList`, `subtree`, and `characterData`.
- Ignore mutations caused by Glossa-owned nodes.
- Ignore mutations inside excluded subtrees.
- Coalesce mutations for a short delay before rescanning.
- Rescan the closest stable container rather than the entire page.
- Clear marks and candidate state under replaced containers before rescanning.

For URL changes in single-page apps:

- Compare URL without hash for route changes.
- Recompute page rules and scopes after route changes.
- Clear page-local scan state when the route changes.
- Keep persistent vocabulary state in background storage.

## Stale Result Prevention

Every async result must prove its source still exists:

- Assign a monotonically increasing scan version per document or scan scope.
- Store `TextSurface.scanVersion` with each candidate request.
- Store the original text slice, text-node identity, offsets, and a compact source fingerprint.
- Before rendering, verify the node is connected, version is current, offsets still contain the original slice, and the candidate range still produces rendered rects.
- Discard the result when any verification fails.

This rule applies to gloss cache hits and network/AI results equally.

## Extension-Owned DOM

Every inserted node must be identifiable:

- Add a stable attribute such as `data-glossa-owned="1"`.
- Add `translate="no"` and `class="notranslate"` where appropriate.
- Keep wrappers removable without losing the original text.
- Mark programmatic updates so the mutation observer can ignore them during the same task.

Never let extension-owned text enter candidate extraction.

## Frames And Shadow DOM

Handle each document-like root intentionally:

- Same-origin iframes can be scanned with the same rules after injecting CSS and observers.
- Cross-origin iframes require separate content-script injection through extension matching rules.
- Open shadow roots can be scanned by attaching observers to the shadow root.
- Closed shadow roots are outside direct DOM scanning; rely on host-level behavior or explicit page integrations.

Track root identity in diagnostics so labels can be traced to document, frame, or shadow root.

## Insertion Safeguards

Before inserting a gloss:

- Rebuild a `Range` for the candidate.
- Confirm `Range.toString()` matches the candidate text.
- Confirm `Range.getClientRects()` has at least one visible rect.
- Check adjacent siblings and parent wrappers for an existing Glossa label.
- Use a deterministic candidate id to dedupe across rescans.

When the original text node is split for insertion, update local mappings or invalidate sibling candidates from the same text node and rescan the container.

## Failure Signals

Record these counts per scan:

- scanned text nodes
- rejected by subtree exclusion
- rejected by style/visibility
- rejected by empty or non-English tokenization
- candidate words emitted
- requests sent
- cache hits
- render successes
- render skips due to stale DOM
- render skips due to duplicate label

Use sanitized URLs and request IDs. Do not log full page text.
