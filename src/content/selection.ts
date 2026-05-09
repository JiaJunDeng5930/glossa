// @behavior glossa.page_translation.shortcut_selection Holding the configured shortcut while clicking a word sends a DOM-grounded token candidate to the background.
import { normalizeLemma } from "../core/state";
import { isShortcutRelease, matchesShortcut } from "../shared/shortcut";
import type { TokenCandidate } from "../shared/types";
import { createSourceFingerprint, type ScannedToken } from "./scanner";

export interface WordSelection {
  surface: string;
  lemma: string;
  token: TokenCandidate;
  renderToken?: ScannedToken;
  sentence: string;
}

export interface SelectionController {
  attach(): void;
  detach(): void;
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
  const doc = options.document;

  const setActive = (nextActive: boolean) => {
    if (active === nextActive) {
      return;
    }
    active = nextActive;
    if (active) {
      doc.documentElement.dataset.glossaSelecting = "true";
    } else {
      delete doc.documentElement.dataset.glossaSelecting;
    }
    options.onSelectionModeChange?.(active);
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (matchesShortcut(event, options.shortcutKey)) {
      setActive(true);
    }
  };
  const onKeyUp = (event: KeyboardEvent) => {
    if (active && isShortcutRelease(event, options.shortcutKey)) {
      setActive(false);
    }
  };
  const onClick = (event: MouseEvent) => {
    if (!active) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();

    const element = event.target instanceof Element ? event.target : null;
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

  return {
    attach() {
      doc.addEventListener("keydown", onKeyDown, true);
      doc.addEventListener("keyup", onKeyUp, true);
      doc.addEventListener("click", onClick, true);
    },
    detach() {
      doc.removeEventListener("keydown", onKeyDown, true);
      doc.removeEventListener("keyup", onKeyUp, true);
      doc.removeEventListener("click", onClick, true);
      setActive(false);
    }
  };
}

function selectionFromClick(element: Element, event: MouseEvent): WordSelection | undefined {
  const existing = element.closest<HTMLElement>("[data-glossa-token]");
  if (existing) {
    return selectionFromRenderedToken(existing);
  }
  const textPoint = textPointFromClick(element, event);
  if (!textPoint) {
    return undefined;
  }
  const match = wordAtOffset(textPoint.node.nodeValue ?? "", textPoint.offset);
  if (!match) {
    return undefined;
  }
  const surface = match[0];
  const startOffset = match.index ?? 0;
  const endOffset = startOffset + surface.length;
  const lemma = normalizeLemma(surface);
  const sourceFingerprint = createSourceFingerprint(textPoint.node.nodeValue ?? "", startOffset, endOffset);
  const token: TokenCandidate = {
    id: `manual:${lemma}:${sourceFingerprint}`,
    sentenceId: "manual",
    surface,
    lemma,
    startOffset,
    endOffset
  };
  const renderToken: ScannedToken = {
    ...token,
    textNode: textPoint.node,
    nodeStartOffset: startOffset,
    nodeEndOffset: endOffset,
    sentenceText: textPoint.sentence,
    sourceText: surface,
    sourceFingerprint,
    scanVersion: 0
  };
  return {
    surface,
    lemma,
    token,
    renderToken,
    sentence: textPoint.sentence
  };
}

function selectionFromRenderedToken(element: HTMLElement): WordSelection | undefined {
  const surface = element.dataset.glossaSurface ?? element.textContent?.trim() ?? "";
  const lemma = element.dataset.glossaLemma ?? normalizeLemma(surface);
  const startOffset = Number(element.dataset.glossaOriginalStart ?? 0);
  const endOffset = Number(element.dataset.glossaOriginalEnd ?? startOffset + surface.length);
  if (!surface || !lemma || !Number.isFinite(startOffset) || !Number.isFinite(endOffset)) {
    return undefined;
  }
  const token: TokenCandidate = {
    id: element.dataset.glossaToken ?? `manual:${lemma}:${startOffset}`,
    sentenceId: "manual",
    surface,
    lemma,
    startOffset,
    endOffset
  };
  return {
    surface,
    lemma,
    token,
    sentence: element.parentElement?.textContent?.trim() || surface
  };
}

function textPointFromClick(element: Element, event: MouseEvent): { node: Text; offset: number; sentence: string } | undefined {
  const doc = element.ownerDocument;
  const fromPoint = textPointFromCoordinates(doc, event.clientX, event.clientY);
  const node = fromPoint?.node && element.contains(fromPoint.node) ? fromPoint.node : firstTextNode(element);
  if (!node) {
    return undefined;
  }
  const offset = fromPoint?.node === node ? fromPoint.offset : 0;
  return {
    node,
    offset,
    sentence: element.textContent?.trim() || node.nodeValue?.trim() || ""
  };
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

function firstTextNode(element: Element): Text | undefined {
  const doc = element.ownerDocument;
  const walker = doc.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      return /[A-Za-z]/.test(node.nodeValue ?? "") ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    }
  });
  return walker.nextNode() as Text | null ?? undefined;
}

function wordAtOffset(text: string, offset: number): RegExpMatchArray | undefined {
  for (const match of text.matchAll(/[A-Za-z][A-Za-z'-]*/g)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    if (offset >= start && offset <= end) {
      return match as RegExpExecArray;
    }
  }
  return /[A-Za-z][A-Za-z'-]*/.exec(text) ?? undefined;
}
