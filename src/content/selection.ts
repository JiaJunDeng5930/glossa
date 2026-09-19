import { normalizeLemma } from "../core/state";
import { isShortcutRelease, matchesShortcut } from "../shared/shortcut";
import type { TokenCandidate } from "../shared/types";
import { createSentenceContextResolver } from "./context";
import { createSourceFingerprint, type ScannedToken } from "./scanner";
import { occurrencesFor } from "./occurrence";
import { WORD_PATTERN, isReadableText } from "./readability";

export interface WordSelection {
  token: TokenCandidate;
  renderToken: ScannedToken;
  sentence: string;
}

export interface SelectionController {
  attach(): void;
  detach(): void;
  releaseHold(): void;
  setShortcut(shortcutKey: string): void;
}

export interface SelectionControllerOptions {
  document: Document;
  shortcutKey: string;
  onWordSelected(selection: WordSelection): void | Promise<void>;
  onSelectionModeChange?(active: boolean): void;
  onError?(error: unknown): void;
}

export function createSelectionController(options: SelectionControllerOptions): SelectionController {
  let active = false;
  let scrollBlockersAttached = false;
  let shortcutKey = options.shortcutKey;
  const doc = options.document;
  const activeListenerOptions = { capture: true, passive: false };

  const setActive = (nextActive: boolean) => {
    if (active === nextActive) {
      return;
    }
    active = nextActive;
    if (active) {
      attachScrollBlockers();
      doc.documentElement.dataset.glossaSelecting = "true";
    } else {
      detachScrollBlockers();
      delete doc.documentElement.dataset.glossaSelecting;
    }
    options.onSelectionModeChange?.(active);
  };

  // A held shortcut owns pointer input; any second key exits the hold so page and extension chords resolve normally.
  const onKeyDown = (event: KeyboardEvent) => {
    if (matchesShortcut(event, shortcutKey)) {
      setActive(true);
      consumeEvent(event);
      return;
    }
    if (active) {
      setActive(false);
    }
  };
  const onKeyUp = (event: KeyboardEvent) => {
    if (active && isShortcutRelease(event, shortcutKey)) {
      setActive(false);
      consumeEvent(event);
      return;
    }
    if (active) {
      consumeEvent(event);
    }
  };
  const onClick = (event: MouseEvent) => {
    if (!active) {
      return;
    }
    const element = event.target instanceof Element ? event.target : null;
    if (isGlossControl(element)) {
      return;
    }
    consumeEvent(event);

    const selection = element ? selectionFromClick(element, event) : undefined;
    if (selection) {
      try {
        const result = options.onWordSelected(selection);
        if (result && typeof result.catch === "function") {
          void result.catch((error) => options.onError?.(error));
        }
      } catch (error) {
        options.onError?.(error);
      }
    }
  };
  const onPageInteraction = (event: Event) => {
    if (!active) {
      return;
    }
    const element = event.target instanceof Element ? event.target : null;
    if (isGlossControl(element)) {
      return;
    }
    consumeEvent(event);
  };
  const onPageScroll = (event: Event) => {
    if (!active) {
      return;
    }
    consumeEvent(event);
  };
  function attachScrollBlockers(): void {
    if (scrollBlockersAttached) {
      return;
    }
    doc.addEventListener("wheel", onPageScroll, activeListenerOptions);
    doc.addEventListener("touchmove", onPageScroll, activeListenerOptions);
    scrollBlockersAttached = true;
  }
  function detachScrollBlockers(): void {
    if (!scrollBlockersAttached) {
      return;
    }
    doc.removeEventListener("wheel", onPageScroll, activeListenerOptions);
    doc.removeEventListener("touchmove", onPageScroll, activeListenerOptions);
    scrollBlockersAttached = false;
  }
  const onFocusLoss = () => {
    if (!active) {
      return;
    }
    setActive(false);
  };

  return {
    releaseHold() {
      setActive(false);
    },
    setShortcut(nextShortcutKey) {
      setActive(false);
      shortcutKey = nextShortcutKey;
    },
    attach() {
      doc.addEventListener("keydown", onKeyDown, true);
      doc.addEventListener("keyup", onKeyUp, true);
      doc.addEventListener("click", onClick, true);
      doc.addEventListener("pointerdown", onPageInteraction, activeListenerOptions);
      doc.addEventListener("pointerup", onPageInteraction, activeListenerOptions);
      doc.addEventListener("mousedown", onPageInteraction, activeListenerOptions);
      doc.addEventListener("mouseup", onPageInteraction, activeListenerOptions);
      doc.addEventListener("dblclick", onPageInteraction, activeListenerOptions);
      doc.addEventListener("auxclick", onPageInteraction, activeListenerOptions);
      doc.addEventListener("contextmenu", onPageInteraction, activeListenerOptions);
      doc.addEventListener("visibilitychange", onFocusLoss, true);
      doc.defaultView?.addEventListener("blur", onFocusLoss, true);
    },
    detach() {
      doc.removeEventListener("keydown", onKeyDown, true);
      doc.removeEventListener("keyup", onKeyUp, true);
      doc.removeEventListener("click", onClick, true);
      doc.removeEventListener("pointerdown", onPageInteraction, activeListenerOptions);
      doc.removeEventListener("pointerup", onPageInteraction, activeListenerOptions);
      doc.removeEventListener("mousedown", onPageInteraction, activeListenerOptions);
      doc.removeEventListener("mouseup", onPageInteraction, activeListenerOptions);
      doc.removeEventListener("dblclick", onPageInteraction, activeListenerOptions);
      doc.removeEventListener("auxclick", onPageInteraction, activeListenerOptions);
      doc.removeEventListener("contextmenu", onPageInteraction, activeListenerOptions);
      detachScrollBlockers();
      doc.removeEventListener("visibilitychange", onFocusLoss, true);
      doc.defaultView?.removeEventListener("blur", onFocusLoss, true);
      setActive(false);
    }
  };
}

