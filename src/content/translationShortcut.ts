import { matchesShortcut } from "../shared/shortcut";

export interface TranslationShortcutHandlerOptions {
  shortcut(): string;
  toggle(): void | Promise<void>;
}

export function createTranslationShortcutHandler(options: TranslationShortcutHandlerOptions): EventListener {
  return (event): void => {
    if (!(event instanceof KeyboardEvent) || !matchesShortcut(event, options.shortcut())) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    void options.toggle();
  };
}
