import { matchesShortcut } from "../shared/shortcut";

export interface TranslationShortcutHandlerOptions {
  shortcut(): string;
  beforeToggle?(): void;
  toggle(): void | Promise<void>;
}

export function createTranslationShortcutHandler(options: TranslationShortcutHandlerOptions): EventListener {
  return (event): void => {
    if (!(event instanceof KeyboardEvent) || !matchesShortcut(event, options.shortcut())) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    options.beforeToggle?.();
    if (!event.repeat) {
      void options.toggle();
    }
  };
}
