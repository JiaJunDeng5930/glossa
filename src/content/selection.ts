import { normalizeLemma } from "../core/state";
import { isShortcutRelease, matchesShortcut } from "../shared/shortcut";
import type { TokenCandidate } from "../shared/types";

export interface WordSelection {
  surface: string;
  lemma: string;
  token: TokenCandidate;
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
}

export function createSelectionController(options: SelectionControllerOptions): SelectionController {
  let active = false;
  const doc = options.document;

  const onKeyDown = (event: KeyboardEvent) => {
    if (matchesShortcut(event, options.shortcutKey)) {
      active = true;
      doc.documentElement.dataset.glossaSelecting = "true";
    }
  };
  const onKeyUp = (event: KeyboardEvent) => {
    if (active && isShortcutRelease(event, options.shortcutKey)) {
      active = false;
      delete doc.documentElement.dataset.glossaSelecting;
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
    const selection = element ? selectionFromElementText(element) : undefined;
    if (selection) {
      void options.onWordSelected(selection);
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
      delete doc.documentElement.dataset.glossaSelecting;
    }
  };
}

function selectionFromElementText(element: Element): WordSelection | undefined {
  const text = element.textContent?.trim() ?? "";
  const match = /[A-Za-z][A-Za-z'-]*/.exec(text);
  if (!match) {
    return undefined;
  }
  const surface = match[0];
  const startOffset = match.index;
  const token: TokenCandidate = {
    id: `manual:${normalizeLemma(surface)}:${startOffset}`,
    sentenceId: "manual",
    surface,
    lemma: normalizeLemma(surface),
    startOffset,
    endOffset: startOffset + surface.length
  };
  return {
    surface,
    lemma: token.lemma,
    token,
    sentence: text
  };
}