function isGlossControl(element: Element | null): boolean {
  return Boolean(element?.closest("[data-glossa-duplicate-card-prompt], [data-glossa-token-label][role=button], #glossa-overlay"));
}

function consumeEvent(event: Event): void {
  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();
}

function selectionFromClick(element: Element, event: MouseEvent): WordSelection | undefined {
  const registry = occurrencesFor(element.ownerDocument);
  const existing = registry.findFromNode(element);
  if (existing) return selectionFromRenderedToken(existing);
  const textPoint = textPointFromClick(element, event);
  if (!textPoint || !isReadableText(textPoint.node)) {
    return undefined;
  }
  const match = wordAtClickPoint(textPoint.node, textPoint.offset, event.clientX, event.clientY);
  if (!match) {
    return undefined;
  }
  const surface = match[0];
  const nodeStartOffset = match.index ?? 0;
  const nodeEndOffset = nodeStartOffset + surface.length;
  const context = createSentenceContextResolver("selection")(textPoint.node, nodeStartOffset, nodeEndOffset);
  if (!context) {
    return undefined;
  }
  const lemma = normalizeLemma(surface);
  const sourceFingerprint = createSourceFingerprint(textPoint.node.nodeValue ?? "", nodeStartOffset, nodeEndOffset);
  const token: TokenCandidate = {
    id: registry.identify(textPoint.node, nodeStartOffset, nodeEndOffset, surface),
    sentenceId: "manual",
    surface,
    lemma,
    startOffset: context.startOffset,
    endOffset: context.endOffset
  };
  const renderToken: ScannedToken = {
    ...token,
    readingPolicy: "selection",
    textNode: textPoint.node,
    nodeStartOffset,
    nodeEndOffset,
    sentenceText: context.text,
    sourceFingerprint,
    scanVersion: 0
  };
  registry.register(renderToken);
  return {
    token,
    renderToken,
    sentence: context.text
  };
}

function selectionFromRenderedToken(previous: ScannedToken): WordSelection | undefined {
  const registry = occurrencesFor(previous.textNode.ownerDocument);
  const handles = registry.handlesFor(previous.id);
  const node = handles && Array.from(handles.surface.childNodes).find((child): child is Text => child instanceof Text);
  if (!node || !isReadableText(node)) return undefined;
  const match = Array.from(node.data.matchAll(WORD_PATTERN))[0];
  if (!match) return undefined;
  const start = match.index!, end = start + match[0].length;
  const context = createSentenceContextResolver("selection")(node, start, end);
  if (!context) return undefined;
  const token: TokenCandidate = { id: registry.identify(node, start, end, match[0]), sentenceId: "manual", surface: match[0], lemma: normalizeLemma(match[0]), startOffset: context.startOffset, endOffset: context.endOffset };
  const renderToken: ScannedToken = { ...token, readingPolicy: "selection", textNode: node, nodeStartOffset: start, nodeEndOffset: end, sentenceText: context.text, sourceFingerprint: createSourceFingerprint(node.data, start, end), scanVersion: previous.scanVersion };
  registry.register(renderToken);
  return { token, renderToken, sentence: context.text };
}

function textPointFromClick(element: Element, event: MouseEvent): { node: Text; offset: number } | undefined {
  const doc = element.ownerDocument;
  const fromPoint = textPointFromCoordinates(doc, event.clientX, event.clientY);
  if (!fromPoint?.node || !element.contains(fromPoint.node)) {
    return undefined;
  }
  return fromPoint;
}

function textPointFromCoordinates(doc: Document, x: number, y: number): { node: Text; offset: number } | undefined {
  const caretDoc = doc as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  const position = caretDoc.caretPositionFromPoint?.(x, y);
  if (position?.offsetNode.nodeType === Node.TEXT_NODE) {
    return { node: position.offsetNode as Text, offset: position.offset };
  }
  const range = caretDoc.caretRangeFromPoint?.(x, y);
  if (range?.startContainer.nodeType === Node.TEXT_NODE) {
    return { node: range.startContainer as Text, offset: range.startOffset };
  }
  return undefined;
}

function wordAtClickPoint(node: Text, offset: number, x: number, y: number): RegExpMatchArray | undefined {
  const text = node.nodeValue ?? "";
  for (const match of text.matchAll(WORD_PATTERN)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    if (offset >= start && offset < end) {
      return match as RegExpExecArray;
    }
    if (offset === end && pointInsideTextRange(node, start, end, x, y)) {
      return match as RegExpExecArray;
    }
  }
  return undefined;
}

function pointInsideTextRange(node: Text, start: number, end: number, x: number, y: number): boolean {
  const doc = node.ownerDocument;
  const range = doc.createRange();
  range.setStart(node, start);
  range.setEnd(node, end);
  const rects = typeof range.getClientRects === "function" ? Array.from(range.getClientRects()) : [];
  if (typeof range.detach === "function") {
    range.detach();
  }
  return rects.some((rect) => x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom);
}
